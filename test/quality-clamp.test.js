// The "reduce image quality" setting is the ONLY thing allowed to shrink a
// capture. Two other places used to resize one behind the user's back:
//
//   · toPng (the clipboard encode) clamped the longest side to a flat 8192px
//     "purely to protect memory" — so a 1080×24000 scrolling screenshot pasted
//     as 369×8192, 12% of its pixels, with no signal anywhere in the UI.
//   · the phone's HEIC→JPEG format conversion inherited qualityCompress's
//     4096px quality-reduction clamp through a bare default, so a 48MP iPhone
//     HEIC lost 74% of its pixels with the quality setting OFF.
//
// Both are pinned BEHAVIOURALLY: a stub canvas records the exact pixel size the
// encoder produced, so these assertions are about the output resolution rather
// than about which constant a comment claims. The clipboard's only real limit is
// physical (Firefox caps a canvas at 32767px a side, Chromium/Safari at 2^28px of
// total area), and every blob here is fetched from /media — the PC refuses a
// capture past 64MP — so nothing storable comes close: resize only when a canvas
// cannot hold the image AT ALL, and then only by the overlap. The phone's only
// real limit is the PC's published accept ceiling, and it must never be guessed
// lower than the truth (a low guess is a silent downscale).
//
// No jsdom: the two scripts touch only createImageBitmap + document.createElement,
// both of which are stubbed below (a Worker is deliberately absent so toPng
// takes its main-thread fallback, which shares the same limits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(APP, f), 'utf8');
const PHONE_JS = read('public/phone.js');

// the PC's ceiling, published by GET /api/quality (server/store.js MAX_PIXELS)
const MAX_PIXELS = 64_000_000;
// The 2026-09 ceilings this file exists to keep out: a flat longest-side clamp on
// the clipboard encode, and the shared 4096px that the format conversion
// inherited. Both ran with the quality setting OFF.
const OLD_CLIPBOARD_CLAMP = 8192;
const OLD_HEIC_CLAMP = 4096;

// A window just real enough to run the encoders: createImageBitmap reports the
// size of whatever blob we hand it, and every canvas records the drawImage
// dimensions (the size the encode actually happened at).
function makeWindow() {
  const drew = [];
  const canvas = () => ({
    width: 0, height: 0,
    getContext: () => ({ drawImage: (_bmp, _x, _y, w, h) => drew.push({ w, h }) }),
    toBlob: cb => cb({ size: 1, type: 'image/png' }),
  });
  const win = {
    document: { createElement: tag => (tag === 'canvas' ? canvas() : {}) },
    createImageBitmap: async blob => ({ width: blob.__w, height: blob.__h, close() {} }),
    Blob: class { constructor(parts, opt) { this.size = 5; this.type = (opt || {}).type; } },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    setTimeout, clearTimeout,
  };
  win.window = win;
  const ctx = vm.createContext(win);
  return {
    win, ctx, drew,
    // a 5-byte "photo" that decodes to the given pixel size
    blob: (w, h) => Object.assign(new win.Blob(['12345']), { __w: w, __h: h, type: 'image/jpeg' }),
  };
}

// toPng.js publishes itself on window (that is its contract for classic
// late-loaded scripts), so one eval is all it takes.
function withToPng() {
  const env = makeWindow();
  vm.runInContext(read('public/toPng.js'), env.ctx, { filename: 'toPng.js' });
  return env;
}

// qualityCompress is a top-level function declaration in phone.js; running just
// that slice gives it a callable global without booting the PWA (which needs
// IndexedDB + EventSource). Same trick as test/phone-ui.test.js.
function withQualityCompress() {
  const env = makeWindow();
  const src = PHONE_JS.slice(PHONE_JS.indexOf('async function qualityCompress'), PHONE_JS.indexOf('// SSE health'));
  assert.ok(src.includes('function qualityCompress'), 'qualityCompress must be where we think it is');
  vm.runInContext(src, env.ctx, { filename: 'qualityCompress.js' });
  return env;
}

// tooManyPixelsMsg reads the phone's live `settings`; the slice carries only the
// function, so the global it reads is installed on the context first.
function withMsg(maxPixels) {
  const env = makeWindow();
  env.win.settings = { maxPixels };
  const src = PHONE_JS.slice(PHONE_JS.indexOf('function tooManyPixelsMsg'), PHONE_JS.indexOf('async function loadQuality'));
  assert.ok(src.includes('function tooManyPixelsMsg'), 'tooManyPixelsMsg must be where we think it is');
  vm.runInContext(src, env.ctx, { filename: 'tooManyPixelsMsg.js' });
  return env.win;
}

test('toPng: a tall screenshot copies at FULL resolution (no 8192 clamp)', async () => {
  const { win, drew, blob } = withToPng();
  // the 22:1 monster that used to collapse to 369×8192
  await win.toPng(blob(1080, 24000));
  assert.deepEqual(drew, [{ w: 1080, h: 24000 }], 'the clipboard gets every pixel the server stored');
});

test('toPng: ordinary captures are byte-for-byte the same size as before', async () => {
  for (const [w, h] of [[4032, 3024], [8064, 6048], [1080, 12000], [9487, 3162]]) {
    const { win, drew, blob } = withToPng();
    await win.toPng(blob(w, h));
    assert.deepEqual(drew, [{ w, h }], `${w}×${h} must not be resized`);
  }
});

