// Dev-only: load the UNPACKED extension into REAL Chrome, open the p-tray on a
// plain test page, and perform GENUINE mouse drags — first out of the tray,
// then from control elements in the page itself — reporting exactly what each
// drop received (every file's byte length + hash). A drag payload is the one
// thing that cannot be verified by reading the source: only the browser can
// say what a drop gets, and the tray's own drop silently gets nothing when the
// payload is wrong.
//
//   node dev/ext-tray-probe.mjs            # tray drag + control drags
//   PP_SKIP_CONTROLS=1 node dev/ext-tray-probe.mjs   # tray drag only
//
// Self-contained: it spawns a scratch ProofPipe server (PP_DATA in the TEMP
// dir, never data/) and its own test page, and installs the extension over CDP
// (`Extensions.loadUnpacked` — the --load-extension switch is a no-op on
// current Chrome, and even where it loads, content scripts never register).
//
// Reading the output:
//   `seeded capture #N … original=<bytes> thumbnail=<bytes>` is the yardstick.
//   Each drop prints the DataTransfer types/items and every file's size+sha:
//     · size == original            → the ORIGINAL arrived (the goal)
//     · size == thumbnail           → the derived 400px grid image leaked in
//     · files: [] and no DownloadURL → the drop got nothing at all
//   The CONTROL drags are the calibration: they set the same payloads by hand,
//   so they separate "the tray is broken" from "this browser/automation cannot
//   carry DownloadURL or file items at all" — without them, a failing tray drag
//   proves nothing.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import sharp from 'sharp';

