// ProofPipe extension — shared browser-target helpers (pure, no chrome.*).
// Loaded by background.js via importScripts, by offscreen.html as a script
// tag, and by test/extension-logic.test.js via node:vm. Must stay a classic
// script (no import/export): MV3 service workers don't module-load from
// plain files, and every context shares the same contract.
//
// Why this exists: the PC harness "Open harness in" pick (settings.browser)
// used to drive ONLY the .bat launcher — auto-paste always fired in
// whichever Chromium had the extension, ignoring the pick. The server now
// tags every auto SSE event with `autoTarget` (the settings.browser value),
// and each extension instance pastes only when the tag names it.
const PPBrowserTarget = (() => {
  // Every id the harness "Open harness in" pick can hold that is a
  // CHROMIUM-family browser (server/browser.js CANDIDATES) — i.e. one where
  // this very MV3 extension loads and works. Their user agents are
  // indistinguishable from Chrome (Brave hides its token entirely; Opera adds
  // "OPR/", Vivaldi "Vivaldi", Chromium "Chromium" — all still report the
  // Chrome/… token and run the same extension), so a pick naming ANY of them
  // must be served by the same instance family the Chrome extension runs in.
  const CHROMIUM_PICKS = new Set(['chrome', 'brave', 'opera', 'vivaldi', 'chromium']);

  // Which browser is THIS extension instance running in? Edge's UA contains
  // "Edg/" (desktop) — everything else Chromium-shaped counts as 'chrome'.
  function myBrowserId(ua) {
    return /Edg\//i.test(String(ua || '')) ? 'edge' : 'chrome';
  }

  // Should THIS instance paste an event tagged with `target`?
  // - missing/empty (pre-tag servers) → paste (back-compat, old behavior)
  // - 'default' → paste in ANY Chromium instance. The OS default browser is
  //   not visible to an extension, so 'default' can't name one winner; with
  //   the extension in both Chrome AND Edge this double-pastes — pick an
  //   explicit browser in Settings to disambiguate (documented in README).
  // - 'edge' → only the Edge instance pastes (Chrome stands down, and vice
  //   versa for a 'chrome' pick).
  // - any other Chromium harness pick (brave/opera/vivaldi/chromium) → the
  //   chrome-family instance, exactly like a 'chrome' pick. These used to
  //   fall through to `false` for BOTH instances, which tagged every auto SSE
  //   event with an id no extension matched and killed auto-paste outright.
  // - anything else (e.g. 'firefox' — no extension exists there) → nowhere.
  function shouldAutoPaste(target, myId) {
    if (target == null || target === '') return true;
    const t = String(target).toLowerCase();
    if (t === 'default') return true;
    const me = String(myId || '').toLowerCase();
    if (t === 'edge') return me === 'edge';
    if (CHROMIUM_PICKS.has(t)) return me === 'chrome';
    return false;
  }

  return { myBrowserId, shouldAutoPaste };
})();
if (typeof self !== 'undefined') self.PPBrowserTarget = PPBrowserTarget;
