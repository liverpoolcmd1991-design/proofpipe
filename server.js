import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import QRCode from 'qrcode';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// more libuv threads so parallel uploads don't queue behind each other (fs + sharp share the pool)
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';
// CRITICAL ordering: better-sqlite3 and sharp are NATIVE and grab the libuv
// threadpool on load, and UV_THREADPOOL_SIZE is only read once at pool init.
// ESM static imports hoist — they'd initialize the pool BEFORE the env var
// above runs, freezing it at the default of 4. So these two are imported
// dynamically, AFTER the env var is set. (There is NO --threadpool-size CLI
// flag — that proposal was never merged and passing one exits "bad option";
// the environment variable is the only mechanism. ProofPipe.bat exports it
// before `node`, and `npm start` preloads scripts/threadpool.cjs for the same
// reason. Do not re-import these two statically.)
const Database = (await import('better-sqlite3')).default;
const sharp = (await import('sharp')).default;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// PP_DATA lets tests/sandbox runs point at a scratch dir without touching real captures
const DATA = process.env.PP_DATA ? path.resolve(process.env.PP_DATA) : path.join(ROOT, 'data');
for (const d of [DATA]) fs.mkdirSync(d, { recursive: true });
// Media (captures + transfer files + inbox copies) lives under one base the
// user can relocate from the PC harness. The DB always stays in DATA — only
// these three dirs move, so relocation never touches the database handle.
// mediaDirs() lives in server/util.js (pure, no server state).
let mediaBase = DATA;
let { captures: CAPTURES, files: FILES, inbox: INBOX } = mediaDirs(mediaBase);
// live view + switch for the extracted modules (cleanup/mediadir/backup):
// they must NEVER cache a media path, because relocation reassigns these
// bindings at runtime — they read paths() fresh and switch them via adopt().
const currentMediaBase = () => ({ base: mediaBase, captures: CAPTURES, files: FILES, inbox: INBOX });
const adoptMediaDir = (base) => {
  mediaBase = base;
  ({ captures: CAPTURES, files: FILES, inbox: INBOX } = mediaDirs(mediaBase));
};
for (const d of [CAPTURES, FILES, INBOX]) fs.mkdirSync(d, { recursive: true });

const db = new Database(path.join(DATA, 'proofpipe.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL'); // WAL-safe; recommended setting, fewer fsyncs per write
db.pragma('mmap_size = 268435456'); // hot pages read straight from memory, no read() syscall
db.pragma('cache_size = -16000'); // ~16MB page cache — list queries stay in RAM
// single source of truth for the version: package.json (was a second hardcoded
// string that drifted from package.json + the smoke test asserting it)
const PP_VERSION = 'v' + JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// content-hash cache busting for the phone shell's CSS/JS: the asset URL query
// changes whenever the file bytes change, so neither the HTTP cache nor the
// service worker can serve a stale stylesheet/script against fresh markup.
// (A static version string chained to app releases left the phone stuck on old
// assets until the SW was bumped — content hashing fixes it for good.)
import { createHash } from 'node:crypto';
// stamps are cached: hashing on EVERY / and /phone request did sync read +
// SHA-1 on the hottest GETs. The cache key includes mtimeMs+size, so an edited
// file invalidates itself; only the first request after a change pays.
const stampCache = new Map(); // file -> { key, stamp }
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

// versioned, explicit migrations (PRAGMA user_version) — never silently drop data
const userVersion = db.pragma('user_version', { simple: true });
const tableExists = name =>
  !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
const MIGRATIONS = [
  // v0 -> v1: remove tables left over from the parked AI harness, add bytes column
  // (guarded below: a fresh DB has no captures table yet — its CREATE includes
  // the bytes column, so these ALTERs must not run or warn on every new boot)
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
  // v1 -> v2: track capture origin ('phone' | 'pc') so both UIs can badge
  // where an image came from
  {
    to: 2,
    run(db) {
      if (!tableExists('captures')) return;
      try { db.exec('ALTER TABLE captures ADD COLUMN origin TEXT'); } catch (e) { console.warn('migration v2: add origin:', e.message); }
    },
  },
  // v2 -> v3: generic file transfers live in their own table (own storage cap
  // and rate bucket, so a big transfer can never evict photo history)
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
  // v3 -> v4: idempotent uploads. The phone retries a timed-out upload from
  // its offline queue with the same client key, so a slow network can never
  // store the same photo twice (the retry looked like a brand-new upload).
  {
    to: 4,
    run(db) {
      if (!tableExists('captures')) return;
      try { db.exec('ALTER TABLE captures ADD COLUMN dedupe_key TEXT'); } catch (e) { console.warn('migration v4: add dedupe_key:', e.message); }
      try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_captures_dedupe ON captures(dedupe_key) WHERE dedupe_key IS NOT NULL'); } catch (e) { console.warn('migration v4: dedupe index:', e.message); }
    },
  },
  // v4 -> v5: separate media-chip rows (PC "send to phone" capture links) from
  // ordinary texts. Both shared one 20-row cap, so ~20 chips silently evicted
  // each other off the phone — and chips are functional (tap-to-view), not chat.
  {
    to: 5,
    run(db) {
      if (!tableExists('texts')) return;
      try { db.exec("ALTER TABLE texts ADD COLUMN kind TEXT DEFAULT 'text'"); } catch (e) { console.warn('migration v5: add kind:', e.message); }
      // rows written before this migration were overwhelmingly chip URLs (the
      // phone sends plain text, the PC's sendToPhone inserts /media/ URLs) —
      // classify them so the new cap split behaves for existing data.
      try { db.exec("UPDATE texts SET kind = 'media' WHERE kind IS NULL AND instr(body, '/media/') > 0"); } catch {}
      try { db.exec("UPDATE texts SET kind = 'text' WHERE kind IS NULL"); } catch {}
    },
  },
];
for (const m of MIGRATIONS) {
  // transactional: a crash mid-migration can never leave a half-migrated DB.
  // Each step guards itself against missing tables (see the early returns
  // above), so a fresh DB migrates cleanly instead of logging ALTER warnings.
  if (userVersion < m.to) db.transaction(() => m.run(db))();
}
// never downgrade a newer DB (e.g. opened by a newer ProofPipe then this one)
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

// hoisted prepared statements — never re-prepared per request
// CAPTURE_COLS: explicit column list, never SELECT *. `dedupe_key` is an
// internal idempotency key — it has no client use and every list/SSE row was
// shipping it to the harness, the phone and the extension for nothing.
const CAPTURE_COLS = 'id, file, created_at, bytes, origin';
const stmts = {
  insertCapture: db.prepare('INSERT INTO captures(file, bytes, origin, dedupe_key) VALUES (?, ?, ?, ?)'),
  getCaptureByDedupeKey: db.prepare(`SELECT ${CAPTURE_COLS} FROM captures WHERE dedupe_key = ?`),
  listCaptures: db.prepare(`SELECT ${CAPTURE_COLS} FROM captures ORDER BY id DESC LIMIT ?`),
  listCapturesBefore: db.prepare(`SELECT ${CAPTURE_COLS} FROM captures WHERE id < ? ORDER BY id DESC LIMIT ?`),
  getCapture: db.prepare(`SELECT ${CAPTURE_COLS} FROM captures WHERE id = ?`),
  deleteCapture: db.prepare('DELETE FROM captures WHERE id = ?'),
  deleteAllCaptures: db.prepare('DELETE FROM captures'),
  countCaptures: db.prepare('SELECT COUNT(*) AS c FROM captures'),
  sumBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM captures'),
  latestCaptureId: db.prepare('SELECT id FROM captures ORDER BY id DESC LIMIT 1'),
  backfillBytes: db.prepare('UPDATE captures SET bytes = ? WHERE id = ? AND bytes IS NULL'),
  addThumbBytes: db.prepare('UPDATE captures SET bytes = COALESCE(bytes, 0) + ? WHERE id = ?'),
  insertText: db.prepare('INSERT INTO texts(body, source, kind) VALUES (?, ?, ?)'),
  // trim ONLY ordinary texts: media chips (PC "send to phone" capture links)
  // have their own, much larger cap — sharing one cap let ~20 chips evict
  // each other (and the user's texts) off the phone.
  trimTexts: db.prepare("DELETE FROM texts WHERE kind = 'text' AND id NOT IN (SELECT id FROM texts WHERE kind = 'text' ORDER BY id DESC LIMIT 20)"),
  trimMediaTexts: db.prepare("DELETE FROM texts WHERE kind = 'media' AND id NOT IN (SELECT id FROM texts WHERE kind = 'media' ORDER BY id DESC LIMIT 200)"),
  // listing stays kind-AGNOSTIC on purpose: the phone strip mixes media chips
  // and text chips (rendered by body content). Only TRIMMING splits the caps.
  listTexts: db.prepare('SELECT * FROM texts WHERE source = ? ORDER BY id DESC LIMIT ?'),
  latestTextId: db.prepare('SELECT id FROM texts ORDER BY id DESC LIMIT 1'),
  listAllTexts: db.prepare('SELECT * FROM texts ORDER BY id DESC LIMIT ?'),
  deleteTextsBySource: db.prepare('DELETE FROM texts WHERE source = ?'),
  // one row — the phone's swipe-down-to-delete on a PC-sent chip
  deleteTextById: db.prepare('DELETE FROM texts WHERE id = ?'),
  // media-link text rows (the PC's "send to phone" chips) die with the
  // capture they point at — a deleted capture must never leave a phone chip
  // that can only 404. Matches by the stored filename, which is random.
  deleteTextsForCapture: db.prepare('DELETE FROM texts WHERE instr(body, ?) > 0'),
  deleteAllTexts: db.prepare('DELETE FROM texts'),
  insertFile: db.prepare("INSERT INTO files(name, file, mime, bytes, dir) VALUES (?, ?, ?, ?, ?)"),
  listFiles: db.prepare('SELECT * FROM files ORDER BY id DESC LIMIT ?'),
  listFilesBefore: db.prepare('SELECT * FROM files WHERE id < ? ORDER BY id DESC LIMIT ?'),
  getFile: db.prepare('SELECT * FROM files WHERE id = ?'),
  deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),
  deleteAllFiles: db.prepare('DELETE FROM files'),
  countFiles: db.prepare('SELECT COUNT(*) AS c FROM files'),
  sumFileBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM files'),
  latestFileId: db.prepare('SELECT id FROM files ORDER BY id DESC LIMIT 1'),
};