const ROOT = process.cwd();
const CHROME = process.env.PP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// The extension's OWN default port (discovery.js DEFAULT_PORT / SCAN_RANGE is
// 8780-8800): the tray then finds this server through the normal discovery path,
// with no port pinning at all — see the occupancy check below.
const API_PORT = Number(process.env.PP_API_PORT || 8787);
const PAGE_PORT = Number(process.env.PP_PAGE_PORT || 8901);
const CDP_PORT = Number(process.env.PP_CDP_PORT || 9336);
const OUT = process.env.PP_OUT || join(ROOT, 'dev', 'ext-tray-probe.png');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Auto-paste REFUSES a loopback paste target on purpose (PPPasteLogic.
// isSelfPasteTarget — pasting into the harness would loop), and 127.0.0.1 is
// loopback whichever way you spell it. So the test page is served on this
// machine's LAN address: still local, still offline, but not loopback — the
// same shape as the real chat sites the tray is injected into.
const LAN = (() => {
  const nets = networkInterfaces();
  const cands = [];
  for (const list of Object.values(nets)) for (const n of list || []) {
    if (n.family === 'IPv4' && !n.internal) cands.push(n.address);
  }
  return cands.find(a => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) || cands[0] || null;
})();
console.log(`page origin: ${LAN ? `http://${LAN}:${PAGE_PORT}` : '(loopback — auto-paste will refuse this target)'}`);

if (!existsSync(CHROME)) {
  console.error(`chrome not found at ${CHROME} — set PP_CHROME=<path to chrome.exe>`);
  process.exit(2);
}

// The page: a chat box to drop into, and four control drag sources that set
// exactly one payload shape each. `__pp.last` is overwritten per drop so each
// drag can be reported on its own.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>PP drag probe</title>
<style>body{font:14px system-ui;margin:0;background:#f5f5f5}
#chat{position:absolute;left:40px;top:120px;width:420px;height:200px;border:2px dashed #999;background:#fff;padding:8px}
.ctl{position:absolute;right:20px;top:20px;width:200px;height:34px;line-height:34px;text-align:center;
background:#2f6f8f;color:#fff;cursor:grab;border-radius:6px;margin-top:2px}
#ctrl-file{top:60px}#ctrl-both{top:100px}#ctrl-two{top:140px}

pre{position:absolute;left:40px;top:340px}</style>
</head><body>
<div id="chat" contenteditable="true"></div>
<div class="ctl" id="ctrl-url" draggable="true">URL only</div>
<div class="ctl" id="ctrl-file" draggable="true">File only</div>
<div class="ctl" id="ctrl-both" draggable="true">URL + File</div>
<div class="ctl" id="ctrl-two" draggable="true">URL + uri-list</div>
<img id="ctrl-img" alt="native" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAP0lEQVRYhe3OMQEAIAzAsIF/z0NGHjQKej1zZmae7AJ2ATuTAxwOcDjA4QCHA3YBO5MDHA5wOMDhAIcDdgE7kwMnDgNJ0Y0LsAAAAABJRU5ErkJggg=="
  style="position:absolute;right:20px;top:180px;width:32px;height:32px;cursor:grab" draggable="true">
<!-- the payload the FIX ships: a native image drag PLUS a DownloadURL. Verifies
     that the fetch-based entry does not take the bytes down with it. -->
<img id="ctrl-img-dl" alt="native+DownloadURL" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAP0lEQVRYhe3OMQEAIAzAsIF/z0NGHjQKej1zZmae7AJ2ATuTAxwOcDjA4QCHA3YBO5MDHA5wOMDhAIcDdgE7kwMnDgNJ0Y0LsAAAAABJRU5ErkJggg=="
  style="position:absolute;right:20px;top:220px;width:32px;height:32px;cursor:grab" draggable="true">
<!-- does an image loaded from a blob: URL carry ITS OWN encoded bytes? This is
     the assumption the fix rests on: the tile's <img> shows the derived 400px
     thumbnail by default, and is upgraded to the stored ORIGINAL's blob URL on
     hover, so the bytes Blink attaches are the original's. -->
<img id="ctrl-blobimg" alt="blob-backed"
  style="position:absolute;right:20px;top:260px;width:32px;height:32px;cursor:grab" draggable="true">
<pre id="log"></pre>
<script>
window.__pp = { drops: [], errors: [] };
window.__mediaUrl = null;
// a real JPEG, built in-page, so the control File payload has real bytes
(async () => {
  const c = document.createElement('canvas'); c.width = 300; c.height = 200;
  const g = c.getContext('2d'); g.fillStyle = '#b05'; g.fillRect(0, 0, 300, 200);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  window.__ctrlFile = new File([blob], 'control.jpg', { type: 'image/jpeg' });
  window.__ctrlSize = blob.size;
})();
const typesOf = dt => dt ? [...dt.types] : [];
document.addEventListener('drop', async e => {
  e.preventDefault();
  const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
  const items = [...(e.dataTransfer ? e.dataTransfer.items : [])].map(i => ({ kind: i.kind, type: i.type, file: i.getAsFile() ? i.getAsFile().name + ':' + i.getAsFile().size : null }));
  const dt = e.dataTransfer;
  const strings = {};
  for (const t of ['text/plain', 'DownloadURL', 'text/uri-list']) {
    try { strings[t] = (dt.getData(t) || '').slice(0, 120); } catch { strings[t] = '(threw)'; }
  }
  const out = { types: typesOf(e.dataTransfer), strings, items, files: [] };
  for (const f of files) {
    let sha = null;
    try {
      const buf = await f.arrayBuffer();
      const h = await crypto.subtle.digest('SHA-256', buf);
      sha = [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
    } catch (err) { window.__pp.errors.push(String(err)); }
    out.files.push({ name: f.name, type: f.type, size: f.size, sha, head: (await f.slice(0, 4).arrayBuffer()).byteLength });
  }
  window.__pp.drops.push(out);
  document.getElementById('log').textContent = JSON.stringify(out, null, 1);
}, true);
document.addEventListener('dragover', e => e.preventDefault(), true);
// auto-paste lands here as a synthetic 'paste' event carrying the original
window.__pp.pastes = [];
document.addEventListener('paste', async e => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  const out = { types: e.clipboardData ? [...e.clipboardData.types] : [], files: [] };
  for (const f of files) {
    // crypto.subtle does NOT exist on a plain-http origin, and this page's
    // auto-paste leg runs on the LAN address (a loopback paste target is refused
    // by design) — an unguarded digest here rejects the listener and the whole
    // paste goes unrecorded, which reads exactly like "auto-paste did nothing"
    let sha = null;
    try {
      const buf = await f.arrayBuffer();
      const h = await crypto.subtle.digest('SHA-256', buf);
      sha = [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
    } catch (err) { window.__pp.errors.push('paste sha: ' + err); }
    out.files.push({ name: f.name, type: f.type, size: f.size, sha });
  }
  window.__pp.pastes.push(out);
}, true);
// a DISTINCT, blob-backed control image (different size + hash from every other
// control), so a drop carrying it can be named exactly
(async () => {
  const c = document.createElement('canvas'); c.width = 512; c.height = 384;
  const g = c.getContext('2d'); g.fillStyle = '#0a7'; g.fillRect(0, 0, 512, 384);
  g.fillStyle = '#fd0'; g.fillRect(40, 40, 200, 120);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
  const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  window.__ctrlBlobSize = blob.size;
  window.__ctrlBlobSha = [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  document.getElementById('ctrl-blobimg').src = URL.createObjectURL(blob);
})();
// one payload shape per control, each in its own try so a throw is visible
document.getElementById('ctrl-url').addEventListener('dragstart', e => {
  try { e.dataTransfer.setData('DownloadURL', 'image/jpeg:control.jpg:' + window.__mediaUrl); }
  catch (err) { window.__pp.errors.push('ctrl-url: ' + err); }
});
document.getElementById('ctrl-file').addEventListener('dragstart', e => {
  try { e.dataTransfer.items.add(window.__ctrlFile); }
  catch (err) { window.__pp.errors.push('ctrl-file: ' + err); }
});
document.getElementById('ctrl-both').addEventListener('dragstart', e => {
  try { e.dataTransfer.setData('DownloadURL', 'image/jpeg:control.jpg:' + window.__mediaUrl); }
  catch (err) { window.__pp.errors.push('ctrl-both url: ' + err); }
  try { e.dataTransfer.items.add(window.__ctrlFile); }
  catch (err) { window.__pp.errors.push('ctrl-both file: ' + err); }
});
document.getElementById('ctrl-img-dl').addEventListener('dragstart', e => {
  try { e.dataTransfer.setData('DownloadURL', 'image/png:control.png:' + window.__mediaUrl); }
  catch (err) { window.__pp.errors.push('ctrl-img-dl: ' + err); }
});
document.getElementById('ctrl-two').addEventListener('dragstart', e => {
  try { e.dataTransfer.setData('DownloadURL', 'image/jpeg:control.jpg:' + window.__mediaUrl); }
  catch (err) { window.__pp.errors.push('ctrl-two url: ' + err); }
  try { e.dataTransfer.setData('text/uri-list', window.__mediaUrl); }
  catch (err) { window.__pp.errors.push('ctrl-two uri: ' + err); }
});
</script></body></html>`;

// ---------- scratch ProofPipe server (never data/) ----------
// NEVER seed into a ProofPipe the developer already has running: this probe
// uploads 9 captures and would otherwise be writing into (and reporting on)
// their real store. If anything answers on the port, stop here.
const api = `http://127.0.0.1:${API_PORT}`;
try {
  await fetch(`${api}/api/version`, { signal: AbortSignal.timeout(1500) });
  console.error(`something is already serving ${api} — stop it, or set PP_API_PORT=<free port>`);
  console.error('(the tray must also be able to find that port, and 8787 is the only default-free choice)');
  process.exit(2);
} catch {}
const dataDir = mkdtempSync(join(tmpdir(), 'ppprobe-data-'));
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(API_PORT), PP_DATA: dataDir, PP_NO_OPEN: '1' },
  stdio: 'ignore',
});
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(api + '/api/version'); if (r.ok) break; } catch {}
  await sleep(250);
}

// NINE captures, each a different size, so the drop's file (or its filename)
// identifies WHICH capture and WHICH quality travelled. Nine also puts a cell
// past the five the tray prefetches on open — that is the cold-cache cell.
let first = null, origLen = 0, thumbLen = 0;
for (let i = 0; i < 9; i++) {
  const jpeg = await sharp({ create: { width: 900 + i * 60, height: 600 + i * 40, channels: 3, background: `hsl(${i * 36} 55% 45%)` } })
    .jpeg({ quality: 90 }).toBuffer();
  const fd = new FormData();
  fd.set('source', 'phone');
  fd.set('file', new Blob([jpeg], { type: 'image/jpeg' }), `probe-${i}.jpg`);
  const row = await fetch(api + '/upload', { method: 'POST', body: fd }).then(r => r.json());
  const f = row.file || row.capture?.file || row.name;
  const len = Number((await fetch(`${api}/media/${encodeURIComponent(f)}`)).headers.get('content-length'));
  if (i === 8) { // the newest (last uploaded) is the tray's first cell
    first = { id: row.id, file: f };
    origLen = len;
    thumbLen = Number((await fetch(`${api}/media/t-${encodeURIComponent(f)}`)).headers.get('content-length'));
  }
}
console.log(`seeded 9 captures; newest #${first.id} file=${first.file}`);
console.log(`original=${origLen}B thumbnail=${thumbLen}B`);

// ---------- test page ----------
// bound on every interface: the drag/copy checks want 127.0.0.1 (a SECURE
// origin, so crypto.subtle and navigator.clipboard exist — the clipboard API is
// simply absent on a plain http:// LAN origin), while auto-paste needs a
// non-loopback target (see LAN above). One page, two origins, right tool each.
const page = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(PAGE_PORT, '0.0.0.0');
const PAGE_ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;

// ---------- chrome + extension ----------
const profile = mkdtempSync(join(tmpdir(), 'ppext-'));
const W = 1280, H = 900;
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--enable-unsafe-extension-debugging',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`,
  'about:blank',
], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    ws = new WebSocket((await r.json()).webSocketDebuggerUrl);
    break;
  } catch { await sleep(200); }
}
if (!ws) { chrome.kill(); server.kill(); throw new Error('chrome never came up'); }
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
const pageErrors = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageErrors.push(`${d.text} ${d.exception?.description || ''}`.trim().split('\n')[0]);
  }
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
const send = (method, params = {}, sessionId) => {
  const msg = { id: ++id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pending.set(msg.id, { res, rej }));
};

