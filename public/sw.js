// Phone PWA service worker. Registered ONLY by phone.js — the PC harness never
// registers a worker — so this precaches the phone shell and nothing else.
//
// KEY SCHEME — canonical, query-stripped, never bumped:
// Every versioned request (/phone.js?v=abcdef) is stored under ONE key
// (/phone.js). A new version overwrites the old entry, so old asset versions
// never accumulate and the cache name NEVER needs a manual bump (the previous
// proofpipe-v33 scheme keyed by full URL and grew unboundedly until someone
// remembered to bump it). The cache name below is the last bump ever — it only
// exists to shed v33's accumulated entries on first activation.
//
// SERVING — network-first, cache = offline fallback ONLY:
// The phone talks to a LAN server it must be fresh against; a cached-first
// policy would serve OLD bytes for a NEW ?v=hash URL (the stale-shell bug,
// see PITFALLS #25). So every shell request tries the network first and only
// falls back to the cache when the network is gone (phone offline / server
// down). The browser HTTP cache (max-age=86400 on shell assets) still makes
// repeat loads of the same version instant — no server round trip.
const CACHE = 'proofpipe-v34'; // stable — do NOT bump (canonical keys self-overwrite)
const SHELL = [
  // phone PWA: the actual served page is /phone (never /phone.html — that's
  // the raw source file with literal __PP_VERSION__ placeholders)
  '/phone', '/phone.css', '/phone.js', '/toPng.js', '/queue.js',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png',
  // icons this app actually renders (harness-only icons excluded)
  '/icons/camera.svg', '/icons/chevron-up.svg', '/icons/clipboard-copy.svg',
  '/icons/download.svg', '/icons/file.svg', '/icons/images.svg',
  '/icons/mail.svg', '/icons/monitor.svg', '/icons/monitor-down.svg',
  '/icons/more-vertical.svg', '/icons/package.svg', '/icons/rotate-cw.svg',
  '/icons/send-horizontal.svg', '/icons/trash-2.svg', '/icons/upload.svg',
  '/icons/x.svg',
];
const SHELL_SET = new Set(SHELL);

self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})
    .then(() => { try { return self.skipWaiting(); } catch {} })
));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => { try { return self.clients.claim(); } catch {} })
));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // live data always hits the network (fresh captures, stats, SSE, uploads)
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/upload') || url.pathname.startsWith('/media')) return;
  if (e.request.method !== 'GET') return;
  // NAVIGATIONS: network first (fresh HTML, never a cached shell against
  // newer assets). Each successful navigation refreshes the cached copy so
  // the offline fallback tracks the version you actually used last; on
  // failure fall back to the last cached phone shell.
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(e.request);
        if (net && net.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(url.origin + url.pathname, net.clone());
        }
        return net;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(url.origin + url.pathname)) || (await cache.match('/phone')) || Response.error();
      }
    })());
    return;
  }
  // shell assets: network first, cache under canonical (query-stripped) key
  if (!SHELL_SET.has(url.pathname)) return;
  const key = url.origin + url.pathname;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const net = await fetch(e.request);
      if (net && net.ok) await cache.put(key, net.clone());
      return net;
    } catch {
      return (await cache.match(key)) || Response.error();
    }
  })());
});