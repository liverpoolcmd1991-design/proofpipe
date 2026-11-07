// ProofPipe universal capture tray (all websites).
// A floating "p" button opens a tray of recent captures.
// Drag a capture into any chat's message box. A drag carries the stored
// ORIGINAL, byte for byte — and it carries it the ONE way a drop actually reads
// it: as the dragged IMAGE's own bytes.
//
// That is the mechanism, not a preference. Measured with real drags in real
// Chrome, every payload shape dispatched side by side (dev/ext-tray-probe.mjs):
//   · Blink writes a dragged <img>'s own encoded resource into the drag store
//     itself (DataObject::WriteImageToDataObject → AddFileSharedBuffer) and the
//     drop receives it as a real File, byte-for-byte — no re-encode, no resize.
//     An image loaded from a blob: URL contributes exactly that blob's bytes.
//   · setData('DownloadURL', …) is NOT readable by a drop in the SAME document
//     (the probe's drop read an empty store), and no other string is either.
//     Chrome resolves DownloadURL for an OS drop / a drag to another tab, and
//     for nothing else.
//   · items.add(new File([blob], …)) does NOT deliver bytes: the drop receives
//     the FILENAME as text/plain and no file item at all. So the payload this
//     file used to set — DownloadURL plus a File built over the cached original
//     — handed an in-page chat box a bare filename: the drag looked broken
//     because, for the drop, it was. See PITFALLS #56.
// So the drag source is the tile's <img>, and full quality is structural: the
// image being dragged IS the original. The grid still DISPLAYS the derived 400px
// thumbnail (that is what keeps opening the tray cheap); the tile the pointer is
// on is upgraded to the original's blob URL in upgradeTile() — a local load, no
// second transfer, no re-encode — so the grab carries the original. Only a grab
// that crosses Blink's drag threshold before that upgrade lands can carry the
// thumbnail instead.
// Click a capture = copy to clipboard for Ctrl+V instead.
// Server access: background service worker first, direct fetch as fallback
// (SW path can be blocked by newer Chrome's local-network protections; the
// fallback only runs while the tray is open, so any Local-Network-Access
// prompt appears at most once per site).
(() => {
  if (window.top !== window) return; // iframes: skip
  // The ProofPipe harness IS the tray — full-grid, QR, delete, everything.
  // The floating "p" button there just duplicates it and covers the scroll
  // corner, so never inject on our own server's origin. Two layers:
  // 1) sync: the harness DEFAULT origin (loopback, port 8787, root/index
  //    path) is suppressed at boot — covers the common case before storage
  //    answers. Other loopback apps (dev servers on other ports) keep the tray.
  // 2) async un-inject (below, after pp_host is read): covers a harness on a
  //    CUSTOM port. If a FAB flashes there briefly, the self-paste refusal
  //    (PPPasteLogic.isSelfPasteTarget) still breaks the capture loop — the
  //    worst case is a duplicated FAB, never a paste loop.
  const HARNESS_BOOT_RE = /^\/(index\.html?)?([?#].*)?$/i;
  const HARNESS_TITLE_RE = /proofpipe/i;
  const isLoopbackHost = h => h === '127.0.0.1' || h === 'localhost' || h === '::1';
  const isHarnessOrigin = () => {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
    if (!isLoopbackHost(location.hostname) || !HARNESS_BOOT_RE.test(location.pathname)) return false;
    // Default port, or ANY loopback port whose root document is the harness's
    // own (its title). The async pp_host un-inject below still catches every
    // other case, but a storage read is a round-trip away — this closes the
    // window where the FAB flashed on a custom-port harness first.
    return location.port === '8787' || HARNESS_TITLE_RE.test(document.title);
  };
  if (isHarnessOrigin()) return;

  const REFRESH_MS = 5000;
  // Base used for DownloadURL drags (Chrome fetches it itself) and the direct
  // fetch fallback. Defaults to http 127.0.0.1; updated to whatever host the
  // background worker pinned (which may be https) so the extension keeps
  // working when the server runs with TLS.
  let SERVER = 'http://127.0.0.1:8787'; // default; replaced by the pinned origin below
  let serverHostSynced = false;
  // the only origins SERVER may ever be set to (pinned host, media fetch winner,
  // port override) — declared up here so every adopter can use it
  const HOST_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

  const host = document.createElement('div');
  host.id = 'proofpipe-tray-host';
  host.style.cssText = 'all:initial; position:fixed; z-index:2147483647;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'closed' });

  root.innerHTML = `
    <style>
      /* the tray is a dark island inside a page we do not control: declaring the
         color scheme keeps its native textarea chrome/scrollbars dark instead of
         inheriting the host page's light ones */
      :host { all: initial; color-scheme: dark; user-select: none; -webkit-user-select: none; }
      * {
        box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 0;
        user-select: none; -webkit-user-select: none;
      }
      /* The tile's image IS the drag source (see the file header): Blink attaches
         a dragged <img>'s own bytes to the drag, which is the only shape a drop
         in the same document can read. auto is the <img> default; declared here
         because this one property is load-bearing — none on the image silently
         turns every tray drag into an empty one. */
      .cell .thumb { -webkit-user-drag: auto; }

      /* --- floating action button (FAB) --- */
      .fab {
        width: 36px; height: 36px; border-radius: 50%;
        background: linear-gradient(145deg, #1e2023, #17181a); color: #e8e8e6;
        border: 1px solid #2a2c2f; font-size: 16px; font-weight: 700; cursor: pointer;
        box-shadow: 0 4px 14px rgba(0,0,0,.4), 0 0 0 0 rgba(72,76,80,0);
        display: grid; place-items: center; user-select: none;
        transition: border-color .18s, box-shadow .18s, transform .12s;
      }
      .fab:hover {
        border-color: #5a5d60;
        box-shadow: 0 6px 20px rgba(0,0,0,.45), 0 0 0 3px rgba(72,76,80,.12);
      }
      .fab:active { transform: scale(.93); }

      /* --- main panel --- */
      .panel {
        position: fixed; bottom: 64px; right: 14px; width: 280px;
        background: #17181a; color: #e8e8e6; border: 1px solid #2a2c2f;
        border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.02);
        padding: 12px; display: none;
        opacity: 0; transform: translateY(8px) scale(.97); transform-origin: bottom right;
        transition: opacity .18s ease, transform .18s ease;
      }
      .panel.open { display: block; }
      .panel.open.visible { opacity: 1; transform: translateY(0) scale(1); }

      /* --- header --- */
      .head { display: flex; align-items: center; justify-content: space-between; padding: 0 4px 10px; }
      .head b { font-size: 13px; letter-spacing: .2px; }
      .head-actions { display: flex; gap: 4px; align-items: center; }
      .icon-btn {
        background: none; border: 1px solid #2a2c2f; color: #9a9c9e;
        border-radius: 8px; font-size: 11px; padding: 4px 9px; cursor: pointer;
        display: inline-flex; align-items: center; gap: 4px; line-height: 1;
        transition: color .15s, border-color .15s, background .15s;
      }
      .icon-btn:hover { color: #e8e8e6; border-color: #4a4d50; background: rgba(255,255,255,.03); }
      .icon-btn svg { width: 12px; height: 12px; flex: none; }

      /* --- capture grid --- */
      .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; max-height: 238px; overflow-y: auto; }
      .grid::-webkit-scrollbar { width: 5px; }
      .grid::-webkit-scrollbar-track { background: transparent; }
      .grid::-webkit-scrollbar-thumb { background: #2a2c2f; border-radius: 3px; }
      .grid::-webkit-scrollbar-thumb:hover { background: #3a3c3f; }

      .cell {
        position: relative; border-radius: 8px; overflow: hidden; cursor: grab;
        border: 1px solid #2a2c2f; background: #1d1f21;
        -webkit-user-drag: element; user-select: none; -webkit-user-select: none;
        transition: border-color .15s, box-shadow .15s;
      }
      .cell:hover { border-color: #4a4d50; box-shadow: 0 0 0 2px rgba(72,76,80,.15); }
      .cell:active { cursor: grabbing; }
      .cell .thumb { width: 100%; height: 72px; object-fit: cover; display: block; transition: transform .2s; }
      .cell:hover .thumb { transform: scale(1.04); }
      .cell .id {
        pointer-events: none;
        position: absolute; bottom: 3px; left: 3px; font-size: 9px; color: #fff;
        background: rgba(0,0,0,.65); border-radius: 4px; padding: 0 4px; line-height: 13px;
        backdrop-filter: blur(2px);
      }

      /* --- status & empty --- */
      .status { font-size: 11px; color: #9a9c9e; padding: 8px 4px 2px; text-align: center; transition: color .15s; }
      .status.err { color: #ef4444; }
      .empty { font-size: 12px; color: #9a9c9e; text-align: center; padding: 18px 6px; grid-column: 1 / -1; line-height: 1.5; }

      /* --- text section --- */
      .textsec { border-top: 1px solid #2a2c2f; margin-top: 8px; padding-top: 8px; }
      .txthead { font-size: 11px; color: #9a9c9e; padding: 0 4px 6px; display: flex; justify-content: space-between; align-items: center; }
      .txtrow { display: flex; gap: 6px; }
      .txt {
        flex: 1; min-width: 0; resize: none; height: 34px;
        background: #1d1f21; border: 1px solid #2a2c2f; color: #e8e8e6;
        border-radius: 8px; padding: 6px 8px; font-size: 12px; outline: none;
        user-select: text; -webkit-user-select: text;
        transition: border-color .15s;
      }
      .txt:focus { border-color: #4a4d50; }
      .txt::placeholder { color: #6f7274; }
      .txtsend {
        flex: none; width: 46px; border: 1px solid #2a2c2f; border-radius: 8px;
        background: #1d1f21; color: #22c55e; font-size: 12px; cursor: pointer;
        display: grid; place-items: center;
        transition: border-color .15s, background .15s;
      }
      .txtsend:hover { border-color: #4a4d50; background: rgba(34,197,94,.06); }
      .txtitem {
        font-size: 11px; color: #e8e8e6; background: #1d1f21; border: 1px solid #2a2c2f;
        border-radius: 6px; padding: 5px 8px; margin-top: 5px; cursor: pointer;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: text; -webkit-user-select: text;
        transition: border-color .15s, background .15s;
      }
      .txtitem:hover { border-color: #4a4d50; background: rgba(255,255,255,.03); }
      .txtnone { font-size: 11px; color: #6f7274; padding: 4px; text-align: center; }

      /* ---------- UX polish ---------- */
      /* the tray previously had no visible keyboard focus at all */
      .fab:focus-visible, .icon-btn:focus-visible, .txtsend:focus-visible,
      .cell:focus-visible, .txtitem:focus-visible, .txt:focus-visible {
        outline: 2px solid #22c55e; outline-offset: 2px;
      }
      .icon-btn:active, .txtsend:active { transform: scale(.96); }
      .cell { outline-offset: 0; }
      .empty { border: 1px dashed #2a2c2f; border-radius: 10px; }
      .status { min-height: 16px; }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation: none !important; transition: none !important; }
      }
    </style>
    <button class="fab" aria-controls="pp-panel" title="ProofPipe captures — click to open. Drag to move · right-click to hide on this site (restore from the popup)." aria-label="Open ProofPipe capture tray"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12h16"/><circle cx="4" cy="12" r="2.75"/><circle cx="20" cy="12" r="2.75"/></svg></button>
    <div class="panel" id="pp-panel" role="region" aria-label="ProofPipe captures" tabindex="-1">
      <div class="head">
        <b>ProofPipe</b>
        <div class="head-actions">
          <button class="icon-btn sync" title="Re-check the ProofPipe server now" aria-label="Re-check the ProofPipe server now">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
            Sync
          </button>
          <button class="icon-btn reload" title="Reload captures" aria-label="Reload captures">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>
          </button>
        </div>
      </div>
      <div class="grid"></div>
      <div class="textsec">
        <div class="txthead"><b>Text</b><span>type → phone · tap text = copy</span></div>
        <div class="txtrow">
          <textarea class="txt" placeholder="type text to send to your phone…"></textarea>
          <!-- icon + explicit name: the raw arrow glyph this used to carry WAS
               the button's accessible name — announced verbosely, rendered by
               whatever font the host page supplies, and it could not follow
               currentColor. Same reasoning as the harness outbox badge. -->
          <button class="txtsend" title="Send text to phone" aria-label="Send text to phone"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12 16-8-5.5 8 5.5 8-16-8Z"/></svg></button>
        </div>
        <div class="txtlist"></div>
      </div>
      <div class="status" role="status" aria-live="polite"></div>
    </div>
  `;

  const fab = root.querySelector('.fab');
  const panel = root.querySelector('.panel');
  const grid = root.querySelector('.grid');
  const status = root.querySelector('.status');
  const refreshBtn = root.querySelector('.icon-btn.reload');
  const syncBtn = root.querySelector('.icon-btn.sync');
  const txtInput = root.querySelector('.txt');
  const txtSend = root.querySelector('.txtsend');
  const txtList = root.querySelector('.txtlist');

  // Global hide for the FAB — flagged in chrome.storage.local by the toolbar
  // popup, which owns the control. Per-site hide (right-click the p button)
  // is separate and still lives in this origin's localStorage.
  const FAB_GLOBAL_HIDE_KEY = 'pp_fab_global_hidden';
  let fabGloballyHidden = false;

  // The ONE place that applies the global flag to this page. `force` repaints
  // even when the value is unchanged (boot and the focus resync both need it).
  function setGlobalHidden(next, { force = false } = {}) {
    if (!force && next === fabGloballyHidden) return;
    fabGloballyHidden = next;
    updateFabVisibility();
    if (!next) position();
  }

  // LIVE sync from the toolbar popup. Two registrations on purpose:
  //   - chrome.storage.onChanged is the classic event, delivered to content
  //     scripts by every Chrome that runs MV3;
  //   - chrome.storage.local.onChanged is the per-area event (Chrome 73+).
  // Some builds expose only one of them from a content script, and the handler
  // is idempotent, so double delivery is harmless — subscribing to BOTH is what
  // makes the toggle take effect without a page reload.
  function onStorageChange(changes, area) {
    if (area !== 'local' || !changes || !changes[FAB_GLOBAL_HIDE_KEY]) return;
    setGlobalHidden(changes[FAB_GLOBAL_HIDE_KEY].newValue === true);
  }
  try { chrome.storage?.onChanged?.addListener(onStorageChange); } catch {}
  try { chrome.storage?.local?.onChanged?.addListener(onStorageChange); } catch {}

  // Belt + suspenders: if neither event reaches this content script, re-read
  // the flag whenever the page regains focus/visibility — which is exactly what
  // closing the popup does. A missed event can then never leave the tray stale
  // until a reload (the reported "only works after F5" behaviour).
  function resyncGlobalHidden() {
    try {
      chrome.storage?.local?.get(FAB_GLOBAL_HIDE_KEY).then(r => {
        setGlobalHidden(r && r[FAB_GLOBAL_HIDE_KEY] === true);
      }).catch(() => {});
    } catch {}
  }
  addEventListener('focus', resyncGlobalHidden);
  addEventListener('pageshow', resyncGlobalHidden);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resyncGlobalHidden(); });

  // initial paint: default is visible; this read may flip it before the
  // bottom-of-script updateFabVisibility() paints everything (FAB_HIDE_KEY etc.)
  try {
    chrome.storage?.local?.get(FAB_GLOBAL_HIDE_KEY).then(r => {
      setGlobalHidden(r && r[FAB_GLOBAL_HIDE_KEY] === true, { force: true });
    }).catch(() => { updateFabVisibility(); });
  } catch {}

  // Both flavors of "hidden" take the whole tray out; the toolbar menu is the
  // way back (it owns the flag — no hide/show control lives on the page).
  function updateFabVisibility() {
    let siteHidden = false;
    try { siteHidden = localStorage.getItem(FAB_HIDE_KEY) === '1'; } catch {}
    const hidden = fabGloballyHidden || siteHidden;
    host.style.display = hidden ? 'none' : '';
    // the panel is opened by the fab and lives inside the host — no fab, no
    // panel. Guarded on `open` because this runs during boot too, where a
    // close would reach stopPoll() before pollTimer exists (TDZ).
    if (hidden && open) setOpen(false, { focusFab: false });
  }

  // Single write path for the global flag: storage (which fans out to the other
  // tabs via onChanged), then repaint this page.
  function setFabGloballyHidden(next) {
    try {
      const p = chrome.storage?.local?.set({ [FAB_GLOBAL_HIDE_KEY]: next });
      if (p && p.catch) p.catch(() => {});
    } catch {}
    setGlobalHidden(next, { force: true });
  }

  let captures = [];
  let open = false;
  const thumbs = new Map();   // id -> thumbnail objectURL (display only)
  const blobs = new Map();    // id -> Blob of the stored ORIGINAL (drag source + clipboard copy)
  const fullUrls = new Map(); // id -> objectURL of that ORIGINAL (what the dragged <img> shows)

  function bg(msg) {
    return chrome.runtime.sendMessage(msg).then(res => {
      if (!res || res.error) throw new Error((res && res.error) || 'no response');
      return res;
    });
  }

  function goodHostReset() {
    // ask the background worker to forget its pinned host and retry both
    return chrome.runtime.sendMessage({ type: 'resetHost' }).catch(() => {});
  }

  // All server traffic tries the background service worker first (extension
  // context — no per-site prompts). If the SW path fails (newer Chrome can
  // block extension local-network requests), fall back to a direct fetch from
  // the page. That fallback runs ONLY while the tray is open (user gesture),
  // so Chrome's Local-Network-Access prompt can appear at most once per site —
  // click Allow once and it works everywhere from then on.
  // Port discovery (shared contract via discovery.js — the same module the
  // background, offscreen and popup contexts load):
  // the pinned origin from storage comes first, then the manual override
  // (pp_port), the default port and the bounded scan — ONE source for every
  // extension context (the old private copy had drifted from background's).
  // bootstrap: read the pinned origin once at injection; background.js keeps
  // it fresh (it re-pins on every serverFetch). Also layer 2 of the harness
  // suppression: if the pinned origin IS this page (server on a custom port),
  // remove the FAB — the harness renders its own tray.
  // manual override (pp_port) participates in directBases() too — the popup
  // may have pointed the server at a port outside the scan range, and the
  // direct fallback must follow the SAME candidate order as the SW
  // (discovery.js is the single source; private-copy drift is the bug class)
  let manualPortCache = null; // pp_port override for directBases()
  try {
    chrome.storage?.local?.get(['pp_host', 'pp_port']).then(({ pp_host, pp_port } = {}) => {
      if (pp_host && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(pp_host)) {
        SERVER = pp_host;
        try {
          if (new URL(pp_host).origin === location.origin && location.protocol.startsWith('http')) {
            host.remove();
          }
        } catch {}
      }
      manualPortCache = PPDiscovery.parsePort(pp_port);
    }).catch(() => {});
  } catch {}
  function directBases() {
    const manualPort = manualPortCache; // null until storage answers — fine, discovery copes
    // protocol-aware default: an https origin on the protocol default is 443,
    // NOT 80 (Number('') is 0, which would never match a port anyway). This
    // matches background.js's isPinnedServerUrl so the two contexts agree.
    const pinnedUrl = new URL(SERVER);
    const pinnedPort = Number(pinnedUrl.port) || (pinnedUrl.protocol === 'https:' ? 443 : 80);
    const ports = PPDiscovery.candidatePorts({ manualPort, pinnedPort });
    return [...new Set([SERVER, ...PPDiscovery.candidateHosts(ports).filter(h => h.startsWith('http:'))])];
  }

  // ONE adopter for every successful direct fetch: the loopback origin that just
  // answered IS the live server for this page, so SERVER follows it. The drag's
  // DownloadURL is fetched by Chrome itself, so a SERVER left stale (wrong port,
  // or an http/https mismatch) makes that fetch fail silently while every other
  // path keeps working — exactly the failure the tray drag cannot show.
  function adoptServer(base) {
    if (base !== SERVER && HOST_RE.test(base)) SERVER = base;
  }

  // Every direct fetch is BOUNDED — without a timeout a half-open LAN
  // connection left the tray stale forever with no error path (discovery probes
  // had one, data fetches never learned it). JSON budgets are tight; media gets
  // the room a multi-MB photo legitimately needs.
  const JSON_TIMEOUT_MS = 4000;
  const MEDIA_TIMEOUT_MS = 15000;
  async function fetchCaptures() {
    try { return await bg({ type: 'captures' }); } catch {}
    for (const base of directBases()) {
      try {
        const r = await fetch(`${base}/api/captures`, { signal: AbortSignal.timeout(JSON_TIMEOUT_MS) });
        if (r.ok) { adoptServer(base); return await r.json(); }
      } catch {}
    }
    throw new Error('unreachable via background worker and direct fetch');
  }

  // Tiny fingerprint for the poll: `${count}:${latestId}` (a delete of an OLD
  // capture changes the count, a new capture changes both). Same pre-check the
  // harness and the phone's loadRecent use — the 3s poll used to pull the full
  // 100-row list every tick just to discover nothing had changed.
  async function fetchCapturesVersion() {
    try { return await bg({ type: 'capturesVersion' }); } catch {}
    for (const base of directBases()) {
      try {
        const r = await fetch(`${base}/api/captures/version`, { signal: AbortSignal.timeout(JSON_TIMEOUT_MS) });
        if (r.ok) { adoptServer(base); return await r.json(); }
      } catch {}
    }
    return null;
  }

  // server filename guard — shared module (extension/files.js, loaded before
  // this script). It used to be a private copy that had to stay in lockstep
  // with background.js's and popup.js's; a drift there is security-relevant.
  const safeFile = PPFiles.safe;
  // SW blob relay first: the background worker's fetches carry
  // host_permissions and are immune to page-level Local-Network-Access
  // blocks that kill the direct fetch on public https sites (the main
  // auto-paste failure mode — page unfocused means the clipboard fallback
  // dies too, so the media fetch MUST succeed here). The Blob travels over
  // the message channel as-is — no base64 inflation.
  async function fetchMediaSW(file) {
    const r = await bg({ type: 'mediaBlob', file });
    if (r && r.blob instanceof Blob) return r.blob;
    if (typeof r === 'string' && r.startsWith('data:')) return await (await fetch(r)).blob(); // older SW fallback
    throw new Error('media unreachable via SW');
  }
  async function fetchMedia(file, { preferSW = false } = {}) {
    if (preferSW) {
      try { return await fetchMediaSW(file); } catch {}
      // SW busy/restarting — one direct attempt before giving up
    }
    // direct fetch first for the tray/drag UX: fastest path (no SW wake).
    // Cost: one Local-Network-Access prompt per site at most (README).
    for (const base of directBases()) {
      try {
        const r = await fetch(`${base}/media/${safeFile(file)}`, { signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
        if (r.ok) {
          // Adopt whatever origin just served media to THIS page — the drag's
          // DownloadURL is fetched by Chrome itself, so a pinned SERVER that is
          // stale for this page (wrong port, or http/https mismatch) makes that
          // fetch fail silently. Same allowlist as every other adoption.
          adoptServer(base);
          return await r.blob();
        }
      } catch {}
    }
    if (!preferSW) {
      try { return await fetchMediaSW(file); } catch {}
      // legacy dataUrl fallback (pre-mediaBlob extension workers)
      try {
        const dataUrl = await bg({ type: 'dataUrl', file });
        if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) return await (await fetch(dataUrl)).blob();
      } catch {}
    }
    throw new Error('media unreachable');
  }

  // Server rows carry "YYYY-MM-DD HH:MM:SS" in UTC. The tray showed no time at
  // all, so two captures with the same #-less thumbnail were indistinguishable;
  // every other surface renders the viewer's local clock.
  function localTime(sql) {
    if (!sql) return '';
    const d = new Date(String(sql).replace(' ', 'T') + 'Z');
    return isNaN(d) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function setStatus(text, isErr = false) {
    status.textContent = text;
    status.className = 'status' + (isErr ? ' err' : '');
  }
  // the tray's resting hint — ONE string, so the poll's repaint after a load and
  // a drag's end can never drift apart from what the tray actually does
  const IDLE_STATUS = 'drag or Ctrl+Enter → chat · click = copy';

  // toPng comes from the shared extension/toPng.js (same file as public/toPng.js)

  // The stored ORIGINAL as a Blob — the one thing the drag's BYTES and the
  // clipboard copy both need. Fetched from the pointer (hover/press) rather than
  // at render: loading a full-size capture per visible cell is exactly the cost
  // the 400px grid thumbnail exists to avoid, and warming on hover means the
  // bytes are already in hand when the drag starts, so the drag adds no fetch
  // and no latency of its own.
  const prefetchFull = c => {
    if (blobs.has(c.id)) return Promise.resolve();
    return fetchMedia(c.file)
      .then(blob => { blobs.set(c.id, blob); evictCaches(); })
      .catch(() => {});
  };
  const prefetchThumb = c => {
    if (thumbs.has(c.id)) return Promise.resolve();
    return fetchMedia(`t-${c.file}`)
      .then(blob => {
        thumbs.set(c.id, URL.createObjectURL(blob));
        evictCaches();
      })
      .catch(() => {});
  };

  // cap the caches — a stored original is hundreds of KB to a few MB and the
  // tray injects into EVERY site, so a page-worth of budget per tab adds up.
  // Insertion order is oldest-first, so dropping from the front evicts the
  // least recently ADDED entry (a miss just refetches from the LAN).
  function evictCaches() {
    for (const [map, cap] of [[blobs, 12], [thumbs, 40]]) {
      if (map.size <= cap) continue;
      for (const key of map.keys()) {
        if (map.size <= cap) break;
        // both object-URL maps pin their blob: the thumbnails directly, and
        // fullUrls through the original it wraps (released with its blob below)
        if (map === thumbs) URL.revokeObjectURL(map.get(key));
        map.delete(key);
        if (map === blobs) releaseFullUrl(key);
      }
    }
  }

  // A tile showing the ORIGINAL has to fall back to the 400px thumbnail before
  // its object URL is revoked, or evicting the blob turns a tile into a broken
  // image. Hovering it again re-upgrades from the LAN.
  function releaseFullUrl(id) {
    const url = fullUrls.get(id);
    if (!url) return;
    const img = cellById.get(id)?.querySelector('img.thumb');
    const showing = img && (img.dataset.original === url || img.dataset.upgrading === url);
    // Only let go when there is something to fall BACK to. With no thumbnail in
    // hand (its own fetch evicted or failed) revoking would leave a broken image
    // on screen, so the tile keeps the original — one blob stays pinned, which the
    // cache cap bounds — and the next render re-fetches the thumbnail.
    if (showing) {
      const thumb = thumbs.get(id);
      if (!thumb) return;
      img.dataset.original = '';
      img.dataset.upgrading = '';
      img.src = thumb;
    }
    fullUrls.delete(id);
    URL.revokeObjectURL(url);
  }

  // The drag carries whatever bytes the dragged <img> has loaded, so this is what
  // makes a drag full-quality: point the tile's image at the stored ORIGINAL's
  // blob URL the moment the pointer is on the tile. A blob: URL is a local load —
  // no fetch (the blob is already in hand), no re-encode, no resize — and an
  // image dragging out of the grid keeps its place and crop because object-fit
  // does not move.
  function upgradeTile(c, img) {
    prefetchFull(c).then(() => {
      const blob = blobs.get(c.id);
      if (!blob || !img.isConnected) return;
      let url = fullUrls.get(c.id);
      if (!url) {
        url = URL.createObjectURL(blob);
        fullUrls.set(c.id, url);
        evictCaches();
      }
      if (img.dataset.original === url || img.dataset.upgrading === url) return;
      // `original` means LOADED, not assigned: Blink writes the loaded resource
      // into the drag store, so a src that is still in flight is still the
      // thumbnail as far as a drag is concerned — and it is what the drag's
      // low-res tripwire reads. `upgrading` covers the gap in between, which also
      // keeps the thumbnail path from clobbering a load that is still running.
      img.dataset.upgrading = url;
      img.onload = () => {
        if (img.getAttribute('src') !== url) return;
        img.dataset.upgrading = '';
        img.dataset.original = url;
      };
      img.src = url;
    });
  }

  // ---------- thumbnail fetching is VISIBILITY-gated ----------
  // The server list is up to 100 rows while the grid shows ~9 cells, so the old
  // eager prefetch for every row fired ~90+ parallel LAN fetches on each open —
  // all of them fighting the handful actually on screen. One observer, rebound
  // per render (the grid is rebuilt wholesale) and rootMargin'd so a fast scroll
  // doesn't outrun the LAN. Falls back to the eager path if IO is missing.
  const thumbTargets = new WeakMap(); // cell -> { c, img }
  let thumbObserver = null;
  try {
    thumbObserver = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        thumbObserver.unobserve(en.target);
        const t = thumbTargets.get(en.target);
        if (!t) continue;
        // never clobber a tile that has already been upgraded to the original
        // (the pointer can beat the observer to a cell that was just scrolled in)
        prefetchThumb(t.c).then(() => {
          if (t.img.isConnected && !t.img.dataset.original && !t.img.dataset.upgrading) {
            t.img.src = thumbs.get(t.c.id) || '';
          }
        });
      }
    }, { root: grid, rootMargin: '150px' });
  } catch { thumbObserver = null; }

  // Cells are RECONCILED by id instead of rebuilt wholesale: the 3s poll used
  // to disconnect the observer and recreate every cell (up to 100 rows, each
  // with fresh listeners + observer registration) whenever a single capture
  // changed. Reusing the node keeps its decoded thumbnail, listeners and place.
  const cellById = new Map(); // capture id -> live cell
  function buildCell(c) {
    const cell = document.createElement('div');
      cell.className = 'cell';
      const when = localTime(c.created_at);
      cell.title = `#${c.id}${when ? ` · ${when}` : ''} — drag it or press Ctrl+Enter into the chat box, or click to copy`;
      const img = document.createElement('img');
      img.className = 'thumb';
      img.alt = `#${c.id}`;
      // THE drag source (see the .thumb rule and the file header): Blink writes a
      // dragged <img>'s own loaded bytes into the drag store, which is the only
      // payload a drop in the same document can read — and upgradeTile() swaps
      // this element over to the stored ORIGINAL the moment the pointer arrives.
      img.draggable = true;
      if (thumbObserver) {
        thumbTargets.set(cell, { c, img }); // fetched when it scrolls into view
        thumbObserver.observe(cell);
      } else {
        prefetchThumb(c).then(() => {
          if (cell.isConnected && !img.dataset.original && !img.dataset.upgrading) {
            img.src = thumbs.get(c.id) || '';
          }
        });
      }
      const id = document.createElement('span');
      id.className = 'id';
      id.textContent = `#${c.id}`;
      cell.append(img, id);
      // the tile is draggable too, so a drag that starts on the 1px border (the
      // only part of the cell the image does not cover) still starts a drag at
      // all; the image above is the source that actually carries bytes
      cell.draggable = true;
      // keyboard-reachable: Enter/Space copies (drag is mouse-only)
      cell.tabIndex = 0;
      cell.setAttribute('role', 'button');
      cell.setAttribute('aria-label', `Capture #${c.id}${when ? ` at ${when}` : ''} — press Enter to copy, Ctrl+Enter to paste it into the chat, or drag it`);
      cell.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          // Ctrl/⌘+Enter = the drag, from the keyboard: straight into the page's
          // own editor, no clipboard and no Ctrl+V owed. Plain Enter/Space stays
          // copy-to-clipboard, which is what the tile's tooltip promises.
          if (e.ctrlKey || e.metaKey) pasteIntoTarget(c);
          else copyOriginal(c);
        }
      });

      // hover / press before drag: fetch the stored ORIGINAL and point THIS tile's
      // image at it, so the bytes Blink writes into the drag store are the
      // original's. The gesture gives this a few hundred ms (the pointer has to
      // arrive, aim, press and cross the drag threshold), and a blob: load is
      // local — see upgradeTile.
      cell.addEventListener('pointerenter', () => upgradeTile(c, img));

      // track press point so a post-drag click doesn't double-fire copy
      let downXY = null;
      // did the DRAG's payload carry the original? decided at dragstart (the tile
      // can finish upgrading mid-drag, but the payload was built already) and
      // reported at dragend — see the tripwire there
      let payloadWasOriginal = false;
      cell.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        downXY = [e.clientX, e.clientY];
        upgradeTile(c, img); // the pointer can land on a tile it never "entered"
        // NOTE: no preventDefault here — canceling mousedown's default action
        // cancels the native drag and degenerates the gesture into selection.
        // selectstart is deliberately NOT canceled either: this repo has already
        // been bitten by exactly that aborting drag initiation (v0.3.5), and
        // user-select:none plus the pointer-events:none id chip already make a
        // selection impossible, so there is nothing left to suppress.
      });

      // DRAG, on the IMAGE (the event bubbles to here): what the drop reads is
      // the image's own bytes, which Blink writes BEFORE this handler runs, so
      // the one thing left to add is Chrome's DownloadURL — for an OS drop or a
      // drag to another tab, where an in-page drop's blob would not survive
      // anyway. Built AT DRAGSTART because SERVER only becomes the live scheme
      // (http vs https) after a getHost round-trip succeeds: a payload frozen at
      // cell-creation time could point at the wrong scheme and make every drag
      // silently fail until the tray had been opened once.
      cell.addEventListener('dragstart', e => {
        // NEVER cancel dragstart — a canceled drag degenerates into text selection.
        // c.id is server JSON: sanitize it (DownloadURL is mime:filename:url —
        // a ':' or newline in the id would malformed the payload) the same way
        // c.file is guarded by FILE_RE.
        const idSlug = String(c.id).replace(/[^A-Za-z0-9_-]/g, '') || 'capture';
        // ONE source of truth for the drag's file URL: the stored ORIGINAL.
        const originalUrl = `${SERVER}/media/${encodeURIComponent(c.file)}`;
        // ...declared with the capture's REAL format: a PNG/WebP/HEIC capture
        // used to go over as "image/jpeg" / ".jpg", and consumers that trust
        // the declared type re-encoded it lossily (see PPPasteLogic.dragFile).
        const { mime, filename } = PPPasteLogic.dragFile(idSlug, c.file);
        // In its OWN try, and alone: a drop in the same document cannot read a
        // string format at all (it reads the image's bytes), so this entry exists
        // only for the targets that DO resolve it — and the one thing that must
        // never happen is it throwing and taking the rest of the handler with it.
        try {
          e.dataTransfer.setData('DownloadURL', `${mime}:${filename}:${originalUrl}`);
        } catch {}
        e.dataTransfer.effectAllowed = 'copy';
        // The tile's image IS the payload, so this is the one moment the app can
        // know whether a full-quality file is on its way or the 400px preview is.
        payloadWasOriginal = !!img.dataset.original;
        // drag visual: the thumbnail, so the cursor carries the capture itself
        // rather than the whole card. Declared by hand on every drag because the
        // dragged image may be the full-size original (whose own preview Blink
        // would otherwise scale, or skip entirely for a very large one). A drag
        // image is a preview only: it never becomes a payload entry.
        if (thumbs.has(c.id)) {
          const ghost = document.createElement('img');
          ghost.src = thumbs.get(c.id);
          e.dataTransfer.setDragImage(ghost, 40, 30);
        }
        setStatus(`#${c.id} — drop it on the message box`);
      });
      cell.addEventListener('dragend', e => {
        if (!open) return;
        // TRIPWIRE: the one quality hole this design has is a grab that beats the
        // hover upgrade, which sends the derived 400px thumbnail. A silent
        // downgrade is the exact thing this path exists to prevent, so say it
        // where the user is looking — but only for a drag that actually delivered
        // something (a canceled drag never went anywhere).
        const delivered = e.dataTransfer && e.dataTransfer.dropEffect !== 'none';
        if (!payloadWasOriginal && delivered) {
          setStatus(`#${c.id} went out as the 400px preview — hover the tile, then drag again`, true);
        } else {
          setStatus(IDLE_STATUS);
        }
      });
      // click still fires after a drag on some sites; only copy on a true click
      cell.addEventListener('click', e => {
        if (downXY && (Math.abs(e.clientX - downXY[0]) > 6 || Math.abs(e.clientY - downXY[1]) > 6)) return; // was a drag
        copyOriginal(c);
      });
    return cell;
  }
  function render() {
    if (!captures.length) {
      for (const [id, cell] of cellById) {
        if (thumbObserver) thumbObserver.unobserve(cell);
        thumbTargets.delete(cell);
        cell.remove();
        cellById.delete(id);
      }
      if (!grid.querySelector('.empty')) grid.innerHTML = '<div class="empty">No captures yet.<br>Snap one with the phone app.</div>';
      return;
    }
    grid.querySelector('.empty')?.remove(); // drop the empty placeholder once rows exist
    const ids = new Set(captures.map(c => c.id));
    for (const [id, cell] of cellById) {
      if (ids.has(id)) continue;
      if (thumbObserver) thumbObserver.unobserve(cell);
      thumbTargets.delete(cell);
      cell.remove();
      cellById.delete(id);
    }
    // ONE ordered pass: place each cell after the one before it. A cell already
    // in position is never touched (no DOM write, no re-observe, no re-decode).
    let prev = null;
    for (const c of captures) {
      let cell = cellById.get(c.id);
      if (!cell) { cell = buildCell(c); cellById.set(c.id, cell); }
      const wantNext = prev ? prev.nextSibling : grid.firstChild;
      if (cell !== wantNext) grid.insertBefore(cell, wantNext);
      prev = cell;
    }
  }

  const pngCache = new Map(); // id -> encoded PNG (instant re-copy, no re-encode)
  // Per-TAB budget, kept deliberately small: a 48MP PNG is 30–50MB and the
  // tray only re-copies the latest few captures — but the tray injects into
  // EVERY site, so twenty open tabs each holding a page-worth of budget adds
  // up. 24MB ≈ one big photo + headroom for a couple of small ones; misses
  // just re-encode from the original-blob cache (capped separately, 12).
  const PNG_BUDGET = 24 * 1024 * 1024;
  let pngBytes = 0;
  function pngCachePut(id, png) {
    if (pngCache.has(id)) { pngBytes -= pngCache.get(id).size; pngCache.delete(id); }
    pngCache.set(id, png);
    pngBytes += png.size;
    while (pngBytes > PNG_BUDGET && pngCache.size > 1) {
      const old = pngCache.keys().next().value;
      pngBytes -= pngCache.get(old).size;
      pngCache.delete(old);
    }
  }
  // ONE clipboard write path for the whole tray (click-to-copy, the auto-paste
  // fallback, the undelivered flush). It hands the API a PROMISE for the PNG, so
  // the write is accepted while the encode and the media fetch behind it are
  // still running. Awaiting the PNG first is what made a big copy report itself
  // blocked: the encode of a 12MP capture runs for seconds, which outlives
  // Chromium's transient-activation window — the write then had no activation
  // left to spend and failed with NotAllowedError even though nothing was wrong.
  // The awaited form is kept only as the fallback for a build that refuses a
  // promised blob outright, so no browser loses the copy.
  async function writePngToClipboard(c) {
    const png = pngFor(c);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e; // a real failure (encode, permission)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': await png })]);
    }
  }

  async function copyOriginal(c) {
    try {
      setStatus(`copying #${c.id}…`);
      await writePngToClipboard(c);
      setStatus(`copied #${c.id} — Ctrl+V into the chat`);
    } catch (e) {
      console.debug('ProofPipe copy failed:', e); // the toast alone hides WHY (permissions? encode? fetch?)
      // The one cause the user can actually fix: the clipboard needs the PAGE to
      // hold focus, and clicking the toolbar popup took it away. Everything else
      // is drag-or-popup territory (drag is mouse-only, so a keyboard user needs
      // that hint spelled out).
      setStatus(e && e.name === 'NotAllowedError'
        ? 'copy blocked — click anywhere on this page, then copy again'
        : 'copy blocked — drag the capture, or copy it from the toolbar popup', true);
    }
  }

  let capturesVersion = null; // fingerprint of the list we last rendered
  let textsVersionId;         // newest TEXT id the poll has acted on (see loadTexts)
  async function load() {
    try {
      // adopt the host the background worker pinned (http or https) so the
      // DownloadURL drag payload and direct fallback match the live server.
      // Allowlisted: never adopt an arbitrary string from another context.
      if (!serverHostSynced) {
        try {
          const { host } = await bg({ type: 'getHost' });
          if (host && HOST_RE.test(host)) SERVER = host;
          serverHostSynced = true; // latch on a SUCCESSFUL read only
        } catch {
          // SW asleep/restarting (the common first-load case): leave the flag
          // false so the NEXT load retries. Latching here pinned SERVER to the
          // built-in default for the page's whole life, and a stale SERVER makes
          // Chrome's own DownloadURL fetch fail silently.
        }
      }
      // cheap fingerprint first: nothing changed → no 100-row fetch at all.
      // Gated on `captures.length`, not on the DOM: the error path below repaints
      // an EMPTY grid while the fingerprint still matches, and that tick must
      // refetch rather than leave "no captures yet" on screen.
      const v = await fetchCapturesVersion();
      const fp = v ? `${v.n}:${v.latest}` : null;
      // The SAME response carries the newest TEXT id, and the tray used to throw
      // it away: the text list was rendered once when the tray opened and never
      // again, so a text sent from the phone while the tray was open never
      // appeared — the one direction this panel exists for. The server publishes
      // `textId` precisely so a polling client notices (see PITFALLS #59), so the
      // refresh costs no extra request and no second timer.
      if (v && v.textId !== textsVersionId) {
        textsVersionId = v.textId;
        loadTexts({ quiet: true });
      }
      if (fp && fp === capturesVersion && captures.length) return;
      const caps = await fetchCaptures();
      capturesVersion = fp;
      // skip the re-render entirely when nothing changed (poll tick with no news)
      const unchanged = caps.length === captures.length &&
        caps[0]?.id === captures[0]?.id &&
        caps.every((c, i) => c.id === captures[i]?.id);
      if (unchanged && grid.childElementCount) return;
      captures = caps;
      render();
      if (open) setStatus(IDLE_STATUS);
      // warm only the newest few full-size images — the rest load on hover
      captures.slice(0, 5).forEach(prefetchFull);
    } catch {
      // only clear the UI if we previously had data (don't flash on first tick)
      if (captures.length || grid.childElementCount) {
        captures = [];
        capturesVersion = null; // the next successful tick must refetch, not trust the fingerprint
        render();
      }
      setStatus('server not reachable — press ⟳ Sync now (or start ProofPipe.bat)', true);
      serverHostSynced = false;
    }
  }

  // FAB placement: drag to move (remembered per browser via page localStorage),
  // right-click hides it on THIS site only (restore via the popup button).
  // A 5px threshold separates a drag from a click so opening the tray still works.
  const FAB_POS_KEY = 'pp_fab_pos';
  const FAB_HIDE_KEY = 'pp_fab_hidden_site';
  let fabDrag = null;
  let suppressFabClick = false;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  fab.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    fabDrag = { sx: e.clientX, sy: e.clientY, ox: host.offsetLeft, oy: host.offsetTop, moved: false };
    try { fab.setPointerCapture(e.pointerId); } catch {}
  });
  fab.addEventListener('pointermove', e => {
    if (!fabDrag) return;
    const dx = e.clientX - fabDrag.sx, dy = e.clientY - fabDrag.sy;
    if (!fabDrag.moved && Math.hypot(dx, dy) < 5) return;
    fabDrag.moved = true;
    host.style.left = `${clamp(fabDrag.ox + dx, 10, window.innerWidth - 44)}px`;
    host.style.top = `${clamp(fabDrag.oy + dy, 10, window.innerHeight - 44)}px`;
  });
  fab.addEventListener('pointerup', () => {
    if (fabDrag && fabDrag.moved) {
      suppressFabClick = true;
      setTimeout(() => { suppressFabClick = false; }, 0);
      try { localStorage.setItem(FAB_POS_KEY, JSON.stringify({ l: host.style.left, t: host.style.top })); } catch {}
    }
    fabDrag = null;
  });
  fab.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    try { localStorage.setItem(FAB_HIDE_KEY, '1'); } catch {}
    updateFabVisibility(); // per-site hide takes the whole host out
    setOpen(false, { focusFab: false });
  });
  // ---------- auto-paste (phone "auto" mode) ----------
  // A synthetic 'paste' event carrying the image as a real File in a
  // DataTransfer — the same thing a user's Ctrl+V produces, minus the
  // keystroke. Needs no OS focus, so it lands in this tab even when Chrome
  // is in the background. Verified by diffing the target's content ~400ms
  // later; sites that reject untrusted paste events fall back to clipboard
  // + toast (and are remembered so next time skips straight there).
  const PASTE_FAIL_KEY = 'pp_paste_fail';

  function toast(text, isErr = false) {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = `position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:2147483647;background:${isErr ? '#3b1215' : '#17181a'};color:#e8e8e6;border:1px solid ${isErr ? '#ef4444' : '#2a2c2f'};border-radius:999px;padding:8px 16px;font:12px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);`;
    document.documentElement.appendChild(d);
    setTimeout(() => d.remove(), 2600);
  }

  // Every way a chat site spells "this is the box you type in". The old list was
  // `[contenteditable="true"], textarea, input[type="text"]` — it missed
  // `contenteditable=""` (which IS editable), `plaintext-only`, and the
  // `role="textbox"` wrappers some composers are built from.
  const EDITABLE_SEL = [
    '[contenteditable="true"]', '[contenteditable=""]', '[contenteditable="plaintext-only"]',
    '[role="textbox"]', 'textarea',
    'input[type="text"]', 'input[type="search"]', 'input:not([type])',
  ].join(', ');
  const isEditor = el => {
    // getClientRects() is the visibility test AND the type=hidden guard: a
    // display:none / 0×0 / type=hidden control has no rects
    if (!el || el.nodeType !== 1 || !el.getClientRects().length) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    // a password/file/button-ish control is never a capture target
    return !/^(password|hidden|button|submit|reset|checkbox|radio|file|image)$/i.test(el.type || 'text');
  };
  function findChatTarget() {
    // the focused editor is where the caret is — always the first choice
    const a = document.activeElement;
    if (isEditor(a)) return a;
    // otherwise the LARGEST visible editable element. A chat composer is big and
    // a search box or footer field is small, so area separates them; this used
    // to take the LAST candidate in DOM order, which is how an auto-paste could
    // land in a comment box below the composer while the composer sat empty.
    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll(EDITABLE_SEL)) {
      if (!isEditor(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area >= bestArea) { best = el; bestArea = area; } // a tie keeps the later node
    }
    // Nothing editable on the page: body is still worth a shot — a site that
    // handles paste at the document level gets it (attempt 2 bubbles there), and
    // a miss just costs the verification budget before the clipboard fallback.
    return best || document.body;
  }

  // ONE encode per capture, shared: the click path, the auto-paste PNG retry and
  // the undelivered flush all funnel through here, so a second caller JOINS the
  // in-flight encode instead of starting a duplicate one — a 48MP encode is
  // seconds of a worker thread and nobody wants to pay it twice for one capture.
  const pngPending = new Map(); // id -> in-flight encode
  function pngFor(c) {
    const cached = pngCache.get(c.id);
    if (cached) return Promise.resolve(cached);
    const inflight = pngPending.get(c.id);
    if (inflight) return inflight;
    const tracked = (async () => {
      let blob = blobs.get(c.id);
      if (!blob) {
        blob = await fetchMedia(c.file);
        blobs.set(c.id, blob);
        evictCaches();
      }
      const png = await toPng(blob);
      pngCachePut(c.id, png);
      return png;
    })().finally(() => pngPending.delete(c.id));
    pngPending.set(c.id, tracked);
    tracked.catch(() => {}); // a caller that moves on first must not leak an unhandled rejection
    return tracked;
  }

  // auto-paste fast path: the synthetic paste File does NOT need to be PNG —
  // chat editors accept the original JPEG/WebP as-is. Re-encoding a 12MP photo
  // to a 20-40MB PNG cost seconds per paste (toPng is only required by the
  // clipboard API, which the fallback uses).
  // preferSW: auto-paste runs while the page is often UNFOCUSED — the direct
  // fetch may be LNA-blocked and the clipboard fallback needs focus, so the
  // media fetch has to succeed via the SW relay.
  async function rawFor(c) {
    let blob = blobs.get(c.id);
    if (!blob) {
      blob = await fetchMedia(c.file, { preferSW: true });
      // keep it: the PNG retry below encodes THIS blob, and without the cache it
      // would go back to the LAN for bytes already in hand
      blobs.set(c.id, blob);
      evictCaches();
    }
    return blob;
  }

  // fallback: OS clipboard + toast. Needs page focus; fails gracefully otherwise.
  async function copyAndHint(c) {
    try {
      await writePngToClipboard(c);
      toast(`#${c.id} copied — click the chat box and press Ctrl+V`);
      return true;
    } catch {
      toast(`photo #${c.id} arrived — click this tab, it will be copied`, true);
      return false;
    }
  }

  // ---------- undelivered queue: captures that couldn't paste OR copy ----------
  // paste-logic.js carries the pure decision rules (self-paste refusal,
  // filename construction, insert detection) — shared contract, unit-tested
  // in test/extension-logic.test.js. The local helpers below delegate to it.
  // Auto-paste usually fires while this tab is UNFOCUSED (you're on the phone).
  // A clipboard write needs focus and some sites reject synthetic paste — the
  // capture used to evaporate with only a badge nudge. Queue it and deliver on
  // the next focus of this tab (clipboard then succeeds).
  const UNDELIVERED_KEY = 'pp_undelivered';
  const UNDELIVERED_CAP = 10;
  const undelivered = [];
  // the queue must survive a page reload — the whole point is "deliver on the
  // next focus", and the user may reload before refocusing. Persist the
  // capture records themselves (small: id + file + a few fields), not a count.
  function saveUndelivered() {
    try {
      localStorage.setItem(UNDELIVERED_KEY, JSON.stringify(undelivered.map(c => ({
        id: c.id, file: c.file, created_at: c.created_at || '',
      }))));
    } catch {}
  }
  // restore at boot; strict shape check — a stale/garbage entry must never
  // reach fetchMedia (FILE_RE there is the real guard, but fail early anyway)
  try {
    const saved = JSON.parse(localStorage.getItem(UNDELIVERED_KEY) || '[]');
    if (Array.isArray(saved)) for (const c of saved) {
      if (c && typeof c.file === 'string' && c.id != null) undelivered.push(c);
    }
  } catch {}
  function queueUndelivered(c) {
    if (undelivered.some(x => x.id === c.id)) return;
    undelivered.push(c);
    if (undelivered.length > UNDELIVERED_CAP) undelivered.shift();
    saveUndelivered();
  }
  async function flushUndelivered() {
    while (undelivered.length) {
      const c = undelivered[0];
      try {
        await writePngToClipboard(c);
        undelivered.shift();
        saveUndelivered();
        toast(`#${c.id} copied — Ctrl+V into the chat`);
      } catch { break; } // still no focus/permission — try again on next focus
    }
  }
  addEventListener('focus', () => { flushUndelivered(); });
  addEventListener('visibilitychange', () => { if (!document.hidden) flushUndelivered(); });

  async function autoPasteCapture(c) {
    if (!c || !c.file) return false;
    // never auto-paste into the ProofPipe harness itself: its paste handler
    // re-uploads the image, which fires another auto event -> loop of
    // duplicate captures. Refuse quietly (no fail flag, no toast).
    // Decision in PPPasteLogic (unit-tested); pinnedPort from the live SERVER.
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      const pinnedPort = SERVER ? Number(new URL(SERVER).port) : null;
      if (PPPasteLogic.isSelfPasteTarget(location.href, { pinnedPort })) {
        return false; // refuse quietly — pasting into the harness would loop
      }
    }
    try {
      // always attempt the synthetic paste first — a stale per-site failure
      // flag must not permanently disable auto-paste; verification below
      // decides, and the fallback runs only on a real rejection
      const blob = await rawFor(c);
      const target = findChatTarget();
      const fname = PPPasteLogic.pasteFileName(c.id, blob.type);
      const file = new File([blob], fname, { type: blob.type || 'image/jpeg' });
      if (await pasteVerify(target, file, fname)) {
        toast(`#${c.id} pasted`);
        return true;
      }
      // one PNG retry: some editors (Slack/Discord-style) accept paste files
      // only as image/png — the original JPEG/WebP gets silently ignored
      if (PPPasteLogic.needsPngRetry(blob.type)) {
        try {
          const png = await pngFor(c);
          const pngName = `proofpipe-${c.id}.png`;
          if (await pasteVerify(target, new File([png], pngName, { type: 'image/png' }), pngName)) {
            toast(`#${c.id} pasted`);
            return true;
          }
        } catch {}
      }
      // site ignored the untrusted paste event — remember and fall back
      try { localStorage.setItem(PASTE_FAIL_KEY, '1'); } catch {}
      const copied = await copyAndHint(c);
      if (!copied) queueUndelivered(c); // clipboard needs focus → deliver on next focus
      return copied;
    } catch {
      try { localStorage.setItem(PASTE_FAIL_KEY, '1'); } catch {}
      const copied = await copyAndHint(c);
      if (!copied) queueUndelivered(c);
      return copied;
    }
  }

  // Ctrl/⌘+Enter on a tile: the keyboard's answer to the DRAG. It reuses the
  // phone's "auto" path whole — target discovery, the PNG retry, the clipboard
  // fallback and the undelivered queue all live there — because a mouse-free
  // transfer should land in the page's own editor, not in the clipboard with a
  // Ctrl+V still owed. autoPasteCapture owns its toasts, so only a total failure
  // (including "this page is the harness, pasting here would loop") needs a
  // status line of its own.
  async function pasteIntoTarget(c) {
    setStatus(`#${c.id} — sending it to the chat…`);
    if (!(await autoPasteCapture(c))) {
      setStatus(`#${c.id} not delivered — press Enter to copy it, then Ctrl+V`, true);
    }
  }

  function pasteAttempt(target, file, bubbles) {
    const dt = new DataTransfer();
    dt.items.add(file);
    // dispatchEvent returns FALSE when any handler called preventDefault() —
    // real paste handlers virtually always do. That's our strongest,
    // near-universal "the site handled it" signal.
    return target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles, cancelable: true }));
  }
  // document-wide insert detection, ALL the ways sites render pasted images:
  // editor text, <img>, attachment chips (the filename label — DeepSeek),
  // canvas previews, blob: URLs, shadow DOM. The old editor-only check
  // false-negatived, every escalation fired, and the photo pasted 4x.
  // The snapshot/check rules live in PPPasteLogic (unit-tested);
  // watchInsert adds the async layer (input events, MutationObserver).
  function watchInsert(target, fname, base) {
    return new Promise(res => {
      let done = false, inputSeen = false, mo = null;
      const onInput = () => { inputSeen = true; finish(true); };
      const check = (broad = true) =>
        PPPasteLogic.insertedAnywhere(target, fname, base, { broad }) ||
        inputSeen; // a handled paste virtually always fires input on the editor
      const finish = v => { if (!done) { done = true; try { mo && mo.disconnect(); } catch {} target.removeEventListener('input', onInput, true); clearTimeout(timer); res(v); } };
      // A broad page scan runs at most twice per attempt (now and at timeout),
      // never once per animation frame.
      const timer = setTimeout(() => finish(check(true)), 1200);
      if (check(true)) return finish(true);
      target.addEventListener('input', onInput, { capture: true });
      try {
        // rAF-debounced: check() walks the full shadow-root text (every
        // element), and the observer fires per mutation on busy pages —
        // first filter the records with a cheap local hint. Unrelated chat
        // typing/animation mutations now cost zero full-document scans; a
        // possibly relevant record still follows the original check path.
        let raf = 0;
        mo = new MutationObserver(records => {
          const hint = PPPasteLogic.mutationMayContainInsert(records, target, fname);
          if (hint === false) return;
          // An exact unique-filename/media insertion is already proof; stop the
          // observer immediately. Uncertain editor-local mutations use only the
          // scoped check, never body.textContent/global selectors.
          if (hint === true) return finish(true);
          if (raf) return;
          raf = requestAnimationFrame(() => { raf = 0; if (!done && check(false)) finish(true); });
        });
        mo.observe(document.body, {
          childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ['src', 'href'],
        });
      } catch { finish(check()); }
    });
  }
  async function pasteVerify(target, file, fname) {
    // attempt 1: non-bubbling — only the target's own handler (what Ctrl+V does)
    let base = PPPasteLogic.snapshot(target);
    if (pasteAttempt(target, file, false) === false) return true; // site handled it
    if (await watchInsert(target, fname, base)) return true;
    // attempt 2: bubbling — handlers higher up the tree (document/root)
    base = PPPasteLogic.snapshot(target);
    if (pasteAttempt(target, file, true) === false) return true;
    return watchInsert(target, fname, base);
  }

  // popup "Show p button on this site" lands here; also report FAB visibility
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // unhideSite is the older message (per-site only); both names now clear
    // per-site AND global hide — one path, so the two can't drift apart.
    if (msg && (msg.type === 'unhideSite' || msg.type === 'unhideGlobal')) {
      try { localStorage.removeItem(FAB_HIDE_KEY); } catch {}
      setFabGloballyHidden(false);
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'autoPaste') {
      // phone "auto" mode: paste (or copy) the capture in this tab
      autoPasteCapture(msg.capture).then(ok => sendResponse({ ok })).catch(() => sendResponse({ ok: false }));
      return true; // async response
    } else if (msg && msg.type === 'fabState') {
      let pasteFail = false;
      try { pasteFail = localStorage.getItem(PASTE_FAIL_KEY) === '1'; } catch {}
      sendResponse({ hidden: host.style.display === 'none', pasteFail, undelivered: undelivered.length, globallyHidden: fabGloballyHidden });
    }
  });

  // open the panel anchored to the FAB (flip up/sideways near screen edges)
  function placePanel() {
    const fabRight = host.offsetLeft + host.offsetWidth;
    panel.style.right = `${Math.max(8, window.innerWidth - fabRight)}px`;
    const roomAbove = host.offsetTop > 340; // panel is ~300px tall
    panel.style.bottom = roomAbove ? `${window.innerHeight - host.offsetTop + 10}px` : '10px';
  }
  function setOpen(next, { focusFab = true } = {}) {
    open = next;
    fab.setAttribute('aria-expanded', String(open));
    if (open) {
      panel.classList.add('open');
      placePanel(); load(); loadTexts(); startPoll();
      // keyboard users land IN the tray (Escape returns focus to the FAB); the
      // panel is programmatically focusable, so it takes no focus ring of its own
      panel.focus({ preventScroll: true });
      // trigger the CSS transition on the next frame
      requestAnimationFrame(() => panel.classList.add('visible'));
    }
    else {
      // .open is display:block — dropping it in the same frame would snap the
      // panel away instead of fading. Remove .visible, let the .18s transition
      // run, then drop .open (a fast re-open cancels via the !open guard).
      panel.classList.remove('visible');
      setTimeout(() => { if (!open) panel.classList.remove('open'); }, 180);
      stopPoll();
      // keyboard users land back on the toggle — but an outside CLICK already
      // moved focus to whatever was clicked; stealing it back would be rude
      if (focusFab) fab.focus();
    }
  }

  fab.addEventListener('click', () => {
    if (suppressFabClick) return; // end of a drag, not a real click
    setOpen(!open);
  });

  // click anywhere outside the tray closes it (Escape still works too).
  // composedPath: the shadow root is closed, so detect "inside the host" that way.
  document.addEventListener('pointerdown', e => {
    if (!open) return;
    if (e.composedPath().includes(host)) return;
    setOpen(false, { focusFab: false }); // same state path as Escape — aria, class, poll stop
  }, true);

  // ---------- text sync in the tray ----------
  // ONE row count for BOTH transports. The SW relay asked the server for 10 and
  // the direct fallback asked for 5, so the same list silently showed a different
  // number of rows depending on which one happened to answer — invisible drift of
  // exactly the kind the shared discovery/files modules exist to prevent (the
  // server caps at 20). The content script owns the number and passes it along.
  const TEXTS_LIMIT = 10;
  async function fetchTexts() {
    try { return await bg({ type: 'texts', limit: TEXTS_LIMIT }); } catch {}
    for (const base of directBases()) {
      try {
        const r = await fetch(`${base}/api/text?source=phone&limit=${TEXTS_LIMIT}`, { signal: AbortSignal.timeout(JSON_TIMEOUT_MS) });
        if (r.ok) return await r.json();
      } catch {}
    }
    throw new Error('unreachable');
  }

  // `quiet` = the poll's refresh (load() fires it whenever the newest text id
  // moves). A quiet pass never flashes the placeholder and never rebuilds an
  // identical list — that would throw away the user's scroll position every 5s.
  let textsKey = null; // `${id}:${body}` of every row — "did anything change?"
  let textsSeq = 0;    // newest load wins: opening the tray fires a LOUD load while
                       // the poll (load() → the textId hook) fires a quiet one, and
                       // if the quiet pass landed first the loud one would find the
                       // key already written and leave "…" on screen for good
  async function loadTexts({ quiet = false } = {}) {
    const seq = ++textsSeq;
    if (!quiet) { txtList.innerHTML = '<div class="txtnone">…</div>'; textsKey = null; }
    try {
      const texts = await fetchTexts();
      if (seq !== textsSeq) return; // superseded by a newer load
      const key = texts.map(t => `${t.id}:${t.body}`).join('\n');
      if (textsKey === key) return; // poll tick with no news — leave the DOM alone
      textsKey = key;
      txtList.innerHTML = '';
      if (!texts.length) { txtList.innerHTML = '<div class="txtnone">no texts from the phone yet</div>'; return; }
      for (const t of texts) {
        const d = document.createElement('div');
        d.className = 'txtitem';
        d.textContent = t.body;
        d.title = 'Click to copy';
        d.onclick = async () => {
          try {
            await navigator.clipboard.writeText(t.body);
            setStatus(`copied text #${t.id} — Ctrl+V anywhere`);
          } catch { setStatus('copy blocked — select the text on the page instead', true); }
        };
        txtList.appendChild(d);
      }
    } catch {
      // A transient failure must not paint an error over rows the user is
      // reading (and the 5s poll would repaint it every tick). Only a tray with
      // nothing rendered yet reports the server as unreachable.
      if (textsKey !== null) return;
      txtList.innerHTML = '<div class="txtnone">server not reachable</div>';
    }
  }

  async function sendText() {
    const body = txtInput.value.trim();
    if (!body) return;
    txtSend.disabled = true;
    try {
      try { await bg({ type: 'sendText', body }); }
      catch {
        let ok = false;
        for (const base of directBases()) {
          try {
            const r = await fetch(`${base}/api/text`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ body, source: 'pc' }),
              signal: AbortSignal.timeout(5000),
            });
            if (r.ok) { ok = true; break; }
          } catch {}
        }
        if (!ok) throw new Error('unreachable');
      }
      txtInput.value = '';
      setStatus('text sent to phone ✓');
      loadTexts({ quiet: true });
    } catch {
      setStatus('text not sent — server not reachable', true);
    } finally {
      txtSend.disabled = false;
    }
  }
  txtSend.addEventListener('click', sendText);
  txtInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
  });

  // NOTE: no JS selectstart/dragstart suppression here — canceling selectstart
  // also aborts Chrome's drag initiation on draggable elements (v0.3.5 bug).
  // Text selection is already impossible via user-select:none CSS, and cell
  // dragstart is never canceled, so the selection fallback can't happen.
  refreshBtn.addEventListener('click', load);
  syncBtn.addEventListener('click', () => {
    goodHostReset();              // let the worker re-probe both hosts
    load();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && open) setOpen(false);
  });

  // keep the FAB reachable across resizes; honor a user-dragged position
  function position() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null'); } catch {}
    if (saved && saved.l && saved.t) {
      host.style.left = saved.l;
      host.style.top = saved.t;
      return;
    }
    host.style.left = `${Math.max(10, window.innerWidth - 48)}px`;
    host.style.top = `${Math.max(10, window.innerHeight - 48)}px`;
  }
  window.addEventListener('resize', () => {
    position();
    if (open) placePanel(); // keep the tray anchored to the FAB
  });
  position();

  // applied last, once every listener and the poll helpers exist:
  // per-site hide (right-click on the FAB) and the global flag from the toolbar
  updateFabVisibility();

  // poll lifecycle: started when the tray opens, stopped when it closes —
  // no timer at all while the tray is closed (the open-state guard in the
  // tick is no longer needed; load() only runs while open by construction)
  let pollTimer = null;
  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  }
  function stopPoll() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }
})();
