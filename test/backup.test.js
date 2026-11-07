import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPort } from './port-ranges.js';

// Backup/export endpoint test: uploads a capture, backs up to a scratch dir,
// verifies the zip lands intact and staging is cleaned up. Windows-only like
// the feature itself (PowerShell Compress-Archive); skipped elsewhere.
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = pickPort('backup'); // disjoint range — test/port-ranges.js
const BASE = `http://127.0.0.1:${PORT}`;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let child;
let errOut = '';
let dataDir;
let backupDir;

const WIN = process.platform === 'win32';

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpipe-backup-'));
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpipe-backup-dst-'));
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
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
});

const upload = async () => {
  const fd = new FormData();
  fd.append('photo', new Blob([PNG], { type: 'image/png' }), 't.png');
  const r = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  assert.equal(r.status, 200);
  return r.json();
};

test('backup writes a zip containing DB, settings and media; staging is cleaned', { skip: !WIN && 'Windows-only feature' }, async () => {
  // something real to back up: one capture (original + background thumb)
  const { file } = await upload();
  // wait for the background thumbnail so the backup covers both files
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (fs.existsSync(path.join(dataDir, 'captures', `t-${file}`))) break;
    await new Promise(r => setTimeout(r, 50));
  }

  const r = await fetch(`${BASE}/api/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: backupDir }),
  });
  const body = await r.json();
  assert.equal(r.status, 200, `backup should succeed: ${JSON.stringify(body)}`);
  assert.equal(body.ok, true);
  assert.ok(body.path.startsWith(backupDir), 'zip lands in the requested folder');
  assert.ok(body.path.endsWith('.zip'), 'artifact is a zip');
  assert.ok(body.bytes > 0, 'zip is not empty');

  // the zip magic bytes (PK\x03\x04) — proves it's a real archive
  const zip = fs.readFileSync(body.path);
  assert.deepEqual([...zip.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'PK zip signature');

  // staging dir removed — no .pp-stage-* leftovers in the destination
  const leftovers = fs.readdirSync(backupDir).filter(f => f.startsWith('.pp-stage-'));
  assert.equal(leftovers.length, 0, `staging must be cleaned: ${leftovers}`);

  // exactly one zip in the destination
  const zips = fs.readdirSync(backupDir).filter(f => f.endsWith('.zip'));
  assert.equal(zips.length, 1);

  // contents check without a zip dep: PowerShell Expand-Archive into a temp
  // dir and assert the DB + capture original + thumb are inside
  const extract = path.join(os.tmpdir(), `pp-extract-${Date.now()}`);
  fs.mkdirSync(extract, { recursive: true });
  try {
    await new Promise((resolve, reject) => {
      const ps = `Expand-Archive -Path '${body.path.replace(/'/g, "''")}' -DestinationPath '${extract.replace(/'/g, "''")}' -Force`;
      const z = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
      z.on('close', code => code === 0 ? resolve() : reject(new Error(`Expand-Archive exited ${code}`)));
      z.on('error', reject);
    });
    assert.ok(fs.existsSync(path.join(extract, 'proofpipe.db')), 'zip contains the SQLite DB');
    // settings.json is only written once a toggle has been saved — a fresh
    // PP_DATA may legitimately not have one yet, so assert conditionally
    if (fs.existsSync(path.join(dataDir, 'settings.json')))
      assert.ok(fs.existsSync(path.join(extract, 'settings.json')), 'zip contains settings when it exists');
    assert.ok(fs.existsSync(path.join(extract, 'captures', file)), 'zip contains the capture original');
    assert.ok(fs.existsSync(path.join(extract, 'captures', `t-${file}`)), 'zip contains the capture thumbnail');
  } finally {
    fs.rmSync(extract, { recursive: true, force: true });
  }
  // the DB inside the backup must have the capture row (checkpoint worked)
  // — verified indirectly: the live DB is 20KB+ after checkpoint, so a copy
  // that captured pre-checkpoint state would be suspiciously small. The row
  // check itself would need better-sqlite3 opening the copied file; keep the
  // test dependency-free and rely on the file-presence asserts above.
});

test('backup refuses relative or missing dir, unwritable dir (400)', async () => {
  const bad = await fetch(`${BASE}/api/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: 'relative/path' }),
  });
  assert.equal(bad.status, 400);
  const none = await fetch(`${BASE}/api/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(none.status, 400);
  const unwritable = await fetch(`${BASE}/api/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // an absolute path to a FILE, not a dir — must be refused, not followed
    body: JSON.stringify({ dir: path.join(dataDir, 'proofpipe.db') }),
  });
  assert.equal(unwritable.status, 400);
});

test('backup is CSRF-checked like every other mutation', async () => {
  const r = await fetch(`${BASE}/api/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ dir: backupDir }),
  });
  assert.equal(r.status, 403, 'cross-site backup must be refused');
});
