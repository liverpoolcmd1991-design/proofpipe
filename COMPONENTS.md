# COMPONENTS.md — component inventory

What already exists, where it lives, and when to use it. **Rule zero: before  
building any UI, check this list. If a component here can do the job, use it —  
do not create a parallel one.**

Two UIs share one design system (see DESIGN.md) but have separate surfaces:

| Surface                   | Entry                  | Styles                                     | Behavior               |
| ------------------------- | ---------------------- | ------------------------------------------ | ---------------------- |
| PC harness                | `public/index.html`    | `public/style.css`                         | `public/app.js`        |
| Phone PWA                 | `public/phone.html`    | `public/phone.css`                         | `public/phone.js`      |
| Extension popup           | `extension/popup.html` | inline `<style>`                           | `extension/popup.js`   |
| Extension tray (any site) | injected shadow DOM    | inline `<style>` in `extension/content.js` | `extension/content.js` |

The extension tray uses a **closed shadow root** with its own reset  
(`all:initial` + scoped styles) so host pages can't bleed styles in. Its  
visuals mirror DESIGN.md colors but are self-contained — don't try to share  
CSS with it; keep its copy in sync manually.

Styling approach everywhere: **plain CSS, semantic class names, design tokens  
as CSS custom properties in `:root`**. No Tailwind, no CSS modules, no  
styled-components, no build step. Icons are Lucide SVG masks (`.ic` classes),  
not icon fonts or inline paths.

---

## 1. Feedback & status

### Toast (PC) — `toast(msg, ms)` in `public/app.js`

- Bottom-center white pill; auto-dismiss; dedupes identical consecutive  
  messages by refreshing the timer.
- Supports an **Undo** variant (`deleteCaptureUndoable`): button + shrinking  
  countdown bar (10s window, `scaleX` not `width`).
- Every message is mirrored into ONE persistent live region,  
  `#toast-announcer` (`.sr-only`, `role=status aria-live=polite`) via  
  `announce(msg)` — the visible pill must not BE the region (it contains the  
  interactive Undo button) and a region created with its content already inside  
  it is often never announced. `#toasts` is positioning only.
