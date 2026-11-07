// Dev-only: render and MEASURE the PC harness in headless Chrome over CDP.
// The PC counterpart of dev/phone-lane.mjs. Every number in the PC-harness
// redesign was read off a live page with this script, and P1–P4 (plus the tile
// pass) were verified the same way — never by reading the source.
//
//   PP_DATA=<win-path> PORT=8899 node server.js &   # scratch instance, never data/
//                                                  # (a TEMP path: a fixture inside
//                                                  # the repo becomes lint INPUT —
//                                                  # the seeded app.js is a parse error)
//   node dev/pc-harness.mjs seed  http://127.0.0.1:8899
//   node dev/pc-harness.mjs probe http://127.0.0.1:8899 1440 900
//   node dev/pc-harness.mjs shot  http://127.0.0.1:8899 out.png 1440 900 [hover|menu]
//   node dev/pc-harness.mjs eval  http://127.0.0.1:8899 <expr> 1440 900 [out.png]
//
// THREE traps this file exists to stop you re-learning (they cost real time):
//   · `mobile: true` is WRONG for this page and `deviceScaleFactor: 1` comes back
//     scaled ×0.75 on Windows (1080×675 for a 1440×900 viewport) — shoot at 2.
//   · the selected tab / density persist in localStorage, so a fresh navigate does
//     NOT reset the screen; seed() therefore clears the profile it drives.
//   · PP_DATA must be a WINDOWS path: `/tmp/x` under Git Bash resolves to C:\tmp\x.
//
// probe prints JSON (shell metrics, every control height, sub-28px targets, the
// tile action panel on a real :hover, and the tile ⋯ menu measured while open).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const CHROME = process.env.PP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [mode, url, ...rest] = process.argv.slice(2);
if (!mode || !url) {
  console.error('usage: pc-harness.mjs <seed|probe|shot|eval> <url> [args…]');
  process.exit(2);
}
// [w] [h] always follow the mode's own required args:
//   probe <url> [w] [h] · shot <url> <out.png> [w] [h] [hover|menu]
//   eval  <url> <expr>    [w] [h] [out.png]   · seed <url>
const W = Number((mode === 'probe' ? rest[0] : rest[1]) || 1440);
const H = Number((mode === 'probe' ? rest[1] : rest[2]) || 900);
const PORT = Number(process.env.PP_CDP_PORT || 9334);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- seed: a PC-shaped fixture (captures, both origins, both lists) ----------
if (mode === 'seed') {
  const B = url.replace(/\/$/, '');
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(B + '/api/version'); if (r.ok) break; } catch {}
    await sleep(250);
  }
  const HUE = [12, 40, 96, 140, 178, 205, 232, 268, 300, 330, 18, 62, 120, 250];
  let n = 0;
  for (const hue of HUE) {
    // a real JPEG, not a stub: the grid decodes thumbnails and measures bytes
    const buf = await sharp({
      create: { width: 900, height: 640, channels: 3, background: `hsl(${hue} 45% 42%)` },
    }).jpeg({ quality: 82 }).toBuffer();
    const fd = new FormData();
    fd.set('source', n % 5 === 0 ? 'pc' : 'phone'); // PC origin is the exception
    fd.set('file', new Blob([buf], { type: 'image/jpeg' }), `p4-${String(hue).padStart(3, '0')}.jpg`);
    await fetch(B + '/upload', { method: 'POST', body: fd }).then(r => r.json());
    n++;
  }
  const mk = (name, dir) => {
    const fd = new FormData();
    fd.set('dir', dir);
    fd.set('file', new Blob([`pc harness ${name}\n`], { type: 'text/plain' }), name);
    return fetch(B + '/api/files', { method: 'POST', body: fd }).then(r => r.json());
  };
  for (const [i, name] of ['contract-v3-final.pdf', 'reading-list.md', 'site-photos.zip',
    'budget-2026.xlsx', 'notes.txt', 'diagram.svg', 'slides.pptx', 'dataset.csv', 'app.js'].entries()) {
    await mk(name, i % 3 === 2 ? 'phone' : 'pc');
  }
  // FOUR texts so the recent-texts glance can be measured at its 1-row cap —
  // both directions, and three PAST the cap that must NOT render in the glance
  // (they are what fills the dialog behind the band's mail icon; the LAST one
  // below is the newest, so it is the one the glance shows).
  for (const [body, source] of [['pc → phone: the meeting notes are in the zip', 'pc'],
    ['phone → pc: on my way, 10 min', 'phone'],
    ['pc → phone: https://example.com/paste-target', 'pc'],
    ['phone → pc: fourth message (newest — the glance shows this one)', 'phone']]) {
    await fetch(B + '/api/text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, source }),
    }).then(r => r.json());
  }
  const v = await fetch(B + '/api/captures/version').then(r => r.json());
  console.log(`seeded: captures=${v.n} (5% pc-origin) files=9 texts=4`);
  process.exit(0);
}

