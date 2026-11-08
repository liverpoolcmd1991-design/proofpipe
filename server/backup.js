// server/backup.js — backup/export route, extracted from server.js.
// Zips the whole ProofPipe state — DB (checkpointed inside a write
// transaction so a concurrent upload can't slip between checkpoint and
// copy), settings, captures, transfer files, inbox — into one timestamped
// archive the user chooses via the /api/pick-folder dialog.
// Loopback-only: the zip lands on this PC's disk at a path the PC's own
// browser supplied (a LAN client must not write arbitrary server paths).
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function registerBackup(app, ctx) {
  const { csrfSafe, DATA, SETTINGS_FILE, currentMediaBase } = ctx;
  let backupRunning = false;

  app.post('/api/backup', async (req, reply) => {
    if (!csrfSafe(req)) return reply.code(403).send({ error: 'cross-site request blocked' });
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    if (ip !== '127.0.0.1' && ip !== '::1') return reply.code(403).send({ error: 'available from this PC only' });
    if (backupRunning) return reply.code(409).send({ error: 'a backup is already running' });
    const raw = String((req.body || {}).dir || '').trim();
    if (!raw) return reply.code(400).send({ error: 'an absolute destination folder is required' });
    const dir = path.resolve(raw);
    let probeFile = '';
    try {
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) return reply.code(400).send({ error: 'destination is not a folder' });
      probeFile = path.join(dir, `.pp-backup-test-${Date.now()}`);
      await fsp.writeFile(probeFile, 'ok');
      await fsp.rm(probeFile, { force: true });
    } catch {
      return reply.code(400).send({ error: 'destination folder is not writable' });
    }
    if (process.platform !== 'win32') return reply.code(400).send({ error: 'Windows only (PowerShell Compress-Archive)' });
    backupRunning = true;
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const zipPath = path.join(dir, `proofpipe-backup-${stamp}.zip`);
    const stage = path.join(dir, `.pp-stage-${stamp}`);
    try {
      await fsp.mkdir(stage, { recursive: true });
      // Checkpoint the WAL and copy DB files inside one immediate transaction
      // so concurrent writes cannot interleave between checkpoint and copy.
      ctx.db.transaction(() => {
        ctx.db.pragma('wal_checkpoint(TRUNCATE)');
        try { fs.copyFileSync(path.join(DATA, 'proofpipe.db'), path.join(stage, 'proofpipe.db')); }
        catch (e) { throw new Error('db copy failed: ' + (e?.message || e)); }
        try { fs.copyFileSync(path.join(DATA, 'proofpipe.db-wal'), path.join(stage, 'proofpipe.db-wal')); } catch {}
        try { fs.copyFileSync(path.join(DATA, 'proofpipe.db-shm'), path.join(stage, 'proofpipe.db-shm')); } catch {}
      })();
      try { await fsp.copyFile(SETTINGS_FILE, path.join(stage, path.basename(SETTINGS_FILE))); } catch {}
      const cur = currentMediaBase();
      const CHUNK = 64;
      for (const [label, srcDir] of [['captures', cur.captures], ['files', cur.files], ['inbox', cur.inbox]]) {
        let entries = [];
        try { entries = await fsp.readdir(srcDir, { withFileTypes: true }); } catch {}
        const dstDir = path.join(stage, label);
        await fsp.mkdir(dstDir, { recursive: true });
        const names = entries.filter(e => e.isFile()).map(e => e.name);
        for (let i = 0; i < names.length; i += CHUNK) {
          await Promise.all(names.slice(i, i + CHUNK).map(async n => {
            try { await fsp.copyFile(path.join(srcDir, n), path.join(dstDir, n)); } catch {}
          }));
        }
      }
      // 4) zip with PowerShell (repo already shells out to PS for the picker;
      // no new npm deps). -Force overwrites a same-second name collision.
      await new Promise((resolve, reject) => {
        const ps = `Compress-Archive -Path '${stage.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
        const z = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        z.stderr.on('data', d => { err += d; });
        z.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `Compress-Archive exited ${code}`)));
        z.on('error', reject);
      });
      const st = await fsp.stat(zipPath);
      return { ok: true, path: zipPath, bytes: st.size };
      // NOTE: fallthrough cleanup lives in finally — stage is always removed
    } catch (e) {
      console.error('backup:', e?.message || e);
      try { await fsp.rm(zipPath, { force: true }); } catch {} // no half zips
      return reply.code(500).send({ error: 'backup failed — see the server console' });
    } finally {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
      backupRunning = false;
    }
  });

  return {};
}
