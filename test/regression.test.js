import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPort } from './port-ranges.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// fixed within regression's own disjoint range (see test/port-ranges.js).
// Was 8975 until NVIDIA's nvcontainer process squatted it (a socket in
// "Bound" state that netstat's LISTENING filter can't see — the bind fails
// while the port "looks" free).
const PORT = pickPort('regression');
const BASE = `http://127.0.0.1:${PORT}`;

// 1x1 red PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let child;
let errOut = '';
let dataDir;

async function waitUp(ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${errOut}`);
    try {
      const r = await fetch(`${BASE}/api/version`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`server did not start:\n${errOut}`);
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpipe-reg-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: APP,
    env: { ...process.env, PORT: String(PORT), PP_DATA: dataDir, PP_RATE_CAPACITY: '1000', PP_RATE_REFILL_PER_MIN: '1000' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', d => { errOut += d; });
  await waitUp();
});

after(() => {
  try { child?.kill(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

const upload = async () => {
  const fd = new FormData();
  fd.append('photo', new Blob([PNG], { type: 'image/png' }), 't.png');
  const r = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  assert.equal(r.status, 200);
  return r.json();
};

test('served HTML is version-stamped: script URLs carry ?v= and no __PP_VERSION__ leaks', async () => {
  // A stale tab (old app.js cached by the shell's 24h policy) ignores new SSE
  // events -> frozen grid until F5 — and the version banner can't detect it
  // when the HTML is fresh but the JS is stale. Version-stamping the script
  // URL makes every new page version request an UNCACHED URL, so a reload
  // always lands the matching JS.
  for (const path of ['/', '/phone']) {
    const html = await fetch(`${BASE}${path}`).then(r => r.text());
    assert.ok(!html.includes('__PP_VERSION__'), `${path} must not leak the placeholder`);
    assert.match(html, /\.js\?v=[0-9a-f]{10}|\.js\?v=v\d+\.\d+\.\d+/, `${path} must reference version-stamped script URLs`);
  }
  // the harness content-hashes its CSS/JS exactly like the phone shell (see
  // server.js assetStamp) so edits are never served stale — the stamp is a
  // hash, not the release version (an old version-string assertion rotted
  // here once the harness switched to hashing)
  const indexHtml = await fetch(`${BASE}/`).then(r => r.text());
  assert.match(indexHtml, /\/app\.js\?v=[0-9a-f]{10}/, 'harness script stamp must be a content hash');
  assert.match(indexHtml, /\/style\.css\?v=[0-9a-f]{10}/, 'harness stylesheet stamp must be a content hash');
  const phoneHtml = await fetch(`${BASE}/phone`).then(r => r.text());
  assert.match(phoneHtml, /\/phone\.js\?v=[0-9a-f]{10}/, 'phone script stamp must be a content hash');
  assert.match(phoneHtml, /\/phone\.css\?v=[0-9a-f]{10}/, 'phone stylesheet stamp must be a content hash');
});

test('version parity: served HTML meta matches /api/version (no false update banner)', async () => {
  const { version } = await fetch(`${BASE}/api/version`).then(r => r.json());
  const html = await fetch(`${BASE}/`).then(r => r.text());
  const meta = html.match(/<meta name="app-version" content="([^"]+)"/)?.[1];
  assert.ok(meta, 'index.html must carry an app-version meta tag');
  assert.equal(meta, version);
});

test('pagination beyond 100: ?limit honored, ?before keyset works, limit capped at 200', async () => {
  // make sure we have more than 100 captures
  const v0 = await fetch(`${BASE}/api/captures/version`).then(r => r.json());
  for (let i = v0.n; i < 120; i++) await upload();

  const page1 = await fetch(`${BASE}/api/captures`).then(r => r.json());
  assert.equal(page1.length, 100, 'default page is 100');

  const page2 = await fetch(`${BASE}/api/captures?before=${page1[page1.length - 1].id}`).then(r => r.json());
  assert.ok(page2.length >= 20, `keyset page should hold the rest (got ${page2.length})`);
  const ids = new Set([...page1, ...page2].map(c => c.id));
  assert.equal(ids.size, page1.length + page2.length, 'no overlap between keyset pages');
  assert.ok(Math.min(...page2.map(c => c.id)) < Math.min(...page1.map(c => c.id)), 'older items come after ?before=');

  const capped = await fetch(`${BASE}/api/captures?limit=9999`).then(r => r.json());
  assert.equal(capped.length, Math.min(200, 120), 'limit is honored but capped at 200');

  const bad = await fetch(`${BASE}/api/captures?limit=abc`).then(r => r.json());
  assert.equal(bad.length, 100, 'non-numeric limit falls back to 100');
});

test('oversized upload is rejected by the 20MB body limit', async () => {
  const fd = new FormData();
  fd.append('photo', new Blob([Buffer.alloc(21 * 1024 * 1024)], { type: 'image/png' }), 'big.png');
  const r = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  assert.ok(r.status >= 400, `expected rejection, got ${r.status}`);
});

test('body limit has headroom over the multipart file cap (a ~19.9MB photo is not a 413)', () => {
  // A photo just under the 20MB file cap plus multipart framing once exceeded
  // the (equal) body limit → Fastify 413'd the whole request and the phone
  // poisoned a fine capture. Regression pin: the limits must not be equal.
  // (The 21MB body above still 413s; this asserts the boundary moved.)
  // 19.9MB of PNG header bytes is not a decodable image, so the honest
  // outcome is 415 from the probe — ANY status except 413/414 proves the
  // body reached the route handler instead of dying at bodyLimit.
  return (async () => {
    const fd = new FormData();
    fd.append('source', 'phone');
    fd.append('photo', new Blob([Buffer.alloc(19.9 * 1024 * 1024, 0)], { type: 'image/png' }), 'edge.png');
    const r = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
    assert.ok(r.status !== 413, `19.9MB body must not die at bodyLimit (got 413 — headroom regressed)`);
  })();
});

test('delete reports failure semantics and DB/file stay consistent', async () => {
  const { id, file } = await upload();
  const r = await fetch(`${BASE}/api/captures/${id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  // both files must actually be gone when ok:true is reported
  assert.equal((await fetch(`${BASE}/media/${file}`)).status, 404);
  assert.equal((await fetch(`${BASE}/media/t-${file}`)).status, 404);
});

