// Capture list fetch strategy:
// direct fetch first — the popup is an extension context (chrome-extension://
// origin), so its fetches carry host_permissions, do NOT trigger per-site
// Local-Network-Access prompts, and get real Blobs (no base64 inflation).
// The background service worker is the fallback for locked-down Chrome builds.
const $ = s => document.querySelector(s);
// one status writer: clears the error tint on success, sets it on failure
function setStatus(text, isErr = false) {
  const el = $('#status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('err', !!isErr);
}
// Port discovery (shared contract with background.js via discovery.js):
// manual override (pp_port) → pinned origin (pp_host) → default port →
// 8780–8800 scan → extras. The popup keeps its own direct-fetch fallback
// list but now derives it from the SAME source — the old private copy had
// drifted from the background's (different ports, different order).
async function candidateBases() {
  let pinned = null;
  let manualPort = null;
  try { ({ pp_host: pinned = null, pp_port: manualPort = null } = await chrome.storage?.local?.get(['pp_host', 'pp_port']) || {}); } catch {}
  return PPDiscovery.originList({ pinned, manualPort });
}

// ---------- manual server port override ----------
// The scan only covers 8780–8800 + a few legacy favorites; a server on any
// other port needs the user to say so. Persisted as pp_port, probed first.
function wirePortOverride() {
  const input = $('#port-input');
  const save = $('#port-save');
  const status = $('#port-status');
  chrome.storage?.local?.get('pp_port').then(({ pp_port } = {}) => {
    if (pp_port != null) input.value = String(pp_port);
  }).catch(() => {});
  save.onclick = async () => {
    const raw = input.value.trim();
    try {
      if (raw === '') { // cleared → back to pure discovery
        await chrome.storage.local.remove('pp_port');
        try { await chrome.runtime.sendMessage({ type: 'resetHost' }); } catch {}
        status.textContent = 'Port override cleared — auto-discovery';
        return;
      }
      const port = PPDiscovery.parsePort(raw);
      if (port == null) {
        status.textContent = 'Enter a port number between 1 and 65535';
        return;
      }
      await chrome.storage.local.set({ pp_port: port });
      // resetHost makes the SW re-read pp_port and re-probe with the new port
      try { await chrome.runtime.sendMessage({ type: 'resetHost' }); } catch {}
      status.textContent = `Port ${port} saved — checking…`;
      // immediate feedback: try the override directly, AND verify it's
      // actually ProofPipe — any web app can 200 on /api/version, the same
      // identity check every other probe uses (isProofPipe in background/
      // offscreen) guards against "Server found ✓" pointing at a foreign app
      let found = false;
      for (const tpl of PPDiscovery.HOST_TPLS) {
        try {
          const r = await fetch(tpl.replace('PORT', String(port)) + '/api/version', { signal: AbortSignal.timeout(1500) });
          if (!r.ok) continue;
          const j = await r.json().catch(() => null);
          if (j && typeof j.version === 'string' && /^v\d/.test(j.version)) { found = true; break; }
        } catch {}
      }
      status.textContent = found ? `Server found on port ${port} ✓` : `No server answered on port ${port} — is ProofPipe running there?`;
    } catch (e) {
      status.textContent = `Save failed: ${String((e && e.message) || e)}`;
    }
  };
}
wirePortOverride();

// Bounded requests (the extension had no fetch timeouts at all): a half-open LAN
// connection left the popup on "Loading…" forever. JSON answers are small and
// must fail fast; media blobs get the room a real photo needs.
const JSON_TIMEOUT_MS = 4000;
const MEDIA_TIMEOUT_MS = 15000;

// popup is click-to-copy only: never select text, never start drags — EXCEPT in
// the error block, where the detail span is the one thing a user needs to select
// (to paste the failure into a bug report or a terminal)
document.addEventListener('selectstart', e => {
  // text fields are inherently selectable (the port override) and the error
  // block's detail span must be copyable — everything else stays click-to-copy
  if (e.target instanceof Element && e.target.closest('.empty, input, textarea')) return;
  e.preventDefault();
});
document.addEventListener('dragstart', e => e.preventDefault());

async function bg(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res || res.error) throw new Error((res && res.error) || 'no response');
  return res;
}