// storage byte totals maintained on write — /api/stats never walks the folder
// (recomputed by bootSweep once backfilled + healed rows are included). Both
// counters live in server/bytes.js (centralized, with a periodic DB re-sync).

// opt-in HTTPS: drop data/key.pem + data/cert.pem into the data folder and the
// whole server (harness + phone PWA) becomes https:// — a secure context, which
// is what Android Chrome requires for clipboard IMAGE writes (no flag needed).
let httpsOpts = null;
try {
  httpsOpts = {
    key: fs.readFileSync(path.join(DATA, 'key.pem')),
    cert: fs.readFileSync(path.join(DATA, 'cert.pem')),
  };
} catch {}
const SCHEME = httpsOpts ? 'https' : 'http';
// Errors are always logged (to stderr, one line); PP_LOG=1 additionally
// logs every request line. `logger: true` would keep this quiet-by-default
// but dumps a JSON line per request on stdout at info level — too noisy for
// a personal tool, so the built-in logger stays off and req.log.* routes to
// stderr via the minimal shim below.
const VERBOSE_LOG = process.env.PP_LOG === '1' || /^(debug|trace)$/i.test(process.env.PP_LOG || '');
// structured log line for the events that matter (eviction, rate-limit, SSE
// lifecycle) — one parseable JSON per line to stderr, so a tail can rebuild
// what happened after the fact (PITFALLS #2: never debug with empty traces).
const logEvent = (name, data = {}) => {
  try { process.stderr.write(JSON.stringify({ t: Date.now(), ev: name, ...data }) + '\n'); }
  catch { /* logging must never break a request */ }
};
const app = Fastify({
  logger: { level: 'error', stream: { write: (s) => process.stderr.write(s) } },
  // MUST exceed the multipart fileSize cap below: the body INCLUDES multipart
  // framing (boundaries + the source/auto/key fields), so a photo just under
  // 20 MB produced a body just OVER 20 MB → Fastify 413'd the WHOLE request
  // and the phone poisoned a perfectly fine capture. 1 MB of headroom.
  bodyLimit: 21 * 1024 * 1024,
  ...(httpsOpts ? { https: httpsOpts } : {}),
});
// default keep-alive is 5s but the phone polls every 10s — below this, every
// poll/upload paid a fresh TCP (+TLS) handshake. 65s comfortably covers it.
app.server.keepAliveTimeout = 65_000;
app.server.headersTimeout = 66_000; // must exceed keepAliveTimeout

