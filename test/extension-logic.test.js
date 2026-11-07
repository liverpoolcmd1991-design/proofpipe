// Extension logic unit tests — no browser, no chrome.*: the pure decision
// modules (discovery.js, paste-logic.js) are loaded into a VM context and
// exercised directly. These are the rules behind the port-discovery guessing
// and the double/4x-paste saga (PITFALLS #5/#6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// top-level `const` in a vm script does NOT attach to the context object —
// both modules export via `self.X = X` when self exists, so provide a self
// sandbox and read the export from it
const load = rel => {
  // URL must be provided: paste-logic's isSelfPasteTarget parses URLs, and a
  // bare VM context has no WHATWG URL — without it every check silently
  // returned false (the catch-all) and the tests caught it
  const ctx = { console, self: {}, URL };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(APP, 'extension', rel), 'utf8'), ctx);
  return ctx.self;
};

// ---------- discovery ----------
const { PPDiscovery } = load('discovery.js');

test('parsePort accepts valid integers (number or string), refuses garbage', () => {
  assert.equal(PPDiscovery.parsePort(8787), 8787);
  assert.equal(PPDiscovery.parsePort('9099'), 9099);
  assert.equal(PPDiscovery.parsePort(' 9099 '), 9099); // trimmed input field value
  assert.equal(PPDiscovery.parsePort(''), null);
  assert.equal(PPDiscovery.parsePort('0'), null);
  assert.equal(PPDiscovery.parsePort('-1'), null);
  assert.equal(PPDiscovery.parsePort('99999'), null);
  assert.equal(PPDiscovery.parsePort('8o87'), null);
  assert.equal(PPDiscovery.parsePort(null), null);
  assert.equal(PPDiscovery.parsePort(undefined), null);
  assert.equal(PPDiscovery.parsePort(12.5), null);
});

test('candidatePorts: default first, bounded scan, deduped, extras last', () => {
  const ports = PPDiscovery.candidatePorts({});
  assert.equal(ports[0], 8787, 'default port leads');
  assert.ok(!ports.includes(null) && !ports.includes(0), 'no invalid ports leak in');
  assert.equal(new Set(ports).size, ports.length, 'deduped');
  assert.ok(ports.length <= 40, `bounded (got ${ports.length})`);
  assert.ok(ports.includes(8780) && ports.includes(8800), 'scan range covered');
  assert.ok(ports.includes(8080) && ports.includes(3000), 'legacy extras kept');
  assert.ok(ports.indexOf(8787) < ports.indexOf(8788), 'scan follows the default');
});

test('candidatePorts: manual override probes FIRST, pinned port second', () => {
  const ports = PPDiscovery.candidatePorts({ manualPort: 9999, pinnedPort: 8799 });
  assert.equal(ports[0], 9999, 'user-set port wins');
  assert.equal(ports[1], 8799, 'last known good is next');
  // invalid values fall back cleanly — never crash the discovery
  const safe = PPDiscovery.candidatePorts({ manualPort: 'abc', pinnedPort: 0 });
  assert.equal(safe[0], 8787);
});

test('candidateHosts: 4 templates per port, order preserved', () => {
  const hosts = PPDiscovery.candidateHosts([8787]);
  assert.equal(hosts.length, 4);
  assert.equal(hosts[0], 'http://127.0.0.1:8787');
  assert.equal(hosts[1], 'http://localhost:8787');
  assert.equal(hosts[2], 'https://127.0.0.1:8787');
  assert.equal(hosts[3], 'https://localhost:8787');
});

test('probeHosts: primary (plain-http loopback) stage first, the rest after', async () => {
  const seen = [];
  const probe = async h => { seen.push(h); return h === 'https://localhost:8790'; };
  const hosts = [
    'http://127.0.0.1:8787', 'http://localhost:8787',
    'https://127.0.0.1:8787', 'https://localhost:8790',
  ];
  const found = await PPDiscovery.probeHosts(hosts, probe);
  assert.equal(found, 'https://localhost:8790', 'a non-primary candidate still wins after stage 1 misses');
  // stage 1 must COMPLETE before any non-primary host is touched — that is what
  // makes the common case ~one probe timeout instead of the sum of them
  const firstSecondary = seen.findIndex(h => !PPDiscovery.primaryHost(h));
  assert.ok(firstSecondary > -1, 'stage 2 ran');
  assert.ok(seen.slice(0, firstSecondary).every(h => PPDiscovery.primaryHost(h)), 'stage 1 is not interleaved with stage 2');
  assert.ok(seen.includes('http://127.0.0.1:8787') && seen.includes('http://localhost:8787'), 'both primary hosts probed');
});

test('probeHosts: the quick path never touches the https/no-port matrix', async () => {
  const seen = [];
  const found = await PPDiscovery.probeHosts(
    ['http://127.0.0.1:8787', 'https://127.0.0.1:8787', 'http://localhost:8787'],
    async h => { seen.push(h); return null; },
    { stages: 'primary-only' },
  );
  assert.equal(found, null);
  assert.deepEqual(seen.sort(), ['http://127.0.0.1:8787', 'http://localhost:8787'], 'https candidate skipped');
});

test('probeHosts: no candidates resolves null instead of throwing (Promise.any on [])', async () => {
  assert.equal(await PPDiscovery.probeHosts([], async () => true), null);
  assert.equal(await PPDiscovery.probeHosts(null, async () => true), null);
  assert.equal(await PPDiscovery.probeHosts(['https://x:1'], async () => false, { stages: 'primary-only' }), null);
});

test('primaryHost: only plain-http loopback with an explicit port is stage 1', () => {
  const p = PPDiscovery.primaryHost;
  assert.equal(p('http://127.0.0.1:8787'), true);
  assert.equal(p('http://localhost:8787'), true);
  assert.equal(p('https://127.0.0.1:8787'), false, 'https is the slow variant');
  assert.equal(p('http://127.0.0.1'), false, 'portless defaults are last');
  assert.equal(p('http://192.168.1.10:8787'), false, 'LAN IPs are stage 2');
});

