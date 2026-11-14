const $ = s => document.querySelector(s);

const RELEASES = [
  {
    version: 'v1.24.0',
    date: '2026-11',
    headline: 'Live Phone XHR Progress, Two-Way Extension Quick Send & Background Daemon',
    changes: [
      {
        scope: 'phone',
        title: 'Real byte-level upload progress for photos',
        detail: 'Upgraded photo uploads to XMLHttpRequest with xhr.upload.onprogress tracking so single and concurrent bursts stream real-time percentages into the Liquid Glass status wave.',
      },
      {
        scope: 'extension',
        title: 'Two-way Quick Send, tab screenshot & Liquid Glass UI',
        detail: 'Added an inline note/URL composer, one-click Tab Link sender, and visible-tab Screenshot capture to the extension popup, alongside dark Liquid Glass styling for the popup, in-page tray, and page toasts.',
      },
      {
        scope: 'server',
        title: 'Cross-platform background daemon CLI & Windows tray launcher',
        detail: 'Added scripts/daemon.js (start, stop, restart, status, logs, autostart) and a zero-dependency Windows system tray monitor (scripts/tray.ps1) wired into ProofPipe.bat.',
      },
    ],
  },
  {
    version: 'v1.23.0',
    date: '2026-11',
    headline: 'Liquid Glass UX Overhaul, Safe Deletions, Two-Way Sync & Pre-Compiled SQL',
    changes: [
      {
        scope: 'server',
        title: 'Safe destructive actions, Undo snackbar & live XHR upload progress',
        detail: 'Added a confirmation modal for bulk wipes, a 5-second Undo snackbar for single deletions, full-window drag-and-drop overlay, hover photo actions, and live byte-level upload progress on the PC workbench.',
      },
      {
        scope: 'phone',
        title: 'Two-way capture gallery sync & full-screen text composer',
        detail: 'PC-origin captures now appear automatically in the phone gallery with a PC badge, accompanied by a labeled From your PC inbox strip and a minimal full-screen text editor.',
      },
      {
        scope: 'extension',
        title: 'Liquid Glass extension popup & collapsible advanced drawer',
        detail: 'Redesigned the Chrome extension popup with translucent glass cards, segmented pill tabs, and a collapsible drawer for port override and site button controls.',
      },
    ],
  },
  {
    version: 'v1.22.0',
    date: '2026-10',
    headline: '64 MP Full-Resolution Pipeline & Lossless Clipboard Encoding',
    changes: [
      {
        scope: 'server',
        title: '64 MP capture ceiling',
        detail: 'Raised the image probe limit to 64 MP (MAX_PIXELS) so 48 MP and 50 MP phone photos upload byte-for-byte without downscaling.',
      },
      {
        scope: 'phone',
        title: 'Resolution-preserving HEIC conversion',
        detail: 'Decoupled HEIC-to-JPEG format conversion from the optional 4096 px quality-reduction clamp so full-sensor photos keep every pixel when quality reduction is off.',
      },
      {
        scope: 'extension',
        title: 'Full-resolution PNG Worker encoding',
        detail: 'Removed the 8192 px clipboard clamp in toPng.js so tall scrolling screenshots copy 1:1 up to physical browser canvas limits.',
      },
    ],
  },
  {
    version: 'v1.21.0',
    date: '2026-09',
    headline: 'Bulk File Operations, Phone Sorting & In-Flight Decode Guards',
    changes: [
      {
        scope: 'server',
        title: 'In-flight sharp decode coordination',
        detail: 'Added beginFileRead and awaitFileIdle synchronization so deleting a capture immediately after upload waits for background thumbnail generation before unlinking.',
      },
      {
        scope: 'server',
        title: 'Batch file deletion',
        detail: 'Extended DELETE /api/files to accept an { ids } array and broadcast a single coalesced file-deleted SSE event.',
      },
      {
        scope: 'phone',
        title: 'Unified sort order & viewer rotation',
        detail: 'Added Newest, Oldest, and Name sorting across phone lanes plus 90-degree rotation inside the mobile pinch-zoom viewer.',
      },
    ],
  },
  {
    version: 'v1.20.0',
    date: '2026-08',
    headline: 'Full-Resolution Tray Dragging & Keyboard Direct Paste',
    changes: [
      {
        scope: 'extension',
        title: 'Byte-identical drag payloads from the p tray',
        detail: 'Upgraded hovered tray tiles to their stored original blob before dragstart and attached real MIME types so dragging into AI chats transfers untouched originals.',
      },
      {
        scope: 'extension',
        title: 'Ctrl/Cmd+Enter direct chat injection',
        detail: 'Added keyboard shortcut support in the in-page tray to run the staged synthetic paste pipeline directly into the page editor.',
      },
      {
        scope: 'extension',
        title: 'Largest-visible composer targeting',
        detail: 'Improved editor discovery to prefer the focused element or the largest visible contenteditable/textarea composer rather than the last DOM node.',
      },
    ],
  },
  {
    version: 'v1.18.0',
    date: '2026-07',
    headline: 'Browser-Targeted Auto-Paste & Pinned Extension Origin',
    changes: [
      {
        scope: 'server',
        title: 'Pinned chrome-extension CSRF origin',
        detail: 'Derived the exact 32-character extension ID from extension/manifest.json key so only the official ProofPipe extension passes mutation checks.',
      },
      {
        scope: 'extension',
        title: 'Multi-browser autoTarget routing',
        detail: 'Added browser-target matching so Chrome and Edge extensions only auto-paste when selected, with automatic fallback when the target browser has no active SSE client.',
      },
      {
        scope: 'server',
        title: 'Aggregated /api/settings bundle',
        detail: 'Combined all server settings into a single GET /api/settings payload and SSE broadcast frame.',
      },
    ],
  },
  {
    version: 'v1.15.0',
    date: '2026-05',
    headline: 'Bidirectional File Transfers, Auto-Inbox & ZIP Backups',
    changes: [
      {
        scope: 'server',
        title: '1 GB file transfer store & HTTP Range streaming',
        detail: 'Added /api/files and /file/:id with RFC 7233 byte-range support, dedicated token-bucket rate limiting, and automatic saving of phone files into data/inbox/.',
      },
      {
        scope: 'server',
        title: 'Live media directory relocation & transactional backups',
        detail: 'Added /api/media-dir for moving captures/files across drives with rollback on failure, and /api/backup for WAL-checkpointed archive exports.',
      },
      {
        scope: 'phone',
        title: 'Swipe-to-delete with deferred Undo snackbar',
        detail: 'Added downward swipe gestures on phone text and file chips with a 6-second undo window before committing server deletion.',
      },
    ],
  },
  {
    version: 'v1.10.0',
    date: '2026-03',
    headline: 'Idempotent Offline Queues & Automatic Port Discovery',
    changes: [
      {
        scope: 'phone',
        title: 'IndexedDB offline queues with deduplication keys',
        detail: 'Queued photos, files, and texts in IndexedDB when offline and attached client-generated dedupe_key tokens so retried uploads never create duplicates.',
      },
      {
        scope: 'extension',
        title: 'Two-stage loopback port discovery',
        detail: 'Added PPDiscovery.probeHosts to scan candidate ports in parallel and verify /api/version so custom PORT setups work without manual configuration.',
      },
      {
        scope: 'server',
        title: 'Age-based retention & 80% storage cap sweeps',
        detail: 'Added configurable retention days and storage cap thresholds that trim the oldest captures automatically on schedule and on upload.',
      },
    ],
  },
  {
    version: 'v1.0.0',
    date: '2026-01',
    headline: 'Initial Release: One-Tap Phone Capture to AI Chat Paste',
    changes: [
      {
        scope: 'server',
        title: 'Fastify + SQLite + sharp capture server',
        detail: 'Built the local LAN capture server storing untouched originals in data/captures/ with background 400 px thumbnail generation and instant SSE push.',
      },
      {
        scope: 'phone',
        title: 'Installable Mobile PWA & Web Share Target',
        detail: 'Created the /phone web app with one-tap camera shutter, two-way text chips, pinch-to-zoom gallery viewer, and Share-to-ProofPipe support.',
      },
      {
        scope: 'extension',
        title: 'MV3 offscreen SSE relay & staged synthetic paste',
        detail: 'Built the Chromium extension with an offscreen EventSource relay and non-bubbling-first synthetic ClipboardEvent dispatch into AI chat editors.',
      },
    ],
  },
];

