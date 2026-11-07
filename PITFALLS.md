# Pitfalls & Hiccups — lessons learned building ProofPipe

Written for agents (and humans) touching this codebase, so the same mistakes
aren't repeated. Everything here actually happened in a working session.

## MV3 extension architecture

### 1. Service workers forget everything (~30 s)
Module-level state in an MV3 background worker (`let lastChatTab = null`) is
wiped every time Chrome idles the worker out. Auto-paste was routing to
"whatever tab is active" because the remembered tab vanished with the worker.
**Fix:** anything that must survive goes in `chrome.storage.session` (dies
with the browser, which is what you want for tab context) or
`chrome.storage.local` (survives restarts, for things like the pinned server
origin). Restore it at the top of the worker, not lazily at use time.

### 2. The offscreen-document relay can die invisibly
The SSE connection lives in an offscreen document. If `createDocument` fails
or the doc crashes, NOTHING downstream fires and — worse — nothing was
traced, so the popup trace was empty and there was no badge. "Empty trace +
no symptoms" means stage 0. **Fix:** trace the document's first line
(`offscreen-doc-boot`), trace `createDocument` failures, and run a watchdog
alarm (every 5 min — a 1/min cadence bought nothing but extra service-worker
wake-ups) that pings the doc (`relayPing`) and tears down + rebuilds an
unresponsive one. Alarms wake the SW, so the watchdog doubles as keepalive.

