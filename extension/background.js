// ProofPipe background service worker.
// All ProofPipe-server fetches happen here: extension contexts honor
// host_permissions, so localhost requests from web pages would be blocked
// by CORS/mixed-content — content script and popup route through here.
// Port discovery: the server may run on any port (PORT env override), so we
// probe loopback candidates for /api/version (ProofPipe answers {version}) and
// pin the origin that identifies itself as ProofPipe. The candidate list and
// port parsing live in discovery.js (shared with the popup + tests).
// Order: manual override (pp_port in storage, set from the popup) → last known
// good → 8787 → 8780–8800 scan → extras. The sweep is PARALLEL with a short
// timeout: the old serial walk could take ~70s worst case; now the answer
// arrives in ~one timeout, whichever port answers first.
importScripts('discovery.js');
importScripts('browser-target.js');
importScripts('files.js'); // PPFiles — the shared /media filename guard
const DEFAULT_PORT = PPDiscovery.DEFAULT_PORT;
let goodHost = null; // full origin incl. port, e.g. http://127.0.0.1:8791
let manualPort = null; // user-set port override (storage pp_port), probed first
let discoveryPromise = null; // single-flight: concurrent callers share one scan
let forceFullScan = false; // set by explicit "Sync now"/port override — one-shot full re-scan

function candidates() {
  const pinnedPort = goodHost ? Number(new URL(goodHost).port) || 80 : null;
  return PPDiscovery.candidateHosts(PPDiscovery.candidatePorts({ manualPort, pinnedPort }));
}

async function isProofPipe(host) {
  try {
    const r = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json();
    return typeof j.version === 'string' && /^v\d/.test(j.version); // e.g. "v1.9.8"
  } catch { return false; }
}

// find (or re-find) the server. Resolves to the pinned origin or null.
// STAGED to cut the probe storm: the old single Promise.any fired ~27 ports ×
// 4 host templates = ~108 fetches at once. Stage 1 is just the plain-http
// loopback hosts for the pinned/manual/default ports (the overwhelmingly
// common case — ProofPipe.bat on 127.0.0.1) — 4–6 fetches. Both stages are
// PARALLEL within themselves, and the staging itself now lives in discovery.js
// (PPDiscovery.probeHosts) because offscreen.js had its own serial copy.
//
// QUICK path for AUTOMATIC fetches: stage-1 hosts only. It never fires the
// broad 4-template matrix — an auto-triggered ~108-fetch sweep is needless
// noise on a LAN and reads like a network scanner. The full matrix is reserved
// for an EXPLICIT user refresh ("Sync now" / port override), so discovery is
// on-demand rather than a blanket scan on every cold start.
async function discoverQuick() {
  return PPDiscovery.probeHosts(candidates(), isProofPipe, { stages: 'primary-only' });
}
// FULL path (explicit refresh only): stage 1, then the whole matrix (https
// variants + the scan range + extras).
async function discover() {
  return PPDiscovery.probeHosts(candidates(), isProofPipe);
}

// The pinned origin is re-verified at most once per VERIFY_TTL. ensureHost()
// runs on EVERY serverFetch, and the old unconditional `await isProofPipe`
// added an /api/version round-trip in front of every real request — the tray
// polls every 3s while open, so the pin alone doubled its traffic.
// Invalidation: a NETWORK failure clears the pin + stamp (the server may have
// MOVED), while an HTTP error status does not — the server is demonstrably
// there, so a 404 must not trigger a re-discovery sweep.
const VERIFY_TTL = 45_000;
let verifiedAt = 0;
async function ensureHost(full) {
  if (goodHost && Date.now() - verifiedAt < VERIFY_TTL) return goodHost;
  if (goodHost && await isProofPipe(goodHost)) { verifiedAt = Date.now(); return goodHost; }
  goodHost = null;
  const useFull = full || forceFullScan;
  if (useFull) forceFullScan = false; // one-shot: a failed explicit sync must not make every later auto fetch sweep
  if (!discoveryPromise) {
    discoveryPromise = (useFull ? discover() : discoverQuick())
      .finally(() => { discoveryPromise = null; });
  }
  const found = await discoveryPromise;
  if (found) {
    goodHost = found;
    verifiedAt = Date.now();
    try {
      const store = chrome.storage && chrome.storage.local;
      if (store) store.set({ pp_host: found }).catch(() => {});
    } catch {}
  }
  return goodHost;
}

// manual port override: probed FIRST on every discovery, and survives SW
// restarts (chrome.storage.local). An invalid stored value is ignored.
try {
  const store = chrome.storage && chrome.storage.local;
  if (store) store.get('pp_port').then(({ pp_port } = {}) => {
    const p = PPDiscovery.parsePort(pp_port);
    if (p != null) manualPort = p;
  }).catch(() => {});
} catch {}

