// server/lockfile.js — single-instance PID/port lockfile management.
import fs from 'node:fs';

const LOCK_BOOT_GRACE_MS = 20_000;

export function createLockManager({ lockFile, port }) {
  function readLock() {
    try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; }
  }

  async function lockAlive(lock) {
    if (!lock || typeof lock.pid !== 'number' || lock.pid === process.pid) return false;
    let pidExists = false;
    try { process.kill(lock.pid, 0); pidExists = true; }
    catch (e) { pidExists = e.code === 'EPERM'; }
    if (!pidExists) return false;
    const lockPort = Number(lock.port);
    if (!Number.isInteger(lockPort) || lockPort < 1 || lockPort > 65535) return true;
    const age = Date.now() - Date.parse(lock.started || '');
    if (Number.isFinite(age) && age < LOCK_BOOT_GRACE_MS) return true;
    try {
      const r = await fetch(`http://127.0.0.1:${lockPort}/api/version`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return false;
      const j = await r.json();
      return typeof j.version === 'string' && /^v\d/.test(j.version);
    } catch { return false; }
  }

  async function acquireLock() {
    const payload = JSON.stringify({ pid: process.pid, port, started: new Date().toISOString() });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.writeFileSync(lockFile, payload, { flag: 'wx' });
        return;
      } catch (e) {
        if (e?.code !== 'EEXIST') break;
      }
      const existing = readLock();
      if (await lockAlive(existing)) {
        console.error(`ProofPipe is ALREADY RUNNING (pid ${existing.pid}, started ${existing.started}).`);
        console.error(`Stop it first (close its window / Ctrl+C), or point PP_DATA elsewhere.`);
        process.exit(1);
      }
      try { fs.rmSync(lockFile, { force: true }); } catch {}
    }
    try { fs.writeFileSync(lockFile, payload); }
    catch (e) {
      console.error('Could not write the instance lock:', e.message);
      process.exit(1);
    }
  }

  function releaseLock() {
    try {
      const lock = readLock();
      if (lock && lock.pid === process.pid) fs.rmSync(lockFile, { force: true });
    } catch {}
  }

  return { acquireLock, releaseLock };
}
