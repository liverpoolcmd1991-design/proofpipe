# ProofPipe — capture & sync

Phone photo (and text) to PC, one tap — for pasting handwritten proofs and
snippets into AI chats.

## Run
Double-click **ProofPipe.bat** in this folder (or run `npm start` from here). It
starts the server (v1.21) and opens the harness at http://localhost:8787 once
the server is actually listening — in the browser you chose in Settings
("Open harness in", defaults to your system's default browser). The console window is titled "ProofPipe" and
stays open — **closing that window (or Ctrl+C) stops the server**. If the port
is already in use it says so and waits for a key instead of vanishing, and any
error pauses before exit so you can read it. Run tests with `npm test`
and lint with `npm run lint` (ESLint with the full recommended rule set, plus a
manifest/permission contract test). The shipped dependency tree is audited in
CI (`npm audit --omit=dev`). Requires **Node 20+** (declared in `engines`).
For a desktop feel, right-click
the .bat → Send to → Desktop (shortcut). See **CHANGELOG.md** for the full history
and **PITFALLS.md** for platform gotchas learned while building this
(MV3 service-worker amnesia, synthetic-paste staging, Fastify plugin ordering,
Windows test flakes — worth a read before touching the extension or server).

## Harness (PC) — http://localhost:8787
- **Grid**: click to open the lightbox — a small thumbnail paints instantly and
  the full-resolution original cross-fades in behind it (scroll / Ctrl+scroll =
  zoom at cursor, drag = pan, double-click = reset, R = rotate, ←/→ = flip,
  F = fit ↔ actual size, Space = back to the grid, Del = delete and advance).
  The caption shows `#id · N of M · date/time ·
  origin` — provenance is on screen, not only in the image tooltip. The zoom
  hint is a one-time coach mark, and the open animates out of the tile it came
  from. Tile tooltips show the full capture timestamp.
  Hover actions: 📋 copy, 📱 send to phone, ⋯ more (download, delete).
  Every tile has a selection box in its bottom-left corner: tick it to start a
  multi-select, then Delete the group or drag it into a chat.
  Keyboard: ↑↓←→ or J/K move (highlights the focused tile) · Enter or Space
  open the viewer · C copy · D download · X delete · S select ·
  1/2/3 Captures/Transfers/All · ⌘A select the whole list · ⌘C copy the
  selection · ⌘⇧S save the selection. **Ctrl/⌘+click** toggles and
  **Shift+click** selects a range — both without entering Select mode.
- **Where a capture came from**: a small colored pill sits on each
  thumbnail's bottom-left corner — green 📱 for phone-sent shots, blue 🖥
  for PC-added ones (drag & drop / paste). The sidebar hint card explains
  both. Pre-existing captures show no badge.
- **Thumbnail size**: S/M/L icon buttons in the toolbar (more space for bigger
  tiles), and the grid auto-loads older captures as you scroll. Skeletons show
  while the first page loads.
- **Delete is undoable**: tile and Delete-key deletions show an **Undo** button
  (10s, with a shrinking countdown bar); bulk delete shows a single
  **"Deleted N · Undo all"** toast. The confirm dialog defaults to Cancel and
  Esc cancels it. "Delete all" keeps a hard confirm.
- **Drag & drop / Ctrl+V** an image anywhere on the page to upload from the PC.
  The capture area shows a dashed hint border while it's empty, and the drop
  overlay animates when you're dragging.
- **Scan a document** (the camera button beside ＋File): opens your webcam and
  snaps the page edges automatically — drag the four corners to fix the crop —
  then deskews it into a normal capture, **auto-copied** so you can Ctrl+V it
  straight into a chat. The scanner needs a secure context, so open the harness
  at `http://localhost:8787`; from the LAN address the button says so instead of
  failing silently.
- **Text ⇄ phone**: type, Enter sends to the phone. Incoming phone texts appear
  as a chip — click to expand it, 📋 to copy; `history` shows the last 20 in
  **both** directions with timestamps.
- **📱 Send to phone**: pushes the capture to the phone as a tappable image
  chip (thumbnail + PC badge, tap to preview full-screen). The chip resolves
  its image from the phone's own origin (like the recent-captures tiles), so
  a stale or unreachable host in the stored link can never make the open
  fail. Deleting the capture on the PC also removes its chip from the phone.
  Chip thumbnails retry automatically while the background thumbnail
  finishes deriving.
- **Auto-copy toggle** (sidebar under the keyboard hint): tick "Automatically
  copy new capture to clipboard" and every fresh phone snap is copied straight
  to the clipboard — walk straight to Claude/ChatGPT and Ctrl+V, no clicking needed.
- **Auto-cleanup toggle** (settings modal): when storage passes 80% of the cap
  (500 MB by default — change the cap itself in the settings modal, 50 MB–1 TB;
  `PP_MAX_STORE_MB` overrides the built-in default), the OLDEST
  captures are deleted automatically until back under the threshold. Off by
  default. The same toggle lives in the phone's More menu — flipping it on
  either device syncs it to the other instantly.
- **Retention auto-delete** (settings modal): deletes captures older than N
  days (0 = off, up to 3650). The sweep runs at boot, hourly, and on every
  upload — a quiet gallery still gets cleaned on schedule, not just when the
  next photo arrives.
- **Pair phone**: scan the QR (pick the right network adapter from the dropdown
  if you have several NICs — the choice is remembered). The stats box warns you
  if the phone has never connected.
- **Transfers tab** (next to Captures, remembered): any file type, both
  directions (PDF, ZIP, docs, video, APK… — 1 GB per file). "＋ File" sends
  to the phone with a progress bar; drag&drop routes images to Captures and
  everything else here. "Show all" merges files into one view. Phone files
  auto-save into `data/inbox/` (toggle in the sidebar, default ON) — the
  file is already on disk when you look up.
- The "Live" pill shows an amber package badge with the phone's queued-photo
  count while photos are waiting to upload.
- **Open harness in** (settings modal): pick which browser ProofPipe.bat
  opens the harness in — "Default browser" (your OS default), or any
  installed browser the server detected (Chrome, Edge, Firefox, Brave, Opera,
  Vivaldi, Chromium, plus anything registered in Windows "App Paths" so
  custom installs show up too). Applies the next time you start ProofPipe.bat.
- **Backup now** (sidebar, under the storage path): pick a folder — ProofPipe
  writes a timestamped zip there containing the SQLite database (WAL
  checkpointed first), `settings.json`, and every capture / transfer file /
  inbox copy. PC-only (the endpoint answers loopback requests, like the
  folder picker). Restoring = drop the zip's contents back into the data /
  media folders with the server stopped.
- If the server was updated, a banner stays until you click **Refresh now**.

## Phone — http://<pc-ip>:8787/phone
The header is a **status strip** that says what the link is doing:
`connected · N sent`, `reconnecting…`, `offline`, or — on a phone that has never
reached the PC since the page loaded — **`not paired — scan the QR on your PC ·
same Wi-Fi`**, which is a different problem with a different fix. It is tinted by
state, so you can read it without reading it. The grid of recent captures sits
directly under it, and **Capture** is the white button at the bottom, where your
thumb already is.

1. Connect the PC to the phone hotspot (same network)
2. Scan the QR on the harness, then Chrome → "Add to Home screen" → app icon
3. **Capture** → lands on the harness instantly. Offline photos queue
   automatically and sync when back online (tap the queue counter to retry the
   queues now; clearing them is under More options).
   **Auto-paste toggle**: flip it ON and each capture is pasted straight into
   the chat tab you last used on the PC — no drag, no keystroke (see the
   extension section below).
4. Tap any photo → gallery viewer: swipe left/right to flip through recent
   shots (a "3 / 15" counter shows where you are), pinch to zoom (the image
   tracks your fingers 1:1 and can never be panned off-screen), double-tap
   to zoom in/out at the tapped point, **Rotate** (a quarter-turn per tap),
   **Download**, **Delete** for server-backed shots, plus **Retry send** /
   **Discard** while a photo is still pending. Copying images happens on the PC side (Ctrl+V on the
   harness) — the phone viewer retired its Copy button.
5. **Text → PC** in the big text box (Enter sends; the chevron expands it
   into a drafting box — Enter becomes a newline while expanded, and it
   stays expanded across sends). Offline texts are queued
   (shown as "✉ N texts queued") and sent automatically when back online.
   Incoming PC texts are chips — tap to copy. Captures sent from the PC
   (via 📱 Send to phone) arrive as **image chips with a PC badge**: tap one
   to preview the full-resolution original in the same viewer (pinch-zoom,
   Download, swipe between PC-sent shots).
    Files sent from the PC arrive as **file chips** (name · size · 🖥 badge):
    tap for **Save** (download) or **Open** (media/PDF inline, the rest
    downloads). The **File** button beside Gallery sends any file to the PC
    with per-file progress — offline files queue and sync when back online,
    and arrive auto-saved in the PC's `data/inbox/` folder.
6. **Share → ProofPipe** from any Android app: shared **images** are sent to
   the PC as full captures (they appear in the grid, count against storage,
   and are auto-pasted if the toggle is on — same pipeline as the shutter
   button; HEIC "high efficiency" photos are re-encoded to JPEG by the phone
   when possible and stored as-is otherwise — either way they land, and the
   PC grid shows the derived thumbnail); shared **text/links** land as a text
   chip on the PC. (An old cached manifest may still share text-only via the
   legacy GET path.)
7. **More options** (the ⋮ at the right of the status strip — the only way in)
   tucks the rare/destructive actions out of the way (the destructive ones still
   confirm): **Auto-cleanup** switch (synced with the PC's toggle), **Reduce
   transfer quality** + its slider, **Auto-paste** switch, **Open latest on PC**,
   then a separated **Clean up — these delete data** group holding **Clear recent
   captures**, **Clear PC-sent captures** (also wipes their PC-side history) and
   **Clear queued photos**, and finally **Delete all captures on PC**.
   Sync is automatic — SSE while connected, the adaptive poll loop when not,
   and a re-check when the app regains focus or comes back online. If the load
   failed, **Retry now** forces one.

## Browser extension (v0.9.3)
Chrome: `chrome://extensions` → Developer mode → Load unpacked → select `extension/`. Edge: same folder at `edge://extensions` (Chromium MV3 + `offscreen` work unchanged — no separate build). Firefox is NOT supported (no `chrome.offscreen` / `chrome.storage.session` equivalent).
- **Auto-paste follows the PC browser pick** — the Settings → "Open harness in" choice (`settings.browser`) is stamped onto every auto SSE event as `autoTarget`, and each extension instance pastes only when the tag names it (`extension/browser-target.js`: Edge UA → `edge`, everything else → `chrome`). Pick "Microsoft Edge" and only the Edge extension pastes; Chrome stands down (and vice versa). `Default browser` pastes in ANY instance (the OS default is invisible to extensions — install the extension in only ONE browser, or pick it explicitly to avoid double-pastes). Picks that name another **Chromium** browser (Brave, Opera, Vivaldi, Chromium) paste in the chrome-family instance — their UAs are indistinguishable from Chrome, so they follow the `chrome` path rather than pasting nowhere. A **Firefox** pick pastes nowhere in Chromium (no Firefox extension). If the picked browser has **no live extension connected**, auto-paste falls back to pasting in whatever instance *is* connected — so picking a browser you didn't install the extension in can't silently kill auto-paste.
- **Server-port discovery** — the extension no longer hardcodes port 8787.
  It probes loopback candidates (8787, then common alternates), verifies the
  endpoint answers `/api/version` like ProofPipe, and pins the origin
  (survives browser restarts). Run the server on any `PORT` and the
  extension follows automatically.
- **Auto-paste** — flip **"Auto-paste into chat: ON"** on the phone. Every new
  capture is then pasted straight into the chat tab you last had focused on
  the PC — no drag, no keystroke, and it works even when Chrome isn't the
  foreground app. How the pipeline works, stage by stage:
  1. **Tagging**: the phone upload carries `auto=1`; the server persists it
     and emits an instant SSE `capture-ready` event (the original is
     available — no thumbnail wait).
  2. **Relay**: an offscreen document holds the SSE connection (MV3 service
     workers can't) and forwards events to the background worker. A **watchdog
     alarm (every 5 min)** verifies the offscreen doc exists *and* answers a
     ping — a crashed relay used to die silently until the next browser
     restart; now it's torn down and rebuilt automatically. (The relay itself
     already recovers from ordinary SSE drops via reconnect + backoff; the
     watchdog is only insurance against Chrome killing the document.)
  3. **Routing**: the last-focused chat tab is remembered in
     `chrome.storage.session`, so it survives service-worker idle restarts
     (~30s). If it's gone, known chat sites (claude.ai, chatgpt.com,
     gemini.google.com, …) are preferred over whatever tab happens to be
     active. No target → a green `1` badge on the extension icon.
  4. **Media**: the capture is fetched **through the background worker**
     (`mediaBlob` message — a real Blob, no base64). The worker starts the
     fetch the moment the capture event arrives — it races the routing
     message to the tab, so the image is usually already local when the
     content script asks. The worker's fetches carry `host_permissions` and
     are immune to page-level Local Network Access blocks that kill direct
     loopback fetches from public https pages (and the clipboard fallback
     needs focus, which auto-paste doesn't have).
  5. **Paste**: a synthetic paste event carrying the real file. Dispatch is
     **staged**: non-bubbling first (only the editor's own handler — what a
     real Ctrl+V effectively does), verified, then a bubbling attempt only if
     the page ignored the first. Success detection is universal —
     `dispatchEvent()` returning `false` (the site called `preventDefault()`,
     as real handlers do) ends the chain immediately; DOM-wide signals
     (unique `proofpipe-<id>` filename including shadow-DOM text, editor
     length, img/canvas/blob: counts, an `input` event) catch everything
     else. Editors that accept only PNG get one PNG re-encode retry.
     This staging is what keeps sites from pasting the same image 2–4 times
     (a naive `bubbles: true` dispatch fires editor AND document handlers).
  If both paste and clipboard fail (e.g. tab never focused), the capture is
  **queued and auto-copied on the next focus** of that tab — the popup shows
  "N capture(s) waiting" and any per-site "ignores paste events" flag.
  Toggle off (or never on) and the manual workflow below is untouched. After
  reloading the extension (or it auto-updating), refresh your chat tabs once —
  content scripts don't re-inject into already-loaded pages.
- **p button on any site** (bottom-right): open the tray and **drag** a capture
  straight into a chat's message box (the drag carries the full-resolution
  original's own bytes — never the grid thumbnail), or click one to copy it.
  **Drag the button itself to move it** (the position is remembered), and
  **right-click it to hide it on the current site** — collisions with chat
  widgets are your call now. Hide/show **everywhere** lives in the toolbar
  popup instead — a control inside the thing it hides could never be undone
  from the page.
- **Toolbar popup**: Captures tab (click = copy; the item flashes a ✓) and
  Texts tab (tap-to-copy texts from the phone), plus ⟳ Sync now and
  **Show p button on this site** (appears when you've hidden it there). The
  bottom row's **Hide p button everywhere / Show p button everywhere** toggle
  reads and writes `chrome.storage.local` itself, so it works from any tab —
  chrome:// pages and the Web Store included, where no content script exists;
  already-open tabs follow it instantly via `storage.onChanged`.
- **Send text to phone**: select text on any page → right-click →
  "Send to phone via ProofPipe".
- Note: dragging only works from the p button — Chrome closes popups mid-drag.

## Storage & copy quality
- Captures are stored **full-resolution, byte-for-byte** as sent by the phone
  (`server.js` never re-encodes the original — only a small grid thumbnail is
  derived, in the background right after the capture lands, and the boot sweep
  regenerates any thumbnail that goes missing). The phone's own viewer shows
  that original.
- **Copy on the PC harness** re-encodes to PNG (the clipboard API only
  accepts PNG) **at the resolution the capture is stored at** — a 4000×1844
  photo and a 1080×24000 scrolling screenshot both paste 1:1. The one thing
  that can still resize is a canvas that physically cannot hold the image
  (32767px per side / 2^28px of total area), which no *storable* capture
  reaches, and it shrinks by the overlap only. Download always grabs the
  untouched original. The PNG encode runs on a Worker, so the page never
  freezes mid-copy.
- **The phone's transfer-quality setting is the only thing that may shrink a
  capture.** With it **off**, a photo goes up at the resolution it was taken
  at: the HEIC→JPEG conversion the PC needs in order to display an iPhone
  photo now changes the format *only* — it used to also clamp the longest side
  to 4096px, so a 48MP HEIC arrived at 4096×3072 (a quarter of its pixels)
  with the setting off and nothing anywhere saying so. With it **on**, the
  phone re-encodes to JPEG at the configured level and still clamps the
  longest side to 4096px, as before.
- **The PC accepts captures up to 64MP** (`server/store.js` `MAX_PIXELS`) —
  every real phone sensor mode, from a 12MP shot to an iPhone 48MP HEIC
  (8064×6048) or a 50MP Android JPEG, so a full-resolution photo is never
  refused and never has to be shrunk to fit. This ceiling is *published* to the
  phone (`GET /api/quality` → `maxPixels`) so it never has to guess one. Past
  it, an upload is refused as a **terminal 413** and the phone says which
  switch fixes it — instead of retrying the same impossible bytes every 5
  minutes in silence.
- **Dragging a capture out of the p-tray always carries the original** — full
  quality, by construction. A drop in the same page can read exactly one thing:
  the dragged **image's own encoded bytes**, which the browser writes into the
  drag store itself. So the tile's image *is* the drag source, and the tile the
  pointer is on is upgraded to the **stored original** first — a local `blob:`
  load of bytes the tray had already fetched on hover, so no second transfer, no
  re-encode and no added latency on the gesture. What travels is the stored file,
  byte-for-byte; the grid still *displays* 400px thumbnails, which is what keeps
  opening the tray cheap. The phone's transfer-quality switch is already baked
  into the stored file — the tray never re-encodes. The drag also declares the
  capture's **real format** (`image/png` + `.png` for a screenshot, `image/webp`,
  `image/heic`…) taken from the stored name, instead of labelling every capture
  `image/jpeg` / `.jpg` — a consumer that trusted that label re-encoded the
  pixels lossily — and sets Chrome's **`DownloadURL`** (the only string format,
  in its own `try`) for what image bytes cannot cover: an OS drop or a drag to
  another tab. Strings alone reach a same-page chat box as *nothing*, which is
  why the payload is shaped this way — see PITFALLS #56, and
  `dev/ext-tray-probe.mjs` for the measurements behind it.
- **Clicking a capture copies it, and the tray says honestly which happened.**
  The clipboard API only accepts PNG, so a copy has to re-encode the original
  first, and Chromium's user activation only lasts seconds — so the write now
  starts *before* the encode and is handed a **promise** for the PNG. A 12MP
  capture copies instead of reporting "copy blocked" for a copy it had actually
  made. All three clipboard writes in the tray go through one path, one encode
  per capture is shared rather than run twice, a fresh copy is never downgraded
  (PNG is lossless and `toPng` resizes only what a canvas cannot hold at all),
  and the one refusal you can fix tells you what to do — *"click anywhere on this
  page, then copy again"*, because the clipboard needs the page focused and
  clicking the toolbar took focus away.
- **Ctrl/⌘+Enter sends a capture straight into the chat.** Enter/Space copies, as
  the tile's tooltip says; Ctrl/⌘+Enter runs the same transfer the phone's *auto*
  mode uses — target discovery, the PNG retry, the clipboard fallback and the
  undelivered queue all included — so a keyboard user gets the capture INTO the
  page's own editor, with no clipboard and no Ctrl+V owed. The shortcut is named
  in the tooltip, in the tile's accessible name and in the tray's status line.
- **Auto-paste aims at the composer, not at the last editable box on the page.**
  The target is the focused editor when there is one (that is where the caret
  is), otherwise the **largest visible** editable element — a composer is big and
  a search field is not, which is what the old last-in-DOM-order rule got wrong.
  `contenteditable=""`, `contenteditable="plaintext-only"` and `role="textbox"`
  editors all count; password and hidden controls never do.

## Configuration (environment variables)

All optional; defaults suit a personal trusted-LAN setup.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Server port — the extension discovers it automatically |
| `PP_MAX_STORE_MB` | `500` | Photo-capture storage cap **default** (auto-cleanup trims at 80%) — a cap chosen in the settings modal overrides it |
| `PP_MAX_FILES_MB` | `2000` | Transfer-file storage cap (oldest drop at 80%, always on) |
| `PP_MAX_FILE_MB` | `1024` | Per-transfer-file size cap |
| `PP_RATE_CAPACITY` / `PP_RATE_REFILL_PER_MIN` | `60` / `120` | Photo-upload token bucket |
| `PP_FILE_RATE_CAPACITY` / `PP_FILE_RATE_REFILL_PER_MIN` | `30` / `30` | Transfer-file token bucket |
| `PP_DATA` | `./data` | Alternate data dir (tests/sandbox) |
| `PP_LOG` | unset | `1` (or `debug`) logs every request line; default logs only uploads/shares/deletions. Errors always log to stderr. |
| `PP_EXTENSION_ID` | derived from `extension/manifest.json`'s `key` | Pins the ONE trusted `chrome-extension://` origin for mutations. Set it for a packed / Web-Store build whose id isn't in our manifest. |

## Android share target
The installed PWA registers a **POST multipart** share target (`/share`):
"Share → ProofPipe" from Gallery, WhatsApp, etc. sends photos and text in one
shot. The server stores shared images through the exact same hardened
pipeline as `/upload` (stream-to-disk, pixel-cap probe, byte-for-byte
originals, background thumbnails, SSE events, rate limit) and redirects back
to the phone with `?shared=1` (or `?shared=error` on failure) — the phone
flashes the result and cleans the URL. A cross-site POST to `/share` is
refused like every other mutation (a webpage must not flood disk).

## Native Android app
The native Android app (Kotlin + Jetpack Compose) replacing the phone PWA now
lives in its **own repo: [`BIGtourist1991/proofpipe-android`](https://github.com/BIGtourist1991/proofpipe-android)**
(separate from this server repo). It is a faithful port of the phone UI's
`phone.html`/`phone.css` via custom Compose components, plus true background
sync. The authoritative wire contract the app targets is **`API.md`**
(generated from the actual server routes) and the offline-queue policy in
`public/queue.js` (`PPQueue`) is transliterated to `SyncPolicy` in the app.
The build is CI-only (GitHub Actions) — the Android SDK/Gradle run on GitHub
runners, never on a dev machine. See the repo's `README.md` for the port map
and decisions.

## Data
Everything lives in `data/` inside this folder (SQLite DB + original images,
plus the optional HTTPS certs). Byte totals are tracked in the DB; an orphan
sweep on boot removes files with no DB row (including their thumbnails).

## Security model — none, by maintainer decision (parked forever)
ProofPipe has **no authentication** and answers **any** origin
(`Access-Control-Allow-Origin: *`) with `GET/POST/DELETE` open to the whole LAN.
Anyone who knows the PC's LAN IP can read, delete, or flood your captures and
texts. (The v1.8 origin check on DELETE requests — and on the
`POST /api/autopaste` / `POST /api/autocleanup` setting endpoints, which could
otherwise flip auto-cleanup ON cross-site and delete captures that way — stops
*cross-site* browser
requests — an arbitrary webpage you visit cannot wipe your captures — and only
*this project's* extension is trusted: the allowed `chrome-extension://` origin
is pinned to the id derived from `extension/manifest.json`'s `key`, so another
installed extension can no longer pass the mutation gate; but none of that does
anything against direct access from anyone on the network.) This is deliberate: the maintainer uses this project personally on a
trusted network, and a pairing token was in fact removed in v1.2 for exactly
that reason. This is **parked forever** — do not expose ProofPipe to an
untrusted or public network.

## Optional HTTPS (self-signed cert)
The phone only copies TEXT (which works over plain HTTP), and image Copy lives
on the PC harness where `http://localhost` is already a secure context — so
HTTPS is no longer needed for clipboard images. It's still available if you
want the phone served on a secure origin (installed PWA / share-target):
1. Run `npm run gen-cert` (needs `openssl` on PATH — Git for Windows ships it).
   It creates `data/key.pem` + `data/cert.pem` covering localhost, 127.0.0.1 and
   the PC's LAN IPs.
2. Restart ProofPipe: the server now serves everything over `https://` (the
   console, the QR and the harness URL all show it).
3. On the phone, open the QR link once, accept the self-signed-certificate
   warning (Details → proceed), then reinstall the PWA from the new address.
4. To go back to plain HTTP, delete `data/key.pem` / `data/cert.pem`.

## Troubleshooting the extension
If the popup says "server not reachable": start `ProofPipe.bat`, then press
**⟳ Sync now**. The extension tries the background service worker first, then
direct fetches to 127.0.0.1 / localhost (the server answers CORS + Private-Network
preflights). The direct fallback only runs while the tray/popup is open, so
Chrome's **Local Network Access** prompt ("…access other apps and services on
this device") can appear at most once per site — click **Allow** once and it
works everywhere; Chrome is just asking permission for the extension to reach
the ProofPipe server on 127.0.0.1, nothing else. The technical error is shown
at the bottom of the popup message.
