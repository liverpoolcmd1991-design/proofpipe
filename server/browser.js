// server/browser.js — launcher browser choice + harness opener, extracted from
// the .bat launcher into the server so the pick lives in the settings (the
// .bat can't read settings.json) and the tab opens only once the server is
// actually listening — killing the old "wait 2s then open" race that could
// land on a dead page, and honoring a custom PORT.
//
// Detection is Windows-only and browser-agnostic: a curated list of known
// install paths first (instant, no subprocess), then the Windows "App Paths"
// registry keys — ANY browser that registered there resolves even at a custom
// location, so browsers not in the list below still show up. "Default
// browser" (the built-in choice) falls back to `start`, which opens the user's
// OS default — fully agnostic by construction.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PF = () => process.env['ProgramFiles'] || '';
const PF86 = () => process.env['ProgramFiles(x86)'] || '';
const LOCAL = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

// id = the persisted settings.browser value; exe = the App Paths key name
// (registry lookup keyed on it); paths() = standard install locations,
// machine-wide + per-user, checked with existsSync before any subprocess.
const CANDIDATES = [
  { id: 'chrome', name: 'Google Chrome', exe: 'chrome.exe', paths: () => [
    path.join(PF(), 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(PF86(), 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(LOCAL(), 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]},
  { id: 'edge', name: 'Microsoft Edge', exe: 'msedge.exe', paths: () => [
    path.join(PF86(), 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(PF(), 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]},
  { id: 'firefox', name: 'Mozilla Firefox', exe: 'firefox.exe', paths: () => [
    path.join(PF(), 'Mozilla Firefox', 'firefox.exe'),
    path.join(PF86(), 'Mozilla Firefox', 'firefox.exe'),
    path.join(LOCAL(), 'Mozilla Firefox', 'firefox.exe'),
  ]},
  { id: 'brave', name: 'Brave', exe: 'brave.exe', paths: () => [
    path.join(PF(), 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(PF86(), 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(LOCAL(), 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ]},
  { id: 'opera', name: 'Opera', exe: 'opera.exe', paths: () => [
    path.join(PF(), 'Opera', 'opera.exe'),
    path.join(PF86(), 'Opera', 'opera.exe'),
    path.join(LOCAL(), 'Programs', 'Opera', 'opera.exe'),
  ]},
  { id: 'vivaldi', name: 'Vivaldi', exe: 'vivaldi.exe', paths: () => [
    path.join(PF(), 'Vivaldi', 'Application', 'vivaldi.exe'),
    path.join(PF86(), 'Vivaldi', 'Application', 'vivaldi.exe'),
    path.join(LOCAL(), 'Vivaldi', 'Application', 'vivaldi.exe'),
  ]},
  { id: 'chromium', name: 'Chromium', exe: 'chromium.exe', paths: () => [
    path.join(LOCAL(), 'Chromium', 'Application', 'chromium.exe'),
    path.join(PF(), 'Chromium', 'Application', 'chromium.exe'),
  ]},
];

// the App Paths (Default) value for one exe name, HKCU then HKLM — a custom
// install location that no known-path guess covers still resolves here
function regDefaultPath(exeName) {
  return new Promise(resolve => {
    let remaining = 2;
    for (const hive of ['HKCU', 'HKLM']) {
      const key = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`;
      let out = '';
      let child;
      try { child = spawn('reg', ['query', key, '/ve'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { if (--remaining === 0) resolve(null); continue; }
      child.stdout.on('data', d => { out += d; });
      child.on('error', () => {}); // 'close' still fires; handled below
      child.on('close', () => {
        // reg.exe writes UTF-16LE (null-byte interleaved) when stdout is a
        // pipe on some Windows versions — strip the nulls or the regex misses
        const m = /\(Default\)\s+REG_SZ\s+(\S.*)/.exec(out.replace(/\0/g, ''));
        const p = m ? m[1].trim() : null;
        if (p && fs.existsSync(p)) resolve(p);
        else if (--remaining === 0) resolve(null);
      });
    }
  });
}

let cache = { at: 0, list: null };
// installs don't change mid-session and the probe can spawn `reg` subprocesses,
// so the result is cached for a long while — the settings dialog is rare and
// /api/settings does not include the list at all
const CACHE_MS = 5 * 60_000;
async function detectBrowsers() {
  const now = Date.now();
  if (cache.list && now - cache.at < CACHE_MS) return cache.list;
  let found = [];
  if (process.platform === 'win32') {
    // PARALLEL: the old loop awaited regDefaultPath() for each candidate in turn
    // — up to 7 candidates × 2 registry hives, one subprocess at a time, so a
    // machine with browsers in non-standard locations could stall the settings
    // modal for seconds. Promise.all preserves CANDIDATES order.
    const results = await Promise.all(CANDIDATES.map(async c => {
      for (const p of c.paths()) {
        try { if (p && fs.existsSync(p)) return { id: c.id, name: c.name, path: p }; } catch {}
      }
      const viaReg = await regDefaultPath(c.exe);
      return viaReg ? { id: c.id, name: c.name, path: viaReg } : null;
    }));
    found = results.filter(Boolean);
  }
  cache = { at: now, list: found };
  return found;
}

// Resolve the `autoTarget` stamped onto an auto SSE event — the value the
// extension gate compares against its own id. `pick` is settings.browser (the
// harness's "Open harness in" choice), and `isPresent(id)` reports whether a
// live extension for that id is connected to the SSE hub.
//
// The footgun this closes: the pick can name a browser the extension is NOT
// installed in (e.g. "Microsoft Edge" while the extension lives in Chrome), or
// one that can never host it (Firefox). Passing the pick straight through
// tagged every auto event with an id no live extension matched, so the capture
// pasted NOWHERE — silently. When the pick names a browser we can detect
// (chrome/edge) and no instance for it is connected, fall back to 'default' so
// a lone instance elsewhere still receives the paste. Every other pick passes
// through untouched: Chromium ids are mapped to the chrome instance by the
// client gate (`extension/browser-target.js`), and 'firefox' is documented as
// pasting nowhere (no Chromium extension exists there).
export function resolveAutoTarget(pick, isPresent = () => false) {
  const p = String(pick == null ? '' : pick).toLowerCase() || 'default';
  if (p === 'chrome' || p === 'edge') {
    // 'default' pastes in any instance; a connected pick still disambiguates
    // Chrome from Edge exactly as before.
    try { return isPresent(p) ? p : 'default'; } catch { return 'default'; }
  }
  return p;
}

export function registerBrowser(app, ctx) {
  const { settings, saveSettings, csrfSafe } = ctx;

  // ---------- launcher browser choice (which browser the .bat opens) ----------
  app.get('/api/browsers', async () => {
    const browsers = await detectBrowsers();
    // a stored pick whose browser was uninstalled reports 'default' (the
    // launcher falls back to it anyway) instead of a dead option
    const current = settings.browser !== 'default' && browsers.some(b => b.id === settings.browser)
      ? settings.browser : 'default';
    return { browsers, current };
  });
  app.post('/api/browsers', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const id = String((req.body || {}).id || 'default');
    if (id !== 'default') {
      const browsers = await detectBrowsers();
      if (!browsers.some(b => b.id === id)) return reply.code(400).send({ error: 'unknown browser' });
    }
    settings.browser = id;
    saveSettings(); // SSE 'settings' push live-syncs every open UI
    return { ok: true, browser: settings.browser };
  });

  // ---------- harness opener (called by server.js after listen) ----------
  // Windows-only by design: the .bat launcher is the only caller (it sets
  // PP_OPEN_BROWSER=1), so `npm start` and tests never pop a browser.
  async function openHarness(url) {
    if (process.platform !== 'win32') return { opened: false, reason: 'not windows' };
    const choice = settings.browser || 'default';
    if (choice !== 'default') {
      const list = await detectBrowsers();
      const hit = list.find(b => b.id === choice);
      if (hit) {
        try {
          // every Chromium-family browser + Firefox accepts the URL as an
          // argument and opens a tab in the running instance
          const child = spawn(hit.path, [url], { detached: true, stdio: 'ignore', windowsHide: true });
          child.unref();
          return { opened: true, browser: hit.name };
        } catch { /* fall through to the default below */ }
      }
      console.warn(`ProofPipe: browser '${choice}' not found — opening the default browser instead`);
    }
    // default: `start` is a cmd.exe builtin that resolves the OS default browser
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return { opened: true, browser: 'default' };
    } catch (e) {
      console.error('ProofPipe: could not open a browser:', e?.message || e);
      return { opened: false, reason: String(e?.message || e) };
    }
  }

  return { openHarness };
}