// the extension's service-worker session, when reachable — auto-paste is driven
// from there (chrome.tabs.sendMessage), exactly as the SSE relay drives it
let swSession = null;

// install the extension FIRST, then open the page whose content script we need
const loaded = await send('Extensions.loadUnpacked', { path: join(ROOT, 'extension') });
console.log(`extension loaded: ${loaded.id}`);

// No port pinning: the scratch server sits on the extension's own default port
// (checked above), so the tray finds it the way a real user's tray does.
// (Pinning pp_port via a service-worker evaluate was the fragile part — Chrome
// suspends the worker, and an evaluate against a suspended/odd context returns
// nothing at all, which left the tray looking at a server with no captures and
// the probe reporting on a tray with nothing to drag.) The worker is still woken
// here so auto-paste's SSE relay is alive before the upload leg drives it.
await sleep(1200);
const attachSW = async () => {
  const { targetInfos } = await send('Target.getTargets');
  const sw = targetInfos.find(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
  if (!sw) return null;
  const att = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  await send('Runtime.enable', {}, att.sessionId).catch(() => {});
  swSession = att.sessionId;
  return sw;
};
try {
  const sw = await attachSW();
  if (sw) {
    const r = await send('Runtime.evaluate', {
      expression: `typeof chrome + ' storage=' + typeof chrome.storage + ' local=' + typeof chrome.storage?.local`,
      returnByValue: true,
    }, swSession);
    const why = r.exceptionDetails ? ` (exception: ${r.exceptionDetails.text})` : '';
    console.log(`service worker awake: ${JSON.stringify(r.result?.value)}${why}`);
  } else {
    console.log('!! no extension service worker target — the SSE relay cannot drive auto-paste');
  }
} catch (e) { console.log(`could not reach the service worker: ${e.message}`); }

// PP_TRAY_SCRATCH=1: aim the tray at THIS run's scratch server, so its data is
// the nine known captures instead of whatever ProofPipe the machine happens to be
// running. Storage first, then a COLD service-worker boot: goodHost is in-memory
// and the pp_host restore only runs at boot, and a pinned-and-verified origin is
// returned immediately — no discovery race in which the real server can win.
// (An evaluate against a SUSPENDED worker is what made this look impossible; the
// fix is to stop the worker and let the next message boot it.)
if (process.env.PP_TRAY_SCRATCH) {
  // The write must come from an extension PAGE, not the worker: an attached SW
  // context here exposes `chrome` with no extension bindings at all
  // (`typeof chrome.storage` is 'undefined' in it), which is why a storage pin
  // from the worker looked like it silently did nothing.
  const popup = await send('Target.createTarget', { url: `chrome-extension://${loaded.id}/popup.html` });
  const att = await send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
  await sleep(800);
  const wrote = await send('Runtime.evaluate', {
    expression: `chrome.storage.local.set({ pp_host: ${JSON.stringify(api)}, pp_port: ${API_PORT} })
      .then(() => chrome.storage.local.get(['pp_host', 'pp_port']))
      .then(r => JSON.stringify(r))`,
    awaitPromise: true, returnByValue: true,
  }, att.sessionId).then(r => r.result.value).catch(e => `threw ${e.message}`);
  await send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
  // ...then COLD-boot the service worker: goodHost is in-memory and pp_host is
  // only restored at boot (a pinned, verified origin is returned immediately, so
  // there is no discovery race for a real server to win)
  const sw = await attachSW();
  if (sw) await send('Target.closeTarget', { targetId: sw.targetId }).catch(() => {});
  await sleep(1500);
  const again = await attachSW();
  await sleep(300);
  console.log(`tray pinned to this run's server: ${api} (storage ${wrote}, worker ${again ? 'back' : 'MISSING'})`);
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
const evaluate = async expression =>
  (await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

await S('Page.enable');
await S('Runtime.enable');
await S('DOM.enable');
await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await S('Page.navigate', { url: `${PAGE_ORIGIN}/` });

let injected = false;
for (let i = 0; i < 30; i++) {
  injected = await evaluate("!!document.querySelector('#proofpipe-tray-host')");
  if (injected) break;
  await sleep(300);
}
console.log(`content script injected: ${injected}`);
if (!injected) console.log('!! the tray never injected — check the extension load above');
// WHY can the tray not reach this run's server? A CORS refusal and a refused
// connection look identical from the tray's side (both land in its catch), so
// ask the page directly — the direct-fetch fallback and the SW relay are
// different failure modes and the drag's DownloadURL is a third.
try {
  const diag = await evaluate(`fetch(${JSON.stringify(`${api}/api/captures`)})
    .then(r => 'HTTP ' + r.status + ' acao=' + r.headers.get('access-control-allow-origin'))
    .catch(e => 'ERR ' + e)`);
  console.log(`page→server reachability: ${diag}`);
} catch {}
try {
  const pinned = await send('Runtime.evaluate', {
    expression: `chrome.storage.local.get(['pp_host', 'pp_port']).then(r => JSON.stringify(r))`,
    awaitPromise: true, returnByValue: true,
  }, swSession).then(r => r.result.value).catch(e => `threw ${e.message}`);
  console.log(`extension storage: ${pinned}`);
} catch {}

// give the control payload its media URL (the tray's own server, so the
// DownloadURL in the controls points at a real, fetchable original)
await evaluate(`window.__mediaUrl = ${JSON.stringify(`${api}/media/${encodeURIComponent(first.file)}`)}; 1`).catch(() => {});
await sleep(600);

// `button: 'left'` + `buttons: 1` on the move events matters: a move with
// button 'none' is not a drag as far as Blink's drag controller is concerned,
// so the drag never starts and no event is ever delivered
const mouse = (type, x, y, extra = {}) => S('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', clickCount: 1, ...extra,
});
const dragMove = (x, y) => mouse('mouseMoved', x, y, { buttons: 1 });
const shoot = async out => {
  const shot = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
};

// the tray's nodes live behind a CLOSED shadow root, so they can only be
// reached by a pierced document — taken fresh each time (a re-render/repaint
// invalidates node ids)
const piercedRoot = async () => (await S('DOM.getDocument', { depth: -1, pierce: true })).root;
const attr = (n, name) => {
  const a = n.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return null;
};
const walk = (node, want) => {
  const seen = new Set();
  const out = [];
  const rec = n => {
    if (!n || (n.nodeId && seen.has(n.nodeId))) return;
    if (n.nodeId) seen.add(n.nodeId);
    for (const c of n.children || []) rec(c);
    for (const sr of n.shadowRoots || []) rec(sr);
    if (n.contentDocument) rec(n.contentDocument);
    if ((n.attributes || []).length && want(n)) out.push(n);
  };
  rec(node);
  return out;
};
// The yardstick: hash every capture's ORIGINAL and its derived `t-` thumbnail on
// whichever servers are in play, so a dropped/copied/pasted image can be named
// — and so a leak of the 400px grid image can be called out by name instead of
// as "some other size".
const sha12 = buf => crypto.subtle.digest('SHA-256', buf)
  .then(h => [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12));
const serversInPlay = async () => {
  const list = [api];
  if (swSession) {
    const pinned = await send('Runtime.evaluate', {
      expression: `chrome.storage.local.get('pp_host').then(r => r.pp_host || '')`,
      awaitPromise: true, returnByValue: true,
    }, swSession).then(r => r.result.value).catch(() => '');
    if (pinned) list.push(pinned);
  }
  list.push('http://127.0.0.1:8787'); // the built-in default the tray falls back to
  return [...new Set(list)];
};
const index = [];
async function buildIndex() {
  for (const base of await serversInPlay()) {
    let caps = [];
    try { caps = await (await fetch(`${base}/api/captures`)).json(); } catch { continue; }
    for (const c of (Array.isArray(caps) ? caps : []).slice(0, 8)) {
      for (const [kind, name] of [['original', c.file], ['THUMBNAIL', `t-${c.file}`]]) {
        try {
          const buf = Buffer.from(await (await fetch(`${base}/media/${encodeURIComponent(name)}`)).arrayBuffer());
          index.push({ base, id: c.id, kind, name, size: buf.length, sha: await sha12(buf) });
        } catch {}
      }
    }
  }
  console.log(`indexed ${index.length} media files across ${[...new Set(index.map(i => i.base))].length} server(s)`);
}
const identify = async (sha, size) => {
  // a non-secure origin has no crypto.subtle, so fall back to the byte count
  const hit = sha ? index.find(i => i.sha === sha) : index.find(i => i.size === size);
  if (!hit) return `NO MATCH (${size}B) — not any indexed original or thumbnail`;
  return hit.kind === 'original'
    ? `== ORIGINAL of #${hit.id} (${hit.size}B) — FULL QUALITY, byte for byte`
    : `!! == the ${hit.kind} of #${hit.id} (${hit.size}B) — QUALITY LEAK: the 400px grid image travelled`;
};
const verifyDrops = async label => {
  const drops = JSON.parse(await evaluate('JSON.stringify(window.__pp.drops)')).slice(-1);
  for (const d of drops) for (const f of d.files) console.log(`  ${label}: ${f.size}B ${f.type} → ${await identify(f.sha, f.size)}`);
};

const centreOf = async nodeId => {
  const model = await S('DOM.getBoxModel', { nodeId });
  const q = model.model.border;
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
};
// ONE snapshot of the tray per call: node ids must be used against the tree
// they came from, and every extra DOM.getDocument in between risks a stale id
const traySnapshot = async () => {
  const root = await piercedRoot();
  const cells = walk(root, n => n.localName === 'div' && (attr(n, 'class') || '') === 'cell');
  const statusNode = walk(root, x => (attr(x, 'class') || '').split(' ')[0] === 'status')[0];
  const text = async n => n ? (await S('DOM.getOuterHTML', { nodeId: n.nodeId })).outerHTML.replace(/<[^>]+>/g, '').trim() : '(none)';
  const markup = cells.length ? (await S('DOM.getOuterHTML', { nodeId: cells[0].nodeId })).outerHTML : '';
  const boxes = [];
  for (const c of cells) boxes.push(await centreOf(c.nodeId));
  return { cells: cells.length, status: await text(statusNode), markup, box: boxes[0] || null, boxes };
};
// plain page elements (the controls and the chat box) are readable directly
const rectOf = async sel => JSON.parse(await evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return 'null';
  const b = el.getBoundingClientRect();
  return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
})()`));

// THE REAL GESTURE: press on `from`, move in steps to `to` (crossing Blink's
// drag threshold and letting it build the drag data object), release there
async function dragFromTo(from, to, label) {
  await mouse('mouseMoved', from.x, from.y, { buttons: 0, button: 'none' });
  await sleep(150);
  await mouse('mousePressed', from.x, from.y);
  for (let i = 1; i <= 12; i++) {
    const t = i / 12;
    await dragMove(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await sleep(60);
  }
  await sleep(250);
  await mouse('mouseReleased', to.x, to.y);
  await sleep(900);
  const last = await evaluate('JSON.stringify(window.__pp.drops[window.__pp.drops.length - 1] || null)');
  console.log(`--- ${label} ---`);
  console.log(`  drop:  ${last}`);
  if (process.env.PP_STORE === '1') console.log(`  store: ${await storeOf(from, to, label)}`);
}

const chatCentre = await rectOf('#chat');

// The AUTHORITATIVE view: `Input.setInterceptDrags` makes Chrome hand over the
// drag data store it actually built, before any drop handler sees it. This is
// the only way to tell "the payload was never built" from "the payload was
// built and the drop could not read it". Interception pauses the drag, so it
// is a separate pass: press, move past the threshold, read, cancel.
const interceptEnabled = async on => {
  try { return await send('Input.setInterceptDrags', { enabled: on }); }
  catch { return null; } // not available in this Chrome — the drop view is all we get
};
let intercepted = null;
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Input.dragIntercepted') intercepted = m.params.data;
});

async function storeOf(from, to, label) {
  if (process.env.PP_STORE !== '1') return '(skipped)';
  intercepted = null;
  await interceptEnabled(true);
  await mouse('mouseMoved', from.x, from.y, { buttons: 0, button: 'none' });
  await sleep(120);
  await mouse('mousePressed', from.x, from.y);
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    await dragMove(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await sleep(60);
    if (intercepted) break;
  }
  for (let i = 0; i < 20 && !intercepted; i++) await sleep(100);
  await interceptEnabled(false);
  await mouse('mouseReleased', from.x, from.y);
  await sleep(300);
  if (!intercepted) return '(no dragIntercepted event — drag never became a drag?)';
  const items = (intercepted.items || []).map(i => {
    const v = String(i.data || '');
    const len = v.startsWith('data:') ? `${v.length}B dataURL` : v.slice(0, 100);
    return `${i.mimeType}="${len}"`;
  });
  const files = (intercepted.files || []).map(f => (typeof f === 'string' ? f : JSON.stringify(f).slice(0, 160)));
  return `items=[${items.join(' | ')}] files=[${files.join(', ')}]`;
}

// ---------- 1. the tray's own drag ----------
const fab = { x: Math.max(10, W - 48) + 18, y: Math.max(10, H - 48) + 18 };
await mouse('mouseMoved', fab.x, fab.y, { buttons: 0, button: 'none' });
await mouse('mousePressed', fab.x, fab.y);
await mouse('mouseReleased', fab.x, fab.y);
await sleep(2500);
await shoot(OUT);
console.log(`clicked the FAB at ${fab.x},${fab.y} — screenshot: ${OUT} (tray open)`);

await buildIndex();
const tray = await traySnapshot();
console.log(`tray cells: ${tray.cells} · status: "${tray.status}"`);
if (tray.cells) {
  console.log(`first cell at ${tray.box.x.toFixed(0)},${tray.box.y.toFixed(0)} · markup ${tray.markup.slice(0, 300)}`);

  // COLD FIRST, on a cell the tray never prefetched (load() warms only the
  // newest five): this is the real gesture — grab a capture and drag it within
  // a few hundred ms. `text/plain` in the drop is the file item's filename, so
  // its presence/absence IS "did the drag carry the original's bytes".
  const cold = tray.boxes[Math.min(7, tray.boxes.length - 1)];
  await dragFromTo(cold, chatCentre, `TRAY DRAG, COLD cache (cell ${Math.min(8, tray.cells)})`);
  await verifyDrops('cold drag');

  // ...and the same drag after a deliberate hover, which is what warms the
  // full-size blob. Same cell, same code path: the difference is the payload.
  await mouse('mouseMoved', tray.box.x, tray.box.y, { buttons: 0, button: 'none' });
  await sleep(2500);
  await dragFromTo(tray.box, chatCentre, 'TRAY DRAG, hover-WARMED cache');
  await verifyDrops('warm drag');
  console.log(`tray status after the drag: "${(await traySnapshot()).status}"`);

  // the click-to-copy path (the other half of "drag OR copy"): the status line
  // distinguishes success from a blocked copy, and its timing shows a stall
  await mouse('mouseMoved', tray.box.x, tray.box.y, { buttons: 0, button: 'none' });
  await mouse('mousePressed', tray.box.x, tray.box.y);
  await mouse('mouseReleased', tray.box.x, tray.box.y);
  const t0 = Date.now();
  for (const ms of [500, 2000, 5000, 12000, 31000]) {
    const wait = ms - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    console.log(`copy status @${ms}ms: "${(await traySnapshot()).status}"`);
  }
  // ...and WHAT it put on the clipboard: the clipboard API only takes PNG, so
  // the check is the pixel SIZE — a re-encoded copy is fine, a downscaled one
  // is a quality regression (the transfer-quality switch must be the only thing
  // allowed to shrink a capture)
  await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  const clip = await evaluate(`(async () => {
    try {
      const items = await navigator.clipboard.read();
      const out = [];
      for (const it of items) {
        for (const type of it.types) {
          const b = await it.getType(type);
          let dim = null;
          try { const bmp = await createImageBitmap(b); dim = bmp.width + 'x' + bmp.height; bmp.close(); } catch {}
          out.push({ type, bytes: b.size, dim });
        }
      }
      return JSON.stringify(out);
    } catch (e) { return 'clipboard read failed: ' + e; }
  })()`);
  console.log(`clipboard after copy: ${clip}`);
} else {
  console.log('!! no cells — the tray had nothing to show (server unreachable from the tray?)');
}

// ---------- 2. controls: the same payload shapes, set by hand ----------
if (!process.env.PP_SKIP_CONTROLS) {
  for (const [ctl, label] of [['#ctrl-url', 'CONTROL: DownloadURL only'],
    ['#ctrl-file', 'CONTROL: File only'],
    ['#ctrl-both', 'CONTROL: DownloadURL + File'],
    ['#ctrl-two', 'CONTROL: DownloadURL + text/uri-list'],
    ['#ctrl-img-dl', 'CONTROL: native <img> drag + DownloadURL (the fix)'],
    ['#ctrl-blobimg', 'CONTROL: native <img> drag, blob: URL src'],
    // the mechanism that DID work before this work (v1.11): a dragged <img>.
    // If THIS also reaches the drop with no file, then this browser/automation
    // cannot carry file items in-page at all and the tray is not the problem.
    ['#ctrl-img', 'CONTROL: native <img> drag (v1.11 mechanism)']]) {
    await dragFromTo(await rectOf(ctl), chatCentre, label);
  }
  console.log(`control file size (image/jpeg built in-page): ${await evaluate('window.__ctrlSize')}B`);
  // The blob-backed control's own identity, so a drop carrying it (or failing to)
  // can be named against the EXACT bytes its <img> loaded.
  console.log(`blob-backed control image: ${await evaluate('window.__ctrlBlobSize')}B sha ${await evaluate('window.__ctrlBlobSha')}  (data: URL control is 121B)`);
}

// ---------- 3. auto-paste (the phone "auto" mode), driven exactly as the SSE
// relay drives it: a tab message from the service worker ----------
if (!process.env.PP_SKIP_AUTOPASTE) {
  if (!LAN) {
    console.log('AUTO-PASTE: skipped — no non-loopback address to host the target tab on');
  } else {
    // the paste TARGET is a second tab on the LAN origin: a loopback target is
    // refused by design (PPPasteLogic.isSelfPasteTarget)
    const { targetId: pasteTarget } = await send('Target.createTarget', { url: `http://${LAN}:${PAGE_PORT}/` });
    const { sessionId: pasteSession } = await send('Target.attachToTarget', { targetId: pasteTarget, flatten: true });
    const P = (m, p) => send(m, p, pasteSession);
    await P('Runtime.enable');
    await P('Page.enable');
    await sleep(1500);
    const pane = { P, targetId: pasteTarget };
    console.log(`AUTO-PASTE: target tab ${pasteTarget} at http://${LAN}:${PAGE_PORT}/`);
    // THE REAL PATH, with nothing driven by hand: uploading a capture is what a
    // phone does, the server's /events stream wakes the offscreen relay, the
    // service worker routes it to the chat tab and the content script pastes it.
    // (Driving chrome.tabs.sendMessage directly would skip the two hops most
    // likely to be broken: the relay's wiring and the target-tab routing.)
    await send('Target.activateTarget', { targetId: pasteTarget });
    await P('Runtime.evaluate', { expression: "document.getElementById('chat').focus()" });
    const fresh = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#17c' } })
      .jpeg({ quality: 90 }).toBuffer();
    const fdup = new FormData();
    fdup.set('source', 'phone');
    // `auto=1` is what the phone sends in auto mode (server.js: wantsAuto =
    // origin==='phone' && auto flag, falling back to the server's autoPaste
    // toggle — which is OFF on a fresh store). Without it the upload is a plain
    // capture: stored and shown, never routed to a chat.
    fdup.set('auto', '1');
    fdup.set('file', new Blob([fresh], { type: 'image/jpeg' }), 'autopaste.jpg');
    const up = await fetch(api + '/upload', { method: 'POST', body: fdup }).then(r => r.json());
    const autoSha = await sha12(fresh);
    console.log(`AUTO-PASTE: uploaded #${up.id} (${fresh.length}B sha ${autoSha}) — waiting for the relay to route it`);
    await sleep(7000); // SSE wake -> offscreen relay -> SW route -> content-script paste
    const pastes = JSON.parse(await pane.P('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__pp.pastes)', returnByValue: true,
    }).then(r => r.result.value) || '[]');
    console.log(`AUTO-PASTE: the target page saw ${pastes.length} paste event(s)`);
    for (const p of pastes) for (const f of p.files) {
      console.log(`AUTO-PASTE: ${f.size}B ${f.type} (${f.name}) → ${
        f.size === fresh.length
          ? `== the uploaded ORIGINAL (${fresh.length}B) — no re-encode`
          : `!! ${f.size}B ≠ the uploaded original (${fresh.length}B) — a re-encode or a substitute`}`);
    }
    if (!pastes.length) console.log('AUTO-PASTE: no paste event reached the target page');
    const toast = await pane.P('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('div')].map(d => d.textContent).filter(t => /pasted|copied|arrived/.test(t)).join(' | ')`,
      returnByValue: true,
    }).then(r => r.result.value);
    console.log(`AUTO-PASTE: target page toast: "${toast}"`);
  }
}

// The payload builders catch their own throws, so a refused items.add()/setData()
// shows up HERE and nowhere else — and "the drop got nothing" is exactly what a
// swallowed throw looks like. Print it before the summary.
try {
  const caught = JSON.parse(await evaluate('JSON.stringify(window.__pp.errors)') || '[]');
  console.log(`in-page caught payload errors (${caught.length}): ${caught.length ? JSON.stringify(caught.slice(0, 8)) : '(none)'}`);
} catch {}
if (pageErrors.length) console.log('page errors:', JSON.stringify(pageErrors.slice(0, 6), null, 1));
console.log(`original=${origLen}B thumbnail=${thumbLen}B`);

ws.close();
chrome.kill();
server.kill();
page.close();
process.exit(0);
