const $ = s => document.querySelector(s);

const RELEASES = typeof PP_RELEASES !== 'undefined' ? PP_RELEASES : [];

const SCOPE_LABELS = {
  server: 'Server',
  phone: 'Phone PWA',
  extension: 'Extension',
};

let captures = [];
let files = [];
let texts = [];
let selectedFiles = new Set();
let selectedCaptures = new Set();
let captureSelectMode = false;
let captureSort = 'new';
let captureOriginFilter = 'all';
let compactGrid = false;
let capturesLoaded = false;
let filesLoaded = false;
let lightboxIdx = -1;
let lbZoomMode = 'fit';
let lbScale = 1;
let lbPanX = 0;
let lbPanY = 0;
let lbRotateBusy = false;
let activeSse = null;
let sseHadError = false;
let connRestoreTimer = null;
let qrHiddenByUser = false;
let toastTimer = null;
let settingsSaveBadgeTimer = null;
let activeReleaseCategory = 'all';
let releaseSearchQuery = '';
let resolvedPhoneUrl = `${location.origin}/phone`;

const fmtBytes = PPShared.fmtBytes;
const fmtTime = iso => PPShared.fmtClock(iso) || (iso || '');

function inferNotifTone(msg = '') {
  const s = String(msg).toLowerCase();
  if (/could not|failed|blocked|unavailable|offline|error/.test(s)) return 'err';
  if (/retry|limit|warning|lost|offline/.test(s)) return 'warn';
  return 'ok';
}

function attachNotifSwipe(el, onDismiss, { onHoldStart, onHoldEnd } = {}) {
  if (!el || el.dataset.swipeWired === '1') return;
  el.dataset.swipeWired = '1';
  let drag = null;
  let dismissTimer = 0;

  const resetVisual = () => {
    el.classList.remove('swiping');
    el.style.transform = '';
    el.style.opacity = '';
  };

  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest('button')) return;
    clearTimeout(dismissTimer);
    onHoldStart && onHoldStart();
    drag = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      t0: performance.now(),
      dx: 0,
      dy: 0,
      moved: false,
    };
    el.classList.add('swiping');
    try { el.setPointerCapture(e.pointerId); } catch {}
  });

  el.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = Math.max(-18, e.clientY - drag.y0);
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    drag.dx = dx;
    drag.dy = dy;
    const dist = Math.hypot(dx, Math.max(0, dy));
    el.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
    el.style.opacity = String(Math.max(0.18, 1 - dist / 140));
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
    const commit = d.moved && (
      Math.abs(d.dx) > 54
      || d.dy > 42
      || (Math.abs(vx) > 0.42 && Math.abs(d.dx) > 18)
      || (vy > 0.42 && d.dy > 16)
    );
    if (commit) {
      const tx = Math.abs(d.dx) >= Math.abs(d.dy) ? (d.dx >= 0 ? 160 : -160) : d.dx * 1.4;
      const ty = d.dy > 18 ? Math.max(48, d.dy * 1.8) : d.dy;
      el.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0)`;
      el.style.opacity = '0';
      dismissTimer = setTimeout(() => {
        resetVisual();
        onDismiss();
      }, 150);
    } else {
      resetVisual();
      onHoldEnd && onHoldEnd();
    }
  };

  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('mouseenter', () => { if (!drag) onHoldStart && onHoldStart(); });
  el.addEventListener('mouseleave', () => { if (!drag) onHoldEnd && onHoldEnd(); });
}

function dismissToast() {
  const el = $('#toast');
  if (!el) return;
  clearTimeout(toastTimer);
  toastTimer = null;
  el.classList.remove('swiping');
  el.style.transform = '';
  el.style.opacity = '';
  el.classList.add('hidden');
}

function scheduleToastHide(ms = 2600) {
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissToast, ms);
}

function showToast(msg, opts = {}) {
  const el = $('#toast');
  if (!el) return;
  const tone = opts.tone || inferNotifTone(msg);
  const duration = opts.duration || (tone === 'err' ? 3600 : 2600);
  attachNotifSwipe(el, dismissToast, {
    onHoldStart: () => clearTimeout(toastTimer),
    onHoldEnd: () => { if (!el.classList.contains('hidden')) scheduleToastHide(1800); },
  });
  el.dataset.tone = tone;
  el.dataset.duration = String(duration);
  el.textContent = msg;
  el.classList.remove('swiping');
  el.style.transform = '';
  el.style.opacity = '';
  el.classList.remove('hidden');
  scheduleToastHide(duration);
}

function showSettingsSaved(label = 'Saved ✓') {
  const pill = $('#settings-save-state');
  if (!pill) return;
  pill.textContent = label;
  pill.classList.remove('hidden');
  if (settingsSaveBadgeTimer) clearTimeout(settingsSaveBadgeTimer);
  settingsSaveBadgeTimer = setTimeout(() => pill.classList.add('hidden'), 2000);
}

// ---------- Modal Focus Trapping Stack ----------
const modalFocusStack = [];

function getModalFocusables(modal) {
  if (!modal) return [];
  const sel = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
  return [...modal.querySelectorAll(sel)].filter(el => {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    let cur = el;
    while (cur && cur !== modal) {
      if (cur.classList?.contains('hidden')) return false;
      cur = cur.parentElement;
    }
    return true;
  });
}

function activeFocusModal() {
  for (let i = modalFocusStack.length - 1; i >= 0; i--) {
    const entry = modalFocusStack[i];
    if (entry.modal && !entry.modal.classList.contains('hidden')) return entry;
  }
  return null;
}

function activateModalFocus(modal, initialEl = null) {
  if (!modal) return;
  const existingIdx = modalFocusStack.findIndex(e => e.modal === modal);
  const opener = existingIdx !== -1
    ? modalFocusStack[existingIdx].opener
    : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  if (existingIdx !== -1) modalFocusStack.splice(existingIdx, 1);
  modalFocusStack.push({ modal, opener });
  const focusables = getModalFocusables(modal);
  const target = (initialEl && focusables.includes(initialEl)) ? initialEl : (focusables[0] || modal);
  if (target === modal && !modal.hasAttribute('tabindex')) modal.tabIndex = -1;
  target?.focus?.();
}

function deactivateModalFocus(modal) {
  if (!modal) return;
  const idx = modalFocusStack.findIndex(e => e.modal === modal);
  if (idx === -1) return;
  const [entry] = modalFocusStack.splice(idx, 1);
  const opener = entry?.opener;
  if (opener && opener.isConnected && !opener.disabled && !opener.closest('.hidden')) {
    opener.focus();
  }
}

// ---------- PC Confirmation Modal (prevents accidental nuclear wipes) ----------
let confirmResolver = null;
function closePcConfirm(answer = false) {
  const bd = $('#pc-confirm-backdrop');
  if (bd) {
    bd.classList.add('hidden');
    deactivateModalFocus(bd);
  }
  if (confirmResolver) {
    const res = confirmResolver;
    confirmResolver = null;
    res(answer);
  }
}

function pcConfirm({ title, body = '', ok = 'Delete' }) {
  const bd = $('#pc-confirm-backdrop');
  const titleEl = $('#pc-confirm-title');
  const bodyEl = $('#pc-confirm-body');
  const okBtn = $('#pc-confirm-ok');
  const cancelBtn = $('#pc-confirm-cancel');
  if (!bd || !titleEl || !okBtn || !cancelBtn) {
    return Promise.resolve(true);
  }
  if (confirmResolver) closePcConfirm(false);
  titleEl.textContent = title;
  if (bodyEl) {
    bodyEl.textContent = body;
    bodyEl.classList.toggle('hidden', !body);
  }
  okBtn.textContent = ok;
  bd.classList.remove('hidden');
  activateModalFocus(bd, cancelBtn);
  return new Promise(resolve => {
    confirmResolver = resolve;
  });
}

// ---------- PC 5-Second Undo Snackbar for Single-Item Deletions ----------
let pcUndoState = null;

function flushPcUndo() {
  if (!pcUndoState) return;
  const { timer, perform } = pcUndoState;
  clearTimeout(timer);
  pcUndoState = null;
  const bar = $('#pc-undo-toast');
  if (bar) {
    bar.classList.remove('swiping');
    bar.style.transform = '';
    bar.style.opacity = '';
    bar.classList.add('hidden');
  }
  Promise.resolve().then(perform).catch(() => {});
}

function startPcUndo({ msg, perform, restore }) {
  if (pcUndoState) flushPcUndo();
  const bar = $('#pc-undo-toast');
  const msgEl = $('#pc-undo-msg');
  if (!bar || !msgEl) {
    Promise.resolve().then(perform).catch(() => {});
    return;
  }
  attachNotifSwipe(bar, flushPcUndo, {
    onHoldStart: () => { if (pcUndoState) clearTimeout(pcUndoState.timer); },
    onHoldEnd: () => {
      if (pcUndoState) pcUndoState.timer = setTimeout(flushPcUndo, 4000);
    },
  });
  msgEl.textContent = msg;
  bar.classList.remove('swiping');
  bar.style.transform = '';
  bar.style.opacity = '';
  bar.classList.remove('hidden');
  const timer = setTimeout(flushPcUndo, 5000);
  pcUndoState = { timer, perform, restore };
}

// ---------- Live PC Upload Progress Pill ----------
let pcTransferTotal = 0;
let pcTransferDone = 0;

function updatePcTransferUI(name, pct) {
  const pill = $('#pc-transfer-pill');
  const fill = $('#pc-transfer-fill');
  const text = $('#pc-transfer-text');
  if (!pill || !fill || !text) return;
  pill.classList.remove('hidden');
  const batchSuffix = pcTransferTotal > 1 ? ` (${Math.min(pcTransferDone + 1, pcTransferTotal)}/${pcTransferTotal})` : '';
  const pctLabel = pct == null || pct < 0 ? 'Uploading' : (pct >= 100 ? 'Processing' : `${pct}%`);
  text.textContent = `${pctLabel} · ${name}${batchSuffix}`;
  const itemFrac = pct == null || pct < 0 ? 0.5 : Math.max(0.08, Math.min(1, pct / 100));
  const scale = Math.max(0.12, Math.min(1, (pcTransferDone + itemFrac) / Math.max(1, pcTransferTotal)));
  pill.style.setProperty('--pc-xfer-scale', scale.toFixed(3));
}

function endPcTransferItem() {
  pcTransferDone++;
  if (pcTransferDone >= pcTransferTotal) {
    pcTransferTotal = 0;
    pcTransferDone = 0;
    const pill = $('#pc-transfer-pill');
    if (pill) {
      pill.classList.add('hidden');
      pill.style.setProperty('--pc-xfer-scale', '0');
    }
  }
}

async function uploadWithProgress(url, fd, name) {
  if (!pcTransferTotal) {
    pcTransferTotal = 1;
    pcTransferDone = 0;
  }
  updatePcTransferUI(name, 0);
  try {
    return await PPShared.xhrPost(url, fd, {
      onProgress: pct => updatePcTransferUI(name, pct),
    });
  } finally {
    endPcTransferItem();
  }
}

// Custom Liquid Glass Popover Menu logic
function closeAllGlassSelects(except = null) {
  for (const wrap of document.querySelectorAll('.glass-select.open')) {
    if (wrap === except) continue;
    wrap.classList.remove('open');
    wrap.querySelector('.glass-select-trigger')?.setAttribute('aria-expanded', 'false');
    wrap.querySelector('.glass-select-menu')?.classList.add('hidden');
  }
}

function setGlassSelectValue(wrap, val, notify = false) {
  if (!wrap) return;
  const options = [...wrap.querySelectorAll('.glass-select-option')];
  const match = options.find(o => o.dataset.value === val) || options[0];
  if (!match) return;
  const chosenVal = match.dataset.value || '';
  const chosenLabel = match.querySelector('span')?.textContent || match.textContent.trim();
  wrap.dataset.value = chosenVal;
  const labelEl = wrap.querySelector('.glass-select-label');
  if (labelEl) labelEl.textContent = chosenLabel;
  for (const opt of options) {
    const active = opt === match;
    opt.classList.toggle('active', active);
    opt.setAttribute('aria-selected', String(active));
  }
  if (notify && typeof wrap._onChange === 'function') {
    wrap._onChange(chosenVal);
  }
}

function setGlassSelectOptions(wrap, items, selectedValue) {
  if (!wrap) return;
  const menu = wrap.querySelector('.glass-select-menu');
  if (!menu) return;
  menu.replaceChildren();
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'glass-select-option';
    btn.setAttribute('role', 'option');
    btn.dataset.value = item.value;
    btn.setAttribute('aria-selected', 'false');

    const textSpan = document.createElement('span');
    textSpan.textContent = item.label;

    const checkSpan = document.createElement('span');
    checkSpan.className = 'glass-select-check';
    checkSpan.setAttribute('aria-hidden', 'true');
    checkSpan.textContent = '✓';

    btn.append(textSpan, checkSpan);
    menu.appendChild(btn);
  }
  setGlassSelectValue(wrap, selectedValue, false);
}

function wireGlassSelect(wrap, onChange) {
  if (!wrap) return;
  wrap._onChange = onChange;
  const trigger = wrap.querySelector('.glass-select-trigger');
  const menu = wrap.querySelector('.glass-select-menu');
  if (!trigger || !menu) return;

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = !wrap.classList.contains('open');
    closeAllGlassSelects(wrap);
    wrap.classList.toggle('open', willOpen);
    trigger.setAttribute('aria-expanded', String(willOpen));
    menu.classList.toggle('hidden', !willOpen);
  });

  menu.addEventListener('click', e => {
    const opt = e.target.closest('.glass-select-option');
    if (!opt) return;
    e.stopPropagation();
    setGlassSelectValue(wrap, opt.dataset.value, true);
    closeAllGlassSelects();
    trigger.focus();
  });

  wrap.addEventListener('keydown', e => {
    const options = [...wrap.querySelectorAll('.glass-select-option')];
    if (!options.length) return;
    const curIdx = Math.max(0, options.findIndex(o => o.dataset.value === wrap.dataset.value));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const nextOpt = options[(curIdx + dir + options.length) % options.length];
      if (nextOpt) setGlassSelectValue(wrap, nextOpt.dataset.value, true);
    } else if (e.key === 'Escape') {
      closeAllGlassSelects();
    }
  });
}

function syncRangeFill(rangeEl) {
  if (!rangeEl) return;
  const min = Number(rangeEl.min) || 0;
  const max = Number(rangeEl.max) || 100;
  const val = Number(rangeEl.value) || 0;
  const pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
  rangeEl.style.setProperty('--range-pct', `${pct}%`);
}

async function copyText(str) {
  try {
    await navigator.clipboard.writeText(str);
    showToast('Copied to clipboard');
  } catch {
    showToast('Clipboard access blocked');
  }
}

const pcPngCache = new Map(); // file -> Blob
const pcPngPending = new Map(); // file -> Promise<Blob>
const PC_PNG_BUDGET = 24 * 1024 * 1024;
let pcPngBytes = 0;

function pcPngPut(file, png) {
  if (pcPngCache.has(file)) {
    pcPngBytes -= pcPngCache.get(file).size;
    pcPngCache.delete(file);
  }
  pcPngCache.set(file, png);
  pcPngBytes += png.size;
  while (pcPngBytes > PC_PNG_BUDGET && pcPngCache.size > 1) {
    const oldest = pcPngCache.keys().next().value;
    pcPngBytes -= pcPngCache.get(oldest).size;
    pcPngCache.delete(oldest);
  }
}

function getCapturePng(file) {
  const cached = pcPngCache.get(file);
  if (cached) {
    pcPngCache.delete(file);
    pcPngCache.set(file, cached);
    return Promise.resolve(cached);
  }
  const pending = pcPngPending.get(file);
  if (pending) return pending;
  const p = (async () => {
    const res = await fetch(`/media/${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error('fetch failed');
    const blob = await res.blob();
    const pngBlob = typeof toPng === 'function' ? await toPng(blob) : blob;
    pcPngPut(file, pngBlob);
    return pngBlob;
  })().finally(() => pcPngPending.delete(file));
  pcPngPending.set(file, p);
  p.catch(() => {});
  return p;
}