- The stack sits at z-index 380: above the Settings/folder dialogs (so a  
  settings toggle's confirmation is not dimmed behind the veil), below the  
  confirm dialog (400), so an interactive Undo can never cover a Delete.
- Use for: transient confirmations. Don't build banners or alerts for these.
- Phone equivalent: **Flash** — `flash(msg)` in `public/phone.js` (same  
  visual, 1.6s, no undo). Renders top-center (safe-area aware) and is  
  `pointer-events:none` — never blocks taps beneath it. ONE reused node, so a  
  new message replaces the current one: a batch send used to stack identical  
  pills on the same spot, and a single node is also a single live region.

### Undo snackbar (phone) — `#undo-toast` in `phone.html`

- Interactive counterpart to the phone flash: bottom-center, `pointer-events:
  auto`, 6s window with a shrinking bar and an Undo button. Backed by  
  `startUndoWindow/settleUndo` in `phone.js`.
- **Defer, don't restore.** The DELETE is held until the window closes — a  
  PC-sent file's bytes can't be re-created on the phone, so Undo must mean  
  "never delete". Use it for any phone delete; `.flash` stays inert.

### Status dot / pill — `.pill` + `.dot` (`style.css`, `phone.css`)

- `.dot.ok|warn|off` = connected / reconnecting / offline.
- Use for: any connection or presence state. Never a new indicator design.

### Confirm dialog — `confirmDialog(...)` (`app.js`) / `phoneConfirm({ title, body, ok })` (`phone.js`)

- In-app modal replacing `window.confirm` on BOTH surfaces (`#confirm-backdrop`  
  / `#confirm`). Defaults to Cancel, focuses Cancel, Esc/backdrop cancel,  
  promise-based, stacks safely (a second dialog retires the first).
- Overlays stack, so the keyboard is layered with them: only the TOP layer  
  answers (harness `escLayer()` + `ESC_LAYERS`; phone `closeTopOverlay()`), and  
  the focus trap is a stack (`trapFocus`/`untrapFocus` push and pop  
  `{ container, returnFocus }`) so closing an inner dialog restores focus into  
  the dialog still open beneath it.
- **Every destructive action goes through one of these.** The native prompt  
  BLOCKS the main thread (it freezes the phone's animations while it is up) and  
  focuses OK — neither is acceptable. On the phone it is additionally the  
  topmost back-guard layer: Android Back cancels the dialog, not the viewer  
  underneath it (`closeTopOverlay`).

### Progress row — `uploadRow(name)` / `fileUploadRow(...)`

- XHR upload progress: name + % + 4px accent bar. PC: `#transfers-uploads`;  
  phone: `#file-progress` (`.up-row`).
- The bar's fill is `transform: scaleX(fraction)` (JS writes the fraction), not  
  `width` — a layout property animating for the length of an upload repaints  
  every frame.
- Use for: any long-running upload. `fetch` can't report progress — keep XHR.

### Skeleton loader — `showSkeletons()` + `.capture.skel`

- Shimmer placeholders for the first grid paint. Reuse for any new  
  list/grid view that loads over the network.
- The sweep is a translated gradient overlay (`.skel-img::after`,  
  `transform: translateX(-100%) → 100%`), not an animated  
  `background-position`, and `aria-hidden` — placeholders carry nothing a screen  
  reader can use. The grid itself announces the load through `aria-busy`  
  (`gridBusy()`, a counter: a skeleton first load and an upload burst are two  
  owners).

### Update banner — `#update-banner` (`index.html` + `checkPageVersion()`)

- Version-mismatch notice, wired to `/api/version` vs page meta and re-armed  
  by unknown SSE event types. Don't add a second update mechanism.

## 2. Navigation & layout

### View tabs — `.view-tabs` + `.tab-btn` (`style.css`, `applyTab()` in app.js)

- Captures / Transfers with `localStorage` persistence (`pp_tab`) and a  
  "Show all" merged mode. Extend via `activeTab` state + `applyTab()` — don't  
  invent a router.

### Lightbox — `openLightbox/renderLightbox/lbNav` (`app.js`)

- Fullscreen viewer: thumb-first paint → full-res crossfade (`img.decode()`),  
  wheel/pinch zoom at cursor, pan with clamp, rotate, keyboard (←/→/R/Del/±),  
  neighbor preload with priority tiers.
- This is one of the most optimized components in the repo — modify carefully,  
  see comments in app.js before touching `measureLb`/`clampPan`.

### Phone viewer — `showViewer/openViewer` + touch gestures (`phone.js`)

- Fullscreen image + action bar; pinch-zoom/pan/swipe with  
  `.gesturing` transition suspension — the transition is OFF for the whole  
  gesture (added at `touchstart`, removed at `touchend`), not per-path; only  
  release/snap paths (spring-back, commit, double-tap) animate. All  
  "viewing" transforms (pan, pinch, double-tap zoom) go through  
  `clampViewerPan()` so the image can never be dragged off-screen — but the  
  unzoomed swipe drag deliberately bypasses the clamp (at scale 1 the clamp  
  range is zero and would kill 1:1 tracking; see PITFALLS #31–#32).  
  Handles both local captures and PC-sent remote items (`viewerItems` list  
  switching). Actions: Rotate (quarter-turn per press, `viewerRot` — rotation  
  rides inside the same `applyViewerZoom()` transform and `clampViewerPan()`  
  extends the pan range by the rotated AABB), Download, Delete for  
  server-backed shots (Retry/Discard while pending); no Copy (image copy is  
  PC-side).

### Modals — `#confirm-backdrop`, `#dir-backdrop` (PC), `#file-sheet`, `#confirm` (phone)

- Shared anatomy: fixed backdrop + blur, centered box, Esc/backdrop = cancel.  
  Reuse the CSS patterns in DESIGN.md §7 rather than new overlay code.
- A modal's ✕ must be a CHILD of its box: `position:absolute` in the fixed  
  overlay positions against the viewport, which stranded `#file-sheet-close` in  
  the screen corner (and left the box reserving padding for a button it did  
  not contain).

### Overlays — `#drop-overlay` (drag & drop), `#lightbox`, `#viewer`

- Fullscreen fixed layers with explicit z-index ladder (DESIGN.md §7).

## 3. Capture grid (harness)

### Capture tile — `buildCell(c, isNew)` in `app.js`

- The core tile: square thumbnail, NEW badge, origin pill (phone/PC) on the  
  thumbnail's bottom-left corner, meta row (#id + time), hover actions  
  (copy/send/download/delete), selection checkmark, keyboard focus ring  
  (`kfocus`), `content-visibility: auto` for big grids.
- Rounded clipping lives on `.thumb` (`overflow: hidden` + top radius) —  
  `.capture` itself must stay `overflow: visible` or grid rows collapse  
  (PITFALLS #29).
- The tile's own action surface is `.capture-open` (thumb + meta, `role="button"`,  
  `tabIndex=0` — the element that takes focus). The four overlay actions are its  
  **siblings**, never nested inside it, and `d._open` points at it so keyboard  
  nav can focus it without a DOM query per keystroke. Grid shortcuts resolve  
  their target from `document.activeElement`'s tile (`refreshGridCache`  
  re-derives `focusedIdx`) — never from an index tracked in parallel, or an SSE  
  prepend silently shifts it and X/D/C hit a neighbouring capture.
- Selection model: `selected` Set + `selectMode` toggle + Ctrl/Shift+click.
- Add tile features here, not as a parallel card component.

### Capture grid state — `loadCaptures/syncGrid/renderGrid` (`app.js`)

- Keyset pagination (`?before=`), SSE incremental updates, dedupe by id,  
  sort toggle. **Understand `loadCaptures` before touching pagination** —  
  the cursor rules are subtle (see comments about `before`/`moreAvailable`).

### Grid controls — toolbar (`.toolbar`, `.tools`)

- Sort select (`.pp-sel`), density S/M/L (`.dens` segmented control,  
  `--tile` CSS var), Select mode, Delete all (`.del-far`), bulk bar  
  (`#bulk-bar`) with count + **Select all** (`#bulk-all`, one pass over the live  
  nodes — adds `.sel`/`aria-pressed`/`.sel-check`, never rebuilds a tile) +  
  Delete (disabled at 0 selected).

### Webcam scanner — `public/scan.js`

- The **Scan** button (`#scan-btn`, beside ＋File) opens `#scan-backdrop`
  (`PPScan.open()`), a modal viewfinder + corner-overlay stage. It lazily injects
  the vendored **OpenCV.js** (`public/vendor/opencv-4.13.0.js`) on first open,
  detects the page quad (`detectFromCanvas`), lets the four corners be dragged on
  the frozen frame, and deskews via `warpToCanvas` (`getPerspectiveTransform` +
  `warpPerspective`). **Save scan** reuses the capture pipeline: `POST /upload`
  with `source=pc` + the JPEG, then `writeCaptureToClipboard` + `loadCaptures`.
  Owns its own camera lifecycle (every track stopped on close) and deletes every
  `cv.Mat`. PC-only: `getUserMedia` requires a loopback/HTTPS origin.

## 4. Transfers (harness)

### Transfer row — `buildFileRow(f)` in `app.js`

- Direction badge (`.f-dir.phone|pc`), name/size/time, Open/Save/Delete.  
  Deletion via `confirmDialog`, animated removal (`.removing`).

### Upload router — `uploadFiles(files)` in `app.js`

- Splits images → `/upload`, everything else → `/api/files`. Reuse for any  
  new drop/paste surface.

## 5. Phone-specific

### Capture buttons — `.shutter` (camera), `.alt-btn` (gallery/files)

- 56px hero + 44px tap targets, busy state via `.busy`, applied by  
  `shutterBusy()` while a batch uploads (ref-counted — a camera batch and a  
  gallery batch can overlap).
- They are `<label>`s wrapping hidden file inputs, so they carry  
  `role=button tabindex=0` and `activateOnKey()` forwards Enter/Space to  
  `el.click()`: a bare label is NOT focusable, which left all three pickers  
  unreachable by keyboard, switch control or a desktop PWA.


### Switch row — `.switch-row` + `aria-checked` (`phone.css`)
- The phone toggle pattern (auto-paste, auto-cleanup). State lives on
  `aria-checked`; the checkbox is invisible. Reuse for any new setting.

### Text chip strip — `.text-in` + `.text-chip`
- Horizontal scroll of incoming texts/URLs/media with edge-fade mask.
  URL chips open; plain chips copy; media chips open the viewer.
- **Swipe down to delete** (`attachChipSwipe`): collapses the chip and opens the
  undo snackbar. The axis lock keeps horizontal scrolling intact. A focused chip
  also deletes with Delete/Backspace through the same deferred path — the
  gesture alone is unreachable without a touchscreen.
- Chips are focusable `role=button`s (`chipA11y`): Enter/Space runs the chip's
  primary action, Delete/Backspace the removal.

### File chip + action sheet — `.file-chip`, `#files`, `#file-sheet`
- The `#files` lane lists transferred files **in both directions** (the same rows
  the harness's Transfers tab shows), each with a direction badge: PC = blue
  (`ic-pc`), phone = accent (`ic-phone`). Tap → Save/Open sheet. Deduped by id,
  version-gated (`/api/files/version`).
- It is a **horizontal strip**: one row scrolled sideways, scrollbar suppressed
  and the same edge-fade mask as `.text-in`. As a vertical list it was a 30dvh
  window with a hairline scrollbar — barely anything was visible and the row you
  wanted was usually below the fold. One row also means it can never push the
  fixed-height layout around. Chips are `flex:none` with a `max-width` and
  ellipsize their name instead of squeezing.
- Same **swipe down to delete** as the text chips (undo snackbar; deletes the
  file server-side, so it leaves the PC too). Sideways drags pan the strip; a
  downward drag has nowhere to go vertically, so it arms the delete.

### Offline queues — `outbox*` (photos), `textQueue*` (texts), `fqueue*` (files)
- IndexedDB (`proofpipe`, `proofpipe-files`) with retry/backoff, poison
  marking (413 → tries=999; a 415 is NOT terminal and backs off instead — the
  unpoison migration in `queue.js` only spares `poisonReason: 'too-large'`),
  manual retry coordination via `inflightKeys`.
- **Any new phone→PC data channel must use this same pattern** — never a
  bare `fetch` without a durable queue.
- The queue counter (`#outbox-info`) **retries** the queues (it re-runs
  `checkServer()`, which flushes photos/texts/files) and reports what is left.
  Clearing is a destructive action and lives with the others in More options
  ("Clear queued photos") — the most prominent queue affordance must not be the
  one that loses data.

### Adaptive poll loop — `pollLoop()` in `phone.js`
- 10s when SSE down / busy, 60s when healthy+idle. New background work
  should hook into `hasPendingWork()` rather than adding another interval.

## 6. Extension (shared patterns)

### Shared modules — `discovery.js`, `paste-logic.js`, `files.js`, `toPng.js`
- Classic scripts (no import/export: MV3 workers and content scripts don't
  module-load) attached to `self`, loaded by every chain that needs them. The
  loader wiring is pinned by `test/extension-logic.test.js` — an extracted
  module that isn't wired into a chain is a ReferenceError at runtime.
- `PPFiles` (`files.js`) owns the `/media/<name>` guard: `valid()` to relay a
  name, `safe()` to build a URL. One copy — three hand-synced copies of a
  security-relevant check is a drift waiting to happen.

### Server discovery — `candidates()/ensureHost()` (background), `findHost()` (offscreen)
- Probes loopback candidates, pins only origins answering `/api/version`.
  All server traffic flows through `serverFetch`/`bg()` — never a raw fetch
  to a hardcoded port.
- Staging (`PPDiscovery.probeHosts`) is SHARED by all three probers: primary
  plain-http loopback hosts in parallel first, then the https/no-port matrix.
  Anything serial here strands auto-paste for tens of seconds after a port
  change (that was offscreen's private copy).
- The pin is TTL-verified (45s): `ensureHost()` runs on every request, and an
  unconditional re-probe doubled the tray's 3s poll traffic. Only a NETWORK
  failure clears the pin; an HTTP status error does not.
- Every request is bounded (`AbortSignal.timeout`: 4s JSON, 15s media) — an
  unbounded fetch is a popup stuck on "Loading…" with no error path.

### Media relay — `mediaBlob` message (`background.js` ↔ content/popup)
- Background fetches with `host_permissions`, returns a real Blob (no
  base64). Auto-paste prefetches (`prefetchBlob`) once a paste TARGET is
  resolved — early enough to race the tab's request, late enough that a
  capture with nowhere to paste doesn't pull a full-size image for nothing.
  Any new media access must go through this path (Local Network Access blocks
  direct page fetches).
- **Thumbnails are fetched ON VISIBILITY**, never eagerly: the tray and popup
  render up to 100 rows while ~9 are on screen, so an eager loop is ~100
  parallel LAN fetches per open (`img.loading="lazy"` does not help — the fetch
  starts before `src` is set). One `IntersectionObserver` per surface, rooted at
  its scroll container, `rootMargin` a screen ahead.

### Synthetic paste engine — `autoPasteCapture/pasteVerify` (`content.js`)
- Staged dispatch (non-bubbling → bubbling → PNG retry → clipboard fallback
  → focus queue), verification via `preventDefault` return + document-wide
  signals. This is the most delicate code in the repo — see PITFALLS #5–9
  before modifying.

### FAB + tray — `extension/content.js` shadow DOM
- Draggable "p" button (position in page localStorage), per-site hide
  (restore via popup), panel with capture grid + text sync.
- Keyboard-reachable: the p button and every capture cell are `tabIndex=0`
  buttons (Enter/Space = copy); the status line is a `role="status"` live region.
- Global hide/show follows `chrome.storage.local` LIVE (both storage events +
  a focus/pageshow re-read) — see PITFALLS #40/#42.

### Popup — `extension/popup.html/js`
- Captures tab (click = copy), Texts tab, Sync now, unhide button,
  undelivered-count status.
- Items are `role="button"` + `tabIndex=0` (Enter/Space = click). The hide/show
  p-button toggle writes `chrome.storage.local` directly (PITFALLS #40).

---

## Anti-inventory (don't create these — they exist already)

| Need | Use | Don't build |
|---|---|---|
| Transient message | `toast()` / `flash()` | banner, alert, snackbar |
| Confirmation | `confirmDialog()` | custom modal per feature |
| Toggle | `.auto-copy-toggle` / `.switch-row` | new switch CSS |
| Icon | `.ic .ic-*` mask class | inline SVG path, icon font |
| Progress | `uploadRow`/`fileUploadRow` | custom progress UI |
| Empty state | `.empty` anatomy (title/sub/hint) | ad-hoc centered divs |
| Connection state | `.pill` + `.dot` | badges, spinners of a new shape |
| Fullscreen image view | lightbox / phone viewer | third lightbox |
| Phone→PC channel | outbox pattern + SSE events | polling loop per feature |
