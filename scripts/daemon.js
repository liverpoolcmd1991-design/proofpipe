// ProofPipe cross-platform background daemon CLI (Windows, Linux, Darwin).
// Zero external dependencies: uses Node.js child_process/fs/os and OS-native
// startup mechanisms (Windows HKCU Run registry, XDG autostart, LaunchAgent).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_NAME = 'ProofPipe';

export function resolvePaths({ root = ROOT, env = process.env } = {}) {
  const dataDir = env.PP_DATA ? path.resolve(env.PP_DATA) : path.join(root, 'data');
  const port = Number(env.PORT) || 8787;
  const scheme = fs.existsSync(path.join(dataDir, 'cert.pem')) ? 'https' : 'http';
  return {
    root,
    dataDir,
    port,
    scheme,
    lockFile: path.join(dataDir, 'proofpipe.lock'),
    logFile: path.join(dataDir, 'proofpipe.log'),
    serverFile: path.join(root, 'server.js'),
    preloadFile: path.join(root, 'scripts', 'threadpool.cjs'),
    trayScript: path.join(root, 'scripts', 'tray.ps1'),
  };
}

export function readLock(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return null;
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

export async function probeServer(port, scheme = 'http') {
  const urls = [`${scheme}://127.0.0.1:${port}/api/version`, `http://127.0.0.1:${port}/api/version`];
  for (const url of new Set(urls)) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      if (j && typeof j.version === 'string' && /^v\d/.test(j.version)) {
        return { url: url.replace('/api/version', ''), version: j.version };
      }
    } catch {}
  }
  return null;
}

