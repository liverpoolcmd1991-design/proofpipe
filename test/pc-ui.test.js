// Desktop workbench (/) and built-in What's New modal window UI surface tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workbenchHtml = fs.readFileSync(path.join(APP, 'public/index.html'), 'utf8');
const workbenchCss = fs.readFileSync(path.join(APP, 'public/style.css'), 'utf8');
const workbenchJs = fs.readFileSync(path.join(APP, 'public/app.js'), 'utf8');
const sharedJs = fs.readFileSync(path.join(APP, 'public/shared.js'), 'utf8');
const releasesJs = fs.readFileSync(path.join(APP, 'public/releases.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional */ }
const skipOpt = JSDOM ? false : 'jsdom not installed — run `npm i -D jsdom` to enable';

test('desktop workbench: shell carries required stamps, Messages & Clipboard dock, rail, captures grid, files section, and What\'s New modal trigger', { skip: skipOpt }, () => {
  const dom = new JSDOM(workbenchHtml);
  const d = dom.window.document;

  assert.equal(d.querySelector('meta[name="color-scheme"]')?.getAttribute('content'), 'dark');
  assert.equal(d.querySelector('meta[name="app-version"]')?.getAttribute('content'), '__PP_VERSION__');
  assert.match(d.querySelector('link[rel="stylesheet"]')?.getAttribute('href') || '', /^\/style\.css\?v=__ASSET_STYLE__$/);
  assert.ok(d.querySelector('script[src^="/shared.js?v=__ASSET_SHARED__"]'), 'workbench shared.js script stamp exists');
  assert.ok(d.querySelector('script[src^="/releases.js?v=__ASSET_RELEASES__"]'), 'workbench releases.js script stamp exists');
  assert.ok(d.querySelector('script[src^="/app.js?v=__ASSET_APP__"]'), 'workbench app.js script stamp exists');

  // Ensure the 3 colored dots are removed
  assert.equal(d.querySelector('.window-lights'), null, 'no traffic-light dots in topbar');

  // What's New modal trigger button & modal backdrop
  const wnBtn = d.querySelector('#whats-new-btn');
  assert.ok(wnBtn, 'desktop workbench header has #whats-new-btn trigger');
  assert.equal(wnBtn.getAttribute('aria-controls'), 'whats-new-backdrop');
  const wnBackdrop = d.querySelector('#whats-new-backdrop');
  assert.ok(wnBackdrop, '#whats-new-backdrop modal exists');
  assert.ok(wnBackdrop.classList.contains('hidden'), '#whats-new-backdrop starts hidden like Settings');

  // Workbench landmarks & controls
  assert.ok(d.querySelector('#composer-section'), 'dedicated Messages & Clipboard card exists');
  assert.ok(d.querySelector('#text-input'), 'bi-directional text composer exists');
  assert.ok(d.querySelector('#text-send'), 'send text button exists');
  assert.ok(d.querySelector('#texts-btn'), 'text history dialog trigger exists');
  assert.ok(d.querySelector('#rail'), 'status and pairing rail exists');
  assert.ok(d.querySelector('#qr'), 'pairing QR image exists');
  assert.ok(d.querySelector('#grid'), 'captures grid exists');
  assert.ok(d.querySelector('#file-list'), 'transferred files list exists');
  assert.ok(d.querySelector('#settings-backdrop'), 'settings modal exists');
  assert.ok(d.querySelector('#lightbox'), 'lightbox preview modal exists');

  // Ensure no native <select> or multi-IP dropdown bar exists
  assert.equal(d.querySelectorAll('select').length, 0, 'no native OS <select> elements in desktop workbench');
  assert.equal(d.querySelector('#nic-sel'), null, 'no multi-IP dropdown bar in pairing card');
  assert.ok(d.querySelector('#capture-sort.glass-select'), 'capture sort uses custom Liquid Glass popover menu');
  assert.ok(d.querySelector('#set-browser.glass-select'), 'browser selector uses custom Liquid Glass popover menu');

  const cssNoComments = workbenchCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(cssNoComments, /#text-input\s*\{[^}]*max-height:\s*var\(--tb-ctl\)/);
  assert.match(cssNoComments, /#text-input\s*\{[^}]*overflow:\s*hidden/);
  assert.match(cssNoComments, /\.glass-select-menu\s*\{/);
  assert.match(workbenchJs, /new EventSource\('\/events'\)/);
  assert.ok(d.querySelector('#pc-confirm-backdrop'), 'PC workbench includes destructive confirmation modal');
  assert.ok(d.querySelector('#pc-undo-toast'), 'PC workbench includes single-item undo snackbar');
  assert.ok(d.querySelector('#pc-transfer-pill'), 'PC workbench includes live transfer progress pill');
  assert.ok(d.querySelector('#copy-phone-url'), 'PC workbench includes copyable companion URL button');
  assert.equal(d.querySelector('#recent-card'), null, 'redundant sidebar recent-activity card is retired');
  assert.match(workbenchJs, /function uploadWithProgress\(/, 'PC uploads report live XHR byte progress');
});

test('whats-new modal window & Liquid Glass popover menus: open, filter/select, and close cleanly', { skip: skipOpt }, () => {
  const changelogMd = fs.readFileSync(path.join(APP, 'CHANGELOG.md'), 'utf8');
  assert.match(releasesJs, new RegExp(`version:\\s*'v${pkg.version.replace(/\./g, '\\.')}'`),
    `releases.js includes a release entry for current version v${pkg.version}`);
  assert.match(changelogMd, new RegExp(`^## \\[${pkg.version.replace(/\./g, '\\.')}\\]`, 'm'),
    `CHANGELOG.md includes a release section for current version ${pkg.version}`);

  const dom = new JSDOM(workbenchHtml, {
    url: 'http://localhost:8787/',
    runScripts: 'dangerously',
  });
  const { window } = dom;
  window.EventSource = class {
    constructor() {}
    close() {}
  };
  window.fetch = async () => ({
    ok: true,
    json: async () => ([]),
  });
  window.eval(sharedJs);
  window.eval(releasesJs);
  window.eval(workbenchJs);

  const d = window.document;
  const wnBtn = d.querySelector('#whats-new-btn');
  const wnBackdrop = d.querySelector('#whats-new-backdrop');
  const wnClose = d.querySelector('#whats-new-close');

  assert.ok(wnBackdrop.classList.contains('hidden'), 'What\'s New modal is initially hidden');
  wnBtn.click();
  assert.ok(!wnBackdrop.classList.contains('hidden'), 'clicking #whats-new-btn opens the What\'s New modal window');

  const cards = d.querySelectorAll('.release-card');
  assert.ok(cards.length >= 6, `renders chronological release cards (found ${cards.length})`);
  assert.match(cards[0].querySelector('.release-version')?.textContent || '', new RegExp(`v${pkg.version.replace(/\./g, '\\.')}`));

  const phoneTab = d.querySelector('.filter-btn[data-category="phone"]');
  phoneTab.click();
  assert.equal(phoneTab.getAttribute('aria-pressed'), 'true');
  const scopes = [...d.querySelectorAll('.item-scope')].map(el => el.textContent);
  assert.ok(scopes.length > 0 && scopes.every(s => s === '[Phone PWA]'), 'phone filter shows only Phone PWA changes');

  wnClose.click();
  assert.ok(wnBackdrop.classList.contains('hidden'), 'clicking #whats-new-close closes the What\'s New modal window');

  // Verify custom Liquid Glass popover menu interaction
  const sortWrap = d.querySelector('#capture-sort');
  const sortTrigger = sortWrap.querySelector('.glass-select-trigger');
  const sortMenu = sortWrap.querySelector('.glass-select-menu');
  assert.ok(sortMenu.classList.contains('hidden'), 'sort popover menu starts hidden');
  sortTrigger.click();
  assert.ok(!sortMenu.classList.contains('hidden'), 'clicking trigger opens Liquid Glass popover menu');
  const sizeOpt = sortMenu.querySelector('.glass-select-option[data-value="size"]');
  sizeOpt.click();
  assert.equal(sortWrap.dataset.value, 'size', 'clicking option updates selected value');
  assert.equal(sortWrap.querySelector('.glass-select-label').textContent, 'Largest Size');
  assert.ok(sortMenu.classList.contains('hidden'), 'selecting an option closes the popover menu');

  const cssNoComments = workbenchCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(cssNoComments, /\.release-card\s*\{/);
});

test('desktop workbench: single settings trigger, loading skeletons, conn recovery banner, and lightbox zoom/rotate controls', { skip: skipOpt }, () => {
  const dom = new JSDOM(workbenchHtml);
  const d = dom.window.document;

  // Duplicate rail settings trigger removed; topbar trigger stays
  assert.equal(d.querySelector('#settings-btn'), null, 'duplicate rail settings trigger removed');
  assert.ok(d.querySelector('#top-settings-btn'), 'sole settings trigger exists in topbar');

  // Connection recovery banner + retry button
  assert.ok(d.querySelector('#conn-banner'), '#conn-banner exists');
  assert.ok(d.querySelector('#conn-retry'), '#conn-retry button exists');

  // Initial skeletons rendered dynamically by app.js & styled in style.css
  assert.match(workbenchJs, /className = 'cap-skel'/);
  assert.match(workbenchJs, /className = 'file-skel'/);
  assert.match(workbenchCss, /\.cap-skel\s*\{/);
  assert.match(workbenchCss, /\.file-skel\s*\{/);

  // Lightbox inspection & edit controls
  for (const id of ['#lb-origin', '#lb-index', '#lb-dims', '#lb-zoom', '#lb-rotate', '#lb-prev', '#lb-next']) {
    assert.ok(d.querySelector(id), `lightbox control ${id} exists`);
  }
  assert.match(workbenchJs, /\/api\/captures\/.*\/rotate|rotateLightboxCapture/);
  assert.match(workbenchCss, /\.ic-rotate/);
});

test('desktop workbench: non-blocking bottom-right Liquid Glass notification dock with swipe-to-dismiss', { skip: skipOpt }, () => {
  const dom = new JSDOM(workbenchHtml);
  const d = dom.window.document;
  const dock = d.querySelector('#pc-notif-dock.pc-notif-dock');
  assert.ok(dock, '#pc-notif-dock exists');
  assert.ok(dock.querySelector('#pc-undo-toast'), '#pc-undo-toast sits inside dock');
  assert.ok(dock.querySelector('#toast'), '#toast sits inside dock');

  const cssNoComments = workbenchCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(cssNoComments, /\.pc-notif-dock\s*\{[^}]*bottom:\s*20px[^}]*right:\s*20px[\s\S]*?pointer-events:\s*none/);
  assert.match(cssNoComments, /\.pc-undo-toast,\s*\.toast\s*\{[\s\S]*?backdrop-filter:\s*saturate\(/);
  assert.match(cssNoComments, /\.toast\[data-tone="err"\]/);
  assert.match(workbenchJs, /function attachNotifSwipe\(/);
  assert.match(workbenchJs, /function inferNotifTone\(/);
});

test('desktop workbench: capture grid multi-select batch delete and modal focus trapping', { skip: skipOpt }, () => {
  const dom = new JSDOM(workbenchHtml, {
    url: 'http://localhost:8787/',
    runScripts: 'dangerously',
  });
  const { window } = dom;
  window.EventSource = class {
    constructor() {}
    close() {}
  };
  window.fetch = async () => ({
    ok: true,
    json: async () => ([]),
  });
  window.eval(sharedJs);
  window.eval(releasesJs);
  window.eval(workbenchJs);

  const d = window.document;
  for (const id of ['#captures-select-btn', '#captures-select-all', '#captures-delete-selected', '#captures-sel-count']) {
    assert.ok(d.querySelector(id), `capture multi-select control ${id} exists`);
  }
  assert.equal(d.querySelector('#captures-search'), null, 'no workbench search input added');

  const cssNoComments = workbenchCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(cssNoComments, /\.cap-select-wrap\s*\{/);
  assert.match(cssNoComments, /\.cap-tile\.selected\s*\{/);
  assert.match(cssNoComments, /\.capture-grid\.select-mode\s+\.cap-hover-actions\s*\{/);

  assert.match(workbenchJs, /function syncCaptureSelectionUI\(/);
  assert.match(workbenchJs, /function toggleCaptureSelected\(/);
  assert.match(workbenchJs, /fetch\('\/api\/captures',\s*\{\s*method:\s*'DELETE'[\s\S]*?body:\s*JSON\.stringify\(\{\s*ids\s*\}\)/);

  // Modal focus trap & opener restore
  assert.match(workbenchJs, /function activateModalFocus\(/);
  assert.match(workbenchJs, /function deactivateModalFocus\(/);
  const wnBtn = d.querySelector('#whats-new-btn');
  const wnBackdrop = d.querySelector('#whats-new-backdrop');
  const wnClose = d.querySelector('#whats-new-close');
  wnBtn.focus();
  assert.equal(d.activeElement, wnBtn, 'trigger holds focus before opening modal');
  wnBtn.click();
  assert.ok(!wnBackdrop.classList.contains('hidden'), 'What\'s New modal opens');
  assert.equal(d.activeElement, wnClose, 'modal moves focus inside on open');

  // Shift+Tab from first focusable wraps inside modal
  d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.ok(wnBackdrop.contains(d.activeElement), 'Shift+Tab keeps focus trapped inside modal');

  // Escape closes top modal and restores focus to opener
  d.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(wnBackdrop.classList.contains('hidden'), 'Escape closes top modal');
  assert.equal(d.activeElement, wnBtn, 'closing modal restores focus to opener');
});



