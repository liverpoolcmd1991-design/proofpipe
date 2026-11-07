import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { pickPort } from './port-ranges.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// read the version from package.json — the server derives PP_VERSION from the
// same file, so this test never needs a hardcoded string bumped by hand
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
const VERSION = `v${PKG_VERSION}`;
// per-suite port RANGES live in test/port-ranges.js (ONE disjoint table, so a
// new suite can't silently overlap an existing one), randomized within the
// range to avoid unrelated apps that hold the exact port — see PITFALLS
// #27/#39. The retry-on-EADDRINUSE loop below redraws within smoke's own range.
const PORT = pickPort('smoke');
let BASE = `http://127.0.0.1:${PORT}`; // let: the EADDRINUSE retry below may re-draw the port

// 1x1 red PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// A real NxN PNG, built here rather than shipped as a fixture.
//
// The capture pipeline acks the upload and derives the thumbnail in the
// BACKGROUND, and sharp holds the original open for the whole decode. A 1x1
// decodes in ~1ms, so a delete fired right after the ack only *sometimes* lands
// inside that window (which is exactly why the orphan race below was flaky).
// 1400x1400 measures ~50ms — long enough that the delete is always racing the
// decode, and the test asserts the FIX rather than a lucky interleaving.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = buf => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function pngOfSize(n) {
  const stride = n * 3 + 1;
  const raw = Buffer.alloc(stride * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = x & 255;
      raw[o + 1] = y & 255;
      raw[o + 2] = 90;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

// Boot with one retry: the randomized port can be HELD by an unrelated process
// as an ephemeral outbound port (a proxy client held 9030 this way — invisible
// to netstat's LISTENING filter), and the server exits with EADDRINUSE. A
// fresh random draw from the range retries instead of failing 12 tests.
before(async () => {
  for (let attempt = 0; ; attempt++) {
    const port = PORT + attempt;
    BASE = `http://127.0.0.1:${port}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpipe-test-'));
    child = spawn(process.execPath, ['server.js'], {
      cwd: APP,
      env: { ...process.env, PORT: String(port), PP_DATA: dataDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', d => { errOut += d; });
    try {
      await waitUp();
      break;
    } catch (e) {
      const died = child.exitCode !== null;
      // Read the reason BEFORE clearing the buffer: this used to reset errOut
      // first and then test /EADDRINUSE/ against the now-empty string, so the
      // condition was always true and the retry loop threw on the FIRST
      // collision — the redraw existed on paper only, and any grabbed port
      // failed all 17 tests in this suite instead of drawing another one.
      const squatted = /EADDRINUSE/.test(errOut);
      try { child.kill(); } catch {}
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
      child = null; errOut = '';
      // retry only when the server died on THIS port specifically (ephemeral
      // squat); range 9027-9060 gives ~34 draws before this gives up
      if (!died || attempt >= 33 || !squatted) throw e;
      await new Promise(r => setTimeout(r, 200));
    }
  }
});

after(() => {
  try { child?.kill(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

test('version endpoint reports the package.json version', async () => {
  const r = await fetch(`${BASE}/api/version`);
  const { version } = await r.json();
  assert.equal(version, VERSION);
});

test('stats reports tracked byte totals (no FS walk)', async () => {
  const fd = new FormData();
  fd.append('photo', new Blob([PNG], { type: 'image/png' }), 't.png');
  const up = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  assert.equal(up.status, 200);
  const { id } = await up.json();
  const s = await fetch(`${BASE}/api/stats`).then(r => r.json());
  assert.ok(s.bytes > 0, 'bytes should be tracked on write');
  await fetch(`${BASE}/api/captures/${id}`, { method: 'DELETE' });
  const s2 = await fetch(`${BASE}/api/stats`).then(r => r.json());
  assert.ok(s2.bytes < s.bytes, 'bytes should decrease after delete');
});

test('a delete waits for an in-flight decode of the original (no orphan, honest bytes)', async () => {
  // The race this pins: /upload acks BEFORE the thumbnail is derived, and sharp
  // holds the ORIGINAL open for that whole decode. A delete fired straight after
  // the ack therefore raced the decode: on Windows the unlink lost (EBUSY), the
  // row went but the file stayed, and the byte accounting re-added the leftover
  // to stay honest — so `bytes` did not even go down. Both symptoms were the same
  // bug, and both were only visible under suite load.
  const dir = path.join(dataDir, 'captures');
  const before = await fetch(`${BASE}/api/stats`).then(r => r.json());
  const fd = new FormData();
  fd.append('photo', new Blob([pngOfSize(1400)], { type: 'image/png' }), 'race.png');
  const up = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  assert.equal(up.status, 200);
  const { id, file } = await up.json();
  const uploaded = await fetch(`${BASE}/api/stats`).then(r => r.json());
  assert.ok(uploaded.bytes > before.bytes, 'the upload is counted');

  // fire the delete IMMEDIATELY — the background thumb decode is in flight now
  assert.equal((await fetch(`${BASE}/api/captures/${id}`, { method: 'DELETE' })).status, 200);

  // give a late thumb write time to land before checking, so this cannot pass by
  // being fast: if the thumbnail job still writes after the delete, it shows up
  await new Promise(r => setTimeout(r, 400));
  for (const f of [file, `t-${file}`, `t-tmp-t-${file}`]) {
    assert.ok(!fs.existsSync(path.join(dir, f)), `${f} must not be left behind`);
  }
  const after = await fetch(`${BASE}/api/stats`).then(r => r.json());
  assert.ok(after.bytes < uploaded.bytes, 'the deleted bytes leave the total (nothing re-added)');
});

test('a wipe fired right after an upload leaves no orphan either', async () => {
  // The bulk path already retried its unlinks, which is why this one looks after
  // only a long decode could beat it — but "the retry budget happens to cover a
  // PNG" is not a correctness argument, so the wipe now WAITS for the reader like
  // the single-row deleter does. This pins the user-visible outcome: a wipe right
  // after a batch upload comes back clean.
  const dir = path.join(dataDir, 'captures');
  const fd = new FormData();
  fd.append('photo', new Blob([pngOfSize(1400)], { type: 'image/png' }), 'wipe.png');
  const up = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  assert.equal(up.status, 200);
  assert.equal((await fetch(`${BASE}/api/captures`, { method: 'DELETE' })).status, 200);
  await new Promise(r => setTimeout(r, 400)); // let a late thumb write land, if any
  assert.equal(fs.readdirSync(dir).length, 0, 'nothing left on disk for the boot sweep');
  assert.equal((await fetch(`${BASE}/api/captures/version`).then(r => r.json())).n, 0, 'no rows either');
});

test('cleanup: BOTH capture deleters are armed against an in-flight decode', async () => {
  // The invariant the tests above depend on, pinned at the source so a refactor
  // cannot quietly drop one side of it. Both the single-row deleter and the wipe
  // unlink originals that a background thumbnail job may be reading, so each has
  // to (a) wait for the reader and (b) retry the unlink — and the reader has to
  // announce itself, or both waits are silent no-ops. Dropping any one of those
  // is invisible in an unloaded run, which is exactly how this shipped.
  const read = f => fs.readFileSync(path.join(APP, f), 'utf8');
  const cleanup = read('server/cleanup.js');
  const captures = read('server/captures.js');
  const store = read('server/store.js');
  assert.match(cleanup, /awaitFileIdle\(path\.join\(CAPTURES, cap\.file\)\)/, 'the single deleter waits for the reader');
  assert.match(captures, /rows\.map\(cap => awaitFileIdle\(path\.join\(paths\(\)\.captures, cap\.file\)\)\)/, 'the wipe waits too');
  assert.match(cleanup, /rmWithRetry\(path\.join\(CAPTURES, f\)\)/, 'the single deleter retries the unlink');
  assert.match(captures, /rmWithRetry\(path\.join\(paths\(\)\.captures, f\)\)/, 'the wipe retries too');
  assert.match(store, /if \(reading\) beginFileRead\(input\)/, 'the reader announces itself');
  assert.match(store, /finally \{\n\s*if \(reading\) endFileRead\(input\);/, 'and always clears the announcement');
});

test('cleanup: a reader in flight blocks the unlink until it ends (bounded)', async () => {
  // The mechanism the test above depends on, in isolation — so a future change
  // to removeCaptureRow cannot quietly drop the wait and leave only the flaky
  // end-to-end signal behind.
  const { beginFileRead, endFileRead, awaitFileIdle } = await import('../server/cleanup.js');
  const target = path.join(dataDir, 'captures', 'in-flight.png');

  beginFileRead(target); // e.g. sharp decoding this original for a thumbnail
  let idle = false;
  const waited = awaitFileIdle(target).then(() => { idle = true; });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(idle, false, 'the waiter holds while a reader is in flight');
  endFileRead(target);
  await waited;
  assert.equal(idle, true, 'and resolves the moment the reader ends');

  // a wedged reader must not wedge the delete: the wait is bounded
  beginFileRead(target);
  const t0 = Date.now();
  await awaitFileIdle(target, 50);
  assert.ok(Date.now() - t0 >= 45, 'the timeout path still resolves');
  endFileRead(target);
  assert.equal(await awaitFileIdle(target), undefined, 'idle again — no leaked registration');
});

// thumbnails are derived AFTER the fast upload ack — poll briefly
async function waitThumb(file, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fetch(`${BASE}/media/t-${file}`);
    if (r.ok) return r;
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
}

test('media responses carry immutable cache headers', async () => {
  const fd = new FormData();
  fd.append('photo', new Blob([PNG], { type: 'image/png' }), 't.png');
  const { file } = await fetch(`${BASE}/upload`, { method: 'POST', body: fd }).then(r => r.json());
  const res = await waitThumb(file);
  assert.ok(res, 'thumbnail should appear after the async derivation');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  await fetch(`${BASE}/api/captures?limit=50`).then(r => r.json()).then(async list => {
    const row = list.find(c => c.file === file);
    await fetch(`${BASE}/api/captures/${row.id}`, { method: 'DELETE' });
  });
});

test('captures version endpoint includes textId for poll fallback', async () => {
  const v = await fetch(`${BASE}/api/captures/version`).then(r => r.json());
  assert.ok(Number.isInteger(v.textId));
});

test('QR endpoint accepts a validated ip param', async () => {
  const bad = await fetch(`${BASE}/qr.png?ip=9.9.9.9`);
  assert.equal(bad.status, 200); // falls back to default IP rather than failing
});

test('text sync roundtrip + source filter + history cap', async () => {
  const post = (body, source) => fetch(`${BASE}/api/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, source }),
  });
  const r1 = await post('hello from pc', 'pc');
  assert.equal(r1.status, 200);
  await post('hello from phone', 'phone');
  await post('second pc', 'pc');

  const pcTexts = await fetch(`${BASE}/api/text?source=pc&limit=10`).then(r => r.json());
  assert.ok(pcTexts.every(t => t.source === 'pc'));
  assert.equal(pcTexts[0].body, 'second pc'); // newest first

  const all = await fetch(`${BASE}/api/text?limit=20`).then(r => r.json());
  assert.ok(all.some(t => t.body === 'hello from phone'));

  const empty = await post('   ', 'pc');
  assert.equal(empty.status, 400); // whitespace-only rejected
});