let lastKnownHost = null;

async function fetchCaptures() {
  const hit = await PPDiscovery.fetchFirst(await candidateBases(), '/api/captures', undefined, JSON_TIMEOUT_MS);
  if (hit) { lastKnownHost = hit.base; return await hit.response.json(); }
  try { return await bg({ type: 'captures' }); } catch {}
  throw new Error('server unreachable from the extension (direct + SW)');
}

async function openWorkbenchTab() {
  let targetUrl = lastKnownHost;
  if (!targetUrl) {
    try {
      const { pp_host } = await chrome.storage?.local?.get('pp_host') || {};
      if (pp_host) targetUrl = pp_host;
    } catch {}
  }
  if (!targetUrl) {
    try {
      const res = await bg({ type: 'getHost' });
      if (res && res.host) targetUrl = res.host;
    } catch {}
  }
  if (!targetUrl) targetUrl = `http://127.0.0.1:${PPDiscovery.DEFAULT_PORT}`;
  const clean = targetUrl.endsWith('/') ? targetUrl : `${targetUrl}/`;
  try {
    await chrome.tabs.create({ url: clean });
  } catch {
    setStatus('Could not open workbench tab.', true);
  }
}

async function deleteCaptureById(id) {
  const hit = await PPDiscovery.fetchFirst(await candidateBases(), `/api/captures/${id}`, { method: 'DELETE' }, JSON_TIMEOUT_MS);
  if (hit) { lastKnownHost = hit.base; return await hit.response.json(); }
  return await bg({ type: 'deleteCapture', id });
}

async function deleteTextById(id) {
  const hit = await PPDiscovery.fetchFirst(await candidateBases(), `/api/text/${id}`, { method: 'DELETE' }, JSON_TIMEOUT_MS);
  if (hit) { lastKnownHost = hit.base; return await hit.response.json(); }
  return await bg({ type: 'deleteText', id });
}

// object URL of a media file (thumbnail or original) — no dataURL round trip.
// Cached per popup session: reopening the popup doesn't re-download thumbs.
// server filename guard: shared module (extension/files.js, loaded before this
// script) — it used to be a private copy kept in lockstep with the background
// worker's and the content script's by hand.
const safeFile = PPFiles.safe;
const mediaUrlCache = new Map();
// the popup is short-lived, but blob URLs pin their bytes until its renderer
// goes away — hand them back on teardown
addEventListener('pagehide', () => {
  for (const u of mediaUrlCache.values()) URL.revokeObjectURL(u);
  mediaUrlCache.clear();
});

// Thumbnails load when they scroll into VIEW. The list is up to 100 rows while
// the popup shows ~6, so the old eager fetch fired ~100 LAN requests on open
// (img.loading='lazy' never helped: the fetch starts before src is assigned).
// rootMargin fetches one screen ahead so scrolling never outruns the LAN.
const thumbTargets = new WeakMap(); // item -> { c, img }
let thumbObserver = null;
try {
  thumbObserver = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      thumbObserver.unobserve(en.target);
      const t = thumbTargets.get(en.target);
      if (!t) continue;
      fetchMediaUrl(`t-${t.c.file}`).then(u => { if (t.img.isConnected) t.img.src = u; }).catch(() => {});
    }
  }, { root: $('#list'), rootMargin: '160px' });
} catch { thumbObserver = null; }
// raw Blob of a media file (for clipboard re-encode and object URLs)
async function fetchMediaBlob(file) {
  const hit = await PPDiscovery.fetchFirst(await candidateBases(), `/media/${safeFile(file)}`, undefined, MEDIA_TIMEOUT_MS);
  if (hit) return await hit.response.blob();
  try {
    const blob = await bg({ type: 'mediaBlob', file });
    if (blob instanceof Blob) return blob;
  } catch {}
  return null;
}