export async function fetchRuntimeInfo(port, scheme = 'http') {
  const base = (await probeServer(port, scheme))?.url;
  if (!base) return null;
  const [stats, lan] = await Promise.all([
    fetch(`${base}/api/stats`, { signal: AbortSignal.timeout(1500) }).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`${base}/api/lan`, { signal: AbortSignal.timeout(1500) }).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  const ips = Array.isArray(lan?.ips) ? lan.ips : [];
  const activeScheme = lan?.scheme || scheme;
  const activePort = lan?.port || port;
  return {
    base,
    stats,
    lan,
    webUrl: `${activeScheme}://localhost:${activePort}`,
    phoneUrl: ips[0] ? `${activeScheme}://${ips[0]}:${activePort}/phone` : null,
  };
}

export function rotateLogIfNeeded(logFile, maxBytes = LOG_MAX_BYTES) {
  try {
    const st = fs.statSync(logFile);
    if (st.size >= maxBytes) {
      const backup = `${logFile}.1`;
      try { fs.rmSync(backup, { force: true }); } catch {}
      fs.renameSync(logFile, backup);
    }
  } catch {}
}

export function tailText(content, lines = 50) {
  const count = Math.max(1, Number(lines) || 50);
  const all = String(content || '').replace(/\r\n/g, '\n').split('\n');
  while (all.length && all[all.length - 1] === '') all.pop();
  return all.slice(-count).join('\n');
}

export function buildAutostartSpec({
  platform = process.platform,
  root = ROOT,
  nodePath = process.execPath,
  homeDir = os.homedir(),
  env = process.env,
} = {}) {
  const daemonJs = path.join(root, 'scripts', 'daemon.js');
  const trayPs1 = path.join(root, 'scripts', 'tray.ps1');
  if (platform === 'win32') {
    const command = fs.existsSync(trayPs1)
      ? `powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "${trayPs1}"`
      : `"${nodePath}" "${daemonJs}" start`;
    return { platform, kind: 'registry', key: WIN_RUN_KEY, valueName: AUTOSTART_NAME, command };
  }
  if (platform === 'darwin') {
    const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', 'com.proofpipe.daemon.plist');
    const logPath = path.join(resolvePaths({ root, env }).dataDir, 'proofpipe.log');
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.proofpipe.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodePath)}</string>
    <string>--require</string>
    <string>${esc(path.join(root, 'scripts', 'threadpool.cjs'))}</string>
    <string>${esc(path.join(root, 'server.js'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logPath)}</string>
</dict>
</plist>
`;
    return { platform, kind: 'launchd', filePath: plistPath, content };
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  const filePath = path.join(configHome, 'autostart', 'proofpipe.desktop');
  const content = `[Desktop Entry]
Type=Application
Name=ProofPipe
Comment=ProofPipe local photo, file, and text bridge
Exec="${nodePath}" "${daemonJs}" start
Path=${root}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
  return { platform, kind: 'xdg', filePath, content };
}

export function getAutostartEnabled(opts = {}) {
  const spec = buildAutostartSpec(opts);
  if (spec.kind === 'registry') {
    try {
      execFileSync('reg', ['query', spec.key, '/v', spec.valueName], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  return fs.existsSync(spec.filePath);
}

export function setAutostartEnabled(enable, opts = {}) {
  const spec = buildAutostartSpec(opts);
  if (spec.kind === 'registry') {
    if (enable) {
      execFileSync('reg', ['add', spec.key, '/v', spec.valueName, '/t', 'REG_SZ', '/d', spec.command, '/f'], { stdio: 'ignore' });
    } else {
      try { execFileSync('reg', ['delete', spec.key, '/v', spec.valueName, '/f'], { stdio: 'ignore' }); } catch {}
    }
    return { ok: true, enabled: enable, location: `${spec.key}\\${spec.valueName}` };
  }
  if (enable) {
    fs.mkdirSync(path.dirname(spec.filePath), { recursive: true });
    fs.writeFileSync(spec.filePath, spec.content, 'utf8');
    if (spec.kind === 'launchd') {
      try { execFileSync('launchctl', ['load', '-w', spec.filePath], { stdio: 'ignore' }); } catch {}
    }
    return { ok: true, enabled: true, location: spec.filePath };
  }
  if (spec.kind === 'launchd' && fs.existsSync(spec.filePath)) {
    try { execFileSync('launchctl', ['unload', spec.filePath], { stdio: 'ignore' }); } catch {}
  }
  try { fs.rmSync(spec.filePath, { force: true }); } catch {}
  return { ok: true, enabled: false, location: spec.filePath };
}

export async function getStatus(env = process.env) {
  const paths = resolvePaths({ env });
  const lock = readLock(paths.lockFile);
  const effectivePort = Number(lock?.port) || paths.port;
  const aliveByPid = lock ? pidAlive(lock.pid) : false;
  const runtime = aliveByPid ? await fetchRuntimeInfo(effectivePort, paths.scheme) : await fetchRuntimeInfo(paths.port, paths.scheme);
  const running = !!(runtime && (aliveByPid || !lock));
  return {
    running,
    pid: running && lock?.pid ? lock.pid : null,
    port: effectivePort,
    scheme: paths.scheme,
    started: lock?.started || null,
    webUrl: runtime?.webUrl || `${paths.scheme}://localhost:${effectivePort}`,
    phoneUrl: runtime?.phoneUrl || null,
    stats: runtime?.stats || null,
    autostart: getAutostartEnabled({ env }),
    logFile: paths.logFile,
    dataDir: paths.dataDir,
  };
}

export async function startDaemon({ open = false, env = process.env } = {}) {
  const paths = resolvePaths({ env });
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const current = await getStatus(env);
  if (current.running) {
    if (open) openUrl(current.webUrl);
    return { ...current, alreadyRunning: true };
  }
  const staleLock = readLock(paths.lockFile);
  if (staleLock && !pidAlive(staleLock.pid)) {
    try { fs.rmSync(paths.lockFile, { force: true }); } catch {}
  }

  rotateLogIfNeeded(paths.logFile);
  const logFd = fs.openSync(paths.logFile, 'a');
  const childEnv = {
    ...env,
    UV_THREADPOOL_SIZE: env.UV_THREADPOOL_SIZE || '16',
    ...(open ? { PP_OPEN_BROWSER: '1' } : { PP_OPEN_BROWSER: '0' }),
  };
  const child = spawn(
    process.execPath,
    ['--require', paths.preloadFile, paths.serverFile],
    {
      cwd: paths.root,
      env: childEnv,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    }
  );
  child.unref();
  try { fs.closeSync(logFd); } catch {}

  const deadline = Date.now() + 15000;
  let exited = false;
  let exitCode = null;
  child.once('exit', code => { exited = true; exitCode = code; });
  while (Date.now() < deadline && !exited) {
    const info = await fetchRuntimeInfo(paths.port, paths.scheme);
    if (info) {
      return {
        running: true,
        alreadyRunning: false,
        pid: child.pid,
        port: paths.port,
        scheme: paths.scheme,
        webUrl: info.webUrl,
        phoneUrl: info.phoneUrl,
        stats: info.stats,
        autostart: getAutostartEnabled({ env }),
        logFile: paths.logFile,
      };
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(exited
    ? `Server exited immediately (code ${exitCode}). Check logs: ${paths.logFile}`
    : `Timed out waiting for ProofPipe on port ${paths.port}. Check logs: ${paths.logFile}`);
}

export async function stopDaemon({ env = process.env } = {}) {
  const paths = resolvePaths({ env });
  const lock = readLock(paths.lockFile);
  if (!lock || !pidAlive(lock.pid)) {
    try { fs.rmSync(paths.lockFile, { force: true }); } catch {}
    return { stopped: false, wasRunning: false };
  }
  const pid = lock.pid;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      try { fs.rmSync(paths.lockFile, { force: true }); } catch {}
      return { stopped: true, wasRunning: true, pid };
    }
    await new Promise(r => setTimeout(r, 120));
  }
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  try { fs.rmSync(paths.lockFile, { force: true }); } catch {}
  return { stopped: true, wasRunning: true, pid, forced: true };
}

export function openUrl(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}

export function launchTray({ env = process.env } = {}) {
  if (process.platform !== 'win32') return false;
  const paths = resolvePaths({ env });
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', paths.trayScript],
    { cwd: paths.root, env, detached: true, windowsHide: true, stdio: 'ignore' }
  );
  child.unref();
  return true;
}

function parseFlags(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--open') flags.open = true;
    else if (a === '--port' && argv[i + 1]) { flags.port = argv[++i]; }
    else if (a === '-n' && argv[i + 1]) { flags.lines = Number(argv[++i]); }
    else args.push(a);
  }
  return { args, flags };
}

async function main() {
  const { args, flags } = parseFlags(process.argv.slice(2));
  const cmd = (args[0] || 'status').toLowerCase();
  const sub = (args[1] || '').toLowerCase();
  const env = flags.port ? { ...process.env, PORT: String(flags.port) } : process.env;

  const outJson = v => { console.log(JSON.stringify(v, null, 2)); };

  if (cmd === 'start') {
    const res = await startDaemon({ open: !!flags.open, env });
    if (flags.json) return outJson(res);
    console.log(res.alreadyRunning
      ? `ProofPipe already running (PID ${res.pid ?? 'active'}, port ${res.port})`
      : `ProofPipe started in background (PID ${res.pid}, port ${res.port})`);
    console.log(`  Web   : ${res.webUrl}`);
    if (res.phoneUrl) console.log(`  Phone : ${res.phoneUrl}`);
    console.log(`  Logs  : ${res.logFile}`);
    return;
  }
  if (cmd === 'stop') {
    const res = await stopDaemon({ env });
    if (flags.json) return outJson(res);
    console.log(res.wasRunning ? `ProofPipe stopped (PID ${res.pid})` : 'ProofPipe is not running');
    return;
  }
  if (cmd === 'restart') {
    await stopDaemon({ env });
    const res = await startDaemon({ open: !!flags.open, env });
    if (flags.json) return outJson(res);
    console.log(`ProofPipe restarted (PID ${res.pid}, port ${res.port})`);
    console.log(`  Web   : ${res.webUrl}`);
    return;
  }
  if (cmd === 'status') {
    const s = await getStatus(env);
    if (flags.json) return outJson(s);
    console.log(`ProofPipe: ${s.running ? 'RUNNING' : 'STOPPED'}${s.pid ? ` (PID ${s.pid})` : ''}`);
    console.log(`  Web       : ${s.webUrl}`);
    if (s.phoneUrl) console.log(`  Phone     : ${s.phoneUrl}`);
    if (s.stats) {
      console.log(`  Bridge    : ${s.stats.phoneOnline ? 'Phone connected' : 'Ready to pair'} · ${s.stats.count} captures · ${s.stats.files?.count ?? 0} files`);
    }
    console.log(`  Autostart : ${s.autostart ? 'enabled' : 'disabled'}`);
    console.log(`  Logs      : ${s.logFile}`);
    return;
  }
  if (cmd === 'logs') {
    const { logFile } = resolvePaths({ env });
    if (!fs.existsSync(logFile)) {
      console.log(`No log file yet at ${logFile}`);
      return;
    }
    console.log(tailText(fs.readFileSync(logFile, 'utf8'), flags.lines || 50));
    return;
  }
  if (cmd === 'autostart') {
    if (sub === 'enable' || sub === 'on') {
      const r = setAutostartEnabled(true, { env });
      if (flags.json) return outJson(r);
      console.log(`Autostart enabled (${r.location})`);
      return;
    }
    if (sub === 'disable' || sub === 'off') {
      const r = setAutostartEnabled(false, { env });
      if (flags.json) return outJson(r);
      console.log('Autostart disabled');
      return;
    }
    const enabled = getAutostartEnabled({ env });
    if (flags.json) return outJson({ enabled });
    console.log(`Autostart: ${enabled ? 'enabled' : 'disabled'}`);
    return;
  }
  if (cmd === 'tray') {
    if (launchTray({ env })) {
      console.log('ProofPipe Windows tray launched.');
    } else {
      console.log('System tray is Windows-only. Use "npm run daemon -- start|stop|status|logs|autostart" on this OS.');
    }
    return;
  }

  console.error(`Usage: node scripts/daemon.js <start|stop|restart|status|logs|tray|autostart [enable|disable|status]> [--open] [--json] [--port N]`);
  process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(err => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}
