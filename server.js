import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import QRCode from 'qrcode';
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
import { registerCleanup } from './server/cleanup.js';
import { registerMediaDir } from './server/mediadir.js';
import { registerBackup } from './server/backup.js';
import { createStore, MAX_PIXELS } from './server/store.js';
import { registerFiles } from './server/files.js';
import { registerCaptures } from './server/captures.js';
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
      .header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
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

const LOCK_FILE = path.join(DATA, 'proofpipe.lock');
function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
}
const LOCK_BOOT_GRACE_MS = 20_000;
async function lockAlive(lock) {
  if (!lock || typeof lock.pid !== 'number' || lock.pid === process.pid) return false;
  let pidExists = false;
  try { process.kill(lock.pid, 0); pidExists = true; }
  catch (e) { pidExists = e.code === 'EPERM'; }
  if (!pidExists) return false;
  const port = Number(lock.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return true;
  const age = Date.now() - Date.parse(lock.started || '');
  if (Number.isFinite(age) && age < LOCK_BOOT_GRACE_MS) return true;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json();
    return typeof j.version === 'string' && /^v\d/.test(j.version);
  } catch { return false; }
}
async function acquireLock() {
  const payload = JSON.stringify({ pid: process.pid, port: PORT, started: new Date().toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
      return;
    } catch (e) {
      if (e?.code !== 'EEXIST') break;
    }
    const existing = readLock();
    if (await lockAlive(existing)) {
      console.error(`ProofPipe is ALREADY RUNNING (pid ${existing.pid}, started ${existing.started}).`);
      console.error(`Stop it first (close its window / Ctrl+C), or point PP_DATA elsewhere.`);
      process.exit(1);
    }
    try { fs.rmSync(LOCK_FILE, { force: true }); } catch {}
  }
  try { fs.writeFileSync(LOCK_FILE, payload); }
  catch (e) {
    console.error('Could not write the instance lock:', e.message);
    process.exit(1);
  }
}
await acquireLock();

const RATE = {
  capacity: Number(process.env.PP_RATE_CAPACITY) || 120,
  refillPerMin: Number(process.env.PP_RATE_REFILL_PER_MIN) || 240,
};
const photoBucket = createTokenBucket({ ...RATE, logEvent, kind: 'photo' });

setInterval(() => {
  bytes.set(stmts.sumBytes.get().b);
  bytes.setFiles(stmts.sumFileBytes.get().b);
}, 15 * 60 * 1000).unref();

setInterval(() => { runRetentionSweep().catch(() => {}); }, 60 * 60 * 1000).unref();

const FILE_RATE = {
  capacity: Number(process.env.PP_FILE_RATE_CAPACITY) || 60,
  refillPerMin: Number(process.env.PP_FILE_RATE_REFILL_PER_MIN) || 60,
};
const fileBucket = createTokenBucket({ ...FILE_RATE, logEvent, kind: 'file' });

