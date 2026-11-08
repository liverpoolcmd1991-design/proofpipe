const $ = s => document.querySelector(s);
const SERVER = location.origin;

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
let transferTotal = 0, transferDone = 0, transferActive = null;
function transferBegin(name, total) {
  if (!transferTotal) { transferTotal = total || 1; transferDone = 0; }
  transferActive = { name, pct: 0 };
  renderTransferStatus();
}
function transferProgress(name, pct) { transferActive = { name, pct }; renderTransferStatus(); }
function transferEnd(name) {
  transferDone++;
  if (transferActive && transferActive.name === name) transferActive = null;
  if (transferDone >= transferTotal) { // batch finished — hand the line back
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
  if (!el || !transferActive) return;
  const n = transferTotal > 1 ? ` · ${Math.min(transferDone + 1, transferTotal)}/${transferTotal}` : '';
  const p = transferActive.pct;
  // pct < 0 = indeterminate. fetch() cannot report upload bytes, so the photo
  // path has no percentage to show — an ellipsis is honest, a fake 0% is not.
  const lead = p < 0 ? 'sending…' : (p === 100 ? 'processing…' : p + '%');
  el.textContent = `${lead} ${transferActive.name}${n}`; // textContent only — XSS rule
  // setStatusSub() dedupes against this cache, so a direct write that skipped it
  // would make the NEXT statusDetail() early-return and strand the progress
  // string on screen after the batch was done.
  statusSubText = el.textContent;
  const strip = $('#status-strip');
  if (strip) {
    strip.dataset.state = 'busy';
    const itemFrac = p < 0 ? 0.58 : Math.max(0.08, Math.min(1, p / 100));
    const scale = Math.max(0.14, Math.min(1, (transferDone + itemFrac) / Math.max(1, transferTotal)));
    strip.style.setProperty('--xfer-scale', scale.toFixed(3));
  }
}
// How many items the current batch holds. The two-worker pools below each call
// transferBegin() per item, and every worker sees only its own item — without
// this the strip would claim "1/1" for every file in a 10-file batch.
let transferBatchRemaining = 0;
const transferBatchSize = () => transferBatchRemaining || 1;

async function checkServer() {
  try {
    // report the outbox size so the PC harness can show a queue badge
    let n = 0;
    try { n = await outboxCount(); } catch {}
    const url = `${SERVER}/api/lan?device=phone${n ? `&outbox=${n}` : ''}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw 0;
    everConnected = true;
    setStatus('ok', 'connected');
    if (!sseLive) {
      // SSE is down: this tick is the ONLY refresh — captures, PC texts/chips
      // and files must all come back (loadTexts was missing, so PC sends stayed
      // invisible for as long as the SSE outage lasted)
      loadRecent();
      loadTexts();
    }
    flushOutbox();
    flushTextQueue();
    flushFileQueue();
    // With a live SSE stream, file events arrive with the row payload; polling
    // the version endpoint every idle tick was just battery/radio work. Keep the
    // fallback when SSE is down, or when this lane already has rows whose
    // deletions/changes need reconciliation.
    if (!sseLive || xferFiles.length) loadFiles();
  } catch {
    // Two different failures were reported as one word. "offline" claims a
    // connection that DROPPED, which is wrong for a phone that has never reached
    // the PC at all — that phone was never paired, and the fix is the QR on the
    // PC, not the Wi-Fi. And the queue count lives in exactly ONE place now (the
    // amber bar above the shutter), so it can no longer be asserted here and
    // contradicted there.
    if (!everConnected) { setStatus('off', 'not paired'); setStatusSub('scan the QR on your PC · same Wi-Fi'); return; }
    setStatus('off', 'offline');
  }
}

// ---------- offline queue for TEXTS (photos have the outbox; texts get one too) ----------
// Capacity/retry policy lives in queue.js (PPQueue) — unit-tested.
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
  // universal quality reduction (server setting, OFF by default): when on,
  // EVERY photo upload path funnels through here — capture, gallery batch,
  // manual retry, and the offline-queue flush — so one flag controls them
  // all. Re-encode to JPEG at the configured quality (1–100); re-encoding
  // a JPEG at the same q is visually ~neutral but strips EXIF (fine for
  // transfers). Files and PC-origin images never pass through here.
  let sendBlob = blob;
  if (settings.qualityReduce && blob.type && blob.type.startsWith('image/') && blob.type !== 'image/gif') {
    try {
      sendBlob = await qualityCompress(blob, settings.qualityLevel, { maxDim: 4096 });
    } catch {} // compression failed → send the original; a photo must never be lost over a setting
  }
  // HEIC/HEIF: most browsers can't DECODE it, so the PC viewer would show a
  // broken image and pasted HEIC often lands nowhere. Browser <input> picks
  // arrive as JPEG (when transcoded), but the ANDROID SHARE-TARGET passes
  // the original bytes through. Re-encode to JPEG via canvas when possible;
  // if this browser can't decode HEIC either, send the original anyway — the
  // server stores it, and the 415-no-longer-poisons policy keeps retrying it
  // harmless.
  if (sendBlob.type && /^image\/(hei[cf]|heif)$/i.test(sendBlob.type)) {
    try {
      // force: a JPEG is usually BIGGER than the HEIC it replaces, and the
      // size guard would silently skip every conversion.
      // NO size limit of any kind — not maxDim, not maxPixels. This runs with
      // the quality setting OFF too, so the one thing it is entitled to change
      // is the FORMAT; it used to inherit qualityCompress's 4096px clamp
      // through a bare default, which cost a 48MP phone HEIC 74% of its
      // pixels. A photo past the PC's ceiling is refused by the server with a
      // message naming the limit and the single switch that fixes it (see
      // tooManyPixelsMsg) — never quietly shrunk to fit.
      const j = await qualityCompress(sendBlob, 92, { force: true });
      if (j && j.type === 'image/jpeg' && j !== sendBlob) sendBlob = j;
    } catch {} // not decodable here — the original goes out as-is
  }
  const fd = new FormData();
  fd.append('source', 'phone'); // origin badge on the PC (declared BEFORE the file part)
  // auto-paste intent is frozen at capture/queue time, not read at flush time —
  // a photo queued offline must not paste just because the toggle flipped later
  if (opts.auto ?? autoPaste) fd.append('auto', '1');
  // idempotency: one key per capture, FROZEN at capture/queue time and reused
  // on every retry. The server answers a retry of an upload that actually
  // landed with the ORIGINAL row — a timed-out send can never duplicate.
  // the idempotency key is frozen at capture/queue time and passed as
  // `dedupeKey` on every retry — there is no separate reuse path
  const dedupeKey = opts.dedupeKey ?? null;
  if (dedupeKey) fd.append('key', String(dedupeKey).slice(0, 32));
  // name the part by the blob's real type: the server preserves the original
  // format, and a hardcoded .jpg mislabeled PNG/HEIC captures
  const ext = ((sendBlob.type || '').split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  fd.append('photo', sendBlob, `capture.${ext}`);
  // timeout sized to the payload, not a flat 30s: a 15 MB photo over slow
  // Wi-Fi legitimately takes minutes, and a premature abort + retry used to
  // duplicate the capture on the PC (the first attempt had already landed).
  // The dedupe key makes a retry harmless anyway — this just avoids the churn.
  // ~1 MB/s floor + 15 s overhead, clamped to [30s, 10min].
  const timeoutMs = Math.min(600000, Math.max(30000, 15000 + (sendBlob.size / (1024 * 1024)) * 1000));
  const res = await fetch(SERVER + '/upload', { method: 'POST', body: fd, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const err = new Error('upload failed ' + res.status);
    err.status = res.status; // let the queue distinguish 429 / 413 / 415 from a gone server
    // the server's reason string travels with the error: a 413 measured as
    // genuinely over the cap is terminal (poisonReason 'too-large'), while a
    // 415 is retryable — the unpoison migration uses the same distinction.
    try { const b = await res.clone().json(); if (b && b.error) err.reason = String(b.error); } catch {}
    throw err;
  }
  return res.json();
}

// ---------- outbox (IndexedDB) ----------
// Each item: { blob (original quality), tries, lastAttempt, auto, dedupeKey }
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
// upload idempotency key: MUST match the server's ^[A-Za-z0-9_-]{8,32}$ gate
// (it is stripped if it doesn't). Minted ONCE per capture and frozen into the
// outbox record — a timed-out upload that retries with the same key is
// answered with the original capture instead of storing a duplicate.
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
  // the wrapper is the tap target (role=button); the live region is the inner
  // span, so the announcement never sits inside an interactive element
  const live = $('#outbox-text') || el;
  live.replaceChildren(
    Object.assign(document.createElement('i'), { className: 'ic ic-package' }),
    document.createTextNode(` ${n} photo${n > 1 ? 's' : ''} queued — will sync automatically`)
  );
  // the More-menu mirror of the queue chip: visible only when there is
  // something queued, so "Clear queued photos" stays discoverable even when
  // the chip (which now RETRIES) is the only thing on screen
  const co = $('#clear-outbox');
  if (co) co.classList.toggle('hidden', !n);
}
// resolves with the new record's key
async function outboxAdd(blob, existingKey = null, auto = false, dedupeKey = null) {
  if (!idb) return null;
  // store the ORIGINAL blob so queued photos sync at full quality too;
  // `auto` freezes the auto-paste intent the capture was made with,
  // `dedupeKey` freezes the idempotency key so retries can't duplicate
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
  // write EXACTLY the policy state given: PPQueue.onFailure already computed
  // tries+1 — bumping again here counted every failure twice (backoff doubled
  // speed, poison hit in ~500 real attempts). Callers pass the bookkeeping
  // straight through; no re-increment, and lastAttempt comes from the policy.
  await new Promise(resolve => {
    const tx = idb.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').put({ ...value, tries: value.tries || 0, lastAttempt: value.lastAttempt ?? Date.now() }, key);
    tx.oncomplete = resolve; tx.onerror = resolve;
  });
}
// A record written before keys were frozen has none. Without this the
// auto-flush retries it with no key at all — a timed-out send that actually
// landed then stores a duplicate. Never rewrites a key that is already set.
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
async function outboxDelete(key) {
  if (!idb) return;
  await new Promise(resolve => {
    const tx = idb.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').delete(key);
    tx.oncomplete = resolve; tx.onerror = resolve;
  });
  outboxUI();
}
// snapshot every queued item (small — at most a burst's worth)
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
// fetch a single queued record (null if absent) — used to re-check liveness
// before the flush worker uploads an item from a stale snapshot
async function outboxGet(key) {
  if (!idb) return null;
  return new Promise(resolve => {
    const req = idb.transaction('outbox').objectStore('outbox').get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
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
// exponential backoff / poison / rate-limit policy: PPQueue (queue.js) —
// backoffMs(tries) and the flush decisions are shared by ALL THREE queues
// and unit-tested in test/queue.test.js
const sleep = ms => new Promise(r => setTimeout(r, ms));

let flushing = false; // single-flight guard: concurrent checkServer() calls share one loop
// outbox keys currently being uploaded by a MANUAL retry — the flush worker
// must skip them or both paths upload the same blob (duplicate capture on PC)
const inflightKeys = new Set();
async function flushOutbox() {
  if (flushing || !idb) return;
  flushing = true;
  let last429 = 0;
  let usedLast = false;
  try {
    const items = await outboxAll(); // snapshot — no cursor held across awaits
    if (!items.length) return;
    // bounded catch-up concurrency (2 = same as the live-capture path)
    const CONC = 2;
    let idx = 0;
    const worker = async () => {
      while (true) {
        // after a rate limit, back EVERYONE off briefly so the bucket can refill
        while (Date.now() - last429 < 1500) await sleep(last429 + 1500 - Date.now());
        const job = items[idx++];
        if (!job) return;
        const v = job.value;
        // poison / backoff / inflight decisions: PPQueue.decide (unit-tested).
        // - 413-poisoned (415 no longer poisons — see public/queue.js): keep
        //   visible for tap-to-clear, never re-send
        // - cooling down: skip THIS item (not the whole queue) — one bad head
        //   used to block everything behind it forever
        // - a manual retry owns the item right now
        if (PPQueue.decide(v, { now: Date.now(), inflight: inflightKeys.has(job.key) }) !== 'send') {
          continue;
        }
        // the record may have been deleted by a successful manual retry after
        // this snapshot was taken — re-check before uploading or we'd send a
        // ghost copy of a capture that already landed
        try {
          const stillThere = await outboxGet(job.key);
          if (!stillThere) continue;
        } catch { continue; }
        usedLast = true;
        transferBegin('queued photos', items.length);
        transferProgress('photo', -1); // fetch() cannot report bytes
        try {
          const result = await upload(v.blob, { auto: v.auto, dedupeKey: v.dedupeKey }); // stored key: retries stay idempotent
          const item = recentItems.find(i => i.outboxKey === job.key);
          await outboxDelete(job.key);
          if (item) {
            item.outboxKey = null;
            markSent(item.el, result);
          }
          transferEnd('photo');
        } catch (e) {
          const status = e && e.status;
          const book = PPQueue.onFailure(v, status);
          if (book.rateLimitedMs) last429 = Date.now();
          // poisonReason marks WHY an item is terminal: only a server-measured
          // refusal (413 = over the byte cap OR over the PC's pixel ceiling) is
          // permanent — the one-time unpoison migration trusts this marker and
          // leaves these alone.
          const extra = book.poisoned ? { poisonReason: 'too-large' } : {};
          await outboxBumpTries(job.key, { ...v, tries: book.tries, lastAttempt: book.lastAttempt, ...extra });
          // 413-poisoned items (book.poisoned) stay in the queue/count for
          // tap-to-clear; transient failures back off and keep syncing others.
          // SAY WHY. A terminal photo used to fail in complete silence — the
          // capture simply never reached the PC and nothing on the page said so.
          if (book.poisoned) flash(e?.reason === 'too many pixels'
            ? tooManyPixelsMsg()
            : 'Photo is over the size cap — it was not sent');
          transferEnd('photo');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, items.length) }, worker));
  } finally {
    flushing = false;
    outboxUI();
    // keep draining promptly if some remain and we made progress — the 10s tick
    // also catches it, but this makes a big burst finish in seconds, not minutes
    if (usedLast) {
      const remaining = await outboxCount();
      if (remaining) setTimeout(flushOutbox, 2000);
    }
  }
}


// ---------- recent items: tap = open viewer, actions under the image ----------
const recentItems = []; // { el, blob, ts, sent, file, id, remote, fromPc }
// Local tiles use a small bitmap only for the grid. The ORIGINAL blob remains
// untouched for upload/viewer/copy; server-backed tiles use the server's
// existing thumbnail and do not download full-resolution data until opened.
async function tileUrl(blob) {
  try {
    // resizeWidth ONLY: passing both width+height squashed portrait photos
    // into squares; a single dimension preserves the aspect ratio
    const bmp = await createImageBitmap(blob, { resizeWidth: 240, resizeQuality: 'medium' });
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    return new Promise(res => c.toBlob(b => res(b ? URL.createObjectURL(b) : URL.createObjectURL(blob)), 'image/jpeg', 0.8));
  } catch {
    return URL.createObjectURL(blob); // decode unsupported — show the original
  }
}
function revokeObjectUrl(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) URL.revokeObjectURL(url);
}
// " at 14:32" — the ONLY thing that tells one tile's label from the next in a
// list of up to 100 (server rows carry created_at; a live capture is now).
// UTC from the server, rendered in the viewer's local zone, like the chips.
function tileTimeLabel(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'string' ? ts.replace(' ', 'T') + 'Z' : ts);
  if (!d || isNaN(d)) return '';
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  // a clock time ALONE collides across days — two captures both "at 14:32" were
  // indistinguishable in the tile's own label
  return new Date().toDateString() === d.toDateString()
    ? ` at ${time}`
    : ` at ${time} on ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}
function recentTileA11y(w, tile, when = null) {
  const base = `${tile.fromPc ? 'Capture from PC' : 'Capture'}${tileTimeLabel(when)}, open preview`;
  w.dataset.a11yBase = base; // setTileState() below appends the badge state
  w.setAttribute('role', 'button');
  w.tabIndex = 0;
  w.setAttribute('aria-label', base);
  w.title = 'Tap or press Enter to view';
  w.onclick = () => tile.remote ? openViewerRemote(tile) : openViewer(tile);
  w.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); w.click(); }
  };
}
// The pending spinner and the failed "not sent" banner are drawn by CSS
// (::after / ::before), which screen readers never see — mirror the badge into
// the tile's accessible name so the label matches what is on screen.
function setTileState(w, state) {
  const base = w && w.dataset.a11yBase;
  if (!base) return;
  w.setAttribute('aria-label', state ? `${base} — ${state}` : base);
}
// The ✓ is an ARRIVAL confirmation, not a state. A badge on EVERY tile marked
// the NORMAL case, so it carried no information — and it spent the top-right
// corner of every 96px thumbnail, the only part of the UI that is content.
// Shown at full strength for JUST_SENT_MS, then faded over JUST_SENT_FADE_MS and
// removed: a confirmation that vanishes between two frames reads as a glitch, so
// the exit is a fade (and the reduced-motion block makes it instant). A resting
// tile is badge-free, and .pending/.failed persist because those are the states
// worth interrupting for. Driven by the same paths that already clear the state
// suffix, so a tile can never wear a ✓ and a spinner at once.
const JUST_SENT_MS = 2000;
const JUST_SENT_FADE_MS = 400;
function markJustSent(el) {
  if (!el) return;
  clearTimeout(el._justSentTimer);
  // re-armed mid-fade: restore full strength before re-timing
  el.classList.remove('just-sent-out');
  el.classList.add('just-sent');
  el._justSentTimer = setTimeout(() => {
    el.classList.add('just-sent-out');
    el._justSentTimer = setTimeout(() => {
      el.classList.remove('just-sent', 'just-sent-out');
    }, JUST_SENT_FADE_MS);
  }, JUST_SENT_MS);
}
// entrance + thumb fade helpers. Both are compositor-only (opacity/transform).
// The entrance class runs ONE animation on arrival; dropping it on animationend
// releases the promoted layer. The fade gates on DECODE, never on the network:
// the image paints the instant its bytes are ready — no added latency, just no
// half-parsed flash. Tiles whose bitmap is already decoded skip the fade.
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
// live=true (default) = just captured/sent: entrance animation + decode fade.
// Outbox restore on page load passes live=false — history, not an arrival.
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
  };
  tileUrl(blob).then(u => {
    if (!recentItems.includes(tile)) { revokeObjectUrl(u); return; } // evicted mid-decode
    // the tile's OWN bitmap lives in tileUrl — never url: url flips to the server
    // original at markSent, and a late decode must not clobber it
    tile.tileUrl = u;
    if (live) {
      // just-captured tile: mark the img transparent BEFORE assigning src so
      // the first paint is the fade-in, never a half-parsed frame
      img.classList.add('thumb-enter');
      thumbFadeIn(img);
    }
    img.src = u;
  });
  w.appendChild(img);
  // a just-captured tile can timestamp itself; restored queue history cannot
  // (the outbox record carries no time), so it keeps the generic label
  recentTileA11y(w, tile, live ? Date.now() : null);
  if (live) {
    tileEnter(w);
    setTileState(w, 'uploading'); // just captured: the pending spinner is showing
  }
  $('#recent').prepend(w);
  recentItems.unshift(tile);
  trimRecent();
  return tile; // CALLER keeps this ref — never look the tile up by element (see handleFiles)
}
// live=true marks an SSE/just-uploaded arrival (entrance animation + decode
// fade). History loads (loadRecent) pass nothing: dozens of tiles must not
// animate, and their cached thumbnails must paint instantly with no gating.
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
      recentTileA11y(existing.el, existing, cap.created_at); // keep the label's origin honest
    }
    existing.el.classList.toggle('pc-origin', existing.fromPc);
    existing.el.classList.remove('pending', 'failed');
    setTileState(existing.el, '');
    existing.el.title = 'Uploaded to your PC — tap to view';
    if (live) markJustSent(existing.el); // a live arrival confirms itself briefly
    existing.url = `${SERVER}/media/${encodeURIComponent(cap.file)}`;
    existing.thumbUrl = `${SERVER}/media/t-${encodeURIComponent(cap.file)}`;
    // A tile that owns a local bitmap keeps it. Re-pointing src here reloads +
    // re-decodes the just-captured thumbnail — the second half of the blink.
    if (existing.img && existing.thumbUrl && !existing.tileUrl) {
      const nextSrc = `${existing.thumbUrl}${existing.img.src === existing.thumbUrl ? `?v=${cap.id || Date.now()}` : ''}`;
      if (live) {
        // pending → sent swap: fade the server thumb in over the local bitmap
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
  };
  if (live) {
    img.classList.add('thumb-enter'); // fade in on decode — never a half-parsed frame
    tileEnter(w);
    markJustSent(w);
  }
  img.src = thumb;
  recentTileA11y(w, tile, cap.created_at);
  w.title = 'Uploaded to your PC — tap to view'; // this row is already on the PC
  let thumbTries = 0;
  img.onerror = () => {
    // The capture SSE event can precede deferred thumbnail creation. Keep the
    // tile visible and retry; never fall back to the full-resolution URL.
    // The window is long on purpose (12 tries, staggered to a 5s ceiling ≈ 40s):
    // the server regenerates a missing thumb on demand, so a retry that lands
    // after a rate-limited burst's write queue drains still heals itself, and a
    // tile that gives up early is the bug this replaced (it used to be 6 × 800ms).
    if (++thumbTries > 11) return;
    setTimeout(() => { if (img.isConnected) img.src = `${thumb}?retry=${Date.now()}`; }, Math.min(5000, 400 * thumbTries));
  };
  w.appendChild(img);
  stampSort(w, { ts: chipTimestamp(cap.created_at), name: cap.file, seq: cap.id });
  $('#recent').prepend(w);
  recentItems.unshift(tile);
  // the grid is appended-newest-first above; an "Oldest"/"Name" order has to be
  // re-established on every arrival, not only when the menu is used
  if (sortMode !== 'new') applySort($('#recent'));
  trimRecent();
  return tile;
}
let recentVersion = -1;
// False until the first loadRecent() settles. Distinguishes "still loading" from
// "genuinely empty" — the empty copy is a statement about the library, so it must
// not sit next to the skeletons while the first request is in flight.
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
    const tile = addRecent(job.value.blob, { outboxKey: job.key }, { live: false }); // restored history — no entrance animation
    tile.auto = job.value.auto === true; // restored queue item keeps its frozen auto-paste intent
    if (job.value.dedupeKey) tile.dedupeKey = job.value.dedupeKey; // restored key: retries stay idempotent
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
      // nothing changed, but the first load has still settled — stop loading UI
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
    // Merge server history into the local/pending session list. Existing local
    // items are matched by filename after upload; originals are never fetched
    // here — addRemoteRecent uses the server thumbnail only.
    //
    // Merge server history (both phone and PC captures) into the gallery.
    // PC-origin captures wear a subtle blue PC badge on their tile and in the viewer.
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
    // Offline reloads retain the durable outbox; server-backed history returns
    // automatically on the next successful visibility/connection check. Do not
    // silently present the genuine-empty message as if the library had no data.
    // The error state replaces the skeleton rather than sharing the screen.
    recentLoaded = true;
    skel?.classList.add('hidden');
    $('#recent-error')?.classList.remove('hidden');
    recentEmptyUI();
  }
}
$('#recent-retry')?.addEventListener('click', () => loadRecent(true));
// cap the recent list at 100 by evicting the OLDEST *sent* tile. Unsent/pending
// tiles are kept — a burst's eviction must never drop a photo that hasn't
// synced yet or is still recoverable from the durable outbox.
function trimRecent() {
  if (recentItems.length <= 100) return;
  for (let i = recentItems.length - 1; i >= 0; i--) {
    const old = recentItems[i];
    if (!old.sent) continue;
    recentItems.splice(i, 1);
    if (viewerBlob === old.blob) hideViewer();
    old.el.remove();
    revokeObjectUrl(old.tileUrl);   // local tile bitmap
    revokeObjectUrl(old.url);       // sent tiles: server URL (a no-op for blob:)
    revokeObjectUrl(old.fullUrl);   // local viewer copy only
    return;
  }
  // everything is still pending (huge burst in flight) — allow the list to
  // exceed 100 briefly rather than lose an unsynced capture
}
function removeRecentItem(item) {
  if (!item) return;
  if (viewerBlob === item.blob) hideViewer();
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
  // the ✓ badge is CSS-only (invisible to assistive tech) and is TRANSIENT now —
  // it confirms the arrival for ~2s, so the title names the state that lasts
  el.title = 'Uploaded to your PC — tap to view';
  markJustSent(el);
  const item = recentItems.find(i => i.el === el);
  if (!item) return;
  item.sent = true;
  if (result?.file) {
    const duplicate = recentItems.find(i => i !== item && i.file === result.file);
    if (duplicate) {
      removeRecentItem(item); // response/SSE race: retain one visible capture
      return;
    }
    item.file = result.file;
    // Keep the tile's own local bitmap. Re-pointing <img>.src at the server
    // thumbnail made every capture blink right after upload (blank frame →
    // network round-trip → decode → repaint). The bitmap is a ~240px JPEG, so
    // keeping it costs almost nothing and takes a request + repaint off the hot
    // path. item.url becomes the server ORIGINAL (viewer + download source) and
    // item.tileUrl keeps the bitmap so removal can still revoke it.
    item.url = `${SERVER}/media/${encodeURIComponent(result.file)}`;
    item.thumbUrl = `${SERVER}/media/t-${encodeURIComponent(result.file)}`;
    // memory: the multi-MB original is unreachable once the outbox record is
    // gone — drop it (the tile keeps only the small bitmap now).
    item.blob = null;
    if (item.fullUrl) { revokeObjectUrl(item.fullUrl); item.fullUrl = null; }
  }
  if (result?.id != null) item.id = result.id;
}
async function retryItem(item) {
  if (!item || item.sent) return;
  if (!$('#status-dot').classList.contains('ok')) { flash('Offline — cannot retry now'); return; }
  // tell the auto-flush worker this item is OURS — otherwise it can upload the
  // same blob from its snapshot in parallel (duplicate capture on the PC)
  const key = item.outboxKey;
  if (key != null) inflightKeys.add(key);
  // resolve the dedupe key ONCE, before the try: the queued record is the
  // source of truth (it froze the key at capture time), and the catch path
  // re-queueing a record needs the same key so retries stay idempotent.
  let dk = item.dedupeKey ?? null;
  if (!dk && item.outboxKey != null) {
    try { dk = (await outboxGet(item.outboxKey))?.dedupeKey || null; } catch {}
  }
  if (!dk) dk = newKey(); // tile had no record and no key — mint one for this capture
  item.dedupeKey = dk;
  await outboxSetDedupeKey(item.outboxKey, dk); // no-op unless the stored record predates frozen keys
  try {
    const result = await upload(item.blob, { auto: item.auto ?? autoPaste, dedupeKey: dk }); // original quality: no downscale/re-encode
    // manual success: remove the queued record so the auto-flush can't re-upload it
    if (item.outboxKey != null) await outboxDelete(item.outboxKey);
    item.outboxKey = null;
    markSent(item.el, result);
    flash('Sent ✓');
  } catch (e) {
    // keep/queue the record — never mark a failed retry as sent. Carry the
    // dedupe key + auto intent into the new record (fix: the re-queue used to
    // drop the frozen auto flag).
    if (item.outboxKey == null) item.outboxKey = await outboxAdd(item.blob, null, item.auto ?? autoPaste, dk);
    // a terminal refusal must not masquerade as a transient one: retrying this
    // photo can never work until the quality setting (which resizes) is on
    flash(e?.reason === 'too many pixels'
      ? tooManyPixelsMsg()
      : 'Still failing — queued for auto-sync');
  } finally {
    if (key != null) inflightKeys.delete(key);
  }
}
// ---------- viewer: fullscreen image + two buttons underneath ----------
let viewerBlob = null;
let viewerRetryFn = null;
let viewerDiscardFn = null;
let viewerReturnFocus = null; // element to restore focus to when the viewer closes
let viewerIdx = -1;   // position within the ACTIVE list for swipe navigation
let viewerItems = null; // active list (recentItems, or PC-sent media)

