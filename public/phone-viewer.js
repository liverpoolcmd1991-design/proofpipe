// Fullscreen capture viewer for ProofPipe Phone PWA: pinch/double-tap/wheel zoom,
// 90-degree rotation with viewport auto-fit and save, two-layer swipe + keyboard nav,
// swipe-down dismiss, inline remote loading/error recovery, download, retry/discard, and delete.
const PPPhoneViewer = (() => {
  function create({
    $, SERVER, flash, phoneConfirm, trapPhone, untrapPhone, syncOverlayHistory, confirmOpen,
    getRecentItems, outboxDelete, outboxUpdateBlob, regenerateTileUrl,
    retryItem, recentEmptyUI, revokeObjectUrl,
    pcMediaItems, markDeadPcMedia, reloadTexts,
  }) {
    let viewerBlob = null;
    let activeItem = null;
    let viewerRetryFn = null;
    let viewerDiscardFn = null;
    let viewerReturnFocus = null;
    let viewerIdx = -1;
    let viewerItems = null;
    let viewerZoom = { scale: 1, tx: 0, ty: 0 };
    let viewerRot = 0; // degrees, reset per item — the harness lightbox behaves the same
    let swipeHintShown = false;
    let remoteLoadGen = 0;
    let remoteFetchCtrl = null;
    let tapChromeTimer = 0;
    let dismissDragActive = false;
    let stageRect = null;
    const MAX_VIEWER_BLOBS = 4;
    const remoteBlobLru = [];

    const viewerEl = $('#viewer');
    const viewerImg = $('#viewer-img');
    const viewerUnder = $('#viewer-under');
    const viewerStage = $('#viewer-stage');
    const activeViewerItems = () => viewerItems || getRecentItems();

    function invalidateStageRect() { stageRect = null; }
    function getStageRect() {
      if (!stageRect) stageRect = viewerStage.getBoundingClientRect();
      return stageRect;
    }

    function releaseRemoteItemBlob(it) {
      if (!it || !it.remote) return;
      if (it.fullUrl && it.fullUrl !== it.thumbUrl && it.fullUrl !== it.url) {
        revokeObjectUrl(it.fullUrl);
      }
      it.fullUrl = null;
      it.blob = null;
      const i = remoteBlobLru.indexOf(it);
      if (i >= 0) remoteBlobLru.splice(i, 1);
    }

    function touchRemoteBlobLru(it) {
      if (!it || !it.remote || !it.blob) return;
      const idx = remoteBlobLru.indexOf(it);
      if (idx >= 0) remoteBlobLru.splice(idx, 1);
      remoteBlobLru.push(it);
      while (remoteBlobLru.length > MAX_VIEWER_BLOBS) {
        const victimIdx = remoteBlobLru.findIndex(x => x !== activeItem);
        if (victimIdx < 0) break;
        const [victim] = remoteBlobLru.splice(victimIdx, 1);
        if (victim) releaseRemoteItemBlob(victim);
      }
    }

    function getFitMetrics() {
      const r = getStageRect();
      const sw = r.width || 1;
      const sh = r.height || 1;
      const nw = viewerImg.naturalWidth || 0;
      const nh = viewerImg.naturalHeight || 0;
      let dispW = sw;
      let dispH = sh;
      if (nw > 0 && nh > 0) {
        const ir = nw / nh;
        const sr = sw / sh;
        if (ir > sr) { dispW = sw; dispH = sw / ir; }
        else { dispW = sh * ir; dispH = sh; }
      }
      const rotSwap = ((viewerRot % 180) + 180) % 180 === 90;
      const fitScale = rotSwap ? Math.min(1, sw / dispH, sh / dispW) : 1;
      return { r, sw, sh, nw, nh, dispW, dispH, fitScale };
    }

    function syncRotFitScale(extraScale = 1) {
      const { fitScale } = getFitMetrics();
      const combined = fitScale * extraScale;
      viewerImg.style.scale = Math.abs(combined - 1) < 0.001 ? '' : String(combined);
    }

    function syncZoomBtn() {
      const btn = $('#viewer-zoom-btn');
      if (!btn) return;
      const zoomed = viewerZoom.scale > 1.05;
      btn.classList.toggle('hidden', !zoomed);
      if (zoomed) {
        btn.textContent = `${viewerZoom.scale.toFixed(1).replace(/\.0$/, '')}×`;
        btn.setAttribute('aria-label', `Zoom ${btn.textContent}, tap to reset`);
      }
    }

    function applyViewerZoom() {
      // scale and rotate commute for a uniform scale, so the rotation can ride here
      // without disturbing any of the gesture math
      viewerImg.style.transform = `translate(${viewerZoom.tx}px, ${viewerZoom.ty}px) scale(${viewerZoom.scale}) rotate(${viewerRot}deg)`;
      syncZoomBtn();
    }

    // keep the zoomed image on-screen: the pan can never push the painted image box
    // past the stage edges (at scale 1 this recenters — the clamp range is 0).
    // Rotation extends the reachable range: rotating the box swaps/extends its AABB.
    function clampViewerPan() {
      const { sw, sh, dispW, dispH, fitScale } = getFitMetrics();
      const rad = viewerRot * Math.PI / 180;
      const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
      const baseW = dispW * fitScale * cos + dispH * fitScale * sin;
      const baseH = dispW * fitScale * sin + dispH * fitScale * cos;
      const mx = Math.max(0, (baseW * viewerZoom.scale - sw) / 2);
      const my = Math.max(0, (baseH * viewerZoom.scale - sh) / 2);
      viewerZoom.tx = Math.min(mx, Math.max(-mx, viewerZoom.tx));
      viewerZoom.ty = Math.min(my, Math.max(-my, viewerZoom.ty));
    }

    // rotate one quarter-turn per press — a sideways photo had to be sent to the PC
    // to be straightened, on the device that took it
    function rotateViewer() {
      viewerRot = (viewerRot + 90) % 360;
      syncRotFitScale();
      clampViewerPan();
      applyViewerZoom();
      syncSaveRotUI();
      updateViewerMeta();
    }

    let savingRot = false;
    function canPersistViewerRot(item) {
      if (!item) return false;
      if (item.sent && item.id != null) return true;
      if (item.blob && !(item.blob.type && /^image\/(tiff|hei[cf])$/i.test(item.blob.type))) return true;
      return false;
    }
    function syncSaveRotUI() {
      const btn = $('#viewer-save-rot');
      if (!btn) return;
      const item = activeViewerItems()[viewerIdx];
      const show = (viewerRot % 360) !== 0 && canPersistViewerRot(item);
      btn.classList.toggle('hidden', !show);
      btn.disabled = savingRot;
    }

    function hideViewerUnder() {
      viewerUnder.style.display = 'none';
      viewerUnder.dataset.src = '';
    }

    function itemPreviewSrc(item) {
      if (!item) return '';
      return item.fullUrl || item.url || item.thumbUrl || item.tileUrl || '';
    }

    function showViewerUnder(item, offset) {
      const src = itemPreviewSrc(item);
      if (!src) { hideViewerUnder(); return; }
      if (viewerUnder.dataset.src !== src) {
        viewerUnder.dataset.src = src;
        viewerUnder.src = src;
      }
      viewerUnder.style.display = 'block';
      viewerUnder.classList.add('gesturing');
      viewerUnder.style.transform = `translate(${offset}px, 0)`;
    }

    function updateViewerPos() {
      const list = activeViewerItems();
      const posEl = $('#viewer-pos');
      if (posEl) posEl.textContent = list.length ? `${viewerIdx + 1} / ${list.length}` : '';
      const prevBtn = $('#viewer-prev');
      const nextBtn = $('#viewer-next');
      const showNav = list.length > 1 && viewerZoom.scale <= 1.05;
      if (prevBtn) {
        prevBtn.classList.toggle('hidden', !showNav || viewerIdx <= 0);
        prevBtn.disabled = viewerIdx <= 0;
      }
      if (nextBtn) {
        nextBtn.classList.toggle('hidden', !showNav || viewerIdx < 0 || viewerIdx >= list.length - 1);
        nextBtn.disabled = viewerIdx < 0 || viewerIdx >= list.length - 1;
      }
    }

    function updateViewerMeta(item = activeItem) {
      const el = $('#viewer-meta');
      if (!el) return;
      if (!item) { el.textContent = ''; return; }
      const parts = [];
      const nw = viewerImg.naturalWidth || 0;
      const nh = viewerImg.naturalHeight || 0;
      if (nw > 0 && nh > 0) {
        const swap = ((viewerRot % 180) + 180) % 180 === 90;
        parts.push(`${swap ? nh : nw}×${swap ? nw : nh}`);
      }
      if (!item.sent) parts.push('Queued');
      if (item.createdAt) {
        const d = new Date(item.createdAt);
        if (!Number.isNaN(d.getTime())) {
          parts.push(d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
        }
      }
      el.textContent = parts.join(' · ');
    }

    function setViewerLoading(on) {
      $('#viewer-loader')?.classList.toggle('hidden', !on);
    }

    function setViewerError(on, msg = 'Could not load full-resolution capture', retryFn = null) {
      const box = $('#viewer-error');
      if (!box) return;
      box.classList.toggle('hidden', !on);
      const msgEl = $('#viewer-error-msg');
      if (msgEl && msg) msgEl.textContent = msg;
      const retryBtn = $('#viewer-error-retry');
      if (retryBtn) retryBtn.onclick = retryFn ? e => { e.stopPropagation(); retryFn(); } : null;
    }

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

    function viewerZoomTo(scale, cx, cy) {
      const r = getStageRect();
      const targetX = cx != null ? cx - r.left : r.width / 2;
      const targetY = cy != null ? cy - r.top : r.height / 2;
      // Coordinates around stage center because transform-origin on #viewer-img is 50% 50%
      const ox = targetX - r.width / 2;
      const oy = targetY - r.height / 2;
      const nextScale = Math.min(6, Math.max(1, scale));
      if (nextScale <= 1.01) {
        viewerZoom.scale = 1;
        viewerZoom.tx = 0;
        viewerZoom.ty = 0;
      } else {
        const ratio = nextScale / viewerZoom.scale;
        viewerZoom.tx = ox - ratio * (ox - viewerZoom.tx);
        viewerZoom.ty = oy - ratio * (oy - viewerZoom.ty);
        viewerZoom.scale = nextScale;
      }
      clampViewerPan();
      applyViewerZoom();
      updateViewerPos();
    }

    function prefetchNeighbors(list, idx) {
      for (const offset of [-1, 1]) {
        const n = list[idx + offset];
        if (!n) continue;
        const src = n.thumbUrl || n.url || n.tileUrl;
        if (src && !n._prefetched) {
          n._prefetched = true;
          const img = new Image();
          img.decoding = 'async';
          img.src = src;
        }
      }
    }

    function resetViewerBackdrop() {
      viewerEl.style.removeProperty('--viewer-bg-alpha');
    }

    function setViewerChromeHidden(hidden) {
      viewerEl.classList.toggle('chrome-hidden', !!hidden);
    }

    // shared display path for local tiles and PC-sent captures alike
    function showViewer(item, { loading = false } = {}) {
      activeItem = item;
      viewerBlob = item.blob || null;
      viewerZoom = { scale: 1, tx: 0, ty: 0 };
      viewerRot = 0; // fresh image, fresh orientation
      resetViewerBackdrop();
      setViewerChromeHidden(false);
      updateViewerPos();
      hideViewerUnder(); // fresh open: never leave a stale neighbor slide layer
      setViewerLoading(loading);
      setViewerError(false);

      const vo = $('#viewer-origin');
      if (vo) vo.classList.toggle('hidden', !item.fromPc);
      if (!item.fullUrl && item.blob) item.fullUrl = URL.createObjectURL(item.blob);
      const src = loading ? (item.thumbUrl || item.url || item.tileUrl || '') : (item.fullUrl || item.url || item.thumbUrl || item.tileUrl || '');
      if (viewerImg.getAttribute('src') !== src) viewerImg.src = src;

      syncRotFitScale();
      applyViewerZoom();
      syncSaveRotUI();
      updateViewerMeta(item);

      const wasHidden = viewerEl.classList.contains('hidden');
      viewerEl.classList.remove('hidden');
      invalidateStageRect();
      if (wasHidden) {
        viewerReturnFocus = document.activeElement;
        trapPhone(viewerEl, $('#viewer-close'));
      }
      syncOverlayHistory();
      maybeShowSwipeHint();
      prefetchNeighbors(activeViewerItems(), viewerIdx);
    }

    function animateViewerIn() {
      requestAnimationFrame(() => {
        viewerImg.classList.remove('gesturing');
        viewerZoom.tx = 0;
        viewerZoom.ty = 0;
        applyViewerZoom();
      });
    }

    const viewerCanDelete = item => item && item.id != null && item.file && !item.fromPc;

    function syncActionButtons(item) {
      const needsRetry = item ? !item.sent : false;
      $('#viewer-retry')?.classList.toggle('hidden', !needsRetry);
      $('#viewer-discard')?.classList.toggle('hidden', !needsRetry);
      $('#viewer-del')?.classList.toggle('hidden', !viewerCanDelete(item));
      syncSaveRotUI();
    }

    function openViewer(item) {
      if (remoteFetchCtrl) { remoteFetchCtrl.abort(); remoteFetchCtrl = null; }
      remoteLoadGen++;
      clearTimeout(tapChromeTimer);
      const recentItems = getRecentItems();
      viewerItems = item.remoteList || recentItems;
      viewerIdx = viewerItems.indexOf(item);
      showViewer(item);
      syncActionButtons(item);
      const needsRetry = !item.sent;
      viewerRetryFn = needsRetry ? async () => { hideViewer(); await retryItem(item); } : null;
      viewerDiscardFn = needsRetry ? async () => {
        if (!await phoneConfirm({ title: 'Discard this photo?', body: 'It will not be uploaded.', ok: 'Discard' })) return;
        if (item.outboxKey != null) await outboxDelete(item.outboxKey);
        item.outboxKey = null;
        item.el.remove();
        const idx = recentItems.indexOf(item);
        if (idx >= 0) recentItems.splice(idx, 1);
        revokeObjectUrl(item.tileUrl);
        revokeObjectUrl(item.url);
        revokeObjectUrl(item.fullUrl);
        hideViewer();
        recentEmptyUI();
        flash('Discarded');
      } : null;
    }

    async function openViewerRemote(item) {
      if (remoteFetchCtrl) { remoteFetchCtrl.abort(); remoteFetchCtrl = null; }
      const gen = ++remoteLoadGen;
      clearTimeout(tapChromeTimer);

      const recentItems = getRecentItems();
      viewerItems = item.remoteList || (recentItems.includes(item) ? recentItems : pcMediaItems);
      viewerIdx = viewerItems.indexOf(item);

      const needsFetch = !item.blob && item.url;
      showViewer(item, { loading: needsFetch });
      animateViewerIn();
      syncActionButtons(item);
      const needsRetry = !item.sent;
      viewerRetryFn = needsRetry ? async () => { hideViewer(); await retryItem(item); } : null;
      viewerDiscardFn = null;

      if (needsFetch) {
        const ctrl = new AbortController();
        remoteFetchCtrl = ctrl;
        const timeout = setTimeout(() => ctrl.abort('timeout'), 20000);
        try {
          const r = await fetch(item.url, { signal: ctrl.signal });
          if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }
          const fetchedBlob = await r.blob();
          if (gen !== remoteLoadGen) return;
          item.blob = fetchedBlob;
        } catch (e) {
          if (gen !== remoteLoadGen || e?.name === 'AbortError') return;
          setViewerLoading(false);
          if (e && e.status === 404) {
            markDeadPcMedia(item.file);
            const pcIdx = pcMediaItems.indexOf(item);
            if (pcIdx >= 0) {
              pcMediaItems.splice(pcIdx, 1);
              revokeObjectUrl(item.fullUrl);
            }
            reloadTexts();
            flash('This capture was deleted on the PC');
            const list = activeViewerItems();
            const fallback = list[viewerIdx + 1] || list[viewerIdx - 1] || null;
            if (fallback && fallback !== item) {
              fallback.remote ? openViewerRemote(fallback) : openViewer(fallback);
            } else {
              hideViewer();
            }
          } else {
            setViewerError(true, 'Load failed — check the connection', () => openViewerRemote(item));
          }
          return;
        } finally {
          clearTimeout(timeout);
          if (remoteFetchCtrl === ctrl) remoteFetchCtrl = null;
        }
      }

      if (gen !== remoteLoadGen) return;
      setViewerLoading(false);
      setViewerError(false);

      if (item.blob && item.blob.type && /^image\/(tiff|hei[cf])$/i.test(item.blob.type)) {
        item.fullUrl = item.thumbUrl || item.url;
        viewerBlob = null;
        if (viewerImg.getAttribute('src') !== item.fullUrl) viewerImg.src = item.fullUrl;
        flash('No in-browser preview for this format — thumbnail shown');
        syncActionButtons(item);
        return;
      }

      if (item.blob && (!item.fullUrl || item.fullUrl === item.thumbUrl || item.fullUrl === item.url)) {
        item.fullUrl = URL.createObjectURL(item.blob);
      }
      touchRemoteBlobLru(item);
      viewerBlob = item.blob || null;
      const finalSrc = item.fullUrl || item.url || item.thumbUrl || '';
      if (finalSrc && viewerImg.getAttribute('src') !== finalSrc) {
        viewerImg.src = finalSrc;
      }
      syncActionButtons(item);
      updateViewerMeta(item);
    }

    function hideViewer() {
      if (remoteFetchCtrl) { remoteFetchCtrl.abort(); remoteFetchCtrl = null; }
      remoteLoadGen++;
      clearTimeout(tapChromeTimer);
      viewerEl.classList.add('hidden');
      setViewerChromeHidden(false);
      resetViewerBackdrop();
      setViewerLoading(false);
      setViewerError(false);
      viewerImg.src = '';
      viewerImg.style.scale = '';
      hideViewerUnder();
      invalidateStageRect();
      for (const it of [...remoteBlobLru]) releaseRemoteItemBlob(it);
      remoteBlobLru.length = 0;
      activeItem = null;
      viewerBlob = null;
      viewerRetryFn = null;
      viewerDiscardFn = null;
      viewerItems = null;
      const back = viewerReturnFocus;
      viewerReturnFocus = null;
      untrapPhone(viewerEl, back);
      syncOverlayHistory();
    }

    function viewerDownload() {
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

    async function viewerDelete() {
      const list = activeViewerItems();
      const recentItems = getRecentItems();
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

    async function rotateBlobPixels(blob, deg) {
      const norm = ((deg % 360) + 360) % 360;
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      try {
        const swap = norm === 90 || norm === 270;
        c.width = swap ? bmp.height : bmp.width;
        c.height = swap ? bmp.width : bmp.height;
        const ctx = c.getContext('2d');
        ctx.translate(c.width / 2, c.height / 2);
        ctx.rotate((norm * Math.PI) / 180);
        ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
        const mime = blob.type === 'image/png' ? 'image/png' : (blob.type === 'image/webp' ? 'image/webp' : 'image/jpeg');
        return await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), mime, 0.92));
      } finally {
        bmp.close && bmp.close();
        c.width = 0; c.height = 0;
      }
    }

    async function saveViewerRotation() {
      const deg = ((viewerRot % 360) + 360) % 360;
      if (!deg || savingRot) return;
      const item = activeViewerItems()[viewerIdx];
      if (!canPersistViewerRot(item)) return;
      savingRot = true;
      syncSaveRotUI();
      try {
        if (item.sent && item.id != null) {
          const r = await fetch(`${SERVER}/api/captures/${encodeURIComponent(item.id)}/rotate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deg }),
            signal: AbortSignal.timeout(15000),
          });
          if (!r.ok) throw new Error('server rotate failed');
          const { capture } = await r.json();
          if (capture?.file) {
            item.file = capture.file;
            item.url = `${SERVER}/media/${encodeURIComponent(capture.file)}`;
            item.thumbUrl = `${SERVER}/media/t-${encodeURIComponent(capture.file)}`;
            revokeObjectUrl(item.fullUrl);
            item.fullUrl = item.url;
            item.blob = null;
            viewerBlob = null;
            if (item.img) item.img.src = item.thumbUrl;
            viewerImg.src = item.fullUrl;
          }
        } else if (item.blob) {
          const rotatedBlob = await rotateBlobPixels(item.blob, deg);
          item.blob = rotatedBlob;
          viewerBlob = rotatedBlob;
          revokeObjectUrl(item.fullUrl);
          item.fullUrl = URL.createObjectURL(rotatedBlob);
          viewerImg.src = item.fullUrl;
          if (item.outboxKey != null && outboxUpdateBlob) {
            await outboxUpdateBlob(item.outboxKey, rotatedBlob);
          }
          if (regenerateTileUrl) await regenerateTileUrl(item);
        }
        viewerRot = 0;
        viewerZoom = { scale: 1, tx: 0, ty: 0 };
        syncRotFitScale();
        applyViewerZoom();
        updateViewerMeta(item);
        updateViewerPos();
        flash('Rotation saved ✓');
      } catch {
        flash('Could not save rotation — try again');
      } finally {
        savingRot = false;
        syncSaveRotUI();
      }
    }

    function navigateBy(dir) {
      const list = activeViewerItems();
      const next = list[viewerIdx + dir];
      if (!next) return false;
      clearTimeout(tapChromeTimer);
      viewerZoom = { scale: 1, tx: 0, ty: 0 };
      viewerImg.classList.add('gesturing');
      applyViewerZoom();
      next.remote ? openViewerRemote(next) : openViewer(next);
      return true;
    }

    function commitAnimatedNav(dir) {
      const list = activeViewerItems();
      const next = list[viewerIdx + dir];
      if (!next) return false;
      const stageW = viewerStage.clientWidth || 1;
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
        setTimeout(finish, 240);
      });
      return true;
    }

    viewerImg.addEventListener('load', () => {
      if (viewerEl.classList.contains('hidden')) return;
      syncRotFitScale();
      clampViewerPan();
      applyViewerZoom();
      updateViewerMeta();
    });

    const onViewportChange = () => {
      invalidateStageRect();
      if (viewerEl.classList.contains('hidden')) return;
      syncRotFitScale();
      clampViewerPan();
      applyViewerZoom();
    };
    addEventListener('resize', onViewportChange);
    addEventListener('orientationchange', onViewportChange);

    // Touch gestures on viewer stage (midpoint pinch-zoom, pan, double-tap, single-tap chrome toggle, two-layer swipe, swipe-down dismiss)
    (() => {
      const stage = viewerStage;
      const AXIS_LOCK = 10;
      const FLICK_V = 0.5;
      const FLICK_WINDOW = 90;
      const COMMIT_FRAC = 0.25;
      const DISMISS_PX = 105;
      const DISMISS_V = 0.55;
      const RUBBER = 0.35;
      let start = null;
      let stageW = 1;
      let samples = [];
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
        return {
          vx: dt > 0 ? (last.x - first.x) / dt : 0,
          vy: dt > 0 ? (last.y - first.y) / dt : 0,
        };
      }

      stage.addEventListener('touchstart', e => {
        if (e.target.closest('button')) return;
        stageRect = stage.getBoundingClientRect();
        viewerImg.style.willChange = 'transform';
        viewerImg.classList.add('gesturing');
        if (e.touches.length === 2) {
          clearTimeout(tapChromeTimer);
          const [a, b] = e.touches;
          const r = stageRect;
          const mx = (a.clientX + b.clientX) / 2 - r.left - r.width / 2;
          const my = (a.clientY + b.clientY) / 2 - r.top - r.height / 2;
          start = {
            dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
            scale: viewerZoom.scale,
            tx: viewerZoom.tx,
            ty: viewerZoom.ty,
            mx,
            my,
            pinch: true,
            wasPinch: true,
            axis: 'h',
          };
        } else if (e.touches.length === 1) {
          stageW = stageRect.width || 1;
          samples = [{ x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now() }];
          start = {
            x: e.touches[0].clientX,
            y: e.touches[0].clientY,
            t: performance.now(),
            baseX: viewerZoom.tx,
            baseY: viewerZoom.ty,
            scale: viewerZoom.scale,
            pinch: false,
            wasPinch: start ? !!start.wasPinch : false,
            axis: null,
          };
        }
      }, { passive: true });

      stage.addEventListener('touchmove', e => {
        if (!start) return;
        if (start.pinch && e.touches.length === 1) {
          start = {
            x: e.touches[0].clientX,
            y: e.touches[0].clientY,
            t: performance.now(),
            baseX: viewerZoom.tx,
            baseY: viewerZoom.ty,
            scale: viewerZoom.scale,
            pinch: false,
            wasPinch: true,
            axis: viewerZoom.scale > 1.02 ? 'h' : null,
          };
          samples = [{ x: start.x, y: start.y, t: start.t }];
        }
        if (start.pinch && e.touches.length === 2) {
          const [a, b] = e.touches;
          const r = getStageRect();
          const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
          const nextScale = Math.min(6, Math.max(1, start.scale * (d / start.dist)));
          const mx = (a.clientX + b.clientX) / 2 - r.left - r.width / 2;
          const my = (a.clientY + b.clientY) / 2 - r.top - r.height / 2;
          const ratio = nextScale / start.scale;
          viewerZoom.scale = nextScale;
          viewerZoom.tx = mx - ratio * (start.mx - start.tx);
          viewerZoom.ty = my - ratio * (start.my - start.ty);
          clampViewerPan();
          applyViewerZoom();
          updateViewerPos();
          return;
        }
        if (start.pinch || e.touches.length !== 1) return;
        const t = e.touches[0];
        samples.push({ x: t.clientX, y: t.clientY, t: performance.now() });
        if (samples.length > 8) samples.shift();
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (!start.axis) {
          if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
          start.axis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
        }
        if (viewerZoom.scale > 1.01) {
          viewerZoom.tx = start.baseX + dx;
          viewerZoom.ty = start.baseY + dy;
          clampViewerPan();
          applyViewerZoom();
          return;
        }
        if (start.wasPinch) return;
        if (start.axis === 'v') {
          dismissDragActive = true;
          viewerZoom.tx = 0;
          viewerZoom.ty = dy;
          const shrink = Math.max(0.86, 1 - Math.abs(dy) / 1400);
          syncRotFitScale(shrink);
          const bgAlpha = Math.max(0.18, 0.9 * (1 - Math.abs(dy) / 420));
          viewerEl.style.setProperty('--viewer-bg-alpha', bgAlpha.toFixed(3));
          applyViewerZoom();
          return;
        }
        const dir = dx < 0 ? 1 : -1;
        const neighbor = Math.abs(dx) > 2 ? neighborFor(dir) : null;
        if (neighbor) showViewerUnder(neighbor, dir * stageW + dx);
        else hideViewerUnder();
        slideTo(neighbor ? dx : dx * RUBBER, false);
      }, { passive: true });

      stage.addEventListener('touchend', e => {
        if (!start) return;
        if (e.touches.length === 0) {
          viewerImg.style.willChange = '';
          viewerImg.classList.remove('gesturing');
        }
        if (!start.pinch && !start.wasPinch && start.axis === 'v' && start.scale <= 1.01 && dismissDragActive) {
          dismissDragActive = false;
          const dy = viewerZoom.ty;
          const { vy } = flickVelocity();
          const flick = Math.abs(vy) > DISMISS_V && Math.sign(vy) === Math.sign(dy);
          if (Math.abs(dy) > DISMISS_PX || (flick && Math.abs(dy) > 36)) {
            hideViewer();
            if (e.touches.length === 0) start = null;
            return;
          }
          viewerZoom.ty = 0;
          syncRotFitScale();
          resetViewerBackdrop();
          applyViewerZoom();
          if (e.touches.length === 0) start = null;
          return;
        }
        if (!start.pinch && !start.wasPinch && start.axis === 'h' && start.scale <= 1.01) {
          const dx = viewerZoom.tx;
          const { vx } = flickVelocity();
          const dir = dx < 0 ? 1 : -1;
          const flick = Math.abs(vx) > FLICK_V && Math.sign(vx) === dir;
          if ((Math.abs(dx) > stageW * COMMIT_FRAC || flick) && Math.abs(dx) > 24 && neighborFor(dir)) {
            dismissSwipeHint();
            commitAnimatedNav(dir);
            start = e.touches.length === 0 ? null : start;
            return;
          }
          slideTo(0, true);
          hideViewerUnder();
        }
        if (e.touches.length === 0 && !start.pinch && !start.wasPinch && !start.axis) {
          const t = e.changedTouches[0];
          const now = performance.now();
          if (lastTap && now - lastTap.t < 300 && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 40) {
            clearTimeout(tapChromeTimer);
            lastTap = null;
            if (viewerZoom.scale > 1.05) viewerZoomTo(1);
            else viewerZoomTo(2.5, t.clientX, t.clientY);
          } else {
            lastTap = { x: t.clientX, y: t.clientY, t: now };
            clearTimeout(tapChromeTimer);
            tapChromeTimer = setTimeout(() => {
              tapChromeTimer = 0;
              if (!viewerEl.classList.contains('hidden')) {
                setViewerChromeHidden(!viewerEl.classList.contains('chrome-hidden'));
              }
            }, 260);
          }
        }
        if (e.touches.length === 0) start = null;
      });

      // Mouse/trackpad convenience (responsive/tablet testing)
      stage.addEventListener('wheel', e => {
        if (viewerEl.classList.contains('hidden')) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        viewerZoomTo(viewerZoom.scale * factor, e.clientX, e.clientY);
      }, { passive: false });

      stage.addEventListener('dblclick', e => {
        if (e.target.closest('button')) return;
        if (viewerZoom.scale > 1.05) viewerZoomTo(1);
        else viewerZoomTo(2.5, e.clientX, e.clientY);
      });
    })();

    $('#viewer-prev')?.addEventListener('click', e => { e.stopPropagation(); dismissSwipeHint(); navigateBy(-1); });
    $('#viewer-next')?.addEventListener('click', e => { e.stopPropagation(); dismissSwipeHint(); navigateBy(1); });
    $('#viewer-zoom-btn')?.addEventListener('click', e => { e.stopPropagation(); viewerZoomTo(1); });
    $('#viewer-rot').onclick = e => { e.stopPropagation(); rotateViewer(); };
    $('#viewer-save-rot')?.addEventListener('click', e => { e.stopPropagation(); saveViewerRotation(); });
    $('#viewer-dl').onclick = e => { e.stopPropagation(); viewerDownload(); };
    $('#viewer-retry').onclick = e => { e.stopPropagation(); if (viewerRetryFn) viewerRetryFn(); };
    $('#viewer-discard').onclick = e => { e.stopPropagation(); if (viewerDiscardFn) viewerDiscardFn(); };
    $('#viewer-del').onclick = e => { e.stopPropagation(); viewerDelete(); };
    $('#viewer-close').onclick = e => { e.stopPropagation(); hideViewer(); };
    viewerEl.onclick = e => { if (e.target.id === 'viewer') hideViewer(); };
    document.addEventListener('keydown', e => {
      if (viewerEl.classList.contains('hidden') || confirmOpen()) return;
      if (e.key === 'Escape') { hideViewer(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); dismissSwipeHint(); navigateBy(-1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); dismissSwipeHint(); navigateBy(1); return; }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rotateViewer(); return; }
      if (e.key === '0') { e.preventDefault(); viewerZoomTo(1); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); viewerZoomTo(viewerZoom.scale * 1.5); return; }
      if (e.key === '-') { e.preventDefault(); viewerZoomTo(viewerZoom.scale / 1.5); }
    });

    return {
      openViewer,
      openViewerRemote,
      hideViewer,
      hasBlob: b => b != null && b === viewerBlob,
      hasItem: item => item != null && item === activeItem,
      isOpen: () => !viewerEl.classList.contains('hidden'),
    };
  }

  return { create };
})();
if (typeof self !== 'undefined') self.PPPhoneViewer = PPPhoneViewer;