app.post('/upload', { bodyLimit: UPLOAD_BODY_LIMIT }, async (req, reply) => {
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

app.post('/share', { bodyLimit: UPLOAD_BODY_LIMIT }, async (req, reply) => {
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
      try { const cap = stmts.getCapture.get(s.id); if (cap) await removeCaptureRow(cap); } catch {}
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

app.get('/api/stats', () => {
  let latest = null;
  let outboxSum = 0;
  const phoneList = [];
  for (const [ip, p] of phones) {
    outboxSum += p.outbox;
    const entry = { ip, lastSeen: p.lastSeen, outbox: p.outbox };
    phoneList.push(entry);
    if (!latest || p.lastSeen > latest.lastSeen) latest = entry;
  }
  return {
    version: PP_VERSION,
    count: stmts.countCaptures.get().c,
    bytes: bytes.total,
    cap: (settings.storageCapMB || defaultMaxStoreMB) * 1024 * 1024,
    files: { count: stmts.countFiles.get().c, bytes: bytes.files },
    mediaDir: mediaBase,
    phoneLastSeen: latest?.lastSeen ?? 0,
    phoneOnline: !phoneSseClosed && !!latest && Date.now() - latest.lastSeen < PHONE_ONLINE_MS,
    phoneOutbox: Math.min(999, outboxSum),
    phoneIp: latest?.ip || null,
    phoneCount: phoneList.length,
    phones: phoneList,
    sseClients: sseClients.size,
    recent: [
      ...stmts.listCaptures.all(3).map(c => ({
        kind: 'capture', id: c.id, label: 'Capture',
        dir: c.origin === 'pc' ? 'pc' : 'phone', at: c.created_at,
      })),
      ...stmts.listFiles.all(3).map(f => ({
        kind: 'file', id: f.id, label: f.name,
        dir: f.dir === 'phone' ? 'phone' : 'pc', at: f.created_at,
      })),
    ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 3),
  };
});

app.post('/api/open-latest', (req, reply) => {
  if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
  notify('open-latest'); return { ok: true };
});

const SETTINGS_FILE = path.join(DATA, 'settings.json');
const settings = { version: 1, autoPaste: false, autoCleanup: false, filesToInbox: true, mediaDir: null, qualityReduce: false, qualityLevel: 80, storageCapMB: null, retentionDays: 0, inboxDir: null, browser: 'default' };
try {
  const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (Number.isFinite(loaded?.version) && loaded.version >= 1) settings.version = loaded.version;
  for (const k of ['autoPaste', 'autoCleanup', 'filesToInbox', 'qualityReduce']) {
    if (typeof loaded?.[k] === 'boolean') settings[k] = loaded[k];
  }
  if (typeof loaded?.mediaDir === 'string' || loaded?.mediaDir === null) settings.mediaDir = loaded.mediaDir;
  if (Number.isFinite(loaded?.qualityLevel)) settings.qualityLevel = Math.min(100, Math.max(1, Math.round(loaded.qualityLevel)));
  if (Number.isFinite(loaded?.storageCapMB)) settings.storageCapMB = loaded.storageCapMB >= 50 && loaded.storageCapMB <= 1024 * 1024 ? Math.round(loaded.storageCapMB) : null;
  if (Number.isFinite(loaded?.retentionDays)) settings.retentionDays = Math.min(3650, Math.max(0, Math.round(loaded.retentionDays)));
  if (typeof loaded?.inboxDir === 'string' || loaded?.inboxDir === null) settings.inboxDir = loaded.inboxDir;
  if (typeof loaded?.browser === 'string') settings.browser = loaded.browser;
} catch {}

if (typeof settings.mediaDir === 'string' && settings.mediaDir) {
  try {
    const base = path.resolve(settings.mediaDir);
    if (path.isAbsolute(base)) {
      for (const d of Object.values(mediaDirs(base))) fs.mkdirSync(d, { recursive: true });
      mediaBase = base;
      ({ captures: CAPTURES, files: FILES, inbox: INBOX } = mediaDirs(mediaBase));
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
  return {
    version: PP_VERSION,
    autoPaste: { auto: settings.autoPaste },
    autoCleanup: { on: settings.autoCleanup, cap: (settings.storageCapMB || defaultMaxStoreMB) * 1024 * 1024, used: bytes.total },
    filesInbox: { on: settings.filesToInbox },
    quality: { on: settings.qualityReduce, level: settings.qualityLevel, maxPixels: MAX_PIXELS },
    storageCap: { capMb: settings.storageCapMB || defaultMaxStoreMB, custom: settings.storageCapMB != null },
    retention: { days: settings.retentionDays },
    inboxDir: { path: settings.inboxDir, def: currentMediaBase().inbox },
    mediaDir: { path: currentMediaBase().base, def: DATA },
    browser: settings.browser,
  };
}

function saveSettings() {
  try {
    const tmp = `${SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings));
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (e) {
    console.warn('settings save failed:', e?.message || e);
  }
  notify('settings', settingsBundle());
}

function setAutoPaste(on) {
  settings.autoPaste = !!on;
  saveSettings();
}
app.get('/api/autopaste', () => ({ auto: settings.autoPaste }));
app.post('/api/autopaste', (req, reply) => {
  if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
  const b = req.body || {};
  if (typeof b.auto !== 'boolean') return reply.code(400).send({ error: 'auto must be a boolean' });
  setAutoPaste(b.auto);
  return { ok: true, auto: settings.autoPaste };
});

const autoCaptureIds = new Set();
const {
  runRetentionSweep, runAutoCleanup, runFileCleanup, removeCaptureRow, removeFileRow,
  defaultMaxStoreMB,
} = registerCleanup(app, {
  settings, stmts, db, bytes, notify, saveSettings, csrfSafe, logEvent, autoCaptureIds, paths: currentMediaBase,
});
registerMediaDir(app, { settings, saveSettings, csrfSafe, DATA, adoptMediaDir, currentMediaBase });
registerBackup(app, { csrfSafe, DATA, SETTINGS_FILE, currentMediaBase, db });
const { openHarness } = registerBrowser(app, { settings, saveSettings, csrfSafe });

const store = createStore({
  sharp, settings, stmts, db, bytes, notify, logEvent, autoCaptureIds, paths: currentMediaBase,
  browserPresent: sseHub.hasBrowser,
  cleanup: { runRetentionSweep, runAutoCleanup },
});
const { bootSweep, storeCapturedParts, thumbFor } = store;

registerCaptures(app, {
  stmts, db, bytes, notify, csrfSafe, autoCaptureIds, paths: currentMediaBase,
  cleanup: { removeCaptureRow },
});

registerFiles(app, {
  settings, stmts, db, bytes, notify, csrfSafe, fileBucket, paths: currentMediaBase,
  cleanup: { runFileCleanup, removeFileRow }, streamFile,
});

app.get('/api/quality', () => ({ on: settings.qualityReduce, level: settings.qualityLevel, maxPixels: MAX_PIXELS }));
app.post('/api/quality', (req, reply) => {
  if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
  const b = req.body || {};
  if (typeof b.on !== 'boolean') return reply.code(400).send({ error: 'on must be a boolean' });
  const lvl = Math.round(Number(b.level));
  if (b.level != null && (!Number.isFinite(lvl) || lvl < 1 || lvl > 100))
    return reply.code(400).send({ error: 'level must be 1-100' });
  settings.qualityReduce = b.on;
  if (b.level != null) settings.qualityLevel = lvl;
  saveSettings();
  return { ok: true, on: settings.qualityReduce, level: settings.qualityLevel };
});

app.get('/api/files-inbox', () => ({ on: settings.filesToInbox }));
app.get('/api/settings', () => settingsBundle());

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

const qrCache = new Map();
app.get('/qr.png', async (req, reply) => {
  let ip = lanIPs()[0] || 'localhost';
  const want = String(req.query.ip || '');
  if (lanIPs().includes(want)) ip = want;
  let p = qrCache.get(ip);
  if (!p) {
    const url = `${SCHEME}://${ip}:${PORT}/phone`;
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
  return { ips: lanIPs(), port: PORT, scheme: SCHEME };
});

app.get('/api/version', () => ({ version: PP_VERSION }));

app.get('/phone', async (_req, reply) => {
  const html = phoneHtml ??= await fsp.readFile(path.join(ROOT, 'public', 'phone.html'), 'utf8');
  const stamped = html
    .replace('/phone.css?v=__PP_VERSION__', `/phone.css?v=${assetStamp('phone.css')}`)
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

function releaseLock() {
  try {
    const lock = readLock();
    if (lock && lock.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch {}
}
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