async function copyCapturePng(file) {
  try {
    const pngPromise = getCapturePng(file);
    if (navigator.clipboard && window.ClipboardItem) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': await pngPromise })]);
      }
      showToast('Copied PNG to clipboard');
    } else {
      showToast('Clipboard API unavailable');
    }
  } catch {
    showToast('Could not copy image to clipboard');
  }
}

async function sendCaptureToPhone(file) {
  try {
    const url = `${location.origin}/media/${encodeURIComponent(file)}`;
    const r = await fetch('/api/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: url, source: 'pc', kind: 'media' }),
    });
    if (r.ok) showToast('Pinned capture to phone inbox');
  } catch {
    showToast('Failed to send capture to phone');
  }
}

function renderReleases() {
  const listEl = $('#release-list');
  const emptyEl = $('#release-empty');
  const countEl = $('#release-count');
  if (!listEl) return;

  const q = releaseSearchQuery.trim().toLowerCase();
  const filtered = [];

  for (const rel of RELEASES) {
    const matchingChanges = rel.changes.filter(ch => {
      if (activeReleaseCategory !== 'all' && ch.scope !== activeReleaseCategory) return false;
      if (!q) return true;
      if (!ch._hay) {
        ch._hay = `${rel.version} ${rel.headline} ${ch.title} ${ch.detail} ${SCOPE_LABELS[ch.scope] || ''}`.toLowerCase();
      }
      return ch._hay.includes(q);
    });
    if (matchingChanges.length > 0) {
      filtered.push({ ...rel, changes: matchingChanges });
    }
  }

  listEl.replaceChildren();
  const totalChanges = filtered.reduce((acc, r) => acc + r.changes.length, 0);
  if (countEl) {
    countEl.textContent = `Showing ${filtered.length} of ${RELEASES.length} versions · ${totalChanges} change${totalChanges === 1 ? '' : 's'}`;
  }

  if (!filtered.length) {
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');

  for (const rel of filtered) {
    const card = document.createElement('article');
    card.className = 'release-card';
    card.dataset.version = rel.version;

    const header = document.createElement('div');
    header.className = 'release-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'release-title-group';

    const ver = document.createElement('span');
    ver.className = 'release-version';
    ver.textContent = rel.version;

    const h3 = document.createElement('h3');
    h3.className = 'release-headline';
    h3.textContent = rel.headline;

    titleGroup.append(ver, h3);

    const meta = document.createElement('span');
    meta.className = 'release-meta';
    meta.textContent = `${rel.date} · ${rel.changes.length} addition${rel.changes.length === 1 ? '' : 's'}`;

    header.append(titleGroup, meta);

    const ul = document.createElement('ul');
    ul.className = 'release-items';

    for (const ch of rel.changes) {
      const li = document.createElement('li');
      const scope = document.createElement('span');
      scope.className = 'item-scope';
      scope.textContent = `[${SCOPE_LABELS[ch.scope] || ch.scope}]`;

      const strong = document.createElement('strong');
      strong.textContent = ch.title + ' — ';

      const text = document.createTextNode(ch.detail);
      li.append(scope, strong, text);
      ul.appendChild(li);
    }

    card.append(header, ul);
    listEl.appendChild(card);
  }
}

function filteredSortedCaptures() {
  const arr = captures.filter(c => {
    if (captureOriginFilter === 'phone') return c.origin !== 'pc';
    if (captureOriginFilter === 'pc') return c.origin === 'pc';
    return true;
  });
  if (captureSort === 'old') arr.sort((a, b) => a.id - b.id);
  else if (captureSort === 'size') arr.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  else arr.sort((a, b) => b.id - a.id);
  return arr;
}

function syncCaptureSelectionUI() {
  const grid = $('#grid');
  const selectBtn = $('#captures-select-btn');
  const selectAllBtn = $('#captures-select-all');
  const delSelBtn = $('#captures-delete-selected');
  const selCountEl = $('#captures-sel-count');
  const visible = filteredSortedCaptures();
  const count = selectedCaptures.size;
  const active = captureSelectMode || count > 0;

  if (grid) grid.classList.toggle('select-mode', active);
  if (selectBtn) {
    selectBtn.classList.toggle('hidden', captures.length === 0);
    selectBtn.textContent = captureSelectMode ? 'Done' : 'Select';
    selectBtn.setAttribute('aria-pressed', String(captureSelectMode));
  }
  if (selectAllBtn) {
    selectAllBtn.classList.toggle('hidden', !active || visible.length === 0);
    const allSelected = visible.length > 0 && visible.every(c => selectedCaptures.has(c.id));
    selectAllBtn.textContent = allSelected ? 'None' : 'All';
  }
  if (delSelBtn && selCountEl) {
    selCountEl.textContent = String(count);
    delSelBtn.classList.toggle('hidden', count === 0);
  }
}

function toggleCaptureSelected(id, tileEl, checkboxEl) {
  if (selectedCaptures.has(id)) selectedCaptures.delete(id);
  else selectedCaptures.add(id);
  const selected = selectedCaptures.has(id);
  if (tileEl) tileEl.classList.toggle('selected', selected);
  if (checkboxEl) checkboxEl.checked = selected;
  syncCaptureSelectionUI();
}

const captureTileById = new Map(); // capture.id -> { tile, img, badge, sizeSpan, timeSpan, dlLink, chk, cap }

function syncSelectionOnTiles() {
  for (const [id, entry] of captureTileById) {
    const sel = selectedCaptures.has(id);
    entry.tile.classList.toggle('selected', sel);
    entry.chk.checked = sel;
  }
  syncCaptureSelectionUI();
}

function buildCaptureTile(cap) {
  const isSelected = selectedCaptures.has(cap.id);
  const tile = document.createElement('article');
  tile.className = `cap-tile${isSelected ? ' selected' : ''}`;
  tile.dataset.id = String(cap.id);

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'cap-thumb-wrap';

  const selectWrap = document.createElement('label');
  selectWrap.className = 'cap-select-wrap';
  selectWrap.title = `Select capture #${cap.id}`;
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.className = 'pp-check cap-check';
  chk.checked = isSelected;
  chk.setAttribute('aria-label', `Select capture #${cap.id}`);
  const entry = { tile, chk, cap };
  chk.onchange = () => toggleCaptureSelected(entry.cap.id, tile, chk);
  selectWrap.onclick = e => e.stopPropagation();
  selectWrap.appendChild(chk);

  thumbWrap.onclick = e => {
    if (e.target.closest('.cap-hover-actions') || e.target.closest('.cap-select-wrap')) return;
    if (captureSelectMode || selectedCaptures.size > 0) {
      toggleCaptureSelected(entry.cap.id, tile, chk);
      return;
    }
    const idx = filteredSortedCaptures().findIndex(c => c.id === entry.cap.id);
    if (idx >= 0) openLightbox(idx);
  };

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = `/media/t-${encodeURIComponent(cap.file)}`;
  img.alt = `Capture #${cap.id}`;
  img.onerror = () => { img.src = `/media/${encodeURIComponent(entry.cap.file)}`; };

  const badge = document.createElement('span');
  const isPc = cap.origin === 'pc';
  badge.className = `cap-badge ${isPc ? 'pc' : 'phone'}`;
  badge.textContent = isPc ? 'PC' : 'Phone';

  const hoverActions = document.createElement('div');
  hoverActions.className = 'cap-hover-actions';

  const phoneBtn = document.createElement('button');
  phoneBtn.type = 'button';
  phoneBtn.className = 'toolbtn';
  phoneBtn.title = 'Pin capture to phone inbox';
  phoneBtn.setAttribute('aria-label', 'Pin capture to phone inbox');
  phoneBtn.innerHTML = '<i class="ic ic-phone"></i>';
  phoneBtn.onclick = e => {
    e.stopPropagation();
    sendCaptureToPhone(entry.cap.file);
  };

  const dlLink = document.createElement('a');
  dlLink.className = 'toolbtn';
  dlLink.href = `/media/${encodeURIComponent(cap.file)}`;
  dlLink.download = cap.file;
  dlLink.title = 'Download original';
  dlLink.setAttribute('aria-label', 'Download original');
  dlLink.innerHTML = '<i class="ic ic-download"></i>';
  dlLink.onclick = e => e.stopPropagation();

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'toolbtn cap-del-btn';
  delBtn.title = 'Delete capture';
  delBtn.setAttribute('aria-label', 'Delete capture');
  delBtn.innerHTML = '<i class="ic ic-trash"></i>';
  delBtn.onclick = e => {
    e.stopPropagation();
    deleteCapture(entry.cap.id);
  };

  hoverActions.append(phoneBtn, dlLink, delBtn);
  thumbWrap.append(img, badge, hoverActions, selectWrap);

  const footer = document.createElement('div');
  footer.className = 'cap-footer';

  const meta = document.createElement('div');
  meta.className = 'cap-meta';
  const sizeSpan = document.createElement('span');
  sizeSpan.className = 'cap-meta-size mono';
  sizeSpan.textContent = fmtBytes(cap.bytes || 0);
  const timeSpan = document.createElement('span');
  timeSpan.textContent = fmtTime(cap.created_at);
  meta.append(sizeSpan, timeSpan);

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn primary-tinted cap-copy-btn';
  copyBtn.title = 'Copy PNG to clipboard';
  copyBtn.innerHTML = '<i class="ic ic-copy"></i> Copy';
  copyBtn.onclick = () => copyCapturePng(entry.cap.file);

  footer.append(meta, copyBtn);
  tile.append(thumbWrap, footer);

  entry.img = img;
  entry.badge = badge;
  entry.sizeSpan = sizeSpan;
  entry.timeSpan = timeSpan;
  entry.dlLink = dlLink;
  return entry;
}

function updateCaptureTile(entry, cap) {
  const prevFile = entry.cap.file;
  entry.cap = cap;
  const sel = selectedCaptures.has(cap.id);
  entry.tile.classList.toggle('selected', sel);
  entry.chk.checked = sel;
  if (prevFile !== cap.file) {
    entry.img.src = `/media/t-${encodeURIComponent(cap.file)}`;
    entry.dlLink.href = `/media/${encodeURIComponent(cap.file)}`;
    entry.dlLink.download = cap.file;
  }
  const isPc = cap.origin === 'pc';
  entry.badge.className = `cap-badge ${isPc ? 'pc' : 'phone'}`;
  entry.badge.textContent = isPc ? 'PC' : 'Phone';
  entry.sizeSpan.textContent = fmtBytes(cap.bytes || 0);
}

function renderCaptures() {
  const grid = $('#grid');
  const empty = $('#grid-empty');
  const countBadge = $('#captures-count');
  const moreWrap = $('#captures-more-wrap');
  const clearBtn = $('#clear-captures');
  if (!grid) return;

  for (const id of [...selectedCaptures]) {
    if (!captures.some(c => c.id === id)) selectedCaptures.delete(id);
  }
  if (captures.length === 0) captureSelectMode = false;

  const list = filteredSortedCaptures();
  if (countBadge) countBadge.textContent = String(list.length);
  if (clearBtn) clearBtn.classList.toggle('hidden', captures.length === 0);
  syncCaptureSelectionUI();
  grid.classList.toggle('compact', compactGrid);

  if (!capturesLoaded) {
    captureTileById.clear();
    grid.replaceChildren();
    empty?.classList.add('hidden');
    moreWrap?.classList.add('hidden');
    for (let i = 0; i < 6; i++) {
      const sk = document.createElement('div');
      sk.className = 'cap-skel';
      sk.setAttribute('aria-hidden', 'true');
      sk.innerHTML = '<div class="cap-skel-thumb"></div><div class="cap-skel-foot"></div>';
      grid.appendChild(sk);
    }
    return;
  }

  for (const child of [...grid.children]) {
    if (child.classList.contains('cap-skel')) child.remove();
  }

  if (!list.length) {
    for (const [id, entry] of captureTileById) {
      entry.tile.remove();
      captureTileById.delete(id);
    }
    empty?.classList.remove('hidden');
    moreWrap?.classList.add('hidden');
    return;
  }
  empty?.classList.add('hidden');
  moreWrap?.classList.toggle('hidden', captures.length < 100);

  const visibleIds = new Set(list.map(c => c.id));
  for (const [id, entry] of captureTileById) {
    if (!visibleIds.has(id)) {
      entry.tile.remove();
      captureTileById.delete(id);
    }
  }

  let prev = null;
  list.forEach((cap, idx) => {
    let entry = captureTileById.get(cap.id);
    if (!entry) {
      entry = buildCaptureTile(cap);
      entry.tile.style.animationDelay = `${Math.min(idx * 12, 120)}ms`;
      captureTileById.set(cap.id, entry);
    } else {
      updateCaptureTile(entry, cap);
    }
    const wantNext = prev ? prev.nextSibling : grid.firstChild;
    if (entry.tile !== wantNext) grid.insertBefore(entry.tile, wantNext);
    prev = entry.tile;
  });
}

function applyLightboxTransform() {
  const img = $('#lightbox-img');
  const stage = $('#lightbox-stage');
  const zoomBtn = $('#lb-zoom');
  if (img) {
    img.style.transform = `translate(${lbPanX}px, ${lbPanY}px) scale(${lbScale})`;
  }
  if (stage) stage.classList.toggle('zoomed', lbScale > 1.01);
  if (zoomBtn) {
    zoomBtn.textContent = lbZoomMode === 'fit' ? 'Fit' : (lbZoomMode === '100' ? '100%' : '200%');
  }
}

function resetLightboxView() {
  lbZoomMode = 'fit';
  lbScale = 1;
  lbPanX = 0;
  lbPanY = 0;
  applyLightboxTransform();
}

function setLightboxZoomMode(mode) {
  const img = $('#lightbox-img');
  if (mode === 'fit') {
    resetLightboxView();
    return;
  }
  const natW = img?.naturalWidth || 0;
  const renW = img?.clientWidth || 0;
  const ratio = (natW > 0 && renW > 0) ? Math.max(1.5, natW / renW) : 1.75;
  lbZoomMode = mode;
  lbScale = mode === '200' ? Math.min(4, Math.max(2.2, ratio * 2)) : Math.min(3.5, ratio);
  lbPanX = 0;
  lbPanY = 0;
  applyLightboxTransform();
}

function cycleLightboxZoom() {
  if (lbZoomMode === 'fit') setLightboxZoomMode('100');
  else if (lbZoomMode === '100') setLightboxZoomMode('200');
  else setLightboxZoomMode('fit');
}

function syncLightboxHeader(cap, idx, list) {
  const originEl = $('#lb-origin');
  const indexEl = $('#lb-index');
  const dimsEl = $('#lb-dims');
  const meta = $('#lightbox-meta');
  const dl = $('#lb-download');
  const prevBtn = $('#lb-prev');
  const nextBtn = $('#lb-next');
  const img = $('#lightbox-img');

  if (originEl) {
    const isPc = cap.origin === 'pc';
    originEl.className = `cap-badge inline ${isPc ? 'pc' : 'phone'}`;
    originEl.textContent = isPc ? 'PC' : 'Phone';
  }
  if (indexEl) indexEl.textContent = `${idx + 1} / ${list.length}`;
  if (prevBtn) prevBtn.disabled = idx <= 0;
  if (nextBtn) nextBtn.disabled = idx >= list.length - 1;
  if (meta) meta.textContent = `${cap.file} · ${fmtBytes(cap.bytes || 0)} · ${fmtTime(cap.created_at)}`;
  if (dl) {
    dl.href = `/media/${encodeURIComponent(cap.file)}`;
    dl.download = cap.file;
  }
  if (dimsEl) {
    if (img?.complete && img.naturalWidth > 0) {
      dimsEl.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
      dimsEl.classList.remove('hidden');
    } else {
      dimsEl.classList.add('hidden');
    }
  }
}

const lightboxPrefetched = new Set();
function prefetchLightboxNeighbors(list, idx) {
  for (const offset of [-1, 1]) {
    const n = list[idx + offset];
    if (!n || lightboxPrefetched.has(n.file)) continue;
    lightboxPrefetched.add(n.file);
    if (lightboxPrefetched.size > 24) {
      lightboxPrefetched.delete(lightboxPrefetched.keys().next().value);
    }
    const pre = new Image();
    pre.decoding = 'async';
    pre.src = `/media/${encodeURIComponent(n.file)}`;
  }
}

function openLightbox(idx) {
  const list = filteredSortedCaptures();
  if (idx < 0 || idx >= list.length) return;
  lightboxIdx = idx;
  const cap = list[idx];
  const lb = $('#lightbox');
  const img = $('#lightbox-img');
  const dimsEl = $('#lb-dims');
  if (!lb || !img) return;
  const wasHidden = lb.classList.contains('hidden');

  resetLightboxView();
  if (dimsEl) dimsEl.classList.add('hidden');
  img.onload = () => {
    const cur = filteredSortedCaptures()[lightboxIdx];
    if (cur && cur.id === cap.id && dimsEl && img.naturalWidth > 0) {
      dimsEl.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
      dimsEl.classList.remove('hidden');
    }
  };
  img.src = `/media/${encodeURIComponent(cap.file)}`;
  syncLightboxHeader(cap, idx, list);
  lb.classList.remove('hidden');
  if (wasHidden) activateModalFocus(lb, $('#lb-close'));
  prefetchLightboxNeighbors(list, idx);
}

function closeLightbox() {
  lightboxIdx = -1;
  resetLightboxView();
  const lb = $('#lightbox');
  if (lb && !lb.classList.contains('hidden')) {
    lb.classList.add('hidden');
    deactivateModalFocus(lb);
  }
}

async function rotateLightboxCapture() {
  if (lbRotateBusy || lightboxIdx === -1) return;
  const list = filteredSortedCaptures();
  const cap = list[lightboxIdx];
  if (!cap) return;
  const btn = $('#lb-rotate');
  lbRotateBusy = true;
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(`/api/captures/${cap.id}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deg: 90 }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast(err.error || 'Could not rotate capture');
      return;
    }
    const { capture: updated } = await r.json();
    if (updated) {
      const i = captures.findIndex(c => c.id === updated.id);
      if (i !== -1) captures[i] = updated;
      renderCaptures();
      const refreshedList = filteredSortedCaptures();
      const nextIdx = refreshedList.findIndex(c => c.id === updated.id);
      if (nextIdx !== -1 && lightboxIdx !== -1) openLightbox(nextIdx);
      loadStats();
    }
    showToast('Rotated 90° clockwise');
  } catch {
    showToast('Could not rotate capture');
  } finally {
    lbRotateBusy = false;
    if (btn) btn.disabled = false;
  }
}

function deleteCapture(id) {
  const idx = captures.findIndex(c => c.id === id);
  if (idx === -1) return;
  const removed = captures[idx];
  captures.splice(idx, 1);
  if (lightboxIdx !== -1) closeLightbox();
  renderCaptures();

  startPcUndo({
    msg: `Deleted capture #${id}`,
    restore: () => {
      if (!captures.some(c => c.id === removed.id)) {
        captures.splice(Math.min(idx, captures.length), 0, removed);
        renderCaptures();
      }
    },
    perform: async () => {
      try {
        await fetch(`/api/captures/${id}`, { method: 'DELETE' });
        loadStats();
      } catch {
        loadCaptures();
      }
    },
  });
}

