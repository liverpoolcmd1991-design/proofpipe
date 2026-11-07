// ProofPipe phone PWA — pure offline-queue policy (no DOM, no fetch, no IDB).
// Extracted from phone.js so the retry rules that govern all three offline
// queues (photo outbox, text queue, file queue) can be unit-tested without a
// browser: test/queue.test.js loads this file through node:vm.
//
// Classic script (phone.js has no bundler; the test VM shares the file).
const PPQueue = (() => {
  // exponential backoff between automatic flush attempts: 5s, 10s, 20s …
  // capped at 5min. tries=0 → 5s.
  const backoffMs = tries => Math.min(5 * 60_000, 5_000 * 2 ** (tries || 0));

  // POISON marker: a 413/415 answer means the server can NEVER accept the
  // item (too large / not an image). The item stays in the queue — the count
  // and tap-to-clear UI stay honest — but flush workers must never re-send it.
  const POISON_TRIES = 999;

  // Decision for one queue item at flush time, given the policy state.
  // Returns:
  //   'skip-poison'  — marked never-accepted, keep visible, don't send
  //   'skip-backoff' — still cooling down from a previous failure
  //   'skip-inflight'— a manual retry owns this item right now
  //   'send'         — attempt the upload/post now
  function decide(item, { now = Date.now(), inflight = false } = {}) {
    const { tries = 0, lastAttempt = 0 } = item || {};
    if (tries >= POISON_TRIES) return 'skip-poison';
    if (inflight) return 'skip-inflight';
    if (now - (lastAttempt || 0) < backoffMs(tries)) return 'skip-backoff';
    return 'send';
  }

  // Outcome bookkeeping after a send attempt failed with `status`.
  // Returns the fields to persist over the stored item:
  //   poisoned: true        → set tries = POISON (never retried again)
  //   rateLimitedMs: number → EVERYONE in the queue should pause this long
  //                           (the shared token bucket needs to refill)
  //   otherwise             → tries + 1, lastAttempt = now (exponential backoff)
  // 413 = file too large: the server can NEVER accept it — poison.
  // 415 used to poison too, but "not a supported image" is not always forever:
  // an older server build may lack a format (e.g. HEIC) a newer one accepts,
  // and a sharp decode can fail transiently. Back off and retry instead —
  // capped at one attempt per 5 min, and a manual retry is always available.
  // A permanent 415 just retries at a slow trickle; a fixable one recovers
  // itself after a server update with zero user action.
  function onFailure(item, status, { now = Date.now() } = {}) {
    const tries = (item && item.tries) || 0;
    if (status === 413) return { tries: POISON_TRIES, lastAttempt: now, poisoned: true };
    if (status === 429) return { tries: tries + 1, lastAttempt: now, rateLimitedMs: 1500 };
    return { tries: tries + 1, lastAttempt: now };
  }

  // Text queue capacity policy (localStorage queue): keep the newest N.
  // Full cap first; if storage is full (QuotaExceeded), a reduced cap still
  // preserves the newest messages rather than losing the whole queue.
  const TEXT_CAP = 20;
  const TEXT_CAP_REDUCED = 5;
  function trimTexts(queue) {
    return Array.isArray(queue) ? queue.slice(-TEXT_CAP) : [];
  }
  function trimTextsFallback(queue) {
    return Array.isArray(queue) ? queue.slice(-TEXT_CAP_REDUCED) : [];
  }

  // One-time migration for items poisoned under the OLD policy, where a 415
  // ("not a supported image") ALSO set tries = POISON. 413 is still terminal —
  // the file genuinely can never fit — but a 415 can become fixable: a newer
  // server build accepts the format (the HEIC case), or the rejection was a
  // transient decode failure. Returns the fields to persist, or null to leave
  // the item untouched.
  //   tries 999 → 0 (eligible for immediate retry on the next flush)
  function unpoison(item) {
    if (!item || (item.tries || 0) < POISON_TRIES) return null;
    // no server-provided reason is stored, so the terminal-vs-fixable split is
    // the size: items the server measured as over the cap stay poisoned;
    // everything else gets its life back. Oversized blobs re-fail as 413 on
    // the first flush attempt and re-poison — one wasted request, no data loss.
    if (item.poisonReason === 'too-large') return null;
    return { tries: 0, lastAttempt: 0 };
  }

  // Ordered flush plan: which keys to send now, in queue order. Pure so tests
  // can assert exact ordering — one bad head must never block the queue
  // behind it (that bug shipped: a cooling head stopped everything behind it).
  function planFlush(items, { now = Date.now(), inflightKeys = [] } = {}) {
    const inflight = new Set(inflightKeys || []);
    const send = [];
    const keep = [];
    for (const it of items || []) {
      const d = decide(it.value, { now, inflight: inflight.has(it.key) });
      if (d === 'send') send.push(it.key);
      else keep.push(it.key);
    }
    return { send, keep };
  }

  return { backoffMs, POISON_TRIES, decide, onFailure, TEXT_CAP, TEXT_CAP_REDUCED, trimTexts, trimTextsFallback, planFlush, unpoison };
})();
if (typeof self !== 'undefined') self.PPQueue = PPQueue;
