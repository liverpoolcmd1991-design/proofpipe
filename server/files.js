// server/files.js — generic file transfer (phone ⇄ PC, any file type),
// extracted from server.js: the POST /api/files route, phone→PC inbox
// auto-save (saveToInbox), the listing/version/serving routes, and the
// DELETE route.
//
// Any file type (PDF, ZIP, docs, video, APK…): only size is validated, names
// are sanitized, serving is forced safe (stored-XSS hole closed by rules, not
// trust). Streamed end-to-end (part.file → disk, never toBuffer) so memory
// stays flat for 1 GB files. Own table/dir/cap/rate bucket — a big transfer
// can never evict photo history or trip the photo rate limiter.
//
// Pure helpers stay in server/util.js: sanitizeDisplayName(), storedExtFor(),
// FILE_INLINE_MIME, fileServeHeaders().
// State governance matches cleanup/mediadir/backup/store: nothing is cached —
// paths() is read fresh (media-dir relocation reassigns the bindings), and the
// file-row deleter + cap sweeper come from the cleanup module.
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sanitizeDisplayName, storedExtFor, fileServeHeaders, randomToken } from './util.js';
import { rmWithRetry } from './cleanup.js';

// generic file transfers: 1 GB per file at the ROUTE level (captures keep
// their 20 MB global cap). PP_MAX_FILE_MB overrides for tests/sandbox runs.
const MAX_FILE_BYTES = (Number(process.env.PP_MAX_FILE_MB) || 1024) * 1024 * 1024;

