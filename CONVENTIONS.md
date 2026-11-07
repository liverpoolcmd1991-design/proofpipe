# CONVENTIONS.md — code conventions

How code is structured in this repo. Not visual (see DESIGN.md), not
component-level (see COMPONENTS.md) — this prevents *structural* drift so
any file here looks familiar at first read.

## 1. File & folder layout

```
server.js              # the entire backend (single file — deliberate, see below)
ProofPipe.bat          # Windows launcher (double-click entry point)
scripts/               # one-shot helpers, run via npm scripts from the repo root
  gen-cert.js          #   self-signed HTTPS cert (openssl wrapper)
  gen-icons.js         #   rasterizes app icons from public/icons/scan-line.svg
  threadpool.cjs       #   preloaded by `npm start` (libuv thread pool size)
public/                # everything served statically (both web UIs)
  index.html / app.js / style.css      # PC harness
  phone.html / phone.js / phone.css    # phone PWA (+ manifest.webmanifest, sw.js)
  toPng.js             # shared clipboard-encode helper — byte-identical to extension copy (test/dup.test.js enforces it)
  icons/               # Lucide stroke SVGs (icon source of truth)
extension/             # Chrome MV3 extension (load unpacked)
  background.js        # service worker: all server fetches, tab routing, auto-paste
  offscreen.js         # offscreen doc: holds the SSE connection
  content.js           # injected tray + synthetic paste engine (any site)
  popup.html/js        # toolbar popup
  toPng.js             # byte-identical copy of public/toPng.js (test/dup.test.js fails if they drift)
test/                  # node:test suites, one server process per suite (18 as of v1.21)
  *.test.js            # api-docs / backup / browser / config / dup / extension-logic /
                       #   extension-manifest / fab-hide-show / files / harness-ui /
                       #   mediadir / pc-ui / phone-ui / quality-clamp / queue /
                       #   ratelimit / regression / smoke
  port-ranges.js       # shared, disjoint per-suite port table (pickPort) — NOT a suite
server/                # extracted subsystems (imported by server.js — see below)
  util.js              # pure, side-effect-free helpers (no DB/network/sharp)
  bytes.js             # centralized /api/stats byte counters (+ DB re-sync)
  store.js             # capture pipeline: probe/thumb (announces its file reads),
                       #   storeCapturedParts, bootSweep
  captures.js          # captures query/delete HTTP surface
  files.js             # file transfer + inbox auto-save + serving
  cleanup.js           # storage caps, retention, sweeps, shared row deleters,
                       #   the in-flight read handshake (begin/endFileRead + awaitFileIdle)
  mediadir.js          # media-dir relocation, inbox dir, Windows folder picker
  backup.js            # backup/export (transactional DB checkpoint+copy)
  sse.js               # /events SSE hub: clients, eviction cap, heartbeat, notify
  ratelimit.js         # per-IP token buckets (photo + file classes)
  browser.js           # launcher browser choice + harness opener (Windows detection)
dev/                   # dev-only artifacts, never packaged or served: the two render/
                       #   measure harnesses (phone-lane.mjs + seed-scratch.mjs, pc-harness.mjs)
                       #   and preview.html (the tray UI preview)
data/                  # runtime state (gitignored): SQLite DB, captures, files, inbox, settings
docs: README.md / CHANGELOG.md / PITFALLS.md / DESIGN.md / COMPONENTS.md / API.md
      / AGENTS.md / CONVENTIONS.md
```

Naming rules:
- **lowercase, no separators** for runtime files (`app.js`, `phone.css`,
  `background.js`); kebab-case only for docs and helpers (`gen-cert.js`,
  `PITFALLS.md`).
