import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPort } from './port-ranges.js';

// Rate limiting needs a dedicated server instance: the token bucket is
// per-process and shared with other tests otherwise.
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// a fixed port would collide with unrelated apps that happen to hold it
// (e.g. a VPN core); draw within ratelimit's range (test/port-ranges.js)
const PORT = pickPort('ratelimit');
const BASE = `http://127.0.0.1:${PORT}`;

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpipe-rate-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: APP,
    env: { ...process.env, PORT: String(PORT), PP_DATA: dataDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', d => { errOut += d; });
  await waitUp();
});

after(() => {
  try { child?.kill(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

test('upload rate limit: burst beyond capacity gets 429', async () => {
  // The bucket's defaults deliberately allow a LARGE gallery multi-select (a
  // 97-photo pick is one user, not a flood), so the burst size is derived from
  // the shipped capacity rather than hardcoded — a future capacity change must
  // not silently turn this into a test of nothing.
  const capacity = Number(process.env.PP_RATE_CAPACITY) || 120;
  const burst = capacity + 10;
  const results = [];
  for (let i = 0; i < burst; i++) {
    const fd = new FormData();
    fd.append('photo', new Blob([PNG], { type: 'image/png' }), 't.png');
    results.push((await fetch(`${BASE}/upload`, { method: 'POST', body: fd })).status);
  }
  // the first `capacity` requests pass (bounded by the refill that accrues while
  // they run — so assert the first capacity-5, never exactly `capacity`)
  assert.ok(results.slice(0, Math.max(1, capacity - 5)).every(s => s === 200),
    `the burst up to capacity should pass: ${results}`);
  assert.ok(results.some(s => s === 429), `burst beyond capacity should 429: ${results}`);
});

test('upload rate limit: a 97-photo pick is not throttled', async () => {
  // The reported bug: a 97-capture multi-select produced a run of 200s then a
  // wall of 429s, and the rejected photos were lost.
  //
  // This runs against its OWN server deliberately: the suite shares one
  // instance, and the burst test above deliberately drains the bucket. A fresh
  // process has a full bucket, which is exactly the state a user's pick starts
  // from — so this asserts the FIX, not the residue of the previous test.
  const P2 = pickPort('ratelimit');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpipe-rate97-'));
  const kid = spawn(process.execPath, ['server.js'], {
    cwd: APP,
    env: { ...process.env, PORT: String(P2), PP_DATA: dir2 },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    // wait for it to answer
    for (let i = 0; i < 75; i++) {
      try { if ((await fetch(`http://127.0.0.1:${P2}/api/version`)).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    const results = [];
    for (let i = 0; i < 97; i++) {
      const fd = new FormData();
      fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'pick.png');
      results.push((await fetch(`http://127.0.0.1:${P2}/upload`, { method: 'POST', body: fd })).status);
    }
    const throttled = results.filter(s => s === 429).length;
    assert.equal(throttled, 0, `a 97-photo pick must not be throttled (got ${throttled} 429s)`);
    assert.ok(results.slice(0, 90).every(s => s === 200), `the pick must be stored: ${results.slice(0, 90)}`);
  } finally {
    try { kid.kill(); } catch {}
    try { fs.rmSync(dir2, { recursive: true, force: true }); } catch {}
  }
});