test('delete-all wipes every capture (DB + files) and reports the count', async () => {
  // ensure at least a few exist
  await upload();
  await upload();
  const v = await fetch(`${BASE}/api/captures/version`).then(r => r.json());
  assert.ok(v.n >= 2, `expected >=2 captures before delete-all, got ${v.n}`);

  const r = await fetch(`${BASE}/api/captures`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.deleted, v.n);

  const after = await fetch(`${BASE}/api/captures/version`).then(r => r.json());
  assert.equal(after.n, 0);
  assert.equal(after.latest, 0);

  // every file (originals + thumbnails) must be gone from disk
  const files = fs.readdirSync(path.join(dataDir, 'captures')).filter(f => !f.startsWith('t-tmp-'));
  assert.equal(files.length, 0, `captures dir should be empty: ${files}`);

  // storage stat resets
  const s = await fetch(`${BASE}/api/stats`).then(r => r.json());
  assert.equal(s.bytes, 0);
});

test('temp upload files are not left behind after a successful upload', async () => {
  const before = fs.readdirSync(path.join(dataDir, 'captures')).filter(f => f.includes('tmp'));
  assert.equal(before.length, 0, `no tmp files should persist: ${before}`);
});

test('CSRF guard covers POST setting endpoints, not just DELETEs', async () => {
  // cross-site POSTs (no preflight needed for simple requests) must be blocked
  // — flipping autoCleanup:true from a random page used to trim oldest captures
  const evil = { origin: 'https://evil.example' };
  for (const [url, body] of [
    ['/api/autopaste', { auto: true }],
    ['/api/autocleanup', { on: true }],
  ]) {
    const r = await fetch(`${BASE}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...evil },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 403, `${url} must reject a cross-site POST`);
    // same-origin POST still works (no Origin header from curl-like clients)
    const ok = await fetch(`${BASE}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(ok.status, 200);
  }
  // leave settings OFF so later tests aren't affected
  await fetch(`${BASE}/api/autopaste`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto: false }) });
  await fetch(`${BASE}/api/autocleanup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) });
});

// ---------- the capture pixel ceiling (server/store.js MAX_PIXELS) ----------
// The ceiling is a decompression-bomb guard AND a promise to the sender: the
// phone is not allowed to downscale anything unless the quality setting is on
// (see test/quality-clamp.test.js), so a real full-resolution phone photo must
// be accepted — a refusal means the capture can never arrive at all.
test('a 33MP photo uploads untouched (the ceiling is no longer 30MP)', async () => {
  const sharp = (await import('sharp')).default;
  // 6000×5500 = 33.0MP: over the old 30MP ceiling, well under the current one.
  // A flat synthetic frame keeps the payload ~190KB and the build ~300ms.
  const jpeg = await sharp({ create: { width: 6000, height: 5500, channels: 3, background: { r: 12, g: 34, b: 56 } } })
    .jpeg({ quality: 60 }).toBuffer();
  const fd = new FormData();
  fd.append('source', 'phone');
  fd.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'big.jpg');
  const r = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  assert.equal(r.status, 200, `a 33MP capture must be accepted (got ${r.status})`);
  const { id, file } = await r.json();
  assert.match(file, /\.jpg$/);
  const stored = Buffer.from(await fetch(`${BASE}/media/${file}`).then(x => x.arrayBuffer()));
  assert.ok(stored.equals(jpeg), 'stored byte-for-byte — the server never re-encodes an original');
  await fetch(`${BASE}/api/captures/${id}`, { method: 'DELETE' });
});

test('past the pixel ceiling the upload is refused as TERMINAL, with a reason', async () => {
  const sharp = (await import('sharp')).default;
  const before = (await fetch(`${BASE}/api/captures/version`).then(r => r.json())).n;
  // 11000×7000 = 77MP, past the ceiling. The STATUS matters: the phone's queue
  // poisons on 413 only (public/queue.js) — a 415 backs off and retries FOREVER,
  // which is how an oversized photo used to sit in the outbox for eternity
  // without a single word to the user. The body's reason is what it tells them.
  const jpeg = await sharp({ create: { width: 11000, height: 7000, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .jpeg({ quality: 60 }).toBuffer();
  const fd = new FormData();
  fd.append('source', 'phone');
  fd.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'huge.jpg');
  const r = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  assert.equal(r.status, 413, `over-ceiling must be terminal, not retryable (got ${r.status})`);
  assert.equal((await r.json()).error, 'too many pixels', 'the phone needs a reason it can report');
  const after = (await fetch(`${BASE}/api/captures/version`).then(r => r.json())).n;
  assert.equal(after, before, 'a refused capture is not stored');
});

test('the pixel ceiling is published to the phone (GET /api/quality)', async () => {
  // The phone reads this instead of guessing a limit: guessing LOW is what made
  // a 48MP HEIC lose 74% of its pixels to a format conversion. It must be big
  // enough for the largest real sensor mode the phone can hand over.
  const q = await fetch(`${BASE}/api/quality`).then(r => r.json());
  assert.equal(typeof q.maxPixels, 'number');
  assert.ok(q.maxPixels >= 48_800_000, `must cover a 48MP HEIC (got ${q.maxPixels})`);
  const s = await fetch(`${BASE}/api/settings`).then(r => r.json());
  assert.equal(s.quality.maxPixels, q.maxPixels, 'the settings bundle and the endpoint must agree');
});

test('SVG uploads are rejected (415), not stored with a .jpg extension', async () => {
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  const fd = new FormData();
  fd.append('photo', new Blob([SVG], { type: 'image/svg+xml' }), 'evil.svg');
  const r = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  assert.equal(r.status, 415, `svg must be rejected, got ${r.status}`);
});

test('CSRF guard blocks DNS-rebinding: matching evil Host is refused, LAN-IP Host passes', async () => {
  // rebinding page: Origin evil.example + Host evil.example (resolves to the PC).
  // Old check (origin.host === headers.host) accepted this; now the Host must be
  // an address the server actually answers on.
  const reb = await fetch(`${BASE}/api/autopaste`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://evil.example:8787',
      Host: 'evil.example:8787', // Node honors an explicit Host header
    },
    body: JSON.stringify({ auto: false }),
  });
  assert.equal(reb.status, 403, 'rebound Host must be refused');
  // same request through a legitimate host still works (origin === host,
  // host is loopback → pass). Port comes from BASE — tests bind dynamically.
  const u = new URL(BASE);
  const ok = await fetch(`${BASE.replace('127.0.0.1', 'localhost')}/api/autopaste`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://localhost:${u.port}`, // origin === host, loopback → pass
    },
    body: JSON.stringify({ auto: false }),
  });
  assert.equal(ok.status, 200, 'same-origin loopback POST must still pass');
});

