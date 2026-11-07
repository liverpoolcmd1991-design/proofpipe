// server/captures.js — the captures query/delete surface, extracted from
// server.js: keyset pagination, the version fingerprint, single + delete-all
// routes. The store pipeline (storeCapturedParts) lives in server/store.js;
// the shared single-capture deleter (removeCaptureRow) and the sweeps live in
// server/cleanup.js — this module is purely the HTTP surface over them.
//
// State governance matches the other extracted modules: nothing is cached —
// paths() is read fresh (media-dir relocation reassigns the bindings), and
// byte counters / SSE notify / auto-paste bookkeeping are injected.
import path from 'node:path';
import { rmWithRetry, awaitFileIdle } from './cleanup.js';

export function registerCaptures(app, ctx) {
  const { stmts, db, bytes, notify, csrfSafe, autoCaptureIds, paths, cleanup } = ctx;

  // page through captures: newest first, ?before=<id> for older pages (keyset)
  // ?limit is honored but capped (client "load older" paginates via ?before)
  app.get('/api/captures', (req) => {
    const before = Number(req.query.before);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    if (Number.isInteger(before) && before > 0) {
      return stmts.listCapturesBefore.all(before, limit);
    }
    return stmts.listCaptures.all(limit);
  });

  app.get('/api/captures/version', () => {
    // text fingerprint so poll-fallback clients notice text changes too
    return {
      n: stmts.countCaptures.get().c,
      latest: stmts.latestCaptureId.get()?.id ?? 0,
      textId: stmts.latestTextId.get()?.id ?? 0,
    };
  });

  // delete all captures: SELECT + DELETE inside ONE transaction so a concurrent
  // upload can't slip between them (better-sqlite3 is sync — no interleave).
  app.delete('/api/captures', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const rows = db.transaction(() => {
      // explicit columns (never SELECT *) — only id/file/bytes are used below
      const r = db.prepare('SELECT id, file, bytes FROM captures').all();
      stmts.deleteAllCaptures.run();
      return r;
    })();
    let failed = 0;
    let textClean = 0;
    for (const cap of rows) {
      // media-link text rows ("sent to phone" chips) reference these files —
      // purge them so no phone chip is left pointing at a deleted capture
      textClean += stmts.deleteTextsForCapture.run(`/media/${cap.file}`).changes;
    }
    // Wait out any in-flight decode of these originals FIRST. A capture uploaded
    // seconds ago still has its deferred thumbnail job reading the file (sharp
    // holds it open — see cleanup.beginFileRead), and a wipe fired right after a
    // batch upload is exactly that case. The rows are already gone, so those jobs
    // bow out without writing their thumbs; the wait only stops our unlink from
    // losing to their open handle. `rmWithRetry` below is the second line of
    // defence, not the first: its 400ms budget happens to cover a PNG today and
    // must not be what correctness rests on.
    await Promise.all(rows.map(cap => awaitFileIdle(path.join(paths().captures, cap.file))));
    // file removal runs with bounded concurrency: the DB rows are already gone,
    // and a serial `await fsp.rm` per file made a 2k-capture delete-all issue
    // ~4k sequential awaits before it could respond. Chunked (32 in flight) so
    // the libuv pool is busy but never flooded.
    const names = rows.flatMap(cap => [cap.file, `t-${cap.file}`]);
    const RM_CHUNK = 32;
    for (let i = 0; i < names.length; i += RM_CHUNK) {
      await Promise.all(names.slice(i, i + RM_CHUNK).map(async f => {
        // retrying unlink — a bulk delete races captures still being written
        if (await rmWithRetry(path.join(paths().captures, f))) failed++;
      }));
    }
    // auto-paste bookkeeping clears ONLY after file removal: a blanket clear()
    // right after the txn used to wipe the flag of an upload landing during the
    // awaited rm loop — its 'capture-ready' SSE never fired and auto-paste
    // silently dropped that photo. Delete exactly the removed ids instead.
    for (const cap of rows) autoCaptureIds.delete(Number(cap.id));
    if (textClean) notify('text'); // chips disappear on the phone too
    // recompute (don't zero): an upload racing after the txn is counted correctly
    bytes.set(stmts.sumBytes.get().b); // recompute (don't zero): uploads racing the txn are counted correctly
    notify('deleted');
    if (failed) return reply.code(500).send({ deleted: rows.length, failedFiles: failed, error: 'some files could not be removed' });
    return { ok: true, deleted: rows.length };
  });

  app.delete('/api/captures/:id', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const cap = stmts.getCapture.get(req.params.id);
    if (!cap) return reply.code(404).send();
    // DB row first, then files — if a file can't be removed, don't report success
    const ok = await cleanup.removeCaptureRow(cap);
    if (!ok) return reply.code(500).send({ error: 'deleted from database but file removal failed' });
    return { ok: true };
  });

  return {};
}
