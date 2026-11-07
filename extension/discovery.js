// ProofPipe extension — shared port-discovery helpers (pure, no fetches).
// Loaded by background.js via importScripts (classic SW scope), by popup.html
// as a script tag, and by test/extension-logic.test.js via node:vm. Must stay
// a classic script (no import/export): MV3 service workers don't module-load
// from plain files, and the popup shares the same contract.
//
// Extracted because background.js and popup.js had drifted into two private
// copies of the probe list (different ports, different order) — one answered,
// the other guessed. This is the single source of both.
const PPDiscovery = (() => {
  const DEFAULT_PORT = 8787;
  // secondary sweep: a bounded range around the default catches PORT=N runs
  // (8788, 8790, 8799…) without an unbounded port scan
  const SCAN_RANGE = { from: 8780, to: 8800 };
  // legacy favorites kept from the old probe list (apps that commonly sit there)
  const EXTRA_PORTS = [8080, 3000, 5000];
  const HOST_TPLS = ['http://127.0.0.1:PORT', 'http://localhost:PORT', 'https://127.0.0.1:PORT', 'https://localhost:PORT'];

  // manual-port override validation: integer 1..65535, else null. Accepts
  // strings (input field) and numbers (storage), refuses 0/NaN/negatives —
  // a typo must fall back to discovery, never to port 0 or undefined.
  function parsePort(v) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 65535) return null;
    return n;
  }

  // ordered, deduped port list: manual override → last known good → default →
  // scan range (ascending) → extras. Bounded at 40 by construction
  // (3 + 21 + 3); never grows with use.
  function candidatePorts({ manualPort = null, pinnedPort = null } = {}) {
    const scan = [];
    for (let p = SCAN_RANGE.from; p <= SCAN_RANGE.to; p++) scan.push(p);
    return [...new Set([manualPort, pinnedPort, DEFAULT_PORT, ...scan, ...EXTRA_PORTS]
      .map(p => parsePort(p))
      .filter(p => p != null))];
  }

  // full origin candidates for a port list, template order preserved
  function candidateHosts(ports) {
    return ports.flatMap(p => HOST_TPLS.map(t => t.replace('PORT', String(p))));
  }

  // Plain-http loopback with an explicit port — the overwhelmingly common case
  // (ProofPipe.bat on 127.0.0.1:8787). http/https + localhost/127.0.0.1 are the
  // only shapes the server ever answers on, and the https/no-port variants are
  // what make a full sweep slow.
  function primaryHost(host) {
    return /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(host);
  }

  // How many LEADING ports get the fast path. candidatePorts() puts the manual
  // override, the last known good and the default first, so the first three
  // ports are the ones that matter in practice.
  const PRIORITY_PORTS = 3;

  // Probe candidates for the FIRST host that identifies as ProofPipe.
  // Staged: (1) the priority ports' plain-http loopback hosts — 6 probes for
  // manual/pinned/default, the overwhelmingly common ProofPipe.bat case;
  // (2) the remaining loopback hosts (the 8780–8800 scan + extras); (3) the
  // slow matrix (https variants). Each stage is fully PARALLEL with the caller's
  // short per-probe timeout, and a later stage only runs if every earlier one
  // missed — so the common case costs 6 requests instead of the whole ~52-host
  // sweep, and a server on a scanned port was never slow. `probe(host)` resolves
  // to a truthy value for a real ProofPipe origin.
  // Shared so background.js, offscreen.js and the popup can't drift into private
  // copies with different staging (they did once already).
  async function probeHosts(hosts, probe, { stages = 'both', priorityPorts = PRIORITY_PORTS } = {}) {
    const list = hosts || [];
    const primeCount = Math.max(0, priorityPorts) * HOST_TPLS.length;
    const prime = list.slice(0, primeCount);
    const rest = list.slice(primeCount);
    const groups = stages === 'primary-only'
      ? [prime.filter(primaryHost), rest.filter(primaryHost)]
      : [prime.filter(primaryHost), rest.filter(primaryHost), list.filter(h => !primaryHost(h))];
    for (const stage of groups) {
      if (!stage.length) continue;
      try {
        return await Promise.any(stage.map(async h => {
          const hit = await probe(h);
          if (hit) return h;
          throw new Error('not proofpipe');
        }));
      } catch { /* stage exhausted — try the next */ }
    }
    return null;
  }

  return {
    DEFAULT_PORT, SCAN_RANGE, EXTRA_PORTS, HOST_TPLS,
    parsePort, candidatePorts, candidateHosts, primaryHost, probeHosts,
  };
})();
if (typeof self !== 'undefined') self.PPDiscovery = PPDiscovery;
