// gen-cert.js — one-time helper: creates a self-signed cert for serving
// ProofPipe over HTTPS (which makes Android Chrome treat the phone PWA as a
// secure context, enabling clipboard IMAGE writes without any flag).
// Usage: npm run gen-cert   (requires the `openssl` CLI on PATH)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ROOT is the repo root, not this file's folder — the cert lands in data/
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.PP_DATA ? path.resolve(process.env.PP_DATA) : path.join(ROOT, 'data');
const KEY = path.join(DATA, 'key.pem');
const CERT = path.join(DATA, 'cert.pem');
fs.mkdirSync(DATA, { recursive: true });

if (fs.existsSync(KEY) && fs.existsSync(CERT)) {
  console.log('Certificates already exist:\n  ' + KEY + '\n  ' + CERT);
  console.log('Delete them first if you want to regenerate.');
  process.exit(0);
}

// gather every LAN IPv4 + localhost for the subjectAltName list
const sans = ['DNS:localhost', 'IP:127.0.0.1'];
for (const addrs of Object.values(os.networkInterfaces()))
  for (const a of addrs || [])
    if (a.family === 'IPv4' && !a.internal) sans.push(`IP:${a.address}`);

const cfg = [
  '[req]',
  'distinguished_name = dn',
  'x509_extensions = v3',
  'prompt = no',
  '[dn]',
  'CN = proofpipe',
  '[v3]',
  'subjectAltName = ' + sans.join(', '),
  'basicConstraints = critical,CA:FALSE',
  'keyUsage = digitalSignature, keyEncipherment',
  'extendedKeyUsage = serverAuth',
].join('\n');
const cfgPath = path.join(DATA, 'openssl-san.cnf');
fs.writeFileSync(cfgPath, cfg);

// locate openssl: PATH first, then Git for Windows' bundled copy
function findOpenssl() {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', 'openssl.exe'),
  ];
  for (const c of candidates) {
    try { execFileSync(c, ['version'], { stdio: 'pipe' }); return c; } catch {}
  }
  return null;
}

try {
  const bin = findOpenssl();
  if (!bin) throw new Error('openssl CLI not found on PATH or in Git for Windows');
  execFileSync(bin, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', KEY, '-out', CERT, '-days', '825',
    '-config', cfgPath,
  ], { stdio: 'pipe' });
  fs.rmSync(cfgPath, { force: true });
  console.log('Created self-signed certificate:\n  ' + CERT + '\n  ' + KEY);
  console.log('SANs: ' + sans.join(', '));
  console.log('\nRestart ProofPipe — it will now serve https://. On the phone, open the');
  console.log('QR link once and accept the certificate warning (Details → proceed).');
} catch (e) {
  fs.rmSync(cfgPath, { force: true });
  console.error('openssl not found or failed: ' + (e && e.message));
  console.error('Install Git for Windows (ships openssl) or OpenSSL for Windows,');
  console.error('then run: npm run gen-cert');
  process.exit(1);
}