const SCOPE_LABELS = {
  server: 'Server',
  phone: 'Phone PWA',
  extension: 'Extension',
};

let captures = [];
let files = [];
let texts = [];
let selectedFiles = new Set();
let captureSort = 'new';
let captureOriginFilter = 'all';
let compactGrid = false;
let lightboxIdx = -1;
let qrHiddenByUser = false;
let toastTimer = null;
let settingsSaveBadgeTimer = null;
let activeReleaseCategory = 'all';
let releaseSearchQuery = '';
let resolvedPhoneUrl = `${location.origin}/phone`;

function fmtBytes(n) {
  const b = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = b;
  let u = 0;
  while (val >= 1024 && u < units.length - 1) {
    val /= 1024;
    u++;
  }
  return `${u === 0 ? val : val.toFixed(1)} ${units[u]}`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function showToast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
}

function showSettingsSaved(label = 'Saved ✓') {
  const pill = $('#settings-save-state');
  if (!pill) return;
  pill.textContent = label;
  pill.classList.remove('hidden');
  if (settingsSaveBadgeTimer) clearTimeout(settingsSaveBadgeTimer);
  settingsSaveBadgeTimer = setTimeout(() => pill.classList.add('hidden'), 2000);
}

// ---------- PC Confirmation Modal (prevents accidental nuclear wipes) ----------
let confirmResolver = null;
function closePcConfirm(answer = false) {
  const bd = $('#pc-confirm-backdrop');
  if (bd) bd.classList.add('hidden');
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
  cancelBtn.focus();
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
  $('#pc-undo-toast')?.classList.add('hidden');
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
  msgEl.textContent = msg;
  bar.classList.remove('hidden');
  const timer = setTimeout(() => {
    pcUndoState = null;
    bar.classList.add('hidden');
    Promise.resolve().then(perform).catch(() => {});
  }, 5000);
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

function uploadWithProgress(url, fd, name) {
  if (!pcTransferTotal) {
    pcTransferTotal = 1;
    pcTransferDone = 0;
  }
  updatePcTransferUI(name, 0);

  if (typeof XMLHttpRequest !== 'function') {
    return fetch(url, { method: 'POST', body: fd }).finally(endPcTransferItem);
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    if (xhr.upload) {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable && e.total > 0) {
          const pct = Math.min(100, Math.round((e.loaded / e.total) * 100));
          updatePcTransferUI(name, pct);
        } else {
          updatePcTransferUI(name, -1);
        }
      };
    }
    xhr.onload = () => {
      endPcTransferItem();
      const ok = xhr.status >= 200 && xhr.status < 300;
      const bodyText = xhr.responseText || '';
      resolve({
        ok,
        status: xhr.status,
        json: async () => JSON.parse(bodyText || '{}'),
      });
    };
    xhr.onerror = () => {
      endPcTransferItem();
      reject(new Error('network error'));
    };
    xhr.onabort = () => {
      endPcTransferItem();
      reject(new Error('aborted'));
    };
    xhr.send(fd);
  });
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