// aria-modal means Tab must stay inside the visible overlay. The harness has a
// trap; the phone did not, so keyboard/switch users could tab into the page
// behind the viewer, file sheet or confirm dialog. Keep a small stack because a
// confirm dialog can open above the viewer/sheet; closing the top layer restores
// the previous trap.
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

const activeViewerItems = () => viewerItems || recentItems;
// shared display path for local tiles and PC-sent captures alike
function showViewer(item) {
  viewerBlob = item.blob;
  updateViewerPos();
  hideViewerUnder(); // fresh open: never leave a stale neighbor slide layer
  // where we are: local captures or the PC-sent list ("3 / 5 · PC")
  const vo = $('#viewer-origin');
  vo.classList.toggle('hidden', !item.fromPc);
  // the tile shows a small bitmap — the viewer loads the FULL-RES blob.
  // Sent tiles have no local blob anymore (memory: dropped on markSent);
  // their viewer source is the server's original URL instead.
  if (!item.fullUrl) item.fullUrl = item.blob ? URL.createObjectURL(item.blob) : (item.url || item.thumbUrl || '');
  $('#viewer-img').src = item.fullUrl;
  viewerZoom = { scale: 1, tx: 0, ty: 0 };
  viewerRot = 0; // fresh image, fresh orientation
  applyViewerZoom();
  const wasHidden = $('#viewer').classList.contains('hidden');
  $('#viewer').classList.remove('hidden');
  if (wasHidden) { // dialog semantics: focus moves in on open, back out on close
    viewerReturnFocus = document.activeElement;
    trapPhone($('#viewer'), $('#viewer-close'));
  }
  syncOverlayHistory();
  maybeShowSwipeHint();
}
// swipe-navigate entry animation relies on the transform transition;
// showViewer callers that set a start offset call this to slide in
function animateViewerIn() {
  requestAnimationFrame(() => {
    viewerImg.classList.remove('gesturing');
    viewerZoom.tx = 0;
    applyViewerZoom();
  });
}
function openViewer(item) {
  viewerItems = item.remoteList || recentItems;
  viewerIdx = viewerItems.indexOf(item);
  showViewer(item);
  const retry = $('#viewer-retry');
  const needsRetry = !item.sent;
  retry.classList.toggle('hidden', !needsRetry);
  $('#viewer-discard').classList.toggle('hidden', !needsRetry);
  $('#viewer-del').classList.toggle('hidden', !viewerCanDelete(item));
  viewerRetryFn = needsRetry ? async () => { hideViewer(); await retryItem(item); } : null;
  viewerDiscardFn = needsRetry ? async () => {
    if (!await phoneConfirm({ title: 'Discard this photo?', body: 'It will not be uploaded.', ok: 'Discard' })) return;
    if (item.outboxKey != null) await outboxDelete(item.outboxKey);
    item.outboxKey = null;
    item.el.remove();
    recentItems.splice(recentItems.indexOf(item), 1);
    revokeObjectUrl(item.tileUrl);
    revokeObjectUrl(item.url);
    revokeObjectUrl(item.fullUrl);
    hideViewer();
    flash('Discarded');
  } : null;
}
// pinch-zoom + swipe navigation for the fullscreen viewer
let viewerZoom = { scale: 1, tx: 0, ty: 0 };
let viewerRot = 0; // degrees, reset per item — the harness lightbox behaves the same
const viewerImg = $('#viewer-img');
function applyViewerZoom() {
  // scale and rotate commute for a uniform scale, so the rotation can ride here
  // without disturbing any of the gesture math
  viewerImg.style.transform = `translate(${viewerZoom.tx}px, ${viewerZoom.ty}px) scale(${viewerZoom.scale}) rotate(${viewerRot}deg)`;
}
// keep the zoomed image on-screen: the pan can never push the element box
// past the stage edges (at scale 1 this recenters — the clamp range is 0).
// The element box is the stage box scaled around its center, so the rendered
// overflow is (scale-1)*size/2 per side. Without this, a pan could throw the
// image fully off-screen and leave it there.
// Rotation extends the reachable range: rotating the box swaps/extends its AABB
// (the same cos/sin math the harness's clampPan uses).
function clampViewerPan() {
  const r = $('#viewer-stage').getBoundingClientRect();
  const rad = viewerRot * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const baseW = r.width * cos + r.height * sin;
  const baseH = r.width * sin + r.height * cos;
  const mx = (baseW * (viewerZoom.scale - 1)) / 2;
  const my = (baseH * (viewerZoom.scale - 1)) / 2;
  viewerZoom.tx = Math.min(mx, Math.max(-mx, viewerZoom.tx));
  viewerZoom.ty = Math.min(my, Math.max(-my, viewerZoom.ty));
}
// rotate one quarter-turn per press — a sideways photo had to be sent to the PC
// to be straightened, on the device that took it
function rotateViewer() {
  viewerRot = (viewerRot + 90) % 360;
  clampViewerPan();
  applyViewerZoom();
}
// gallery-style slide layer: the INCOMING neighbor is rendered underneath the
// current image and both follow the finger 1:1 — no more teleporting swap
const viewerUnder = $('#viewer-under');
function hideViewerUnder() {
  viewerUnder.style.display = 'none';
  viewerUnder.dataset.src = '';
}
function showViewerUnder(item, offset) {
  const src = item.fullUrl || item.url || item.thumbUrl || '';
  if (!src) { hideViewerUnder(); return; }
  if (viewerUnder.dataset.src !== src) {
    viewerUnder.dataset.src = src;
    viewerUnder.src = src;
  }
  viewerUnder.style.display = 'block';
  viewerUnder.classList.add('gesturing');
  viewerUnder.style.transform = `translate(${offset}px, 0)`;
}
// "3 / 15" position indicator — galleries without it feel like a void
function updateViewerPos() {
  const list = activeViewerItems();
  $('#viewer-pos').textContent = list.length ? `${viewerIdx + 1} / ${list.length}` : '';
}
// one-time swipe affordance: visible until the user performs their first
// successful swipe — no motion at rest afterwards
let swipeHintShown = false;
function maybeShowSwipeHint() {
  const hint = $('#viewer-hint');
  if (!hint) return;
  if (swipeHintShown || activeViewerItems().length < 2) { hint.classList.add('hidden'); return; }
  hint.classList.remove('hidden');
}
function dismissSwipeHint() {
  swipeHintShown = true;
  $('#viewer-hint')?.classList.add('hidden');
}
// double-tap zoom: toggle 1x ↔ 2.5x centered on the tapped point (the standard
// gallery affordance — no pinch needed for a closer view)
function viewerZoomTo(scale, cx, cy) {
  const r = $('#viewer-stage').getBoundingClientRect();
  const lx = cx - r.left, ly = cy - r.top;
  // keep the tapped image point fixed under the finger: p = (l − t) / s
  const px = (lx - viewerZoom.tx) / viewerZoom.scale;
  const py = (ly - viewerZoom.ty) / viewerZoom.scale;
  viewerZoom.scale = scale;
  if (scale === 1) { viewerZoom.tx = 0; viewerZoom.ty = 0; }
  else { viewerZoom.tx = lx - scale * px; viewerZoom.ty = ly - scale * py; }
  clampViewerPan();
  applyViewerZoom();
}
(() => {
  const stage = $('#viewer-stage');
  // Gallery-style swipe, three ingredients:
  //  1. the image tracks the finger 1:1 and the NEIGHBOR slides in beneath it
  //     (two-layer push) — navigation previews where you're going;
  //  2. axis locks after ~10px so vertical moves never hijack navigation;
  //  3. commit on release past 25% of the stage width OR a flick measured over
  //     the last ~90ms (a lifetime average misjudges drag-then-flick). At the
  //     ends of the list there is no neighbor: the drag rubber-bands (0.35x)
  //     and always springs back.
  const AXIS_LOCK = 10;
  const FLICK_V = 0.5;        // px/ms over the trailing window
  const FLICK_WINDOW = 90;    // ms of move history used for the flick test
  const COMMIT_FRAC = 0.25;
  const RUBBER = 0.35;
  let start = null; // { x, y, t, baseX, baseY, scale, pinch, axis }
  let stageW = 1;
  let samples = [];   // trailing [{ x, t }] for the flick velocity
  let lastTap = null;

  const neighborFor = dir => activeViewerItems()[viewerIdx + dir] || null;
  const slideTo = (px, animate) => {
    viewerImg.classList.toggle('gesturing', !animate);
    viewerZoom.tx = px;
    viewerZoom.ty = 0;
    applyViewerZoom();
  };
  function flickVelocity() {
    const s = samples;
    if (s.length < 2) return 0;
    const last = s[s.length - 1];
    let first = s[0];
    for (let i = s.length - 1; i >= 1; i--) {
      if (last.t - s[i].t <= FLICK_WINDOW) first = s[i];
      else break;
    }
    const dt = last.t - first.t;
    return dt > 0 ? (last.x - first.x) / dt : 0;
  }
  // two-layer push: the current image slides out, the neighbor slides in from
  // the same edge, then content swaps at rest. transitionend (with a reduced-
  // motion fallback timer) promotes the neighbor cleanly — no setTimeout jump.
  function commitNav(dir) {
    const list = activeViewerItems();
    const next = list[viewerIdx + dir];
    if (!next) return false;
    showViewerUnder(next, dir * stageW);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      viewerUnder.removeEventListener('transitionend', finish);
      hideViewerUnder();
      viewerZoom = { scale: 1, tx: 0, ty: 0 };
      viewerImg.classList.add('gesturing');
      applyViewerZoom();
      next.remote ? openViewerRemote(next) : openViewer(next);
    };
    viewerUnder.addEventListener('transitionend', finish);
    requestAnimationFrame(() => {
      viewerUnder.classList.remove('gesturing');
      viewerImg.classList.remove('gesturing');
      viewerZoom.tx = dir * -stageW;
      applyViewerZoom();
      viewerUnder.style.transform = 'translate(0, 0)';
      setTimeout(finish, 260); // fallback: reduced motion kills transitionend
    });
    return true;
  }
  stage.addEventListener('touchstart', e => {
    viewerImg.style.willChange = 'transform'; // keep gestures compositor-driven
    // transitions OFF for the whole gesture — otherwise the .18s transform
    // transition chases every touchmove and the image rubber-bands behind
    // the finger (the "zoom is slow" report). Snap paths re-enable it.
    viewerImg.classList.add('gesturing');
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      start = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), scale: viewerZoom.scale, pinch: true, axis: 'h' };
    } else if (e.touches.length === 1) {
      stageW = stage.clientWidth || 1;
      samples = [{ x: e.touches[0].clientX, t: performance.now() }];
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now(), baseX: viewerZoom.tx, baseY: viewerZoom.ty, scale: viewerZoom.scale, pinch: false, axis: null };
    }
  }, { passive: true });
  stage.addEventListener('touchmove', e => {
    if (!start) return;
    // a pinch that drops to one finger becomes a pan of that finger —
    // otherwise gestures froze until every finger lifted
    if (start.pinch && e.touches.length === 1) {
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now(), baseX: viewerZoom.tx, baseY: viewerZoom.ty, scale: viewerZoom.scale, pinch: false, axis: 'h' };
      samples = [{ x: start.x, t: start.t }];
    }
    if (start.pinch && e.touches.length === 2) {
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      viewerZoom.scale = Math.min(6, Math.max(1, start.scale * (d / start.dist)));
      clampViewerPan();
      applyViewerZoom();
      return;
    }
    if (start.pinch || e.touches.length !== 1) return;
    const t = e.touches[0];
    samples.push({ x: t.clientX, t: performance.now() });
    if (samples.length > 8) samples.shift();
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (!start.axis) {
      if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
      // lock once: horizontal wins ties so deliberate swipes never lose to noise
      start.axis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
    }
    if (start.axis === 'v') return; // vertical gesture — never navigates
    if (viewerZoom.scale > 1) {
      // zoomed: this finger pans the image freely, clamped to the stage
      viewerZoom.tx = start.baseX + dx;
      viewerZoom.ty = start.baseY + dy;
      clampViewerPan();
      applyViewerZoom();
      return;
    }
    // unzoomed: 1:1 slide with the incoming neighbor underneath; past the ends
    // of the list, rubber-band instead
    const dir = dx < 0 ? 1 : -1;
    const neighbor = Math.abs(dx) > 2 ? neighborFor(dir) : null;
    if (neighbor) showViewerUnder(neighbor, dir * stageW + dx);
    else hideViewerUnder();
    slideTo(neighbor ? dx : dx * RUBBER, false);
  }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (!start) return;
    if (e.touches.length === 0) {
      viewerImg.style.willChange = ''; // free the compositor layer when idle
      // transitions back on for snap-back / double-tap zoom. Commit and
      // spring paths manage the class themselves; this cleans up the
      // pinch and tap ends (and a stuck post-navigation state).
      viewerImg.classList.remove('gesturing');
    }
    if (!start.pinch && start.axis === 'h' && start.scale === 1) {
      const dx = viewerZoom.tx;
      const v = flickVelocity();
      const dir = dx < 0 ? 1 : -1;
      // flick direction must match the drag direction, else a hard stop's
      // trailing samples would flip the navigation
      const flick = Math.abs(v) > FLICK_V && Math.sign(v) === dir;
      if ((Math.abs(dx) > stageW * COMMIT_FRAC || flick) && Math.abs(dx) > 24 && neighborFor(dir)) {
        dismissSwipeHint();
        commitNav(dir);
        start = e.touches.length === 0 ? null : start;
        return;
      }
      slideTo(0, true); // spring back (also the rubber-band release)
      hideViewerUnder();
    }
    // double-tap zoom: a tap is a touchend with no axis locked and no pinch
    if (e.touches.length === 0 && !start.pinch && !start.axis) {
      const t = e.changedTouches[0];
      const now = performance.now();
      if (lastTap && now - lastTap.t < 300 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 40) {
        lastTap = null;
        if (viewerZoom.scale > 1) viewerZoomTo(1);
        else viewerZoomTo(2.5, t.clientX, t.clientY);
      } else {
        lastTap = { x: t.clientX, y: t.clientY, t: now };
      }
    }
    if (e.touches.length === 0) start = null;
  });
})();
// Delete is offered for server-backed captures only: unsent photos have no
// server identity (Discard covers them) and PC-sent chips live in the text
// table, so /api/captures/:id does not apply to them.
const viewerCanDelete = item => item && item.id != null && item.file && !item.fromPc;
async function viewerDelete() {
  const list = activeViewerItems();
  const item = list[viewerIdx];
  if (!viewerCanDelete(item)) return;
  if (!await phoneConfirm({ title: 'Delete this capture from the PC?', body: 'This cannot be undone.' })) return;
  try {
    const r = await fetch(`${SERVER}/api/captures/${encodeURIComponent(item.id)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw 0;
  } catch {
    flash('Delete failed — offline?');
    return;
  }
  flash('Deleted ✓');
  // advance to a neighbor BEFORE the list mutates, then drop the item from the
  // strip without closing the viewer (removeRecentItem would hide it)
  const target = list[viewerIdx + 1] || list[viewerIdx - 1] || null;
  item.el.remove();
  const idx = recentItems.indexOf(item);
  if (idx >= 0) recentItems.splice(idx, 1);
  revokeObjectUrl(item.tileUrl);
  revokeObjectUrl(item.url);
  revokeObjectUrl(item.fullUrl);
  viewerBlob = null;
  if (target) {
    viewerIdx = activeViewerItems().indexOf(target);
    target.remote ? openViewerRemote(target) : openViewer(target);
  } else {
    hideViewer();
  }
  recentEmptyUI();
}
$('#viewer-del').onclick = e => { e.stopPropagation(); viewerDelete(); };
function hideViewer() {
  $('#viewer').classList.add('hidden');
  $('#viewer-img').src = '';
  hideViewerUnder();
  viewerBlob = null;
  viewerRetryFn = null;
  viewerDiscardFn = null;
  viewerItems = null; // next open starts from its own list again
  const back = viewerReturnFocus;
  viewerReturnFocus = null;
  untrapPhone($('#viewer'), back);
  syncOverlayHistory();
}
// ONE reused toast node, not a fresh div per call: a batch send fires a flash
// per file, and they all landed on the same top-center spot — stacked and
// unreadable. Reusing the node also keeps a single live region that announces
// the replacement text. Hiding it (display:none) restarts the enter animation
// on the next message, so no forced reflow is needed to replay it.
let flashEl = null, flashTimer = 0;
function flash(msg) {
  if (!flashEl) {
    flashEl = document.createElement('div');
    flashEl.className = 'flash hidden';
    flashEl.setAttribute('role', 'status'); // announced by assistive tech
    document.body.appendChild(flashEl);
  }
  flashEl.classList.remove('hidden');
  flashEl.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => flashEl.classList.add('hidden'), 1600);
}

// ---------- confirm dialog (phone) ----------
// Promise-based replacement for window.confirm(): the native prompt BLOCKS the
// main thread (and freezes every running animation on mobile), and it focuses
// OK — DESIGN.md §7 wants Cancel as the default. Esc and a backdrop tap cancel;
// focus returns to whatever opened the dialog. A second call settles the first
// as Cancel, so a queued overlay can never leave a dangling promise.
let confirmResolve = null;
let confirmReturnFocus = null;
function phoneConfirm({ title, body = '', ok = 'Delete', danger = true }) {
  const box = $('#confirm');
  if (!box) return Promise.resolve(window.confirm(title)); // older cached shell
  closeConfirm(false); // settle a previous dialog as cancelled
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  $('#confirm-body').classList.toggle('hidden', !body);
  const okBtn = $('#confirm-ok');
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  confirmReturnFocus = document.activeElement;
  box.classList.remove('hidden');
  // Cancel holds focus: Enter must not be able to delete by accident
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
// hoisted (the viewer/file-sheet Esc guards below call it before this line runs)
function confirmOpen() { return !$('#confirm').classList.contains('hidden'); }
$('#confirm-cancel').onclick = () => closeConfirm(false);
$('#confirm-ok').onclick = () => closeConfirm(true);
$('#confirm').onclick = e => { if (e.target.id === 'confirm') closeConfirm(false); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && confirmOpen()) closeConfirm(false);
});

// ---------- capture handling (fast path) ----------
// `.shutter.busy` (accent border + accent label) while a batch is in flight:
// the class was styled and documented but never applied, so a slow multi-photo
// upload looked exactly like an idle button. Ref-counted, because a camera
// batch and a gallery batch can overlap.
let shutterBusyCount = 0;
function shutterBusy(on) {
  shutterBusyCount = Math.max(0, shutterBusyCount + (on ? 1 : -1));
  const s = $('#shutter');
  if (s) s.classList.toggle('busy', shutterBusyCount > 0);
  // the .busy tint is visual only; the grid carries the busy state for AT
  const recent = $('#recent');
  if (recent) recent.setAttribute('aria-busy', String(shutterBusyCount > 0));
}
async function handleFiles(files) {
  // zero-byte picks would 415 at the server and poison the outbox — drop them
  const jobs = [...files].filter(f => f && f.size > 0).map(file => {
    const blob = file.type && file.type.startsWith('image/') ? file : new Blob([file], { type: 'image/jpeg' });
    // keep the stable tile ref — a >24 batch evicts old tiles, so looking the
    // tile back up by element returned undefined and dropped unsynced photos
    const tile = addRecent(blob);
    tile.auto = autoPaste; // the intent THIS capture was made with
    const dedupeKey = newKey(); // frozen now; reused on every retry of this capture
    tile.dedupeKey = dedupeKey;
    return { blob, tile, dedupeKey };
  });
  // 2 concurrent uploads: gallery batches land ~2x faster without starving
  // the mobile radio; each tile still gets its own pending/failed state
  let qi = 0;
  // 429 back-off. The server's photo bucket refills at a fixed rate, so a
  // 97-photo multi-select can legitimately outrun it: without this the burst
  // just sprayed 429s and dropped the rejected photos into the outbox. Pausing
  // the WHOLE pool for the same 1.5s PPQueue.onFailure uses lets the bucket
  // refill and keeps every photo on its original fast path.
  let last429 = 0;
  const worker = async () => {
    while (qi < jobs.length) {
      while (Date.now() - last429 < 1500) await sleep(last429 + 1500 - Date.now());
      const job = jobs[qi++];
      transferBegin('photos', jobs.length);
      transferProgress('photo', -1); // fetch() cannot report bytes — indeterminate
      try {
        const result = await upload(job.blob, { auto: job.tile.auto, dedupeKey: job.dedupeKey });
        markSent(job.tile.el, result);
        transferEnd('photo');
      } catch (e) {
        if (e && e.status === 429) last429 = Date.now();
        // ALWAYS enqueue durably first — the image must never be lost even if
        // its tile was already evicted from the 24-cap recent list. The same
        // dedupe key rides along, so the flush/retry can't duplicate.
        const key = await outboxAdd(job.blob, null, job.tile.auto, job.dedupeKey);
        if (key) job.tile.outboxKey = key;
        if (job.tile.el.isConnected) {
          job.tile.el.classList.add('failed');  // or tap to retry now
          setTileState(job.tile.el, 'not sent');
        } else if (!key) flash('Some photos could not be queued — index offline'); // no IndexedDB
        transferEnd('photo');
      }
    }
  };
  if (!jobs.length) return; // nothing to upload — don't flash the busy state
  shutterBusy(true);
  try {
    await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, worker));
  } finally {
    shutterBusy(false);
  }
}

// ---------- viewer actions ----------
function viewerDownload() {
  // Sent tiles no longer hold a local blob (memory: dropped on markSent) —
  // download from the server URL instead of silently doing nothing.
  const item = activeViewerItems()[viewerIdx];
  if (!viewerBlob && !(item && item.url)) return;
  const a = document.createElement('a');
  if (viewerBlob) {
    a.href = URL.createObjectURL(viewerBlob);
  } else {
    a.href = item.url;
    a.download = (item.file || 'capture').replace(/^t-/, '');
    document.body.appendChild(a);
    a.click();
    a.remove();
    flash('Saved to downloads ✓');
    return;
  }
  const ext = (viewerBlob.type && viewerBlob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  a.download = `proofpipe-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  flash('Saved to downloads ✓');
}
$('#viewer-rot').onclick = e => { e.stopPropagation(); rotateViewer(); };
$('#viewer-dl').onclick = e => { e.stopPropagation(); viewerDownload(); };
$('#viewer-retry').onclick = e => { e.stopPropagation(); if (viewerRetryFn) viewerRetryFn(); };
$('#viewer-discard').onclick = e => { e.stopPropagation(); if (viewerDiscardFn) viewerDiscardFn(); };
$('#viewer-close').onclick = e => { e.stopPropagation(); hideViewer(); };
$('#viewer').onclick = e => { if (e.target.id === 'viewer') hideViewer(); };
document.addEventListener('keydown', e => {
  // the confirm dialog stacks ABOVE the viewer — one Esc must never close both
  if (e.key !== 'Escape' || confirmOpen()) return;
  if (!$('#viewer').classList.contains('hidden')) hideViewer();
});

// ---------- file transfer: send ANY file to the PC (outbox-backed) ----------
// Same pattern as photos: upload now, or queue durably in IndexedDB when
// offline, with exponential backoff and per-file pending/failed state.
let fileDb = null;
function openFileQueue() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('proofpipe-files', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('fqueue', { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const fqueueCount = async () => {
  if (!fileDb) return 0;
  const tx = fileDb.transaction('fqueue').objectStore('fqueue').count();
  return new Promise(r => { tx.onsuccess = () => r(tx.result); tx.onerror = () => r(0); });
};
async function fqueueAdd(rec) {
  if (!fileDb) return null;
  return new Promise(resolve => {
    const tx = fileDb.transaction('fqueue', 'readwrite');
    const req = tx.objectStore('fqueue').add(rec);
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => resolve(null);
  });
}
async function fqueueDelete(key) {
  if (!fileDb) return;
  await new Promise(resolve => {
    const tx = fileDb.transaction('fqueue', 'readwrite');
    tx.objectStore('fqueue').delete(key);
    tx.oncomplete = resolve; tx.onerror = resolve;
  });
}
async function fqueueAll() {
  if (!fileDb) return [];
  return new Promise(resolve => {
    const out = [];
    const req = fileDb.transaction('fqueue').objectStore('fqueue').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) { out.push({ key: c.key, value: c.value }); c.continue(); }
      else resolve(out);
    };
    req.onerror = () => resolve([]);
  });
}
// The accessible copy of the same progress the strip shows visually. #file-progress
// is off-screen (role=status) rather than a band of cards: the strip has the
// pixels, this has the announcement, and neither duplicates the other's job.
function transferA11y(name, pct) {
  const el = $('#file-progress');
  if (!el) return;
  el.textContent = pct < 0 ? `Sending ${name}` : `${name} ${pct}%`;
}
function uploadFileXHR(blob, name) {
  return new Promise((resolve, reject) => {
    const label = name || 'file';
    transferBegin(label, transferBatchSize());
    const xhr = new XMLHttpRequest();
    xhr.open('POST', SERVER + '/api/files');
    xhr.responseType = 'json';
    // a stalled transfer must not hang forever — generous (5 min) so legitimate
    // large files over slow Wi-Fi still complete
    xhr.timeout = 300000;
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const p = Math.round((e.loaded / e.total) * 100);
      transferProgress(label, p);
      transferA11y(label, p);
    };
    xhr.onload = () => {
      transferEnd(label);
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else { const err = new Error('upload failed ' + xhr.status); err.status = xhr.status; reject(err); }
    };
    xhr.onerror = () => { transferEnd(label); reject(new Error('network'));
    };
    xhr.ontimeout = () => { transferEnd(label); reject(new Error('timeout')); };
    const fd = new FormData();
    fd.append('dir', 'phone'); // direction badge on the PC (declared BEFORE the file part)
    fd.append('file', blob, label);
    xhr.send(fd);
  });
}
let fileFlushing = false;
async function flushFileQueue() {
  if (fileFlushing || !fileDb) return;
  fileFlushing = true;
  try {
    const items = await fqueueAll();
    // the strip's "n/N" counter needs the size of the batch it is reporting on
    transferBatchRemaining = items.length;
    for (const job of items) {
      const v = job.value;
      // same policy as the photo outbox: PPQueue (unit-tested)
      if (PPQueue.decide(v) !== 'send') continue;
      try {
        await uploadFileXHR(v.blob, v.name);
        await fqueueDelete(job.key);
      } catch (e) {
        const book = PPQueue.onFailure(v, e.status);
        // poisonReason MUST ride along here too: unpoison() revives any
        // tries=999 item without it, so a file the server measured as too
        // large would otherwise be re-uploaded from scratch every boot.
        const extra = book.poisoned ? { poisonReason: 'too-large' } : {};
        await new Promise(resolve => {
          const tx = fileDb.transaction('fqueue', 'readwrite');
          tx.objectStore('fqueue').put({ ...v, tries: book.tries, lastAttempt: book.lastAttempt, ...extra }, job.key);
          tx.oncomplete = resolve; tx.onerror = resolve;
        });
        if (book.poisoned) { flash(`“${v.name}” is over the size cap`); }
        else break; // transient failure — wait for the next tick
      }
    }
  } finally {
    fileFlushing = false;
    transferBatchRemaining = 0;
    const n = await fqueueCount();
    const el = $('#file-queued');
    el.classList.toggle('hidden', !n);
    if (n) {
      el.replaceChildren(
        Object.assign(document.createElement('i'), { className: 'ic ic-file' }),
        document.createTextNode(` ${n} file(s) queued — will send automatically`)
      );
    } else {
      el.replaceChildren();
    }
  }
}
async function sendFiles(files) {
  const jobs = [...files].filter(f => f && f.size > 0);
  if (!jobs.length) return;
  // 2 concurrent sends — the same pool the photo path (handleFiles) and the PC
  // file path (uploadAnyFiles) already use. One-at-a-time made a 6-file pick
  // take ~6x a single upload over the mobile radio.
  let qi = 0;
  transferBatchRemaining = jobs.length;
  const worker = async () => {
    while (qi < jobs.length) {
      const f = jobs[qi++];
      try {
        await uploadFileXHR(f, f.name);
        flash(`Sent ${f.name} ✓`);
      } catch (e) {
        // lastAttempt: 0 — the item must be sendable the MOMENT connectivity
        // returns. (lastAttempt: Date.now() made every freshly queued file sit
        // out the 5s backoff window even after the server came back.)
        const key = await fqueueAdd({ blob: f, name: f.name, tries: 0, lastAttempt: 0 });
        if (key == null) flash(`Could not queue ${f.name} — try again when online`);
        else {
          flash(`Offline — ${f.name} queued`);
          if (e && e.status === 413) flash(`${f.name} is over the size cap — queued anyway`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, worker));
  transferBatchRemaining = 0;
}
$('#file-input').onchange = e => {
  const fs = [...e.target.files];
  e.target.value = '';
  if (fs.length) sendFiles(fs);
};

// ---------- transferred files (BOTH directions): chips + Save/Open sheet ----------
const xferFiles = []; // { id, name, bytes, mime, dir, created_at }
function fmtFb(b) {
  if (b == null) return '';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}
function chipTimestamp(s) {
  const d = s ? new Date(String(s).replace(' ', 'T') + 'Z') : null;
  return d && !isNaN(d) ? d.getTime() : 0;
}
function chipHHMM(sql) {
  const ts = chipTimestamp(sql);
  return ts ? new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
}
function markChipNew(el) {
  el.classList.add('chip-new');
  setTimeout(() => el.classList.remove('chip-new'), 240);
}
function fileChip(f) {
  const chip = document.createElement('div');
  chip.className = 'file-chip';
  chip.dataset.id = String(f.id);
  const fromPc = f.dir !== 'phone';
  const thumb = document.createElement('span');
  thumb.className = 'f-thumb ' + (fromPc ? 'pc' : 'phone');
  thumb.setAttribute('aria-hidden', 'true');
  const ico = document.createElement('i');
  ico.className = 'ic ic-file';
  thumb.appendChild(ico);
  const meta = document.createElement('div');
  meta.className = 'f-meta';
  const nm = document.createElement('div');
  nm.className = 'f-name';
  nm.textContent = f.name;
  const sub = document.createElement('div');
  sub.className = 'f-sub';
  const when = chipHHMM(f.created_at);
  sub.textContent = when ? `${fmtFb(f.bytes)} · ${when}` : fmtFb(f.bytes);
  meta.append(nm, sub);
  const badge = document.createElement('span');
  badge.className = 'chip-badge ' + (fromPc ? 'pc' : 'phone');
  badge.title = fromPc ? 'Sent from your PC' : 'Sent from this phone';
  const badgeIc = document.createElement('i');
  badgeIc.className = `ic ${fromPc ? 'ic-pc' : 'ic-phone'}`;
  badgeIc.setAttribute('aria-hidden', 'true');
  badge.append(badgeIc, document.createTextNode(fromPc ? 'PC' : 'Phone'));
  chip.append(thumb, meta, badge);
  chip.onclick = () => openFileSheet(f);
  chipA11y(chip, `${fromPc ? 'File from your PC' : 'File sent to your PC'}: ${f.name} — open actions`);
  attachChipSwipe(chip, {
    msg: `Removed “${f.name}”`,
    perform: () => deleteServerFile(f),
    lane: '#files',
    chipSel: '.file-chip',
  });
  stampSort(chip, { ts: chipTimestamp(f.created_at), name: f.name });
  markChipNew(chip);
  return chip;
}
let filesVersion = -1;
let filesBefore = null;
let filesMoreAvailable = false;
let filesLoadBusy = false;
function updateFilesLoadMore() {
  const more = $('#files-load-more');
  if (!more) return;
  more.classList.toggle('hidden', !filesMoreAvailable);
  more.disabled = filesLoadBusy;
  more.textContent = filesLoadBusy ? 'Loading older transfers…' : 'Load older transfers';
}
async function loadFiles(force = false, older = false) {
  if (chipSwiping || undoIsFile()) { filesDirty = true; return; }
  if (filesLoadBusy || (older && filesBefore === null)) return;
  filesLoadBusy = true;
  updateFilesLoadMore();
  try {
    if (!older) {
      const v = await fetch(`${SERVER}/api/files/version`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok ? r.json() : null);
      if (!force && v && v.latest === filesVersion) return;
      if (v) filesVersion = v.latest;
    }
    const q = older && filesBefore !== null
      ? `?before=${encodeURIComponent(filesBefore)}&limit=20`
      : '?limit=20';
    const list = await fetch(`${SERVER}/api/files${q}`, { signal: AbortSignal.timeout(4000) }).then(r => {
      if (!r.ok) throw 0;
      return r.json();
    });
    if (older) {
      const have = new Set(xferFiles.map(f => f.id));
      renderFiles(xferFiles.concat(list.filter(f => !have.has(f.id))));
    } else {
      filesBefore = null;
      renderFiles(list);
    }
    filesBefore = list.length ? list[list.length - 1].id : filesBefore;
    filesMoreAvailable = list.length === 20;
  } catch {}
  finally {
    filesLoadBusy = false;
    updateFilesLoadMore();
  }
}
$('#files-load-more').onclick = () => loadFiles(false, true);
function renderFiles(list) {
  const box = $('#files');
  const incoming = new Map(list.map(f => [String(f.id), f]));
  const existing = new Map();
  for (const child of [...box.children]) {
    if (!child.classList.contains('file-chip')) continue;
    if (!incoming.has(child.dataset.id)) child.remove();
    else existing.set(child.dataset.id, child);
  }
  let cursor = box.firstElementChild;
  for (const f of list) {
    const id = String(f.id);
    const chip = existing.get(id) || fileChip(f);
    if (chip !== cursor) box.insertBefore(chip, cursor);
    cursor = chip.nextElementSibling;
  }
  box.classList.toggle('hidden', !list.length);
  if (sortMode !== 'new') applySort(box);
  xferFiles.length = 0;
  xferFiles.push(...list);
}

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
let sheetFile = null;
let sheetReturnFocus = null;
function openFileSheet(f) {
  sheetFile = f;
  $('#file-sheet-name').textContent = f.name;
  // arrival context: when it landed, not just what it is
  const when = f.created_at ? new Date(f.created_at.replace(' ', 'T') + 'Z') : null;
  const whenTxt = when && !isNaN(when)
    ? ' · ' + when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '';
  $('#file-sheet-sub').textContent = fmtFb(f.bytes)
    + (f.dir === 'phone' ? ' · sent from this phone' : ' · from your PC') + whenTxt;
  $('#file-sheet').classList.remove('hidden');
  sheetReturnFocus = document.activeElement;
  trapPhone($('#file-sheet'), $('#file-sheet-close'));
  syncOverlayHistory();
}
function closeFileSheet() {
  $('#file-sheet').classList.add('hidden');
  sheetFile = null;
  const back = sheetReturnFocus;
  sheetReturnFocus = null;
  untrapPhone($('#file-sheet'), back);
  syncOverlayHistory();
}
$('#file-sheet-close').onclick = closeFileSheet;
$('#file-sheet').onclick = e => { if (e.target.id === 'file-sheet') closeFileSheet(); };
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || confirmOpen()) return; // same: only the top layer
  if (!$('#file-sheet').classList.contains('hidden')) closeFileSheet();
});
$('#file-sheet-save').onclick = () => {
  if (!sheetFile) return;
  // download attribute: server sends attachment-disposition for non-media anyway
  const a = document.createElement('a');
  a.href = `${SERVER}/file/${sheetFile.id}`;
  a.download = sheetFile.name || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  closeFileSheet();
  flash('Saving…');
};
$('#file-sheet-open').onclick = () => {
  if (!sheetFile) return;
  // inline for media/pdf (server sets inline disposition), else downloads
  window.open(`${SERVER}/file/${sheetFile.id}`, '_blank', 'noopener');
  closeFileSheet();
};

// ---------- inputs ----------
// A <label> wrapping a hidden file input is not focusable, so Capture / Choose
// photos / File were unreachable with a keyboard or a switch device — and the
// .shutter / .alt-btn :focus-visible rings in phone.css could never match.
// role=button + tabindex make them focusable; Enter/Space forwards to
// el.click(), which is the label's own tap path — nothing extra is added to
// the capture/upload path itself.
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
activateOnKey($('#outbox-info')); // tap-to-retry the queues, reachable by keyboard
$('#cam').onchange = e => { handleFiles([...e.target.files]); e.target.value = ''; };
$('#gallery').onchange = e => { handleFiles([...e.target.files]); e.target.value = ''; };

// ---------- open latest on PC ----------
$('#open-latest').onclick = async () => {
  try {
    await fetch(SERVER + '/api/open-latest', { method: 'POST', signal: AbortSignal.timeout(3000) });
    flash('Sent — the PC harness will open it (tab must be open)');
  } catch { flash('Offline'); }
};

// ---------- live updates from PC (paste/drop/text uploads) ----------
try {
  // `device=phone` labels this stream so the server can treat it as the phone's
  // live wire: while it is open the phone is HERE, and its close (page closed,
  // app killed, network gone) is what brings the pairing QR back on the PC in
  // seconds instead of after the 90s ping window. See server/sse.js.
  const es = new EventSource(SERVER + '/events?device=phone');
  es.onopen = () => { sseLive = true; everConnected = true; setStatus('ok', 'connected'); loadRecent(); };
  es.onerror = () => {
    sseLive = false;
    // a never-paired phone is not "reconnecting" — it never connected, and the
    // SSE error fires before the first poll can say so
    if (everConnected) setStatus('warn', 'reconnecting…');
    else { setStatus('off', 'not paired'); setStatusSub('scan the QR on your PC · same Wi-Fi'); }
  };
  es.onmessage = e => {
    // events are JSON ({type, ...}); plain strings fall back for safety
    let m; try { m = JSON.parse(e.data); } catch { m = { type: e.data }; }
    if ((m.type === 'capture-ready' || m.type === 'capture') && m.capture?.file) {
      addRemoteRecent(m.capture, { live: true }); // just arrived — animate it in
      if (m.capture.origin === 'pc') {
        textRenderSignature = '';
        loadTexts();
        if (m.type === 'capture-ready') flash('New capture from PC');
      }
      recentEmptyUI();
      scheduleTotalBytes();
    }
    if (m.type === 'file' && m.row && m.row.id != null) {
      // both directions land in the files lane; only a PC send needs a flash
      // (a phone send already flashed "Sent … ✓" when it left)
      if (m.row.id > filesVersion) filesVersion = m.row.id;
      xferFiles.unshift(m.row);
      if (undoIsFile()) filesDirty = true; else renderFiles(xferFiles);
      if (m.row.dir === 'pc') flash(`${m.row.name} — from your PC`);
    }
    // A coalesced batch (the PC's new bulk delete, the cap sweeper) may carry
    // `ids` instead of one `id` — accept both, so N deleted rows cost one event
    // and no list refetch. Neither payload present = the old bare batch event.
    const goneIds = m.type === 'file-deleted'
      ? (Array.isArray(m.ids) && m.ids.length ? m.ids : (m.id != null ? [m.id] : null))
      : null;
    if (goneIds) {
      const gone = new Set(goneIds.map(Number));
      const next = xferFiles.filter(f => !gone.has(Number(f.id)));
      if (undoIsFile()) filesDirty = true; else renderFiles(next);
    } else if (m.type === 'file-deleted') {
      // A payload-less sweep event; reconcile once.
      loadFiles(true);
    }
    if (m.type === 'capture' || m.type === 'capture-ready') {
      recentVersion = Math.max(recentVersion, Number(m.capture.id) || 0);
    }
    if (m.type === 'deleted') { loadRecent(true); scheduleTotalBytes(); }
    if (m.type === 'text') loadTexts();
    if (m.type === 'settings') { // PC flipped a shared toggle — bundle is the source
      applyServerSettings(m);
    }
  };
} catch {}

// ---------- text sync ----------
// receive from PC: chips, tap to copy (execCommand fallback works over http)
// PC-sent CAPTURES (/media/ URLs) render as image chips with a PC badge and
// preview in the in-app viewer — no new browser tab, no copy-only confusion
const pcMediaItems = []; // { file, url, blob, fullUrl, remote: true }
// capture files confirmed deleted on the PC during THIS session — the server
// purges their text rows too, but an offline straggler must not re-render as
// a chip that can only 404 in the viewer
const deadPcMedia = new Set();
// bound: every capture deleted on the PC this session lands here; a long
// session must not grow the set forever (oldest-first eviction — a re-appearing
// straggler just re-adds itself on the next 404).
const DEAD_PC_MEDIA_MAX = 200;
function markDeadPcMedia(file) {
  deadPcMedia.add(file);
  if (deadPcMedia.size > DEAD_PC_MEDIA_MAX) deadPcMedia.delete(deadPcMedia.values().next().value);
}
function pcMediaFor(file, url) {
  let item = pcMediaItems.find(i => i.file === file);
  if (!item) {
    item = { file, url, blob: null, fullUrl: null, remote: true, sent: true };
    pcMediaItems.unshift(item);
    if (pcMediaItems.length > 24) {
      const old = pcMediaItems.pop();
      if (viewerBlob === old.blob) hideViewer();
      if (old.fullUrl) URL.revokeObjectURL(old.fullUrl);
    }
  }
  return item;
}
async function openViewerRemote(item) {
  viewerItems = item.remoteList || (recentItems.includes(item) ? recentItems : pcMediaItems);
  viewerIdx = viewerItems.indexOf(item);
  updateViewerPos();
  if (!item.blob) {
    flash('Loading…');
    try {
      const r = await fetch(item.url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
      item.blob = await r.blob();
    } catch (e) {
      if (e && e.status === 404) {
        // the capture was deleted on the PC — its text row is purged too, so
        // this chip is a straggler (offline, or a row older than the purge).
        // Drop it instead of flashing a misleading connection error forever.
        markDeadPcMedia(item.file);
        const idx = pcMediaItems.indexOf(item);
        if (idx >= 0) {
          pcMediaItems.splice(idx, 1);
          revokeObjectUrl(item.fullUrl);
        }
        textRenderSignature = '';
        loadTexts();
        flash('This capture was deleted on the PC');
      } else {
        flash('Load failed — check the connection');
      }
      // a failed load after a swipe-commit leaves the old image mid-exit;
      // reset the stage transform so the viewer isn't stuck off-screen
      viewerZoom = { scale: 1, tx: 0, ty: 0 };
      viewerImg.classList.add('gesturing');
      applyViewerZoom();
      viewerItems = null;
      return;
    }
  }
  // tiff/heic captures: the fetched "original" can't be rendered by this
  // browser (no tiff/heic decode on most phones) — the viewer would show a
  // broken image. The tile's thumbnail is a PNG the server derived for
  // exactly this case; show it full-size instead of the raw original.
  if (item.blob && item.blob.type && /^image\/(tiff|hei[cf])$/i.test(item.blob.type)) {
    item.fullUrl = item.thumbUrl || item.url;
    viewerBlob = null; // download button has nothing meaningful to save on a phone
    showViewer(item);
    animateViewerIn();
    flash('No in-browser preview for this format — thumbnail shown');
    $('#viewer-del').classList.toggle('hidden', !viewerCanDelete(item));
    viewerRetryFn = null;
    viewerDiscardFn = null;
    return;
  }
  showViewer(item);
  animateViewerIn();
  const needsRetry = !item.sent;
  $('#viewer-retry').classList.toggle('hidden', !needsRetry);
  $('#viewer-discard').classList.toggle('hidden', !needsRetry);
  $('#viewer-del').classList.toggle('hidden', !viewerCanDelete(item));
  viewerRetryFn = needsRetry ? async () => { hideViewer(); await retryItem(item); } : null;
  viewerDiscardFn = null;
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
// `chip` exists so the MANUAL path can be unlocked on failure: chip text is not
// selectable on purpose (an app-like surface shouldn't start a selection on a
// long-press), so "long-press the text" would be a dead end unless this flips
// that one chip back on. The app's own copy path is tried first, always.
async function tapCopyText(text, chip) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch { ok = copyTextFallback(text); }
  if (ok) { flash('Copied ✓ — paste anywhere'); return; }
  chip?.classList.add('chip-manual'); // this chip is selectable from now on
  flash('Copy blocked — long-press the text to select it');
}
// ---------- swipe (down) to delete a PC-sent chip ----------
// One gesture, two row types: text/image chips (#text-in) delete a text row via
// /api/text/:id; file chips (#files, either direction) delete the file via
// /api/files/:id. A
// vertical drag reddens the row progressively (--del 0→1, painted as an inset
// box-shadow so the label stays legible) and, past the threshold, collapses it
// and opens an undo window (the DELETE itself is deferred — see startUndoWindow).
// Horizontal drags are left to the strip's native scroll: the gesture is only
// taken over (preventDefault) after it locks vertical, so scrolling and deleting
// never fight over the same touch.
const CHIP_DEL_PX = 72;   // downward travel that arms the delete
const CHIP_AXIS_PX = 12;  // movement before an axis is chosen (a tap can drift)
let chipSwiping = false;  // a chip gesture is active — don't re-render its lane
let textsDirty = false;   // a list change arrived mid-gesture — reload after it
let filesDirty = false;   // (same, for the PC-files lane / an open undo window)
// one-time affordance: the gesture is invisible until you know it exists.
// ONE element now — see updateInbox() for why.
function dismissChipHint() {
  try { localStorage.pp_chip_hint = '1'; } catch {}
  $('#chip-hint')?.classList.add('hidden');
}
// a text that arrived during a gesture must not be dropped on the floor
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
// ---------- undo window for chip deletes ----------
// The DELETE is deferred until the window closes. A text row could be re-created,
// but a PC-sent file's bytes can't (the phone never holds them), so "Undo" has to
// mean "never delete". One window at a time; opening a new one commits the old.
// If the app is closed mid-window the row simply stays — the fail-safe direction.
const UNDO_MS = 6000;
let undoPending = null; // { lane, perform, restore }
let undoTimer = 0;
const undoIsFile = () => !!(undoPending && undoPending.lane === '#files');
function hideUndoToast() {
  $('#undo-toast')?.classList.add('hidden');
  const btn = $('#undo-toast-btn');
  if (btn) btn.onclick = null;
}
// flushes only once no window is open — a new window owns the next reload
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
  settleUndo(true); // an earlier pending delete commits before this one starts
  const toast = $('#undo-toast');
  if (!toast) { perform(); return; } // older shell without the node — just delete
  undoPending = { lane, perform, restore };
  $('#undo-toast-msg').textContent = msg;
  const bar = toast.querySelector('.undo-bar');
  if (bar) { // restart the countdown bar from full
    bar.style.animation = 'none';
    void bar.offsetWidth; // reflow between the two writes, or the restart is a no-op
    bar.style.animation = '';
    bar.style.animationDuration = UNDO_MS + 'ms';
  }
  $('#undo-toast-btn').onclick = () => { settleUndo(false); flash('Restored ✓'); };
  toast.classList.remove('hidden');
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
    loadTexts(); // the server still has it — put the chip back
  }
}
// FILE chips (either direction): same gesture, but the row it removes is /api/files/:id
async function deleteServerFile(f) {
  if (!f || f.id == null) return;
  dismissChipHint();
  try {
    const r = await fetch(`${SERVER}/api/files/${encodeURIComponent(f.id)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw 0;
    const i = xferFiles.findIndex(x => x.id === f.id);
    if (i >= 0) xferFiles.splice(i, 1); // keep the local list in step (SSE may be down)
    flash('File removed');
  } catch {
    flash('Delete failed — offline?');
    loadFiles(true); // the server still has it — put the chip back
  }
}
// generic swipe-down-to-delete for a chip row. `lane` is the container the chip
// lives in (mask/empty-state) and `chipSel` is how to tell if any chip remains.
// `perform` runs the real delete when the undo window closes; `restore` re-inserts
// the row if the user taps Undo.
function attachChipSwipe(el, { msg, perform, lane = '#text-in', chipSel = '.text-chip' }) {
  let x0 = 0, y0 = 0, dy = 0, axis = null, raf = 0;
  const CHIP_Y_MAX = 30; // px of visible travel (the strip clips below its lane)
  // rAF coalesces the per-move style writes into one write per frame
  const paint = () => {
    raf = 0;
    const p = Math.min(1, dy / CHIP_DEL_PX);
    el.style.setProperty('--del', p.toFixed(3));
    // red ramps to full BEFORE the travel cap, then the pill fades — the pill
    // never slides out of its lane, so the whole gesture stays visible
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
    setTimeout(clear, 260); // fallback: reduced motion kills transitionend
  };
  // animate the row out and detach it — the server delete is NOT here; the undo
  // window owns it (see startUndoWindow). cancelDrop lets a fast Undo undo the
  // detach itself (otherwise the queued drop would yank the restored row again).
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
    const timer = setTimeout(drop, 340); // fallback: reduced motion kills animationend
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
      // lock once: a clearly-downward drag takes the gesture, a sideways (or
      // diagonal) drag hands it straight back to the strip's horizontal scroll.
      // The 1.2x dominance test keeps a mostly-horizontal flick from deleting.
      axis = raw > 0 && raw > Math.abs(dx) * 1.2 ? 'v' : 'x';
      // A lane that can still scroll VERTICALLY keeps its drag: only a pull with
      // nowhere to go is a delete. Both lanes are horizontal now (the files lane
      // is a sideways strip), so scrollTop is 0 and a downward drag always arms
      // — correct, because vertical has nowhere to go in either lane. The check
      // stays for any future vertical lane.
      if (axis === 'v') {
        const box = $(lane);
        if (box && box.scrollTop > 0 && box.scrollHeight > box.clientHeight) axis = 'x';
      }
      if (axis === 'x') return;
      dismissChipHint(); // the user found the gesture — stop advertising it
      chipSwiping = true;
      el.classList.remove('snap');
      el.classList.remove('chip-new'); // a finished entrance animation would keep overriding the drag transform
      el.classList.add('swiping');
      $(lane)?.classList.add('swiping');
    }
    if (axis !== 'v') return;
    e.preventDefault(); // own the vertical drag (stops any native pan/rubber-band)
    // past the threshold, add resistance instead of a hard stop
    dy = raw > CHIP_DEL_PX ? CHIP_DEL_PX + (raw - CHIP_DEL_PX) * 0.25 : Math.max(0, raw);
    if (!raf) raf = requestAnimationFrame(paint);
  }, { passive: false });
  // The armed path, shared by the swipe and the keyboard (Delete/Backspace):
  // remove the row now, but hold the DELETE until the undo window closes.
  const runDelete = () => {
    dismissChipHint();
    const box = $(lane);
    const next = el.nextSibling; // where to put it back on Undo
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
  // Keyboard/AT: the gesture is unreachable without a touchscreen, so a focused
  // chip deletes with Delete/Backspace through the exact same deferred path
  // (collapse + undo window). addEventListener, not onkeydown — chipA11y owns
  // the Enter/Space handler on the same element.
  el.addEventListener('keydown', e => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (el.classList.contains('deleting')) return;
    e.preventDefault(); // Backspace must never navigate back
    runDelete();
  });
  const end = () => {
    if (axis !== 'v') { stop(); flushPendingLists(); return; }
    const armed = dy >= CHIP_DEL_PX;
    // A deliberate drag must never fall through to the chip's tap handler; a
    // short drift must, or a tap that moved a few px silently does nothing.
    if (armed) el.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); }, { capture: true, once: true });
    stop();
    if (!armed) { spring(); flushPendingLists(); return; }
    runDelete();
  };
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', () => { if (axis === 'v') spring(); stop(); flushPendingLists(); });
}

// text chips are non-focusable divs with click handlers — give them the same
// role/tabindex/Enter handling the recent tiles already have
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
    const item = pcMediaFor(file, `${location.origin}/media/${encodeURIComponent(file)}`);
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
// One order for all three received-content surfaces: the Recent grid and both
// strips. Remembered per device — the same convention as pp_sort on the PC
// harness, so flipping the order once survives a reload.
const SORT_KEY = 'pp_phone_sort';
const SORT_MODES = ['new', 'old', 'name'];
let sortMode = 'new';
try {
  const saved = localStorage.getItem(SORT_KEY);
  if (SORT_MODES.includes(saved)) sortMode = saved;
} catch {}

// Each renderer stamps a comparable key onto the chip/tile as it builds it, so
// sorting is a pure DOM reorder off dataset — never a re-fetch, and never a
// re-parse of the visible label (times are 12-hour and localized).
// `seq` is the server row id. It is the STABILITY key, not a cosmetic one: a
// bulk insert (or a same-second batch) gives many rows an identical timestamp,
// and falling through to the name on a tie would silently turn "Newest" into
// "A→Z". The id preserves the server's own arrival order instead.
function stampSort(el, { ts, name, seq }) {
  el.dataset.sortTs = String(ts || 0);
  el.dataset.sortSeq = String(seq == null ? 0 : seq);
  // lower-case and NFD-folded so "É" and "e" sort together instead of after "z"
  el.dataset.sortName = String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return el;
}
function sortComparator(a, b) {
  const an = a.dataset.sortName || '', bn = b.dataset.sortName || '';
  const at = Number(a.dataset.sortTs) || 0, bt = Number(b.dataset.sortTs) || 0;
  const as = Number(a.dataset.sortSeq) || 0, bs = Number(b.dataset.sortSeq) || 0;
  // ties are always broken by arrival order, in the direction the mode implies
  const bySeq = (x, y) => (sortMode === 'old' ? x - y : y - x);
  if (sortMode === 'old') return at - bt || bySeq(as, bs);
  if (sortMode === 'name') {
    // rows with no server name (a bare text) fall in behind the named ones
    if (!an && bn) return 1;
    if (an && !bn) return -1;
    return an.localeCompare(bn) || bt - at || bySeq(as, bs);
  }
  return bt - at || bySeq(as, bs); // 'new'
}
// Reorder one container in place. Only re-inserts nodes whose position actually
// changed, so an already-sorted strip is left untouched (no scroll jump, no
// re-triggered CSS entry animations).
function applySort(box) {
  if (!box || box.children.length < 2) return;
  const desired = [...box.children].sort(sortComparator);
  const current = [...box.children];
  if (desired.every((el, i) => el === current[i])) return;
  // one DocumentFragment append: a single reflow instead of N reinserts
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
    // queue it like photos — it will go out when the connection returns
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
  autoGrowText(); // shrink back to one line — the field keeps its grown height
  if (document.body.classList.contains('text-mode')) setTextMode(false);
}
$('#text-send').onclick = sendText;
$('#text-input').addEventListener('keydown', e => {
  // IME: the Enter that COMMITS a candidate is part of composition. Sending on
  // it shipped a half-composed string (any CJK/IME keyboard) and cleared the
  // field mid-word.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendText(); return; }
  if (e.key === 'Enter' && !e.shiftKey && $('#text-input').classList.contains('expanded')) return; // expanded: Enter = newline
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});
// Auto-grow to the SAME 150px ceiling as the PC harness. The phone used to stay
// a fixed 40px unless it was in expanded mode, so a long message scrolled inside
// a one-line box while the harness grew under the same fingers. Coalesced to one
// measure+write per frame for the same reason as the harness: height:auto →
// read scrollHeight → write height is a forced synchronous layout per keystroke.
const TEXT_AUTOGROW_MAX = 150;
let textResizeRaf = 0;
function autoGrowText() {
  if (textResizeRaf) return;
  textResizeRaf = requestAnimationFrame(() => {
    textResizeRaf = 0;
    const input = $('#text-input');
    // with the soft keyboard up the CSS gives the field the whole panel — an
    // inline height would out-specify it and freeze the field at 150px
    if (document.body.classList.contains('kb-open') || document.body.classList.contains('text-mode')) { input.style.height = ''; return; }
    input.style.height = 'auto';
    input.style.height = Math.min(TEXT_AUTOGROW_MAX, Math.max(40, input.scrollHeight)) + 'px';
  });
}
// thin one-line field by default; the chevron expands it into a drafting box
// (the chevron sits INSIDE the field box, so keep pointerdown from blurring the
// field and dismissing the keyboard on the way to the toggle)
$('#text-expand').addEventListener('pointerdown', e => e.preventDefault());
$('#text-expand').onclick = () => {
  const input = $('#text-input');
  const expanded = input.classList.toggle('expanded');
  // A stale inline height would out-specify the .expanded height. Expanded sits
  // AT the ceiling (CSS), so only collapsing needs to shrink back to content.
  if (expanded) {
    input.style.height = '';
    if (textResizeRaf) { cancelAnimationFrame(textResizeRaf); textResizeRaf = 0; }
  } else autoGrowText();
  $('#text-expand').setAttribute('aria-expanded', String(expanded));
  if (expanded) input.focus();
};
$('#text-input').addEventListener('input', () => {
  syncComposerState();
  // expanded holds the ceiling, so growing it would collapse it back to 40px
  if ($('#text-input').classList.contains('expanded')) return;
  autoGrowText();
});
// ---------- share target: Android "Share → ProofPipe" lands here ----------
const shareParams = new URLSearchParams(location.search);
// legacy fallback: an OLD installed manifest still uses GET title/text/url.
// New manifests POST to /share (files + text), so this only fires for stale
// cached manifests that haven't re-fetched yet — keep it for smooth upgrade.
const sharedText = shareParams.get('text') || shareParams.get('title') || '';
if (sharedText) {
  (async () => {
    try {
      await fetch(`${SERVER}/api/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: sharedText, source: 'phone' }),
        signal: AbortSignal.timeout(8000),
      });
      history.replaceState(null, '', '/phone'); // clean the URL
      flash('Shared to PC ✓');
      setTimeout(loadTexts, 300); // refresh PC-text chips only
    } catch {
      flash('Offline — share not sent, try again');
    }
  })();
} else if (shareParams.get('shared') === '1') {
  // the server handled a POST share and 303'd back here — images stored on
  // the PC, text posted; just acknowledge and clean the URL
  history.replaceState(null, '', '/phone');
  setTimeout(() => flash('Shared to PC ✓'), 600); // after the page settles
  setTimeout(loadTexts, 400);
} else if (shareParams.get('shared') === 'error') {
  history.replaceState(null, '', '/phone');
  setTimeout(() => flash('Share failed on the PC — try again'), 600);
}