function syncFileSelectionUI() {
  const delSelBtn = $('#files-delete-selected');
  const selCountEl = $('#files-sel-count');
  if (delSelBtn && selCountEl) {
    selCountEl.textContent = String(selectedFiles.size);
    delSelBtn.classList.toggle('hidden', selectedFiles.size === 0);
  }
}

const fileRowById = new Map();

function buildFileRow(f) {
  const row = document.createElement('div');
  row.className = 'file-row';

  const left = document.createElement('div');
  left.className = 'file-row-left';

  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.className = 'pp-check';
  chk.checked = selectedFiles.has(f.id);
  chk.setAttribute('aria-label', `Select ${f.name}`);
  chk.onchange = () => {
    if (chk.checked) selectedFiles.add(f.id);
    else selectedFiles.delete(f.id);
    syncFileSelectionUI();
  };

  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = f.name;

  const sub = document.createElement('span');
  sub.className = 'file-sub';
  sub.textContent = `${f.dir === 'phone' ? 'Phone → PC' : 'PC → Phone'} · ${fmtBytes(f.bytes || 0)} · ${fmtTime(f.created_at)}`;

  left.append(chk, name, sub);

  const actions = document.createElement('div');
  actions.className = 'file-row-actions';

  const dl = document.createElement('a');
  dl.className = 'toolbtn';
  dl.href = `/file/${f.id}`;
  dl.download = f.name;
  dl.title = 'Save file';
  dl.innerHTML = '<i class="ic ic-download"></i> Save';

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'toolbtn icon-btn';
  del.title = 'Delete file';
  del.setAttribute('aria-label', `Delete ${f.name}`);
  del.innerHTML = '<i class="ic ic-trash"></i>';
  del.onclick = () => {
    const idx = files.findIndex(x => x.id === f.id);
    if (idx === -1) return;
    const removed = files[idx];
    files.splice(idx, 1);
    selectedFiles.delete(f.id);
    renderFiles();

    startPcUndo({
      msg: `Removed ${removed.name}`,
      restore: () => {
        if (!files.some(x => x.id === removed.id)) {
          files.splice(Math.min(idx, files.length), 0, removed);
          renderFiles();
        }
      },
      perform: async () => {
        try {
          await fetch(`/api/files/${f.id}`, { method: 'DELETE' });
          scheduleStats();
        } catch {
          loadFiles();
        }
      },
    });
  };

  actions.append(dl, del);
  row.append(left, actions);
  return { row, chk };
}

