const $ = s => document.querySelector(s);
// Every harness request is bounded: a half-open LAN connection used to leave a
// fetch (and its spinner/awaited chain) hanging forever. Callers can raise the
// budget for genuinely slow operations (folder pickers, backup, relocation,
// uploads) via `timeoutMs`, or pass their own `signal` to own cancellation.
const API_TIMEOUT_MS = 15000;
const api = async (p, opt = {}) => {
  if (opt.signal) { // caller owns cancellation — don't stack a second signal
    const r = await fetch(p, opt);
    if (!r.ok) throw new Error(`${r.status} ${p}`);
    return r.json();
  }
  const { timeoutMs = API_TIMEOUT_MS, ...rest } = opt;
  const r = await fetch(p, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${r.status} ${p}`);
  return r.json();
};
const PAGE = 100;
let before = null; // keyset cursor for "load older" pagination
let moreAvailable = true;

// ---------- toasts (deduped: identical consecutive messages don't stack) ----------
// Every message is ALSO written to ONE persistent live region (#toast-announcer).
// The visible pill must not be the region: on the PC it contains the interactive
// Undo button (the phone's queue chip was fixed the same way), and a region
// created with its content already inside it is often never announced at all.
function announce(msg) {
  const el = $('#toast-announcer');
  if (el) el.textContent = msg; // persistent node — writing it is what gets read out
}
function toast(msg, ms = 2200) {
  announce(msg);
  const box = $('#toasts');
  const last = box.lastElementChild;
  if (last && last.dataset.msg === msg) { // refresh the timer instead of stacking
    clearTimeout(+last.dataset.timer);
    last.dataset.timer = setTimeout(() => { last.classList.remove('show'); setTimeout(() => last.remove(), 250); }, ms);
    return;
  }
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  t.dataset.msg = msg;
  t.dataset.timer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, ms);
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
}

// ---------- modal focus trap (lightboxes + dialogs) ----------
// While an overlay is up, Tab must cycle INSIDE it and focus must return to
// where the user came from when it closes (aria-modal="true" promises this;
// without the trap, Tab walked straight into the dimmed page behind).
// ---------- modal focus trap (a STACK of overlays) ----------
// While an overlay is up, Tab must cycle INSIDE it and focus must return to
// where the user came from when it closes (aria-modal="true" promises this).
// A STACK, not one slot: the storage-folder dialog opens from INSIDE the settings
// modal, and the single-slot version retired the settings trap for good when the
// folder dialog closed — Tab then walked into the page behind a dialog that was
// still up. Only the top entry listens. Mirrors the phone's phoneTrapStack.
let trapReturnFocus = null; // the top entry's return target (closeLightbox reads it)
const trapStack = [];
function focusablesIn(root) {
  return [...root.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter(el => el.getClientRects().length); // drops .hidden/opacity-0-invisible nodes; works for fixed overlays too (offsetParent is null there)
}
function trapFocus(container, initial) {
  const top = trapStack.at(-1);
  if (top && top.container === container) { // re-entrant open (open-latest, re-entry after delete): keep the original return target
    (initial || focusablesIn(container)[0] || container).focus({ preventScroll: true });
    return;
  }
  // a second dialog takes the keyboard; the layer below keeps its put-back target
  if (top) top.container.removeEventListener('keydown', onTrapKey);
  const returnFocus = document.activeElement;
  trapStack.push({ container, returnFocus });
  trapReturnFocus = returnFocus;
  container.addEventListener('keydown', onTrapKey);
  const f = focusablesIn(container);
  ((initial && container.contains(initial)) ? initial : f[0] || container).focus({ preventScroll: true });
}
function untrapFocus(container, restoreEl) {
  const idx = trapStack.findIndex(e => e.container === container);
  if (idx < 0) return; // not an active trap
  const [entry] = trapStack.splice(idx, 1);
  entry.container.removeEventListener('keydown', onTrapKey);
  const previous = trapStack.at(-1);
  trapReturnFocus = previous ? previous.returnFocus : null;
  const el = restoreEl || entry.returnFocus;
  if (previous) {
    previous.container.addEventListener('keydown', onTrapKey); // the dialog below resumes
    // only restore INTO the layer that is up again (the caller may hand us a
    // node from a layer that just closed)
    if (el && el.isConnected && previous.container.contains(el)) el.focus({ preventScroll: true });
    return;
  }
  if (el && el.isConnected) el.focus({ preventScroll: true });
}
function onTrapKey(e) {
  const entry = trapStack.at(-1);
  if (e.key !== 'Tab' || !entry) return;
  const container = entry.container;
  const f = focusablesIn(container);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (!container.contains(document.activeElement)) { // focus escaped (e.g. click on scrollbar) — pull it back in
    e.preventDefault();
    (e.shiftKey ? last : first).focus({ preventScroll: true });
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault(); last.focus({ preventScroll: true });
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus({ preventScroll: true });
  }
}

// ---------- Escape: only the TOP layer closes ----------
// Overlays stack (the confirm dialog opens OVER the lightbox; the folder dialog
// opens OVER the settings modal), so a single keypress must not tear two of them
// down — or key a destructive action on a grid the user cannot see. Ordered by
// the z-ladder in DESIGN.md §7. The phone does the same (closeTopOverlay).
const ESC_LAYERS = [
  ['#confirm-backdrop', 'confirm'],
  ['#dir-backdrop', 'dir'],
  ['#settings-backdrop', 'settings'],
  ['#scan-backdrop', 'scan'],
  ['#texts-backdrop', 'texts'],
  ['#lightbox', 'lightbox'],
  // the rail drawer sits BELOW every dialog on the z-ladder (320 vs 350/370/400),
  // so it is last: with Settings open over it, one Esc closes Settings.
  ['#rail-backdrop', 'rail'],
];
function escLayer() {
  for (const [sel, name] of ESC_LAYERS) if (!$(sel).classList.contains('hidden')) return name;
  return null;
}

// ---------- in-app confirm dialog (replaces native confirm()) ----------
function confirmDialog(msg, yesLabel = 'Delete') {
  return new Promise(resolve => {
    const bd = $('#confirm-backdrop');
    // a second dialog must retire the first: its listeners were overwritten,
    // so its promise could otherwise never settle (and its keydown leaked)
    if (confirmDialog.active) confirmDialog.active(false);
    confirmDialog.active = null;
    $('#confirm-msg').textContent = msg;
    $('#confirm-yes').textContent = yesLabel;
    bd.classList.remove('hidden');
    trapFocus(bd, $('#confirm-no')); // Tab cycles the dialog; focus leaves via Cancel
    const done = v => {
      if (confirmDialog.active !== done) return; // already settled by a newer dialog
      confirmDialog.active = null;
      bd.classList.add('hidden');
      untrapFocus(bd);
      $('#confirm-yes').onclick = $('#confirm-no').onclick = null;
      bd.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    confirmDialog.active = done;
    const onKey = e => { if (e.key === 'Escape' && escLayer() === 'confirm') done(false); }; // Esc = the universal "no"
    document.addEventListener('keydown', onKey);
    $('#confirm-yes').onclick = () => done(true);
    $('#confirm-no').onclick = () => done(false);
    bd.onclick = e => { if (e.target === bd) done(false); };
    // focus Cancel — Enter must NEVER be one keystroke away from "delete"
    $('#confirm-no').focus();
  });
}

// ---------- keyboard undo ----------
// A delete's only way back is the toast's Undo button, and the toast is gone in
// 10s — far too short to Tab to (the toast lives outside the tab order's
// neighbourhood and focus never moves there). Ctrl+Z activates the newest
// undoable action while its window is still open. Plain typing keeps its own
// Ctrl+Z: editable fields are excluded.
let activeUndo = null; // the Undo button of the most recent undoable delete
function clearActiveUndo(btn) { if (activeUndo === btn) activeUndo = null; }
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || !activeUndo) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!activeUndo.isConnected) { activeUndo = null; return; }
  e.preventDefault();
  activeUndo.click();
});

// ---------- undo-able delete: fetch the image BEFORE deleting so we can restore it ----------
async function deleteCaptureUndoable(c, { advanceLightbox = false } = {}) {
  // undo-blob fetch runs IN PARALLEL with the delete — the old version awaited
  // the full-res download BEFORE issuing the DELETE, adding its latency to it.
  // BOUNDED like every other request: without a timeout a half-open connection
  // left this fetch (and the awaited chain behind it) hanging forever.
  const blobP = fetch(`/media/${encodeURIComponent(c.file)}`, { signal: AbortSignal.timeout(60000) })
    .then(r => r.ok ? r.blob() : null).catch(() => null);
  try {
    await api(`/api/captures/${c.id}`, { method: 'DELETE' });
  } catch { toast('Delete failed'); return false; }
  knownIds.delete(c.id); // identity set must not outlive the row (see knownIds)
  const restoreBlob = await blobP;
  if (advanceLightbox && view.length) lbNav(0); // re-render (view refresh follows)
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = 'Deleted';
  announce('Deleted');
  // visual countdown: the undo window is closing — decide now
  const bar = document.createElement('i');
  bar.className = 'toast-undo-bar';
  bar.style.animationDuration = '10s';
  t.appendChild(bar);
  const undo = document.createElement('button');
  undo.className = 'toast-undo';
  undo.textContent = 'Undo';
  undo.onclick = async () => {
    t.remove();
    clearActiveUndo(undo);
    if (!restoreBlob) { toast('Cannot undo — image data unavailable'); return; }
    const fd = new FormData();
    fd.append('source', c.origin === 'phone' ? 'phone' : 'pc'); // preserve origin through undo
    fd.append('auto', '0'); // restored captures never auto-paste — the user already saw it
    fd.append('photo', restoreBlob, c.file);
    try { await api('/upload', { method: 'POST', body: fd, timeoutMs: 120000 }); toast('Restored ✓'); }
    catch { toast('Undo failed — re-upload manually'); }
  };
  t.appendChild(undo);
  activeUndo = undo; // Ctrl+Z reaches this while the window is open
  $('#toasts').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  // 10s for undo — destructive + irreversible once the toast is gone
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.remove(); clearActiveUndo(undo); }, 250); }, 10000);
  return true;
}

// bulk delete with ONE "Undo all" toast (per-item toasts stack up unreadably)
// concurrency-capped (4): large multi-selects no longer burst 2N requests at once
async function poolSettled(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array(Math.min(limit, items.length)).fill().map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = { status: 'fulfilled', value: await fn(items[idx], idx) }; }
      catch (e) { out[idx] = { status: 'rejected', reason: e }; }
    }
  });
  await Promise.all(workers);
  return out;
}
async function deleteManyUndoable(targets) {
  // Undo needs the original bytes, and those bytes vanish with the file — so
  // each item's full-res image is fetched just before its DELETE. The old
  // version started one fetch per selected capture UP FRONT (50 selected = 50
  // concurrent multi-MB downloads). Work in small batches instead: memory is
  // bounded by the batch, not by the selection size, and blobs are only kept
  // for rows that actually got deleted.
  const deleted = [];
  const canUndo = []; // { c, blob }
  // Reserve the undo budget BEFORE fetching. The previous cap discarded blobs
  // only after downloading every selected original, so it still transferred up
  // to gigabytes and briefly held each four-item batch in memory. `bytes` also
  // includes the thumbnail, making this estimate deliberately conservative.
  const UNDO_BUDGET_BYTES = 96 * 1024 * 1024;
  const UNKNOWN_CAPTURE_BYTES = 20 * 1024 * 1024;
  let undoBytesReserved = 0;
  const BATCH = 4;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const fetchBlob = async c => {
      const estimate = Math.max(1, Number(c.bytes) || UNKNOWN_CAPTURE_BYTES);
      if (undoBytesReserved + estimate > UNDO_BUDGET_BYTES) return null;
      undoBytesReserved += estimate;
      try {
        const r = await fetch(`/media/${encodeURIComponent(c.file)}`, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error(`media ${r.status}`);
        const blob = await r.blob();
        // Old/malformed rows may under-report. Keep the hard byte cap honest.
        if (undoBytesReserved - estimate + blob.size > UNDO_BUDGET_BYTES) {
          undoBytesReserved -= estimate;
          return null;
        }
        undoBytesReserved += blob.size - estimate;
        return blob;
      } catch {
        undoBytesReserved -= estimate;
        return null;
      }
    };
    const blobs = await poolSettled(batch, BATCH, fetchBlob);
    const results = await poolSettled(batch, BATCH, c => api(`/api/captures/${c.id}`, { method: 'DELETE' }));
    batch.forEach((c, idx) => {
      if (results[idx].status !== 'fulfilled') return;
      deleted.push(c);
      knownIds.delete(c.id); // identity set must not outlive the row
      if (blobs[idx].status === 'fulfilled' && blobs[idx].value) canUndo.push({ c, blob: blobs[idx].value });
    });
  }
  const failed = targets.length - deleted.length;
  if (!deleted.length) { toast('Delete failed', 3500); return 0; }
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = `Deleted ${deleted.length}`;
  if (failed) t.textContent += `, ${failed} failed`;
  const notUndoable = deleted.length - canUndo.length;
  if (notUndoable) t.textContent += ` · ${notUndoable} too large to undo`;
  announce(t.textContent);
  const bar = document.createElement('i');
  bar.className = 'toast-undo-bar';
  bar.style.animationDuration = '10s';
  t.appendChild(bar);
  const undo = document.createElement('button');
  undo.className = 'toast-undo';
  undo.textContent = 'Undo all';
  undo.onclick = async () => {
    t.remove();
    clearActiveUndo(undo);
    if (!canUndo.length) { toast('Cannot undo — image data unavailable', 3500); return; }
    const ups = await poolSettled(canUndo, 3, r => {
      const fd = new FormData();
      fd.append('source', r.c.origin === 'phone' ? 'phone' : 'pc'); // preserve origin through undo (same as single delete)
      fd.append('auto', '0'); // restored captures never auto-paste
      fd.append('photo', r.blob, r.c.file);
      return api('/upload', { method: 'POST', body: fd, timeoutMs: 120000 });
    });
    const okN = ups.filter(u => u.status === 'fulfilled').length;
    toast(okN === canUndo.length
      ? `Restored ${okN} ✓`
      : `Restored ${okN}, ${canUndo.length - okN} failed — re-upload manually`, 3500);
  };
  t.appendChild(undo);
  activeUndo = undo; // Ctrl+Z reaches this while the window is open
  $('#toasts').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.remove(); clearActiveUndo(undo); }, 250); }, 10000);
  return deleted.length;
}

// ---------- version self-check (server injects its version into this page) ----------
let versionChecked = false;
function checkPageVersion({ force = false } = {}) {
  // `force` is what the unknown-SSE-event path needs: without it the guard below
  // returned immediately on every later call, so the "re-arm the version check"
  // in the SSE handler was a no-op — a stale tab silently ignored every event
  // from a newer server and never showed the update banner (exactly the failure
  // that comment claims to handle).
  if (versionChecked && !force) return; // one round-trip per page load
  versionChecked = true;
  api('/api/version').then(({ version }) => {
    const pageVersion = document.querySelector('meta[name="app-version"]')?.content;
    if (pageVersion && version !== pageVersion) {
      // stays visible until the user actually refreshes — never auto-hide
      $('#update-banner').classList.remove('hidden');
    }
  }).catch(() => { versionChecked = false; }); // allow a retry on the next trigger
}
checkPageVersion();
$('#update-refresh').onclick = () => location.reload();
$('#empty-retry').onclick = () => {
  capturesLoadError = false;
  showSkeletons();
  loadCaptures().catch(() => { capturesLoadError = true; updateEmptyState(0); toast('Still could not load captures', 3500); });
};

// ---------- lan info (IP picker + fresh QR so IP changes are reflected) ----------
let lanPort = 8787;
let lanScheme = 'http';
let lanIPsList = [];
let lanKnown = false; // /api/lan has answered — before that, the interface list is unknown
let phoneIp = ''; // address the PHONE itself used to reach the server (from /api/stats)
function updatePairing() {
  const ip = $('#nic-sel').value || 'localhost';
  const url = `${lanScheme}://${ip}:${lanPort}/phone`;
  $('#lan-url').textContent = url;
  $('#lan-url').href = url;
  $('#qr').src = `/qr.png?ip=${encodeURIComponent(ip)}`; // no cache-buster — server caches per-IP
}

// BOUNDED retry: the pairing card is the onboarding path. This request used to
// have NO catch at all, so a transient failure produced an unhandled rejection
// and left the card with no LAN URL and no interface picker until a reload.
let lanAttempts = 0;
function loadLan() {
  if (lanKnown) return; // a late retry must not re-append the interface options
  api('/api/lan').then(applyLan).catch(() => {
    // back off 1.5s, 3s, 4.5s … capped at 5 attempts, then leave the state to
    // the connection pill — the rest of the app keeps working meanwhile
    if (lanAttempts++ < 5) setTimeout(loadLan, 1500 * lanAttempts);
  });
}
function applyLan({ ips, port, scheme }) {
  if (lanKnown) return; // a late retry must not re-append the interface options
  lanPort = port;
  if (scheme) lanScheme = scheme;
  lanIPsList = ips;
  const sel = $('#nic-sel');
  // a REAL LAN IP first: localhost can never pair a phone, so it must never be
  // the default (a saved localhost choice is ignored while a LAN IP exists)
  const all = [...ips, 'localhost'];
  const saved = localStorage.pp_nic;
  for (const i of all) {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = i === 'localhost' ? 'localhost (this PC only — phone can\'t use it)' : i;
    sel.appendChild(o);
  }
  sel.value = ips.includes(saved) ? saved : (ips[0] || 'localhost');
  localStorage.pp_nic = sel.value;
  sel.onchange = () => { localStorage.pp_nic = sel.value; updatePairing(); };
  // nothing to choose when there is a single interface: the URL below already
  // names it, and the card has to fit vertically — a one-option select is noise
  sel.classList.toggle('hidden', ips.length === 1);
  lanKnown = true;
  updatePairing();
  // the storage hint can only tell the truth about pairing once we know whether
  // this PC has a reachable interface at all — refine it now, and only then
  if (!ips.length) loadStats();
}
loadLan();

// ---------- QR visibility: shown while no phone is ONLINE; auto-hides on connect ----------
// A phone is "online" while it keeps pinging the server (the phone polls every
// 10–60s, so a silent window means it went away) — and, when the server offers
// its own verdict (it can watch the phone's SSE stream close, which the harness
// cannot), that verdict wins: /api/stats reports `phoneOnline` and the QR comes
// back as soon as the phone's stream drops instead of after the window.
// The QR shows whenever no phone is reachable — before the first connection AND
// after the paired phone drops offline — so it disappears on connect and
// reappears on disconnect. The toggle pins the user's choice for the rest of the
// session (re-pairing a second phone, or tucking the QR away while one is
// already connected).
let phoneOnline = false; // server verdict when offered, else a ping within PHONE_ONLINE_MS
const PHONE_ONLINE_MS = 90 * 1000; // server/PC share one clock; phone pings 10–60s
let qrAuto = true;       // true = follow the connection rule; false = user pinned it
let pairShown = true;
function qrVisible() { return !$('#pair-body').classList.contains('hidden'); }
function updateQr() {
  const show = qrAuto ? !phoneOnline : pairShown;
  $('#pair-body').classList.toggle('hidden', !show);
  const btn = $('#qr-toggle');
  btn.textContent = show ? 'Hide QR' : 'Show QR';
  btn.setAttribute('aria-expanded', String(show));
  btn.title = show ? 'Hide the pairing QR' : 'Show the pairing QR';
  // The empty state points at this panel instead of rendering its own copy of
  // the QR (there is exactly ONE pairing code on screen now), so its wording has
  // to follow the same state — connected phones don't need to scan anything.
  const sub = $('#empty-sub');
  if (sub) sub.textContent = show
    ? 'Scan the pairing QR on the left with your phone, or drop / paste an image here.'
    : 'Your phone is connected — new captures land here. You can also drop / paste an image on this PC.';
}
$('#qr-toggle').onclick = () => {
  qrAuto = false;               // once the user clicks, they own the state
  pairShown = !qrVisible();
  updateQr();
};
updateQr();

// ---------- the rail is a column on a desktop, a DRAWER below 900px ----------
// Out of flow, on a veil, there is exactly ONE scroll region in a short window
// (it used to be a second grid row capped at 40dvh with its own scrollbar,
// beside the library's own). The trigger lives in the top band and renders only
// below the breakpoint — otherwise the status card, the capacity meter and the
// Recent list would not exist at all on a laptop-width window.
const railEl = $('#rail');
const railBackdrop = $('#rail-backdrop');
// the trigger is display:none above the breakpoint, so its computed display is
// the breakpoint test — no second copy of the 900px number to keep in step
const railIsDrawer = () => getComputedStyle($('#rail-toggle')).display !== 'none';
function openRail() {
  if (!railIsDrawer()) return;
  railEl.classList.add('open');
  railBackdrop.classList.remove('hidden');
  $('#rail-toggle').setAttribute('aria-expanded', 'true');
  // a modal surface has to hold Tab: without this the focus ring walks into the
  // library behind the veil
  trapFocus(railEl, railEl.querySelector('button, a, select, input'));
}
function closeRail() {
  if (!railEl.classList.contains('open')) return;
  railEl.classList.remove('open');
  railBackdrop.classList.add('hidden');
  $('#rail-toggle').setAttribute('aria-expanded', 'false');
  untrapFocus(railEl);
}
$('#rail-toggle').onclick = () => (railEl.classList.contains('open') ? closeRail() : openRail());
railBackdrop.addEventListener('mousedown', e => { if (e.target === railBackdrop) closeRail(); });
document.addEventListener('keydown', e => {
  // only when the drawer is the top layer — with Settings open over it, one Esc
  // must not tear both down
  if (e.key === 'Escape' && escLayer() === 'rail') closeRail();
});
// crossing back above the breakpoint with it open would leave a translated panel
// pinned over the library, so the drawer always closes when it stops being one
window.addEventListener('resize', () => { if (!railIsDrawer()) closeRail(); });

// Capacity card's "Manage…": the cap and the cleanup rule are settings, so the
// link opens Settings rather than guessing which of the two the user meant.
$('#manage-storage').onclick = () => openSettings();
// The setup card's step 1 asks for the pairing code, and the code lives in the
// rail — on a drawer-width window that means opening the drawer first, or the
// button scrolls the user to a panel that is off-canvas.
$('#setup-pair').onclick = () => { qrAuto = false; pairShown = true; updateQr(); openRail(); };

// ---------- stats & phone presence ----------
// ONE ladder for both clients (the phone's). The PC's never emitted GB, so a
// 2 GB library read "2048.0 MB" while the phone read "2.0 GB".
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log2(n) / 10));
  const v = n / 2 ** (10 * i);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