// ---------- auto-paste toggle click ----------
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

// ---------- auto-cleanup toggle (same server flag as the PC; syncs via SSE) ----------
$('#autocleanup').onclick = async () => {
  const b = $('#autocleanup');
  const next = b.getAttribute('aria-checked') !== 'true';
  b.setAttribute('aria-checked', String(next)); // optimistic; SSE corrects if the save failed
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

// ---------- transfer-quality control (More menu, same server flag as the PC) ----------
// ONE place that folds a /api/quality or settings-bundle `quality` payload into
// local state. maxPixels is applied only when the payload actually carries it:
// the POST echoes reply { ok, on, level } and must not zero out a ceiling it
// never mentioned — the ceiling is what a later refusal quotes, and a zeroed one
// would make the phone stop naming a limit it knows perfectly well.
function applyQualityPayload(s) {
  if (!s) return;
  settings.qualityReduce = s.on === true;
  settings.qualityLevel = Math.min(100, Math.max(1, Math.round(Number(s.level) || 80)));
  const mp = Math.round(Number(s.maxPixels));
  if (Number.isFinite(mp) && mp > 0) settings.maxPixels = mp;
  saveQualityLocal();
}
// What to tell the user when the PC refuses a photo for being too many pixels
// (413 "too many pixels", server/store.js MAX_PIXELS). It is TERMINAL: re-sending
// the same bytes can never work, and the one lever that fixes it is the quality
// setting — which resizes — so name that rather than "try again". This message is
// the ONLY thing maxPixels is for, and it is why the server publishes the number
// at all: with no size limit anywhere else in this file, "too big" has to say how
// big. The ceiling is quoted only once the server has actually sent it (0 = not
// told yet) — inventing a number here would be the same guess that caused the
// silent downscale this replaced.
function tooManyPixelsMsg() {
  const mp = settings.maxPixels > 0 ? ` (over ${Math.round(settings.maxPixels / 1e6)}MP)` : '';
  return `Too big for the PC${mp} — turn on Reduce image quality to send it`;
}
async function loadQuality() {
  try {
    const r = await fetch(`${SERVER}/api/quality`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return;
    applyQualityPayload(await r.json());
  } catch {} // offline: cached values keep behavior consistent
  qualityUI();
}
function qualityUI() {
  $('#quality-toggle').setAttribute('aria-checked', String(settings.qualityReduce === true));
  $('#quality-level').value = String(settings.qualityLevel);
  $('#quality-level-val').textContent = String(settings.qualityLevel);
  $('#quality-level-row').classList.toggle('hidden', !settings.qualityReduce); // slider only when on
}
$('#quality-toggle').onclick = async () => {
  const next = $('#quality-toggle').getAttribute('aria-checked') !== 'true';
  $('#quality-toggle').setAttribute('aria-checked', String(next)); // optimistic
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
// slider: live local echo while dragging; debounce the server write to one
// request per pause (a drag fires dozens of input events)
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
  // settings SSE includes the same bundle as GET /api/settings; apply it
  // directly instead of three GETs on every PC toggle. This is a read-path
  // optimization only — writes and the auto-paste flag semantics are unchanged.
  if (s.autoPaste) {
    autoPaste = s.autoPaste.auto === true;
    autoPasteUI();
    try { localStorage.setItem(AP_KEY, autoPaste ? '1' : '0'); } catch {}
  }
  if (s.autoCleanup) {
    $('#autocleanup').setAttribute('aria-checked', String(s.autoCleanup.on === true));
    // the PC shows the resolved cap next to its toggle; the phone said
    // "80% storage" with no number anywhere on the page
    if (s.autoCleanup.cap) $('#autocleanup-sub').textContent = `drops oldest captures past 80% of ${fmtBytes(s.autoCleanup.cap)}`;
  }
  if (s.quality) {
    applyQualityPayload(s.quality);
    qualityUI();
  }
}

// ---------- settings bundle: ONE boot read ----------
// /api/settings carries autoPaste + autoCleanup + quality — the same bundle the
// SSE 'settings' event pushes — so boot no longer fires three separate GETs
// (/api/autopaste, /api/autocleanup, /api/quality) for data one request already
// returns. The per-setting loaders remain only as failure-path re-syncs.
async function loadSettings() {
  try {
    const r = await fetch(`${SERVER}/api/settings`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) { applyServerSettings(await r.json()); return; }
  } catch {}
  // offline / older server: fall back to the last known local state
  try { autoPaste = localStorage.getItem(AP_KEY) === '1'; } catch {}
  autoPasteUI();
  qualityUI();
}

// ---------- more menu (keeps destructive actions tucked away) ----------
// Anchored under the header button and opens DOWNWARD via a .open class — the
// CSS transition (opacity + transform only) handles the animation, so JS just
// flips one class and the compositor does the rest.
const moreBtn = $('#more-btn'), moreMenu = $('#more-menu');
// ONE trigger, ONE panel. The labelled "More" cell in the secondary row used to
// be a second entry point to this same sheet — it reported its own
// aria-expanded, and the outside-click handler had to exclude it by name or the
// click's bubble closed the panel it had just opened. Both problems are gone
// with the second door; the ⋮ in the status strip is the only way in.
function setMenu(open) {
  moreMenu.classList.toggle('open', open);
  moreBtn.setAttribute('aria-expanded', String(open));
  // the sheet's scroll position is fresh on every open, and its height depends
  // on what is inside it at that moment — so decide the fade here, not on load
  if (open) syncMenuEdges();
  syncOverlayHistory();
}
// The sheet scrolls but shows no scrollbar (phone.css hides it), so a fade on
// the bottom edge is the ONLY cue that more actions sit below the fold. Same
// at-bottom convention the two strips use, one axis over.
function syncMenuEdges() {
  const m = moreMenu;
  // 1px of slack: sub-pixel scroll heights would otherwise hide the cue forever
  m.classList.toggle('at-bottom', m.scrollTop + m.clientHeight >= m.scrollHeight - 1);
}
moreMenu.addEventListener('scroll', syncMenuEdges, { passive: true });
// the panel is rebuilt/relaid-out when its contents or the viewport change
new ResizeObserver(syncMenuEdges).observe(moreMenu);
window.addEventListener('resize', syncMenuEdges);
moreBtn.onclick = () => setMenu(!moreMenu.classList.contains('open'));
// tap/keydown OUTSIDE the open menu closes it — before, the only way to
// dismiss was tapping the button again (a dead tap on mobile felt broken)
document.addEventListener('click', e => {
  if (!moreMenu.classList.contains('open')) return;
  if (e.target.closest('.more-wrap')) return;
  setMenu(false);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || confirmOpen()) return; // the dialog owns Esc while it is up
  if (moreMenu.classList.contains('open')) {
    setMenu(false);
    moreBtn.focus(); // keyboard dismiss returns focus to the trigger
    return;
  }
  if (document.body.classList.contains('text-mode')) {
    setTextMode(false);
    textModeBtn?.focus();
  }
});
// picking an action closes the menu; the auto-cleanup switch stays open so
// the user sees the state change
moreMenu.addEventListener('click', e => { if (e.target.closest('.alt-btn')) setMenu(false); });

// ---------- Android Back closes the topmost overlay instead of the PWA ----------
// Each open overlay is guarded by one history entry; a Back press pops the
// guard and closes the topmost layer (viewer > file sheet > More menu).
// Closing an overlay through its own UI (✕ / Esc / backdrop) consumes the
// guard entry so the next Back exits normally. Edge case: reloading the page
// while an overlay is open restores the guard entry with nothing open — the
// first Back then pops it silently (one dead press), which is harmless.
function overlayOpen() {
  return confirmOpen()
    || !$('#viewer').classList.contains('hidden')
    || !$('#file-sheet').classList.contains('hidden')
    || document.body.classList.contains('text-mode')
    || moreMenu.classList.contains('open');
}
function closeTopOverlay() {
  // the confirm dialog is the topmost layer (z-index 400): Back must cancel it
  // rather than close the viewer/sheet underneath
  if (confirmOpen()) { closeConfirm(false); return; }
  if (!$('#viewer').classList.contains('hidden')) { hideViewer(); return; }
  if (!$('#file-sheet').classList.contains('hidden')) { closeFileSheet(); return; }
  if (document.body.classList.contains('text-mode')) { setTextMode(false); return; }
  if (moreMenu.classList.contains('open')) setMenu(false);
}
let overlayGuardBusy = false; // history.back() lands asynchronously — don't consume twice
function syncOverlayHistory() {
  if (overlayGuardBusy) return;
  if (overlayOpen()) {
    if (!history.state?.ppOverlay) history.pushState({ ppOverlay: true }, '');
  } else if (history.state?.ppOverlay) {
    overlayGuardBusy = true;
    history.back(); // consume the guard entry — its popstate finds nothing open
    addEventListener('popstate', () => { overlayGuardBusy = false; }, { once: true });
    setTimeout(() => { overlayGuardBusy = false; }, 500); // popstate may never fire (no prior entry)
  }
}
addEventListener('popstate', () => {
  if (overlayOpen()) {
    closeTopOverlay();
    // closeTopOverlay → syncOverlayHistory may ALREADY have re-armed the guard
    // (a dialog closed over a still-open viewer: the popped entry's state is
    // the viewer's own guard). Pushing again would leave a dead Back press.
    if (overlayOpen() && !history.state?.ppOverlay) history.pushState({ ppOverlay: true }, '');
  }
  // else: the guard entry was just consumed, or there was never one — let Back exit
});

// ---------- recent grid empty state ----------
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log2(n) / 10));
  const v = n / 2 ** (10 * i);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
