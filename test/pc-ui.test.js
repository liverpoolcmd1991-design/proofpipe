// PC harness shell + toolbar guards (P1 of the PC design review).
//
// Two things drove P1, both MEASURED on a real 1440×900 render:
//   · the window spent 118px of chrome on two stacked bands — a 49px header whose
//     right half was permanently empty, plus a 69px compose bar holding a
//     1338px-wide single-line field. The user's own summary of the screen was
//     "118px of chrome for one idea".
//   · the toolbar held 10 controls on THREE baselines (31 / 23 / 22px), two
//     inverted-white surfaces (the active tab AND the active density segment —
//     DESIGN.md §7 allows exactly one per screen) and wrapped to a 72px second
//     row at 860px.
//
// jsdom is loaded WITHOUT runScripts (same as test/harness-ui.test.js): app.js
// needs EventSource / Clipboard / IntersectionObserver at boot, so only the
// shipped markup is parsed and the JS glue is pinned by source assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(APP, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(APP, 'public/style.css'), 'utf8');
const js = fs.readFileSync(path.join(APP, 'public/app.js'), 'utf8');
const design = fs.readFileSync(path.join(APP, 'DESIGN.md'), 'utf8');

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
const token = name => (css.match(new RegExp(`--${name}:\\s*([^;]+);`)) || [])[1]?.trim();
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

// ---------- 1. one top band ----------

test('pc: the brand row and the compose bar are ONE 64px band', { skip: skipOpt }, () => {
  const d = doc();
  const header = d.querySelector('header');
  const bar = d.querySelector('#text-bar');
  assert.ok(header, 'the band is the header');
  assert.equal(bar.closest('header'), header, 'the compose group lives INSIDE it, not under it');
  assert.ok(d.querySelector('#text-input').closest('#text-bar'), 'the field is in the group');
  assert.ok(d.querySelector('#text-send').closest('#text-bar'), 'and so is Send');
  // the band declares its own height and derives nothing from a magic number
  assert.match(blocksFor('header'), /height:\s*var\(--topbar-h\)/);
  assert.equal(token('topbar-h'), '64px');
  assert.match(blocksFor('header'), /border-bottom:\s*1px solid var\(--border\)/, 'ONE band rule in 64px');
  assert.match(blocksFor('.app'), /flex:\s*1 1 auto/, 'the app still takes the rest of the window');
  // the arithmetic has to leave room for the field, or the 44px control would bind
  // the band open: 64 - 18 (9px padding ×2) - 1 (the rule) = 45 >= 44
  const pad = Number((blocksFor('header').match(/padding:\s*(\d+)px 24px/) || [])[1]);
  assert.equal(pad, 9, 'the band padding is what makes the 44px control fit');
  assert.match(blocksFor('#text-bar'), /--tb-ctl:\s*44px/);
  assert.ok(64 - pad * 2 - 1 >= 44, `64px band must fit the 44px field (${64 - pad * 2 - 1}px left)`);
  // and the field is capped: a 1338px-wide single-line field is a measure nobody reads
  // …and capped at 560px by a DEFINITE width. Not `flex-basis: 560px`: an
  // auto-sized flex item contributes its content width to its parent's intrinsic
  // size, so the strip's group measured itself 517px and shrank the field to
  // 185px (measured live) to fit inside it.
  assert.match(blocksFor('#text-bar'), /width:\s*560px/);
  assert.ok(!/flex-basis/.test(blocksFor('#text-bar')), 'a basis would not size the group');
  assert.match(blocksFor('#text-bar'), /margin-left:\s*auto/, 'the compose group sits at the band\'s end');
});