const ago = ms => {
  if (!ms) return 'never';
  const s = (Date.now() - ms) / 1000;
  if (!Number.isFinite(s)) return 'never'; // malformed timestamp — never "NaNh ago"
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400); // hour-only labels read "49h ago"
  // DAYS IN WORDS up to a month. This is the label the user actually reads to
  // answer "how old is this", and "20 days ago" says it where a bare date has to
  // be decoded against today's date. Past a month the date IS the shorter answer.
  if (d < 30) return d === 1 ? '1 day ago' : `${d} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });
};
const timeAgo = sql => ago(new Date(sql.replace(' ', 'T') + 'Z').getTime());
// absolute timestamp: relative labels ("2h ago") are useless once a day has passed
const fullTime = sql => {
  const d = new Date(sql.replace(' ', 'T') + 'Z');
  return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
// per-row cache: SSE merges re-render cells repeatedly — parsing the same
// `created_at` string (new Date + toLocaleString) once per row instead of per render
// BOUNDED: a deleted capture's entries have no other removal path, so a long
// session with lots of deletes used to grow these maps without limit.
const TIME_CACHE_MAX = 2000;
const TIME_CACHE_TTL = 30000; // a relative label is stale after ~30s of sitting still
const _timeAgoCache = new Map();
const _fullTimeCache = new Map();
function _cachePut(map, key, val) {
  map.set(key, val);
  if (map.size > TIME_CACHE_MAX) map.delete(map.keys().next().value);
}
// drop a removed capture's memo — called from every delete path
function dropTimeCache(id) { _timeAgoCache.delete(id); _fullTimeCache.delete(id); }
function timeAgoCached(c) {
  // TTL, not permanent: the grid is reconciled in place, so a memo keyed by id
  // alone froze every tile at "just now" for the whole session. refreshRelativeTimes()
  // (on the existing 15s tick) re-reads these as the label ages.
  const hit = _timeAgoCache.get(c.id);
  if (hit && Date.now() - hit.at < TIME_CACHE_TTL) return hit.v;
  const v = timeAgo(c.created_at);
  _cachePut(_timeAgoCache, c.id, { v, at: Date.now() });
  return v;
}
function fullTimeCached(c) {
  if (!_fullTimeCache.has(c.id)) _cachePut(_fullTimeCache, c.id, fullTime(c.created_at));
  return _fullTimeCache.get(c.id);
}
// The tile's meta row answers "how recent is this", so it carries the RELATIVE
// label ("just now" · "6h ago" · "20 days ago"). It used to carry `#14`, a
// database id, and then a clock ("14:31" · "Yest 14:31" · "13 Sep") — a clock
// only answers "when" for TODAY: on a week-old tile "10:20" needs the date beside
// it to mean anything. Rows and the viewer's caption already spoke relative; the
// tile does now too, and the exact stamp lives in the hover title and the
// accessible name, which is where a label that never moves belongs.
function tileTime(c) { return timeAgoCached(c); }
// the accessible name has to be enough to tell two tiles apart: the visible label
// is relative and collides at day granularity (two captures "2 days ago" from
// different days), so the EXACT stamp rides along with it here.
function tileAria(c) {
  const label = timeAgoCached(c);
  const stamp = fullTimeCached(c);
  return `Capture #${c.id}, added ${label}${stamp ? ` (${stamp})` : ''}`;
}
// Time labels move while the page sits idle and NOTHING re-renders them
// (syncGrid/findFile reuse the existing nodes), so the existing 15s stats tick
// also refreshes only the labels that actually changed. No new timer, no
// rebuild — two text writes per row at most. Both labels are RELATIVE now (the
// tile's meta row and its accessible name), so they are re-read on the same tick
// against the same TTL'd memo.
function refreshRelativeTimes() {
  const byId = new Map(captures.map(c => [c.id, c]));
  for (const cell of gridCache.cells) {
    const c = byId.get(Number(cell.dataset.id));
    if (!c || !cell._metaLeft) continue;
    const label = tileTime(c);
    if (cell._metaLeft.textContent !== label) cell._metaLeft.textContent = label;
    const open = cell.querySelector('.capture-open');
    const aria = tileAria(c); // re-reads timeAgoCached, which is what keeps its TTL warm
    if (open && open.getAttribute('aria-label') !== aria) open.setAttribute('aria-label', aria);
  }
  const files = new Map(filesList.map(f => [f.id, f]));
  for (const row of $('#transfers').children) {
    const f = files.get(Number(row.dataset.id));
    if (!f || !row._sub) continue;
    const next = `${fmtSize(f.bytes)} · ${timeAgo(f.created_at)}${filesToInbox && f.dir === 'phone' ? ' · saved to inbox' : ''}`;
    if (row._sub.textContent !== next) row._sub.textContent = next;
  }
}
// Signature of the last rendered stats block. This ran every 15s and rebuilt
// the whole thing (replaceChildren + N createElement) even when nothing had
// changed — only the relative "seen Xm ago" label actually moves between ticks.
let statsSig = null;
// The rail answers three questions in four cards, so this renders THREE blocks
// from ONE payload: the status card (presence), the capacity meter (bytes of
// cap) and the Recent list (the last three arrivals). The count/bytes sentence
// used to sit in the status card under a "Storage" heading JS injected — every
// card owns its own label now (#status-label / #cap-label in index.html), so
// the count moved next to the thing it measures instead of being stated twice.
let anyData = false; // has ANY arrival ever landed — gates the setup card + the data tools
let phoneEverSeen = false; // has a phone ever reached this server? (ends the first run)
let recentSig = null;
// Steps 2–3 dim to 45% until the phone has actually connected. A user cannot send
// a photo from a phone that has not paired, so a step they cannot do yet should
// LOOK like it — a progress affordance, not a checklist. Guarded on the last
// value so a 15s tick never re-writes the same two classes.
let setupStepState = null;
function stepSet(phoneConnected) {
  if (setupStepState === phoneConnected) return;
  setupStepState = phoneConnected;
  for (const id of ['#setup-2', '#setup-3']) $(id).classList.toggle('dim', !phoneConnected);
}
async function loadStats() {
  try {
    const s = await api('/api/stats');
    phoneIp = s.phoneIp || phoneIp;
    const never = !s.phoneLastSeen;
    // live presence. The SERVER owns this verdict when it offers one: only it
    // can see a phone's SSE stream close, which is what lets the QR come back in
    // seconds instead of waiting out the ping window. The local window stays as
    // the fallback for a server that predates the field.
    const online = typeof s.phoneOnline === 'boolean'
      ? s.phoneOnline
      : (!!s.phoneLastSeen && Date.now() - s.phoneLastSeen < PHONE_ONLINE_MS);
    if (phoneOnline !== online) { phoneOnline = online; updateQr(); }
    // Build the lines as DATA first (server strings never go near innerHTML),
    // then diff against what is on screen. `dot` renders a real presence lamp
    // (an element, not a background trick, so it stays aligned when the
    // sentence wraps); `cls` is the line's tint, `icon` a leading warning glyph.
    const lines = [];
    if (never && lanKnown && lanIPsList.length === 0) {
      // no interface at all: the QR points at localhost, so "scan it" would lie
      lines.push({ text: 'No network connection found — connect this PC to Wi-Fi or Ethernet so your phone can reach it.', cls: 'warn', icon: 'ic-alert' });
    } else if (never) {
      lines.push({ text: 'No phone has paired yet', cls: 's-offline', dot: 'off' });
      lines.push({ text: qrVisible() ? 'Scan the QR below with your phone.' : 'Show the QR below to pair.', cls: 's-sub' });
    } else if (s.phones?.length > 1) {
      // several phones → one line each, newest first, so a second phone (or a
      // hotspot IP change) can't silently overwrite the first
      lines.push({ text: 'Connected', cls: 's-online', dot: 'ok' });
      for (const p of [...s.phones].sort((a, b) => b.lastSeen - a.lastSeen))
        lines.push({ text: `Phone${p.ip === s.phoneIp ? ' (latest)' : ''}: seen ${ago(p.lastSeen)}${p.outbox ? ` · ${p.outbox} queued` : ''}`, cls: 's-sub' });
    } else {
      // "Live" in a 28px pill is one word; the card behind it says what it means:
      // connected or not, and when this phone was last heard from. A phone that
      // paired and then went quiet is COLD, not absent — amber, not red.
      lines.push(online
        ? { text: 'Connected', cls: 's-online', dot: 'ok' }
        : { text: 'Not connected', cls: 's-offline', dot: 'warn' });
      lines.push({ text: `Synced ${ago(s.phoneLastSeen)}`, cls: 's-sub' });
    }
    const sig = lines.map(l => `${l.cls}|${l.dot || ''}|${l.icon || ''}|${l.text}`).join('\n');
    if (sig !== statsSig) {
      statsSig = sig;
      const stats = $('#stats');
      stats.replaceChildren();
      // one BLOCK per row: the old <br>+<span> soup left stray breaks and made
      // the last line's spacing depend on where the break landed. No heading is
      // injected any more — the card owns its own label (#status-label).
      for (const l of lines) {
        const line = document.createElement('div');
        if (l.cls) line.className = l.cls;
        // a mask icon, not a raw warning glyph: emoji ignore currentColor (so the amber
        // .warn tint never reached them), render differently per OS, and are
        // read out as "warning sign" before the sentence
        if (l.icon) {
          const i = document.createElement('i');
          i.className = `ic ${l.icon}`;
          i.setAttribute('aria-hidden', 'true'); // the text already says it
          line.appendChild(i);
          line.appendChild(document.createTextNode(' '));
        }
        if (l.dot) {
          const d = document.createElement('span');
          d.className = `dot ${l.dot}`;
          d.setAttribute('aria-hidden', 'true'); // the sentence already says the state
          line.appendChild(d);
        }
        line.appendChild(document.createTextNode(l.text));
        stats.appendChild(line);
      }
    }
    // ---- capacity: the meter and its one sentence ----
    // Written every tick (two property writes) rather than diffed: unlike the
    // status lines this moves on every capture AND every file, which is exactly
    // when nothing re-renders it. `cap` comes from the same payload so the meter
    // has its denominator on first paint instead of a 0% bar until /api/settings
    // lands. aria-valuenow is a percentage; the sentence carries the real pair.
    const cap = Number(s.cap) > 0 ? Number(s.cap) : 0;
    const pct = cap ? Math.min(100, Math.round((s.bytes / cap) * 100)) : 0;
    const meter = $('#meter');
    if (meter) {
      const fill = $('#meter-fill');
      if (fill) fill.style.width = `${pct}%`;
      meter.setAttribute('aria-valuenow', String(pct));
      meter.setAttribute('aria-valuetext', `${fmtBytes(s.bytes)} of ${fmtBytes(cap)}`);
      meter.classList.toggle('over', pct >= 80); // the same threshold auto-cleanup uses
    }
    const capText = $('#cap-text');
    if (capText) capText.textContent = `${fmtBytes(s.bytes)} of ${fmtBytes(cap)} · ${s.count} capture${s.count === 1 ? '' : 's'}`;
    // ---- recent arrivals: the "did it land?" answer ----
    // The list is server data (a file name can be 200 chars) — textContent only.
    const recent = Array.isArray(s.recent) ? s.recent : [];
    const rsig = recent.map(r => `${r.kind}|${r.id}|${r.label}|${r.dir}|${r.at}`).join('\n');
    if (rsig !== recentSig) {
      recentSig = rsig;
      const list = $('#recent-list');
      if (list) {
        list.replaceChildren();
        for (const r of recent) {
          const li = document.createElement('li');
          // direction is the colour, kind is the glyph: an inbound file and an
          // outbound capture are both "it landed", in opposite directions
          const out = r.dir === 'pc';
          li.className = out ? 'r-out' : 'r-in';
          const i = document.createElement('i');
          i.className = `ic ${r.kind === 'file' ? 'ic-file' : 'ic-image'}`;
          i.setAttribute('aria-hidden', 'true');
          // colour is not allowed to be the ONLY carrier of direction, so the
          // row carries the words too — hidden, because three rail rows is not
          // the place to spend 60px on "from your phone"
          const dir = document.createElement('span');
          dir.className = 'sr-only';
          dir.textContent = out ? 'To your phone:' : 'From your phone:';
          const name = document.createElement('span');
          name.className = 'r-name';
          name.textContent = r.label;
          name.title = r.kind === 'file' ? r.label : 'Capture';
          const time = document.createElement('span');
          time.className = 'r-time';
          time.textContent = timeAgo(r.at);
          time.title = fullTime(r.at);
          li.append(i, dir, name, time);
          list.appendChild(li);
        }
      }
      $('#recent-empty')?.classList.toggle('hidden', recent.length > 0);
    }
    // ---- first run: does anything exist yet? ----
    // ONE verdict from ONE payload drives both the setup card and the data tools,
    // so the empty screen and the toolbar can never disagree about whether there
    // is data. A failed /api/stats leaves the last known answer alone.
    anyData = s.count > 0 || (s.files?.count ?? 0) > 0;
    phoneEverSeen = !never;
    document.querySelector('.main-card')?.classList.toggle('no-data', !anyData);
    const setup = $('#setup');
    if (setup) {
      // The setup card is the FIRST RUN screen; once the phone has ever reached
      // this server we are past it, and an empty library is the ordinary
      // "nothing here right now" state (#empty) instead. It follows the CAPTURES
      // list the way #empty does — on the Transfers tab it would be sitting over
      // a lane that has an empty copy of its own.
      const firstRun = !anyData && !phoneEverSeen && !capturesLoadError && capturesVisible();
      setup.classList.toggle('hidden', !firstRun);
      if (firstRun) stepSet(!never);
      updateEmptyState(view.length); // #empty defers to the setup card while it is up
    }
    // same total, echoed in the Captures toolbar so the grid has context (and
    // "n of total" while a filter is on — see paintCount)
    statsCount = s.count;
    statsBytes = fmtBytes(s.bytes);
    paintCount();
    // queued-photos badge in the Live pill
    const pill = document.querySelector('.pill');
    if (!pill) return; // layout variant without the pill — don't crash mid-update
    let badge = $('#outbox-badge');
    if (s.phoneOutbox > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.id = 'outbox-badge';
        badge.title = 'photos queued on the phone (will auto-sync)';
        pill.appendChild(badge);
      }
      badge.replaceChildren(
        Object.assign(document.createElement('i'), { className: 'ic ic-package' }),
        document.createTextNode(` ${s.phoneOutbox}`)
      );
    } else if (badge) badge.remove();
  } catch {}
}
// stats refresh piggybacks on SSE events (capture/deleted/file changes all
// move count/bytes) — the 15s poll remains only as an SSE-down safety net
function scheduleStats() {
  clearTimeout(scheduleStats._t);
  scheduleStats._t = setTimeout(loadStats, 150);
}
// The stats payload changes on capture/file events (SSE schedules a coalesced
// refresh below), so while SSE is healthy there is no reason to hit /api/stats
// every 15 s. ONE exception: phone presence. The server pushes a 'phone' event
// on the transitions it can see (a phone arriving, and its live stream closing),
// but a phone that only pings — no SSE, or one that went quiet without closing
// anything — is only ever caught by the clock, so this tick keeps the QR rule
// and the "Phone: seen …" line honest. It runs only while a phone is believed
// online; with none and SSE up, nothing polls.
let sseReady = false;
// ONE tick, two jobs: the presence clock (above) and keeping the relative labels
// on screen honest. Not a second timer — the grid and the transfer rows are
// reconciled in place, so their "3m ago" text would otherwise never move.
setInterval(() => { refreshRelativeTimes(); if (!sseReady || phoneOnline) loadStats(); }, 15000);
loadStats();

// ---------- settings: ONE bundle, ONE apply path ----------
// These settings used to be eight independent GETs (14 API calls on every
// harness load, 9 more on every change) while the SSE 'settings' event carried
// the whole payload and was thrown away. Now: one bundle at boot, applied
// straight from the SSE payload on change. WRITES are unchanged — each control
// still POSTs to its own endpoint; only the READ side was consolidated.
// The bundle shape mirrors the old per-setting responses 1:1 (server.js
// settingsBundle()), so nothing here has to guess.
function applySettings(s) {
  if (!s) return;
  // auto-paste — the same server flag the phone's Auto-paste button writes
  if (s.autoPaste) $('#auto-paste-pc').checked = s.autoPaste.auto === true;
  // auto-cleanup + its resolved cap label
  if (s.autoCleanup) {
    $('#auto-cleanup').checked = s.autoCleanup.on === true;
    $('#cleanup-cap').textContent = s.autoCleanup.cap ? `(${fmtBytes(s.autoCleanup.cap)} cap)` : '';
  }
  // storage cap — an unknown custom value (e.g. 750 via env + hand edit) gets
  // its own option rather than silently showing 'Server default' while the
  // server trims at 750
  if (s.storageCap) {
    const sel = $('#cap-sel');
    sel.value = s.storageCap.custom ? String(s.storageCap.capMb) : '0';
    if (s.storageCap.custom && ![...sel.options].some(o => o.value === String(s.storageCap.capMb))) {
      const o = document.createElement('option');
      o.value = String(s.storageCap.capMb);
      o.textContent = `${s.storageCap.capMb >= 1024 ? `${(s.storageCap.capMb / 1024).toFixed(s.storageCap.capMb % 1024 ? 1 : 0)} GB` : `${s.storageCap.capMb} MB`}`;
      sel.appendChild(o);
    }
  }
  // retention
  if (s.retention) {
    const sel = $('#retention-sel');
    sel.value = String(s.retention.days || 0);
    if (![...sel.options].some(o => o.value === String(s.retention.days || 0))) {
      const o = document.createElement('option');
      o.value = String(s.retention.days);
      o.textContent = `${s.retention.days} days`;
      sel.appendChild(o);
    }
  }
  // the cap row only matters while cleanup is on
  $('#cap-row').classList.toggle('hidden', $('#auto-cleanup').checked !== true);
  // files → inbox auto-save
  if (s.filesInbox) { filesToInbox = s.filesInbox.on === true; $('#auto-inbox').checked = filesToInbox; }
  // transfer-quality reduction
  if (s.quality) {
    const lvl = Math.min(100, Math.max(1, Math.round(Number(s.quality.level) || 80)));
    $('#quality-reduce').checked = s.quality.on === true;
    $('#quality-pc-level').value = String(lvl);
    $('#quality-pc-val').textContent = String(lvl);
    $('#quality-level-cap').textContent = s.quality.on ? `(${lvl}% JPEG)` : '';
    $('#quality-row').classList.toggle('hidden', s.quality.on !== true);
  }
  // storage folder + inbox folder
  if (s.mediaDir) setMediaDirLabel(s.mediaDir.path);
  if (s.inboxDir) {
    $('#inbox-dir-path').textContent = s.inboxDir.path ? `Inbox: ${s.inboxDir.path}` : 'Inbox: default (data/inbox)';
    $('#inbox-dir-path').title = s.inboxDir.path || 'Where phone files land when auto-save is on';
  }
  // launcher browser PICK (the detected LIST is a separate, cached call below)
  if (typeof s.browser === 'string') {
    const sel = $('#browser-sel');
    if ([...sel.options].some(o => o.value === s.browser)) sel.value = s.browser;
  }
}
// the single reader every former per-setting loader now delegates to
async function refreshSettings() {
  try { applySettings(await api('/api/settings')); } catch {}
}
refreshSettings();
$('#auto-cleanup').onchange = async e => {
  try {
    const r = await api('/api/autocleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: e.target.checked }),
    });
    if (r.ok) toast(e.target.checked ? 'Auto-cleanup on — oldest captures drop at 80%' : 'Auto-cleanup off');
  } catch { toast('Could not save setting'); e.target.checked = !e.target.checked; }
};