function renderFiles() {
  const listEl = $('#file-list');
  const emptyEl = $('#files-empty');
  const countEl = $('#files-count');
  const clearBtn = $('#clear-files');
  if (!listEl) return;

  if (countEl) countEl.textContent = String(files.length);
  if (clearBtn) clearBtn.classList.toggle('hidden', files.length === 0);
  for (const id of [...selectedFiles]) {
    if (!files.some(f => f.id === id)) selectedFiles.delete(id);
  }
  syncFileSelectionUI();

  if (!filesLoaded) {
    fileRowById.clear();
    listEl.replaceChildren();
    emptyEl?.classList.add('hidden');
    for (let i = 0; i < 3; i++) {
      const sk = document.createElement('div');
      sk.className = 'file-skel';
      sk.setAttribute('aria-hidden', 'true');
      listEl.appendChild(sk);
    }
    return;
  }
  for (const child of [...listEl.children]) {
    if (child.classList.contains('file-skel')) child.remove();
  }
  if (!files.length) {
    for (const [id, entry] of fileRowById) {
      entry.row.remove();
      fileRowById.delete(id);
    }
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');

  const visibleIds = new Set(files.map(f => f.id));
  for (const [id, entry] of fileRowById) {
    if (!visibleIds.has(id)) {
      entry.row.remove();
      fileRowById.delete(id);
    }
  }

  let prev = null;
  for (const f of files) {
    let entry = fileRowById.get(f.id);
    if (!entry) {
      entry = buildFileRow(f);
      fileRowById.set(f.id, entry);
    } else {
      entry.chk.checked = selectedFiles.has(f.id);
    }
    const wantNext = prev ? prev.nextSibling : listEl.firstChild;
    if (entry.row !== wantNext) listEl.insertBefore(entry.row, wantNext);
    prev = entry.row;
  }
}

function isUrlText(str) {
  return /^https?:\/\/\S+$/i.test(String(str || '').trim());
}

let renderedTextsSig = null;
function renderTexts() {
  const recentSec = $('#text-recent');
  const recentRows = $('#text-recent-rows');
  const dialogList = $('#texts-dialog-list');
  const countBadge = $('#texts-count');
  const clearBtn = $('#clear-texts-btn');
  const plainTexts = texts.filter(t => t.kind !== 'media');

  if (countBadge) countBadge.textContent = String(plainTexts.length);
  if (clearBtn) clearBtn.classList.toggle('hidden', plainTexts.length === 0);

  const nextSig = plainTexts.map(t => `${t.id}:${t.source}:${t.body}`).join('\n');
  if (nextSig === renderedTextsSig) return;
  renderedTextsSig = nextSig;

  if (recentSec && recentRows) {
    recentRows.replaceChildren();
    if (!plainTexts.length) {
      recentSec.classList.add('hidden');
    } else {
      recentSec.classList.remove('hidden');
      for (const t of plainTexts.slice(0, 3)) {
        const wrap = document.createElement('div');
        wrap.className = 'text-pill-wrap';

        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'text-pill';
        pill.title = 'Click to copy to clipboard';
        pill.onclick = () => copyText(t.body);

        const tag = document.createElement('span');
        const fromPhone = t.source === 'phone';
        tag.className = `text-origin-tag ${fromPhone ? 'phone' : 'pc'}`;
        tag.textContent = fromPhone ? 'Phone' : 'PC';

        const bodySpan = document.createElement('span');
        bodySpan.className = `text-pill-body${isUrlText(t.body) ? ' is-url' : ''}`;
        bodySpan.textContent = t.body;

        pill.append(tag, bodySpan);
        wrap.appendChild(pill);

        if (isUrlText(t.body)) {
          const openLink = document.createElement('a');
          openLink.className = 'text-open-link';
          openLink.href = t.body.trim();
          openLink.target = '_blank';
          openLink.rel = 'noopener noreferrer';
          openLink.title = 'Open URL in new tab';
          openLink.textContent = 'Open ↗';
          wrap.appendChild(openLink);
        }

        recentRows.appendChild(wrap);
      }
    }
  }

  if (dialogList) {
    dialogList.replaceChildren();
    if (!plainTexts.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'No messages in history yet.';
      dialogList.appendChild(empty);
      return;
    }
    for (const t of plainTexts) {
      const row = document.createElement('div');
      row.className = 'text-dialog-row';
      row.onclick = () => copyText(t.body);

      const left = document.createElement('div');
      left.className = 'text-dialog-left';

      const tag = document.createElement('span');
      const fromPhone = t.source === 'phone';
      tag.className = `text-origin-tag ${fromPhone ? 'phone' : 'pc'}`;
      tag.textContent = fromPhone ? 'Phone' : 'PC';

      const body = document.createElement('div');
      body.className = 'text-dialog-body';
      body.textContent = t.body;

      left.append(tag, body);

      const actions = document.createElement('div');
      actions.className = 'text-dialog-actions';

      if (t.created_at) {
        const timeEl = document.createElement('span');
        timeEl.className = 'text-dialog-time';
        timeEl.textContent = fmtTime(t.created_at);
        actions.appendChild(timeEl);
      }

      if (isUrlText(t.body)) {
        const openLink = document.createElement('a');
        openLink.className = 'text-open-link';
        openLink.href = t.body.trim();
        openLink.target = '_blank';
        openLink.rel = 'noopener noreferrer';
        openLink.textContent = 'Open ↗';
        openLink.onclick = e => e.stopPropagation();
        actions.appendChild(openLink);
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'toolbtn icon-btn';
      del.title = 'Delete message';
      del.setAttribute('aria-label', 'Delete message');
      del.innerHTML = '<i class="ic ic-trash"></i>';
      del.onclick = e => {
        e.stopPropagation();
        const idx = texts.findIndex(x => x.id === t.id);
        if (idx === -1) return;
        const removed = texts[idx];
        texts.splice(idx, 1);
        renderTexts();

        startPcUndo({
          msg: 'Deleted message',
          restore: () => {
            if (!texts.some(x => x.id === removed.id)) {
              texts.splice(Math.min(idx, texts.length), 0, removed);
              renderTexts();
            }
          },
          perform: async () => {
            await fetch(`/api/text/${t.id}`, { method: 'DELETE' });
            await loadTexts();
          },
        });
      };

      actions.appendChild(del);
      row.append(left, actions);
      dialogList.appendChild(row);
    }
  }
}

function setConnBanner(state, text) {
  const banner = $('#conn-banner');
  const textEl = $('#conn-banner-text');
  const retryBtn = $('#conn-retry');
  if (!banner) return;
  if (connRestoreTimer) { clearTimeout(connRestoreTimer); connRestoreTimer = null; }
  if (state === 'hidden') {
    banner.classList.add('hidden');
    banner.classList.remove('restored');
    return;
  }
  if (textEl && text) textEl.textContent = text;
  banner.classList.toggle('restored', state === 'restored');
  if (retryBtn) retryBtn.classList.toggle('hidden', state === 'restored');
  banner.classList.remove('hidden');
  if (state === 'restored') {
    connRestoreTimer = setTimeout(() => setConnBanner('hidden'), 2200);
  }
}

async function loadCaptures() {
  try {
    const r = await fetch('/api/captures?limit=100');
    if (!r.ok) {
      capturesLoaded = true;
      renderCaptures();
      return false;
    }
    captures = await r.json();
    capturesLoaded = true;
    renderCaptures();
    return true;
  } catch {
    capturesLoaded = true;
    renderCaptures();
    setConnBanner('lost', 'Unable to reach ProofPipe server — trying to reconnect…');
    return false;
  }
}

async function loadOlderCaptures() {
  if (!captures.length) return;
  const oldestId = Math.min(...captures.map(c => c.id));
  try {
    const r = await fetch(`/api/captures?limit=100&before=${oldestId}`);
    if (!r.ok) return;
    const older = await r.json();
    if (older.length) {
      const seen = new Set(captures.map(c => c.id));
      for (const c of older) if (!seen.has(c.id)) captures.push(c);
      renderCaptures();
    } else {
      $('#captures-more-wrap')?.classList.add('hidden');
    }
  } catch {}
}

async function loadFiles() {
  try {
    const r = await fetch('/api/files?limit=100');
    if (!r.ok) {
      filesLoaded = true;
      renderFiles();
      return false;
    }
    files = await r.json();
    filesLoaded = true;
    renderFiles();
    return true;
  } catch {
    filesLoaded = true;
    renderFiles();
    return false;
  }
}

async function loadTexts() {
  try {
    const r = await fetch('/api/text?limit=20');
    if (!r.ok) return;
    texts = await r.json();
    renderTexts();
  } catch {}
}

let statsTimer = null;
function scheduleStats(delay = 350) {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => { statsTimer = null; loadStats(); }, delay);
}

async function loadStats() {
  try {
    const r = await fetch('/api/stats');
    if (!r.ok) return;
    const s = await r.json();

    const pageVer = document.querySelector('meta[name="app-version"]')?.getAttribute('content');
    if (pageVer && pageVer !== '__PP_VERSION__' && s.version && pageVer !== s.version) {
      $('#update-banner')?.classList.remove('hidden');
    }
    if (s.version) {
      if ($('#top-ver-chip')) $('#top-ver-chip').textContent = s.version;
      if ($('#wn-modal-ver')) $('#wn-modal-ver').textContent = s.version;
    }

    const statsEl = $('#stats');
    if (statsEl) {
      statsEl.replaceChildren();
      const line1 = document.createElement('div');
      line1.textContent = s.phoneOnline
        ? `Connected (${s.phoneIp || 'Phone'})`
        : (s.phoneLastSeen ? `Standby · seen ${new Date(s.phoneLastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Ready to pair');
      statsEl.appendChild(line1);
      if (s.phoneOutbox > 0) {
        const line2 = document.createElement('div');
        line2.className = 'muted';
        line2.textContent = `${s.phoneOutbox} item${s.phoneOutbox === 1 ? '' : 's'} queued on phone`;
        statsEl.appendChild(line2);
      }
    }

    const pairBody = $('#pair-body');
    const qrToggle = $('#qr-toggle');
    if (pairBody && qrToggle && !qrHiddenByUser) {
      const hideQr = !!s.phoneOnline;
      pairBody.classList.toggle('hidden', hideQr);
      qrToggle.setAttribute('aria-expanded', String(!hideQr));
      qrToggle.textContent = hideQr ? 'Show QR' : 'Hide QR';
    }

    const used = s.bytes || 0;
    const cap = s.cap || (500 * 1024 * 1024);
    const pct = Math.min(100, Math.round((used / cap) * 100));
    const meter = $('#meter');
    const fill = $('#meter-fill');
    const capText = $('#cap-text');
    if (meter) meter.setAttribute('aria-valuenow', String(pct));
    if (fill) fill.style.width = `${pct}%`;
    if (capText) capText.textContent = `${fmtBytes(used)} of ${fmtBytes(cap)} (${pct}%)`;
  } catch {}
}

// Smart, automatic LAN IP selection — filters out non-routable 169.254.x.x
// link-local addresses and picks the highest-priority reachable interface.
async function loadLan() {
  try {
    const r = await fetch('/api/lan');
    if (!r.ok) return;
    const { ips = [], port = 8787, scheme = 'http' } = await r.json();
    const qr = $('#qr');
    const emptyUrl = $('#empty-phone-url');
    const pairUrl = $('#pair-phone-url');

    const routableIps = ips.filter(ip => ip && !ip.startsWith('169.254.') && !ip.startsWith('127.'));
    const bestIp = routableIps[0] || null;
    resolvedPhoneUrl = bestIp ? `${scheme}://${bestIp}:${port}/phone` : `${location.origin}/phone`;

    if (emptyUrl) {
      emptyUrl.textContent = bestIp ? `${scheme}://${bestIp}:${port}/phone` : '/phone';
    }
    if (pairUrl) {
      pairUrl.textContent = bestIp ? `${scheme}://${bestIp}:${port}/phone` : '/phone';
    }
    if (qr) qr.src = bestIp ? `/qr.png?ip=${encodeURIComponent(bestIp)}` : '/qr.png';
  } catch {}
}

function applySettingsBundle(s) {
  if (!s) return;
  if ($('#set-autopaste')) $('#set-autopaste').checked = !!s.autoPaste?.auto;
  if ($('#set-files-inbox')) $('#set-files-inbox').checked = !!s.filesInbox?.on;
  if ($('#set-quality-on')) $('#set-quality-on').checked = !!s.quality?.on;
  if ($('#set-quality-level') && s.quality?.level != null) {
    $('#set-quality-level').value = String(s.quality.level);
    syncRangeFill($('#set-quality-level'));
    if ($('#set-quality-val')) $('#set-quality-val').textContent = String(s.quality.level);
  }
  if ($('#set-autocleanup')) $('#set-autocleanup').checked = !!s.autoCleanup?.on;
  if ($('#set-storage-cap') && s.storageCap?.capMb != null) {
    $('#set-storage-cap').value = String(s.storageCap.capMb);
  }
  if ($('#set-retention') && s.retention?.days != null) {
    $('#set-retention').value = String(s.retention.days);
  }
  if ($('#set-media-dir') && s.mediaDir?.path) {
    $('#set-media-dir').value = s.mediaDir.path;
  }
}

async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    if (r.ok) applySettingsBundle(await r.json());
    const br = await fetch('/api/browsers');
    if (br.ok) {
      const { browsers = [], current = 'default' } = await br.json();
      const sel = $('#set-browser');
      if (sel) {
        const items = [
          { value: 'default', label: 'Default (Any Active Browser)' },
          ...browsers.map(b => ({ value: b.id, label: b.name })),
        ];
        setGlassSelectOptions(sel, items, current);
      }
    }
  } catch {}
}

async function uploadPhotoBlob(blob, filename = 'capture.png') {
  const fd = new FormData();
  fd.append('source', 'pc');
  fd.append('photo', blob, filename);
  try {
    const r = await uploadWithProgress('/upload', fd, filename);
    if (r.ok) {
      showToast('Imported photo to library');
      await loadCaptures();
      await loadStats();
    } else {
      const err = await r.json().catch(() => ({}));
      showToast(err.error || 'Photo upload failed');
    }
  } catch {
    showToast('Photo upload failed');
  }
}

async function uploadPcFile(file) {
  const fd = new FormData();
  fd.append('dir', 'pc');
  fd.append('file', file, file.name);
  try {
    const r = await uploadWithProgress('/api/files', fd, file.name);
    if (r.ok) {
      showToast(`Sent ${file.name} to phone`);
      await loadFiles();
      await loadStats();
    } else {
      const err = await r.json().catch(() => ({}));
      showToast(err.error || 'File transfer failed');
    }
  } catch {
    showToast('File transfer failed');
  }
}

async function sendTextFromBar() {
  const input = $('#text-input');
  if (!input) return;
  const body = input.value.trim();
  if (!body) return;
  input.value = '';
  try {
    const r = await fetch('/api/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, source: 'pc', kind: 'text' }),
    });
    if (r.ok) {
      showToast('Sent message to phone');
      await loadTexts();
    }
  } catch {
    showToast('Could not send message');
  }
}

