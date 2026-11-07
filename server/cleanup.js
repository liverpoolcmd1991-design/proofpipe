// server/cleanup.js — storage governance, extracted from server.js:
// the cap/retention routes, the shared single-row deleters, and the three
// sweep loops (retention, capture cap, file cap).
//
// The caller (server.js) keeps ownership of ALL state: settings, statements,
// the DB handle, byte counters, SSE notify, and — critically — the LIVE media
// dir paths, which media-dir relocation reassigns at runtime. This module
// therefore never caches a path: every function destructures ctx.paths()
// fresh, so a relocation mid-process is picked up on the next call.
//
// registerCleanup returns the functions server.js needs inline:
//   - storeCapturedParts calls runAutoCleanup / runRetentionSweep
//   - POST /api/files calls runFileCleanup
//   - the DELETE routes call removeCaptureRow / removeFileRow
import fsp from 'node:fs/promises';
import path from 'node:path';

// Unlink with a bounded retry.
//
// On Windows a just-written file can still be held by a closing handle (the
// upload's createWriteStream, an AV scanner, or the search indexer), and
// fsp.rm throws EBUSY/EPERM for a few milliseconds after the row is gone. A
// bulk delete makes this visible: measured 12/60 files "failing" on a delete
// fired right after a seed upload, and a plain retry removed all 12 with zero
// errors. `force:true` already absorbs ENOENT, so anything that reaches here is
// transient by nature — retry briefly, then report honestly.
//
// Returns the error code on final failure (so a caller can surface WHY), or null
// on success. The previous boolean swallowed the reason, which made a 500 read
// as "some files could not be removed" with nothing in the log to act on.
export async function rmWithRetry(target, attempts = 5) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try { await fsp.rm(target, { force: true }); return null; }
    catch (e) {
      last = e;
      const transient = e?.code === 'EBUSY' || e?.code === 'EPERM' || e?.code === 'ENOTEMPTY'
        || e?.code === 'EACCES'; // Windows also reports access denial under EACCES
      if (!transient) break;
      await new Promise(r => setTimeout(r, 40 * (i + 1))); // 40, 80, 120, 160ms
    }
  }
  console.error('rmWithRetry failed:', target, last?.code, last?.message);
  return last?.code || 'UNKNOWN';
}

// ---------- in-flight reads of a stored ORIGINAL ----------
//
// The capture pipeline derives its thumbnail in a BACKGROUND job, and sharp holds
// the original path open until that job's promise resolves (see store.makeThumb).
// On Windows an unlink of a file someone is still reading fails with
// EBUSY/EPERM — and the loser is the delete: the DB row goes, the bytes stay,
// and the accounting then deliberately re-adds the leftovers (see
// removeCaptureRow below), so the byte total does not even drop. The orphan and
// the wrong total both clear at the next boot sweep, which is far too late to be
// called correct. (Measured in test/smoke.test.js: an upload immediately
// followed by a delete left the original behind roughly one run in three under
// suite load, always paired with "bytes should decrease after delete".)
//
// So a reader ANNOUNCES itself here and the deleter WAITS for it, instead of the
// deleter retrying blind and hoping. Keyed by ABSOLUTE path: media-dir
// relocation reassigns the roots at runtime, so only the resolved file is a
// stable key.
const readsInFlight = new Map(); // abs path -> { n, waiters: Set<fn> }

// Every beginFileRead must be paired with an endFileRead in a `finally`.
export function beginFileRead(abs) {
  const e = readsInFlight.get(abs) || { n: 0, waiters: new Set() };
  e.n++;
  readsInFlight.set(abs, e);
}

export function endFileRead(abs) {
  const e = readsInFlight.get(abs);
  if (!e || --e.n > 0) return;
  readsInFlight.delete(abs);
  for (const w of e.waiters) w();
  e.waiters.clear();
}

// Resolve once no reader holds `abs` — or after `ms`, because a wedged decode
// must never wedge a delete. rmWithRetry below is the second line of defence for
// whatever the wait cannot cover (a lock held by something other than us).
export function awaitFileIdle(abs, ms = 5000) {
  const e = readsInFlight.get(abs);
  if (!e) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const waiter = () => {
      if (settled) return; // the timeout already answered (endFileRead may call it late)
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(waiter, ms);
    e.waiters.add(waiter);
  });
}