// ---------- storage cap + retention (auto-cleanup companions) ----------
$('#cap-sel').onchange = async e => {
  try {
    const mb = Number(e.target.value);
    await api('/api/storage-cap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capMb: mb > 0 ? mb : null }),
    });
    toast(mb > 0 ? `Storage cap set to ${mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}` : 'Storage cap back to the server default');
    refreshSettings(); // refresh the (cap) label
  } catch { toast('Could not save setting'); refreshSettings(); }
};
$('#retention-sel').onchange = async e => {
  const days = Number(e.target.value) || 0;
  try {
    await api('/api/retention', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });
    toast(days > 0 ? `Captures older than ${days >= 365 ? '1 year' : `${days} days`} are deleted automatically` : 'Captures kept forever');
  } catch { toast('Could not save setting'); refreshSettings(); }
};

// ---------- auto-paste mirrored in the settings modal (same server flag as the phone) ----------
$('#auto-paste-pc').onchange = async e => {
  const next = e.target.checked;
  try {
    await api('/api/autopaste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto: next }),
    });
    toast(next ? 'Auto-paste on — new phone photos paste into your last chat tab' : 'Auto-paste off');
  } catch { toast('Could not save setting'); e.target.checked = !next; }
};

// ---------- inbox folder choice (where phone files auto-save) ----------
$('#inbox-dir-change').onclick = async () => {
  const btn = $('#inbox-dir-change');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Picking…';
  try {
    const pick = await api('/api/pick-folder', { method: 'POST', timeoutMs: 600000 });
    if (!pick.path) return; // cancelled — say nothing
    const r = await api('/api/inbox-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: pick.path }),
    });
    $('#inbox-dir-path').textContent = `Inbox: ${r.path}`;
    toast(`Phone files will auto-save to ${r.path}`);
  } catch (e) {
    const s = String((e && e.message) || e);
    toast(s.includes('not writable') ? 'That folder is not writable' : 'Could not set the inbox folder');
  } finally { btn.disabled = false; btn.textContent = label; }
};

// ---------- launcher browser choice (which browser ProofPipe.bat opens) ----------
// The dropdown lists every browser the server detected plus "Default browser"
// (the OS default). Persisted server-side like the other settings; applies the
// next time the .bat starts the server. Live-synced via SSE 'settings'.
async function loadBrowserSetting() {
  try {
    const s = await api('/api/browsers');
    const sel = $('#browser-sel');
    sel.innerHTML = ''; // rebuild from the server's authoritative detected list
    const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
    add('default', 'Default browser');
    for (const b of s.browsers) add(b.id, b.name);
    sel.value = s.current && [...sel.options].some(o => o.value === s.current) ? s.current : 'default';
  } catch {} // endpoint missing on an old server — the dropdown keeps its default option
}
$('#browser-sel').onchange = async e => {
  const id = e.target.value;
  try {
    await api('/api/browsers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const name = e.target.selectedOptions[0]?.textContent || 'your default browser';
    toast(`Harness opens in ${name} the next time you start ProofPipe.bat`);
  } catch {
    toast('Could not save setting');
    loadBrowserSetting();
  }
};
loadBrowserSetting();

// ---------- transfer-quality reduction (shared server setting, OFF by default) ----------
// Photos from the phone are compressed before upload when on; level 1–100.
// The compression itself lives in phone.js's upload() — this UI only edits the
// flag, exactly like auto-cleanup/files-inbox. Live-synced via SSE 'settings'.
async function postQuality(on, level) {
  const r = await api('/api/quality', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on, level }),
  });
  return r; // { ok, on, level }
}
$('#quality-reduce').onchange = async e => {
  const next = e.target.checked;
  $('#quality-row').classList.toggle('hidden', !next);
  try {
    const s = await postQuality(next, Number($('#quality-pc-level').value) || 80);
    $('#quality-level-cap').textContent = s.on ? `(${s.level}% JPEG)` : '';
    toast(next ? `Transfer quality reduction on — ${s.level}% JPEG` : 'Transfer quality reduction off — full quality');
  } catch { toast('Could not save setting'); e.target.checked = !next; }
};
let qualityPCTimer = null;
$('#quality-pc-level').addEventListener('input', e => {
  const lvl = Math.min(100, Math.max(1, Math.round(Number(e.target.value) || 80)));
  $('#quality-pc-val').textContent = String(lvl);
  clearTimeout(qualityPCTimer);
  qualityPCTimer = setTimeout(async () => {
    try {
      const s = await postQuality($('#quality-reduce').checked, lvl);
      $('#quality-level-cap').textContent = s.on ? `(${s.level}% JPEG)` : '';
    } catch {}
  }, 400);
});

// ---------- thumbnail density (S / M / L, remembered) ----------
// An icon MENU since P1, not a three-way segmented control: density is a
// remembered preference, not a mode you flip while looking at the grid — and its
// track was the second inverted-white surface on the screen (DESIGN.md §7: a
// screen has exactly one). The trigger carries the current size as its glyph, so
// the setting is readable without opening anything.
const DENS = { s: '110px', m: '150px', l: '210px' };
const DENS_IC = { s: 'ic ic-grid-3x3', m: 'ic ic-grid-2x2', l: 'ic ic-square' };
function applyDensity() {
  const d = localStorage.pp_dens || 'm';
  $('#captures').style.setProperty('--tile', DENS[d]);
  $('#captures').dataset.dens = d; // CSS compacts the action overlay on S tiles
  $('#dens-btn-ic').className = DENS_IC[d];
  for (const k of ['s', 'm', 'l']) {
    const b = $(`#dens-${k}`);
    const on = k === d;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on)); // the selected density was color-only
  }
}
for (const k of ['s', 'm', 'l']) {
  $(`#dens-${k}`).onclick = () => { localStorage.pp_dens = k; applyDensity(); requestAnimationFrame(updateGridCols); };
}
applyDensity();

// ---------- toolbar menus (sort · size · ⋯ overflow) ----------
// ONE popup implementation for the toolbar's three icon menus — the same shape
// the phone's More sheet uses: one trigger, one panel, `.open` gated. Opening one
// closes the others (there is only ever one panel on screen), an outside press or
// a picked action closes it, and Escape closes it in the CAPTURE phase so one
// keypress settles the menu without also closing the layer underneath it
// (the lightbox handler below runs on the bubble phase).
const MENUS = [
  ['#sort-btn', '#sort-menu'],
  ['#dens-btn', '#dens-menu'],
  ['#tools-btn', '#tools-menu'],
].map(([btn, menu]) => ({ btn: $(btn), menu: $(menu) }));
// A transfer row's ⋯ and a capture tile's ⋯ use the same panel, but it cannot
// live in the fixed MENUS list: every render destroys and rebuilds rows/tiles.
// `rowMenu` records the one that is open, and popupOpen() answers for BOTH — the
// grid shortcuts and Escape must treat any open panel the same way, whichever
// built it (a tile menu opened with the keyboard therefore also makes X/D/C/P
// inert, which is the point: the panel is sitting on the grid).
let rowMenu = null; // { panel, btn }
function closeRowMenu() {
  if (!rowMenu) return;
  rowMenu.panel.classList.remove('open');
  rowMenu.btn.setAttribute('aria-expanded', 'false');
  rowMenu.panel.remove(); // it was moved to the body while open (see toggleRowMenu)
  rowMenu = null;
}
function popupOpen() { return MENUS.some(m => m.menu.classList.contains('open')) || rowMenu !== null; }
function closeMenus() {
  for (const m of MENUS) {
    m.menu.classList.remove('open');
    m.btn.setAttribute('aria-expanded', 'false');
  }
}
// A row/tile panel is placed from its trigger's rect and pinned to the viewport,
// because the list it belongs to SCROLLS: an absolutely-positioned panel inside a
// scroll container is clipped by it, and the last visible row — where a menu is
// most likely to be opened — is exactly the clipped one. It flips above the row
// when there is no room below.
// The panel is MOVED INTO THE BODY while it is open, and that is not tidiness: a
// TRANSFORMED ancestor becomes the containing block for a fixed descendant, and
// `.capture:hover` lifts a tile by 2px. Built inside the tile, the panel resolved
// against the TILE and landed 400px off (measured at 1440×900) — and it moved
// again the moment the pointer left and the lift transitioned back. In the body
// the containing block is the viewport for a row and a tile alike. Nothing is
// reused across a close: both lists are rebuilt on every render anyway.
// (The transfer row's own panel never had the bug — a row does not transform.)
function toggleRowMenu(panel, btn) {
  const reopening = rowMenu && rowMenu.panel === panel;
  closeMenus();
  closeRowMenu();
  if (reopening) return; // a second press on the same ⋯ closes it
  document.body.appendChild(panel); // BEFORE the measurement: a detached node is 0px tall
  const r = btn.getBoundingClientRect();
  const h = panel.offsetHeight; // laid out while hidden (visibility, not display)
  const below = r.bottom + 6 + h <= innerHeight - 8;
  panel.style.top = `${Math.round(below ? r.bottom + 6 : Math.max(8, r.top - h - 6))}px`;
  panel.style.right = `${Math.round(Math.max(8, innerWidth - r.right))}px`;
  panel.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  rowMenu = { panel, btn };
}
// a fixed panel would hang in space while its row/tile scrolled out from under
// it — and BOTH lists are scroll containers (the grid is the tile's own)
$('#transfers').addEventListener('scroll', closeRowMenu, { passive: true });
$('#captures').addEventListener('scroll', closeRowMenu, { passive: true });
addEventListener('resize', closeRowMenu);
for (const m of MENUS) {
  m.btn.onclick = e => {
    const opening = !m.menu.classList.contains('open');
    closeMenus();
    closeRowMenu(); // one panel at a time, toolbar or row
    if (!opening) return;
    m.menu.classList.add('open');
    m.btn.setAttribute('aria-expanded', 'true');
    // a keyboard open (Enter/Space produce a click with detail 0) moves focus in,
    // so arrows/Tab work immediately; a mouse open leaves focus on the trigger
    if (e.detail === 0) m.menu.querySelector('button, input')?.focus();
  };
  // picking an ACTION closes the menu; the Show-both-lists switch stays open so
  // the state change is visible (same rule as the phone's More sheet)
  m.menu.addEventListener('click', e => { if (e.target.closest('.menu-item')) closeMenus(); });
  // Arrow keys walk the rows — a menu you can only reach with Tab is not a menu
  m.menu.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...m.menu.querySelectorAll('button, input')].filter(el => !el.disabled);
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1) + items.length) % items.length].focus();
  });
}
document.addEventListener('pointerdown', e => {
  // `.menu` as well as `.mpop`: an open row/tile panel lives in the BODY while it
  // is open (see toggleRowMenu), so it is no longer a descendant of its trigger.
  // A closed menu is `visibility: hidden`, so it can never swallow a press.
  if (e.target.closest('.mpop, .menu')) return; // a press anywhere else dismisses both kinds
  closeMenus();
  closeRowMenu();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !popupOpen()) return;
  e.stopPropagation(); // capture phase: ONE Escape closes only the topmost thing
  const open = MENUS.find(x => x.menu.classList.contains('open'));
  const trigger = (open && open.btn) || (rowMenu && rowMenu.btn);
  closeMenus();
  closeRowMenu();
  trigger?.focus(); // a keyboard dismiss returns focus to the trigger
}, true);

// ---------- skeleton loaders while the first page fetches ----------
// aria-busy on the grid has TWO owners (a skeleton first load and an upload
// burst), so a counter keeps one from clearing the other's state.
let gridBusyCount = 0;
function gridBusy(delta) {
  gridBusyCount = Math.max(0, gridBusyCount + delta);
  $('#captures')?.setAttribute('aria-busy', String(gridBusyCount > 0));
}
function gridIdle() { gridBusyCount = 0; $('#captures')?.setAttribute('aria-busy', 'false'); }
function showSkeletons() {
  const grid = $('#captures');
  capturesLoadError = false;
  $('#empty-error').classList.add('hidden');
  grid.innerHTML = '';
  for (let i = 0; i < 12; i++) {
    const sk = document.createElement('div');
    sk.className = 'capture skel';
    // decorative: shimmer placeholders carry no information a screen reader can
    // use — the load is announced by the grid's aria-busy + the toast region
    sk.setAttribute('aria-hidden', 'true');
    sk.innerHTML = '<div class="skel-img"></div><div class="meta"><span>…</span><span>…</span></div>';
    grid.appendChild(sk);
  }
  gridIdle();
  gridBusy(1);
  $('#empty').classList.add('hidden');
}

// ---------- captures: state ----------
let captures = [];       // as fetched (newest first)
let view = [];           // sorted AND filtered — what the grid is showing
const knownIds = new Set();
let firstLoad = true;
let selectMode = false;
// How Select mode was ENTERED decides how it EXITS. A tile's own box is an
// IMPLICIT entry — the bulk bar is up because something is selected, so it must
// go down with the last un-ticked box (updateBulkBar). The ⋯ menu's Select item
// (and the S / ⌘A shortcuts that click it) is a DELIBERATE entry: an empty bar
// reading "0 selected" with Select all and Cancel is exactly what was asked for
// there, so `selectPinned` holds it open until Done.
let selectPinned = false;
const selected = new Set();
// Range select (Shift+click) remembers WHERE the range started: the last tile
// picked without Shift. Cleared with the selection and on a tab switch, so a
// stale anchor can never turn a fresh Shift+click into a range back to a tile
// the user picked minutes ago.
let selAnchor = null;

// ---------- origin filter (ONE state, both lists) ----------
// `originFilter` (not `origin`: that name is a read-only window global) is the
// side rail's old legend turned into a control: the same vocabulary (“from
// phone” / “from this PC”), except this one does something. It applies to BOTH
// lists (a capture by `origin`, a transfer row by `dir`), because “from phone”
// means the same thing in either direction of the app.
// The text SEARCH that used to live beside it is gone (v1.20.0): a library you
// scroll in a screenful or two does not need a second way to narrow it, and a
// box that mostly answers “nothing matches” is a control that costs attention and
// returns none. The origin chips are kept — they are the legend, and they filter.
let originFilter = 'all';
function filterActive() { return originFilter !== 'all'; }
// null origin = a pre-v2 row. Everything else already treats that as the normal
// (phone) case — the tile badges PC only — so the filter agrees with the badge
// instead of inventing a third category the UI cannot show. That disagreement
// is exactly what the old static legend had.
const capOrigin = c => (c.origin === 'pc' ? 'pc' : 'phone');
const fileOrigin = f => (f.dir === 'phone' ? 'phone' : 'pc');
const matchOrigin = o => originFilter === 'all' || o === originFilter;
function matchCapture(c) { return matchOrigin(capOrigin(c)); }

function computeView() {
  // 'new' ALIASES the captures array when nothing is filtered — `view` is only
  // ever read (findIndex, indexing, iteration), and copying a 1000-row array on
  // every SSE push was pure garbage. Only a reversed sort or a filter needs its
  // own array.
  const sorted = sortOrder === 'old' ? [...captures].reverse() : captures;
  view = filterActive() ? sorted.filter(matchCapture) : sorted;
}

async function loadCaptures(incremental = false) {
  // keyset pagination: initial/SSE loads fetch the newest PAGE; "load older"
  // fetches ?before=<last id>. SSE refresh resets to the first page.
  const q = (!incremental && before !== null) ? `before=${before}` : `limit=${PAGE}`;
  const page = await api(`/api/captures?${q}`);
  capturesLoadError = false; // a successful retry restores the real empty state
  $('#empty-error').classList.add('hidden');
  if (incremental && before !== null) {
    // SSE refresh while older pages are loaded: MERGE — prepend only the new
    // items and keep the pages the user already scrolled to (they used to be
    // silently wiped by the reset to page 1). CRITICAL: do NOT touch `before`
    // or `moreAvailable` here — this fetch is the newest page, so reading its
    // tail would corrupt the deep-page cursor (resetting page-2 tail e.g. id
    // 51 to the page-1 tail e.g. 151) and flip moreAvailable back on, making
    // the next "Load older" refetch ids 151..52 — which are already in
    // `captures` — and concat would duplicate them.
    const have = new Set(captures.map(c => c.id));
    captures = [...page.filter(c => !have.has(c.id)), ...captures];
  } else {
    // initial load, "Load older" fetch, or SSE reset (cursor null):
    // this page IS the cursor source. Dedupe: an SSE capture arriving between
    // pages would otherwise duplicate a tile.
    if (!incremental && before !== null) {
      const have = new Set(captures.map(c => c.id));
      captures = captures.concat(page.filter(c => !have.has(c.id)));
    }
    else captures = page;
    before = page.length ? page[page.length - 1].id : null;
    moreAvailable = page.length === PAGE;
  }
  $('#load-more').classList.toggle('hidden', !moreAvailable);
  // ONE incremental path for every load after the first: paging appends, SSE
  // prepends, a sort flip reorders — none of them rebuild the tiles already on
  // screen. (The old non-incremental path tore down every cell, which re-decoded
  // the visible thumbnails and dropped the keyboard cursor.) Only the very
  // first paint — skeletons → tiles — builds the grid from scratch.
  if (incremental || !firstLoad) syncGrid();
  else renderGrid();
}

let loadMoreBusy = false; // one page at a time — a scroll burst must not queue several
$('#load-more').onclick = async () => {
  if (loadMoreBusy) return;
  loadMoreBusy = true;
  $('#load-more').disabled = true;
  try { await loadCaptures(); } catch { toast('Could not load older captures'); }
  $('#load-more').disabled = false;
  loadMoreBusy = false;
};
// infinite scroll: load older captures when the GRID is scrolled near its end.
// The old IntersectionObserver watched #load-more itself, but that button is
// pinned BELOW the scrolling grid — it is on screen at all times, so with a
// 400px rootMargin it never stopped intersecting and the grid paged through the
// WHOLE library on its own, with no user scroll at all. A passive scroll check
// is O(1) per event and only runs while the grid is actually being scrolled.
const gridScrollEl = $('#captures'); // hoisted: the handler must not query the DOM per frame
// (the load-more click below is the only other DOM touch, and only on a real trigger)
gridScrollEl.addEventListener('scroll', () => {
  if (loadMoreBusy || !moreAvailable) return; // 400px of runway, as before
  if (gridScrollEl.scrollTop + gridScrollEl.clientHeight < gridScrollEl.scrollHeight - 400) return;
  $('#load-more').click();
}, { passive: true });

// What a dragged tile hands to the drop target. Several MIME shapes, because
// every app picks a different one: `text/uri-list` (editors, browsers),
// `text/html` (chat and compose boxes, which render the <img> we pass),
// `text/plain` (everything else), and — for a SINGLE capture, the only case where
// a name and a type are unambiguous — Chromium's `DownloadURL` convention, which
// is what makes "drag into Discord/Slack" attach the real file instead of a link.
const MEDIA_MIME = file => /\.png$/i.test(file) ? 'image/png'
  : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg';
function setDragPayload(dt, caps) {
  if (!dt || !caps.length) return;
  const urls = caps.map(c => `${location.origin}/media/${encodeURIComponent(c.file)}`);
  dt.effectAllowed = 'copy';
  dt.setData('text/uri-list', urls.join('\r\n'));
  dt.setData('text/plain', urls.join('\n'));
  // built as DOM, not a template string: nothing user-controlled is interpolated
  const html = document.createElement('div');
  for (const url of urls) {
    const img = document.createElement('img');
    img.src = url;
    html.appendChild(img);
  }
  dt.setData('text/html', html.innerHTML);
  if (caps.length === 1) dt.setData('DownloadURL', `${MEDIA_MIME(caps[0].file)}:${caps[0].file}:${urls[0]}`);
  toast(caps.length === 1 ? 'Drag to drop this capture' : `Drag to drop ${caps.length} captures`, 1800);
}