// ---------- shared server-filename guard ----------
// files.js replaced three hand-synced copies (background/popup/content). A drift
// between them is security-relevant: this is what keeps `../settings.json` or an
// absolute URL out of a /media fetch.
const { PPFiles } = load('files.js');

test('PPFiles: accepts server filenames + t- thumbnails, refuses traversal shapes', () => {
  assert.equal(PPFiles.valid('1789000000000-a1b2c3.jpg'), true);
  assert.equal(PPFiles.valid('1789000000000-a1b2c3.webp'), true);
  assert.equal(PPFiles.valid('t-1789000000000-a1b2c3.jpg'), true, 'thumbnail form');
  assert.equal(PPFiles.valid('../settings.json'), false, 'path separator');
  assert.equal(PPFiles.valid('..%2Fsettings.json'), false, 'percent escape');
  assert.equal(PPFiles.valid('http://evil.test/x.jpg'), false, 'absolute URL');
  assert.equal(PPFiles.valid('a b.jpg'), false, 'whitespace');
  assert.equal(PPFiles.valid(''), false);
  assert.equal(PPFiles.valid(null), false);
  assert.equal(PPFiles.valid(undefined), false);
  // dot-segments alone are refused too: `/media/..` normalizes to `/`
  assert.equal(PPFiles.valid('..'), false);
  assert.equal(PPFiles.valid('.'), false);
  assert.equal(PPFiles.valid('t-..'), false);
});

test('PPFiles.safe: returns an encoded name or throws — never a partial path', () => {
  assert.equal(PPFiles.safe('1789000000000-a1b2c3.jpg'), '1789000000000-a1b2c3.jpg');
  assert.equal(PPFiles.safe('t-1789000000000-a1b2c3.jpg'), 't-1789000000000-a1b2c3.jpg');
  for (const bad of ['../x.jpg', '/etc/passwd', 'http://evil.test/x.jpg', '', null, '..']) {
    assert.throws(() => PPFiles.safe(bad), /bad filename/, `must refuse ${JSON.stringify(bad)}`);
  }
});

// ---------- paste logic ----------
const { PPPasteLogic } = load('paste-logic.js');

test('pasteFileName: capture id + mime → proofpipe-<id>.<ext>, jpeg normalized to jpg', () => {
  assert.equal(PPPasteLogic.pasteFileName(42, 'image/jpeg'), 'proofpipe-42.jpg');
  assert.equal(PPPasteLogic.pasteFileName(7, 'image/png'), 'proofpipe-7.png');
  assert.equal(PPPasteLogic.pasteFileName(9, 'image/webp'), 'proofpipe-9.webp');
  assert.equal(PPPasteLogic.pasteFileName(3, ''), 'proofpipe-3.jpg', 'missing mime falls back to jpg');
  assert.equal(PPPasteLogic.pasteFileName(3, undefined), 'proofpipe-3.jpg');
});

test('dragFile: the tray drag declares the capture\'s REAL mime + extension', () => {
  const d = PPPasteLogic.dragFile;
  // compared field-by-field (flattened): the result is born in the VM realm, so
  // deepStrictEqual would reject it on prototype identity alone — the same trap
  // fab-hide-show.test.js documents for its message reply
  const spec = (id, file) => { const s = d(id, file); return `${s.mime} ${s.filename}`; };
  // the stored name's extension IS the original's format (server/store.js keeps
  // each capture in the format it arrived in and names the file for it)
  assert.equal(spec(42, '1789373928237-lcfvj5.jpg'), 'image/jpeg proofpipe-42.jpg');
  assert.equal(spec(7, '1789376112132-5tvxzu.jpeg'), 'image/jpeg proofpipe-7.jpg', 'jpeg normalizes to jpg, like pasteFileName');
  assert.equal(spec(8, 'shot.png'), 'image/png proofpipe-8.png');
  assert.equal(spec(9, 'pic.WEBP'), 'image/webp proofpipe-9.webp', 'extension match is case-insensitive');
  assert.equal(spec(11, 'iphone.HEIC'), 'image/heic proofpipe-11.heic');
  assert.equal(spec(12, 'scan.tif'), 'image/tiff proofpipe-12.tif');
  // unknown/absent extension keeps the old jpeg fallback rather than a guess
  assert.equal(spec(3, 'mystery'), 'image/jpeg proofpipe-3.jpg');
  assert.equal(spec(3, undefined), 'image/jpeg proofpipe-3.jpg');
});

test('needsPngRetry: only non-PNG originals trigger the PNG re-encode retry', () => {
  assert.equal(PPPasteLogic.needsPngRetry('image/jpeg'), true);
  assert.equal(PPPasteLogic.needsPngRetry('image/webp'), true);
  assert.equal(PPPasteLogic.needsPngRetry('image/png'), false);
  assert.equal(PPPasteLogic.needsPngRetry(''), true);
});

test('isSelfPasteTarget: the harness loop is refused on ANY loopback form/port shape', () => {
  const p = PPPasteLogic.isSelfPasteTarget;
  // the pasted-into-harness loop (1 photo → 5 captures)
  assert.equal(p('http://127.0.0.1:8787/'), true);
  assert.equal(p('http://localhost:8787/'), true);
  assert.equal(p('https://localhost:8787/'), true);
  assert.equal(p('http://127.0.0.1:8799/upload'), true, 'any port on loopback refuses');
  // the pinned port must refuse even on a non-loopback spelling (LAN IP form)
  assert.equal(p('http://192.168.1.10:8787/', { pinnedPort: 8787 }), true, 'pinned port refuses');
  assert.equal(p('http://192.168.1.10:8787/', { pinnedPort: 8788 }), false, 'other ports on LAN IPs are fine');
  // normal chat sites never refuse
  assert.equal(p('https://claude.ai/new'), false);
  assert.equal(p('https://chatgpt.com/'), false);
  assert.equal(p('https://gemini.google.com/app'), false);
  // garbage URLs refuse nothing (fall through to normal paste)
  assert.equal(p('not a url'), false);
  // non-http(s) schemes (the SW already blocks chrome* pages upstream)
  assert.equal(p('chrome-extension://abc/popup.html'), false);
});