// total stored size from /api/stats — refreshed with the count, and pushed by
// the same SSE events that refresh the grid (deleted/capture), so it never
// goes stale without a reload.
let totalBytes = 0;
// the LIBRARY count from the server — the tile strip is capped at 100, and the
// heading paired that held-tile count with a whole-library byte total
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
// SSE bursts (a 20-photo burst fires one event per capture) must not turn into
// 20 stats round-trips — coalesce to one refresh per quiet 600ms window
let bytesTimer = null;
function scheduleTotalBytes() {
  clearTimeout(bytesTimer);
  bytesTimer = setTimeout(refreshTotalBytes, 600);
}
function recentEmptyUI() {
  const count = recentItems.length;
  // While the first load is in flight the skeletons speak for the list, and on a
  // failure the error copy does — neither can share the screen with "no captures
  // yet", which is a statement about the library rather than about the request.
  const failed = !$('#recent-error')?.classList.contains('hidden');
  $('#recent-empty').classList.toggle('hidden', count > 0 || !recentLoaded || failed);
  const countEl = $('#recent-count');
  if (countEl) {
    // single value, unknown → "…" (the convention the PC sidebar stats use)
    if (!recentLoaded) countEl.textContent = '…';
    else {
      const parts = [];
      const shown = Math.max(totalCount, count); // library total wins; local tiles cover an offline server
      if (shown) parts.push(`${shown} capture${shown === 1 ? '' : 's'}`);
      if (shown && totalBytes > 0) parts.push(fmtBytes(totalBytes));
      countEl.textContent = parts.join(' · ');
    }
  }
  // cleanup entry point is pointless with an empty strip
  const cr = $('#clear-recent');
  if (cr) cr.classList.toggle('hidden', $('#recent').children.length === 0);
  // the strip's "N sent" rides the same count the heading shows
  statusDetail();
}
new MutationObserver(recentEmptyUI).observe($('#recent'), { childList: true });
refreshTotalBytes(); // initial total for the "N captures · X MB" counter