// permissive CORS + Private-Network-Access answers, so the extension popup/tray
// can talk to the server directly even if Chrome blocks its service worker.
// READS stay open; MUTATIONS (DELETE) are origin-checked further down so an
// arbitrary webpage can never wipe captures while you browse (CSRF).
app.addHook('onRequest', async (req, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    reply
      // DELETE deliberately NOT advertised: cross-site DELETE preflights fail
      // (same-origin + extension clients never need CORS for it)
      .header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      .header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*')
      .header('Access-Control-Max-Age', '86400');
    if (req.headers['access-control-request-private-network'] === 'true')
      reply.header('Access-Control-Allow-Private-Network', 'true');
    return reply.code(204).send();
  }
});

// ---------- the ONE trusted extension origin ----------
// Mutations are CSRF-gated by Origin/Host, but extension fetches come from
// chrome-extension://<id> (which never matches a Host). The old gate accepted
// ANY installed extension via a shape check — so every other extension on the
// machine could wipe captures. Pin to OUR id, derived from
// extension/manifest.json's `key`: the id is the first 128 bits of SHA-256 over
// the base64-decoded public key, hex mapped 0–f → a–p (Chrome's algorithm).
// Carrying `key` also makes the id STABLE across unpacked reloads. Set
// PP_EXTENSION_ID for a packed / Web Store build whose id isn't in our manifest.
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

// a DELETE is safe when it comes from: no Origin (curl/health checks), OUR
// extension, or our own origin (the harness / phone PWA are same-origin)
function csrfSafe(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  if (/^chrome-extension:\/\//i.test(origin)) {
    // exactly our extension. If the id couldn't be derived, fall back to the
    // shape check so a misconfigured server doesn't brick the extension (the
    // boot log says which mode is active).
    if (TRUSTED_EXTENSION_ORIGIN) return origin.toLowerCase().replace(/\/$/, '') === TRUSTED_EXTENSION_ORIGIN;
    return /^chrome-extension:\/\/[a-p]{32}$/i.test(origin);
  }
  const host = String(req.headers.host || '');
  // Host must be an address THIS server actually answers on — a DNS-rebinding
  // page (evil.com → LAN IP) sends Origin: evil.com + Host: evil.com, which the
  // old origin===host check happily accepted. localhost/loopback and the real
  // LAN IPs pass; anything else (rebound domain) is refused.
  try {
    const originHost = new URL(origin).host;
    if (originHost !== host) return false; // mismatch = spoofed/rebound — refuse
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (/^(localhost|127(\.\d+){3}|\[::1\]|::1)$/i.test(hostname)) return true;
    return lanIPs().includes(hostname); // one of OUR interfaces, not a rebound name
  } catch { return false; }
}

// ---------- request log (quiet: only uploads & deletions; PP_LOG=1 = every request) ----------
app.addHook('onResponse', async (req, reply) => {
  const url = (req.raw.url || '').split('?')[0];
  if (VERBOSE_LOG) {
    console.log(`${req.method} ${url} ${reply.statusCode}`);
  } else if (url === '/upload' || url === '/share' || url === '/api/files' || req.method === 'DELETE') {
    console.log(`${req.method} ${url} ${reply.statusCode}`);
  }
});

// ---------- live push (SSE) — clients update the instant something changes ----------
// (extracted to server/sse.js: client set, /events route, eviction cap,
// heartbeat, notify, shutdown destroyAll)
const sseHub = createSseHub(app, { logEvent, onPhonePresence });
const notify = sseHub.notify;
const sseClients = { get size() { return sseHub.clientCount(); } }; // /api/stats reads .size

// ---------- phone presence: the ping window PLUS the phone's live wire ----------
// The 90s ping window below is the only heartbeat a phone gives us, so the QR
// used to stay hidden-then-shown on a 90s + up-to-15s-tick delay. But a phone
// also holds an SSE stream open; its CLOSE is the earliest honest sign the phone
// left (page closed, app killed), so /api/stats answers `phoneOnline` as the
// ping window AND "we have not watched the phone's stream go away".
//
// The verdict is NOT "no phone stream is open right now": a phone whose SSE
// never managed to connect (blocked, or the server just restarted) still counts
// as present through its pings, so the harness never claims a connected phone is
// gone. `phoneSseClosed` can only rise from an OBSERVED close, and any phone ping
// clears it — a phone can never get stuck "offline" while it keeps pinging.
//
// A close is only trusted after a grace period: EventSource auto-retries a
// dropped stream (retry: 2000) and a page reload re-opens it in ~1s, so a blip
// must not flash the pairing QR. A reconnect within the window cancels it.
// The window that decides a ping is still "fresh" — the harness's own
// PHONE_ONLINE_MS in public/app.js, kept in sync here so the server can tell a
// FIRST contact apart from a routine keep-alive ping.
const PHONE_ONLINE_MS = 90 * 1000;
const PHONE_SSE_GRACE_MS = 4000;
let phoneSseClosed = false; // observed close, not yet contradicted by a ping
let phoneGoneTimer = null;
function onPhonePresence(anyPhoneConnected) {
  if (anyPhoneConnected) {
    phoneSseClosed = false;
    if (phoneGoneTimer) { clearTimeout(phoneGoneTimer); phoneGoneTimer = null; }
    notify('phone'); // the harness re-reads stats → online → the QR retires
    return;
  }
  if (phoneGoneTimer) return; // already counting down
  phoneGoneTimer = setTimeout(() => {
    phoneGoneTimer = null;
    phoneSseClosed = true;
    notify('phone'); // harness re-reads stats → offline → the QR comes back
  }, PHONE_SSE_GRACE_MS);
}