// snapshot/insertedAnywhere need a document — run in a VM with a minimal DOM
// fake that models exactly what the check reads: body text, per-selector
// counts, shadow roots, and an editor whose length can grow.
function domContext({ editorHTML = '', bodyExtra = '', imgs = 0, canvases = 0, blobs = 0, chipText = '' } = {}) {
  const elements = [
    ...Array.from({ length: imgs }, () => ({ matches: sel => sel === 'img', shadowRoot: null, textContent: '' })),
    ...Array.from({ length: canvases }, () => ({ matches: sel => sel === 'canvas', shadowRoot: null, textContent: '' })),
    ...Array.from({ length: blobs }, () => ({ matches: sel => sel === '[src^="blob:"]', shadowRoot: null, textContent: '' })),
    ...Array.from({ length: imgs + canvases + blobs }, (_, i) => i).map(() => ({ matches: () => false, shadowRoot: null, textContent: '' })),
  ];
  const ctx = {
    self: {},
    URL,
    document: {
      querySelectorAll: sel => elements.filter(e => e.matches(sel)),
      body: { textContent: chipText + bodyExtra },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(APP, 'extension', 'paste-logic.js'), 'utf8'), ctx);
  const target = {
    isContentEditable: true,
    get innerHTML() { return editorHTML; },
  };
  return { logic: ctx.self.PPPasteLogic, target };
}

test('insertedAnywhere: editor length growth is detected', () => {
  const before = domContext({ editorHTML: 'hello' });
  const base = before.logic.snapshot(before.target);
  const after = domContext({ editorHTML: 'hello world', bodyExtra: '' });
  assert.equal(after.logic.insertedAnywhere(after.target, 'proofpipe-1.jpg', base), true);
  assert.equal(before.logic.insertedAnywhere(before.target, 'proofpipe-1.jpg', base), false, 'no change → no insert');
});

test('insertedAnywhere: an attachment-chip FILENAME in the page text counts (DeepSeek case)', () => {
  // editor length unchanged, no new img/canvas — only the chip label appears
  const base = domContext({ editorHTML: '' }).logic.snapshot(domContext({ editorHTML: '' }).target);
  const after = domContext({ editorHTML: '', chipText: 'proofpipe-42.jpg' });
  assert.equal(after.logic.insertedAnywhere(after.target, 'proofpipe-42.jpg', base), true, 'chip filename must be detected');
  assert.equal(after.logic.insertedAnywhere(after.target, 'proofpipe-99.jpg', base), false, 'a DIFFERENT filename must not count');
});

test('insertedAnywhere: new <img>, canvas, and blob: URLs each count (PITFALLS #6 full list)', () => {
  for (const [key, opts] of [['imgs', { imgs: 1 }], ['canvases', { canvases: 1 }], ['blobs', { blobs: 1 }]]) {
    const baseCtx = domContext({});
    const base = baseCtx.logic.snapshot(baseCtx.target);
    const after = domContext(opts);
    assert.equal(after.logic.insertedAnywhere(after.target, 'proofpipe-1.jpg', base), true, `${key} growth must be detected`);
  }
});

test('insertedAnywhere: shadow-DOM text is found (hosts hide it from body.textContent)', () => {
  const baseCtx = domContext({});
  const base = baseCtx.logic.snapshot(baseCtx.target);
  // fake a shadow host: querySelectorAll('*') returns it, its shadowRoot holds the filename
  const ctx = {
    self: {},
    document: {
      querySelectorAll: sel => sel === '*' ? [{ shadowRoot: { textContent: 'proofpipe-7.jpg' } }] : [],
      body: { textContent: 'no chip here' },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(APP, 'extension', 'paste-logic.js'), 'utf8'), ctx);
  assert.equal(ctx.self.PPPasteLogic.insertedAnywhere({ isContentEditable: true, innerHTML: '' }, 'proofpipe-7.jpg', base), true, 'shadow-root text must be detected');
});

test('mutationMayContainInsert: filters unrelated mutations but preserves uncertain and relevant paths', () => {
  const logic = PPPasteLogic.mutationMayContainInsert;
  const target = { contains: node => node === 'inside' };
  const quietNode = { nodeType: 1, textContent: 'typing indicator', matches: () => false, querySelector: () => null, shadowRoot: null };
  assert.equal(logic([{ type: 'childList', target: {}, addedNodes: [quietNode] }], target, 'proofpipe-1.jpg'), false,
    'unrelated page churn must not trigger a full verification scan');
  const insertedNode = { nodeType: 1, textContent: 'attachment proofpipe-1.jpg', matches: () => false, querySelector: () => null, shadowRoot: null };
  assert.equal(logic([{ type: 'childList', target: {}, addedNodes: [insertedNode] }], target, 'proofpipe-1.jpg'), true,
    'a filename in an inserted subtree must trigger verification');
  assert.equal(logic([{ type: 'characterData', target: 'inside' }], target, 'proofpipe-1.jpg'), null,
    'an edit inside the target remains uncertain and uses the original broad fallback');
  assert.equal(logic([{ type: 'attributes', attributeName: 'src', target: {} }], target, 'proofpipe-1.jpg'), true,
    'media URL changes remain relevant');
});

// ---------- browser-target (auto-paste follows the PC "Open harness in" pick) ----------
const { PPBrowserTarget } = load('browser-target.js');