export function registerFiles(app, ctx) {
  const { settings, stmts, db, bytes, notify, csrfSafe, fileBucket, paths, cleanup, streamFile } = ctx;

  app.post('/api/files', { bodyLimit: MAX_FILE_BYTES + 8 * 1024 * 1024 }, async (req, reply) => {
    const { files: FILES } = paths(); // live paths — see header
    // same CSRF bar as /upload + DELETEs: an arbitrary webpage must not flood
    // disk via cross-site FormData. Same-origin PWA (host match), curl pass.
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    if (!fileBucket.allow(req.ip)) return reply.code(429).send({ error: 'too many files, slow down' });
    let part;
    try {
      part = await req.file({ limits: { fileSize: MAX_FILE_BYTES } });
    } catch (e) {
      try { req.raw.resume(); } catch {} // drain: the client may still be sending
      if (e && /too large|limit|truncat/i.test(String((e && e.message) || e.code || e)))
        return reply.code(413).send({ error: 'file too large' });
      return reply.code(400).send({ error: 'no file' });
    }
    if (!part) return reply.code(400).send({ error: 'no file' });
    // dir parallels captures' `source` field (sent BEFORE the file part): which
    // side sent it ('phone' | 'pc'). Accepts `dir` or legacy `source`.
    const rawDir = part.fields?.dir;
    const dirVal = typeof rawDir === 'string' ? rawDir : rawDir?.value;
    const rawSource = part.fields?.source;
    const sourceVal = typeof rawSource === 'string' ? rawSource : rawSource?.value;
    const dir = (dirVal === 'phone' || sourceVal === 'phone') ? 'phone' : 'pc';
    const name = sanitizeDisplayName(part.filename);
    const stored = `${Date.now()}-${randomToken()}${storedExtFor(name)}`;
    const tmp = path.join(FILES, `f-tmp-${Date.now()}-${randomToken()}`);
    const finalPath = path.join(FILES, stored);
    try {
      await pipeline(part.file, fs.createWriteStream(tmp));
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      try { req.raw.resume(); } catch {}
      req.log.error(e);
      return reply.code(500).send({ error: 'failed to store file' });
    }
    if (part.file.truncated) { // busboy stopped at the cap — never keep a partial
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return reply.code(413).send({ error: 'file too large' });
    }
    let size = 0;
    try { size = (await fsp.stat(tmp)).size; } catch {}
    if (size > MAX_FILE_BYTES) { // belt + suspenders (truncation flags vary by version)
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return reply.code(413).send({ error: 'file too large' });
    }
    try {
      await fsp.rename(tmp, finalPath); // atomic; tmp cleanup on any failure
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      req.log.error(e);
      return reply.code(500).send({ error: 'failed to store file' });
    }
    const mime = String(part.mimetype || 'application/octet-stream').slice(0, 128);
    let info;
    try {
      info = stmts.insertFile.run(name, stored, mime, size, dir);
    } catch (e) {
      await fsp.rm(finalPath, { force: true }).catch(() => {});
      req.log.error(e);
      return reply.code(500).send({ error: 'failed to record file' });
    }
    bytes.addFiles(size);
    const row = stmts.getFile.get(info.lastInsertRowid);
    cleanup.runFileCleanup().catch(() => {});
    if (dir === 'phone' && settings.filesToInbox) saveToInbox(row).catch(() => {});
    notify('file', { row });
    return reply.send(row);
  });

  function inboxTargetDir() { return settings.inboxDir || paths().inbox; }
  async function saveToInbox(row) {
    const { files: FILES } = paths();
    const base = sanitizeDisplayName(row.name).replace(/"/g, '');
    let target = path.join(inboxTargetDir(), base);
    for (let n = 2; n < 1000; n++) {
      try { await fsp.access(target); } catch { break; }
      const dot = base.lastIndexOf('.');
      target = dot > 0
        ? path.join(inboxTargetDir(), `${base.slice(0, dot)}-${n}${base.slice(dot)}`)
        : path.join(inboxTargetDir(), `${base}-${n}`);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fsp.copyFile(path.join(FILES, row.file), target, fs.constants.COPYFILE_EXCL);
        return;
      } catch (e) {
        if (e?.code !== 'EEXIST' || attempt === 2) { console.error('inbox save:', e?.message || e); return; }
        const dot = base.lastIndexOf('.');
        target = dot > 0
          ? path.join(inboxTargetDir(), `${base.slice(0, dot)}-${Date.now() % 1000}${base.slice(dot)}`)
          : path.join(inboxTargetDir(), `${base}-${Date.now() % 1000}`);
      }
    }
  }

  app.get('/api/files', (req) => {
    const before = Number(req.query.before);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    if (Number.isInteger(before) && before > 0) return stmts.listFilesBefore.all(before, limit);
    return stmts.listFiles.all(limit);
  });

  app.get('/api/files/version', () => ({
    n: stmts.countFiles.get().c,
    latest: stmts.latestFileId.get()?.id ?? 0,
  }));

  app.get('/file/:id', async (req, reply) => {
    const row = stmts.getFile.get(req.params.id);
    if (!row) return reply.code(404).send();
    const filePath = path.join(paths().files, row.file);
    const { contentType, disposition } = fileServeHeaders(row.file, row.name);
    return streamFile(req, reply, filePath, { contentType, disposition });
  });

  app.delete('/api/files/:id', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const row = stmts.getFile.get(req.params.id);
    if (!row) return reply.code(404).send();
    const ok = await cleanup.removeFileRow(row);
    if (!ok) return reply.code(500).send({ error: 'deleted from database but file removal failed' });
    return { ok: true };
  });

  // Delete all transferred files (body-less) or specific file IDs ({ ids: [...] }).
  app.delete('/api/files', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const rawIds = req.body && req.body.ids;
    let ids = null;
    if (Array.isArray(rawIds)) {
      ids = [...new Set(rawIds.map(Number).filter(n => Number.isInteger(n) && n > 0))];
    } else if (rawIds != null) {
      return reply.code(400).send({ error: 'ids must be an array' });
    }
    if (ids) {
      const rows = ids.map(id => stmts.getFile.get(id)).filter(Boolean);
      let failed = 0;
      const CHUNK = 32;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const oks = await Promise.all(
          rows.slice(i, i + CHUNK).map(row => cleanup.removeFileRow(row, { silent: true })),
        );
        failed += oks.filter(ok => !ok).length;
      }
      if (rows.length) notify('file-deleted', { ids: rows.map(r => Number(r.id)) });
      return { ok: failed === 0, deleted: rows.length, failed };
    }
    const rows = db.transaction(() => {
      const r = stmts.listAllFileRowsForDelete.all();
      stmts.deleteAllFiles.run();
      return r;
    })();
    const RM_CHUNK = 32;
    let failed = 0;
    for (let i = 0; i < rows.length; i += RM_CHUNK) {
      await Promise.all(rows.slice(i, i + RM_CHUNK).map(async row => {
        if (await rmWithRetry(path.join(paths().files, row.file))) failed++;
      }));
    }
    bytes.setFiles(stmts.sumFileBytes.get().b);
    notify('file-deleted');
    if (failed) return reply.code(500).send({ ok: false, deleted: rows.length, failed, error: 'some files could not be removed' });
    return { ok: true, deleted: rows.length, failed: 0 };
  });

  return { MAX_FILE_BYTES };
}