// ---------- phone-side cleanup ----------
// Clear the recent strip. Unsent photos are safe: anything that failed to
// upload already lives in the durable IndexedDB outbox and will still sync.
// The only loss risk is a failed photo with NO outbox (IndexedDB unavailable) —
// warn before dropping those.
$('#clear-recent').onclick = async () => {
  const atRisk = recentItems.filter(i => !i.sent && i.outboxKey == null).length;
  const unsent = recentItems.filter(i => !i.sent).length;
  if (atRisk > 0 && !await phoneConfirm({
    title: `${atRisk} photo(s) were never sent and are not queued offline`,
    body: 'Clearing the strip loses them for good.',
    ok: 'Clear',
  })) return;
  for (const item of [...recentItems]) {
    if (viewerBlob === item.blob) hideViewer();
    item.el.remove();
    revokeObjectUrl(item.tileUrl);
    revokeObjectUrl(item.url);
    revokeObjectUrl(item.fullUrl);
  }
  recentItems.length = 0;
  recentEmptyUI();
  flash(unsent && !atRisk ? `Cleared — ${unsent} queued photo(s) still sync` : 'Recent cleared');
};
// Clear the durable queue (same as tapping the queued-photos chip, but discoverable)
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
// Clear every capture the PC sent over (the image chips strip). This wipes the
// server-side text rows too, so the chips stay gone after a reload — and the
// PC harness history drops them as well (they were never real "texts").
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
    if (viewerBlob === item.blob) hideViewer();
    if (item.blob && item.fullUrl) URL.revokeObjectURL(item.fullUrl);
  }
  pcMediaItems.length = 0;
  const box = $('#text-in');
  box.innerHTML = '';
  box.classList.add('hidden');
  delete box.dataset.all; // retire "show older" too
  $('#text-load-more')?.classList.add('hidden');
  flash('PC captures cleared');
};