test('extension origin is pinned to the manifest key (a foreign extension is refused)', async () => {
  // The old gate trusted ANY chrome-extension://<32 a-p chars> origin, so any
  // other extension the user had installed could wipe captures. The id is now
  // derived from extension/manifest.json's `key` (SHA-256 of the base64-decoded
  // public key, first 128 bits mapped 0-f -> a-p) — the same algorithm Chrome
  // uses. This test recomputes it independently and proves the pin.
  const mf = JSON.parse(fs.readFileSync(path.join(APP, 'extension', 'manifest.json'), 'utf8'));
  assert.ok(typeof mf.key === 'string' && mf.key, 'manifest must carry a key so the id is stable');
  const hex = createHash('sha256').update(Buffer.from(mf.key, 'base64')).digest('hex').slice(0, 32);
  const own = hex.replace(/[0-9a-f]/g, c => 'abcdefghijklmnop'[parseInt(c, 16)]);

  const good = await fetch(`${BASE}/api/autopaste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `chrome-extension://${own}` },
    body: JSON.stringify({ auto: false }),
  });
  assert.equal(good.status, 200, 'our own extension origin must pass the mutation gate');

  const foreign = 'a'.repeat(32); // valid shape, wrong id
  assert.notEqual(foreign, own);
  const bad = await fetch(`${BASE}/api/autopaste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `chrome-extension://${foreign}` },
    body: JSON.stringify({ auto: false }),
  });
  assert.equal(bad.status, 403, 'a foreign extension must NOT be trusted');
});

