// Phone PWA service worker. Registered ONLY by phone.js; precaches the phone
// shell under canonical query-stripped keys and serves network-first with
// cache fallback when offline.
const CACHE = 'proofpipe-v34';
const SHELL = [
  '/phone', '/phone.css', '/phone.js', '/toPng.js', '/queue.js',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png',
  '/icons/camera.svg', '/icons/chevron-up.svg', '/icons/download.svg',
  '/icons/file.svg', '/icons/images.svg', '/icons/mail.svg',
  '/icons/monitor.svg', '/icons/monitor-down.svg', '/icons/more-vertical.svg',
  '/icons/package.svg', '/icons/rotate-cw.svg', '/icons/send-horizontal.svg',
  '/icons/smartphone.svg', '/icons/trash-2.svg', '/icons/upload.svg',
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