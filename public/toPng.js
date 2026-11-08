// toPng — shared clipboard helper used by the harness (app.js), the phone PWA
// (phone.js) and the browser extension (content.js + popup.js).
// Re-encodes an image Blob to PNG (the clipboard API only accepts PNG images)
// so captures paste 1:1, at FULL resolution. The only reason this code ever
// resizes is that a canvas cannot hold the image at all (see MAX_SIDE/MAX_AREA
// below) — never to save memory and never as a quality trade-off. A capture the
// user copied must arrive at the resolution it was stored at: the quality
// setting (see the transfer-quality endpoints) is the ONLY thing allowed to
// reduce a photo, and it gates the PHONE's upload, not the clipboard.
//
// This used to clamp the longest side to a flat 8192px "purely to protect
// memory", which silently cost a 1080×24000 scrolling screenshot 88% of its
// pixels (369×8192) with no signal anywhere in the UI. (The old comment also
// claimed "every real phone photo (12–48MP) copies at full resolution" — a
// 48MP photo can't even be stored: the server's pixel ceiling refuses it.)
// The encode runs on a Worker (OffscreenCanvas) so the page never freezes
// mid-copy; if Workers are blocked (e.g. strict page CSP in the content
// script, or MV3 extension pages) it falls back to the main-thread canvas.
//
// Byte-identical copies must live in BOTH public/toPng.js (served to the web
// UIs) and extension/toPng.js (packaged with the extension — Chrome content
// scripts can only load files from the extension's own directory, so the web
// copy can't simply be reused). test/dup.test.js fails the build if they
// drift apart.
const toPng = (() => {
  // The tightest limits among the browsers the harness can be opened in:
  // MAX_SIDE is Firefox's 32767px per side (Chromium allows 65535, Safari
  // 4194303) and MAX_AREA is Chromium's and Safari's documented 2^28px.
  // Firefox's own area ceiling is lower, but that guard cannot bind on anything
  // this code is handed: a blob here comes from /media, and the PC refuses a
  // capture past 64MP (server/store.js MAX_PIXELS) — so only the SIDE limit can
  // ever be reached, and only by an extremely elongated pano/screenshot.
  // Resizing happens for exactly one reason: a canvas cannot hold the image at
  // all (HTTP canvas limits are hard — MDN: exceeding them "renders the canvas
  // unusable — drawing commands will not work"). A hit here means "this image
  // cannot be encoded at full size", never "this image is big". Should an
  // engine still be tighter than these numbers the encode yields nothing and
  // the caller reports a blocked copy — an honest failure, never a silent
  // downgrade.
  const MAX_SIDE = 32767;
  const MAX_AREA = 268435456;
  const workerSrc = `self.onmessage = async e => {
  const { blob, port } = e.data;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, ${MAX_SIDE} / Math.max(bmp.width, bmp.height),
      Math.sqrt(${MAX_AREA} / (bmp.width * bmp.height)));
    let w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    // rounding BOTH sides up can land the canvas just over the area limit —
    // the one thing this must stay under — so take off a row until it fits
    while (w * h > ${MAX_AREA} && w > 1 && h > 1) { if (w >= h) w--; else h--; }
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const png = await c.convertToBlob({ type: 'image/png' });
    port.postMessage({ png });
  } catch (err) {
    port.postMessage({ error: String((err && err.message) || err) });
  }
};`;
  let worker = null;
  let workerBroken = false;
  const getWorker = () => {
    if (worker || workerBroken) return worker;
    try {
      const url = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
      worker = new Worker(url);
      URL.revokeObjectURL(url); // worker holds its own copy — don't leak the blob URL
    } catch { workerBroken = true; }
    return worker;
  };
  // fallback path — same limits, on the main thread
  const mainThreadPng = blob => createImageBitmap(blob).then(bmp => {
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height),
      Math.sqrt(MAX_AREA / (bmp.width * bmp.height)));
    let w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    // same guard as the worker path — see there
    while (w * h > MAX_AREA && w > 1 && h > 1) { if (w >= h) w--; else h--; }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    return new Promise((r, rej) => c.toBlob(b => {
      // Release the backing store before resolving. A main-thread fallback can
      // otherwise keep a full-size canvas alive until GC, while the worker path
      // already drops its bitmap explicitly.
      const out = b;
      c.width = 0; c.height = 0;
      out ? r(out) : rej(new Error('encode failed'));
    }, 'image/png'));
  });
  const closeCh = ch => { try { ch.port1.close(); } catch {} try { ch.port2.close(); } catch {} };
  return blob => new Promise((resolve, reject) => {
    const w = getWorker();
    if (!w) return mainThreadPng(blob).then(resolve, reject);
    const ch = new MessageChannel();
    const timer = setTimeout(() => { // safety net: never hang the copy action
      ch.port1.onmessage = null;
      closeCh(ch);
      // a 30s encode means the worker is wedged — terminate it so it (and its
      // MessageChannel port) can't leak and wedge every future copy
      try { w.terminate(); } catch {}
      worker = null;
      mainThreadPng(blob).then(resolve, reject);
    }, 30000);
    ch.port1.onmessage = e => {
      clearTimeout(timer);
      const { png, error } = e.data || {};
      closeCh(ch);
      if (error || !(png instanceof Blob)) {
        if (error) {
          workerBroken = true;
          try { w.terminate(); } catch {}
          worker = null;
          mainThreadPng(blob).then(resolve, reject);
        } else {
          reject(new Error('encode failed'));
        }
      } else resolve(png);
    };
    try {
      w.postMessage({ blob, port: ch.port2 }, [ch.port2]);
    } catch {
      clearTimeout(timer);
      closeCh(ch);
      workerBroken = true;
      worker = null;
      mainThreadPng(blob).then(resolve, reject);
    }
  });
})();
// expose to late-loaded classic scripts (harness, phone, content script) — the
// top-level `const` lives in this script's lexical scope and is visible to
// later scripts either way; setting it on `window` makes the contract explicit.
if (typeof window !== 'undefined') window.toPng = toPng;