function buildCell(c, isNew) {
  const d = document.createElement('div');
  d.className = 'capture' + (isNew ? ' new enter' : '') + (selected.has(c.id) ? ' sel' : '');
  // one-shot entrance: drop the class as soon as the animation ends so the
  // compositor layer is released and hover transforms stay cheap
  if (isNew) d.addEventListener('animationend', () => d.classList.remove('enter'), { once: true });
  d.dataset.id = c.id;
  d.title = `${fullTimeCached(c)} · ${timeAgoCached(c)}`;
  // Origin badge: where the capture came from. Built with DOM APIs — c.file is
  // never interpolated into HTML (stored-XSS safe). The badge lives INSIDE the
  // square thumbnail (bottom-left), so it stays visible at every grid density.
  // PC ONLY: most captures arrive from the phone, so a "from phone" chip was on
  // every single tile — 14 badges saying nothing. DESIGN.md §7: "a badge must
  // mark the EXCEPTION, not the normal case." (null = pre-v2 row: normal case,
  // no badge — the same rule the origin filter follows, see capOrigin.)
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  // first viewport of a fresh grid: high priority so visible tiles beat the
  // 90+ offscreen lazy thumbs competing for the same connection
  if (hpBudget > 0) { img.fetchPriority = 'high'; hpBudget--; }
  img.src = `/media/t-${encodeURIComponent(c.file)}`;
  img.alt = `Capture #${c.id} thumbnail`;
  // New tiles only: hold the paint until the bytes are decoded, then fade in.
  // This gates on DECODE, never on the network — the image appears the moment
  // it is ready (no added latency), just without the half-parsed flash.
  // Rendered-history tiles skip this entirely: lazy loading must not be nudged.
  if (isNew && 'decode' in img) {
    img.classList.add('thumb-enter');
    img.decode().then(() => {
      img.classList.remove('thumb-enter');
      img.classList.add('thumb-in');
    }).catch(() => { img.classList.remove('thumb-enter'); }); // decode failed — onerror takes over
  }
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  thumb.appendChild(img);
  if (c.origin === 'pc') {
    const pill = document.createElement('span');
    pill.className = 'origin-chip pc';
    pill.title = 'Added on this PC';
    pill.setAttribute('aria-label', pill.title);
    const badge = document.createElement('i');
    badge.className = 'ic ic-pc';
    pill.appendChild(badge);
    thumb.appendChild(pill);
  }
  if (isNew) {
    const b = document.createElement('span');
    b.className = 'badge-new';
    b.textContent = 'NEW';
    d.appendChild(b);
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  const left = document.createElement('span');
  left.className = 't';
  left.textContent = tileTime(c); // the time, not `#${c.id}` — see tileTime()
  const right = document.createElement('span');
  right.className = 'sz';
  right.textContent = fmtBytes(c.bytes); // hover/focus only: quiet at rest
  meta.append(left, right);
  d._metaLeft = left; // refreshRelativeTimes() keeps this label honest in place
  // The tile's OWN action (open the viewer / toggle selection) lives on one
  // focusable surface wrapping thumb + meta. The overlay actions below are
  // SIBLINGS of it: role="button" used to wrap all four, which is invalid
  // interactive nesting and made AT announce five buttons as one.
  const open = document.createElement('div');
  open.className = 'capture-open';
  open.tabIndex = 0;
  open.dataset.id = c.id; // lightbox focus-restore fallback across re-renders
  open.setAttribute('role', 'button');
  open.setAttribute('aria-label', tileAria(c));
  open.setAttribute('aria-pressed', String(selected.has(c.id))); // see toggleSelect
  open.append(thumb, meta);
  d.append(open);
  // A SELECTION BOX on every tile. Selection used to have no handle of its own:
  // you entered Select mode from the ⋯ menu, then clicked tiles, and the only
  // evidence a tile was picked was a green ✓ that appeared afterwards. The box is
  // always there now (quiet at rest, green when on), and it is a real checkbox —
  // Space toggles it, assistive tech announces its state — sitting BESIDE the
  // tile's own surface, never inside it (no nested interactive elements).
  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.className = 'pick';
  pick.checked = selected.has(c.id);
  pick.title = 'Select this capture';
  pick.setAttribute('aria-label', `Select capture, ${tileTime(c)}`);
  pick.onclick = e => {
    e.stopPropagation(); // the box selects; it never opens the viewer
    if (!selectMode) setSelectMode(true); // picking is how the bulk bar appears
    toggleSelect(c.id);
  };
  d.prepend(pick);
  const actions = document.createElement('div');
  actions.className = 'actions';
  const mkBtn = (cls, title, icon) => {
    const b = document.createElement('button');
    b.className = `act ${cls}`;
    b.title = title;
    b.setAttribute('aria-label', title);
    const i = document.createElement('i');
    i.className = `ic ${icon}`;
    i.setAttribute('aria-hidden', 'true');
    b.appendChild(i);
    return b;
  };
  // TWO glyphs + one ⋯, in ONE translucent panel (see .act-panel). Four loose
  // squares was 4 targets on every tile, and at S density they did not fit the
  // tile row at 28px each so they wrapped 2×2. Copy and Send stay up because
  // they are what the library exists for; Download and Delete are occasional or
  // destructive, so they belong behind the ⋯ where they cannot sit next to the
  // action the user came for (DESIGN.md §7).
  const copyBtn = mkBtn('copy', 'Copy image', 'ic-copy');
  const toPhoneBtn = mkBtn('tophone', 'Send to phone', 'ic-send');
  // a real <a>: middle-click, ⌘-click and "save link as" all behave
  const dl = document.createElement('a');
  dl.className = 'menu-item';
  dl.href = `/media/${encodeURIComponent(c.file)}`;
  dl.download = '';
  const dlIcon = document.createElement('i');
  dlIcon.className = 'ic ic-download';
  dlIcon.setAttribute('aria-hidden', 'true');
  dl.append(dlIcon, document.createTextNode('Download'));
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'menu-item danger';
  const delIcon = document.createElement('i');
  delIcon.className = 'ic ic-trash';
  delIcon.setAttribute('aria-hidden', 'true');
  delBtn.append(delIcon, document.createTextNode('Delete capture'));
  const panel = document.createElement('div');
  panel.className = 'menu menu-right';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', `Actions for ${tileTime(c)}`);
  panel.append(dl, delBtn);
  const menuBtn = mkBtn('more', 'More actions', 'ic-more');
  menuBtn.setAttribute('aria-haspopup', 'true');
  menuBtn.setAttribute('aria-expanded', 'false');
  // the same panel the transfer rows use, and the same reason it is FIXED:
  // .capture-grid is a scroll container, so an absolutely-positioned panel
  // inside a tile is clipped by it (see toggleRowMenu).
  // The panel swallows its own clicks — built as a child of the tile, and kept
  // in the body while open (toggleRowMenu), a press on its own padding would
  // otherwise reach whatever is under it.
  panel.onclick = e => e.stopPropagation();
  menuBtn.onclick = e => { e.stopPropagation(); toggleRowMenu(panel, menuBtn); };
  const menuWrap = document.createElement('div');
  menuWrap.className = 'mpop cap-menu';
  menuWrap.append(menuBtn, panel);
  const panelBox = document.createElement('div');
  panelBox.className = 'act-panel';
  panelBox.append(copyBtn, toPhoneBtn, menuWrap);
  actions.appendChild(panelBox);
  d.appendChild(actions);
  d._open = open; // keyboard nav focuses this, not the tile (kept off a query per arrow)
  d._copyBtn = copyBtn; d._tophoneBtn = toPhoneBtn; d._delBtn = delBtn;
  // missing thumb mid-self-heal: neutral tile instead of a broken-image icon
  // (grid paint is driven by the post-thumb 'capture' event, so a missing
  // thumb here means a crash gap — the boot sweep regenerates it)
  img.onerror = function () { this.classList.add('thumb-missing'); };
  delBtn.onclick = async e => {
    e.stopPropagation();
    closeRowMenu();
    await deleteCaptureUndoable(c);
    selected.delete(c.id);
    await loadCaptures(true).catch(() => {});
  };
  dl.onclick = e => { e.stopPropagation(); closeRowMenu(); }; // the download itself is the anchor's own job
  copyBtn.onclick = async e => { e.stopPropagation(); closeRowMenu(); await copyCapture(c); };
  toPhoneBtn.onclick = async e => { e.stopPropagation(); closeRowMenu(); await sendToPhone(c); };
  d.onclick = e => {
    // Shift+click is a RANGE from the last plain pick; Ctrl/⌘+click is one
    // toggle. Both select anywhere, without needing Select mode.
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) { selectRangeCaptures(c.id); return; }
    if (e.ctrlKey || e.metaKey) { toggleSelect(c.id); return; }
    selectMode ? toggleSelect(c.id) : openLightbox(c);
  };
  // DRAG a tile — or the whole selection, when the tile is part of one — into
  // anything that takes a drop: a chat box, an editor, Explorer. The payload
  // carries several shapes because apps disagree about which one they accept.
  d.draggable = true;
  d.addEventListener('dragstart', e => {
    // the box and the overlay controls are not drag handles
    if (e.target.closest('.pick, .act-panel, input, button, a')) { e.preventDefault(); return; }
    const group = selected.has(c.id) && selected.size ? view.filter(x => selected.has(x.id)) : [c];
    setDragPayload(e.dataTransfer, group);
  });
  return d;
}

// push a capture to the phone as a tappable URL chip (phone can open/copy it)
// The link host must be a SERVER interface reachable FROM THE PHONE. Careful:
// `phoneIp` (from /api/stats) is the address the SERVER saw the request come
// from — i.e. the PHONE's own IP. Building the link from it pointed the chip
// at the phone itself and nothing loaded (the exact "PC → phone is broken"
// bug). Use the server's real LAN IPs, preferring the NIC on the same /24 as
// the phone (multi-NIC machines can have several).
function phoneBestIp() {
  const lan = lanIPsList.filter(ip => ip !== 'localhost' && !ip.startsWith('127.'));
  if (!lan.length) return null;
  if (phoneIp && !phoneIp.startsWith('127.')) {
    const p = phoneIp.split('.');
    const sameSubnet = lan.find(ip => { const o = ip.split('.'); return o[0] === p[0] && o[1] === p[1] && o[2] === p[2]; });
    if (sameSubnet) return sameSubnet;
  }
  return lan[0];
}
async function sendToPhone(c) {
  const ip = phoneBestIp();
  if (!ip) { toast("Can't build a phone link — the phone hasn't connected yet", 3500); return; }
  const url = `${lanScheme}://${ip}:${lanPort}/media/${c.file}`;
  try {
    await api('/api/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: url, source: 'pc' }),
    });
    toast('Sent to phone ✓ — tap the chip there to open it');
  } catch { toast('Send failed'); }
}

let capturesLoadError = false;
function updateEmptyState(n) {
  // the Transfers tab overlays this view: while it is active the captures
  // empty-box must never claim "No captures" over a transfers screen, and a
  // failed request must never claim the library is empty. A FILTER that matched
  // nothing is a third state — "No captures yet." is a claim about the data, and
  // a filter that found nothing did not delete anything. One owner for all three
  // boxes, so two of them can never be up at once.
  const visible = capturesVisible();
  const shown = visible ? n : view.length;
  const filtered = filterActive();
  // ...and a fourth: the setup card. On a true first run the EMPTY STATE is the
  // setup card, so "No captures yet." must not print underneath it.
  const setupUp = $('#setup') && !$('#setup').classList.contains('hidden');
  $('#empty-error').classList.toggle('hidden', !visible || !capturesLoadError);
  $('#empty').classList.toggle('hidden', setupUp || !visible || capturesLoadError || filtered || shown > 0);
  $('#empty-filtered').classList.toggle('hidden', !visible || capturesLoadError || !filtered || shown > 0);
  if (visible && filtered && !shown) $('#empty-filtered-sub').textContent = filterSentence('capture', 'captures');
  document.querySelector('.main-card')?.classList.toggle('droptarget', shown === 0 && visible && !capturesLoadError && !filtered);
}
// why a list is empty, in the user's own terms — `one` is the singular noun
// ("capture") because the sentence is about ONE list's contents
function filterSentence(one, many) {
  const scope = originFilter === 'all' ? '' : ` ${originFilter === 'phone' ? 'from your phone' : 'from this PC'}`;
  return originFilter === 'all' ? `No ${many} to show.` : `No ${many}${scope} yet.`;
}

// fetchPriority budget: refilled per full render — the first ~12 tiles (one
// viewport) load high-priority, everything else stays lazy
let hpBudget = 0;
function renderGrid() {
  computeView();
  const grid = $('#captures');
  clearNeighborPreloads(); // list replaced — stale decoded neighbours are meaningless now
  hpBudget = 12;
  grid.innerHTML = '';
  for (const c of view) grid.appendChild(buildCell(c, !firstLoad && !knownIds.has(c.id)));
  updateEmptyState(view.length);
  captures.forEach(c => knownIds.add(c.id));
  firstLoad = false;
  refreshGridCache();
  updateBulkBar();
  gridIdle(); // the first paint landed — the grid is no longer busy
  applyTab(); // keep Transfers/Show-all visibility in sync with the fresh grid
}

// incremental grid update: add/remove/REORDER only what changed (SSE, deletes,
// paging, sort) — never a rebuild. ONE ordered pass over `view`: each node is
// placed after the node before it, so a new capture prepends, an older page
// appends, and a sort flip moves nodes into place. A node already in position
// is never touched (no DOM write, no re-decode, no lost focus).
function syncGrid() {
  computeView();
  const grid = $('#captures');
  // Map of rendered nodes: O(1) lookups instead of a querySelector per item
  const nodeById = new Map([...grid.children].map(el => [Number(el.dataset.id), el]));
  const ids = new Set(view.map(c => c.id));
  // removals
  for (const el of [...grid.children]) {
    if (!ids.has(Number(el.dataset.id))) {
      selected.delete(Number(el.dataset.id));
      el.remove();
      nodeById.delete(Number(el.dataset.id));
    }
  }
  // additions + ordering, in one pass (the sort direction is already baked
  // into `view` by computeView)
  let prev = null;
  for (const c of view) {
    let el = nodeById.get(c.id);
    if (!el) {
      el = buildCell(c, !knownIds.has(c.id));
      nodeById.set(c.id, el);
    }
    const wantNext = prev ? prev.nextSibling : grid.firstChild;
    if (el !== wantNext) grid.insertBefore(el, wantNext);
    prev = el;
  }
  captures.forEach(c => knownIds.add(c.id));
  updateEmptyState(view.length);
  refreshGridCache();
  updateBulkBar();
  gridIdle();
}

// ---------- the filter UI: three origin chips ----------
function paintChips() {
  for (const b of document.querySelectorAll('#origin-chips .chip')) {
    const on = b.dataset.origin === originFilter;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on)); // the chosen chip was colour-only
  }
}
// ONE apply path for every filter change (typing, a chip, Clear, Escape):
// syncGrid() and not renderGrid() — a filter only ADDS and REMOVES nodes, so the
// tiles that stay keep their decoded thumbnails, their place and the keyboard
// cursor, and typing in a 200-tile library does not re-decode per keystroke.
function applyFilter() {
  syncGrid();
  renderFiles();
  paintCount();
}
$('#origin-chips').addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b) return;
  originFilter = b.dataset.origin;
  paintChips();
  applyFilter();
});
$('#filter-clear').onclick = () => {
  originFilter = 'all'; // the origin chips are the only filter left
  paintChips();
  applyFilter();
};
paintChips();
// (The 1260px breakpoint that folded the search field into the ⋯ overflow, and
// the `/` shortcut that focused it, went with the field in v1.20.0. The chips fit
// the row at every width the card survives at, so there is nothing left to
// relocate.)
// The Captures tab's count is the LIBRARY's (from /api/stats). While a filter is
// applied it also says how many are showing — "· 14 ·" beside three tiles is the
// kind of number that makes a user think the filter is broken.
let statsCount = 0, statsBytes = '';
function paintCount() {
  const cc = $('#cap-count');
  if (!cc) return;
  if (!statsCount) { cc.textContent = ''; return; }
  const showing = view.length;
  const scope = filterActive() && showing !== statsCount ? `${showing} of ${statsCount}` : `${statsCount}`;
  cc.textContent = `· ${scope} · ${statsBytes}`;
}