// ---------- delete all captures on the PC (with confirmation) ----------
$('#del-all').onclick = async () => {
  // a failed COUNT is not an empty library — the old `if (!n)` reported
  // "Nothing to delete" whenever the version request itself failed (same bug
  // the PC harness had)
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
// It used to open a Clear confirm: the most prominent queue affordance in the
// app invited data loss, while recovery only existed as a per-tile Retry behind
// the viewer. Clearing still lives in More options ("Clear queued photos"),
// where the destructive actions are.
$('#outbox-info').onclick = async () => {
  flash('Retrying queued items…');
  await checkServer(); // flushes the photo/text/file queues when the server answers
  const left = await outboxCount().catch(() => 0);
  flash(left ? `Still queued: ${left} photo${left === 1 ? '' : 's'}` : 'Queue synced ✓');
};// ---------- touch behavior ----------
// Refresh is intentionally not gesture-driven: document-level pull handlers
// intercepted ordinary downward swipes and could reload the PWA while the user
// was trying to browse captures. Server sync remains automatic via SSE, online,
// visibility, and the adaptive poll loop.

// ---------- keyboard mode ----------
// When the soft keyboard opens, the capture grid and secondary rows step aside
// so the text area takes their space; when it closes everything returns. No
// image or upload path is involved.
(() => {
  const vv = window.visualViewport;
  if (!vv) return; // older browsers: keep the static layout
  const input = $('#text-input');
  let open = false;
  let focused = false;
  // The keyboard only ever makes the VISUAL viewport SHORTER. The old test
  // compared vv.height to window.innerHeight — but the viewport meta sets
  // interactive-widget=resizes-content, so Chrome Android shrinks
  // window.innerHeight along with it, the ratio stayed ~1, and this swap never
  // engaged there (mobile WebKit ignores that meta, which is why it worked there).
  // Baseline against the height seen while NO text field is focused instead.
  let baseline = vv.height;
  let rebaseline = 0;
  const apply = kbOpen => {
    if (kbOpen === open) return;
    open = kbOpen;
    document.body.classList.toggle('kb-open', open);
  };
  const update = () => apply(focused && vv.height < baseline * 0.85); // ~15% = unmistakably the keyboard
  const stopRebaseline = () => { if (rebaseline) { clearTimeout(rebaseline); rebaseline = 0; } };
  input.addEventListener('focus', () => {
    stopRebaseline(); // re-focusing mid-close keeps the real (un-keyboarded) baseline
    focused = true;
    update();
  });
  input.addEventListener('blur', () => {
    focused = false;
    // Re-baseline only once the keyboard has finished closing: measuring it
    // mid-animation would record the shrunken height as "no keyboard" and mute
    // keyboard mode for the rest of the session.
    stopRebaseline();
    rebaseline = setTimeout(() => { rebaseline = 0; baseline = vv.height; apply(false); }, 350);
  });
  vv.addEventListener('resize', () => {
    if (focused) { update(); return; }
    if (rebaseline) return; // keyboard still closing — ignore those frames
    baseline = vv.height; // rotation / browser-chrome change
    apply(false);
  });
  update();
})();

// ---------- one-time unpoison migration ----------
// Items poisoned under the OLD policy (415 also set tries=999) get their life
// back; genuinely-too-large items (poisonReason 'too-large') stay poisoned.
// Runs once per boot, is a no-op for records already migrated (the revived
// ones have tries far below 999), and applies to all three queues.
async function runUnpoisonMigration() {
  let revived = 0;
  if (idb) {
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
  if (fileDb) {
    for (const job of await fqueueAll()) {
      const fix = PPQueue.unpoison(job.value);
      if (!fix) continue;
      await new Promise(resolve => {
        const tx = fileDb.transaction('fqueue', 'readwrite');
        tx.objectStore('fqueue').put({ ...job.value, ...fix, poisonReason: undefined }, job.key);
        tx.oncomplete = resolve; tx.onerror = resolve;
      });
      revived++;
    }
  }
  { // text queue (localStorage)
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
    checkServer(); // drain immediately rather than waiting for the next tick
  }
}

// ---------- boot ----------
(async () => {
  idb = await openOutbox().catch(() => null);
  fileDb = await openFileQueue().catch(() => null);
  runUnpoisonMigration().catch(() => {}); // never blocks boot; failures retry next boot
  await outboxUI();
  textQueueUI();
  recentEmptyUI();
  await loadQueuedRecent();
  await loadRecent();
  loadSettings(); // one /api/settings read covers auto-paste + auto-cleanup + quality
  loadFiles();
  // loadTexts was the one lane missing from boot: with SSE live, texts were only
  // fetched on a NEW 'text' event (or when SSE was down), so a cold load showed
  // the PC-sent captures/texts of an existing session NOWHERE until the PC sent
  // another one or the tab was hidden and re-shown.
  loadTexts();
  checkServer();
  // hidden tabs don't poll: visibilitychange re-checks the moment it's shown.
// Adaptive cadence: when SSE is live AND everything is synced (no queued
// photos/texts/files) a 10s tick buys nothing — it's a request + outbox count
// + four flush attempts forever, burning battery/radio. Poll fast (10s) only
// when SSE is down or work is pending; otherwise coast at 60s.
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
    if (document.hidden) { pollTimer = setTimeout(pollLoop, FAST_POLL); return; } // re-checked on visibilitychange
    try { await checkServer(); } catch {}
    const busy = sseLive ? await hasPendingWork().catch(() => true) : true;
    pollTimer = setTimeout(pollLoop, busy ? FAST_POLL : IDLE_POLL);
  }
  pollLoop();
})();

// flush queued photos/texts the moment connectivity returns or the PWA is
// reopened — don't make the user wait for the next 10s tick
addEventListener('online', () => checkServer());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { checkServer(); loadRecent(); loadTexts(); loadSettings(); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