test('pc: the field is ONE row — it can no longer grow the band it sits in', () => {
  // DESIGN.md §7 used to promise "textareas auto-grow up to max-height: 150px",
  // which is fine in a bar that sizes itself and wrong in a fixed 64px band: a
  // long draft would push the whole library down and move Send off its baseline.
  assert.match(blocksFor('#text-input'), /max-height:\s*var\(--tb-ctl\)/);
  assert.match(blocksFor('#text-input'), /overflow-y:\s*auto/, 'long drafts scroll inside the field');
  assert.ok(!/Math\.min\(150,/.test(js), 'the auto-grow write is gone');
  assert.ok(!/textResizeRaf/.test(js), 'and so is its per-keystroke measure+write');
  assert.match(design, /one row tall in the top band/, 'the doc moved with the code');
  assert.ok(!/Textareas auto-grow/.test(design), 'the old promise is not left standing');
});

// ---------- 2. the inbound text is content ----------

test('pc: the recent texts sit beside the field, and Send never moves', { skip: skipOpt }, () => {
  const d = doc();
  // Send is pinned to the END of the field. The texts-dialog trigger is the ONE
  // thing after it, and it never moves — the old inbound chip was a sibling of
  // Send, so an arriving message displaced the button by 350px (x1372 → x1022).
  const bar = d.querySelector('#text-bar');
  const send = d.querySelector('#text-send');
  const controls = [...bar.querySelectorAll('button, textarea, input')].map(el => el.id);
  assert.deepEqual(controls, ['text-input', 'text-send', 'texts-btn'], 'the field, Send, then the texts dialog');
  assert.equal(send.nextElementSibling.id, 'texts-btn', 'only the texts trigger follows Send');
  // the glance belongs to the FIELD, not to the library: it is the strip in the
  // band immediately before #text-bar, and the captures grid keeps the whole card
  const strip = d.querySelector('#text-recent');
  const card = d.querySelector('.main-card');
  assert.equal(strip.closest('header'), d.querySelector('header'), 'it lives in the band');
  assert.equal(strip.closest('.main-card'), null, 'and out of the library card');
  assert.ok(card.firstElementChild.classList.contains('toolbar'),
    'the card now OPENS on the toolbar — the captures own the top of it');
  assert.equal(strip.nextElementSibling.id, 'text-bar', 'it sits directly before the field');
  assert.equal(strip.closest('#text-bar'), null, 'as a sibling, never a child of it');
  assert.equal(strip.parentElement.className, 'compose-group', 'the two are one group in the band');
  assert.equal(strip.querySelector('#text-recent-label').textContent, 'Recent texts');
  assert.ok(d.querySelector('#text-recent-rows'), 'it has a rows container');
  // every row is full width and a real 28px control, and the dialog trigger
  // sizes from .toolbtn so it cannot fall below the target floor
  assert.match(blocksFor('.text-item'), /width:\s*100%/);
  assert.match(blocksFor('.text-item'), /min-height:\s*28px/);
  assert.ok(d.querySelector('#texts-btn').classList.contains('toolbtn'),
    'the texts trigger sizes from .toolbtn → the 28px target floor');
  // the mail button is the dialog's ONLY trigger now, so it has to be RENDERED.
  // It shipped with `.hidden` hard-coded and nothing ever removed it, and the
  // dialog's one visible entry was the strip's own "Every text…" link.
  assert.ok(!d.querySelector('#texts-btn').classList.contains('hidden'),
    'the band trigger is not hidden — it is the only way into the dialog');
  assert.equal(d.querySelector('#texts-all'), null, 'the strip no longer carries a second trigger');
});

// ---------- 3. six controls, one height ----------

test('pc: the toolbar is six controls on ONE 32px baseline', { skip: skipOpt }, () => {
  const d = doc();
  const kids = [...d.querySelectorAll('.toolbar .tools > *')];
  const tools = kids.filter(el => !el.hidden);
  // five live controls on the right (.tools): sort · size · ＋File · scan · ⋯
  assert.equal(tools.length, 5, 'five controls in .tools (sort · size · ＋ · scan · ⋯)');
  assert.equal(d.querySelector('#scan-btn').closest('.tools'), d.querySelector('.tools'),
    'the webcam scan lives in the tools group, beside ＋File');
  assert.ok(d.querySelector('.toolbar .view-tabs'), 'plus the view switch');
  assert.deepEqual(kids.filter(el => el.hidden).map(el => el.id), ['file-input'],
    'the hidden file input is the only non-control child');
  // the old row: 10 controls, three heights, a <select> for a 2-way choice
  assert.equal(d.querySelector('#sort-sel'), null, 'the sort <select> is gone');
  assert.equal(d.querySelector('.dens'), null, 'the density trio is gone');
  // one height, declared once, read by every control in the row
  assert.match(blocksFor('.toolbar'), /--row:\s*32px/);
  assert.match(blocksFor('.toolbar .toolbtn'), /height:\s*var\(--row\)/);
  assert.match(blocksFor('.toolbar .toolbtn'), /min-height:\s*var\(--row\)/);
  assert.match(blocksFor('.toolbar .icon-btn'), /width:\s*var\(--row\)/);
  assert.match(blocksFor('.menu-item'), /height:\s*var\(--row/);
  // no dead selectors left behind from the trio/separators
  for (const dead of ['.dens', '.tool-group', '.tool-sep', '.del-far']) {
    assert.ok(!cssNoComments.includes(dead + ' '), `${dead} is gone from the stylesheet`);
    assert.ok(!html.includes(dead.replace('.', 'class="')), `${dead} is gone from the markup`);
  }
});

test('pc: the view switch is a real segmented control', { skip: skipOpt }, () => {
  const d = doc();
  assert.equal(token('seg'), '#171a1c', 'the track token exists (DESIGN.md §1)');
  const track = blocksFor('.view-tabs');
  assert.match(track, /background:\s*var\(--seg\)/, 'the track carries the fill');
  assert.match(track, /border:\s*1px solid var\(--ctl\)/, 'and the ONE outline');
  assert.match(track, /padding:\s*1px/, 'a 2px inset would leave 26px segments');
  assert.match(track, /height:\s*var\(--row/);
  // items carry neither a border nor a fill of their own — that is what lets four
  // bordered controls become one boundary
  const item = blocksFor('.view-tabs .tab-btn');
  assert.match(item, /border:\s*none/);
  assert.match(item, /background:\s*none/);
  // 32px track - 2 (border) - 2 (padding) = 28px segments, the desktop floor
  assert.match(item, /height:\s*calc\(var\(--row, 32px\) - 4px\)/);
  assert.match(item, /min-height:\s*28px/);
  assert.match(blocksFor('.view-tabs .tab-btn.active'), /background:\s*var\(--inv\)/);
  // still a real ARIA tablist (arrows + roving tabindex, unchanged by P1)
  const tabs = [...d.querySelectorAll('.view-tabs [role="tab"]')];
  assert.equal(tabs.length, 2);
  for (const tab of tabs) assert.ok(d.querySelector(`#${tab.getAttribute('aria-controls')}`));
});

test('pc: the toolbar paints exactly ONE inverted surface, and its count stays readable', { skip: skipOpt }, () => {
  // Before P1 an idle Captures view had TWO white surfaces (the active tab and the
  // active density segment), so neither could look primary — DESIGN.md §7: "a
  // screen has exactly one of them".
  assert.match(blocksFor('.view-tabs .tab-btn.active'), /background:\s*var\(--inv\)/);
  for (const sel of ['.toolbar .toolbtn', '.dens']) {
    assert.ok(!/background:\s*var\(--inv\)/.test(blocksFor(sel)), `${sel} must not be inverted too`);
  }
  assert.ok(!/background:\s*var\(--inv\)/.test(blocksFor('.menu-item')), 'a menu row is never inverted');
  assert.match(blocksFor('.menu-item[aria-pressed="true"]'), /background:\s*var\(--card2\)/,
    'a chosen menu item is a fill (the same rule the phone\'s sheet uses)');
  assert.ok(doc().querySelectorAll('#tools-menu .menu-item.active').length === 0,
    'no menu row ships as the active/inverted control');
  // the count inside the inverted segment cannot stay --faint on white
  const count = (blocksFor('.tab-btn.active .faint').match(/color:\s*(#[0-9a-f]{6})/i) || [])[1];
  assert.equal(count, '#5b6472');
  assert.ok(contrast(count, token('inv')) >= 4.5,
    `the segment count is ${contrast(count, token('inv')).toFixed(2)}:1 on the inverted fill`);
  // and the track fill is a slot, not a fourth emphasis level
  assert.ok(contrast(token('seg'), token('card2')) < 1.3, '--seg sits with --card, under --card2');
});

// ---------- 4. the overflow ----------

test('pc: Select, Show both lists and both wipes live behind the ⋯', { skip: skipOpt }, () => {
  const d = doc();
  const menu = d.querySelector('#tools-menu');
  for (const id of ['#select-btn', '#show-all', '#del-all-btn', '#del-all-files-btn']) {
    assert.ok(menu.contains(d.querySelector(id)), `${id} moved into the overflow`);
  }
  // the gates those buttons are wired to did not move with them
  assert.ok(d.querySelector('#del-all-btn').classList.contains('cap-only'));
  assert.ok(d.querySelector('#del-all-files-btn').classList.contains('files-only'));
  assert.ok(d.querySelector('#del-all-files-btn').classList.contains('danger'));
  assert.ok(!d.querySelector('#select-btn').classList.contains('cap-only'), 'Select serves BOTH lists');
  assert.match(js, /querySelectorAll\('\.cap-only'\)\) el\.classList\.toggle\('hidden', !captures\)/,
    'applyTab is still the one owner of tab visibility');
  // #show-all is still the single state holder every reader consults
  assert.match(js, /localStorage\.pp_show_all/);
  assert.match(js, /function capturesVisible\(\) \{ return activeTab === 'captures' \|\| \$\('#show-all'\)\.checked; \}/);
  assert.match(js, /function transfersVisible\(\) \{ return activeTab === 'transfers' \|\| \$\('#show-all'\)\.checked; \}/);
});

test('pc: the three menus open, close, and hand the keyboard back', { skip: skipOpt }, () => {
  const d = doc();
  for (const [btn, menu] of [['#sort-btn', '#sort-menu'], ['#dens-btn', '#dens-menu'], ['#tools-btn', '#tools-menu']]) {
    const b = d.querySelector(btn);
    const m = d.querySelector(menu);
    assert.ok(b && m, `${btn} → ${menu}`);
    assert.equal(b.getAttribute('aria-haspopup'), 'true');
    assert.equal(b.getAttribute('aria-expanded'), 'false', 'a closed trigger says so');
    assert.equal(b.getAttribute('aria-controls'), menu.slice(1));
    assert.equal(m.getAttribute('role'), 'group', 'a panel of controls, not a fake menu role');
    assert.ok(m.getAttribute('aria-label'), 'and it is named');
  }
  // the panel is positioned, painted and ordered above the library
  const panel = blocksFor('.menu');
  assert.match(panel, /position:\s*absolute/);
  const z = Number((panel.match(/z-index:\s*(\d+)/) || [])[1]);
  assert.ok(z > 1 && z < 150, `the panel (${z}) floats over the grid, under the banner (150)`);
  assert.match(panel, /visibility:\s*hidden/, 'closed = out of the tab order, no phantom focus stop');
  assert.match(blocksFor('.menu.open'), /visibility:\s*visible/);
  assert.match(blocksFor('.menu-right'), /left:\s*auto/, 'the ⋯ panel is right-aligned to its trigger');
  // and so is EVERY toolbar panel, not just the ⋯ (measured at 1440: a
  // left-anchored 196px panel hung 65px past `.main-card`'s content box — it made
  // the card report a horizontal overflow, which is the kind of thing that becomes
  // a scrollbar the moment the card gains `overflow-x`)
  for (const id of ['#sort-menu', '#dens-menu', '#tools-menu']) {
    assert.ok(doc().querySelector(id).classList.contains('menu-right'), `${id} is right-anchored`);
  }
  // wiring: one open at a time, dismissable three ways, one owner of aria-expanded
  assert.match(js, /function closeMenus\(\)/, 'ONE writer for the open state');
  assert.match(js, /const opening = !m\.menu\.classList\.contains\('open'\)/);
  assert.match(js, /e\.detail === 0/, 'a keyboard open moves focus into the panel');
  // `.menu` too: an open row/tile panel lives in the BODY, so it is no longer a
  // descendant of its trigger and `closest('.mpop')` alone would not match it
  assert.match(js, /addEventListener\('pointerdown', e => \{[\s\S]{0,300}closest\('\.mpop, \.menu'\)/, 'an outside press dismisses');
  // Escape settles the panel and hands focus back to whichever trigger opened
  // it — toolbar or transfer row — so it reads the trigger off the OPEN menu
  // rather than assuming the toolbar owns it
  assert.match(js, /e\.stopPropagation\(\); \/\/ capture phase[\s\S]{0,200}const trigger = \(open && open\.btn\) \|\| \(rowMenu && rowMenu\.btn\)/,
    'Escape closes only the panel and returns focus to its trigger');
  assert.match(js, /\}, true\);/, 'that Escape handler runs in the capture phase');
  assert.match(js, /function popupOpen\(\)/, 'ONE predicate answers for both kinds of panel');
  assert.match(js, /if \(popupOpen\(\)\) return;/, 'grid shortcuts are inert while a panel is up');
  // picking an ACTION closes the panel; the switch stays open so the state is seen
  assert.match(js, /if \(e\.target\.closest\('\.menu-item'\)\) closeMenus\(\)/);
  assert.ok(!/e\.target\.closest\('\.show-all-toggle'\)[\s\S]{0,40}closeMenus/.test(js),
    'the Show-both-lists switch does not close the panel it lives in');
});

// ---------- 5. the two icon menus reflect their state ----------

test('pc: sort and density remember their choice and say what it is', { skip: skipOpt }, () => {
  const d = doc();
  // sort: a two-row radio menu, remembered (it used to snap back to "newest")
  assert.equal(d.querySelectorAll('#sort-menu [data-sort]').length, 2);
  for (const b of d.querySelectorAll('#sort-menu [data-sort]')) {
    assert.ok(['true', 'false'].includes(b.getAttribute('aria-pressed')));
  }
  assert.match(js, /let sortOrder = localStorage\.pp_sort === 'old' \? 'old' : 'new'/);
  assert.match(js, /localStorage\.pp_sort = sortOrder; paintSort\(\); syncGrid\(\)/);
  assert.match(js, /const sorted = sortOrder === 'old' \? \[\.\.\.captures\]\.reverse\(\) : captures;/);
  // 'new' still ALIASES the captures array while nothing is filtered — only a
  // reversed sort or an active filter allocates (P2 added the second case)
  assert.match(js, /view = filterActive\(\) \? sorted\.filter\(matchCapture\) : sorted;/);
  // density: the trigger glyph carries the current size, the rows expose it too
  const dens = [...d.querySelectorAll('#dens-menu [id^="dens-"]')];
  assert.deepEqual(dens.map(b => b.id), ['dens-s', 'dens-m', 'dens-l']);
  for (const b of dens) assert.equal(b.getAttribute('aria-pressed'), 'false');
  assert.match(js, /const DENS_IC = \{ s: 'ic ic-grid-3x3', m: 'ic ic-grid-2x2', l: 'ic ic-square' \}/);
  assert.match(js, /\$\('#dens-btn-ic'\)\.className = DENS_IC\[d\]/);
  assert.match(js, /setAttribute\('aria-pressed', String\(on\)\)/, 'chosen state is exposed, not color-only');
});

// ---------- 6. P2: search, filter, and the missing bulk action ----------
//
// Three measured facts drove P2:
//   · 0 inputs matching /search|filter|query/ anywhere in the harness — at 14
//     captures the absence is invisible, at 200 it is the difference between a
//     tool and a toy. The origin key was a static legend: a colour explained by
//     something you could not click.
//   · every tile carried `#14` — a database id where the user's question is
//     "when was this" — and 14 "from phone" badges saying nothing.
//   · Select mode offered three controls and exactly one outcome (destroy), in an
//     app whose whole purpose is getting captures INTO a chat.

test('pc: the origin chips filter both lists, and the search field is gone', { skip: skipOpt }, () => {
  const d = doc();
  const filters = d.querySelector('.toolbar .filters');
  assert.ok(filters, 'the filter group is a child of the toolbar row, not a second band');
  assert.ok(filters.contains(d.querySelector('#origin-chips')), 'the chips live in the filter slot');
  // v1.20.0: the text search is GONE — markup, stylesheet hook and matcher
  assert.equal(d.querySelector('#search'), null, 'no search field in the markup');
  assert.ok(!/\.search-box\s*\{/.test(cssNoComments), 'and no search-box rule');
  assert.ok(!/matchQuery|captureHay/.test(js), 'the query matcher is gone too');
  // the old legend is a CONTROL now: three chips, one state each
  const chips = [...d.querySelectorAll('#origin-chips .chip')];
  assert.deepEqual(chips.map(c => c.dataset.origin), ['all', 'phone', 'pc']);
  assert.match(blocksFor('.chip'), /min-height:\s*28px/);
  // the chosen chip is a TINT — the inverted fill belongs to the view switch
  // (DESIGN.md §7: one per screen, and it is not a filter)
  assert.match(blocksFor('.chip.on'), /rgba\(34,\s*197,\s*94,\s*\.12\)/);
  assert.ok(!/var\(--inv\)/.test(blocksFor('.chip.on')), 'a filter is not the one inverted surface');
  // ONE state, one apply path, one writer for the chip paint
  assert.match(js, /let originFilter = 'all';/);
  assert.match(js, /const matchOrigin = o => originFilter === 'all' \|\| o === originFilter;/);
  assert.match(js, /function matchCapture\(c\) \{ return matchOrigin\(capOrigin\(c\)\); \}/);
  assert.match(js, /function filesView\(\) \{ return filterActive\(\) \? filesList\.filter\(matchFile\) : filesList; \}/);
  // a filter change only adds and removes nodes, so the tiles that stay keep their
  // decoded thumbnails, their place and the keyboard cursor
  assert.match(js, /function applyFilter\(\) \{\n {2}syncGrid\(\);\n {2}renderFiles\(\);\n {2}paintCount\(\);/);
  // the count says how many of the library are showing, or the filter looks broken
  assert.match(js, /const scope = filterActive\(\) && showing !== statsCount \? `\$\{showing\} of \$\{statsCount\}` : `\$\{statsCount\}`;/);
});

test('pc: a filter that matches nothing never claims the library is empty', { skip: skipOpt }, () => {
  const d = doc();
  assert.ok(d.querySelector('#empty-filtered'), 'there is a third empty state');
  assert.match(js, /\$\('#empty-filtered'\)\.classList\.toggle\('hidden', !visible \|\| capturesLoadError \|\| !filtered \|\| shown > 0\)/);
  // #empty still has exactly ONE writer, so two empty boxes can never be up at once
  assert.equal([...js.matchAll(/\$\('#empty'\)\.classList\.toggle/g)].length, 1);
  assert.match(js, /\$\('#empty-filtered-sub'\)\.textContent = filterSentence\('capture', 'captures'\)/);
  // origin-only now (the search is gone): it names the scope, not a query
  const sentence = js.slice(js.indexOf('function filterSentence'), js.indexOf('function filterSentence') + 420);
  assert.match(sentence, /return originFilter === 'all' \? `No \$\{many\} to show\.` : `No \$\{many\}\$\{scope\} yet\.`;/);
  assert.ok(!/innerHTML/.test(sentence), 'the sentence is never interpolated into HTML');
  // the transfers lane has the same three causes, so it says which one it is
  assert.match(js, /emptyLane\.querySelector\('\.empty-title'\)\.textContent = laneFiltered \? 'Nothing matches\.'/);
  assert.match(js, /\$\('#transfers-empty-sub'\)\.textContent = laneFiltered/);
  // ...and both empty states have a way out that does not involve re-reading them
  assert.match(js, /\$\('#filter-clear'\)\.onclick/);
});

test('pc: the tile meta shows the time, the size on demand, and badges only the exception', { skip: skipOpt }, () => {
  // `#14` was a database id sitting where the user's question is "when was this"
  assert.match(js, /function tileTime\(c\)/);
  assert.match(js, /left\.textContent = tileTime\(c\); \/\/ the time/);
  assert.match(js, /right\.textContent = fmtBytes\(c\.bytes\); \/\/ hover\/focus only/);
  assert.match(js, /d\._metaLeft = left/);
  // the relative label survives where a moving label belongs: the accessible name
  // and the hover title (that is also what refreshRelativeTimes re-reads)
  assert.match(js, /d\.title = `\$\{fullTimeCached\(c\)\} · \$\{timeAgoCached\(c\)\}`/);
  assert.match(js, /function tileAria\(c\)/);
  // quiet at rest, revealed on hover / focus-within — and not by colour alone
  assert.match(blocksFor('.capture .meta .sz'), /opacity:\s*0/);
  assert.match(blocksFor('.capture:hover .meta .sz'), /opacity:\s*1/);
  // PC ONLY: phone origin is the normal case, so it carries no badge at all
  assert.match(js, /if \(c\.origin === 'pc'\) \{/);
  assert.ok(!/origin-chip phone/.test(js), 'no phone-origin badge is built any more');
  assert.ok(!/origin-chip\.phone/.test(cssNoComments), 'and its rule is gone, not merely unused');
  // the filter and the badge agree about a pre-v2 (null-origin) row
  assert.match(js, /const capOrigin = c => \(c\.origin === 'pc' \? 'pc' : 'phone'\);/);
  assert.match(js, /const fileOrigin = f => \(f\.dir === 'phone' \? 'phone' : 'pc'\);/);
});

test('pc: a capture tile is TWO glyphs plus one ⋯, wrapped in one panel', { skip: skipOpt }, () => {
  // Four loose squares measured 27×21 and needed ~120px — more than a 110px
  // S-density tile — so they wrapped 2×2 and covered the photo they belonged to.
  // The panel measures 92×34 at every density: three 28px targets, 2px padding.
  assert.match(js, /panelBox\.className = 'act-panel'/);
  assert.match(js, /panelBox\.append\(copyBtn, toPhoneBtn, menuWrap\)/);
  assert.match(js, /menuWrap\.className = 'mpop cap-menu'/);
  // ONE boundary for three controls, instead of four painted squares
  const panel = blocksFor('.capture .act-panel');
  assert.match(panel, /display:\s*flex/);
  assert.match(panel, /background:\s*rgba\(0,0,0,\.78\)/);
  assert.match(panel, /border:\s*1px solid var\(--ctl\)/);
  // …and the glyph inside it is a 28px target with no chrome of its own
  const act = blocksFor('.capture .act');
  assert.match(act, /background:\s*transparent/, 'the panel is the chrome now');
  assert.match(act, /min-width:\s*28px/);
  assert.match(act, /min-height:\s*28px/);
  // the S-density overrides that only existed to shrink four squares are gone
  assert.ok(!/data-dens="s"\] \.capture \.act\b/.test(cssNoComments), 'no density-sized targets');
  // Download and Delete are occasional or destructive: behind the ⋯, never
  // beside the action the user came for
  assert.match(js, /delBtn\.className = 'menu-item danger';/);
  assert.match(js, /delBtn\.append\(delIcon, document\.createTextNode\('Delete capture'\)\)/);
  assert.match(js, /dl\.append\(dlIcon, document\.createTextNode\('Download'\)\)/);
  // the ⋯ panel is FIXED and closes on grid scroll — .capture-grid is a scroll
  // container, so a panel inside a tile is clipped exactly at the bottom row
  assert.match(blocksFor('.cap-menu .menu'), /position:\s*fixed/);
  // …and it must be hosted on the BODY while open: .capture:hover's
  // translateY(-2px) makes the tile the containing block for a fixed descendant,
  // so a panel built inside the tile landed 400px off in a live render and moved
  // again when the lift transitioned back (both measured at 1440×900)
  assert.match(js, /document\.body\.appendChild\(panel\); \/\/ BEFORE the measurement/);
  assert.match(js, /rowMenu\.panel\.remove\(\); \/\/ it was moved to the body while open/);
  assert.match(js, /e\.target\.closest\('\.mpop, \.menu'\)/, 'an outside press still dismisses it');
  assert.match(js, /\$\('#captures'\)\.addEventListener\('scroll', closeRowMenu/);
  // the panel is a CHILD of .capture, so it swallows its own clicks: otherwise a
  // press on its padding bubbles into d.onclick and opens the viewer underneath
  assert.match(js, /panel\.onclick = e => e\.stopPropagation\(\)/);
  // keyboard parity survives the move: X/D/C/P still reach the tile's controls
  assert.match(js, /d\._copyBtn = copyBtn; d\._tophoneBtn = toPhoneBtn; d\._delBtn = delBtn;/);
  assert.match(js, /menuBtn\.setAttribute\('aria-haspopup', 'true'\)/);
});

test('pc: transfer rows group by day and keep their actions out of the way', { skip: skipOpt }, () => {
  assert.match(js, /function makeDayHead\(ms\)/);
  assert.match(js, /function fileInsertRow\(box, f\)/);
  assert.match(js, /function pruneDayHeads\(box\)/);
  // a header is a SIBLING row, not a wrapper: one delete can never disturb a group
  assert.match(js, /const transferRows = box => \[\.\.\.box\.children\]\.filter\(el => !isDayHead\(el\)\);/);
  // ...and every paint pass goes through that helper, or a ✓ lands on a label
  assert.equal([...js.matchAll(/of transferRows\(/g)].length, 3);
  assert.ok(!/\$\('#transfers'\)\.children\) paintFileSelect/.test(js), 'no pass skips the helper');
  // sticky inside the scrolling ancestor, opaque so rows cannot slide through it
  assert.match(blocksFor('.day-head'), /position:\s*sticky/);
  assert.match(blocksFor('.day-head'), /background:\s*var\(--card\)/);
  // actions: zero at rest, two + ⋯ on hover / focus (a control you can tab to is
  // a control you can see)
  assert.match(blocksFor('.f-actions'), /opacity:\s*0/);
  assert.match(blocksFor('.transfer-row:focus-within .f-actions'), /opacity:\s*1/);
  assert.match(blocksFor('.f-actions .act'), /width:\s*28px/);
  // the ⋯ panel is FIXED and placed from the trigger's rect: the list scrolls, and
  // a panel inside a scroll container is clipped exactly where it is opened most
  assert.match(blocksFor('.f-menu .menu'), /position:\s*fixed/);
  assert.match(js, /function toggleRowMenu\(panel, btn\)/);
  assert.match(js, /\$\('#transfers'\)\.addEventListener\('scroll', closeRowMenu/);
  // keyboard parity: Enter opens, ⌘S saves, ⌫ deletes
  assert.match(js, /if \(\(e\.key === 's' \|\| e\.key === 'S'\) && \(e\.ctrlKey \|\| e\.metaKey\)\) \{ e\.preventDefault\(\); save\.click\(\); return; \}/);
  assert.match(js, /if \(e\.key !== 'Backspace' && e\.key !== 'Delete'\) return;/);
  // Delete lives behind the ⋯ instead of being the third identical text button
  assert.match(js, /del\.className = 'menu-item danger';/);
  assert.ok(!/'act del'/.test(js), 'the row no longer ships a bare text Delete');
  // 27 buttons for 9 files: gone. Three text buttons per row became zero at rest.
  assert.ok(!/open\.textContent = 'Open'/.test(js));
  assert.ok(!/save\.textContent = 'Save'/.test(js));
});

test('pc: Copy N is the bulk bar primary, and Delete is out of the way', { skip: skipOpt }, () => {
  const d = doc();
  const copy = d.querySelector('#bulk-copy');
  assert.ok(copy, 'Copy N exists in the bulk bar');
  assert.ok(copy.classList.contains('primary'), 'and it is the primary action');
  assert.ok(copy.classList.contains('cap-only'), 'a file has no image bytes — Copy is captures-only');
  // ONE gesture over N images: the items are built over PROMISES so the single
  // write starts inside the click (PITFALLS #57), with visible progress — a
  // control that does nothing for ten seconds reads as broken
  assert.match(js, /\$\('#bulk-copy'\)\.onclick = async \(\) => \{/);
  assert.match(js, /const items = targets\.map\(c => new ClipboardItem\(\{ 'image\/png': encodeCapture\(c\) \}\)\);/);
  assert.match(js, /await navigator\.clipboard\.write\(items\)/);
  // a platform that keeps ONE image is told about, never silently half-copied
  assert.match(js, /await navigator\.clipboard\.write\(\[items\[0\]\]\)/);
  assert.match(js, /this browser keeps one image per copy/);
  assert.match(js, /paintBulkCopy\(\); \/\/ restores the label AND the enabled state/);
  // the primary says how many it will copy, and the destructive action sits at the
  // far end, past a gap — it is not shoulder-to-shoulder with the safe one
  assert.match(js, /\$\('#bulk-copy-label'\)\.textContent = selected\.size \? `Copy \$\{selected\.size\}` : 'Copy';/);
  assert.match(blocksFor('#bulk-bar .btn.danger'), /margin-left:\s*auto/);
  // `#fff` is sanctioned here by DESIGN.md §7 (the bulk bar is a docked overlay,
  // not a fourth level in the toolbar's emphasis scale)
  assert.match(blocksFor('#bulk-bar .btn.primary'), /background:var\(--inv\); color:var\(--inv-fg\)/);
  assert.match(design, /bulk bar[\s\S]{0,80}primary/i);
});

test('pc: a clipboard write starts inside the click, over a PROMISE', { skip: skipOpt }, () => {
  // PITFALLS #57, the harness half: `write()` needs transient user activation
  // (~5s) and the clipboard only takes PNG, so awaiting the re-encode of a
  // fresh 12MP capture before the write spends the activation on the encode.
  // The symptom was precise — copying a RECENT capture said "blocked" and then
  // worked on a second click, because the first run had already filled pngCache.
  // The extension was fixed this way; the harness kept the awaited shape.
  assert.ok(
    !/ClipboardItem\(\{ 'image\/png': await encodeCapture/.test(js),
    'never await the encode before calling write()'
  );
  assert.match(js, /const png = encodeCapture\(c\);/);
  assert.match(js, /await navigator\.clipboard\.write\(\[new ClipboardItem\(\{ 'image\/png': png \}\)\]\);/);
  // the awaited form survives ONLY as the fallback for a build that refuses a
  // promised blob — and a real failure is rethrown, not retried into a second
  // identical error
  assert.match(js, /if \(!\(e instanceof TypeError\)\) throw e;/);
  assert.match(js, /new ClipboardItem\(\{ 'image\/png': await png \}\)/);
  // two callers that overlap (click, then auto-copy) share ONE encode
  assert.match(js, /const pngPending = new Map\(\);/);
  assert.match(js, /if \(inflight\) return inflight;/);
  // the toast alone hides why; the console keeps the reason
  assert.match(js, /console\.debug\('ProofPipe copy failed:', e\)/);
});

// ---------- 7. P3: first run, and a rail that earns its column ----------
//
// Three measured facts drove P3:
//   · the 320px rail spent 331.8px of 742px (44.7%) empty at 1440×900 and 511.8px
//     of 922px (55.5%) at 1920×1080 — a pill, a QR that vanishes on pairing, three
//     lines of storage text and a legend you could not click. Below 900px it
//     overflowed a 40dvh cap by 108.9px, giving a 700px window TWO scroll regions.
//   · a fresh install showed three lines of 12.5–16px grey text in a 996×661 void
//     beside a full set of tools: every control present, none able to do anything.
//   · "31.5 MB" answered nothing without the cap beside it.

test('pc: the rail is a 264px column of four answer-cards', { skip: skipOpt }, () => {
  const d = doc();
  const rail = d.querySelector('#rail');
  assert.ok(rail.classList.contains('card') && rail.classList.contains('side'));
  // the four questions: connected · how do I pair · how full am I · did it land
  assert.deepEqual(
    [...rail.querySelectorAll('.rail-card')].map(s => s.id),
    ['status-card', 'pair-card', 'cap-card', 'recent-card']);
  for (const s of rail.querySelectorAll('.rail-card')) {
    assert.ok(s.getAttribute('aria-labelledby'), 'every card is named by its own label');
    assert.ok(d.querySelector(`#${s.getAttribute('aria-labelledby')}`), 'and the label exists');
  }
  // 320px was 22% of a 1440px window; the column is narrower AND fuller now
  assert.match(blocksFor('.view'), /grid-template-columns: 264px minmax\(0, 1fr\)/);
  // the legend is gone (P2 turned it into the toolbar's chips) — there must be
  // exactly ONE origin vocabulary in the markup
  assert.equal(d.querySelectorAll('.legend').length, 0);
  // the cards STRETCH: a centred stack of labels is what left the column empty
  assert.match(blocksFor('.card.side'), /align-items:\s*stretch/);
});

test('pc: the status card says what "Live" means, and the meter says how full', { skip: skipOpt }, () => {
  const d = doc();
  // "Live" in a 28px pill is one word; the card behind it is the sentence
  const stats = d.querySelector('#stats');
  assert.ok(stats, 'the status card body exists');
  assert.equal(stats.getAttribute('aria-live'), 'polite', 'a state change is announced');
  assert.match(js, /text: 'Connected', cls: 's-online', dot: 'ok'/);
  assert.match(js, /text: 'Not connected', cls: 's-offline', dot: 'warn'/);
  assert.match(js, /d\.className = `dot \$\{l\.dot\}`/);
  assert.match(js, /Synced \$\{ago\(s\.phoneLastSeen\)\}/);
  // the presence lamp is a real element, not a background trick, so it stays
  // aligned with the text when the sentence wraps
  assert.match(blocksFor('#stats .s-online'), /align-items:\s*center/);
  // the capacity meter: a bar plus ONE sentence. "31.5 MB" alone answered nothing
  const meter = d.querySelector('#meter');
  assert.equal(meter.getAttribute('role'), 'progressbar');
  assert.equal(meter.getAttribute('aria-valuemin'), '0');
  assert.equal(meter.getAttribute('aria-valuemax'), '100');
  assert.ok(d.querySelector('#meter-fill'));
  assert.match(blocksFor('.meter'), /height:\s*4px/);
  assert.match(blocksFor('.meter.over i'), /background:\s*var\(--danger\)/);
  assert.match(js, /meter\.setAttribute\('aria-valuenow', String\(pct\)\)/);
  assert.match(js, /meter\.classList\.toggle\('over', pct >= 80\)/);
  // the denominator comes from the SAME payload, so the meter is honest on first
  // paint instead of reading 0% until /api/settings lands
  assert.match(js, /capText\.textContent = `\$\{fmtBytes\(s\.bytes\)\} of \$\{fmtBytes\(cap\)\}/);
  // Manage… opens Settings rather than guessing which of cap/cleanup was meant
  assert.match(js, /\$\('#manage-storage'\)\.onclick = \(\) => openSettings\(\)/);
});

test('pc: the Recent list is the "did it land?" answer, and it names direction', { skip: skipOpt }, () => {
  const d = doc();
  assert.ok(d.querySelector('#recent-list') && d.querySelector('#recent-empty'));
  assert.match(js, /for \(const r of recent\) \{/);
  assert.match(js, /const out = r\.dir === 'pc';\n {10}li\.className = out \? 'r-out' : 'r-in';/);
  assert.match(js, /i\.className = `ic \$\{r\.kind === 'file' \? 'ic-file' : 'ic-image'\}`/);
  // kind is the glyph, direction is the colour — one signal each, not two colours
  assert.match(blocksFor('.rail-list .r-in .ic'), /color:\s*var\(--accent\)/);
  assert.match(blocksFor('.rail-list .r-out .ic'), /color:\s*#60a5fa/);
  // ...but colour is never the ONLY carrier: the row spells the direction out
  // for a screen reader, because a three-row rail has no room for the words
  assert.match(js, /dir\.className = 'sr-only';/);
  assert.match(js, /dir\.textContent = out \? 'To your phone:' : 'From your phone:';/);
  assert.ok(cssNoComments.includes('.sr-only'), 'and the helper class is defined');
  // a file name can be 200 chars and is server data: textContent only, one line
  assert.match(js, /name\.textContent = r\.label;/);
  assert.match(blocksFor('.rail-list .r-name'), /text-overflow:\s*ellipsis/);
  // the empty copy hides the moment there is something to show
  assert.match(js, /\$\('#recent-empty'\)\?\.classList\.toggle\('hidden', recent\.length > 0\)/);
  // the payload is assembled server-side from two bounded queries (3 rows each),
  // so the rail does not drag a 100-row /api/files page along to name three rows
  const server = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
  assert.match(server, /recent: \[/);
  assert.equal([...server.matchAll(/stmts\.listCaptures\.all\(3\)|stmts\.listFiles\.all\(3\)/g)].length, 2);
  assert.match(server, /\.sort\(\(a, b\) => \(a\.at < b\.at \? 1 : a\.at > b\.at \? -1 : 0\)\)\.slice\(0, 3\)/);
});

test('pc: below 900px the rail is a DRAWER, so there is one scroll region', { skip: skipOpt }, () => {
  const d = doc();
  const mq = cssNoComments.match(/@media \(max-width: 899px\) \{([\s\S]*?)\n\}/);
  assert.ok(mq, 'the breakpoint is 899px');
  const block = mq[1];
  assert.match(block, /\.view \{ grid-template-columns: minmax\(0, 1fr\); grid-template-rows: minmax\(0, 1fr\); \}/,
    'the rail leaves the grid — no second row, no second scroller');
  assert.match(block, /position:\s*fixed/, 'out of flow');
  assert.match(block, /z-index:\s*320/);
  // closed = off-canvas AND out of the tab order: a translated panel is still focusable
  assert.match(block, /transform:\s*translateX\(101%\); visibility:\s*hidden/);
  assert.match(block, /\.card\.side\.open \{ transform:\s*none; visibility:\s*visible; \}/);
  // the trigger renders ONLY where the rail is a drawer, and the veil only with it
  assert.match(blocksFor('#rail-toggle'), /display:\s*none/, 'hidden above the breakpoint');
  // the drawer's overrides live in a SECOND 899px block, AFTER the base rules:
  // `#rail-toggle { display: none }` and the drawer's `display: grid` have the
  // same specificity (one id each), so source order decides. With the override
  // inside the block at the top of the file the trigger was permanently hidden
  // and the rail unreachable below 900px — measured, not guessed:
  // getComputedStyle('#rail-toggle').display === 'none' at 800px. The last
  // 899px block in the sheet must come after the base declarations.
  const blocks = [...cssNoComments.matchAll(/@media \(max-width: 899px\) \{([\s\S]*?)\n\}/g)].map(m => m[1]);
  assert.equal(blocks.length, 2, 'the drawer has two blocks: layout, then the trigger override');
  assert.match(blocks[1], /#rail-toggle \{ display: grid; \}/);
  assert.match(blocks[1], /#rail-backdrop:not\(\.hidden\) \{ display: block; \}/);
  assert.ok(cssNoComments.indexOf('#rail-toggle { display: none;') < cssNoComments.lastIndexOf('@media (max-width: 899px)'),
    'the base `display: none` precedes the drawer override — order is the whole fix');
  assert.match(blocksFor('#rail-backdrop'), /z-index:\s*310/);
  // the element that exists only as a drawer trigger is a real button with state
  const toggle = d.querySelector('#rail-toggle');
  assert.equal(toggle.tagName, 'BUTTON');
  assert.equal(toggle.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'shipped closed');
  assert.equal(toggle.getAttribute('aria-controls'), 'rail');
  // ...and one Escape closes only the TOP layer, with the drawer at the bottom
  assert.match(js, /\['#rail-backdrop', 'rail'\],/);
  assert.match(js, /if \(e\.key === 'Escape' && escLayer\(\) === 'rail'\) closeRail\(\)/);
  // the breakpoint test is the trigger's own computed display — there is no second
  // copy of 899 to keep in step
  assert.match(js, /const railIsDrawer = \(\) => getComputedStyle\(\$\('#rail-toggle'\)\)\.display !== 'none';/);
  // a drawer left open while the window widens would sit translated over the library
  assert.match(js, /addEventListener\('resize', \(\) => \{ if \(!railIsDrawer\(\)\) closeRail\(\); \}\)/);
  // modal surface: Tab is trapped, and the grid's shortcuts are inert behind it
  assert.match(js, /trapFocus\(railEl, railEl\.querySelector\('button, a, select, input'\)\)/);
  assert.match(js, /'#confirm-backdrop', '#rail-backdrop'\]/);
});

test('pc: first run is a three-step setup card that resolves into the library', { skip: skipOpt }, () => {
  const d = doc();
  const setup = d.querySelector('#setup');
  assert.ok(setup, 'the setup card exists');
  assert.ok(setup.classList.contains('hidden'), 'and ships hidden — loadStats owns the verdict');
  assert.match(blocksFor('.setup-steps'), /max-width:\s*460px/);
  // three steps, in ORDER, each a numbered row
  const steps = [...setup.querySelectorAll('.setup-step')].map(s => s.id);
  assert.deepEqual(steps, ['setup-1', 'setup-2', 'setup-3']);
  for (const s of setup.querySelectorAll('.setup-step')) {
    assert.ok(s.querySelector('.setup-n'), 'each step is numbered');
    assert.ok(s.querySelector('b'), 'and states its instruction');
    assert.ok(s.querySelector('.setup-sub'), 'and says how');
  }
  // step 1 renders NO second QR: the pairing code lives in the rail, and a copy
  // here is the exact bug test/harness-ui.test.js pins ('exactly ONE pairing QR')
  assert.equal(setup.querySelectorAll('img').length + setup.querySelectorAll('canvas').length, 0,
    'the setup card draws no QR of its own');
  // steps 2–3 dim to 45% until the phone has actually connected: a step the user
  // cannot do yet should look like it
  assert.match(blocksFor('.setup-step.dim'), /opacity:\s*\.45/);
  assert.match(js, /function stepSet\(phoneConnected\)/);
  assert.match(js, /\['#setup-2', '#setup-3'\]\) \$\(id\)\.classList\.toggle\('dim', !phoneConnected\)/);
  assert.match(js, /stepSet\(!never\)/);
  // it RESOLVES: the first arrival (or the first paired phone) ends it for good
  assert.match(js, /const firstRun = !anyData && !phoneEverSeen && !capturesLoadError && capturesVisible\(\);/);
  assert.match(js, /anyData = s\.count > 0 \|\| \(s\.files\?\.count \?\? 0\) > 0;/);
  // and #empty defers to it, so "No captures yet." never prints under the card
  assert.match(js, /const setupUp = \$\('#setup'\) && !\$\('#setup'\)\.classList\.contains\('hidden'\);/);
  assert.match(js, /classList\.toggle\('hidden', setupUp \|\| !visible/);
  // step 1's button shows the code — and opens the drawer at drawer widths, or it
  // would "scroll" the user to a panel that is off-canvas
  assert.match(js, /\$\('#setup-pair'\)\.onclick = \(\) => \{ qrAuto = false; pairShown = true; updateQr\(\); openRail\(\); \}/);
});

test('pc: a fresh install hides the tools that can do nothing', { skip: skipOpt }, () => {
  const d = doc();
  // the markup ships gated, so there is no frame where sort/Delete-all are live
  // over an empty grid before the first /api/stats reply
  assert.ok(d.querySelector('.main-card').classList.contains('no-data'));
  assert.match(blocksFor('.main-card.no-data .filters'), /display:\s*none/,
    'search + origin chips are hidden with nothing to filter');
  assert.match(cssNoComments, /\.main-card\.no-data \.mpop\.cap-only,[\s\S]{0,200}#del-all-files-btn \{ display: none; \}/);
  // the two things a first-run screen is FOR stay: which view, and adding data
  assert.ok(!/no-data[^{]*\.view-tabs/.test(cssNoComments), 'the view switch stays');
  assert.ok(!/no-data[^{]*file-add/.test(cssNoComments), '＋File stays — it is how the first data arrives');
  assert.ok(!/no-data[^{]*#search\b/.test(cssNoComments));
  assert.ok(!/no-data[^{]*#text-input/.test(cssNoComments), 'the compose field stays');
  // JS is the only writer, and it reads ONE verdict from ONE payload
  assert.match(js, /document\.querySelector\('\.main-card'\)\?\.classList\.toggle\('no-data', !anyData\)/);
});

// ---------- P4: viewer polish, settings structure, keyboard ----------

test('pc: settings is three named groups, and each row is one grid with a right control column', { skip: skipOpt }, () => {
  const d = doc();
  // the flat list gave "copy new captures" and "back up everything" the same
  // weight and left every switch on the left beside every select on the right
  const groups = [...d.querySelectorAll('.settings-list > .settings-group')];
  assert.equal(groups.length, 3, 'three groups, no more');
  assert.deepEqual(groups.map(g => g.querySelector('.settings-group-h').textContent.trim()),
    ['Capture', 'Storage', 'Devices & app']);
  for (const g of groups) assert.ok(g.querySelector('.settings-rows'), 'every group owns one row rail');
  // every existing control kept its id, so its handler still binds — the
  // restructure is markup only
  for (const id of ['#auto-copy', '#auto-paste-pc', '#quality-reduce', '#auto-cleanup',
    '#cap-sel', '#retention-sel', '#backup-btn', '#auto-inbox', '#browser-sel']) {
    assert.ok(d.querySelector(id), `${id} survives the restructure`);
  }
  // the row anatomy: label left, CONTROL RIGHT (the switch is the last child)
  assert.match(blocksFor('.settings-rows .auto-copy-toggle'), /justify-content:\s*space-between/);
  assert.match(blocksFor('.settings-rows'), /grid-auto-rows:\s*minmax\(36px, auto\)/);
  // and NO destructive group here — the two wipes belong beside the list they
  // destroy (the toolbar's ⋯), which is where the review's own §4 puts them
  assert.ok(!/\.settings-group[^{]*danger/.test(cssNoComments), 'no Danger zone in settings');
  assert.ok(!/settings-danger|danger-zone/.test(html), 'and no such markup');
});

test('pc: the viewer bar is glyphs with a centred position and a fading caption', { skip: skipOpt }, () => {
  const d = doc();
  const bar = d.querySelector('#lb-bar');
  // four words became four 34×34 squares: the labels were what made the
  // position fight them for room
  assert.equal(bar.querySelectorAll('.lb-act').length, 4, 'copy · download · rotate · delete');
  for (const b of bar.querySelectorAll('.lb-act')) {
    assert.ok(b.getAttribute('aria-label'), 'each keeps its accessible name');
    assert.equal(b.textContent, '', 'and draws no text of its own');
  }
  assert.ok(bar.querySelector('#lb-pos'), 'the position sits in the bar, not in a sentence');
  assert.equal(bar.querySelector('#lb-del').getAttribute('aria-label'), 'Delete capture');
  assert.match(blocksFor('#lb-pos'), /font-variant-numeric:\s*tabular-nums/);
  // the caption fades 2s after the last move (context, not chrome)
  assert.match(blocksFor('#lb-meta.idle #lb-caption'), /opacity:\s*0/);
  assert.match(js, /lbMetaIdle = setTimeout\(\(\) => meta\.classList\.add\('idle'\), 2000\)/);
  // the permanent zoom sentence is now a ONE-TIME coach mark that retires on the
  // first zoom or at 6s — it is never still there on the second visit
  assert.match(js, /function showCoach\(retiring = false\)/);
  assert.match(js, /if \(retiring \|\| localStorage\.pp_lb_zoomed\)/);
  assert.match(js, /lbCoachTimer = setTimeout\(\(\) => el\.classList\.add\('gone'\), 6000\)/);
  assert.match(js, /localStorage\.pp_lb_zoomed = '1'/);
  // matched-geometry open: the tile grows into the stage, transform-only, and
  // the animation is on #lb-stage — never on the overlay, which would stretch
  // the toolbar for its 240ms
  assert.match(js, /function flipFrom\(el\)/);
  assert.match(js, /lbStage\.animate\(/);
  assert.ok(js.includes("matchMedia('(prefers-reduced-motion: reduce)').matches) return"), 'reduced-motion users skip the FLIP');
  assert.match(js, /flipFrom\(src\)/);
  assert.ok(!/#lightbox\.animate\(/.test(js), 'the overlay never animates a scale');
});

test('pc: 1/2/3, ⌘A, ⌘C and ⌘⇧S act on the view and the selection', { skip: skipOpt }, () => {
  // 3 is the SAME state #show-all owns, set through the checkbox so nothing can
  // disagree about which view is up
  assert.match(js, /if \(!mod && !e\.altKey && \(e\.key === '1' \|\| e\.key === '2' \|\| e\.key === '3'\)\)/);
  assert.match(js, /\$\('#show-all'\)\.checked = showAll;/);
  assert.match(js, /selectTab\(e\.key === '2' \? 'transfers' : 'captures'\)/);
  // ⌘A enters Select mode first — the bulk bar (and Select all) only exist there
  assert.match(js, /if \(!selectMode\) \$\('#select-btn'\)\.click\(\);/);
  assert.match(js, /\$\('#bulk-all'\)\.click\(\);/);
  // ⌘C copies the SELECTION; with nothing selected the browser keeps its own
  // Ctrl+C (copying text is still the common case)
  assert.match(js, /if \(selectedKey\(\) !== 'capture' \|\| !selected\.size\) return;/);
  assert.match(js, /\$\('#bulk-copy'\)\.click\(\);/);
  // ⌘⇧S saves the selection — the per-row download gesture, repeated
  assert.match(js, /function saveSelection\(\)/);
  assert.match(js, /a\.download = t\.name;/);
  // every chord is scoped to a NON-editable target, and inert while a dialog or
  // a toolbar panel owns the screen
  assert.match(js, /if \(modalOpen\(\) \|\| popupOpen\(\)\) return;/);
  assert.match(js, /if \(t && \(t\.tagName === 'INPUT' \|\| t\.tagName === 'SELECT' \|\| t\.tagName === 'TEXTAREA' \|\| t\.isContentEditable\)\) return;/);
});

test('pc: Shift+click selects a range; the position, not the labels, is what moves', { skip: skipOpt }, () => {
  // the anchor is the last PLAIN pick, and it lives only as long as the
  // selection does — a stale anchor would range to a tile picked minutes ago
  assert.match(js, /let selAnchor = null;/);
  assert.match(js, /selAnchor = null; \/\/ nothing is selected/);
  for (const fn of ['function selectRangeCaptures(toId)', 'function selectRangeFiles(toId)']) {
    assert.match(js, new RegExp(fn.replace(/[()]/g, '\\$&')));
  }
  // additive, walked inside the ACTIVE list only (view / filesView) — the same
  // universe Select all uses, so a range can never reach a filtered-out row
  assert.match(js, /const ids = view\.map\(c => c\.id\);/);
  assert.match(js, /const ids = filesView\(\)\.map\(f => f\.id\);/);
  // ONE writer per surface: the tiles route through paintCaptureSelect, the
  // rows through paintFileSelect
  assert.match(js, /function paintCaptureSelect\(id, on\)/);
  assert.match(js, /paintCaptureSelect\(id, selected\.has\(id\)\)/);
  // the tile: Shift ranges, Ctrl/⌘ toggles — neither needs Select mode
  assert.match(js, /if \(e\.shiftKey && !e\.ctrlKey && !e\.metaKey\) \{ selectRangeCaptures\(c\.id\); return; \}/);
  assert.match(js, /if \(e\.ctrlKey \|\| e\.metaKey\) \{ toggleSelect\(c\.id\); return; \}/);
  // the file row: same two gestures, scoped by selectedKey()
  assert.match(js, /if \(ev && selectedKey\(\) === 'file' && \(ev\.shiftKey \|\| ev\.ctrlKey \|\| ev\.metaKey\)\)/);
  assert.match(js, /selectRangeFiles\(f\.id\)/);
});

test('pc: Space is Quick Look both ways — it opens the viewer and closes it', { skip: skipOpt }, () => {
  // Space opened the viewer already; without the close, "look at it, then keep
  // browsing" was click-view-Esc-re-find
  assert.match(js, /if \(e\.key === ' ' && !\(e\.target\.closest && e\.target\.closest\('button, a'\)\)\) \{/);
  assert.match(js, /if \(e\.key === 'Enter' \|\| e\.key === ' '\) \{ \/\/ Space = Quick Look/);
  // closeLightbox restores focus to the tile it came from, so Space returns the
  // user to the SAME tile
  assert.match(js, /untrapFocus\(\$\('#lightbox'\), \(ret && ret\.isConnected\) \? ret/);
  // …and the guard matters: on a focused control inside the viewer, Space stays
  // that control's own activation key
  const lbKeys = js.slice(js.indexOf("if (e.key === 'Escape') closeLightbox();"), js.indexOf("if (e.key === 'ArrowLeft') lbNav(-1);"));
  assert.ok(/closest\('button, a'\)/.test(lbKeys), 'Space defers to a focused control');
  // F replaces the permanent hint, and the README table records the new set
  assert.match(js, /if \(e\.key === 'f' \|\| e\.key === 'F'\) toggleActualSize\(\);/);
  const readme = fs.readFileSync(path.join(APP, 'README.md'), 'utf8');
  for (const frag of ['1/2/3 Captures/Transfers/All', 'select the whole list', 'save the selection', 'Shift+click', 'selection box']) {
    assert.ok(readme.includes(frag), `README records: ${frag}`);
  }
  // the search shortcut went with the field it focused
  assert.ok(!readme.includes('/ search'), 'README does not advertise a removed shortcut');
});

test('pc: every tile carries a selection box, and a tile drag carries the selection', { skip: skipOpt }, () => {
  // The box is a REAL checkbox on every tile, not a mode-only affordance: you
  // start a multi-select by ticking the tile you mean. It is a sibling of the
  // tile's own surface (never nested interactive elements), and its own click
  // stops there so the box never opens the viewer underneath it.
  assert.match(js, /pick\.type = 'checkbox';/);
  assert.match(js, /pick\.className = 'pick';/);
  assert.match(js, /d\.prepend\(pick\);/);
  assert.match(js, /pick\.setAttribute\('aria-label', `Select capture, \$\{tileTime\(c\)\}`\)/);
  assert.match(js, /e\.stopPropagation\(\); \/\/ the box selects; it never opens the viewer/);
  assert.match(js, /if \(!selectMode\) setSelectMode\(true\); \/\/ picking is how the bulk bar appears/);
  assert.match(js, /toggleSelect\(c\.id\);/);
  // ...and the bar that appeared WITH a tick must go away with the last un-tick.
  // Entry decides the exit: an implicit mode (a box) closes when the selection
  // empties, a deliberate one (the ⋯ menu's Select, S, ⌘A) is pinned and keeps
  // its empty bar — Select all / Cancel are the point of it.
  assert.match(js, /let selectPinned = false;/);
  assert.match(js, /selectPinned = selectMode && pin;/, 'entry records how the mode was entered');
  assert.match(js, /\$\('#select-btn'\)\.onclick = \(\) => setSelectMode\(!selectMode, \{ pin: true \}\);/);
  assert.match(js, /if \(selectMode && !selectPinned && !selected\.size\) \{ setSelectMode\(false\); return; \}/,
    'the bulk bar closes when an implicitly-entered selection empties');
  // 20px painted, 28px target through an invisible expansion; state is a fill
  assert.match(blocksFor('.pick'), /position:\s*absolute/);
  assert.match(blocksFor('.pick::after'), /inset:\s*-4px/);
  assert.match(blocksFor('.pick:checked'), /background:\s*var\(--accent\)/);
  // the tile is draggable, and ONE dragstart carries every selected capture
  assert.match(js, /d\.draggable = true;/);
  assert.match(js, /d\.addEventListener\('dragstart', e => \{/);
  assert.match(js, /const group = selected\.has\(c\.id\) && selected\.size \? view\.filter\(x => selected\.has\(x\.id\)\) : \[c\];/);
  assert.match(js, /setDragPayload\(e\.dataTransfer, group\)/);
  // the box and the action panel are not drag handles
  assert.match(js, /if \(e\.target\.closest\('\.pick, \.act-panel, input, button, a'\)\)/);
  // several MIME shapes, so a chat box, an editor and Explorer all accept it
  for (const mime of ['text/uri-list', 'text/plain', 'text/html', 'DownloadURL']) {
    assert.ok(js.includes(`setData('${mime}'`), `the drag payload carries ${mime}`);
  }
});

test('pc: the bulk bar goes away with the selection it was opened for', { skip: skipOpt }, () => {
  // The reported bug: tick a capture's box, the bulk bar opens — un-tick it and
  // the bar stayed, reading "0 selected" over a dead Copy and Delete, covering
  // the grid. It closes on the empty selection now, and leaves the mode with it.
  assert.match(js, /if \(selectMode && !selectPinned && !selected\.size\) \{ setSelectMode\(false\); return; \}/);
  assert.match(js, /function setSelectMode\(on, \{ pin = false \} = \{\}\)/);
  // the pin is DROPPED the moment the mode is left, so the next implicit entry
  // starts unpinned rather than inheriting the last one's rule
  assert.match(js, /selectPinned = selectMode && pin;/);
  // and a deliberate entry now paints the bar immediately: ⋯ → Select used to
  // fire the toast and nothing else, so the bar the mode exists for stayed
  // hidden until a capture was picked and "Select" read as a dud
  assert.match(js, /if \(pin\) updateBulkBar\(\);/);
});

test('pc: the recent-texts glance shows the newest one, in one 210px row', { skip: skipOpt }, () => {
  // ONE row beside the field. As a two-row card above the grid it measured
  // 112px of the card and pushed the first capture row to y271 — the library
  // paid for a text list. The dialog holds the conversation; this is the glance.
  assert.match(js, /const RECENT_TEXTS = 1;/);
  assert.match(js, /for \(const t of list\.slice\(0, RECENT_TEXTS\)\) rows\.appendChild\(textRow\(t\)\)/);
  // a fixed, small column: the field's measure can never move because of it
  assert.match(blocksFor('.text-recent'), /width:\s*210px/);
  assert.match(blocksFor('.compose-group'), /gap:\s*14px/, 'the glance is one group with the field');
  // the label is a caption — line-height 1 keeps 11 + 2 + 28 inside the band
  assert.match(blocksFor('.text-recent .eyebrow'), /line-height:\s*1/);
  // no card skin in the band: the row itself is the affordance
  assert.ok(!/background/.test(blocksFor('.text-recent')), 'the strip is chrome-free');
  // below 1024px the band cannot hold brand + glance + a 560px field
  assert.match(cssNoComments, /@media \(max-width: 1023px\)\s*\{\s*#text-recent\s*\{\s*display:\s*none/,
    'the glance stands down when the band runs out of room');
  // a row says direction + message + how long ago, and clicking it copies
  assert.match(js, /dir\.className = `ic \$\{fromPhone \? 'ic-phone' : 'ic-pc'\} t-dir \$\{fromPhone \? 'in' : 'out'\}`/);
  assert.match(js, /when\.textContent = timeAgo\(t\.created_at\);/);
  assert.match(js, /b\.onclick = async \(\) => toast\(await copyTextSmart\(t\.body\)/);
  // one row anatomy, shared with the dialog (which is where its rows wrap)
  const d = doc();
  assert.match(blocksFor('.text-item'), /padding:\s*4px 10px/);
  assert.match(blocksFor('.texts-list .text-item'), /white-space:\s*normal/);
  assert.equal(d.querySelector('#texts-btn').getAttribute('aria-controls'), 'texts-backdrop');
});