function connectSse(forceReset = false) {
  if (forceReset && activeSse) {
    try { activeSse.close(); } catch {}
    activeSse = null;
  }
  const dot = $('#conn-dot');
  const txt = $('#conn-text');
  const es = new EventSource('/events');
  activeSse = es;

  es.onopen = () => {
    if (dot) dot.className = 'dot ok';
    if (txt) txt.textContent = 'Live';
    if (sseHadError) {
      sseHadError = false;
      setConnBanner('restored', 'Connection restored ✓');
      loadCaptures();
      loadFiles();
      loadTexts();
      loadStats();
    } else {
      setConnBanner('hidden');
    }
  };

  es.onerror = () => {
    sseHadError = true;
    if (dot) dot.className = 'dot warn';
    if (txt) txt.textContent = 'Reconnecting…';
    setConnBanner('lost', 'Connection lost — trying to reconnect…');
  };

  es.onmessage = e => {
    let msg = null;
    try { msg = JSON.parse(e.data); } catch { msg = { type: e.data }; }
    const type = msg?.type || e.data;
    if (type === 'capture') {
      if (msg?.capture && msg.capture.id != null) {
        if (!captures.some(c => c.id === msg.capture.id)) {
          captures.unshift(msg.capture);
        }
        renderCaptures();
      } else {
        loadCaptures();
      }
      scheduleStats();
    } else if (type === 'capture-updated') {
      if (msg?.capture && msg.capture.id != null) {
        const idx = captures.findIndex(c => c.id === msg.capture.id);
        if (idx !== -1) captures[idx] = msg.capture;
        else captures.unshift(msg.capture);
        renderCaptures();
        if (lightboxIdx !== -1) {
          const cur = filteredSortedCaptures()[lightboxIdx];
          if (cur && cur.id === msg.capture.id) openLightbox(lightboxIdx);
        }
      } else {
        loadCaptures();
      }
      scheduleStats();
    } else if (type === 'deleted') {
      if (msg?.id === 'all') {
        captures = [];
        selectedCaptures.clear();
        captureSelectMode = false;
        closeLightbox();
        renderCaptures();
      } else if (Array.isArray(msg?.ids)) {
        const drop = new Set(msg.ids);
        const curCap = lightboxIdx !== -1 ? filteredSortedCaptures()[lightboxIdx] : null;
        captures = captures.filter(c => !drop.has(c.id));
        for (const id of drop) selectedCaptures.delete(id);
        if (curCap && drop.has(curCap.id)) closeLightbox();
        renderCaptures();
      } else if (typeof msg?.id === 'number') {
        const curCap = lightboxIdx !== -1 ? filteredSortedCaptures()[lightboxIdx] : null;
        captures = captures.filter(c => c.id !== msg.id);
        selectedCaptures.delete(msg.id);
        if (curCap && curCap.id === msg.id) closeLightbox();
        renderCaptures();
      } else {
        loadCaptures();
      }
      scheduleStats();
    } else if (type === 'file') {
      if (msg?.row && msg.row.id != null) {
        if (!files.some(f => f.id === msg.row.id)) {
          files.unshift(msg.row);
        }
        renderFiles();
      } else {
        loadFiles();
      }
      scheduleStats();
    } else if (type === 'file-deleted') {
      if (msg?.id === 'all') {
        files = [];
        selectedFiles.clear();
        renderFiles();
      } else if (Array.isArray(msg?.ids)) {
        const drop = new Set(msg.ids);
        files = files.filter(f => !drop.has(f.id));
        renderFiles();
      } else if (typeof msg?.id === 'number') {
        files = files.filter(f => f.id !== msg.id);
        renderFiles();
      } else {
        loadFiles();
      }
      scheduleStats();
    } else if (type === 'text' || type === 'text-deleted') {
      loadTexts();
    } else if (type === 'settings') {
      applySettingsBundle(msg);
      scheduleStats();
    } else if (type === 'phone') {
      scheduleStats();
    } else if (type === 'open-latest') {
      if (captures.length) openLightbox(0);
    }
  };
}