### 3. Local Network Access blocks content-script → loopback fetches
2026 Chrome blocks `fetch('http://127.0.0.1:…')` from public https pages
(LNA + mixed content). The old design fetched media directly from the page
and fell back to clipboard — but the clipboard API needs page FOCUS, and
auto-paste fires while the tab is unfocused (you're on your phone). Both
paths dead. **Fix:** fetch through the background worker (`host_permissions`
make it immune) and pass the Blob over the message channel — structured
clone moves Blobs as-is, no base64 inflation. Direct fetch stays only for
the interactive tray (one LNA prompt is acceptable there).

### 4. `chrome.runtime.sendMessage` Blobs are fine; don't dataURL-encode
The pre-existing `dataUrl` path base64-inflated every photo (~33% + string
cost). If you control both ends, send `{ blob }` and check
`r.blob instanceof Blob` at the receiver. Keep the dataURL path as a
compat fallback if older builds exist in the wild.

## Synthetic paste events (the 2x → 4x duplicate saga)

### 5. `bubbles: true` fires MULTIPLE site handlers → duplicate pastes
Chat sites attach paste handlers at several levels (editor + React root +
document). A bubbling synthetic paste invokes each of them; DeepSeek pasted
the same image twice on the very first attempt. **Never dispatch synthetic
paste with `bubbles: true` as the first attempt.** Stage it: non-bubbling
first (only the target's own handler), verify, escalate only on real
rejection.

### 6. Verification false-negatives multiply the damage
The escalation chain is only as good as its success detection. The original
check (`contentLen(target)` grew, or an `<img>` inside the target) missed:
- **attachment chips** — DeepSeek renders a filename label; the editor
  length never changes
- **canvas previews** and **blob: URLs** — no `<img>` in the editor
- **shadow DOM** — text hidden from `body.textContent`/`innerText`
When verification false-negatived, EVERY escalation fired → 4 pastes.
**The decisive, near-universal signal:** `dispatchEvent()` returns `false`
when any handler calls `preventDefault()` — real paste handlers always do.
Check the return value FIRST; DOM watching is the backup, not the primary.

### 7. Detection must be document-wide and multi-signal
What ended up working, in order: `preventDefault` return value → unique
filename (we control it: `proofpipe-<id>.<ext>`) anywhere in the document
including shadow roots → editor length delta → global img/canvas/blob: URL
count deltas → an `input` event on the editor (captured). Take fresh
baselines per attempt, and end on the FIRST hit.

### 8. Editors that only accept PNG
Some editors (Slack-style) silently ignore non-PNG paste files. One PNG
re-encode retry is worth it — but ONLY after the original-format attempt is
confirmed dead (see #6, or you'll paste twice).

### 9. Focus-gated fallbacks need a queue, not a toast
When auto-paste runs unfocused, `navigator.clipboard.write` fails. The old
code toasted "press Ctrl+V" and the capture evaporated. Queue undelivered
captures per-tab and flush on `focus`/`visibilitychange`; surface the count
in the popup so silence can't hide data.

## Fastify / server

### 10. `return reply` after `reply.send()` breaks under plugins
`reply.send(payload); ...; return reply;` double-resolves the route promise.
Plain Fastify tolerates it; `@fastify/compress` emits an EMPTY gzip body
(`content-length: 0`). Symptoms: route returns 200 with 0 bytes, only for
some routes (`/` and `/upload` had it; the handler that returned a value
directly was fine). **Fix:** always end handlers with a single
`return reply.send(payload)` (or return the payload). Tests only caught
this because one asserted on the served HTML body — assertion tests on
bodies, not just status codes, pay off.

### 11. `@fastify/compress` must be registered BEFORE `@fastify/static`
Hooks only reach routes registered after them in the same scope. Static
routes registered before compress silently skip compression. Same class of
bug as any Fastify "route doesn't inherit plugin X" issue: check ORDER
first, not config.

### 12. setHeaders in @fastify/static v10 receives the Fastify reply
Not the raw `http.ServerResponse`. `res.setHeader(...)` throws
`TypeError` at boot. Use `reply.header(...)`.

### 13. Tests can pass against a STALE server process
During debugging, manually started servers on the test port lingered; the
suite then "tested" old code and failed confusingly (429s from default rate
caps, empty bodies from the pre-fix handler). Symptom: failures that don't
match any recent change and change between runs. **Kill stray
`node server.js` processes before believing a test failure** — on Windows:
`Get-CimInstance Win32_Process -Filter "Name='node.exe'"` filtered by
CommandLine, then `Stop-Process`. (PowerShell property access inside bash
needs `\$_`, not `$_`.)

### 14. Windows test flakes: EBUSY / random failures are environmental
This repo's suite intermittently fails 1–2 tests on Windows with
`EBUSY: resource busy or locked` on temp files (antivirus real-time scan
holds handles). Verified by running the ORIGINAL code: same flakes. Don't
chase them; rerun, and prove pre-existence (stash your changes and run the
suite) before attributing a flake to your diff.

## Sharp / image pipeline

### 15. Thumb-encode effort is free latency; originals are not your buffer
`png({ effort: 6 })` on a 400px thumb is ~2–4x slower than effort 2 with no
visible difference at grid sizes. And `makeThumb(Buffer)` forced every
upload to hold the whole file in heap; reading from the stored file path
works identically for sharp and cuts GC pressure during bursts.
`fastShrinkOnLoad: true` speeds large-JPEG downscale.

## Node streams

### 16. 64 KB highWaterMark is expensive for multi-MB streams
`fs.createReadStream` default (64 KB) means 4x the read syscalls for a
multi-MB photo vs 256 KB. Pass `{ highWaterMark: 256 * 1024 }` on any
endpoint streaming images. `readdir({ withFileTypes: true })` similarly
halves boot-sweep syscalls (no per-entry stat for directories).

## Client JS

### 17. SSE events make polling redundant — piggyback, don't duplicate
The harness polled `/api/stats` every 15 s while SSE already pushes every
event that changes those numbers. Piggyback stats refresh on existing SSE
events (coalesced with a small timeout) and keep the interval only as an
SSE-down fallback.

### 18. `img.decode()` before crossfades
`onload` can fire while the bitmap is still decoding; swapping big images
on `onload` shows a half-decoded frame. `await img.decode()` before the
fade. Also: memoize per-row `new Date(...)` + `toLocaleString` parsing —
re-renders of 500+ tiles re-parsing timestamps is real jank.

## SSE event contract (the frozen-grid saga)

### 23. The post-thumbnail event is a PAINT signal, not a duplicate
The server fires `capture-ready` (original on disk, before the thumb) and
`capture` (after the thumbnail lands). The second looked like pure redundancy —
"one event is enough, the clients retry" — so it was removed and clients were
told to paint on `capture-ready` + retry missing thumbs. Result: every new
tile appeared EMPTY and stayed empty for the thumb-derivation window (hundreds
of ms, seconds on a hotspot). The early event carries a row whose thumbnail
does not exist yet; "paint signal" and "paste signal" have different timing
requirements. **Fix:** restore both events but SCOPED — `capture-ready` only
for auto captures (the only consumer that needs pre-thumb timing), `capture`
for everyone after the thumb exists. When deleting an event as "redundant",
first list every consumer and ask what DELAY each one tolerates.

### 24. Changing the SSE contract without bumping the version = silent freeze
The event rename/removal shipped with the same `PP_VERSION`, so the harness's
one stale-page detector (page meta version vs `/api/version`) had nothing to
detect. Open tabs kept running old JS against a new server: events silently
matched no handler, and the poll fallback stood down *because SSE was
connected* (`if (es.readyState === 1) return`). Every consumer of an evented
contract must ship with a version bump in the SAME change.

### 25. F5 does not revalidate subresources — refresh ≠ fresh JS
The shell is served with `max-age=86400, must-revalidate`. A normal reload
revalidates only the HTML document; `app.js` comes from the browser cache for
a full day. Users hard-refreshed, got fresh HTML, ran STALE JS, saw nothing
wrong (the page looked fine), and the bug looked unfixable. **Fix:**
version-stamp the script URLs (`/app.js?v=v1.8.3`) — a URL that has never
been requested cannot be served from cache, so ANY reload after a version
bump lands matching JS. The pitfall pair to remember: meta-version parity
detects a stale page only if the JS is versioned, and versioned URLs work
only if the version actually changes when JS semantics change.

### 26. `String.replace(string, ...)` replaces the FIRST occurrence only
Adding a second `__PP_VERSION__` placeholder (meta + script URL) to the HTML
silently broke it: `.replace()` swapped the first one and left a literal
`__PP_VERSION__` in the served page. Use `replaceAll` — and a test that
fetches the served HTML and asserts no placeholder leaked (a source-level
test would have passed while the served page was broken).

### 27. Per-suite test port ranges must be DISJOINT, not just random
Randomizing one suite's port into another suite's range lets two servers
race for the same port; the loser's requests hit the WINNER's server and
tests fail with shared-state symptoms (429s from someone else's rate-limit
bucket, byte totals that don't add up). Give each suite a fixed range and
randomize WITHIN it — the layout now lives in ONE place, `test/port-ranges.js`
(ratelimit 8976–9025, regression 9026, smoke 9027–60, files 9200–99, mediadir
9300–99, backup 9400–49, browser 9500–49, config 9550–89). See #39, which
widened smoke and moved regression after nvcontainer squatted the old range.

### 28. Extension "debug traces" are load-bearing for nobody and cost everyone
The popup trace (ring buffer in chrome.storage.session, written from every
context) read like pure diagnostics, but removing it touched five files and
its absence must not change behavior. If you keep tracing: write it in ONE
place, keep the schema documented, and gate verbose writes behind a flag.
If you delete it: grep every context for both the writer and the reader UI.

## Process / methodology (what actually found the bugs)

### 19. Reproduce the pipeline server-side before touching client code
The first debugging session verified the server emitted correct SSE events
via a live curl + upload — which ruled out half the pipeline in five
minutes and focused the search on the extension.

### 20. Tracing beats guessing; put it in BEFORE the field test
The empty-trace report was only interpretable because stages were already
logging. When a pipeline spans server → SW → offscreen → content script,
each stage needs a trace line (via `chrome.storage.session` so any context
can read them). A stage with no logging is a stage that can fail invisibly.

### 21. One fix per commit, named after the symptom it kills
`fix double-paste`, `fix 4x paste`, `universal paste detection` — the commit
history now reads as the debugging narrative. Field-tested regressions
(2x → then 4x → then fixed) each got their own commit, so bisecting this
session later is trivial.

### 22. Ask for the observable, not "does it work?"
The turnaround moment was asking the user for the trace + symptom checklist
instead of another blind fix attempt. "Empty trace, no badge, DeepSeek,
0.6.1 loaded" narrowed it immediately. When you can't reproduce locally,
instrument first, interrogate second, patch last.

## CSS / layout (v1.8.8 sessions)

### 29. `overflow: hidden` on a GRID ITEM collapses auto rows below the content
`.capture` tiles used `overflow: hidden` to round their corners. A
hidden-overflow grid item reports no content contribution to auto-row sizing,
so whenever the grid's content was taller than the visible area (M/L tile
densities at narrower widths — i.e. more than one row), Chrome sized every
auto row to an equal slice of the container (~229px) instead of the tile
content (~310px). Rows shrank below the square thumbnail, and the tile's own
clip then cropped the photo into a band and cut off the meta row — the origin
badge and time stats only "showed" on the Small density because its rows fit.
Grid row sizing is invisible in DevTools until you compare `gridTemplateRows`
(used track sizes) with item content heights; a 20-line standalone repro
(toggling `overflow` on the item) pinned it in minutes. **Fix:** never put
`overflow: hidden` on the grid item itself. Move the rounded clip to an inner
wrapper (`.thumb`) or radius the element that needs it (`.skel-img`); the
tile background already follows `border-radius` without any clip — only
overflowing CHILDREN need one.

### 30. Negative margins that cross the viewport edge create a phantom scroll
The phone header's ⋮ button pulled itself flush to the right wall with
`margin-right: calc(-18px - 2px - 12px + 6px)`; the trailing `+6px` fudge
pushed the button's layout box 6px PAST the viewport edge, making the
document 6px wider than the screen — a barely-there horizontal scroll (and
rubber-band) on the phone. Symptom-hunt by measuring `documentElement.scrollWidth`
vs `innerWidth` at real device widths, then listing elements whose
`getBoundingClientRect().right` exceeds the viewport. **Fix:** end the pull
exactly at the viewport edge (`calc(-18px - 2px)` = the wrap + capture-bar
padding) — the glyph reads as flush without any fudge past the edge.

### 31. A `flex: 1` box squeezed to zero paints its children over its neighbours
The phone's `.gallery` is the layout's one `flex: 1 1 auto; min-height: 0` item,
so it is the thing that absorbs every other row growing. Add one 44px row to the
PC-sent lane and on a 320×568 screen the gallery is handed 6px — and because its
empty-state hint is a flex item with `min-height: auto`, it cannot shrink below
its two lines, so it overflowed the gallery and painted straight over the
composer. Nothing was clipped (the gallery had no `overflow`), and `.wrap` did
not scroll either, because the chrome itself still fitted. **Fix:** a `flex: 1`
box that is allowed to reach zero must clip (`overflow: hidden`) and carry a
floor (`min-height: 44px`, matching the row it exists to hold) so the app
column's documented overflow net engages and the box stays reachable. Symptom to
look for: text or chrome from one row bleeding over the row below it at a
viewport size you have not tried yet.

### 32. A mask that fades "the edge" fades it even when there is no edge
The phone's chip strips masked themselves with
`linear-gradient(90deg, transparent 0, #000 14px, …)` to advertise horizontal
scroll. At `scrollLeft: 0` the leading chip therefore sat inside a 0→14px
transparent ramp, so its left border was not drawn — the card read as an open
shape — and a strip with a single chip that did not overflow faded both ends for
nothing. A screenshot is easy to misread here (the fill difference is 1.07:1, so
only the *border* visibly disappears). **Fix:** make the fade per edge
(`--fade-l` / `--fade-r`, set to `0px` by `.at-start` / `.at-end`), and drive
those classes from `scrollLeft`/`scrollWidth`/`clientWidth` on scroll, on resize
and whenever the row count changes. Keep the mask in CSS; JS only sets the two
custom properties.

### 33. Two "identical" CSS blocks drift, and only a render shows it
`#text-in` and `#files` were declared as two blocks that were meant to be the
same strip. They were not: one had `padding: 2px 2px 32px; margin-bottom: -24px`
and the other the same numbers plus `align-items` differences, which put every
chip 2px in from the page's 18px gutter and produced a 14 / 12 / 4px vertical
rhythm between the lane's rows. None of that is visible in the source — the two
blocks LOOK equivalent. It is visible the moment you dump
`getBoundingClientRect()` for every row and diff the numbers — `dev/phone-lane.mjs
probe <url>` does exactly that (headless Chrome over CDP, with real timers, so
the fetches settle; pair it with `dev/seed-scratch.mjs`, which seeds a scratch
instance at `PP_DATA`/`PORT` with every chip variant so the lane renders full).
**Fix:** declare
the shared component in ONE rule whose selector list names both
(`.text-in, #files`), and pin it with a test that asserts the rule exists and
lists both, so a second copy cannot be added back.

### 34. An id in the ancestor chain silently outranks a two-class descendant rule
`.text-chip .toolbtn { display: none }` was meant to keep the incoming-text chip's
copy button hidden until the chip was expanded. It never applied: the button also
matches `#text-bar .toolbtn`, and `#text-bar .toolbtn` is (1 id, 1 class) while
`.text-chip .toolbtn` is (0 ids, 2 classes) — so `display: inline-flex` from the
ID rule won and the copy button rendered at the bar's full 44px all the time. The
CSS *looked* right, and the visible symptom was a chip that was ~62px tall in a
bar whose other controls are 44px — which reads as "the chip has generous padding",
not as a specificity bug. Found by measuring, not reading: the chip's copy button
reported `display: flex` where the source says `display: none`.
**Lesson:** specificity is not "more classes wins" — an id anywhere in a selector
beats any number of classes. Before adding a descendant override to a component
that lives inside an id-scoped region (`#text-bar`, `#lb-bar`, `#bulk-bar`), check
whether an id rule already targets the same element; prefer extending that rule or
scoping the override with the same id.
**Resolved in v1.16.0 (harness P1)** — the chip moved out of the band (it is a
full-width *From your phone* row above the library now), so `#text-bar .toolbtn`
no longer matches its copy button and `.text-chip .toolbtn` is the only rule left:
it renders compact (34×28, 14px glyph) and it is **meant** to be there while
collapsed — copy is the one action a one-line preview exists to serve. The lesson
outlives the fix: the override never had a chance, and only a measurement said so.

## Touch gestures (phone viewer, v1.9.1 sessions)

### 31. A transform transition on a gesture surface rubber-bands behind the finger
The viewer image had `transition: transform .18s ease-out` for snap-back and
navigation — and it chased EVERY `touchmove`: each pan/pinch step animated
from the previous position, so the image lagged ~180ms behind the finger and
felt "slow and unresponsive." The `.gesturing` escape hatch existed and the
swipe path used it — but pinch and pan never did. **Fix:** transitions off at
`touchstart`, on at `touchend`; only release/snap paths (spring-back, commit,
double-tap) run animated. Rule: any element that tracks a finger 1:1 must
have its transition disabled for the duration of the gesture, not per-path.

### 32. An unclamped pan can park the image off-screen
Zoomed panning translated freely, so one confident drag could throw the
image completely out of the viewport and leave it there (the "weird
glitch"). **Fix:** clamp translate to the scaled box overflow —
`(scale-1)*size/2` per side, which is zero at scale 1 — in every transform
writer (pinch, pan, double-tap zoom). But do NOT clamp the unzoomed swipe
drag: at scale 1 the clamp range is zero and it would kill the 1:1 tracking.
Clamp "viewing" transforms; never clamp "gesture-echo" transforms.

### 33. An inline style.height silently defeats a height CLASS
The expand-text chevron toggled `.expanded { height:180px }` — but
`sendText()` had set `style.height = 'auto'` inline after every send, and
inline styles outrank classes. After the first sent text the button was
dead forever. **Fix:** clear the inline height where the class is toggled
(`style.height = ''`), and don't set layout properties inline that a class
also controls — pick one owner. Debug pattern: if a class toggle "does
nothing," check the element's `style` attribute before believing the CSS.

### 34. Toasts rendered where buttons live will block them
Bottom-center flash toasts sat exactly over the viewer action bar
(Download/Retry/Discard/Delete) — an invisible tap-eater for ~1.6s after
every action. **Fix:** toasts moved to the top (safe-area aware) AND
got `pointer-events:none` — a status message must never be a hit target,
wherever it renders. Corollary: audit any fixed-position overlay's rect
against the interactive elements beneath it.

### 35. Shared modules must be wired into EVERY loader chain that needs them
Extracting `discovery.js` (shared port-discovery) updated its four consumers'
code but wired the `<script>`/`importScripts` into only two of four contexts
(background, offscreen) — the manifest's `content_scripts` and `popup.html`
never loaded it, so every tray/popup interaction died with
`PPDiscovery is not defined` on real sites (auto-paste fell through to a
clipboard fallback that fails unfocused; sites showed their own "does not
support copy events" errors). Unit tests on the extracted module passed —
they never exercise the WIRING. **Fix:** a structural test parses the
manifest + popup/offscreen HTML script chains and fails the build if any
consumer references a shared global its chain doesn't load first. Rule:
an extraction is not done when the code compiles — it's done when every
consumer's loader provides the module before it.

### 36. A bare `rules:` key in an eslint config block REPLACES the preset
Every flat-config block here spread `...js.configs.recommended` and then
declared `rules: { 'no-unused-vars': ... }` — which wholesale REPLACED the
recommended set instead of merging. Only `no-unused-vars` was ever active;
`no-undef`, `no-dupe-keys`, `no-func-assign` etc. were decorative for the
whole life of the lint script, and everyone believed "eslint catches those"
without ever verifying. The consequence was real: `newKey()` was called in
`phone.js` but defined nowhere, and `npm run lint` stayed green while every
phone capture crashed at runtime. **Fix:** merge (`...js.configs.recommended.rules`
inside the block's `rules:`), declare the legitimate cross-script globals
(`PPQueue`, `toPng`, `PPDiscovery`, …) in `languageOptions.globals`, and
prove the config works: `npx eslint --print-config <file>` should show the
rules you think are on, and a one-line probe file calling an undefined
function should FAIL. Rule: a safety net you have never seen catch anything
is decoration — test it once with a deliberate bug.

### 37. Untested client files fail in the exact way their extraction test can't see
`phone.js` is browser-only glue with zero automated coverage, and both of
the v1.9.8 batch regressions lived there (`newKey` ReferenceError, double
`tries` increment) while all 85 tests stayed green — the tests exercise the
server and the pure `queue.js` policy, never the glue that calls them.
`node --check` passes too: a ReferenceError is not a syntax error.
**Fix (partial):** eslint with a REAL `no-undef` (see #36) now catches the
undefined-identifier class statically; cross-script globals are declared so
the rule has no false positives. **Fix (real):** pure decision logic belongs
in `queue.js`-style `node:vm`-testable modules — the outbox record
lifecycle (`outboxAdd`/`bumpTries`/flush decisions) is the next extraction
candidate. Rule: the file where a bug class has already bitten twice is the
file that needs extraction into something testable, not more care.

### 38. A "pre-X scratch save" commit is a revert unless you diff it first
The `3493f40` commit message said "new pre browser selection commit" but
deleted ~1,500 lines of shipped work: `eslint.config.js`, three test suites,
`public/queue.js`, and reverted phone.js/extension features — and only the
next commit recovered *part* of it (server/browser.js). Nobody read the
stat. The repo then sat with red CI (lint unrunnable), a 404 script tag in
phone.html, and a silently-dead phone settings toggle for two days.
**Fix:** before committing a broad working-tree state, READ `git status` +
`git diff --stat` and ask what every deleted file was. Scratch states belong
on a branch or `git stash`, never on master. And when reverting damage, the
checklist is: diff against the last known good commit, list every file with
a net line LOSS, and restore each one explicitly — "the commit I reverted
back to" is not the same as "the feature set that was live".

### 39. Ephemeral outbound ports can squat a test range (and netstat can't see them)
smoke.test.js failed 12/50 with `EADDRINUSE :9030` while netstat showed no
LISTENER on that port — a proxy client (sing-box) held 9030 as an EPHEMERAL
outbound source port. Randomized port tests race every process on the box
making outbound connections, not just listeners; PITFALLS #27's "disjoint
ranges" defense assumed listeners.
**Fix:** widen the draw (smoke now spans 9027–9060) AND retry the boot: when
the server dies with EADDRINUSE, redraw the port and re-spawn (the harness
gives up only after the whole range). A LISTENING-filter netstat precheck
would NOT have caught this — don't bother adding one.
**But check the retry actually retries** (added after this bit again): smoke's
hook read the failure reason with `/EADDRINUSE/.test(errOut)` AFTER doing
`errOut = ''`, so the test was against an empty string, the condition was always
true, and the redraw never ran — every squat failed all 17 tests while the code
looked like it handled it. Proven by squatting 9027–9060 with listeners and
running the suite: before, 17 failures; after, 17 passes and the boot lands
above the range. A retry path you never force is a retry path you do not have.

### 40. A control the popup owns must not talk to the content script in the *current* tab
The p-button hide/show toggle set `pp_fab_global_hidden` by sending a message
to the active tab, which then wrote storage. `chrome.tabs.sendMessage` rejects
whenever no content script is injected — chrome:// pages, the Web Store, and
our own harness origin, where content.js deliberately returns early. So the
button did nothing on exactly the pages where you'd reach for the popup, and
the failure was caught by a bare `catch` that printed a generic "open a normal
website tab".
**Fix:** the popup reads and writes `chrome.storage.local` itself (it is an
extension context — no tab required), and content scripts follow the change
through `storage.onChanged`, which also makes the flag apply to tabs that are
already open instead of only after a reload. Rule: if the popup owns a
setting, storage is the source of truth and the content script is a
subscriber — never the round trip.

### 41. Boot-time init that calls a teardown path will hit a `let` in its TDZ
`updateFabVisibility()` runs while the content script is still executing, and
closed the tray panel unconditionally — reaching `stopPoll()`, which reads
`pollTimer`, declared with `let` further down the file. On every page load
while the tray was hidden that threw `ReferenceError: Cannot access
'pollTimer' before initialization` and aborted the rest of the script: the
message listener, polling and drag never got wired, so the button "wouldn't
work" until the flag was cleared.
**Fix:** guard on state, not on intent — `if (hidden && open) setOpen(false)`.
Anything reachable during initialization (visibility painters, restore
handlers, storage callbacks) must only undo what has actually been done.
**Test:** `test/fab-hide-show.test.js` boots the real content.js in jsdom with
the flag already set and asserts the message listener still registered.

### 42. A content script subscribed to ONE storage event may receive none
#40 moved the p-button flag's source of truth into `chrome.storage.local` and
told content scripts to follow `storage.onChanged` — but the content script
listened only on `chrome.storage.local.onChanged` (the per-area event, Chrome
73+). On real installs the toolbar toggle was invisible to already-open tabs:
the tray only appeared/disappeared after F5, which is the *init read* path, not
the event path. Optional chaining (`chrome.storage?.local?.onChanged?.addListener`)
meant the miss was completely silent — no error, no trace.
**Fix:** register the SAME idempotent handler on BOTH `chrome.storage.onChanged`
(the classic event, delivered to content scripts everywhere) and
`chrome.storage.local.onChanged`, and re-read the flag on
`focus`/`pageshow`/`visibilitychange` as a convergence net (closing the popup
returns focus to the page, so a missed event self-heals on the next interaction).
Rule: when a push channel is best-effort, pair it with a cheap pull on an event
the user is guaranteed to cause.

### 43. Trusting an origin's SHAPE is not trusting an identity
`csrfSafe` exempted mutations from the Origin/Host check when the origin matched
`/^chrome-extension:\/\/[a-p]{32}$/` — a "is this a plausible extension id"
test. Any extension the user happened to have installed passed it, so any of
them could delete captures on the LAN origin. The shape check existed because a
pinned id needs a manifest `key`, and a `key` changes the id for unpacked loads
— a real cost, but not a reason to trust everyone.
**Fix:** carry a `key` in `manifest.json` and derive the ONE allowed origin from
it (SHA-256 of the base64-decoded public key, first 128 bits mapped `0-f` →
`a-p` — Chrome's algorithm), with `PP_EXTENSION_ID` for a packed build. Print
the trusted origin at boot, and test BOTH directions (our id passes, a foreign
id is 403) so a regression can't silently re-open the gate.
Rule: an allowlist must compare against a known value, never a value's
format — a regex that says "looks legitimate" is an authentication bypass.

### 44. A dialog opened FROM a modal must outrank it — layer order is behavior
The storage-folder picker lived at z-index 300 while the Settings modal that
opens it is 350, so it rendered *underneath* the veil: dimmed, and every click
in it landed on the Settings backdrop and closed Settings instead. Keyboard
still worked (the modal focus trap moved focus into the picker), which is
exactly why "the folder button does nothing" survived so long as a mouse-only
bug. The same shape showed up three more times: Settings and the folder picker
each bound their OWN document Escape listener, so one keypress closed both; the
lightbox key handler had no `modalOpen()` guard (unlike the grid handler), so
with the confirm dialog open over the viewer, Esc closed both layers, Delete
re-opened the dialog and ←/→/R/± still rotated an image the user could not see;
and the focus trap was a single slot, so closing the inner dialog retired the
outer one's trap for good and Tab walked into the dimmed page behind it.
**Fix:** one ordered ladder (DESIGN.md §7) plus a single `escLayer()` that names
the top layer, and a focus-trap **stack** (`trapStack` of `{ container,
returnFocus }`) that hands the keyboard back to the layer below. A second
dialog takes the keyboard without clearing the first one's put-back target.
**Rule:** whenever overlays can nest, every layer-scoped behavior (Escape,
keyboard shortcuts, focus trap, backdrop click, Android back) needs an "am I the
top layer?" check derived from the SAME ordering the z-index ladder encodes —
paint order and input order must be one list, not two.
**Test:** `test/harness-ui.test.js` — "one Escape closes only the TOP overlay"
and "the folder dialog outranks the settings modal that opens it".

### 45. A live region that CONTAINS the control announces nothing
`#toasts` was `role="status" aria-live="polite"` and the Undo button was
appended *inside* it; the phone's `#undo-toast` had the same shape around its
Undo button, and the phone's queue chip carried the region on the tap target
itself. Two costs: a control inside a status region is not announced (and is
announced as part of the message when it is), and a live region created with its
content already inside it — the usual `innerHTML`-on-open pattern — is often not
announced at all. The messages that mattered most ("Deleted" + the Undo button,
"3 photos queued — will sync automatically") were the ones nobody heard.
**Fix:** ONE persistent, visually hidden region (`#toast-announcer`, `.sr-only`,
`role=status aria-live=polite`) that every toast path writes through a single
`announce(msg)`; the visible pill (`#toasts`) is positioning only and the Undo
button is its sibling. The phone split its snackbar the same way (`#undo-toast`
wrapper, `aria-live` on the message span).
**Rule:** a live region is a text channel — no interactive content, created
empty, updated in place, and every transient message routed through it from one
place. If a status pill is also a button, the pill is not the region.

### 46. `overflow-y: auto` in a floating panel draws a real OS scrollbar
`#more-menu` is a floating sheet anchored under the `⋮`, and it genuinely
overflows on a short or landscape screen — so it needs `overflow-y:auto`. The
default bar that came with it was drawn INSIDE the panel, over 8px of padding,
against the sheet's 14px corners: a rail with its own thumb and arrows sitting
in a floating card reads as a broken nested pane, not as "there is more below".
The same shape had already been solved twice elsewhere in this codebase
(`.text-in` / `#files`) and was not carried over to the third scrolling surface.
**Fix:** hide the bar (`scrollbar-width: none` plus a `::-webkit-scrollbar {
  display: none }` — the property alone does not cover Blink) and keep the
scroll, then advertise the overflow with something that belongs to the design:
per-edge fades for the strips (`#32`), and for the sheet a bottom gradient plus
a `.at-bottom` class from `scrollTop`, because a mask would clip the panel's own
box-shadow and corners.
**Rule:** a floating panel owes the same treatment as a strip — the scroll stays
(a sheet that cannot reach its last action on a 390×844 screen is a worse bug
than a hidden bar), the OS bar goes, and a cue you drew takes its place. Never
leave the platform default on a surface the design system otherwise controls
(also: `CONVENTIONS.md` §3 requires both the standard and the `-webkit-` form —
`scrollbar-width` alone is ignored by Blink).
**Test:** `test/phone-ui.test.js` — the More-sheet guard asserts a `max-height`,
`scrollbar-width:none` and the `::-webkit-scrollbar` rule together.

### 47. A background job that HOLDS a file makes every deleter a race
`/upload` acks as soon as the original and its DB row land; the grid thumbnail
derives behind that ack, and sharp **holds the original path open** for the whole
decode (libvips opens the input itself — a plain `fopen`, i.e. without
`FILE_SHARE_DELETE`, unlike libuv's own opens). So a delete arriving during that
window lost its unlink on Windows with `EBUSY`/`EPERM`. The damage was not the
missing thumbnail: the row was already gone, so the original survived as an
orphan only the NEXT boot sweep would find, and the accounting deliberately
re-added the undeletable file's bytes to stay honest — so the byte total did not
even go down. Both smoke-test symptoms ("bytes should decrease after delete" and
the orphan count) were this one bug. It was invisible in isolation and reached
100% reproduction under three parallel suites, which is the general lesson:
**a timing bug that needs load to show will pass every run you use to check your
fix.** Fix verification has to reproduce the ORIGINAL conditions (here: run the
suite in parallel), not just the original test.
**Fix:** the reader announces itself for the duration of the decode
(`beginFileRead`/`endFileRead`, bracketed around `makeThumb`'s path reads — a
Buffer input holds no handle and says nothing) and the deleter waits it out
(`awaitFileIdle`, bounded so a wedged decode cannot wedge a delete), with
`rmWithRetry` as the belt for locks we do not own.
**Scope, measured** (so nobody re-fixes non-problems): libuv's OWN handles do
not block an unlink on Windows — an open `fs.open` fd, a live `createReadStream`
(which is what `/media/*` and `/file/:id` hand to fastify), an upload's
`createWriteStream`, a `FileHandle`, a handle in ANOTHER process, and an
in-flight `fsp.copyFile` (the inbox save, a backup's staging copy) all unlinked
cleanly in a probe. Only sharp/libvips's own open did, and the only files it
ever opens by path are capture originals. So the file-transfer, media-serving
and backup paths need no wait added — adding one there would be noise.
**Rule:** if an async job holds a resource another path destroys, the holder has
to publish that fact and the destroyer has to wait for it. "Retry and hope" is
only acceptable as the second layer — and it is not acceptable as the only one
when the failure mode is silent (an orphan file, a total that lies) rather than
loud. Audit by ENUMERATING deleters, not by remembering the one you fixed:
the single-row deleter and the bulk wipe were written at different times and
only one of them had the guard.
**Test:** `test/smoke.test.js` — "a delete waits for an in-flight decode of the
original" (a 1400×1400 PNG keeps the decode open long enough to be the normal
case) plus a unit guard on the registry itself.

## CSS / layout (PC harness redesign, v1.16–v1.19 sessions)

### 48. A flex item WRAPS on its hypothetical size, not its final one
`.toolbar` is `display: flex; flex-wrap: wrap` and the new filter group was
`.filters { flex: 1 1 auto }`. It wrapped to a second line at 1280×800 **with 300px
of empty space still on the first line** — because the wrap algorithm measures each
item's HYPOTHETICAL main size (its `flex-basis`, here `auto` = max-content: a 200px
field + 274px of chips) before any shrinking happens. `space-between` then spread
the two remaining items and the row looked "full".
**Fix:** `flex: 1 1 0`. A zero basis makes the group exactly as wide as the space
that is left, which is what "take the remaining space" means. Same family as
DESIGN.md §7's `minmax(0,1fr)` note — the flexible length that is really a
MAX-content request is the recurring trap.
**Measure it, do not read it:** the stylesheet said `flex: 1 1 auto` and a
`grep` for `wrap` said nothing; only `rowTops` from a live render showed two
distinct baselines. And when a row genuinely cannot fit its controls, collapse one
of them into the overflow instead of accepting the wrap — 1180px would have left
the search field 76px wide, so the field moves into the ⋯ below 1260px where it
still has 150px of paint (`placeFilters()`, which MOVES the node so there is still
exactly one of it).

### 49. A popup inside a scrolling list is clipped exactly where it is opened
A transfer row's `⋯` panel was `position: absolute` inside `.transfer-row` — and
`#transfers` is `overflow-y: auto`, so the panel was clipped by its own scroll
container. The rows most likely to need it are the last visible ones, which are
exactly the ones clipped; scrolling could reveal it, but a menu that has to be
scrolled into view is not a menu. Absolute descendants DO extend the scrollable
area, which is what made this look like "it works" in a quick check.
**Fix:** `position: fixed`, placed from the trigger's rect (`toggleRowMenu`), with
the panel flipped above the trigger when there is no room below and closed on
scroll (a fixed panel would otherwise hang in space while its row moves away).
**Rule:** before adding a popup to any element with `overflow`, ask what its
containing block is and what clips it. The z-index ladder does not save you from
an ancestor's `overflow`.
**Test:** `test/pc-ui.test.js` — the row-actions guard asserts `.f-menu .menu`
declares `position: fixed` and that the list's own `scroll` listener closes it.

### 50. A media query adds NO specificity — only source order decides

`.card.side` becomes a drawer inside `@media (max-width: 899px)`, so the trigger
and the veil were switched on in that same block: `#rail-toggle { display: grid }`.
The BASE rules for those two live ~20 lines *later* in the file
(`#rail-toggle { display: none }`, `#rail-backdrop { display: none }`) — and one
id against one id is a tie, which CSS resolves by order. The base declarations
therefore won everywhere, so the drawer trigger was permanently hidden and the rail
was **unreachable below 900px** with nothing in the source looking wrong: the
media block reads exactly as intended.

`#rail-backdrop:not(.hidden)` survived by accident — `:not()` carries the
specificity of its argument, so it was one class heavier than the base rule.
That is the whole tell: the fix is not "add specificity", it is to realise the two
sides were never meant to compete and let order express the intent.

**Fix:** a SECOND `@media (max-width: 899px) { … }` block placed *after* the base
declarations, with a comment saying why it is not with the breakpoint block.
**Measure it, do not read it:** `getComputedStyle($('#rail-toggle')).display`
returned `'none'` at an 800px viewport while the layout block was demonstrably
applied (the rail was already `position: fixed` and off-canvas). The render, not
the stylesheet, is what showed the contradiction.
**Rule:** when a media query overrides a base rule, the base rule must come
FIRST. Two blocks for one breakpoint is the price of keeping the layout rules
together; keep them adjacent and comment the split.
**Test:** `test/pc-ui.test.js` — the drawer guard asserts both 899px blocks exist,
that the trigger override is in the SECOND, and that the base `display: none`
precedes the last `@media (max-width: 899px)` in the sheet.

### 51. A `position: fixed` child is positioned against a TRANSFORMED ancestor

The capture tile lifts on hover (`.capture:hover { transform: translateY(-2px) }`),
and P4's tile action panel is `position: fixed` for the same reason a transfer row's
is (#49: `.capture-grid` scrolls, so an absolute panel is clipped exactly at the row
it is opened in). Fixed is supposed to mean "the viewport" — but it means "the
nearest ancestor that establishes a containing block", and **any non-`none`
`transform`, `filter`, `backdrop-filter`, `perspective`, `will-change` of those, or
`contain: paint/layout` does that.**

Measured at 1440×900: the panel's right edge was supposed to sit under its `⋯`
trigger at x≈494. It rendered at x≈‑107 — 400px off — because it was being placed
from coordinates that meant "relative to the tile's box". It then moved *again* the
moment the pointer left and the lift finished.

Two fixes that look right and are not:
- `.capture:has(.menu.open) { transform: none }` — the transition on `transform`
  (`.12s`) means the tile is still a containing block for the whole animation, so
  the first placement is still wrong, and hover can re-lift it.
- Reading `panel.offsetParent` — for a fixed element that is `null` by spec.

**Fix:** move the panel into the BODY while it is open
(`document.body.appendChild(panel)` in `toggleRowMenu`, `panel.remove()` in
`closeRowMenu`). The containing block is then the viewport for a row and a tile
alike, and the placement maths stays one code path. Safe here because both lists
are rebuilt on every render — nothing is reused across a close. The
outside-press dismissal had to learn the new location: `closest('.mpop')` no
longer matches, so it is `closest('.mpop, .menu')` (a closed menu is
`visibility: hidden` and cannot swallow a press).
**Rule:** `position: fixed` is only viewport-relative when nothing above it
transforms. Re-check hover/reveal animations — they are the usual culprit.
**Test:** `test/pc-ui.test.js` — the tile-actions guard asserts the body host, the
`remove()` on close and the widened dismissal selector.

### 52. `draggable` on a container makes EVERY child a drag handle
Giving a capture tile `draggable = true` (so a multi-select can be dragged into a
chat box) silently broke its own selection checkbox: starting a press on the box
began a tile drag instead of toggling it, and the same held for the hover
action panel — a press on `⋯` could tear the tile off the grid mid-click.
**Fix:** bail out of the handler when the press started inside a control —
`if (e.target.closest('.pick, .act-panel, input, button, a')) { e.preventDefault(); return; }`
— rather than making each control `draggable = false` (a nested handler is easy
to add later and forget).
**Rule:** a drag payload belongs to the TILE, but the grab must not start on the
tile's own controls. Drag is inherited downward; opt out at the source.
**Related:** the drag payload is the SELECTION when the grabbed tile is part of
one, and it rides in several MIME shapes at once — drop targets (chat boxes,
editors, Explorer) disagree about which single shape they accept.
**Test:** `test/pc-ui.test.js` — the selection-box guard asserts the `draggable`
assignment, the `dragstart` listener and the `closest(...)` control opt-out.

### 53. Re-deriving the surface ramp means re-deriving the CONTRAST, not the hexes
Darkening the harness meant editing `--bg`/`--card`/`--card2` and `--inv`. Every
text tier and every control boundary in this repo is contrast-audited against
those exact surfaces (`--ctl` "clears 3:1 on --bg, --card AND --card2"; the text
tiers clear 4.5:1), so a token change invalidates the audit by construction — the
old greys no longer sit on the old backgrounds.
**Fix:** step the surfaces down (`#08090a` / `#131518` / `#1a1d20`, `--inv`
white → `#e4e7e3`) and then RE-DERIVE `--ctl`/`--ctl-hover` and the text tiers
against the new values rather than reusing them.
**Rule:** contrast is a property of a (foreground, background) PAIR. Changing one
side of that pair is not a one-line edit — grep the audit tests, not just the
palette.
**Test:** `test/harness-ui.test.js` (`every text tier clears WCAG AA on both
surfaces`), `test/phone-ui.test.js` (`one definition per selector`) — one token
set feeds both UIs, so both suites must stay green.

### 54. Wiping `.git/objects/` is not always fatal — the Recycle Bin keeps the map
On 2026-09-14 this repo's entire object store was emptied: every loose object,
both `pack-*.pack` files, their `.rev` files and `refs/heads/` were gone, so every
git command died with `fatal: bad object HEAD`. It turned out to be **fully
recoverable**, because the deletion went to the **Recycle Bin** rather than `rm`.
**Fix:** each recycled file leaves a pair in `C:\$Recycle.Bin\<SID>\`:
`$I<id><suffix>` is metadata whose UTF-16LE payload starts at **byte 28** and
records the ORIGINAL absolute path, and `$R<id><suffix>` holds the bytes. Walking
every `$I` file and copying its `$R` partner back to the recorded path restored 132
loose objects plus all three packs. Three traps in that loop:
- **Keep the `$R` suffix verbatim** (`$I<id>.idx` pairs with `$R<id>.idx`). Dropping
  it looks for a bare id and silently reports the file as missing.
- **Skip recycled DIRECTORIES.** A fanout dir gets its own `$I` entry with no
  filename; `mkdir` on demand recreates it, and copying onto the existing directory
  is `EPERM`. 117 of the 393 entries were directories.
- **Only restore what git cannot rebuild.** `.rev`, `.mtimes` and `objects/info/*`
  are derived — a stale copy is a corruption risk for zero gain.
**Missing TREES are rebuildable from the index, hash-exactly:** `git ls-files -s -z`
into a throwaway index (`GIT_INDEX_FILE=<tmp>`) then `git write-tree --missing-ok`.
It must be a fresh index — the real index's stale cache-tree makes `write-tree`
return the cached root and never descend, so the subtrees silently stay missing.
The rebuilt root matching HEAD's tree proved the reconstruction exact.
**Blobs are rebuildable from the working tree** wherever the file still hashes to
its committed SHA (`git hash-object -w <path>`); files modified since are lost.
**Rule:** a broken parent link does NOT block committing — it blocks `git log` and
`git push`. `git replace --graft <commit> <new-parent>` repairs local traversal and
is reversible (`git replace -d`); **`pack-objects` ignores replace refs**, so it
does not make a push work. `git push --dry-run` reports a clean fast-forward on a
repo that cannot actually be pushed — verify a push against a throwaway
`git init --bare` instead.
**Also:** with objects missing, git's `commit-graph` maintenance task fails on
every commit (`error: task 'commit-graph' failed`) — harmless but alarming. Both
`gc.writeCommitGraph=false` and `core.commitGraph=false` are needed to silence it.
**Finishing the cleanup takes BOTH steps, in this order:** `git reflog expire
--expire=now --all` then `git gc --prune=now`. The `expire` is the load-bearing
half — `gc` alone will not drop commits the reflog still references. And **`gc`
refuses to run at all while ANY ref points at a missing object** (`fatal: bad
object refs/<name>` → `fatal: failed to run repack`): here two of Cline's 69
`refs/cline/checkpoints/*` were already dead before the wipe, and deleting just
those two (`git update-ref -d`, values saved first) was the unblock. Note the
checkpoint refs are a likely CAUSE, not just a casualty — Cline's checkpointing
drives temp refs and stash-like operations in this repo.
**Test:** the recovery tool is kept at `.workbuddy-ai/scratch/restore-git-objects.mjs`
(that directory is gitignored, so the tool is local-only).

### 55. On a slow uplink you cannot push a big commit — and a FORCE push re-uploads it in full
A 2.3 MB commit refused to land for a whole session: every attempt ended in
`error: RPC failed; HTTP 408` after a suspiciously constant ~32 s. The pack was
fine; the **uplink was ~70 KB/s**, so the request body could not finish inside
GitHub's ~30 s request timeout. Small pushes (≤ ~1 MB) succeed, which is what
makes this so confusing: the same `git push` works, then doesn't.
**Batching works only for FAST-FORWARDS.** Pushing a chain of throwaway commits
to the remote advances the ref, so each pack is small and each one lands. But if
the final commit cannot descend from those staging commits, landing it needs a
force push — and when the remote tip is **not an ancestor** of the pushed commit,
`mark_parents_uninteresting` marks the tip's commits UNINTERESTING *without
walking their trees*. Nothing marks the blobs as present, so git re-sends the
ENTIRE diff even though the remote already holds every tree and blob. That is
why pre-seeding the objects with staging commits buys nothing: measured here as
81 objects / 2.28 MiB, byte-identical to the honest push. `git rev-list --objects
<new> --not <tip>` reproduces exactly the object set git puts in that pack, so it
is the right local probe; a clean-room repo reproduces the same asymmetry.
**Consequence:** the git protocol has no "send just this object" mode — a push
prunes (fast-forward) or re-uploads (force). When the size is the obstacle, stop
using the protocol. If the tree and parents are already on the server, the
missing object is the **commit itself**, and `POST
/repos/{owner}/{repo}/git/commits` builds it server-side for free: a git commit
object is a deterministic serialization, so passing the tree, parents, author,
committer and message read from `git cat-file commit <sha>` reproduces the same
SHA **byte-for-byte** (verified) rather than creating a "different" commit. Then
`PATCH /repos/{owner}/{repo}/git/refs/heads/<branch>` with `force=true`. Two traps:
- Use the `cat-file` output **untrimmed** — a stored message ends in `\n`, and
  trimming it changes the SHA (and the API happily returns a different commit
  that looks correct in `git log`).
- Keep the author/committer date's original `+HH:MM` **offset**; normalizing to UTC
  changes the SHA too.
**Tools:** `.workbuddy-ai/scratch/stage-push.mjs` (splits a big commit into
pushable fast-forward batches) and `api-commit.mjs` (materializes one commit via
the API). Both are local-only; the scratch directory is gitignored.

### 56. A drop in the same document reads the dragged IMAGE's bytes and nothing else — measure a drag payload, never reason about it
The p-tray's drag-to-chat stopped working with no error anywhere: the drop just
did nothing. Three passes of reasoning about the payload produced three wrong
answers, each defended by a plausible mechanism. What settled it was measuring the
drag itself — real Chrome, every payload shape dispatched side by side from ONE
page (`dev/ext-tray-probe.mjs`, which also drags out of the tray itself and prints
what each drop received, with the seeded original and its derived thumbnail as the
yardstick):

| what the drag source declared | what a drop in the same page actually received |
|---|---|
| `setData('DownloadURL', url)` only | an **empty store** — no URL, no file |
| `items.add(new File([blob], name))` | the **filename** as `text/plain`, **no file item** |
| `DownloadURL` + File | the filename, nothing else |
| `DownloadURL` + `text/uri-list` | the uri-list only; the DownloadURL is gone |
| a dragged `<img>` | a real **File** of that image's own **encoded** bytes |

- **A same-document drop reads files, not strings.** Chrome resolves
  `DownloadURL` for an OS drop or a drag to ANOTHER tab; for a drop into the same
  document the target's `DataTransfer` is built from what the renderer put in the
  store, and a string format is not part of it. The tray is injected into the chat
  page, so the chat box IS the same document: a payload of strings is a payload of
  nothing.
- **`items.add(File)` does not deliver bytes.** The item arrives as `text/plain`
  — the *filename* — with `files: []`. A blob-backed `File` has no path and no
  synchronously available buffer, so nothing travels. This is the trap that made
  "carry the original's bytes as a File" look right and do nothing.
- **Only a dragged `<img>` works**, because Blink writes the image resource's own
  encoded bytes into the store itself (`DataObject::WriteImageToDataObject` →
  `AddFileSharedBuffer`) *before* `dragstart` runs. Consequence: whatever that
  image has loaded is what the drop gets, so point the image at the stored
  original and full quality is structural. An image loaded from a `blob:` URL
  contributes exactly the blob's bytes (verified by hash, not by size).
- **Blink builds that payload BEFORE the handler runs**, which is why a
  `dragstart` handler cannot rescue a wrong-source drag: swapping the `<img>`'s
  `src` there is too late, and `setDragImage()` is a preview only. The image must
  already be showing the original when the gesture starts, so upgrade it on
  `pointerenter`/`mousedown` — a `blob:` load of bytes the tray fetched anyway is
  local, and the pointer has to aim before it can drag. A grab that crosses
  Blink's drag threshold before that lands still carries the derived thumbnail:
  the one hole left — and it is REPORTED, not silent (the tray's status line says
  `went out as the 400px preview` on `dragend`). A downgrade nobody can see is how
  this whole incident started.
- **Do not "warm" a drag with a hidden overlay image.** A second, transparent,
  full-bleed `<img>` as the drag source is a real image drag target covering the
  whole tile, which arms an image drag on the first pixel of movement — one
  mechanism that made both the drag and the tile's click-to-copy misbehave.
- **`-webkit-user-drag` on the tile's image is load-bearing.** `none` there sends
  Blink's `DragController::DraggableNode` walk past the image to the CELL, and a
  cell is a DHTML drag — a payload of strings, which per the table above reaches a
  same-document drop as nothing. Note what `none` does NOT do: it does not stop the
  drag (the walk `continue`s up to the parent), which is exactly how a
  cell-as-source arrangement can start a drag, look healthy, and leave the chat box
  with a bare filename. Read `DraggableNode`, not the "user-drag: none disables the
  subtree" folklore.
- **Do not cancel `selectstart` on a drag source.** This repo already paid for
  that once (v0.3.5): canceling it aborts Chrome's drag initiation on draggable
  elements, and `user-select: none` CSS makes the suppression redundant.
- **The one-string-format rule is about `setData()` with MULTIPLE types** (crbug
  40459758, formerly 55071/451437 — "setData multiple formats does not work if one
  of the types is DownloadURL"). It does NOT mean a `DownloadURL` cripples a native
  image drag: measured here, the file still arrived byte-for-byte with a
  `DownloadURL` set beside it. Keep `DownloadURL` for the OS-drop / cross-tab case,
  keep it the only string format the handler sets — and never build a payload
  whose only entry is a fetch.
- **Two stale-origin bugs surfaced with it, and for the same reason.**
  `serverHostSynced = true` sat OUTSIDE the `try` around the pinned-host read, so
  one failed `getHost` (the SW is usually asleep on a page's first load) pinned
  `SERVER` to the hardcoded default for that page's lifetime; and only the media
  path ever adopted a serving origin. A `DownloadURL` fetched by Chrome itself
  fails *silently* on a stale origin, so both bugs were invisible everywhere
  except the drag. Latch only on a SUCCESSFUL read; adopt the origin from every
  direct fetch that answers.
**Fix, in shape:** the tile's `<img>` is the drag source, upgraded to the original
(`upgradeTile`: reuse ONE object URL per capture, revoke it with the blob it wraps
and drop that tile back to the thumbnail — a revoked URL left on screen is a broken
image), the grid keeps displaying 400px thumbnails, and `dragstart` adds the
`DownloadURL` and nothing else. And when a drag payload is the question, do not
reason: `node dev/ext-tray-probe.mjs` dispatches real drags in real Chrome and
prints what each drop received, with controls that set each shape by hand — so
"the tray is broken" can never be confused with "this browser cannot carry that
shape at all".

### 57. A clipboard write cannot outlive its user activation — hand the API a promise, not encoded bytes
Clicking a capture in the p-tray sometimes answered *"copy blocked"* for a copy
that then worked from the toolbar popup, which is the tell: the clipboard, the
permission and the encode were all fine. `navigator.clipboard.write()` needs
transient user activation (about five seconds in Chromium) and the clipboard API
only accepts PNG — so a copy has to re-encode the capture first, seconds of work
for a 12MP photo, plus a LAN fetch of its bytes on a cell the pointer never
warmed. The old shape awaited all of that and *then* called `write()`, so by the
time the write ran the activation was gone: `NotAllowedError` on a copy that was
perfectly legal when the user made the gesture. **Fix:** call `write()` FIRST, in
the click, and build the item over a `Promise<Blob>` — `new ClipboardItem({
'image/png': pngFor(c) })`. The API accepts a promise for its data exactly so a
slow encode does not have to fit in the activation window; the encode then runs
while the browser already holds the write. Keep the awaited form only as the
fallback for a build that rejects a promised blob (a `TypeError` on the item), so
no browser loses the copy. Two follow-ons: because a second caller can now arrive
mid-encode, the encode cache returns the IN-FLIGHT promise for that id instead of
starting a duplicate (a 48MP PNG is seconds of the worker thread, and the click,
the auto-paste retry and the undelivered flush all want the same one); and a
refusal the user can actually fix is reported as fixable — the clipboard needs
the PAGE to hold focus, and clicking the toolbar took it away, so the status says
so instead of reading like a dead feature.

**The harness kept the awaited shape for months after this entry was written.**
Same symptom, same diagnosis, same fix — "copy blocked" on a *recent* capture
(the one whose encode is not yet memoized), then working on the second click
because the first had filled the cache. If a copy works from one surface and not
another, diff the two `ClipboardItem` constructions before suspecting anything
else: `new ClipboardItem({ 'image/png': await encode() })` is the bug, whatever
the file is called.

### 58. "Most visible editable element" is not "the last editable element in the DOM"
Auto-paste occasionally dropped a capture into a comment box below the composer,
or into a search field, while the chat's own composer sat empty. The comment said
"most-visible editable element (chat sites keep exactly one)" and the code took
`cands[cands.length - 1]` — DOM order answers a different question, and on a real
page (a rail, a footer, a comment thread) the two answers differ. Two smaller
holes travelled with it: the selector list was `[contenteditable="true"],
textarea, input[type="text"]`, which misses `contenteditable=""` (an EMPTY value
IS editable), `plaintext-only`, and the `role="textbox"` wrappers some composers
are built from; and `document.activeElement` was accepted on tag/type without
checking it was visible, so a focused `type=hidden` control could win outright.
**Fix:** recognise the element for what it IS (`isContentEditable`, tag, type —
with `getClientRects()` doubling as the visibility test and the `type=hidden`
guard), keep a focused editor first because that is where the caret is, and
otherwise pick the candidate with the largest visible area: a composer is big and
a search field is not. Body stays the last resort, so a site that handles paste at
the document level still gets its shot.

### 59. A list that only loads when its panel opens is frozen — and two transports that ask different questions drift
Two shapes of one disease — a path that is fully wired and still cannot work —
found a layer apart in the p-tray's text relay:
- **The signal existed and nobody read it.** `/api/captures/version` returns
  `{ n, latest, textId }`, and its own comment says the text fingerprint is there
  "so poll-fallback clients notice text changes too". The tray polled that route
  every 5s and used `n`/`latest` for the captures, discarding `textId` — while the
  text list was rendered ONLY when the tray opened (`setOpen` → `loadTexts`). Net
  effect: a text sent from the phone while the tray was open never appeared. The
  list looked live and was frozen until the panel was closed and reopened, which
  is the hardest kind of bug to report because nothing errors. **Fix:** the poll's
  own response drives it (`v.textId !== textsVersionId` → a quiet refresh — no
  extra request, no second timer), checked BEFORE `load()`'s unchanged-captures
  early return, since a text can change while the capture list does not.
- **Two transports, two row counts.** The SW relay fetched
  `/api/text?source=phone&limit=10` and the page-side fallback fetched
  `…&limit=5`, so which list you saw depended on whether the worker was awake.
  Nobody could see it: both are plausible, and the shorter one only appears on the
  path taken when the relay fails. **Fix:** the caller owns the number
  (`TEXTS_LIMIT` in content.js) and passes it in the message; the SW relays what
  it is asked for, clamped once against the server's own cap. Same reasoning as
  the shared `discovery.js`/`files.js` modules and the "private copy that drifted"
  traps — with one belt added: the value now has exactly one owner.
**Two smaller traps in the same function**, both about a 5s poll repainting a panel
a human is reading: a quiet refresh must not flash the loading placeholder, and
must not rebuild an identical list (that throws the scroll position away every
tick). It compares an `${id}:${body}` key and returns early, and a transient error
keeps the last good list instead of painting "server not reachable" over rows the
user is reading. And because opening the tray fires a LOUD load while the poll's
own refresh can fire a quiet one, a sequence number decides which result may
paint — otherwise the loud pass could find the key already written by the quiet
one and leave the placeholder on screen for good.
**Test:** `test/extension-logic.test.js` — the text-relay guard pins the single
limit, the textId hook's position relative to the captures early return, the key
comparison, and the sequence guard.

### 60. An emscripten `cv` exists before its wasm runtime does — and `getUserMedia` needs a loopback origin
Vendoring OpenCV.js (the webcam-scan feature) hid two boot-order traps. (1) The
single-file build defines `window.cv` **synchronously** as the script is appended,
but `cv.Mat` does not exist until the wasm module initialises a moment later, so
reading `cv.Mat` at `script.onload` threw "cv.Mat is not a constructor". Polling
for `window.cv && window.cv.Mat` (60ms, 60s cap) is the handshake that survives
across builds; the ~10 MB module is also injected **lazily** on first open, never
in the shell. (2) `navigator.mediaDevices.getUserMedia` exists only in a **secure
context** — `https://` or a loopback host. `ProofPipe.bat` opens
`http://localhost:8787` (secure), but the same harness reached over its LAN IP
(how the phone connects) is NOT, and `getUserMedia` is simply `undefined` there
with no thrown error to catch — check `window.isSecureContext` up front and say
so. **Measure it, do not read it:** both traps are a silent no-op, not a visible
failure, and `dev/pc-harness.mjs` cannot drive a camera — the modal was measured
by forcing `#scan-backdrop` open (layout only: 680×600 box, 4:3 stage, 34px
buttons, no overflow at 1440×900 or 1200×700), and the camera paths are pinned by
the `getTracks().forEach(t => t.stop())` / `isSecureContext` source assertions in
`test/harness-ui.test.js`.

## Networking / pairing (hotspot + VPN sessions)

### 61. A VPN tunnel's address is a private IP too — the range cannot tell it from a hotspot
Pairing broke the moment a hotspot password changed, with the server healthy and
listening on `0.0.0.0`. `lanIPs()` scored candidates by **range alone**
(`192.168` → 0, `10.x` → 1, `172.16-31` → 3) and `server.js` puts `lanIPs()[0]`
into the QR. A VPN adapter carries a private address in the *same* ranges: the
hotspot handed out `10.179.242.175` while Windscribe's IKEv2 tunnel sat on
`10.189.137.195`. Both scored 1, `Array#sort` is stable, interface order broke
the tie — and the tunnel was enumerated first, so `/qr.png` encoded
`10.189.137.195`, an address that exists only on this PC. The phone scanned a
dead URL; nothing logged an error anywhere.
**Fix:** classify by **adapter name**, not address — `Windscribe`, `WireGuard`/
`wintun`, `TAP`/`OpenVPN`, `Tailscale`, `ZeroTier`, `vEthernet`, `VMware`,
`VirtualBox`, `Docker`, `WSL` all rank below every real NIC whatever their range.
Keep them in the list (the picker, the boot log and the `csrfSafe` host check all
need them); only the **default** must be a real one.
**Test:** `test/lan-ips.test.js` (injectable interface map, so no live machine).

**The second half of the same failure is not ProofPipe's:** a kill-switch VPN can
block the LAN at the driver level, so even the *correct* IP is unreachable. The
tell is `EACCES` ("Bad access") from `connect()` **on the machine's own address**
— a firewall that only filtered inbound would hang, not refuse. Check it with a
throwaway server on `0.0.0.0` and one `fetch` per adapter address; Windscribe
logs `"isAllowLanTraffic": false` when its firewall is the culprit. Turn on
"Allow LAN traffic" (or disconnect the VPN) — no amount of address picking fixes
a blocked adapter.
