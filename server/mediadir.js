// server/mediadir.js — folder management routes, extracted from server.js:
// inbox folder choice, media-folder relocation (captures + files + inbox move
// together), and the native Windows folder picker.
//
// The DB stays in DATA — only the three media dirs move, so relocation never
// touches the database handle. server.js owns the `mediaBase`/`CAPTURES`/
// `FILES`/`INBOX` bindings; this module switches them through the injected
// setter (adoptMediaDir) so the source of truth stays in ONE place.
// saveSettings is injected so the SSE 'settings' push keeps firing from here.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mediaDirs } from './util.js';

export function registerMediaDir(app, ctx) {
  const { settings, saveSettings, csrfSafe, DATA, adoptMediaDir, currentMediaBase } = ctx;

  // ---------- inbox folder choice (where phone files auto-save; null = default) ----------
  app.get('/api/inbox-dir', () => ({ path: settings.inboxDir, def: currentMediaBase().inbox }));
  app.post('/api/inbox-dir', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const b = req.body || {};
    if (b.path === null) { // reset → back to the default data/inbox
      settings.inboxDir = null;
      saveSettings();
      return { ok: true, path: null };
    }
    const raw = String(b.path || '').trim();
    if (!raw || !path.isAbsolute(raw)) return reply.code(400).send({ error: 'an absolute folder path is required' });
    const base = path.normalize(raw);
    // nesting against the capture/file stores would let inbox dedup collide with
    // live media names — refuse (a fresh subfolder is fine)
    const cur = currentMediaBase();
    for (const c of [cur.captures, cur.files]) {
      const rel = path.relative(c, base);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return reply.code(400).send({ error: 'cannot be inside the captures or files folder' });
    }
    try {
      await fsp.mkdir(base, { recursive: true });
      const probe = path.join(base, `.pp-write-test-${Date.now()}`);
      await fsp.writeFile(probe, 'ok');
      await fsp.rm(probe, { force: true });
    } catch { return reply.code(400).send({ error: 'folder is not writable' }); }
    settings.inboxDir = base;
    saveSettings();
    return { ok: true, path: base };
  });
  app.post('/api/files-inbox', (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const b = req.body || {};
    if (typeof b.on !== 'boolean') return reply.code(400).send({ error: 'on must be a boolean' });
    settings.filesToInbox = !!b.on;
    saveSettings();
    return { ok: true, on: settings.filesToInbox };
  });

  // ---------- media folder relocation (captures + files + inbox move together) ----------
  // Paths switch only after every entry moved; a failure rolls the moves back.
  app.get('/api/media-dir', () => ({ path: currentMediaBase().base, def: DATA }));
  async function moveEntry(src, dst) {
    try {
      await fsp.rename(src, dst);
    } catch (e) {
      if (e?.code !== 'EXDEV') throw e; // cross-drive: copy + remove instead
      await fsp.copyFile(src, dst);
      await fsp.rm(src, { force: true });
    }
  }
  let relocationRunning = false;
  app.post('/api/media-dir', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    if (relocationRunning) return reply.code(409).send({ error: 'relocation already in progress' });
    const raw = String((req.body || {}).path || '').trim();
    if (!raw || !path.isAbsolute(raw)) return reply.code(400).send({ error: 'an absolute folder path is required' });
    const base = path.normalize(raw);
    const cur = currentMediaBase();
    if (base === cur.base) return { ok: true, path: cur.base }; // no-op
    // nesting either way would move a folder into itself — refuse (checked per
    // media dir, so a fresh subfolder of the current base is still allowed)
    const nxt = Object.values(mediaDirs(base));
    const dirs = [cur.captures, cur.files, cur.inbox];
    for (const n of nxt) for (const c of dirs) {
      if (!path.relative(c, n).startsWith('..') || !path.relative(n, c).startsWith('..'))
        return reply.code(400).send({ error: 'folders cannot be nested inside each other' });
    }
    relocationRunning = true;
    try {
      const dst = mediaDirs(base);
      for (const d of Object.values(dst)) await fsp.mkdir(d, { recursive: true });
      // writability proof before touching anything live
      const probe = path.join(base, `.pp-write-test-${Date.now()}`);
      try { await fsp.writeFile(probe, 'ok'); await fsp.rm(probe, { force: true }); }
      catch { return reply.code(400).send({ error: 'folder is not writable' }); }
      const src = { captures: cur.captures, files: cur.files, inbox: cur.inbox };
      const moved = []; // [from, to] pairs for best-effort rollback
      try {
        for (const k of Object.keys(src)) {
          let entries = [];
          try { entries = await fsp.readdir(src[k]); } catch { continue; }
          for (const e of entries) {
            await moveEntry(path.join(src[k], e), path.join(dst[k], e));
            moved.push([path.join(dst[k], e), path.join(src[k], e)]);
          }
        }
      } catch (e) {
        for (const [there, back] of moved.reverse()) {
          try { await moveEntry(there, back); } catch {}
        }
        req.log.error(e);
        return reply.code(500).send({ error: 'move failed, rolled back' });
      }
      for (const d of Object.values(src)) { try { await fsp.rmdir(d); } catch {} } // old dirs, if empty
      // THE switch: server.js reassigns mediaBase + CAPTURES/FILES/INBOX here
      adoptMediaDir(base);
      settings.mediaDir = base;
      saveSettings(); // SSE 'settings' push refreshes every open UI
      // stragglers: an upload racing the move may have landed in an old dir
      // after it was listed — sweep once more so nothing is left behind
      const now = currentMediaBase();
      for (const k of Object.keys(src)) {
        let entries = [];
        try { entries = await fsp.readdir(src[k]); } catch { continue; }
        for (const e of entries) {
          try { await moveEntry(path.join(src[k], e), path.join(now[k], e)); } catch {}
        }
        try { await fsp.rmdir(src[k]); } catch {}
      }
      return { ok: true, path: base };
    } finally { relocationRunning = false; }
  });

  // ---------- native OS folder picker (PC harness "Browse…" button) ----------
  // A web page can never learn an absolute path from the browser's own folder
  // dialog (sandbox), so the SERVER opens the real Windows folder picker on
  // the PC screen and returns the chosen path. Loopback-only: the dialog pops
  // on the PC desktop, so only the PC's own browser may summon it (a phone on
  // the LAN gets 403 — checked by remote IP, since same-origin phone requests
  // pass the CSRF host check).
  let pickRunning = false;
  app.post('/api/pick-folder', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    if (ip !== '127.0.0.1' && ip !== '::1') return reply.code(403).send({ error: 'available from this PC only' });
    if (process.platform !== 'win32') return reply.code(400).send({ error: 'Windows only' });
    if (pickRunning) return reply.code(409).send({ error: 'a picker is already open on the PC' });
    pickRunning = true;
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose where ProofPipe saves captures and files'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }`;
    let picker;
    try {
      picker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { pickRunning = false; return reply.code(500).send({ error: 'could not open the folder picker' }); }
    req.raw.on('close', () => { try { picker.kill(); } catch {} }); // browser gave up — take the dialog down too
    const out = await new Promise(resolve => {
      let buf = '';
      picker.stdout.on('data', d => { buf += d; });
      picker.on('close', () => resolve(buf));
      picker.on('error', () => resolve(''));
    });
    pickRunning = false;
    const picked = out.split('\n').map(s => s.trim()).filter(Boolean).pop() || '';
    if (!picked) return { cancelled: true }; // closed the dialog without choosing
    return { path: picked };
  });

  return {};
}
