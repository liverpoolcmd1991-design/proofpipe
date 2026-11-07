// PC harness surface guards — the a11y/layout/behaviour fixes from the harness
// UI/UX audit that had no test surface.
//
// `app.js` is plain DOM glue with zero automated coverage (same situation
// PITFALLS #37 describes for phone.js), so every bug pinned here was found by
// reading code: keyboard grid shortcuts that acted on the wrong capture once an
// SSE insert shifted the index, an infinite-scroll sentinel that paged the whole
// library by itself, a "file send" control no keyboard could reach, tile
// interactive content nested inside role="button", a toast that covered the
// lightbox action bar, and an update banner pinned on top of the compose bar.
//
// jsdom is loaded WITHOUT runScripts: app.js needs EventSource / Clipboard /
// IntersectionObserver at boot, so only the shipped markup is parsed here. The
// JS-side glue is pinned by source assertions at the bottom — same intent, no
// boot.
//
// jsdom is a devDependency. The guard keeps `npm test` green on a checkout
// installed with --omit=dev, where the import would throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(APP, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(APP, 'public/style.css'), 'utf8');
const js = fs.readFileSync(path.join(APP, 'public/app.js'), 'utf8');

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional */ }
const skipOpt = JSDOM ? false : 'jsdom not installed — run `npm i -D jsdom` to enable';
const doc = () => new JSDOM(html).window.document;

