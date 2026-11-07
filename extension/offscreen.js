// ProofPipe offscreen document — keeps a live SSE connection to the local
// ProofPipe server on behalf of the MV3 service worker, which cannot hold
// long-lived connections while asleep. Every capture event is forwarded to
// the background worker, which routes auto-paste captures to the last-focused
// chat tab. Host rotation: 127.0.0.1 first (localhost can resolve to ::1),
// cycling through all hosts on repeated failures so https servers work too.
// Port discovery: probe loopback candidates and pin the origin whose
// /api/version identifies itself as ProofPipe. Candidate list from the SHARED
// discovery.js (offscreen.html loads it first) — the old private copy had
// drifted from background.js's list.
let pinnedHost = null;
// manual port override (popup pp_port). The background worker honors this on
// every fetch — the relay must too, or a server on an override port gets
// found by the worker but never by the SSE relay (auto-paste dies while
// everything else works). Re-read on connect failures: the user may have
// changed the override while the doc was alive.
let manualPort = null;
let lastOpenedHost = null; // what the live EventSource is pointed at (watchdog reports it)
// this instance's browser id ('chrome' | 'edge', from the shared PPBrowserTarget)
// — reported on the SSE connect so the server can fall back to 'default' when
// the harness's picked browser has no live extension (server/browser.js
// resolveAutoTarget). null on a load where browser-target.js didn't run: the
// relay simply omits the param (server treats it as unknown → no pin).
let myBrowserId = null;
try { myBrowserId = PPBrowserTarget.myBrowserId(navigator.userAgent); } catch {}

// watchdog ping: the background worker probes this every 5 minutes — a doc that
// lost its SSE (or died and got replaced) reports its true state here.
try {
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg && msg.type === 'relayPing') {
      sendResponse({ alive: true, connected: !!es && es.readyState === 1, host: lastOpenedHost });
    }
    return false;
  });
} catch {}
async function isProofPipe(host) {
  try {
    const r = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json();
    return typeof j.version === 'string' && /^v\d/.test(j.version);
  } catch { return false; }
}
// restore the pinned origin + manual port override across offscreen-doc
// reloads, then verify
try {
  chrome.storage?.local?.get(['pp_host', 'pp_port']).then(({ pp_host, pp_port } = {}) => {
    if (pp_host && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(pp_host)) pinnedHost = pp_host;
    manualPort = PPDiscovery.parsePort(pp_port);
  }).catch(() => {});
} catch {}
function candidateHosts() {
  const pinnedPort = pinnedHost ? Number(new URL(pinnedHost).port) || 80 : null;
  return PPDiscovery.candidateHosts(PPDiscovery.candidatePorts({ manualPort, pinnedPort }));
}
// Staged + PARALLEL, shared with background.js via PPDiscovery.probeHosts: the
// old serial walk probed up to ~100 candidates one at a time, 1.5s each on the
// ones that hang, so a port change could leave auto-paste dark for tens of
// seconds (the worker's own discovery was already staged — the relay's private
// copy had drifted). Primary http loopback hosts go first; an answer now costs
// ~one probe timeout instead of the sum of them.
async function findHost() {
  const host = await PPDiscovery.probeHosts(candidateHosts(), isProofPipe);
  if (!host) return null;
  pinnedHost = host;
  try { chrome.storage?.local?.set({ pp_host: host }).catch(() => {}); } catch {}
  return host;
}
let failures = 0;
let failuresResetTimer = null;
let es = null; // the live EventSource (was an implicit global — declared properly)
const seenIds = new Map(); // id -> timestamp; dedupe: each capture pastes exactly once
const SEEN_TTL = 5 * 60_000;
function markSeen(id) {
  seenIds.set(id, Date.now());
  if (seenIds.size > 200) seenIds.delete(seenIds.keys().next().value);
  for (const [k, t] of seenIds) if (Date.now() - t > SEEN_TTL) seenIds.delete(k);
}
const pendingRelay = []; // captures dropped while the SW was unreachable — retried, never lost
let retryDelay = 3000;
function noteSuccess() {
  failures = 0;
  retryDelay = 3000; // backoff resets on a good connection
}

