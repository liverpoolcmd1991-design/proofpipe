// Phone PWA surface guards — the a11y/layout fixes that had no test surface.
//
// The phone UI is plain DOM glue (phone.html / phone.css / phone.js) and had NO
// coverage, so every bug pinned here was found by reading code: a close button
// that positioned against the fixed overlay instead of its dialog, capture
// controls that could never take focus, a button with no styling on this page
// (its only .linkbtn rule lives in style.css, which phone.html never loads),
// tap targets below the 44px floor DESIGN.md §2 mandates, and two states that
// only existed visually (CSS ::before/::after badges a screen reader never
// sees).
//
// jsdom is loaded WITHOUT runScripts: phone.js needs IndexedDB,
// createImageBitmap and EventSource at boot, so only the shipped markup is
// parsed here. The JS-side glue is pinned by cheap source assertions at the
// bottom — same intent, no boot.
//
// jsdom is a devDependency. The guard keeps `npm test` green on a checkout
// installed with --omit=dev, where the import would throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(APP, 'public/phone.html'), 'utf8');
const css = fs.readFileSync(path.join(APP, 'public/phone.css'), 'utf8');
const js = fs.readFileSync(path.join(APP, 'public/phone.js'), 'utf8');

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional */ }
const skipOpt = JSDOM ? false : 'jsdom not installed — run `npm i -D jsdom` to enable';
const doc = () => new JSDOM(html).window.document;

// ---------- CSS helpers (comments stripped; exact selector-list membership) ----------
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
// the PC harness stylesheet, for the cross-client parity assertions below
const harnessCssNoComments = fs.readFileSync(path.join(APP, 'public/style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
function blocksFor(selector) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cssNoComments))) {
    const sels = m[1].split(',').map(s => s.trim());
    if (sels.includes(selector)) out.push(m[2]);
  }
  return out.join('\n');
}
// the tallest height declared for a selector, or null when it declares none
function declaredHeight(selector) {
  const sizes = [...blocksFor(selector).matchAll(/(?:^|[\s;])(?:min-)?height\s*:\s*(\d+)px/g)]
    .map(m => Number(m[1]));
  return sizes.length ? Math.max(...sizes) : null;
}

test('phone: the file-sheet close button lives INSIDE its dialog box', { skip: skipOpt }, () => {
  const d = doc();
  // outside the box it positioned against the fixed #file-sheet overlay and
  // rendered in the screen corner, far from the dialog it closes
  assert.ok(d.querySelector('#file-sheet-box #file-sheet-close'), 'close button is a child of the box');
  assert.equal(d.querySelector('#file-sheet > #file-sheet-close'), null, 'not a direct child of the overlay');
  assert.equal(d.querySelector('#file-sheet').getAttribute('role'), 'dialog');
});