async function copyCapturePng(file) {
  try {
    const res = await fetch(`/media/${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error('fetch failed');
    const blob = await res.blob();
    const pngBlob = typeof toPng === 'function' ? await toPng(blob) : blob;
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
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
      const hay = `${rel.version} ${rel.headline} ${ch.title} ${ch.detail} ${SCOPE_LABELS[ch.scope] || ''}`.toLowerCase();
      return hay.includes(q);
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

function renderCaptures() {
  const grid = $('#grid');
  const empty = $('#grid-empty');
  const countBadge = $('#captures-count');
  const moreWrap = $('#captures-more-wrap');
  const clearBtn = $('#clear-captures');
  if (!grid) return;

  const list = filteredSortedCaptures();
  if (countBadge) countBadge.textContent = String(list.length);
  if (clearBtn) clearBtn.classList.toggle('hidden', captures.length === 0);
  grid.classList.toggle('compact', compactGrid);
  grid.replaceChildren();

  if (!list.length) {
    empty?.classList.remove('hidden');
    moreWrap?.classList.add('hidden');
    return;
  }
  empty?.classList.add('hidden');
  moreWrap?.classList.toggle('hidden', captures.length < 100);

  list.forEach((cap, idx) => {
    const tile = document.createElement('article');
    tile.className = 'cap-tile';
    tile.dataset.id = String(cap.id);
    tile.style.animationDelay = `${Math.min(idx * 12, 120)}ms`;

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'cap-thumb-wrap';
    thumbWrap.onclick = e => {
      if (e.target.closest('.cap-hover-actions')) return;
      openLightbox(idx);
    };

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = `/media/t-${encodeURIComponent(cap.file)}`;
    img.alt = `Capture #${cap.id}`;
    img.onerror = () => { img.src = `/media/${encodeURIComponent(cap.file)}`; };

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
      sendCaptureToPhone(cap.file);
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
      deleteCapture(cap.id);
    };

    hoverActions.append(phoneBtn, dlLink, delBtn);
    thumbWrap.append(img, badge, hoverActions);

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
    copyBtn.onclick = () => copyCapturePng(cap.file);

    footer.append(meta, copyBtn);
    tile.append(thumbWrap, footer);
    grid.appendChild(tile);
  });
}

