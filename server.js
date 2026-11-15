import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import compress from '@fastify/compress';
import { mediaDirs, lanIPs, mediaContentType } from './server/util.js';
import { bytes } from './server/bytes.js';
import { createSseHub } from './server/sse.js';
import { createTokenBucket } from './server/ratelimit.js';
import { createLockManager } from './server/lockfile.js';
import { initSettings } from './server/settings.js';
import { registerCleanup } from './server/cleanup.js';
import { registerMediaDir } from './server/mediadir.js';
import { registerBackup } from './server/backup.js';
import { createStore, MAX_PIXELS } from './server/store.js';
import { registerFiles } from './server/files.js';
import { registerCaptures } from './server/captures.js';
import { registerText } from './server/text.js';
import { registerBrowser } from './server/browser.js';

// Set libuv threadpool size before loading native modules (sqlite, sharp).
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';
const Database = (await import('./server/sqlite.js')).default;
const sharp = (await import('sharp')).default;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.PP_DATA ? path.resolve(process.env.PP_DATA) : path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

let mediaBase = DATA;
let { captures: CAPTURES, files: FILES, inbox: INBOX } = mediaDirs(mediaBase);
const currentMediaBase = () => ({ base: mediaBase, captures: CAPTURES, files: FILES, inbox: INBOX });
const adoptMediaDir = (base) => {
  mediaBase = base;
  ({ captures: CAPTURES, files: FILES, inbox: INBOX } = mediaDirs(mediaBase));
};
for (const d of [CAPTURES, FILES, INBOX]) fs.mkdirSync(d, { recursive: true });