// ---------- sort / select controls ----------
// the sort is a two-row radio menu (P1), remembered like density/tab/merge — it
// used to snap back to "newest" on every reload
let sortOrder = localStorage.pp_sort === 'old' ? 'old' : 'new';
function paintSort() {
  for (const b of document.querySelectorAll('#sort-menu [data-sort]')) {
    b.setAttribute('aria-pressed', String(b.dataset.sort === sortOrder));
  }
}
for (const b of document.querySelectorAll('#sort-menu [data-sort]')) {
  b.onclick = () => { sortOrder = b.dataset.sort; localStorage.pp_sort = sortOrder; paintSort(); syncGrid(); };
}
paintSort();
// leaving Select mode only has to drop the selection VISUALS — rebuilding the
// whole grid for that was the most expensive possible way to clear a few classes
function clearSelection() {
  selected.clear();
  selAnchor = null; // nothing is selected, so there is nothing to range from
  for (const el of $('#captures').children) {
    el.classList.remove('sel');
    el.querySelector('.capture-open')?.setAttribute('aria-pressed', 'false');
    const pick = el.querySelector('.pick');
    if (pick) pick.checked = false;
  }
  // the Transfers tab's rows hold the same selection while it is the active
  // list, so they clear through the same call — one owner for "nothing is
  // selected", whichever tab said so
  for (const row of transferRows($('#transfers'))) paintFileSelect(row, false);
  updateBulkBar();
}
// ONE writer for a transfer row's selected look. Select all, a row click and
// clearSelection() all route through it, so the white ring, the ✓ badge and
// aria-pressed can never disagree about the same row.
function paintFileSelect(row, on) {
  row.classList.toggle('sel', on);
  row.querySelector('.f-info')?.setAttribute('aria-pressed', String(on));
  const check = row.querySelector('.sel-check');
  if (on && !check) {
    const s = document.createElement('span');
    s.className = 'sel-check';
    s.setAttribute('aria-hidden', 'true');
    s.textContent = '✓';
    row.prepend(s);
  } else if (!on && check) check.remove();
}
function toggleFileSelect(id) {
  selected.has(id) ? selected.delete(id) : selected.add(id);
  selAnchor = id; // a plain pick is where the next Shift-range starts
  const row = document.querySelector(`.transfer-row[data-id="${id}"]`);
  if (row) paintFileSelect(row, selected.has(id));
  updateBulkBar();
}
// ONE writer for the mode: the ⋯ menu's Select item and a tile's own selection
// box both come through here, so the item's label, its pressed state and the
// bulk bar can never disagree about whether Select mode is on.
function setSelectMode(on, { pin = false } = {}) {
  if (selectMode === on) return;
  selectMode = on;
  selectPinned = selectMode && pin; // see the declaration — implicit mode exits with the selection
  $('#select-btn').classList.toggle('active', selectMode);
  $('#select-btn').setAttribute('aria-pressed', String(selectMode)); // state was color-only
  $('#select-btn').textContent = selectMode ? 'Done' : 'Select';
  if (!selectMode) clearSelection();
  else {
    toast(`Tap ${selectedKey() === 'file' ? 'files' : 'captures'} to select`);
    // A DELIBERATE entry paints its (empty) bar AT ONCE: the ⋯ menu's Select used
    // to fire the toast and nothing else — the bar the mode exists for did not
    // appear until a capture had been picked, so "Select" looked like a dud. An
    // IMPLICIT entry (a tile's box) is painted by the toggleSelect right after it,
    // one selection item later, and must not paint here — an empty implicit mode
    // is exactly what updateBulkBar() now closes.
    if (pin) updateBulkBar();
  }
}
$('#select-btn').onclick = () => setSelectMode(!selectMode, { pin: true });
// ONE writer for a tile's selected look — toggleSelect(), Select all and a
// Shift-range all route through it, so the ring, the ✓ badge and aria-pressed
// can never disagree about the same tile (the file rows have paintFileSelect()).
function paintCaptureSelect(id, on) {
  const cell = document.querySelector(`.capture[data-id="${id}"]`);
  if (!cell) return; // filtered out or paged away — the set still holds the id
  cell.classList.toggle('sel', on);
  // selection used to be colour-only (a green ✓ badge, aria-hidden), so assistive
  // tech had no way to tell a selected tile from an unselected one
  cell.querySelector('.capture-open')?.setAttribute('aria-pressed', String(on));
  // the box IS the mark now: one state, one writer, no badge to drift out of step
  const pick = cell.querySelector('.pick');
  if (pick) pick.checked = on;
}
function toggleSelect(id) {
  selected.has(id) ? selected.delete(id) : selected.add(id);
  selAnchor = id; // a plain pick is where the next Shift-range starts
  // toggle just the one cell + bulk bar — a full renderGrid() here re-built the
  // whole grid on every Ctrl+click (visible stutter once the grid fills up)
  paintCaptureSelect(id, selected.has(id));
  updateBulkBar();
}
// ---------- range select (Shift+click) ----------
// Standard list behaviour the grid never had. The range is walked inside the
// ACTIVE list only (view / filesView()), which is the same universe Select all
// uses — a range may never reach a row the filter is hiding. Additive, so a
// second Shift+click extends rather than restarting.
function selectRangeCaptures(toId) {
  const ids = view.map(c => c.id);
  const from = selAnchor !== null ? ids.indexOf(selAnchor) : -1;
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0) { toggleSelect(toId); return; }
  const [a, b] = from <= to ? [from, to] : [to, from];
  for (let i = a; i <= b; i++) { selected.add(ids[i]); paintCaptureSelect(ids[i], true); }
  updateBulkBar();
}
function selectRangeFiles(toId) {
  const ids = filesView().map(f => f.id);
  const from = selAnchor !== null ? ids.indexOf(selAnchor) : -1;
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0) { toggleFileSelect(toId); return; }
  const [a, b] = from <= to ? [from, to] : [to, from];
  for (let i = a; i <= b; i++) {
    selected.add(ids[i]);
    const row = document.querySelector(`.transfer-row[data-id="${ids[i]}"]`);
    if (row) paintFileSelect(row, true);
  }
  updateBulkBar();
}
function updateBulkBar() {
  const bar = $('#bulk-bar');
  // An IMPLICIT Select mode (a tile's box was ticked) has nothing left to act on
  // the moment the last box is un-ticked: the bar would sit there reading "0
  // selected" over a dead Copy and Delete — a menu with nothing in it, covering
  // the grid it serves. Leave the mode instead, so un-ticking the box you ticked
  // is the whole way back to plain browsing. A mode opened from the ⋯ menu is
  // pinned and keeps its empty bar (Select all / Cancel / Done are the point).
  if (selectMode && !selectPinned && !selected.size) { setSelectMode(false); return; }
  // the bar acts on ONE list: the active tab's. Show all keeps both on screen,
  // so visibility follows the LISTS (either of them) while the id space below
  // follows the tab — the bar shows wherever it has a target.
  const visible = capturesVisible() || transfersVisible();
  bar.classList.toggle('hidden', !selectMode || !visible);
  bar.classList.toggle('collapsed', !visible); // no reserved toolbar row while no list is up
  $('#bulk-count').textContent = `${selected.size} selected`;
  paintBulkCopy();
  // a 0-selection Delete was a live button that did nothing
  $('#bulk-del').disabled = !selected.size;
  // Select all is pointless when everything already is — and "everything" is
  // the ACTIVE tab's list. It used to compare against `view` (the captures grid)
  // unconditionally, so on Transfers it could never reach the size and an empty
  // grid disabled it outright.
  // the universe is what is ON SCREEN, filter included: "Select all" that also
  // grabbed rows the filter is hiding would act on things the user cannot see
  const universe = selectedKey() === 'file' ? filesView() : view;
  $('#bulk-all').disabled = !universe.length || selected.size === universe.length;
}
// "Select all": with a full library the only bulk path was Ctrl+clicking every
// tile. One pass over the live nodes — no rebuild, no thumbnail re-decode.
$('#bulk-all').onclick = () => {
  if (selectedKey() === 'file') {
    // same contract on the Transfers tab: ids + in-place paint, no rebuild —
    // over the VISIBLE rows, so a filter narrows what "all" means
    for (const f of filesView()) selected.add(f.id);
    for (const row of transferRows($('#transfers'))) paintFileSelect(row, true);
    updateBulkBar();
    return;
  }
  for (const c of view) selected.add(c.id);
  for (const cell of gridCache.cells) {
    cell.classList.add('sel');
    cell.querySelector('.capture-open')?.setAttribute('aria-pressed', 'true');
    const pick = cell.querySelector('.pick');
    if (pick) pick.checked = true;
  }
  updateBulkBar();
};
// The primary says what it will do and to how many: "Copy" over a twelve-item
// selection is a promise with no size in it.
function paintBulkCopy() {
  $('#bulk-copy-label').textContent = selected.size ? `Copy ${selected.size}` : 'Copy';
  $('#bulk-copy').disabled = !selected.size;
}
// Copy N — ONE gesture instead of twelve. The stated purpose of this app is
// getting captures into a chat, and the only bulk affordance it offered was
// destroying them.
//
// The encode is handed to the clipboard as a PROMISE, never awaited first:
// `encodeCapture` re-encodes to PNG (the clipboard only takes PNG) and memoizes
// by id, so a second Copy of the same selection is instant, but a 48MP re-encode
// is seconds of work — long enough to outlive the click's activation window and
// make the whole copy report itself blocked (PITFALLS #57). The button reports
// progress while the write is in flight, because a control that does nothing
// visible for ten seconds reads as broken.
//
// The clipboard takes ONE ClipboardItem per image. `clipboard.write()` with
// several is in the spec and honoured by Chromium, but a platform that keeps a
// single image instead of REJECTING would silently drop the rest — and a
// rejection is the case we can see. So: try the whole set, and if that throws,
// write the first and say so. What this must never be is a quiet half-copy.
$('#bulk-copy').onclick = async () => {
  const targets = captures.filter(c => selected.has(c.id));
  if (!targets.length) return;
  const btn = $('#bulk-copy');
  btn.disabled = true;
  try {
    // Items are built over PROMISES, not encoded blobs: the write has to start
    // inside the click's activation window (PITFALLS #57), and awaiting N
    // encodes first guaranteed the window was long gone by the time write()
    // ran — a 2-capture copy reported itself blocked every time.
    const items = targets.map(c => new ClipboardItem({ 'image/png': encodeCapture(c) }));
    $('#bulk-copy-label').textContent = `Copying ${items.length}…`;
    try {
      await navigator.clipboard.write(items);
      toast(`Copied ${items.length} — paste into any chat (Ctrl+V)`, 3000);
    } catch {
      await navigator.clipboard.write([items[0]]);
      toast(`Copied the first of ${items.length} — this browser keeps one image per copy`, 4000);
    }
  } catch {
    toast('Copy blocked — use Download instead', 3000);
  } finally {
    paintBulkCopy(); // restores the label AND the enabled state
  }
};
$('#bulk-cancel').onclick = () => clearSelection();
// Destructive-action rule (ONE rule for both clients): an action that CAN be
// undone uses the 10s undo toast and no confirm (a single tile or the lightbox
// delete); an action that cannot be undone (Delete all, the phone's capture
// delete) — or that spans many rows at once (this bulk delete) — confirms first.
$('#bulk-del').onclick = async () => {
  if (!selected.size) return;
  if (selectedKey() === 'file') {
    // Files hold no bytes on this client, so unlike a capture a deleted file
    // cannot be restored from memory. Same rule as Delete all: an action that
    // cannot be undone confirms first, and promises no Undo it cannot honour —
    // deleteManyUndoable is captures-only for exactly that reason.
    if (!await confirmDialog(`Delete ${selected.size} file(s) from both devices? This cannot be undone.`)) return;
    const ids = [...selected];
    try {
      const r = await api('/api/files', {
        method: 'DELETE', body: JSON.stringify({ ids }),
        headers: { 'Content-Type': 'application/json' },
      });
      toast(`Deleted ${r.deleted}${r.failed ? `, ${r.failed} failed` : ''}`);
      for (const id of ids) fileRemove(id); // drop the rows we just deleted, no refetch
    } catch { toast('Delete failed', 3500); }
    clearSelection();
    return;
  }
  if (!await confirmDialog(`Delete ${selected.size} capture(s)? You can undo right after.`)) return;
  const targets = captures.filter(c => selected.has(c.id));
  const n = await deleteManyUndoable(targets);
  clearSelection();
  if (n) loadCaptures(true).catch(() => {}); // failures: tiles stay (SSE/deletes refetch reconciles)
  else for (const c of targets) selected.add(c.id); // retry the failed set
};
// delete all: server wipes every capture (DB + files) after explicit confirmation
$('#del-all-btn').onclick = async () => {
  // a failed COUNT is not an empty library: asking the server for the number
  // used to report "Nothing to delete" when the request itself was down
  let n = 0;
  let counted = true;
  try { n = (await api('/api/captures/version')).n; } catch { counted = false; }
  if (counted && !n) { toast('Nothing to delete'); return; }
  if (!await confirmDialog(counted
    ? `Delete ALL ${n} capture(s)? This cannot be undone.`
    : 'Could not count your captures. Delete EVERYTHING anyway? This cannot be undone.')) return;
  try {
    const r = await api('/api/captures', { method: 'DELETE' });
    toast(`Deleted ${r.deleted}`);
  } catch {
    toast('Delete-all failed (partially done?)', 3500);
  }
  before = null;
  moreAvailable = false;
  clearSelection();   // a partially-failed wipe must not leave ✓ marks with no state behind them
  clearImageCaches(); // server wiped everything — drop every memoized byte/row
  knownIds.clear();   // and every remembered id
  loadCaptures(true).catch(() => {});
};
// delete all FILES — the Transfers tab's counterpart to Delete all captures.
// Files are the phone's copies: deleting one here removes it from both devices,
// and there is no local byte-level undo for a file row (unlike a capture, whose
// delete is reversible from the in-memory blob), so this confirms and offers no
// Undo — the same rule the capture wipe already follows.
$('#del-all-files-btn').onclick = async () => {
  // a failed COUNT is not an empty list (same distinction as the capture wipe)
  let n = 0;
  let counted = true;
  try { n = (await api('/api/files/version')).n; } catch { counted = false; }
  if (counted && !n) { toast('Nothing to delete'); return; }
  if (!await confirmDialog(counted
    ? `Delete ALL ${n} transferred file(s)? They will be removed from your phone too. This cannot be undone.`
    : 'Could not count your files. Delete EVERYTHING anyway? This cannot be undone.')) return;
  try {
    const r = await api('/api/files', { method: 'DELETE' });
    toast(`Deleted ${r.deleted} file(s)`);
  } catch {
    toast('Delete-all failed (partially done?)', 3500);
  }
  filesBefore = null;
  filesMoreAvailable = false;
  loadFiles(true).catch(() => {}); // the server also sends a batch SSE; this is the caller's own refresh
};
// ---------- clipboard: plain copy + "copy for chat" bundle (toPng from /toPng.js) ----------
const pngCache = new Map(); // capture id -> encoded PNG (instant re-copy of the same capture)
const pngPending = new Map(); // capture id -> IN-FLIGHT encode, shared by every caller
// cap by BYTES, not count: a 48MP PNG can be 30–60MB, so 6 of them meant
// hundreds of MB of heap → GC pauses → jank. ~128MB keeps re-copies instant.
const PNG_CACHE_MAX_BYTES = 128 * 1024 * 1024;
let pngCacheBytes = 0;
// a full wipe (delete-all) must drop every memoized render artifact, otherwise
// PNGs and timestamp strings for captures that no longer exist linger
function clearImageCaches() {
  pngCache.clear();
  pngPending.clear();
  pngCacheBytes = 0;
  _timeAgoCache.clear();
  _fullTimeCache.clear();
}
function pngCachePut(id, png) {
  if (pngCache.has(id)) pngCacheBytes -= pngCache.get(id).size || 0;
  pngCache.set(id, png);
  pngCacheBytes += png.size || 0;
  while (pngCacheBytes > PNG_CACHE_MAX_BYTES && pngCache.size > 1) {
    const oldest = pngCache.keys().next().value;
    pngCacheBytes -= pngCache.get(oldest)?.size || 0;
    pngCache.delete(oldest);
  }
}
async function copyCapture(c) {
  try {
    await copyBlob(c);
    toast('Copied — paste into any chat (Ctrl+V)');
  } catch (e) {
    // the toast alone hides WHY (permission? encode? a 404 on the media?).
    // The one cause the user can fix is focus: the clipboard needs the PAGE to
    // hold it, and a copy that arrives from the keyboard/another window has not.
    console.debug('ProofPipe copy failed:', e);
    toast(e && e.name === 'NotAllowedError'
      ? 'Copy blocked — click the page first, then press Copy'
      : 'Copy blocked — use Download instead', 3000);
  }
}
// Returns a PROMISE for the PNG, never an awaited blob: the clipboard write has
// to be STARTED inside the click's activation window (see writeCaptureToClipboard),
// and the encode of a 12MP capture outlives that window on its own. Callers that
// arrive mid-encode (the click, then auto-copy, then a bulk copy) share ONE run.
function encodeCapture(c) {
  const cached = pngCache.get(c.id);
  if (cached) return Promise.resolve(cached);
  const inflight = pngPending.get(c.id);
  if (inflight) return inflight;
  const tracked = (async () => {
    // BOUNDED: this was the only unbounded fetch left in the file, and
    // copyCapture() only reports failure when the promise REJECTS — a stalled
    // connection never rejects, so Copy (or C, or the lightbox button) did
    // nothing visible, forever. PNG encode of a 48MP original is the slow part,
    // so the media budget is generous.
    const r = await fetch(`/media/${encodeURIComponent(c.file)}`, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`media ${r.status}`);
    const png = await toPng(await r.blob());
    pngCachePut(c.id, png);
    return png;
  })().finally(() => pngPending.delete(c.id));
  pngPending.set(c.id, tracked);
  tracked.catch(() => {}); // a caller that moved on first must not leak a rejection
  return tracked;
}
// PITFALLS #57: `write()` needs transient user activation (~5s in Chromium) and
// the clipboard only accepts PNG, so the encode has to happen AFTER the write is
// under way. Awaiting the encode first is what made a recent capture report
// itself "blocked" — and then work on a second click, once pngCache held the
// result. The API takes a Promise<Blob> for exactly this; the awaited form stays
// as the fallback for a build that refuses a promised blob outright.
async function writeCaptureToClipboard(c) {
  const png = encodeCapture(c);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e; // a real failure (permission, encode)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': await png })]);
  }
}
async function copyBlob(c) { await writeCaptureToClipboard(c); }

// ---------- auto-copy: a phone snap is instantly ready to Ctrl+V ----------
const autoCopyEl = $('#auto-copy');
autoCopyEl.checked = localStorage.pp_auto_copy === '1';
autoCopyEl.onchange = () => {
  localStorage.pp_auto_copy = autoCopyEl.checked ? '1' : '0';
  toast(autoCopyEl.checked ? 'Auto-copy ON — new phone captures go to the clipboard' : 'Auto-copy off');
};
let autoCopyBusy = false;
let autoCopyQueued = null;
let seenMaxId = 0; // newest capture id ever auto-copied (poll fallback dedupe)
function maybeAutoCopy(c) {
  if (localStorage.pp_auto_copy !== '1') return;
  if (!c || !c.file || c.origin !== 'phone') return; // PC adds are already in front of you
  // stale-data guard: the poll fallback fires capsChanged when the TOP capture
  // is deleted too — comparing ids (not position) prevents re-copying an old
  // remaining capture after a delete
  if ((c.id ?? 0) <= seenMaxId) return;
  seenMaxId = c.id;
  if (autoCopyBusy) { autoCopyQueued = c; return; } // burst → only the newest lands
  autoCopyBusy = true;
  writeCaptureToClipboard(c)
    .then(() => toast('📋 Copied new capture — ready to paste (Ctrl+V)'))
    .catch(() => {
      // throttle: on plain HTTP every snap would spam the same blocked toast
      const now = Date.now();
      if (!maybeAutoCopy._lastWarn || now - maybeAutoCopy._lastWarn > 30000) {
        maybeAutoCopy._lastWarn = now;
        toast('Auto-copy blocked — press 📋 to copy', 3000);
      }
    })
    .finally(() => {
      autoCopyBusy = false;
      if (autoCopyQueued) { const q = autoCopyQueued; autoCopyQueued = null; maybeAutoCopy(q); }
    });
}
// clipboard writes need a focused document on many browsers — a capture that
// landed while the harness was backgrounded gets one retry on focus
addEventListener('focus', () => {
  if (autoCopyQueued) { const q = autoCopyQueued; autoCopyQueued = null; maybeAutoCopy(q); }
});

// ---------- lightbox with zoom & pan ----------
let lbIndex = -1;
let scale = 1, tx = 0, ty = 0, rot = 0;
let lbBase = { w: 0, h: 0 }; // untransformed image size — cached so pan/zoom never forces layout
const lbImg = $('#lb-img');
const lbThumb = $('#lb-thumb');
const lbStage = $('#lb-stage');

function measureLb() {
  // called right after load — resetTf ran first, so scale=1/rot=0 and the
  // rect IS the untransformed size. One layout read per image, never per frame.
  const r = lbImg.getBoundingClientRect();
  lbBase = r.width ? { w: r.width, h: r.height } : { w: 0, h: 0 };
}
function applyTf() {
  // JS fully owns the transform — no CSS transform on the img to conflict with
  lbImg.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg) scale(${scale})`;
}
function resetTf() { scale = 1; tx = 0; ty = 0; rot = 0; lbStage.classList.remove('zoomed'); applyTf(); }
function rotateLb() { rot = (rot + 90) % 360; applyTf(); }

// keep the image reachable: pan is clamped so some part stays on screen
function clampPan() {
  if (scale <= 1) { tx = 0; ty = 0; return; }
  // cached base size: no getBoundingClientRect() inside the pan/zoom loop
  // (a read right after a transform write forces synchronous layout every frame).
  // rotation only rotates the box — its AABB swaps/extends the reachable range.
  const rad = rot * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const baseW = lbBase.w * cos + lbBase.h * sin;
  const baseH = lbBase.w * sin + lbBase.h * cos;
  const maxX = (baseW * (scale - 1)) / 2 + 40;
  const maxY = (baseH * (scale - 1)) / 2 + 40;
  tx = Math.max(-maxX, Math.min(maxX, tx));
  ty = Math.max(-maxY, Math.min(maxY, ty));
}

function openLightbox(c, fromEl) {
  if (!view.length) return; // race with deletes: an empty view must not open a blank lightbox
  lbIndex = view.findIndex(x => x.id === c.id);
  if (lbIndex < 0) lbIndex = 0;
  // the tile we are growing OUT of: the caller passes the node it acted on (so a
  // keyboard Space that opened from a focused tile reports that tile, not the
  // first one in the DOM). Fall back to the id.
  const src = fromEl || document.querySelector(`.capture-open[data-id="${c.id}"]`);
  renderLightbox();
  $('#lightbox').classList.remove('hidden');
  flipFrom(src);
  trapFocus($('#lightbox'), $('#lb-close')); // Tab cycles the viewer; Esc/return lands back on the tile
  preloadNeighbors();
}
// ---------- matched-geometry open ----------
// The tile GROWS into the image over 240ms instead of the viewer appearing from
// nowhere. Two deliberate choices:
//   · the animation is on #lb-stage (the two stacked images), never on the
//     overlay — scaling #lightbox would stretch the toolbar and the close button
//     for the length of the animation, which is the classic FLIP mistake;
//   · the scale is UNIFORM, taken from the width ratio. Matching the tile's
//     width AND height independently would distort the photo for 240ms, and a
//     distorted photo is a worse start than a slightly inexact box.
// transform-origin is moved to the tile's centre so the grow starts exactly on
// the tile rather than from the stage's middle, and the whole thing is skipped
// for reduced-motion users. `Element.animate` cancels itself on finish, so no
// transition state is left behind for the next open (or for a manual pan).
function flipFrom(el) {
  if (!el || !el.getBoundingClientRect) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const to = lbStage.getBoundingClientRect();
  const from = el.getBoundingClientRect();
  if (!to.width || !from.width) return; // not laid out (hidden grid, closed drawer)
  const scale = Math.max(0.05, Math.min(1, from.width / to.width));
  const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
  const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
  const an = lbStage.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.35 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: 240, easing: 'cubic-bezier(.2,.8,.3,1)' },
  );
  // reset the origin the animation needs, then let the finished animation go
  an.onfinish = () => { an.cancel(); lbStage.style.transformOrigin = ''; };
  lbStage.style.transformOrigin = '50% 50%';
}
function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  // Release every retained preload image, not just its id marker. Browsing the
  // viewer used to keep one decoded neighbour per capture for the whole session.
  clearNeighborPreloads();
  // restore focus to where the user came from. It is the tile's .capture-open
  // surface that holds focus (the tile itself is not focusable); that node may
  // have been re-rendered by an SSE push or a delete, so fall back to looking
  // the fresh surface up by capture id.
  const ret = trapReturnFocus;
  const id = ret?.dataset?.id;
  untrapFocus($('#lightbox'), (ret && ret.isConnected) ? ret
    : (id != null ? document.querySelector(`.capture-open[data-id="${id}"]`) : null));
}
function renderLightbox() {
  const c = view[lbIndex];
  if (!c) return;
  resetTf();
  // thumbnail paints INSTANTLY (small file, already on disk); the full-res
  // original streams in behind it and cross-fades over. The final image on
  // screen is always the untouched original — no quality trade-off.
  lbThumb.src = `/media/t-${encodeURIComponent(c.file)}`;
  lbThumb.classList.remove('hidden');
  lbImg.classList.add('loading');
  // tiff/heic originals: no browser renders them, so the full-res swap would
  // end on a broken image. Keep the (PNG) thumbnail on screen and show a note.
  if (/\.(tiff|heic|heif)$/i.test(c.file || '')) {
    lbImg.onload = null;
    lbImg.onerror = null;
    lbImg.removeAttribute('src');
    lbImg.classList.remove('loading');
    const note = /\.tiff$/i.test(c.file) ? 'TIFF' : 'HEIC';
    paintLbMeta(c, `${note}: showing the derived thumbnail (download for the original)`);
    $('#lb-dl').href = mediaUrl(c);
    lbImg.title = originLabel(c);
    preloadNeighbors();
    return;
  }
  // decode() before the swap: the image is fully decoded BEFORE it paints, so
  // the thumb→full-res crossfade never shows a half-decoded frame (onload
  // fired while the bitmap was still being decoded on big photos)
  lbImg.onload = () => {
    const swap = () => { measureLb(); lbImg.classList.remove('loading'); lbThumb.classList.add('hidden'); };
    (lbImg.decode ? lbImg.decode().then(swap, swap) : Promise.resolve().then(swap));
  };
  lbImg.onerror = () => lbThumb.classList.add('hidden'); // thumb may be missing mid-self-heal
  lbImg.src = mediaUrl(c);
  $('#lb-dl').href = mediaUrl(c);
  paintLbMeta(c);
  preloadNeighbors();
}
// ---------- the viewer's caption + position + one-time coach mark ----------
// The caption used to lead with `#14` — a database id where the question is
// "where did this come from, and when" — followed by the position, which is the
// one value that MOVES. The id is gone; the position is its own centred slot in
// the bar, and what is left reads as a sentence: from your phone · 14:31.
let lbMetaIdle = 0;
function paintLbMeta(c, note = '') {
  const pos = $('#lb-pos');
  if (pos) pos.textContent = `${lbIndex + 1} / ${view.length}`;
  // provenance belongs ON SCREEN: a tooltip alone is invisible on touch and was
  // announced to nobody. The phone's viewer shows a PC badge for the same fact.
  const origin = originLabel(c);
  const cap = $('#lb-caption');
  if (cap) cap.textContent = [origin, fullTimeCached(c), note].filter(Boolean).join(' · ');
  lbImg.title = origin; // and kept on the tooltip, since the caption can ellipsize
  showCoach();
  // the caption is context, not chrome: 2s after the last move it fades
  const meta = $('#lb-meta');
  if (meta) {
    meta.classList.remove('idle');
    clearTimeout(lbMetaIdle);
    lbMetaIdle = setTimeout(() => meta.classList.add('idle'), 2000);
  }
}
// ONE-TIME coach mark: it replaces a sentence that was permanent documentation on
// a toolbar. It retires on the first zoom (markLbZoomed) and, for someone who
// never zooms, on the 6s mark — so it is never still there on the second visit.
let lbCoachTimer = 0;
function showCoach(retiring = false) {
  const el = $('#lb-coach');
  if (!el) return;
  if (retiring || localStorage.pp_lb_zoomed) { el.classList.add('gone'); return; }
  el.classList.remove('hidden', 'gone');
  clearTimeout(lbCoachTimer);
  lbCoachTimer = setTimeout(() => el.classList.add('gone'), 6000);
}
const mediaUrl = c => `/media/${encodeURIComponent(c.file)}`;
const originLabel = c => c.origin === 'phone' ? 'from your phone' : c.origin === 'pc' ? 'from this PC' : '';
function clearNeighborPreloads(keep = new Set()) {
  for (const [id, img] of preloadNeighbors.cache) {
    if (keep.has(id)) continue;
    // Drop both our reference and the pending request/decoded backing store.
    try { img.src = ''; } catch {}
    preloadNeighbors.cache.delete(id);
  }
}
function preloadNeighbors() {
  const at = off => view[(lbIndex + off + view.length) % view.length];
  const wanted = [
    { c: at(1), thumbOnly: false, lowPri: true },
    { c: at(-1), thumbOnly: false, lowPri: true },
    { c: at(2), thumbOnly: true, lowPri: false },
    { c: at(-2), thumbOnly: true, lowPri: false },
  ].filter(x => x.c);
  // Keep only the CURRENT ±2 window. The old Set grew for every image visited
  // until the viewer closed, allowing a long browse to pin a large decoded set.
  const keep = new Set(wanted.map(x => x.c.id));
  clearNeighborPreloads(keep);
  for (const { c, thumbOnly, lowPri } of wanted) {
    if (preloadNeighbors.cache.has(c.id)) continue;
    const img = new Image();
    if (lowPri && 'fetchPriority' in img) img.fetchPriority = 'low'; // never fight the CURRENT image
    img.src = thumbOnly ? `/media/t-${encodeURIComponent(c.file)}` : mediaUrl(c);
    preloadNeighbors.cache.set(c.id, img);
  }
}
preloadNeighbors.cache = new Map();

