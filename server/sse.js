// server/sse.js — the live-push hub (SSE), extracted from server.js.
// Owns the client set, the /events route registration, the eviction cap, the
// heartbeat, and the broadcast helper. Depends on nothing but an injected
// logger and an injected presence callback, so this module stays free of server
// state and is trivially testable in isolation.
//
// Shutdown: destroyAll() is what the SIGINT/SIGTERM path must call BEFORE
// app.close() — SSE streams never end on their own, so app.close() would
// wait on them FOREVER and the node process would linger after Ctrl+C.
export function createSseHub(app, { logEvent = () => {}, maxClients = 100, onPhonePresence = () => {} } = {}) {
  const sseClients = new Set();
  // Which browser each live connection belongs to. The extension's offscreen
  // relay appends `?browser=chrome|edge` (see extension/offscreen.js) so the
  // server can tell whether the harness's picked browser is actually here and
  // fall back to 'default' when it isn't (server/browser.js resolveAutoTarget) —
  // otherwise an auto capture tagged for an absent browser pastes nowhere.
  // Non-extension clients (the PC harness grid) send no param → null.
  const clientBrowsers = new Map(); // reply.raw -> 'chrome' | 'edge' | null
  // Which connections are a PHONE. The phone's EventSource appends
  // `?device=phone` (public/phone.js); the harness grid sends nothing and the
  // extension's relay only `browser=`. A phone's stream is a live wire to this
  // server — while it is open the phone is here, and (subject to the caller's
  // reconnect grace) its close is the earliest honest sign the phone left,
  // minutes ahead of the ping window the harness otherwise has to wait out.
  const clientDevices = new Map(); // reply.raw -> 'phone' | null
  const phoneConnections = () => {
    let n = 0;
    for (const d of clientDevices.values()) if (d === 'phone') n++;
    return n;
  };
  // Sockets whose write buffer is full. `res.write()` returning false means the
  // kernel buffer is saturated; continuing to write would grow Node's buffer
  // without bound (a slow phone during a cleanup burst used to be able to do
  // exactly that). A backed-up client is skipped until its 'drain' fires — safe
  // because every payload-less event is a "resync from the server" signal, so
  // dropping intermediate frames can never leave a client permanently stale.
  const backedUp = new Set();
  const dropClient = raw => {
    const wasPhone = clientDevices.get(raw) === 'phone';
    sseClients.delete(raw); clientBrowsers.delete(raw); clientDevices.delete(raw); backedUp.delete(raw);
    // edge, not level: only the LAST phone leaving is a presence change (a
    // second phone still holding a stream keeps the phone side connected)
    if (wasPhone && phoneConnections() === 0) onPhonePresence(false);
  };
  // one write path for both notify() and the heartbeat, with backpressure
  const send = (raw, chunk) => {
    if (backedUp.has(raw)) return;
    let ok = true;
    try { ok = raw.write(chunk); } catch { dropClient(raw); return; }
    if (ok === false) {
      backedUp.add(raw);
      raw.once('drain', () => backedUp.delete(raw));
      // a socket that never drains must not sit in the set forever
      raw.once('close', () => backedUp.delete(raw));
    }
  };
  const browserParam = v => {
    const s = String(v == null ? '' : v).toLowerCase();
    return /^[a-z]{2,16}$/.test(s) ? s : null;
  };

  // FD-exhaustion guard on an open LAN: past the cap, drop the OLDEST — a
  // refresh storm must never exhaust file descriptors.
  app.get('/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 2000\n\n');
    if (sseClients.size >= maxClients) {
      const oldest = sseClients.values().next().value;
      try { oldest.destroy(); } catch {}
      dropClient(oldest);
      logEvent('sse-evict', { clients: sseClients.size });
    }
    clientBrowsers.set(reply.raw, browserParam(req.query && req.query.browser));
    const isPhone = req.query && req.query.device === 'phone';
    const hadPhone = phoneConnections() > 0;
    clientDevices.set(reply.raw, isPhone ? 'phone' : null);
    sseClients.add(reply.raw);
    if (isPhone && !hadPhone) onPhonePresence(true); // phone reached us — presence edge
    req.raw.on('close', () => dropClient(reply.raw));
    reply.raw.on('error', () => dropClient(reply.raw)); // dead sockets leave immediately
  });

  // payload included → clients apply the change WITHOUT refetching anything.
  // type always wins — a payload key can never spoof the event type.
  const notify = (type = 'capture', payload = null) => {
    const data = payload ? JSON.stringify({ ...payload, type }) : type;
    const chunk = `data: ${data}\n\n`;
    for (const res of [...sseClients]) send(res, chunk);
  };

  // heartbeat keeps SSE alive past idle-timeout proxies (comment frames, no
  // events). unref'd: it must never hold the process open on shutdown.
  const heartbeat = setInterval(() => {
    for (const res of [...sseClients]) send(res, ': hb\n\n');
  }, 25000);
  heartbeat.unref();

  // call BEFORE app.close() on the shutdown path (see header comment)
  const destroyAll = () => {
    clearInterval(heartbeat);
    for (const res of [...sseClients]) { try { res.destroy(); } catch {} }
    sseClients.clear();
    clientBrowsers.clear();
    clientDevices.clear();
    backedUp.clear();
  };

  // is a live extension for this browser id connected right now? (drives the
  // autoTarget fallback — see server/browser.js resolveAutoTarget)
  const hasBrowser = id => {
    const want = String(id == null ? '' : id).toLowerCase();
    if (!want) return false;
    for (const b of clientBrowsers.values()) if (b === want) return true;
    return false;
  };

  return { notify, destroyAll, clientCount: () => sseClients.size, hasBrowser };
}