function openLightbox(idx) {
  const list = filteredSortedCaptures();
  if (idx < 0 || idx >= list.length) return;
  lightboxIdx = idx;
  const cap = list[idx];
  const lb = $('#lightbox');
  const img = $('#lightbox-img');
  const meta = $('#lightbox-meta');
  const dl = $('#lb-download');
  if (!lb || !img) return;

  img.src = `/media/${encodeURIComponent(cap.file)}`;
  if (meta) meta.textContent = `${cap.file} · ${fmtBytes(cap.bytes || 0)} · ${fmtTime(cap.created_at)}`;
  if (dl) {
    dl.href = `/media/${encodeURIComponent(cap.file)}`;
    dl.download = cap.file;
  }
  lb.classList.remove('hidden');
}

function closeLightbox() {
  lightboxIdx = -1;
  $('#lightbox')?.classList.add('hidden');
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

  listEl.replaceChildren();
  if (!files.length) {
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');

  for (const f of files) {
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
            loadStats();
          } catch {
            loadFiles();
          }
        },
      });
    };

    actions.append(dl, del);
    row.append(left, actions);
    listEl.appendChild(row);
  }
}

function isUrlText(str) {
  return /^https?:\/\/\S+$/i.test(String(str || '').trim());
}

function renderTexts() {
  const recentSec = $('#text-recent');
  const recentRows = $('#text-recent-rows');
  const dialogList = $('#texts-dialog-list');
  const countBadge = $('#texts-count');
  const clearBtn = $('#clear-texts-btn');
  const plainTexts = texts.filter(t => t.kind !== 'media');

  if (countBadge) countBadge.textContent = String(plainTexts.length);
  if (clearBtn) clearBtn.classList.toggle('hidden', plainTexts.length === 0);

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

async function loadCaptures() {
  try {
    const r = await fetch('/api/captures?limit=100');
    if (!r.ok) return;
    captures = await r.json();
    renderCaptures();
  } catch {}
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
    if (!r.ok) return;
    files = await r.json();
    renderFiles();
  } catch {}
}