async function fetchMediaUrl(file) {
  const safe = safeFile(file);
  if (mediaUrlCache.has(safe)) return mediaUrlCache.get(safe);
  const blob = await fetchMediaBlob(file);
  if (!blob) return '';
  const u = URL.createObjectURL(blob);
  mediaUrlCache.set(safe, u);
  return u;
}

// toPng comes from the shared toPng.js loaded before popup.js

// Server rows carry "YYYY-MM-DD HH:MM:SS" in UTC. This panel printed the raw
// slice of that string ("09-12 04:31" = UTC) while the harness and the phone
// both render the viewer's LOCAL time.
function popupWhen(sql) {
  const d = PPDiscovery.parseUtcDate(sql);
  return d ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function copiedFlash(el, msg) {
  el.classList.add('copied');
  setStatus(msg);
  setTimeout(() => el.classList.remove('copied'), 1200);
}

async function copyCapture(capture, el) {
  setStatus(`Copying #${capture.id}…`);
  try {
    const blob = await fetchMediaBlob(capture.file);
    if (!blob) throw new Error('no image');
    const png = await toPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    if (el) copiedFlash(el, `✓ Copied #${capture.id} — Ctrl+V into your chat`);
    else setStatus(`✓ Copied #${capture.id} — Ctrl+V into your chat`);
  } catch {
    setStatus('Copy failed — use the p button on the page and drag instead.', true);
  }
}

let lastCaps = [];
let lastTexts = [];
let filterQuery = '';

function originBadge(originVal) {
  const isPc = originVal === 'pc';
  const span = document.createElement('span');
  span.className = `origin-badge ${isPc ? 'pc' : 'phone'}`;
  span.textContent = isPc ? 'PC' : 'Phone';
  return span;
}

function renderReachError(prefix, err) {
  const list = $('#list');
  list.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  const msg = document.createElement('span');
  msg.textContent = prefix;
  const detail = document.createElement('span');
  detail.className = 'err-detail';
  detail.textContent = String((err && err.message) || err);

  const actions = document.createElement('div');
  actions.className = 'empty-actions';

  const connBtn = document.createElement('button');
  connBtn.type = 'button';
  connBtn.id = 'err-conn-settings';
  connBtn.className = 'recovery-btn';
  connBtn.textContent = 'Open Connection Settings';
  connBtn.onclick = () => {
    const adv = $('details.ext-advanced');
    if (adv) adv.open = true;
    const portInput = $('#port-input');
    if (portInput) { portInput.scrollIntoView({ block: 'nearest' }); portInput.focus(); }
  };

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.id = 'err-test-8787';
  testBtn.className = 'recovery-btn';
  testBtn.textContent = `Test Port ${PPDiscovery.DEFAULT_PORT}`;
  testBtn.onclick = async () => {
    testBtn.disabled = true;
    const p = PPDiscovery.DEFAULT_PORT;
    setStatus(`Testing port ${p}…`);
    let foundUrl = null;
    for (const host of [`http://127.0.0.1:${p}`, `http://localhost:${p}`]) {
      try {
        const r = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) continue;
        const j = await r.json().catch(() => null);
        if (j && typeof j.version === 'string' && /^v\d/.test(j.version)) { foundUrl = host; break; }
      } catch {}
    }
    testBtn.disabled = false;
    if (foundUrl) {
      lastKnownHost = foundUrl;
      const portStatus = $('#port-status');
      if (portStatus) portStatus.textContent = `Server found on port ${p} ✓`;
      try { await chrome.runtime.sendMessage({ type: 'resetHost' }); } catch {}
      setStatus(`✓ Connected on port ${p}`);
      await showTab(activeTab);
    } else {
      setStatus(`No server answered on port ${p} — start ProofPipe first.`, true);
    }
  };

  const wbBtn = document.createElement('button');
  wbBtn.type = 'button';
  wbBtn.id = 'err-open-workbench';
  wbBtn.className = 'recovery-btn';
  wbBtn.textContent = 'Open Workbench';
  wbBtn.onclick = () => openWorkbenchTab();

  actions.append(connBtn, testBtn, wbBtn);
  empty.append(msg, detail, actions);
  list.appendChild(empty);
}

