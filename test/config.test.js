// Threadpool configuration contract (see the comment block atop server.js):
// UV_THREADPOOL_SIZE is read ONCE at libuv pool init — which happens when the
// first native module (better-sqlite3 / sharp) loads. `npm start` preloads
// scripts/threadpool.cjs via --require for exactly this reason, and server.js
// imports those two packages DYNAMICALLY after setting the env var.
//
// Nothing here can observe the live pool size from outside the process, so
// these tests pin the CONTRACT: if any piece below drifts, the pool silently
// falls back to 4 threads and parallel uploads queue behind each other —
// the exact failure this whole dance exists to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPort } from './port-ranges.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const THREADPOOL_CJS = fs.readFileSync(path.join(APP, 'scripts', 'threadpool.cjs'), 'utf8');
const SERVER_JS = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
const BAT = fs.readFileSync(path.join(APP, 'ProofPipe.bat'), 'utf8');

// End-to-end: boot the server through the REAL npm-start command shape (same
// argv, including the --require preload) on a scratch data dir + port. A
// server that crashed on boot would exit immediately, so "listens" proves
// the preloaded path still works. This catches the sneakiest regression:
// someone edits the start script or the preload and nothing notices.
test('npm start command shape boots (preload wired before server.js)', async () => {
  const PORT = pickPort('config'); // disjoint range — test/port-ranges.js
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpipe-tp-'));
  const child = spawn(process.execPath, ['--require', './scripts/threadpool.cjs', 'server.js'], {
    cwd: APP,
    env: { ...process.env, PORT: String(PORT), PP_DATA: dataDir },
    stdio: 'ignore',
  });
  let up = false;
  // 30s (not 15s): the full parallel suite spawns ~8 servers at once and a
  // cold sharp load under that contention once blew the 15s budget — a boot
  // that lands at 16s is healthy, not failed (PITFALLS #14 flake class).
  const end = Date.now() + 30000;
  while (Date.now() < end && !up) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/version`);
      if (r.ok) up = true;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  assert.ok(up, 'server booted through the preloaded threadpool path');
});

test('package.json start script preloads scripts/threadpool.cjs', () => {
  assert.match(PKG.scripts.start, /--require\s+\.\/scripts\/threadpool\.cjs/, 'npm start must preload the threadpool setter');
});

test('scripts/threadpool.cjs sets UV_THREADPOOL_SIZE=16 by default', () => {
  assert.match(THREADPOOL_CJS, /UV_THREADPOOL_SIZE/, 'preload must target the env var');
  assert.match(THREADPOOL_CJS, /['"]16['"]/, 'and the documented value 16');
});

test('ProofPipe.bat exports UV_THREADPOOL_SIZE before node runs', () => {
  assert.match(BAT, /set UV_THREADPOOL_SIZE=16/i, 'the .bat must export the env var');
  const setLine = BAT.indexOf('UV_THREADPOOL_SIZE');
  const nodeLine = BAT.indexOf('node server.js');
  assert.ok(setLine !== -1 && nodeLine !== -1 && setLine < nodeLine, 'export must precede the node launch');
});

test('server.js does not statically import better-sqlite3 or sharp', () => {
  // static ESM imports hoist ABOVE the env-var assignment and freeze the pool
  // at 4 — the exact bug the dynamic imports exist to avoid.
  assert.doesNotMatch(SERVER_JS, /^import\s+(Database|sharp)\b/m);
  assert.match(SERVER_JS, /await import\(['"]better-sqlite3['"]\)/, 'better-sqlite3 must be imported dynamically');
  assert.match(SERVER_JS, /await import\(['"]sharp['"]\)/, 'sharp must be imported dynamically');
  // the env var must be assigned before those dynamic imports in file order
  const envPos = SERVER_JS.indexOf('UV_THREADPOOL_SIZE');
  const dbPos = SERVER_JS.indexOf("await import('better-sqlite3')");
  assert.ok(envPos !== -1 && dbPos !== -1 && envPos < dbPos, 'env var must be assigned before the dynamic native imports');
});
