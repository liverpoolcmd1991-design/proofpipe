// p button hide/show — the client glue (PITFALLS #37: "untested client glue is
// where the regressions lived").
//
// These load the REAL popup.html/popup.js and content.js into a DOM with a
// stubbed chrome.* and drive them the way a user would. Two things here have
// already bitten and are pinned by these tests:
//   1. a hide/show control that talks to the active tab over sendMessage does
//      nothing on pages with no content script (chrome://, our own harness
//      origin) — the popup must own the flag in storage instead
//   2. updateFabVisibility() runs during boot, before `let pollTimer` is
//      initialized — closing the panel there threw a TDZ ReferenceError and
//      aborted the rest of content.js on EVERY load while the tray was hidden
//
// jsdom is a devDependency. The guard below keeps `npm test` green on a
// checkout installed with --omit=dev, where the import would throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(APP, 'extension');
const read = rel => fs.readFileSync(path.join(EXT, rel), 'utf8');

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional */ }
const skipOpt = JSDOM ? false : 'jsdom not installed — run `npm i -D jsdom` to enable';

// in-memory chrome.storage.local with the same onChanged fan-out as the real one
function makeStorage() {
  const data = new Map();
  const listeners = [];
  return {
    data,
    api: {
      get: keys => {
        const out = {};
        for (const k of [].concat(keys || [])) if (data.has(k)) out[k] = data.get(k);
        return Promise.resolve(out);
      },
      set: obj => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: data.get(k), newValue: v };
          data.set(k, v);
        }
        for (const fn of listeners) fn(changes, 'local');
        return Promise.resolve();
      },
      onChanged: { addListener: fn => listeners.push(fn) },
    },
  };
}

// the chrome surface content.js/popup.js touch, with NO content script in the
// tab — the situation where a sendMessage-based toggle silently does nothing
function makeChrome(storage) {
  const runtimeListeners = [];
  return {
    runtimeListeners,
    api: {
      storage: { local: storage },
      runtime: {
        sendMessage: () => Promise.reject(new Error('no background in test')),
        onMessage: { addListener: fn => runtimeListeners.push(fn) },
      },
      tabs: {
        query: () => Promise.resolve([{ id: 1 }]),
        sendMessage: () => Promise.reject(new Error('no content script here')),
      },
    },
  };
}

const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));

// ---------- the toolbar popup owns the global flag ----------
test('popup: the hide/show button flips the flag in storage (no content script needed)', { skip: skipOpt }, async () => {
  const store = makeStorage();
  const chrome = makeChrome(store.api);
  const dom = new JSDOM(read('popup.html'), {
    runScripts: 'dangerously', url: 'chrome-extension://test/popup.html', pretendToBeVisual: true,
  });
  const win = dom.window;
  win.chrome = chrome.api;
  win.fetch = () => Promise.reject(new Error('no server in test')); // list load fails; irrelevant here
  for (const f of ['toPng.js', 'discovery.js', 'files.js', 'popup.js']) win.eval(read(f));
  await settle(60);

  const btn = win.document.querySelector('#fab-toggle');
  const label = win.document.querySelector('#fab-toggle-label');
  const icon = btn.querySelector('.ic');
  assert.equal(label.textContent, 'Hide p button everywhere');
  assert.equal(icon.className, 'ic ic-eye');

  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(store.data.get('pp_fab_global_hidden'), true, 'click writes the flag even with no content script in the tab');
  assert.match(label.textContent, /^Show p button everywhere/);
  assert.equal(icon.className, 'ic ic-eye-off');
  assert.ok(btn.classList.contains('off'));

  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(store.data.get('pp_fab_global_hidden'), false);
  assert.equal(label.textContent, 'Hide p button everywhere');
  assert.equal(icon.className, 'ic ic-eye');
});

// ---------- popup tabs follow the ARIA pattern ----------
// Both tabs used to be plain buttons: Tab/Shift+Tab was the only way between
// them (skipping past the pattern), and the inactive panel's control stayed in
// the tab order. Roving tabindex + arrows is the expected behaviour.
test('popup: arrow keys move and select the tabs (roving tabindex)', { skip: skipOpt }, async () => {
  const store = makeStorage();
  const dom = new JSDOM(read('popup.html'), {
    runScripts: 'dangerously', url: 'chrome-extension://test/popup.html', pretendToBeVisual: true,
  });
  const win = dom.window;
  win.chrome = makeChrome(store.api).api;
  win.fetch = () => Promise.reject(new Error('no server in test'));
  for (const f of ['toPng.js', 'discovery.js', 'files.js', 'popup.js']) win.eval(read(f));
  await settle(60);

  const caps = win.document.querySelector('#tab-caps');
  const texts = win.document.querySelector('#tab-texts');
  const selected = () => (caps.getAttribute('aria-selected') === 'true' ? 'caps' : 'texts');
  const key = (el, k) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));

  assert.equal(selected(), 'caps', 'captures starts selected');
  assert.equal(caps.tabIndex, 0, 'the selected tab is in the tab order');
  assert.equal(texts.tabIndex, -1, 'the unselected tab is not');

  key(caps, 'ArrowRight');
  await settle(30);
  assert.equal(selected(), 'texts', 'ArrowRight selects the next tab');
  assert.equal(texts.tabIndex, 0, 'the roving tabindex followed');
  assert.equal(caps.tabIndex, -1);
  assert.equal(win.document.activeElement, texts, 'focus follows the selection');

  // wraps in both directions, and Home/End jump to the ends
  key(texts, 'ArrowRight');
  await settle(30);
  assert.equal(selected(), 'caps', 'wraps forward');
  key(caps, 'ArrowLeft');
  await settle(30);
  assert.equal(selected(), 'texts', 'wraps backward');
  key(texts, 'Home');
  await settle(30);
  assert.equal(selected(), 'caps', 'Home jumps to the first tab');
  key(caps, 'End');
  await settle(30);
  assert.equal(selected(), 'texts', 'End jumps to the last tab');
});