async function loadTexts() {
  try {
    const r = await fetch('/api/text?limit=20');
    if (!r.ok) return;
    texts = await r.json();
    renderTexts();
  } catch {}
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

function connectSse() {
  const dot = $('#conn-dot');
  const txt = $('#conn-text');
  const es = new EventSource('/events');

  es.onopen = () => {
    if (dot) dot.className = 'dot ok';
    if (txt) txt.textContent = 'Live';
  };

  es.onerror = () => {
    if (dot) dot.className = 'dot warn';
    if (txt) txt.textContent = 'Reconnecting…';
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
      loadStats();
    } else if (type === 'deleted') {
      if (msg?.id === 'all') {
        captures = [];
        renderCaptures();
      } else if (typeof msg?.id === 'number') {
        captures = captures.filter(c => c.id !== msg.id);
        renderCaptures();
      } else {
        loadCaptures();
      }
      loadStats();
    } else if (type === 'file') {
      if (msg?.row && msg.row.id != null) {
        if (!files.some(f => f.id === msg.row.id)) {
          files.unshift(msg.row);
        }
        renderFiles();
      } else {
        loadFiles();
      }
      loadStats();
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
      loadStats();
    } else if (type === 'text' || type === 'text-deleted') {
      loadTexts();
    } else if (type === 'settings') {
      applySettingsBundle(msg);
      loadStats();
    } else if (type === 'phone') {
      loadStats();
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

  // What's New sheet modal (opens in-app like Settings)
  $('#whats-new-btn')?.addEventListener('click', () => {
    renderReleases();
    $('#whats-new-backdrop')?.classList.remove('hidden');
  });
  $('#whats-new-close')?.addEventListener('click', () => $('#whats-new-backdrop')?.classList.add('hidden'));

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
    $('#texts-backdrop')?.classList.remove('hidden');
  });
  $('#texts-close')?.addEventListener('click', () => $('#texts-backdrop')?.classList.add('hidden'));
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
    $('#settings-backdrop')?.classList.remove('hidden');
  };
  $('#settings-btn')?.addEventListener('click', openSettingsModal);
  $('#top-settings-btn')?.addEventListener('click', openSettingsModal);
  $('#settings-close')?.addEventListener('click', () => {
    closeAllGlassSelects();
    $('#settings-backdrop')?.classList.add('hidden');
  });

  // Close modals when clicking the backdrop itself
  for (const id of ['#whats-new-backdrop', '#texts-backdrop', '#settings-backdrop', '#lightbox', '#pc-confirm-backdrop']) {
    $(id)?.addEventListener('click', e => {
      if (e.target === $(id)) {
        closeAllGlassSelects();
        if (id === '#lightbox') closeLightbox();
        else if (id === '#pc-confirm-backdrop') closePcConfirm(false);
        else $(id)?.classList.add('hidden');
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

  $('#pc-upload-input')?.addEventListener('change', async e => {
    const list = [...(e.target.files || [])];
    e.target.value = '';
    if (!list.length) return;
    pcTransferTotal = list.length;
    pcTransferDone = 0;
    for (const f of list) await uploadPhotoBlob(f, f.name);
  });

  $('#pc-file-input')?.addEventListener('change', async e => {
    const list = [...(e.target.files || [])];
    e.target.value = '';
    if (!list.length) return;
    pcTransferTotal = list.length;
    pcTransferDone = 0;
    for (const f of list) await uploadPcFile(f);
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
    if (e.key === 'Escape') {
      if (confirmResolver) {
        closePcConfirm(false);
        return;
      }
      closeAllGlassSelects();
      closeLightbox();
      $('#whats-new-backdrop')?.classList.add('hidden');
      $('#texts-backdrop')?.classList.add('hidden');
      $('#settings-backdrop')?.classList.add('hidden');
    } else if (lightboxIdx !== -1) {
      if (e.key === 'ArrowLeft' && lightboxIdx > 0) openLightbox(lightboxIdx - 1);
      if (e.key === 'ArrowRight' && lightboxIdx < filteredSortedCaptures().length - 1) openLightbox(lightboxIdx + 1);
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
    for (const f of dropped) {
      if (f.type.startsWith('image/')) await uploadPhotoBlob(f, f.name);
      else await uploadPcFile(f);
    }
  });
}

wireEvents();
renderReleases();
loadCaptures();
loadFiles();
loadTexts();
loadStats();
loadLan();
loadSettings();
connectSse();
