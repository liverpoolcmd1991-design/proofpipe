// server/store.js — the capture storage pipeline, extracted from server.js:
// image probing + thumbnail derivation (sharp), the shared storeCapturedParts
// pipeline (stream → probe → rename → DB row → auto-tag → thumb + SSE) used by
// BOTH the /upload and /share routes, and the boot-time orphan/thumb/retention
// sweep with its self-healing logic.
//
// IMPORTANT (UV_THREADPOOL discipline): sharp is NATIVE and grabs the libuv
// threadpool at load time; UV_THREADPOOL_SIZE is read once at pool init. That
// is why this module receives sharp INJECTED by server.js — server.js imports
// sharp dynamically AFTER setting the env var (see the comment block atop
// server.js and test/config.test.js, which pins this contract). Importing
// sharp HERE statically would re-trigger the early-pool-init bug class.
//
// Like cleanup/mediadir/backup, this module owns no server state: settings,
// statements, byte counters, SSE notify, the autoCaptureIds set, and the LIVE
// media paths (relocation reassigns them) are all injected; paths() is read
// fresh in every function.
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { resolveAutoTarget } from './browser.js';
import { beginFileRead, endFileRead } from './cleanup.js';
import { randomToken } from './util.js';

// The accept ceiling for one capture, in pixels. The server stores the ORIGINAL
// bytes untouched and only derives a 400px thumbnail, so this number is a
// decompression-bomb guard AND a promise the sender can rely on: anything under
// it is stored at the resolution it arrived at.
// 64MP covers high-resolution phone sensor modes (48MP HEIC = 8064×6048,
// 50MP = 8160×6120, 64MP sensors = 9248×6936), so a full-resolution
// capture is never refused and the sender never has to downscale it to fit.
// Above it the upload is refused (413) rather than downscaled: shrinking a
// photo the user never asked to shrink is exactly what the quality setting
// exists to control, so the refusal is the honest answer (the 4096px collapse
// that used to happen here silently cost a 48MP HEIC 74% of its pixels).
// Exported so server.js can PUBLISH it (GET /api/quality → the phone stops
// guessing) — one home for the number, no drift between the two sides.
export const MAX_PIXELS = 64_000_000;