function lbNav(dir) {
  if (!view.length) { closeLightbox(); return; }
  lbIndex = (lbIndex + dir + view.length) % view.length; renderLightbox();
}
$('#lb-close').onclick = () => closeLightbox();
$('#lightbox').onclick = e => { if (e.target.id === 'lightbox') closeLightbox(); };
$('#lb-prev').onclick = e => { e.stopPropagation(); lbNav(-1); };
$('#lb-next').onclick = e => { e.stopPropagation(); lbNav(1); };
$('#lb-copy').onclick = async e => { e.stopPropagation(); await copyCapture(view[lbIndex]); };
$('#lb-rot').onclick = e => { e.stopPropagation(); rotateLb(); };
$('#lb-del').onclick = async e => {
  e.stopPropagation();
  const c = view[lbIndex];
  if (!c) return;
  if (await deleteCaptureUndoable(c)) {
    await loadCaptures(true).catch(() => {});
    if (!$('#lightbox').classList.contains('hidden')) lbNav(0); // advance to the next image
  }
};
lbImg.addEventListener('dblclick', e => { e.stopPropagation(); resetTf(); });

// wheel zoom at the cursor, immediate (no transition), clamped scale >= 1.
// Trackpad pinch-zoom arrives as wheel events with ctrlKey — same handler, gentler steps.
lbStage.addEventListener('wheel', e => {
  e.preventDefault(); e.stopPropagation();
  // delta-proportional zoom: smooth on trackpads (small deltas), ~1.25 steps
  // for mouse wheels — instead of fixed 25% hops that fought fine-grained input
  const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022));
  const ns = Math.min(8, Math.max(1, scale * factor));
  if (ns === scale) return;
  // zoom around the cursor position
  const cx = e.clientX - (innerWidth / 2 + tx);
  const cy = e.clientY - (innerHeight / 2 + ty);
  tx += cx * (1 - ns / scale);
  ty += cy * (1 - ns / scale);
  scale = ns;
  clampPan();
  if (scale === 1) { tx = 0; ty = 0; }
  markLbZoomed();
  lbStage.classList.toggle('zoomed', scale > 1);
  applyTf();
}, { passive: false });

// pan: pointer events on the whole stage (works even when grabbing "air")
let dragging = null;
lbStage.addEventListener('pointerdown', e => {
  if (e.button !== 0 || scale <= 1) return;
  if (e.target.closest('#lb-bar, #lb-close, #lb-prev, #lb-next')) return;
  dragging = { x: e.clientX - tx, y: e.clientY - ty, id: e.pointerId };
  lbStage.setPointerCapture(e.pointerId);
  lbStage.classList.add('zoomed');
});
lbStage.addEventListener('pointermove', e => {
  if (!dragging || e.pointerId !== dragging.id) return;
  tx = e.clientX - dragging.x;
  ty = e.clientY - dragging.y;
  clampPan();
  applyTf();
});
const endPan = e => {
  if (dragging && e.pointerId === dragging.id) { dragging = null; lbStage.classList.remove('zoomed'); }
};
lbStage.addEventListener('pointerup', endPan);
lbStage.addEventListener('pointercancel', endPan);

document.addEventListener('keydown', e => {
  if ($('#lightbox').classList.contains('hidden')) { gridKeys(e); return; }
  // a dialog stacked OVER the viewer owns the keyboard: Escape closed the
  // lightbox AND the dialog (one keypress, two layers), and Delete/arrows/R/±
  // still acted on the image behind the dialog, which the user could not see.
  if (modalOpen()) return;
  if (e.key === 'Escape') closeLightbox();
  // Space closes back to the tile it opened from (closeLightbox restores that
  // focus) — the same key that opened it, Finder's Quick Look. Guarded: inside
  // the viewer Space is a real control's activation key, so on a focused button
  // it must stay that button's.
  if (e.key === ' ' && !(e.target.closest && e.target.closest('button, a'))) {
    e.preventDefault();
    closeLightbox();
  }
  if (e.key === 'ArrowLeft') lbNav(-1);
  if (e.key === 'ArrowRight') lbNav(1);
  if (e.key === 'r' || e.key === 'R') rotateLb();
  if (e.key === 'f' || e.key === 'F') toggleActualSize();
  if (e.key === 'Delete') $('#lb-del').click();
  if (e.key === '+' || e.key === '=') { scale = Math.min(8, scale * 1.25); clampPan(); lbStage.classList.toggle('zoomed', scale > 1); applyTf(); markLbZoomed(); }
  if (e.key === '-') { scale = Math.max(1, scale / 1.25); if (scale === 1) { tx = 0; ty = 0; } lbStage.classList.toggle('zoomed', scale > 1); applyTf(); }
});
// fit ↔ ACTUAL SIZE: 1 image pixel per screen pixel, counted from the cached
// untransformed box (lbBase) and the source bitmap. An image already at or under
// its natural size has no "actual" bigger than fit, so F goes to 2× — a key that
// silently does nothing reads as broken. It replaces a permanent sentence of
// documentation (.lb-coach) with one keystroke.
function toggleActualSize() {
  if (scale > 1) { resetTf(); return; }
  const nat = lbImg.naturalWidth || 0;
  const real = (nat && lbBase.w) ? nat / lbBase.w : 1;
  scale = real > 1.05 ? Math.min(8, real) : 2;
  clampPan();
  lbStage.classList.toggle('zoomed', scale > 1);
  applyTf();
  markLbZoomed();
}
// shared by wheel + keyboard zoom: retire the one-time hint
function markLbZoomed() {
  if (scale > 1 && !localStorage.pp_lb_zoomed) {
    localStorage.pp_lb_zoomed = '1';
    showCoach(true);
  }
}
// ---------- keyboard-first grid navigation ----------
let focusedIdx = -1;
// cached per render: arrow keys must not re-scan the DOM + force layout
const gridCache = { cells: [], cols: 1 };
function refreshGridCache() {
  gridCache.cells = [...document.querySelectorAll('.capture')];
  // `cols` is maintained by the grid ResizeObserver below. Keeping the layout
  // read out of this hot path avoids a forced style/layout flush after every
  // render and SSE-driven incremental sync.
  // focusedIdx is DERIVED from the DOM here, never tracked in parallel: an SSE
  // insert prepends to `view` (shifting every index) and a full re-render
  // replaces the nodes outright. Re-deriving keeps the highlight, the arrow
  // cursor and the action keys on the same tile — they used to drift apart, so
  // X/D/C/Enter could hit a NEIGHBOURING capture. With no focused tile the
  // index drops to -1, so an action key can't fire at an unhighlighted tile.
  const activeCell = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest('.capture') : null;
  if (activeCell) {
    focusedIdx = gridCache.cells.indexOf(activeCell);
    if (focusedIdx >= 0) activeCell.classList.add('kfocus'); // rebuilt nodes start clean
  } else {
    focusedIdx = -1;
  }
}
// Column count from the USED grid tracks: getComputedStyle returns one track
// size per column, so this is exact. The old
// `round(gridWidth / tile.offsetWidth)` divided by a BORDER-INCLUSIVE width, so
// it rounded to the wrong integer at some sizes and arrow Up/Down jumped a row.
// This is called only by ResizeObserver (plus one initial frame), never by a
// render/sync, so DOM mutation and layout measurement cannot thrash each other.
function updateGridCols() {
  try {
    const tpl = getComputedStyle(grid).gridTemplateColumns;
    const n = tpl ? tpl.split(' ').filter(Boolean).length : 0;
    gridCache.cols = Math.max(1, n);
  } catch { gridCache.cols = 1; }
}
// any modal dialog currently owning the screen. Grid shortcuts must not fire
// behind one: with Settings open, X used to delete the focused capture and D
// downloaded it — destructive keys acting on a grid the user can't see.
function modalOpen() {
  // the rail DRAWER belongs here even though its backdrop is not a dialog: below
  // 900px it covers the grid, and X/D/P/arrows on a rail the user cannot see
  // through is the exact bug this guard exists for.
  return ['#settings-backdrop', '#texts-backdrop', '#scan-backdrop', '#dir-backdrop', '#confirm-backdrop', '#rail-backdrop']
    .some(sel => !$(sel).classList.contains('hidden'));
}
function gridKeys(e) {
  if (modalOpen()) return; // an open dialog owns the keyboard (its own trap handles Tab)
  // ...and so does an open toolbar menu: its panel covers part of the grid, so
  // X/D/P/arrows must not act on tiles the menu is sitting on. Escape is already
  // handled in the capture phase (the menu owns it while it is open).
  if (popupOpen()) return;
  // the captures view can be HIDDEN (Transfers tab, no Show-all) while its tiles
  // are still in the DOM — every shortcut below would then act on a grid the
  // user cannot see: the arrows selected an invisible tile and X/D/P operated on
  // it (deleting a capture nobody was looking at). Same guard the bulk bar and
  // the empty states already use.
  if (!capturesVisible()) return;
  const t = e.target;
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
  // single-letter shortcuts are bare keys only: with a tile focused, Ctrl+X
  // deleted it, Ctrl+P sent it to the phone (and opened the print dialog),
  // Ctrl+S toggled Select (and the save-page dialog), Ctrl+D downloaded it
  // (and bookmarked). Ctrl+Z keeps its own undo path (see above).
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!gridCache.cells.length) return;
  const cells = gridCache.cells, cols = gridCache.cols;
  const setFocus = i => {
    focusedIdx = Math.max(0, Math.min(cells.length - 1, i));
    cells.forEach((c, j) => c.classList.toggle('kfocus', j === focusedIdx));
    (cells[focusedIdx]._open || cells[focusedIdx]).focus(); // the tile's own surface, not the tile
  };
  if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
    e.preventDefault();
    if (focusedIdx < 0) setFocus(0);
    else if (e.key === 'ArrowRight') setFocus(focusedIdx + 1);
    else if (e.key === 'ArrowLeft') setFocus(focusedIdx - 1);
    else if (e.key === 'ArrowDown') setFocus(focusedIdx + cols);
    else if (e.key === 'ArrowUp') setFocus(focusedIdx - cols);
  }
  if (focusedIdx < 0) return; // action keys need a visibly targeted cell first
  // a focused real control (a tile action button, a link) handles Enter/Space
  // itself — without this the grid handler fired alongside it, so activating
  // "Copy" from the keyboard also threw the lightbox open on top of it
  if (t.closest && t.closest('button, a')) return;
  // resolve the target from the tile that ACTUALLY holds focus, not from the
  // index (see refreshGridCache — a prepended capture shifts every index)
  const focusedCell = t.closest ? t.closest('.capture') : null;
  const capId = focusedCell ? focusedCell.dataset.id : null;
  const capIdx = capId != null ? view.findIndex(x => String(x.id) === capId) : focusedIdx;
  const cap = view[capIdx >= 0 ? capIdx : focusedIdx];
  if (!cap) return;
  if (e.key === 'Enter' || e.key === ' ') { // Space = Quick Look (the same activation as Enter)
    e.preventDefault(); // …and it must not scroll the grid
    // hand the node the key came from to the FLIP, so the viewer grows out of the
    // tile the user was looking at
    openLightbox(cap, focusedCell || cells[focusedIdx]);
    focusedIdx = capIdx;
    return;
  }
  if (e.key === 'c' || e.key === 'C') copyBlob(cap).then(() => toast('Copied ✓')).catch(() => toast('Copy blocked'));
  if (e.key === 'd' || e.key === 'D') { const a = document.createElement('a'); a.href = `/media/${cap.file}`; a.download = cap.file; a.click(); }
  if (e.key === 'p' || e.key === 'P') sendToPhone(cap); // the tile's Send action, keyboard-reachable
  if (e.key === 'x' || e.key === 'X') {
    deleteCaptureUndoable(cap).then(ok => { if (ok) loadCaptures(true).catch(() => {}); });
  }
  if (e.key === 's' || e.key === 'S') $('#select-btn').click();
  // J/K mirror ↓/↑ — Vim/gallery convention, and it keeps the hand off the arrow
  // cluster for the two most common moves (next image, previous image).
  if (e.key === 'j' || e.key === 'J') { e.preventDefault(); setFocus(focusedIdx + 1); }
  if (e.key === 'k' || e.key === 'K') { e.preventDefault(); setFocus(focusedIdx - 1); }
}
const grid = $('#captures');
if ('ResizeObserver' in window) new ResizeObserver(updateGridCols).observe(grid);
else addEventListener('resize', updateGridCols);
requestAnimationFrame(updateGridCols);
grid.addEventListener('focusin', e => {
  const cell = e.target.closest('.capture');
  if (cell) focusedIdx = view.findIndex(x => x.id == cell.dataset.id);
});

// ---------- PC-side upload: drag & drop or Ctrl+V anywhere ----------
let dragDepth = 0;
const isImage = f => f && f.type && f.type.startsWith('image/');
// router: images → Captures (/upload), everything else → Transfers (/api/files)
async function uploadFiles(files) {
  const list = [...files].filter(f => f && f.size > 0);
  const imgs = list.filter(isImage);
  const others = list.filter(f => !isImage(f));
  if (imgs.length) await uploadCaptureImages(imgs);
  if (others.length) await uploadAnyFiles(others);
}
async function uploadCaptureImages(imgs) {
  toast(`Uploading ${imgs.length} image${imgs.length > 1 ? 's' : ''}…`);
  gridBusy(1); // the burst is a real busy state for AT, not just a toast
  // 3 concurrent uploads: LAN bandwidth shared, ~3x faster for multi-drops
  let failed = 0;
  const queue = [...imgs];
  // the server's photo bucket is a burst ceiling: a multi-drop bigger than it
  // must RETRY its 429s with backoff instead of toasting "failed" for the tail
  // (the phone queue already does this). Bounded: 5 tries / ~1.9s max wait — a
  // genuinely dead server still fails fast.
  const uploadWithRetry = async f => {
    for (let t = 0; ; t++) {
      const fd = new FormData();
      fd.append('source', 'pc'); // origin badge (declared BEFORE the file part)
      fd.append('photo', f, f.name || 'paste.jpg');
      try { await api('/upload', { method: 'POST', body: fd, timeoutMs: 120000 }); return; }
      catch (e) {
        if (t >= 4 || !String(e).includes('429')) { failed++; return; }
        await new Promise(r => setTimeout(r, 400 * 2 ** t)); // 400/800/1600/3200ms
      }
    }
  };
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      await uploadWithRetry(f);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, imgs.length) }, worker));
  if (failed) toast(`${failed} upload${failed > 1 ? 's' : ''} failed`, 3500);
  // incremental: a full (non-incremental) load appends an OLDER page when scrolled, hiding the new uploads
  loadCaptures(true).catch(() => {}).finally(() => gridBusy(-1));
}
// ignore the extension's auto-paste files: if an auto-paste ever lands on the
// harness itself, re-uploading would fire another auto event -> a loop of
// duplicate captures. (Real Ctrl+V pastes never carry a "proofpipe-<id>.png"
// name — only autoPasteCapture synthesizes one.)
document.addEventListener('paste', e => uploadFiles(
  [...(e.clipboardData?.files || [])].filter(f => !/^proofpipe-\d+\.\w+$/.test(f.name || ''))
));
const isEditableTarget = t => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
document.addEventListener('drop', e => {
  const files = [...(e.dataTransfer?.files || [])];
  // A drop carrying NO files (dragged text, a link) belongs to the page — the
  // old handler preventDefault()ed unconditionally, so dragging text into the
  // message box silently did nothing. Only a file drop is ours; anything else
  // on a non-editable target is still swallowed so the browser can't navigate
  // away to the dropped URL.
  if (!files.length && isEditableTarget(e.target)) return;
  e.preventDefault(); dragDepth = 0;
  $('#drop-overlay').classList.remove('show');
  if (files.length) uploadFiles(files);
});
// the overlay advertises a FILE drop — a text/URL drag must not flash it
const dragHasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', e => {
  e.preventDefault();
  if (dragHasFiles(e) && ++dragDepth === 1) $('#drop-overlay').classList.add('show');
});
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').classList.remove('show'); } });
document.addEventListener('dragover', e => {
  // Preserve native text/link drops into editable controls. File drags are ours;
  // non-editable URL drops are still cancelled so they cannot navigate away.
  if (!dragHasFiles(e) && isEditableTarget(e.target)) return;
  e.preventDefault();
});

// ---------- transfers (any file, phone ⇄ PC) ----------
// Talks to the /api/files endpoints. If they 404 (page opened against an
// older server mid-update), the tab degrades to a friendly notice and
// nothing else breaks — no hard dependency at load.
let filesAvailable = true; // flipped off permanently once /api/files 404s
let filesLoadError = false; // last transfers load FAILED (distinct from "empty")
let filesList = [];        // as fetched (newest first)
let filesSeen = new Set();
let filesLoaded = false;
let filesBefore = null;
let filesMoreAvailable = false;
let filesLoadBusy = false;
function matchFile(f) { return matchOrigin(fileOrigin(f)); }
// The FILTERED file list — what renderFiles draws and what the bulk bar's
// universe is built from. filesList stays the unfiltered fetch state (the merge
// cursor and the counts read it), so "Select all" with a filter on selects the
// rows the user can actually see, exactly as `view` does for captures.
function filesView() { return filterActive() ? filesList.filter(matchFile) : filesList; }

// ---------- day groups ----------
// A flat list of twenty rows has no shape: "27.0 B · 2h ago" repeated twenty
// times is a wall, and the question the list exists to answer — did my file land
// today? — needed counting. Rows group under a sticky header; the header is a
// SIBLING row (not a wrapper), so removing one row never disturbs a group and an
// SSE insert can target a group directly.
const startOfDay = sql => {
  const d = new Date(String(sql).replace(' ', 'T') + 'Z');
  return isNaN(d) ? 0 : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
function dayLabel(ms) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((today - ms) / 86400000);
  if (days <= 0) return 'Today'; // <= 0, not === : a clock-skewed future row is "today", not "this week"
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Earlier this week';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined,
    d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' });
}
const isDayHead = el => el.classList.contains('day-head');
function makeDayHead(ms) {
  const h = document.createElement('div');
  h.className = 'day-head';
  h.dataset.day = String(ms); // the group key: the local midnight of the day
  h.textContent = dayLabel(ms);
  return h;
}
function dayHeads(box) { return [...box.children].filter(isDayHead); }
// one row per file, in the group its timestamp belongs to — creating the group
// (and placing it by day rank) when this is the first row of that day. A
// backfilled row from an SSE replay lands in the right group for the same reason.
function fileInsertRow(box, f) {
  const row = buildFileRow(f);
  const key = startOfDay(f.created_at);
  const head = dayHeads(box).find(h => h.dataset.day === String(key));
  if (!head) {
    const older = dayHeads(box).find(h => Number(h.dataset.day) < key);
    box.insertBefore(makeDayHead(key), older || null);
    box.insertBefore(row, older || null);
    return row;
  }
  const heads = dayHeads(box);
  const next = heads[heads.indexOf(head) + 1] || null; // the next day's header, or the end
  box.insertBefore(row, next);
  return row;
}
// a day header with no rows left under it is noise: drop it when its group is
// empty (a delete, or the last row of a day being removed)
function pruneDayHeads(box) {
  const heads = dayHeads(box);
  for (const h of heads) {
    const next = heads[heads.indexOf(h) + 1] || null;
    // nothing between this header and the next group's header (or the end)
    if (h.nextElementSibling === next) h.remove();
  }
}
// every pass over the list (paint, count, "is it empty") goes through this: a day
// header carries no dataset.id, so one forgetful caller would paint a ✓ badge on
// a label. ONE helper means no caller can forget.
const transferRows = box => [...box.children].filter(el => !isDayHead(el));
let activeTab = 'captures';
let filesToInbox = true;   // mirrored server setting (auto-save phone files)

