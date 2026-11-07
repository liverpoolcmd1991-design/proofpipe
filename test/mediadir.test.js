import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPort } from './port-ranges.js';

// Media-folder relocation: isolated server with its own PP_DATA scratch dir.
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = pickPort('mediadir');
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpipe-mediadir-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: APP,
    env: {
      ...process.env, PORT: String(PORT), PP_DATA: dataDir,
      PP_RATE_CAPACITY: '1000', PP_RATE_REFILL_PER_MIN: '1000',
      PP_FILE_RATE_CAPACITY: '1000', PP_FILE_RATE_REFILL_PER_MIN: '1000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', d => { errOut += d; });
  await waitUp();
});

after(() => {
  try { child?.kill(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

const postDir = (p, origin) => fetch(`${BASE}/api/media-dir`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
  body: JSON.stringify({ path: p }),
});

test('media-dir defaults to PP_DATA and is exposed via stats', async () => {
  const d = await fetch(`${BASE}/api/media-dir`).then(r => r.json());
  assert.equal(path.resolve(d.path), path.resolve(dataDir));
  assert.equal(path.resolve(d.def), path.resolve(dataDir));
  const s = await fetch(`${BASE}/api/stats`).then(r => r.json());
  assert.equal(path.resolve(s.mediaDir), path.resolve(dataDir));
});

test('media-dir validation: relative, nested and cross-site rejected; same-path is a no-op', async () => {
  assert.equal((await postDir('relative/path')).status, 400);
  assert.equal((await postDir('')).status, 400);
  assert.equal((await postDir(dataDir, 'https://evil.example')).status, 403);
  // nesting either way must fail (moving a folder into itself)
  assert.equal((await postDir(path.join(dataDir, 'captures', 'deep'))).status, 400);
  const noop = await postDir(dataDir);
  assert.equal(noop.status, 200);
  assert.equal(path.resolve((await noop.json()).path), path.resolve(dataDir));
});

test('relocation moves captures + files live; serving follows', async () => {
  const capFd = new FormData();
  capFd.append('photo', new Blob([PNG], { type: 'image/png' }), 't.png');
  const cap = await fetch(`${BASE}/upload`, { method: 'POST', body: capFd }).then(r => r.json());
  const fileFd = new FormData();
  fileFd.append('dir', 'pc');
  fileFd.append('file', new Blob([Buffer.from('relocate me')]), 'move.txt');
  const file = await fetch(`${BASE}/api/files`, { method: 'POST', body: fileFd }).then(r => r.json());

  const vault = path.join(dataDir, 'vault');
  const r = await postDir(vault);
  assert.equal(r.status, 200);
  assert.equal(path.resolve((await r.json()).path), path.resolve(vault));

  // entries physically moved, old dirs left empty
  assert.ok(fs.existsSync(path.join(vault, 'captures', cap.file)));
  assert.ok(fs.existsSync(path.join(vault, 'files', file.file)));
  // the server removes the old dirs once emptied (rmdir after the move) —
  // ENOENT there means everything moved, which is what this asserts
  const dirEmptyOrGone = p => { try { return fs.readdirSync(p).length === 0; } catch (e) { return e.code === 'ENOENT'; } };
  assert.ok(dirEmptyOrGone(path.join(dataDir, 'captures')), 'old captures dir empty or removed');
  assert.ok(dirEmptyOrGone(path.join(dataDir, 'files')), 'old files dir empty or removed');
  // DB untouched (same rows), setting persisted
  assert.ok((await fetch(`${BASE}/api/captures`).then(x => x.json())).some(c => c.id === cap.id));
  assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).mediaDir);
  assert.equal(path.resolve((await fetch(`${BASE}/api/media-dir`).then(x => x.json())).path), path.resolve(vault));

  // serving follows the move: original, thumbnail, transfer file
  const orig = await fetch(`${BASE}/media/${cap.file}`);
  assert.equal(orig.status, 200);
  assert.ok(Buffer.from(await orig.arrayBuffer()).equals(PNG));
  const end = Date.now() + 5000;
  let thumb = null;
  while (Date.now() < end) {
    const t = await fetch(`${BASE}/media/t-${cap.file}`);
    if (t.ok) { thumb = t; break; }
    await new Promise(x => setTimeout(x, 100));
  }
  assert.ok(thumb, 'thumbnail served from the relocated dir');
  const got = await fetch(`${BASE}/file/${file.id}`);
  assert.equal(got.status, 200);
  assert.equal(await got.text(), 'relocate me');

  // and back again (repeat relocation works)
  assert.equal((await postDir(dataDir)).status, 200);
  assert.ok(fs.existsSync(path.join(dataDir, 'captures', cap.file)));
  assert.equal((await fetch(`${BASE}/media/${cap.file}`)).status, 200);
});