let connecting = false; // single-flight: retry ticks never double-probe
async function connect() {
  if (connecting) return;
  if (es) { try { es.close(); } catch {} es = null; }
  connecting = true;
  try {
    // pinned origin first (re-verified); on miss, probe candidates once
    let host = null;
    if (pinnedHost && await isProofPipe(pinnedHost)) {
      host = pinnedHost;
    } else {
      pinnedHost = null;
      // re-read the override before probing: the popup may have changed or
      // cleared pp_port since this doc woke up
      try { const { pp_port } = await chrome.storage?.local?.get('pp_port') || {}; manualPort = PPDiscovery.parsePort(pp_port); } catch {}
      host = await findHost();
    }
    if (!host) { scheduleRetry(); return; } // server down — keep backing off
    try {
      // identify our browser on the connect (server presence probe for the
      // autoTarget fallback); omitted when unknown, which the server ignores.
      const q = myBrowserId ? `?browser=${encodeURIComponent(myBrowserId)}` : '';
      es = new EventSource(`${host}/events${q}`);
      lastOpenedHost = host;
    } catch {
      scheduleRetry();
      return;
    }
    es.onopen = () => { noteSuccess(); drainPending(); };
    es.onerror = () => {
      // close NOW: a live EventSource auto-retries the SAME url in the
      // background, so during the retry window we'd have two competing
      // connections (the old one reconnecting + the new one we're about to open)
      try { es.close(); } catch {}
      es = null;
      // consecutive failures → drop the pin so the next connect() re-probes
      // all ports (the server may have MOVED, not just gone down)
      failures++;
      if (failures >= 2) pinnedHost = null;
      // failures decay: two drops an hour apart must not re-probe everything
      clearTimeout(failuresResetTimer);
      failuresResetTimer = setTimeout(() => { failures = 0; }, 60000);
      scheduleRetry();
    };
    const onEvent = ev => {
      let data = null;
      try { data = JSON.parse(ev.data); } catch { return; } // plain 'hb'-style events
      // 'capture-ready' = server says the ORIGINAL is available (paste path, no
      // thumb wait). 'capture' = the classic post-thumbnail event. We relay BOTH
      // to the background worker, which is the single place that decides whether
      // to paste (it checks msg.auto). The id guard below makes the
      // (capture-ready + capture) pair for one upload paste exactly ONCE.
      if (!data || (data.type !== 'capture' && data.type !== 'capture-ready')) return;
      const id = data.capture && data.capture.id;
      if (id != null) {
        if (seenIds.has(id)) return; // same capture — never paste twice
        markSeen(id);
      }
      relayToWorker(data).then(ok => { if (ok) drainPending(); });
    };
    es.onmessage = onEvent;
    // named events too, if the server ever emits `event: capture`
    try {
      es.addEventListener('capture', onEvent);
      es.addEventListener('capture-ready', onEvent);
    } catch {}
  } finally {
    connecting = false;
  }
}

// Single delivery path: a failed send is queued ONCE and retried by the
// drain loop. The old code ran two competing mechanisms — a queue re-sent on
// the next SSE open AND a per-event retry chain — and a queued copy was never
// removed when its retry chain succeeded, so one capture could be delivered
// (and auto-pasted) TWICE. Now: enqueue on failure, drain strictly in order,
// dequeuing only after a confirmed send.
let draining = false; // single-flight: one drain at a time, events stay ordered
// `fromQueue`: the item is ALREADY in pendingRelay — a failed send must not
// push it again (that duplicated + reordered the queue on every failed drain)
async function sendToWorker(data) {
  try {
    await chrome.runtime.sendMessage({
      type: 'sseCapture',
      capture: data.capture,
      auto: data.auto === true,
      // the SW's browser gate needs this: a Chrome instance must ignore an
      // event tagged for Edge and vice versa (else double-paste). Carried
      // through untouched — the relay never decides, it only forwards.
      autoTarget: data.autoTarget,
    });
    return true;
  } catch {
    return false;
  }
}
async function relayToWorker(data) {
  const ok = await sendToWorker(data);
  if (!ok) {
    // worker throttled/asleep — queue durably instead of dropping
    pendingRelay.push(data);
    if (pendingRelay.length > 50) pendingRelay.shift();
  }
  return ok;
}
async function drainPending() {
  if (draining) return; // an in-flight drain already owns the queue
  draining = true;
  try {
    while (pendingRelay.length) {
      const ok = await sendToWorker(pendingRelay[0]);
      if (!ok) break; // worker still down — retry on the next open/tick
      pendingRelay.shift(); // delivered — only now drop it from the queue
    }
  } finally {
    draining = false;
  }
}
// wake the drain on a timer while items sit queued (worker may have woken
// without a new SSE event). Idempotent + single-flight, so extra ticks are free.
setInterval(drainPending, 5000);

function scheduleRetry() {
  if (es) { try { es.close(); } catch {} es = null; }
  // backoff with jitter: thundering reconnects don't hammer the server
  const wait = Math.min(30000, retryDelay + Math.random() * 1000);
  retryDelay = Math.min(30000, retryDelay * 1.5);
  setTimeout(() => connect().catch(() => { connecting = false; }), wait);
}

connect().catch(() => { connecting = false; });