// which view is showing; localStorage-remembered
function applyTab() {
  const showAll = $('#show-all').checked;
  const transfers = activeTab === 'transfers' || showAll;
  const captures = activeTab === 'captures' || showAll;
  $('#tab-captures').classList.toggle('active', activeTab === 'captures');
  $('#tab-captures').setAttribute('aria-selected', String(activeTab === 'captures'));
  $('#tab-transfers').classList.toggle('active', activeTab === 'transfers');
  $('#tab-transfers').setAttribute('aria-selected', String(activeTab === 'transfers'));
  document.querySelector('.main-card').classList.toggle('all-view', showAll);
  // captures-only tools follow the tab. On Transfers they acted on an invisible
  // grid — Delete all would wipe every capture with no captures on screen.
  for (const el of document.querySelectorAll('.cap-only')) el.classList.toggle('hidden', !captures);
  // the Transfers-only counterpart: "Delete all files" acts on the file list, so
  // it must be absent wherever that list is (an .all-view keeps both tool sets
  // visible, which is why this follows the LIST, not the tab, like capturesVisible)
  const filesShown = transfers || showAll;
  for (const el of document.querySelectorAll('.files-only')) el.classList.toggle('hidden', !filesShown);
  $('#captures').classList.toggle('hidden', !captures);
  $('#load-more').classList.toggle('hidden', !captures || !moreAvailable);
  $('#transfers').classList.toggle('hidden', !transfers || !filesAvailable || !filesLoaded);
  $('#transfers-uploads').classList.toggle('hidden', !transfers || !filesAvailable);
  $('#transfers-loading').classList.toggle('hidden', !transfers || !filesAvailable || filesLoaded || filesLoadError);
  $('#transfers-error').classList.toggle('hidden', !transfers || !filesAvailable || filesLoaded || !filesLoadError);
  $('#files-load-more').classList.toggle('hidden', !transfers || !filesAvailable || !filesMoreAvailable || !filesLoaded);
  $('#transfers-fallback').classList.toggle('hidden', !transfers || filesAvailable);
  // An empty lane has three causes — the list is empty, a filter hid everything,
  // the load failed — and the copy has to name the right one: "No transfers yet."
  // printed over a filtered-out list is a claim about the data that the data does
  // not support. The count is the VISIBLE count (filesView), not filesList.
  const emptyLane = $('#transfers-empty');
  const laneRows = filesView().length;
  emptyLane.classList.toggle('hidden', !transfers || !filesAvailable || !filesLoaded || laneRows > 0 || filesUploading.size > 0);
  const laneFiltered = filterActive() && laneRows === 0;
  emptyLane.querySelector('.empty-title').textContent = laneFiltered ? 'Nothing matches.' : 'No transfers yet.';
  $('#transfers-empty-sub').textContent = laneFiltered
    ? filterSentence('transfer', 'transfers')
    : 'Send a file from your phone, or click “＋ File” / drop any file here.';
  updateEmptyState(view.length); // ONE owner for #empty visibility (this toggled it too)
  updateFileCount();
  updateBulkBar(); // Select mode survives a tab switch — its bar must not
  paintTabFocus(); // the roving tabindex follows the selection (ARIA tabs)
  paintCount(); // the counts are per-tab, so the tab switch repaints them
}
function capturesVisible() { return activeTab === 'captures' || $('#show-all').checked; }
// the Transfers counterpart, for the same reason capturesVisible exists: with
// Show all on, BOTH lists are on screen, so "the tab" and "the list" are two
// different questions and only one of them can decide what a bulk action means.
function transfersVisible() { return activeTab === 'transfers' || $('#show-all').checked; }
// Which id space `selected` holds: capture ids on the Captures tab, file ids on
// Transfers. An id is only an id inside its own table (capture #4 and file #4 are
// different rows), so the ACTIVE TAB decides — not what happens to be visible.
// selectTab() clears the set on a switch so a capture id can never be handed to
// the files route (or the reverse).
function selectedKey() { return activeTab === 'transfers' ? 'file' : 'capture'; }
// ARIA tabs: exactly ONE tab is in the tab order (the selected one), so Tab
// lands on the tablist once instead of stopping twice on the way through it.
// The keydown wiring below moves both the selection and this tabindex.
function paintTabFocus() {
  $('#tab-captures').tabIndex = activeTab === 'captures' ? 0 : -1;
  $('#tab-transfers').tabIndex = activeTab === 'transfers' ? 0 : -1;
}
// (updateEmptyState handles the transfers-view guard internally now — the
// old function reassignment lived here)

function updateFileCount() {
  const cc = $('#file-count');
  if (!cc) return;
  if (!filesList.length) { cc.textContent = ''; return; }
  const shown = filesView();
  // "n of total" while a filter is on — same rule as the Captures tab
  const scope = filterActive() && shown.length !== filesList.length
    ? `${shown.length} of ${filesList.length}` : `${filesList.length}`;
  const bytes = filesList.reduce((n, f) => n + (f.bytes || 0), 0);
  cc.textContent = `· ${scope} · ${fmtBytes(bytes)}`; // same shape as the Captures tab
}

const fileUrl = f => `/file/${f.id}`;
function fmtSize(b) { return fmtBytes(b); }

function buildFileRow(f) {
  const row = document.createElement('div');
  row.className = 'transfer-row';
  row.dataset.id = f.id;
  const dir = document.createElement('span');
  dir.className = 'f-dir ' + (f.dir === 'phone' ? 'phone' : 'pc');
  dir.title = f.dir === 'phone' ? 'From your phone' : 'Sent from this PC';
  const dirIcon = document.createElement('i');
  dirIcon.className = 'ic origin ' + (f.dir === 'phone' ? 'ic-phone' : 'ic-pc');
  dir.appendChild(dirIcon);
  const info = document.createElement('div');
  info.className = 'f-info';
  const name = document.createElement('span');
  name.className = 'f-name';
  name.textContent = f.name; // textContent only — never interpolate server strings
  const sub = document.createElement('span');
  sub.className = 'f-sub';
  sub.textContent = `${fmtSize(f.bytes)} · ${timeAgo(f.created_at)}${filesToInbox && f.dir === 'phone' ? ' · saved to inbox' : ''}`;
  row._sub = sub; // refreshRelativeTimes() keeps this label honest in place
  info.append(name, sub);
  // The row's OWN surface, exactly as `.capture-open` is the tile's: a real
  // control (focusable, aria-pressed) that opens the file normally and toggles
  // selection in Select mode. Selection used to be reachable only by clicking a
  // row with a mouse, so the Transfers tab had no keyboard path into it at all.
  // Its accessible name is its content (name + size/time) — deliberately not an
  // aria-label, so refreshRelativeTimes() keeps the announced time honest.
  info.tabIndex = 0;
  info.setAttribute('role', 'button');
  info.setAttribute('aria-pressed', 'false'); // painted by paintFileSelect()
  const fileAct = ev => {
    // Shift ranges from the last plain pick, Ctrl/⌘ toggles one — the same two
    // gestures the capture tiles accept. Both are scoped by selectedKey(), for
    // the same reason Select mode is: on the Captures tab a file id must never
    // enter the set the captures bulk actions read.
    if (ev && selectedKey() === 'file' && (ev.shiftKey || ev.ctrlKey || ev.metaKey)) {
      if (ev.shiftKey && !ev.ctrlKey && !ev.metaKey) selectRangeFiles(f.id);
      else toggleFileSelect(f.id);
      return;
    }
    if (!selectMode) { window.open(fileUrl(f), '_blank', 'noopener'); return; }
    // Select mode on the Transfers tab selects files; on the Captures tab (Show
    // all keeps this list on screen) it must not, or a file id would enter the
    // set the captures bulk actions read — see selectedKey().
    if (selectedKey() === 'file') toggleFileSelect(f.id);
  };
  // Row actions: two glyphs plus a ⋯ menu, 28×28, revealed on hover or focus
  // (see .f-actions). What they are not: three identical TEXT buttons repeated in
  // every row — 27 targets and 27 tab stops for 9 files, none of which said which
  // file it belonged to.
  const mkAct = (tag, cls, title, icon) => {
    const b = document.createElement(tag);
    b.className = `act ${cls}`;
    b.title = title;
    b.setAttribute('aria-label', title);
    const i = document.createElement('i');
    i.className = `ic ${icon}`;
    i.setAttribute('aria-hidden', 'true');
    b.appendChild(i);
    return b;
  };
  // a real <a>: middle-click, ⌘-click and "open in a new window" all behave
  const open = mkAct('a', 'open', 'Open in a new tab', 'ic-external');
  open.href = fileUrl(f);
  open.target = '_blank';
  open.rel = 'noopener';
  const save = mkAct('a', 'save', 'Save to your inbox', 'ic-download');
  save.href = fileUrl(f);
  save.download = f.name || '';
  // Everything occasional — and everything destructive — behind the ⋯, so Delete
  // is never a neighbour of the action the user actually came for.
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'menu-item danger';
  const delIcon = document.createElement('i');
  delIcon.className = 'ic ic-trash';
  delIcon.setAttribute('aria-hidden', 'true');
  del.append(delIcon, document.createTextNode('Delete from both devices'));
  del.onclick = async e => {
    e.stopPropagation();
    if (!await confirmDialog(`Delete “${f.name}” from both devices?`)) return;
    try {
      await api(`/api/files/${f.id}`, { method: 'DELETE' });
      fileRemove(f.id);
      toast('Deleted');
    } catch { toast('Delete failed'); }
  };
  const panel = document.createElement('div');
  panel.className = 'menu menu-right';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', `Actions for ${f.name}`);
  panel.appendChild(del);
  const menuBtn = mkAct('button', 'more', 'More actions', 'ic-more');
  menuBtn.type = 'button';
  menuBtn.setAttribute('aria-haspopup', 'true');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.onclick = e => { e.stopPropagation(); toggleRowMenu(panel, menuBtn); };
  const menuWrap = document.createElement('div');
  menuWrap.className = 'mpop f-menu';
  menuWrap.append(menuBtn, panel);
  const actions = document.createElement('div');
  actions.className = 'f-actions';
  actions.append(open, save, menuWrap);
  // The row's own surface answers the keyboard as well as the mouse: Enter opens,
  // ⌘S saves, ⌫ deletes. Without this the actions only existed under the pointer
  // (DESIGN.md §5 — “keyboard parity”), and Tab cannot reveal what it cannot see.
  info.onclick = ev => fileAct(ev);
  info.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileAct(); return; }
    if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    e.preventDefault();
    del.click();
  };
  row.append(dir, info, actions);
  return row;
}

function renderFiles() {
  const box = $('#transfers');
  box.innerHTML = '';
  // grouped by day, filtered by the same origin state the grid uses
  let day = null;
  for (const f of filesView()) {
    const ms = startOfDay(f.created_at);
    if (ms !== day) { day = ms; box.appendChild(makeDayHead(ms)); }
    box.appendChild(buildFileRow(f));
  }
  // Re-apply the selection the render was made with: the rows are new nodes, so
  // an SSE insert or a paged load would otherwise drop every ✓ while the set —
  // and the bulk bar's count — still held the ids. Guarded by selectedKey()
  // because with Show all this runs while the set holds CAPTURE ids, and capture
  // #4 must not paint file #4 as selected. Day headers are skipped: they carry no
  // dataset.id, and a header wearing a ✓ is a selection badge on nothing.
  if (selectedKey() === 'file') {
    for (const row of transferRows(box)) paintFileSelect(row, selected.has(Number(row.dataset.id)));
  }
  updateFileCount();
  applyTab();
  updateBulkBar(); // the universe changed — "Select all" may now be pointless
}

async function loadFiles(incremental = false) {
  if (filesLoadBusy) return;
  filesLoadBusy = true;
  const loading = $('#transfers-loading');
  if (!filesLoaded && !incremental) {
    filesLoadError = false; // a retry clears the error state as it starts
    loading.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty-sub', textContent: 'Loading transfers…' }));
    applyTab();
  }
  try {
    const q = incremental && filesBefore !== null ? `?before=${filesBefore}&limit=100` : '?limit=100';
    const page = await api(`/api/files${q}`);
    filesAvailable = true;
    filesLoadError = false;
    if (incremental && filesBefore !== null) {
      const have = new Set(filesList.map(f => f.id));
      filesList = filesList.concat(page.filter(f => !have.has(f.id)));
    } else {
      filesList = page;
    }
    filesSeen = new Set(filesList.map(f => f.id));
    filesLoaded = true;
    filesBefore = page.length ? page[page.length - 1].id : filesBefore;
    filesMoreAvailable = page.length === 100;
    renderFiles();
  } catch (e) {
    if (String(e).includes('404')) {
      filesAvailable = false; // backend not updated yet — show the notice, keep everything else working
      filesLoaded = false;
      renderFiles();
    } else if (!filesLoaded) {
      // Never flash "No transfers yet." for a failed request — and never sit on
      // "Loading transfers…" forever either: a real error state with its own
      // Retry is shown instead (see applyTab / #transfers-retry).
      filesLoadError = true;
    }
  } finally {
    filesLoadBusy = false;
    applyTab();
  }
}
$('#files-load-more').onclick = () => { if (!filesLoadBusy && filesMoreAvailable) loadFiles(true); };
// a failed transfers load has a way back that doesn't involve hunting for the
// already-active tab: an explicit retry in the error state
$('#transfers-retry').onclick = () => { if (!filesLoadBusy && filesAvailable) loadFiles(); };

function filePush(f) {
  if (!filesAvailable) { filesAvailable = true; $('#transfers-fallback').classList.add('hidden'); }
  if (filesSeen.has(f.id)) return;
  filesSeen.add(f.id);
  filesList.unshift(f); // newest first
  // newest first: at the top — and inside the right day group, creating that
  // group when this is the first file of a new day. (The old if/else had two
  // byte-identical branches — one of them dead code pretending to be a
  // fallback.) A row a filter hides is not inserted at all: it stays in
  // filesList, so clearing the filter brings it back on the next render.
  if (!filterActive() || matchFile(f)) fileInsertRow($('#transfers'), f);
  updateFileCount();
  applyTab();
  const fromPhone = f.dir === 'phone';
  const inboxNote = fromPhone && filesToInbox ? ' — saved to inbox' : '';
  toast(`📄 ${f.name} ${fromPhone ? 'from your phone' : 'sent to phone'}${inboxNote}`, 3500);
}

function fileRemove(id) {
  filesSeen.delete(id);
  filesList = filesList.filter(f => f.id !== id);
  // a deleted row must not stay in the bulk selection — and only while the set
  // is the FILES one, or a file id could evict the capture id that shares it
  if (selectedKey() === 'file') selected.delete(Number(id));
  const row = document.querySelector(`.transfer-row[data-id="${id}"]`);
  if (row) {
    row.classList.add('removing');
    setTimeout(() => {
      row.remove();
      pruneDayHeads($('#transfers')); // a day header with no rows left is noise
      applyTab();
    }, 200);
  }
  updateFileCount();
}

// ---------- uploads with real progress (XHR — fetch can't report progress) ----------
const filesUploading = new Map(); // uploadId -> { name, row }
let uploadSeq = 0;
function uploadRow(name) {
  const row = document.createElement('div');
  row.className = 'upload-row';
  const meta = document.createElement('div');
  meta.className = 'u-meta';
  const nm = document.createElement('span');
  nm.className = 'u-name';
  nm.append(
    Object.assign(document.createElement('i'), { className: 'ic ic-upload' }),
    document.createTextNode(` ${name}`)
  );
  const pct = document.createElement('span');
  pct.className = 'u-pct';
  pct.textContent = '0%';
  meta.append(nm, pct);
  const bar = document.createElement('div');
  bar.className = 'u-bar';
  const fill = document.createElement('i');
  bar.appendChild(fill);
  row.append(meta, bar);
  return { row, pct, fill };
}
function uploadFileXHR(f) {
  return new Promise((resolve, reject) => {
    const id = ++uploadSeq;
    const ui = uploadRow(f.name || 'file');
    const box = $('#transfers-uploads');
    box.appendChild(ui.row);
    box.classList.remove('hidden');
    filesUploading.set(id, ui);
    applyTab();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    xhr.responseType = 'json';
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const p = Math.round((e.loaded / e.total) * 100);
      ui.fill.style.transform = `scaleX(${(p / 100).toFixed(3)})`; // compositor-only progress
      ui.pct.textContent = p === 100 ? 'processing…' : p + '%';
    }; 
    xhr.onload = () => {
      filesUploading.delete(id);
      ui.row.remove();
      if (!box.children.length && !filesUploading.size) applyTab();
      if (xhr.status >= 200 && xhr.status < 300) {
        // SSE usually delivers the row first; this is the local fallback
        if (xhr.response && xhr.response.id != null) filePush(xhr.response);
        resolve(xhr.response);
      } else if (xhr.status === 413) {
        reject(new Error('too large'));
      } else if (xhr.status === 404) {
        filesAvailable = false;
        applyTab();
        reject(new Error('server updating'));
      } else {
        // carry the status on the Error so the caller can branch on it (a
        // string-match on the message was the only way to spot a 429)
        const err = new Error(`upload failed ${xhr.status}`);
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => {
      filesUploading.delete(id);
      ui.row.remove();
      if (!box.children.length && !filesUploading.size) applyTab();
      reject(new Error('network'));
    };
    const fd = new FormData();
    fd.append('dir', 'pc'); // direction badge (declared BEFORE the file part)
    fd.append('file', f, f.name || 'file');
    xhr.send(fd);
  });
}
async function uploadAnyFiles(files) {
  if (!filesAvailable) { toast('Server updating — file transfer coming', 3000); return; }
  toast(`Sending ${files.length} file${files.length > 1 ? 's' : ''}…`);
  let failed = 0;
  // 2 concurrent: big files share LAN bandwidth without starving each other
  const queue = [...files];
  // File transfers have their OWN token bucket, so a burst large enough to
  // exhaust it must back off and retry rather than dropping the tail (the
  // capture path already does this with the same bounded shape).
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      for (let t = 0; ; t++) {
        try { await uploadFileXHR(f); break; }
        catch (e) {
          if (e && e.status === 429 && t < 4) {
            await new Promise(r => setTimeout(r, 400 * 2 ** t)); // 400/800/1600/3200ms
            continue;
          }
          failed++;
          if (String(e.message).includes('too large')) toast(`${f.name} is over the size cap`, 3500);
          break;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, files.length) }, worker));
  if (failed) toast(`${failed} file${failed > 1 ? 's' : ''} failed to send`, 3500);
  else toast('Sent ✓ — tap the chip on your phone');
}