function wireEvents() {
  // Close custom glass popover dropdowns when clicking anywhere outside
  document.addEventListener('click', () => closeAllGlassSelects());

  // Confirmation modal buttons
  $('#pc-confirm-cancel')?.addEventListener('click', () => closePcConfirm(false));
  $('#pc-confirm-ok')?.addEventListener('click', () => closePcConfirm(true));

  // Undo snackbar button
  $('#pc-undo-btn')?.addEventListener('click', () => {
    if (!pcUndoState) return;
    const { timer, restore } = pcUndoState;
    clearTimeout(timer);
    pcUndoState = null;
    $('#pc-undo-toast')?.classList.add('hidden');
    if (typeof restore === 'function') restore();
    showToast('Restored ✓');
  });

  // Wire custom Liquid Glass Popover Menus
  wireGlassSelect($('#capture-sort'), val => {
    captureSort = val || 'new';
    renderCaptures();
  });

  wireGlassSelect($('#set-browser'), val => {
    fetch('/api/browsers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: val }),
    }).then(r => { if (r.ok) showSettingsSaved(); }).catch(() => {});
  });

  syncRangeFill($('#set-quality-level'));

  $('#copy-phone-url')?.addEventListener('click', () => {
    copyText(resolvedPhoneUrl);
  });

  $('#text-send')?.addEventListener('click', sendTextFromBar);
  $('#text-input')?.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendTextFromBar();
    }
  });

  const closeWhatsNewModal = () => {
    const bd = $('#whats-new-backdrop');
    if (bd && !bd.classList.contains('hidden')) {
      bd.classList.add('hidden');
      deactivateModalFocus(bd);
    }
  };
  const closeTextsModal = () => {
    const bd = $('#texts-backdrop');
    if (bd && !bd.classList.contains('hidden')) {
      bd.classList.add('hidden');
      deactivateModalFocus(bd);
    }
  };
  const closeSettingsModal = () => {
    closeAllGlassSelects();
    const bd = $('#settings-backdrop');
    if (bd && !bd.classList.contains('hidden')) {
      bd.classList.add('hidden');
      deactivateModalFocus(bd);
    }
  };

  // What's New sheet modal (opens in-app like Settings)
  $('#whats-new-btn')?.addEventListener('click', () => {
    renderReleases();
    const bd = $('#whats-new-backdrop');
    if (bd) {
      bd.classList.remove('hidden');
      activateModalFocus(bd, $('#whats-new-close'));
    }
  });
  $('#whats-new-close')?.addEventListener('click', closeWhatsNewModal);

  $('#category-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    activeReleaseCategory = btn.dataset.category || 'all';
    for (const b of $('#category-tabs').querySelectorAll('.filter-btn')) {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    renderReleases();
  });

  $('#release-search')?.addEventListener('input', e => {
    releaseSearchQuery = e.target.value || '';
    renderReleases();
  });

  $('#reset-filters')?.addEventListener('click', () => {
    activeReleaseCategory = 'all';
    releaseSearchQuery = '';
    if ($('#release-search')) $('#release-search').value = '';
    if ($('#category-tabs')) {
      for (const b of $('#category-tabs').querySelectorAll('.filter-btn')) {
        const on = b.dataset.category === 'all';
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      }
    }
    renderReleases();
  });

  $('#texts-btn')?.addEventListener('click', () => {
    loadTexts();
    const bd = $('#texts-backdrop');
    if (bd) {
      bd.classList.remove('hidden');
      activateModalFocus(bd, $('#texts-close'));
    }
  });
  $('#texts-close')?.addEventListener('click', closeTextsModal);
  $('#clear-texts-btn')?.addEventListener('click', async () => {
    const plainCount = texts.filter(t => t.kind !== 'media').length;
    if (!plainCount) return;
    if (!await pcConfirm({
      title: `Clear all ${plainCount} message${plainCount === 1 ? '' : 's'}?`,
      body: 'This permanently removes message history from both PC and phone.',
      ok: 'Clear History',
    })) return;
    await fetch('/api/text', { method: 'DELETE' });
    await loadTexts();
    showToast('Cleared message history');
  });

  const openSettingsModal = () => {
    loadSettings();
    const bd = $('#settings-backdrop');
    if (bd) {
      bd.classList.remove('hidden');
      activateModalFocus(bd, $('#settings-close'));
    }
  };
  $('#top-settings-btn')?.addEventListener('click', openSettingsModal);
  $('#settings-close')?.addEventListener('click', closeSettingsModal);

  $('#conn-retry')?.addEventListener('click', () => {
    if ($('#conn-banner-text')) $('#conn-banner-text').textContent = 'Retrying connection…';
    connectSse(true);
    loadCaptures();
    loadFiles();
    loadTexts();
    loadStats();
  });

  // Close modals when clicking the backdrop itself
  for (const id of ['#whats-new-backdrop', '#texts-backdrop', '#settings-backdrop', '#lightbox', '#pc-confirm-backdrop']) {
    $(id)?.addEventListener('click', e => {
      if (e.target === $(id)) {
        closeAllGlassSelects();
        if (id === '#lightbox') closeLightbox();
        else if (id === '#pc-confirm-backdrop') closePcConfirm(false);
        else if (id === '#whats-new-backdrop') closeWhatsNewModal();
        else if (id === '#texts-backdrop') closeTextsModal();
        else if (id === '#settings-backdrop') closeSettingsModal();
      }
    });
  }

  $('#rail-toggle')?.addEventListener('click', () => {
    const rail = $('#rail');
    const open = rail?.classList.toggle('open');
    $('#rail-toggle')?.setAttribute('aria-expanded', String(!!open));
  });

  $('#qr-toggle')?.addEventListener('click', () => {
    const body = $('#pair-body');
    if (!body) return;
    const hidden = body.classList.toggle('hidden');
    qrHiddenByUser = true;
    $('#qr-toggle').setAttribute('aria-expanded', String(!hidden));
    $('#qr-toggle').textContent = hidden ? 'Show QR' : 'Hide QR';
  });

  $('#update-refresh')?.addEventListener('click', () => location.reload());

  $('#capture-origin-tabs')?.addEventListener('click', e => {
    const btn = e.target.closest('.origin-btn');
    if (!btn) return;
    captureOriginFilter = btn.dataset.origin || 'all';
    for (const b of $('#capture-origin-tabs').querySelectorAll('.origin-btn')) {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    renderCaptures();
  });

  $('#density-toggle')?.addEventListener('click', () => {
    compactGrid = !compactGrid;
    renderCaptures();
  });

  $('#captures-select-btn')?.addEventListener('click', () => {
    captureSelectMode = !captureSelectMode;
    if (!captureSelectMode) selectedCaptures.clear();
    syncSelectionOnTiles();
  });

  $('#captures-select-all')?.addEventListener('click', () => {
    const visible = filteredSortedCaptures();
    const allSelected = visible.length > 0 && visible.every(c => selectedCaptures.has(c.id));
    if (allSelected) {
      for (const c of visible) selectedCaptures.delete(c.id);
    } else {
      captureSelectMode = true;
      for (const c of visible) selectedCaptures.add(c.id);
    }
    syncSelectionOnTiles();
  });

  $('#captures-delete-selected')?.addEventListener('click', async () => {
    const ids = [...selectedCaptures];
    if (!ids.length) return;
    if (!await pcConfirm({
      title: `Delete ${ids.length} selected capture${ids.length === 1 ? '' : 's'}?`,
      body: 'Selected photos will be permanently deleted from this PC.',
      ok: 'Delete Selected',
    })) return;
    flushPcUndo();
    try {
      const r = await fetch('/api/captures', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (r.ok) {
        const drop = new Set(ids);
        captures = captures.filter(c => !drop.has(c.id));
        selectedCaptures.clear();
        captureSelectMode = false;
        renderCaptures();
        loadStats();
        showToast(`Deleted ${ids.length} capture${ids.length === 1 ? '' : 's'}`);
      } else {
        showToast('Could not delete selected captures');
      }
    } catch {
      showToast('Could not delete selected captures');
    }
  });

  const runUploadWorkers = async (list, workerFn, concurrency = 2) => {
    let idx = 0;
    const worker = async () => {
      while (idx < list.length) {
        const f = list[idx++];
        await workerFn(f);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  };

  $('#pc-upload-input')?.addEventListener('change', async e => {
    const list = [...(e.target.files || [])];
    e.target.value = '';
    if (!list.length) return;
    pcTransferTotal = list.length;
    pcTransferDone = 0;
    await runUploadWorkers(list, f => uploadPhotoBlob(f, f.name));
  });

  $('#pc-file-input')?.addEventListener('change', async e => {
    const list = [...(e.target.files || [])];
    e.target.value = '';
    if (!list.length) return;
    pcTransferTotal = list.length;
    pcTransferDone = 0;
    await runUploadWorkers(list, f => uploadPcFile(f));
  });

  $('#clear-captures')?.addEventListener('click', async () => {
    if (!captures.length) return;
    if (!await pcConfirm({
      title: `Delete all ${captures.length} capture${captures.length === 1 ? '' : 's'}?`,
      body: 'All stored photos will be permanently deleted from this PC.',
      ok: 'Delete All Photos',
    })) return;
    flushPcUndo();
    const r = await fetch('/api/captures', { method: 'DELETE' });
    if (r.ok) {
      captures = [];
      selectedCaptures.clear();
      captureSelectMode = false;
      renderCaptures();
      loadStats();
      showToast('Cleared photo library');
    }
  });

  $('#captures-load-more')?.addEventListener('click', loadOlderCaptures);

  $('#files-delete-selected')?.addEventListener('click', async () => {
    const ids = [...selectedFiles];
    if (!ids.length) return;
    if (!await pcConfirm({
      title: `Remove ${ids.length} selected file${ids.length === 1 ? '' : 's'}?`,
      body: 'Selected files will be removed from Shared Files.',
      ok: 'Remove Selected',
    })) return;
    flushPcUndo();
    const r = await fetch('/api/files', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (r.ok) {
      selectedFiles.clear();
      await loadFiles();
      await loadStats();
      showToast(`Removed ${ids.length} file${ids.length === 1 ? '' : 's'}`);
    }
  });

  $('#clear-files')?.addEventListener('click', async () => {
    if (!files.length) return;
    if (!await pcConfirm({
      title: `Delete all ${files.length} shared file${files.length === 1 ? '' : 's'}?`,
      body: 'All files in Shared Files will be permanently deleted.',
      ok: 'Clear Files',
    })) return;
    flushPcUndo();
    const r = await fetch('/api/files', { method: 'DELETE' });
    if (r.ok) {
      selectedFiles.clear();
      files = [];
      renderFiles();
      loadStats();
      showToast('Cleared shared files');
    }
  });

  // Settings controls (unified auto-save with visual confirmation)
  $('#set-autopaste')?.addEventListener('change', e => {
    fetch('/api/autopaste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto: e.target.checked }),
    }).then(r => { if (r.ok) showSettingsSaved(); }).catch(() => {});
  });

  $('#set-files-inbox')?.addEventListener('change', e => {
    fetch('/api/files-inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: e.target.checked }),
    }).then(r => { if (r.ok) showSettingsSaved(); }).catch(() => {});
  });

  let qualitySaveTimer = null;
  const saveQuality = (immediate = false) => {
    const on = !!$('#set-quality-on')?.checked;
    const rangeEl = $('#set-quality-level');
    const level = Number(rangeEl?.value || 80);
    syncRangeFill(rangeEl);
    if ($('#set-quality-val')) $('#set-quality-val').textContent = String(level);
    clearTimeout(qualitySaveTimer);
    const send = () => {
      fetch('/api/quality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on, level }),
      }).then(r => { if (r.ok) showSettingsSaved(); }).catch(() => {});
    };
    if (immediate) send();
    else qualitySaveTimer = setTimeout(send, 250);
  };
  $('#set-quality-on')?.addEventListener('change', () => saveQuality(true));
  $('#set-quality-level')?.addEventListener('input', () => saveQuality(false));

  $('#set-autocleanup')?.addEventListener('change', e => {
    fetch('/api/autocleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: e.target.checked }),
    }).then(r => { if (r.ok) showSettingsSaved(); }).catch(() => {});
  });

  let storageCapTimer = null;
  const saveStorageCap = async () => {
    const capMb = Number($('#set-storage-cap')?.value || 500);
    if (!Number.isFinite(capMb) || capMb < 50) return;
    const r = await fetch('/api/storage-cap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capMb }),
    });
    if (r.ok) {
      showSettingsSaved();
      loadStats();
    }
  };
  $('#save-storage-cap')?.addEventListener('click', saveStorageCap);
  $('#set-storage-cap')?.addEventListener('change', saveStorageCap);
  $('#set-storage-cap')?.addEventListener('input', () => {
    clearTimeout(storageCapTimer);
    storageCapTimer = setTimeout(saveStorageCap, 450);
  });

  let retentionTimer = null;
  const saveRetention = async () => {
    const days = Number($('#set-retention')?.value || 0);
    if (!Number.isFinite(days) || days < 0) return;
    const r = await fetch('/api/retention', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });
    if (r.ok) showSettingsSaved();
  };
  $('#save-retention')?.addEventListener('click', saveRetention);
  $('#set-retention')?.addEventListener('change', saveRetention);
  $('#set-retention')?.addEventListener('input', () => {
    clearTimeout(retentionTimer);
    retentionTimer = setTimeout(saveRetention, 450);
  });

  $('#save-media-dir')?.addEventListener('click', async () => {
    const pathVal = $('#set-media-dir')?.value?.trim();
    if (!pathVal) return;
    const r = await fetch('/api/media-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: pathVal }),
    });
    if (r.ok) {
      showSettingsSaved('Relocated ✓');
      showToast('Relocated media directory');
    } else {
      const err = await r.json().catch(() => ({}));
      showToast(err.error || 'Could not relocate media directory');
    }
  });

  // Lightbox controls
  $('#lb-close')?.addEventListener('click', closeLightbox);
  $('#lb-prev')?.addEventListener('click', () => {
    if (lightboxIdx > 0) openLightbox(lightboxIdx - 1);
  });
  $('#lb-next')?.addEventListener('click', () => {
    const list = filteredSortedCaptures();
    if (lightboxIdx < list.length - 1) openLightbox(lightboxIdx + 1);
  });
  $('#lb-zoom')?.addEventListener('click', cycleLightboxZoom);
  $('#lb-rotate')?.addEventListener('click', rotateLightboxCapture);
  $('#lightbox-img')?.addEventListener('dblclick', () => {
    if (lbZoomMode === 'fit') setLightboxZoomMode('100');
    else setLightboxZoomMode('fit');
  });

  const lbStage = $('#lightbox-stage');
  if (lbStage) {
    let panDrag = null;
    lbStage.addEventListener('pointerdown', e => {
      if (lbScale <= 1.01) return;
      e.preventDefault();
      lbStage.classList.add('panning');
      lbStage.setPointerCapture?.(e.pointerId);
      panDrag = { x: e.clientX, y: e.clientY, sx: lbPanX, sy: lbPanY, id: e.pointerId };
    });
    lbStage.addEventListener('pointermove', e => {
      if (!panDrag || e.pointerId !== panDrag.id) return;
      lbPanX = panDrag.sx + (e.clientX - panDrag.x);
      lbPanY = panDrag.sy + (e.clientY - panDrag.y);
      applyLightboxTransform();
    });
    const endPan = e => {
      if (!panDrag || (e && e.pointerId !== panDrag.id)) return;
      panDrag = null;
      lbStage.classList.remove('panning');
    };
    lbStage.addEventListener('pointerup', endPan);
    lbStage.addEventListener('pointercancel', endPan);
    lbStage.addEventListener('wheel', e => {
      if (lightboxIdx === -1) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.25 : -0.25;
      const next = Math.max(1, Math.min(4, lbScale + delta));
      if (next <= 1.02) {
        resetLightboxView();
      } else {
        lbScale = next;
        lbZoomMode = next >= 2.2 ? '200' : '100';
        applyLightboxTransform();
      }
    }, { passive: false });
  }

  $('#lb-copy')?.addEventListener('click', () => {
    const cap = filteredSortedCaptures()[lightboxIdx];
    if (cap) copyCapturePng(cap.file);
  });
  $('#lb-send-phone')?.addEventListener('click', () => {
    const cap = filteredSortedCaptures()[lightboxIdx];
    if (cap) sendCaptureToPhone(cap.file);
  });
  $('#lb-delete')?.addEventListener('click', () => {
    const cap = filteredSortedCaptures()[lightboxIdx];
    if (cap) deleteCapture(cap.id);
  });

  // Global keyboard & paste handlers
  document.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      const top = activeFocusModal();
      if (top) {
        const list = getModalFocusables(top.modal);
        if (!list.length) {
          e.preventDefault();
          return;
        }
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || !top.modal.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last || !top.modal.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
    }

    if (e.key === 'Escape') {
      if (confirmResolver) {
        closePcConfirm(false);
        return;
      }
      if (document.querySelector('.glass-select.open')) {
        closeAllGlassSelects();
        return;
      }
      const top = activeFocusModal();
      if (top) {
        if (top.modal.id === 'lightbox') closeLightbox();
        else if (top.modal.id === 'whats-new-backdrop') closeWhatsNewModal();
        else if (top.modal.id === 'texts-backdrop') closeTextsModal();
        else if (top.modal.id === 'settings-backdrop') closeSettingsModal();
        return;
      }
      closeLightbox();
      closeWhatsNewModal();
      closeTextsModal();
      closeSettingsModal();
    } else if (lightboxIdx !== -1) {
      if (e.key === 'ArrowLeft' && lightboxIdx > 0) openLightbox(lightboxIdx - 1);
      else if (e.key === 'ArrowRight' && lightboxIdx < filteredSortedCaptures().length - 1) openLightbox(lightboxIdx + 1);
      else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) rotateLightboxCapture();
      else if (e.key === '0') resetLightboxView();
    }
  });

  document.addEventListener('paste', async e => {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return;
    const items = [...(e.clipboardData?.items || [])];
    const imgItem = items.find(i => i.type.startsWith('image/'));
    if (imgItem) {
      const blob = imgItem.getAsFile();
      if (blob) await uploadPhotoBlob(blob, 'pasted.png');
    }
  });

  // Full-window drag-and-drop overlay with depth counter (never flickers on child nodes)
  let dragDepth = 0;
  window.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    $('#drop-hint')?.classList.remove('hidden');
  });
  window.addEventListener('dragover', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', e => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 || e.relatedTarget === null) {
      dragDepth = 0;
      $('#drop-hint')?.classList.add('hidden');
    }
  });
  window.addEventListener('drop', async e => {
    e.preventDefault();
    dragDepth = 0;
    $('#drop-hint')?.classList.add('hidden');
    const dropped = [...(e.dataTransfer?.files || [])];
    if (!dropped.length) return;
    pcTransferTotal = dropped.length;
    pcTransferDone = 0;
    await runUploadWorkers(dropped, f => (f.type.startsWith('image/') ? uploadPhotoBlob(f, f.name) : uploadPcFile(f)));
  });
}

wireEvents();
renderReleases();
renderCaptures();
renderFiles();
loadCaptures();
loadFiles();
loadTexts();
loadStats();
loadLan();
loadSettings();
connectSse();
