// ProofPipe extension — server filename guard, shared by every context that
// builds a `/media/<name>` URL or relays a name to the service worker.
//
// This guard was copy-pasted into three files (background.js, popup.js,
// content.js) and the copies had to stay in lockstep because the check is
// security-relevant: a name like `../settings.json`, an absolute URL or a
// percent-escaped traversal must never reach a fetch. A drift between copies
// is exactly the class of bug the shared-module pattern here exists to kill.
// Loaded by the service worker (importScripts), the popup (script tag) and
// every content script (manifest content_scripts) — the same three chains as
// discovery.js. test/extension-logic.test.js pins both the rules and the wiring.
//
// Classic script (no import/export): MV3 workers and content scripts don't
// module-load, and the test VM shares the file.
const PPFiles = (() => {
  // Server filenames are a timestamp + random suffix; thumbnails are the
  // original's name with a `t-` prefix. Anything else — path separators, dot
  // segments, spaces, percent-escapes, a scheme — is refused, never escaped.
  // The lookahead rejects names made only of dots/underscores: `/media/..`
  // normalizes to `/` in the URL parser, i.e. the "filename" would fetch a
  // non-media path. Real names always carry digits (server/store.js:
  // `${Date.now()}-${random36}${ext}`).
  const FILE_RE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._-]+$/;

  // true when `name` is a plain server filename or its `t-` thumbnail form.
  // The thumbnail prefix is STRIPPED before validating, never merely allowed:
  // `t-..` must fail for the same reason `..` does. Empty/nullish names are
  // invalid too — they would build `/media/` or `/media/undefined`.
  function valid(name) {
    return FILE_RE.test(String(name == null ? '' : name).replace(/^t-/, ''));
  }

  // URL-safe name for `${base}/media/<...>`, or throw. Callers that build a URL
  // use this; callers that only relay a name to another context use valid().
  function safe(name) {
    const s = String(name == null ? '' : name);
    if (!valid(s)) throw new Error('bad filename');
    return encodeURIComponent(s);
  }

  return { FILE_RE, valid, safe };
})();
if (typeof self !== 'undefined') self.PPFiles = PPFiles;