test('myBrowserId: Edge UA → edge, Chrome/others → chrome', () => {
  assert.equal(PPBrowserTarget.myBrowserId('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'), 'edge');
  assert.equal(PPBrowserTarget.myBrowserId('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'), 'chrome');
  assert.equal(PPBrowserTarget.myBrowserId(''), 'chrome');
  assert.equal(PPBrowserTarget.myBrowserId(undefined), 'chrome');
});

test('shouldAutoPaste: selected browser pastes, the other stands down, default pastes anywhere', () => {
  const t = PPBrowserTarget.shouldAutoPaste;
  assert.equal(t('edge', 'edge'), true, 'Edge instance pastes an Edge-tagged event');
  assert.equal(t('edge', 'chrome'), false, 'Chrome instance ignores an Edge-tagged event');
  assert.equal(t('chrome', 'chrome'), true, 'Chrome instance pastes a Chrome-tagged event');
  assert.equal(t('chrome', 'edge'), false, 'Edge instance ignores a Chrome-tagged event');
  assert.equal(t('default', 'chrome'), true, 'default tag pastes everywhere (OS default not visible to extensions)');
  assert.equal(t('default', 'edge'), true);
  assert.equal(t(undefined, 'chrome'), true, 'missing tag (pre-tag server) pastes — back-compat');
  assert.equal(t('', 'edge'), true);
  assert.equal(t('firefox', 'chrome'), false, 'Firefox pick pastes nowhere in Chromium (no extension there)');
  assert.equal(t('firefox', 'edge'), false);
  assert.equal(t('EDGE', 'edge'), true, 'case-insensitive');
});

test('shouldAutoPaste: every Chromium harness pick routes to the chrome instance (regression)', () => {
  // server/browser.js lists brave/opera/vivaldi/chromium in its "Open harness
  // in" CANDIDATES. Their UAs are indistinguishable from Chrome, so a pick
  // naming any of them must paste in the chrome-family instance instead of
  // falling through to `false` for BOTH instances — that tag reached no
  // extension and auto-paste silently died for those picks.
  const t = PPBrowserTarget.shouldAutoPaste;
  for (const pick of ['brave', 'opera', 'vivaldi', 'chromium']) {
    assert.equal(t(pick, 'chrome'), true, `${pick} pick must paste in the chrome instance`);
    assert.equal(t(pick, 'edge'), false, `${pick} pick must NOT double-paste in the edge instance`);
  }
  // an unknown/uninstallable pick still pastes nowhere
  assert.equal(t('safari', 'chrome'), false);
  assert.equal(t('safari', 'edge'), false);
});

test('shouldAutoPaste covers every browser id the harness can emit (drift guard)', () => {
  // The two lists must not drift: server/browser.js decides which ids land in
  // settings.browser (stamped onto auto SSE events as autoTarget), and this
  // gate decides whether any extension pastes them. A Chromium-family id the
  // gate does not recognize means auto-paste silently stops for that pick.
  const src = fs.readFileSync(path.join(APP, 'server', 'browser.js'), 'utf8');
  const ids = [...src.matchAll(/\bid:\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(ids.length >= 2, `expected harness browser ids, got ${ids.join(', ')}`);
  const t = PPBrowserTarget.shouldAutoPaste;
  for (const id of ids) {
    const pastesSomewhere = t(id, 'chrome') || t(id, 'edge');
    if (id === 'firefox') {
      assert.equal(pastesSomewhere, false, `${id} cannot host the Chromium extension — must paste nowhere`);
    } else {
      assert.equal(pastesSomewhere, true, `harness can pick "${id}" — auto-paste must land in an instance`);
    }
  }
});

// ---------- loader wiring (the silent-shipping-bug guard) ----------
// The 0.7.0 refactor extracted shared modules but forgot to add discovery.js
// to the manifest's content_scripts and popup.html — content.js/popup.js
// called PPDiscovery.* and every tray/popup interaction died with a
// ReferenceError. These tests fail the build if any context consumes a
// shared global without its provider script loaded BEFORE the consumer.
test('every content/popup script chain provides the globals its consumers use', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'extension', 'manifest.json'), 'utf8'));
  const contentScripts = manifest.content_scripts.flatMap(cs => cs.js);
  const popupScripts = [...fs.readFileSync(path.join(APP, 'extension', 'popup.html'), 'utf8')
    .matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  const offscreenScripts = [...fs.readFileSync(path.join(APP, 'extension', 'offscreen.html'), 'utf8')
    .matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);

  // global -> provider file -> consumers that reference it
  const contracts = [
    { global: 'PPDiscovery', provider: 'discovery.js', consumers: ['content.js', 'popup.js', 'offscreen.js', 'background.js'] },
    { global: 'PPPasteLogic', provider: 'paste-logic.js', consumers: ['content.js'] },
    { global: 'PPBrowserTarget', provider: 'browser-target.js', consumers: ['background.js', 'offscreen.js'] },
    { global: 'toPng', provider: 'toPng.js', consumers: ['content.js', 'popup.js'] },
    { global: 'PPFiles', provider: 'files.js', consumers: ['content.js', 'popup.js', 'background.js'] },
  ];
  for (const { global, provider, consumers } of contracts) {
    const uses = (file, src) => src.includes(global);
    // content scripts: provider must appear in the same content_scripts js
    // list, strictly BEFORE any consumer
    for (const consumer of consumers) {
      const consumerSrc = fs.readFileSync(path.join(APP, 'extension', consumer), 'utf8');
      if (!uses(consumer, consumerSrc)) continue; // consumer doesn't use it — fine
      if (consumer === 'background.js') {
        // background uses importScripts — check it's imported there
        assert.ok(new RegExp(`importScripts\\(['"]${provider.replace('.', '\\.')}['"]\\)`).test(consumerSrc),
          `background.js uses ${global} but never importScripts ${provider}`);
        continue;
      }
      const chains = [
        ['content_scripts', contentScripts],
        ['popup.html', popupScripts],
        ['offscreen.html', offscreenScripts],
      ];
      const inChain = chains.some(([, scripts]) => {
        const pi = scripts.indexOf(provider);
        const ci = scripts.indexOf(consumer);
        return pi !== -1 && ci !== -1 && pi < ci;
      });
      // background.js handled above; every other consumer must be in a chain
      // that loads the provider first (offscreen consumes PPDiscovery via
      // offscreen.js, popup via popup.js, pages via content.js)
      if (consumer === 'offscreen.js') {
        const pi = offscreenScripts.indexOf(provider);
        const ci = offscreenScripts.indexOf(consumer);
        assert.ok(pi !== -1 && ci !== -1 && pi < ci,
          `offscreen.js uses ${global} but offscreen.html doesn't load ${provider} before it`);
      } else {
        assert.ok(inChain,
          `${consumer} uses ${global} but no loader chain (manifest/popup.html) loads ${provider} before it`);
      }
    }
    // and the provider file must actually define the global it promises
    const providerSrc = fs.readFileSync(path.join(APP, 'extension', provider), 'utf8');
    assert.ok(providerSrc.includes(`self.${global}`) || providerSrc.includes(`const ${global}`),
      `${provider} must define ${global}`);
  }
});