- Test files end `.test.js`; each spawns its own server on a **disjoint port
  range** (see PITFALLS #27).
- Version stamping: `package.json` is the **single source of truth** —
  `server.js` derives `PP_VERSION` from it at boot (`v` + the version field),
  so bumping the version is one edit, never three. `extension/manifest.json`
  versions independently (it's a separate release artifact).
- **When to bump** (PITFALLS #24–#25): the harness and phone routes both stamp
  asset URLs with a **content hash** (`assetStamp`) — `/app.js?v=<sha1-10>`,
  `/style.css?v=…`, `/phone.js?v=…` — so a byte change to `app.js` /
  `style.css` / `index.html` / `phone.*` automatically revs its own URL and
  clients fetch the fresh copy. **No manual bump is needed for asset changes
  any more.** Only bump the version for behavior changes you want visible in
  the UI (the harness's `meta[name=app-version]` still carries
  `__PP_VERSION__`, which is what drives the update banner). Don't bump per
  commit or per pixel-tweak — batch trivial UI churn into one release so the
  version still means something.
- `public/sw.js` serves **network-first with canonical, query-stripped cache
  keys** — a new asset version overwrites the same key, so the cache name
  never needs a manual bump (`proofpipe-v34` is the last one; the v33→v34
  name change is exactly how the old accumulated per-URL entries get shed on
  first activation). Only re-bump the cache name if you change the KEY
  scheme itself.

### Why server.js is a composition root (formerly "one file")
server.js held the entire backend until the v1.9.8 audit split it. It now
keeps only: boot/config, DB + versioned migrations, the single set of hoisted
prepared statements, the Fastify HTTP shell (CORS/CSRF/logging), genuinely
cross-cutting small routes (stats, text sync, QR, phone shell), and module
wiring. Everything else lives in `server/` — see the layout above.

Extraction rules (follow them for any future split):
- A module owns no state. Everything comes in through an injected `ctx`:
  `settings`, `stmts`, `db`, byte counters, `notify`, `csrfSafe`, and —
  critically — `paths`, a LIVE getter for the media dirs.
- **No module may cache a media path.** Media-dir relocation reassigns
  `mediaBase`/`CAPTURES`/`FILES`/`INBOX` at runtime through
  `adoptMediaDir()`; modules destructure `paths()` fresh inside every
  function so a mid-process relocation is picked up on the next call.
- **sharp stays a dynamic import in server.js**, after the
  `UV_THREADPOOL_SIZE` assignment. It is *injected* into store.js. ESM
  static imports hoist above any assignment and would re-freeze the libuv
  threadpool at 4 — the code runs fine, upload parallelism silently dies.
  `test/config.test.js` fails the build if this contract is broken.
- A module earns its own file when it is either (a) pure — no DB, no
  network, no sharp, no mutable state — or (b) one subsystem with an
  explicit `register(app, ctx)` / `create(ctx)` boundary. The body of every
  moved route/function must stay byte-identical to the original; the full suite
  passing unmodified is the proof the extraction was mechanical (the suite/port
  map lives in `test/port-ranges.js`).

## 2. JavaScript conventions

### Style
- **ES modules** in the server, classic scripts in the browser (no bundler).
- `const` by default; `let` when reassigned; no `var`.
- Template literals over concatenation; arrow functions for callbacks;
  `async/await` over `.then` chains (extension code uses `.then` chains
  where message-passing makes it clearer — acceptable there).
- No TypeScript, no JSDoc enforcement. Comments explain **why**, especially
  where a bug was fixed — the comment usually names the failure mode.
- Error handling: try/catch with deliberate empty catch + `// why` comment is
  idiomatic here (best-effort IO, cleanup paths). Never swallow silently
  where the user would see a lie.

### State management

Server:
- Module-level singletons: `db` (better-sqlite3), hoisted `stmts`, in-memory
  counters (`server/bytes.js`), Maps for rate buckets and SSE
  clients. `settings` object persisted to `settings.json` (allowlist-loaded,
  atomic tmp+rename write).
- Concurrency guards: `cleanupRunning` / `fileCleanupRunning` /
  `relocationRunning` booleans for single-flight async work. Follow this
  pattern for any new background loop.

Harness (`app.js`) — plain module pattern, no framework:
- Arrays of rows (`captures`, `filesList`) + Sets for identity
  (`knownIds`, `selected`, `seenMaxId`), `localStorage` for UI prefs
  (`pp_dens`, `pp_tab`, `pp_nic`, `pp_auto_copy`…).
- Render model: **full render** (`renderGrid`) vs **incremental sync**
  (`syncGrid`) — new SSE payloads apply to state then `syncGrid()`;
  structural changes call `renderGrid()`. Keep this split; don't introduce
  a virtual DOM or reactive library.
- Clipboard/PNG caches are LRU-ish Maps with byte budgets — copy this pattern
  for any new unbounded cache.

Phone (`phone.js`):
- Durable state in **IndexedDB** (photos, files) with retry/backoff; small
  state in `localStorage`. Server is source of truth for settings; local
  value is the offline fallback.

Extension:
- **`chrome.storage.session`** for anything that must survive MV3 service
  worker restarts but die with the browser; **`chrome.storage.local`** for
  the pinned server origin. Module-level `let` is lost on every SW idle —
  see PITFALLS #1.

### API conventions (client ⇄ server)

- Multipart uploads send metadata fields **before** the file part
  (`source`, `dir`, `auto`) — the server reads `part.fields` from the first
  part object; keep this order in any new upload endpoint.
- Pagination: `?limit=` (capped server-side) + `?before=<id>` keyset cursor,
  newest first.
- Mutations are CSRF-checked via `csrfSafe(req)` (Origin/Host validation);
  any new mutating route needs the check in its first line.
- SSE events: `notify(type, payload)` — payload always carries the full row
  the consumer needs (clients apply without refetching). Event types:
  `capture-ready` (auto captures only, pre-thumb), `capture` (all, post-thumb),
  `deleted`, `file`, `file-deleted`, `text`, `settings`, `open-latest`.
  Changing this contract requires a version bump (PITFALLS #24).
- JSON error shape: `{ error: 'message' }` with a precise status code
  (400 bad input, 403 CSRF, 404 missing, 413 too large, 415 unsupported, 429
  rate limit, 409 conflict/relocation).

### Client structure order (per file)

1. `$`/helper declarations (`api()`, formatters)
2. Feature sections in UI order, each with a `// ---------- name ----------`
   banner comment
3. SSE wiring near the end
4. Boot block last (IIFE on phone.js, top-level calls on app.js)

Event handlers are assigned as properties (`$('#btn').onclick = …`) —
consistent, simple, no `addEventListener` ceremony for single handlers (use
`addEventListener` when multiple listeners or capture phases matter, e.g.
document-level keys, pointer events).

### XSS rules (non-negotiable)

- Server strings (filenames, texts) enter the DOM via `textContent` or
  `createElement`/`append` — **never `innerHTML` with interpolation**.
- `innerHTML` is allowed only with fully static strings.
- Media URLs are built with `encodeURIComponent(file)` against a validated
  filename (`FILE_RE` in extension code; flat-namespace regex in server).

## 3. CSS conventions

- **One stylesheet per surface** (`style.css`, `phone.css`); tokens in
  `:root`, referenced as `var(--token)` — never raw hex in new rules
  (grandfathered one-offs are documented in DESIGN.md §1).
- State is a `data-state` attribute on the element that carries it, and its
  paint comes from a `--tint-<state>` / `--tint-<state>-bd` **token pair** — the
  same vocabulary the dot and the strip share, so a new state is two tokens and
  one rule, never a fourth literal. Today's set lives on the phone's
  `.status-strip` (`ok` · `warn` · `off` · `busy`; §1 of DESIGN.md).
- A rule may never draw its own scrollbar: a strip/panel that scrolls hides
  the bar (`scrollbar-width: none` + `::-webkit-scrollbar`) and advertises the
  overflow with an edge fade or a cue instead (PITFALLS #46).
- Plain CSS only: no preprocessor, no Tailwind, no CSS-in-JS, no build step.
  Class names are semantic (`.transfer-row`, `.f-name`), not utility.
- Mobile-first on phone.css; the harness is desktop-first with two breakpoints
  (`max-width: 800px` grid collapse, `max-width: 760px` lightbox).
- Overrides land in a trailing `/* ---------- UX pass overrides ---------- */`
  section rather than increasing specificity mid-file.
- `prefers-reduced-motion` block sits at the end of both stylesheets and
  kills all animation/transition — new animations are covered automatically.
- Icons: extend the `.ic` mask pattern with a new `--m` variable; SVG source
  goes in `public/icons/` (Lucide), then `gen-icons.js` re-rasterizes app
  icons if needed.

## 4. Extension conventions

- Every server request originates in `background.js` (`serverFetch`) or an
  extension page with `host_permissions`; content scripts use the SW relay
  (`bg({type:'mediaBlob'…})`) first, direct fetch as documented fallback.
- Message protocol: `{ type: '…', …payload }` with `{ ok }` / `{ error }` /
  typed responses; every listener returns `true` only when responding async.
- Offscreen document owns the SSE connection; the SW owns routing decisions;
  content scripts own DOM interaction. Don't move responsibilities across
  these boundaries without re-reading PITFALLS #1–3.
- Content-script UI lives in a **closed shadow root** with `all:initial`
  reset; per-site state uses page `localStorage` keys prefixed `pp_`.

## 5. Testing conventions

- Runner: `node --test test/*.test.js`; suites spawn the real server
  (`spawn(process.execPath, ['server.js'], { env: { PP_DATA: tmpdir, PORT: <range> } })`)
  and assert over HTTP — integration-style, no unit-test framework.
- Each suite has a **disjoint randomized port range** and its own temp
  `PP_DATA`.
- Env knobs for tests: `PP_MAX_FILE_MB`, `PP_RATE_CAPACITY`,
  `PP_RATE_REFILL_PER_MIN`, `PP_FILE_RATE_*` — add analogous overrides for
  new limits so they stay testable.
- Polling assertions (async thumb derivation, inbox copy) use bounded
  deadline loops, never fixed sleeps; EBUSY-prone Windows reads retry on
  `EBUSY`/`EPERM` (PITFALLS #14).
- `npm run lint` = **one gate**: `eslint .` driven by `eslint.config.js`. (The
  old separate `node --check` pass was removed — ESLint parses every file it
  lints, and a hand-maintained file list was one forgotten edit away from false
  confidence; keep the globs in `eslint.config.js` complete instead.) ESLint is
  configured per surface: Node ESM for `server.js`/`server/*`/`test/*`, browser
  globals for the web UIs, `chrome` + service-worker globals for the extension.
  It catches the dead-variable / undefined-reference / duplicate-key classes
  that a parse-only check cannot. `npm audit --omit=dev` runs in CI as a
  release gate for the shipped dependency tree, and
  `test/extension-manifest.test.js` pins the manifest permissions/icons to what
  the extension code actually uses, and `test/api-docs.test.js` parses every
  `app.<method>('…')` registration out of the server sources and fails if a
  route is missing from `API.md` (or documented there after being removed) —
  `API.md` is hand-maintained and is the Android app's wire contract, so it
  gets the same structural guard as any other contract.
- Tests assert **bodies and shapes**, not just status codes (PITFALLS #10) —
  e.g. the SSE contract tests parse actual `data:` frames.

## 6. Docs & versioning conventions

- Every behavior change lands with: code + version bumps (server/extension/SW
  cache as applicable) + CHANGELOG entry + test. Docs (README/PITFALLS) get
  updated in the same change when behavior or lessons are user-visible.
- CHANGELOG format: `## v<server> / ext v<ext> — summary` with
  `### Fixed/Performance/…` subsections, written for humans who upgrade.
- PITFALLS.md is append-only folklore: numbered entries, each stating the
  mistake, the symptom, and the fix — written when the lesson costs real
  debugging time.
