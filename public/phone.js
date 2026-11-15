const $ = s => document.querySelector(s);
const SERVER = location.origin;
const fmtBytes = PPShared.fmtBytes;

// ---------- auto-paste toggle (phone-side) ----------
const AP_KEY = 'pp_autopaste';
let autoPaste = false;

// ---------- universal transfer-quality reduction (server setting) ----------
const QUALITY_KEY = 'pp_quality';
const settings = { qualityReduce: false, qualityLevel: 80, maxPixels: 0 };
try { Object.assign(settings, JSON.parse(localStorage.getItem(QUALITY_KEY) || '{}')); } catch {}
function saveQualityLocal() {
  try { localStorage.setItem(QUALITY_KEY, JSON.stringify({
    qualityReduce: !!settings.qualityReduce, qualityLevel: settings.qualityLevel,
  })); } catch {}
}
async function qualityCompress(blob, q, { force = false, maxDim = 0 } = {}) {
  const bmp = await createImageBitmap(blob);
  let c = null;
  try {
    const scale = maxDim > 0 ? Math.min(1, maxDim / Math.max(bmp.width, bmp.height)) : 1;
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const out = await new Promise((res, rej) => c.toBlob(
      b => b ? res(b) : rej(new Error('encode failed')), 'image/jpeg', Math.min(1, Math.max(0.01, q / 100))));
    return (out && (force || out.size < blob.size)) ? out : blob;
  } finally {
    bmp.close && bmp.close();
    if (c) { c.width = 0; c.height = 0; }
  }
}
// SSE health for the adaptive poll loop (bottom of file) — true while the
// /events connection is open; flips off on error so polling speeds back up
let sseLive = false;
let everConnected = false;
function autoPasteUI() {
  const b = $('#autopaste');
  if (!b) return;
  b.setAttribute('aria-checked', String(autoPaste));
  statusDetail();
}
let statusCls = null, statusText = null;
function setStatus(cls, text) {
  const strip = $('#status-strip');
  if (cls === statusCls && text === statusText) {
    if (strip && !transferActive && strip.dataset.state !== cls) strip.dataset.state = cls;
    return;
  }
  statusCls = cls; statusText = text;
  $('#status-dot').className = 'dot ' + cls;
  $('#status').textContent = text;
  if (strip && !transferActive) strip.dataset.state = cls;
}
let statusSubText = null;
function setStatusSub(text) {
  const t = text || '';
  if (t === statusSubText) return;
  statusSubText = t;
  const el = $('#status-sub');
  if (el) el.textContent = t;
}
function statusDetail() {
  const n = Math.max(totalCount, recentItems.length);
  const parts = [];
  if (n) parts.push(`${n} sent`);
  if (autoPaste) parts.push('auto-paste on');
  setStatusSub(parts.join(' · '));
}

// ---------- transfer progress ----------
let transferTotal = 0, transferDone = 0, transferActive = null, transferSeq = 0;
const activeTransfers = new Map();
function transferBegin(name, total) {
  if (!transferTotal) { transferTotal = total || 1; transferDone = 0; }
  else if (total && transferDone + activeTransfers.size >= transferTotal) transferTotal++;
  const id = ++transferSeq;
  const entry = { id, name, pct: 0 };
  activeTransfers.set(id, entry);
  transferActive = entry;
  renderTransferStatus();
  return id;
}
function transferProgress(idOrName, pct) {
  let entry = activeTransfers.get(idOrName);
  if (!entry) {
    for (const v of activeTransfers.values()) if (v.name === idOrName) { entry = v; break; }
  }
  if (!entry) return;
  entry.pct = pct;
  transferActive = entry;
  renderTransferStatus();
}
function transferEnd(idOrName) {
  let key = activeTransfers.has(idOrName) ? idOrName : null;
  if (key == null) {
    for (const [k, v] of activeTransfers) if (v.name === idOrName) { key = k; break; }
  }
  if (key != null) activeTransfers.delete(key);
  transferDone++;
  transferActive = activeTransfers.values().next().value || null;
  if (transferDone >= transferTotal && !activeTransfers.size) {
    transferTotal = 0; transferDone = 0; transferActive = null;
    const strip = $('#status-strip');
    if (strip) {
      strip.dataset.state = statusCls || 'ok';
      strip.style.setProperty('--xfer-scale', '0');
    }
    statusDetail();
    return;
  }
  renderTransferStatus();
}
function renderTransferStatus() {
  const el = $('#status-sub');
  let sumFrac = 0;
  let leadEntry = transferActive;
  let bestPct = -2;
  for (const entry of activeTransfers.values()) {
    const f = entry.pct < 0 ? 0.58 : Math.max(0.06, Math.min(1, entry.pct / 100));
    sumFrac += f;
    if (entry.pct >= bestPct) { bestPct = entry.pct; leadEntry = entry; }
  }
  transferActive = leadEntry;
  if (!el || !transferActive) return;
  const n = transferTotal > 1 ? ` · ${Math.min(transferDone + activeTransfers.size, transferTotal)}/${transferTotal}` : '';
  const p = transferActive.pct;
  const lead = p < 0 ? 'sending…' : (p === 100 ? 'processing…' : p + '%');
  el.textContent = `${lead} ${transferActive.name}${n}`; // textContent only — XSS rule
  statusSubText = el.textContent;
  const strip = $('#status-strip');
  if (strip) {
    strip.dataset.state = 'busy';
    const scale = Math.max(0.14, Math.min(1, (transferDone + sumFrac) / Math.max(1, transferTotal)));
    strip.style.setProperty('--xfer-scale', scale.toFixed(3));
  }
}
function transferA11y(name, pct) {
  const el = $('#file-progress');
  if (!el) return;
  el.textContent = pct < 0 ? `Sending ${name}` : `${name} ${pct}%`;
}
let transferBatchRemaining = 0;
const transferBatchSize = () => transferBatchRemaining || 1;

async function checkServer() {
  try {
    let n = 0;
    try { n = await outboxCount(); } catch {}
    const url = `${SERVER}/api/lan?device=phone${n ? `&outbox=${n}` : ''}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw 0;
    everConnected = true;
    setStatus('ok', 'connected');
    if (!sseLive) {
      loadRecent();
      loadTexts();
    }
    flushOutbox();
    flushTextQueue();
    flushFileQueue();
    if (!sseLive || xferFiles.length) loadFiles();
  } catch {
    if (!everConnected) { setStatus('off', 'not paired'); setStatusSub('scan the QR on your PC · same Wi-Fi'); return; }
    setStatus('off', 'offline');
  }
}

// ---------- offline queue for TEXTS (capacity/retry policy in queue.js) ----------
const TEXTQ_KEY = 'pp_text_queue';
const textQueue = () => { try { return JSON.parse(localStorage.getItem(TEXTQ_KEY) || '[]'); } catch { return []; } };
const setTextQueue = q => {
  try { localStorage.setItem(TEXTQ_KEY, JSON.stringify(PPQueue.trimTexts(q))); }
  catch { try { localStorage.setItem(TEXTQ_KEY, JSON.stringify(PPQueue.trimTextsFallback(q))); } catch {} }
  textQueueUI();
};
function textQueueUI() {
  const q = textQueue();
  const el = $('#text-queued');
  el.classList.toggle('hidden', !q.length);
  if (q.length) {
    el.replaceChildren(
      Object.assign(document.createElement('i'), { className: 'ic ic-mail' }),
      document.createTextNode(` ${q.length} text${q.length > 1 ? 's' : ''} queued — will send when back online`)
    );
  } else {
    el.replaceChildren();
  }
}
async function flushTextQueue() {
  const q = textQueue();
  if (!q.length) return;
  const remaining = [];
  for (const t of q) {
    try {
      const r = await fetch(`${SERVER}/api/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: t.body, source: 'phone' }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw 0;
    } catch { remaining.push(t); }
  }
  setTextQueue(remaining);
  if (q.length && !remaining.length) flash('Queued texts sent ✓');
}

