// server/text.js — two-way clipboard/note text sync HTTP endpoints.
export function registerText(app, { stmts, notify, csrfSafe }) {
  app.post('/api/text', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const b = req.body || {};
    const body = String(b.body || '').slice(0, 10000).trim();
    if (!body) return reply.code(400).send({ error: 'empty text' });
    const source = b.source === 'phone' ? 'phone' : 'pc';
    const isMediaLink = b.kind === 'media' || /^https?:\/\/[^/]+\/media\//.test(body);
    const kind = isMediaLink ? 'media' : 'text';
    const info = stmts.insertText.run(body, source, kind);
    if (kind === 'media') stmts.trimMediaTexts.run();
    stmts.trimTexts.run();
    notify('text');
    return { id: info.lastInsertRowid, ok: true };
  });

  app.get('/api/text', (req) => {
    const source = req.query.source === 'phone' || req.query.source === 'pc' ? req.query.source : null;
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10));
    if (source) return stmts.listTexts.all(source, limit);
    return stmts.listAllTexts.all(limit);
  });

  app.delete('/api/text', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const source = req.query.source === 'phone' || req.query.source === 'pc' ? req.query.source : null;
    const info = source ? stmts.deleteTextsBySource.run(source) : stmts.deleteAllTexts.run();
    notify('text');
    return { ok: true, removed: info.changes };
  });

  app.delete('/api/text/:id', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad id' });
    const info = stmts.deleteTextById.run(id);
    if (info.changes) notify('text');
    return { ok: true, removed: info.changes };
  });
}