function renderCaps() {
  const list = $('#list');
  list.innerHTML = '';
  if (thumbObserver) thumbObserver.disconnect();
  if (!lastCaps.length) {
    list.innerHTML = '<div class="empty">No captures yet.<br>Snap from your phone or click Screenshot above.</div>';
    return;
  }
  const q = filterQuery;
  const rows = q
    ? lastCaps.filter(c => {
        const orig = c.origin === 'pc' ? 'pc' : 'phone';
        const hay = `#${c.id} ${c.file || ''} ${orig} ${popupWhen(c.created_at)}`.toLowerCase();
        return hay.includes(q);
      })
    : lastCaps;
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = `No captures match "${filterQuery}".`;
    list.appendChild(empty);
    return;
  }
  // thumbnails stream in per item AS IT SCROLLS INTO VIEW (see thumbObserver)
  for (const c of rows) {
    const d = document.createElement('div');
    d.className = 'item';
    d.title = `#${c.id} — click to copy`;
    const img = document.createElement('img');
    img.loading = 'lazy';
    if (thumbObserver) {
      thumbTargets.set(d, { c, img });
      thumbObserver.observe(d);
    } else {
      fetchMediaUrl(`t-${c.file}`).then(u => { img.src = u; }).catch(() => {});
    }
    const info = document.createElement('div');
    info.className = 'item-main';
    const idLine = document.createElement('div');
    idLine.className = 'item-top';
    const idTxt = document.createElement('span');
    idTxt.textContent = `#${c.id}`;
    idLine.append(idTxt, originBadge(c.origin));
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = popupWhen(c.created_at);
    info.append(idLine, meta);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'item-del';
    delBtn.textContent = '×';
    delBtn.title = `Delete capture #${c.id}`;
    delBtn.setAttribute('aria-label', `Delete capture #${c.id}`);
    delBtn.onclick = async e => {
      e.stopPropagation();
      delBtn.disabled = true;
      try {
        await deleteCaptureById(c.id);
        lastCaps = lastCaps.filter(x => x.id !== c.id);
        renderCaps();
        setStatus(`✓ Deleted capture #${c.id}`);
      } catch {
        delBtn.disabled = false;
        setStatus(`Could not delete capture #${c.id}.`, true);
      }
    };

    d.append(img, info, delBtn);
    d.onclick = () => copyCapture(c, d);
    // keyboard-reachable: copying is this panel's primary action
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    d.setAttribute('aria-label', `Capture #${c.id} from ${c.origin === 'pc' ? 'PC' : 'Phone'} — copy to clipboard`);
    d.onkeydown = e => {
      if (e.target.closest && e.target.closest('.item-del')) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.click(); }
    };
    list.appendChild(d);
  }
}

async function loadList() {
  try {
    lastCaps = await fetchCaptures();
    renderCaps();
  } catch (e) {
    renderReachError('ProofPipe server not reachable from Chrome. Start ProofPipe, then press ⟳ Sync now.', e);
  }
}

// ---------- texts from the phone: tap to copy ----------
async function fetchTexts() {
  const hit = await PPDiscovery.fetchFirst(await candidateBases(), '/api/text?source=phone&limit=10', undefined, JSON_TIMEOUT_MS);
  if (hit) { lastKnownHost = hit.base; return await hit.response.json(); }
  try { return await bg({ type: 'texts' }); } catch {}
  throw new Error('server unreachable');
}

