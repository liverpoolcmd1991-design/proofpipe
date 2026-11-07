// Extension manifest <-> code contract.
// A permission that is used but not declared is INVISIBLE: the API is
// `undefined`, the call is swallowed by a try/catch, and the feature just
// silently does nothing on real installs while every unit test stays green.
// That exact bug shipped (chrome.alarms used in background.js while "alarms"
// was missing from manifest.json — the relay watchdog never ran). This test
// derives the required permissions FROM the code so the two can't drift again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(APP, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

// chrome.* namespaces that REQUIRE a manifest permission. Namespaces absent
// from this map (action, runtime, windows, i18n, …) need no declaration.
const REQUIRED_PERMISSION = {
  alarms: 'alarms',
  offscreen: 'offscreen',
  contextMenus: 'contextMenus',
  scripting: 'scripting',
  tabs: 'tabs',
  storage: 'storage',
};

const jsFiles = fs.readdirSync(EXT).filter(f => f.endsWith('.js'));

test('every chrome.* namespace used in extension JS has its manifest permission', () => {
  const declared = new Set(manifest.permissions || []);
  const missing = new Map(); // permission -> [files]
  for (const file of jsFiles) {
    const src = fs.readFileSync(path.join(EXT, file), 'utf8');
    for (const m of src.matchAll(/\bchrome\.([A-Za-z_$][\w$]*)/g)) {
      const perm = REQUIRED_PERMISSION[m[1]];
      if (!perm || declared.has(perm)) continue;
      if (!missing.has(perm)) missing.set(perm, []);
      const list = missing.get(perm);
      if (!list.includes(file)) list.push(file);
    }
  }
  assert.equal(
    missing.size, 0,
    [...missing.entries()].map(([p, files]) => `"${p}" used in ${files.join(', ')} but not declared`).join('; ')
      || 'all used permissions declared'
  );
});

test('manifest declares the expected baseline permissions', () => {
  const declared = new Set(manifest.permissions || []);
  // pinned explicitly so a careless edit that DROPS one is caught even when no
  // file happens to reference it at the moment (the alarms regression class)
  for (const p of ['alarms', 'contextMenus', 'scripting', 'offscreen', 'tabs', 'storage']) {
    assert.ok(declared.has(p), `manifest must declare "${p}"`);
  }
});

test('manifest carries a key so the extension id is stable and pinnable', () => {
  // The server gates mutations to exactly ONE extension origin, deriving the id
  // from this key (see csrfSafe in server.js). Without the key the id would
  // change on every unpacked reload, so the pin could never hold.
  assert.ok(typeof manifest.key === 'string' && manifest.key.length > 0, 'manifest.key is required for a stable id');
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const id = hex.replace(/[0-9a-f]/g, c => 'abcdefghijklmnop'[parseInt(c, 16)]);
  assert.match(id, /^[a-p]{32}$/, `derived extension id must be 32 a-p chars, got ${id}`);
});

test('host_permissions cover the loopback server (http + https)', () => {
  const hosts = manifest.host_permissions || [];
  for (const origin of ['http://localhost/*', 'http://127.0.0.1/*', 'https://localhost/*', 'https://127.0.0.1/*']) {
    assert.ok(hosts.includes(origin), `host_permissions must include ${origin}`);
  }
});

test('every icon path declared in the manifest exists in extension/', () => {
  const icons = manifest.icons || {};
  assert.ok(Object.keys(icons).length > 0, 'manifest must declare at least one icon');
  for (const [size, file] of Object.entries(icons)) {
    assert.ok(fs.existsSync(path.join(EXT, file)), `icon ${size} (${file}) must exist`);
  }
});

test('manifest content scripts load the shared modules before their consumers', () => {
  // PITFALLS #35: an extracted module must be wired into every loader chain
  // that references it. content.js consumes PPDiscovery + PPPasteLogic + PPFiles
  // + toPng.
  const scripts = (manifest.content_scripts || []).flatMap(cs => cs.js || []);
  const order = name => scripts.indexOf(name);
  for (const [consumer, deps] of [
    ['content.js', ['toPng.js', 'discovery.js', 'paste-logic.js', 'files.js']],
  ]) {
    assert.ok(order(consumer) !== -1, `${consumer} must be a content script`);
    for (const dep of deps) {
      assert.ok(order(dep) !== -1 && order(dep) < order(consumer), `${dep} must load before ${consumer}`);
    }
  }
});