// ---------- the content script follows that flag ----------
function bootContent({ storage, siteHidden }) {
  const chrome = makeChrome(storage);
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.com/page', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  const win = dom.window;
  win.chrome = chrome.api;
  win.fetch = () => Promise.reject(new Error('no server in test'));
  if (siteHidden) win.localStorage.setItem('pp_fab_hidden_site', '1');
  for (const f of ['toPng.js', 'discovery.js', 'paste-logic.js', 'files.js', 'content.js']) win.eval(read(f));
  return { win, chrome, host: () => win.document.getElementById('proofpipe-tray-host') };
}

test('content: global hide removes the tray, global show brings it back', { skip: skipOpt }, async () => {
  const store = makeStorage();
  const { host } = bootContent({ storage: store.api });
  await settle(60);
  assert.ok(host(), 'tray host injected');
  assert.notEqual(host().style.display, 'none');

  await store.api.set({ pp_fab_global_hidden: true });
  await settle();
  assert.equal(host().style.display, 'none', 'open tabs follow the flag without a reload');

  await store.api.set({ pp_fab_global_hidden: false });
  await settle();
  assert.notEqual(host().style.display, 'none');
});

test('content: booting while hidden must not abort the script (TDZ on pollTimer)', { skip: skipOpt }, async () => {
  const store = makeStorage();
  // hidden from the start, both ways — this is the load path that used to throw
  await store.api.set({ pp_fab_global_hidden: true });
  const { host, chrome, win } = bootContent({ storage: store.api, siteHidden: true });
  await settle(60);
  assert.equal(host().style.display, 'none');
  assert.ok(chrome.runtimeListeners.length > 0, 'the message listener still registered — the script ran to the end');
  // ...and the popup's unhide still reaches it
  let reply = null;
  chrome.runtimeListeners[0]({ type: 'unhideGlobal' }, {}, r => { reply = r; });
  await settle();
  // plain equal: the reply object was born in the jsdom realm, so its
  // prototype differs from ours (deepStrictEqual would reject it)
  assert.equal(reply && reply.ok, true);
  assert.equal(win.localStorage.getItem('pp_fab_hidden_site'), null, 'per-site flag cleared');
  assert.notEqual(host().style.display, 'none', 'tray comes back');
});

test('popup: Quick Send sends composer note, active tab link, and visible tab screenshot', { skip: skipOpt }, async () => {
  const store = makeStorage();
  const sentMessages = [];
  let activeTab = { id: 42, windowId: 7, url: 'https://example.com/article?id=9' };
  const dom = new JSDOM(read('popup.html'), {
    runScripts: 'dangerously', url: 'chrome-extension://test/popup.html', pretendToBeVisual: true,
  });
  const win = dom.window;
  win.chrome = {
    storage: { local: store.api },
    runtime: {
      sendMessage: async msg => {
        sentMessages.push(msg);
        if (msg.type === 'sendText') return { ok: true, id: 101 };
        if (msg.type === 'uploadCapture') return { ok: true, id: 202, file: 'shot.png' };
        if (msg.type === 'captures') return [];
        throw new Error('unexpected message');
      },
      onMessage: { addListener: () => {} },
    },
    tabs: {
      query: () => Promise.resolve([activeTab]),
      sendMessage: () => Promise.reject(new Error('no content script')),
      captureVisibleTab: async (winId, opts) => {
        assert.equal(winId, 7);
        assert.equal(opts.format, 'png');
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      },
    },
  };
  win.fetch = () => Promise.reject(new Error('force SW relay'));
  for (const f of ['toPng.js', 'discovery.js', 'files.js', 'popup.js']) win.eval(read(f));
  await settle(60);

  // 1. Inline text composer via Enter
  const input = win.document.querySelector('#quick-text');
  const status = win.document.querySelector('#status');
  input.value = 'Check this build note';
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.ok(sentMessages.some(m => m.type === 'sendText' && m.body === 'Check this build note'));
  assert.equal(input.value, '');
  assert.equal(status.textContent, '✓ Sent to phone');
  assert.equal(status.classList.contains('err'), false);

  // 2. 1-click active tab link
  win.document.querySelector('#send-tab-link').click();
  await settle();
  assert.ok(sentMessages.some(m => m.type === 'sendText' && m.body === 'https://example.com/article?id=9'));
  assert.equal(status.textContent, '✓ Tab link sent to phone');

  // 3. Restricted chrome:// page guard
  activeTab = { id: 43, windowId: 7, url: 'chrome://settings' };
  win.document.querySelector('#send-tab-link').click();
  await settle();
  assert.equal(status.textContent, 'Open a web page tab to send its link.');
  assert.equal(status.classList.contains('err'), true);

  // 4. Visible tab screenshot upload
  activeTab = { id: 42, windowId: 7, url: 'https://example.com/article?id=9' };
  win.document.querySelector('#send-tab-shot').click();
  await settle(60);
  const up = sentMessages.find(m => m.type === 'uploadCapture');
  assert.ok(up && up.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(status.textContent, '✓ Screenshot sent — live on phone & workbench');
});