test('upload SSE contract: capture-ready only for auto captures, capture once after thumb', async () => {
  const res = await fetch(`${BASE}/events`);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const collect = async ms => {
    let buf = '';
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = Math.max(0, end - Date.now());
      const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ done: true }), t))]);
      if (done) break;
      buf += Buffer.from(value).toString();
    }
    return buf;
  };
  try {
    // listen first so nothing is missed, then upload (small PNG: thumb derives fast)
    const listener = collect(2000);
    await new Promise(r => setTimeout(r, 100));
    await upload(); // no auto field -> NOT an auto capture
    const buf = await listener;
    const events = [...buf.matchAll(/^data: (.*)$/gm)].map(m => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean)
      .filter(e => e.type === 'capture' || e.type === 'capture-ready');
    assert.ok(events.length >= 1, 'at least the post-thumb capture event must fire');
    assert.ok(!events.some(e => e.type === 'capture-ready'), `non-auto upload must NOT fire capture-ready (got ${JSON.stringify(events.map(e => e.type))})`);
    const cap = events.find(e => e.type === 'capture');
    assert.ok(cap, 'post-thumb capture event must fire');
    assert.ok(cap.capture && cap.capture.id != null && cap.capture.file, 'event carries the full capture row');
  } finally {
    try { await reader.cancel(); } catch {}
  }
});

test('auto-tagged upload fires capture-ready immediately (extension paste path)', async () => {
  const res = await fetch(`${BASE}/events`);
  const reader = res.body.getReader();
  const collect = async ms => {
    let buf = '';
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = Math.max(0, end - Date.now());
      const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ done: true }), t))]);
      if (done) break;
      buf += Buffer.from(value).toString();
    }
    return buf;
  };
  try {
    const listener = collect(2000);
    await new Promise(r => setTimeout(r, 100));
    const fd = new FormData();
    fd.append('source', 'phone');
    fd.append('auto', '1');
    fd.append('photo', new Blob([PNG], { type: 'image/png' }), 't.png');
    const r = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
    assert.equal(r.status, 200);
    const buf = await listener;
    const events = [...buf.matchAll(/^data: (.*)$/gm)].map(m => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean)
      .filter(e => e.type === 'capture' || e.type === 'capture-ready');
    const ready = events.find(e => e.type === 'capture-ready');
    assert.ok(ready, 'auto upload must fire capture-ready');
    assert.equal(ready.auto, true, 'capture-ready carries auto:true');
    assert.ok(ready.capture && ready.capture.id != null, 'capture-ready carries the row');
    assert.equal(ready.autoTarget, 'default', 'capture-ready carries the browser target (default first boot)');
    assert.equal(events.filter(e => e.type === 'capture').length, 1, 'exactly one post-thumb capture event');
  } finally {
    try { await reader.cancel(); } catch {}
  }
});

