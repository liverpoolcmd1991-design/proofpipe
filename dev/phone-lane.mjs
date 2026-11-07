// Dev-only: render and MEASURE the phone UI's lower stack (the PC-sent lane) in
// headless Chrome over CDP. Real timers, so fetches settle — unlike
// `--virtual-time-budget`, which pauses the clock on pending requests and
// screenshots an EMPTY lane (that is how the "lane is two components" bugs were
// missed by reading the source).
//
//   node dev/seed-scratch.mjs                 # fixture: 8 PC rows + 20 transfers
//   node dev/phone-lane.mjs probe  <url> [w] [h] [stripSel] [clickSel]
//   node dev/phone-lane.mjs shot   <url> <out.png> [w] [h] [stripSel] [scrollTo] [clipX clipY clipW clipH]
//   node dev/phone-lane.mjs eval   <url> <js> [w] [h] [out.png]
//
// probe prints every row's box (x/y/w/h, font, padding, margin) plus each
// strip's .at-start/.at-end state, so a rhythm or gutter regression shows up as
// numbers instead of a vibe. clip* are viewport coordinates at 4× scale.
//
// `eval` runs an expression ON the real page (same origin, no harness) and
// prints its JSON — use it for states only JS can produce. It awaits promises,
// so it can drive a gesture and read the result back in one call. Synthetic
// TouchEvents work: `new TouchEvent('touchmove', { touches: [new Touch({
// identifier: 1, target: el, clientX, clientY })] })` fired start → move → end
// on a chip arms the swipe-to-delete and shows the undo pill, which is how the
// pill's one-line clamp was measured against a real 116-char file name.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.PP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [mode, url, ...rest] = process.argv.slice(2);
if (!mode || !url) {
  console.error('usage: phone-lane.mjs <probe|shot> <url> [args…]');
  process.exit(2);
}
const W = Number(rest[1] || 390);
const H = Number(rest[2] || 844);
const PORT = Number(process.env.PP_CDP_PORT || 9333);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
// awaitPromise so an expression can drive a gesture and read the result back
const evaluate = async expression => (await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

await S('Page.enable');
await S('Runtime.enable');
await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
await S('Page.navigate', { url });
await sleep(4500); // real time: let the poll/SSE settle

// Every row of the lower stack, plus the two strips' edge-fade state.
const PROBE = `(() => {
  const one = sel => { const el = document.querySelector(sel); if (!el) return null;
    const b = el.getBoundingClientRect(); const c = getComputedStyle(el);
    return { sel, x:+b.x.toFixed(1), y:+b.y.toFixed(1), w:+b.width.toFixed(1), h:+b.height.toFixed(1),
      bottom:+b.bottom.toFixed(1), font:c.fontSize, pad:c.padding, margin:c.margin }; };
  const out = { boxes: ['.text-row', '.secondary-row', '.shutter-bar', '#inbox', '#text-in', '#files',
    '#text-load-more', '#files-load-more', '#chip-hint', '.recent-heading', '.gallery', '.wrap', '#recent-empty']
    .map(one) };
  const wrap = document.querySelector('.wrap');
  out.wrapScrolls = wrap ? wrap.scrollHeight > wrap.clientHeight + 1 : null;
  out.status = document.querySelector('#status')?.textContent;
  out.firstTextChip = one('#text-in > *');
  out.firstFileChip = one('#files > .file-chip');
  out.strips = ['#text-in', '#files'].map(s => { const el = document.querySelector(s);
    return el ? { sel: s, cls: el.className, scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null; });
  out.moreRows = ['#text-load-more', '#files-load-more'].map(s => { const el = document.querySelector(s);
    return el ? { sel: s, hidden: el.classList.contains('hidden'), text: el.textContent } : null; });
  out.chips = { text: document.querySelectorAll('#text-in .text-chip').length,
    file: document.querySelectorAll('#files .file-chip').length };
  return JSON.stringify(out, null, 1);
})()`;

if (mode === 'probe') {
  console.log(await evaluate(PROBE));
  const [stripSel, clickSel] = rest.slice(3);
  if (stripSel) {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(stripSel)});
      if (el) el.scrollLeft = el.scrollWidth; return 1; })()`);
    await sleep(400);
    console.log(`--- after scrolling ${stripSel} to its end ---`);
    console.log(JSON.parse(await evaluate(PROBE)).strips);
  }
  if (clickSel) {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(clickSel)});
      if (el) el.click(); return 1; })()`);
    await sleep(1200);
    const after = JSON.parse(await evaluate(PROBE));
    console.log(`--- after clicking ${clickSel} ---`);
    console.log(after.chips, after.moreRows);
  }
} else if (mode === 'shot') {
  const [out, , , stripSel, scrollTo] = rest;
  if (stripSel) {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(stripSel)});
      if (el) el.scrollLeft = ${Number(scrollTo) || 0} || el.scrollWidth; return 1; })()`);
  }
  await evaluate(`(() => { const el = document.querySelector('#inbox');
    if (el) el.scrollIntoView({ block: 'center' }); return 1; })()`);
  await sleep(400);
  const shotArgs = { format: 'png', captureBeyondViewport: true };
  const clip = rest.slice(5, 9).map(Number);
  if (clip.length === 4 && clip.every(Number.isFinite)) {
    // the clip is page-relative; the caller passes viewport-relative
    shotArgs.clip = { x: clip[0], y: clip[1] + Number(await evaluate('window.scrollY')), width: clip[2], height: clip[3], scale: 4 };
  }
  const shot = await S('Page.captureScreenshot', shotArgs);
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('wrote ' + out);
} else if (mode === 'eval') {
  // Drive a state only JS can produce (open a dialog, fill a toast) and read it
  // back. `eval <url> <expression> [w] [h] [out.png]`
  const [expression, , , out] = rest;
  console.log(await evaluate(expression));
  if (out) {
    await sleep(700); // let any reveal animation (flashin) settle before the shot
    const shot = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('wrote ' + out);
  }
} else {
  console.error('unknown mode: ' + mode);
}

ws.close();
chrome.kill();
process.exit(0);
