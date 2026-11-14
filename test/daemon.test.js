// Daemon CLI + Windows Tray launcher unit and isolated lifecycle tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPort } from './port-ranges.js';
import {
  resolvePaths,
  rotateLogIfNeeded,
  tailText,
  buildAutostartSpec,
  startDaemon,
  getStatus,
  stopDaemon,
} from '../scripts/daemon.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('resolvePaths resolves lock, log, and server files from PP_DATA & PORT', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpipe-paths-'));
  try {
    const p = resolvePaths({ env: { PP_DATA: scratch, PORT: '9601' } });
    assert.equal(p.dataDir, path.resolve(scratch));
    assert.equal(p.port, 9601);
    assert.equal(p.scheme, 'http');
    assert.equal(p.lockFile, path.join(path.resolve(scratch), 'proofpipe.lock'));
    assert.equal(p.logFile, path.join(path.resolve(scratch), 'proofpipe.log'));
    assert.ok(fs.existsSync(p.serverFile));
    assert.ok(fs.existsSync(p.preloadFile));
    assert.ok(fs.existsSync(p.trayScript));

    fs.writeFileSync(path.join(scratch, 'cert.pem'), 'dummy');
    const pTls = resolvePaths({ env: { PP_DATA: scratch } });
    assert.equal(pTls.scheme, 'https');
    assert.equal(pTls.port, 8787);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('rotateLogIfNeeded rotates oversize log to .1 backup and tailText returns trailing lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpipe-log-'));
  try {
    const log = path.join(dir, 'proofpipe.log');
    fs.writeFileSync(log, '12345678901234567890');
    rotateLogIfNeeded(log, 10);
    assert.equal(fs.existsSync(log), false, 'rotated log moves out of the active path');
    assert.equal(fs.readFileSync(`${log}.1`, 'utf8'), '12345678901234567890');

    const sample = 'line1\r\nline2\nline3\nline4\n\n';
    assert.equal(tailText(sample, 2), 'line3\nline4');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildAutostartSpec covers win32 registry, linux XDG desktop, and darwin launchd', () => {
  const win = buildAutostartSpec({ platform: 'win32', root: APP });
  assert.equal(win.kind, 'registry');
  assert.match(win.command, /scripts[\\/]tray\.ps1/);

  const xdg = buildAutostartSpec({
    platform: 'linux',
    root: '/opt/proofpipe',
    nodePath: '/usr/bin/node',
    homeDir: '/home/tester',
    env: { XDG_CONFIG_HOME: '/home/tester/.cfg' },
  });
  assert.equal(xdg.kind, 'xdg');
  assert.equal(xdg.filePath, '/home/tester/.cfg/autostart/proofpipe.desktop');
  assert.match(xdg.content, /Exec="\/usr\/bin\/node" "\/opt\/proofpipe\/scripts\/daemon\.js" start/);

  const darwin = buildAutostartSpec({
    platform: 'darwin',
    root: '/opt/proof&pipe',
    nodePath: '/usr/local/bin/node',
    homeDir: '/Users/tester',
    env: {},
  });
  assert.equal(darwin.kind, 'launchd');
  assert.equal(darwin.filePath, '/Users/tester/Library/LaunchAgents/com.proofpipe.daemon.plist');
  assert.match(darwin.content, /com\.proofpipe\.daemon/);
  assert.match(darwin.content, /proof&amp;pipe/, 'XML special characters in paths are escaped');
});

test('tray.ps1 declares single-instance mutex and WinForms tooltip cap', () => {
  const ps1 = fs.readFileSync(path.join(APP, 'scripts', 'tray.ps1'), 'utf8');
  assert.match(ps1, /Local\\ProofPipeWindowsTray/);
  assert.match(ps1, /System\.Windows\.Forms\.NotifyIcon/);
  assert.match(ps1, /if \(\$tip\.Length -gt 63\)/);
});

test('daemon start -> status -> stop lifecycle works against isolated data dir and port', async () => {
  const port = pickPort('daemon');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofpipe-daemon-'));
  const env = { ...process.env, PP_DATA: dataDir, PORT: String(port) };
  try {
    const started = await startDaemon({ open: false, env });
    assert.equal(started.running, true);
    assert.equal(started.alreadyRunning, false);
    assert.equal(started.port, port);
    assert.ok(started.pid > 0);
    assert.ok(fs.existsSync(started.logFile), 'daemon writes log file in PP_DATA');

    const again = await startDaemon({ open: false, env });
    assert.equal(again.alreadyRunning, true, 'second start detects running daemon');
    assert.equal(again.pid, started.pid);

    const status = await getStatus(env);
    assert.equal(status.running, true);
    assert.equal(status.pid, started.pid);
    assert.ok(status.stats && typeof status.stats.count === 'number');

    const stopped = await stopDaemon({ env });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.wasRunning, true);

    const after = await getStatus(env);
    assert.equal(after.running, false);
  } finally {
    await stopDaemon({ env }).catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