// Every request is BOUNDED. The extension had no fetch timeout anywhere: a
// half-open LAN connection left the popup on "Loading…" and the tray stale
// forever, with no error path (the harness's api() has always had one). 15s
// covers media blobs too — /media rides this same path, and a multi-MB photo
// over slow Wi-Fi is legitimately slow; JSON answers long before that.
const FETCH_TIMEOUT_MS = 15000;
async function serverFetch(path, init) {
  // discovery first: pinned origin (TTL-verified) or a probe scan. Only a
  // ProofPipe-identified origin is ever pinned, so a foreign app on a lucky
  // port can never hijack the extension.
  const pinned = await ensureHost();
  if (!pinned) throw new Error('unreachable — ProofPipe server not found on any loopback port (start ProofPipe.bat)');
  const opts = { ...(init || {}) };
  if (!opts.signal) opts.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(pinned + path, opts);
  } catch (e) {
    // network-level failure (refused / reset / timed out) — the pin may be dead
    // or stale, so drop it; the next call re-discovers instead of retrying it
    goodHost = null;
    verifiedAt = 0;
    throw e;
  }
  if (!r.ok) throw new Error('http ' + r.status);
  return r;
}
// restore pinned host across SW suspends (in-memory goodHost is lost on wake).
// Stored in chrome.storage.local (survives browser restarts, not just SW idle).
try {
  const store = chrome.storage && chrome.storage.local;
  if (store) store.get('pp_host').then(({ pp_host } = {}) => {
    if (pp_host && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(pp_host)) goodHost = pp_host;
  }).catch(() => {});
} catch {}

async function fetchJSON(path) {
  return (await serverFetch(path)).json();
}

async function fetchDataUrl(path) {
  const blob = await (await serverFetch(path)).blob();
  return new Promise((res, rej) => {
    const f = new FileReader();
    f.onload = () => res(f.result);
    f.onerror = () => rej(f.error || new Error('read failed'));
    f.readAsDataURL(blob);
  });
}