async function upload(blob, opts = {}) {
  let sendBlob = blob;
  if (settings.qualityReduce && blob.type && blob.type.startsWith('image/') && blob.type !== 'image/gif') {
    try {
      sendBlob = await qualityCompress(blob, settings.qualityLevel, { maxDim: 4096 });
    } catch {}
  }
  if (sendBlob.type && /^image\/(hei[cf]|heif)$/i.test(sendBlob.type)) {
    try {
      const j = await qualityCompress(sendBlob, 92, { force: true });
      if (j && j.type === 'image/jpeg' && j !== sendBlob) sendBlob = j;
    } catch {}
  }
  const fd = new FormData();
  fd.append('source', 'phone');
  if (opts.auto ?? autoPaste) fd.append('auto', '1');
  const dedupeKey = opts.dedupeKey ?? null;
  if (dedupeKey) fd.append('key', String(dedupeKey).slice(0, 32));
  const ext = ((sendBlob.type || '').split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  fd.append('photo', sendBlob, `capture.${ext}`);
  const timeoutMs = Math.min(600000, Math.max(30000, 15000 + (sendBlob.size / (1024 * 1024)) * 1000));
  const res = await PPShared.xhrPost(SERVER + '/upload', fd, {
    timeoutMs,
    onProgress: opts.onProgress,
  });
  if (res.ok) return res.data;
  const err = new Error('upload failed ' + res.status);
  err.status = res.status;
  if (res.reason) err.reason = res.reason;
  throw err;
}

// ---------- outbox (IndexedDB) ----------
let idb = null;
function openOutbox() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('proofpipe', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('outbox', { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
function newKey() {
  const k = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .replace(/-/g, '');
  return k.slice(0, 32);
}
async function outboxCount() {
  if (!idb) return 0;
  const tx = idb.transaction('outbox').objectStore('outbox').count();
  return new Promise(r => { tx.onsuccess = () => r(tx.result); tx.onerror = () => r(0); });
}
async function outboxUI() {
  const n = await outboxCount();
  const el = $('#outbox-info');
  el.classList.toggle('hidden', !n);
  const live = $('#outbox-text') || el;
  live.replaceChildren(
    Object.assign(document.createElement('i'), { className: 'ic ic-package' }),
    document.createTextNode(` ${n} photo${n > 1 ? 's' : ''} queued — will sync automatically`)
  );
  const co = $('#clear-outbox');
  if (co) co.classList.toggle('hidden', !n);
}
async function outboxAdd(blob, existingKey = null, auto = false, dedupeKey = null) {
  if (!idb) return null;
  const key = await new Promise((resolve, reject) => {
    const tx = idb.transaction('outbox', 'readwrite');
    const store = tx.objectStore('outbox');
    const rec = { blob, id: uuid(), tries: 0, lastAttempt: 0, auto: auto === true };
    if (dedupeKey) rec.dedupeKey = String(dedupeKey).slice(0, 32);
    const req = existingKey != null
      ? store.put(rec, existingKey)
      : store.add(rec);
    tx.oncomplete = () => resolve(existingKey ?? req.result);
    tx.onerror = () => reject(tx.error);
  });
  outboxUI();
  return key;
}
async function outboxBumpTries(key, value) {
  if (!idb) return;
  await new Promise(resolve => {
    const tx = idb.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').put({ ...value, tries: value.tries || 0, lastAttempt: value.lastAttempt ?? Date.now() }, key);
    tx.oncomplete = resolve; tx.onerror = resolve;
  });
}
async function outboxSetDedupeKey(key, dedupeKey) {
  if (!idb || key == null || !dedupeKey) return;
  const rec = await outboxGet(key).catch(() => null);
  if (!rec || rec.dedupeKey) return;
  await new Promise(resolve => {
    const tx = idb.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').put({ ...rec, dedupeKey: String(dedupeKey).slice(0, 32) }, key);
    tx.oncomplete = resolve; tx.onerror = resolve;
  });
}
async function outboxUpdateBlob(key, blob) {
  if (!idb || key == null || !blob) return;
  const rec = await outboxGet(key).catch(() => null);
  if (!rec) return;
  await new Promise(resolve => {
    const tx = idb.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').put({ ...rec, blob }, key);
    tx.oncomplete = resolve; tx.onerror = resolve;
  });
}
async function outboxDelete(key) {
  if (!idb) return;
  await new Promise(resolve => {
    const tx = idb.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').delete(key);
    tx.oncomplete = resolve; tx.onerror = resolve;
  });
  outboxUI();
}
async function outboxAll() {
  if (!idb) return [];
  return new Promise(resolve => {
    const out = [];
    const req = idb.transaction('outbox').objectStore('outbox').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) { out.push({ key: c.key, value: c.value }); c.continue(); }
      else resolve(out);
    };
    req.onerror = () => resolve([]);
  });
}
async function outboxGet(key) {
  if (!idb) return null;
  return new Promise(resolve => {
    const req = idb.transaction('outbox').objectStore('outbox').get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}
async function outboxExists(key) {
  if (!idb) return false;
  return new Promise(resolve => {
    const req = idb.transaction('outbox').objectStore('outbox').getKey(key);
    req.onsuccess = () => resolve(req.result !== undefined);
    req.onerror = () => resolve(false);
  });
}
async function outboxClear() {
  if (!idb) return;
  await new Promise(resolve => {
    const tx = idb.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').clear();
    tx.oncomplete = resolve; tx.onerror = resolve;
  });
  outboxUI();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let flushing = false;
const inflightKeys = new Set();
async function flushOutbox() {
  if (flushing || !idb) return;
  flushing = true;
  let last429 = 0;
  let usedLast = false;
  try {
    if (!(await outboxCount())) return;
    const items = await outboxAll();
    if (!items.length) return;
    const CONC = 2;
    let idx = 0;
    const worker = async () => {
      while (true) {
        while (Date.now() - last429 < 1500) await sleep(last429 + 1500 - Date.now());
        const job = items[idx++];
        if (!job) return;
        const v = job.value;
        if (PPQueue.decide(v, { now: Date.now(), inflight: inflightKeys.has(job.key) }) !== 'send') {
          continue;
        }
        try {
          const stillThere = await outboxExists(job.key);
          if (!stillThere) continue;
        } catch { continue; }
        usedLast = true;
        const tid = transferBegin('queued photos', items.length);
        try {
          const result = await upload(v.blob, { auto: v.auto, dedupeKey: v.dedupeKey, onProgress: p => transferProgress(tid, p) });
          const item = recentItems.find(i => i.outboxKey === job.key);
          await outboxDelete(job.key);
          if (item) {
            item.outboxKey = null;
            markSent(item.el, result);
          }
        } catch (e) {
          const status = e && e.status;
          const book = PPQueue.onFailure(v, status);
          if (book.rateLimitedMs) last429 = Date.now();
          const extra = book.poisoned ? { poisonReason: 'too-large' } : {};
          await outboxBumpTries(job.key, { ...v, tries: book.tries, lastAttempt: book.lastAttempt, ...extra });
          if (book.poisoned) flash(e?.reason === 'too many pixels'
            ? tooManyPixelsMsg()
            : 'Photo is over the size cap — it was not sent');
        } finally {
          transferEnd(tid);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, items.length) }, worker));
  } finally {
    flushing = false;
    outboxUI();
    if (usedLast) {
      const remaining = await outboxCount();
      if (remaining) setTimeout(flushOutbox, 2000);
    }
  }
}

// ---------- recent items: tap = open viewer, actions under the image ----------
const recentItems = []; // { el, blob, ts, sent, file, id, remote, fromPc }
let selectMode = false;
const selectedTiles = new Set();

function syncBatchUI() {
  for (const tile of [...selectedTiles]) {
    if (!recentItems.includes(tile)) selectedTiles.delete(tile);
  }
  const toggleBtn = $('#select-toggle');
  if (toggleBtn) {
    toggleBtn.classList.toggle('hidden', recentItems.length === 0);
    toggleBtn.setAttribute('aria-pressed', String(selectMode));
    toggleBtn.textContent = selectMode ? 'Done' : 'Select';
  }
  document.body.classList.toggle('select-mode', selectMode);
  const bar = $('#batch-bar');
  if (bar) bar.classList.toggle('hidden', !selectMode);
  const countEl = $('#batch-count');
  if (countEl) countEl.textContent = `${selectedTiles.size} selected`;
  const allBtn = $('#batch-all');
  if (allBtn) {
    const allSelected = recentItems.length > 0 && selectedTiles.size === recentItems.length;
    allBtn.textContent = allSelected ? 'None' : 'All';
  }
  const hasQueued = [...selectedTiles].some(t => !t.sent);
  const retryBtn = $('#batch-retry');
  if (retryBtn) retryBtn.classList.toggle('hidden', !hasQueued);
  const delBtn = $('#batch-delete');
  if (delBtn) delBtn.disabled = selectedTiles.size === 0;
}

function setSelectMode(on) {
  selectMode = !!on && recentItems.length > 0;
  if (!selectMode) {
    for (const tile of selectedTiles) {
      tile.el.classList.remove('selected');
      tile.el.removeAttribute('aria-pressed');
    }
    selectedTiles.clear();
  }
  syncBatchUI();
}

function toggleTileSelection(tile) {
  if (!tile) return;
  if (selectedTiles.has(tile)) {
    selectedTiles.delete(tile);
    tile.el.classList.remove('selected');
    tile.el.setAttribute('aria-pressed', 'false');
  } else {
    selectedTiles.add(tile);
    tile.el.classList.add('selected');
    tile.el.setAttribute('aria-pressed', 'true');
  }
  syncBatchUI();
}

function attachTileSelectionGesture(w, tile) {
  let lpTimer = 0;
  let sx = 0, sy = 0;
  const cancel = () => {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; }
  };
  w.addEventListener('pointerdown', e => {
    if (selectMode || e.button !== 0) return;
    sx = e.clientX; sy = e.clientY;
    cancel();
    lpTimer = setTimeout(() => {
      lpTimer = 0;
      w.dataset.longPressed = '1';
      if (!selectMode) setSelectMode(true);
      if (!selectedTiles.has(tile)) toggleTileSelection(tile);
    }, 450);
  });
  w.addEventListener('pointermove', e => {
    if (!lpTimer) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel();
  });
  w.addEventListener('pointerup', cancel);
  w.addEventListener('pointercancel', cancel);
}

async function tileUrl(blob) {
  let bmp = null;
  let c = null;
  try {
    bmp = await createImageBitmap(blob, { resizeWidth: 240, resizeQuality: 'medium' });
    c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    bmp = null;
    return await new Promise(res => c.toBlob(b => {
      c.width = 0; c.height = 0;
      res(b ? URL.createObjectURL(b) : URL.createObjectURL(blob));
    }, 'image/jpeg', 0.8));
  } catch {
    if (bmp && bmp.close) bmp.close();
    if (c) { c.width = 0; c.height = 0; }
    return URL.createObjectURL(blob);
  }
}
async function regenerateTileUrl(tile) {
  if (!tile || !tile.blob) return;
  const next = await tileUrl(tile.blob);
  if (!recentItems.includes(tile)) { revokeObjectUrl(next); return; }
  revokeObjectUrl(tile.tileUrl);
  tile.tileUrl = next;
  if (tile.img) tile.img.src = next;
}
function revokeObjectUrl(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
}
function tileTimeLabel(ts) {
  const ms = PPShared.parseUtcMs(ts);
  if (!ms) return '';
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return new Date().toDateString() === d.toDateString()
    ? ` at ${time}`
    : ` at ${time} on ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}
function recentTileA11y(w, tile, when = null) {
  const base = `${tile.fromPc ? 'Capture from PC' : 'Capture'}${tileTimeLabel(when)}, open preview`;
  w.dataset.a11yBase = base;
  w.setAttribute('role', 'button');
  w.tabIndex = 0;
  w.setAttribute('aria-label', base);
  w.title = 'Tap or press Enter to view';
  w.onclick = () => {
    if (w.dataset.longPressed === '1') {
      delete w.dataset.longPressed;
      return;
    }
    if (selectMode) {
      toggleTileSelection(tile);
      return;
    }
    tile.remote ? openViewerRemote(tile) : openViewer(tile);
  };
  w.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); w.click(); }
  };
}
function setTileState(w, state) {
  const base = w && w.dataset.a11yBase;
  if (!base) return;
  w.setAttribute('aria-label', state ? `${base} — ${state}` : base);
}
const JUST_SENT_MS = 2000;
const JUST_SENT_FADE_MS = 400;
function markJustSent(el) {
  if (!el) return;
  clearTimeout(el._justSentTimer);
  el.classList.remove('just-sent-out');
  el.classList.add('just-sent');
  el._justSentTimer = setTimeout(() => {
    el.classList.add('just-sent-out');
    el._justSentTimer = setTimeout(() => {
      el.classList.remove('just-sent', 'just-sent-out');
    }, JUST_SENT_FADE_MS);
  }, JUST_SENT_MS);
}
function tileEnter(w) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  w.classList.add('tile-enter');
  w.addEventListener('animationend', () => w.classList.remove('tile-enter'), { once: true });
}
function thumbFadeIn(img) {
  if (!('decode' in img)) return;
  img.decode().then(() => {
    img.classList.remove('thumb-enter');
    img.classList.add('thumb-in');
  }).catch(() => { img.classList.remove('thumb-enter'); });
}
function addRecent(blob, meta = {}, { live = true } = {}) {
  const w = document.createElement('div');
  w.className = 'ok-badge pending';
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  const tile = {
    el: w, img, blob, sent: false, url: null, tileUrl: null, outboxKey: meta.outboxKey ?? null,
    file: meta.file || null, id: meta.id || null, remote: false, fromPc: false,
    createdAt: meta.createdAt || Date.now(),
  };
  tileUrl(blob).then(u => {
    if (!recentItems.includes(tile)) { revokeObjectUrl(u); return; }
    tile.tileUrl = u;
    if (live) {
      img.classList.add('thumb-enter');
      thumbFadeIn(img);
    }
    img.src = u;
  });
  const chk = document.createElement('span');
  chk.className = 'tile-check';
  chk.setAttribute('aria-hidden', 'true');
  w.append(img, chk);
  recentTileA11y(w, tile, live ? Date.now() : null);
  attachTileSelectionGesture(w, tile);
  if (live) {
    tileEnter(w);
    setTileState(w, 'uploading');
  }
  $('#recent').prepend(w);
  recentItems.unshift(tile);
  trimRecent();
  return tile;
}
function addRemoteRecent(cap, { live = false } = {}) {
  if (!cap || !cap.file) return null;
  const existing = recentItems.find(i => i.file === cap.file);
  if (existing) {
    existing.id = cap.id ?? existing.id;
    existing.file = cap.file;
    existing.sent = true;
    existing.remote = true;
    if (existing.fromPc !== (cap.origin === 'pc')) {
      existing.fromPc = cap.origin === 'pc';
      recentTileA11y(existing.el, existing, cap.created_at);
    }
    existing.el.classList.toggle('pc-origin', existing.fromPc);
    existing.el.classList.remove('pending', 'failed');
    setTileState(existing.el, '');
    existing.el.title = 'Uploaded to your PC — tap to view';
    if (live) markJustSent(existing.el);
    existing.url = `${SERVER}/media/${encodeURIComponent(cap.file)}`;
    existing.thumbUrl = `${SERVER}/media/t-${encodeURIComponent(cap.file)}`;
    if (existing.img && existing.thumbUrl && !existing.tileUrl) {
      const nextSrc = `${existing.thumbUrl}${existing.img.src === existing.thumbUrl ? `?v=${cap.id || Date.now()}` : ''}`;
      if (live) {
        existing.img.classList.add('thumb-enter');
        existing.img.src = nextSrc;
        thumbFadeIn(existing.img);
      } else {
        existing.img.src = nextSrc;
      }
    }
    return existing;
  }
  const w = document.createElement('div');
  w.className = cap.origin === 'pc' ? 'ok-badge pc-origin' : 'ok-badge';
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  const thumb = `${SERVER}/media/t-${encodeURIComponent(cap.file)}`;
  const tile = {
    el: w, img, blob: null, sent: true, url: `${SERVER}/media/${encodeURIComponent(cap.file)}`,
    thumbUrl: thumb, fullUrl: null, outboxKey: null, file: cap.file, id: cap.id ?? null,
    remote: true, fromPc: cap.origin === 'pc', remoteList: recentItems,
    createdAt: cap.created_at || null,
  };
  if (live) {
    img.classList.add('thumb-enter');
    tileEnter(w);
    markJustSent(w);
  }
  img.src = thumb;
  recentTileA11y(w, tile, cap.created_at);
  w.title = 'Uploaded to your PC — tap to view';
  let thumbTries = 0;
  img.onerror = () => {
    if (++thumbTries > 11) return;
    setTimeout(() => { if (img.isConnected) img.src = `${thumb}?retry=${Date.now()}`; }, Math.min(5000, 400 * thumbTries));
  };
  const chk = document.createElement('span');
  chk.className = 'tile-check';
  chk.setAttribute('aria-hidden', 'true');
  w.append(img, chk);
  attachTileSelectionGesture(w, tile);
  stampSort(w, { ts: chipTimestamp(cap.created_at), name: cap.file, seq: cap.id });
  $('#recent').prepend(w);
  recentItems.unshift(tile);
  if (sortMode !== 'new') applySort($('#recent'));
  trimRecent();
  return tile;
}
let recentVersion = -1;
let recentLoaded = false;
const SKEL_TILES = 6;
function buildRecentSkeleton() {
  const box = $('#recent-loading');
  if (!box || box.children.length) return;
  for (let i = 0; i < SKEL_TILES; i++) {
    const tile = document.createElement('div');
    tile.className = 'skel-tile';
    box.appendChild(tile);
  }
}
async function loadQueuedRecent() {
  const queued = await outboxAll();
  for (const job of queued.reverse()) {
    if (!job.value?.blob) continue;
    const tile = addRecent(job.value.blob, { outboxKey: job.key }, { live: false });
    tile.auto = job.value.auto === true;
    if (job.value.dedupeKey) tile.dedupeKey = job.value.dedupeKey;
    if ((job.value.tries || 0) >= 999) {
      tile.el.classList.remove('pending');
      tile.el.classList.add('failed');
      setTileState(tile.el, 'not sent');
    }
  }
  recentEmptyUI();
}
async function loadRecent(force = false) {
  const skel = $('#recent-loading');
  if (!recentLoaded) {
    buildRecentSkeleton();
    skel?.classList.remove('hidden');
  }
  try {
    const version = await fetch(`${SERVER}/api/captures/version`, { signal: AbortSignal.timeout(3000) });
    if (!version.ok) throw 0;
    const versionBody = await version.json();
    if (!force && versionBody.latest === recentVersion) {
      recentLoaded = true;
      skel?.classList.add('hidden');
      recentEmptyUI();
      return;
    }
    const r = await fetch(`${SERVER}/api/captures?limit=100`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw 0;
    const list = await r.json();
    recentVersion = versionBody.latest;
    recentLoaded = true;
    skel?.classList.add('hidden');
    $('#recent-error')?.classList.add('hidden');
    const known = new Set(list.map(cap => cap.file));
    for (let i = recentItems.length - 1; i >= 0; i--) {
      const item = recentItems[i];
      if (item.file && item.sent && item.outboxKey == null && !known.has(item.file)) {
        item.el.remove();
        recentItems.splice(i, 1);
      }
    }
    for (const cap of [...list].reverse()) addRemoteRecent(cap);
    recentEmptyUI();
  } catch {
    recentLoaded = true;
    skel?.classList.add('hidden');
    $('#recent-error')?.classList.remove('hidden');
    recentEmptyUI();
  }
}
$('#recent-retry')?.addEventListener('click', () => loadRecent(true));
function trimRecent() {
  if (recentItems.length <= 100) return;
  for (let i = recentItems.length - 1; i >= 0 && recentItems.length > 100; i--) {
    const old = recentItems[i];
    if (!old.sent) continue;
    recentItems.splice(i, 1);
    if (viewer.hasItem(old) || viewer.hasBlob(old.blob)) hideViewer();
    old.el.remove();
    revokeObjectUrl(old.tileUrl);
    revokeObjectUrl(old.url);
    revokeObjectUrl(old.fullUrl);
  }
}
function removeRecentItem(item) {
  if (!item) return;
  selectedTiles.delete(item);
  if (viewer.hasItem(item) || viewer.hasBlob(item.blob)) hideViewer();
  item.el.remove();
  const idx = recentItems.indexOf(item);
  if (idx >= 0) recentItems.splice(idx, 1);
  revokeObjectUrl(item.tileUrl);
  revokeObjectUrl(item.url);
  revokeObjectUrl(item.fullUrl);
}
function markSent(el, result = null) {
  el.classList.remove('pending', 'failed');
  setTileState(el, '');
  el.title = 'Uploaded to your PC — tap to view';
  markJustSent(el);
  const item = recentItems.find(i => i.el === el);
  if (!item) return;
  item.sent = true;
  if (result?.file) {
    const duplicate = recentItems.find(i => i !== item && i.file === result.file);
    if (duplicate) {
      removeRecentItem(item);
      return;
    }
    item.file = result.file;
    item.url = `${SERVER}/media/${encodeURIComponent(result.file)}`;
    item.thumbUrl = `${SERVER}/media/t-${encodeURIComponent(result.file)}`;
    item.blob = null;
    if (item.fullUrl) { revokeObjectUrl(item.fullUrl); item.fullUrl = null; }
  }
  if (result?.id != null) item.id = result.id;
}
async function retryItem(item) {
  if (!item || item.sent) return;
  if (!$('#status-dot').classList.contains('ok')) { flash('Offline — cannot retry now'); return; }
  const key = item.outboxKey;
  if (key != null) inflightKeys.add(key);
  let dk = item.dedupeKey ?? null;
  if (!dk && item.outboxKey != null) {
    try { dk = (await outboxGet(item.outboxKey))?.dedupeKey || null; } catch {}
  }
  if (!dk) dk = newKey();
  item.dedupeKey = dk;
  await outboxSetDedupeKey(item.outboxKey, dk);
  const tid = transferBegin('photo', 1);
  try {
    const result = await upload(item.blob, { auto: item.auto ?? autoPaste, dedupeKey: dk, onProgress: p => transferProgress(tid, p) });
    if (item.outboxKey != null) await outboxDelete(item.outboxKey);
    item.outboxKey = null;
    markSent(item.el, result);
    flash('Sent ✓');
  } catch (e) {
    if (item.outboxKey == null) item.outboxKey = await outboxAdd(item.blob, null, item.auto ?? autoPaste, dk);
    flash(e?.reason === 'too many pixels'
      ? tooManyPixelsMsg()
      : 'Still failing — queued for auto-sync');
  } finally {
    transferEnd(tid);
    if (key != null) inflightKeys.delete(key);
  }
}

// ---------- modal focus trap + flash + confirm ----------
const phoneTrapStack = [];
function phoneFocusables(root) {
  return [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(el => el.getClientRects().length);
}
function phoneTrapKey(e) {
  if (e.key !== 'Tab') return;
  const entry = phoneTrapStack.at(-1);
  if (!entry || !entry.container.contains(e.target)) return;
  const f = phoneFocusables(entry.container);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus({ preventScroll: true }); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus({ preventScroll: true }); }
}
function trapPhone(container, initial) {
  const current = phoneTrapStack.at(-1);
  if (current && current.container === container) return;
  if (current) current.container.removeEventListener('keydown', phoneTrapKey);
  const entry = { container, returnFocus: document.activeElement };
  phoneTrapStack.push(entry);
  container.addEventListener('keydown', phoneTrapKey);
  const f = phoneFocusables(container);
  (initial || f[0] || container).focus({ preventScroll: true });
}
function untrapPhone(container, restoreEl = null) {
  const idx = phoneTrapStack.findIndex(e => e.container === container);
  if (idx < 0) return;
  const [entry] = phoneTrapStack.splice(idx, 1);
  entry.container.removeEventListener('keydown', phoneTrapKey);
  const previous = phoneTrapStack.at(-1);
  if (previous) {
    previous.container.addEventListener('keydown', phoneTrapKey);
    const el = restoreEl || entry.returnFocus;
    if (el && el.isConnected && previous.container.contains(el)) el.focus({ preventScroll: true });
  } else {
    const el = restoreEl || entry.returnFocus;
    if (el && el.isConnected) el.focus({ preventScroll: true });
  }
}

let flashEl = null, flashTimer = 0;
function inferFlashTone(msg = '') {
  const s = String(msg).toLowerCase();
  if (/failed|could not|blocked|offline|too many|over the size|refused|empty/.test(s)) return 'err';
  if (/queued|retry|not sent|check the connection/.test(s)) return 'warn';
  return 'ok';
}
function hideFlashNow() {
  if (!flashEl) return;
  clearTimeout(flashTimer);
  flashTimer = 0;
  flashEl.classList.remove('swiping');
  flashEl.style.transform = '';
  flashEl.style.opacity = '';
  flashEl.classList.add('hidden');
}
function scheduleFlashHide(ms = 1800) {
  clearTimeout(flashTimer);
  flashTimer = setTimeout(hideFlashNow, ms);
}
function attachPhoneSwipeDismiss(el, onDismiss, { allowUp = true, allowDown = false, onHoldStart, onHoldEnd } = {}) {
  if (!el || el.dataset.swipeWired === '1') return;
  el.dataset.swipeWired = '1';
  let drag = null;
  let settleTimer = 0;
  const reset = () => {
    el.classList.remove('swiping');
    el.style.transform = '';
    el.style.opacity = '';
  };
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest('button')) return;
    clearTimeout(settleTimer);
    onHoldStart && onHoldStart();
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), dx: 0, dy: 0, moved: false };
    el.classList.add('swiping');
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  el.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const rawDy = e.clientY - drag.y0;
    const minY = allowUp ? -120 : -12;
    const maxY = allowDown ? 120 : 14;
    const dy = Math.max(minY, Math.min(maxY, rawDy));
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    drag.dx = dx;
    drag.dy = dy;
    const dist = Math.hypot(dx, allowUp && dy < 0 ? -dy : (allowDown && dy > 0 ? dy : 0));
    el.style.transform = `translate(calc(-50% + ${dx.toFixed(1)}px), ${dy.toFixed(1)}px)`;
    el.style.opacity = String(Math.max(0.18, 1 - dist / 120));
  });
  const finish = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    el.classList.remove('swiping');
    try { el.releasePointerCapture(e.pointerId); } catch {}
    const dt = Math.max(1, performance.now() - d.t0);
    const vx = d.dx / dt;
    const vy = d.dy / dt;
    const yCommit = (allowUp && (d.dy < -36 || (vy < -0.4 && d.dy < -14)))
      || (allowDown && (d.dy > 36 || (vy > 0.4 && d.dy > 14)));
    const xCommit = Math.abs(d.dx) > 56 || (Math.abs(vx) > 0.42 && Math.abs(d.dx) > 18);
    if (d.moved && (xCommit || yCommit)) {
      const tx = xCommit ? (d.dx >= 0 ? 180 : -180) : d.dx * 1.2;
      const ty = yCommit ? (d.dy < 0 ? -72 : 72) : d.dy;
      el.style.transform = `translate(calc(-50% + ${tx.toFixed(1)}px), ${ty.toFixed(1)}px)`;
      el.style.opacity = '0';
      settleTimer = setTimeout(() => { reset(); onDismiss(); }, 150);
    } else {
      reset();
      onHoldEnd && onHoldEnd();
    }
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}
function flash(msg, opts = {}) {
  if (!flashEl) {
    flashEl = document.createElement('div');
    flashEl.className = 'flash hidden';
    flashEl.setAttribute('role', 'status');
    document.body.appendChild(flashEl);
  }
  const tone = opts.tone || inferFlashTone(msg);
  const ms = opts.duration || (tone === 'err' ? 2400 : 1800);
  attachPhoneSwipeDismiss(flashEl, hideFlashNow, {
    allowUp: true,
    allowDown: false,
    onHoldStart: () => clearTimeout(flashTimer),
    onHoldEnd: () => { if (flashEl && !flashEl.classList.contains('hidden')) scheduleFlashHide(1400); },
  });
  flashEl.dataset.tone = tone;
  flashEl.classList.remove('swiping', 'hidden');
  flashEl.style.transform = '';
  flashEl.style.opacity = '';
  flashEl.textContent = msg;
  scheduleFlashHide(ms);
}

let confirmResolve = null;
let confirmReturnFocus = null;
function phoneConfirm({ title, body = '', ok = 'Delete', danger = true }) {
  const box = $('#confirm');
  if (!box) return Promise.resolve(window.confirm(title)); // older cached shell
  closeConfirm(false);
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  $('#confirm-body').classList.toggle('hidden', !body);
  const okBtn = $('#confirm-ok');
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  confirmReturnFocus = document.activeElement;
  box.classList.remove('hidden');
  trapPhone(box, $('#confirm-cancel'));
  syncOverlayHistory();
  return new Promise(resolve => { confirmResolve = resolve; });
}
function closeConfirm(result) {
  const box = $('#confirm');
  if (!box || box.classList.contains('hidden')) return;
  box.classList.add('hidden');
  const resolve = confirmResolve;
  confirmResolve = null;
  const back = confirmReturnFocus;
  confirmReturnFocus = null;
  untrapPhone(box, back);
  syncOverlayHistory();
  if (resolve) resolve(result);
}
function confirmOpen() { return !$('#confirm').classList.contains('hidden'); }
$('#confirm-cancel').onclick = () => closeConfirm(false);
$('#confirm-ok').onclick = () => closeConfirm(true);
$('#confirm').onclick = e => { if (e.target.id === 'confirm') closeConfirm(false); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && confirmOpen()) closeConfirm(false);
});

// ---------- capture handling (fast path) ----------
let shutterBusyCount = 0;
function shutterBusy(on) {
  shutterBusyCount = Math.max(0, shutterBusyCount + (on ? 1 : -1));
  const s = $('#shutter');
  if (s) s.classList.toggle('busy', shutterBusyCount > 0);
  const recent = $('#recent');
  if (recent) recent.setAttribute('aria-busy', String(shutterBusyCount > 0));
}
async function handleFiles(files) {
  const jobs = [...files].filter(f => f && f.size > 0).map(file => {
    const blob = file.type && file.type.startsWith('image/') ? file : new Blob([file], { type: 'image/jpeg' });
    const tile = addRecent(blob);
    tile.auto = autoPaste;
    const dedupeKey = newKey();
    tile.dedupeKey = dedupeKey;
    return { blob, tile, dedupeKey };
  });
  let qi = 0;
  let last429 = 0;
  const worker = async () => {
    while (qi < jobs.length) {
      while (Date.now() - last429 < 1500) await sleep(last429 + 1500 - Date.now());
      const job = jobs[qi++];
      const tid = transferBegin('photos', jobs.length);
      try {
        const result = await upload(job.blob, { auto: job.tile.auto, dedupeKey: job.dedupeKey, onProgress: p => transferProgress(tid, p) });
        markSent(job.tile.el, result);
      } catch (e) {
        if (e && e.status === 429) last429 = Date.now();
        const key = await outboxAdd(job.blob, null, job.tile.auto, job.dedupeKey);
        if (key) job.tile.outboxKey = key;
        if (job.tile.el.isConnected) {
          job.tile.el.classList.add('failed');
          setTileState(job.tile.el, 'not sent');
        } else if (!key) flash('Some photos could not be queued — index offline');
      } finally {
        transferEnd(tid);
      }
    }
  };
  if (!jobs.length) return;
  shutterBusy(true);
  try {
    await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, worker));
  } finally {
    shutterBusy(false);
  }
}

// ---------- inputs ----------
function activateOnKey(el) {
  if (!el) return;
  el.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    el.click();
  });
}
for (const input of [$('#cam'), $('#gallery'), $('#file-input')]) {
  const label = input && input.closest('label');
  if (label) activateOnKey(label);
}
activateOnKey($('#outbox-info'));
$('#cam').onchange = e => { handleFiles([...e.target.files]); e.target.value = ''; };
$('#gallery').onchange = e => { handleFiles([...e.target.files]); e.target.value = ''; };

// ---------- open latest on PC ----------
$('#open-latest').onclick = async () => {
  try {
    await fetch(SERVER + '/api/open-latest', { method: 'POST', signal: AbortSignal.timeout(3000) });
    flash('Sent — the PC harness will open it (tab must be open)');
  } catch { flash('Offline'); }
};

// ---------- text & media chips + swipe/undo ----------
const pcMediaItems = []; // { file, url, blob, fullUrl, remote: true }
const deadPcMedia = new Set();
const DEAD_PC_MEDIA_MAX = 200;
function markDeadPcMedia(file) {
  deadPcMedia.add(file);
  if (deadPcMedia.size > DEAD_PC_MEDIA_MAX) deadPcMedia.delete(deadPcMedia.values().next().value);
}
function pcMediaFor(file, url, createdAt = null) {
  let item = pcMediaItems.find(i => i.file === file);
  if (!item) {
    const thumbUrl = `${SERVER}/media/t-${encodeURIComponent(file)}`;
    item = { file, url, thumbUrl, blob: null, fullUrl: null, remote: true, sent: true, fromPc: true, createdAt };
    pcMediaItems.unshift(item);
    if (pcMediaItems.length > 24) {
      const old = pcMediaItems.pop();
      if (viewer.hasItem(old) || viewer.hasBlob(old.blob)) hideViewer();
      if (old.fullUrl) URL.revokeObjectURL(old.fullUrl);
    }
  } else if (createdAt && !item.createdAt) {
    item.createdAt = createdAt;
  }
  return item;
}
function copyTextFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}
async function tapCopyText(text, chip) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch { ok = copyTextFallback(text); }
  if (ok) {
    if (chip) {
      chip.classList.remove('is-copied');
      void chip.offsetWidth;
      chip.classList.add('is-copied');
      clearTimeout(chip._copyTimer);
      chip._copyTimer = setTimeout(() => chip.classList.remove('is-copied'), 950);
    }
    flash('Copied ✓ — paste anywhere');
    return;
  }
  chip?.classList.add('chip-manual');
  flash('Copy blocked — long-press the text to select it');
}

const CHIP_DEL_PX = 72;
const CHIP_AXIS_PX = 12;
let chipSwiping = false;
let textsDirty = false;
let filesDirty = false;
function dismissChipHint() {
  try { localStorage.pp_chip_hint = '1'; } catch {}
  $('#chip-hint')?.classList.add('hidden');
}
function maybeFlushTexts() {
  if (!textsDirty) return;
  textsDirty = false;
  loadTexts();
}
function maybeFlushFiles() {
  if (!filesDirty) return;
  filesDirty = false;
  loadFiles(true);
}
const UNDO_MS = 6000;
let undoPending = null;
let undoTimer = 0;
function hideUndoToast() {
  const toast = $('#undo-toast');
  if (toast) {
    toast.classList.remove('swiping');
    toast.style.transform = '';
    toast.style.opacity = '';
    toast.classList.add('hidden');
  }
  const btn = $('#undo-toast-btn');
  if (btn) btn.onclick = null;
}
function flushAfterUndo() {
  setTimeout(() => {
    if (undoPending) return;
    maybeFlushTexts();
    maybeFlushFiles();
  }, 0);
}
function settleUndo(commitDelete) {
  if (!undoPending) { hideUndoToast(); return; }
  const u = undoPending;
  undoPending = null;
  clearTimeout(undoTimer);
  hideUndoToast();
  commitDelete ? u.perform() : u.restore();
  flushAfterUndo();
}
function startUndoWindow({ lane, perform, restore, msg }) {
  settleUndo(true);
  const toast = $('#undo-toast');
  if (!toast) { perform(); return; }
  attachPhoneSwipeDismiss(toast, () => settleUndo(true), {
    allowUp: false,
    allowDown: true,
    onHoldStart: () => clearTimeout(undoTimer),
    onHoldEnd: () => {
      if (undoPending) undoTimer = setTimeout(() => settleUndo(true), 3500);
    },
  });
  undoPending = { lane, perform, restore };
  $('#undo-toast-msg').textContent = msg;
  const bar = toast.querySelector('.undo-bar');
  if (bar) {
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = '';
    bar.style.animationDuration = UNDO_MS + 'ms';
  }
  $('#undo-toast-btn').onclick = () => { settleUndo(false); flash('Restored ✓'); };
  toast.classList.remove('swiping', 'hidden');
  toast.style.transform = '';
  toast.style.opacity = '';
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => settleUndo(true), UNDO_MS);
}
function flushPendingLists() {
  maybeFlushTexts();
  maybeFlushFiles();
}
async function deletePcText(id) {
  if (id == null) return;
  dismissChipHint();
  try {
    const r = await fetch(`${SERVER}/api/text/${encodeURIComponent(id)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw 0;
    flash('Removed from PC');
  } catch {
    flash('Delete failed — offline?');
    loadTexts();
  }
}
function attachChipSwipe(el, { msg, perform, lane = '#text-in', chipSel = '.text-chip' }) {
  let x0 = 0, y0 = 0, dy = 0, axis = null, raf = 0;
  const CHIP_Y_MAX = 30;
  const paint = () => {
    raf = 0;
    const p = Math.min(1, dy / CHIP_DEL_PX);
    el.style.setProperty('--del', p.toFixed(3));
    el.style.transform = `translateY(${Math.min(CHIP_Y_MAX, dy * (CHIP_Y_MAX / CHIP_DEL_PX)).toFixed(1)}px) scale(${(1 - 0.035 * p).toFixed(3)})`;
    el.style.opacity = p > 0.75 ? (1 - (p - 0.75) / 0.25 * 0.45).toFixed(3) : '1';
  };
  const stop = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    chipSwiping = false;
    el.classList.remove('swiping');
    $(lane)?.classList.remove('swiping');
    axis = null;
  };
  const spring = () => {
    el.classList.add('snap');
    el.style.transform = '';
    el.style.opacity = '';
    el.style.removeProperty('--del');
    const clear = () => el.classList.remove('snap');
    el.addEventListener('transitionend', clear, { once: true });
    setTimeout(clear, 260);
  };
  let cancelDrop = null;
  const commit = () => {
    el.classList.add('deleting');
    let gone = false;
    const drop = () => {
      if (gone) return;
      gone = true;
      el.remove();
      const box = $(lane);
      if (box && !box.querySelector(chipSel)) box.classList.add('hidden');
    };
    el.addEventListener('animationend', drop, { once: true });
    const timer = setTimeout(drop, 340);
    cancelDrop = () => {
      gone = true;
      clearTimeout(timer);
      el.removeEventListener('animationend', drop);
    };
  };
  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; dy = 0; axis = null;
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - x0;
    const raw = t.clientY - y0;
    if (!axis) {
      if (Math.abs(dx) < CHIP_AXIS_PX && Math.abs(raw) < CHIP_AXIS_PX) return;
      axis = raw > 0 && raw > Math.abs(dx) * 1.2 ? 'v' : 'x';
      if (axis === 'v') {
        const box = $(lane);
        if (box && box.scrollTop > 0 && box.scrollHeight > box.clientHeight) axis = 'x';
      }
      if (axis === 'x') return;
      dismissChipHint();
      chipSwiping = true;
      el.classList.remove('snap');
      el.classList.remove('chip-new');
      el.classList.add('swiping');
      $(lane)?.classList.add('swiping');
    }
    if (axis !== 'v') return;
    e.preventDefault();
    dy = raw > CHIP_DEL_PX ? CHIP_DEL_PX + (raw - CHIP_DEL_PX) * 0.25 : Math.max(0, raw);
    if (!raf) raf = requestAnimationFrame(paint);
  }, { passive: false });
  const runDelete = () => {
    dismissChipHint();
    const box = $(lane);
    const next = el.nextSibling;
    commit();
    startUndoWindow({
      lane, perform, msg,
      restore: () => {
        if (cancelDrop) { cancelDrop(); cancelDrop = null; }
        el.classList.remove('deleting', 'snap', 'swiping');
        el.style.transform = '';
        el.style.opacity = '';
        el.style.removeProperty('--del');
        if (box && box.isConnected) {
          box.insertBefore(el, next && next.isConnected ? next : null);
          box.classList.remove('hidden');
        }
      },
    });
  };
  el.addEventListener('keydown', e => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (el.classList.contains('deleting')) return;
    e.preventDefault();
    runDelete();
  });
  const end = () => {
    if (axis !== 'v') { stop(); flushPendingLists(); return; }
    const armed = dy >= CHIP_DEL_PX;
    if (armed) el.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); }, { capture: true, once: true });
    stop();
    if (!armed) { spring(); flushPendingLists(); return; }
    runDelete();
  };
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', () => { if (axis === 'v') spring(); stop(); flushPendingLists(); });
}

