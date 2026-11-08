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
});

test('whats-new modal window & Liquid Glass popover menus: open, filter/select, and close cleanly', { skip: skipOpt }, () => {
  assert.match(workbenchJs, new RegExp(`version:\\s*'v${pkg.version.replace(/\./g, '\\.')}'`),
    `app.js includes a release entry for current version v${pkg.version}`);

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