// tab + show-all wiring. Both the pointer and the keyboard path go through
// selectTab, so the visual state, the remembered tab and the roving tabindex
// can never drift apart.
const TAB_IDS = { captures: '#tab-captures', transfers: '#tab-transfers' };
function selectTab(t, { focus = false } = {}) {
  // the selection is scoped to the tab that made it: capture ids and file ids
  // are different spaces, so carrying a set across the switch would hand the
  // files route a set of capture ids (see selectedKey)
  if (selectMode && t !== activeTab) clearSelection();
  activeTab = t;
  localStorage.pp_tab = t;
  applyTab();
  if (focus) $(TAB_IDS[t]).focus(); // automatic activation: focus follows selection
  // the transfers list is fetched lazily — a capture-only user never pays for it
  if (t === 'transfers' && !filesLoaded && filesAvailable) loadFiles();
}
$('#tab-captures').onclick = () => selectTab('captures');
$('#tab-transfers').onclick = () => selectTab('transfers');
// ARIA tabs keyboard pattern: arrows move between the two tabs, Home/End jump
// to the first/last. The same pattern the extension popup implements — here the
// tabs were plain buttons, so Tab/Shift+Tab was the only way across and the
// pattern's own keys did nothing.
for (const t of ['captures', 'transfers']) {
  $(TAB_IDS[t]).addEventListener('keydown', e => {
    const dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1
      : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
    if (!dir) {
      if (e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      selectTab(e.key === 'Home' ? 'captures' : 'transfers', { focus: true });
      return;
    }
    e.preventDefault();
    selectTab(t === 'captures' ? 'transfers' : 'captures', { focus: true });
  });
}
$('#show-all').onchange = () => {
  localStorage.pp_show_all = $('#show-all').checked ? '1' : '0';
  applyTab();
  if ($('#show-all').checked && !filesLoaded && filesAvailable) loadFiles();
};
$('#file-input').onchange = e => {
  const fs = [...e.target.files];
  e.target.value = '';
  if (fs.length) uploadAnyFiles(fs);
};
$('#file-add-btn').onclick = () => {
  if (!filesAvailable) { toast('Server updating — file transfer coming', 3000); return; }
  $('#file-input').click(); // programmatic open — the button (unlike the old label) is tab-reachable
};

// ---------- webcam scan (this PC's camera) ----------
// scan.js owns the camera, the OpenCV detection and the corner UI, and exposes
// window.PPScan.open()/close(). The harness routes only its two triggers — the
// toolbar button and Esc — and the module reaches the SAME /upload endpoint as
// every other PC capture, so a scan needs no new server route.
$('#scan-btn').onclick = () => window.PPScan?.open();
$('#scan-backdrop').addEventListener('mousedown', e => { if (e.target.id === 'scan-backdrop') window.PPScan?.close(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && escLayer() === 'scan') window.PPScan?.close();
});

// ---------- the four keys that act on the APP, not on a tile ----------
// Save N — the download every row already offers, issued for the whole
// selection. A capture saves its original from /media, a transfer from its own
// /file route; `download` is how the browser names and stores it, so this is
// exactly the per-row gesture repeated, not a second mechanism with its own
// bugs. ("Save to your inbox" in this app has always meant this browser
// download — see the transfer row's own save link.)
function saveSelection() {
  if (!selected.size) return;
  const targets = selectedKey() === 'file'
    ? filesList.filter(f => selected.has(f.id)).map(f => ({ url: fileUrl(f), name: f.name || '' }))
    : captures.filter(c => selected.has(c.id)).map(c => ({ url: `/media/${encodeURIComponent(c.file)}`, name: c.file || '' }));
  for (const t of targets) {
    const a = document.createElement('a');
    a.href = t.url;
    a.download = t.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  if (targets.length) toast(`Saving ${targets.length}…`, 3000);
}
// 1 · Captures  2 · Transfers  3 · Both (the Show-all state), plus the three
// chords that act on the SELECTION. One listener for all of them, and each
// guard is narrow on purpose: a bare digit has no browser meaning, but ⌘C and
// ⌘S do — so they are only intercepted when this app has something to do with
// them, leaving Ctrl+C on selected TEXT and Ctrl+S on the page untouched.
document.addEventListener('keydown', e => {
  if (modalOpen() || popupOpen()) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const mod = e.ctrlKey || e.metaKey;
  // 1/2/3 switch the view the segmented control switches (and 3 is the same
  // state its "Show all" checkbox owns — set through the checkbox so nothing
  // can disagree about which view is up).
  if (!mod && !e.altKey && (e.key === '1' || e.key === '2' || e.key === '3')) {
    if (!capturesVisible() && !transfersVisible()) return;
    e.preventDefault();
    const showAll = e.key === '3';
    $('#show-all').checked = showAll;
    localStorage.pp_show_all = showAll ? '1' : '0';
    selectTab(e.key === '2' ? 'transfers' : 'captures');
    if (showAll && !filesLoaded && filesAvailable) loadFiles();
    return;
  }
  if (!mod || e.altKey) return;
  // ⌘A — select the whole active list. The bulk bar only exists in Select mode,
  // so this enters it first (the same click the button performs).
  if (e.key === 'a' || e.key === 'A') {
    if (!capturesVisible() && !transfersVisible()) return;
    e.preventDefault();
    if (!selectMode) $('#select-btn').click();
    $('#bulk-all').click();
    return;
  }
  // ⌘C — copy the selection. Captures only (`#bulk-copy` is cap-only: the
  // clipboard holds images, and a transferred file is not one). With nothing
  // selected the browser keeps its own Ctrl+C.
  if ((e.key === 'c' || e.key === 'C') && !e.shiftKey) {
    if (selectedKey() !== 'capture' || !selected.size) return;
    e.preventDefault();
    $('#bulk-copy').click();
    return;
  }
  // ⌘⇧S — save the selection (browser downloads, one per item).
  if ((e.key === 's' || e.key === 'S') && e.shiftKey) {
    if (!selected.size) return;
    e.preventDefault();
    saveSelection();
    return;
  }
});

// auto-save-to-inbox toggle (shared setting, synced via SSE 'settings' —
// the value itself arrives in the settings bundle, see applySettings)
$('#auto-inbox').onchange = async e => {
  const next = e.target.checked;
  try {
    const r = await api('/api/files-inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: next }),
    });
    filesToInbox = r.on === true;
    toast(next ? 'Phone files auto-save to the inbox folder' : 'Phone files stay in ProofPipe only');
  } catch {
    toast('Could not save setting');
    e.target.checked = !next;
  }
};

// storage folder picker (server-side live relocation — captures, transfer
// files and inbox copies move together, no restart, no database touch)
let mediaDirPath = '';
function setMediaDirLabel(p) {
  mediaDirPath = p || '';
  const el = $('#media-dir-path');
  el.textContent = p || '…';
  el.title = p || '';
}
function showDirErr(msg) {
  const el = $('#dir-err');
  el.textContent = msg;
  el.classList.remove('hidden');
}
async function openDirPicker() {
  $('#dir-backdrop').classList.remove('hidden');
  $('#dir-err').classList.add('hidden');
  $('#dir-manual').value = mediaDirPath || '';
  $('#dir-current').textContent = mediaDirPath || '';
  setTimeout(() => { $('#dir-manual').focus(); $('#dir-manual').select(); }, 0);
  trapFocus($('#dir-backdrop'), $('#dir-manual'));
}
function closeDirPicker() {
  $('#dir-backdrop').classList.add('hidden');
  untrapFocus($('#dir-backdrop'));
}
$('#media-dir-change').onclick = openDirPicker;

// ---------- settings modal (moved out of the side info card) ----------
// All toggles keep their original element IDs, so their existing handlers
// (auto-copy / auto-cleanup / auto-inbox binds) work untouched. This block
// only owns open/close: fast scale+fade, focus trapped like the other dialogs.
let settingsHideTimer = 0;
function openSettings() {
  const bd = $('#settings-backdrop');
  // a pending close (the exit transition runs for 100ms) must not hide the
  // dialog we are opening right now — that left an invisible modal holding the
  // focus trap, with Esc unable to reach it
  clearTimeout(settingsHideTimer);
  bd.classList.remove('hidden');
  requestAnimationFrame(() => bd.setAttribute('data-open', '')); // next frame: transition runs
  trapFocus(bd, $('#settings-close'));
}
function closeSettings() {
  const bd = $('#settings-backdrop');
  bd.removeAttribute('data-open'); // play the exit transition…
  clearTimeout(settingsHideTimer);
  settingsHideTimer = setTimeout(() => { // …then hide; 100ms < the .12s transition end
    bd.classList.add('hidden');
    untrapFocus(bd);
  }, 100);
}
$('#settings-btn').onclick = openSettings;
$('#settings-close').onclick = closeSettings;
$('#settings-backdrop').addEventListener('mousedown', e => { if (e.target.id === 'settings-backdrop') closeSettings(); });
document.addEventListener('keydown', e => {
  // only when SETTINGS is the top layer — with the folder dialog open above it,
  // one Esc used to close both dialogs at once
  if (e.key === 'Escape' && escLayer() === 'settings') closeSettings();
});
$('#dir-cancel').onclick = closeDirPicker;
$('#dir-browse').onclick = async () => {
  // real OS picker: the server opens the Windows folder dialog on the PC
  // screen (a web page can never learn absolute paths by itself)
  const btn = $('#dir-browse');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Pick a folder on the PC…';
  try {
    const r = await api('/api/pick-folder', { method: 'POST', timeoutMs: 600000 });
    if (r.path) {
      $('#dir-manual').value = r.path;
      $('#dir-err').classList.add('hidden');
    } else if (!r.cancelled) {
      showDirErr('Folder picker failed — paste the path instead');
    }
    // cancelled: dialog closed without choosing — leave the field as-is
  } catch {
    showDirErr('Folder picker failed — paste the path instead');
  } finally { btn.disabled = false; btn.textContent = label; }
};
$('#dir-backdrop').addEventListener('mousedown', e => { if (e.target.id === 'dir-backdrop') closeDirPicker(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && escLayer() === 'dir') closeDirPicker();
});
$('#dir-use').onclick = async () => {
  const target = $('#dir-manual').value.trim();
  if (!target) { showDirErr('Paste an absolute folder path first'); return; }
  const btn = $('#dir-use');
  btn.disabled = true;
  try {
    const r = await api('/api/media-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target }),
      timeoutMs: 600000, // moving thousands of files can take a while
    });
    setMediaDirLabel(r.path);
    closeDirPicker();
    toast(`Captures and files now save to ${r.path}`, 4000);
  } catch (e) {
    const s = String((e && e.message) || e);
    showDirErr(s.includes('409') ? 'A move is already running — try again in a moment'
      : s.includes('400') ? 'That folder cannot be used — absolute path, writable, not nested in the current one'
      : 'Move failed — everything stayed where it was');
  } finally { btn.disabled = false; }
};

// ---------- backup (server zips DB + settings + all media into the chosen folder) ----------
$('#backup-btn').onclick = async () => {
  const btn = $('#backup-btn');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Picking folder…';
  try {
    // same OS folder picker the media-dir row uses — the zip lands where the
    // user points, on the PC desktop (the endpoint is loopback-only)
    const pick = await api('/api/pick-folder', { method: 'POST', timeoutMs: 600000 });
    if (!pick.path) { // cancelled or picker failed — do nothing, say nothing
      return;
    }
    btn.textContent = 'Backing up…';
    toast('Backup started — zipping captures, files and database…', 4000);
    const r = await api('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: pick.path }),
      timeoutMs: 1800000, // large galleries may take longer than ten minutes
    });
    toast(`✅ Backup written: ${r.path} (${fmtBytes(r.bytes)})`, 6000);
  } catch (e) {
    const s = String((e && e.message) || e);
    toast(s.includes('409') ? 'A backup is already running — wait for it to finish'
      : s.includes('400') ? 'That folder cannot be used — pick a writable folder'
      : /AbortError|TimeoutError|timed out/i.test(s)
        ? 'Backup is still running — check the destination folder when it finishes'
        : 'Backup failed — see the server console');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};

// restore remembered tab / show-all
if (localStorage.pp_show_all === '1') $('#show-all').checked = true;
activeTab = localStorage.pp_tab === 'transfers' ? 'transfers' : 'captures';
// fetch the transfers list only when the restored view actually shows it — a
// capture-only user used to pay for a 100-row /api/files request on every load
if (activeTab === 'transfers' || $('#show-all').checked) loadFiles();
applyTab();

// ---------- text sync ----------
const textState = { latest: 0 }; // newest text id seen (any direction)
// How many texts the glance beside the field shows. ONE: it is the single answer
// to "did my last message land", in the smallest space that can hold a row, and
// the dialog behind the band's mail icon is the conversation. It was two rows in
// a card above the captures grid, where it cost the grid 112px of height; beside
// the field it costs the grid nothing at all.
const RECENT_TEXTS = 1;

async function copyTextSmart(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  // legacy fallback — still works over plain http for text
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

async function loadTexts() {
  try {
    // combined feed (both directions) so the history shows the whole conversation
    const list = await api('/api/text?limit=20');
    textState.latest = list.reduce((m, t) => Math.max(m, t.id ?? 0), textState.latest);
    // The glance beside the compose field: the most recent text in BOTH
    // directions, so "what did I just send" and "what did my phone just say" are
    // answered where the eye already is instead of in a dropdown two clicks away.
    const rows = $('#text-recent-rows');
    rows.innerHTML = ''; // a text is immutable once sent, so the rows are rebuilt
    for (const t of list.slice(0, RECENT_TEXTS)) rows.appendChild(textRow(t));
    $('#text-recent').classList.toggle('hidden', !list.length);
    // The full conversation is painted only while its dialog is open: 200 rows
    // nobody is looking at is 200 buttons in the tab order.
    if (!$('#texts-backdrop').classList.contains('hidden')) paintTextsList(list);
  } catch {}
}
// ONE row anatomy for a text, shared by the band's glance and the full dialog: direction
// ICON (which device it came from or went to), the message, and how long ago.
// A real <button> — the old clickable <div> had no tab stop, so copying a past
// text had no keyboard path at all — and clicking it copies, which is what the
// texts are for.
function textRow(t) {
  const fromPhone = t.source === 'phone';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'text-item';
  const dir = document.createElement('i');
  dir.className = `ic ${fromPhone ? 'ic-phone' : 'ic-pc'} t-dir ${fromPhone ? 'in' : 'out'}`;
  dir.setAttribute('aria-hidden', 'true');
  const txt = document.createElement('span');
  txt.className = 't-body';
  txt.textContent = t.body;
  const when = document.createElement('span');
  when.className = 't-when';
  when.textContent = timeAgo(t.created_at);
  b.append(dir, txt, when);
  b.title = `${fromPhone ? 'From your phone' : 'Sent from this PC'} · ${fullTime(t.created_at)} — click to copy`;
  b.setAttribute('aria-label', `${fromPhone ? 'From your phone' : 'Sent from this PC'}, ${timeAgo(t.created_at)}: ${t.body}`);
  b.onclick = async () => toast(await copyTextSmart(t.body) ? 'Copied to clipboard' : 'Copy failed');
  return b;
}
function paintTextsList(list) {
  const box = $('#texts-list');
  box.innerHTML = '';
  for (const t of list) box.appendChild(textRow(t));
  $('#texts-empty').classList.toggle('hidden', !!list.length);
}
// The full conversation, in the SAME dialog shell as Settings: one backdrop, one
// focus trap, Escape and a backdrop click both close it. Rows copy on click.
let textsHideTimer = 0;
function openTexts() {
  const bd = $('#texts-backdrop');
  clearTimeout(textsHideTimer);
  bd.classList.remove('hidden');
  requestAnimationFrame(() => bd.setAttribute('data-open', ''));
  api('/api/text?limit=200').then(paintTextsList).catch(() => {});
  trapFocus(bd, $('#texts-close'));
}
function closeTexts() {
  const bd = $('#texts-backdrop');
  bd.removeAttribute('data-open');
  clearTimeout(textsHideTimer);
  textsHideTimer = setTimeout(() => { bd.classList.add('hidden'); untrapFocus(bd); }, 100);
}
$('#texts-btn').onclick = openTexts;
$('#texts-close').onclick = closeTexts;
$('#texts-backdrop').addEventListener('mousedown', e => { if (e.target.id === 'texts-backdrop') closeTexts(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && escLayer() === 'texts') closeTexts();
});

async function sendText() {
  const body = $('#text-input').value.trim();
  if (!body) return;
  try {
    await api('/api/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, source: 'pc' }),
    });
    $('#text-input').value = '';
    toast('Sent to phone ✓');
  } catch { toast('Send failed'); }
}
const textInput = $('#text-input');
textInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});
// auto-grow, coalesced to ONE measure+write per frame: setting height:auto then
// the field does NOT auto-grow any more: it is one row inside a fixed 64px band,
// so a long draft scrolls inside it instead of pushing the library down. The old
// listener also forced a synchronous layout per keystroke (set height:auto, read
// scrollHeight, write height) to do it.
$('#text-send').onclick = sendText;
loadTexts();

// ---------- live updates: SSE push + poll fallback ----------
const es = new EventSource('/events');
let reloadTimer = null;
// 50ms: coalesces bursts yet keeps "lands on the harness" feeling instant
const queueReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => loadCaptures(true).catch(() => {}), 50); };
es.onmessage = e => {
  // events are JSON ({type, capture/id}); plain strings fall back (legacy/heartbeat safety)
  let m; try { m = JSON.parse(e.data); } catch { m = { type: e.data }; }
  // capture/file events move storage count/bytes — stats ride the event
  // stream (coalesced) instead of a blind 15s poll
  if (m.type === 'capture' || m.type === 'capture-ready' || m.type === 'deleted' || m.type === 'file' || m.type === 'file-deleted') scheduleStats();
  if (m.type === 'open-latest') {
    if (view.length) { openLightbox(view[0]); toast('Opened from your phone'); }
  } else if (m.type === 'text') {
    loadTexts();
    toast('Text from phone');
  } else if (m.type === 'phone') {
    // a phone just came online (server.js pushes this on the transition, not on
    // every keep-alive ping) — refresh stats now so updateQr() retires the
    // pairing QR the moment it is scanned, instead of on the next capture event
    // or the SSE-down 15s poll.
    scheduleStats();
  } else if (m.type === 'settings') {
    // The event carries the WHOLE settings bundle (server.js settingsBundle),
    // so it is applied directly — this branch used to fire 9 GETs for data the
    // event had already handed us.
    applySettings(m);
  } else if (m.type === 'file' && m.row && m.row.id != null) {
    filePush(m.row);
  } else if (m.type === 'file-deleted' && (m.id != null || Array.isArray(m.ids))) {
    // a coalesced batch (our own bulk bar, the cap sweeper) carries `ids`; the
    // single-row path carries `id`. Either way the rows we hold are dropped
    // locally — no list refetch for a delete we already know about.
    for (const id of (m.ids?.length ? m.ids : [m.id])) if (id != null) fileRemove(Number(id));
  } else if (m.type === 'file' || m.type === 'file-deleted') {
    // payload-less batch event (a cleanup sweep coalesces its rows into one) —
    // refetch the list once instead of once per deleted file
    loadFiles();
  } else if (m.type === 'capture' && m.capture && m.capture.id != null) {
    // the grid's paint signal: the thumbnail EXISTS by now, so the tile
    // appears fully painted — no empty tile, no onerror retry flash.
    // ('capture-ready' arrives earlier but only arms auto-copy/relay paths.)
    if (!captures.some(c => c.id === m.capture.id)) {
      captures.unshift(m.capture); // newest-first; syncGrid respects the active sort
      syncGrid();
      maybeAutoCopy(m.capture); // toggle armed → the new capture is already on the clipboard
    }
  } else if (m.type === 'capture-ready' && m.capture && m.capture.id != null) {
    // auto captures only (server scopes this event). Tile NOT added here —
    // the thumbnail doesn't exist yet; the post-thumb 'capture' event above
    // paints the grid.
    maybeAutoCopy(m.capture);
  } else if (m.type === 'deleted' && m.id != null) {
    // push carries the deleted id — remove just that tile, NO refetch
    if (captures.some(c => c.id === m.id)) {
      pngCache.delete(m.id); // don't keep dead full-res PNGs in the cache
      dropTimeCache(m.id);   // and its timestamp-memo entries
      knownIds.delete(m.id); // identity set must not outlive the row
      const lbOpen = !$('#lightbox').classList.contains('hidden');
      const shownId = lbOpen ? view[lbIndex]?.id : null;
      captures = captures.filter(c => c.id !== m.id);
      selected.delete(m.id);
      document.querySelector(`.capture[data-id="${m.id}"]`)?.remove();
      computeView();
      // CRITICAL: re-derive the keyboard cache. Removing the node straight from
      // the DOM left gridCache.cells holding a DETACHED tile, so arrow-key
      // navigation could land on it (focus fails, activeElement falls back to
      // <body>) and X/D/C/P then resolved their target from a stale index — a
      // destructive key could act on the wrong capture.
      refreshGridCache();
      updateEmptyState(view.length);
      updateBulkBar();
      if (lbOpen && shownId === m.id) view.length ? lbNav(0) : closeLightbox();
    }
  } else if (m.type === 'capture' || m.type === 'capture-ready' || m.type === 'deleted') {
    // legacy/payload-less events land HERE — full refresh. Must stay reachable:
    // the branches above narrow to payload-carrying events only (a bare
    // m.capture.id access on an undefined row used to throw and kill this handler).
    queueReload();
  } else {
    // UNKNOWN event type = the server's SSE contract moved past this page's
    // JS (a stale tab after a server restart — the exact failure that freezes
    // the grid until F5). Re-arm the version check: if the server really is
    // newer, the update banner appears; if not, this costs one cached fetch.
    checkPageVersion({ force: true });
  }
};
es.onopen = () => { sseReady = true; setStatusDot('ok'); };
es.onerror = () => { sseReady = false; setStatusDot('warn'); };
// 'ok'   = SSE live · 'warn' = SSE dropped, the poll fallback is carrying (data
// may lag ~3s) · 'off' = the server itself is unreachable. The 'off' state was
// described in the old comment but could never be reached: nothing set it and
// style.css had no .dot.off rule at all.
function setStatusDot(state) {
  $('#conn-dot').className = 'dot ' + state;
  $('#conn-text').textContent = state === 'ok' ? 'Live'
    : state === 'warn' ? 'reconnecting…'
    : 'server unreachable';
}
let pollBusy = false; // ONE check at a time: a hung request must not stack ticks
setInterval(async () => { // fallback if SSE drops; also catches deletes/texts done elsewhere
  if (pollBusy || document.hidden || es.readyState === 1) return;
  pollBusy = true;
  try {
    const v = await api('/api/captures/version');
    setStatusDot('warn'); // the server answered — only the SSE stream is down
    const fullyLoaded = !moreAvailable;
    const capsChanged = v.latest !== (captures[0]?.id ?? 0) || (fullyLoaded && v.n !== captures.length);
    const textChanged = v.textId !== undefined && v.textId !== textState.latest;
    if (textChanged) loadTexts();
    if (capsChanged) {
      // SSE is down (poll fallback) — still honor auto-copy for a fresh phone snap
      api('/api/captures?limit=1').then(page => maybeAutoCopy(page && page[0])).catch(() => {});
      loadCaptures(true).catch(() => {}); // floating refresh: a rejection here must not go unhandled
    }
  } catch { setStatusDot('off'); } // nothing answered at all
  finally { pollBusy = false; }
}, 3000);

showSkeletons();
loadCaptures().catch(() => {
  // Never turn a connection error into a false "No captures yet." claim. Keep a
  // distinct retryable state; the background retry below can restore the grid.
  document.querySelectorAll('.capture.skel').forEach(el => el.remove());
  capturesLoadError = true;
  updateEmptyState(0);
  toast('Could not load captures — retrying…');
  setTimeout(() => loadCaptures().catch(() => {}), 5000);
});