// phone presence tracking
// phone presence tracking — a Map keyed by the phone's own IP, so a second
// phone (or one phone whose hotspot IP changed) no longer silently overwrites
// the first: the single-slot version made the stats lie about phone #1.
// value: { lastSeen: epoch ms, outbox: queued photos the phone reported }
const phones = new Map();
const PHONE_SLOTS = 10; // bound: drop the oldest-seen entry past this
const PHONE_STALE_MS = 45 * 24 * 3600 * 1000; // forgotten after 45 days silent
// Returns true when this ping is phone PRESENCE NEWS the harness must act on:
// the phone coming online (first ever contact, or the first after going quiet
// past PHONE_ONLINE_MS), or a ping that contradicts a close verdict. A routine
// keep-alive stays silent — otherwise every ping would wake every SSE client
// for nothing.
function trackPhone(rawIp, outbox) {
  const ip = String(rawIp || '').replace(/^::ffff:/, '');
  if (!ip) return false;
  const prev = phones.get(ip);
  const justCameOnline = !prev || Date.now() - prev.lastSeen > PHONE_ONLINE_MS;
  // a ping is presence proof too: it contradicts a "the phone's stream closed"
  // verdict, so a phone that is pingable can never be reported gone
  const wasDeclaredGone = phoneSseClosed;
  phoneSseClosed = false;
  phones.set(ip, { lastSeen: Date.now(), outbox: Math.max(0, Math.min(999, outbox ?? 0)) });
  // prune: long-silent entries first, then oldest-seen past the slot cap
  const now = Date.now();
  for (const [ip2, p] of phones) if (now - p.lastSeen > PHONE_STALE_MS) phones.delete(ip2);
  while (phones.size > PHONE_SLOTS) {
    let oldest = null, oldestSeen = Infinity;
    for (const [ip2, p] of phones) if (p.lastSeen < oldestSeen) { oldest = ip2; oldestSeen = p.lastSeen; }
    if (!oldest) break;
    phones.delete(oldest);
  }
  return justCameOnline || wasDeclaredGone; // either way the harness must re-read
}

await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
// text/JSON responses (app.js, style.css, /api/*) compress ~75%; binaries
// (images, video, PDFs) fall through untouched — quality and /media streams
// are never affected. SSE writes via reply.raw bypass these hooks entirely.
// Registered BEFORE static: hooks only reach routes registered after them in
// the same scope — after static, the shell assets streamed by @fastify/static
// silently skipped compression.
await app.register(compress, { global: true, threshold: 1024 });
await app.register(fastifyStatic, {
  root: path.join(ROOT, 'public'),
  // shell assets are version-stamped by the SW cache + the update banner:
  // one day of no-revalidation caching kills the per-file 304 round-trip on
  // every load for non-SW clients, while an update still lands within a day.
  setHeaders: (reply, filePath) => {
    // sw.js must never be long-cached — the browser must re-fetch it to pick
    // up a new CACHE version after code changes; 24 h caching delayed updates
    if (filePath.endsWith('sw.js')) reply.header('Cache-Control', 'no-store');
    // vendored, VERSION-IN-THE-NAME libs (OpenCV.js for the scan feature) are
    // immutable: the filename pins the version, so a 1-year cache is correct and
    // spares a 10MB re-download every day.
    else if (filePath.includes(`${path.sep}vendor${path.sep}`)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    else reply.header('Cache-Control', 'public, max-age=86400, must-revalidate');
  },
});
// serve the harness HTML through a handler so the server version is injected
// into it — the client compares this against /api/version (single source of truth).
// Cached at boot: version only changes on restart, and the disk read was per-load.
let indexHtml = null;
let phoneHtml = null;
try { indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'); } catch {}
app.get('/', async (_req, reply) => {
  const html = (indexHtml ??= await fsp.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8'));
  // content-hash the harness assets (mirrors the phone shell's assetStamp) so
  // a change to app.js/style.css rev's the URL without a manual version bump —
  // otherwise clients keep the old stamped URL up to a day (CONVENTIONS #24/25).
  const stamped = html
    .replace('__ASSET_STYLE__', assetStamp('style.css'))
    .replace('__ASSET_SCAN__', assetStamp('scan.js'))
    .replace('__ASSET_APP__', assetStamp('app.js'));
  // return the payload (NOT `return reply` after .send — that double-resolves
  // the route promise and @fastify/compress emits an empty gzip body)
  return reply.type('text/html').send(stamped.replaceAll('__PP_VERSION__', PP_VERSION));
});
// capture/thumbnail files, served from the CURRENT captures dir (which the
// user can relocate live — a static mount would pin the old root forever).
// Same contract the static mount had: immutable 1-year cache, correct type
// for t-*.tiff PNG-byte thumbs, byte-identical originals, Range support.
// mediaContentType()/MEDIA_MIME live in server/util.js (pure).
// shared file streamer: full body or single/suffix Range, 416 when unsatisfiable
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
    // 256KB readahead: the 64KB default forces 4x the syscalls per multi-MB
    // original streamed into the lightbox
    return reply.send(fs.createReadStream(absPath, { highWaterMark: 256 * 1024 }));
  }
  const rangeHeader = range.trim();
  // multi-range (`bytes=0-1,5-6`) requires a multipart/byteranges body, which
  // this server doesn't emit. RFC 7233 lets a server ignore Range entirely and
  // answer 200 — do that (the old code returned 416 for a satisfiable request,
  // which was simply wrong).
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
  // flat namespace: stored names are timestamp-random + safe chars, never paths
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..') || name.startsWith('.')) return reply.code(404).send();
  const fp = path.resolve(CAPTURES, name);
  if (path.relative(CAPTURES, fp).startsWith('..') || path.dirname(fp) !== CAPTURES)
    return reply.code(404).send();
  // Self-heal a missing THUMBNAIL before answering.
  //
  // The boot sweep regenerates missing thumbs, but only at boot: a thumb whose
  // deferred background write failed mid-session stayed missing for the whole
  // run, and the phone gives up after ~6 retries — so the tile stayed blank
  // until a restart. Building it here means the first request after the failure
  // both fixes the file and answers with real bytes.
  // Only `t-<original>` is eligible: `thumbFor` re-checks the name against a
  // real captures row and a known image extension, so a decoy name cannot make
  // this decode arbitrary files.
  if (name.startsWith('t-') && !fs.existsSync(fp)) {
    const thumb = await thumbFor(name.slice(2)).catch(() => null);
    if (!thumb) return reply.code(404).send();
    return reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('Content-Type', mediaContentType(name))
      .send(thumb);
  }
  return streamFile(req, reply, fp, { contentType: mediaContentType(name) });
});

// lanIPs() lives in server/util.js (pure; caches its 3s probe internally).

const PORT = Number(process.env.PORT) || 8787;