// ---------- CSS helpers (comments stripped; exact selector-list membership) ----------
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
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
// blocks where the selector is alone on its own line — catches shadowed duplicates
function definitionCount(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...cssNoComments.matchAll(new RegExp(`^\\s*${esc}\\s*\\{`, 'gm'))].length;
}
const token = name => (css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i')) || [])[1];
function hexLum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a, b) {
  const [hi, lo] = [hexLum(a), hexLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('harness: every text tier clears WCAG AA on both surfaces', () => {
  // --faint was #7d7f81: 4.4:1 on --card and ~4.1:1 on --card2, under the 4.5:1
  // floor — and it labels 11.5–12.5px timestamps, hints and meta rows.
  const faint = token('faint');
  for (const surface of ['card', 'card2']) {
    const ratio = contrast(faint, token(surface));
    assert.ok(ratio >= 4.5, `--faint ${faint} on --${surface} is ${ratio.toFixed(2)}:1 (needs ≥4.5)`);
  }
  assert.ok(contrast(token('muted'), token('card2')) >= 4.5, '--muted stays AA on --card2');
});

test('harness: a capture tile is ONE action plus siblings, not nested buttons', { skip: skipOpt }, () => {
  const d = doc();
  // the tile itself must not be a role=button container: role="button" used to
  // wrap the four overlay actions, which is invalid interactive nesting
  assert.equal(d.querySelector('#captures').getAttribute('role'), 'tabpanel');
  assert.ok(!/d\.setAttribute\('role', 'button'\)/.test(js), 'the tile is not a button container');
  assert.match(js, /open\.setAttribute\('role', 'button'\)/, 'the tile has its own action surface');
  assert.match(js, /const open = document\.createElement\('div'\)/, 'that surface wraps thumb + meta');
  assert.match(js, /open\.append\(thumb, meta\)/);
  assert.match(js, /d\._open = open/, 'keyboard nav focuses the surface, not the tile');
  assert.match(js, /_open \|\| cells\[focusedIdx\]/, 'setFocus uses it');
  assert.match(cssNoComments, /\.capture-open\s*\{/, '.capture-open is styled');
});

test('harness: grid shortcut keys target the tile that actually has focus', () => {
  // view[focusedIdx] drifted from the focused tile when an SSE capture was
  // prepended — X/D/C/Enter could then act on a NEIGHBOURING capture
  assert.match(js, /const activeCell = document\.activeElement/, 'focusedIdx is re-derived from the DOM');
  assert.match(js, /gridCache\.cells\.indexOf\(activeCell\)/);
  assert.match(js, /const focusedCell = t\.closest \? t\.closest\('\.capture'\) : null/);
  assert.match(js, /view\.findIndex\(x => String\(x\.id\) === capId\)/, 'the target is resolved by id');
  assert.match(js, /e\.key === 'Enter' \|\| e\.key === ' '/, 'Space activates like Enter');
  assert.match(js, /t\.closest\('button, a'\)/, 'a focused action button keeps its own Enter/Space');
  assert.match(js, /e\.key === 'p' \|\| e\.key === 'P'\) sendToPhone\(cap\)/, 'Send has a keyboard path');
});

test('harness: infinite scroll watches the grid, not an always-visible button', () => {
  // #load-more is pinned BELOW the scrolling grid, so an IntersectionObserver
  // on it (400px rootMargin) never stopped intersecting and the grid paged
  // through the entire library with no user scroll at all
  assert.ok(!/new IntersectionObserver\(/.test(js), 'the self-firing observer is gone');
  assert.match(js, /gridScrollEl\.addEventListener\('scroll'/, 'the grid owns the trigger');
  assert.match(js, /,\s*\{ passive: true \}\)/, 'passive listener — scrolling never blocks');
  assert.match(js, /loadMoreBusy/, 'one page in flight at a time');
  // no DOM query inside the scroll handler
  assert.match(js, /const gridScrollEl = \$\('#captures'\)/);
  assert.match(js, /gridScrollEl\.scrollTop \+ gridScrollEl\.clientHeight < gridScrollEl\.scrollHeight - 400/,
    'same 400px runway as before');
});

test('harness: file send is a focusable button, not a label wrapping a hidden input', { skip: skipOpt }, () => {
  const d = doc();
  const btn = d.querySelector('#file-add-btn');
  assert.equal(btn.tagName, 'BUTTON'); // a <label> is not focusable — send was mouse-only
  assert.equal(btn.querySelector('input'), null, 'the input moved out of the label');
  assert.ok(d.querySelector('#file-input'), 'the hidden input is still in the document');
  assert.match(js, /\$\('#file-input'\)\.click\(\)/, 'the button opens the picker itself');
  assert.ok(!/\.file-add input\s*\{/.test(cssNoComments), 'the label-only rule is gone');
});

test('harness: text sync is operable without a mouse', { skip: skipOpt }, () => {
  const d = doc();
  // The newest text is a one-row glance in the band, beside the field; the
  // band's mail button opens the full conversation. Both are real controls, and
  // every row in either place is a <button> that copies on click — the old
  // clickable divs had no tab stop, so copying a past text had no key path.
  const band = d.querySelector('#texts-btn');
  assert.equal(band.tagName, 'BUTTON');
  assert.equal(band.getAttribute('aria-haspopup'), 'dialog');
  assert.ok(d.querySelector(`#${band.getAttribute('aria-controls')}`), 'it opens the texts dialog');
  // ...and it has to actually RENDER: it shipped with `.hidden` hard-coded and
  // nothing ever removed it (measured display:none on a live page), so the
  // dialog's one reachable trigger was a link inside the strip
  assert.ok(!band.classList.contains('hidden'), 'the dialog trigger is not hidden');
  const bd = d.querySelector('#texts-backdrop');
  assert.equal(bd.getAttribute('role'), 'dialog');
  assert.equal(bd.getAttribute('aria-modal'), 'true');
  assert.equal(d.querySelector('#texts-close').tagName, 'BUTTON', 'the dialog has a keyboard close');
  assert.equal(d.querySelector('#text-recent-label').tagName, 'SPAN', 'the glance is labelled');
  assert.equal(d.querySelector('#text-recent').getAttribute('aria-labelledby'), 'text-recent-label');
  // history rows were clickable divs too — copying a past text had no key path
  assert.match(js, /const b = document\.createElement\('button'\);\n\s*b\.type = 'button';\n\s*b\.className = 'text-item'/);
  assert.match(js, /b\.onclick = async \(\) => toast\(await copyTextSmart\(t\.body\)/, 'a row copies on click');
  assert.match(cssNoComments, /\.text-item:focus-visible/, 'history rows have a ring');
});

test('harness: a delete is undoable from the keyboard', () => {
  // the Undo toast auto-dismisses in 10s and focus never moves to it, so Ctrl+Z
  // is the only keyboard route back
  assert.match(js, /let activeUndo = null/);
  assert.match(js, /e\.ctrlKey \|\| e\.metaKey\) \|\| e\.key\.toLowerCase\(\) !== 'z'/);
  assert.match(js, /t\.isContentEditable/, 'editable fields keep their own Ctrl+Z');
  assert.match(js, /activeUndo\.click\(\)/);
  assert.match(js, /activeUndo = undo/);
});

test('harness: dialogs and view tabs carry their semantics', { skip: skipOpt }, () => {
  const d = doc();
  const lb = d.querySelector('#lightbox');
  assert.equal(lb.getAttribute('role'), 'dialog');
  assert.equal(lb.getAttribute('aria-modal'), 'true');
  assert.ok(lb.getAttribute('aria-label'));
  const confirm = d.querySelector('#confirm-backdrop');
  assert.equal(confirm.getAttribute('role'), 'dialog');
  const labelled = confirm.getAttribute('aria-labelledby');
  assert.ok(d.querySelector(`#${labelled}`), 'the confirm dialog has an accessible name');
  // tabs must point at real panels
  const tabs = [...d.querySelectorAll('[role="tab"]')];
  assert.equal(tabs.length, 2);
  for (const tab of tabs) {
    const panel = d.querySelector(`#${tab.getAttribute('aria-controls')}`);
    assert.ok(panel, `${tab.id} controls an existing panel`);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
  }
});

test('harness: every switch, toggle and input is announced', { skip: skipOpt }, () => {
  const d = doc();
  // selected state used to be color-only on these two control groups
  for (const id of ['#select-btn', '#dens-s', '#dens-m', '#dens-l']) {
    assert.equal(d.querySelector(id).getAttribute('aria-pressed'), 'false', `${id} exposes aria-pressed`);
  }
  assert.match(js, /setAttribute\('aria-pressed', String\(selectMode\)\)/);
  assert.match(js, /setAttribute\('aria-pressed', String\(on\)\)/);
  // placeholder/title-only labels are not labels
  assert.ok(d.querySelector('#text-input').getAttribute('aria-label'));
  for (const id of ['cap-sel', 'retention-sel', 'browser-sel']) {
    assert.ok(d.querySelector(`label[for="${id}"]`), `${id} has a real <label for>`);
  }
});

test('harness: the text bar is ONE control group — field and buttons share a height', () => {
  // The field measured ~44px/10px while its buttons sat at 38px/8px, so the send
  // button looked like it belonged to a different row. Both sides must now read
  // the SAME custom property, or the drift just comes back.
  const bar = blocksFor('#text-bar');
  assert.match(bar, /--tb-ctl:\s*44px/, 'the bar declares the shared control height');
  assert.match(blocksFor('#text-input'), /height:\s*var\(--tb-ctl\)/, 'the field uses it');
  assert.match(blocksFor('#text-bar .toolbtn'), /height:\s*var\(--tb-ctl\)/, 'the buttons use it');
  // one radius for the pair (10px), not the field 10 / button 8 split
  assert.match(blocksFor('#text-input'), /border-radius:\s*10px/);
  assert.match(blocksFor('#text-bar .toolbtn'), /border-radius:\s*10px/);
  // the buttons must NOT stretch with a growing draft — a square 44px control
  // sitting beside a 150px textarea is the whole point
  assert.match(blocksFor('#text-bar .toolbtn'), /min-width:\s*var\(--tb-ctl\)/);
  assert.doesNotMatch(blocksFor('#text-bar .toolbtn'), /align-self:\s*stretch/);
  // Send is the bar's one action, and it must live IN the bar to read the shared
  // height rule above. The texts dialog's trigger is a .toolbtn too, so every
  // control in the band shares one height — an inbound message no longer lives
  // in the bar at all, so it cannot displace Send by 350px (test/pc-ui.test.js
  // pins that).
  const d = doc();
  const send = d.querySelector('#text-send');
  assert.ok(send.classList.contains('toolbtn'), '#text-send shares the bar\'s control rule');
  assert.equal(send.closest('[id="text-bar"]')?.id, 'text-bar', '#text-send lives in the bar');
  assert.ok(d.querySelector('#texts-btn').classList.contains('toolbtn'),
    'the texts dialog trigger keeps the shared .toolbtn skin — and its 28px floor');
});

test('harness: focus rings exist and a mouse click no longer paints one', () => {
  // .btn (lightbox bar, bulk bar, confirm) had no :focus-visible at all
  assert.match(cssNoComments, /\.btn:focus-visible/);
  assert.match(cssNoComments, /\.capture:has\(\.capture-open:focus-visible\)/);
  assert.ok(!/\.capture:focus\s*\{/.test(cssNoComments), 'the tile uses :focus-visible, not :focus');
});

test('harness: overlays stop landing on top of interactive controls', () => {
  // toasts are interactive on the PC (Undo) and every bottom-docked bar sits at
  // the same bottom-centre offset — the toast has to move, not the bar.
  //
  // This used to be a per-case override that named the lightbox and nothing else.
  // Entering select mode therefore covered the bulk bar's Cancel button
  // (measured: toast 164x38 at y841-879 over Cancel 66x27 at y825-852, with the
  // toast overhanging the card at 879 vs 861). ONE variable, read by #toasts and
  // set by whichever bar is open, is what makes a third bar correct by default.
  assert.match(blocksFor('#toasts'), /bottom:\s*calc\(22px \+ var\(--toast-lift/,
    '#toasts reads the shared lift variable');
  const liftFor = sel => {
    const m = cssNoComments.match(new RegExp(`body:has\\(${sel.replace(/[.()#:]/g, '\\$&')}\\)\\s*\\{([^}]*)\\}`));
    return m ? Number((m[1].match(/--toast-lift:\s*(\d+)px/) || [])[1]) : null;
  };
  const lb = liftFor('#lightbox:not(.hidden)');
  const bulk = liftFor('#bulk-bar:not(.hidden)');
  assert.equal(lb, 64, 'the lightbox lift is the old 86px, re-expressed as 22 + 64');
  assert.ok(22 + lb >= 86, 'the viewer guarantee is preserved');
  assert.ok(bulk > lb, 'the bulk bar (45px tall, 39px off the floor) needs the larger lift');
  assert.ok(22 + bulk >= 90, 'a toast clears the bulk bar top edge by a real gap');
  // the banner was pinned at top:57px, i.e. ON the compose bar, and ate its clicks.
  // It clears the WHOLE top band now — and derives the offset from the band's own
  // token, because the band holds the compose field: an in-band 6px would sit on a
  // control again the moment the two bands were merged (P1).
  assert.match(blocksFor('#update-banner'), /top:\s*calc\(6px \+ var\(--topbar-h\)\)/);
  assert.ok(!/top:\s*57px/.test(cssNoComments), 'the old banner offset is gone');
});

test('harness: the chrome height is not a magic number', () => {
  // .app used calc(100dvh - 49px) and the banner hardcoded the same 49px
  assert.ok(!/calc\(100dvh - 49px\)/.test(cssNoComments), 'the header offset calc is gone');
  assert.match(blocksFor('body'), /display:\s*flex/);
  assert.match(blocksFor('.app'), /flex:\s*1 1 auto/);
  // header shares the 1800px content column instead of running full-bleed
  assert.match(blocksFor('header'), /max-width:\s*1800px/);
});

test('harness: UI chrome is not selectable text — a drag never smears the app', () => {
  // The harness is an application, not a document: dragging across a tile, the
  // stats box or a label used to leave a blue text selection behind.
  assert.match(blocksFor('body'), /user-select:\s*none/);
  assert.match(blocksFor('body'), /-webkit-user-select:\s*none/);
  // ...while text ENTRY and the values copied on purpose stay selectable
  for (const sel of ['input', 'textarea', 'select', '#lan-url', '.storage-path']) {
    assert.match(blocksFor(sel), /user-select:\s*text/, `${sel} stays selectable`);
  }
});

test('harness: overflowing dialogs scroll and empty lanes collapse', () => {
  assert.match(blocksFor('.settings-box'), /max-height\s*:/, 'settings cannot run off a short window');
  assert.match(blocksFor('.settings-box'), /overflow-y:\s*auto/);
  assert.match(cssNoComments, /#transfers-uploads:empty\s*\{[^}]*display:\s*none/, 'no phantom gap');
  // #text-history had no positioned ancestor — it anchored to the viewport
  assert.match(blocksFor('#text-bar'), /position:\s*relative/);
});

test('harness: the contested blocks have one definition each', () => {
  assert.equal(definitionCount('.badge-new'), 1, '.badge-new had two rules that disagreed on the corner');
  assert.equal(definitionCount('.text-item'), 1, 'the text row skin and its layout live in ONE rule');
});

test('harness: housekeeping guards', () => {
  assert.ok(!/insertBefore\(buildFileRow/.test(js), 'filePush has no dead branch');
  assert.match(js, /localStorage\.pp_sort/, 'sort order is remembered like the other prefs');
  assert.match(js, /activeTab === 'transfers' \|\| \$\('#show-all'\)\.checked/,
    'the transfers list is fetched only when the restored view shows it');
  // #empty visibility has exactly ONE owner (applyTab used to toggle it too)
  assert.equal([...js.matchAll(/\$\('#empty'\)\.classList\.toggle/g)].length, 1);
});

test('harness: live-update recovery and transfer pagination stay wired', () => {
  assert.match(js, /refreshGridCache\(\);[\s\S]{0,120}updateEmptyState\(view\.length\)/,
    'payload-less deletion re-derives keyboard navigation state');
  assert.match(js, /checkPageVersion\(\{ force: true \}\)/,
    'unknown SSE events can re-arm the stale-tab version check');
  assert.match(js, /api\('\/api\/settings'\)/, 'boot uses the aggregated settings endpoint');
  assert.match(js, /filesBefore|files-load-more/, 'Transfers has a keyset pagination cursor');
  assert.match(js, /filesLoadBusy/, 'only one transfer page loads at a time');
});

test('harness: there is exactly ONE pairing QR on screen', { skip: skipOpt }, () => {
  const d = doc();
  // the empty state used to render its own copy of the same code, so a fresh
  // install showed two identical QRs ~200px apart
  assert.ok(d.querySelector('.card.side #qr'), 'the pairing card owns the QR');
  assert.equal(d.querySelector('.empty-qr'), null, 'the empty state no longer copies it');
  assert.ok(!/\.empty-qr/.test(js), 'and nothing keeps it in sync any more');
  assert.ok(cssNoComments.indexOf('.empty-qr') === -1, '.empty-qr styling is gone');
  // the empty-state copy points AT the panel — and follows whether it is showing
  assert.ok(d.querySelector('#empty-sub'));
  assert.match(js, /\$\('#empty-sub'\)/, 'updateQr keeps that copy in step');
  assert.match(js, /the pairing QR on the left/);
});

test('harness: the pairing card holds a static, self-consistent layout', { skip: skipOpt }, () => {
  const d = doc();
  // the two section labels must not render at different sizes: .card.side h3 used
  // to out-specify .eyebrow's 11px micro-label
  assert.ok(!/font-size/.test(blocksFor('.card.side h3')), '.eyebrow owns the label type');
  // P3: every rail card owns its OWN label, and JS no longer injects a second
  // heading into the status box. It used to render a "Storage" .eyebrow inside
  // #stats while the card had no heading at all — so the label belonged to the
  // wrong card and "STORAGE" sat over the phone-presence lines.
  assert.ok(d.querySelector('#status-card > h3.eyebrow'), 'the status card owns its label');
  assert.ok(d.querySelector('#cap-card > h3.eyebrow'), 'the capacity card owns its label');
  assert.ok(d.querySelector('#recent-card > h3.eyebrow'), 'the Recent card owns its label');
  assert.ok(!/stats\.appendChild\(head\)/.test(js), 'nothing injects a heading into the stats box');
  assert.ok(!/createElement\('b'\)/.test(js));
  // one block per stats row, not <br>+<span> soup
  assert.ok(!/appendChild\(document\.createElement\('br'\)\)/.test(js));
  // the rail's cards stretch to the column: the column used to centre a stack of
  // labels, which is what left 45% of it empty (measured: 331.8px at 1440×900)
  assert.match(blocksFor('.card.side'), /align-items:\s*stretch/);
  // a thin scrollbar at every width — hidden-on-desktop clipped short windows
  assert.match(blocksFor('.card.side'), /scrollbar-width:\s*thin/);
  assert.ok(!/scrollbar-width:\s*none/.test(cssNoComments));
});

test('harness: the pairing card tells the truth about the network', { skip: skipOpt }, () => {
  const d = doc();
  // a one-option picker is noise; the LAN URL already names the interface
  assert.ok(d.querySelector('#nic-sel').classList.contains('hidden'), 'starts hidden');
  assert.match(js, /classList\.toggle\('hidden', ips\.length === 1\)/);
  // with no interface at all the QR points at localhost, so "scan it" would be a lie
  assert.match(js, /No network connection found/);
  assert.match(js, /lanKnown && lanIPsList\.length === 0/);
  assert.match(js, /if \(!ips\.length\) loadStats\(\)/, 'the hint is refined once, only in that case');
  // counts read as sentences
  assert.match(js, /capture\$\{s\.count === 1 \? '' : 's'\}/);
  // an empty href made the LAN link a reload of the harness before it resolved
  assert.equal(d.querySelector('#lan-url').getAttribute('href'), null);
  // The side rail's static legend is gone (P2): its two colour keys are the
  // toolbar's origin chips now — the same vocabulary as a CONTROL. There must be
  // exactly one origin vocabulary in the markup, not a key and a filter saying
  // the same thing in two places.
  assert.equal(d.querySelectorAll('.legend').length, 0, 'the legend moved into the toolbar');
  const chips = [...d.querySelectorAll('#origin-chips .chip')];
  assert.deepEqual(chips.map(c => c.dataset.origin), ['all', 'phone', 'pc']);
  for (const c of chips) assert.equal(c.getAttribute('aria-pressed'), String(c.dataset.origin === 'all'));
  for (const ic of d.querySelectorAll('#origin-chips .ic')) assert.equal(ic.getAttribute('aria-hidden'), 'true');
  // the toggle says what it controls
  assert.equal(d.querySelector('#qr-toggle').getAttribute('aria-controls'), 'pair-body');
});

test("harness: the QR follows the server's presence verdict", () => {
  // The server can see a phone's SSE stream close; the harness cannot. When the
  // server offers a verdict, the local 90s window must not override it — the
  // window is only the fallback for an older server without the field.
  assert.match(js, /typeof s\.phoneOnline === 'boolean'/);
  assert.match(js, /if \(phoneOnline !== online\) \{ phoneOnline = online; updateQr\(\); \}/, 'the QR still follows the verdict');
  // the 15s tick stays as the clock backstop for a phone that only pings — and
  // it now also refreshes the relative tile labels, which nothing else re-renders
  assert.match(js, /setInterval\(\(\) => \{ refreshRelativeTimes\(\); if \(!sseReady \|\| phoneOnline\) loadStats\(\); \}, 15000\)/);
});

// ---------- overlay layering, keyboard safety and the 2026-09 audit pass ----------

test('harness: one Escape closes only the TOP overlay', () => {
  // The lightbox key handler lacked the guard gridKeys has, so with the delete
  // confirm open OVER the viewer one Esc closed BOTH, Delete re-opened the
  // dialog, and arrows/R/± still acted on an image the user could not see.
  assert.match(js, /function escLayer\(\)/);
  assert.match(js, /const ESC_LAYERS = \[/);
  const lb = js.slice(js.indexOf("document.addEventListener('keydown', e => {\n  if ($('#lightbox').classList.contains('hidden')) { gridKeys(e); return; }"), js.indexOf('// ---------- live updates: SSE push'));
  assert.ok(lb.length > 0, 'the lightbox key handler is where we think it is');
  assert.match(lb, /if \(modalOpen\(\)\) return;/, 'a dialog stacked over the viewer owns the keyboard');
  // every layer's own close path defers to the ladder
  assert.match(js, /escLayer\(\) === 'confirm'/, 'Esc only settles the confirm when it is on top');
  assert.match(js, /escLayer\(\) === 'settings'/);
  assert.match(js, /escLayer\(\) === 'dir'/);
});

test('harness: grid shortcuts ignore modifier combinations', () => {
  // With a tile focused, Ctrl+X deleted it, Ctrl+P sent it to the phone (and
  // opened the print dialog), Ctrl+S toggled Select (and save-page), Ctrl+D
  // downloaded it (and bookmarked).
  assert.match(js, /if \(e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey\) return;/);
  // ...while Ctrl+Z keeps its own undo path
  assert.match(js, /e\.ctrlKey \|\| e\.metaKey\) \|\| e\.key\.toLowerCase\(\) !== 'z'/);
});

test('harness: the folder dialog outranks the settings modal that opens it', () => {
  // At 300 it rendered UNDERNEATH #settings-backdrop (350): dimmed, and every
  // click in it landed on the settings backdrop (closing Settings instead).
  const z = sel => Number((blocksFor(sel).match(/z-index\s*:\s*(\d+)/) || [])[1]);
  assert.ok(z('#dir-backdrop') > z('#settings-backdrop'),
    `#dir-backdrop (${z('#dir-backdrop')}) must stack above #settings-backdrop (${z('#settings-backdrop')})`);
  assert.ok(z('#toasts') > z('#settings-backdrop'), 'settings feedback is not dimmed behind the modal veil');
  assert.ok(z('#toasts') < z('#confirm-backdrop'), 'an interactive Undo never covers a destructive Delete');
});

test('harness: toasts are never a live region that contains the Undo button', { skip: skipOpt }, () => {
  const d = doc();
  // role=status on the pill means the Undo control lives INSIDE a status region
  assert.equal(d.querySelector('#toasts').getAttribute('role'), null);
  assert.equal(d.querySelector('#toasts').getAttribute('aria-live'), null);
  const announcer = d.querySelector('#toast-announcer');
  assert.ok(announcer, 'one persistent live region exists');
  assert.equal(announcer.getAttribute('role'), 'status');
  assert.equal(announcer.getAttribute('aria-live'), 'polite');
  assert.ok(d.querySelector('#toast-announcer').classList.contains('sr-only'), 'and it is not visible');
  // every toast path writes to it
  assert.match(js, /function announce\(msg\)/);
  assert.ok([...js.matchAll(/announce\(/g)].length >= 4, 'toast() and both undoable paths announce');
  assert.match(cssNoComments, /\.sr-only\s*\{/);
});

test('harness: relative timestamps stay honest while the page sits idle', () => {
  // timeAgoCached memoised by id FOREVER while syncGrid reuses nodes, so every
  // tile read "just now" for the whole session; and `ago()` had no day unit.
  assert.match(js, /const TIME_CACHE_TTL = \d+/);
  assert.match(js, /Date\.now\(\) - hit\.at < TIME_CACHE_TTL/);
  assert.match(js, /function refreshRelativeTimes\(\)/);
  // the handle is on the tile's TIME label now (P2: the meta row shows 14:31, not
  // `#14`) — the relative label still has to be re-read on the same tick, so the
  // assertion follows the handle rather than the old name
  assert.match(js, /d\._metaLeft = left/, 'the tile keeps a handle on its label');
  assert.match(js, /cell\._metaLeft\.textContent !== label/);
  assert.match(js, /row\._sub = sub/, 'transfer rows too');
  // `ago()` used to top out at hours, so a fortnight-old tile read "336h ago"
  assert.match(js, /if \(d < 30\) return d === 1 \? '1 day ago' : `\$\{d\} days ago`/, 'days are spelled out');
  assert.ok(!/return `\$\{Math\.floor\(s \/ 3600\)\}h ago`;\n};/.test(js), 'hours are no longer the last unit');
  assert.match(js, /function tileAria\(/);
  assert.match(js, /function tileAria\(c\) \{\s*const label = timeAgoCached\(c\);\s*const stamp = fullTimeCached\(c\);/, 'the accessible name carries the exact stamp');
});

test('harness: bulk selection is operable without typing on every tile', { skip: skipOpt }, () => {  const d = doc();
  assert.ok(d.querySelector('#bulk-all'), 'Select all exists in the bulk bar');
  assert.match(js, /\$\('#bulk-all'\)\.onclick/);
  assert.match(js, /\$\('#bulk-del'\)\.disabled = !selected\.size/, 'a 0-selection Delete is disabled');
  const bulk = blocksFor('.btn:disabled');
  assert.ok(bulk.length > 0 || /#bulk-bar \.btn:disabled/.test(cssNoComments), 'the disabled state is styled');
});

test('harness: the pairing legend, lightbox caption and byte ladder agree with the design system', () => {
  // DESIGN.md §1: phone = accent, PC = #60a5fa, in BOTH UIs and every badge
  assert.match(blocksFor('.origin.ic-pc'), /color:\s*#60a5fa/);
  // provenance used to be a tooltip nobody could open on touch
  assert.match(js, /const originLabel = c =>/);
  // The caption is ONE write (paintLbMeta — the viewer and the TIFF/HEIC
  // thumbnail fallback both reach it) and it must carry provenance, not just the
  // tooltip. The leading `#id` is gone deliberately: it was a database id where
  // the question is "where from, and when", and the position it trailed now has
  // its own centred slot in the bar (#lb-pos).
  assert.match(js, /\$\('#lb-caption'\)/, 'the caption element is still addressed');
  assert.match(js, /cap\.textContent = \[origin, fullTimeCached\(c\), note\]\.filter\(Boolean\)\.join\(' · '\)/, 'the caption carries the origin');
  assert.ok(!/#\$\{c\.id\}/.test(js.split('lb-caption')[1] || ''), 'the caption never leads with a database id');
  assert.match(js, /pos\.textContent = `\$\{lbIndex \+ 1\} \/ \$\{view\.length\}`/, 'the position has its own slot');
  // one byte ladder for both clients — the PC never emitted GB
  assert.match(js, /const u = \['B', 'KB', 'MB', 'GB', 'TB'\]/);
});

test('harness: shimmer, countdown bars and the drop pulse stay off the layout thread', () => {
  // H1/H2/H3 of the audit: background-position shimmer repainted every skeleton
  // every frame, the 10s undo bar animated `width`, and the drop overlay pulsed
  // a 500px box-shadow (a full-area repaint) for as long as a drag hovered.
  assert.match(cssNoComments, /\.skel-img::after \{[^}]*transform:\s*translateX\(-100%\)/);
  assert.match(cssNoComments, /@keyframes shimmer \{ to \{ transform:\s*translateX\(100%\); \} \}/);
  assert.match(cssNoComments, /@keyframes toast-shrink \{ from \{ transform:\s*scaleX\(1\); \} to \{ transform:\s*scaleX\(0\); \} \}/);
  assert.match(cssNoComments, /\.toast-undo-bar \{[^}]*transform-origin:\s*left center/);
  assert.match(cssNoComments, /@keyframes dropring/);
  assert.ok(!/@keyframes droppulse/.test(cssNoComments), 'the box-shadow pulse is gone');
  assert.match(cssNoComments, /\.u-bar i \{[^}]*transform:\s*scaleX\(0\)/);
  assert.match(js, /ui\.fill\.style\.transform = `scaleX\(\$\{/);
});

test('harness: no raw emoji left in the chrome icon slots', () => {
  // 📦 / ⬆ / ⚠ / ⚡ cannot take currentColor, render per-OS, and are read out
  // verbosely by assistive tech — the rest of the UI is Lucide mask icons.
  const html = fs.readFileSync(path.join(APP, 'public/index.html'), 'utf8');
  for (const glyph of ['📦', '⬆', '⚠', '⚡']) assert.ok(!html.includes(glyph), `${glyph} is gone from index.html`);
  for (const glyph of ['📦', '⬆', '⚠']) assert.ok(!js.includes(glyph), `${glyph} is gone from app.js`);
  assert.match(html, /class="ic ic-grid-3x3"/, 'the density buttons use icon classes, not inline SVG');
  assert.match(html, /class="ic ic-upload"/, 'and so does the drop overlay');
  assert.match(cssNoComments, /\.ic-grid-2x2 \{/);
  assert.match(cssNoComments, /\.ic-alert \{/);
});

test('harness: paging and sorting reuse existing tiles instead of rebuilding them', { skip: skipOpt }, () => {
  // "Load older" and the sort flip used to tear down every tile (a fresh <img>
  // per row, fresh listeners, keyboard cursor dropped). After the first paint
  // every load routes through syncGrid(), which adds/reorders only what changed.
  assert.match(js, /if \(incremental \|\| !firstLoad\) syncGrid\(\);\s*else renderGrid\(\)/,
    'every load after the first reuses the existing grid');
  assert.match(js, /localStorage\.pp_sort = sortOrder; paintSort\(\); syncGrid\(\)/,
    'a sort flip reorders in place instead of rebuilding');
  assert.match(js, /grid\.insertBefore\(el, wantNext\)/, 'syncGrid places nodes in order');
  // leaving Select mode / cancelling a selection only drops the visuals
  assert.match(js, /function clearSelection\(\)/);
  assert.match(js, /if \(!selectMode\) clearSelection\(\)/);
  assert.match(js, /\$\('#bulk-cancel'\)\.onclick = \(\) => clearSelection\(\)/);
  // and selection state is exposed to assistive tech, not color-only
  assert.match(js, /setAttribute\('aria-pressed', String\(selected\.has\(c\.id\)\)\)/);
});

// ---------- long server strings + motion (the 2026-09 UI pass) ----------

test('harness: a long file name cannot stretch the page out of the viewport', () => {
  // `1fr` is really `minmax(auto, 1fr)`: a grid item's automatic minimum size is
  // its MIN-CONTENT size, and .f-name is nowrap. `min-width: 0` on .f-info only
  // lets it shrink DURING layout — it cannot lower a min-content contribution, so
  // one 120-char file name inflated the track to 1104px and pushed the card 80px
  // past the right edge of a 1440px window (measured in Chrome). min-width:0 on
  // the grid item is what keeps the track on its share and lets the name
  // ellipsize, which is what .f-name was always meant to do.
  assert.match(blocksFor('.main-card'), /min-width:\s*0/, '.main-card is a shrinkable grid item');
  assert.match(blocksFor('.f-info'), /min-width:\s*0/, 'the transfer row shrinks around its name');
  assert.match(blocksFor('.f-name'), /text-overflow:\s*ellipsis/);
  assert.match(blocksFor('.capture-grid'), /minmax\(var\(--tile/, 'the capture grid still sizes from --tile');
});

test('harness: server strings echoed into chrome are capped and breakable', () => {
  // Toasts and the confirm dialog print file names and absolute paths verbatim,
  // and neither can know how long they are. Uncapped and unbreakable, the
  // centered toast grew wider than the viewport and dragged the bottom bar off
  // screen; the confirm text spilled straight out of its 380px box.
  assert.match(blocksFor('#toasts'), /max-width:\s*min\(/, 'the toast stack is capped to the viewport');
  assert.match(blocksFor('.toast'), /max-width:\s*100%/);
  assert.match(blocksFor('.toast'), /overflow-wrap:\s*anywhere/);
  assert.match(blocksFor('.confirm-box'), /max-width:\s*min\(/);
  assert.match(blocksFor('.confirm-box p'), /overflow-wrap:\s*anywhere/);
});

test('harness: grid shortcuts are inert while the captures view is hidden', () => {
  // The Transfers tab hides #captures with display:none, but its tiles stay in
  // the DOM — so every grid shortcut below still resolved a target: one arrow
  // key armed focusedIdx (focus() on a hidden tile silently fails) and the next
  // X/D/P deleted, downloaded or sent a capture that was not on screen. The
  // guard is the same view check updateBulkBar and the empty states already use.
  assert.match(js, /if \(!capturesVisible\(\)\) return;/, 'gridKeys refuses to act on a hidden grid');
  assert.match(js, /function capturesVisible/, 'the guard is the shared view check');
  assert.match(js, /bar\.classList\.toggle\('hidden', !selectMode \|\| !visible\)/, 'the bulk bar uses the same rule');
});

test('harness: the view tabs implement the ARIA tabs keyboard pattern', () => {
  const tabs = [...doc().querySelectorAll('[role="tab"]')];
  assert.equal(tabs.length, 2);
  // roving tabindex: ONE stop through the tablist, and it follows the selection
  assert.match(js, /function paintTabFocus\(\)/);
  assert.match(js, /tabIndex = activeTab === 'captures' \? 0 : -1/);
  assert.match(js, /paintTabFocus\(\); \/\/ the roving tabindex/);
  // arrows + Home/End move the selection (the pattern the extension popup uses)
  assert.match(js, /e\.key === 'ArrowRight' \|\| e\.key === 'ArrowDown'/);
  assert.match(js, /e\.key !== 'Home' && e\.key !== 'End'/);
  // one selection path shared by the pointer and the keyboard
  assert.match(js, /function selectTab\(t, \{ focus = false \} = \{\}\)/);
  assert.match(js, /\$\('#tab-transfers'\)\.onclick = \(\) => selectTab\('transfers'\)/);
  assert.match(js, /if \(focus\) \$\(TAB_IDS\[t\]\)\.focus\(\)/);
});

test('harness: "Delete all files" is the Transfers tab\'s own bulk action', () => {
  // Bulk delete used to be capture-only: on the Transfers tab there was no way
  // to clear the file list at all. The new button is .files-only (not .cap-only)
  // because it must be present on exactly the tab where the capture tools hide.
  const d = doc();
  const btn = d.querySelector('#del-all-files-btn');
  assert.ok(btn, 'the button exists');
  assert.ok(btn.classList.contains('files-only'), 'it is gated by .files-only, not .cap-only');
  assert.ok(btn.classList.contains('danger'), 'a destructive action carries the danger treatment');
  assert.equal(btn.querySelector('i.ic'), btn.querySelector('i.ic-trash'), 'same trash glyph as Delete all');
  // both tool sets are wired from applyTab(), which is the ONLY place tab
  // visibility is decided (two drifted rules were the class of bug here)
  assert.match(js, /querySelectorAll\('\.cap-only'\)\) el\.classList\.toggle\('hidden', !captures\)/);
  assert.match(js, /querySelectorAll\('\.files-only'\)\) el\.classList\.toggle\('hidden', !filesShown\)/);
  // it must hit the BULK files route, not the per-capture one
  assert.match(js, /api\('\/api\/files', \{ method: 'DELETE' \}\)/, 'calls the bulk files route');
  // no undo for a file wipe (a file row holds no local bytes) — so it confirms
  assert.match(js, /Delete ALL \$\{n\} transferred file\(s\)\?/);
});

test('harness: the dark app declares its color scheme and the viewer caption is announced', { skip: skipOpt }, () => {
  const d = doc();
  // without it, the canvas flashed white before style.css applied and native
  // scrollbars/form chrome rendered light inside every dark pane
  assert.equal(d.querySelector('meta[name="color-scheme"]').getAttribute('content'), 'dark');
  // the caption is the only thing that changes while arrowing through the
  // viewer; the phone announces the same fact (#viewer-pos is a live region)
  const cap = d.querySelector('#lb-caption');
  assert.equal(cap.getAttribute('role'), 'status');
  assert.equal(cap.getAttribute('aria-live'), 'polite');
});

test('harness: reveals and presses animate on compositor-only properties', () => {
  // The parts that had no animation at all: the view swap, the empty/loading
  // states, the bulk bar, the update banner, the lightbox, the two dialogs
  // without an exit transition, and every flat button (which snapped).
  for (const sel of ['#captures:not(.hidden)', '#transfers:not(.hidden)', '#lightbox:not(.hidden)',
    '#bulk-bar:not(.hidden)', '.empty:not(.hidden)', '#update-banner:not(.hidden)']) {
    // the selector may sit in a list (a rule can carry several of these states)
    assert.match(cssNoComments, new RegExp(`${sel.replace(/[.()#:]/g, '\\$&')}\\s*(?:,[^{}]*)?\\{[^}]*animation:`), `${sel} animates in`);
  }
  // #lb-bar is centered by translateX(-50%) — the keyframe must carry it, or the
  // bar jumps to the left half of the screen for the length of the animation
  assert.match(cssNoComments, /@keyframes lb-bar-in\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:\s*translateX\(-50%\)\s*translateY\(/);
  // press feedback reaches the transform, not just the colors
  assert.match(blocksFor('.toolbtn'), /transition:[^;]*transform/);
  // every keyframe this pass declares moves opacity/transform only
  const frames = [...cssNoComments.matchAll(/@keyframes\s+(pp-\w+|lb-bar-in)\s*\{([^}]*)\}/g)];
  assert.ok(frames.length >= 4, `the motion pass declares its keyframes (found ${frames.length})`);
  for (const [, name, body] of frames) {
    assert.ok(!/(?:width|height|top|left|right|margin|padding)\s*:/.test(body), `${name} animates no layout property`);
    assert.match(body, /opacity|transform/, `${name} animates a compositor property`);
  }
  // ...and the global kill switch still covers them
  assert.match(cssNoComments, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?animation:\s*none !important/);
});

test('harness: bulk selection works on the Transfers tab too', { skip: skipOpt }, () => {
  const d = doc();
  // Select was .cap-only, so the file list had no way into select mode and the
  // bulk bar hid with the capture tools — "Delete all files" was the only bulk
  // path a file list had.
  const sel = d.querySelector('#select-btn');
  assert.ok(sel, 'Select exists');
  assert.ok(!sel.classList.contains('cap-only'), 'Select is not capture-only');
  assert.ok(!sel.classList.contains('files-only'), 'and not transfers-only either');
  // the id space follows the ACTIVE TAB: capture ids and file ids are different
  // rows, so Show all (which puts both lists on screen) cannot decide it
  assert.match(js, /function selectedKey\(\) \{ return activeTab === 'transfers' \? 'file' : 'capture'; \}/);
  assert.match(js, /function transfersVisible\(\) \{ return activeTab === 'transfers' \|\| \$\('#show-all'\)\.checked; \}/);
  // switching tabs drops the set, or a capture id could reach the files route
  assert.match(js, /if \(selectMode && t !== activeTab\) clearSelection\(\);/);
  // "everything is selected" is the tab's own universe, not always the grid
  // ...and "everything" is what is ON SCREEN: with a filter applied, Select all
  // must not reach for rows the filter is hiding (filesView, not filesList)
  assert.match(js, /const universe = selectedKey\(\) === 'file' \? filesView\(\) : view;/);
  assert.match(js, /\$\('#bulk-all'\)\.disabled = !universe\.length \|\| selected\.size === universe\.length/);
});

test('harness: deleting selected files confirms, and promises no Undo', { skip: skipOpt }, () => {
  // Files hold no bytes on this client, so unlike a capture the delete cannot be
  // restored from memory: it must confirm and must NOT route through
  // deleteManyUndoable (which hardcodes /api/captures/:id and a 96MB budget)
  const start = js.indexOf("$('#bulk-del').onclick = async () => {");
  const branch = js.slice(start, js.indexOf('if (!await confirmDialog(`Delete ${selected.size} capture(s)?', start));
  assert.ok(start > 0 && branch.length > 100, 'the bulk-delete handler is where this test expects it');
  assert.match(branch, /await confirmDialog\(`Delete \$\{selected\.size\} file\(s\) from both devices\? This cannot be undone\.`\)/);
  assert.ok(!/await deleteManyUndoable\(/.test(branch), 'the file branch never uses the capture undo path');
  assert.match(branch, /api\('\/api\/files', \{\s*\n\s*method: 'DELETE', body: JSON\.stringify\(\{ ids \}\),/, 'the ids go to the bulk route');
  assert.match(branch, /for \(const id of ids\) fileRemove\(id\)/, 'the deleted rows are dropped without a refetch');
  // a coalesced SSE batch carries ids too — the single-row path carries id
  assert.match(js, /m\.type === 'file-deleted' && \(m\.id != null \|\| Array\.isArray\(m\.ids\)\)/);
  // the dead selector is gone: nothing in either client creates a .file-card,
  // so the second querySelector in fileRemove could never match anything
  assert.ok(!/file-card/.test(js), 'no dead .file-card selector');
  assert.ok(!/file-card/.test(css), 'and no dead .file-card rule');
});

test('harness: a transfer row is selectable, and selectable by keyboard', () => {
  // rows are built by buildFileRow(), so the surface is pinned in source, not
  // via the shipped markup (which is an empty container)
  assert.match(js, /function buildFileRow\(f\) \{/);
  // .f-info is the row's own surface — the tile's .capture-open equivalent — so
  // the name/size line is focusable and carries the toggle state
  assert.match(js, /info\.setAttribute\('role', 'button'\)/);
  assert.match(js, /info\.setAttribute\('aria-pressed', 'false'\)/);
  assert.match(js, /info\.tabIndex = 0/);
  assert.match(js, /info\.onkeydown = e => \{/);
  // one writer paints a row's selected look (ring + ✓ + aria-pressed)
  assert.match(js, /function paintFileSelect\(row, on\)/);
  assert.match(blocksFor('.transfer-row.sel'), /outline:\s*2px solid var\(--inv\)/, 'same ring the tile uses');
  assert.match(blocksFor('.transfer-row'), /position:\s*relative/, 'the absolute .sel-check needs this');
});

// ---------- P0 (2026-09): the control-boundary split + target sizes ----------
//
// The harness drew ALL 26 boundaries with --border (1.37–1.80:1), so a button, a
// card and a divider were the same hairline and nothing could look primary. That
// is why the toolbar had accumulated seven competing emphasis levels trying to
// compensate — it was fighting the token layer. DESIGN.md §1 had specified --ctl
// for exactly this and noted it was "wired on the phone; the harness still
// outlines controls with --border".

test('harness: every interactive boundary is --ctl, never --border', () => {
  const CONTROLS = ['.mini-btn', '#text-input', '.text-item', '.dir-manual',
    '.capture', '#lb-bar', '.btn', '#lb-close', '.pp-sel', '.toolbtn', '.view-tabs',
    '.transfer-row', '.f-actions .act', '.main-card.droptarget',
    '.auto-copy-toggle input', '.show-all-toggle input',
    '.chip']; // P2's origin filters join the same rule
  for (const sel of CONTROLS) {
    assert.match(blocksFor(sel), /border[^;]*var\(--ctl\)/, `${sel} is a control — its outline is --ctl`);
    assert.ok(!/border[^;]*var\(--border\)/.test(blocksFor(sel)), `${sel} must not draw its outline with --border`);
  }
});

test('harness: passive surfaces keep --border, so controls stand proud of them', () => {
  // 1.4.11 applies to CONTROLS. Pointing a divider or a card at --ctl is not a
  // fix — it makes the layout loud and destroys the hierarchy the split buys.
  const PASSIVE = ['header', '.card', '.pill', '.hint', '.confirm-box', '.dir-box',
    '.settings-box', '.upload-row', '.f-dir', '#bulk-bar'];
  for (const sel of PASSIVE) {
    assert.match(blocksFor(sel), /var\(--border\)/, `${sel} is a passive surface — it stays on --border`);
  }
  assert.match(blocksFor('.menu-sep'), /background:\s*var\(--border\)/, 'a separator is not a control');
  // The settings panel's single `.settings-sep` <hr> became three named group
  // headers; the group rail that replaced it is a passive surface, so it stays
  // on --border and the controls inside it are the only --ctl edges.
  assert.match(blocksFor('.settings-rows'), /border:\s*1px solid var\(--border\)/);
});

test('harness: the control boundary and its hover step clear 3:1 on every surface', () => {
  for (const surface of ['bg', 'card', 'card2']) {
    const rest = contrast(token('ctl'), token(surface));
    const hov = contrast(token('ctl-hover'), token(surface));
    assert.ok(rest >= 3, `--ctl on --${surface} is ${rest.toFixed(2)}:1 (needs >=3)`);
    assert.ok(hov >= 3, `--ctl-hover on --${surface} is ${hov.toFixed(2)}:1 (needs >=3)`);
    assert.ok(hov > rest, `--ctl-hover must be a visible step above --ctl on --${surface}`);
  }
  // the retired hover colour measured 1.72–2.26:1 — a state nobody could see
  assert.ok(!/#4a4d50/.test(cssNoComments), 'the grandfathered #4a4d50 hover border is gone');
  assert.ok(!/#3a3d41/.test(cssNoComments), 'and so is the one-off .droptarget hex');
});

test('harness: every interactive control is at least 28x28', () => {
  // WCAG 2.5.8's floor is 24x24; 28 is the desktop-comfortable size DESIGN.md §2
  // commits to. Measured before P0: tile actions 27x21, density segments 27x23,
  // the Show-all switch 38x22, "Hide QR" 58x16, the LAN link 202x17.3, the
  // transfer-row actions 24px, the settings mini-btns 24px, the quality slider
  // 20px, the toast Undo ~20px, and .btn had no padding at all so #update-refresh,
  // #empty-retry and the folder dialog's three buttons rendered ~20px tall.
  const MIN_H = ['.btn', '.toolbtn', '.pp-sel', '.mini-btn', '.f-actions .act',
    '.capture .act', '.menu-item', '.view-tabs .tab-btn', '.linkbtn', '#lan-url',
    '.chip']; // the origin filters are controls, so they carry a real target too
  for (const sel of MIN_H) {
    assert.match(blocksFor(sel), /min-height:\s*28px/, `${sel} declares a 28px minimum height`);
  }
  // icon-only controls: 32px squares in the toolbar, never below the floor
  for (const sel of ['.toolbtn', '.capture .act', '.toolbar .icon-btn']) {
    assert.match(blocksFor(sel), /min-width:\s*28px/, `${sel} can render icon-only — 28px minimum width`);
  }
  // a switch's LABEL is its target (it wraps the input), so the 38x22 track can
  // stay a switch instead of becoming a chunky one
  for (const sel of ['.auto-copy-toggle', '.show-all-toggle']) {
    assert.match(blocksFor(sel), /min-height:\s*28px/, `${sel} is a 28px-tall target`);
  }
  // text-level controls keep their type size and grow the box instead, so a text
  // row declares the 28px floor in min-height rather than stretching its type
  assert.match(blocksFor('.text-item'), /min-height:\s*28px/);
  assert.match(blocksFor('.texts-list .text-item'), /white-space:\s*normal/,
    'the dialog is where a text is READ, so its rows wrap');
  // <summary> keeps its list-item display (padding, not min-height) so the
  // disclosure marker survives
  assert.match(blocksFor('.kb-hint summary'), /padding:\s*5px 0/);
  assert.match(blocksFor('#quality-row input[type="range"]'), /height:\s*28px/,
    'the whole slider strip is draggable, not just the thumb');
  // ...and the ONE control whose target is a ::after expansion: growing the
  // painted pill to 28px would make EVERY toast 8px taller (38 -> 46px) to serve
  // a control most toasts do not have. Nothing else in a toast is interactive, so
  // the invisible expansion cannot steal a click, and it stays inside the toast's
  // own 9px padding, so `overflow: hidden` never clips it.
  assert.match(blocksFor('.toast-undo'), /position:\s*relative/);
  assert.match(blocksFor('.toast-undo::after'), /inset:\s*-5px -3px/);
});

// (the density trio's own guard lived here: 28px segments + a 1px inset in a
// 32px group. P1 replaced the trio with an icon menu and the segmented control
// moved to the view switch — `test/pc-ui.test.js` pins the new geometry.)

// ---------- webcam scan (PC harness) ----------
test('harness: the webcam scan is a modal that reuses the capture pipeline', { skip: skipOpt }, () => {
  const d = doc();
  const scanjs = fs.readFileSync(path.join(APP, 'public/scan.js'), 'utf8');
  const serverjs = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');

  // the vendored engine is actually present (a ~10MB single-file wasm build) and
  // the shell loads the module with its own content stamp
  const vendor = path.join(APP, 'public/vendor/opencv-4.13.0.js');
  assert.ok(fs.existsSync(vendor), 'OpenCV.js is vendored under public/vendor/');
  assert.ok(fs.statSync(vendor).size > 1_000_000, 'and it is the full build, not a stub');
  assert.match(html, /<script src="\/scan\.js\?v=__ASSET_SCAN__"><\/script>/,
    'the shell loads scan.js with its own content stamp');
  assert.match(serverjs, /\.replace\('__ASSET_SCAN__', assetStamp\('scan\.js'\)\)/,
    'the server stamps scan.js like the other shell assets');
  // version-in-the-name vendor libs can be cached for a year
  assert.match(serverjs, /vendor\$\{path\.sep\}/, 'the vendor dir is cached immutably');
  assert.match(serverjs, /max-age=31536000, immutable/, 'and never re-validated within that year');

  // the trigger is a real button beside ＋File, using the scan-line mask icon
  const btn = d.querySelector('#scan-btn');
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.getAttribute('aria-label'), "Scan a document with this PC's camera");
  assert.ok(btn.querySelector('.ic-scan'), 'it uses the scan-line mask icon');
  assert.match(cssNoComments, /\.ic-scan \{/);
  assert.equal(btn.closest('.tools'), d.querySelector('.tools'), 'it lives in the tools group');

  // the modal is a dialog on the SETTINGS tier — a new z-level would fight the
  // ladder in DESIGN.md §7
  const bd = d.querySelector('#scan-backdrop');
  assert.equal(bd.getAttribute('role'), 'dialog');
  assert.equal(bd.getAttribute('aria-modal'), 'true');
  assert.match(cssNoComments, /#settings-backdrop, #texts-backdrop, #scan-backdrop \{/,
    'it shares the settings backdrop (350)');
  assert.ok(d.querySelector('.scan-box'), 'it has its own landscape box');
  // the shutter/save is the ONE emphasis fill that system-wide --inv means
  assert.match(blocksFor('.scan-buttons .btn.primary'), /background:\s*var\(--inv\)/);

  // camera hygiene: a muted, playsinline viewfinder; every track stopped on close
  const video = d.querySelector('#scan-video');
  assert.ok(video.hasAttribute('muted') && video.hasAttribute('playsinline'),
    'the viewfinder is muted + playsinline (no mic, no iOS full-screen player)');
  assert.ok(d.querySelector('#scan-overlay'), 'the corner overlay exists');
  assert.match(scanjs, /getTracks\(\)\.forEach\(t => t\.stop\(\)\)/, 'every camera track is stopped on close');
  assert.match(scanjs, /getUserMedia/, 'it opens the camera itself');
  assert.match(scanjs, /warpPerspective/, 'it deskews with a perspective warp');
  assert.match(scanjs, /\.delete\(\)/, 'every cv.Mat is deleted (the wasm heap is not GC-ed)');
  assert.match(scanjs, /isSecureContext/, 'it refuses a non-loopback origin instead of failing silently');

  // the review stage: draggable corners + a deskewed preview, buttons hidden until then
  assert.ok(d.querySelector('#scan-review').classList.contains('hidden'), 'the review is hidden live');
  assert.ok(d.querySelector('#scan-send').classList.contains('hidden'), 'so is Save scan');
  assert.ok(d.querySelector('#scan-retake').classList.contains('hidden'), 'and Retake');
  assert.match(scanjs, /addEventListener\('pointerdown'/, 'the corners are draggable');

  // it reuses the harness upload route (source=pc, before the file part) and the
  // PNG clipboard path, then refreshes the grid
  assert.match(scanjs, /fd\.append\('source', 'pc'\)/, 'the crop is a PC-origin capture');
  assert.match(scanjs, /fetch\('\/upload'/, 'it POSTs to the same /upload as every capture');
  assert.match(scanjs, /writeCaptureToClipboard/, 'the result is auto-copied for instant Ctrl+V');
  assert.match(scanjs, /window\.loadCaptures/, 'and the grid is refreshed');

  // the harness routes BOTH triggers and lets Esc reach the top layer
  assert.match(js, /\['#scan-backdrop', 'scan'\]/, 'scan is an Esc layer');
  assert.match(js, /'#texts-backdrop', '#scan-backdrop', '#dir-backdrop'/,
    'grid shortcuts (X/D/arrows) are inert behind the scan dialog');
  assert.match(js, /\$\('#scan-btn'\)\.onclick = \(\) => window\.PPScan\?\.open\(\)/, 'the button opens it');
  assert.match(js, /escLayer\(\) === 'scan'\) window\.PPScan\?\.close\(\)/, 'Esc closes the top-layer scan');
});
