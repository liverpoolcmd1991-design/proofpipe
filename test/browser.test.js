import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPort } from './port-ranges.js';
import { resolveAutoTarget } from '../server/browser.js';

// Launcher-browser choice: /api/browsers detection + persistence. Isolated
// server with its own PP_DATA scratch dir, mirroring the other module tests.
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = pickPort('browser'); // disjoint range — test/port-ranges.js
const BASE = `http://127.0.0.1:${PORT}`;

// 1x1 red PNG (same fixture as regression.test.js)
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpipe-browser-'));
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

const postBrowser = (id, origin) => fetch(`${BASE}/api/browsers`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
  body: JSON.stringify({ id }),
});

test('GET /api/browsers returns detected browsers + the current pick (default first boot)', async () => {
  const r = await fetch(`${BASE}/api/browsers`);
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.ok(Array.isArray(s.browsers), 'browsers is a list');
  assert.equal(s.current, 'default');
  // every detected entry must have the shape the settings dropdown needs —
  // and must actually exist on disk (no phantom options)
  for (const b of s.browsers) {
    assert.ok(b.id && typeof b.id === 'string');
    assert.ok(b.name && typeof b.name === 'string');
    assert.ok(b.path && typeof b.path === 'string');
    assert.ok(fs.existsSync(b.path), `detected browser path exists: ${b.path}`);
  }
});

test('GET /api/settings returns the complete client settings bundle', async () => {
  const r = await fetch(`${BASE}/api/settings`);
  assert.equal(r.status, 200);
  const s = await r.json();
  for (const key of ['autoPaste', 'autoCleanup', 'filesInbox', 'quality', 'storageCap', 'retention', 'inboxDir', 'mediaDir', 'browser']) {
    assert.ok(Object.hasOwn(s, key), `${key} is present`);
  }
  assert.equal(typeof s.autoPaste.auto, 'boolean');
  assert.equal(typeof s.autoCleanup.on, 'boolean');
  assert.equal(typeof s.quality.level, 'number');
  assert.equal(typeof s.browser, 'string');
});

test('POST /api/browsers persists a known pick, rejects unknown ids and cross-site', async () => {
  // unknown id → 400
  assert.equal((await postBrowser('not-a-real-browser')).status, 400);
  // cross-site → 403 (same mutation gate as every other setting)
  assert.equal((await postBrowser('default', 'https://evil.example')).status, 403);

  const list = (await fetch(`${BASE}/api/browsers`).then(r => r.json())).browsers;
  if (list.length) {
    // a real detected browser can be chosen, is persisted in settings.json…
    const r = await postBrowser(list[0].id);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).browser, list[0].id);
    assert.equal((await fetch(`${BASE}/api/browsers`).then(x => x.json())).current, list[0].id);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).browser, list[0].id);
  } else {
    // nothing detected (e.g. non-Windows CI) — 'default' is the only valid pick
    assert.equal((await postBrowser('default')).status, 200);
  }

  // back to the default: always valid, always persisted
  const back = await postBrowser('default');
  assert.equal(back.status, 200);
  assert.equal((await fetch(`${BASE}/api/browsers`).then(x => x.json())).current, 'default');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).browser, 'default');
});

test('browser pick is live-broadcast over SSE (auto-paste tag source stays in sync)', async () => {
  // saveSettings() notifies 'settings' with the full object — the autoTarget
  // stamped onto capture events reads the same live settings.browser, so a
  // pick change must reach every SSE client without a restart.
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
    const listener = collect(2000);
    await new Promise(r => setTimeout(r, 100));
    const r = await postBrowser('default'); // always valid on every platform
    assert.equal(r.status, 200);
    const buf = await listener;
    const settingsEv = [...buf.matchAll(/^data: (.*)$/gm)]
      .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
      .filter(Boolean)
      .find(e => e.type === 'settings');
    assert.ok(settingsEv, 'changing the browser pick must broadcast an SSE settings event');
    assert.equal(settingsEv.browser, 'default', 'broadcast carries the live browser pick autoTarget reads');
  } finally {
    try { await reader.cancel(); } catch {}
  }
});

// ---------- autoTarget fallback (the "picked browser isn't here" footgun) ----------
test('resolveAutoTarget: a trackable pick falls back to default only when absent', () => {
  const none = () => false;
  assert.equal(resolveAutoTarget('default', none), 'default');
  assert.equal(resolveAutoTarget('', none), 'default', 'empty pick → default');
  assert.equal(resolveAutoTarget(undefined, none), 'default', 'missing pick → default');
  assert.equal(resolveAutoTarget('chrome', none), 'default', 'Chrome picked but absent → paste anywhere');
  assert.equal(resolveAutoTarget('chrome', () => true), 'chrome', 'Chrome present → Chrome only');
  assert.equal(resolveAutoTarget('edge', id => id === 'edge'), 'edge', 'Edge present → Edge only');
  assert.equal(resolveAutoTarget('edge', id => id === 'chrome'), 'default', 'Edge picked but only Chrome here → default');
  assert.equal(resolveAutoTarget('EDGE', () => true), 'edge', 'case-insensitive');
  // non-trackable picks pass through untouched (Chromium ids are mapped to the
  // chrome instance by the client gate; Firefox pastes nowhere by design)
  assert.equal(resolveAutoTarget('brave', none), 'brave');
  assert.equal(resolveAutoTarget('firefox', none), 'firefox');
});

test('autoTarget falls back to default when the picked browser has no live extension (SSE presence)', async () => {
  // Needs a trackable pick (chrome/edge) this host actually detects so the POST
  // is accepted; hosts without either skip (the pure test above still covers it).
  const ids = (await fetch(`${BASE}/api/browsers`).then(r => r.json())).browsers.map(b => b.id);
  const pick = ids.find(id => id === 'chrome' || id === 'edge');
  if (!pick) return;
  await postBrowser(pick);

  const upload = async () => {
    const fd = new FormData();
    fd.append('source', 'phone');
    fd.append('auto', '1');
    fd.append('photo', new Blob([PNG], { type: 'image/png' }), 't.png');
    assert.equal((await fetch(`${BASE}/upload`, { method: 'POST', body: fd })).status, 200);
  };
  // connect a listener (optionally identifying as `browserId`), fire an auto
  // upload, and return the autoTarget stamped onto its capture-ready event.
  const autoTargetFrom = async query => {
    const res = await fetch(`${BASE}/events${query}`);
    const reader = res.body.getReader();
    let buf = '';
    const end = Date.now() + 2000;
    const reading = (async () => {
      while (Date.now() < end) {
        const t = Math.max(1, end - Date.now());
        const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ done: true }), t))]);
        if (done) break;
        buf += Buffer.from(value).toString();
      }
    })();
    await new Promise(r => setTimeout(r, 100)); // let the server register the client
    await upload();
    await reading;
    try { await reader.cancel(); } catch {}
    const events = [...buf.matchAll(/^data: (.*)$/gm)].map(m => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
    const ready = events.find(e => e.type === 'capture-ready');
    assert.ok(ready, 'auto upload must fire capture-ready');
    return ready.autoTarget;
  };

  // listener claims NO browser → the pick is "absent" → default (paste anywhere)
  assert.equal(await autoTargetFrom(''), 'default', 'absent pick must fall back to default');
  // listener identifies as the pick → presence keeps the exact disambiguation tag
  assert.equal(await autoTargetFrom(`?browser=${pick}`), pick, 'connected pick must keep its exact tag');

  await postBrowser('default'); // restore for any later test
});