function renderTexts() {
  const list = $('#list');
  list.innerHTML = '';
  if (thumbObserver) thumbObserver.disconnect();
  if (!lastTexts.length) {
    list.innerHTML = '<div class="empty">No texts from the phone yet.<br>Send one from the phone\'s text box, or share text to ProofPipe on Android.</div>';
    return;
  }
  const q = filterQuery;
  const rows = q
    ? lastTexts.filter(t => {
        const src = t.source === 'pc' ? 'pc' : 'phone';
        const hay = `${t.body || ''} #${t.id} ${src} ${popupWhen(t.created_at)}`.toLowerCase();
        return hay.includes(q);
      })
    : lastTexts;
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = `No texts match "${filterQuery}".`;
    list.appendChild(empty);
    return;
  }
  for (const t of rows) {
    const d = document.createElement('div');
    d.className = 'titem';
    d.title = 'Click to copy';
    const main = document.createElement('div');
    main.className = 'titem-main';
    const body = document.createElement('div');
    body.className = 'titem-body';
    body.textContent = t.body;
    const when = document.createElement('div');
    when.className = 'when';
    const when_ = popupWhen(t.created_at);
    const metaTxt = document.createElement('span');
    metaTxt.textContent = `#${t.id}${when_ ? ` · ${when_}` : ''}`;
    when.append(originBadge(t.source), metaTxt);
    main.append(body, when);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'item-del';
    delBtn.textContent = '×';
    delBtn.title = `Delete text #${t.id}`;
    delBtn.setAttribute('aria-label', `Delete text #${t.id}`);
    delBtn.onclick = async e => {
      e.stopPropagation();
      delBtn.disabled = true;
      try {
        await deleteTextById(t.id);
        lastTexts = lastTexts.filter(x => x.id !== t.id);
        renderTexts();
        setStatus(`✓ Deleted text #${t.id}`);
      } catch {
        delBtn.disabled = false;
        setStatus(`Could not delete text #${t.id}.`, true);
      }
    };

    d.append(main, delBtn);
    d.onclick = async () => {
      try {
        await navigator.clipboard.writeText(t.body);
        copiedFlash(d, '✓ Copied — Ctrl+V anywhere');
      } catch {
        setStatus('Copy failed — select and copy the text manually.', true);
      }
    };
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    d.setAttribute('aria-label', `Text from phone #${t.id} — copy`);
    d.onkeydown = e => {
      if (e.target.closest && e.target.closest('.item-del')) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.click(); }
    };
    list.appendChild(d);
  }
}

async function loadTexts() {
  try {
    lastTexts = await fetchTexts();
    renderTexts();
  } catch (e) {
    renderReachError('ProofPipe server not reachable from Chrome.', e);
  }
}