// ---------- single-instance lock (see acquireLock below, before listen) ----------
// Two ProofPipe processes on the same DATA dir = two servers racing on the
// same SQLite DB (WAL tolerates it, but uploads race the cleanup sweeper,
// storage totals drift, and the second listen either fails confusingly or
// silently steals the port). The .bat's port check only covers 8787; a
// lockfile covers EVERY port and any second instance, whatever the launch
// path (bat, npm start, PORT=8788). A PID-guarded lockfile also catches the
// crashed-process case: a stale lock with no live ProofPipe PID is broken
// and re-taken, so a crash never bricks startup.
const LOCK_FILE = path.join(DATA, 'proofpipe.lock');
function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
}
// Is the process recorded in the lock actually a live ProofPipe?
//
// `process.kill(pid, 0)` alone is NOT enough on Windows: pids are recycled
// aggressively, so a crashed ProofPipe's pid gets reused by an unrelated
// process (observed live: the recorded pid had become svchost.exe) and the
// check reported "alive" forever — the documented "a crash never bricks
// startup" self-heal silently failed and ProofPipe could not start again until
// the lockfile was deleted by hand.
//
// So a live pid is confirmed against the port the lock recorded: only a real
// ProofPipe answers /api/version there. A very fresh lock is trusted as-is, so
// a second instance racing the first one's boot can never break a live lock.
const LOCK_BOOT_GRACE_MS = 20_000;
async function lockAlive(lock) {
  if (!lock || typeof lock.pid !== 'number' || lock.pid === process.pid) return false;
  let pidExists = false;
  try { process.kill(lock.pid, 0); pidExists = true; }
  catch (e) { pidExists = e.code === 'EPERM'; } // EPERM = alive but not ours
  if (!pidExists) return false;
  const port = Number(lock.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return true; // unknown shape — stay conservative
  const age = Date.now() - Date.parse(lock.started || '');
  if (Number.isFinite(age) && age < LOCK_BOOT_GRACE_MS) return true; // just written, still booting
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json();
    return typeof j.version === 'string' && /^v\d/.test(j.version); // ProofPipe's shape
  } catch { return false; } // nothing (or something else) on that port — recycled pid
}
async function acquireLock() {
  // Exclusive-create (wx) makes the take atomic: two racers can never both
  // own the lock. The old read-then-write let a slower second instance
  // overwrite a just-taken lock — both thought they owned it, and the loser's
  // exit hook then deleted the winner's lock. EEXIST → re-check the holder;
  // break it only when it is provably not a live ProofPipe; retry (bounded).
  const payload = JSON.stringify({ pid: process.pid, port: PORT, started: new Date().toISOString() });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
      return;
    } catch (e) {
      if (e?.code !== 'EEXIST') break; // real I/O error — fall through to the fatal message
    }
    const existing = readLock();
    if (await lockAlive(existing)) {
      console.error(`ProofPipe is ALREADY RUNNING (pid ${existing.pid}, started ${existing.started}).`);
      console.error(`Stop it first (close its window / Ctrl+C), or point PP_DATA elsewhere.`);
      process.exit(1);
    }
    // stale lock (crashed process, dead or recycled PID) — break and re-take.
    // The unlink can itself race another breaker: if it's gone, the loop retries.
    try { fs.rmSync(LOCK_FILE, { force: true }); } catch {}
  }
  try { fs.writeFileSync(LOCK_FILE, payload); }
  catch (e) {
    console.error('Could not write the instance lock:', e.message);
    process.exit(1);
  }
}
await acquireLock();
// release on the way out (also on crash paths via exit hooks below)

// ---------- upload hardening: rate limit, pixel cap, sharp concurrency ----------
// token buckets per IP (no external dep; in-memory is fine for a single-host
// tool) — extracted to server/ratelimit.js, one bucket per traffic class so
// photo bursts and file transfers never starve each other.
const RATE = {
  // Sized for a real gallery multi-select. The old 60/120 tripped on a 97-photo
  // burst (measured: a run of POST /upload 200s then a wall of 429s) because the
  // bucket is per-IP and the phone uploads 4 at a time — capacity is a BURST
  // ceiling, and 97 > 60 is not a flood, it is one user picking a lot of photos.
  // 120 tokens lets a 100+ batch through; the refill still bounds sustained
  // traffic, and 429 remains as anti-flood OOM hardening, not a feature gate.
  capacity: Number(process.env.PP_RATE_CAPACITY) || 120,
  refillPerMin: Number(process.env.PP_RATE_REFILL_PER_MIN) || 240,
};
const photoBucket = createTokenBucket({ ...RATE, logEvent, kind: 'photo' });
// periodic byte-counter reconcile: catches any residual drift between the
// in-memory totals and the DB (a thumb-write failure or a mid-move upload that
// the boot sweep missed would otherwise leave /api/stats lying until reboot).
setInterval(() => {
  bytes.set(stmts.sumBytes.get().b);
  bytes.setFiles(stmts.sumFileBytes.get().b);
}, 15 * 60 * 1000).unref();
// retention must hold even when NO photos arrive: the upload-time piggyback
// alone let a quiet gallery keep expired captures indefinitely. Hourly tick,
// unref'd so it never holds the process open; batched 500-delete passes inside
// runRetentionSweep keep each tick off the event loop's critical path.
setInterval(() => { runRetentionSweep().catch(() => {}); }, 60 * 60 * 1000).unref();
// own rate bucket for file transfers (1 token = 1 file): a 20-file batch must
// never fight the photo limiter, and photo bursts must never starve files.
// Raised with the photo bucket: 30 was under a realistic batch of phone photos
// sent as files, and the two limits should not disagree about what "a batch" is.
const FILE_RATE = {
  capacity: Number(process.env.PP_FILE_RATE_CAPACITY) || 60,
  refillPerMin: Number(process.env.PP_FILE_RATE_REFILL_PER_MIN) || 60,
};
const fileBucket = createTokenBucket({ ...FILE_RATE, logEvent, kind: 'file' });

