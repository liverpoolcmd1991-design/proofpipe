// ProofPipe extension — pure auto-paste decision logic (no DOM, no chrome.*).
// Extracted from content.js so the rules that caused the double/4x-paste saga
// (PITFALLS #5/#6) can be unit-tested without a browser: test/
// extension-logic.test.js runs this file through node:vm.
//
// Classic script, same reason as discovery.js: content scripts and MV3
// workers don't module-load, and the test VM shares the file.
const PPPasteLogic = (() => {
  // Files the synthetic paste carries. Auto-paste prefers the ORIGINAL bytes
  // (no re-encode); only the clipboard fallback needs PNG (Clipboard API).
  function pasteFileName(captureId, mime) {
    const ext = String(mime || '').split('/')[1] || 'jpg';
    return `proofpipe-${captureId}.${ext === 'jpeg' ? 'jpg' : ext}`;
  }

  // Stored-name extension (lowercased) — server/store.js keeps each capture in
  // the format it arrived in and names the file for that format, so this IS the
  // original's format.
  const fileExt = file => (/[.]([A-Za-z0-9]{1,5})$/.exec(String(file || ''))?.[1] || '').toLowerCase();
  const DRAG_MIME = {
    jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    avif: 'image/avif', tiff: 'image/tiff', tif: 'image/tiff',
    // no browser renders these, but they are still what the drop target must be
    // told — a HEIC handed over as "image/jpeg" fails or is re-encoded blindly
    heic: 'image/heic', heif: 'image/heif',
  };

  // `mime` + `filename` for the tray's DownloadURL drag of one capture. It used
  // to be the hardcoded `image/jpeg:proofpipe-<id>.jpg`, which mislabeled every
  // PNG / WebP / HEIC capture — consumers that trust the declared type then
  // re-encoded a lossless PNG as lossy JPEG (or could not decode the HEIC at
  // all). Unknown extensions keep the old jpeg fallback. Lives beside
  // pasteFileName on purpose: both build the same proofpipe-<id>.<ext> name and
  // must not drift apart. `captureId` is expected already sanitized by the
  // caller (DownloadURL is colon-delimited, so content.js strips separator
  // characters from it).
  function dragFile(captureId, file) {
    const ext = fileExt(file);
    const named = ext === 'jpeg' ? 'jpg' : ext;
    const mime = DRAG_MIME[named];
    return mime ? { mime, filename: `proofpipe-${captureId}.${named}` }
                : { mime: 'image/jpeg', filename: `proofpipe-${captureId}.jpg` };
  }

  // A paste File is worth attempting as-is when it's already an image the
  // editors accept; the PNG retry only makes sense for non-PNG originals.
  function needsPngRetry(mime) {
    return (mime || '') !== 'image/png';
  }

  // Never auto-paste into the ProofPipe harness itself: its paste handler
  // re-uploads the image, which fires another auto SSE event, which gets
  // pasted again — a self-feeding loop (1 photo → 5 "empty" captures, the
  // exact bug this rule kills). Loopback OR the pinned server port refuses,
  // quietly: no fail flag, no toast.
  function isSelfPasteTarget(url, { pinnedPort = null } = {}) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const host = String(u.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
      const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
      const pinned = pinnedPort != null ? String(u.port || (u.protocol === 'https:' ? '443' : '80')) === String(pinnedPort) : false;
      return isLoopback || pinned;
    } catch {
      return false;
    }
  }

  // Insert-detection snapshot + check (the PITFALLS #6 fix): sites render
  // pasted images as editor text, <img>, attachment chips (filename label),
  // canvas previews, or blob: URLs — ALL must be checked, editor length
  // alone false-negatived and fired every escalation (4x paste).
  function snapshot(target) {
    const count = sel => document.querySelectorAll(sel).length;
    const localCount = sel => {
      try { return target.querySelectorAll ? target.querySelectorAll(sel).length : 0; } catch { return 0; }
    };
    // Discover shadow hosts ONCE per paste attempt, not once per animation
    // frame. New hosts are inspected directly from MutationRecords below.
    let shadowHosts = [];
    try { shadowHosts = [...document.querySelectorAll('*')].filter(el => el.shadowRoot).slice(0, 128); } catch {}
    return {
      len: target.isContentEditable ? target.innerHTML.length : (target.value ?? '').length,
      imgs: count('img'),
      canvases: count('canvas'),
      blobs: count('[src^="blob:"]'),
      localImgs: localCount('img'),
      localCanvases: localCount('canvas'),
      localBlobs: localCount('[src^="blob:"]'),
      shadowHosts,
    };
  }
  function insertedAnywhere(target, fname, base, { broad = true } = {}) {
    const count = sel => document.querySelectorAll(sel).length;
    const localCount = sel => {
      try { return target.querySelectorAll ? target.querySelectorAll(sel).length : 0; } catch { return 0; }
    };
    const targetChanged = (target.isContentEditable ? target.innerHTML.length : (target.value ?? '').length) > base.len ||
      localCount('img') > (base.localImgs || 0) ||
      localCount('canvas') > (base.localCanvases || 0) ||
      localCount('[src^="blob:"]') > (base.localBlobs || 0);
    if (targetChanged || !broad) return targetChanged;
    // Broad verification runs only at attempt start/timeout. Filename text is
    // unique to this capture; shadow traversal is bounded to the hosts cached
    // by snapshot() instead of walking every page element on every check.
    let textFound = false;
    if (fname && document.body) {
      if (document.body.textContent.includes(fname)) textFound = true;
      else {
        const hosts = Array.isArray(base.shadowHosts) ? base.shadowHosts : [];
        for (const el of hosts) {
          if (el.shadowRoot && el.shadowRoot.textContent.includes(fname)) { textFound = true; break; }
        }
        // A host may be attached after the snapshot without a useful mutation
        // record. Broad checks are limited to attempt start/timeout, so one
        // bounded discovery here preserves that edge case without a per-frame
        // whole-tree walk.
        if (!textFound) {
          let seen = 0;
          for (const el of document.querySelectorAll('*')) {
            if (++seen > 128) break;
            if (el.shadowRoot && el.shadowRoot.textContent.includes(fname)) { textFound = true; break; }
          }
        }
      }
    }
    return textFound || count('img') > base.imgs || count('canvas') > base.canvases || count('[src^="blob:"]') > base.blobs;
  }

  // Cheap MutationObserver hint used by content.js. It deliberately returns
  // `true` only for records that can represent an insertion; unrelated chat
  // animations/typing mutations are ignored without running the expensive full
  // document scan. `null` means "uncertain" and preserves the old safe fallback
  // (the caller performs the full insertedAnywhere check).
  function mutationMayContainInsert(records, target, fname) {
    let uncertain = false;
    const hasSignal = node => {
      if (!node) return false;
      if (node.nodeType === 3) return !!fname && node.data.includes(fname);
      if (node.nodeType !== 1 && node.nodeType !== 11) return false;
      if (fname && node.textContent && node.textContent.includes(fname)) return true;
      try {
        if (node.matches?.('img,canvas,[src^="blob:"]') || node.querySelector?.('img,canvas,[src^="blob:"]')) return true;
      } catch {}
      // Shadow hosts hide their text from body.textContent. Inspect only the
      // added subtree here; the broad fallback still handles already-existing
      // hosts and keeps the original shadow-DOM guarantee intact.
      const sr = node.shadowRoot;
      if (sr && hasSignal(sr)) return true;
      return false;
    };
    for (const r of records || []) {
      if (r.type === 'characterData') {
        if (hasSignal(r.target)) return true;
        if (target && (r.target === target || target.contains?.(r.target))) uncertain = true;
      } else if (r.type === 'attributes') {
        if (/^(src|href)$/i.test(r.attributeName || '')) return true;
        if (target && (r.target === target || target.contains?.(r.target))) uncertain = true;
      } else if (r.type === 'childList') {
        for (const n of r.addedNodes || []) if (hasSignal(n)) return true;
        if (target && (r.target === target || target.contains?.(r.target))) uncertain = true;
      }
    }
    return uncertain ? null : false;
  }

  return { pasteFileName, dragFile, needsPngRetry, isSelfPasteTarget, snapshot, insertedAnywhere, mutationMayContainInsert };
})();
if (typeof self !== 'undefined') self.PPPasteLogic = PPPasteLogic;
