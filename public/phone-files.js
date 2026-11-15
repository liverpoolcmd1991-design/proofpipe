// Bi-directional file transfers and durable IndexedDB file outbox for ProofPipe Phone PWA.
const PPPhoneFiles = (() => {
  function create({
    $, SERVER, PPQueue, PPShared, flash, trapPhone, untrapPhone, syncOverlayHistory, confirmOpen,
    transferBegin, transferProgress, transferEnd, setTransferBatchRemaining, transferBatchSize,
    transferA11yName, getSortMode, applySort, stampSort, chipA11y, attachChipSwipe, markChipNew,
    dismissChipHint, getChipSwiping, setFilesDirty, getUndoLane, chipHHMM, chipTimestamp,
  }) {
    let fileDb = null;
    let fileFlushing = false;
    let filesVersion = -1;
    let filesBefore = null;
    let filesMoreAvailable = false;
    let filesLoadBusy = false;
    let sheetFile = null;
    let sheetReturnFocus = null;
    const xferFiles = []; // { id, name, bytes, mime, dir, created_at }

    const fmtFb = b => PPShared.fmtBytes(b, { nullable: true, compactKb: true });
    const undoIsFile = () => getUndoLane() === '#files';

    function openFileQueue() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('proofpipe-files', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('fqueue', { autoIncrement: true });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    async function initDb() {
      fileDb = await openFileQueue().catch(() => null);
      return fileDb;
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

    async function unpoisonAll() {
      if (!fileDb || !(await fqueueCount())) return 0;
      let revived = 0;
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
      return revived;
    }

    async function uploadFileXHR(blob, name) {
      const label = name || 'file';
      const tid = transferBegin(label, transferBatchSize());
      const fd = new FormData();
      fd.append('dir', 'phone'); // direction badge on the PC (declared BEFORE the file part)
      fd.append('file', blob, label);
      try {
        const res = await PPShared.xhrPost(SERVER + '/api/files', fd, {
          timeoutMs: 300000,
          onProgress: p => {
            if (p < 0) return;
            transferProgress(tid, p);
            transferA11yName(label, p);
          },
        });
        if (!res.ok) {
          const err = new Error('upload failed ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.data;
      } finally {
        transferEnd(tid);
      }
    }

    async function flushFileQueue() {
      if (fileFlushing || !fileDb) return;
      fileFlushing = true;
      try {
        if (!(await fqueueCount())) return;
        const items = await fqueueAll();
        setTransferBatchRemaining(items.length);
        for (const job of items) {
          const v = job.value;
          if (PPQueue.decide(v) !== 'send') continue;
          try {
            await uploadFileXHR(v.blob, v.name);
            await fqueueDelete(job.key);
          } catch (e) {
            const book = PPQueue.onFailure(v, e.status);
            const extra = book.poisoned ? { poisonReason: 'too-large' } : {};
            await new Promise(resolve => {
              const tx = fileDb.transaction('fqueue', 'readwrite');
              tx.objectStore('fqueue').put({ ...v, tries: book.tries, lastAttempt: book.lastAttempt, ...extra }, job.key);
              tx.oncomplete = resolve; tx.onerror = resolve;
            });
            if (book.poisoned) { flash(`“${v.name}” is over the size cap`); }
            else break;
          }
        }
      } finally {
        fileFlushing = false;
        setTransferBatchRemaining(0);
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
      let qi = 0;
      setTransferBatchRemaining(jobs.length);
      const worker = async () => {
        while (qi < jobs.length) {
          const f = jobs[qi++];
          try {
            await uploadFileXHR(f, f.name);
            flash(`Sent ${f.name} ✓`);
          } catch (e) {
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
      setTransferBatchRemaining(0);
    }

    $('#file-input').onchange = e => {
      const fs = [...e.target.files];
      e.target.value = '';
      if (fs.length) sendFiles(fs);
    };

    async function deleteServerFile(f) {
      if (!f || f.id == null) return;
      dismissChipHint();
      try {
        const r = await fetch(`${SERVER}/api/files/${encodeURIComponent(f.id)}`,
          { method: 'DELETE', signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw 0;
        const i = xferFiles.findIndex(x => x.id === f.id);
        if (i >= 0) xferFiles.splice(i, 1);
        flash('File removed');
      } catch {
        flash('Delete failed — offline?');
        loadFiles(true);
      }
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

    function updateFilesLoadMore() {
      const more = $('#files-load-more');
      if (!more) return;
      more.classList.toggle('hidden', !filesMoreAvailable);
      more.disabled = filesLoadBusy;
      more.textContent = filesLoadBusy ? 'Loading older transfers…' : 'Load older transfers';
    }

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
      if (getSortMode() !== 'new') applySort(box);
      xferFiles.length = 0;
      xferFiles.push(...list);
    }

    async function loadFiles(force = false, older = false) {
      if (getChipSwiping() || undoIsFile()) { setFilesDirty(true); return; }
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

    function openFileSheet(f) {
      sheetFile = f;
      $('#file-sheet-name').textContent = f.name;
      const formatted = PPShared.fmtShortDateTime(f.created_at);
      const whenTxt = formatted ? ' · ' + formatted : '';
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
      if (e.key !== 'Escape' || confirmOpen()) return;
      if (!$('#file-sheet').classList.contains('hidden')) closeFileSheet();
    });
    $('#file-sheet-save').onclick = () => {
      if (!sheetFile) return;
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
      window.open(`${SERVER}/file/${sheetFile.id}`, '_blank', 'noopener');
      closeFileSheet();
    };

    return {
      initDb,
      fqueueCount,
      unpoisonAll,
      flushFileQueue,
      loadFiles,
      renderFiles,
      xferFiles,
      bumpVersion: v => { if (v > filesVersion) filesVersion = v; },
      undoIsFile,
      closeFileSheet,
    };
  }

  return { create };
})();
if (typeof self !== 'undefined') self.PPPhoneFiles = PPPhoneFiles;