// ---------- extension surfaces announce themselves ----------
// Both of these were unlabelled in the shipped UI: the popup declared no
// language (WCAG 3.1.1 — a screen reader picks a pronunciation from it) and the
// tray's send control used its own glyph as its accessible name, which is
// announced verbosely and renders per-OS. The tray is a closed shadow root, so
// the shipped source is the only place these can be pinned.
test('extension: popup declares its language and the tray controls carry names', () => {
  const popupHtml = fs.readFileSync(path.join(APP, 'extension', 'popup.html'), 'utf8');
  assert.match(popupHtml, /<html lang="en">/);
  assert.match(popupHtml, /<meta name="color-scheme" content="dark">/);

  const contentJs = fs.readFileSync(path.join(APP, 'extension', 'content.js'), 'utf8');
  assert.match(contentJs, /class="txtsend" title="Send text to phone" aria-label="Send text to phone"/);
  assert.match(contentJs, /:host \{ all: initial; color-scheme: dark;/, 'the tray does not inherit a light host page');
  assert.match(contentJs, /class="icon-btn reload" title="Reload captures" aria-label="Reload captures"/);
  // decorative svgs must not contribute to a name, and no bare glyph may BE one
  for (const name of ['fab', 'icon-btn sync', 'icon-btn reload', 'txtsend']) {
    const el = new RegExp(`class="${name.replace('-', '\\-')}"[^>]*>[\\s\\S]{0,240}?<svg([^>]*)>`).exec(contentJs);
    assert.ok(el, `${name} renders an svg`);
    assert.match(el[1], /aria-hidden="true"/, `${name}'s svg is decorative`);
  }
  assert.ok(!/\u27a4/.test(contentJs), 'no bare glyph as a button name');
});

// ---------- the tray drag carries the ORIGINAL, never the grid thumbnail ----------
// Dragging a capture out of the p-tray used to arrive as a 400px image: the
// dragged element was the thumbnail <img>, and Blink attaches a dragged
// <img>'s OWN bytes to the drag (DataObject::WriteImageToDataObject →
// AddFileSharedBuffer). Chromium only prefers the declared DownloadURL over
// those bytes when it can actually fetch it, so the thumbnail was the silent
// fallback — with the transfer-quality setting OFF, nothing to do with it.
// Both invariants below are pinned from the SHIPPED SOURCE because the tray is
// a closed shadow root: a test cannot reach its cells from outside.
test('extension: the tray drag declares the ORIGINAL media URL and never drags the thumbnail', () => {
  const contentJs = fs.readFileSync(path.join(APP, 'extension', 'content.js'), 'utf8');
  // the dragstart HANDLER body — the code under test, with the file's header
  // comment and the other listeners excluded
  const dragstart = contentJs.slice(contentJs.indexOf("addEventListener('dragstart'"), contentJs.indexOf("addEventListener('dragend'"));
  assert.ok(dragstart.length > 0, 'the dragstart handler exists');

  // 1. the drag's ONE file URL is the stored ORIGINAL
  assert.ok(contentJs.includes('const originalUrl = `${SERVER}/media/${encodeURIComponent(c.file)}`;'),
    'the drag URL must be built from the stored original (/media/<c.file>)');
  const payload = /setData\('DownloadURL', `([^`]+)`\)/.exec(contentJs);
  assert.ok(payload, 'the tray declares a DownloadURL drag payload');
  assert.match(payload[1], /\$\{originalUrl\}$/,
    `the DownloadURL must point at that original — got: ${payload[1]}`);
  // ...declared with the capture's REAL format, never a hardcoded image/jpeg
  assert.match(payload[1], /^\$\{mime\}:\$\{filename\}:/,
    `the drag must declare the real mime/filename — got: ${payload[1]}`);
  assert.match(contentJs, /PPPasteLogic\.dragFile\(idSlug, c\.file\)/,
    'the real format must come from the shared PPPasteLogic.dragFile helper');
  assert.ok(!payload[1].includes('image/jpeg:'), 'no hardcoded jpeg type in the payload');
  // ...and NO second string format rides along. Chromium on Windows breaks the
  // WHOLE drag when one of several setData() types is DownloadURL (crbug
  // 40459758), and the native image drag's text/uri-list is not missed anyway:
  // it named a URL only this PC can resolve. See PITFALLS #56.
  // (scanned in the HANDLER, not the file: the header comment discusses the same
  //  API by name, and a guard that a comment can trip is a guard that lies)
  const stringFormats = [...dragstart.matchAll(/setData\('([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(stringFormats, ['DownloadURL'],
    `the drag store must carry ONE string format, got: ${stringFormats.join(', ') || 'none'}`);
  assert.ok(!payload[1].includes('/media/t-'),
    'the DownloadURL must never point at the derived thumbnail');
  // ...and no drag payload anywhere in the tray may carry a thumbnail name
  assert.ok(!dragstart.includes('t-${'), 'the drag must not build a thumbnail URL');

  // 1b. ...BUT THE BYTES DO NOT COME FROM THE STORE. They come from the dragged
  //     IMAGE, because that is the only payload a drop in the SAME document can
  //     read. Measured with real drags in real Chrome, every shape dispatched
  //     side by side from one page (dev/ext-tray-probe.mjs):
  //       · setData('DownloadURL') alone  → the drop's store is EMPTY.
  //       · items.add(new File([blob], …)) → the drop gets the FILENAME as
  //         text/plain and NO file item; no bytes travel at all.
  //       · a dragged <img>                → the drop gets a real File of that
  //         image's own ENCODED bytes, byte-for-byte (an image loaded from a
  //         blob: URL contributes exactly the blob's bytes, hash-verified), and
  //         a DownloadURL set beside it does not disturb the file.
  //     So the DownloadURL above is the OS-drop / cross-tab entry, never the
  //     reason an in-page chat box gets the capture — and a File entry is worse
  //     than useless there: it silently replaces the payload with a filename.
  //     This is the mistake that broke the tray: the handler used to set exactly
  //     DownloadURL + a File, so a chat box received a bare filename.
  assert.ok(!dragstart.includes('items.add('),
    'a File entry does NOT deliver bytes to an in-page drop — it delivers the filename (measured)');
  assert.ok(!dragstart.includes('new File('),
    'no File belongs in the drag store: a blob-backed one degrades to a text/plain filename');

  // 1c. THE DRAG SOURCE IS THE TILE'S <img>, and it is UPGRADED TO THE ORIGINAL.
  //     Blink writes a dragged <img>'s own loaded bytes (the encoded resource)
  //     into the store, so whatever that image has loaded is what the drop gets.
  assert.match(contentJs, /img\.draggable = true;/,
    "the tile's <img> must be the drag source — an image drag is the only shape a drop in the same document reads");
  assert.match(contentJs, /\.cell \.thumb \{ -webkit-user-drag: auto; \}/,
    'the tile image must keep -webkit-user-drag: auto — none silently empties every drag');
  assert.match(contentJs, /function upgradeTile\(c, img\)/,
    'the hovered tile must be upgraded so the dragged image IS the stored original');
  assert.match(contentJs, /let url = fullUrls\.get\(c\.id\);/,
    'the upgrade must reuse ONE object URL per capture (a fresh one per hover would pin every blob)');
  assert.match(contentJs, /url = URL\.createObjectURL\(blob\);/,
    'the upgrade must point the image at the cached ORIGINAL blob — a local load, no re-encode');
  // hover AND press arm it: the pointer must aim before it can drag, and one that
  // lands on the tile without an "enter" still gets its chance
  assert.match(contentJs, /pointerenter', \(\) => upgradeTile\(c, img\)/,
    'hover must upgrade the tile image to the original before a grab can start');
  assert.match(contentJs, /addEventListener\('mousedown',[\s\S]{0,400}?upgradeTile\(c, img\)/,
    'press must arm the upgrade too');
  // text selection must not be "suppressed" in JS on the tile: canceling
  // selectstart aborts drag initiation on draggable elements (this repo's v0.3.5
  // bug), and user-select:none CSS plus the pointer-events:none id chip already
  // make a selection impossible here.
  assert.ok(!contentJs.includes("addEventListener('selectstart'"),
    'never cancel selectstart on a drag source — it aborts the drag (v0.3.5)');

  // 2. the derived 400px thumbnail is DISPLAY-only: it may be the drag VISUAL,
  //    never a payload entry, and an evicted original must drop the tile back to
  //    it rather than leave a broken image
  assert.ok(!/setData\([^)]*thumbs|new File\(\[[^\]]*thumbs/.test(dragstart),
    'no derived 400px image may enter the payload (the thumbnail is only the drag visual)');
  assert.match(contentJs, /function releaseFullUrl\(id\)/,
    'an evicted original must release its object URL and drop the tile back to the thumbnail');
  // ...but never at the price of a broken tile: with no thumbnail in hand the
  // blob stays pinned and the image keeps rendering
  assert.match(contentJs, /if \(showing\) \{\s*\n\s*const thumb = thumbs\.get\(id\);\s*\n\s*if \(!thumb\) return;/,
    'releaseFullUrl must not revoke an original a tile is still showing with no thumbnail to fall back to');
  // "showing the original" means LOADED: the payload is the loaded resource, so a
  // src that is still in flight is still the thumbnail to a drag
  assert.match(contentJs, /img\.dataset\.upgrading = url;/,
    'the upgrade must track the assigned-but-not-yet-loaded window');
  // ...and the drag reports which of the two it carried, instead of downgrading
  // a capture silently
  assert.match(contentJs, /payloadWasOriginal = !!img\.dataset\.original;/,
    "dragstart must record whether the payload is the original — the image is the payload");
  assert.match(contentJs, /went out as the 400px preview/,
    'a drag that carried the derived thumbnail must say so rather than look identical to a full-quality one');
  assert.ok(!contentJs.includes('warmDragSource'),
    'there is no separate drag-source warming path: the tile image is the source');
});

// ---------- the drag's declared server origin must never go stale ----------
// The drag's DownloadURL is fetched by Chrome ITSELF, so a SERVER left pointing
// at the wrong loopback origin (custom PORT, or http vs https) fails that fetch
// silently while every other tray path keeps working — the one failure mode the
// drag cannot report. Two guards keep SERVER honest: the pinned-host read only
// latches on SUCCESS, and every direct fetch adopts the origin that answered.
test('extension: the tray keeps its drag SERVER origin live', () => {
  const contentJs = fs.readFileSync(path.join(APP, 'extension', 'content.js'), 'utf8');

  // 1. the getHost latch sits INSIDE the try: a failed read (SW asleep on the
  //    first load) must retry on the next load instead of pinning the built-in
  //    default for the page's whole life
  const block = contentJs.slice(contentJs.indexOf('if (!serverHostSynced)'),
    contentJs.indexOf('cheap fingerprint first'));
  assert.ok(block.includes("await bg({ type: 'getHost' })"), 'the tray reads the pinned host');
  assert.ok(block.indexOf('serverHostSynced = true;') < block.indexOf('} catch {'),
    'serverHostSynced must latch INSIDE the try — a failed read must retry next load');

  // 2. ONE adopter, allowlisted, used by every direct fetch that answers
  assert.match(contentJs, /function adoptServer\(base\) \{\s*\n\s*if \(base !== SERVER && HOST_RE\.test\(base\)\) SERVER = base;/,
    'adoptServer must keep the loopback allowlist');
  const adopters = [...contentJs.matchAll(/adoptServer\(base\)/g)].length;
  assert.ok(adopters >= 3,
    `captures, captures/version and media must all adopt the serving origin (got ${adopters})`);
});

// ---------- the tray's text list cannot freeze while it is open ----------
// /api/captures/version publishes `textId` "so poll-fallback clients notice text
// changes too", the tray polled that route every 5s, and it threw the text
// fingerprint away while rendering the list ONLY when the tray opened. So a text
// sent from the phone while the tray was open never appeared: the one phone→PC
// surface in the panel looked live and was frozen. The same function also asked
// its two transports for different row counts (the SW relay 10, the page-side
// fallback 5), which is the "private copy that drifted" class again — invisible,
// and only reachable on the path taken when the relay fails.
test('extension: a text can reach the open tray, from either transport, with one row count', () => {
  const contentJs = fs.readFileSync(path.join(APP, 'extension', 'content.js'), 'utf8');
  const bgJs = fs.readFileSync(path.join(APP, 'extension', 'background.js'), 'utf8');

  // 1. the poll acts on the text fingerprint the server already sends...
  assert.match(contentJs, /if \(v && v\.textId !== textsVersionId\) \{/,
    'the poll must act on the version response\'s textId — it is published for exactly this');
  // ...and BEFORE the unchanged-captures early return: a text changes while a
  // capture list does not, and that return is hit on most ticks
  const body = contentJs.slice(contentJs.indexOf('async function load()'), contentJs.indexOf('captures.slice(0, 5).forEach(prefetchFull)'));
  assert.ok(body.length > 0, 'load() exists');
  assert.ok(body.indexOf('v.textId !== textsVersionId') < body.indexOf('fp === capturesVersion'),
    'the text refresh must be decided before the unchanged-captures early return');

  // 2. one row count for both transports, owned by the caller
  assert.match(contentJs, /const TEXTS_LIMIT = 10;/,
    'the tray must own its text row count');
  assert.match(contentJs, /bg\(\{ type: 'texts', limit: TEXTS_LIMIT \}\)/,
    'the relay must be asked for the same count as the fallback');
  assert.match(contentJs, /api\/text\?source=phone&limit=\$\{TEXTS_LIMIT\}/,
    'the direct fallback must use that same count');
  assert.ok(!/limit=5/.test(contentJs), 'no transport may ask a different count');
  assert.match(bgJs, /Math\.min\(20, Math\.max\(1, Number\(msg\.limit\) \|\| 10\)\)/,
    'the relay must honor the requested count (clamped against the server cap, defaulting for the popup)');

  // 3. a 5s poll must not repaint what a human is reading: no placeholder flash,
  //    no rebuild of an identical list (that throws the scroll position away)
  const load = contentJs.slice(contentJs.indexOf('async function loadTexts'), contentJs.indexOf('async function sendText'));
  assert.ok(load.length > 0, 'loadTexts() exists');
  assert.match(load, /if \(!quiet\) \{ txtList\.innerHTML/,
    'the loading placeholder belongs to the loud (open) load only');
  assert.match(load, /if \(textsKey === key\) return;/,
    'an unchanged list must not be rebuilt');
  assert.match(load, /if \(textsKey !== null\) return;/,
    'a transient failure must keep the last good list, not paint over it');

  // 4. and the one race opening the tray creates (loud load vs the poll's quiet
  //    one) must be settled by a sequence, not by whoever wrote the key first
  assert.match(load, /const seq = \+\+textsSeq;/,
    'loadTexts must stamp each load');
  assert.match(load, /if \(seq !== textsSeq\) return;/,
    'a superseded load must not paint — otherwise the placeholder can stick');
});

// ---------- the copy's clipboard write must land inside the click ----------
// A 12MP capture takes SECONDS to encode to PNG (the only image format the
// clipboard API accepts) and Chromium's transient activation lasts about five.
// Awaiting the encode and then calling clipboard.write() meant a big capture had
// no activation left to spend, so a perfectly good copy reported itself blocked.
// The write now happens FIRST and is handed a PROMISE for the PNG, which the API
// accepts while the encode is still running — no extra work, no extra latency,
// and no change to the bytes (toPng only ever resizes what a canvas cannot hold).
test('extension: the tray starts the clipboard write before the PNG encode finishes', () => {
  const contentJs = fs.readFileSync(path.join(APP, 'extension', 'content.js'), 'utf8');
  const body = (start, end) => {
    const i = contentJs.indexOf(start);
    return i < 0 ? '' : contentJs.slice(i, contentJs.indexOf(end, i));
  };

  // the ONE write path hands the API the encode as a promise
  const write = body('async function writePngToClipboard', 'async function copyOriginal');
  assert.ok(write.length > 0, 'the tray has a single clipboard write path');
  assert.match(write, /const png = pngFor\(c\);/,
    'the write path must hold the encode as a PROMISE, not await it');
  assert.match(write, /new ClipboardItem\(\{ 'image\/png': png \}\)/,
    'the ClipboardItem must be given the promise — that is what keeps the write inside the activation');
  assert.ok(!/await pngFor\(c\);\s*\n\s*await navigator\.clipboard\.write/.test(write),
    'the encode must never be awaited before the clipboard write again');
  // ...and a build that refuses a promised blob still gets the bytes, just later
  assert.ok(write.includes("'image/png': await png "), /\(\{ 'image\/png': await png \)\]\)/,
    'a TypeError on the promised blob must fall back to the awaited form, not drop the copy');

  // every write in the tray is that one path — an independent write that forgot
  // the promise rule is exactly how this bug comes back
  for (const [start, end] of [
    ['async function copyOriginal', 'let capturesVersion'],
    ['async function copyAndHint', 'undelivered queue'],
    ['async function flushUndelivered', "addEventListener('focus'"],
  ]) {
    const fn = body(start, end);
    assert.ok(fn.length > 0, `${start} exists`);
    assert.ok(fn.includes('writePngToClipboard(c)'), `${start} must use the shared write path`);
    assert.ok(!fn.includes('navigator.clipboard.write('), `${start} must not write the clipboard itself`);
  }
  // the focus refusal is the one the user can act on — say so
  assert.match(contentJs, /e\.name === 'NotAllowedError'/,
    'a focus refusal must be reported as fixable (click the page), not as a dead copy');

  // ONE encode per capture: a second caller joins the in-flight one instead of
  // paying for a duplicate (a 48MP encode is seconds of the worker thread)
  assert.match(contentJs, /const pngPending = new Map\(\);/);
  assert.match(contentJs, /const inflight = pngPending\.get\(c\.id\);\s*\n\s*if \(inflight\) return inflight;/,
    'pngFor must return the in-flight encode, not start a duplicate');
  assert.match(contentJs, /\.finally\(\(\) => pngPending\.delete\(c\.id\)\)/,
    'the in-flight slot must be released whether the encode succeeded or failed');
});

// ---------- one encode per capture, and the RIGHT box to put it in ----------
// “Which element is the composer?” is where auto-paste actually failed: the old
// rule took the LAST editable candidate in DOM order, so a footer comment box
// below the composer won and the capture landed where nobody was looking.
test('extension: the tray finds the composer by size, not by DOM order', () => {
  const contentJs = fs.readFileSync(path.join(APP, 'extension', 'content.js'), 'utf8');

  // the editable spellings chat sites actually use — `contenteditable=""` IS
  // editable, `plaintext-only` is real, and some composers are role=textbox
  for (const sel of ['[contenteditable=""]', '[contenteditable="plaintext-only"]', '[role="textbox"]']) {
    assert.ok(contentJs.includes(sel), `${sel} must count as an editor`);
  }
  assert.match(contentJs, /const area = r\.width \* r\.height;/,
    'candidates must be ranked by visible area — a composer is big, a search box is not');
  assert.ok(!contentJs.includes('cands[cands.length - 1]'),
    'DOM order is not how a composer is identified');
  assert.match(contentJs, /if \(isEditor\(a\)\) return a;/,
    'the focused editor is still the first choice — that is where the caret is');
  assert.match(contentJs, /return best \|\| document\.body;/,
    'with no editor at all, body still gets a shot (document-level paste handlers)');

  // the blob the SW relay fetched is KEPT, so the PNG retry does not refetch it
  const raw = contentJs.slice(contentJs.indexOf('async function rawFor'),
    contentJs.indexOf('async function copyAndHint'));
  assert.ok(raw.includes('blobs.set(c.id, blob)'), 'rawFor must keep the blob it fetched');
});

// ---------- the keyboard gets the drag, not just the clipboard ----------
// A drag delivers the capture straight into the page's own editor. The keyboard
// used to be able to copy only, which leaves a Ctrl+V still owed — and needs the
// page focused to boot. Ctrl/⌘+Enter now reuses the auto-paste path whole.
test('extension: Ctrl+Enter transfers a capture straight into the chat', () => {
  const contentJs = fs.readFileSync(path.join(APP, 'extension', 'content.js'), 'utf8');

  assert.match(contentJs, /if \(e\.ctrlKey \|\| e\.metaKey\) pasteIntoTarget\(c\);/,
    'Ctrl/⌘+Enter must take the paste path');
  assert.match(contentJs, /else copyOriginal\(c\);\s*\n\s*\}/,
    'plain Enter/Space must stay copy-to-clipboard, which is what the tooltip promises');
  const paste = contentJs.slice(contentJs.indexOf('async function pasteIntoTarget'),
    contentJs.indexOf('function pasteAttempt'));
  assert.ok(paste.length > 0, 'pasteIntoTarget exists');
  assert.ok(paste.includes('await autoPasteCapture(c)'),
    'the keyboard path must reuse the auto-paste path whole (target discovery, PNG retry, fallbacks)');

  // ...and the affordance is ANNOUNCED: the tooltip, the aria-label and the
  // resting status line all name it, because a keyboard path nothing advertises
  // is the "hidden feature" PITFALLS keeps recording
  assert.ok(contentJs.includes('Ctrl+Enter to paste it into the chat'), 'the aria-label names the shortcut');
  assert.ok(contentJs.includes('press Ctrl+Enter into the chat box'), 'the tooltip names the shortcut');
  assert.match(contentJs, /const IDLE_STATUS = '[^']*Ctrl\+Enter/,
    'the tray\'s resting hint names the shortcut');
  assert.ok(!contentJs.includes("setStatus('drag → chat · click = copy')"),
    'the idle hint is one string, so a load and a drag end cannot disagree');
});