const db = new Database(path.join(DATA, 'proofpipe.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('mmap_size = 268435456');
db.pragma('cache_size = -16000');

const PP_VERSION = 'v' + JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const stampCache = new Map();
const assetStamp = (file) => {
  try {
    const fp = path.join(ROOT, 'public', file);
    const st = fs.statSync(fp);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = stampCache.get(file);
    if (hit && hit.key === key) return hit.stamp;
    const stamp = createHash('sha1').update(fs.readFileSync(fp)).digest('hex').slice(0, 10);
    stampCache.set(file, { key, stamp });
    return stamp;
  } catch {
    return PP_VERSION.replace(/[^a-z0-9]/gi, '');
  }
};

const userVersion = db.pragma('user_version', { simple: true });
const tableExists = name =>
  !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
const MIGRATIONS = [
  {
    to: 1,
    run(db) {
      for (const t of ['problems', 'messages', 'settings'])
        db.exec(`DROP TABLE IF EXISTS ${t}`);
      if (!tableExists('captures')) return;
      try { db.exec('ALTER TABLE captures DROP COLUMN used'); } catch (e) { console.warn('migration v1: drop used:', e.message); }
      try { db.exec('ALTER TABLE captures DROP COLUMN tag'); } catch (e) { console.warn('migration v1: drop tag:', e.message); }
      try { db.exec('ALTER TABLE captures ADD COLUMN bytes INTEGER'); } catch (e) { console.warn('migration v1: add bytes:', e.message); }
    },
  },
  {
    to: 2,
    run(db) {
      if (!tableExists('captures')) return;
      try { db.exec('ALTER TABLE captures ADD COLUMN origin TEXT'); } catch (e) { console.warn('migration v2: add origin:', e.message); }
    },
  },
  {
    to: 3,
    run(db) {
      db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        file TEXT NOT NULL,
        mime TEXT,
        bytes INTEGER,
        dir TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );`);
    },
  },
  {
    to: 4,
    run(db) {
      if (!tableExists('captures')) return;
      try { db.exec('ALTER TABLE captures ADD COLUMN dedupe_key TEXT'); } catch (e) { console.warn('migration v4: add dedupe_key:', e.message); }
      try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_captures_dedupe ON captures(dedupe_key) WHERE dedupe_key IS NOT NULL'); } catch (e) { console.warn('migration v4: dedupe index:', e.message); }
    },
  },
  {
    to: 5,
    run(db) {
      if (!tableExists('texts')) return;
      try { db.exec("ALTER TABLE texts ADD COLUMN kind TEXT DEFAULT 'text'"); } catch (e) { console.warn('migration v5: add kind:', e.message); }
      try { db.exec("UPDATE texts SET kind = 'media' WHERE kind IS NULL AND instr(body, '/media/') > 0"); } catch {}
      try { db.exec("UPDATE texts SET kind = 'text' WHERE kind IS NULL"); } catch {}
    },
  },
];
for (const m of MIGRATIONS) {
  if (userVersion < m.to) db.transaction(() => m.run(db))();
}
if (userVersion < MIGRATIONS.length) db.pragma(`user_version = ${MIGRATIONS.length}`);

db.exec(`
CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  bytes INTEGER,
  origin TEXT,
  dedupe_key TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_captures_dedupe ON captures(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_captures_file ON captures(file);
CREATE INDEX IF NOT EXISTS idx_captures_created_at ON captures(created_at);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  source TEXT DEFAULT 'pc',
  created_at TEXT DEFAULT (datetime('now')),
  kind TEXT DEFAULT 'text'
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER,
  dir TEXT DEFAULT 'pc',
  created_at TEXT DEFAULT (datetime('now'))
);
`);

const CAPTURE_COLS = 'id, file, created_at, bytes, origin';
const stmts = {
  insertCapture: db.prepare('INSERT INTO captures(file, bytes, origin, dedupe_key) VALUES (?, ?, ?, ?)'),
  getCaptureByDedupeKey: db.prepare(`SELECT ${CAPTURE_COLS} FROM captures WHERE dedupe_key = ?`),
  getCaptureByFile: db.prepare('SELECT id, file FROM captures WHERE file = ?'),
  listCaptures: db.prepare(`SELECT ${CAPTURE_COLS} FROM captures ORDER BY id DESC LIMIT ?`),
  listCapturesBefore: db.prepare(`SELECT ${CAPTURE_COLS} FROM captures WHERE id < ? ORDER BY id DESC LIMIT ?`),
  listAllCaptureFiles: db.prepare('SELECT id, file FROM captures'),
  listCapturesMissingBytes: db.prepare('SELECT id, file FROM captures WHERE bytes IS NULL OR bytes = 0'),
  listAllCaptureRowsForDelete: db.prepare('SELECT id, file, bytes FROM captures'),
  listExpiredCaptures: db.prepare(`SELECT ${CAPTURE_COLS} FROM captures WHERE created_at < datetime('now', ?) ORDER BY id ASC LIMIT 500`),
  oldestCapture: db.prepare(`SELECT ${CAPTURE_COLS} FROM captures ORDER BY id ASC LIMIT 1`),
  getCapture: db.prepare(`SELECT ${CAPTURE_COLS} FROM captures WHERE id = ?`),
  deleteCapture: db.prepare('DELETE FROM captures WHERE id = ?'),
  deleteAllCaptures: db.prepare('DELETE FROM captures'),
  countCaptures: db.prepare('SELECT COUNT(*) AS c FROM captures'),
  sumBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM captures'),
  latestCaptureId: db.prepare('SELECT id FROM captures ORDER BY id DESC LIMIT 1'),
  backfillBytes: db.prepare('UPDATE captures SET bytes = ? WHERE id = ? AND bytes IS NULL'),
  addThumbBytes: db.prepare('UPDATE captures SET bytes = COALESCE(bytes, 0) + ? WHERE id = ?'),
  insertText: db.prepare('INSERT INTO texts(body, source, kind) VALUES (?, ?, ?)'),
  trimTexts: db.prepare("DELETE FROM texts WHERE kind = 'text' AND id NOT IN (SELECT id FROM texts WHERE kind = 'text' ORDER BY id DESC LIMIT 20)"),
  trimMediaTexts: db.prepare("DELETE FROM texts WHERE kind = 'media' AND id NOT IN (SELECT id FROM texts WHERE kind = 'media' ORDER BY id DESC LIMIT 200)"),
  listTexts: db.prepare('SELECT * FROM texts WHERE source = ? ORDER BY id DESC LIMIT ?'),
  latestTextId: db.prepare('SELECT id FROM texts ORDER BY id DESC LIMIT 1'),
  listAllTexts: db.prepare('SELECT * FROM texts ORDER BY id DESC LIMIT ?'),
  deleteTextsBySource: db.prepare('DELETE FROM texts WHERE source = ?'),
  deleteTextById: db.prepare('DELETE FROM texts WHERE id = ?'),
  deleteTextsForCapture: db.prepare('DELETE FROM texts WHERE instr(body, ?) > 0'),
  deleteAllTexts: db.prepare('DELETE FROM texts'),
  updateCaptureFileAndBytes: db.prepare('UPDATE captures SET file = ?, bytes = ? WHERE id = ?'),
  updateTextBodyByMedia: db.prepare('UPDATE texts SET body = replace(body, ?, ?) WHERE instr(body, ?) > 0'),
  insertFile: db.prepare("INSERT INTO files(name, file, mime, bytes, dir) VALUES (?, ?, ?, ?, ?)"),
  listFiles: db.prepare('SELECT * FROM files ORDER BY id DESC LIMIT ?'),
  listFilesBefore: db.prepare('SELECT * FROM files WHERE id < ? ORDER BY id DESC LIMIT ?'),
  listAllFileNames: db.prepare('SELECT file FROM files'),
  listAllFileRowsForDelete: db.prepare('SELECT id, file, bytes FROM files'),
  oldestFile: db.prepare('SELECT * FROM files ORDER BY id ASC LIMIT 1'),
  getFile: db.prepare('SELECT * FROM files WHERE id = ?'),
  deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),
  deleteAllFiles: db.prepare('DELETE FROM files'),
  countFiles: db.prepare('SELECT COUNT(*) AS c FROM files'),
  sumFileBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM files'),
  latestFileId: db.prepare('SELECT id FROM files ORDER BY id DESC LIMIT 1'),
};

let httpsOpts = null;
try {
  httpsOpts = {
    key: fs.readFileSync(path.join(DATA, 'key.pem')),
    cert: fs.readFileSync(path.join(DATA, 'cert.pem')),
  };
} catch {}
const SCHEME = httpsOpts ? 'https' : 'http';
const VERBOSE_LOG = process.env.PP_LOG === '1' || /^(debug|trace)$/i.test(process.env.PP_LOG || '');
const logEvent = (name, data = {}) => {
  try { process.stderr.write(JSON.stringify({ t: Date.now(), ev: name, ...data }) + '\n'); }
  catch {}
};

// Default 1 MB bodyLimit for JSON routes; multipart upload routes specify their own 21 MB ceiling.
const UPLOAD_BODY_LIMIT = 21 * 1024 * 1024;
const app = Fastify({
  logger: { level: 'error', stream: { write: (s) => process.stderr.write(s) } },
  bodyLimit: 1024 * 1024,
  ...(httpsOpts ? { https: httpsOpts } : {}),
});
app.server.keepAliveTimeout = 65_000;
app.server.headersTimeout = 66_000;

app.addHook('onRequest', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    reply
      .header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
      .header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*')
      .header('Access-Control-Max-Age', '86400');
    if (req.headers['access-control-request-private-network'] === 'true')
      reply.header('Access-Control-Allow-Private-Network', 'true');
    return reply.code(204).send();
  }
});

function trustedExtensionOrigin() {
  const envId = String(process.env.PP_EXTENSION_ID || '').trim();
  if (/^[a-p]{32}$/i.test(envId)) return `chrome-extension://${envId.toLowerCase()}`;
  try {
    const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
    if (typeof mf.key === 'string' && mf.key) {
      const der = Buffer.from(mf.key, 'base64');
      const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
      const id = hex.replace(/[0-9a-f]/g, c => 'abcdefghijklmnop'[parseInt(c, 16)]);
      if (/^[a-p]{32}$/.test(id)) return `chrome-extension://${id}`;
    }
  } catch (e) { console.warn('extension id derive failed:', e?.message || e); }
  return null;
}
const TRUSTED_EXTENSION_ORIGIN = trustedExtensionOrigin();

function csrfSafe(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  if (/^chrome-extension:\/\//i.test(origin)) {
    if (TRUSTED_EXTENSION_ORIGIN) return origin.toLowerCase().replace(/\/$/, '') === TRUSTED_EXTENSION_ORIGIN;
    return /^chrome-extension:\/\/[a-p]{32}$/i.test(origin);
  }
  const host = String(req.headers.host || '');
  try {
    const originHost = new URL(origin).host;
    if (originHost !== host) return false;
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (/^(localhost|127(\.\d+){3}|\[::1\]|::1)$/i.test(hostname)) return true;
    return lanIPs().includes(hostname);
  } catch { return false; }
}

app.addHook('onResponse', async (req, reply) => {
  const url = (req.raw.url || '').split('?')[0];
  if (VERBOSE_LOG) {
    console.log(`${req.method} ${url} ${reply.statusCode}`);
  } else if (url === '/upload' || url === '/share' || url === '/api/files' || req.method === 'DELETE') {
    console.log(`${req.method} ${url} ${reply.statusCode}`);
  }
});

const sseHub = createSseHub(app, { logEvent, onPhonePresence });
const notify = sseHub.notify;
const sseClients = { get size() { return sseHub.clientCount(); } };

const PHONE_ONLINE_MS = 90 * 1000;
const PHONE_SSE_GRACE_MS = 4000;
let phoneSseClosed = false;
let phoneGoneTimer = null;
function onPhonePresence(anyPhoneConnected) {
  if (anyPhoneConnected) {
    phoneSseClosed = false;
    if (phoneGoneTimer) { clearTimeout(phoneGoneTimer); phoneGoneTimer = null; }
    notify('phone');
    return;
  }
  if (phoneGoneTimer) return;
  phoneGoneTimer = setTimeout(() => {
    phoneGoneTimer = null;
    phoneSseClosed = true;
    notify('phone');
  }, PHONE_SSE_GRACE_MS);
}

const phones = new Map();
const PHONE_SLOTS = 10;
const PHONE_STALE_MS = 45 * 24 * 3600 * 1000;
function trackPhone(rawIp, outbox) {
  const ip = String(rawIp || '').replace(/^::ffff:/, '');
  if (!ip) return false;
  const now = Date.now();
  const prev = phones.get(ip);
  const justCameOnline = !prev || now - prev.lastSeen > PHONE_ONLINE_MS;
  const wasDeclaredGone = phoneSseClosed;
  phoneSseClosed = false;
  if (prev) phones.delete(ip);
  phones.set(ip, { lastSeen: now, outbox: Math.max(0, Math.min(999, outbox ?? 0)) });
  for (const [ip2, p] of phones) {
    if (now - p.lastSeen > PHONE_STALE_MS || phones.size > PHONE_SLOTS) phones.delete(ip2);
  }
  return justCameOnline || wasDeclaredGone;
}

await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
await app.register(compress, { global: true, threshold: 1024 });
await app.register(fastifyStatic, {
  root: path.join(ROOT, 'public'),
  setHeaders: (reply, filePath) => {
    if (filePath.endsWith('sw.js')) reply.header('Cache-Control', 'no-store');
    else reply.header('Cache-Control', 'public, max-age=86400, must-revalidate');
  },
});

let indexHtml = null;
let phoneHtml = null;
try { indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'); } catch {}
app.get('/', async (_req, reply) => {
  const html = (indexHtml ??= await fsp.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8'));
  const stamped = html
    .replace('__ASSET_STYLE__', assetStamp('style.css'))
    .replace('__ASSET_SHARED__', assetStamp('shared.js'))
    .replace('__ASSET_RELEASES__', assetStamp('releases.js'))
    .replace('__ASSET_APP__', assetStamp('app.js'));
  return reply.type('text/html').send(stamped.replaceAll('__PP_VERSION__', PP_VERSION));
});

async function streamFile(req, reply, absPath, { contentType, disposition = null, immutable = true } = {}) {
  let st;
  try { st = await fsp.stat(absPath); } catch { return reply.code(404).send(); }
  if (!st.isFile()) return reply.code(404).send();
  const total = st.size;
  if (immutable) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
  reply.header('Accept-Ranges', 'bytes');
  if (contentType) reply.header('Content-Type', contentType);
  if (disposition) reply.header('Content-Disposition', disposition);
  const range = String(req.headers.range || '');
  if (!range) {
    reply.header('Content-Length', total);
    return reply.send(fs.createReadStream(absPath, { highWaterMark: 256 * 1024 }));
  }
  const rangeHeader = range.trim();
  if (rangeHeader.includes(',')) {
    reply.header('Content-Length', total);
    return reply.send(fs.createReadStream(absPath, { highWaterMark: 256 * 1024 }));
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  const bad = () => { reply.header('Content-Range', `bytes */${total}`); return reply.code(416).send(); };
  if (!m || (m[1] === '' && m[2] === '')) return bad();
  let start, end;
  if (m[1] === '') {
    const n = parseInt(m[2], 10);
    if (!Number.isFinite(n) || n <= 0) return bad();
    start = Math.max(0, total - Math.min(n, total)); end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || end < start) return bad();
    end = Math.min(end, total - 1);
  }
  if (total === 0) { reply.header('Content-Length', 0); return reply.send(); }
  reply.code(206);
  reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
  reply.header('Content-Length', end - start + 1);
  return reply.send(fs.createReadStream(absPath, { start, end, highWaterMark: 256 * 1024 }));
}

app.get('/media/*', async (req, reply) => {
  const name = req.params['*'] || '';
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..') || name.startsWith('.')) return reply.code(404).send();
  const fp = path.resolve(CAPTURES, name);
  if (path.relative(CAPTURES, fp).startsWith('..') || path.dirname(fp) !== CAPTURES)
    return reply.code(404).send();
  if (name.startsWith('t-') && !fs.existsSync(fp)) {
    const thumb = await thumbFor(name.slice(2)).catch(() => null);
    if (!thumb) return reply.code(404).send();
    return reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('Content-Type', mediaContentType(name))
      .send(thumb);
  }
  return streamFile(req, reply, fp, { contentType: mediaContentType(name) });
});

const PORT = Number(process.env.PORT) || 8787;
const { acquireLock, releaseLock } = createLockManager({
  lockFile: path.join(DATA, 'proofpipe.lock'),
  port: PORT,
});
await acquireLock();

const RATE = {
  capacity: Number(process.env.PP_RATE_CAPACITY) || 120,
  refillPerMin: Number(process.env.PP_RATE_REFILL_PER_MIN) || 240,
};
const photoBucket = createTokenBucket({ ...RATE, logEvent, kind: 'photo' });

const FILE_RATE = {
  capacity: Number(process.env.PP_FILE_RATE_CAPACITY) || 60,
  refillPerMin: Number(process.env.PP_FILE_RATE_REFILL_PER_MIN) || 60,
};
const fileBucket = createTokenBucket({ ...FILE_RATE, logEvent, kind: 'file' });

setInterval(() => {
  bytes.set(stmts.sumBytes.get().b);
  bytes.setFiles(stmts.sumFileBytes.get().b);
}, 15 * 60 * 1000).unref();

setInterval(() => { runRetentionSweep().catch(() => {}); }, 60 * 60 * 1000).unref();

let defaultMaxStoreMB = 2048;
const {
  settings, settingsFile, saveSettings, registerRoutes: registerSettingsRoutes,
} = initSettings({
  dataDir: DATA,
  adoptMediaDir,
  currentMediaBase,
  notify,
  bytes,
  ppVersion: PP_VERSION,
  maxPixels: MAX_PIXELS,
  getDefaultMaxStoreMB: () => defaultMaxStoreMB,
});

const autoCaptureIds = new Set();
const cleanup = registerCleanup(app, {
  settings, stmts, db, bytes, notify, saveSettings, csrfSafe, logEvent, autoCaptureIds, paths: currentMediaBase,
});
const { runRetentionSweep, runAutoCleanup, runFileCleanup, removeCaptureRow, removeFileRow } = cleanup;
defaultMaxStoreMB = cleanup.defaultMaxStoreMB;

registerMediaDir(app, { settings, saveSettings, csrfSafe, DATA, adoptMediaDir, currentMediaBase });
registerBackup(app, { csrfSafe, DATA, SETTINGS_FILE: settingsFile, currentMediaBase, db });
const { openHarness } = registerBrowser(app, { settings, saveSettings, csrfSafe });

const store = createStore({
  sharp, settings, stmts, db, bytes, notify, logEvent, autoCaptureIds, paths: currentMediaBase,
  browserPresent: sseHub.hasBrowser,
  cleanup: { runRetentionSweep, runAutoCleanup },
});
const { bootSweep, storeCapturedParts, thumbFor, rotateCapture, getCapturesRev } = store;

registerCaptures(app, {
  settings, stmts, db, bytes, notify, csrfSafe, autoCaptureIds, paths: currentMediaBase,
  cleanup: { removeCaptureRow },
  photoBucket, uploadBodyLimit: UPLOAD_BODY_LIMIT, storeCapturedParts, rotateCapture, getCapturesRev,
});

registerFiles(app, {
  settings, stmts, db, bytes, notify, csrfSafe, fileBucket, paths: currentMediaBase,
  cleanup: { runFileCleanup, removeFileRow }, streamFile,
});

registerText(app, { stmts, notify, csrfSafe });

registerSettingsRoutes(app, {
  csrfSafe, stmts, phones, sseClients, phoneOnlineMs: PHONE_ONLINE_MS,
  isPhoneSseClosed: () => phoneSseClosed, trackPhone, scheme: SCHEME, port: PORT,
});

app.get('/phone', async (_req, reply) => {
  const html = phoneHtml ??= await fsp.readFile(path.join(ROOT, 'public', 'phone.html'), 'utf8');
  const stamped = html
    .replace('/phone.css?v=__PP_VERSION__', `/phone.css?v=${assetStamp('phone.css')}`)
    .replace('/shared.js?v=__PP_VERSION__', `/shared.js?v=${assetStamp('shared.js')}`)
    .replace('/phone-viewer.js?v=__PP_VERSION__', `/phone-viewer.js?v=${assetStamp('phone-viewer.js')}`)
    .replace('/phone-files.js?v=__PP_VERSION__', `/phone-files.js?v=${assetStamp('phone-files.js')}`)
    .replace('/phone.js?v=__PP_VERSION__', `/phone.js?v=${assetStamp('phone.js')}`);
  reply.header('Cache-Control', 'no-store');
  return reply.type('text/html').send(stamped);
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`ProofPipe running (${SCHEME})`);
  console.log(`  Web     : http://localhost:${PORT}`);
  for (const ip of lanIPs()) console.log(`  Phone   : http://${ip}:${PORT}/phone`);
  console.log(TRUSTED_EXTENSION_ORIGIN
    ? `  Extension: ${TRUSTED_EXTENSION_ORIGIN}`
    : '  Extension: id unknown — any chrome-extension origin is trusted (add a manifest key or set PP_EXTENSION_ID)');
  bootSweep().catch(() => {});
  if (process.env.PP_OPEN_BROWSER === '1') {
    openHarness(`${SCHEME}://localhost:${PORT}`).catch(() => {});
  }
}).catch(e => { console.error('LISTEN FAILED:', e); process.exit(1); });

process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {
  console.log('\nShutting down...');
  releaseLock();
  sseHub.destroyAll();
  const hardExit = setTimeout(() => process.exit(0), 1500);
  (async () => {
    try { await app.close(); db.close(); } catch {}
    clearTimeout(hardExit);
    process.exit(0);
  })();
});