app.post('/upload', async (req, reply) => {
  // same CSRF bar as DELETEs: an arbitrary webpage must not flood disk via
  // cross-site FormData. Same-origin PWA (host match), extension, curl pass.
  if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
  if (!photoBucket.allow(req.ip)) return reply.code(429).send({ error: 'too many uploads, slow down' });
  const part = await req.file();
  if (!part) return reply.code(400).send({ error: 'no file' });
  // origin: the uploader declares itself ('phone' | 'pc') as a form field sent
  // BEFORE the file part — used by both UIs to badge the capture's source.
  // (multipart field values are part-objects with .value in some versions)
  const rawSource = part.fields?.source;
  const sourceVal = typeof rawSource === 'string' ? rawSource : rawSource?.value;
  const origin = sourceVal === 'phone' ? 'phone' : 'pc';
  // auto-paste: the uploader can tag the capture explicitly (form field sent
  // before the file part, mirrors `source`); when absent, the server-side mode
  // (the phone's toggle) decides.
  const rawAuto = part.fields?.auto;
  const autoVal = typeof rawAuto === 'string' ? rawAuto : rawAuto?.value;
  // auto-paste only ever applies to PHONE photos: an upload added on the PC
  // itself is already in front of the user (the harness copy button / the
  // extension relay must not re-paste it into the last chat). PC-origin
  // uploads are never auto regardless of the toggle or an explicit flag.
  const wantsAuto = origin === 'phone' && (rawAuto == null ? settings.autoPaste : (autoVal === '1' || autoVal === 'true'));
  // idempotency key: the phone generates one per capture (frozen at queue
  // time) and REUSES it on every retry. A timed-out upload that actually
  // landed is answered with the original row instead of storing a duplicate.
  // Non-phone callers may omit it entirely. Bounded (32 chars, URL-safe) and
  // scoped to the phone origin so PC paths can never collide with phone keys.
  const rawKey = typeof part.fields?.key === 'string' ? part.fields.key : part.fields?.key?.value;
  const dedupeKey = origin === 'phone' && typeof rawKey === 'string' && rawKey && /^[A-Za-z0-9_-]{8,32}$/.test(rawKey)
    ? `ph:${rawKey}` : null;
  // everything below (stream to disk, probe, rename, DB row, bytes total,
  // auto-tag, thumb + SSE) lives in the shared storeCapturedParts helper so
  // the Android share route gets the exact same hardened pipeline.
  let stored;
  try {
    stored = await storeCapturedParts([part], origin, wantsAuto, dedupeKey);
  } catch (e) {
    req.log.error(e);
    return reply.code(e?.status || 500).send({ error: e?.status ? e.message : 'failed to store capture' });
  }
  const first = stored[0] || {};
  // fast-ack AFTER background chains are scheduled (not `return reply` after
  // .send — that double-resolves the route and @fastify/compress breaks)
  // duplicate: true tells the phone this was a retry of an already-landed
  // capture — it can treat it as success (it is one).
  return reply.send({ id: first.id, file: first.file, ...(first.duplicate ? { duplicate: true } : {}) });
});