// ---------- CDP ----------
const profile = mkdtempSync(join(tmpdir(), 'ppchrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    ws = new WebSocket((await r.json()).webSocketDebuggerUrl);
    break;
  } catch { await sleep(200); }
}
if (!ws) { chrome.kill(); throw new Error('chrome never came up'); }
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
function send(method, params = {}, sessionId) {
  const msg = { id: ++id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pending.set(msg.id, { res, rej }));
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
const evaluate = async expression => (await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

await S('Page.enable');
await S('Runtime.enable');
await S('Network.enable');
await S('Network.clearBrowserCookies');
await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await S('Page.navigate', { url });
// localStorage (tab, density, show-all) survives a navigate in the same profile,
// so clear it and reload — otherwise a "fresh" screen keeps the last one's state
await sleep(1200);
await evaluate('(() => { localStorage.clear(); return 1; })()');
await S('Page.navigate', { url });
for (let i = 0; i < 40; i++) { // poll the DOM, never an endpoint with a side effect
  const n = await evaluate("document.querySelectorAll('#captures .capture').length");
  if (n) break;
  await sleep(300);
}
await sleep(1200);

const mouse = (type, x, y, extra = {}) => S('Input.dispatchMouseEvent', {
  type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1, ...extra,
});
const centreOf = async sel => await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null; const b = el.getBoundingClientRect();
  return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }); })()`);

// the shell: the measurements the PC-harness audit tabulated, plus the
// two defect classes it found (sub-28 targets, nested scrollbars)
const SHELL = `(() => {
  const r = el => { const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1),
      bottom: +b.bottom.toFixed(1), right: +b.right.toFixed(1) }; };
  const one = sel => { const el = document.querySelector(sel); return el ? { sel, ...r(el) } : null; };
  const out = { viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio } };
  // #text-recent is in here because its width is the field's neighbour in the
  // band: only a render can say what the pair costs (as a two-row card above the
  // grid it was 178.5px of a 1440×900 card, and as a flex-basis beside the
  // field it starved #text-input to 185px — both caught right here)
  out.regions = ['#text-bar', '#text-recent', '.toolbar', '.main-card', '.card.side', '#captures', '.transfer-list', '#toasts']
    .map(one).filter(Boolean);
  const faded = el => { for (let n = el; n; n = n.parentElement) if (+getComputedStyle(n).opacity === 0) return true; return false; };
  // every control height — P1 was "ten controls at three heights", so the row is
  // reported as a baseline COUNT. Closed menu panels are excluded: they are laid
  // out at their own coordinates and would fake extra rows.
  const live = sel => [...document.querySelectorAll(sel)]
    .filter(el => el.offsetParent !== null && !el.closest('.menu'));
  const btns = live('.toolbar .toolbtn');
  const hOf = el => Math.round(el.getBoundingClientRect().height);
  const topOf = el => Math.round(el.getBoundingClientRect().top);
  out.toolbar = {
    toolbtn: { n: btns.length, heights: btns.map(hOf), baselines: [...new Set(btns.map(topOf))] },
    chips: live('.toolbar .chip').map(el => ({ h: hOf(el), sameRow: topOf(el) === topOf(btns[0]) })),
    search: live('.toolbar input, #filter-box input').map(el => hOf(el)),
  };
  // sub-28px targets: nothing in the harness may be one (DESIGN.md §2 / WCAG 2.5.8)
  out.sub28 = [...document.querySelectorAll('button, a[href], [role="button"], input[type="range"], select, summary')]
    .filter(el => el.offsetParent !== null && !el.closest('.hidden') && !el.classList.contains('sr-only'))
    .map(el => { const b = el.getBoundingClientRect();
      return b.width < 28 || b.height < 28 ? { id: el.id || el.className, w: +b.width.toFixed(1), h: +b.height.toFixed(1) } : null; })
    .filter(Boolean);
  // inverted is the system's emphasis language: exactly ONE surface per screen
  // (DESIGN.md §7). The fill is the --inv token now (v1.20.0 darkened the UI,
  // so "inverted" is soft white #e4e7e3, no longer pure #fff). Mask icons paint
  // with background-color too, so .ic is out, and so is anything inside a faded
  // (hover-only) subtree.
  out.invertedSurfaces = [...document.querySelectorAll('body *')]
    .filter(el => el.offsetParent !== null && !el.classList.contains('ic') && !faded(el)
      && getComputedStyle(el).backgroundColor === 'rgb(228, 231, 227)')
    .map(el => el.id || el.className);
  // nested scrollbars: a rail that overflows its own cap was the 780×700 bug
  out.scrollers = [...document.querySelectorAll('body *')].filter(el => {
    const c = getComputedStyle(el);
    return /auto|scroll/.test(c.overflowY) && el.scrollHeight > el.clientHeight + 1;
  }).map(el => (el.id || el.className) + ': ' + el.scrollHeight + '>' + el.clientHeight);
  out.a11yBusy = document.querySelector('#captures')?.getAttribute('aria-busy');
  return JSON.stringify(out, null, 1);
})()`;

// the tile pass: a REAL :hover (CDP mouseMoved), then the ⋯ measured while open
const TILE = `(() => {
  const r = el => { const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const tile = document.querySelector('#captures .capture');
  if (!tile) return JSON.stringify({ error: 'no tile' });
  const acts = [...tile.querySelectorAll('.act-panel .act')];
  // an OPEN row/tile panel is hosted on the BODY (a tile lifts on hover, and a
  // transformed ancestor would become its containing block) — so find it there
  const menu = [...document.querySelectorAll('.menu')].find(el => el.classList.contains('open') && !el.closest('.mpop')) || tile.querySelector('.cap-menu .menu');
  const items = [...menu.querySelectorAll('.menu-item')];
  const t = tile.getBoundingClientRect();
  const p = tile.querySelector('.act-panel').getBoundingClientRect();
  return JSON.stringify({
    tiles: document.querySelectorAll('#captures .capture').length,
    tile: r(tile),
    tileActions: { n: acts.length, labels: acts.map(b => b.getAttribute('aria-label')),
      opacity: getComputedStyle(tile.querySelector('.actions')).opacity,
      heights: acts.map(b => Math.round(b.getBoundingClientRect().height)),
      widths: acts.map(b => Math.round(b.getBoundingClientRect().width)),
      oneRow: new Set(acts.map(b => Math.round(b.getBoundingClientRect().top))).size === 1,
      panel: r(tile.querySelector('.act-panel')),
      insideTile: p.right <= t.right + 0.5 && p.left >= t.left - 0.5,
      panelPctOfTile: +(p.width / t.width * 100).toFixed(1),
    },
    tileTransform: getComputedStyle(tile).transform,
    menu: menu.classList.contains('open') ? {
      open: true, host: menu.parentElement === document.body ? 'body' : menu.parentElement.className,
      rect: r(menu), trigger: r(tile.querySelector('.cap-menu .act')),
      // a panel placed from a transformed ancestor lands far off this, so the
      // right edge is compared with its trigger's — that is the whole contract
      alignedToTrigger: Math.abs(menu.getBoundingClientRect().right - tile.querySelector('.cap-menu .act').getBoundingClientRect().right) < 1,
      inViewport: menu.getBoundingClientRect().bottom <= innerHeight && menu.getBoundingClientRect().top >= 0
        && menu.getBoundingClientRect().left >= 0 && menu.getBoundingClientRect().right <= innerWidth,
      items: items.map(el => ({ text: el.textContent, h: Math.round(el.getBoundingClientRect().height), danger: el.classList.contains('danger') })),
    } : { open: false },
    density: document.querySelector('#captures')?.dataset.dens,
  }, null, 1);
})()`;

async function probe() {
  console.log('=== shell ' + W + '×' + H + ' ===');
  console.log(await evaluate(SHELL));
  const first = JSON.parse(await centreOf('#captures .capture'));
  await mouse('mouseMoved', Math.round(first.x), Math.round(first.y));
  await sleep(300);
  console.log('=== tile, on a real hover ===');
  console.log(await evaluate(TILE));
  const more = JSON.parse(await centreOf('#captures .capture .cap-menu .act'));
  await mouse('mouseMoved', Math.round(more.x), Math.round(more.y));
  await mouse('mousePressed', Math.round(more.x), Math.round(more.y));
  await mouse('mouseReleased', Math.round(more.x), Math.round(more.y));
  await sleep(400);
  console.log('=== tile ⋯ menu, open ===');
  console.log(await evaluate(TILE));
}

const shoot = async out => {
  const shot = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('wrote ' + out);
};

if (mode === 'probe') {
  await probe();
} else if (mode === 'shot') {
  // state is driven by the same real input the user gives, never by CSS injection:
  //   hover — the tile's action panel is up  ·  menu — the ⋯ panel is open too
  const [out, , , state = 'hover'] = rest;
  const first = JSON.parse(await centreOf('#captures .capture'));
  await mouse('mouseMoved', Math.round(first.x), Math.round(first.y));
  await sleep(300);
  if (state === 'menu') {
    const more = JSON.parse(await centreOf('#captures .capture .cap-menu .act'));
    await mouse('mouseMoved', Math.round(more.x), Math.round(more.y));
    await mouse('mousePressed', Math.round(more.x), Math.round(more.y));
    await mouse('mouseReleased', Math.round(more.x), Math.round(more.y));
    await sleep(400);
  }
  await shoot(out);
} else if (mode === 'eval') {
  const [expression, , , out] = rest;
  console.log(await evaluate(expression));
  if (out) { await sleep(700); await shoot(out); }
} else {
  console.error('unknown mode: ' + mode);
}

ws.close();
chrome.kill();
process.exit(0);
