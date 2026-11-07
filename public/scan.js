// public/scan.js — webcam paper scanner for the PC harness.
//
// Opens the laptop camera, detects the page with vendored OpenCV.js, lets the
// four corners be nudged, then perspective-warps the full-resolution frame and
// hands the crop to the harness's OWN upload path (POST /upload, source=pc) —
// no new server route, so a scan lands in the grid like any other PC capture
// (origin badge, storage caps, SSE) and can be copied straight to the
// clipboard for the Ctrl+V-into-the-chat workflow ProofPipe exists for.
//
// WHY OpenCV: reliable document-quad detection is contours + approxPolyDP +
// getPerspectiveTransform + warpPerspective; re-implementing that in plain JS
// was rejected. The wasm is ~10MB, so it is injected lazily on first open and
// only this module ever touches it.
//
// SECURE CONTEXT: getUserMedia() only exists on https:// or a loopback origin.
// ProofPipe.bat opens the harness at http://localhost:8787 (secure), so this
// works with no cert setup — but a harness opened via the LAN IP is not, and we
// say so instead of failing silently.
//
// Load order: after toPng.js, before app.js. It reaches app.js's globals
// (toast/loadCaptures/writeCaptureToClipboard/trapFocus) at CALL time through
// `window`, so their load order does not matter.
(() => {
  const OPENCV_URL = '/vendor/opencv-4.13.0.js';
  const WORK_WIDTH = 640;      // live detection runs on a downscaled frame
  const DETECT_INTERVAL = 140; // ms between detections (~7fps — cheap on a laptop)
  const MIN_AREA_FRAC = 0.12;  // a page fills a real part of the frame, reject specks
  const HANDLE_HIT = 0.07;     // normalized grab radius around a corner handle

  let opened = false;
  let stream = null;
  let cv = null;               // the OpenCV module once its runtime is up
  let cvPromise = null;        // single-flight lazy load
  let rafId = null;
  let lastDetect = 0;
  let stage = 'live';          // 'live' | 'review'
  let corners = null;          // [ {x,y} x4 ] normalized 0..1 of the frame
  let frameCanvas = null;      // frozen full-res frame used for the review warp
  let dragIdx = -1;
  let accent = '#22c55e';
  let workCanvas = null;
  const el = {};

  const $id = id => document.getElementById(id);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // ---------- lazy OpenCV ----------
  function loadOpenCV() {
    if (cvPromise) return cvPromise;
    cvPromise = new Promise((resolve, reject) => {
      if (window.cv && window.cv.Mat) { cv = window.cv; return resolve(cv); }
      const s = document.createElement('script');
      s.src = OPENCV_URL;
      s.async = true;
      s.onload = () => {
        // The emscripten build defines `cv` synchronously but initialises its
        // wasm runtime asynchronously; poll for the ready module rather than
        // guessing an event name across builds.
        const t0 = Date.now();
        const poll = () => {
          if (window.cv && window.cv.Mat) { cv = window.cv; resolve(cv); }
          else if (Date.now() - t0 > 60000) reject(new Error('scanner engine timed out'));
          else setTimeout(poll, 60);
        };
        poll();
      };
      s.onerror = () => reject(new Error('scanner engine failed to load'));
      document.head.appendChild(s);
    });
    return cvPromise;
  }

  // ---------- corner geometry ----------
  // Order corners top-left, top-right, bottom-right, bottom-left so the warp
  // maps them to the destination rectangle in a fixed direction.
  function orderCorners(pts) {
    const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tl = bySum[0], br = bySum[3];
    const rest = [bySum[1], bySum[2]].sort((a, b) => (a.x - a.y) - (b.x - b.y));
    return [tl, rest[0], br, rest[1]];
  }
  const defaultCorners = () => ([
    { x: 0.06, y: 0.06 }, { x: 0.94, y: 0.06 }, { x: 0.94, y: 0.94 }, { x: 0.06, y: 0.94 },
  ]);
  // EMA across frames so the overlay stops jittering on hand-hold noise
  function smooth(prev, next) {
    if (!prev) return next;
    return next.map((p, i) => ({
      x: prev[i].x + (p.x - prev[i].x) * 0.5,
      y: prev[i].y + (p.y - prev[i].y) * 0.5,
    }));
  }

  // ---------- detection (OpenCV) ----------
  // Returns normalized corners or null. Every cv.Mat created here is deleted in
  // the same function — the wasm heap is not garbage-collected for us.
  function detectFromCanvas(canvas) {
    const src = cv.imread(canvas);
    const gray = new cv.Mat(), blur = new cv.Mat(), edges = new cv.Mat();
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    const contours = new cv.MatVector(), hierarchy = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
      cv.Canny(blur, edges, 60, 180);
      cv.dilate(edges, edges, kernel);
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const imgArea = canvas.width * canvas.height;
      let best = null, bestArea = 0;
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const approx = new cv.Mat();
        try {
          const area = Math.abs(cv.contourArea(c));
          if (area < imgArea * MIN_AREA_FRAC || area <= bestArea) continue;
          cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
          if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;
          const pts = [];
          for (let j = 0; j < 4; j++) {
            pts.push({ x: approx.data32S[j * 2] / canvas.width, y: approx.data32S[j * 2 + 1] / canvas.height });
          }
          best = orderCorners(pts);
          bestArea = area;
        } finally {
          approx.delete();
          c.delete();
        }
      }
      return best;
    } finally {
      src.delete(); gray.delete(); blur.delete(); edges.delete();
      kernel.delete(); contours.delete(); hierarchy.delete();
    }
  }

  function ensureWork(w, h) {
    if (!workCanvas) workCanvas = document.createElement('canvas');
    if (workCanvas.width !== w || workCanvas.height !== h) { workCanvas.width = w; workCanvas.height = h; }
    return workCanvas.getContext('2d', { willReadFrequently: true });
  }

  // ---------- perspective warp ----------
  function warpToCanvas(srcCanvas, cs) {
    const W = srcCanvas.width, H = srcCanvas.height;
    const [tl, tr, br, bl] = cs.map(p => ({ x: p.x * W, y: p.y * H }));
    const dW = Math.max(8, Math.round(Math.max(dist(br, bl), dist(tr, tl))));
    const dH = Math.max(8, Math.round(Math.max(dist(tr, br), dist(tl, bl))));
    const src = cv.imread(srcCanvas);
    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, dW, 0, dW, dH, 0, dH]);
    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    const dst = new cv.Mat();
    const out = document.createElement('canvas');
    try {
      cv.warpPerspective(src, dst, M, new cv.Size(dW, dH), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
      out.width = dW; out.height = dH;
      cv.imshow(out, dst);
    } finally {
      src.delete(); srcTri.delete(); dstTri.delete(); M.delete(); dst.delete();
    }
    return out;
  }

  // ---------- overlay ----------
  function sizeOverlay() {
    const w = el.overlay.clientWidth, h = el.overlay.clientHeight;
    if (el.overlay.width !== w || el.overlay.height !== h) { el.overlay.width = w; el.overlay.height = h; }
  }
  function drawOverlay() {
    sizeOverlay();
    const ctx = el.overlay.getContext('2d');
    const W = el.overlay.width, H = el.overlay.height;
    ctx.clearRect(0, 0, W, H);
    if (!corners || W === 0) return;
    ctx.beginPath();
    corners.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
    ctx.closePath();
    ctx.fillStyle = accent + '22';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.stroke();
    // handles are only draggable in the review stage — show them only then
    if (stage === 'review') {
      for (const p of corners) {
        ctx.beginPath();
        ctx.arc(p.x * W, p.y * H, 9, 0, Math.PI * 2);
        ctx.fillStyle = '#e4e7e3';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = accent;
        ctx.stroke();
      }
    }
  }

  // ---------- live loop ----------
  function startLoop() {
    stopLoop();
    const step = ts => {
      rafId = requestAnimationFrame(step);
      if (!cv || stage !== 'live' || !el.video.videoWidth) return;
      if (ts - lastDetect < DETECT_INTERVAL) return;
      lastDetect = ts;
      const w = WORK_WIDTH, h = Math.round(el.video.videoHeight * (w / el.video.videoWidth));
      const ctx = ensureWork(w, h);
      ctx.drawImage(el.video, 0, 0, w, h);
      let found = null;
      try { found = detectFromCanvas(workCanvas); } catch { found = null; }
      if (found) corners = smooth(corners, found);
      else if (!corners) corners = null;
      drawOverlay();
    };
    rafId = requestAnimationFrame(step);
  }
  function stopLoop() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  // ---------- camera ----------
  function cameraError(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera permission was denied — allow it in the address bar, then reopen';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera found on this PC';
    if (n === 'NotReadableError') return 'Camera is in use by another app';
    return 'Could not start the camera';
  }
  async function fillDevices(activeId) {
    let cams = [];
    try { cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); } catch {}
    if (cams.length < 2) { el.device.classList.add('hidden'); return; }
    el.device.replaceChildren();
    cams.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = c.label || `Camera ${i + 1}`;
      el.device.append(o);
    });
    el.device.value = activeId || cams[0].deviceId;
    el.device.classList.remove('hidden');
  }
  async function startCamera(deviceId) {
    const video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    el.video.srcObject = stream;
    await el.video.play().catch(() => {});
    if (!el.video.videoWidth) await new Promise(r => { el.video.onloadedmetadata = () => r(); });
    el.stage.style.aspectRatio = `${el.video.videoWidth} / ${el.video.videoHeight}`;
    await fillDevices(deviceId || (stream.getVideoTracks()[0]?.getSettings?.().deviceId));
  }
  function stopCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    try { el.video.srcObject = null; } catch {}
  }

  // ---------- stages ----------
  function showStatus(msg) {
    if (!msg) { el.status.classList.add('hidden'); el.status.textContent = ''; return; }
    el.status.textContent = msg;
    el.status.classList.remove('hidden');
  }
  function setStage(s) {
    stage = s;
    const review = s === 'review';
    el.review.classList.toggle('hidden', !review);
    el.retake.classList.toggle('hidden', !review);
    el.send.classList.toggle('hidden', !review);
    el.shutter.classList.toggle('hidden', review);
    el.hint.textContent = review
      ? 'Drag the corners to the paper edges, then save'
      : 'Hold the paper in view — the corners snap to its edges';
  }
  function updatePreview() {
    if (!frameCanvas || !corners) return;
    let out;
    try { out = warpToCanvas(frameCanvas, corners); } catch { return; }
    el.preview.width = out.width;
    el.preview.height = out.height;
    el.preview.getContext('2d').drawImage(out, 0, 0);
  }

  // ---------- capture ----------
  function capture() {
    if (!el.video.videoWidth) return;
    const W = el.video.videoWidth, H = el.video.videoHeight;
    if (!frameCanvas) frameCanvas = document.createElement('canvas');
    frameCanvas.width = W; frameCanvas.height = H;
    frameCanvas.getContext('2d').drawImage(el.video, 0, 0, W, H);
    el.video.pause();       // freeze the live view; the last frame stays painted
    stopLoop();
    if (!corners) corners = defaultCorners();
    setStage('review');
    drawOverlay();
    updatePreview();
  }
  function retake() {
    corners = null; frameCanvas = null;
    setStage('live');
    el.video.play().catch(() => {});
    startLoop();
  }

  // ---------- upload (reuses the harness's own capture path) ----------
  async function uploadScan(blob) {
    const fd = new FormData();
    fd.append('source', 'pc'); // multipart metadata BEFORE the file part (contract)
    fd.append('photo', new File([blob], 'scan.jpg', { type: 'image/jpeg' }));
    const r = await fetch('/upload', { method: 'POST', body: fd, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`upload ${r.status}`);
    return r.json();
  }
  async function send() {
    if (!frameCanvas || !corners) return;
    el.send.disabled = true;
    try {
      const out = warpToCanvas(frameCanvas, corners);
      const blob = await new Promise((res, rej) => out.toBlob(b => b ? res(b) : rej(new Error('encode failed')), 'image/jpeg', 0.92));
      const row = await uploadScan(blob);
      window.loadCaptures?.(true); // tile via SSE too; this is the local fallback
      let copied = false;
      // maybeAutoCopy() deliberately ignores PC-origin captures, so a scan is
      // copied here explicitly — the instant Ctrl+V is the point of the feature.
      try { await window.writeCaptureToClipboard({ id: row.id, file: row.file, origin: 'pc' }); copied = true; } catch {}
      window.toast?.(copied ? 'Scanned — copied, ready to paste (Ctrl+V)' : 'Scanned — added to the grid', 2600);
      close();
    } catch (e) {
      window.toast?.('Scan failed: ' + (e?.message || e), 4000);
    } finally {
      el.send.disabled = false;
    }
  }

  // ---------- corner dragging (review stage) ----------
  function evtNorm(e) {
    const r = el.overlay.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }
  function onDown(e) {
    if (stage !== 'review' || !corners) return;
    const p = evtNorm(e);
    let best = -1, bestD = HANDLE_HIT;
    corners.forEach((c, i) => { const d = dist(c, p); if (d < bestD) { bestD = d; best = i; } });
    if (best < 0) return;
    dragIdx = best;
    el.overlay.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }
  function onMove(e) {
    if (dragIdx < 0) return;
    corners[dragIdx] = evtNorm(e);
    drawOverlay();
  }
  function onUp() {
    if (dragIdx < 0) return;
    dragIdx = -1;
    updatePreview();
  }

  // ---------- open / close ----------
  function cacheEls() {
    for (const id of ['scan-backdrop', 'scan-video', 'scan-overlay', 'scan-stage', 'scan-status',
      'scan-review', 'scan-preview', 'scan-device', 'scan-hint', 'scan-retake', 'scan-shutter',
      'scan-send', 'scan-close']) {
      const camel = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace('scan', '');
      el[camel.charAt(0).toLowerCase() + camel.slice(1)] = $id(id);
    }
    accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || accent;
  }
  function wireOnce() {
    if (el.wired) return;
    el.wired = true;
    el.close.onclick = () => close();
    el.shutter.onclick = () => capture();
    el.retake.onclick = () => retake();
    el.send.onclick = () => send();
    el.device.onchange = async () => {
      const id = el.device.value;
      stopCamera(); corners = null; frameCanvas = null;
      setStage('live');
      try { await startCamera(id); } catch (e) { showStatus(cameraError(e)); }
    };
    el.overlay.addEventListener('pointerdown', onDown);
    el.overlay.addEventListener('pointermove', onMove);
    el.overlay.addEventListener('pointerup', onUp);
    el.overlay.addEventListener('pointercancel', onUp);
  }

  async function open() {
    if (opened) return;
    if (!navigator.mediaDevices?.getUserMedia) { window.toast?.('This browser cannot open a camera', 3000); return; }
    if (!window.isSecureContext) { window.toast?.('Camera needs http://localhost:8787 — not the LAN address', 4500); return; }
    cacheEls();
    wireOnce();
    opened = true;
    corners = null; frameCanvas = null;
    setStage('live');
    el.backdrop.classList.remove('hidden');
    requestAnimationFrame(() => el.backdrop.setAttribute('data-open', ''));
    window.trapFocus?.(el.backdrop, el.close);
    showStatus('Starting camera…');
    try {
      await startCamera(null);
    } catch (e) {
      showStatus(cameraError(e));
      return;
    }
    showStatus(cv ? '' : 'Loading scanner…');
    loadOpenCV().then(() => { if (opened) { showStatus(''); lastDetect = 0; startLoop(); } })
      .catch(() => showStatus('Scanner engine failed to load'));
  }

  function close() {
    if (!opened) return;
    opened = false;
    stopLoop();
    stopCamera();
    el.backdrop.removeAttribute('data-open');
    el.backdrop.classList.add('hidden');
    window.untrapFocus?.(el.backdrop);
    showStatus('');
    el.review.classList.add('hidden');
    corners = null; frameCanvas = null;
  }

  window.PPScan = { open, close };
})();