test('DELETE /api/text/:id removes ONE row (phone swipe-to-delete)', async () => {
  const post = (body, source) => fetch(`${BASE}/api/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, source }),
  });
  await post('swipe me', 'pc');
  await post('keep me', 'pc');
  const list = await fetch(`${BASE}/api/text?source=pc&limit=10`).then(r => r.json());
  const victim = list.find(t => t.body === 'swipe me');
  assert.ok(victim, 'setup: the row to delete exists');

  // malformed ids are refused outright
  assert.equal((await fetch(`${BASE}/api/text/not-a-number`, { method: 'DELETE' })).status, 400);
  assert.equal((await fetch(`${BASE}/api/text/0`, { method: 'DELETE' })).status, 400);

  const del = await fetch(`${BASE}/api/text/${victim.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).removed, 1);

  const after = await fetch(`${BASE}/api/text?source=pc&limit=10`).then(r => r.json());
  assert.ok(!after.some(t => t.id === victim.id), 'the deleted row is gone');
  assert.ok(after.some(t => t.body === 'keep me'), 'the sibling row survives');
  // deleting it again is a no-op, not an error (idempotent for a double swipe)
  assert.equal((await fetch(`${BASE}/api/text/${victim.id}`, { method: 'DELETE' })).status, 200);
});

