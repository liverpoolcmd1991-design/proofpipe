// ProofPipe extension — Liquid Glass Shadow-DOM tray markup, styles, and toast.
// Loaded BEFORE content.js (see manifest.json). Keeps presentation separate
// from transport, clipboard, drag-and-drop, and auto-paste logic.
const PPTrayUI = (() => {
  const CSS = `
      /* the tray is a Liquid Glass island inside a page we do not control:
         declaring the color scheme keeps its native textarea chrome dark */
      :host { all: initial; color-scheme: dark; user-select: none; -webkit-user-select: none; }
      * {
        box-sizing: border-box;
        font-family: -apple-system, "SF Pro Text", system-ui, sans-serif;
        letter-spacing: -0.01em;
        margin: 0; padding: 0;
        user-select: none; -webkit-user-select: none;
        -webkit-font-smoothing: antialiased;
      }
      /* The tile's image IS the drag source (see content.js): Blink attaches
         a dragged <img>'s own bytes to the drag, which is the only shape a drop
         in the same document can read. auto is the <img> default; declared here
         because this one property is load-bearing — none on the image silently
         turns every tray drag into an empty one. */
      .cell .thumb { -webkit-user-drag: auto; }

      /* --- floating action button (FAB) --- */
      .fab {
        width: 38px; height: 38px; border-radius: 50%;
        background: radial-gradient(circle at 30% 25%, rgba(56, 88, 168, 0.42), rgba(14, 20, 38, 0.88));
        color: #f5f7ff;
        border: 1px solid rgba(255, 255, 255, 0.22);
        -webkit-backdrop-filter: saturate(200%) blur(24px);
        backdrop-filter: saturate(200%) blur(24px);
        font-size: 16px; font-weight: 700; cursor: pointer;
        box-shadow: 0 8px 24px rgba(0,0,0,.48), inset 0 1px 0 rgba(255,255,255,.28), 0 0 0 0 rgba(10,132,255,0);
        display: grid; place-items: center; user-select: none;
        transition: border-color .18s, box-shadow .18s, transform .12s;
      }
      .fab:hover {
        border-color: rgba(100, 210, 255, 0.48);
        box-shadow: 0 10px 28px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.34), 0 0 0 3px rgba(10, 132, 255, .18);
      }
      .fab:active { transform: scale(.93); }

      /* --- main Liquid Glass panel --- */
      .panel {
        position: fixed; bottom: 64px; right: 14px; width: 296px;
        max-height: calc(100vh - 20px); overflow-y: auto;
        background-color: rgba(12, 18, 34, 0.88);
        background-image:
          radial-gradient(ellipse 95% 55% at 15% -10%, rgba(10, 132, 255, 0.2), transparent 65%),
          radial-gradient(ellipse 85% 50% at 88% 105%, rgba(48, 209, 88, 0.14), transparent 65%);
        -webkit-backdrop-filter: saturate(210%) blur(32px);
        backdrop-filter: saturate(210%) blur(32px);
        color: #f5f7ff; border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 18px;
        box-shadow: 0 20px 54px rgba(0,0,0,.62), inset 0 1px 0 rgba(255,255,255,.2);
        padding: 12px; display: none;
        opacity: 0; transform: scale(.96); transform-origin: bottom right;
        transition: opacity .18s ease, transform .18s cubic-bezier(.22, 1, .36, 1);
      }
      .panel.open { display: block; }
      .panel.open.visible { opacity: 1; transform: scale(1); }

      /* --- header --- */
      .head { display: flex; align-items: center; justify-content: space-between; padding: 0 4px 8px; }
      .head b { font-size: 13.5px; font-weight: 700; letter-spacing: -.01em; }
      .head-actions { display: flex; gap: 5px; align-items: center; }
      .icon-btn {
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.14); color: #98a2b8;
        border-radius: 999px; font-size: 11px; font-weight: 600; padding: 4px 10px; cursor: pointer;
        display: inline-flex; align-items: center; gap: 4px; line-height: 1;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
        transition: color .15s, border-color .15s, background .15s, transform .08s;
      }
      .icon-btn:hover { color: #f5f7ff; border-color: rgba(255, 255, 255, 0.28); background: rgba(255,255,255,.12); }
      .icon-btn svg { width: 12px; height: 12px; flex: none; }

      /* --- live target indicator & search filter --- */
      .target-pill {
        font-size: 10.5px; color: #98a2b8; background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 999px;
        padding: 3px 9px; margin-bottom: 7px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .target-pill strong { color: #7dd3fc; font-weight: 650; }
      .tray-search-row { margin-bottom: 7px; }
      .tray-search {
        width: 100%; background: rgba(6, 9, 19, 0.68); border: 1px solid rgba(255, 255, 255, 0.14);
        color: #f5f7ff; border-radius: 999px; padding: 5px 10px; font-size: 11.5px; outline: none;
        user-select: text; -webkit-user-select: text;
        transition: border-color .15s, background .15s;
      }
      .tray-search:focus { border-color: rgba(100, 210, 255, 0.5); background: rgba(6, 9, 19, 0.84); }
      .tray-search::placeholder { color: #64708a; }

      /* --- capture grid --- */
      .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; max-height: 224px; overflow-y: auto; }
      .grid::-webkit-scrollbar { width: 5px; }
      .grid::-webkit-scrollbar-track { background: transparent; }
      .grid::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.16); border-radius: 3px; }
      .grid::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.28); }

      .cell {
        position: relative; border-radius: 10px; overflow: hidden; cursor: grab;
        border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(24, 32, 54, 0.68);
        box-shadow: 0 4px 12px rgba(0,0,0,.28), inset 0 1px 0 rgba(255,255,255,.14);
        -webkit-user-drag: element; user-select: none; -webkit-user-select: none;
        transition: border-color .15s, box-shadow .15s;
      }
      .cell:hover { border-color: rgba(100, 210, 255, 0.45); box-shadow: 0 0 0 2px rgba(10, 132, 255, .2); }
      .cell:active { cursor: grabbing; }
      .cell .thumb { width: 100%; height: 72px; object-fit: cover; display: block; transition: transform .2s; }
      .cell:hover .thumb { transform: scale(1.04); }
      .cell .id {
        pointer-events: none;
        position: absolute; bottom: 4px; left: 4px; font-size: 9px; font-weight: 650; color: #f5f7ff;
        background: rgba(6, 9, 19, .86); border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 999px; padding: 0 5px; line-height: 14px;
      }
      .cell-origin {
        pointer-events: none; position: absolute; top: 4px; left: 4px;
        font-size: 8.5px; font-weight: 700; line-height: 13px; padding: 0 5px; border-radius: 999px;
      }
      .cell-origin.phone { background: rgba(14, 38, 22, 0.78); color: #5ee987; border: 1px solid rgba(48, 209, 88, 0.4); }
      .cell-origin.pc { background: rgba(14, 28, 52, 0.8); color: #7dd3fc; border: 1px solid rgba(96, 165, 250, 0.42); }
      .cell-paste {
        position: absolute; top: 4px; right: 4px;
        background: rgba(10, 18, 36, 0.84); color: #f5f7ff;
        border: 1px solid rgba(100, 210, 255, 0.42); border-radius: 999px;
        font-size: 9px; font-weight: 700; line-height: 14px; padding: 0 6px; cursor: pointer;
        opacity: 0; transition: opacity .15s, background .15s, border-color .15s;
      }
      .cell:hover .cell-paste, .cell:focus-within .cell-paste { opacity: 1; }
      .cell-paste:hover { background: rgba(10, 132, 255, 0.48); border-color: rgba(125, 211, 252, 0.85); }

      /* --- status & empty --- */
      .status { font-size: 11px; font-weight: 600; color: #98a2b8; padding: 8px 4px 2px; text-align: center; transition: color .15s; min-height: 16px; }
      .status.err { color: #ff453a; }
      .empty {
        font-size: 12px; color: #98a2b8; text-align: center; padding: 14px 8px; grid-column: 1 / -1; line-height: 1.5;
        background: rgba(20, 26, 42, 0.45); border: 1px dashed rgba(255, 255, 255, 0.16); border-radius: 12px;
      }
      .recovery-actions { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; margin-top: 8px; }
      .recovery-btn {
        background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18);
        color: #f5f7ff; border-radius: 999px; font-size: 10.5px; font-weight: 600;
        padding: 4px 10px; cursor: pointer;
        transition: border-color .15s, background .15s;
      }
      .recovery-btn:hover { border-color: rgba(100, 210, 255, 0.55); background: rgba(10, 132, 255, 0.2); }

      /* --- text section --- */
      .textsec { border-top: 1px solid rgba(255, 255, 255, 0.12); margin-top: 8px; padding-top: 8px; }
      .txthead { font-size: 11px; color: #98a2b8; padding: 0 4px 6px; display: flex; justify-content: space-between; align-items: center; }
      .txthead b { color: #f5f7ff; font-weight: 650; }
      .txtrow { display: flex; gap: 6px; }
      .txt {
        flex: 1; min-width: 0; resize: none; height: 34px;
        background: rgba(6, 9, 19, 0.64); border: 1px solid rgba(255, 255, 255, 0.14); color: #f5f7ff;
        border-radius: 10px; padding: 6px 9px; font-size: 12px; outline: none;
        user-select: text; -webkit-user-select: text;
        transition: border-color .15s, background .15s;
      }
      .txt:focus { border-color: rgba(100, 210, 255, 0.5); background: rgba(6, 9, 19, 0.78); }
      .txt::placeholder { color: #64708a; }
      .txtsend {
        flex: none; width: 42px; border: 1px solid rgba(48, 209, 88, 0.35); border-radius: 10px;
        background: rgba(48, 209, 88, 0.14); color: #30d158; font-size: 12px; cursor: pointer;
        display: grid; place-items: center;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
        transition: border-color .15s, background .15s, transform .08s;
      }
      .txtsend:hover { border-color: rgba(48, 209, 88, 0.65); background: rgba(48, 209, 88, 0.24); }
      .txtitem {
        display: flex; align-items: center; gap: 6px;
        font-size: 11.5px; color: #f5f7ff; background: rgba(24, 32, 54, 0.64);
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
        border-radius: 9px; padding: 5px 9px; margin-top: 5px; cursor: pointer;
        user-select: text; -webkit-user-select: text;
        transition: border-color .15s, background .15s;
      }
      .txtitem:hover { border-color: rgba(255, 255, 255, 0.26); background: rgba(34, 44, 72, 0.72); }
      .txtitem-body { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .txt-origin {
        flex: none; font-size: 8.5px; font-weight: 700; line-height: 13px; padding: 0 5px; border-radius: 999px;
      }
      .txt-origin.phone { background: rgba(48, 209, 88, 0.16); color: #5ee987; border: 1px solid rgba(48, 209, 88, 0.34); }
      .txt-origin.pc { background: rgba(96, 165, 250, 0.16); color: #7dd3fc; border: 1px solid rgba(96, 165, 250, 0.36); }
      .txtnone { font-size: 11px; color: #64708a; padding: 6px 4px 2px; text-align: center; }

      /* ---------- UX polish ---------- */
      .fab:focus-visible, .icon-btn:focus-visible, .txtsend:focus-visible,
      .cell:focus-visible, .txtitem:focus-visible, .txt:focus-visible {
        outline: 2px solid #30d158; outline-offset: 2px;
      }
      .icon-btn:active, .txtsend:active { transform: scale(.94); }
      .cell { outline-offset: 0; }

      /* ---------- Liquid Glass Pointer Caustics & Tactile Animations ---------- */
      .panel::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        pointer-events: none;
        z-index: 0;
        opacity: var(--tray-ptr-on, 0);
        background: radial-gradient(
          210px circle at var(--px, 50%) var(--py, 50%),
          rgba(130, 216, 255, 0.14) 0%,
          rgba(10, 132, 255, 0.055) 44%,
          transparent 74%
        );
        transition: opacity 0.2s ease;
      }
      .panel > * { position: relative; z-index: 1; }
      .icon-btn, .txtsend, .txtitem, .recovery-btn { position: relative; overflow: hidden; }
      .pp-tray-ripple {
        position: absolute; border-radius: 50%; pointer-events: none; z-index: 3;
        border: 1px solid rgba(180, 236, 255, 0.65);
        background: radial-gradient(circle, rgba(255,255,255,0.34) 0%, rgba(100,210,255,0.18) 45%, transparent 76%);
        transform: scale(0); opacity: 0.85;
        animation: ppTrayRipple 0.48s cubic-bezier(0.18, 0.88, 0.3, 1) forwards;
      }
      @keyframes ppTrayRipple {
        0% { transform: scale(0); opacity: 0.85; }
        100% { transform: scale(1); opacity: 0; }
      }
      .txtsend.is-sending svg { animation: ppTraySend 0.45s cubic-bezier(0.2, 0.9, 0.25, 1); }
      @keyframes ppTraySend {
        0% { transform: translate3d(0, 0, 0) scale(1); opacity: 1; }
        38% { transform: translate3d(9px, -5px, 0) scale(0.75); opacity: 0; }
        45% { transform: translate3d(-8px, 4px, 0) scale(0.75); opacity: 0; }
        100% { transform: translate3d(0, 0, 0) scale(1); opacity: 1; }
      }
      .icon-btn.sync.is-spinning svg,
      .icon-btn.reload.is-spinning svg {
        animation: ppTraySpin 0.42s cubic-bezier(0.2, 0.9, 0.25, 1);
      }
      @keyframes ppTraySpin {
        to { transform: rotate(360deg); }
      }
      .txtitem.copied {
        border-color: rgba(48, 209, 88, 0.65);
        background: rgba(48, 209, 88, 0.16);
        animation: ppTrayPop 0.28s cubic-bezier(0.2, 0.9, 0.25, 1);
      }
      @keyframes ppTrayPop { 50% { transform: scale(1.025); } }
      @media (prefers-reduced-motion: reduce) {
        .panel::before, .pp-tray-ripple { display: none !important; }
        *, *::before, *::after { animation: none !important; transition: none !important; }
      }
  `;

  const HTML = `
    <style>${CSS}</style>
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
      <div class="target-pill" title="Active auto-paste target on this page">Target: <strong>detecting…</strong></div>
      <div class="tray-search-row">
        <input type="search" class="tray-search" placeholder="Filter captures &amp; texts…" aria-label="Filter captures and texts">
      </div>
      <div class="grid"></div>
      <div class="textsec">
        <div class="txthead"><b>Text</b><span>type → phone · tap text = copy</span></div>
        <div class="txtrow">
          <textarea class="txt" placeholder="type text to send to your phone…"></textarea>
          <button class="txtsend" title="Send text to phone" aria-label="Send text to phone"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12 16-8-5.5 8 5.5 8-16-8Z"/></svg></button>
        </div>
        <div class="txtlist"></div>
      </div>
      <div class="status" role="status" aria-live="polite"></div>
    </div>
  `;

  function mount(doc) {
    const host = doc.createElement('div');
    host.id = 'proofpipe-tray-host';
    host.style.cssText = 'all:initial; position:fixed; z-index:2147483647;';
    doc.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = HTML;
    return {
      host,
      root,
      els: {
        fab: root.querySelector('.fab'),
        panel: root.querySelector('.panel'),
        grid: root.querySelector('.grid'),
        status: root.querySelector('.status'),
        refreshBtn: root.querySelector('.icon-btn.reload'),
        syncBtn: root.querySelector('.icon-btn.sync'),
        txtInput: root.querySelector('.txt'),
        txtSend: root.querySelector('.txtsend'),
        txtList: root.querySelector('.txtlist'),
        searchInput: root.querySelector('.tray-search'),
        targetPill: root.querySelector('.target-pill'),
      },
    };
  }

  function ensureToastDock(doc) {
    let dock = doc.getElementById('proofpipe-toast-dock');
    if (dock) return dock;
    dock = doc.createElement('div');
    dock.id = 'proofpipe-toast-dock';
    dock.style.cssText = [
      'all:initial',
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
      'display:flex', 'flex-direction:column', 'align-items:flex-end', 'gap:8px',
      'max-width:min(340px, calc(100vw - 24px))',
      'pointer-events:none',
    ].join(';');
    doc.documentElement.appendChild(dock);
    return dock;
  }

  function toast(text, isErr = false) {
    const doc = document;
    const dock = ensureToastDock(doc);
    while (dock.childElementCount >= 3) dock.firstElementChild.remove();

    const toneBorder = isErr
      ? 'rgba(255, 69, 58, 0.56)'
      : 'rgba(48, 209, 88, 0.44)';
    const toneGlow = isErr
      ? 'rgba(255, 69, 58, 0.18)'
      : 'rgba(48, 209, 88, 0.12)';
    const baseBg = isErr
      ? 'linear-gradient(155deg, rgba(64, 20, 28, 0.82) 0%, rgba(18, 12, 20, 0.88) 100%)'
      : 'linear-gradient(155deg, rgba(30, 42, 74, 0.78) 0%, rgba(12, 16, 28, 0.88) 100%)';

    const d = doc.createElement('div');
    d.setAttribute('role', isErr ? 'alert' : 'status');
    d.setAttribute('aria-live', isErr ? 'assertive' : 'polite');
    d.textContent = text;
    d.style.cssText = [
      'all:initial',
      'box-sizing:border-box',
      'display:block',
      'max-width:100%',
      'pointer-events:auto',
      'touch-action:none',
      'user-select:none',
      '-webkit-user-select:none',
      'cursor:grab',
      `background:${baseBg}`,
      '-webkit-backdrop-filter:saturate(220%) blur(34px)',
      'backdrop-filter:saturate(220%) blur(34px)',
      'color:#f5f7ff',
      `border:1px solid ${toneBorder}`,
      'border-radius:16px',
      'padding:10px 15px',
      'font-family:-apple-system,"SF Pro Text",system-ui,sans-serif',
      'font-size:12.5px',
      'font-weight:600',
      'line-height:1.38',
      'letter-spacing:-0.01em',
      'overflow-wrap:anywhere',
      `box-shadow:0 16px 40px rgba(0,0,0,.52), 0 0 0 1px ${toneGlow}, inset 0 1px 0 rgba(255,255,255,.32)`,
      'opacity:0',
      'transform:translate3d(0, 10px, 0) scale(0.96)',
      'transition:transform .2s cubic-bezier(.22, 1, .36, 1), opacity .2s ease',
    ].join(';');

    dock.appendChild(d);
    requestAnimationFrame(() => {
      d.style.opacity = '1';
      d.style.transform = 'translate3d(0, 0, 0) scale(1)';
    });

    let hideTimer = 0;
    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      clearTimeout(hideTimer);
      d.style.transition = 'transform .18s ease, opacity .18s ease';
      d.style.opacity = '0';
      setTimeout(() => {
        d.remove();
        if (dock.childElementCount === 0) dock.remove();
      }, 200);
    };
    const schedule = (ms = isErr ? 3600 : 2600) => {
      clearTimeout(hideTimer);
      if (!gone) hideTimer = setTimeout(dismiss, ms);
    };
    schedule();

    let drag = null;
    d.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      clearTimeout(hideTimer);
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), dx: 0, dy: 0, moved: false };
      d.style.transition = 'none';
      d.style.cursor = 'grabbing';
      try { d.setPointerCapture(e.pointerId); } catch {}
    });
    d.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x0;
      const dy = Math.max(-16, e.clientY - drag.y0);
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      drag.dx = dx;
      drag.dy = dy;
      const dist = Math.hypot(dx, Math.max(0, dy));
      d.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
      d.style.opacity = String(Math.max(0.18, 1 - dist / 140));
    });
    const finish = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dr = drag;
      drag = null;
      d.style.cursor = 'grab';
      try { d.releasePointerCapture(e.pointerId); } catch {}
      const dt = Math.max(1, performance.now() - dr.t0);
      const vx = dr.dx / dt;
      const vy = dr.dy / dt;
      const commit = dr.moved && (
        Math.abs(dr.dx) > 52 || dr.dy > 40 || (Math.abs(vx) > 0.4 && Math.abs(dr.dx) > 16) || (vy > 0.4 && dr.dy > 16)
      );
      if (commit) {
        const tx = Math.abs(dr.dx) >= Math.abs(dr.dy) ? (dr.dx >= 0 ? 160 : -160) : dr.dx * 1.4;
        const ty = dr.dy > 18 ? Math.max(48, dr.dy * 1.8) : dr.dy;
        d.style.transition = 'transform .16s ease, opacity .16s ease';
        d.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0)`;
        dismiss();
      } else {
        d.style.transition = 'transform .2s cubic-bezier(.22, 1, .36, 1), opacity .2s ease';
        d.style.transform = 'translate3d(0, 0, 0) scale(1)';
        d.style.opacity = '1';
        schedule(1800);
      }
    };
    d.addEventListener('pointerup', finish);
    d.addEventListener('pointercancel', finish);
    d.addEventListener('mouseenter', () => { if (!drag) clearTimeout(hideTimer); });
    d.addEventListener('mouseleave', () => { if (!drag && !gone) schedule(1600); });
  }

  return { mount, toast };
})();
if (typeof self !== 'undefined') self.PPTrayUI = PPTrayUI;