export function registerCleanup(app, ctx) {
  const { settings, stmts, db, bytes, notify, saveSettings, csrfSafe, logEvent, autoCaptureIds, paths } = ctx;
  const P = () => paths(); // live: never cache — relocation reassigns these

  // ---------- auto-cleanup: drop the OLDEST captures past 80% of the cap ----------
  // Off by default (it deletes data); the toggle lives on both UIs. Cap is 500MB
  // by default, PP_MAX_STORE_MB overrides it; a user-chosen cap (settings
  // modal) overrides both. Mutable — runAutoCleanup recomputes per run.
  const DEFAULT_MAX_STORE_MB = (Number(process.env.PP_MAX_STORE_MB) || 500);
  const maxStoreBytes = () => (settings.storageCapMB || DEFAULT_MAX_STORE_MB) * 1024 * 1024;
  app.get('/api/autocleanup', () => ({ on: settings.autoCleanup, cap: maxStoreBytes(), used: bytes.total }));
  app.post('/api/autocleanup', (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const b = req.body || {};
    if (typeof b.on !== 'boolean') return reply.code(400).send({ error: 'on must be a boolean' });
    settings.autoCleanup = !!b.on;
    saveSettings();
    if (settings.autoCleanup) runAutoCleanup().catch(() => {}); // trim immediately on enable
    return { ok: true, on: settings.autoCleanup };
  });

  // ---------- storage cap (auto-cleanup's threshold, user-adjustable) ----------
  // Default: 500 MB (or PP_MAX_STORE_MB). 50 MB floor — lower is a typo, and
  // cleaning down to it would delete almost everything.
  app.get('/api/storage-cap', () => ({ capMb: settings.storageCapMB || DEFAULT_MAX_STORE_MB, custom: settings.storageCapMB != null }));
  app.post('/api/storage-cap', (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const b = req.body || {};
    if (b.capMb !== null && b.capMb !== undefined) {
      const mb = Math.round(Number(b.capMb));
      if (!Number.isFinite(mb) || mb < 50 || mb > 1024 * 1024) return reply.code(400).send({ error: 'cap must be 50–1048576 MB' });
      settings.storageCapMB = mb;
    } else {
      settings.storageCapMB = null; // back to the default
    }
    saveSettings();
    if (settings.autoCleanup) runAutoCleanup().catch(() => {}); // new cap applies NOW
    return { ok: true, capMb: settings.storageCapMB || DEFAULT_MAX_STORE_MB };
  });

  // ---------- retention: auto-delete captures older than N days (0 = off) ----------
  app.get('/api/retention', () => ({ days: settings.retentionDays }));
  app.post('/api/retention', (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const b = req.body || {};
    const days = Math.round(Number(b.days));
    if (!Number.isFinite(days) || days < 0 || days > 3650) return reply.code(400).send({ error: 'days must be 0–3650 (0 = off)' });
    settings.retentionDays = days;
    saveSettings();
    if (days > 0) runRetentionSweep().catch(() => {}); // sweep immediately on enable/change
    return { ok: true, days: settings.retentionDays };
  });
  let retentionRunning = false;
  async function runRetentionSweep() {
    if (!settings.retentionDays || retentionRunning) return 0;
    retentionRunning = true;
    try {
      // created_at is SQLite datetime('now') UTC text — the comparison is exact
      const cutoff = `-${settings.retentionDays} days`;
      // batched: LIMIT 500 per pass so deleting a huge backlog never blocks the
      // event loop for seconds; the next capture (or setting change) sweeps again
      const old = db.prepare("SELECT * FROM captures WHERE created_at < datetime('now', ?) ORDER BY id ASC LIMIT 500").all(cutoff);
      // SILENT removals + ONE event at the end. A per-row notify made every
      // client re-render per deletion, and the phone refetches its whole list on
      // each 'deleted' — a 500-row pass was 500 events × 2 round-trips.
      for (const cap of old) await removeCaptureRow(cap, { silent: true });
      if (old.length) {
        notify('deleted'); // payload-less: clients refresh once (see CONVENTIONS)
        logEvent('cleanup-local', { dropped: old.length, kind: 'retention', days: settings.retentionDays });
      }
      return old.length;
    } finally { retentionRunning = false; }
  }
  // shared single-capture deletion (used by the :id endpoint and the sweeper).
  // `silent` suppresses the per-row 'deleted' push so a bulk sweep can coalesce
  // its notifications into one — the caller owns that final event.
  async function removeCaptureRow(cap, { silent = false } = {}) {
    const { captures: CAPTURES } = P(); // live paths — see header
    // only subtract when a row actually died — concurrent cleanups must not double-count
    const info = stmts.deleteCapture.run(String(cap.id));
    autoCaptureIds.delete(Number(cap.id));
    // media-link text rows reference this file — purge them so no phone chip is
    // left pointing at a deleted capture (would 404 forever in the viewer).
    // Kept per-row even in silent mode: it only fires for captures that were
    // actually sent to the phone, so it is rare, and the phone must drop the
    // chip. It is a payload-less event either way.
    if (stmts.deleteTextsForCapture.run(`/media/${cap.file}`).changes) notify('text');
    let failed = false;
    // Wait out an in-flight decode of the ORIGINAL before unlinking it: the
    // background thumbnail job reads this exact path, and on Windows the unlink
    // loses to that open handle (see the registry above). The thumb is derived
    // from the ORIGINAL, so only that path needs the wait.
    await awaitFileIdle(path.join(CAPTURES, cap.file));
    for (const f of [cap.file, `t-${cap.file}`]) {
      // retrying unlink — the same tool every other deleter in this file uses
      const code = await rmWithRetry(path.join(CAPTURES, f));
      if (code) { failed = true; console.error('removeCaptureRow:', f, code); }
    }
    if (info.changes && cap.bytes) {
      bytes.sub(cap.bytes);
      if (failed) {
        // a file that couldn't be removed still occupies disk — keep the tracked
        // total honest (without its row it would otherwise be swept as an orphan
        // and lost from the total until the next boot sweep recomputes it)
        let leftover = 0;
        for (const f of [cap.file, `t-${cap.file}`]) {
          try { leftover += (await fsp.stat(path.join(CAPTURES, f))).size; } catch {}
        }
        bytes.add(leftover);
      }
    }
    if (!silent) notify('deleted', { id: Number(cap.id) });
    return !failed;
  }
  let cleanupRunning = false; // concurrent triggers (upload burst + toggle) share one run
  async function runAutoCleanup() {
    if (!settings.autoCleanup || cleanupRunning) return 0;
    cleanupRunning = true;
    try {
      let removed = 0;
      // hoisted: this SELECT used to be re-prepared on every loop iteration
      const oldestStmt = db.prepare('SELECT * FROM captures ORDER BY id ASC LIMIT 1');
      // oldest first (lowest id); stop as soon as we're back under the threshold
      while (bytes.total > maxStoreBytes() * 0.8) {
        const oldest = oldestStmt.get();
        if (!oldest) break;
        await removeCaptureRow(oldest, { silent: true });
        removed++;
      }
      if (removed) {
        notify('deleted'); // ONE event for the whole trim, not one per capture
        logEvent('cleanup-local', { dropped: removed, kind: 'autoCap' });
      }
      return removed;
    } finally { cleanupRunning = false; }
  }

  // ---------- transfer-file cleanup ----------
  // own storage cap (PP_MAX_FILES_MB, default 2000 MB); oldest-first drop past 80%
  const MAX_FILES_STORE = (Number(process.env.PP_MAX_FILES_MB) || 2000) * 1024 * 1024;
  const FILES_CLEANUP_THRESHOLD = MAX_FILES_STORE * 0.8;
  // shared single-file deletion (used by the :id endpoint and the sweeper).
  // `silent` coalesces the per-row push for bulk sweeps — see removeCaptureRow.
  async function removeFileRow(row, { silent = false } = {}) {
    const { files: FILES } = P(); // live paths — see header
    // only subtract when a row actually died — concurrent cleanups must not double-count
    const info = stmts.deleteFile.run(String(row.id));
    let failed = false;
    // retrying unlink: a file written moments ago can still be handle-locked
    if (await rmWithRetry(path.join(FILES, row.file))) failed = true;
    if (info.changes && row.bytes) {
      bytes.subFiles(row.bytes);
      if (failed) {
        // same honesty rule as captures: undeletable file = disk still used
        try { bytes.addFiles((await fsp.stat(path.join(FILES, row.file))).size); } catch {}
      }
    }
    if (!silent) notify('file-deleted', { id: Number(row.id) });
    return !failed;
  }
  let fileCleanupRunning = false; // concurrent triggers (upload burst) share one run
  async function runFileCleanup() {
    if (fileCleanupRunning) return 0;
    fileCleanupRunning = true;
    try {
      let removed = 0;
      const oldestStmt = db.prepare('SELECT * FROM files ORDER BY id ASC LIMIT 1'); // hoisted
      // oldest first (lowest id); stop as soon as we're back under the threshold
      while (bytes.files > FILES_CLEANUP_THRESHOLD) {
        const oldest = oldestStmt.get();
        if (!oldest) break;
        await removeFileRow(oldest, { silent: true });
        removed++;
      }
      if (removed) {
        notify('file-deleted'); // ONE event for the whole trim (clients refetch once)
        logEvent('cleanup-local', { dropped: removed, kind: 'fileCap' });
      }
      return removed;
    } finally { fileCleanupRunning = false; }
  }

  return { runRetentionSweep, runAutoCleanup, runFileCleanup, removeCaptureRow, removeFileRow, maxStoreBytes, defaultMaxStoreMB: DEFAULT_MAX_STORE_MB };
}
