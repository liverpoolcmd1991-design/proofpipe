// server/ratelimit.js — per-IP token buckets, extracted from server.js.
// One bucket map per traffic class (photos vs. file transfers) so a big
// file batch can never starve photo uploads and vice versa. In-memory is
// fine for a single-host tool; the IP normalization strips the IPv4-mapped
// IPv6 prefix so 127.0.0.1 isn't two separate buckets.
// No imports: the stale-bucket sweep intervals are unref'd here.
export function createTokenBucket({ capacity, refillPerMin, sweepMs = 10 * 60_000, logEvent = () => {}, kind = '' } = {}) {
  const buckets = new Map(); // ip -> { tokens, last }

  // stale-bucket sweep — only dead entries; clearing active buckets granted
  // every live client a fresh full-capacity burst every sweep
  setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) if (now - b.last > sweepMs) buckets.delete(ip);
  }, sweepMs).unref();

  function allow(rawIp) {
    const ip = String(rawIp || '').replace(/^::ffff:/, '');
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b) { b = { tokens: capacity, last: now }; buckets.set(ip, b); }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 60000) * refillPerMin);
    b.last = now;
    if (b.tokens < 1) { logEvent('rate-limited', { ip, kind }); return false; }
    b.tokens -= 1;
    return true;
  }

  return { allow };
}