// ---------- tabs ----------
let activeTab = 'caps';
function showTab(tab) {
  activeTab = tab;
  const isCaps = tab === 'caps';
  $('#tab-caps').classList.toggle('active', isCaps);
  $('#tab-texts').classList.toggle('active', !isCaps);
  $('#list').setAttribute('aria-labelledby', isCaps ? 'tab-caps' : 'tab-texts');
  // keep aria-selected in lockstep with the visual .active class — assistive
  // tech reads the attribute, not the class
  $('#tab-caps').setAttribute('aria-selected', String(isCaps));
  $('#tab-texts').setAttribute('aria-selected', String(!isCaps));
  paintTabFocus(); // roving tabindex follows the selection
  $('#list').innerHTML = '<div class="empty">Loading…</div>';
  // return the promise so the sync button can await the refresh
  return tab === 'caps' ? loadList() : loadTexts();
}
const TABS = ['caps', 'texts'];
const tabEl = t => $(t === 'caps' ? '#tab-caps' : '#tab-texts');
// ARIA tabs: ONE tab in the tab order (roving tabindex) and arrows move the
// selection. Both tabs used to be plain buttons, so Tab/Shift+Tab was the only
// way across — it skipped past the pattern and left the inactive panel's control
// in the tab order.
function paintTabFocus() {
  for (const t of TABS) tabEl(t).tabIndex = t === activeTab ? 0 : -1;
}
function selectTab(t, { focus = false } = {}) {
  showTab(t).catch(() => {});
  if (focus) tabEl(t).focus(); // automatic activation: focus follows selection
}
for (const t of TABS) {
  tabEl(t).addEventListener('keydown', e => {
    const dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1
      : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
    if (!dir) {
      if (e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      selectTab(e.key === 'Home' ? TABS[0] : TABS[TABS.length - 1], { focus: true });
      return;
    }
    e.preventDefault();
    const next = TABS[(TABS.indexOf(activeTab) + dir + TABS.length) % TABS.length];
    selectTab(next, { focus: true });
  });
}
$('#tab-caps').onclick = () => showTab('caps');
$('#tab-texts').onclick = () => showTab('texts');

$('#sync').onclick = async () => {
  const btn = $('#sync');
  btn.setAttribute('aria-busy', 'true'); // spins the icon while re-probing
  $('#list').innerHTML = '<div class="empty">Checking…</div>';
  try { await chrome.runtime.sendMessage({ type: 'resetHost' }); } catch {}
  await showTab(activeTab);
  btn.removeAttribute('aria-busy');
};
$('#open-workbench')?.addEventListener('click', () => openWorkbenchTab());

const searchInput = $('#search-input');
const searchClear = $('#search-clear');
if (searchInput) {
  const applyFilter = () => {
    filterQuery = searchInput.value.trim().toLowerCase();
    searchClear?.classList.toggle('hidden', !searchInput.value);
    if (activeTab === 'caps') renderCaps();
    else renderTexts();
  };
  searchInput.addEventListener('input', applyFilter);
  if (searchClear) {
    searchClear.onclick = () => {
      searchInput.value = '';
      applyFilter();
      searchInput.focus();
    };
  }
}

// ---------- p button hide/show ----------
// The global flag lives in chrome.storage.local and THIS popup owns it: the
// button reads and writes storage directly, so it works from any tab —
// including chrome:// pages and our own harness origin, where no content
// script is injected and a sendMessage-based toggle would silently fail.
// Open tabs follow the change through storage.onChanged.
const FAB_GLOBAL_HIDE_KEY = 'pp_fab_global_hidden';

const fabToggle = $('#fab-toggle');
const fabToggleLabel = $('#fab-toggle-label');
const fabToggleIcon = fabToggle.querySelector('.ic');

function paintFabToggle(hidden) {
  fabToggleLabel.textContent = hidden ? 'Show p button everywhere' : 'Hide p button everywhere';
  fabToggle.classList.toggle('off', hidden);
  fabToggleIcon.className = `ic ${hidden ? 'ic-eye-off' : 'ic-eye'}`;
  fabToggle.title = hidden
    ? 'The p button is hidden on every site — click to bring it back'
    : 'Hide the p button on every site';
}

async function readFabHidden() {
  try {
    const r = await chrome.storage.local.get(FAB_GLOBAL_HIDE_KEY);
    return r && r[FAB_GLOBAL_HIDE_KEY] === true;
  } catch { return false; }
}

async function refreshFabToggle() {
  paintFabToggle(await readFabHidden());
}

fabToggle.onclick = async () => {
  const next = !(await readFabHidden());
  try {
    await chrome.storage.local.set({ [FAB_GLOBAL_HIDE_KEY]: next });
  } catch {
    setStatus('Could not save the setting.', true);
    return;
  }
  paintFabToggle(next);
  setStatus(next ? 'p button hidden everywhere' : 'p button is visible ✓');
  refreshUnhideBtn();
};

// another surface (a second popup, or a tab that changed it) can flip the flag
// while this popup is open
try {
  chrome.storage.local.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[FAB_GLOBAL_HIDE_KEY]) refreshFabToggle();
  });
} catch {}
refreshFabToggle();

// restore the p button if it was hidden on this site (right-click on it hides).
// The global hide has its own button above — this row is per-site only, so it
// shows only when THIS site is the thing hiding it.
async function refreshUnhideBtn() {
  const btn = $('#unhide');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'fabState' });
    btn.style.display = res && res.hidden && !res.globallyHidden ? 'block' : 'none';
    btn.textContent = 'Show p button on this site';
    // Surface why auto-paste fell back on THIS site — on its OWN row. This
    // check is async and used to write into #status, racing showTab's paint:
    // the two overwrote each other depending on which landed last.
    const notice = $('#notice');
    // no emoji glyph in the notice: it renders per-OS and screen readers announce
    // it verbosely before the sentence (same reasoning as the harness outbox badge)
    const msg = (res && res.undelivered > 0)
      ? `${res.undelivered} capture${res.undelivered === 1 ? '' : 's'} waiting — click this tab to copy`
      : (res && res.pasteFail)
        ? 'This site ignores paste events — auto-paste copies instead (click the chat box, Ctrl+V).'
        : '';
    notice.textContent = msg;
    notice.classList.toggle('hidden', !msg);
  } catch {
    btn.style.display = 'none'; // no content script here (e.g. a chrome:// page)
    const notice = $('#notice');
    notice.textContent = '';
    notice.classList.add('hidden');
  }
}
refreshUnhideBtn();