// ---------- Android share target ("Share → ProofPipe") ----------
// The manifest's share_target POSTs multipart to /share (files + title/text/
// url fields). Images are stored exactly like shutter-button captures
// (origin 'phone', auto-paste applies when the toggle is on), and a text-only
// share posts the text to the phone→PC texts table the way the phone's text
// box does. Responds 303 to the phone PWA so the share lands on the app.
app.post('/share', async (req, reply) => {
  // same CSRF bar as every other mutation: a cross-site form can't flood disk.
  // The real share-target POST is a top-level navigation with no Origin header
  // (browser-generated form submission), which csrfSafe accepts.
  if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
  if (!photoBucket.allow(req.ip)) return reply.code(429).send({ error: 'too many uploads, slow down' });
  const fields = {};
  const stored = [];
  try {
    // req.files() yields FILE parts only (text fields vanish — that bug shipped
    // and failed its own test); req.parts() yields fields AND files. Files must
    // be consumed in iterator order (streaming parser), so each file is stored
    // as it arrives; fields are collected and the text inserted after the loop.
    for await (const part of req.parts()) {
      if (part.filename) {
        // shared images are phone-origin captures; auto-paste follows the
        // server-side toggle exactly like an upload with no explicit auto flag
        stored.push(...await storeCapturedParts([part], 'phone', settings.autoPaste));
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
  } catch (e) {
    try { req.raw.resume(); } catch {} // drain: the client may still be sending
    // Roll back any images that already committed before the failure. Without
    // this a multi-image share that exits mid-way leaves a partial capture set
    // behind, and the phone's resend-on-error then creates duplicates.
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

// ---------- stats / dashboard (no FS walks: sizes tracked on write) ----------
app.get('/api/stats', () => {
  // top-level phone fields stay backward-compatible (single-phone UIs read
  // them directly) and describe the MOST RECENTLY SEEN phone; `phones`
  // carries every known phone for multi-phone UIs.
  let latest = null;
  for (const [ip, p] of phones) if (!latest || p.lastSeen > latest.lastSeen) latest = { ip, ...p };
  const outboxSum = [...phones.values()].reduce((a, p) => a + p.outbox, 0);
  return {
    version: PP_VERSION,
    count: stmts.countCaptures.get().c,
    bytes: bytes.total,
    // The rail's capacity meter needs a DENOMINATOR: "31.5 MB" answered nothing
    // without the cap beside it, and the harness would otherwise have to fetch
    // /api/settings first and render a 0% bar until it landed. Same resolution
    // the cleanup sweeper uses (settings.storageCapMB || the env default).
    cap: (settings.storageCapMB || defaultMaxStoreMB) * 1024 * 1024,
    files: { count: stmts.countFiles.get().c, bytes: bytes.files },
    mediaDir: mediaBase, // where captures + files land on this PC (relocatable from the harness)
    phoneLastSeen: latest?.lastSeen ?? 0, // epoch ms, 0 = never (most recent phone)
    // ONE verdict for the harness's QR rule, so the two sides cannot disagree:
    // ping-fresh AND no observed "the phone's live wire closed" verdict.
    phoneOnline: !phoneSseClosed && !!latest && Date.now() - latest.lastSeen < PHONE_ONLINE_MS,
    phoneOutbox: Math.min(999, outboxSum), // photos queued across ALL phones
    phoneIp: latest?.ip || null, // host for phone-side links (see /api/lan)
    phoneCount: phones.size,
    phones: [...phones.entries()].map(([ip, p]) => ({ ip, lastSeen: p.lastSeen, outbox: p.outbox })),
    sseClients: sseClients.size,
    // The rail's "did it land?" answer: the last three arrivals across BOTH
    // libraries, newest first. Two bounded queries (3 rows each) and one merge —
    // the alternative was the harness doing a 100-row /api/files fetch it does
    // not otherwise need just to name its three most recent rows. `at` is the
    // raw created_at string the harness already feeds to timeAgo().
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

// phone "open latest on PC" button
app.post('/api/open-latest', (req, reply) => {
  if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
  notify('open-latest'); return { ok: true };
});

// ---------- server-persisted settings (auto-paste, auto-cleanup) ----------
// Both UIs (PC harness + phone) read/write the same flags; every change is
// pushed to all connected clients as an SSE 'settings' event so the toggles
// stay in sync everywhere. Persisted in a tiny JSON file so they survive
// server restarts.
const SETTINGS_FILE = path.join(DATA, 'settings.json');
// version field for forward-compatible settings migrations — SQL is already
// versioned with PRAGMA user_version; the settings file deserves the same.
// Bump it and add a migration branch here when a future setting needs one.
const settings = { version: 1, autoPaste: false, autoCleanup: false, filesToInbox: true, mediaDir: null, qualityReduce: false, qualityLevel: 80, storageCapMB: null, retentionDays: 0, inboxDir: null, browser: 'default' };
try {
  // allowlist the known keys — a hand-edited/corrupted file can otherwise
  // graft arbitrary properties onto `settings` (Object.assign copies anything)
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
  if (typeof loaded?.browser === 'string') settings.browser = loaded.browser; // validated against the detected list at POST/open time
} catch {}
// adopt a previously chosen media folder (validated: absolute + creatable —
// a stale/removed drive falls back to DATA instead of crashing the boot)
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
// adopt a previously chosen inbox folder (absolute + creatable; a removed
// folder falls back to the default data/inbox rather than failing uploads)
if (typeof settings.inboxDir === 'string' && settings.inboxDir) {
  try {
    const base = path.resolve(settings.inboxDir);
    if (path.isAbsolute(base)) { fs.mkdirSync(base, { recursive: true }); settings.inboxDir = base; }
    else settings.inboxDir = null;
  } catch (e) { console.warn('inbox dir adopt failed, using default:', e?.message || e); settings.inboxDir = null; }
}
// The ONE settings payload, shared by GET /api/settings and the SSE 'settings'
// event. Shaped to match the individual endpoints so a client can map it 1:1
// (and so applying the SSE payload needs no refetch — CONVENTIONS: "payload
// always carries the full row the consumer needs"). `browser` stays a FLAT
// top-level key: the extension gate reads it straight off the event.
// Declared as a function so it can be called from saveSettings() above the
// registerCleanup destructuring below (both are only called at request time).
function settingsBundle() {
  return {
    version: PP_VERSION,
    autoPaste: { auto: settings.autoPaste },
    autoCleanup: { on: settings.autoCleanup, cap: (settings.storageCapMB || defaultMaxStoreMB) * 1024 * 1024, used: bytes.total },
    filesInbox: { on: settings.filesToInbox },
    // maxPixels is the PC's capture accept ceiling (server/store.js). The phone
    // uses it to NAME the limit when it refuses a photo (tooManyPixelsMsg) — it
    // resizes nothing, because with the quality setting off no size limit may
    // change a photo. Publishing it is what lets that refusal say "over 64MP"
    // rather than a bare "too big", which is what used to leave an oversized
    // photo retrying forever with nothing on screen to explain it.
    quality: { on: settings.qualityReduce, level: settings.qualityLevel, maxPixels: MAX_PIXELS },
    storageCap: { capMb: settings.storageCapMB || defaultMaxStoreMB, custom: settings.storageCapMB != null },
    retention: { days: settings.retentionDays },
    inboxDir: { path: settings.inboxDir, def: currentMediaBase().inbox },
    mediaDir: { path: currentMediaBase().base, def: DATA },
    browser: settings.browser,
  };
}
function saveSettings() {
  // atomic: tmp + rename so a crash mid-write never corrupts the toggles
  try {
    const tmp = `${SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings));
    fs.renameSync(tmp, SETTINGS_FILE);
  } catch (e) {
    // silent failure here made toggles silently non-persistent (read-only data/)
    console.warn('settings save failed:', e?.message || e);
  }
  notify('settings', settingsBundle()); // live-sync every open UI (no refetch needed)
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

// ---------- extracted subsystems (server/cleanup.js, mediadir.js, backup.js) ----------
// ctx carries the shared singletons; paths() is LIVE — media-dir relocation
// reassigns CAPTURES/FILES/INBOX at runtime, so no module may cache a path.
// autoCaptureIds is hoisted above registerCleanup (its ctx references the Set).
const autoCaptureIds = new Set();
const {
  runRetentionSweep, runAutoCleanup, runFileCleanup, removeCaptureRow, removeFileRow,
  defaultMaxStoreMB,
} = registerCleanup(app, {
  settings, stmts, db, bytes, notify, saveSettings, csrfSafe, logEvent, autoCaptureIds, paths: currentMediaBase,
});
registerMediaDir(app, { settings, saveSettings, csrfSafe, DATA, adoptMediaDir, currentMediaBase });
registerBackup(app, { csrfSafe, DATA, SETTINGS_FILE, currentMediaBase, db });
// launcher browser choice + harness opener (server/browser.js) — the .bat
// hands the open to the server (PP_OPEN_BROWSER=1) so it honors the setting
const { openHarness } = registerBrowser(app, { settings, saveSettings, csrfSafe });

// ---------- capture storage pipeline (server/store.js) ----------
// sharp is injected so it stays a DYNAMIC import in server.js (UV_THREADPOOL
// discipline — see the comment block atop this file and test/config.test.js).
const store = createStore({
  sharp, settings, stmts, db, bytes, notify, logEvent, autoCaptureIds, paths: currentMediaBase,
  browserPresent: sseHub.hasBrowser, // autoTarget fallback when the picked browser is absent
  cleanup: { runRetentionSweep, runAutoCleanup },
});
const { bootSweep, storeCapturedParts, thumbFor } = store; // probeImage/makeThumb stay inside the store module

// ---------- captures query/delete surface (server/captures.js) ----------
registerCaptures(app, {
  stmts, db, bytes, notify, csrfSafe, autoCaptureIds, paths: currentMediaBase,
  cleanup: { removeCaptureRow },
});

// ---------- generic file transfer (server/files.js) ----------
registerFiles(app, {
  settings, stmts, db, bytes, notify, csrfSafe, fileBucket, paths: currentMediaBase,
  cleanup: { runFileCleanup, removeFileRow }, streamFile,
});

// ---------- transfer quality reduction (OFF by default) ----------
// When on, the PHONE compresses photos before upload (qualityCompress in
// phone.js) using qualityLevel 1–100. One flag controls every phone transfer
// path (capture, gallery batch, retry, offline-queue flush) because they all
// funnel through upload(). Toggling it OFF must mean "untouched": the phone's
// only permitted edit then is one the PC physically cannot work without (a
// HEIC→JPEG format conversion, scaled solely to fit MAX_PIXELS) — anything
// above MAX_PIXELS is refused loudly rather than silently downscaled.
// The server deliberately does NOT re-encode on receipt — that would double-compress (q70 of an already-q70 bytes).
// Shared setting: toggleable from either UI, live-synced via SSE 'settings'.
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

// ---------- aggregated settings (one request instead of eight) ----------
// The harness used to fetch each setting from its own endpoint: 14 API GETs on
// every page load, and 9 more every time ANY setting changed (the SSE
// 'settings' event carried the whole object and the client ignored it in favour
// of re-fetching — see CONVENTIONS: "payload always carries the full row the
// consumer needs"). This bundle is that payload.
// The detected-browser LIST is deliberately not here (it needs a registry probe
// and only changes on install) — the harness still calls /api/browsers once at
// boot, and a settings event carries the live `browser` pick in the payload.
app.get('/api/settings', () => settingsBundle());

// ---------- text sync ----------
// bidirectional text between harness and phone; each side lists the other's texts
app.post('/api/text', async (req, reply) => {
  if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
  const b = req.body || {};
  const body = String(b.body || '').slice(0, 10000).trim();
  if (!body) return reply.code(400).send({ error: 'empty text' });
  const source = b.source === 'phone' ? 'phone' : 'pc';
  // classify: PC "send to phone" inserts /media/<file> links — those are
  // FUNCTIONAL chips (tap to view), not chat, and get their own cap so they
  // can't be evicted by (or evict) ordinary texts.
  const isMediaLink = /^https?:\/\/[^/]+\/media\//.test(body);
  const kind = isMediaLink ? 'media' : 'text';
  const info = stmts.insertText.run(body, source, kind);
  if (kind === 'media') stmts.trimMediaTexts.run();
  stmts.trimTexts.run(); // keep a small history
  notify('text');
  return { id: info.lastInsertRowid, ok: true };
});

app.get('/api/text', (req) => {
  const source = req.query.source === 'phone' || req.query.source === 'pc' ? req.query.source : null;
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10));
  if (source) return stmts.listTexts.all(source, limit);
  return stmts.listAllTexts.all(limit); // hoisted — was re-prepared per request
});

// clear sent texts (the phone uses this for its "Clear PC-sent captures");
// ?source=pc|phone wipes one direction, no param wipes the whole history.
// Origin-checked like the capture DELETEs so a random webpage can't wipe it.
app.delete('/api/text', async (req, reply) => {
  if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
  const source = req.query.source === 'phone' || req.query.source === 'pc' ? req.query.source : null;
  const info = source ? stmts.deleteTextsBySource.run(source) : stmts.deleteAllTexts.run();
  notify('text'); // both UIs drop their chips
  return { ok: true, removed: info.changes };
});

// delete ONE text row (the phone's swipe-down gesture on a PC-sent chip).
// Same mutation gate as the bulk wipe; the id must be a positive integer.
app.delete('/api/text/:id', async (req, reply) => {
  if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad id' });
  const info = stmts.deleteTextById.run(id);
  if (info.changes) notify('text'); // both UIs drop the chip
  return { ok: true, removed: info.changes };
});

// ---------- pairing QR (cached per pinned IP) ----------
const qrCache = new Map(); // ip -> png buffer (capped) or in-flight promise
app.get('/qr.png', async (req, reply) => {
  let ip = lanIPs()[0] || 'localhost';
  // allow the harness to pin a specific NIC (user's IP picker)
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
      .catch(e => { qrCache.delete(ip); throw e; }); // never cache a rejected promise
    qrCache.set(ip, p); // concurrent requests share one generation
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
    // a phone that just came online (scanning the pairing QR IS this ping) is
    // pushed to the harness immediately, so the QR retires on connect instead
    // of waiting for the next capture or the SSE-down 15s stats poll.
    if (trackPhone(req.ip, Number.isFinite(n) && n >= 0 ? n : undefined)) notify('phone');
  }
  return { ips: lanIPs(), port: PORT, scheme: SCHEME };
});

app.get('/api/version', () => ({ version: PP_VERSION }));

app.get('/phone', async (_req, reply) => {
  const html = phoneHtml ??= await fsp.readFile(path.join(ROOT, 'public', 'phone.html'), 'utf8');
  // content-hash stamp each asset so the phone never reuses a stale CSS/JS
  const stamped = html
    .replace('/phone.css?v=__PP_VERSION__', `/phone.css?v=${assetStamp('phone.css')}`)
    .replace('/phone.js?v=__PP_VERSION__', `/phone.js?v=${assetStamp('phone.js')}`);
  // no-store on the SHELL: a cached document rendered against newer
  // version-stamped assets is what shredded the phone layout after updates.
  // The document is ~4KB — zero cost to refetch, and it can never desync.
  reply.header('Cache-Control', 'no-store');
  return reply.type('text/html').send(stamped);
});

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`ProofPipe running (${SCHEME})`);
  console.log(`  Harness : http://localhost:${PORT}`);
  for (const ip of lanIPs()) console.log(`  Phone   : http://${ip}:${PORT}/phone`);
  console.log(TRUSTED_EXTENSION_ORIGIN
    ? `  Extension: ${TRUSTED_EXTENSION_ORIGIN}`
    : '  Extension: id unknown — any chrome-extension origin is trusted (add a manifest key or set PP_EXTENSION_ID)');
  // sweep AFTER listen: thumb regeneration must never delay server startup
  bootSweep().catch(() => {});
  // launched from ProofPipe.bat (PP_OPEN_BROWSER=1): open the harness now that
  // we're actually listening, in the browser chosen in Settings — replaces
  // the old "wait 2s then start" line, so no dead page and a custom PORT works
  if (process.env.PP_OPEN_BROWSER === '1') {
    openHarness(`${SCHEME}://localhost:${PORT}`).catch(() => {});
  }
}).catch(e => { console.error('LISTEN FAILED:', e); process.exit(1); });

function releaseLock() {
  try {
    const lock = readLock();
    if (lock && lock.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true }); // never delete another instance's lock
  } catch {}
}
process.on('exit', releaseLock); // crash paths too
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {
  console.log('\nShutting down...');
  releaseLock();
  // SSE streams never end — app.close() would wait on them FOREVER and the
  // node process would linger after Ctrl+C / closing the window. Kill them first.
  sseHub.destroyAll();
  // hard exit safety net: the console must never be left hanging
  const hardExit = setTimeout(() => process.exit(0), 1500);
  (async () => {
    try { await app.close(); db.close(); } catch {}
    clearTimeout(hardExit);
    process.exit(0);
  })();
});