const chipTimestamp = PPShared.parseUtcMs;
const chipHHMM = PPShared.fmtClock;
function markChipNew(el) {
  el.classList.add('chip-new');
  setTimeout(() => el.classList.remove('chip-new'), 240);
}
function chipA11y(d, label) {
  d.setAttribute('role', 'button');
  d.tabIndex = 0;
  d.setAttribute('aria-label', label);
  d.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.click(); } };
}
function buildTextChip(t, seenFiles) {
  const d = document.createElement('div');
  d.className = 'text-chip';
  d.dataset.id = t.id != null ? String(t.id) : '';
  const when = document.createElement('span');
  when.className = 'chip-when';
  when.textContent = chipHHMM(t.created_at);
  const media = t.body.match(/^https?:\/\/[^/]+\/media\/([^/?#]+)$/i);
  if (media && !seenFiles.has(media[1])) {
    seenFiles.add(media[1]);
    const file = decodeURIComponent(media[1]);
    if (deadPcMedia.has(file)) return null;
    const item = pcMediaFor(file, `${location.origin}/media/${encodeURIComponent(file)}`, t.created_at);
    d.classList.add('media-chip');
    const img = document.createElement('img');
    img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    const thumbUrl = () => `${location.origin}/media/t-${encodeURIComponent(file)}`;
    img.src = thumbUrl();
    let thumbTries = 0;
    img.onerror = () => {
      if (thumbTries < 12) {
        thumbTries++;
        setTimeout(() => { img.src = thumbUrl(); }, Math.min(5000, 400 * thumbTries));
        return;
      }
      const ph = document.createElement('span');
      ph.className = 'chip-thumb-missing'; img.replaceWith(ph);
    };
    const meta = document.createElement('span');
    meta.className = 'chip-meta';
    const title = document.createElement('span');
    title.className = 'chip-title';
    title.textContent = 'Capture';
    when.className = 'chip-sub';
    meta.append(title, when);
    const badge = document.createElement('span');
    badge.className = 'chip-badge pc';
    badge.title = 'Sent from your PC';
    const badgeIc = document.createElement('i');
    badgeIc.className = 'ic ic-pc';
    badgeIc.setAttribute('aria-hidden', 'true');
    badge.append(badgeIc, document.createTextNode('PC'));
    d.title = 'Tap to preview';
    chipA11y(d, 'Capture from PC — open preview');
    d.append(img, meta, badge);
    d.onclick = () => openViewerRemote(item);
  } else if (media) {
    return null;
  } else {
    const body = document.createElement('span');
    body.textContent = t.body;
    if (/^https?:\/\/\S+$/i.test(t.body)) {
      body.classList.add('chip-url');
      d.title = 'Tap to open · long-press to copy';
      chipA11y(d, `Link from PC: ${t.body} — open`);
      d.onclick = () => { flash('Opening…'); window.open(t.body, '_blank', 'noopener'); };
    } else {
      d.title = `Tap to copy — ${t.body}`;
      chipA11y(d, `Text from PC: ${t.body} — copy`);
      d.onclick = () => tapCopyText(t.body, d);
    }
    d.append(body, when);
  }
  if (t.id != null) attachChipSwipe(d, {
    msg: d.classList.contains('media-chip') ? 'Capture removed' : 'Text removed',
    perform: () => deletePcText(t.id),
  });
  stampSort(d, {
    ts: chipTimestamp(t.created_at),
    name: media ? decodeURIComponent(media[1]) : t.body,
    seq: t.id,
  });
  markChipNew(d);
  return d;
}

let textRenderSignature = '';

// ---------- sort order (Phone ▸ More ▸ Sort) ----------
const SORT_KEY = 'pp_phone_sort';
const SORT_MODES = ['new', 'old', 'name'];
let sortMode = 'new';
try {
  const saved = localStorage.getItem(SORT_KEY);
  if (SORT_MODES.includes(saved)) sortMode = saved;
} catch {}

function stampSort(el, { ts, name, seq }) {
  el.dataset.sortTs = String(ts || 0);
  el.dataset.sortSeq = String(seq == null ? 0 : seq);
  el.dataset.sortName = String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return el;
}
function sortComparator(a, b) {
  const an = a.dataset.sortName || '', bn = b.dataset.sortName || '';
  const at = Number(a.dataset.sortTs) || 0, bt = Number(b.dataset.sortTs) || 0;
  const as = Number(a.dataset.sortSeq) || 0, bs = Number(b.dataset.sortSeq) || 0;
  const bySeq = (x, y) => (sortMode === 'old' ? x - y : y - x);
  if (sortMode === 'old') return at - bt || bySeq(as, bs);
  if (sortMode === 'name') {
    if (!an && bn) return 1;
    if (an && !bn) return -1;
    return an.localeCompare(bn) || bt - at || bySeq(as, bs);
  }
  return bt - at || bySeq(as, bs);
}
function applySort(box) {
  if (!box || box.children.length < 2) return;
  const desired = [...box.children].sort(sortComparator);
  const current = [...box.children];
  if (desired.every((el, i) => el === current[i])) return;
  box.replaceChildren(...desired);
}
function applySortAll() {
  applySort($('#recent'));
  applySort($('#text-in'));
  applySort($('#files'));
}
function sortUI() {
  for (const btn of document.querySelectorAll('.sort-opt')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.sort === sortMode));
  }
}
for (const btn of document.querySelectorAll('.sort-opt')) {
  btn.onclick = () => {
    if (!SORT_MODES.includes(btn.dataset.sort) || btn.dataset.sort === sortMode) return;
    sortMode = btn.dataset.sort;
    try { localStorage.setItem(SORT_KEY, sortMode); } catch {}
    sortUI();
    applySortAll();
  };
}
sortUI();
async function loadTexts() {
  if (chipSwiping || (undoPending && undoPending.lane === '#text-in')) { textsDirty = true; return; }
  try {
    const SHOW = 20;
    const list = await fetch(`${SERVER}/api/text?source=pc&limit=50`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
    const box = $('#text-in');
    const shown = box.dataset.all === '1' ? list : list.slice(0, SHOW);
    const older = list.length - SHOW;
    const more = $('#text-load-more');
    if (more) more.classList.toggle('hidden', !(older > 0 && box.dataset.all !== '1'));
    const signature = `${box.dataset.all === '1' ? 'all' : 'recent'}|${shown.map(t => `${t.id}:${t.body}:${t.created_at || ''}`).join('|')}`;
    if (signature === textRenderSignature) return;
    textRenderSignature = signature;
    if (!list.length) {
      box.replaceChildren();
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const existing = new Map([...box.querySelectorAll('.text-chip')]
      .map(el => [el.dataset.renderKey || el.dataset.id, el]));
    const desired = [];
    const keep = new Set();
    const seenFiles = new Set();
    for (const t of shown) {
      const renderKey = `${t.id}|${t.body}|${t.created_at || ''}`;
      let d = existing.get(renderKey);
      const media = t.body.match(/^https?:\/\/[^/]+\/media\/([^/?#]+)$/i);
      if (media) {
        if (seenFiles.has(media[1])) continue;
        const file = decodeURIComponent(media[1]);
        if (deadPcMedia.has(file)) { seenFiles.add(media[1]); continue; }
        if (d) seenFiles.add(media[1]);
      }
      if (!d) d = buildTextChip(t, seenFiles);
      if (!d) continue;
      d.dataset.renderKey = renderKey;
      desired.push(d);
      keep.add(d);
    }
    for (const child of existing.values()) if (!keep.has(child)) child.remove();
    if (sortMode !== 'new') desired.sort(sortComparator);
    box.replaceChildren(...desired);
  } catch { textRenderSignature = ''; $('#text-in').classList.add('hidden'); $('#text-load-more')?.classList.add('hidden'); }
}
const textLoadMore = $('#text-load-more');
if (textLoadMore) textLoadMore.onclick = () => {
  $('#text-in').dataset.all = '1';
  loadTexts();
};
async function sendText() {
  const body = $('#text-input').value.trim();
  if (!body) return;
  const sendBtn = $('#text-send');
  if (sendBtn) {
    sendBtn.classList.remove('is-sending');
    void sendBtn.offsetWidth;
    sendBtn.classList.add('is-sending');
    setTimeout(() => sendBtn.classList.remove('is-sending'), 480);
  }
  try {
    const r = await fetch(`${SERVER}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, source: 'phone' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw 0;
    resetComposerField();
    flash('Sent to PC ✓');
  } catch {
    const q = textQueue();
    q.push({ body, ts: Date.now() });
    setTextQueue(q);
    resetComposerField();
    flash('Offline — text queued, sends automatically');
  }
}
function syncComposerState() {
  const input = $('#text-input');
  const row = document.querySelector('.text-row');
  if (row && input) row.classList.toggle('has-text', input.value.trim().length > 0);
  const val = input ? input.value : '';
  const trimmed = val.trim();
  const countEl = $('#text-char-count');
  if (countEl) {
    countEl.textContent = `${val.length.toLocaleString()} / 10,000`;
    countEl.classList.toggle('warn', val.length > 9500);
  }
  const urlBadge = $('#text-url-badge');
  if (urlBadge) {
    urlBadge.classList.toggle('hidden', !/^https?:\/\/\S+$/i.test(trimmed));
  }
}
const textModeBtn = $('#text-mode-btn');
const textModeClose = $('#text-mode-close');
function setTextMode(open) {
  document.body.classList.toggle('text-mode', open);
  textModeBtn?.setAttribute('aria-expanded', String(open));
  const input = $('#text-input');
  if (open) {
    if (moreMenu.classList.contains('open')) setMenu(false);
    if (input) {
      input.style.height = '';
      requestAnimationFrame(() => input.focus());
    }
  } else if (input) {
    input.blur();
  }
  syncOverlayHistory();
}
if (textModeBtn) {
  textModeBtn.onclick = () => setTextMode(!document.body.classList.contains('text-mode'));
}
if (textModeClose) {
  textModeClose.onclick = () => setTextMode(false);
}
function resetComposerField() {
  const input = $('#text-input');
  input.value = '';
  if (input.classList.contains('expanded')) {
    input.classList.remove('expanded');
    $('#text-expand')?.setAttribute('aria-expanded', 'false');
  }
  syncComposerState();
  autoGrowText();
  if (document.body.classList.contains('text-mode')) setTextMode(false);
}
$('#text-send').onclick = sendText;
$('#text-input').addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendText(); return; }
  if (e.key === 'Enter' && !e.shiftKey && $('#text-input').classList.contains('expanded')) return;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});
const TEXT_AUTOGROW_MAX = 150;
let textResizeRaf = 0;
function autoGrowText() {
  if (textResizeRaf) return;
  textResizeRaf = requestAnimationFrame(() => {
    textResizeRaf = 0;
    const input = $('#text-input');
    if (document.body.classList.contains('kb-open') || document.body.classList.contains('text-mode')) { input.style.height = ''; return; }
    input.style.height = 'auto';
    input.style.height = Math.min(TEXT_AUTOGROW_MAX, Math.max(40, input.scrollHeight)) + 'px';
  });
}
$('#text-expand').addEventListener('pointerdown', e => e.preventDefault());
$('#text-expand').onclick = () => {
  const input = $('#text-input');
  const expanded = input.classList.toggle('expanded');
  if (expanded) {
    input.style.height = '';
    if (textResizeRaf) { cancelAnimationFrame(textResizeRaf); textResizeRaf = 0; }
  } else autoGrowText();
  $('#text-expand').setAttribute('aria-expanded', String(expanded));
  if (expanded) input.focus();
};
$('#text-input').addEventListener('input', () => {
  syncComposerState();
  if ($('#text-input').classList.contains('expanded')) return;
  autoGrowText();
});
$('#text-paste-send')?.addEventListener('click', async () => {
  try {
    if (!navigator.clipboard?.readText) throw new Error('unavailable');
    const clip = (await navigator.clipboard.readText()) || '';
    const body = clip.trim().slice(0, 10000);
    if (!body) { flash('Clipboard is empty'); return; }
    $('#text-input').value = body;
    syncComposerState();
    await sendText();
  } catch {
    flash('Clipboard read blocked — paste manually into the box');
  }
});

// ---------- share target: Android "Share → ProofPipe" lands here ----------
const shareParams = new URLSearchParams(location.search);
if (shareParams.get('shared') === '1') {
  history.replaceState(null, '', '/phone');
  setTimeout(() => flash('Shared to PC ✓'), 600);
  setTimeout(loadTexts, 400);
} else if (shareParams.get('shared') === 'error') {
  history.replaceState(null, '', '/phone');
  setTimeout(() => flash('Share failed on the PC — try again'), 600);
}

// ---------- settings toggles ----------
$('#autopaste').onclick = async () => {
  autoPaste = !autoPaste;
  autoPasteUI();
  try { localStorage.setItem(AP_KEY, autoPaste ? '1' : '0'); } catch {}
  try {
    const r = await fetch(`${SERVER}/api/autopaste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto: autoPaste }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw 0;
    flash(autoPaste ? 'Auto-paste on — photos land in your last chat ✓' : 'Auto-paste off — drag from the tray ✓');
  } catch {
    flash(autoPaste ? 'Set locally — syncs with PC when back online' : 'Auto-paste off ✓');
  }
};
$('#autocleanup').onclick = async () => {
  const b = $('#autocleanup');
  const next = b.getAttribute('aria-checked') !== 'true';
  b.setAttribute('aria-checked', String(next));
  try {
    const r = await fetch(`${SERVER}/api/autocleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: next }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw 0;
    flash(next ? 'Auto-cleanup on — oldest drop at 80%' : 'Auto-cleanup off');
  } catch {
    flash('Could not save — check the connection');
    loadSettings();
  }
};
function applyQualityPayload(s) {
  if (!s) return;
  settings.qualityReduce = s.on === true;
  settings.qualityLevel = Math.min(100, Math.max(1, Math.round(Number(s.level) || 80)));
  const mp = Math.round(Number(s.maxPixels));
  if (Number.isFinite(mp) && mp > 0) settings.maxPixels = mp;
  saveQualityLocal();
}
function tooManyPixelsMsg() {
  const mp = settings.maxPixels > 0 ? ` (over ${Math.round(settings.maxPixels / 1e6)}MP)` : '';
  return `Too big for the PC${mp} — turn on Reduce image quality to send it`;
}
async function loadQuality() {
  try {
    const r = await fetch(`${SERVER}/api/quality`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return;
    applyQualityPayload(await r.json());
  } catch {}
  qualityUI();
}
function qualityUI() {
  $('#quality-toggle').setAttribute('aria-checked', String(settings.qualityReduce === true));
  $('#quality-level').value = String(settings.qualityLevel);
  $('#quality-level-val').textContent = String(settings.qualityLevel);
  $('#quality-level-row').classList.toggle('hidden', !settings.qualityReduce);
}
$('#quality-toggle').onclick = async () => {
  const next = $('#quality-toggle').getAttribute('aria-checked') !== 'true';
  $('#quality-toggle').setAttribute('aria-checked', String(next));
  $('#quality-level-row').classList.toggle('hidden', !next);
  try {
    const r = await fetch(`${SERVER}/api/quality`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: next, level: settings.qualityLevel }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw 0;
    const s = await r.json();
    applyQualityPayload(s);
    flash(next ? `Quality reduction on — level ${s.level}` : 'Quality reduction off — full quality');
  } catch {
    flash('Could not save — check the connection');
    loadQuality();
  }
};
let qualitySaveTimer = null;
$('#quality-level').addEventListener('input', e => {
  settings.qualityLevel = Math.min(100, Math.max(1, Math.round(Number(e.target.value) || 80)));
  $('#quality-level-val').textContent = String(settings.qualityLevel);
  clearTimeout(qualitySaveTimer);
  qualitySaveTimer = setTimeout(async () => {
    try {
      const r = await fetch(`${SERVER}/api/quality`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: settings.qualityReduce, level: settings.qualityLevel }),
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) applyQualityPayload(await r.json());
    } catch {}
  }, 400);
});
function applyServerSettings(s) {
  if (!s) return;
  if (s.autoPaste) {
    autoPaste = s.autoPaste.auto === true;
    autoPasteUI();
    try { localStorage.setItem(AP_KEY, autoPaste ? '1' : '0'); } catch {}
  }
  if (s.autoCleanup) {
    $('#autocleanup').setAttribute('aria-checked', String(s.autoCleanup.on === true));
    if (s.autoCleanup.cap) $('#autocleanup-sub').textContent = `drops oldest captures past 80% of ${fmtBytes(s.autoCleanup.cap)}`;
  }
  if (s.quality) {
    applyQualityPayload(s.quality);
    qualityUI();
  }
}
async function loadSettings() {
  try {
    const r = await fetch(`${SERVER}/api/settings`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) { applyServerSettings(await r.json()); return; }
  } catch {}
  try { autoPaste = localStorage.getItem(AP_KEY) === '1'; } catch {}
  autoPasteUI();
  qualityUI();
}

// ---------- Extracted modules: fullscreen viewer + file transfers ----------
const viewer = PPPhoneViewer.create({
  $,
  SERVER,
  flash,
  phoneConfirm,
  trapPhone,
  untrapPhone,
  syncOverlayHistory,
  confirmOpen,
  getRecentItems: () => recentItems,
  outboxDelete,
  outboxUpdateBlob,
  regenerateTileUrl,
  retryItem,
  recentEmptyUI,
  revokeObjectUrl,
  pcMediaItems,
  markDeadPcMedia,
  reloadTexts: () => { textRenderSignature = ''; loadTexts(); },
});
const openViewer = item => viewer.openViewer(item);
const openViewerRemote = item => viewer.openViewerRemote(item);
const hideViewer = () => viewer.hideViewer();

const phoneFiles = PPPhoneFiles.create({
  $,
  SERVER,
  PPQueue,
  PPShared,
  flash,
  trapPhone,
  untrapPhone,
  syncOverlayHistory,
  confirmOpen,
  transferBegin,
  transferProgress,
  transferEnd,
  setTransferBatchRemaining: n => { transferBatchRemaining = n; },
  transferBatchSize,
  transferA11yName: transferA11y,
  getSortMode: () => sortMode,
  applySort,
  stampSort,
  chipA11y,
  attachChipSwipe,
  markChipNew,
  dismissChipHint,
  getChipSwiping: () => chipSwiping,
  setFilesDirty: v => { filesDirty = v; },
  getUndoLane: () => undoPending && undoPending.lane,
  chipHHMM,
  chipTimestamp,
});
const xferFiles = phoneFiles.xferFiles;
const fqueueCount = () => phoneFiles.fqueueCount();
const flushFileQueue = () => phoneFiles.flushFileQueue();
const loadFiles = (...a) => phoneFiles.loadFiles(...a);
const renderFiles = (...a) => phoneFiles.renderFiles(...a);

// ---------- unified inbox visibility + strip edge fades ----------
function updateInbox() {
  const box = $('#inbox'), ti = $('#text-in'), fl = $('#files');
  if (!box || !ti || !fl) return;
  const hasText = !ti.classList.contains('hidden') && ti.childElementCount > 0;
  const hasFiles = !fl.classList.contains('hidden') && fl.childElementCount > 0;
  box.classList.toggle('hidden', !(hasText || hasFiles));
  const hint = $('#chip-hint');
  if (hint) {
    hint.classList.toggle('hidden',
      localStorage.pp_chip_hint === '1' || !(hasText || hasFiles));
  }
  syncStripEdges();
}
const stripEdgeSyncs = [];
function trackStripEdges(el) {
  if (!el) return;
  const sync = () => {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle('at-start', el.scrollLeft <= 1);
    el.classList.toggle('at-end', max <= 1 || el.scrollLeft >= max - 1);
  };
  el.addEventListener('scroll', sync, { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(sync).observe(el);
  stripEdgeSyncs.push(sync);
  sync();
}
function syncStripEdges() { for (const sync of stripEdgeSyncs) sync(); }
trackStripEdges($('#text-in'));
trackStripEdges($('#files'));
if ('MutationObserver' in window) {
  const inboxObserver = new MutationObserver(updateInbox);
  for (const sel of ['#text-in', '#files']) {
    const el = $(sel);
    if (el) inboxObserver.observe(el, { childList: true, attributes: true, attributeFilter: ['class'] });
  }
}
updateInbox();

// ---------- live updates from PC (paste/drop/text uploads) ----------
try {
  let sseHadDrop = false;
  const es = new EventSource(SERVER + '/events?device=phone');
  es.onopen = () => {
    const shouldReload = sseHadDrop || !$('#recent-error')?.classList.contains('hidden');
    sseLive = true;
    everConnected = true;
    sseHadDrop = false;
    setStatus('ok', 'connected');
    if (shouldReload) loadRecent();
  };
  es.onerror = () => {
    if (sseLive || everConnected) sseHadDrop = true;
    sseLive = false;
    if (everConnected) setStatus('warn', 'reconnecting…');
    else { setStatus('off', 'not paired'); setStatusSub('scan the QR on your PC · same Wi-Fi'); }
  };
  es.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { m = { type: e.data }; }
    if ((m.type === 'capture-ready' || m.type === 'capture') && m.capture?.file) {
      addRemoteRecent(m.capture, { live: true });
      if (m.capture.origin === 'pc') {
        textRenderSignature = '';
        loadTexts();
        if (m.type === 'capture-ready') flash('New capture from PC');
      }
      recentEmptyUI();
      scheduleTotalBytes();
    }
    if (m.type === 'file' && m.row && m.row.id != null) {
      phoneFiles.bumpVersion(m.row.id);
      xferFiles.unshift(m.row);
      if (phoneFiles.undoIsFile()) filesDirty = true; else renderFiles(xferFiles);
      if (m.row.dir === 'pc') flash(`${m.row.name} — from your PC`);
    }
    const goneIds = m.type === 'file-deleted'
      ? (Array.isArray(m.ids) && m.ids.length ? m.ids : (m.id != null ? [m.id] : null))
      : null;
    if (goneIds) {
      const gone = new Set(goneIds.map(Number));
      const next = xferFiles.filter(f => !gone.has(Number(f.id)));
      if (phoneFiles.undoIsFile()) filesDirty = true; else renderFiles(next);
    } else if (m.type === 'file-deleted') {
      // A payload-less sweep event; reconcile once.
      loadFiles(true);
    }
    if (m.type === 'capture' || m.type === 'capture-ready') {
      recentVersion = Math.max(recentVersion, Number(m.capture.id) || 0);
    }
    if (m.type === 'capture-updated' && m.capture?.id != null) {
      const existing = recentItems.find(i => i.id === m.capture.id);
      if (existing) {
        existing.file = m.capture.file;
        existing.url = `${SERVER}/media/${encodeURIComponent(m.capture.file)}`;
        existing.thumbUrl = `${SERVER}/media/t-${encodeURIComponent(m.capture.file)}`;
        revokeObjectUrl(existing.fullUrl);
        existing.fullUrl = null;
        if (existing.img) existing.img.src = existing.thumbUrl;
      } else {
        addRemoteRecent(m.capture);
      }
      scheduleTotalBytes();
    }
    if (m.type === 'deleted') {
      if (Array.isArray(m.ids) && m.ids.length) {
        const drop = new Set(m.ids.map(Number));
        for (const item of [...recentItems]) {
          if (item.id != null && drop.has(Number(item.id))) removeRecentItem(item);
        }
        recentEmptyUI();
      } else {
        loadRecent(true);
      }
      scheduleTotalBytes();
    }
    if (m.type === 'text') loadTexts();
    if (m.type === 'settings') {
      applyServerSettings(m);
    }
  };
} catch {}

// ---------- more menu (keeps destructive actions tucked away) ----------
const moreBtn = $('#more-btn'), moreMenu = $('#more-menu');
function setMenu(open) {
  moreMenu.classList.toggle('open', open);
  moreBtn.setAttribute('aria-expanded', String(open));
  if (open) syncMenuEdges();
  syncOverlayHistory();
}
function syncMenuEdges() {
  const m = moreMenu;
  m.classList.toggle('at-bottom', m.scrollTop + m.clientHeight >= m.scrollHeight - 1);
}
moreMenu.addEventListener('scroll', syncMenuEdges, { passive: true });
new ResizeObserver(syncMenuEdges).observe(moreMenu);
window.addEventListener('resize', syncMenuEdges);
moreBtn.onclick = () => setMenu(!moreMenu.classList.contains('open'));
document.addEventListener('click', e => {
  if (!moreMenu.classList.contains('open')) return;
  if (e.target.closest('.more-wrap')) return;
  setMenu(false);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || confirmOpen()) return;
  if (moreMenu.classList.contains('open')) {
    setMenu(false);
    moreBtn.focus();
    return;
  }
  if (document.body.classList.contains('text-mode')) {
    setTextMode(false);
    textModeBtn?.focus();
  }
});
moreMenu.addEventListener('click', e => { if (e.target.closest('.alt-btn')) setMenu(false); });

// ---------- Android Back closes the topmost overlay instead of the PWA ----------
function overlayOpen() {
  return confirmOpen()
    || viewer.isOpen()
    || !$('#file-sheet').classList.contains('hidden')
    || document.body.classList.contains('text-mode')
    || moreMenu.classList.contains('open');
}
function closeTopOverlay() {
  if (confirmOpen()) { closeConfirm(false); return; }
  if (viewer.isOpen()) { hideViewer(); return; }
  if (!$('#file-sheet').classList.contains('hidden')) { phoneFiles.closeFileSheet(); return; }
  if (document.body.classList.contains('text-mode')) { setTextMode(false); return; }
  if (moreMenu.classList.contains('open')) setMenu(false);
}
let overlayGuardBusy = false;
function syncOverlayHistory() {
  if (overlayGuardBusy) return;
  if (overlayOpen()) {
    if (!history.state?.ppOverlay) history.pushState({ ppOverlay: true }, '');
  } else if (history.state?.ppOverlay) {
    overlayGuardBusy = true;
    history.back();
    addEventListener('popstate', () => { overlayGuardBusy = false; }, { once: true });
    setTimeout(() => { overlayGuardBusy = false; }, 500);
  }
}
addEventListener('popstate', () => {
  if (overlayOpen()) {
    closeTopOverlay();
    if (overlayOpen() && !history.state?.ppOverlay) history.pushState({ ppOverlay: true }, '');
  }
});

// ---------- recent grid empty state + library totals ----------
let totalBytes = 0;
let totalCount = 0;
async function refreshTotalBytes() {
  try {
    const r = await fetch(`${SERVER}/api/stats`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const s = await r.json();
      totalBytes = s.bytes || 0;
      totalCount = s.count || 0;
    }
  } catch {}
  recentEmptyUI();
}
let bytesTimer = null;
function scheduleTotalBytes() {
  clearTimeout(bytesTimer);
  bytesTimer = setTimeout(refreshTotalBytes, 600);
}
function recentEmptyUI() {
  const count = recentItems.length;
  const failed = !$('#recent-error')?.classList.contains('hidden');
  $('#recent-empty').classList.toggle('hidden', count > 0 || !recentLoaded || failed);
  const countEl = $('#recent-count');
  if (countEl) {
    if (!recentLoaded) countEl.textContent = '…';
    else {
      const parts = [];
      const shown = Math.max(totalCount, count);
      if (shown) parts.push(`${shown} capture${shown === 1 ? '' : 's'}`);
      if (shown && totalBytes > 0) parts.push(fmtBytes(totalBytes));
      countEl.textContent = parts.join(' · ');
    }
  }
  const cr = $('#clear-recent');
  if (cr) cr.classList.toggle('hidden', $('#recent').children.length === 0);
  if (selectMode && recentItems.length === 0) setSelectMode(false);
  else syncBatchUI();
  statusDetail();
}
new MutationObserver(recentEmptyUI).observe($('#recent'), { childList: true });
refreshTotalBytes();

// ---------- batch selection controls ----------
$('#select-toggle')?.addEventListener('click', () => setSelectMode(!selectMode));
$('#batch-done')?.addEventListener('click', () => setSelectMode(false));
$('#batch-all')?.addEventListener('click', () => {
  const selectAll = selectedTiles.size < recentItems.length;
  for (const tile of recentItems) {
    if (selectAll) {
      selectedTiles.add(tile);
      tile.el.classList.add('selected');
      tile.el.setAttribute('aria-pressed', 'true');
    } else {
      selectedTiles.delete(tile);
      tile.el.classList.remove('selected');
      tile.el.setAttribute('aria-pressed', 'false');
    }
  }
  syncBatchUI();
});
$('#batch-retry')?.addEventListener('click', async () => {
  const queued = [...selectedTiles].filter(t => !t.sent);
  if (!queued.length) return;
  setSelectMode(false);
  for (const tile of queued) await retryItem(tile);
});
$('#batch-delete')?.addEventListener('click', async () => {
  const picked = [...selectedTiles];
  if (!picked.length) return;
  if (!await phoneConfirm({
    title: `Delete ${picked.length} selected capture${picked.length === 1 ? '' : 's'}?`,
    body: 'Uploaded captures will be permanently removed from the PC.',
    ok: 'Delete Selected',
  })) return;
  const localOnly = picked.filter(t => !t.sent || t.id == null);
  const remoteIds = picked.filter(t => t.sent && t.id != null).map(t => Number(t.id));
  for (const t of localOnly) {
    if (t.outboxKey != null) await outboxDelete(t.outboxKey);
    t.outboxKey = null;
    removeRecentItem(t);
  }
  if (remoteIds.length) {
    try {
      const r = await fetch(`${SERVER}/api/captures`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: remoteIds }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw 0;
      const drop = new Set(remoteIds);
      for (const t of picked) {
        if (t.id != null && drop.has(Number(t.id))) removeRecentItem(t);
      }
      scheduleTotalBytes();
    } catch {
      flash('Delete failed — offline?');
      recentEmptyUI();
      return;
    }
  }
  setSelectMode(false);
  recentEmptyUI();
  flash(`Removed ${picked.length} capture${picked.length === 1 ? '' : 's'} ✓`);
});

// ---------- phone-side cleanup ----------
$('#clear-recent').onclick = async () => {
  const atRisk = recentItems.filter(i => !i.sent && i.outboxKey == null).length;
  const unsent = recentItems.filter(i => !i.sent).length;
  if (atRisk > 0 && !await phoneConfirm({
    title: `${atRisk} photo(s) were never sent and are not queued offline`,
    body: 'Clearing the strip loses them for good.',
    ok: 'Clear',
  })) return;
  for (const item of [...recentItems]) {
    if (viewer.hasItem(item) || viewer.hasBlob(item.blob)) hideViewer();
    item.el.remove();
    revokeObjectUrl(item.tileUrl);
    revokeObjectUrl(item.url);
    revokeObjectUrl(item.fullUrl);
  }
  recentItems.length = 0;
  recentEmptyUI();
  flash(unsent && !atRisk ? `Cleared — ${unsent} queued photo(s) still sync` : 'Recent cleared');
};
$('#clear-outbox').onclick = async () => {
  const n = await outboxCount();
  if (!n) return;
  if (!await phoneConfirm({
    title: `Clear all ${n} queued photo(s)?`,
    body: 'They will NOT be uploaded.',
    ok: 'Clear queue',
  })) return;
  await outboxClear();
  flash('Queue cleared');
};
$('#clear-pc').onclick = async () => {
  if (!pcMediaItems.length) { flash('Nothing to clear'); return; }
  if (!await phoneConfirm({
    title: 'Clear all PC-sent captures?',
    body: 'They are removed from this phone and from the PC history.',
    ok: 'Clear',
  })) return;
  try {
    const r = await fetch(`${SERVER}/api/text?source=pc`, { method: 'DELETE', signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw 0;
  } catch { flash('Server unreachable — cleared locally only'); }
  for (const item of pcMediaItems) {
    if (viewer.hasItem(item) || viewer.hasBlob(item.blob)) hideViewer();
    if (item.blob && item.fullUrl) URL.revokeObjectURL(item.fullUrl);
  }
  pcMediaItems.length = 0;
  const box = $('#text-in');
  box.innerHTML = '';
  box.classList.add('hidden');
  delete box.dataset.all;
  $('#text-load-more')?.classList.add('hidden');
  flash('PC captures cleared');
};
$('#del-all').onclick = async () => {
  let n = 0;
  let counted = true;
  try { n = (await fetch(`${SERVER}/api/captures/version`, { signal: AbortSignal.timeout(5000) }).then(r => r.json())).n; }
  catch { counted = false; }
  if (counted && !n) { flash('Nothing to delete'); return; }
  if (!await phoneConfirm({
    title: counted ? `Delete ALL ${n} capture(s) on the PC?` : 'Could not count your captures on the PC. Delete EVERYTHING anyway?',
    body: 'This cannot be undone.',
    ok: 'Delete all',
  })) return;
  try {
    const r = await fetch(`${SERVER}/api/captures`, { method: 'DELETE', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw 0;
    const body = await r.json();
    flash(`Deleted ${body.deleted} on PC ✓`);
  } catch { flash('Delete failed — offline?'); }
};

// ---------- outbox: tap the counter to RETRY ----------
$('#outbox-info').onclick = async () => {
  flash('Retrying queued items…');
  await checkServer();
  const left = await outboxCount().catch(() => 0);
  flash(left ? `Still queued: ${left} photo${left === 1 ? '' : 's'}` : 'Queue synced ✓');
};

// ---------- keyboard mode ----------
(() => {
  const vv = window.visualViewport;
  if (!vv) return;
  const input = $('#text-input');
  let open = false;
  let focused = false;
  let baseline = vv.height;
  let rebaseline = 0;
  const apply = kbOpen => {
    if (kbOpen === open) return;
    open = kbOpen;
    document.body.classList.toggle('kb-open', open);
  };
  const update = () => apply(focused && vv.height < baseline * 0.85);
  const stopRebaseline = () => { if (rebaseline) { clearTimeout(rebaseline); rebaseline = 0; } };
  input.addEventListener('focus', () => {
    stopRebaseline();
    focused = true;
    update();
  });
  input.addEventListener('blur', () => {
    focused = false;
    stopRebaseline();
    rebaseline = setTimeout(() => { rebaseline = 0; baseline = vv.height; apply(false); }, 350);
  });
  vv.addEventListener('resize', () => {
    if (focused) { update(); return; }
    if (rebaseline) return;
    baseline = vv.height;
    apply(false);
  });
  update();
})();

// ---------- one-time unpoison migration ----------
async function runUnpoisonMigration() {
  let revived = 0;
  if (idb && (await outboxCount())) {
    const items = await outboxAll();
    for (const job of items) {
      const fix = PPQueue.unpoison(job.value);
      if (!fix) continue;
      await new Promise(resolve => {
        const tx = idb.transaction('outbox', 'readwrite');
        tx.objectStore('outbox').put({ ...job.value, ...fix, poisonReason: undefined }, job.key);
        tx.oncomplete = resolve; tx.onerror = resolve;
      });
      revived++;
    }
  }
  revived += await phoneFiles.unpoisonAll();
  {
    const q = textQueue().map(t => {
      const fix = PPQueue.unpoison(t);
      if (!fix) return t;
      revived++;
      return { ...t, ...fix, poisonReason: undefined };
    });
    setTextQueue(q);
  }
  if (revived) {
    await outboxUI();
    flash(`${revived} stuck photo(s)/file(s) will retry automatically`);
    checkServer();
  }
}

// ---------- boot ----------
(async () => {
  idb = await openOutbox().catch(() => null);
  await phoneFiles.initDb();
  runUnpoisonMigration().catch(() => {});
  await outboxUI();
  textQueueUI();
  recentEmptyUI();
  await loadQueuedRecent();
  await loadRecent();
  loadSettings();
  loadFiles();
  loadTexts();
  checkServer();
  let pollTimer = null;
  const FAST_POLL = 10000;
  const IDLE_POLL = 60000;
  async function hasPendingWork() {
    if (textQueue().length) return true;
    try { if (await outboxCount()) return true; } catch {}
    try { if (await fqueueCount()) return true; } catch {}
    return false;
  }
  async function pollLoop() {
    clearTimeout(pollTimer);
    if (document.hidden) { pollTimer = setTimeout(pollLoop, FAST_POLL); return; }
    try { await checkServer(); } catch {}
    const busy = sseLive ? await hasPendingWork().catch(() => true) : true;
    pollTimer = setTimeout(pollLoop, busy ? FAST_POLL : IDLE_POLL);
  }
  pollLoop();
})();

addEventListener('online', () => checkServer());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  checkServer();
  if (!sseLive) {
    loadRecent();
    loadTexts();
  }
  loadSettings();
});

function initPhoneLiquidEffects() {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) return;

  const RIPPLE_SEL = '.shutter, .alt-btn, .vbtn, .vtop-btn, .sort-opt, #text-mode-btn, #text-send, .text-paste-btn, #recent .ok-badge, .text-chip, .file-chip, #outbox-info, #undo-toast-btn, #more-btn, .cbtn, #viewer-close';

  document.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const host = e.target?.closest?.(RIPPLE_SEL);
    if (!host || host.disabled) return;
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const size = Math.max(rect.width, rect.height) * 1.9;
    const ripple = document.createElement('span');
    ripple.className = 'pp-phone-ripple';
    const x = (e.clientX || e.clientY ? e.clientX - rect.left : rect.width / 2) - size / 2;
    const y = (e.clientX || e.clientY ? e.clientY - rect.top : rect.height / 2) - size / 2;
    ripple.style.width = `${size.toFixed(0)}px`;
    ripple.style.height = `${size.toFixed(0)}px`;
    ripple.style.left = `${x.toFixed(1)}px`;
    ripple.style.top = `${y.toFixed(1)}px`;
    host.appendChild(ripple);
    const cleanup = () => ripple.remove();
    ripple.addEventListener('animationend', cleanup, { once: true });
    setTimeout(cleanup, 580);
  }, { passive: true });

  $('#viewer-rot')?.addEventListener('click', () => {
    const btn = $('#viewer-rot');
    if (!btn) return;
    btn.classList.remove('is-spinning');
    void btn.offsetWidth;
    btn.classList.add('is-spinning');
    setTimeout(() => btn.classList.remove('is-spinning'), 360);
  });

  const canvas = document.createElement('canvas');
  canvas.className = 'pp-bg-warp';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return;

  let w = 0, h = 0, dpr = 1;
  let tx = -999, ty = -999, cx = -999, cy = -999, str = 0, tStr = 0, raf = 0;
  const ripples = [];

  const drawFrame = now => {
    ctx.clearRect(0, 0, w, h);
    for (let i = ripples.length - 1; i >= 0; i--) {
      if (now - ripples[i].t0 > 900) ripples.splice(i, 1);
    }
    if (str > 0.01) {
      const rx = 240;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
      g.addColorStop(0, `rgba(100, 210, 255, ${(0.1 * str).toFixed(4)})`);
      g.addColorStop(0.55, `rgba(10, 132, 255, ${(0.045 * str).toFixed(4)})`);
      g.addColorStop(1, 'rgba(10, 132, 255, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(Math.max(0, cx - rx), Math.max(0, cy - rx), rx * 2, rx * 2);
    }
    const STEP = 42;
    const cols = Math.ceil(w / STEP) + 2;
    const rows = Math.ceil(h / STEP) + 2;
    const r2 = 170 * 170;
    const activeRipples = ripples.map(rp => {
      const age = (now - rp.t0) / 900;
      return { x: rp.x, y: rp.y, radius: age * 300, decay: (1 - age) * (1 - age) };
    });
    const pts = new Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      const gy = (r - 0.5) * STEP;
      for (let c = 0; c < cols; c++) {
        const gx = (c - 0.5) * STEP;
        let ox = 0, oy = 0, glow = 0;
        if (str > 0.01) {
          const dx = gx - cx, dy = gy - cy, d2 = dx * dx + dy * dy;
          if (d2 < r2 && d2 > 0.01) {
            const dist = Math.sqrt(d2);
            const f = Math.exp(-d2 / (90 * 90));
            const p = 20 * str * f * (1 - Math.exp(-dist / 28));
            ox += (dx / dist) * p; oy += (dy / dist) * p; glow = f * str;
          }
        }
        for (let i = 0; i < activeRipples.length; i++) {
          const rp = activeRipples[i], dx = gx - rp.x, dy = gy - rp.y, dist = Math.hypot(dx, dy);
          const band = dist - rp.radius;
          if (Math.abs(band) < 85 && dist > 1) {
            const wv = Math.cos((band / 85) * Math.PI * 0.5);
            const amp = 14 * rp.decay * wv * Math.sin(band * 0.09);
            ox += (dx / dist) * amp; oy += (dy / dist) * amp; glow = Math.max(glow, rp.decay * wv * 0.8);
          }
        }
        pts[r * cols + c] = [gx + ox, gy + oy, glow];
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(130, 195, 255, 0.045)';
    ctx.beginPath();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const p = pts[r * cols + c];
        if (c === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      }
    }
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const p = pts[r * cols + c];
        if (r === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      }
    }
    ctx.stroke();
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const p0 = pts[r * cols + c], pR = pts[r * cols + c + 1], pD = pts[(r + 1) * cols + c];
        const gm = Math.max(p0[2], pR[2], pD[2]);
        if (gm < 0.04) continue;
        ctx.strokeStyle = `rgba(130, 224, 255, ${(gm * 0.32).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(pR[0], pR[1]);
        ctx.moveTo(p0[0], p0[1]); ctx.lineTo(pD[0], pD[1]); ctx.stroke();
      }
    }
  };
  const tick = now => {
    raf = 0;
    const dx = tx - cx, dy = ty - cy, ds = tStr - str;
    cx += dx * 0.24; cy += dy * 0.24; str += ds * 0.16;
    drawFrame(now);
    if (Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25 || Math.abs(ds) > 0.01 || ripples.length) {
      raf = requestAnimationFrame(tick);
    }
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(tick); };
  const resize = () => {
    w = window.innerWidth; h = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFrame(performance.now());
  };
  window.addEventListener('resize', resize, { passive: true });
  resize();
  if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
    document.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') { tStr = 0; schedule(); return; }
      tx = e.clientX; ty = e.clientY;
      if (tStr === 0 && str < 0.05) { cx = tx; cy = ty; }
      tStr = 1; schedule();
    }, { passive: true });
    document.addEventListener('pointerleave', () => { tStr = 0; schedule(); });
  }
  document.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    ripples.push({ x: e.clientX, y: e.clientY, t0: performance.now() });
    if (ripples.length > 4) ripples.shift();
    schedule();
  }, { passive: true });
}

initPhoneLiquidEffects();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