// in-flight / landed prefetch blobs (file name -> Promise<Blob>). Auto-paste
// needs the image bytes a beat later, not immediately — starting the fetch as
// soon as a paste TARGET is known (instead of when the content script asks)
// hides the LAN round-trip behind the message hop + paste dispatch.
// It deliberately starts after routing resolves, not on the capture event: a
// capture with nowhere to paste would otherwise pull a full-size image off the
// server for nothing.
// Bounded: entries are dropped once consumed.
const prefetch = new Map();
function prefetchBlob(capture) {
  const file = capture && typeof capture.file === 'string' ? capture.file : '';
  if (!PPFiles.valid(file) || prefetch.has(file)) return;
  const p = (async () => {
    const pinned = await ensureHost();
    if (!pinned) throw new Error('unreachable');
    const r = await fetch(`${pinned}/media/${encodeURIComponent(file)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) throw new Error('http ' + r.status);
    return r.blob();
  })();
  prefetch.set(file, p);
  p.catch(() => {}).finally(() => {
    // keep the landed blob ~30s so the content script's request finds it,
    // then drop — the cache must never grow with gallery-sized histories.
    // A FAILED fetch must drop its entry too: a burst of captures while the
    // server is down (or the pinned origin went stale) would otherwise
    // accumulate one dead promise per capture that nothing ever removed.
    setTimeout(() => prefetch.delete(file), 30_000).unref?.();
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'resetHost') {
        goodHost = null;
        verifiedAt = 0;
        // explicit user action — allow the broad re-scan (auto fetches stay on
        // the cheap stage-1 path; only a deliberate refresh sweeps the matrix)
        forceFullScan = true;
        // re-read the override: the popup may have changed or cleared it
        // since this SW instance woke up
        try { chrome.storage?.local?.get('pp_port').then(({ pp_port } = {}) => { manualPort = PPDiscovery.parsePort(pp_port); }).catch(() => {}); } catch {}
        try { chrome.storage?.local?.remove('pp_host').catch(() => {}); } catch {}
        return sendResponse({ ok: true });
      }
      if (msg.type === 'getHost') return sendResponse({ host: goodHost });
      if (msg.type === 'captures') return sendResponse(await fetchJSON('/api/captures'));
      // tiny fingerprint: the tray polls every 3s while open and only needs the
      // full list when something actually changed (same pattern as the harness
      // and the phone's loadRecent)
      if (msg.type === 'capturesVersion') return sendResponse(await fetchJSON('/api/captures/version'));
      // The CALLER owns the row count: content.js passes one TEXTS_LIMIT so the
      // relay and the page-side fallback cannot show different lists (they used
      // to hardcode 10 and 5). The server caps at 20 regardless.
      if (msg.type === 'texts') {
        const limit = Math.min(20, Math.max(1, Number(msg.limit) || 10));
        return sendResponse(await fetchJSON(`/api/text?source=phone&limit=${limit}`));
      }
      if (msg.type === 'sendText') return sendResponse(await postText(String(msg.body || '').slice(0, 10000)));
      if (msg.type === 'dataUrl') {
        const file = String(msg.file || '');
        // unsanitized filenames from content-script context (../, abs URL) stay out
        if (!PPFiles.valid(file)) return sendResponse({ error: 'bad filename' });
        return sendResponse(await fetchDataUrl(`/media/${encodeURIComponent(file)}`));
      }
      if (msg.type === 'mediaBlob') {
        // real Blob over the message channel (structured clone) — the SW's
        // fetches carry host_permissions, so this path is immune to page-level
        // Local-Network-Access blocks that kill the content script's direct
        // fetch on public https sites (the main auto-paste failure mode).
        // No base64 inflation: a Blob travels as-is, unlike the dataUrl path.
        const file = String(msg.file || '');
        if (!PPFiles.valid(file)) return sendResponse({ error: 'bad filename' });
        // prefetch hit? (the fetch started when auto-paste routing resolved a
        // target — see prefetchBlob). Awaiting the promise resolves instantly if
        // it already landed; if still in flight we simply join it.
        const pre = prefetch.get(file);
        if (pre) {
          try { return sendResponse({ blob: await pre }); }
          catch { prefetch.delete(file); } // prefetch failed — fall through to a fresh fetch
        }
        const blob = await (await serverFetch(`/media/${encodeURIComponent(file)}`)).blob();
        return sendResponse({ blob });
      }
      if (msg.type === 'sseCapture') {
        // from the offscreen SSE relay; auto-paste captures go to the last chat tab.
        // Browser gate: the server tags every auto event with `autoTarget`
        // (settings.browser). A non-matching instance (e.g. Chrome while the
        // pick is Edge) stands down so the capture pastes exactly once, in the
        // selected browser. Missing tag = pre-tag server → paste (back-compat).
        if (msg.auto && msg.capture) {
          let myId = 'chrome';
          try { myId = PPBrowserTarget.myBrowserId(navigator.userAgent); } catch {}
          if (!PPBrowserTarget.shouldAutoPaste(msg.autoTarget, myId)) return sendResponse({ ok: true, skipped: 'browser-target' });
          await routeAutoPaste(msg.capture).catch(() => {});
        }
        return sendResponse({ ok: true });
      }
      sendResponse({ error: 'unknown message' });
    } catch (e) {
      sendResponse({ error: String((e && e.message) || e) });
    }
  })();
  return true; // async response
});

// ---------- send selected text to the phone ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'pp-send-text',
    title: 'Send to phone via ProofPipe',
    contexts: ['selection'],
  });
});

async function postText(body) {
  // shared host-probing path: reuses (and pins) goodHost instead of re-probing
  // all four hosts on every send
  return (await serverFetch('/api/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, source: 'pc' }),
  })).json();
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'pp-send-text' || !info.selectionText) return;
  const ok = await postText(info.selectionText.slice(0, 10000)).then(() => true).catch(() => false);
  const note = ok ? 'ProofPipe: text sent to phone ✓' : 'ProofPipe: server not reachable — start ProofPipe.bat';
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: n => {
        const d = document.createElement('div');
        d.textContent = n;
        d.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#17181a;color:#e8e8e6;border:1px solid #2a2c2f;border-radius:999px;padding:8px 18px;font:13px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);';
        document.documentElement.appendChild(d);
        setTimeout(() => d.remove(), 2500);
      },
      args: [note],
    });
  } catch {}
});

// ---------- auto-paste: offscreen SSE relay + last-chat-tab routing ----------
// The offscreen document holds the /events SSE connection (service workers
// can't). Capture events with auto:true are pasted into the last web tab the
// user had focused — a synthetic 'paste' event there, no OS keystrokes needed,
// so it works even when Chrome itself isn't the foreground app.
const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen = null;
async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
  } catch {} // hasDocument unavailable on very old Chrome — fall through
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['DOM_SCRAPING'],
      justification: 'Keeps a live connection to the local ProofPipe server so phone captures auto-paste the moment they arrive.',
    }).catch(e => {
      // parallel wake-ups race createDocument ("only one document allowed") —
      // that means it EXISTS, which is success
      const soft = String((e && e.message) || e).match(/only|exist|single/i);
      if (!soft) throw e;
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

// internal pages can never be paste targets — AND neither can the ProofPipe
// harness itself: pasting into it re-uploads the capture, which fires another
// auto SSE event, which gets pasted again... a self-feeding loop that spawns
// duplicate captures (this exact bug: 1 photo -> 5 "empty" extra captures)
const BAD_TARGET_URL = /^(chrome|edge|about|devtools|view-source|chrome-extension|chrome-untrusted):/;
const SERVER_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i; // any local server origin
// the pinned (or default) ProofPipe origin — the harness must never be a paste
// target regardless of which port it runs on
function isPinnedServerUrl(url) {
  try {
    const u = new URL(url);
    if (!/^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(u.hostname.replace(/^\[|\]$/g, ''))) return false;
    // portless pinned origin means the DEFAULT scheme port (80/443) —
    // Number('') is 0, which would never match anything
    const portOf = u => Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    const pinned = goodHost ? portOf(new URL(goodHost)) : DEFAULT_PORT;
    return portOf(u) === pinned;
  } catch { return false; }
}
// "alarms" is a REQUIRED manifest permission. Without it chrome.alarms is
// undefined, and every timer here (badge clear + the relay watchdog) silently
// no-ops — the failure mode is exactly the invisible-relay death PITFALLS #2
// warns about. Warn loudly ONCE so a future permission regression shows up in
// the service-worker console instead of disappearing.
let warnedNoAlarms = false;
function alarmsApi() {
  if (chrome.alarms) return chrome.alarms;
  if (!warnedNoAlarms) {
    warnedNoAlarms = true;
    console.warn('ProofPipe: chrome.alarms unavailable — add "alarms" to manifest.json permissions (relay watchdog disabled)');
  }
  return null;
}
function clearBadgeSoon() {
  // alarms survive SW idle; setTimeout is the degraded fallback when the API
  // is genuinely missing (see alarmsApi)
  const alarms = alarmsApi();
  if (alarms) {
    try {
      alarms.clear('pp_badge').catch(() => {}).finally(() => {
        alarms.create('pp_badge', { when: Date.now() + 6000 });
      });
      return;
    } catch {}
  }
  setTimeout(() => { chrome.action.setBadgeText({ text: '' }).catch(() => {}); }, 6000);
}
try {
  alarmsApi()?.onAlarm.addListener(a => {
    if (a && a.name === 'pp_badge') chrome.action.setBadgeText({ text: '' }).catch(() => {});
  });
} catch {}
// the "capture arrived but had nowhere to paste" nudge — was duplicated in
// both routeAutoPaste failure branches
async function nudgeBadge() {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    await chrome.action.setBadgeText({ text: '1' });
    clearBadgeSoon();
  } catch {}
}
function normHost(h) { return String(h || '').replace(/^\[|\]$/g, ''); } // '[::1]' vs '::1'
function isBadTargetUrl(url) {
  if (!url || BAD_TARGET_URL.test(url)) return true;
  if (SERVER_URL.test(url)) return true;
  if (isPinnedServerUrl(url)) return true; // any-port-aware harness check
  try {
    const u = new URL(url);
    // IPv6 loopback normalizes differently per browser — catch both spellings
    if (normHost(u.hostname) === '::1') return true;
  } catch { return false; }
  return false;
}
let lastChatTab = null; // { id, windowId }
// MV3: the SW idles out after ~30s and module state dies with it — the tab
// the user had focused would be forgotten exactly when a phone snap arrives.
// storage.session survives SW restarts (cleared when the browser closes), so
// the routing decision is made from the tab the user ACTUALLY had open.
const TAB_STORE_KEY = 'pp_last_tab';
try {
  chrome.storage?.session?.get(TAB_STORE_KEY).then(({ [TAB_STORE_KEY]: t } = {}) => {
    if (t && typeof t.id === 'number') lastChatTab = t;
  }).catch(() => {});
} catch {}
async function rememberTab(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (isBadTargetUrl(t.url)) return;
    lastChatTab = { id: t.id, windowId: t.windowId };
    try { chrome.storage?.session?.set({ [TAB_STORE_KEY]: lastChatTab }).catch(() => {}); } catch {}
  } catch {} // tab closed mid-query — ignore
}

chrome.tabs.onActivated.addListener(({ tabId }) => rememberTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // refresh on navigation: the previously-good tab may now be a chrome:// page
  if (info.status === 'complete' && lastChatTab && lastChatTab.id === tabId) rememberTab(tabId);
});
chrome.windows.onFocusChanged.addListener(async winId => {
  // WINDOW_ID_NONE = Chrome lost OS focus — keep the last known chat tab,
  // that's exactly the tab auto-paste should hit when a photo arrives
  if (winId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [t] = await chrome.tabs.query({ active: true, windowId: winId });
    if (t) rememberTab(t.id);
  } catch {}
});

async function tabAlive(id) {
  try { await chrome.tabs.get(id); return true; } catch { return false; }
}

// Known chat sites for the fallback routing path. Editable: chrome.storage.sync
// key 'pp_chat_sites' (newline/comma-separated host suffixes) overrides this
// list — a new chat product or a company-internal host must not require an
// extension update. (A domain moved once already: chat.openai.com → chatgpt.com.)
const DEFAULT_CHAT_SITES = ['claude.ai', 'chatgpt.com', 'chat.openai.com', 'gemini.google.com', 'perplexity.ai', 'chat.mistral.ai', 'deepseek.com'];
let chatSites = null; // lazy cache; null = not loaded yet
function parseChatSites(v) {
  if (typeof v !== 'string') return null;
  const list = v.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : null; // empty override = fall back to defaults
}
try {
  chrome.storage?.sync?.get('pp_chat_sites').then(({ pp_chat_sites } = {}) => { chatSites = parseChatSites(pp_chat_sites); }).catch(() => {});
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'sync' && changes.pp_chat_sites) chatSites = parseChatSites(changes.pp_chat_sites.newValue);
  });
} catch {}
function isChatHost(hostname) {
  const sites = chatSites || DEFAULT_CHAT_SITES;
  const h = String(hostname || '').toLowerCase();
  return sites.some(s => h === s || h.endsWith('.' + s));
}

async function routeAutoPaste(capture) {
  let target = lastChatTab;
  if (!target || !(await tabAlive(target.id))) {
    // last-known tab is gone (fresh SW + cold storage.session) — prefer a
    // known chat site in any window before falling back to the active tab
    try {
      const tabs = await chrome.tabs.query({ active: true });
      const chat = tabs.find(t => { try { return isChatHost(new URL(t.url || '').hostname); } catch { return false; } });
      if (chat && !isBadTargetUrl(chat.url || '')) target = { id: chat.id, windowId: chat.windowId };
      else {
        const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (t && !isBadTargetUrl(t.url || '')) target = { id: t.id, windowId: t.windowId };
      }
    } catch {}
  }
  if (!target || !(await tabAlive(target.id))) {
    // nowhere to paste — badge as a nudge; the tray still shows the capture
    await nudgeBadge();
    return;
  }
  // Start the media fetch HERE rather than when the capture event arrived: it
  // still races the tab's mediaBlob request (that one only begins after this
  // message lands, and the fetch is already in flight), but a capture with
  // nowhere to paste no longer pulls a full-size image off the server for
  // nothing.
  prefetchBlob(capture);
  try {
    await chrome.tabs.sendMessage(target.id, { type: 'autoPaste', capture });
  } catch {
    // no content script there (e.g. loaded before the extension) — badge nudge
    await nudgeBadge();
  }
}

// ensure the SSE relay exists as soon as the worker starts (install/startup)
ensureOffscreen().catch(() => {});

// ---------- relay watchdog ----------
// The offscreen doc holds the SSE connection, but it can die silently:
// crashed document, Chrome killing it, or a server that moved ports. The
// relay used to fail with NO trace at all — the pipeline just vanished.
// Every 5 minutes: check the doc exists AND answers a ping; recreate on
// failure. (This is insurance against Chrome silently killing the doc — the
// relay itself already detects and recovers from SSE drops via onerror, so a
// 1-minute cadence bought nothing but extra wake-ups of the service worker.)
try {
  const alarms = alarmsApi();
  if (!alarms) throw new Error('alarms permission missing');
  alarms.create('pp_relay_watchdog', { periodInMinutes: 5, delayInMinutes: 1 });
  alarms.onAlarm.addListener(a => {
    if (!a || a.name !== 'pp_relay_watchdog') return;
    (async () => {
      try {
        await ensureOffscreen();
        const alive = await Promise.race([
          chrome.runtime.sendMessage({ type: 'relayPing' }).catch(() => null),
          new Promise(res => setTimeout(() => res(null), 3000)),
        ]);
        if (alive && alive.alive) return;
        // unresponsive doc — tear it down and let the next wake rebuild it
        try { await chrome.offscreen.closeDocument(); } catch {}
        await ensureOffscreen();
      } catch {
        // watchdog failures self-correct on the next alarm tick
      }
    })();
  });
} catch {}