test('phone: capture pickers are focusable buttons, not bare labels', { skip: skipOpt }, () => {
  const d = doc();
  for (const id of ['#cam', '#gallery', '#file-input']) {
    const input = d.querySelector(id);
    const label = input && input.closest('label');
    assert.ok(label, `${id} is wrapped in a label`);
    assert.equal(label.getAttribute('role'), 'button', `${id}'s label carries button semantics`);
    assert.equal(label.getAttribute('tabindex'), '0', `${id}'s label is in the tab order`);
  }
  // the focus ring these controls rely on must exist for the label elements
  assert.match(cssNoComments, /\.shutter:focus-visible/, '.shutter keeps its focus ring');
  assert.match(cssNoComments, /\.alt-btn:focus-visible/, '.alt-btn keeps its focus ring');
  // ...and the keyboard path is wired to the label's own tap path
  assert.match(js, /function activateOnKey\(/, 'activateOnKey exists');
  assert.match(js, /input\.closest\('label'\)/, 'the picker labels are wired to activateOnKey');
});

test('phone: no ARIA container promises children it does not have', { skip: skipOpt }, () => {
  const d = doc();
  // role=list requires listitem children; the tiles are role=button
  assert.equal(d.querySelector('#recent').getAttribute('role'), 'group');
  // the queue chip is a real control now, and its live region is a child span —
  // an aria-live wrapper that is also the tap target is not a status region
  const outbox = d.querySelector('#outbox-info');
  assert.equal(outbox.getAttribute('role'), 'button');
  assert.equal(outbox.getAttribute('tabindex'), '0');
  assert.ok(outbox.querySelector('#outbox-text[aria-live="polite"]'), 'live region is the inner span');
});

test('phone: the more button describes the panel it opens', { skip: skipOpt }, () => {
  const d = doc();
  const btn = d.querySelector('#more-btn');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  const controls = btn.getAttribute('aria-controls');
  assert.ok(controls, 'aria-controls points at the panel');
  const panel = d.querySelector(`#${controls}`);
  assert.ok(panel, `#${controls} exists`);
  assert.notEqual(panel.getAttribute('role'), 'menu', 'the panel holds switches, not menu items');
  // a long menu must be scrollable rather than running off a short viewport —
  // but the OS bar must NOT be drawn inside a floating sheet (it reads as a
  // broken nested pane): keep the scroll, hide the rail, and advertise the
  // overflow with the sheet's own bottom fade instead (PITFALLS #46)
  const menu = blocksFor('.more-wrap #more-menu');
  assert.match(menu, /max-height\s*:/);
  assert.match(menu, /overflow-y\s*:\s*auto/, 'the scroll stays — the last action must stay reachable');
  assert.match(menu, /scrollbar-width\s*:\s*none/);
  assert.match(cssNoComments, /#more-menu::-webkit-scrollbar\s*\{\s*display\s*:\s*none/, 'Blink needs its own rule');
  assert.match(cssNoComments, /#more-menu\.at-bottom::after/, 'a drawn cue replaces the bar');
  assert.match(js, /function syncMenuEdges\(\)/);
});

test('phone: confirm dialog exists, cancels by default, sits above the other overlays', { skip: skipOpt }, () => {
  const d = doc();
  const box = d.querySelector('#confirm');
  assert.ok(box, '#confirm exists');
  assert.equal(box.getAttribute('role'), 'alertdialog');
  assert.equal(box.classList.contains('hidden'), true, 'starts hidden');
  assert.ok(d.querySelector('#confirm-box #confirm-cancel'), 'Cancel is inside the dialog');
  assert.ok(d.querySelector('#confirm-box #confirm-ok'), 'the action is inside the dialog');
  // Cancel first in DOM order: it takes focus, so Enter must not delete
  const order = [...d.querySelectorAll('#confirm-box button')].map(b => b.id);
  assert.deepEqual(order, ['confirm-cancel', 'confirm-ok']);
  const z = Number((blocksFor('#confirm').match(/z-index\s*:\s*(\d+)/) || [])[1]);
  const sheetZ = Number((blocksFor('#file-sheet').match(/z-index\s*:\s*(\d+)/) || [])[1]);
  assert.ok(z > sheetZ, `confirm (${z}) stacks above the file sheet (${sheetZ})`);
});

test('phone: 44px tap targets on every phone control (DESIGN.md §2)', { skip: skipOpt }, () => {
  const expected = [
    '#text-expand', '#text-send', '#viewer-close', '#undo-toast-btn',
    '#outbox-info', '#quality-level', '.cbtn', '.linkbtn', '.text-chip', '.file-chip',
  ];
  for (const sel of expected) {
    const h = declaredHeight(sel);
    assert.ok(h != null, `${sel} declares a height`);
    assert.ok(h >= 44, `${sel} is at least 44px (declared ${h}px)`);
  }
});

test('phone: the files lane is a horizontal strip, not a thin vertical list', () => {
  const lane = blocksFor('#files');
  assert.match(lane, /flex-direction\s*:\s*row/, 'one row');
  assert.match(lane, /overflow-x\s*:\s*auto/, 'scrolls sideways');
  assert.match(lane, /overflow-y\s*:\s*hidden/);
  assert.match(lane, /scrollbar-width\s*:\s*none/, 'no hairline scrollbar');
  assert.match(lane, /mask-image/, 'the edge fade advertises the scroll');
  // the swipe-down-to-delete travel window must stay inside the border-box
  assert.match(lane, /padding[^;]*32px/);
  assert.match(blocksFor('#files.swiping'), /mask-image\s*:\s*none/, 'a lifted chip is not clipped');
  assert.match(blocksFor('.file-chip'), /flex\s*:\s*none/, 'chips never squeeze past their max-width');
  assert.match(blocksFor('.file-chip'), /max-width\s*:/);
});

test('phone: one definition per selector (no shadowed duplicates)', () => {
  for (const sel of ['#more-btn', '#more-menu', '.text-chip', '#viewer-bar']) {
    const hits = [...cssNoComments.matchAll(new RegExp(`^\\s*\\${sel.slice(0, 1)}${sel.slice(1)}\\s*\\{`, 'gm'))];
    assert.equal(hits.length, 1, `${sel} is defined exactly once (found ${hits.length})`);
  }
  // The lane's two strips are ONE component, so they are declared in ONE rule
  // whose selector list names both. As two blocks they had already drifted (2px
  // of side padding on one, none on the other; a 14/12/4px rhythm between
  // them), so pin the merge rather than the per-selector count: .text-in is
  // defined by exactly one rule, and that rule also defines #files.
  const rules = [...cssNoComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(m => m[1].split(',').map(s => s.trim()));
  const strip = rules.filter(sels => sels.includes('.text-in'));
  assert.equal(strip.length, 1, `.text-in is defined by exactly one rule (found ${strip.length})`);
  assert.ok(strip[0].includes('#files'), 'and that rule lists #files too, so the two strips cannot drift');
});

test('phone: the "more rows" controls are one component, styled on this page', () => {
  // phone.js used to BUILD the "show older" button (class linkbtn) and append it
  // INSIDE the text strip — 1,164px past the first chip on a 7-row lane, behind
  // the strip's edge fade — while the files lane's equivalent was an
  // always-visible centred row. Both are now the same static .lane-more row in
  // phone.html, so neither can drift and neither needs rebuilding.
  assert.match(html, /id="text-load-more"[^>]*class="[^"]*lane-more/, 'the text lane has its own "more rows" row');
  assert.match(html, /id="files-load-more"[^>]*class="[^"]*lane-more/, 'the files lane shares that row');
  // the only .linkbtn rule used to live in style.css, which phone.html never loads
  assert.match(cssNoComments, /\.linkbtn\s*\{/, 'phone.css styles .linkbtn itself');
  assert.match(cssNoComments, /\.lane-more\s*\{/, 'phone.css styles .lane-more itself');
  assert.doesNotMatch(js, /box\.appendChild\(more\)/, 'the control is no longer built inside the strip');
  // "(n)" came from the raw row count while duplicate sends of one capture are
  // suppressed at render time, so the label could promise three and reveal one
  assert.doesNotMatch(js, /Show older texts \(\$\{/, 'the label promises no count');
  // The shell is served network-first with the cache as the OFFLINE fallback, so
  // a stale cached phone.html can pair with this phone.js (asset URLs are
  // content-hashed and the server answers any ?v= with the current bytes). An
  // unguarded accessor on the new row would throw and kill the whole boot — the
  // same "older cached shell" case updateInbox() already tolerates.
  assert.match(js, /if \(textLoadMore\) textLoadMore\.onclick/, 'the new row tolerates an older cached shell');
});

test('phone: states drawn by CSS are mirrored into the accessible name', () => {
  assert.match(js, /function setTileState\(/, 'setTileState exists');
  assert.match(js, /setTileState\(w, 'uploading'\)/, 'pending tiles announce the upload');
  assert.match(js, /setTileState\(job\.tile\.el, 'not sent'\)/, 'failed tiles announce they were not sent');
  assert.match(js, /setTileState\(el, ''\)/, 'markSent clears the state suffix');
});

test('phone: capture tiles are individually labelled', () => {
  // every tile used to read "Capture, open preview" — with up to 100 of them the
  // label has to carry something that tells one capture from the next
  assert.match(js, /function tileTimeLabel\(/);
  assert.match(js, /recentTileA11y\(w, tile, cap\.created_at\)/, 'server rows timestamp their label');
  assert.match(js, /recentTileA11y\(w, tile, live \? Date\.now\(\) : null\)/, 'a live capture timestamps itself');
});

test('phone: keyboard and IME paths exist for text + chip delete', () => {
  // IME: the Enter that commits a candidate must not send
  assert.match(js, /e\.isComposing \|\| e\.keyCode === 229/);
  // chips are deletable without a touchscreen
  assert.match(js, /e\.key === 'Delete' && e\.key !== 'Backspace'|e\.key !== 'Delete' && e\.key !== 'Backspace'/);
  assert.match(js, /file-chip.*open actions|open actions`\)/, 'file chips carry an accessible label');
});

test('phone: blocking window.confirm is gone from the action paths', () => {
  // the only surviving call is the explicit fallback for a shell without #confirm
  const raw = [...js.matchAll(/(?<!\.)\bconfirm\(/g)].length;
  assert.equal(raw, 0, 'no bare confirm() calls remain');
  assert.match(js, /window\.confirm\(title\)/, 'the shell fallback is explicit about what it is');
  assert.match(js, /phoneConfirm\(\{/);
});

test('phone: the shutter gets the busy state it documents', () => {
  assert.match(js, /classList\.toggle\('busy', shutterBusyCount > 0\)/);
  assert.match(cssNoComments, /\.shutter\.busy\s*\{/, 'the busy style still exists');
});

test('phone: text chips reconcile without rebuilding unchanged rows', () => {
  assert.match(js, /function buildTextChip\(/, 'text construction is centralized');
  assert.match(js, /dataset\.renderKey = renderKey/, 'rows carry a stable render key');
  assert.match(js, /box\.replaceChildren\(\.\.\.desired\)/, 'reconciliation preserves existing nodes');
  assert.doesNotMatch(js, /textRenderSignature[\s\S]{0,300}box\.innerHTML = ''/, 'text refresh no longer clears the lane wholesale');
});

test('phone: PC-sent content is ONE unified lane that collapses when empty', () => {
  // Two lanes used to each reserve a 78px invisible slot so the recent grid
  // never moved — that left two blank bands whenever the PC had sent nothing.
  assert.doesNotMatch(cssNoComments, /#text-in\.hidden,\s*#files\.hidden/, 'the reserved-slot rule is gone');
  const inboxIdx = html.indexOf('id="inbox"');
  const textIdx = html.indexOf('id="text-in"');
  const filesIdx = html.indexOf('id="files"');
  const composerIdx = html.indexOf('class="text-row"');
  assert.ok(inboxIdx > -1, 'one unified lane exists');
  assert.ok(textIdx > inboxIdx && filesIdx > textIdx, 'PC-sent texts/captures sit above the files');
  assert.ok(composerIdx > -1 && composerIdx < inboxIdx, 'the composer sits above the unified lane');
  assert.match(cssNoComments, /#inbox\s*\{[\s\S]*?flex-direction:\s*column/, 'the lane stacks its two rows');
  assert.match(js, /function updateInbox\(\)/, 'the wrapper follows its children');
  assert.match(js, /box\.classList\.toggle\('hidden', !\(hasText \|\| hasFiles\)\)/);
  assert.match(js, /new MutationObserver\(updateInbox\)/, 'any add/remove path updates it');
});

test('phone: the textarea auto-grows to its own ceiling', () => {
  // anchored on the preceding `}` so `body.kb-open #text-input` can't match first
  const ceiling = src => {
    const block = src.match(/(?:^|\})\s*#text-input\s*\{([^}]*)\}/);
    return Number(block?.[1].match(/max-height:\s*(\d+)px/)?.[1] ?? 0);
  };
  const phone = ceiling(cssNoComments);
  assert.equal(phone, 150, 'the phone keeps the 150px ceiling');
  // The two clients no longer share this contract (P1): the PC field is one row
  // inside a fixed 64px top band, so it does NOT grow at all — a draft would push
  // the whole library down (test/pc-ui.test.js pins the JS side). The phone has no
  // such band to protect, so it keeps its coalesced auto-grow.
  assert.match(harnessCssNoComments, /#text-input\s*\{[^}]*max-height:\s*var\(--tb-ctl\)/, 'the PC field is pinned to the band');
  assert.match(js, /function autoGrowText\(\)/, 'growth is a named path, not inline glue');
  // the phone used to grow ONLY while .expanded — the collapsed field stayed 40px
  assert.match(js, /addEventListener\('input',\s*\(\)\s*=>\s*\{[\s\S]{0,240}autoGrowText\(\)/,
    'typing grows the collapsed field too');
  assert.match(js, /requestAnimationFrame\(\(\)\s*=>\s*\{[\s\S]{0,600}scrollHeight/,
    'the measure+write is coalesced to one frame, not one per keystroke');
  assert.doesNotMatch(js, /Math\.min\(180,/, 'the 180px phone-only ceiling is gone');
});

test('phone: chrome is not selectable, but text entry and link chips still are', () => {
  // Long-pressing a tile, a chip or the status bar used to start a text
  // selection (and pop the iOS copy callout) over controls with their own
  // gestures.
  assert.match(blocksFor('body'), /user-select:\s*none/);
  assert.match(blocksFor('body'), /-webkit-user-select:\s*none/);
  assert.match(blocksFor('textarea'), /user-select:\s*text/, 'the composer stays selectable');
  // a URL chip is copied by long-pressing the link itself — the ONLY copy
  // affordance for a link from the PC. Plain texts copy on tap, which
  // user-select:none does not touch.
  assert.match(blocksFor('.text-chip .chip-url'), /user-select:\s*text/, 'link chips stay selectable');
  assert.match(js, /tapCopyText\(t\.body, d\)/, 'plain texts still have their tap-to-copy path');
});

test('phone: the manual copy fallback stays reachable when the clipboard is blocked', () => {
  // Chip text is not selectable on purpose, so the failure message ("long-press
  // the text to select it") is only honest because the blocked chip is unlocked
  // on the spot — otherwise it points at a gesture that does nothing.
  assert.match(js, /chip\?\.classList\.add\('chip-manual'\)/, 'the blocked chip unlocks selection');
  assert.match(blocksFor('.text-chip.chip-manual'), /user-select:\s*text/, 'and the style exists for it');
  assert.match(js, /tapCopyText\(t\.body, d\)/, 'the chip element is handed to the copy path');
  assert.match(js, /long-press the text to select it/, 'the message names the gesture that now works');
});

test("phone: its live stream is labelled, so the PC can bring the QR back fast", () => {
  // The server treats a `device=phone` stream as the phone's live wire: while it
  // is open the phone is here, and its close is what lets the harness retire /
  // restore the pairing QR in seconds instead of waiting out the ping window.
  assert.match(js, /new EventSource\(SERVER \+ '\/events\?device=phone'\)/);
});

test('phone: the recent grid shows skeletons while the first load is in flight', () => {
  assert.match(html, /id="recent-loading"[^>]*aria-hidden="true"/, 'skeletons are decorative');
  assert.match(cssNoComments, /#recent-loading\s*\{/, 'the skeleton has layout');
  assert.match(cssNoComments, /\.skel-tile\s*\{[\s\S]*?animation:\s*shimmer/, 'lists shimmer');
  assert.match(cssNoComments, /#recent-loading\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fill/,
    'the skeleton mirrors the real grid tracks, so the box does not jump');
  assert.match(js, /let recentLoaded = false/, '"loading" is tracked, not inferred from emptiness');
  assert.match(js, /buildRecentSkeleton\(\)/, 'the skeleton is built once');
  assert.match(js, /countEl\.textContent = '…'/, 'single values show "…" until they are known');
  // "no captures yet" is a claim about the library — it cannot share the screen
  // with the skeletons or with the load-failure copy
  assert.match(js, /toggle\('hidden', count > 0 \|\| !recentLoaded \|\| failed\)/);
});

// ---------- PC-sent rich content: one card, one lane, one motion language ----------

test('phone: PC-sent captures and files render as ONE card anatomy', () => {
  // A capture and a file arrive from the same place and do the same job. They
  // used to render as an inline pill — thumbnail, badge and time sitting on the
  // image's TEXT BASELINE, at three different heights — and, one lane down, a
  // 10px rounded row with a bare icon. Same content, two unrelated components.
  const card = blocksFor('.file-chip'); // the shared rule lists ".media-chip, .file-chip"
  assert.match(card, /display:\s*flex/);
  assert.match(card, /align-items:\s*center/);
  assert.match(card, /gap:\s*10px/);
  assert.match(card, /border-radius:\s*12px/);
  // ONE leading-visual box for an image thumb, its placeholder and the file icon
  assert.match(cssNoComments, /\.media-chip img, \.chip-thumb-missing, \.f-thumb\s*\{[^}]*width:\s*42px[^}]*height:\s*42px/);
  assert.match(cssNoComments, /\.media-chip img, \.chip-thumb-missing, \.f-thumb\s*\{[^}]*border-radius:\s*9px/);
  // the media chip keeps .text-chip (swipe, reconcile key, focus ring) but wins
  // the pill geometry back with a two-class selector
  assert.match(blocksFor('.text-chip.media-chip'), /border-radius:\s*12px/);
  assert.match(blocksFor('.text-chip.media-chip'), /min-height:\s*58px/);
  // the meta block is the shared title/sub path and the badge is ONE trailing slot
  assert.match(cssNoComments, /\.media-chip \.chip-meta, \.file-chip \.f-meta\s*\{[^}]*min-width:\s*0/);
  assert.match(cssNoComments, /\.media-chip \.chip-title, \.file-chip \.f-name\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(cssNoComments, /\.media-chip \.chip-sub, \.file-chip \.f-sub\s*\{/);
  // PC content is BLUE in both cards (DESIGN.md §1 direction identity). The
  // capture badge was accent green — read as "from this phone" on a PC send.
  assert.match(blocksFor('.chip-badge.pc'), /background:\s*#60a5fa/);
  assert.match(js, /badge\.className = 'chip-badge pc'/, 'the capture card badges PC in blue');
  assert.match(js, /'chip-badge ' \+ \(fromPc \? 'pc' : 'phone'\)/, 'the file card shares that slot');
  // and the JS builds exactly that shape
  assert.match(js, /meta\.className = 'chip-meta'/);
  assert.match(js, /title\.className = 'chip-title'/);
  assert.match(js, /when\.className = 'chip-sub'/, 'the time is the card\'s second line, not an inline tail');
  assert.match(js, /d\.append\(img, meta, badge\)/);
  assert.match(js, /thumb\.className = 'f-thumb '/, 'the file card leads with the same 42px box');
  assert.match(js, /chip\.append\(thumb, meta, badge\)/);
  assert.match(js, /chipHHMM\(f\.created_at\)/, 'both cards carry an arrival time');
  // strips that mix 44px pills with 58px cards center them on one axis
  assert.match(blocksFor('.text-in'), /align-items:\s*center/);
  assert.match(blocksFor('#files'), /align-items:\s*center/);
  // the viewer's PC badge is the same blue
  const d = doc();
  assert.ok(d.querySelector('#viewer-origin.chip-badge.pc'), 'the viewer PC badge is tinted too');
});

test('phone: the PC-sent lane is one grid — one gutter, one rhythm, one fade', () => {
  // Measured in a render (headless Chrome, seeded scratch instance): the two
  // strips' side padding put every chip 2px in from the page's 18px gutter, so
  // the lane never lined up with the composer above it nor the rows below it,
  // and their bottom padding plus #inbox's gap gave the lane a 14 / 12 / 4px
  // rhythm. None of that is visible in the source — the two blocks look
  // equivalent — which is why it is pinned here.
  const strip = blocksFor('#files'); // the shared rule lists ".text-in, #files"
  assert.match(strip, /padding\s*:\s*0\s+0\s+32px/, 'the swipe travel window, with no side inset');
  assert.doesNotMatch(strip, /padding[^;]*\d+px\s+\d+px\s+32px/, 'no side padding — chips sit on the 18px gutter');
  assert.match(strip, /margin-bottom\s*:\s*-32px/, 'the travel window is handed back to the layout');
  assert.match(blocksFor('#inbox'), /gap\s*:\s*8px/, "and #inbox's gap is the lane's only vertical spacing");
  // the edge fade belongs only on an edge with content past it
  assert.match(cssNoComments, /\.text-in\.at-start,\s*#files\.at-start\s*\{[^}]*--fade-l\s*:\s*0px/);
  assert.match(cssNoComments, /\.text-in\.at-end,\s*#files\.at-end\s*\{[^}]*--fade-r\s*:\s*0px/);
  assert.match(js, /function trackStripEdges\(/);
  assert.match(js, /trackStripEdges\(\$\('#text-in'\)\)/);
  assert.match(js, /trackStripEdges\(\$\('#files'\)\)/);
  // the flex:1 gallery may not collapse and paint its children over the composer
  assert.match(blocksFor('.gallery'), /overflow\s*:\s*hidden/);
  assert.match(blocksFor('.gallery'), /min-height\s*:\s*44px/, 'never below one row of tiles');
});

test('phone: the PC-sent lane is loaded at BOOT, and chips pop in when they land', () => {
  // loadTexts() was the one lane missing from boot: with SSE live it only ran on
  // a NEW 'text' event, so a cold load showed an existing session's PC-sent
  // captures/texts nowhere until the PC sent another one or the tab was re-shown.
  const boot = js.slice(js.indexOf('// ---------- boot ----------'));
  assert.ok(boot.length > 0, 'the boot block exists');
  assert.match(boot, /loadFiles\(\);[\s\S]{0,400}loadTexts\(\);/);
  // entrance animation: fresh nodes only, dropped on a timer so the strip's
  // reconcile pass (which re-inserts existing nodes) can never replay it
  assert.match(cssNoComments, /\.chip-new\s*\{[^}]*animation:\s*chip-in/);
  assert.match(js, /function markChipNew\(/);
  assert.match(js, /markChipNew\(chip\)/);
  assert.match(js, /markChipNew\(d\)/);
  assert.match(js, /el\.classList\.remove\('chip-new'\)/, 'a swipe takes the entrance animation off');
});

test('phone: overlays and chips animate on compositor-only properties', () => {
  for (const sel of ['#inbox:not(.hidden)', '#viewer:not(.hidden)', '#confirm:not(.hidden)', '#file-sheet:not(.hidden)']) {
    // the selector may sit in a list (a rule can carry several of these states)
    assert.match(cssNoComments, new RegExp(`${sel.replace(/[.()#:]/g, '\\$&')}\\s*(?:,[^{}]*)?\\{[^}]*animation:`), `${sel} animates in`);
  }
  assert.match(blocksFor('#recent .ok-badge'), /transition:[^;]*transform/, 'tiles acknowledge a press');
  assert.match(cssNoComments, /\.text-chip, \.media-chip, \.file-chip\s*\{[^}]*transition:[^;]*transform/);
  // the gesture surfaces keep overriding the base transition (PITFALLS #31:
  // a 1:1 finger-tracking element must not animate what it is tracking)
  assert.match(blocksFor('.text-chip.swiping'), /transition:\s*none/);
  assert.match(blocksFor('.text-chip.snap'), /transition:\s*transform/);
  const frames = [...cssNoComments.matchAll(/@keyframes\s+(pp-\w+|chip-in)\s*\{([^}]*)\}/g)];
  assert.ok(frames.length >= 3, `the motion pass declares its keyframes (found ${frames.length})`);
  for (const [, name, body] of frames) {
    assert.ok(!/(?:width|height|top|left|right|margin|padding)\s*:/.test(body), `${name} animates no layout property`);
  }
  assert.match(cssNoComments, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?animation:\s*none !important/);
});

// ---------- the 2026-09 phone pass: parity, layout safety, honest state ----------

test('phone: the viewer can straighten a photo without the PC', () => {
  // A sideways photo had to be sent to the PC to be rotated, on the device that
  // actually took it.
  assert.match(html, /id="viewer-rot"/);
  assert.match(js, /function rotateViewer\(\)/);
  assert.match(js, /\$\('#viewer-rot'\)\.onclick/);
  assert.match(cssNoComments, /\.ic-rotate \{[^}]*rotate-cw\.svg/);
  // one transform writer: rotation rides the same string the gestures write
  assert.match(js, /viewerImg\.style\.transform = `translate\(\$\{viewerZoom\.tx\}px, \$\{viewerZoom\.ty\}px\) scale\(\$\{viewerZoom\.scale\}\) rotate\(\$\{viewerRot\}deg\)`/);
  assert.match(js, /viewerRot = 0; \/\/ fresh image, fresh orientation/, 'each item starts upright');
  // and the clamp grows with the rotated AABB, so a rotated image still cannot
  // be parked off-screen (the harness's clampPan uses the same cos/sin)
  const clamp = js.slice(js.indexOf('function clampViewerPan()'), js.indexOf('function rotateViewer()'));
  assert.ok(clamp.length > 0, 'clampViewerPan is where we think it is');
  assert.match(clamp, /Math\.abs\(Math\.cos\(rad\)\)/);
  assert.match(clamp, /Math\.abs\(Math\.sin\(rad\)\)/);
});

test('phone: the queue chip retries instead of destroying', () => {
  // The most prominent queue affordance in the app opened a "Clear all queued
  // photos?" confirm, while recovery existed only as a per-tile Retry behind
  // the viewer. Clearing belongs with the other destructive actions.
  assert.match(html, /id="outbox-info"[^>]*title="Tap to retry sending these now"/);
  const handler = js.slice(js.indexOf("$('#outbox-info').onclick"), js.indexOf("$('#outbox-info').onclick") + 700);
  assert.ok(!/outboxClear\(\)/.test(handler), 'the tap target no longer clears the queue');
  assert.match(handler, /await checkServer\(\)/);
  assert.match(handler, /outboxCount\(\)/);
  assert.match(js, /#clear-outbox/, 'clearing still exists, in More options');
});

test('phone: the status strip separates "dropped" from "never paired"', () => {
  // Two different failures used to share one word. "offline" claims a connection
  // that DROPPED — wrong for a phone that has never reached the PC at all, which
  // sends a first-run user hunting for a Wi-Fi problem when the fix (scan the QR
  // on the PC) is on the other device.
  assert.match(js, /let everConnected = false/);
  assert.match(js, /everConnected = true/, 'a successful poll or SSE open marks it');
  assert.match(js, /if \(!everConnected\) \{ setStatus\('off', 'not paired'\)/);
  assert.match(js, /scan the QR on your PC/, 'the message names the actual fix');
  assert.match(js, /setStatus\('off', 'offline'\)/, 'a real drop still says offline');
  // the queue count lives in exactly ONE place — the amber bar above the shutter
  // — so it can no longer be asserted in the status line and contradicted there
  assert.doesNotMatch(js, /photos? queued` : 'offline'/, 'the status line makes no queue claim');
  assert.match(js, /el\.classList\.toggle\('hidden', !n\)/, 'the queue bar appears only with a real count');
});

test('phone: the status strip is tinted by state, from the same ladder as the dot', () => {
  // The dot was 8px and colour-only; the strip's background re-encodes the same
  // state so a change is legible in peripheral vision without reading it.
  assert.match(js, /strip\.dataset\.state = cls/);
  for (const s of ['ok', 'warn', 'off']) {
    assert.match(cssNoComments, new RegExp(`\\.status-strip\\[data-state="${s}"\\]`), `${s} has a tint`);
  }
  // the wordmark is gone — the top of the screen belongs to the state
  assert.doesNotMatch(html, /<h1>/, 'no branding takes the header slot');
  assert.match(html, /id="status-strip"/);
  // #status stays the live region; the detail is deliberately NOT one, or a
  // count that ticks up per capture would be re-announced every time
  assert.match(html, /id="status"[^>]*role="status"/);
  assert.doesNotMatch(html, /id="status-sub"[^>]*aria-live/);
});

test('phone: the ✓ badge confirms an ARRIVAL, not the normal case', () => {
  // A badge on every tile marked the NORMAL case, so it carried no information
  // — and it spent the top-right corner of every 96px thumbnail.
  assert.doesNotMatch(cssNoComments, /\.ok-badge::after\s*\{[^}]*content:\s*'✓'/, 'no default ✓');
  assert.match(cssNoComments, /#recent \.ok-badge\.just-sent::after\s*\{[^}]*content:\s*'✓'/, 'the ✓ is opt-in');
  assert.match(js, /const JUST_SENT_MS = \d+/);
  assert.match(js, /function markJustSent\(/);
  assert.match(js, /markJustSent\(el\)/, 'markSent confirms the arrival');
  assert.match(js, /if \(live\) markJustSent\(existing\.el\)/, 'an SSE arrival confirms too');
  // the persistent states must still out-specify the transient one
  assert.match(cssNoComments, /#recent \.ok-badge\.pending::after/);
  assert.match(cssNoComments, /#recent \.ok-badge\.failed::after/);
});

test('phone: the primary action is the only inverted surface, in the thumb zone', () => {
  // The shutter used to be a --card box at the TOP of the screen, visually
  // identical to its neighbours, while the brightest element on the page was the
  // SECONDARY send button (#fff at 19.2:1 against a card at 1.08:1).
  const shutter = blocksFor('.shutter');
  assert.match(shutter, /background:\s*var\(--inv\)/);
  assert.match(shutter, /height:\s*60px/);
  assert.match(cssNoComments, /\.shutter-bar\s*\{[^}]*position:\s*sticky/, 'the bar stays in reach');
  const send = blocksFor('#text-send');
  assert.ok(!/#fff/.test(send), 'send is no longer the brightest thing on the page');
  assert.match(send, /color:\s*var\(--accent\)/);
  // busy cannot be a colour swap on an inverted fill (accent on white = 2.2:1)
  assert.match(blocksFor('.shutter.busy'), /box-shadow/);
  // and the snackbar must clear the new bar
  assert.match(blocksFor('#undo-toast'), /bottom:max\(84px/);
});

test('phone: controls are outlined with --ctl, dividers keep --border', () => {
  // WCAG 1.4.11 wants ≥3:1 on the boundary of an interactive control; --border
  // measured 1.37:1 on the page, so every button was a shape you could not see.
  assert.match(cssNoComments, /--ctl:\s*#6e757c/, 'the control token exists');
  assert.match(cssNoComments, /--border:\s*#2b2f33/);
  for (const sel of ['.alt-btn', '#text-input', '#text-send']) {
    assert.match(blocksFor(sel), /border:1px solid var\(--ctl\)/, `${sel} is outlined as a control`);
  }
  // #text-expand is now an IN-FIELD affordance of #text-input (bottom-right
  // chevron inside .text-box), not a sibling button — it must NOT draw its own
  // box, or the field would look like it has a button glued to its edge.
  assert.match(blocksFor('#text-expand'), /position:absolute/);
  assert.match(blocksFor('#text-expand'), /border:none/);
  assert.match(blocksFor('.text-box'), /position:relative/);
  assert.match(blocksFor('#text-input'), /padding:9px 32px 9px 12px/, 'the field reserves the chevron column');
  assert.ok(doc().querySelector('#text-expand').closest('.text-box'), '#text-expand lives inside .text-box');
  // .alt-btn fills with --card, so the outline must clear 3:1 against the FILL
  // too, not just the page — #5c636a (3.15:1 on the page) is only 2.72:1 there
  assert.ok(!/--ctl:\s*#5c636a/.test(cssNoComments), 'the outline clears 3:1 on --card as well');
});

test('phone: the action stack is one 52px row, not two sub-44px ones', () => {
  // The old .actions-row held a 36px button and a 38px switch — both under the
  // 44px floor DESIGN.md §2 mandates — with pill radius on a control.
  assert.doesNotMatch(cssNoComments, /\.actions-row/, 'the pill row is gone');
  assert.match(cssNoComments, /\.secondary-row\s*\{[^}]*grid-template-columns:repeat\(2,\s*1fr\)/);
  assert.match(cssNoComments, /\.alt-btn\.sec\s*\{[^}]*min-height:52px/);
  const d = doc();
  assert.ok(d.querySelector('#gallery').closest('label.alt-btn.sec'), 'Choose photos is a picker label');
  assert.ok(d.querySelector('#file-input').closest('label.alt-btn.sec'), 'Send file is a picker label');
});

test('phone: the More sheet has exactly ONE entry point', () => {
  // The labelled "More" cell in the action row was a second door to the same
  // sheet: it duplicated the ⋮, needed its own aria-expanded, and forced the
  // outside-click handler to exclude it by name or the click's own bubble would
  // close the panel it had just opened.
  const d = doc();
  assert.equal(d.querySelector('#more-trigger'), null, 'the duplicate trigger is gone');
  const controls = d.querySelectorAll('[aria-controls="more-menu"]');
  assert.equal(controls.length, 1, 'one control, one panel');
  assert.equal(controls[0].id, 'more-btn');
  assert.doesNotMatch(js, /moreTrigger/, 'its wiring is gone too');
  // so the exclusion is unnecessary — and the handler must not still be
  // special-casing a control that no longer exists
  assert.doesNotMatch(js, /closest\('#more-trigger'\)/);
  assert.match(js, /e\.target\.closest\('\.more-wrap'\)/, 'panel and trigger still exclude each other');
  // the freed cell goes to the pickers, which are why the row exists
  assert.match(html, /Choose photos/);
  assert.match(html, /Send file/);
});

test('phone: the ✓ fades out instead of popping', () => {
  // A confirmation that vanishes between two frames reads as a glitch.
  assert.match(js, /const JUST_SENT_FADE_MS = \d+/);
  assert.match(js, /classList\.add\('just-sent-out'\)/);
  assert.match(js, /classList\.remove\('just-sent', 'just-sent-out'\)/, 'both classes drop together');
  assert.match(blocksFor('#recent .ok-badge.just-sent::after'), /transition:opacity/);
  assert.match(blocksFor('#recent .ok-badge.just-sent-out::after'), /opacity:0/);
  // re-arming mid-fade must restore full strength before re-timing
  assert.match(js, /el\.classList\.remove\('just-sent-out'\)/);
});

test('phone: the PC-sent lane prints ONE gesture tip, not one per strip', () => {
  // Both strips swipe down to remove, and both hints were gated by the SAME flag
  // and dismissed together — so a lane holding texts AND files printed the same
  // sentence twice, one line apart, and the two lines read as a divider between
  // two groups instead of as one lane.
  const d = doc();
  assert.equal(d.querySelector('#text-hint'), null, 'the duplicate tip is gone');
  assert.equal(d.querySelector('#file-hint'), null);
  assert.ok(d.querySelector('#inbox #chip-hint'), 'one tip, inside the lane');
  assert.doesNotMatch(js, /#text-hint|#file-hint/, 'no loader owns a tip any more');
  // driven from the only place that sees both strips
  const upd = js.slice(js.indexOf('function updateInbox()'), js.indexOf('function updateInbox()') + 1100);
  assert.match(upd, /#chip-hint/, 'updateInbox owns it');
  assert.match(upd, /hasText \|\| hasFiles/, 'shown when EITHER strip has rows');
  assert.match(js, /localStorage\.pp_chip_hint/, 'the one-time flag still applies');
  assert.match(cssNoComments, /#chip-hint\s*\{/);
});

test('phone: the PC direction badge renders the same way in every lane', () => {
  // Same trailing slot, same meaning, two renderings: the capture card showed the
  // text "PC" with no glyph, the file card a bare glyph with no text.
  assert.match(js, /badge\.append\(badgeIc, document\.createTextNode\('PC'\)\)/,
    'the capture card badge carries the glyph AND the label');
  assert.match(js, /badge\.append\(badgeIc, document\.createTextNode\(fromPc \? 'PC' : 'Phone'\)\)/,
    'the file card badge carries both too');
  const d = doc();
  const vo = d.querySelector('#viewer-origin.chip-badge.pc');
  assert.ok(vo.querySelector('i.ic-pc'), 'the viewer badge carries the glyph');
  assert.equal(vo.textContent.trim(), 'PC');
  assert.match(blocksFor('.chip-badge.pc'), /background:\s*#60a5fa/, 'still blue');
});

test('phone: every tappable chip is outlined as a control, not a hairline', () => {
  // A chip is tapped (copy / preview / file actions), so its outline is a
  // control boundary and owes 1.4.11 its 3:1. On --border it was 1.56:1 against
  // the page: the inbox lane was a row of cards you could not see.
  assert.match(blocksFor('.text-chip'), /border:1px solid var\(--ctl\)/);
  assert.match(blocksFor('.file-chip'), /border:1px solid var\(--ctl\)/);
  assert.match(blocksFor('.text-chip.media-chip'), /border-radius:\s*12px/);
});

test('phone: the More sheet separates Sync from the destructive group', () => {
  // Four destructive bulk actions sat in the same 8px rhythm as the auto-cleanup
  // switch and the quality slider, and only "Delete all" carried .danger — so
  // "Clear PC-sent captures" (which wipes PC-side history too) read QUIETER than
  // a JPEG quality slider.
  const d = doc();
  const group = d.querySelector('#more-menu .menu-group');
  assert.ok(group, 'the destructive trio has its own group');
  const ids = [...group.querySelectorAll('button')].map(b => b.id);
  assert.deepEqual(ids, ['clear-recent', 'clear-pc', 'clear-outbox']);
  for (const id of ids) {
    assert.ok(d.querySelector(`#${id}`).classList.contains('danger'), `${id} is marked destructive`);
  }
  assert.ok(d.querySelector('#more-menu .menu-head'), 'the group is headed');
  assert.match(cssNoComments, /\.menu-group\s*\{[^}]*border:1px dashed/);
  // auto-paste and the remote "open on PC" moved in here from the action row
  assert.ok(d.querySelector('#more-menu #autopaste'), 'auto-paste is a setting');
  assert.ok(d.querySelector('#more-menu #open-latest'), 'the remote action is tucked away');
});

test('phone: the skeleton occupies the SAME box as the tile it stands in for', () => {
  const radius = s => Number(s.match(/border-radius:\s*(\d+)px/)?.[1]);
  assert.equal(radius(blocksFor('#recent-loading .skel-tile')), radius(blocksFor('#recent .ok-badge')),
    'one radius, not 11 vs 10');
});

test('phone: the sheen is a button flourish, not a chip one', () => {
  // The sweep is the single flourish (DESIGN.md §6). On a chip it streaked light
  // across the one part of the card that is content — the thumbnail.
  assert.match(cssNoComments, /\.alt-btn::after, \.shutter::after, \.vbtn::after\s*\{/);
  assert.doesNotMatch(cssNoComments, /\.text-chip::after/, 'no sweep over a thumbnail');
  // the press feedback itself stays (that is not the flourish)
  assert.match(cssNoComments, /\.text-chip, \.media-chip, \.file-chip\s*\{[^}]*transition:[^;]*transform/);
});

test('phone: the gallery leads and still absorbs the space when it is empty', () => {
  // The gallery moved above the composer ("did it land?" is the question), and
  // an empty library sets #recent{display:none} — without a wrapper to hold the
  // flex:1 the composer and the shutter bunched at the top of the screen.
  const d = doc();
  const gallery = d.querySelector('.gallery');
  assert.ok(gallery, 'the gallery block exists');
  for (const id of ['recent-loading', 'recent', 'recent-empty', 'recent-error']) {
    assert.ok(gallery.querySelector(`#${id}`), `#${id} lives in the gallery block`);
  }
  assert.match(cssNoComments, /\.gallery\s*\{[^}]*flex:1 1 auto/);
  assert.match(blocksFor('.empty-recent'), /margin:auto 0/);
  // the composer must still precede the PC-sent lane (its own guard above)
  assert.ok(html.indexOf('class="recent-heading"') < html.indexOf('class="text-row"'),
    'the gallery leads the composer');
});

test('phone: the undo snackbar is not a live region that CONTAINS the button', { skip: skipOpt }, () => {
  const d = doc();
  assert.equal(d.querySelector('#undo-toast').getAttribute('role'), null);
  const msg = d.querySelector('#undo-toast-msg');
  assert.equal(msg.getAttribute('role'), 'status');
  assert.equal(msg.getAttribute('aria-live'), 'polite');
  assert.equal(d.querySelector('#undo-toast-btn').parentElement.id, 'undo-toast',
    'the interactive control is a sibling of the live region, not its content');
});

test('phone: long names wrap in the flash and are clamped in the undo pill', () => {
  // Two toasts, two shapes, so two policies — they were given one.
  // .flash is a rounded RECT at the top of the screen with room for a second
  // line, and its messages explain a REASON ("«120-char name» is over the size
  // cap"): ellipsizing there cut off the part that mattered, so it wraps.
  const flash = blocksFor('.flash');
  assert.match(flash, /overflow-wrap:\s*anywhere/);
  assert.ok(!/white-space:\s*nowrap/.test(flash), 'the flash wraps to two lines');
  // #undo-toast is a 999px PILL. Wrapping its message turned a 116-char file
  // name into THIRTEEN lines — measured 195×226px of white over the whole lane,
  // the tip, the picker row and part of the shutter. It is clamped to ONE line;
  // the clip is visual only, so the live region keeps the whole string.
  const msg = blocksFor('#undo-toast-msg');
  assert.match(msg, /white-space:\s*nowrap/);
  assert.match(msg, /text-overflow:\s*ellipsis/);
  assert.match(msg, /overflow:\s*hidden/);
  assert.match(msg, /min-width:\s*0/, 'it is the flex item that gives way, not the Undo button');
  assert.ok(!/overflow-wrap:\s*anywhere/.test(msg), 'the pill must not wrap');
});

test('phone: the chrome can always be reached on a short screen', () => {
  // Fixed chrome + body{overflow:hidden} meant the capture grid was simply
  // unreachable when everything above it did not fit (landscape, upload burst).
  const wrap = blocksFor('.wrap');
  assert.match(wrap, /height:\s*100dvh/);
  assert.match(wrap, /overflow-y:\s*auto/);
  assert.match(wrap, /overscroll-behavior:\s*contain/, 'inner lanes keep their own overscroll');
});

test('phone: the counts and the auto-cleanup label describe the library', () => {
  assert.match(js, /totalCount = s\.count \|\| 0/, 'the heading uses the server library count');
  assert.match(js, /Math\.max\(totalCount, count\)/, 'the tile strip is capped at 100 — the total wins');
  assert.match(html, /id="autocleanup-sub"/);
  assert.match(js, /drops oldest captures past 80% of \$\{fmtBytes\(/, 'the toggle names the cap it uses');
});

test('phone: sent and busy states are not CSS-only', () => {
  assert.match(js, /el\.title = 'Uploaded to your PC — tap to view'/);
  assert.match(js, /w\.title = 'Uploaded to your PC — tap to view'/);
  assert.match(js, /recent\.setAttribute\('aria-busy', String\(shutterBusyCount > 0\)\)/);
  assert.match(js, /const time = d\.toLocaleTimeString/, 'a chip/tile time keeps its own clock');
});

test('phone: a chip carries its whole text where a screen reader can read it', () => {
  // Chips are one-line ellipsized pills by design, so the message itself has to
  // live in the tooltip and the accessible name.
  assert.match(js, /chipA11y\(d, `Text from PC: \$\{t\.body\} — copy`\)/);
  assert.match(js, /d\.title = `Tap to copy — \$\{t\.body\}`/);
  assert.match(js, /chipA11y\(d, `Link from PC: \$\{t\.body\} — open`\)/);
});

test('phone: the More sheet sorts every content surface, and remembers it', { skip: skipOpt }, () => {
  const d = doc();
  // a segmented control, not a <select>: the sheet is a touch surface and an OS
  // picker on top of it would be a second modal
  assert.ok(d.querySelector('#more-menu .sort-seg'), 'the Sort control lives in the More sheet');
  const opts = [...d.querySelectorAll('#more-menu .sort-opt')];
  assert.deepEqual(opts.map(b => b.dataset.sort), ['new', 'old', 'name'], 'three modes, one tap each');
  assert.equal(opts[0].getAttribute('aria-pressed'), 'true', 'Newest is the default');
  assert.match(js, /const SORT_KEY = 'pp_phone_sort'/);
  assert.match(js, /localStorage\.setItem\(SORT_KEY, sortMode\)/);
  // the order change must re-stamp the strip's render key, or the signature
  // early-return would keep the old order on screen
  assert.match(js, /textRenderSignature = '';/);
  // and it must reach the grid AND both strips (one order, one writer)
  assert.match(js, /function applySortAll\(\)/);
  assert.match(js, /applySortAll\(\);/);
});

test('phone: a rate-limited capture waits for the bucket instead of losing the photo', () => {
  // 429s came from sustained rate, not from the burst: the pool pauses for the
  // same 1.5s PPQueue.onFailure uses, so the bucket refills and the photo keeps
  // its original fast path (the outbox is durability, not rate policy)
  assert.match(js, /if \(e && e\.status === 429\) last429 = Date\.now\(\);/);
  assert.match(js, /while \(Date\.now\(\) - last429 < 1500\) await sleep\(last429 \+ 1500 - Date\.now\(\)\)/);
});

test('phone: a missing thumbnail keeps retrying instead of going blank', () => {
  // retries used to give up at 6 (tiles) / 6 (chips) — a thumbnail write sitting
  // behind a rate-limited burst outlived that and the tile stayed blank until a
  // restart. 12 staggered tries with a 5s ceiling, on both paths.
  assert.match(js, /if \(thumbTries < 12\)/);
  assert.match(js, /if \(\+\+thumbTries > 11\) return;/);
  assert.match(js, /Math\.min\(5000, 400 \* thumbTries\)/);
  // and neither path may poison the capture: deadPcMedia is only for a full-res
  // 404 (openViewerRemote), never for a thumbnail miss
  assert.ok(!/onerror[\s\S]{0,200}markDeadPcMedia/.test(js), 'a thumbnail miss never marks the media dead');
});

test('phone: a coalesced PC file delete is applied locally, not refetched', () => {
  // the PC's bulk bar deletes N rows in ONE frame carrying `ids`; the phone drops
  // the rows it holds instead of pulling the whole list per deleted row
  assert.match(js, /Array\.isArray\(m\.ids\) && m\.ids\.length \? m\.ids : \(m\.id != null \? \[m\.id\] : null\)/);
  assert.match(js, /const next = xferFiles\.filter\(f => !gone\.has\(Number\(f\.id\)\)\)/);
  // a truly payload-less sweep event still reconciles with one refetch
  assert.match(js, /A payload-less sweep event; reconcile once[\s\S]{0,60}loadFiles\(true\)/);
});

test('phone: a file send reports progress in the status strip, not in a hidden band', { skip: skipOpt }, () => {
  const d = doc();
  // #file-progress was a whole band of upload rows, and `body.kb-open
  // #file-progress { display:none }` hid it outright — a send in progress simply
  // vanished behind the keyboard. It survives as the live region only.
  const band = d.querySelector('#file-progress');
  assert.ok(band, '#file-progress still exists');
  assert.ok(band.classList.contains('sr-only'), 'it is off-screen now');
  assert.equal(band.getAttribute('role'), 'status');
  assert.equal(band.getAttribute('aria-live'), 'polite');
  assert.match(cssNoComments, /\.sr-only\s*\{/, '.sr-only is defined in phone.css (phone.html never loads style.css)');
  assert.ok(!/\.up-row/.test(cssNoComments), 'the old upload-row band is gone');
  assert.ok(!/kb-open #file-progress/.test(cssNoComments), 'and so is the keyboard rule that hid it');
  // progress DRIVES the strip's detail line, and syncs the dedupe cache that
  // setStatusSub() checks — without that, the next statusDetail() would
  // early-return and leave a stale "72% …" on screen
  assert.match(js, /el\.textContent = `\$\{lead\} \$\{transferActive\.name\}\$\{n\}`/);
  assert.match(js, /statusSubText = el\.textContent;/);
  // a blue busy tint marks work in flight — never the warn tint (that reads as a fault)
  assert.match(blocksFor('.status-strip[data-state="busy"]'), /background:\s*var\(--tint-busy\)/);
  assert.match(js, /transferBegin\('photos', jobs\.length\)/);
});