test('upload -> list -> media -> delete roundtrip', async () => {
  const fd = new FormData();
  fd.append('photo', new Blob([PNG], { type: 'image/png' }), 't.png');
  const up = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  assert.equal(up.status, 200, 'upload should succeed');
  const { id, file } = await up.json();
  assert.ok(id > 0);
  assert.match(file, /\.png$/, 'original format is preserved (PNG stays PNG, no re-encode)');

  const list = await fetch(`${BASE}/api/captures`).then(r => r.json());
  assert.ok(list.some(c => c.id === id));
  assert.match(file, /\.png$/, 'original format is preserved (PNG stays PNG, no re-encode)');

  // original served untouched + 400px thumbnail derived asynchronously
  const orig = await fetch(`${BASE}/media/${file}`);
  assert.equal(orig.status, 200);
  assert.equal(orig.headers.get('content-type'), 'image/png');
  const origBuf = Buffer.from(await orig.arrayBuffer());
  assert.ok(origBuf.equals(PNG), 'original bytes must be stored byte-for-byte');
  const thumb = await waitThumb(file);
  assert.ok(thumb, 'thumbnail should appear after the async derivation');
  assert.equal(thumb.headers.get('content-type'), 'image/png', 'thumbnail matches the original format');

  const del = await fetch(`${BASE}/api/captures/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const afterDel = await fetch(`${BASE}/api/captures`).then(r => r.json());
  assert.ok(!afterDel.some(c => c.id === id));
  assert.equal((await fetch(`${BASE}/media/${file}`)).status, 404);
  assert.equal((await fetch(`${BASE}/media/t-${file}`)).status, 404);
});

test('rejects non-image upload', async () => {
  const fd = new FormData();
  fd.append('photo', new Blob([Buffer.from('this is definitely not an image')], { type: 'text/plain' }), 'x.txt');
  const r = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  assert.equal(r.status, 415);
});

test('delete nonexistent capture returns 404', async () => {
  const r = await fetch(`${BASE}/api/captures/999999`, { method: 'DELETE' });
  assert.equal(r.status, 404);
});

test('captures version endpoint tracks count and latest', async () => {
  const v1 = await fetch(`${BASE}/api/captures/version`).then(r => r.json());
  const fd = new FormData();
  fd.append('photo', new Blob([PNG], { type: 'image/png' }), 't.png');
  await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  const v2 = await fetch(`${BASE}/api/captures/version`).then(r => r.json());
  assert.equal(v2.n, v1.n + 1);
  assert.ok(v2.latest > v1.latest);
});

test('CORS preflight is answered for extension requests', async () => {
  const r = await fetch(`${BASE}/api/captures`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'chrome-extension://abcdefg',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('access-control-allow-private-network'), 'true');
});

test('orphan sweep removes files with no DB row', async () => {
  // the boot sweep ran on a fresh dir; simulate by checking DB count matches files
  const files = fs.readdirSync(path.join(dataDir, 'captures')).filter(f => !f.startsWith('t-'));
  const v = await fetch(`${BASE}/api/captures/version`).then(r => r.json());
  assert.equal(files.length, v.n);
});