test('toPng: resizes ONLY when a canvas cannot hold the image, and only enough to fit', async () => {
  // 40000×30000 = 1.2G px: past both real limits, so this one legitimately shrinks
  const { win, drew, blob } = withToPng();
  await win.toPng(blob(40000, 30000));
  const [d] = drew;
  assert.equal(drew.length, 1);
  assert.ok(d.w <= 32767 && d.h <= 32767, `no side may exceed the canvas limit (got ${d.w}×${d.h})`);
  assert.ok(d.w * d.h <= 268435456, `must fit the canvas area (got ${d.w * d.h}px)`);
  // and it must not OVER-shrink: a 4:3 image pinned by the area limit lands
  // within a hair of it, not somewhere comfortably below
  assert.ok(d.w * d.h > 266_000_000, `resize must stop at the limit, not short of it (got ${d.w}×${d.h})`);
  assert.ok(Math.abs(d.w / d.h - 40000 / 30000) < 0.01, 'aspect ratio is preserved');
});

test('toPng: 32767px per side is the ceiling, not 8192', async () => {
  // the tallest capture the PC can store (a 22:1 screenshot) is 24000px — well
  // inside the real side limit, and far past the flat 8192 the clipboard used
  const { win, drew, blob } = withToPng();
  await win.toPng(blob(1080, 32767));
  assert.deepEqual(drew, [{ w: 1080, h: 32767 }]);
  assert.ok(32767 > OLD_CLIPBOARD_CLAMP * 3, 'the old clamp was the problem, not the ceiling');
});

test('qualityCompress: no limits given means no resize at all', async () => {
  const { win, drew, blob } = withQualityCompress();
  await win.qualityCompress(blob(8064, 6048), 80);
  assert.deepEqual(drew, [{ w: 8064, h: 6048 }], 'a caller that asks for nothing gets the original');
});

test('qualityCompress: the quality setting still clamps to 4096 when it IS on', async () => {
  const { win, drew, blob } = withQualityCompress();
  // this is the explicit user opt-in — unchanged by the fix
  await win.qualityCompress(blob(8064, 6048), 80, { maxDim: OLD_HEIC_CLAMP });
  assert.deepEqual(drew, [{ w: 4096, h: 3072 }]);
});

test('qualityCompress: a HEIC format conversion does NOT resize a 48MP photo', async () => {
  const { win, drew, blob } = withQualityCompress();
  // the phone's HEIC→JPEG path runs with the quality setting OFF; it may change
  // the FORMAT, never the resolution — 48MP in, 48MP out
  await win.qualityCompress(blob(8064, 6048), 92, { force: true });
  assert.deepEqual(drew, [{ w: 8064, h: 6048 }], 'a 48MP HEIC must not lose 74% of its pixels to a format conversion');
});

test('qualityCompress: not even a 108MP HEIC is resized by the format conversion', async () => {
  const { win, drew, blob } = withQualityCompress();
  // Past the PC's ceiling nothing this code can do makes the photo acceptable,
  // and shrinking it would be a quality reduction with the setting OFF. The
  // server refuses it as 413 "too many pixels" and the phone says so — a loud
  // refusal, never a quiet trim (a 108MP HEIC used to arrive as 4096px, 1.5% of
  // its pixels, with nothing anywhere saying so).
  await win.qualityCompress(blob(12000, 9000), 92, { force: true });
  assert.deepEqual(drew, [{ w: 12000, h: 9000 }], 'the format conversion must not double as a resize');
});

test('upgrade path: a refused photo names the PC limit and the ONE switch that fixes it', () => {
  // A terminal refusal used to be silent (the photo simply never arrived, and
  // the queue retried it forever). The message is the whole user-facing half of
  // the fix, so pin its two obligations: name the ceiling once the server has
  // published it, and never invent one when it hasn't.
  assert.match(withMsg(MAX_PIXELS).tooManyPixelsMsg(), /over 64MP/, 'the real limit is named');
  assert.match(withMsg(MAX_PIXELS).tooManyPixelsMsg(), /Reduce image quality/, 'and the lever that resizes');
  const unknown = withMsg(0).tooManyPixelsMsg();
  assert.doesNotMatch(unknown, /\d+MP/, 'maxPixels 0 means "not told yet" — do not guess a number');
  assert.match(unknown, /Reduce image quality/);
});

// There is deliberately no "trim to the PC ceiling" case to test: that was the
// intermediate design, and it was still a silent quality reduction with the
// setting off. maxDim is the ONLY limit qualityCompress can apply — see the last
// test, which pins that the setting-off call site passes none.

test('phone.js: the setting-off path passes NO size limit, the setting-on path passes maxDim', () => {
  // Both call sites name their limit explicitly — a bare default is how the
  // HEIC conversion inherited the quality clamp in the first place, and passing
  // the PC ceiling here was the same mistake one decimal place quieter: a
  // 108MP HEIC would have been trimmed to 64MP with no one told.
  assert.match(PHONE_JS, /qualityCompress\(blob, settings\.qualityLevel, \{ maxDim: 4096 \}\)/,
    'quality reduction ON → the 4096 size clamp is the user decision');
  assert.match(PHONE_JS, /qualityCompress\(sendBlob, 92, \{ force: true \}\)/,
    'HEIC → JPEG (setting-independent) → format only, no size limit of any kind');
  assert.doesNotMatch(PHONE_JS, /qualityCompress\(sendBlob, 92, \{[^}]*max(Dim|Pixels)/,
    'nothing may resize the setting-off path');
  assert.doesNotMatch(PHONE_JS, /const MAXDIM = 4096;/, 'the shared 4096 default is gone');
});