test('share-target POST /share stores images as phone captures and 303s to the phone', async () => {
  // Android "Share → ProofPipe" files land here (multipart, field name 'media')
  const fd = new FormData();
  fd.append('media', new Blob([PNG], { type: 'image/png' }), 'shared.png');
  fd.append('text', 'check this out'); // text fields ride along
  const r = await fetch(`${BASE}/share`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(r.status, 303, `share must 303 to the phone, got ${r.status}`);
  assert.equal(new URL(r.headers.get('location'), BASE).pathname, '/phone');
  assert.equal(new URL(r.headers.get('location'), BASE).searchParams.get('shared'), '1');
  // the image became a phone-origin capture with full pipeline behind it
  const caps = await fetch(`${BASE}/api/captures?limit=5`).then(r => r.json());
  const newest = caps.find(c => c.origin === 'phone');
  assert.ok(newest, 'shared image must be stored as a capture');
  assert.ok(newest.file, 'capture carries a stored filename');
  // the text landed in the phone→PC texts
  const texts = await fetch(`${BASE}/api/text?source=phone`).then(r => r.json());
  assert.ok(texts.some(t => t.body === 'check this out'), 'share text must be stored as a phone text');
});

test('share-target with text only (no files) posts the text, no capture', async () => {
  const before = (await fetch(`${BASE}/api/captures/version`).then(r => r.json())).n;
  const fd = new FormData();
  fd.append('text', 'just a link share');
  const r = await fetch(`${BASE}/share`, { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(r.status, 303);
  const after = (await fetch(`${BASE}/api/captures/version`).then(r => r.json())).n;
  assert.equal(after, before, 'text-only share must not create a capture');
  const texts = await fetch(`${BASE}/api/text?source=phone`).then(r => r.json());
  assert.ok(texts.some(t => t.body === 'just a link share'), 'text-only share stores the text');
});

test('share-target rejects cross-site POSTs (CSRF keeps the disk floodable by nobody but us)', async () => {
  const fd = new FormData();
  fd.append('media', new Blob([PNG], { type: 'image/png' }), 'evil.png');
  const r = await fetch(`${BASE}/share`, {
    method: 'POST',
    body: fd,
    headers: { Origin: 'https://evil.example' },
    redirect: 'manual',
  });
  assert.equal(r.status, 403, `cross-site share must be refused, got ${r.status}`);
});

test('stats tracks MULTIPLE phones (single-slot version let phone #2 overwrite phone #1)', async () => {
  // phone A: this suite's normal loopback source
  await fetch(`${BASE}/api/lan?device=phone&outbox=3`);
  // phone B: same destination but a DIFFERENT SOURCE address (bound locally to
  // 127.0.0.2) => a genuinely different req.ip. fetch can't set localAddress,
  // so this one request uses node:http. (No trustProxy — X-Forwarded-For is
  // deliberately NOT honored, it would let a LAN client spoof its rate bucket.)
  await new Promise((resolve, reject) => {
    const u = new URL(BASE);
    http.get({
      host: u.hostname, port: u.port, path: '/api/lan?device=phone&outbox=2',
      localAddress: '127.0.0.2',
    }, res => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });

  const s = await fetch(`${BASE}/api/stats`).then(r => r.json());
  assert.ok(s.phoneCount >= 2, `two phones must be tracked, got ${s.phoneCount}`);
  assert.ok(Array.isArray(s.phones) && s.phones.length >= 2, 'phones array carries every known phone');
  const ips = new Set(s.phones.map(p => p.ip));
  assert.ok(ips.has('127.0.0.1') && ips.has('127.0.0.2'), `both source IPs tracked: ${[...ips]}`);
  // top-level fields stay backward-compatible and describe the most recent phone
  assert.ok(s.phoneLastSeen > 0, 'phoneLastSeen still reports the most recent phone');
  assert.ok(s.phoneIp, 'phoneIp still reports a host for phone-side links');
  // outbox: sum across phones (capped at 999 server-side)
  assert.equal(s.phoneOutbox, Math.min(999, s.phones.reduce((a, p) => a + p.outbox, 0)), 'outbox sums across phones');

  // re-poll from phone A: still two entries, A's outbox updated, nothing lost
  await fetch(`${BASE}/api/lan?device=phone&outbox=5`);
  const s2 = await fetch(`${BASE}/api/stats`).then(r => r.json());
  assert.ok(s2.phoneCount >= 2, 're-poll must not collapse the registry');
  const a = s2.phones.find(p => p.ip === '127.0.0.1');
  assert.ok(a && a.outbox === 5, `phone A outbox updated to 5, got ${JSON.stringify(a)}`);
});

test('a phone coming online pushes ONE phone SSE event (the pairing QR retires on connect)', async () => {
  // The harness only learns that a phone exists by re-reading /api/stats, and it
  // used to do that on capture/file events or a 15s poll that runs ONLY while SSE
  // is down — so the pairing QR stayed on screen long after it was scanned. The
  // server now pushes a 'phone' event on the online TRANSITION (first contact,
  // or first after going quiet), which is what the harness listens for.
  // 127.0.0.3: an address no other test pings, so this is a genuine first contact.
  const ping = localAddress => new Promise((resolve, reject) => {
    const u = new URL(BASE);
    http.get({ host: u.hostname, port: u.port, path: '/api/lan?device=phone', localAddress },
      res => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
  const res = await fetch(`${BASE}/events`);
  const reader = res.body.getReader();
  const collect = async ms => {
    let buf = '';
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = Math.max(0, end - Date.now());
      const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ done: true }), t))]);
      if (done) break;
      buf += Buffer.from(value).toString();
    }
    return buf;
  };
  // 'phone' events are payload-less (a bare type string survives unparsed)
  const phoneEvents = buf => [...buf.matchAll(/^data: (.*)$/gm)]
    .map(m => { try { return JSON.parse(m[1]).type; } catch { return m[1]; } })
    .filter(t => t === 'phone').length;
  try {
    let listener = collect(1500);
    await new Promise(r => setTimeout(r, 100));
    await ping('127.0.0.3');
    assert.equal(phoneEvents(await listener), 1, 'the first ping from a phone must push exactly one phone event');
    // A keep-alive ping seconds later must stay silent — the phone pings every
    // 10-60s and waking every SSE client (the PC grid included) for each one
    // would be pure noise.
    listener = collect(800);
    await ping('127.0.0.3');
    assert.equal(phoneEvents(await listener), 0, 'a keep-alive ping must NOT re-fire the phone event');
  } finally {
    try { await reader.cancel(); } catch {}
  }
});