$('#unhide').onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) throw new Error('no tab');
    // unhideGlobal handles both per-site and global hide in one shot
    await chrome.tabs.sendMessage(tab.id, { type: 'unhideGlobal' });
    setStatus('p button is visible ✓');
    $('#unhide').style.display = 'none';
  } catch {
    setStatus('Open a normal website tab, then try again.', true);
  }
};

// ---------- two-way quick send: composer, 1-click tab link & screenshot ----------
async function sendTextToPhone(raw) {
  const body = String(raw || '').slice(0, 10000).trim();
  if (!body) return false;
  try {
    await bg({ type: 'sendText', body });
    return true;
  } catch {}
  const hit = await PPDiscovery.fetchFirst(await candidateBases(), '/api/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, source: 'pc' }),
  }, JSON_TIMEOUT_MS);
  if (hit) return true;
  throw new Error('server unreachable');
}

async function uploadCaptureDataUrl(dataUrl) {
  try {
    return await bg({ type: 'uploadCapture', dataUrl });
  } catch {}
  const fd = await PPDiscovery.dataUrlToUploadForm(dataUrl);
  const hit = await PPDiscovery.fetchFirst(await candidateBases(), '/upload', { method: 'POST', body: fd }, MEDIA_TIMEOUT_MS);
  if (hit) return await hit.response.json();
  throw new Error('upload failed');
}

function wireQuickSend() {
  const input = $('#quick-text');
  const sendBtn = $('#quick-send-btn');
  const linkBtn = $('#send-tab-link');
  const shotBtn = $('#send-tab-shot');
  if (!input || !sendBtn || !linkBtn || !shotBtn) return;

  const autoResize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(76, Math.max(32, input.scrollHeight)) + 'px';
  };
  input.addEventListener('input', autoResize);

  const submitQuickText = async () => {
    const val = input.value.trim();
    if (!val) { setStatus('Type a note or URL to send.', true); input.focus(); return; }
    sendBtn.disabled = true;
    setStatus('Sending to phone…');
    try {
      await sendTextToPhone(val);
      input.value = '';
      autoResize();
      setStatus('✓ Sent to phone');
    } catch {
      setStatus('Could not reach ProofPipe server.', true);
    } finally {
      sendBtn.disabled = false;
    }
  };
  sendBtn.onclick = submitQuickText;
  input.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitQuickText();
    }
  });

  linkBtn.onclick = async () => {
    linkBtn.disabled = true;
    setStatus('Sending tab link…');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tab && tab.url ? tab.url.trim() : '';
      if (!url || !/^https?:\/\//i.test(url)) {
        setStatus('Open a web page tab to send its link.', true);
        return;
      }
      await sendTextToPhone(url);
      setStatus('✓ Tab link sent to phone');
    } catch {
      setStatus('Could not send tab link — check server.', true);
    } finally {
      linkBtn.disabled = false;
    }
  };

  shotBtn.onclick = async () => {
    shotBtn.disabled = true;
    setStatus('Capturing visible tab…');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.windowId == null) throw new Error('no active tab');
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      setStatus('Uploading screenshot…');
      await uploadCaptureDataUrl(dataUrl);
      setStatus('✓ Screenshot sent — live on phone & workbench');
      if (activeTab === 'caps') await loadList();
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/permission|cannot access|activeTab|restricted/i.test(msg)) {
        setStatus('Cannot capture browser system pages.', true);
      } else {
        setStatus('Screenshot failed — check ProofPipe server.', true);
      }
    } finally {
      shotBtn.disabled = false;
    }
  };
}
wireQuickSend();

showTab(activeTab);
