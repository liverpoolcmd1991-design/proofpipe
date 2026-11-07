import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPort } from './port-ranges.js';

// File-transfer backend: isolated server (own PP_DATA, PP_MAX_FILE_MB=1 so the
// 413 path is testable, generous file rate bucket so bursts don't 429).
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// a fixed port would collide with unrelated apps that happen to hold it
// (e.g. a VPN core); draw within files' range (test/port-ranges.js)
const PORT = pickPort('files');
const BASE = `http://127.0.0.1:${PORT}`;

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpipe-files-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: APP,
    env: { ...process.env, PORT: String(PORT), PP_DATA: dataDir, PP_MAX_FILE_MB: '1', PP_FILE_RATE_CAPACITY: '1000', PP_FILE_RATE_REFILL_PER_MIN: '1000' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', d => { errOut += d; });
  await waitUp();
});

after(() => {
  try { child?.kill(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

// dir field first (mirrors captures' `source`), then the file part
const uploadFile = (dir, filename, content, type) => {
  const fd = new FormData();
  fd.append('dir', dir);
  fd.append('file', new Blob([content], type ? { type } : undefined), filename);
  return fetch(`${BASE}/api/files`, { method: 'POST', body: fd });
};

test('upload -> list -> serve -> delete roundtrip (bytes preserved)', async () => {
  const body = Buffer.from('hello proofpipe - any file type');
  const up = await uploadFile('pc', 'notes.txt', body, 'text/plain');
  assert.equal(up.status, 200);
  const row = await up.json();
  assert.ok(row.id > 0);
  assert.equal(row.name, 'notes.txt');
  assert.equal(row.dir, 'pc');
  assert.equal(row.bytes, body.length);
  assert.match(row.file, /^\d+-[a-z0-9]+\.txt$/);

  const list = await fetch(`${BASE}/api/files`).then(r => r.json());
  assert.ok(list.some(f => f.id === row.id));

  const get = await fetch(`${BASE}/file/${row.id}`);
  assert.equal(get.status, 200);
  // unknown/plain types are forced safe: octet-stream + attachment (stored-XSS)
  assert.equal(get.headers.get('content-type'), 'application/octet-stream');
  assert.match(get.headers.get('content-disposition'), /^attachment/);
  assert.equal(get.headers.get('accept-ranges'), 'bytes');
  assert.ok(Buffer.from(await get.arrayBuffer()).equals(body), 'file bytes stored byte-for-byte');

  const del = await fetch(`${BASE}/api/files/${row.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await fetch(`${BASE}/file/${row.id}`)).status, 404);
  assert.ok(!(await fetch(`${BASE}/api/files`).then(r => r.json())).some(f => f.id === row.id));
});

test('traversal + control-char filenames are sanitized, never stored raw', async () => {
  const up = await uploadFile('phone', '../../..\\evil.txt', Buffer.from('x'));
  assert.equal(up.status, 200);
  const row = await up.json();
  assert.equal(row.name, 'evil.txt');
  assert.ok(!row.name.includes('/') && !row.name.includes('\\') && !row.name.includes('..'));
  assert.match(row.file, /^\d+-[a-z0-9]+\.txt$/);
  assert.ok(!fs.readdirSync(path.join(dataDir, 'files')).some(f => f.includes('..')));
  await fetch(`${BASE}/api/files/${row.id}`, { method: 'DELETE' });
});

test('media + pdf serve inline with the right content type', async () => {
  const pdf = await (await uploadFile('pc', 'doc.pdf', Buffer.from('%PDF-1.4 fake'), 'application/pdf')).json();
  const pdfGet = await fetch(`${BASE}/file/${pdf.id}`);
  assert.equal(pdfGet.headers.get('content-type'), 'application/pdf');
  assert.match(pdfGet.headers.get('content-disposition'), /^inline/);

  const png = await (await uploadFile('pc', 'pic.png', Buffer.from('fakepng'), 'image/png')).json();
  const pngGet = await fetch(`${BASE}/file/${png.id}`);
  assert.equal(pngGet.headers.get('content-type'), 'image/png');
  assert.match(pngGet.headers.get('content-disposition'), /^inline/);

  await fetch(`${BASE}/api/files/${pdf.id}`, { method: 'DELETE' });
  await fetch(`${BASE}/api/files/${png.id}`, { method: 'DELETE' });
});

test('range requests: 206 partial, suffix range, 416 unsatisfiable', async () => {
  const body = Buffer.from('0123456789abcdef');
  const row = await (await uploadFile('pc', 'range.bin', body)).json();

  const part = await fetch(`${BASE}/file/${row.id}`, { headers: { Range: 'bytes=0-4' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-4/${body.length}`);
  assert.equal(await part.text(), '01234');

  const suffix = await fetch(`${BASE}/file/${row.id}`, { headers: { Range: 'bytes=-4' } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), 'cdef');

  const bad = await fetch(`${BASE}/file/${row.id}`, { headers: { Range: 'bytes=999-1000' } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('content-range'), `bytes */${body.length}`);

  // multi-range needs a multipart/byteranges body this server does not emit.
  // RFC 7233 lets a server ignore Range and answer 200 with the full body —
  // the old code 416'd a perfectly satisfiable request.
  const multi = await fetch(`${BASE}/file/${row.id}`, { headers: { Range: 'bytes=0-1,4-5' } });
  assert.equal(multi.status, 200);
  assert.equal(await multi.text(), '0123456789abcdef');

  await fetch(`${BASE}/api/files/${row.id}`, { method: 'DELETE' });
});

test('413 past the per-file cap (mid-stream abort, no partial kept)', async () => {
  const before = new Set(fs.readdirSync(path.join(dataDir, 'files')));
  const big = Buffer.alloc(2 * 1024 * 1024, 7); // cap is 1 MB via PP_MAX_FILE_MB
  const r = await uploadFile('pc', 'big.bin', big);
  assert.equal(r.status, 413);
  const after = fs.readdirSync(path.join(dataDir, 'files'));
  assert.ok(after.every(f => before.has(f)), `no partial file may remain: ${after}`);
});

test('missing file/dir-traversal id handling', async () => {
  assert.equal((await fetch(`${BASE}/file/999999`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/files/999999`, { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(`${BASE}/file/..%2Fserver.js`)).status, 404);
});

test('CSRF guard covers file endpoints, not just captures', async () => {
  const evil = { Origin: 'https://evil.example' };
  const up = await fetch(`${BASE}/api/files`, {
    method: 'POST', headers: evil, body: (() => {
      const fd = new FormData();
      fd.append('file', new Blob([Buffer.from('x')]), 'x.txt');
      return fd;
    })(),
  });
  assert.equal(up.status, 403);

  const row = await (await uploadFile('pc', 'csrf.txt', Buffer.from('x'))).json();
  const del = await fetch(`${BASE}/api/files/${row.id}`, { method: 'DELETE', headers: evil });
  assert.equal(del.status, 403);
  assert.equal((await fetch(`${BASE}/api/files/${row.id}`, { method: 'DELETE' })).status, 200);

  const inbox = await fetch(`${BASE}/api/files-inbox`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...evil }, body: JSON.stringify({ on: false }),
  });
  assert.equal(inbox.status, 403);
});

test('inbox auto-save: phone files land in data/inbox/ when ON, not when OFF', async () => {
  const inboxDir = path.join(dataDir, 'inbox');
  // fresh PP_DATA → default ON
  assert.equal((await fetch(`${BASE}/api/files-inbox`).then(r => r.json())).on, true);

  const r1 = await (await uploadFile('phone', 'report.pdf', Buffer.from('%PDF inbox'))).json();
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (fs.readdirSync(inboxDir).includes('report.pdf')) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(fs.readdirSync(inboxDir).includes('report.pdf'), 'phone file auto-saved to inbox');
  // the async copy may still hold the file open when the name appears — on
  // Windows a read in that window throws EBUSY (observed ~1 run in 4). Retry.
  let saved = null;
  for (let i = 0; i < 20; i++) {
    try { saved = fs.readFileSync(path.join(inboxDir, 'report.pdf')); break; }
    catch (e) { if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e; await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(saved && saved.equals(Buffer.from('%PDF inbox')));

  // PC-side files are already on the PC — never copied to inbox
  const nBefore = fs.readdirSync(inboxDir).length;
  await uploadFile('pc', 'local.txt', Buffer.from('local'));
  await new Promise(r => setTimeout(r, 500));
  assert.equal(fs.readdirSync(inboxDir).length, nBefore);

  // toggle OFF: phone files stay listed but are not copied
  assert.equal((await fetch(`${BASE}/api/files-inbox`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }),
  }).then(r => r.status)), 200);
  await uploadFile('phone', 'no-save.txt', Buffer.from('nope'));
  await new Promise(r => setTimeout(r, 500));
  assert.ok(!fs.readdirSync(inboxDir).includes('no-save.txt'));

  // bad toggle body rejected
  const badToggle = await fetch(`${BASE}/api/files-inbox`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: 'yes' }),
  });
  assert.equal(badToggle.status, 400);

  // restore ON for later runs
  await fetch(`${BASE}/api/files-inbox`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }),
  });
  await fetch(`${BASE}/api/files/${r1.id}`, { method: 'DELETE' });
});

test('pagination: ?limit honored + capped, ?before keyset works', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await (await uploadFile('pc', `p${i}.txt`, Buffer.from(`f${i}`))).json()).id);
  const page1 = await fetch(`${BASE}/api/files?limit=2`).then(r => r.json());
  assert.equal(page1.length, 2);
  assert.ok(page1[0].id > page1[1].id, 'newest first');
  const page2 = await fetch(`${BASE}/api/files?before=${page1[1].id}`).then(r => r.json());
  assert.ok(page2.every(f => f.id < page1[1].id), 'keyset page holds older items');
  assert.ok(page2.some(f => ids.includes(f.id)));
  const capped = await fetch(`${BASE}/api/files?limit=9999`).then(r => r.json());
  assert.ok(capped.length <= 200);
  for (const id of ids) await fetch(`${BASE}/api/files/${id}`, { method: 'DELETE' });
});

test('files version endpoint tracks count and latest', async () => {
  const v1 = await fetch(`${BASE}/api/files/version`).then(r => r.json());
  const row = await (await uploadFile('pc', 'v.txt', Buffer.from('v'))).json();
  const v2 = await fetch(`${BASE}/api/files/version`).then(r => r.json());
  assert.equal(v2.n, v1.n + 1);
  assert.equal(v2.latest, row.id);
  await fetch(`${BASE}/api/files/${row.id}`, { method: 'DELETE' });
  const v3 = await fetch(`${BASE}/api/files/version`).then(r => r.json());
  assert.equal(v3.n, v1.n);
});

test('stats tracks file bytes separately from capture bytes', async () => {
  const s0 = await fetch(`${BASE}/api/stats`).then(r => r.json());
  const row = await (await uploadFile('pc', 's.txt', Buffer.from('12345'))).json();
  const s1 = await fetch(`${BASE}/api/stats`).then(r => r.json());
  assert.equal(s1.files.count, s0.files.count + 1);
  assert.equal(s1.files.bytes, s0.files.bytes + 5);
  assert.equal(s1.bytes, s0.bytes, 'capture bytes untouched by file upload');
  await fetch(`${BASE}/api/files/${row.id}`, { method: 'DELETE' });
  const s2 = await fetch(`${BASE}/api/stats`).then(r => r.json());
  assert.equal(s2.files.bytes, s0.files.bytes);
});

test('bulk delete: {ids} removes exactly those rows and reports counts', async () => {
  const a = await (await uploadFile('pc', 'bulk-a.txt', Buffer.from('a'))).json();
  const b = await (await uploadFile('pc', 'bulk-b.txt', Buffer.from('b'))).json();
  const c = await (await uploadFile('pc', 'bulk-c.txt', Buffer.from('c'))).json();
  const r = await fetch(`${BASE}/api/files`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [a.id, b.id] }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, deleted: 2, failed: 0 });
  const left = await fetch(`${BASE}/api/files`).then(res => res.json());
  assert.ok(!left.some(f => f.id === a.id || f.id === b.id), 'the listed ids are gone');
  assert.ok(left.some(f => f.id === c.id), 'an unlisted row survives');
  assert.equal((await fetch(`${BASE}/file/${a.id}`)).status, 404, 'bytes removed with the row');
  await fetch(`${BASE}/api/files/${c.id}`, { method: 'DELETE' });
});

test('bulk delete: {ids} tolerates unknown, duplicate and junk ids', async () => {
  const a = await (await uploadFile('pc', 'bulk-dup.txt', Buffer.from('x'))).json();
  const r = await fetch(`${BASE}/api/files`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [a.id, a.id, 999999, 0, 'nope'] }),
  });
  assert.equal(r.status, 200);
  // deduped, and a row that is already gone is not a failure — the caller asked
  // for a SET, not for a promise that every id existed
  assert.deepEqual(await r.json(), { ok: true, deleted: 1, failed: 0 });
});

test('bulk delete: a bodyless call removes every file', async () => {
  const beforeList = await fetch(`${BASE}/api/files`).then(res => res.json());
  const r1 = await (await uploadFile('pc', 'wipe-1.txt', Buffer.from('1'))).json();
  const r2 = await (await uploadFile('phone', 'wipe-2.txt', Buffer.from('2'))).json();
  const r = await fetch(`${BASE}/api/files`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  const body = await r.json();
  // `deleted` counts the rows the transaction actually took, not the request's
  // optimistic guess (+ the two uploaded above)
  assert.deepEqual(body, { ok: true, deleted: beforeList.length + 2, failed: 0 });
  assert.deepEqual(await fetch(`${BASE}/api/files`).then(res => res.json()), []);
  assert.equal((await fetch(`${BASE}/file/${r1.id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/file/${r2.id}`)).status, 404);
});

test('bulk delete: a non-array ids body is refused, and the CSRF guard covers it', async () => {
  const bad = await fetch(`${BASE}/api/files`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: 'all' }),
  });
  assert.equal(bad.status, 400);
  const evil = await fetch(`${BASE}/api/files`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ ids: [1] }),
  });
  assert.equal(evil.status, 403);
});

test('bulk delete: ONE coalesced file-deleted frame carrying the ids', async () => {
  const a = await (await uploadFile('pc', 'sse-bulk-a.txt', Buffer.from('a'))).json();
  const b = await (await uploadFile('pc', 'sse-bulk-b.txt', Buffer.from('b'))).json();
  const res = await fetch(`${BASE}/events`);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let buf = '';
  const next = async (ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString();
      const i = buf.indexOf('\n\n');
      if (i < 0) continue;
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const m = frame.match(/^data: (.*)$/m);
      if (m) return JSON.parse(m[1]); // a comment/heartbeat frame is skipped
    }
    throw new Error('timed out waiting for an SSE frame');
  };
  try {
    // SSE has no replay: the stream must be OPEN before the delete is issued, or
    // the frame we are asserting on was broadcast to nobody
    await new Promise(r => setTimeout(r, 250));
    const r = await fetch(`${BASE}/api/files`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [a.id, b.id] }),
    });
    assert.equal((await r.json()).deleted, 2);
    const frame = await next();
    assert.equal(frame.type, 'file-deleted');
    assert.deepEqual([...frame.ids].sort((x, y) => x - y), [a.id, b.id].sort((x, y) => x - y));
    // and exactly ONE frame for the pair: a 200-row wipe must not spray 200
    // 'file-deleted' events at every client
    await assert.rejects(next(1200), /timed out/, 'no second frame for the same batch');
  } finally {
    try { await reader.cancel(); } catch {}
  }
});

test('SSE pushes file + file-deleted in the shape both UIs consume (m.row)', async () => {
  const res = await fetch(`${BASE}/events`);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const readData = async () => {
    let buf = '';
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString();
      const m = buf.match(/^data: (.*)$/m);
      if (m) return JSON.parse(m[1]);
    }
    throw new Error('timed out waiting for SSE data frame');
  };
  try {
    const row = await (await uploadFile('phone', 'sse.txt', Buffer.from('sse'))).json();
    const created = await readData();
    assert.equal(created.type, 'file');
    assert.equal(created.row.id, row.id);
    assert.equal(created.row.name, 'sse.txt');
    await fetch(`${BASE}/api/files/${row.id}`, { method: 'DELETE' });
    const deleted = await readData();
    assert.equal(deleted.type, 'file-deleted');
    assert.equal(deleted.id, row.id);
  } finally {
    try { await reader.cancel(); } catch {}
  }
});
