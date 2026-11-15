// server/settings.js — persisted settings, LAN/QR discovery, and system status routes.
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { mediaDirs, lanIPs } from './util.js';

export function initSettings({
  dataDir,
  adoptMediaDir,
  currentMediaBase,
  notify,
  bytes,
  ppVersion,
  maxPixels,
  getDefaultMaxStoreMB,
}) {
  const settingsFile = path.join(dataDir, 'settings.json');
  const settings = {
    version: 1,
    autoPaste: false,
    autoCleanup: false,
    filesToInbox: true,
    mediaDir: null,
    qualityReduce: false,
    qualityLevel: 80,
    storageCapMB: null,
    retentionDays: 0,
    inboxDir: null,
    browser: 'default',
  };

  try {
    const loaded = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (Number.isFinite(loaded?.version) && loaded.version >= 1) settings.version = loaded.version;
    for (const k of ['autoPaste', 'autoCleanup', 'filesToInbox', 'qualityReduce']) {
      if (typeof loaded?.[k] === 'boolean') settings[k] = loaded[k];
    }
    if (typeof loaded?.mediaDir === 'string' || loaded?.mediaDir === null) settings.mediaDir = loaded.mediaDir;
    if (Number.isFinite(loaded?.qualityLevel)) {
      settings.qualityLevel = Math.min(100, Math.max(1, Math.round(loaded.qualityLevel)));
    }
    if (Number.isFinite(loaded?.storageCapMB)) {
      settings.storageCapMB = loaded.storageCapMB >= 50 && loaded.storageCapMB <= 1024 * 1024
        ? Math.round(loaded.storageCapMB) : null;
    }
    if (Number.isFinite(loaded?.retentionDays)) {
      settings.retentionDays = Math.min(3650, Math.max(0, Math.round(loaded.retentionDays)));
    }
    if (typeof loaded?.inboxDir === 'string' || loaded?.inboxDir === null) settings.inboxDir = loaded.inboxDir;
    if (typeof loaded?.browser === 'string') settings.browser = loaded.browser;
  } catch {}

  if (typeof settings.mediaDir === 'string' && settings.mediaDir) {
    try {
      const base = path.resolve(settings.mediaDir);
      if (path.isAbsolute(base)) {
        for (const d of Object.values(mediaDirs(base))) fs.mkdirSync(d, { recursive: true });
        adoptMediaDir(base);
      }
    } catch (e) { console.warn('media dir adopt failed, using default:', e?.message || e); }
  }

  if (typeof settings.inboxDir === 'string' && settings.inboxDir) {
    try {
      const base = path.resolve(settings.inboxDir);
      if (path.isAbsolute(base)) { fs.mkdirSync(base, { recursive: true }); settings.inboxDir = base; }
      else settings.inboxDir = null;
    } catch (e) { console.warn('inbox dir adopt failed, using default:', e?.message || e); settings.inboxDir = null; }
  }

  function settingsBundle() {
    const defaultCapMB = getDefaultMaxStoreMB();
    return {
      version: ppVersion,
      autoPaste: { auto: settings.autoPaste },
      autoCleanup: { on: settings.autoCleanup, cap: (settings.storageCapMB || defaultCapMB) * 1024 * 1024, used: bytes.total },
      filesInbox: { on: settings.filesToInbox },
      quality: { on: settings.qualityReduce, level: settings.qualityLevel, maxPixels },
      storageCap: { capMb: settings.storageCapMB || defaultCapMB, custom: settings.storageCapMB != null },
      retention: { days: settings.retentionDays },
      inboxDir: { path: settings.inboxDir, def: currentMediaBase().inbox },
      mediaDir: { path: currentMediaBase().base, def: dataDir },
      browser: settings.browser,
    };
  }

  function saveSettings() {
    try {
      const tmp = `${settingsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(settings));
      fs.renameSync(tmp, settingsFile);
    } catch (e) {
      console.warn('settings save failed:', e?.message || e);
    }
    notify('settings', settingsBundle());
  }

  function registerRoutes(app, {
    csrfSafe,
    stmts,
    phones,
    sseClients,
    phoneOnlineMs,
    isPhoneSseClosed,
    trackPhone,
    scheme,
    port,
  }) {
    app.get('/api/stats', (req) => {
      let latest = null;
      let outboxSum = 0;
      const phoneList = [];
      for (const [ip, p] of phones) {
        outboxSum += p.outbox;
        const entry = { ip, lastSeen: p.lastSeen, outbox: p.outbox };
        phoneList.push(entry);
        if (!latest || p.lastSeen > latest.lastSeen) latest = entry;
      }
      const res = {
        version: ppVersion,
        count: stmts.countCaptures.get().c,
        bytes: bytes.total,
        cap: (settings.storageCapMB || getDefaultMaxStoreMB()) * 1024 * 1024,
        files: { count: stmts.countFiles.get().c, bytes: bytes.files },
        mediaDir: currentMediaBase().base,
        phoneLastSeen: latest?.lastSeen ?? 0,
        phoneOnline: !isPhoneSseClosed() && !!latest && Date.now() - latest.lastSeen < phoneOnlineMs,
        phoneOutbox: Math.min(999, outboxSum),
        phoneIp: latest?.ip || null,
        phoneCount: phoneList.length,
        phones: phoneList,
        sseClients: sseClients.size,
      };
      if (req.query?.include === 'recent') {
        res.recent = [
          ...stmts.listCaptures.all(3).map(c => ({
            kind: 'capture', id: c.id, label: 'Capture',
            dir: c.origin === 'pc' ? 'pc' : 'phone', at: c.created_at,
          })),
          ...stmts.listFiles.all(3).map(f => ({
            kind: 'file', id: f.id, label: f.name,
            dir: f.dir === 'phone' ? 'phone' : 'pc', at: f.created_at,
          })),
        ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 3);
      }
      return res;
    });

    app.post('/api/open-latest', (req, reply) => {
      if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
      notify('open-latest');
      return { ok: true };
    });

    app.get('/api/autopaste', () => ({ auto: settings.autoPaste }));
    app.post('/api/autopaste', (req, reply) => {
      if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
      const b = req.body || {};
      if (typeof b.auto !== 'boolean') return reply.code(400).send({ error: 'auto must be a boolean' });
      settings.autoPaste = !!b.auto;
      saveSettings();
      return { ok: true, auto: settings.autoPaste };
    });

    app.get('/api/quality', () => ({ on: settings.qualityReduce, level: settings.qualityLevel, maxPixels }));
    app.post('/api/quality', (req, reply) => {
      if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
      const b = req.body || {};
      if (typeof b.on !== 'boolean') return reply.code(400).send({ error: 'on must be a boolean' });
      const lvl = Math.round(Number(b.level));
      if (b.level != null && (!Number.isFinite(lvl) || lvl < 1 || lvl > 100)) {
        return reply.code(400).send({ error: 'level must be 1-100' });
      }
      settings.qualityReduce = b.on;
      if (b.level != null) settings.qualityLevel = lvl;
      saveSettings();
      return { ok: true, on: settings.qualityReduce, level: settings.qualityLevel };
    });

    app.get('/api/files-inbox', () => ({ on: settings.filesToInbox }));
    app.get('/api/settings', () => settingsBundle());

    const qrCache = new Map();
    app.get('/qr.png', async (req, reply) => {
      let ip = lanIPs()[0] || 'localhost';
      const want = String(req.query.ip || '');
      if (lanIPs().includes(want)) ip = want;
      let p = qrCache.get(ip);
      if (!p) {
        const url = `${scheme}://${ip}:${port}/phone`;
        p = QRCode.toBuffer(url, { width: 320, margin: 1 })
          .then(buf => {
            while (qrCache.size > 12) {
              const droppable = [...qrCache.keys()].filter(k => k !== ip);
              if (!droppable.length) break;
              qrCache.delete(droppable[0]);
            }
            return buf;
          })
          .catch(e => { qrCache.delete(ip); throw e; });
        qrCache.set(ip, p);
      }
      try {
        reply
          .header('Cache-Control', 'no-store')
          .type('image/png')
          .send(await p);
      } catch { qrCache.delete(ip); reply.code(500).send({ error: 'qr failed' }); }
    });

    app.get('/api/lan', (req) => {
      if (req.query.device === 'phone') {
        const n = parseInt(req.query.outbox, 10);
        if (trackPhone(req.ip, Number.isFinite(n) && n >= 0 ? n : undefined)) notify('phone');
      }
      return { ips: lanIPs(), port, scheme };
    });

    app.get('/api/version', () => ({ version: ppVersion }));
  }

  return { settings, settingsFile, settingsBundle, saveSettings, registerRoutes };
}
