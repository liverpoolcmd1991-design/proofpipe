// server/util.js — pure, side-effect-free helpers extracted out of server.js.
// Nothing here touches the DB, the network, or mutable server state, so it can
// be reasoned about (and reused) in isolation. Keep it free of `sharp`/native
// imports on purpose — server.js imports this statically at the top, and
// pulling a native module here would re-trigger the early-libuv-init class of
// bug (see server.js's UV_THREADPOOL_SIZE comment). Image helpers stay in
// server.js next to the (lazy) sharp import.
import path from 'node:path';
import os from 'node:os';

// the four movables — helper for the media dirs under a base. The DB always
// stays in DATA; only these three dirs move on relocation, so relocation never
// touches the database handle.
export function mediaDirs(base) {
  return {
    captures: path.join(base, 'captures'),
    files: path.join(base, 'files'),
    inbox: path.join(base, 'inbox'),
  };
}

// strip any path + control chars from a client-supplied display name; cap the
// length at 200 (preserving the extension) so it can't be a 10k-char disk key.
export function sanitizeDisplayName(raw) {
  let s = String(raw || '').split('/').pop().split('\\').pop(); // strip any path
  s = Array.from(s).filter(c => { const n = c.codePointAt(0); return n >= 32 && n !== 127; }).join("").trim(); // strip control chars
  if (s.length > 200) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 ? s.slice(dot) : '';
    s = s.slice(0, 200 - ext.length) + ext;
  }
  if (!s || s === '.' || s === '..') s = 'file';
  return s;
}
// stored extension: lowercase alphanumerics only (drives serving rules, so it
// must be predictable — never the raw client string)
export function storedExtFor(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name || ''));
  return m ? `.${m[1].toLowerCase()}` : '';
}
// inline ONLY for media/pdf; everything else is attachment + octet-stream, so
// no text/html (or svg-as-image) ever renders on the LAN origin
export const FILE_INLINE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
};
export function fileServeHeaders(storedFile, displayName) {
  const inlineMime = FILE_INLINE_MIME[storedExtFor(storedFile)];
  const safe = sanitizeDisplayName(displayName).replace(/"/g, '');
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_') || 'file';
  const disposition = inlineMime
    ? `inline; filename="${ascii}"`
    : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
  return { contentType: inlineMime || 'application/octet-stream', disposition };
}

export const MEDIA_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.tiff': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heic',
};
export function mediaContentType(name) {
  // t-*.tiff and t-*.heic thumbs are PNG bytes (browsers can't render either)
  if (path.basename(name).startsWith('t-') && (name.endsWith('.tiff') || name.endsWith('.heic') || name.endsWith('.heif')))
    return 'image/png';
  return MEDIA_MIME[storedExtFor(name)] || 'application/octet-stream';
}

// Adapter names that are tunnels or virtual switches. Their addresses are
// private IPs exactly like a hotspot's, so the RANGE cannot tell them apart —
// the name is the only reliable signal. A VPN's own IP is the worst possible
// thing to put in the pairing QR: it exists only on this PC, so the phone dials
// an address that is not on its network (and a kill-switch VPN drops that
// traffic at the driver anyway).
const VIRTUAL_NIC = /(vpn|windscribe|wireguard|wintun|nordlynx|openvpn|tap-windows|\btap\b|\btun\d|\btun\b|tailscale|zerotier|hamachi|proton|mullvad|expressvpn|surfshark|cyberghost|npcap|vethernet|virtualbox|vmware|hyper-v|docker|wsl|loopback)/i;

// Optional `nets` argument = injectable os.networkInterfaces() for tests; it
// also bypasses the cache, so a test never reads another test's snapshot.
export function lanIPs(nets) {
  // cached for 3s: os.networkInterfaces() is a real syscall and this runs on
  // every phone poll (/api/lan) and QR request — Hotspot IP changes are rare
  const now = Date.now();
  if (!nets && now - (lanIPs.cache || 0) < 3000) return [...lanIPs.cached];
  const out = [];
  for (const [name, addrs] of Object.entries(nets || os.networkInterfaces()))
    for (const a of addrs || [])
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
  // 4 = tunnel/virtual adapter: reachable from THIS PC only, never from the
  // phone, so it ranks below every real interface whatever its range. Otherwise
  // real LAN/hotspot ranges first; 172.16-31 is usually WSL/Docker virtual.
  const score = ({ name, ip }) =>
    VIRTUAL_NIC.test(name) ? 4 :
    ip.startsWith('192.168.') ? 0 :
    ip.startsWith('10.') ? 1 :
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 3 : 2;
  const ips = out.sort((a, b) => score(a) - score(b)).map(o => o.ip);
  if (!nets) {
    lanIPs.cached = ips;
    lanIPs.cache = now;
  }
  return [...ips];
}