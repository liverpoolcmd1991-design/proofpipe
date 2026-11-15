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
  const {
    settings, stmts, db, bytes, notify, csrfSafe, autoCaptureIds, paths, cleanup,
    photoBucket, uploadBodyLimit, storeCapturedParts, rotateCapture, getCapturesRev,
  } = ctx;

  app.post('/upload', { bodyLimit: uploadBodyLimit }, async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    if (!photoBucket.allow(req.ip)) return reply.code(429).send({ error: 'too many uploads, slow down' });
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'no file' });
    const rawSource = part.fields?.source;
    const sourceVal = typeof rawSource === 'string' ? rawSource : rawSource?.value;
    const origin = sourceVal === 'phone' ? 'phone' : 'pc';
    const rawAuto = part.fields?.auto;
    const autoVal = typeof rawAuto === 'string' ? rawAuto : rawAuto?.value;
    const wantsAuto = origin === 'phone' && (rawAuto == null ? settings.autoPaste : (autoVal === '1' || autoVal === 'true'));
    const rawKey = typeof part.fields?.key === 'string' ? part.fields.key : part.fields?.key?.value;
    const dedupeKey = origin === 'phone' && typeof rawKey === 'string' && rawKey && /^[A-Za-z0-9_-]{8,32}$/.test(rawKey)
      ? `ph:${rawKey}` : null;
    let stored;
    try {
      stored = await storeCapturedParts([part], origin, wantsAuto, dedupeKey);
    } catch (e) {
      req.log.error(e);
      return reply.code(e?.status || 500).send({ error: e?.status ? e.message : 'failed to store capture' });
    }
    const first = stored[0] || {};
    return reply.send({ id: first.id, file: first.file, ...(first.duplicate ? { duplicate: true } : {}) });
  });

  app.post('/share', { bodyLimit: uploadBodyLimit }, async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    if (!photoBucket.allow(req.ip)) return reply.code(429).send({ error: 'too many uploads, slow down' });
    const fields = {};
    const stored = [];
    try {
      for await (const part of req.parts()) {
        if (part.filename) {
          stored.push(...await storeCapturedParts([part], 'phone', settings.autoPaste));
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
    } catch (e) {
      try { req.raw.resume(); } catch {}
      for (const s of stored) {
        try { const cap = stmts.getCapture.get(s.id); if (cap) await cleanup.removeCaptureRow(cap); } catch {}
      }
      console.error('share:', e?.message || e);
      return reply.code(303).redirect('/phone?shared=error');
    }
    try {
      const bodyText = (fields.text || fields.title || fields.url || '').trim().slice(0, 10000);
      if (bodyText) {
        stmts.insertText.run(bodyText, 'phone', 'text');
        stmts.trimTexts.run();
        notify('text');
      }
      return reply.code(303).redirect('/phone?shared=1');
    } catch (e) {
      console.error('share:', e?.message || e);
      return reply.code(303).redirect('/phone?shared=error');
    }
  });

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
      rev: getCapturesRev ? getCapturesRev() : 0,
    };
  });

  app.post('/api/captures/:id/rotate', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid capture id' });
    const rawDeg = req.body?.deg == null ? 90 : Number(req.body.deg);
    const normDeg = Number.isFinite(rawDeg) ? ((rawDeg % 360) + 360) % 360 : NaN;
    if (![90, 180, 270].includes(normDeg)) {
      return reply.code(400).send({ error: 'deg must be 90, 180, or 270' });
    }
    try {
      const capture = await rotateCapture(id, normDeg);
      return { ok: true, capture };
    } catch (e) {
      req.log.error(e);
      return reply.code(e?.status || 500).send({ error: e?.status ? e.message : 'failed to rotate capture' });
    }
  });

  // delete all or selected captures: SELECT + DELETE inside ONE transaction so
  // a concurrent upload can't slip between them (SQLite is sync — no interleave).
  app.delete('/api/captures', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const hasIds = Array.isArray(req.body?.ids);
    const targetIds = hasIds ? [...new Set(req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] : null;
    if (hasIds && !targetIds.length) return { ok: true, deleted: 0 };

    let textClean = 0;
    const rows = db.transaction(() => {
      const r = hasIds
        ? targetIds.map(id => stmts.getCapture.get(id)).filter(Boolean)
        : stmts.listAllCaptureRowsForDelete.all();
      if (hasIds) {
        for (const cap of r) stmts.deleteCapture.run(String(cap.id));
      } else {
        stmts.deleteAllCaptures.run();
      }
      for (const cap of r) {
        // media-link text rows ("sent to phone" chips) reference these files —
        // purge them inside the same atomic transaction
        textClean += stmts.deleteTextsForCapture.run(`/media/${cap.file}`).changes;
      }
      return r;
    })();
    if (hasIds && !rows.length) return { ok: true, deleted: 0 };

    let failed = 0;
    // Wait for any in-flight decode of these originals before unlinking.
    await Promise.all(rows.map(cap => awaitFileIdle(path.join(paths().captures, cap.file))));
    const names = rows.flatMap(cap => [cap.file, `t-${cap.file}`]);
    const RM_CHUNK = 32;
    for (let i = 0; i < names.length; i += RM_CHUNK) {
      await Promise.all(names.slice(i, i + RM_CHUNK).map(async f => {
        if (await rmWithRetry(path.join(paths().captures, f))) failed++;
      }));
    }
    for (const cap of rows) autoCaptureIds.delete(Number(cap.id));
    if (textClean) notify('text');
    bytes.set(stmts.sumBytes.get().b);
    notify('deleted', hasIds ? { ids: rows.map(c => Number(c.id)) } : undefined);
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