export function createStore(ctx) {
  const sharp = ctx.sharp; // injected — see the threadpool note above
  const { settings, stmts, bytes, notify, autoCaptureIds, paths, cleanup } = ctx;
  // live-extension presence probe (server/sse.js hasBrowser), injected so
  // autoTarget can fall back to 'default' when the picked browser is absent.
  const browserPresent = ctx.browserPresent || (() => false);
  // heif covers HEIC photos (mobile share-target sends ORIGINAL bytes);
  // heif_sequence is the format name libvips reports for some HEIF variants.
  const EXT = { jpeg: '.jpg', png: '.png', webp: '.webp', gif: '.gif', avif: '.avif', tiff: '.tiff', heif: '.heic', heif_sequence: '.heic' };
  // header-only probe: rejects non-images + bombs cheaply; the ORIGINAL bytes are
  // stored untouched (no re-encode = no quality loss), only a thumbnail is derived.
  // `input` may be a Buffer or a file path (sharp handles both).
  async function probeImage(input) {
    const meta = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
    if ((meta.width || 0) * (meta.height || 0) > MAX_PIXELS) throw new Error('too many pixels');
    // reject anything EXT can't label (svg, pdf, raw cameras…) — an unlisted
    // format used to fall through to `.jpg` and be served as image/jpeg,
    // breaking the image in every UI (and SVG could smuggle scripts)
    if (!meta.format || !(meta.format in EXT)) throw new Error('not a supported image');
    return meta; // full metadata — callers reuse it (no second header parse)
  }
  // grid thumbnail — encoded in the SAME format as the original so its file
  // extension (t-<name>) always matches its bytes (and stays lossless for PNG).
  // Pass `meta` from probeImage to skip the second header parse.
  // `input` is the ORIGINAL bytes or a path to them — thumbnails only; the
  // original is never re-encoded, so full resolution is untouched everywhere.
  async function makeThumb(input, meta = null) {
    // A PATH input is read by sharp, and the handle stays open for the whole
    // decode — which is asynchronous, so a delete firing meanwhile would lose
    // its unlink on Windows. Announce the read so the deleter can wait for it
    // (cleanup.awaitFileIdle); a Buffer input holds no handle and needs nothing.
    // The bracket covers the metadata() read too (it is the same open file).
    const reading = typeof input === 'string';
    if (reading) beginFileRead(input);
    try {
      return await buildThumb(input, meta);
    } finally {
      if (reading) endFileRead(input);
    }
  }
  async function buildThumb(input, meta) {
    const m = meta || await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
    const load = () => sharp(input, { limitInputPixels: MAX_PIXELS }).rotate()
      .resize(400, null, { fastShrinkOnLoad: true, withoutEnlargement: true });
    const enc = {
      // PNG thumbs: palette-quantized — the GRID copy only ever shows at 110–210px,
      // and this cuts screenshot thumbs ~5–10x. effort 2 encodes ~2–4x faster than
      // 6 at this tiny size (visually identical at 110–210px). ORIGINAL stays byte-for-byte.
      png: () => load().png({ palette: true, quality: 90, effort: 2 }),
      // jpeg originals keep JPEG thumbs (same bytes family, no quality change to original)
      jpeg: () => load().jpeg({ quality: 70, progressive: true }),
      jpg: () => load().jpeg({ quality: 70, progressive: true }),
      webp: () => load().webp({ quality: 70, effort: 2 }),
      gif: () => load().gif(),
      avif: () => load().avif({ quality: 50, effort: 2 }),
      // tiff originals: browsers can't render tiff — derive a PNG thumb instead
      tiff: () => load().png({ palette: true, quality: 90, effort: 2 }),
      // heic/heif: same story as tiff — no browser renders it, so the thumb is a
      // PNG (the original stays byte-for-byte HEIC and is stored as .heic).
      // NOTE: the prebuilt libvips often can't ENCODE heif, but it can DECODE it,
      // which is all thumbnails need.
      heif: () => load().png({ palette: true, quality: 90, effort: 2 }),
      heif_sequence: () => load().png({ palette: true, quality: 90, effort: 2 }),
    }[m.format] || (() => load().jpeg({ quality: 70, progressive: true }));
    return enc().toBuffer();
  }


  // orphan sweep: files on disk with no DB row (e.g. a crashed upload);
  // also backfills per-file byte sizes for rows that predate the bytes column.
  // Deferred until after listen: thumb regeneration can take seconds on big
  // galleries and used to block server startup entirely.
  const ORPHAN_GRACE_MS = 10 * 60_000; // don't touch files younger than this (in-flight uploads)
  async function bootSweep() {
    const { captures: CAPTURES, files: FILES } = paths(); // live paths — see header
    const known = new Map(stmts.listAllCaptureFiles.all().map(r => [r.file, r.id]));
    const rowsNeedingSize = stmts.listCapturesMissingBytes.all();
    const sizes = new Map();
    let removed = 0;
    // any file that is neither a known original nor the thumbnail of a known
    // capture is orphaned — includes t-tmp-* temps AND thumbnails whose original
    // was already swept (crashed uploads delete both originals and thumbs)
    const knownThumbs = new Set([...known.keys()].map(f => `t-${f}`));
    // async IO: readdirSync/statSync blocked the event loop for seconds on big galleries
    // withFileTypes: directories are skipped without a stat() syscall per entry
    let dirents = [];
    try { dirents = await fsp.readdir(CAPTURES, { withFileTypes: true }); } catch {}
    const files = dirents.filter(d => d.isFile()).map(d => d.name);
    // chunked (64 at a time): a 5,000-file gallery fired 5,000 concurrent stat
    // syscalls at the libuv pool during boot — the chunk keeps it smooth
    const CHUNK = 64;
    for (let i = 0; i < files.length; i += CHUNK) {
      await Promise.all(files.slice(i, i + CHUNK).map(async f => {
      if (!known.has(f) && !knownThumbs.has(f)) {
        // grace window: a temp written by an upload that started right after
        // listen must never be swept out from under it
        try {
          const st = await fsp.stat(path.join(CAPTURES, f));
          if (Date.now() - st.mtimeMs < ORPHAN_GRACE_MS) return;
        } catch { return; }
        try { await fsp.rm(path.join(CAPTURES, f), { force: true }); removed++; } catch {}
        return;
      }
      try { sizes.set(f, (await fsp.stat(path.join(CAPTURES, f))).size); } catch {}
      }));
    }
    if (removed) console.log(`orphan sweep: removed ${removed} file(s)`);
    for (const r of rowsNeedingSize) {
      const size = (sizes.get(r.file) || 0) + (sizes.get(`t-${r.file}`) || 0);
      stmts.backfillBytes.run(size, r.id);
    }
    // self-heal: regenerate any missing thumbnails (e.g. a crash between the
    // upload ack and the deferred thumb write) so the grid never shows gaps.
    // Serial: parallel sharp decodes spike memory (12–48MP originals) and slow
    // everything down — one at a time keeps boot fast and quality untouched.
    let healed = 0;
    for (const [file, id] of known) {
      if (sizes.has(`t-${file}`)) continue;
      if (!Object.values(EXT).some(ext => file.endsWith(ext))) continue; // not a stored original (e.g. a t- thumb) — skip
      try { const thumb = await makeThumb(path.join(CAPTURES, file));
        await fsp.writeFile(path.join(CAPTURES, `t-${file}`), thumb);
        stmts.addThumbBytes.run(thumb.length, id);
        healed++;
      } catch {}
    }
    if (healed) console.log(`thumb sweep: regenerated ${healed} thumbnail(s)`);
    // retention applies at BOOT too: the sweep used to run only when a new
    // upload arrived, so a quiet week with retention on deleted nothing until
    // the next photo — the setting lied about what was on disk.
    try { await cleanup.runRetentionSweep(); } catch {}
    // file transfers: same orphan sweep for data/files/ (no thumbs, no sizes to
    // backfill — file bytes are recorded at upload time). data/inbox/ is never
    // swept: those are user-visible copies, not pipeline state.
    const knownFiles = new Set(stmts.listAllFileNames.all().map(r => r.file));
    let filesRemoved = 0;
    let fileList = [];
    try { fileList = (await fsp.readdir(FILES, { withFileTypes: true })).filter(d => d.isFile()).map(d => d.name); } catch {}
    // chunked exactly like the captures sweep above: an unbounded Promise.all
    // over a large transfers dir fires one stat syscall per file at the libuv
    // pool at once — the same storm the 64-chunk exists to prevent
    for (let i = 0; i < fileList.length; i += CHUNK) {
      await Promise.all(fileList.slice(i, i + CHUNK).map(async f => {
        if (knownFiles.has(f)) return;
        try {
          const st = await fsp.stat(path.join(FILES, f));
          if (Date.now() - st.mtimeMs < ORPHAN_GRACE_MS) return;
        } catch { return; }
        try { await fsp.rm(path.join(FILES, f), { force: true }); filesRemoved++; } catch {}
      }));
    }
    if (filesRemoved) console.log(`file sweep: removed ${filesRemoved} orphan(s)`);
    // re-read: backfilled + healed rows are now included (sweep runs post-listen)
    bytes.set(stmts.sumBytes.get().b);
    bytes.setFiles(stmts.sumFileBytes.get().b);
  }

  // ---------- captures ----------
  // Fast ack: the phone gets its response as soon as the ORIGINAL + DB row land;
  // the grid thumbnail derives in the background and clients are pushed the SSE
  // event once it exists (never a 404 thumb). Boot sweep regenerates thumbs if a
  // crash lands in the gap.
  // storeCapturedParts: the full store pipeline (stream to disk, probe, rename,
  // DB row, bytes total, auto-paste tags, thumb + SSE) shared by the normal
  // upload route and the Android share-target route — the share route
  // must not get a second, half-hardened copy of this.
  async function storeCapturedParts(parts, origin, wantsAuto, dedupeKey = null) {
    // parts: an array of { file (stream), filename, mimetype } — @fastify/multipart
    // `req.files()` yields an async iterator; the share route may hand us several.
    const stored = [];
    for (const part of parts) {
      if (!part || !part.file) continue;
      const { captures: CAPTURES } = paths(); // live paths — see header
      // idempotency: the phone retries timed-out uploads with the SAME client key.
      // Check before streaming to disk — a duplicate is answered with the original
      // row, no file, no DB insert. (A second, concurrent request with the same key
      // loses only the INSERT, not the file: the UNIQUE index is the last word.)
      if (dedupeKey) {
        const existing = stmts.getCaptureByDedupeKey.get(dedupeKey);
        if (existing) { stored.push({ id: existing.id, file: existing.file, duplicate: true }); continue; }
      }
      // streamed straight to disk: no 0–20 MB Buffer in the heap (toBuffer copied
      // the whole file into memory AND back out to disk — GC pressure → jank bursts).
      const tmpA = path.join(CAPTURES, `t-tmp-${Date.now()}-${randomToken()}`);
      try {
        await pipeline(part.file, fs.createWriteStream(tmpA));
      } catch (e) {
        fsp.rm(tmpA, { force: true }).catch(() => {});
        throw e; // caller logs + responds
      }
      if (part.file.truncated) { // busboy stopped at the cap — never keep a partial
        fsp.rm(tmpA, { force: true }).catch(() => {});
        const err = new Error('file too large'); err.status = 413; throw err;
      }
      // header-only probe reads straight from the written file (1–2 ms — no heap copy)
      let meta;
      try {
        meta = await probeImage(tmpA);
      } catch (e) {
        fsp.rm(tmpA, { force: true }).catch(() => {});
        const tooBig = /too many pixels|pixel limit/i.test(String(e?.message || e));
        const err = new Error(tooBig ? 'too many pixels' : 'not a supported image');
        err.status = tooBig ? 413 : 415;
        throw err;
      }
      let size = 0;
      try { size = (await fsp.stat(tmpA)).size; } catch {}
      const name = `${Date.now()}-${randomToken()}${EXT[meta.format] || '.jpg'}`;
      // rename into place; roll back on any failure
      const finalPath = path.join(CAPTURES, name);
      try {
        await fsp.rename(tmpA, finalPath);
      } catch (e) {
        for (const f of [tmpA, finalPath])
          fsp.rm(f, { force: true }).catch(() => {});
        throw e;
      }
      let info;
      try {
        info = stmts.insertCapture.run(name, size, origin, dedupeKey);
      } catch (e) {
        // UNIQUE violation on dedupe_key: a concurrent request with the same key
        // won the INSERT race. Answer with the WINNER's row and drop our file —
        // the caller (and phone) must see the ONE capture that exists.
        if (dedupeKey && String(e?.code || '').startsWith('SQLITE_CONSTRAINT')) {
          const winner = stmts.getCaptureByDedupeKey.get(dedupeKey);
          fsp.rm(finalPath, { force: true }).catch(() => {});
          if (winner) { stored.push({ id: winner.id, file: winner.file, duplicate: true }); continue; }
        }
        fsp.rm(finalPath, { force: true }).catch(() => {});
        throw e;
      }
      bytes.add(size);
      const id = info.lastInsertRowid;
      // auto-tagged captures: remembered so every SSE event for this capture (thumb
      // path, error path) carries the flag. Bounded — oldest entries drop off.
      if (wantsAuto) {
        autoCaptureIds.add(id);
        if (autoCaptureIds.size > 200) autoCaptureIds.delete(autoCaptureIds.keys().next().value);
      }
      // autoTarget: the picked browser, but falling back to 'default' when that
      // browser has no live extension — see resolveAutoTarget (server/browser.js).
      const capEvent = () => ({ capture: stmts.getCapture.get(id), auto: autoCaptureIds.has(id), autoTarget: resolveAutoTarget(settings.browser, browserPresent) });
      // storage cap: if enabled and we're past 80%, sweep the oldest captures now
      if (settings.autoCleanup) cleanup.runAutoCleanup().catch(() => {});
      // retention: cheap WHERE on an indexed-by-age scan — piggybacks on uploads
      if (settings.retentionDays) cleanup.runRetentionSweep().catch(() => {});
      // TWO scoped events per capture — each consumer gets exactly what it needs,
      // when it needs it:
      // - 'capture-ready' (auto captures ONLY, immediately): the extension's paste
      //   relay needs the ORIGINAL, which is on disk NOW. Non-auto captures skip
      //   this frame entirely — nothing consumes an early row for them.
      // - 'capture' (ALL captures, after the thumbnail lands): the grid's PAINT
      //   signal. Tiles added before the thumb exists sit empty until a retry
      //   hits; firing on thumb-ready makes the tile appear fully painted. (This
      //   event was removed once as "redundant" — it is not: see PITFALLS.md.)
      if (wantsAuto) notify('capture-ready', capEvent());
      // background thumbnail: only exists once it's safely on disk, then notify.
      // sharp reads from the stored file — the original never sits in JS heap.
      makeThumb(finalPath, meta).then(async thumb => {
        if (!stmts.getCapture.get(id)) return; // deleted mid-flight — drop it
        const thumbPath = path.join(CAPTURES, `t-${name}`);
        const tmpB = path.join(CAPTURES, `t-tmp-t-${name}`);
        try {
          await fsp.writeFile(tmpB, thumb);
          await fsp.rename(tmpB, thumbPath);
          if (!stmts.getCapture.get(id)) { fsp.rm(thumbPath, { force: true }).catch(() => {}); return; }
          if (stmts.addThumbBytes.run(thumb.length, id).changes) bytes.add(thumb.length);
          notify('capture', capEvent());
        } catch (e) {
          fsp.rm(tmpB, { force: true }).catch(() => {});
          console.error('storeCapturedParts thumb:', e?.message || e);
          notify('capture', capEvent()); // capture is listed; the boot sweep regenerates a missing thumb
        }
      }).catch(e => {
        console.error('storeCapturedParts thumb:', e?.message || e);
        notify('capture', capEvent()); // same — self-heals at next boot
      });
      stored.push({ id, file: name });
    }
    return stored;
  }

  // On-demand thumbnail regeneration.
  //
  // The boot sweep above heals missing thumbs — but only at BOOT. A thumb whose
  // deferred write failed mid-session stayed missing until a restart, and the
  // phone gives up after ~6 retries, so the tile showed a permanent blank. This
  // heals on the first request for the missing file instead.
  //
  // `base` is a stored ORIGINAL name (never a t- name). Returns the thumb bytes,
  // or null when there is nothing to build (no row, not an image, decode failed).
  // Concurrent requests for one file share a single decode: a grid scroll can
  // ask for the same dead thumb several times before the first one lands.
  const thumbJobs = new Map(); // base -> Promise<Buffer|null>
  // the SSE 'capture' payload for one id — the same shape storeCapturedParts
  // builds inline (see capEvent above); kept here so both paths agree
  const capEventFor = id => ({
    capture: stmts.getCapture.get(id),
    auto: autoCaptureIds.has(id),
    autoTarget: resolveAutoTarget(settings.browser, browserPresent),
  });
  async function thumbFor(base) {
    const { captures: CAPTURES } = paths(); // live path — see header
    // only a known, image-typed ORIGINAL row may be built (a t- name or an
    // unknown name must never reach sharp — that was the decoy-file hole)
    const row = stmts.getCaptureByFile.get(base);
    if (!row) return null;
    if (!Object.values(EXT).some(ext => base.endsWith(ext))) return null;
    const inflight = thumbJobs.get(base);
    if (inflight) return inflight;
    const job = (async () => {
      try {
        const thumb = await makeThumb(path.join(CAPTURES, base));
        // write via tmp+rename so a reader never sees a half-written thumb
        const tmp = path.join(CAPTURES, `t-tmp-${base}`);
        const dest = path.join(CAPTURES, `t-${base}`);
        await fsp.writeFile(tmp, thumb);
        await fsp.rename(tmp, dest);
        // only count it if the row is still there and did not already have bytes
        if (stmts.getCapture.get(row.id)) {
          if (stmts.addThumbBytes.run(thumb.length, row.id).changes) bytes.add(thumb.length);
          notify('capture', capEventFor(row.id)); // tiles re-pull the now-existing thumb
        } else {
          // The row was deleted while we were decoding (a delete fired right
          // after the upload). Drop the thumb we just wrote: with no row to
          // describe it, nothing else would ever clean it up before the next
          // boot sweep, and the requester already has the bytes it asked for.
          fsp.rm(dest, { force: true }).catch(() => {});
        }
        return thumb;
      } catch (e) {
        console.error('thumbFor:', base, e?.message || e);
        return null;
      } finally {
        thumbJobs.delete(base);
      }
    })();
    thumbJobs.set(base, job);
    return job;
  }

  return { probeImage, makeThumb, thumbFor, bootSweep, storeCapturedParts, EXT, MAX_PIXELS };
}