test("closing the phone's live wire flips phoneOnline fast (the pairing QR returns in seconds)", async () => {
  // The ping window alone left the harness waiting ~90s plus a stats tick before
  // it would put the QR back. The phone's SSE stream closing is knowable right
  // away, so /api/stats answers `phoneOnline: false` after a short grace — well
  // inside the window, i.e. this is the fast path and not the clock.
  const ping = () => fetch(`${BASE}/api/lan?device=phone&outbox=0`);
  const stats = () => fetch(`${BASE}/api/stats`).then(r => r.json());
  await ping();

  // the phone's own stream. node:http (not fetch) so the socket can be DESTROYED
  // — a real "the page went away", not just a paused reader.
  const phoneReq = http.get(`${BASE}/events?device=phone`);
  await new Promise((resolve, reject) => {
    phoneReq.on('response', res => { res.resume(); resolve(); });
    phoneReq.on('error', reject);
  });

  // a harness listener — no device param, so it is NOT a phone connection
  const res = await fetch(`${BASE}/events`);
  const reader = res.body.getReader();
  const collect = async ms => {
    let buf = '';
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = Math.max(0, end - Date.now());
      const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ done: true }), t))]);
      if (done) break;
      buf += Buffer.from(value).toString();
    }
    return buf;
  };
  try {
    const s0 = await stats();
    assert.equal(s0.phoneOnline, true, 'a pinging, streaming phone is online');

    // 7s > the 4s presence grace; the push must land inside it
    const listener = collect(7000);
    phoneReq.destroy(); // phone page closed
    const buf = await listener;
    const types = [...buf.matchAll(/^data: (.*)$/gm)]
      .map(m => { try { return JSON.parse(m[1]).type; } catch { return m[1]; } });
    assert.ok(types.includes('phone'), `closing the phone stream must push a phone event (got ${JSON.stringify(types)})`);

    const s1 = await stats();
    assert.ok(Date.now() - s1.phoneLastSeen < 90000, 'the ping is still inside the old window — so this is the fast path');
    assert.equal(s1.phoneOnline, false, 'the harness is told the phone is gone within the grace period');

    // self-healing: a ping contradicts the verdict, so a phone that lost its
    // stream while still reachable can never be stuck "offline"
    await ping();
    const s2 = await stats();
    assert.equal(s2.phoneOnline, true, 'a later ping clears the close verdict');
  } finally {
    try { await reader.cancel(); } catch {}
    try { phoneReq.destroy(); } catch {}
  }
});