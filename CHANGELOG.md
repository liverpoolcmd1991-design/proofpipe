# Changelog

All notable changes to ProofPipe. Format follows the repo's commit style:
`v<server-version> [ / ext v<extension-version>]: what changed`.

## Unreleased

### Added
- **The PC harness can scan a document with its own camera** (`public/scan.js`,
  `public/index.html`, `public/style.css`, `public/app.js`, `server.js`,
  `public/vendor/opencv-4.13.0.js`, `test/harness-ui.test.js`, `test/pc-ui.test.js`).
  Every capture path began on the phone — a paper document, a whiteboard, a
  receipt had to be photographed on the phone and sent over before it could be
  pasted — and the harness's own toolbar had no way to add an **image** from the
  PC except drag & drop or paste. A **Scan button beside ＋File** now opens a
  modal viewfinder (muted + `playsinline`, `getUserMedia`, localhost-only) and a
  vendored **OpenCV.js** finds the page: `Canny` → contours → `approxPolyDP` →
  the largest convex **4-point quad**, EMA-smoothed so the overlay stops
  jittering on hand-hold noise. The shutter freezes the frame, the four corners
  are **draggable** on the still, and the deskewed result
  (`getPerspectiveTransform` + `warpPerspective`) is previewed before **Save
  scan** posts it to the SAME `/upload` (`source=pc`) as every other capture —
  same grid, same origin badge, same undo — and copies it to the clipboard, so
  the page is ready to Ctrl+V straight away (the feature's whole point). OpenCV
  is lazily injected on first open (a ~10 MB wasm build) and cached immutably
  under its version-pinned filename; every `cv.Mat` is deleted explicitly. The
  modal rides the settings shell at the 350 z-tier (a new entry in `ESC_LAYERS`
  and `modalOpen()`), so Esc closes the top layer and the grid shortcuts stay
  inert behind it.
- **Every capture carries a selection box, and a selection can be dragged out**
  (`public/app.js`, `public/style.css`, `test/pc-ui.test.js`). Select mode used to
  be the only way in: without it a click opened the viewer, so picking five tiles
  meant discovering a toolbar toggle first, and a selection's only possible fate
  was Delete. Each tile now carries a persistent checkbox in its own corner
  (20×20 drawn, `::after { inset: -4px }` for the 28px target — the same
  hit-area trick as the row menus, so the visible control stays small without
  shrinking what a thumb has to hit). Plain click still opens the viewer, so
  nothing about the old path moved; **Ctrl/⌘+click** toggles one tile and
  **Shift+click** extends a range from the last plain pick, both without entering
  Select mode, which is now only the gesture that keeps the bulk bar on screen.
  A tile is `draggable`, and the drag payload is the WHOLE selection when the
  grabbed tile is part of one — several MIME shapes in one `DataTransfer`, because
  drop targets disagree about which they accept — so a multi-select drags into a
  chat box, an editor or Explorer as one gesture. The checkbox and the overlay's
  own controls are excluded as drag handles, so starting a drag from the box
  toggles instead of tearing the tile off the grid.
- **The texts between the two devices became a first-class list, not a dump**
  (`public/index.html`, `public/style.css`, `public/app.js`, `test/pc-ui.test.js`).
  The harness kept the full text log but only ever surfaced its HEAD — one chip —
  and the composer sat far from it, so the way to re-copy something you sent a
  minute ago was to scroll and hope. The **newest** text now sits in the top band
  **beside the compose field** — one 210px column, newest first, both directions,
  a real button that copies it — which is where *"did my last message land?"* is
  asked, while typing, instead of in a dropdown far from the field it belongs to.
  The band's **mail icon** opens a dialog listing the whole history — no cap —
  with a direction glyph per row (`ic-pc` / `ic-phone`, sent vs received) so the
  origin is legible before the body is read, and the same click-to-copy on every
  row. Both surfaces read one memoized list and are repainted by the same SSE
  event, so a text typed on the phone appears beside the field without a refetch.
  That icon is the dialog's only trigger now, and worth a note: it shipped with
  `.hidden` hard-coded and nothing ever removed it, so it measured `display: none`
  on a live page and the one reachable way into the dialog was the strip's own
  link — the "hidden feature" PITFALLS keeps warning about.
- **PC harness: the library is searchable, filterable, and a selection can finally
  be USED** (`public/index.html`, `public/style.css`, `public/app.js`,
  `public/icons/search.svg`, `public/icons/external-link.svg`,
  `test/pc-ui.test.js`). The audit found **zero** inputs matching
  `/search|filter|query/` in the whole harness — at 14 captures that is invisible,
  at 200 it is the difference between a tool and a toy — and the only bulk action
  on a selection was destroying it, in an app whose own description is *"phone
  photo to PC, one tap — for pasting into AI chats"*.
  The toolbar's middle third is now a search field (`/` focuses it, Escape clears
  it) plus three origin chips — **All · From phone · From this PC** — which is the
  side rail's static legend turned into a control: same vocabulary, but this one
  does something. Both filter BOTH lists (a capture by `origin`, a transfer row by
  `dir`), a pre-v2 row with a null origin counts as the normal phone case so the
  filter and the tile badge can never disagree, and the matching is client-side
  over what is loaded (no request per keystroke, no second index). A filter change
  is add/remove through `syncGrid()`, so surviving tiles keep their decoded
  thumbnails, their scroll position and the keyboard cursor. Below 1260px the
  filters move into the ⋯ overflow (`placeFilters()` moves the node — one
  instance, so the state cannot fork): the row needs 817px of card, the card is
  `window - 442px` whenever the 320px rail is beside it, and 1180px would leave the
  field 76px of paint. The row stays **one 32px line at every width**.
  **Copy N** is the bulk bar's primary: one gesture encodes every selected capture
  (memoized by id, so a re-copy is instant) and writes them in a single
  `clipboard.write()`, with the button reporting progress because a 48MP re-encode
  is not instant. A platform that keeps only one image is **told about** ("Copied
  the first of N — this browser keeps one image per copy"), never silently
  half-copied. It is `.cap-only`: a file has no image bytes, so the button is
  absent on Transfers rather than a no-op, and Delete is demoted to the far end,
  past a gap.
- **PC harness: transfer rows group by day and keep their actions out of the way**
  (`public/index.html`, `public/style.css`, `public/app.js`). Nine rows × three
  identical actions was 27 targets and 27 tab stops that never said which file
  they belonged to. Rows now carry **no controls at rest**: two glyph squares
  (Open, Save) plus a `⋯` holding Delete, 28×28, revealed on hover **or**
  `focus-within` — and the row's own surface answers the keyboard (Enter opens,
  ⌘S saves, ⌫ deletes). Rows group under **sticky day headers** (Today ·
  Yesterday · Earlier this week · a date); a header is a SIBLING row rather than a
  wrapper, so one delete can never disturb a group and an SSE insert can target a
  group directly, with every pass over the list routed through `transferRows()` so
  a header can never be painted as a row. A day header whose rows are all gone
  removes itself. The `⋯` panel is `position: fixed`, placed from its trigger's
  rect and dismissed on scroll: `#transfers` is a scroll container, so an
  absolutely-positioned panel inside a row is clipped exactly at the last visible
  row, which is where a menu is most likely to be opened.
- **Phone: a Sort control that owns every received list** (`public/phone.html`,
  `public/phone.css`, `public/phone.js`). The More sheet gained a segmented
  **Newest · Oldest · Name** control, remembered as `pp_phone_sort` like every
  other phone preference. One order covers all three received surfaces — the
  Recent grid and both strips — applied as a pure DOM reorder off `dataset`
  keys stamped at build time (never a re-fetch, and never a re-parse of a
  12-hour localized label), with the server row id as the stability key so a
  same-second batch keeps arrival order instead of silently turning "Newest"
  into "A→Z".
- **PC: bulk file delete** (`server/files.js`, `public/index.html`,
  `public/app.js`, `API.md`). `DELETE /api/files` now takes the same two shapes
  `DELETE /api/captures` does — no body wipes every file, `{ "ids": [...] }`
  deletes exactly those — which is what the Transfers tab was missing: its only
  bulk path was one big "Delete all files". Selection is scoped to the ACTIVE
  tab (`selectedKey()` — capture ids on Captures, file ids on Transfers) so a
  capture id can never be handed to the files route, and a tab switch clears the
  set. Rows are removed with bounded concurrency and **one** coalesced
  `file-deleted` frame carrying `ids`, which both clients apply locally: a
  200-row wipe used to be 200 frames at every connected client.
- **Phone: a sideways-scroll cue on both lanes** (`public/phone.css`). A
  chevron drawn only while `.at-end` is absent — a touch device has no
  scrollbar, so the 14px edge fade was the only hint that a strip continues, and
  a strip holding six captures still read as a strip holding one.
- **Phone: swipe a chip down to remove it** — one gesture covers both lanes:
  `#text-in` (texts, links and PC-sent capture chips → `DELETE /api/text/:id`)
  and `#files` (transferred files either direction → `DELETE /api/files/:id`).
  **The phone's files lane now lists both directions** — what the PC sent it and
  what it sent the PC — each with a direction badge (PC = blue, phone = accent),
  so a file you sent from the phone can be removed without picking up the PC. The axis lock only takes a clearly-downward drag
  (`CHIP_AXIS_PX` + a 1.2× dominance test), hands a sideways drag back to the
  strip's native scroll, and hands a vertical drag back to the PC-files list
  whenever it still has somewhere to scroll. A one-time hint (`#text-hint` /
  `#file-hint`) advertises the gesture until first use.
- **Deferred-delete Undo snackbar (phone)** — `#undo-toast`. The DELETE is held
  for 6s instead of firing on release: a text row could be re-created, but a
  PC-sent file's bytes can't (the phone never holds them), so "Undo" has to mean
  "never delete". One window at a time (a new swipe commits the previous), a
  countdown bar shows the window, and a mid-window reload leaves the row in place
  — the fail-safe direction.
- **Phone confirm dialog** — `#confirm` + `phoneConfirm({ title, body, ok })`.
  Every phone destructive path (viewer discard/delete, clear recent / PC-sent /
  queued photos, delete-all) used `window.confirm`, which BLOCKS the main
  thread — freezing the phone's animations while it is up — and focuses OK.
  The dialog is promise-based, defaults to Cancel (which holds focus), cancels
  on Esc/backdrop, and is the topmost Android-back layer, so Back cancels it
  instead of closing the viewer underneath.
- **PC: "Select all" in the bulk bar** (`public/index.html`, `public/app.js`).
  The only way to select a whole library was Ctrl+clicking every tile. It is one
  pass over the live nodes — `.sel`, `aria-pressed` and the `.sel-check` badge
  are flipped in place (no rebuild, no thumbnail re-decode) — and it disables
  itself once everything is already selected.
- **Phone: Rotate in the viewer** (`public/phone.html`, `public/phone.css`,
  `public/phone.js`) — `#viewer-rot` + `rotateViewer()`. A sideways photo had to
  be sent to the PC to be straightened, on the device that actually took it. The
  quarter-turn rides inside the same `applyViewerZoom()` transform (`viewerRot`,
  reset per item) and `clampViewerPan()` grows the pan range by the rotated AABB
  (cos/sin, the same math the harness's `clampPan` uses), so a rotated image can
  still never be dragged off-screen.
- **PC: the grid says when it is busy** (`public/app.js`) — `aria-busy` via a
  counter (`gridBusy()`/`gridIdle()`), because a skeleton first load and an
  upload burst are two independent owners of the same state and one used to be
  able to clear the other's. The skeletons themselves are `aria-hidden`.
- **Four Lucide mask icons** — `triangle-alert`, `grid-3x3`, `grid-2x2`,
  `square` (`public/icons/`), replacing the inline SVGs the density buttons and
  the stats warnings carried.
- **PC: the view tabs implement the ARIA tabs pattern** (`public/app.js`).
  Captures ⇄ Transfers was the last tablist without its own keys: both tabs sat
  in the tab order and the arrows did nothing (the Tab key was the only way
  across, and it skipped straight past the pattern). There is now a roving
  tabindex — exactly one tab stop — with ←/→/↑/↓ moving the selection and
  Home/End jumping to the first/last tab, activation following focus. Both the
  pointer path and the keyboard path go through one `selectTab()`, so the active
  class, `aria-selected`, the remembered `pp_tab` and the roving tabindex cannot
  drift apart. The extension popup has done this since its own pass; this closes
  the parity gap.
- **The PC viewer announces where you are** (`public/index.html`). Arrowing
  through the lightbox was completely silent to assistive tech: the caption
  (position · time · origin) is the only thing that changes, and nothing
  referenced it. `#lb-caption` is a `role="status"` live region now — the exact
  fact the phone has always announced from `#viewer-pos`.
- **All three surfaces declare their color scheme** (`public/index.html`,
  `public/phone.html`, `extension/popup.html`, `extension/content.js`). The UIs
  are dark end to end but said so nowhere: the canvas flashed white until
  `style.css` applied, and native scrollbars/form chrome rendered light inside
  every dark pane (a Firefox-thin scrollbar the user cannot restyle). A
  `color-scheme: dark` declaration — meta on the two pages and the popup, a
  `:host` rule in the tray's shadow root, which inherits the host page's light
  scheme otherwise — hands all of it to the browser, at zero cost.
- **The extension's controls carry real accessible names** (`extension/popup.html`,
  `extension/content.js`, `extension/popup.js`). The popup `<html>` declared no
  `lang` (WCAG 3.1.1 — screen readers pick a pronunciation from it), and the
  tray's send button used its own glyph as its accessible name — announced
  verbosely, rendered by whatever font the host page supplies, and unable to
  follow `currentColor`. It is a Lucide send arrow with an explicit
  `aria-label` now, the icon-only Sync/Reload buttons have labels too, every
  decorative tray SVG is `aria-hidden`, and the two status strings that led with
  a camera emoji no longer do (same reasoning as the harness outbox badge).
- **`API.md` is complete again, and now guarded** (`API.md`,
  `test/api-docs.test.js`). The contract document claimed to be "generated from
  the actual routes" — nothing generates it, and it had drifted: ten route
  groups the server registers were missing (`GET /api/settings`, the aggregate
  the PC harness and the Android app consume; `/api/autocleanup`,
  `/api/storage-cap`, `/api/retention`, `/api/media-dir`, `/api/inbox-dir`,
  `POST /api/files-inbox`, `GET/POST /api/browsers`, `POST /api/pick-folder`,
  `POST /api/backup`, and both HTML shells). Its `/api/version` and `/api/stats`
  examples were also wrong on TWO counts — stale (`1.10.0`) and missing the `v`
  the server actually returns. All of it is documented now, and
  `test/api-docs.test.js` parses every `app.<method>('…')` registration out of
  the server sources and fails the build in both directions: an undocumented
  route, or a documented route that no longer exists. The Android app targets
  this file as its wire contract, so drift here is a client-side bug waiting to
  happen.
- **PC harness: first run is a three-step setup card, and the rail earns its
  column** (`public/index.html`, `public/style.css`, `public/app.js`, `server.js`,
  `public/icons/activity.svg`, `test/pc-ui.test.js`). A fresh install showed three
  lines of 12.5–16px grey text centred in a 996×661 void beside a full set of
  tools: every control present, none of them able to do anything — sort, size,
  search, the origin chips, Select and Delete-all over nothing. And the 320px side
  rail was **331.8px of 742px empty (44.7%)** at 1440×900 and 511.8px of 922px
  (55.5%) at 1920×1080 once the phone was paired and the QR left; below 900px it
  was a second grid row capped at `40dvh` with its own scrollbar, giving a 700px
  window **two** scroll regions (measured: 108.9px past a 280px cap).
  The rail is **264px of four answer-cards** — **Status** (`● Connected` /
  `Synced 2m ago`, or `Not connected` when a paired phone has gone quiet: amber,
  not red), **Pair phone** (unchanged), **Storage** (a 4px meter plus *one*
  sentence: `31.5 MB of 5 GB · 14 captures`, with the denominator riding
  `/api/stats` so the bar is honest on first paint; `--danger` past 80%, the same
  threshold auto-cleanup uses) and **Recent** (the last three arrivals across both
  libraries, assembled server-side from two bounded 3-row queries, with kind as
  the glyph and direction as its colour — spelled out in an `.sr-only` span so
  colour is never the only carrier). The cards stretch, which is what fills the
  column.
  **Below 900px the rail is a drawer**, out of flow on a veil: exactly one scroll
  region, Tab trapped, an outside press or Escape to close (bottom of the Escape
  ladder — z-index 320, under the lightbox's 350), and it closes when the window
  widens past the breakpoint. The trigger lives in the top band and renders only
  where the rail is out of flow — otherwise the status card, the meter and the
  Recent list would not exist at all on a laptop-width window.
  First run is a state, not an error message: when nothing has ever arrived AND no
  phone has ever paired, `#setup` replaces `#empty` with three steps in order;
  steps 2–3 dim to 45% until the phone has actually connected, and step 1 renders
  **no second QR** (the code lives in the rail, and a copy here is the bug
  `test/harness-ui.test.js` pins). `.main-card.no-data` — the class the markup
  ships with — hides the tools that can do nothing and keeps the two a first-run
  screen is for: the view switch and the compose field. ＋File stays; it is how
  the first data arrives.

### Changed
- **The tile's time is relative again — `6h ago`, `20 days ago`** (`public/app.js`,
  `test/pc-ui.test.js`). Tiles showed a clock (`14:31` · `Yest 14:31` · `13 Sep`),
  which only answers "when" for today: on a week-old tile `10:20` means nothing
  without the date beside it, and the date is the part a capture's own grid is
  worst at showing. Rows and the viewer's caption already spoke relative; the tile
  does now too, reusing the same `ago()` scale (`just now` · `Nm/Nh ago` ·
  `N days ago`, and a date only past a month, where the date IS the shorter
  answer). The exact stamp did not disappear — it moved to the hover title and the
  accessible name, which is where a label that never moves belongs, and it is what
  keeps two different `2 days ago` tiles distinguishable to a screen reader. The
  labels are re-read on the existing 15s tick against the same TTL'd memo, so
  nothing new ticks and nothing re-renders.
- **Search is gone; the dates stayed** (`public/index.html`, `public/style.css`,
  `public/app.js`, `README.md`, `test/*.test.js`). The toolbar's search field and
  its `/`-to-focus shortcut were removed outright, along with the keymap row and
  the README row that advertised them — a control nobody used was costing the
  toolbar its widest third and, below 1260px, forcing the origin chips into the ⋯
  overflow. The origin chips (**All · From phone · From this PC**) remain and still
  filter both lists, so the toolbar is one 32px line at every width with room to
  spare. Filters now read straight off the row's `origin`/`dir` with no query term
  to combine against, and a stale `#search` handler can no longer be reached.
- **The palette is darker across the board** (`public/style.css`,
  `public/phone.css`, `test/harness-ui.test.js`). The surfaces the eye spends the
  most time on were the brightest thing on screen — a light `--inv` chip and a
  3-step grey ramp that read as paper under a dark UI. `--bg`/`--card`/`--card2`
  step down to `#08090a` / `#131518` / `#1a1d20`, and the inverted surface drops
  from white to `--inv: #e4e7e3` (fg `#0b0c0d`), which keeps its 1.4.11 contrast
  against the new card while costing the eye far less. The control boundaries
  (`--ctl` / `--ctl-hover`) were re-derived against the darker backgrounds rather
  than reused, so every text and border still clears 3:1 where it is drawn. The
  phone UI moves with the harness — one token set, both UIs.
- **PC harness: the viewer grows out of the tile it came from, its bar is glyphs,
  and the keyboard reaches the whole library** (`public/app.js`,
  `public/style.css`, `public/index.html`, `README.md`, `test/pc-ui.test.js`,
  `dev/pc-harness.mjs`). Phase **P4** of the PC design review, shipped as
  **v1.19.0**.
  - **Matched-geometry open.** The tile GROWS into the image over 240ms instead of
    the viewer appearing from nowhere. The animation is on `#lb-stage`, never on
    the overlay — scaling `#lightbox` would stretch the toolbar and the close
    button for the length of the animation, which is the classic FLIP mistake —
    and the scale is UNIFORM, taken from the width ratio, because matching width
    and height independently distorts the photo for 240ms. `transform-origin`
    moves to the tile's centre so the grow starts exactly on the tile, the whole
    thing is skipped for `prefers-reduced-motion`, and `Element.animate` cancels
    itself on finish so no transition state is left for the next open (or for a
    manual pan).
  - **The action bar is four glyphs, not four words.** "Copy", "Download",
    "Rotate" and "Delete" sat on a bar whose icons already said all of it, and the
    words are what made the position and the hint fight them for room. Four 34×34
    squares — `aria-label` carries the name, `title` carries the key. The position
    moved INTO the bar (`#lb-pos`, `tabular-nums`, `aria-hidden` because
    `#lb-caption` is the live region and two polite regions announcing one move is
    a stutter), and the caption is now a chip that fades 2s after the last move:
    context, not chrome.
  - **A one-time zoom coach mark** (`#lb-coach`) replaces a sentence that used to
    sit on the toolbar permanently. It retires on the first zoom
    (`pp_lb_zoomed`) and, for someone who never zooms, on the 6s mark — so it is
    never still there on the second visit.
  - **Settings is three named groups** (Capture · Storage · Devices & app), each
    one row grid with a right-hand control column, so the eye reads down a single
    edge instead of following two alignment systems, one separator and 12.5px
    labels.
  - **The keyboard reaches what the mouse could do**: `/` focuses search, `1 2 3`
    pick Captures / Transfers / All (through `#show-all`, so nothing can disagree
    about which view is up), `Space` is Quick Look both ways (and still defers to
    a focused control), `J/K` move, `⌘A` selects the whole list (entering Select
    mode first — the bulk bar only exists there), `⌘C` copies the SELECTION,
    `⌘⇧S` saves it, `F` toggles fit/actual size in the viewer. Every chord is
    scoped to a non-editable target and inert while a dialog or a toolbar panel
    owns the screen.
  Verified by rendering, not by reading: `dev/pc-harness.mjs` (new — the PC twin
  of `dev/phone-lane.mjs`, and the tool the review asked for) drives headless
  Chrome over CDP at 1440×900, and `npm test` (265) plus `npm run lint` pass.
- **A capture tile is two glyphs plus one `⋯`, in ONE panel** (`public/app.js`,
  `public/style.css`, `test/pc-ui.test.js`). Four loose squares measured 27×21 and
  needed ~120px of a tile that can be 110px wide, so at density S they wrapped 2×2
  **over the photo they belonged to** — and four equal-weight actions on every tile
  also say nothing about which one matters. **Copy** and **Send to phone** stay up
  (they are what the library exists for); **Download** and **Delete** move behind
  the `⋯`, where a destructive action cannot sit next to the action the user came
  for. The panel is one translucent `rgba(0,0,0,.78)` + `--ctl` pill measuring
  **92×34 at every density** — 88px of targets inside 2px of padding — so it never
  wraps and never has to shrink a target below 28px, and the density-S overrides
  that existed only to squeeze four squares are gone. The `⋯` panel is FIXED and
  hosted on the **body** while open: a tile lifts on hover, and a transformed
  ancestor is the containing block for a fixed descendant, so as a child of the
  tile the panel resolved against the tile and landed **400px off** (measured; see
  PITFALLS #51). Measured after: 0 sub-28px targets, three 28×28 glyphs on one row
  at density S (120px tile) and M (165px tile), the panel inside its tile to within
  0.5px, and the menu's right edge aligned to its trigger to within 1px.
- **PC harness: the tile meta shows the TIME, the size on demand, and one badge
  that means something** (`public/app.js`, `public/style.css`). Every tile's meta
  row carried `#14` — a database id where the user's question is *when was this* —
  and the relative label ("2d ago") cannot answer it at day granularity: three
  captures are all "2h ago" on a busy afternoon. It is now `14:31` for today,
  `Yest 14:31` for yesterday, `13 Sep` beyond that; the relative label and the full
  stamp moved to the tile's accessible name and hover title, which is where a
  label that MOVES belongs. The byte size fades in on hover / `focus-within`
  instead of the row carrying two always-on labels. And the origin badge now marks
  only the **exception**: most captures arrive from the phone, so PC-origin tiles
  get the blue chip and phone-origin tiles get none — that deletes 14 badges that
  said nothing and leaves one that says something (`DESIGN.md` §7: "a badge must
  mark the EXCEPTION, not the normal case").
- **PC harness: two stacked bands became one 64px top bar, and the toolbar is five
  controls on a single 32px baseline** (`public/index.html`, `public/style.css`,
  `public/app.js`, `public/icons/arrow-up-down.svg`, `test/pc-ui.test.js`). The
  window's top spent **118px on two bands**: a ~49px header whose right half was
  permanently empty, plus a ~69px compose bar holding a 1338px-wide single-line
  field — 118px of chrome for one idea, ~54px less library than the app could
  afford. They are now one band (`--topbar-h: 64px`). The field is capped at
  **560px** (`flex: 0 1 560px`) and pinned to the band's end, which is where Send
  already sat, and it is **one row, always** (height/min/max-height all `--tb-ctl`,
  `overflow-y:auto`): auto-growing to 150px was fine in a bar that sized itself
  and is wrong in a fixed band, where a long draft would push the library down.
  The inbound text left the bar entirely — it was Send's sibling, so an arriving
  message **displaced Send by 350px** (x1372 → x1022) — and became a full-width
  *From your phone* row above the library: content with the content, which is also
  why it is a lane on the phone. Moving it out of `#text-bar`'s id scope finally
  closes **PITFALLS #34** (`#text-bar .toolbtn` out-specified `.text-chip
  .toolbtn { display:none }`, so the copy button had always rendered at full size).
  The toolbar row itself went from **10 controls on three baselines
  (31 / 23 / 22px) with two inverted-white surfaces** to five on one
  (`--row: 32px`). The view switch is a real segmented control — a `--seg` track
  carrying the row's **one** `--ctl` outline, items with no border or fill of
  their own, a 1px inset so the 32px track still yields 28px segments (the
  desktop target floor) — and sort + density are **icon menus** instead of a
  `<select>` and a second 3-way track, whose active segment was the *second*
  inverted surface on an idle Captures view (DESIGN.md §7: a screen has exactly
  one). A menu's open state is a fill change and its chosen row is a fill plus a
  ✓, so the inverted `#fff` language belongs to the active view segment alone.
  Select, Show both lists and the two wipes moved behind the **⋯** overflow: the
  row's glance is *which view · which subset · in what order · at what size*.
  Sort is remembered now (`pp_sort`); it used to snap back to "newest" on every
  reload.
- **PC harness: every control is now drawn with `--ctl`, and every target is at
  least 28×28** (`public/style.css`, `DESIGN.md` §1/§2/§7,
  `test/harness-ui.test.js`). The harness had been outlining all 26 of its
  boundaries with `--border` (`#3a3f44`) — **measured 1.37:1 on `--card2`, 1.56:1
  on `--card`, 1.80:1 on `--bg`**, against WCAG 1.4.11's 3:1 floor for
  interactive controls. `DESIGN.md` §1 had specified `--ctl` (`#6e757c`,
  3.13–4.11:1) for exactly this and recorded the gap in as many words: *"Wired on
  the phone; the harness still outlines controls with `--border`."* The cost was
  not only compliance — with a button, a card and a divider all carrying the same
  1.56:1 hairline, nothing could look primary, which is why the toolbar had
  accumulated seven competing emphasis levels trying to compensate.
  The split is now explicit and enforced: **a control is `--ctl`; a passive
  surface (card, band rule, dialog, separator, info box, status pill, decorative
  glyph tile, transient status row) stays `--border`** — and
  `test/harness-ui.test.js` pins both lists so a new control cannot quietly ship
  on the wrong one. The grandfathered `#4a4d50` hover — **1.72–2.26:1, a hover
  state nobody could see** — is retired for a new `--ctl-hover` (`#868d94`,
  4.35–5.71:1, and always a visible step above the resting boundary).
  Targets went from "whatever the padding happened to produce" to a stated 28px
  minimum (`DESIGN.md` §2): tile actions **27×21 → 28×28**, density segments
  **27×23 → 28×28**, the Show-all switch **38×22 → a 28px label**, "Hide QR"
  **58×16 → 58×28**, the LAN link **202×17.3 → 202×28**, transfer-row actions and
  settings mini-buttons **24 → 28**, the quality slider **20 → 28**, and `.btn` —
  which had no padding of its own, so `#update-refresh`, `#empty-retry` and the
  folder dialog's three buttons all rendered ~20px tall — now declares one. A
  switch's *label* is its target, so the 38×22 track stays a switch rather than
  becoming a chunky one. The toast's Undo pill is the single deliberate exception:
  its painted box stays compact and its hit area comes from a positioned
  `::after`, because growing the pill to 28px would have made **every** toast 8px
  taller to serve a control most toasts do not have.
- **Phone: `#text-in` is the sole owner of PC-sent captures, and the strip is a
  full page long** (`public/phone.js`). A PC send rendered TWICE — as a strip
  card and as a square tile in the Recent grid — and the tile was the copy that
  could be seen, which is exactly why the strip read as holding "only the most
  recent one". `loadRecent()` now drops `origin === 'pc'` captures from the grid
  (and prunes any it already holds), and the SSE branch routes a PC-origin
  capture to the strip instead of the grid, so each lane has one owner. The
  strip also shows **20 rows of the 50** the API returns (was 5 of 10): the cap
  only ever existed to bound the DOM, and at 76vw per card five rows is roughly
  one screenful of a list that scrolls fine.
- **Phone: file-send progress lives in the status strip** (`public/phone.js`,
  `public/phone.css`, `public/phone.html`). It was a whole band of `.up-row`
  cards — and `body.kb-open #file-progress { display:none }` hid that band
  outright, so a send in progress vanished the moment the keyboard came up. The
  strip's trailing region (`#status-sub`) already ellipsizes one line and is not
  a live region, so progress rides there, with a blue `busy` tint that reads as
  work-in-flight rather than as the warn tint's fault. The node survives as an
  `sr-only` `role="status"` sentence, so per-byte ticks are still announced once
  per percent and never re-announced on every tick.
- **Phone: the expand chevron sits inside the textarea's box**
  (`public/phone.html`, `public/phone.css`). As a sibling it spent a full
  row-height on a chevron and could not be tapped without leaving the field. It
  is a real `<button>` inside `.text-box` (a CSS-only `::after` is neither
  focusable nor announced), bottom-right, with the icon flipping on
  `aria-expanded` — and it is `pointerdown`-guarded so it never steals the caret.
- **Phone: the More sheet draws no scrollbar** (`public/phone.css`). The panel
  keeps `overflow-y:auto` deliberately — a sheet that cannot reach "Delete all
  captures on PC" on a short screen would be the worse bug — but the rail read
  as a broken nested pane inside a floating panel, so it is hidden; the quality
  sub-row is compacted too, so the panel is shorter in the first place.
- **PC: the text bar is one control group** (`public/style.css`). `#text-send`
  and `#text-latest-copy` were content-sized `.toolbtn` pills (38px, 8px radius)
  beside a 44px/10px field, so the row looked assembled from mismatched parts.
  Both now read the field's own shared height token and radius.
- **Raised the photo rate-limit defaults to 120 burst / 240 per minute**
  (`server.js`; `PP_RATE_CAPACITY` / `PP_RATE_REFILL_PER_MIN` still override).
  The old 60/120 tripped on a 97-photo multi-select — one user picking a lot of
  photos, not a flood — and the rejected tail was lost. The bucket is OOM
  hardening, not a usage meter.
- **Phone: the PC-sent lane's two renderings of one meaning are now one**
  (`public/phone.html`, `public/phone.css`, `public/phone.js`). Reading the lane
  rendered — rather than the code — turned up two inconsistencies in the "files
  and captures" area:
  - **The direction badge had two renderings.** The capture card put the text
    `PC` in the trailing slot with no glyph; the file card put a bare `ic-pc`
    glyph there with no text. Same slot, same meaning, two components, and they
    sit one row apart in the same lane. Every badge is now **icon + label**
    (`PC` / `Phone`), in the capture card, the file card and the viewer's
    `#viewer-origin` alike, so a fourth place that needs one copies the whole
    badge instead of re-deriving it.
  - **The lane printed the same tip twice.** Both strips swipe down to remove,
    and both hints were gated by the same `pp_chip_hint` flag and dismissed
    together — so a lane holding texts *and* files showed "tip: swipe a PC text
    chip down to remove it" and "tip: swipe a file chip down to remove it" one
    line apart, and the two lines read as a divider between two groups rather
    than as one lane. Now ONE `#chip-hint` ("tip: swipe a chip down to remove
    it"), driven by `updateInbox()` — the only function that sees both strips —
    instead of by each loader independently.
- **Phone: the PC-sent lane's "files and captures" area, second pass — the two
  strips are now ONE component** (`public/phone.html`, `public/phone.css`,
  `public/phone.js`). Measured in a real render (headless Chrome over CDP, a
  seeded scratch instance) rather than read from source, which is how the
  numbers below were found; a screenshot alone misses them because
  `--virtual-time-budget` freezes pending fetches and leaves the lane empty.
  - **"More rows" had two components in one lane.** The text lane's `show older
    (n)` was an item built *inside* its strip — on a 7-row lane it sat 1,164px
    past the first chip, so it was reachable only by scrolling the strip to its
    end, and the 14px edge fade ate it there — while the files lane's `Load
    older transfers` was an always-visible centred row below its strip. Both are
    now the same static `.lane-more` row (`#text-load-more` /
    `#files-load-more`) directly under the strip it belongs to, wired once
    instead of rebuilt on every render. Its count is gone: `(n)` came from the
    raw row count, but duplicate sends of one capture are suppressed at render
    time, so it could promise three and reveal one — and the files lane's row
    never carried a count, so the two read the same way now.
  - **The lane had three vertical rhythms and no gutter.** The strips' side
    padding pushed every chip 2px in from the page gutter, so the lane never
    lined up with the composer above it nor with the rows below it (all at
    18px), and their bottom padding plus `#inbox`'s gap produced 14px between
    the strips, 12px under them and 4px under the tip. The two strips now share
    ONE plumbing block (`.text-in, #files`), with no side padding, the 32px
    swipe travel window handed straight back to the layout by a matching
    negative margin, and `#inbox`'s `gap: 8px` as the only vertical spacing —
    every gap in the lane now measures 8px.
  - **The edge fade ran on edges with nothing past them.** Applied
    unconditionally, a strip parked at its start ran its first chip through the
    0→14px transparent ramp — that chip's left border was simply not drawn — and
    a strip that did not overflow faded both ends for nothing. The fade is now
    per edge (`.at-start` / `.at-end`, set by `trackStripEdges()` from scroll,
    resize and row-count changes).
  - **The two halves of the "one card anatomy" did not share a type size.** The
    file card inherited body's 16px while the capture card's `.text-chip` said
    13px, and the card geometry was declared twice (the shared `.media-chip,
    .file-chip` rule plus a full re-declaration in `.text-chip.media-chip`).
    Both cards now carry the same root size and the capture card lists only the
    declarations that actually conflict with the pill.
  - **`.chip-badge.phone` did not exist as a selector** — the phone half of the
    direction pair leaned on the base rule, so only the PC half was greppable as
    a direction. Both halves are now spelled out, the way `.f-thumb` already did.
  - **The gallery is contained.** The extra row made a 320×568 screen squeeze
    the `flex:1` gallery to zero, and the empty hint — which cannot shrink below
    its two lines — painted straight over the composer. `.gallery` now clips
    (`overflow: hidden`) and carries `#recent`'s own 44px floor (one row of
    tiles), so `.wrap`'s documented overflow net engages and the grid stays
    reachable instead of the gallery being the thing that vanishes.
  - Tests: 2 new guards (one tip, badge parity across all three lanes). 49
    phone-UI tests, 200 total.
- **Phone polish pass: one door to the More sheet, and the row it freed goes to
  the pickers** (`public/phone.html`, `public/phone.css`, `public/phone.js`).
  The sheet had two entry points — the `⋮` in the status strip and a labelled
  **More** cell in the action row — so the cell is gone. It was not just
  redundant: it had to mirror `aria-expanded`, and the document outside-click
  handler had to exclude it *by name*, because it sits outside `.more-wrap` and
  the same click's bubble would otherwise close the panel it had just opened.
  One control per panel removes both problems. The freed cell went to the two
  controls that are the row's actual purpose: `.secondary-row` is now 2-up,
  `min-height` 48 → **52px**, label size 13.5 → 14.5px, glyph 18 → 20px, and the
  labels became verbs again — **Choose photos** and **Send file**. Also:
  - **The arrival ✓ fades out instead of popping.** It is a confirmation, and
    one that vanishes between two frames reads as a glitch. `markJustSent` holds
    it at full strength for `JUST_SENT_MS`, adds `.just-sent-out` to take it to
    opacity 0 over `JUST_SENT_FADE_MS`, then drops both classes. Re-arming
    mid-fade restores full strength before re-timing (a second capture landing
    on the same tile must not leave a half-faded tick).
  - **The tappable chips are outlined with `--ctl`, not `--border`.** A chip is
    tapped — copy, preview, file actions — so its edge is a control boundary and
    owes WCAG 1.4.11 its 3:1. On `--border` it measured **1.56:1** against the
    page: the inbox lane was a row of cards you could not see. This closes the
    one 1.4.11 gap the re-ranking pass left behind, since the chips were the
    last interactive surfaces still drawing their edge with the divider token.
  - The `⋮` gained an `:active` press state: with the labelled cell retired it
    is the only way into the sheet, so a tap has to be acknowledged before the
    panel animates in.
  - The empty-gallery copy now points at where the action actually is
    ("Nothing here yet — the **Capture** button below sends your first photo")
    instead of describing the list to itself.
  - Fixed a stale comment that still justified the chip's `overflow: hidden` by
    the sheen sweep, which no longer runs on chips.
  - Tests: 3 new guards (single entry point, the fade, the chip outline) and the
    action-row guard rewritten for the 2-up row. 48 phone-UI tests, 198 total.
- **Phone: the whole screen re-ranked — a state-tinted status strip, the gallery
  first, and ONE primary action** (`public/phone.html`, `public/phone.css`,
  `public/phone.js`, `public/style.css`). The screen was built on a good system
  that could not be seen: text contrast measured 6.0–15.6:1 (AA everywhere), but
  every *shape* sat 1.07–1.37:1 from its background where WCAG 1.4.11 asks for
  3:1 — so no element could look primary, and DESIGN.md §7's "one primary action
  per view" had nothing to attach to. Measured, then fixed:
  - **Surfaces are lifted and boundaries split in two.** `--card` `#17181a` →
    `#1c1f22`, `--card2` `#1d1f21` → `#26292d`, `--muted` → `#a6a9ab`. A new
    `--ctl` (`#6e757c`) outlines **interactive controls** while `--border`
    (`#2a2c2f` → `#3a3f44`) stays on passive dividers, because 1.4.11 applies to
    controls, not hairlines. `--ctl` is not the first value that cleared 3:1 on
    the page (`#5c636a` = 3.15:1) but the first that also clears it against
    `--card`, which every `.alt-btn` fills with (`#5c636a` is 2.72:1 there);
    `#6e757c` measures 4.11:1 / 3.55:1 / 3.13:1 on `--bg`/`--card`/`--card2`.
    Both `:root` blocks move together, as DESIGN.md §1 requires; on the harness
    the token is defined but not yet wired, and `--faint` was re-derived
    (`#8a8c8e` → `#96989a`) so its ≥4.5:1 contract survives the lighter `--card2`.
  - **The header is a status strip, not a wordmark.** `<h1>proofpipe</h1>` held
    the centre of the row while the one fact that decides whether a photo lands
    — the connection — was an 8px dot plus 11px text in the corner (DESIGN.md §3
    files 11px as "meta"). The strip now carries `state · N sent · auto-paste on`
    and is **tinted by state**, so a change is legible peripherally; the dot and
    the tint come from one class ladder, so they cannot disagree.
  - **"Offline" no longer covers "never paired."** A phone that has never reached
    the PC since the page loaded reports **not paired — scan the QR on your PC ·
    same Wi-Fi** instead of `offline`, which claimed a connection that dropped and
    sent a first-run user hunting for a Wi-Fi problem. `everConnected` is set by
    the first successful poll or SSE open. The queue count now lives in exactly
    ONE place (the amber bar above the shutter), so the status line can no longer
    assert a queue that the bar contradicts.
  - **The shutter is the one white surface, in the thumb zone.** It was a `--card`
    box at 56px at y≈70px — identical to the pickers below it, and the hardest
    place for a thumb to reach — while the brightest element on the page was the
    SECONDARY `#text-send` (`#fff` at 19.2:1 against a card at 1.08:1). The
    shutter is now 60px on `#fff` in a sticky bottom bar (`.shutter-bar`); the
    inverted fill reuses the system's existing emphasis language rather than
    inventing one, and `#text-send` drops to `--card2` + an accent glyph. Its
    busy state had to change too: accent-on-white is 2.2:1, so it rides a green
    ring instead of a colour swap.
  - **A ✓ badge on every tile meant nothing.** `#recent .ok-badge::after` drew a
    green tick on the NORMAL case, spending the top-right corner of every 96px
    thumbnail — the only part of the UI that is content. The tick is now an
    arrival confirmation (`.just-sent`, dropped after 2s); `.pending` and
    `.failed` persist because those are worth interrupting for. `setTileState`
    already mirrored the states into the accessible name, so nothing was lost.
  - **The action stack is one 48px row instead of two sub-44px ones.** `.row` +
    `.actions-row` collapse into `.secondary-row` (Photos · File · More). The old
    pill row held a 36px button and a 38px switch — both under the 44px floor
    DESIGN.md §2 mandates — and put `border-radius:999px`, reserved for "pills,
    toasts, switches, progress bars, round badges", on a control. Auto-paste and
    the remote `Open on PC` move into the More sheet; auto-paste's STATE stays
    visible in the strip, so a setting costs no row. The sheet gained a second
    trigger, which the outside-click handler must exclude by name or the same
    click's bubble closes the panel it just opened.
  - **The More sheet separates Sync from the destructive group.** Four
    destructive bulk actions sat in the same 8px rhythm as the auto-cleanup
    switch and the quality slider, and only `Delete all` carried `.danger` — so
    `Clear PC-sent captures` (which also wipes PC-side history) read QUIETER than
    a JPEG quality slider, in direct conflict with §7's "destructive actions are
    visually separated". The three `clear-*` actions now sit under their own
    heading inside a dashed rail, all marked danger. Fixing the sheet also
    surfaced a pre-existing layout bug: its `.alt-btn` rows stacked the icon
    ABOVE the label, because `.alt-btn` is a `place-items:center` grid and these
    buttons never carried the `.btn-face` wrapper the pickers have.
  - **The gallery leads.** "Did it land?" is the question this screen answers, so
    the grid sits directly under the status strip and the composer follows it.
    The grid is wrapped in `.gallery` (one `flex:1` box) because an empty library
    sets `#recent{display:none}` — with nothing left to absorb the free space, the
    composer and the shutter bunched at the top of the screen.
  - Smaller: the skeleton is `10px` radius, matching the tile it stands in for
    (it was 11px, 1px off the one thing it exists to guarantee); the sheen is
    restricted to buttons, since on a chip it streaked light across the one part
    of the card that is content; `#undo-toast` lifts to `bottom:max(84px, …)` so
    the new bottom bar cannot cover the Undo button; and `.wrap` gives its bottom
    safe-area inset to `.shutter-bar` (the keyboard block restores it for the
    composer, which is bottom-most while the bar is hidden).
  - Tests: `test/phone-ui.test.js` grew 8 guards for the above and the
    offline-state guard was rewritten to pin the new "never paired" split.
- **Phone: PC-sent captures and files share ONE card anatomy**
  (`public/phone.html`, `public/phone.css`, `public/phone.js`). A capture from
  the PC rendered as an inline pill — a 48×36 thumbnail, the badge and the time
  sitting on the image's TEXT BASELINE — and, one lane down, a file rendered as
  a 10px rounded row with a bare icon: same content, two unrelated components at
  three different heights and insets. Both are the same card now: a 42px leading
  visual (thumbnail · its placeholder · the file-kind icon tile), a title/sub
  meta block, and the direction badge in the trailing slot — same 12px radius,
  same `min(76vw, 248px)` width, same 58px height, all three slots vertically
  centred (measured equal centres in Chrome), so the two lanes stack on one
  axis. The file card's sub line gained the arrival time the capture card already
  showed. Plain texts stay pills — text has no thumbnail and no second line.
  Both strips now set `align-items: center`, which the default `stretch` was
  defeating by pulling 44px pills to the 58px card height.
- **Phone: the capture card's "PC" badge is blue, not green** (`public/phone.js`,
  `public/phone.html`). Direction identity is PC = `#60a5fa`, phone = accent
  (DESIGN.md §1) — the file card sitting directly below it was already blue, so
  the capture badge read as "from this phone". The viewer's PC badge follows.
- **Motion pass over both UIs** (`public/style.css`, `public/phone.css`,
  `public/phone.js`) — the surfaces that had no animation at all now have one:
  the harness view swap, empty/loading states, bulk bar, update banner, lightbox
  and its action bar, the two dialogs without an exit transition, upload rows,
  the pairing body and the incoming-text chip; on the phone the viewer, both
  dialogs, the PC-sent lane, upload rows, and newly-built chips (a JS-added
  `.chip-new` that JS removes, so the strip's reconcile pass can't replay it).
  Every entry is opacity/transform only and 130–180ms, the global
  `prefers-reduced-motion` block still disables all of it, and the gesture
  surfaces keep their `.swiping`/`.snap` overrides (PITFALLS #31). Flat controls
  (`.toolbtn`, `.btn`, `.pp-sel`, `.mini-btn`, `.act`, the phone's `.alt-btn`,
  `.vbtn`, `.cbtn`, `.switch-row`, tiles) now transition their colours and a 3%
  compositor press scale instead of snapping between states.
- **Harness toolbar is tab-aware** — Sort/density and Delete all are `cap-only`
  and the new "Delete all files" is `.files-only`, so each tab shows exactly the
  bulk tools that act on what is on screen (Delete all can no longer wipe every
  capture from a screen that shows none). **Select is neither**: one Select tool
  drives both lists, and the bulk bar follows the active tab's id space
  (`selectedKey()`), with "Select all" counting that tab's own universe.
- **Grid keyboard shortcuts no longer fire behind an open dialog** — with
  Settings, the folder picker or a confirm up, `X`/`D`/`S`/arrows used to act on
  the grid behind the modal.
- **One switch anatomy** — `.show-all-toggle` shares the `.auto-copy-toggle`
  switch rules (it was a second, smaller copy that dropped its focus ring), and
  `.dens` active now matches the other inverted selected states.
- **Phone files lane scrolls sideways** — `#files` was a vertical list capped at
  30dvh with a hairline (`thin`) scrollbar: a ~40px window where the row you
  wanted was almost always below the fold. It is now ONE horizontal row with the
  scrollbar suppressed and the same edge-fade mask as the text strip, so every
  transferred file (either direction, direction badge intact) is scannable at a
  glance; chips keep a `max-width` and ellipsize instead of squeezing, their tap
  targets are 44px, and `touch-action:manipulation` kills the iOS tap delay.
  Sideways drags pan the strip, downward drags still arm swipe-to-delete, and
  the lane is content-height, so it can no longer push the fixed-height layout
  around.
- Side-card scrollbar hides only where the card fits (≥801px); the empty-state
  QR follows the selected NIC, and a stray unparameterized `/qr.png` fetch is gone.
- **Neither client is a document any more: dragging on the UI selects nothing**
  (`public/style.css`, `public/phone.css`). A drag across a tile, the stats box,
  a chip or the status bar left a blue text smear behind (and a long-press on the
  phone raised the iOS copy callout over controls that have their own gestures).
  Both stylesheets now set `user-select:none` at the root and opt back in exactly
  where selection is the point: text ENTRY (`input`/`textarea`/`select`), the
  harness's copyable values (LAN URL, storage and folder paths), and the phone's
  **link chips** — a URL from the PC is copied by long-pressing the link itself,
  which is the only copy affordance it has. A phone chip whose tap-to-copy is
  blocked by the browser unlocks *itself* (`.chip-manual`) so the manual
  long-press its message advertises still works — that message used to point at a
  gesture this change would otherwise have removed.
- **Provenance is on screen, not only in a tooltip** (`public/app.js`,
  `public/style.css`). The lightbox caption carries the origin (`#id · N of M ·
  date/time · from your phone`) on BOTH paths (the normal viewer and the
  TIFF/HEIC thumbnail fallback) — a tooltip is invisible on touch and was
  announced to nobody. The sidebar legend's PC icon is `#60a5fa` like every
  other PC marker (DESIGN.md §1) — it was `--muted`, so the legend and the tile
  badge disagreed about the same capture.
- **One byte ladder for both clients** (`public/app.js`) — `fmtBytes` follows
  the phone's (`B → KB → MB → GB → TB`). The PC's stopped at MB, so the same
  library read "2048.0 MB" on the PC and "2.0 GB" on the phone.
- **Relative labels keep moving while the page sits still** (`public/app.js`).
  `timeAgoCached` memoised by id FOREVER, and the grid is reconciled in place,
  so every tile read "just now" for the whole session; the cache now carries a
  30s TTL and `refreshRelativeTimes()` re-reads the changed labels on the
  existing 15s stats tick (no second timer). `ago()` gained day units and a date
  beyond a week ("49h ago" was not a unit anyone reads), and a tile's accessible
  name carries the date when its label is day-granularity, since two captures
  can both be "2d ago".
- **The overlay ladder is behavior, not just paint** (`public/style.css`,
  `public/app.js`). Settings 350 < folder picker 370 < toasts 380 < confirm 400
  (DESIGN.md §7): a dialog opened FROM a modal outranks it, and feedback
  outranks the layer that produced it but never a destructive confirm. One
  Escape closes only the TOP layer (`escLayer()` + `ESC_LAYERS`), and the focus
  trap is a stack (`trapStack`) so closing an inner dialog hands the keyboard
  back to the modal still open underneath instead of retiring its trap for good.
- **Narrow screens keep every lightbox action on screen** (`public/style.css`):
  under 800px the labels drop and the icons carry the meaning (each control
  keeps its `aria-label`). Delete used to sit off the right edge of a
  horizontally scrolling bar.
- **Copy that had drifted** (`public/index.html`, `README.md`): "Merge" →
  "Show all" (same as the Transfers tab), "history" → "show older" (the phone's
  wording), and an `aria-label` on Delete all that says it cannot be undone.
  The README's pull-to-refresh paragraph is gone with the gesture it described
  (phone.js removed the document-level pull handlers), replaced by the real
  paths: SSE, the adaptive poll, and a re-check on focus/online — plus the
  failed-load state's **Retry now**.
- **Phone: the numbers on screen match the library** (`public/phone.js`). The
  "N captures" heading paired the tile strip's count (capped at 100) with a
  whole-library byte total; it uses the server's `count` now (`/api/stats`,
  falling back to the local tiles while offline). The auto-cleanup toggle names
  the resolved cap it actually drops past ("past 80% of 500 MB") instead of
  "80% storage" with no number anywhere on the page, and exactly like the PC.
- **Phone: a chip's full text is reachable** (`public/phone.js`). Chips are
  one-line ellipsized pills by design, so the tooltip and the accessible name
  carry the whole message — a text chip's name used to be the fixed string
  "Text from PC — copy", and a screen reader could not read a message that was
  copy-only.
- **Extension: local times, like every other surface** (`extension/popup.js`,
  `extension/content.js`). Both printed a raw UTC slice of the server string
  (`09-12 04:31`), while the harness and the phone render the viewer's local
  clock; the tray's cells showed no time at all, so two captures with the same
  thumbnail were indistinguishable.  `popupWhen()`/`localTime()` format them
  now, and the tray cell's title and `aria-label` carry the stamp.
- **The status card, the capacity meter and the Recent list get their own
  labels** (`public/index.html`, `public/app.js`). `loadStats()` used to inject a
  `Storage` eyebrow *inside* the status box while the card itself had no heading
  at all — so the label belonged to the wrong card and "STORAGE" sat directly over
  the phone-presence lines. Each card owns its own `<h3 class="eyebrow">` now and
  nothing is injected. The count/bytes sentence moved out of the status card and
  next to the thing it measures, instead of being stated twice.

### Fixed
- **Copying a recent capture on the PC stopped reporting itself blocked**
  (`public/app.js`, `test/pc-ui.test.js`). The harness built its `ClipboardItem`
  from an already-awaited PNG — `new ClipboardItem({ 'image/png': await
  encodeCapture(c) })` — so the re-encode of a fresh phone photo ran *before*
  `clipboard.write()`. `write()` needs transient user activation (~5s in
  Chromium) and a 12MP encode can outlive it, so the write threw
  `NotAllowedError` and `copyCapture` answered "Copy blocked — use Download
  instead". The tell is that the **second** click worked: the first had already
  memoized the PNG, so the retry had nothing to encode. This is PITFALLS #57
  exactly — the extension was fixed for it, the harness never was. Both now hand
  the API a `Promise<Blob>` so the write starts inside the click, keeping the
  awaited form only as the `TypeError` fallback for a build that refuses a
  promised blob. `encodeCapture` memoizes its **in-flight** promise, so the
  click, auto-copy and a bulk copy share one encode instead of racing three.
  **Copy N had the same defect in a worse form** — it awaited every encode in
  the selection before writing, so a multi-select copy could not succeed at all;
  it now builds its items over promises too. A failure also logs its reason to
  the console, and a `NotAllowedError` says what the user can actually fix
  ("click the page first") instead of reading like a dead feature.
- **Pairing no longer advertises a VPN's address, so a hotspot change can't
  strand the QR** (`server/util.js`, `test/lan-ips.test.js`). `lanIPs()` ranked
  candidate addresses by *range only* — `192.168` first, `10.x` second — and a
  VPN tunnel adapter carries a private address in exactly those ranges. On a
  hotspot that hands out `10.179.242.x` with Windscribe up on `10.189.137.x`,
  both scored the same, the tie fell back to interface order, and the tunnel won:
  `/qr.png` and the boot log both pointed at `10.189.137.195`, an address that
  exists only on this PC. The phone scanned it and dialled nothing. Tunnels and
  virtual switches are now recognised **by adapter name** (`Windscribe`,
  `WireGuard`/`wintun`, `TAP`/`OpenVPN`, `Tailscale`, `ZeroTier`, `vEthernet`,
  `VMware`/`VirtualBox`/`Docker`/`WSL`, …) and sorted below every real NIC
  regardless of range; they stay in the list (the picker, the boot log and the
  CSRF host check all still need them), they just stop being the default.
  `lanIPs()` also takes an optional injected interface map so the ordering is
  testable without touching the live machine.
- **The p-tray's drag-to-chat works again, and it carries the original
  byte-for-byte** (`extension/content.js`, `extension/manifest.json` → ext
  v0.9.3, `test/extension-logic.test.js`). Dragging a capture out of the floating
  tray stopped working, and three passes of reasoning about the payload gave
  three wrong answers. What settled it was measuring the drag itself — real
  Chrome, every payload shape dispatched side by side from one page
  (`dev/ext-tray-probe.mjs`) — which showed that a drop **in the same document**
  (the actual case: the tray is injected into the chat page) can read exactly one
  kind of payload. `setData('DownloadURL', …)` reaches it as an **empty store**
  (Chrome resolves that URL only for an OS drop or a drag to another tab), and
  `items.add(new File([blob], …))` delivers the **filename** as `text/plain` and
  **no file item at all**. The payload this file used to set — a `DownloadURL`
  plus a `File` built over the cached original — was therefore handing a chat box
  a bare filename: a drag that does nothing, which is exactly what it did. Only
  a dragged `<img>` works: Blink writes the image's own **encoded** bytes into
  the store and the drop receives a real `File`, byte-for-byte — an image loaded
  from a `blob:` URL contributes precisely that blob's bytes (hash-verified),
  and a `DownloadURL` set beside it does not disturb the file. So the drag source
  is the tile's `<img>` again (as in v1.11, the last release this worked in), and
  the tile the pointer is on is **upgraded to the stored original's `blob:` URL**
  — a local load the tray already paid for on hover, so no second transfer, no
  re-encode and no added latency on the gesture. Full quality is then structural
  rather than a bet on a fetch: Blink has no other bytes to write. The one case it
  cannot cover — a grab that crosses Chromium's drag threshold before the hover
  upgrade lands — is reported instead of hidden: the tray's status line says the
  capture went out as the 400px preview, because a silent downgrade is the exact
  thing this path exists to prevent. The grid still
  *displays* the derived 400px thumbnail, which is what keeps opening the tray
  cheap, and an evicted original drops its tile back to that thumbnail instead of
  leaving a broken image. `DownloadURL` is still declared (in its own `try`) for
  the OS-drop / cross-tab case and remains the only string format the handler
  sets. Two related origin bugs went with it: the pinned-host read now latches
  only on a *successful* `getHost` (latching on a failed one pinned `SERVER` to
  the built-in default for the page's whole life, which makes Chrome's own
  `DownloadURL` fetch fail silently), and every successful direct fetch adopts
  the origin that answered it (`adoptServer`, used by `/api/captures`,
  `/api/captures/version` and media — previously only media). See PITFALLS #56.
- **Clicking a capture can no longer report a copy it actually made as
  "blocked"** (`extension/content.js`, ext v0.9.3, `test/extension-logic.test.js`).
  The clipboard API only accepts PNG, so a copy has to re-encode the capture
  first — seconds of work for a 12MP photo, where Chromium's transient user
  activation lasts about five. The old path awaited that encode (and, on a cell
  the pointer had not warmed, a LAN fetch for its bytes) *before* calling
  `navigator.clipboard.write()`, so a big capture reached the write with no
  activation left to spend and failed as `NotAllowedError` — handed back to the
  user as "copy blocked" with nothing actually wrong. The write now goes FIRST
  and is handed a **promise** for the PNG (`new ClipboardItem({ 'image/png':
  pngFor(c) })`), which the API accepts precisely so a slow encode does not have
  to fit inside the activation window; the awaited form is kept only for a build
  that rejects a promised blob, so no browser loses the copy. The bytes are
  untouched (the clipboard only takes PNG, and `toPng` still resizes nothing a
  canvas can hold). All three writes — click-to-copy, the auto-paste fallback and
  the undelivered flush — now go through one `writePngToClipboard`; `pngFor`
  returns the in-flight encode when a second caller arrives instead of starting a
  duplicate (a 48MP PNG is seconds of the worker thread); the one refusal the
  user can fix now says so (`click anywhere on this page, then copy again`,
  because the clipboard needs the PAGE focused and clicking the toolbar stole
  it); and `rawFor` keeps the blob the SW relay fetched, so the auto-paste PNG
  retry no longer goes back to the LAN for bytes already in hand. See PITFALLS #57.
- **A capture can be sent to the chat from the keyboard** (`extension/content.js`,
  ext v0.9.3, `test/extension-logic.test.js`). Enter/Space copied to the
  clipboard, which still owes the user a Ctrl+V and needs the page focused to
  boot; the drag — the path that puts a capture straight into the page's own
  editor — was mouse-only. **Ctrl/⌘+Enter** on a focused tile now runs the same
  transfer the phone's "auto" mode uses, whole: target discovery, the PNG retry,
  the clipboard fallback and the undelivered queue all come with it, so a
  keyboard user gets the capture INTO the chat rather than into the clipboard
  with a paste still owed. The tile's tooltip, its accessible name and the tray's
  resting status line all name the shortcut — an affordance, not the "hidden
  feature" PITFALLS keeps recording.
- **Auto-paste puts the capture in the composer instead of a footer box**
  (`extension/content.js`, ext v0.9.3, `test/extension-logic.test.js`). Target
  discovery took the LAST editable candidate in DOM order, so on a page with a
  comment field or a search box below the composer the capture could land out of
  sight — the opposite of what its own comment said it did ("most-visible
  editable element"). Every editable a chat site actually builds is now
  recognised (`contenteditable=""` IS editable, `plaintext-only` is real,
  `role="textbox"` wrappers are composers, password/hidden controls are not), a
  focused editor still wins because that is where the caret is, and the fallback
  is the **largest visible** candidate — a composer is big, a search field is
  not. Body stays the last resort, so a site that handles paste at the document
  level still gets its shot. See PITFALLS #58.
- **The tray's text list can no longer freeze while the tray is open**
  (`extension/content.js`, `extension/background.js`, ext v0.9.3,
  `test/extension-logic.test.js`). `/api/captures/version` returns a `textId`
  fingerprint for exactly one reason — "so poll-fallback clients notice text
  changes too" — and the tray polled that endpoint every 5 seconds, used `n` and
  `latest` for the captures, and threw `textId` away. The text list was rendered
  only when the tray opened, so a text sent from the phone while the tray was
  open never appeared: the panel's one phone→PC surface looked live and was
  frozen, with nothing erroring to say so. The poll's own response now drives a
  **quiet** refresh (`v.textId !== textsVersionId`), checked *before* the
  unchanged-captures early return because a text changes while the capture list
  does not — no extra request, no second timer. A quiet pass never flashes the
  loading placeholder and never rebuilds an identical list (which would reset the
  scroll position every 5 seconds), a transient failure keeps the last good list
  rather than painting "server not reachable" over it, and a sequence number
  settles the one race that opening the tray creates (a loud load and the poll's
  quiet one landing out of order, which a key-only guard answers by leaving the
  placeholder on screen for good). The same function asked the two transports for
  different row counts — the SW relay for 10, the page-side fallback for 5 — so
  which list you got depended on whether the worker happened to be awake; the
  caller now owns the number and passes it along. See PITFALLS #59.
- **The bulk bar closes when the selection it was opened for is gone**
  (`public/app.js`, `public/index.html`, `test/pc-ui.test.js`). Ticking a tile's
  selection box opens Select mode and the bulk bar with it; un-ticking that box
  left the bar sitting over the grid reading **"0 selected"** with a dead Copy and
  Delete — a menu with nothing in it. What was missing is the other half of the
  rule it already had ("picking is how the bulk bar appears"): *entry decides the
  exit*. A box is an **implicit** entry — the bar is up because something is
  selected, so it goes down with the last un-ticked box and takes the mode with
  it. The ⋯ menu's **Select**, `S` and `⌘A` are **deliberate** entries and
  `selectPinned` holds their empty bar open, because Select all and Cancel are
  exactly what it is for there. The pin is dropped on the way out, so the next
  implicit entry starts unpinned instead of inheriting the last one's rule.
- **The recent-texts strip no longer costs the captures anything**
  (`public/app.js`, `public/style.css`, `public/index.html`,
  `test/pc-ui.test.js`). **Measured at 1440×900: the strip was 178.5px of the
  card** — three 35.5px rows under a 36px header, the first thing on the screen,
  and it pushed the first capture row down to **y339.5** in an app whose whole
  purpose is those captures. It is now a glance in the band beside the field it
  belongs to, and **measured, the card opens on the toolbar and the first capture
  row sits at y147 — 192.5px higher than before, with the whole 178.5px given
  back**. Two things kept it that tall for no reason and both are gone: a 7px
  padding that only ever wrapped one 13px line (4px now; the row is its 28px
  target and nothing more), and `.linkbtn`'s `margin-top: 8px` — meant for a link
  sitting *under* a line of text — which dropped "Every text…" 8px below the
  eyebrow that labelled it inside what is a flex row, inflating the header to
  36px. The width is what it costs instead, and that cost was real: `#text-bar`
  had to become a **definite** `width: 560px`, because an auto-sized flex item
  contributes its CONTENT width to its parent's intrinsic size — the band's new
  compose group measured itself **517px** (210 + 14 + the bare textarea) and
  shrank the field to **185px** to fit inside its own group, live. With the
  definite width the group is 784px and `#text-input` keeps its 452px, and **Send
  and the mail icon are still at x1372** — the move changed nothing about where
  they land. Below 1024px the band cannot hold brand + glance + field + the drawer
  trigger, so the glance stands down and the mail icon carries the job alone (the
  same width-gating the filter chips use): measured `display: none` at 1023, and
  `scrollWidth === innerWidth` at 1440 / 1024 / 1023 / 900 — no horizontal overflow
  at any of them.
- **A toast can no longer cover the bulk bar's Cancel button**
  (`public/style.css`, `test/harness-ui.test.js`). The lift that keeps the toast
  stack clear of a bottom-centre bar was a per-case override that named the
  lightbox and nothing else, so entering select mode put the "Tap captures to
  select" pill straight on top of Cancel — **measured: toast 164×38 at y841–879
  over Cancel 66×27 at y825–852, with the toast also overhanging the card (879 vs
  861)**. It is now ONE variable: a bottom-docked bar sets `--toast-lift` and
  `#toasts` reads `calc(22px + var(--toast-lift, 0px))`. The lightbox keeps its
  exact old 86px (22 + 64), and the 45px bulk bar — which sits 39px off the
  viewport floor — lifts to 90px, clearing Cancel by 14px. A third bottom bar is
  now correct by default instead of correct by luck.
- **The phone's "Reduce image quality" setting is now the ONLY thing that may
  shrink a capture** (`public/toPng.js`, `extension/toPng.js`, `public/phone.js`,
  `test/quality-clamp.test.js`). Two other paths reduced a photo with the
  setting OFF, silently, and each cost far more than it looked like:
  - **Copy on the PC** clamped the longest side to a flat **8192px** *"purely to
    protect memory"*. Because the server already refuses anything over its pixel
    ceiling, the clamp could only ever bite on **aspect ratio** — i.e. precisely
    on scrolling screenshots and panoramas: a stored 1080×24000 shot pasted as
    369×8192, **11.7% of its pixels**, with no signal anywhere in the UI. It now
    resizes only when a canvas physically cannot hold the image (32767px a side —
    Firefox's limit, the tightest engine the harness opens in — and 2^28px of
    total area), which no *storable* capture reaches, and then only by the
    overlap. The old comment's claim that "every real phone photo (12–48MP)
    copies at full resolution" was doubly wrong: a 48MP photo can't even be
    *stored* under a 30MP ceiling, and 12MP never came near 8192.
  - **The phone's HEIC→JPEG conversion** inherited quality reduction's **4096px**
    clamp through a bare default, so an iPhone 48MP HEIC (8064×6048) was stored
    as 4096×3072 — **25.8% of its pixels** — on a conversion the PC needs purely
    for *decodability*. It now passes no size limit at all: it may change the
    FORMAT, never the resolution.
- **A photo past the PC's pixel ceiling used to be lost forever, in silence**
  (`server/store.js`, `server.js`, `public/phone.js`). The ceiling was 30MP, so a
  50MP Android gallery pick was refused as `415 not a supported image` — a status
  the phone's queue treats as *transient*, so the item was bumped and re-sent on
  exponential backoff up to every 5 minutes, forever, with no flash, no error
  tile and no failure state: the photo simply never arrived and nothing said why.
  The ceiling is now **64MP** — every real sensor mode (12MP, 48MP HEIC, 50MP
  JPEG, 64MP) — so a full-resolution capture is never refused and never has to be
  downscaled to fit, which is what makes the rule above enforceable. It is also
  *published* to the phone (`GET /api/quality` → `maxPixels`, one home for the
  number) so the phone never has to guess a limit, and over-ceiling is refused as
  a **terminal 413 `too many pixels`**: it poisons the queue in a single attempt
  and the phone says *"Too big for the PC (over 64MP) — turn on Reduce image
  quality to send it"*, naming the one switch that fixes it.
- **Dragging a capture out of the p-tray can no longer deliver the 400px
  thumbnail instead of the original** (`extension/content.js`, `test/extension-logic.test.js`).
  The dragged element was the grid thumbnail `<img>`, and Blink
  attaches a dragged image's OWN bytes to the drag
  (`DataObject::WriteImageToDataObject` → `AddFileSharedBuffer`) — Chromium only
  prefers the page-declared `DownloadURL` over them when it can actually fetch
  it (`web_contents_view_aura.cc`: *"Put download before file contents to
  prefer the download of a image over its thumbnail link"*). Whenever that
  fetch did not happen — a pinned host that is stale for that page, a blocked
  loopback request, the server asleep — the drop silently received the
  thumbnail: a 2.3 MB capture arrived as ~37 KB, with the transfer-quality
  setting OFF and nothing anywhere saying so. The thumbnail is no longer a drag
  source (`img.draggable = false` + `.cell img { -webkit-user-drag: none }`),
  so the cell carries the drag and the `DownloadURL` is the ONLY file payload
  it can carry: a drop gets the original, or nothing — never a silent
  downgrade. It also now points at whichever origin last served media to that
  page, so Chrome's own fetch is not stuck on a host that is stale there. The
  thumbnail is still the drag *visual*. Pinned by a test, since the tray is a
  closed shadow root.
- **...and the drag declares the capture's REAL format** (`extension/content.js`,
  `extension/paste-logic.js`, `test/extension-logic.test.js`, ext v0.9.2). The
  payload was hardcoded `image/jpeg:proofpipe-<id>.jpg:<url>` for every capture,
  so a PNG screenshot came over as a JPEG, a WebP as a JPEG, an iPhone HEIC as
  a JPEG — and a consumer that trusts the declared type re-encoded the pixels
  lossily (or could not decode the HEIC at all). The `mime:filename` pair now
  comes from the stored name's own extension via a shared
  `PPPasteLogic.dragFile()` — the same helper family as the auto-paste filename
  (`pasteFileName`), so the two name builders cannot drift — with the old
  `image/jpeg` + `.jpg` kept only as the unknown-extension fallback.
- **Smoke's port-squat retry actually retries** (`test/smoke.test.js`).
  The boot hook read the failure reason with `/EADDRINUSE/.test(errOut)` *after*
  clearing `errOut`, so the condition was always true and the redraw never ran:
  any process holding a port in smoke's range failed all 17 tests while the code
  read as if it handled it. Found by reproducing the suite's intermittent
  all-fail runs under load (three parallel suites squat each other's range), and
  proven by squatting the whole range deliberately — 17 failures before, 17
  passes after.
- **A delete can no longer race the background thumbnail decode**
  (`server/cleanup.js`, `server/store.js`). `/upload` acks before the thumbnail
  is derived, and sharp holds the ORIGINAL open for that decode — so deleting a
  capture right after uploading it raced the decode, and on Windows the unlink
  lost (`EBUSY`/`EPERM`). The loser was the delete: the row went, the original
  stayed as an orphan the boot sweep would only find on the next restart, and
  the byte total did not even drop, because the accounting deliberately re-adds
  the bytes of a file it could not remove. It needed load to show
  (test-smoke under three parallel suites reproduced it every run; single-file
  runs almost never did). The reader now announces itself (`beginFileRead` /
  `endFileRead`, bracketed around `makeThumb`'s path reads) and the deleter
  **waits for it** (`awaitFileIdle`, bounded at 5s) before unlinking, with the
  retrying unlink as the second line of defence; an on-demand thumbnail built
  for a row that vanished mid-decode is no longer left behind either. The audit
  that came out of this found the same hole in `DELETE /api/captures` (the wipe
  retried its unlinks but never waited, so a wipe fired at a batch still being
  thumbnailed rested on a 400ms retry budget covering a decode it did not
  control) — it now waits for the readers too, and a source guard in
  `test/smoke.test.js` fails if either deleter loses its wait, its retry, or the
  reader loses its announcement. Everything else in the transfer/media paths was
  checked and left alone: libuv's own handles (a served file's read stream, an
  upload's write stream, an in-flight `copyFile` for the inbox or a backup) are
  opened share-delete, so they never block an unlink — only sharp/GLib's own
  `fopen` did, and capture originals are its only targets.
- **Thumbnails regenerate on demand** (`server.js`). The boot sweep was the only
  regenerator, so a deferred thumbnail write that failed mid-session stayed
  missing for the whole run — a rate-limited burst could leave tiles blank until
  a restart. `/media/t-*` now rebuilds the thumbnail from its capture row and
  serves it, still 404ing when the ORIGINAL is gone, and the client's retry
  window is 12 staggered tries (5s ceiling) instead of 6 straight ones. A
  thumbnail miss still never poisons the capture: `deadPcMedia` is only ever set
  by a full-resolution 404.
- **A 429 pauses the transfer instead of dropping the tail** (`public/app.js`,
  `public/phone.js`). Both burst paths — the PC's file uploads and the phone's
  live captures — now back the whole pool off for the same 1.5s
  `PPQueue.onFailure` uses, so the bucket refills and the photo/file keeps its
  fast path. The CHANGELOG used to claim the PC retried 429s; it did not, because
  `uploadFileXHR` threw away the status.
- **The dead `.file-card` selectors are gone** (`public/app.js`,
  `public/style.css`). Nothing has created a `.file-card` since transfers became
  `.transfer-row` rows, so `fileRemove`'s second `querySelector` could never
  match and the seven rules keyed on it styled nothing.
- **A long file name no longer stretches the harness out of the screen**
  (`public/style.css`). `.main-card` is a GRID item of `.view`, whose second
  column is `1fr` — really `minmax(auto, 1fr)` — and a grid item's automatic
  minimum is its *min-content* size. One 120-char name (nowrap in `.f-name`)
  therefore inflated the column to 1104px and pushed the card 80px past the
  right edge of a 1440px window, taking the whole page into a horizontal
  overflow. `min-width: 0` on the grid item keeps the column on its share and
  lets the name ellipsize, which is what `.f-name` was always meant to do
  (`min-width: 0` on the inner `.f-info` only lowers what a shrink can reach —
  it cannot lower a min-content contribution). Verified in Chrome: card 1034px,
  right edge 1408 ≤ 1440, name `clipped: true`; also clean at 1100px.
- **Server strings echoed into chrome are now capped and breakable**
  (`public/style.css`). Toasts and the confirm dialog print file names and
  absolute paths verbatim and cannot know how long they are: the centred toast
  grew wider than the viewport and dragged the bottom bar off screen, and the
  confirm text spilled out of its 380px box. `#toasts` is capped at
  `min(92vw, 620px)` and `.toast`/`.confirm-box p` break anywhere.
- **Phone: the PC-sent lane is loaded at boot** (`public/phone.js`).
  `loadTexts()` was the one lane missing from the boot sequence: with SSE up it
  only ran on a NEW `text` event (or when SSE was down, per its own comment), so
  a cold load showed an existing session's PC-sent captures/texts NOWHERE until
  the PC sent another one or the tab was hidden and re-shown. Measured: the lane
  stayed empty for the whole 14s window before the fix, and renders from the
  first second after it.
- **The pairing QR retires on connect and comes back in seconds, not minutes**
  (`server.js`, `server/sse.js`, `public/app.js`, `public/phone.js`). The QR's
  only presence signal used to be the phone's ping window (~90s) read by a stats
  poll — which, with SSE healthy, ran on capture/file events only, so the QR
  could sit there long after it was scanned and never return once the phone left.
  - A phone now labels its SSE stream `?device=phone`, and that stream is its
    live wire: the server pushes a `phone` event the moment one arrives, so the
    QR goes as soon as the page opens.
  - Its close is the earliest honest sign the phone is gone, so `/api/stats`
    answers a server-side `phoneOnline` (ping-fresh AND no observed close) and
    the harness follows that verdict instead of the local clock. The close waits
    out a 4s grace (EventSource retries in 2s, a reload re-opens in ~1s) so a blip
    cannot flash the QR, and **any ping clears the verdict** — a phone that is
    pingable can never be reported gone, so one whose SSE never connected still
    reads as online and the QR can't get stuck hidden.
  - The 15s `/api/stats` tick now also runs **while a phone is believed online**
    (it was SSE-down only): that is the backstop for a phone that only pings, and
    it keeps the "Phone: seen …" line from freezing.
- **Harness (PC) info-card polish** (`public/index.html`, `public/style.css`,
  `public/app.js`):
  - The card's two section labels rendered at different sizes AND colors:
    `.card.side h3` out-specified `.eyebrow` (so "PAIR PHONE" was 15px) while the
    stats heading was a `<b>`, and `.hint b` out-specified `.eyebrow`'s color (so
    "STORAGE" came out brighter than the label directly above it). Both are quiet
    11px micro-labels now.
  - The stats block sat at content width inside a centered column, so it looked
    ragged against the QR and the interface picker above it — and *changed width*
    as the numbers grew. It stretches to the card like every other row now, and
    its rows are block elements instead of `<br>`+`<span>` soup.
  - "1 captures" → "1 capture"; a multi-phone line says "· 3 queued" rather than
    a bare "· 📦 3".
  - **Only one QR on screen.** The empty state rendered a second copy of the same
    pairing code ~200px below the card's own. The card owns the QR (it carries
    the interface picker and the LAN URL); the empty state points at it, and its
    wording follows the QR's visibility (a connected phone is not told to scan).
  - **The card no longer tells you to scan a QR that cannot work.** With no LAN
    interface the QR points at localhost and pairing is impossible; that state now
    says so instead of "scan the QR above".
  - The interface picker is hidden when there is only one interface to pick — the
    LAN URL already names it and the card has to fit vertically. It also starts
    hidden, so an empty `<select>` no longer flashes in on every load.
  - The desktop-only `scrollbar-width: none` clipped the storage/legend rows on a
    short window with no hint that anything was below; the card keeps a thin
    scrollbar at every width (it only renders when the card actually overflows).
  - `#lan-url` no longer carries `href=""` (a link back to the harness until
    `/api/lan` resolved), the QR's `alt` describes scanning it, and the legend
    icons are `aria-hidden` since their adjacent text already names them.
- **Harness (PC) UI/UX audit pass** (`public/index.html`, `public/style.css`,
  `public/app.js`):
  - Toasts sat on the lightbox action bar (both are bottom-center; toasts are
    z-index 200 and interactive for Undo), so a "Copied" toast covered
    Rotate/Delete for its whole lifetime. They lift clear of the bar while the
    viewer is open — the PC counterpart of PITFALLS #34.
  - The update banner was pinned to `top: 57px`, which lands ON the compose bar,
    and it is interactive — it swallowed clicks meant for the text input. It now
    sits inside the header band, the one strip with no controls in it.
  - **Grid keyboard shortcuts could act on the wrong capture.** `X`/`D`/`C`/
    Enter resolved `view[focusedIdx]`, but an SSE insert prepends to `view`,
    shifting every index under the focused tile — a delete could hit the
    neighbouring capture. The target is now resolved from the tile that
    actually holds focus; `focusedIdx` is re-derived in `refreshGridCache` (and
    drops to -1 when nothing is highlighted), Space activates like Enter, and
    the keys no longer double-fire when a tile action button has focus.
  - **"Load older captures" paged the whole library by itself.** The
    IntersectionObserver watched `#load-more`, which is pinned BELOW the
    scrolling grid and therefore always on screen — with a 400px rootMargin it
    never stopped intersecting. Replaced with a passive, O(1) scroll check on
    the grid; the button stays as the manual/keyboard trigger.
  - Keyboard reachability: "＋ File" was a `<label>` wrapping a hidden input
    (labels are not focusable — file send was mouse-only), and the latest-text
    chip plus every history row were clickable `div`s with no tab stop, so
    copying a text had no keyboard path at all. Both are real controls now, and
    a new `P` shortcut sends the focused capture to the phone.
  - A delete could not be undone by keyboard (the Undo toast auto-dismisses in
    10s and focus never moves to it): `Ctrl+Z` now activates the open undo
    window, while editable fields keep their own Ctrl+Z.
  - Tiles were `role="button"` wrapping four more buttons plus a link — invalid
    interactive nesting. Thumb + meta now sit on one `.capture-open` surface,
    with the overlay actions as siblings.
  - Focus and state were color-only or missing: the tile ring used `:focus` (a
    mouse click left a green outline behind), `.btn` (lightbox bar, bulk bar,
    confirm) had no `:focus-visible` at all, Select and the density buttons had
    no `aria-pressed`, the tablist had no `aria-controls`/`tabpanel`, the
    lightbox had no dialog role, the confirm dialog had no accessible name, and
    `#text-input` plus several selects had placeholder/title-only labels.
  - `--faint` was 4.4:1 on `--card` (and worse on `--card2`) — below AA for the
    11.5–12.5px timestamps and hints it labels. It is `#8a8c8e` now.
  - Layout: `body` is a flex column instead of `calc(100dvh - 49px)`, the header
    shares the 1800px content column (it ran full-bleed and seamed against
    `main` on ultrawide displays), the settings dialog scrolls instead of
    clipping its last rows, `#text-history` is anchored to the compose bar (it
    had no positioned ancestor), and an empty uploads box no longer leaves a
    phantom gap under the toolbar.
  - Housekeeping: sort order is remembered like density/tab/merge, `filePush`'s
    two identical branches collapsed, `#empty` visibility has one owner
    (`updateEmptyState`), and the transfers list is fetched only when the
    restored view shows it (capture-only users no longer pay for a 100-row
    `/api/files` request on every load).
- **Extension audit pass** (`extension/*`; new cases in
  `test/extension-logic.test.js` + `test/fab-hide-show.test.js`):
  - **Thumbnails load on VISIBILITY, not eagerly.** The tray renders up to 100
    cells (the server's list cap) while ~9 are on screen, and the popup did the
    same for its whole list — opening either fired ~100 parallel LAN fetches,
    all fighting the handful actually visible (`img.loading='lazy'` never helped:
    the fetch starts before `src` is assigned). One IntersectionObserver per
    surface, rootMargin'd a screen ahead, now fetches only what scrolls into
    view. Biggest perceived-speed win in this pass.
  - **Every fetch is bounded.** The extension had no data-fetch timeouts at all
    (only the `/api/version` probes did), so a half-open LAN connection left the
    popup on “Loading…” and the tray stale forever, with no error path. Direct
    fetches and `serverFetch`/`prefetchBlob` now carry `AbortSignal.timeout`
    (4s JSON, 15s media — matching the harness's `api()` budget).
  - **The pinned origin is re-verified at most once per 45s.** `ensureHost()`
    runs on every `serverFetch` and always paid an extra `/api/version` round
    trip, so the tray's 3s poll doubled its own traffic. A NETWORK failure still
    clears the pin (a server that MOVED is re-discovered); an HTTP error status
    does not — the server is demonstrably there.
  - **The offscreen relay probes in parallel stages.** `findHost()` walked up to
    ~100 candidates serially at 1.5s each, so a port change left auto-paste dark
    for tens of seconds. The staging now lives in `discovery.js`
    (`PPDiscovery.probeHosts`) and is shared with `background.js`, which already
    had it — the relay's private copy had drifted.
  - **The tray's 3s poll no longer pulls the whole list.** It asks
    `/api/captures/version` for a `${count}:${latestId}` fingerprint first and
    refetches only when something actually changed — the same pre-check the
    harness and the phone's `loadRecent` use.
  - **Popup tabs follow the ARIA tabs pattern**: one tab in the tab order
    (roving tabindex) with Arrow/Home/End moving the selection. Both tabs used
    to be plain buttons, so Tab/Shift+Tab was the only way across.
  - **The per-site notice has its own row.** The async `fabState` check wrote
    into the shared status line and could land after `showTab()` had painted,
    overwriting the other message.
  - The tray's copy-failure hint no longer advises a mouse-only drag to keyboard
    users — it names the toolbar popup as the alternative path; and the popup's
    error-detail span is selectable again (the global `selectstart` guard had
    made the one copyable failure message un-selectable).
  - Boot-time harness suppression now also recognises a CUSTOM-port harness by
    its own document title, closing the window where the p button flashed there
    before the async `pp_host` read landed.
  - The popup revokes its cached thumbnail object URLs on `pagehide`.
  - Auto-paste prefetches the capture only once a paste TARGET is resolved: it
    still races the tab's media request (that one begins after the routing
    message lands), but a capture with nowhere to paste no longer pulls a
    full-size image off the server for nothing.
- **`PPFiles` — one /media filename guard (`extension/files.js`, new).** The
  guard was copy-pasted in three files and had to stay in lockstep by hand; a
  drift there is security-relevant (it is what keeps `../settings.json` and
  absolute URLs out of a fetch). It is now a shared module wired into all three
  loader chains (SW `importScripts`, popup, content scripts) with the wiring
  pinned by the existing loader-contract test. Dot-only names (`..`, `t-..`) are
  refused too — `/media/..` normalizes to `/`.
- **Phone UI audit pass** (`public/phone.*`, guarded by the new
  `test/phone-ui.test.js`):
  - The file-sheet ✕ positioned against the fixed overlay instead of the
    dialog box, so it rendered in the screen corner (and the box reserved 52px
    of padding for a button it did not contain).
  - Capture / Choose photos / File were `<label>`s with no `tabindex`: the three
    main controls could not take focus at all, and the `.shutter`/`.alt-btn`
    `:focus-visible` rings in phone.css could never match. They now carry
    `role=button tabindex=0` + Enter/Space, and the shutter finally uses the
    `.busy` state it documents (ref-counted while a batch uploads).
  - Chip deletion was gesture-only: a focused chip now deletes with
    Delete/Backspace through the same deferred undo path, file chips carry an
    accessible label and are focusable (they were bare divs), and an IME
    no longer sends on the Enter that commits a candidate (`e.isComposing`).
  - Keyboard mode never engaged on Android — `interactive-widget=
    resizes-content` shrinks `window.innerHeight` with the visual viewport, so
    the old `vv.height / innerHeight` ratio stayed ~1 there (iOS Safari ignores
    that meta, which is why it worked). It baselines against the un-focused
    viewport height now.
  - "show older" had no styling on the phone: its only `.linkbtn` rule lived in
    `style.css`, which `phone.html` never loads.
  - Tap targets under the 44px floor (DESIGN §2): `#text-expand` 36→44,
    `#text-send` / `#viewer-close` 40→44, and the undo button, queue chip and
    quality slider rebuilt to 44px.
  - The More menu could run past the bottom of a short/landscape viewport with
    no way to scroll to the last action; it is bounded and scrolls now.
  - Flash toasts stacked on one spot during a batch send (one reused node now);
    `#recent` promised `list` semantics with `role=button` children; a tile's
    pending/"not sent" state existed only in CSS `::before`/`::after`; and the
    queue chip was an unfocusable `div` carrying the live region on the tap
    target itself (the wrapper is the button, the `aria-live` span is inside).
  - `.alt-btn.danger` used the `--danger` fill color as text (DESIGN §1 wants
    `#fca5a5`), the actions row mixed 14px and 999px radii for peer controls,
    and the duplicated rule blocks (`#more-btn`, `#more-menu`, `.text-in`,
    `#viewer-bar`, `.text-chip`) were consolidated.
- **Auto-paste died whenever "Open harness in" named a browser other than
  Chrome or Edge.** `settings.browser` is stamped onto every auto SSE event as
  `autoTarget`, but `PPBrowserTarget.shouldAutoPaste` matched the tag with a
  literal `target === myId` string compare and only ever produced `chrome` or
  `edge` from the user agent. The harness exposes seven Chromium-family picks
  (`server/browser.js` CANDIDATES: chrome, edge, brave, opera, vivaldi,
  chromium, firefox), so picking Brave/Opera/Vivaldi/Chromium tagged every
  event with an id **no** extension instance matched — the gate returned
  `false` in both Chrome and Edge and auto-paste silently stopped (Firefox was
  the only documented dead pick). The gate now maps every Chromium harness id
  to the chrome-family instance; an explicit `chrome`/`edge` pick still
  disambiguates the two, and an uninstallable pick (Firefox) still pastes
  nowhere. Locked by new cases in `test/extension-logic.test.js` plus a drift
  guard that reads the harness's own browser-id list.
- **Auto-paste also died when the picked browser had no live extension.** Even
  with the gate fixed, `autoTarget` was `settings.browser` verbatim — so picking
  a browser the extension is NOT installed in (e.g. "Microsoft Edge" while the
  extension lives in Chrome) tagged every auto event with an id no connected
  instance matched: `false` everywhere, silently. The extension now reports its
  browser on the SSE connect (`extension/offscreen.js` →
  `/events?browser=…`); `server/sse.js` tracks it (`hasBrowser`) and
  `server/browser.js`'s new `resolveAutoTarget` falls back to `default` when a
  `chrome`/`edge` pick has no live instance, so a lone instance elsewhere still
  receives the paste. An explicit present pick still disambiguates Chrome from
  Edge; a `firefox` pick still passes through (pastes nowhere, as documented).
  Covered by pure + SSE-integration tests in `test/browser.test.js`.
- **Performance & UX audit pass** (`AUDIT-REPORT.md` — all 37 findings are now
  fixed). Every item was verified against source or a live test; docs were
  treated as claims, not evidence. Security items were out of scope by request.
  The ones that actually hurt:
  - **A remote delete could act on the wrong capture.** The SSE `deleted` branch
    removed the tile from the DOM without re-deriving the keyboard cache, so
    `gridCache.cells` kept a detached node and a stale index — `X` (delete),
    `D`, `C` and `P` could then hit a *neighbouring* capture.
  - **A cleanup sweep emitted one SSE event per deleted row**, and each one made
    every connected phone refetch its whole list: trimming a 2 000-capture
    library to a new cap meant thousands of events and a multi-minute freeze.
    One payload-less event per sweep now, and clients refetch once.
  - **Bulk delete pinned every full-resolution original in memory** for the 10 s
    undo window — 0.5–2 GB for 100 phone photos, and the tab died *after* the
    deletes were already committed. Undo is capped at a 96 MB budget now.
  - **Auto-paste verification walked the whole document per animation frame**
    (`querySelectorAll('*')` plus every element's `shadowRoot`) for up to 2.4 s,
    on the very page being pasted into. Shadow hosts are discovered once per
    attempt and capped; the broad check runs only at attempt start/timeout.
  - **The stale-tab recovery path was a no-op** — `checkPageVersion()` early-
    returned on a flag that was never reset, so after a server restart the grid
    silently froze and the "ProofPipe was updated" banner never appeared.
  - Cheaper, high-visibility wins: one `GET /api/settings` replaces 14 boot
    requests (and the `settings` SSE payload is applied instead of re-fetching
    nine more); the lightbox releases its neighbour preloads on close; the
    pairing QR reserves its box, so the sidebar stops jumping; Transfers
    paginate on both clients; phone dialogs get the focus trap the harness
    already had; the stats poll only runs while SSE is down; the grid's column
    count comes from the computed tracks instead of a forced layout read; the
    backup stages files in chunks instead of one-by-one.
  - Error and state honesty: Copy can no longer hang silently (the last two
    un-timeouted fetches), a failed first load no longer claims the library is
    empty, Transfers no longer flashes "No transfers yet." before its first
    response, and a backup that outruns the client's budget reports "still
    running" instead of "failed".
  - **One loading convention** — lists get shimmer skeletons, single values get
    "…". The phone had no loading state at all: its recent grid now shows
    skeleton tiles and a "…" count until the first load settles, and "no
    captures yet" can no longer appear beside them or beside the error copy.
  - **One textarea** — the phone's composer auto-grows to the same 150px ceiling
    as the harness instead of staying a fixed 40px unless expanded; expanded is
    now a mode (Enter = newline) rather than a second height ceiling.
- **Modifier combinations are not grid shortcuts** (`public/app.js`). With a
  tile focused: **Ctrl+X deleted a capture**, Ctrl+P sent it to the phone *and*
  opened the print dialog, Ctrl+S toggled Select *and* the save-page dialog,
  Ctrl+D downloaded it *and* bookmarked. The single-letter branch bails on
  ctrl/meta/alt now; Ctrl+Z keeps its own undo path.
- **One Escape closes one layer** (`public/app.js`, `public/style.css`). With
  the delete confirm open OVER the lightbox, Esc closed the dialog *and* the
  viewer, Delete re-opened the dialog, and ←/→/R/± still rotated an image the
  user could not see; Settings and the folder picker each bound their own
  document Escape, so one keypress closed both. All four layers now defer to
  `escLayer()` (the phone's `closeTopOverlay()` equivalent).
- **The storage-folder picker was unusable with a mouse** (`public/style.css`).
  It is only ever opened from the Settings modal and sat at z-index 300, i.e.
  *underneath* `#settings-backdrop` (350): dimmed, and every click in it landed
  on the Settings backdrop and closed Settings instead. 370 now (DESIGN.md §7).
- **Settings confirmations were dimmed behind the modal veil**
  (`public/style.css`). Every control in the Settings modal fires its toast
  while that dialog is up, and `#toasts` sat at 200 — below the 350 veil. It is
  380 now: above Settings, still below the confirm dialog, so an interactive
  Undo can never cover a Delete.
- **A live region must not BE the interactive element** (`public/index.html`,
  `public/app.js`, `public/phone.html`). `#toasts` was `role=status
  aria-live=polite` with the Undo button *inside* it (and a region created with
  its content already in it is often never announced at all): the region is now
  the separate, invisible `#toast-announcer`, written by `announce()`, with the
  pill as positioning only. The phone's `#undo-toast` got the same split — its
  pill carried `role=status` around the Undo button — and its message span is
  `aria-live` now.
- **Long names wrap where there is room, and are clamped where there is not**
  (`public/phone.css`). The phone flash pill was a nowrap single line capped at
  80vw and the undo snackbar's message was `text-overflow: ellipsis`, so
  "«a 120-char name» is over the size cap" was exactly the message that got cut
  off. `.flash` now wraps (`overflow-wrap: anywhere`) — a rounded rect with room
  for a second line, carrying a *reason* where the cut-off part matters. The undo
  message was given the same treatment, which turned out to be the wrong half of
  that call: see the pill fix under Fixed.
- **Phone: the undo notification ballooned on a long file name**
  (`public/phone.css`, `public/phone.js`). Swiping a long-named transfer away
  wrapped the message inside the 999px undo pill: a 116-char name became
  **thirteen lines**, measured at 195×226px of white covering the whole PC-sent
  lane, the gesture tip, the picker row and part of the shutter, with the name
  squeezed into a 94px column. The message is now clamped to ONE line
  (`white-space: nowrap` + `text-overflow: ellipsis`; it is the flex item that
  gives way, so the Undo button keeps its 44px target) — a pill has to stay a
  pill. The clip is visual only, so the live region still announces the whole
  name, and `.flash` keeps wrapping for the reason above. Also: a PC-sent
  **capture** no longer says "Text removed" — its pill reads "Capture removed",
  agreeing with the card's own label.
- **Phone: the layout could not always be reached** (`public/phone.css`). With
  both PC-sent lanes holding chips, an upload burst in flight and the composer
  open on a short or landscape screen, the fixed chrome exceeds the viewport —
  and `.wrap` is `height: 100dvh` with the body's `overflow: hidden`, so the
  capture grid below it was simply unreachable. `.wrap` scrolls when (and only
  when) the content genuinely does not fit (`overscroll-behavior: contain`).
- **Phone: the queue counter could only destroy** (`public/phone.js`). The most
  prominent queue affordance in the app opened a "Clear all queued photos?"
  confirm — while recovery existed only as a per-tile Retry behind the viewer.
  It retries the queues now (re-running `checkServer()` and reporting what is
  left); clearing stayed in More options, with the other destructive actions.
- **Phone: "offline — photos queued" claimed a queue that could be empty**
  (`public/phone.js`). The status pill reports the real count ("offline · 3
  photos queued") or just "offline".
- **Phone: a sent tile's state was CSS-only** (`public/phone.js`). The green ✓
  badge is drawn by CSS and was spelled out nowhere; the tile's title names it
  ("Uploaded to your PC — tap to view"), including when a pending tile flips to
  sent in place. The shutter's busy state is mirrored to `aria-busy` on the grid
  for the same reason.
- **Phone: a clock time alone collides across days** (`public/phone.js`). A
  tile's label said "at 14:32" — two captures from different days were
  indistinguishable; a non-today stamp now carries the date.
- **Bulk delete is disabled at 0 selected** (`public/app.js`, `public/style.css`)
  — it was a live button that did nothing.
- **Stale comments corrected** (`public/phone.js`, `public/phone.css`) — the
  `#outbox-info` binding said "tap-to-clear the queue" after it stopped clearing
  anything, and two rules described the header as "compact … overflow button
  center" / "centered between the status pill and the wordmark" long after the
  layout moved the wordmark in and the button right.
- **Grid keyboard shortcuts acted on a grid the user could not see**
  (`public/app.js`). On the Transfers tab `#captures` is `display:none`, but its
  tiles stay in the DOM — including in the caches `gridKeys()` reads. Nothing
  checked the view, so one arrow key armed `focusedIdx` (its `focus()` on a
  hidden tile silently fails, leaving `activeElement` on `<body>`) and the next
  `X` deleted, `D` downloaded, `C` copied or `P` sent a capture that was not on
  screen; `S` even entered Select mode on the invisible grid. `gridKeys()` now
  returns unless `capturesVisible()` — the same guard `updateBulkBar()` and the
  empty states already used, so the rule is one rule again.
- **The drawer trigger never rendered: a media query adds no specificity**
  (`public/style.css`, `test/pc-ui.test.js`). The drawer's `#rail-toggle {
  display: grid }` sat inside the `@media (max-width: 899px)` layout block, ~20
  lines ABOVE the base `#rail-toggle { display: none }`. One id against one id is
  a tie, and CSS resolves a tie by source order — so the base rule won everywhere
  and the rail was **unreachable below 900px**, with the source reading exactly as
  intended. Caught by measuring (`getComputedStyle($('#rail-toggle')).display`
  returned `'none'` at an 800px viewport while `position: fixed` proved the media
  block *was* applied), fixed with a second 899px block placed after the base
  declarations, and pinned by a guard that asserts the ordering. See PITFALLS #50.

### Performance
- **Skeleton shimmer runs on the compositor** (`public/style.css`,
  `public/phone.css`). The sweep was an animated `background-position`, which
  repaints every placeholder every frame for the whole load (12 tiles on the PC,
  the entire strip on the phone). It is a translated gradient overlay
  (`.skel-img::after`, `transform: translateX(-100%) → 100%`) now — same look,
  zero paint.
- **Countdown bars and upload fills animate `transform`, not `width`**
  (`public/style.css`, `public/phone.css`, `public/app.js`, `public/phone.js`).
  The 10s undo bar, the phone's 6s bar and both upload progress fills animated a
  layout property for their entire life; they are `scaleX()`
  (`transform-origin: left center`, JS writes the fraction).
- **The drop overlay's halo is not a 500px box-shadow** (`public/style.css`).
  `@keyframes droppulse` repainted the whole box every frame for as long as a
  file drag hovered over the page — i.e. exactly when the browser is busiest. A
  scaled/faded ring pseudo-element (`@keyframes dropring`) does the same job on
  the compositor.
- **Nothing here adds a timer or a request.** The relative-label refresh rides
  the existing 15s stats tick, the toast announcer is one persistent node, and
  every client fix reads data already in flight.

## v1.11.0 / ext v0.9.0 — audit fixes, pinned extension origin, tray live-sync

Full-repo audit fixes plus the extension hardening/polish pass. The extension
now carries a `key` and two new behaviours (reload it from `chrome://extensions`
to pick them up); the server's range/delete/sweep paths are corrected; the
harness can no longer hang on a dead connection.

### Fixed
- **The relay watchdog never ran.** `background.js` used `chrome.alarms` for the
  offscreen-relay watchdog and the badge timer, but `"alarms"` was never
  declared in `manifest.json` — the API was `undefined`, every call was
  swallowed by its `try/catch`, and the recovery PITFALLS #2 documents was
  silently absent. The permission is declared, an unavailable API now logs a
  loud warning instead of failing invisibly, and
  `test/extension-manifest.test.js` derives the required permissions from the
  code so it can't regress.
- **Multi-range `Range:` requests** (`bytes=0-1,4-5`) returned a misleading
  `416` for satisfiable ranges; per RFC 7233 they now answer `200` with the
  full body (no multipart/byteranges support). Locked by `test/files.test.js`.
- **Harness fetches are bounded** (`api()` applies a 15 s timeout; slow
  operations — folder picker, backup, media-dir move, uploads — opt into a
  larger budget) so a half-open LAN connection can't leave the UI spinning.
- **Unbounded caches trimmed**: harness timestamp memos are capped and dropped
  on delete, `pngCache` is cleared on delete-all, and the phone's `deadPcMedia`
  set evicts oldest-first.
- **Bounded-concurrency file removal**: delete-all and the boot file-orphan
  sweep no longer issue serial (delete-all) or unbounded (sweep) `rm`/`stat`
  calls.
- Dead `reuseKey` upload option removed; dead `path.isAbsolute` check removed
  from `server/backup.js`.
- **The p-button show/hide only took effect after a page reload.** The content
  script subscribed to a single storage event (`chrome.storage.local.onChanged`)
  that a content script does not reliably receive, so the popup's toggle was
  invisible to already-open tabs until F5. It now listens to BOTH
  `chrome.storage.onChanged` and the per-area event (the handler is idempotent)
  and re-reads the flag on `focus`/`pageshow`/`visibilitychange` — closing the
  popup returns focus to the page, so the tray always converges live.

### Security
- **The mutation gate trusted ANY installed extension.** `csrfSafe` accepted
  `/^chrome-extension:\/\/[a-p]{32}$/`, which exempted every extension on the
  machine from the Origin/Host check — any of them could wipe captures. It now
  accepts only the id derived from `extension/manifest.json`'s `key` (Chrome's
  SHA-256 → a–p algorithm), with `PP_EXTENSION_ID` for a packed/Web-Store build.
  Locked by `test/regression.test.js`; the trusted origin is printed at boot.

### Changed
- Extension icons for 16/32/48 px are generated (`npm run icons`) and declared
  (was a single 128 that Chrome downscaled).
- `extension/preview.html` moved to `dev/preview.html` — it was unreferenced by
  the manifest, any script, or `chrome.runtime.getURL`, so it was dead weight in
  the packaged extension (and had drifted from `content.js`).
- Popup accessibility: tabs expose `role="tab"`/`aria-selected`, the list is a
  `tabpanel`, and the sync button has an `aria-label`.
- `ProofPipe.bat`'s already-running pre-check honours `PORT` (default 8787).
- CI runs `npm run lint` on the Linux job too; `package.json` declares its MIT
  license.
- Docs reconciled: README/CONVENTIONS lint claims now match the actual one-gate
  `eslint .`; PITFALLS #2 cadence and #27 port ranges corrected; the test port
  table now lives in `test/port-ranges.js`.
- Extension UI polish: visible keyboard focus rings everywhere, popup items and
  tray cells are keyboard-activatable (role=button + Enter/Space), the sync icon
  spins while re-probing, failures render in red, the tray empty state is a
  dashed card, the tray status line is a `role="status"` live region, and both
  surfaces honour `prefers-reduced-motion`.
- Manifest `key` added → the unpacked extension id is now stable across reloads
  (previously it changed with the load path).

## v1.10.0 / ext v0.8.0 — auto-paste follows the PC browser pick

### Auto-paste follows the PC browser pick (Chrome + Edge, no Firefox)

The Settings → "Open harness in" choice (`settings.browser`) used to drive
only the `.bat` launcher — auto-paste fired in whichever Chromium had the
extension, ignoring the pick. Now:
- `server/store.js` stamps every auto SSE event (`capture-ready` + the
  post-thumb `capture`) with `autoTarget` = the current `settings.browser`
  pick (`API.md` SSE contract updated).
- New `extension/browser-target.js` (pure, unit-tested): Edge UA (`Edg/`) →
  `edge`, everything else → `chrome`; `shouldAutoPaste(target, myId)` gates
  each instance. `default`/missing tag pastes anywhere (back-compat; the OS
  default is invisible to extensions, so pick explicitly to avoid
  double-pastes when the extension is in both). A `firefox` pick pastes
  nowhere in Chromium (no Firefox extension — documented in `README.md`).
- `extension/background.js` enforces the gate before prefetch/routing;
  `extension/offscreen.js` forwards `autoTarget` untouched.
- Install: same `extension/` folder loads unpacked in Chrome
  (`chrome://extensions`) AND Edge (`edge://extensions`).
- Tests: `PPBrowserTarget` unit tests + loader-wiring contract in
  `test/extension-logic.test.js`; `autoTarget` shape assertion in
  `test/regression.test.js`; `eslint.config.js` knows the new global.

### Restore the v1.9.8/v1.9.9 features & tests lost to the "pre browser selection" revert

The extension fixes in this batch (staged discovery, editable chat-site list,
prefetch-cache leak, badge-nudge dedupe, port-0 default bug) ship as part of
**ext v0.8.0** — no separate manifest bump.

A commit intended as a scratch save before the browser-selection work
(`3493f40`) reverted far more than its name suggested: ~1,500 lines of shipped
v1.9.8/v1.9.9 work — including test infrastructure, the phone's offline-queue
policy module, and five phone/extension features — and then only partially
recovered. This release restores everything that stayed lost, on top of the
v1.9.9 browser work (which is kept intact).

#### Restored: lint & tests (CI was red)
- **`eslint.config.js` restored** — `npm run lint` had been broken (ESLint 9
  "couldn't find an eslint.config file") since the revert; CI runs it as a
  gate, so every push was failing on the lint step.
- **`test/config.test.js` restored** (boot test moved to ports 9550–89, now
  that browser.test uses 9500–49): pins the UV_THREADPOOL contract — the
  `--require` preload, the .bat env export, and the dynamic-only sharp/better-
  sqlite3 imports.
- **`test/extension-logic.test.js` restored**: the 11 unit tests over
  discovery.js and paste-logic.js (port parsing, probe ordering, self-paste
  refusal, insert detection, loader-wiring contract).
- **`test/queue.test.js` restored**: the offline-queue policy tests (backoff,
  poison, 429 pause, planFlush ordering, unpoison migration).
- **Regression tests re-pinned**: the "19.9 MB photo must not 413" body-limit
  headroom test is back in `regression.test.js`; the served-HTML stamp test's
  content-hash assertions were already intact.

#### Restored: phone features (the toggle that did nothing)
- **Transfer-quality reduction works again on the phone.** The server flag,
  the PC settings modal, and the phone's More-menu UI all survived the revert,
  but the `upload()` choke point that actually compressed the photos was gone
  — the toggle flipped and silently did nothing. `qualityCompress` (canvas
  re-encode at the configured level, longest side clamped to 4096px, larger-
  output guard) is restored, plus the HEIC→JPEG transcode-on-upload path.
- **Upload idempotency works again.** The phone re-mints and freezes a dedupe
  key per capture (`newKey()`), passes it on every retry and outbox re-queue,
  and the server's `duplicate: true` answer is honored — a timed-out upload
  retry can no longer store the same photo twice.
- **The auto-paste flag is frozen at capture time again** (`opts.auto ??
  autoPaste`), so a photo queued offline never pastes just because the toggle
  flipped later.
- **`public/queue.js` restored** (phone.html still loaded it — a 404 script
  tag on every PWA load since the revert) along with the PPQueue-driven
  policy: single `onFailure` bookkeeping (the revert reintroduced a double
  tries-increment), 413-only poison with `poisonReason`, the one-time unpoison
  migration, and the sent-tile blob release (memory).
- Also back: viewer pan clamping, gesture-mode transition suppression,
  viewer/file-sheet focus restore, Android Back closing the topmost overlay,
  the timeout sized to the payload, per-format upload filenames, and the
  tiff/heic viewer fallback.

#### Restored: extension hardening
- **Staged discovery** (cheap stage-1 probes for automatic fetches, full
  matrix only on an explicit "Sync now"), the manual-port override in the
  offscreen relay, the **editable chat-site list** (`chrome.storage.sync` key
  `pp_chat_sites` — a new chat product no longer needs an extension update),
  identity-verified probe answers in the popup, shadow-DOM-aware caching, the
  persistent undelivered queue, poll lifecycle tied to tray open/close, and
  the id-slug guard on the drag payload.
- `toPng.js` copies regained the explicit `window.toPng` contract line (both
  copies byte-identical again — `test/dup.test.js` passes).

#### Fixed (audit findings)
- **`loadStats` no longer interpolates server strings into `innerHTML`**:
  the multi-phone stats block is built with DOM APIs (`textContent`), honoring
  the repo's own XSS rule. Numbers-only interpolation was low-risk; the rule
  is the rule.
- **Smoke suite survives ephemeral port squats.** A proxy client held port
  9030 as an *ephemeral outbound* port (invisible to netstat's LISTENING
  filter), failing 12 tests with EADDRINUSE. The smoke range widened to
  9027–9060 and the boot now retries with a fresh port draw when the server
  dies specifically on EADDRINUSE.
- `Microsoft/` (PowerShell's stray ModuleAnalysisCache) is gitignored.
- Version stamping verified end-to-end: `package.json` 1.10.0 is the single
  source of truth; `npm test` 87/87 green on Windows.

#### Fixed while reviewing this batch
- **HEIC→JPEG transcode actually runs.** `qualityCompress()` only returns a
  blob when it came out *smaller* — right for the quality-reduction path, but
  it handed every HEIC straight back, since a JPEG is routinely larger than
  the HEIC it replaces. Format conversion now passes `force: true`: the goal
  there is decodability, not size.
- **The 4096px canvas is released** (`c.width = c.height = 0`) instead of
  waiting for GC — ~67 MB held on a phone after each compression.
- **A queued record written before idempotency keys were frozen gets one.**
  A manual retry minted a key for its own attempt only, so the auto-flush
  later re-sent the record with no key — a timed-out upload that had
  actually landed would store a duplicate.

### ext v0.8.0 — the p button hide/show lives in the toolbar menu
- **Hide or show the p button on every site from the extension menu.** One
  persistent row at the bottom of the popup: "Hide p button everywhere" ⇄
  "Show p button everywhere", with an eye / eye-off icon. It reads and writes
  `pp_fab_global_hidden` in `chrome.storage.local` itself, so it works from
  any tab — chrome:// pages, the Web Store, our own harness origin, all of
  which have no content script. Open tabs follow instantly through
  `storage.onChanged`; nothing needs a reload.
- **Fixed: the toggle did nothing.** The old path sent a message to the active
  tab's content script, which rejects wherever no content script is injected
  — so on exactly the pages where you'd reach for the popup, it silently
  failed.
- **Fixed: content.js aborted on every load while the tray was hidden.**
  `updateFabVisibility()` runs during boot and closed the panel
  unconditionally, reaching `stopPoll()` before `let pollTimer` was
  initialized — a TDZ `ReferenceError` that killed the rest of the script
  (message listener, polling, drag) until the flag was cleared. It now only
  closes when the panel is actually open.
- The tray no longer carries a hide button (a control inside the thing it
  hides can never be undone from the page). Right-click per-site hide is
  unchanged; the popup's per-site row now appears only when *this* origin is
  what hid the button.
- Tests: `test/fab-hide-show.test.js` drives the real popup and content
  script in a DOM over a stubbed `chrome.*`, with no content script in the
  tab — the case that used to fail.

### v1.9.9 / ext v0.7.3 — choose which browser the launcher opens
- **ProofPipe.bat now opens the harness in the browser you pick in Settings.**
  "Open harness in" lists every browser the server detects (Chrome, Edge,
  Firefox, Brave, Opera, Vivaldi, Chromium — plus anything registered in the
  Windows "App Paths" registry, so custom installs resolve too); "Default
  browser" is the built-in choice and stays the fallback. The setting
  persists in `settings.json` and live-syncs like the others.
- **The tab opens from the server once it is actually listening.** The .bat
  hands off via `PP_OPEN_BROWSER=1` instead of the old "wait 2s then `start`"
  line — no more landing on a dead page, and a custom `PORT`/HTTPS scheme is
  honored. `npm start` and the test suites never pop a browser.

### v1.9.8 / ext v0.7.3 — full audit: data-loss bugs fixed, server split into 9 modules, lint made real

#### Data loss / correctness (the bugs that lost photos)
- **`newKey()` was called but never defined — every phone capture crashed.**
  The upload-idempotency work minted a dedupe key via `newKey()` in
  `handleFiles`'s synchronous job-building `map`, but no such function existed
  anywhere in the project. Every photo taken on the phone threw a
  ReferenceError *before* the upload and *before* the durable outbox enqueue —
  the tile showed "pending" forever and the photo was lost on reload. Fixed:
  the key generator now exists (UUID-derived, passes the server's
  `^[A-Za-z0-9_-]{8,32}$` gate). The lesson is PITFALLS #37.
- **HEIC/HEIF photos sent via share-target were rejected and permanently
  poisoned.** The server's format map had no `heif` entry, so the 415 + the
  old poison policy permanently dropped the single core use case (phone
  photo → PC) for anyone with "high efficiency" mode on. The server now
  accepts `heif`/`heif_sequence` (stored as `.heic`, PNG thumbnail — browsers
  can't render HEIC), `MEDIA_MIME` serves it correctly, and the phone's
  share-target path re-encodes HEIC→JPEG via canvas when the browser can
  decode it. The prebuilt libvips can decode HEIC but not encode it — fine,
  thumbnails only need decode.
- **415 no longer poisons the outbox; a one-time unpoison migration revives
  old victims.** "Not a supported image" is not always forever (an older
  server build may lack a format a newer one accepts; sharp can fail
  transiently). 413 stays terminal — the file can never fit. New pure
  `PPQueue.unpoison()` runs once per boot across all three queues, reviving
  items stuck at the old poison marker *unless* `poisonReason: 'too-large'`.
  The flush workers now stamp that reason so genuinely-too-large items stay
  dead. (The file-queue worker initially didn't stamp it — the migration
  would have re-uploaded a hopeless 1 GB file from scratch on every boot.)
- **Uploads are idempotent.** The phone mints one dedupe key per capture,
  frozen into the IndexedDB record, and reuses it on every retry. Migration
  v4 adds `captures.dedupe_key` + a partial UNIQUE index; a timed-out upload
  that actually landed is answered with the original row (`duplicate: true`)
  instead of storing a second copy. Non-phone callers are unaffected.
- **Upload timeout is sized to the payload** (30 s–10 min by blob size,
  ~1 MB/s floor) instead of a flat 30 s — a 15 MB photo over slow Wi-Fi
  legitimately takes minutes, and the premature abort + retry used to
  duplicate the capture.
- **The real photo cap is 20 MB now.** `bodyLimit` equalled the multipart
  file cap, so the multipart *framing* pushed a ~19.9 MB photo over the
  body limit — Fastify 413'd the whole request and the phone poisoned a
  perfectly fine capture. `bodyLimit` is 21 MB with 1 MB of headroom.
- **Retention no longer lies when no photos arrive.** The sweep ran only
  when an upload landed or the setting was touched; a quiet gallery kept
  expired captures indefinitely. It now runs at boot and on an hourly
  (unref'd) interval.
- **Media chips can no longer evict texts (or each other).** Both shared one
  20-row text cap, so ~20 "send to phone" chips silently evicted ordinary
  texts — and each other. Migration v5 adds `texts.kind` ('text' | 'media',
  backfilled); media rows trim at 200, ordinary texts keep their cap.
  Listing stays kind-agnostic on purpose (the phone renders both mixed).
- **`outboxBumpTries` double-incremented `tries`.** `PPQueue.onFailure`
  already returns `tries + 1`; the photo flush bumped again. Backoff
  escalated twice as fast and items hit the poison marker in ~500 real
  attempts. The bookkeeping value is now written exactly as the policy
  computed it.
- **Delete-all no longer drops racing auto-paste flags.**
  `DELETE /api/captures` cleared `autoCaptureIds` right after the
  transaction, wiping the flag of an upload landing during the awaited
  file-removal loop — its `capture-ready` event never fired. It now deletes
  exactly the removed ids, after file removal.

#### Memory & viewer
- **Sent tiles release their multi-MB local blob.** `markSent` re-points the
  tile to the server thumbnail (before revoking the old bitmap URL — revoking
  first blanked the tile), drops the blob, and clears `fullUrl`; a long
  session no longer piles up ~100 live blobs on a phone. The viewer falls
  back to the server URL for sent tiles (previously `createObjectURL(null)`
  crashed) and the download button downloads from the server when there is
  no local blob (previously a silent no-op). Old blob URLs are revoked
  instead of leaking.
- **TIFF/HEIC originals get a viewer fallback.** No browser renders them;
  the PC lightbox keeps the derived PNG thumbnail on screen with a caption
  note (download still serves the original), and the phone viewer shows the
  PNG thumb full-size instead of a broken image.

#### Server architecture: server.js 1,676 → 924 lines
- Split into nine focused modules, each owning one subsystem, each receiving
  its state via an injected `ctx` — nothing is cached:
  `server/store.js` (capture pipeline: probe/thumb/storeCapturedParts/
  bootSweep), `server/captures.js` (query/delete routes), `server/files.js`
  (transfer + inbox auto-save), `server/cleanup.js` (caps, retention,
  sweeps, shared deleters), `server/mediadir.js` (relocation, inbox dir,
  folder picker), `server/backup.js` (export), `server/sse.js` (live-push
  hub), `server/ratelimit.js` (token buckets), plus the existing
  `util.js`/`bytes.js` helpers. server.js is now a composition root: boot,
  DB + migrations, statements, HTTP shell, thin routes, wiring.
- **Two invariants are pinned by tests** (`test/config.test.js`):
  sharp stays a *dynamic* import in server.js AFTER the
  `UV_THREADPOOL_SIZE` assignment (a static import in any module would
  re-freeze the libuv pool at 4 — the code runs fine, the parallelism just
  silently dies); and no module may cache a media path — relocation
  reassigns those bindings at runtime, so every module reads `paths()`
  fresh per call.
- **Backup is transactional.** The WAL checkpoint and the DB/WAL/SHM copy
  now happen inside one exclusive better-sqlite3 transaction — an upload
  landing between checkpoint and copy used to live only in the WAL and
  silently miss the backup. The Windows-only gate also moved to the top (it
  used to do all the copy work, then say "Windows only").

#### Tooling (the meta-bug)
- **ESLint's recommended rules had been silently off project-wide.** Every
  config block spread `...js.configs.recommended` and then declared its own
  `rules:` key — a bare `rules:` REPLACES the recommended set instead of
  merging, so only `no-unused-vars` was ever active and `no-undef` was
  decorative. That is how the `newKey` ReferenceError shipped green. Rules
  now merge; cross-script globals (`PPQueue`, `toPng`, `PPDiscovery`,
  `PPPasteLogic`) are declared in the config with the defining files
  exempted; the codebase's `catch {}` idiom is allowed explicitly. The
  fresh `no-undef` + `no-redeclare` + `no-func-assign` pass found and fixed
  a real monkey-patch: `updateEmptyState` was reassigned after definition —
  the transfers-view guard now lives inside the one function.
- The hand-maintained `node --check` file list is gone (`lint` is just
  `eslint .`); `scripts/*.cjs` — the `--require` preload where an unchecked
  edit surfaced only as a boot crash — is covered by the eslint globs.

#### Platform & CI
- `engines: { node: ">=20" }` — the honest floor (Fastify 5 requires 20+;
  declaring 18 would be a lie npm only warns about).
- CI gains a `test-linux` job (lint + audit stay Windows-only). Windows-only
  feature tests skip themselves there via their own guards. First real run
  happens on the next push — it could not be exercised locally (no WSL or
  Docker on the dev machine).
- **Extension v0.7.3**: the hardcoded chat-site list is overridable via
  `chrome.storage.sync` key `pp_chat_sites` (newline/comma-separated host
  suffixes, live-reloaded) — adding a company-internal chat host no longer
  requires shipping an extension update.
- The asset-stamp cache is keyed by `mtimeMs:size` — an edited file
  invalidates itself; only the first request after a change pays for the
  read + SHA-1 (was: sync read + hash on every `/` and `/phone` hit).

### v1.9.7 — hygiene pass: real linting, content-hashed harness assets, observability, discovery on demand

#### Correctness
- **UV_THREADPOOL_SIZE actually works now.** The `16` was set in the module
  body, but `sharp` and `better-sqlite3` are native and grab the libuv threadpool
  on load — and ESM static imports hoist, so the pool was already frozen at the
  default of 4 by the time that line ran. Both modules are now imported
  dynamically *after* the env var is set, and `npm start` preloads
  `scripts/threadpool.cjs` (the .bat already exported the variable before
  `node`). There is no `--threadpool-size` CLI flag — that proposal was never
  merged, and passing one exits with "bad option".
- **Multi-image share failures no longer leave half a batch behind.** If part 3
  of 5 failed, parts 1–2 were already committed (file on disk + DB row) while the
  phone saw "error" and resent the whole batch — duplicate captures. The share
  route now rolls back every capture it committed before the failure.
- **`/api/stats` byte counters can no longer drift silently.** `bytesTotal` /
  `bytesTotalFiles` were module globals mutated ad hoc (`+= size`, `-= cap.bytes`,
  bare reassigns) that only reconciled at boot. All mutations now go through
  `server/bytes.js`, and a periodic re-sync from the DB self-heals any residual
  drift mid-run instead of waiting for a reboot.
- **Dead code swept (10 findings from the new linter)** — unused
  `HOST_TPLS` (background), `hostIdx` (offscreen), `mediaType` (harness),
  `backoffMs` + `viewerNav` (phone), an unused `id` destructure (backup test),
  and two unused util imports in server.js. `toPng`'s exposure to late-loaded
  scripts is now explicit (`window.toPng`) instead of relying on the implicit
  global-lexical-binding side effect.

#### Tooling
- **`npm run lint` is a real lint now.** It was `node --check` — a *parse*, which
  cannot see unused variables, undefined references, or duplicate keys: exactly
  the bug classes PITFALLS.md catalogs. ESLint (flat config, `eslint.config.js`)
  runs after the syntax check, configured per surface (Node ESM / browser / MV3
  extension globals), and the run surfaced and fixed 10 real findings on day one.
- **Dependency audit is a CI gate.** `npm audit --omit=dev` runs in the test job
  (currently 0 vulnerabilities) plus a non-blocking weekly `audit` job for early
  visibility. `.github/dependabot.yml` added for weekly production-dep bumps and
  monthly Actions bumps (caret ranges kept — Dependabot PRs are reviewable bumps,
  not silent drift).
- **Harness assets are content-hashed like the phone's.** `/app.js?v=` and
  `/style.css?v=` now carry a 10-char sha1 (`assetStamp`) instead of the release
  version, so an asset change revs its own URL and clients fetch the fresh copy —
  no more relying on remembering to bump the version (PITFALLS #24/#25, which had
  already caused silent stale-UI bugs). The harness `meta[name=app-version]` still
  carries the release version for the update banner.

#### Server
- **`server.js` is smaller and its state is explicit.** Pure helpers
  (`sanitizeDisplayName`, `storedExtFor`, `fileServeHeaders`, `mediaContentType`,
  `mediaDirs`, `lanIPs`) moved to `server/util.js`; the `/api/stats` counters to
  `server/bytes.js`. Settings gained a `version` field so a future settings
  migration can be versioned like the SQL one (`PRAGMA user_version`).
- **Structured event log.** Evictions (auto-cleanup / retention / file cap),
  rate-limit refusals, and SSE evictions now emit one parseable JSON line to
  stderr (`logEvent`) — PITFALLS #2 was literally about debugging with empty
  traces. Per-request logging is unchanged and still quiet by default.
- **`csrfSafe` validates the extension-id shape.** A `chrome-extension://`
  origin must now be a real 32-char `a–p` id, so a malformed or spoofed scheme
  string can't pass the mutation gate.

#### Extension (0.7.2)
- **Broad port discovery is on-demand, not automatic.** Automatic fetches
  (`serverFetch` / `prefetchBlob`) re-verify the pinned origin and, failing that,
  probe only the cheap stage-1 candidates (pinned / manual / default port). The
  full 4-template × ~27-port matrix now runs only on an explicit "Sync now" or a
  port-override save — a cold start can no longer fire ~100 speculative requests
  that look like a LAN scan.

### v1.9.2 — phone UI audit pass
- **Upload filenames match the real image format** — `upload()` hardcoded `capture.jpg`, so PNG screenshots and HEIC photos were named (and server-stored) as `.jpg` despite the byte-for-byte original-format guarantee. The multipart filename is now derived from the blob's MIME type.
- **Auto-paste intent is captured at capture time** — `upload()` read the *live* toggle at flush time, so a photo queued offline could paste (or not) based on whatever the toggle said minutes later. The outbox record now freezes `auto` when the capture is made; the flush worker, manual retry, and offline reload all carry the stored intent.
- **Reconnecting is amber, not red** — SSE drops flipped the status dot to the offline red; `.dot.warn` (the DESIGN.md reconnecting token) now exists on the phone and is used for `reconnecting…`. Red stays reserved for confirmed-offline.
- **Emoji glyphs replaced with Lucide mask icons** — 📦/✉/⬆/📄/🖥 chips and rows now use `.ic-package`/`.ic-mail`/`.ic-upload`/`.ic-file`/`.ic-pc` (three new Lucide SVGs, precached in the service worker), per the icon-system rule in DESIGN.md / COMPONENTS.md.
- **Android Back closes overlays** — viewer, file sheet, and the More menu each push a guard history entry while open; Back closes the topmost layer instead of exiting the PWA. Closing through the UI consumes the guard so the next Back exits normally.
- **Dialog semantics + focus management** — `#viewer` and `#file-sheet` are `role="dialog" aria-modal="true"`; focus moves to the close button on open and returns to the trigger on close; the More menu returns focus to its button on Esc.
- **Queue counters are announced** — `#text-queued`, `#file-queued`, and the outbox chip carry `aria-live="polite"`.
- **Contrast fixes** — the failed tile's "tap to retry" label went from 9px white-on-red (~3.2:1) to 10.5px `#fca5a5` on the page-bg token (AA); PC chip badges bumped 9/9.5px → 10.5px.
- **Dead code swept** — retired pull-to-refresh remnants (element, `#pull-indicator` CSS + keyframes, `.pull-hint` rules, the JS display:none), the unused `.brand` rules and shadowed base `h1` rule, and the never-read `fileProgressUI`/`fileSeq`. The stale "opens UPWARD from the bottom" More-menu comment now matches the downward-opening header menu.
- **File uploads get a 5-minute XHR timeout** — `xhr.ontimeout` existed but `timeout` was never set, so a stalled transfer could hang its progress row forever.
- Text-chip history cap (10 rows, 5 shown) documented as intentional: the strip is recent traffic, not an archive.

### Fixed (phone)
- **Viewer zoom/pan was sluggish** — the image's `.18s` transform transition chased every `touchmove` (pinch and pan never toggled `.gesturing`, which disables the transition), so the image rubber-banded behind the finger. Transitions now turn off for the whole gesture and back on for snap-back/double-tap zoom.
- **Swipe navigation fought the user** — a zoomed pan was unclamped, so the image could be dragged fully off-screen and stay there. Pans (and pinches, and double-tap zoom) now clamp to the stage box: at any zoom the image can never leave the viewport.
- **The expand-text button did nothing after the first sent text** — `sendText()` set an inline `style.height = 'auto'` on the textarea, which permanently outranked the `.expanded { height:180px }` class. The inline height is now cleared on toggle (and no longer forced on send, so an expanded drafting box stays expanded).
- **Toasts moved to the top of the screen** — at the bottom they sat over the viewer action bar (Download/Retry/Discard/Delete) and blocked taps. Top placement uses the safe-area inset, and toasts are now `pointer-events:none` so they can never intercept a tap (e.g. the viewer ✕).

### Extension (0.7.0)
- **One port-discovery source for all four contexts.** The candidate list lived as four private copies (background, popup, offscreen, content) that had already drifted — one context found the server, another didn't. `extension/discovery.js` is now the single source: manual override → last known good → 8787 → bounded 8780–8800 scan → legacy extras (8080/3000/5000).
- **Discovery is parallel, not serial.** Up to 12 ports × 4 host templates × 1.5s timeout ≈ 70s worst case of blind guessing; now `Promise.any` over all candidates — the answer arrives in ~one timeout wherever it sits in the list.
- **Manual port override in the popup.** A "Server port" field, persisted as `pp_port` and probed first on every discovery, with immediate found/no-answer feedback — the honest fix for `PORT=9999`, which the bounded scan could never cover.
- **Paste-decision logic extracted and unit-tested** (`extension/paste-logic.js`): self-paste refusal (now also covering the pinned-port-on-LAN-IP form), filename/mime normalization, PNG-retry gate, and the insert-detection snapshot from the 4×-paste saga (PITFALLS #6). `content.js` delegates; the async layer stays local. New `test/extension-logic.test.js`: 11 unit tests through `node:vm` with a minimal fake DOM.

### Fixed
- **Server error logs were silently swallowed.** `Fastify({ logger: false })` made every `req.log.error(e)` a no-op — store failures, move rollbacks, and file-write errors left no trace anywhere. The built-in logger now emits at error level to stderr (one JSON line); `PP_LOG=1` additionally logs every request line (the quiet default still logs only `/upload`, `/share`, `/api/files`, and DELETEs — `/share` added to that set).
- **Phone offline queue policy extracted** to `public/queue.js` (pure, testable) — the retry rules for all three offline queues (photo outbox, text queue, file queue) existed as three drifted inline copies. `phone.js` delegates to it; new `test/queue.test.js` covers enqueue/dedupe/caps/backoff/poison/flush-order through `node:vm`. Behavior is unchanged — the policy is now single-sourced and covered.

## v1.9.0 — image share-target, service-worker rework, multi-phone stats, backup/export, hygiene pass

### Added
- **Android "Share → ProofPipe" now accepts images** (v1.8 share-target was text-only): the PWA manifest registers a POST multipart target at `/share`; shared photos are stored through the exact `/upload` pipeline (stream-to-disk, pixel-cap probe, byte-for-byte originals, background thumbs, SSE, rate limit, CSRF) as `origin: phone` captures — auto-paste applies when the toggle is on — and the server 303s back to `/phone?shared=1` (or `?shared=error`). Shared text/links land as phone→PC texts. The legacy GET text-share is kept for stale cached manifests.
- `test/regression.test.js`: share-target tests — image share stores a phone capture + text and 303s to the phone; text-only share adds no capture; cross-site `/share` POST is refused.
- **Multiple phones tracked**: `/api/lan?device=phone` polls now register into a per-IP phone registry (bounded at 10 slots, entries forgotten after 45 days silent) instead of one scalar slot that let a second phone — or the same phone after a hotspot IP change — silently overwrite the first. `/api/stats` keeps the top-level `phoneLastSeen`/`phoneOutbox`/`phoneIp` fields (now describing the most recently seen phone) and adds `phoneCount` + a `phones: [{ip, lastSeen, outbox}]` array; `phoneOutbox` sums queued photos across all phones. The harness stats box lists each phone (newest first, `(latest)` badge) when more than one is known; single-phone display is unchanged.
- **Backup/export** (`POST /api/backup` + "Backup now" in the harness sidebar): pick a folder via the existing OS picker — the server checkpoints the SQLite WAL, stages DB + settings + captures/files/inbox into a temp dir on the destination drive, and zips it with PowerShell `Compress-Archive` into `proofpipe-backup-YYYYMMDD-HHMMSS.zip` (no new npm deps). Loopback-only and CSRF-checked like the folder picker; single-flight guarded; destination must exist and be writable (empty/relative/typo'd paths are refused — an empty dir used to silently resolve to the server CWD, caught by its own test); staging is always cleaned up and half-written zips removed. New `test/backup.test.js` suite (disjoint port range 9400–49) verifies the zip signature, contents (DB, capture original + thumb via Expand-Archive), staging cleanup, 400/403 handling.

### Changed
- **Service worker reworked** (`public/sw.js`): caches under canonical query-stripped keys (a new `?v=` hash overwrites the same entry — no more manual `proofpipe-vNN` bumps; `v34` is the last name change, shedding v33's accumulated per-URL entries) and serves **network-first** with the cache as offline fallback only — a cached-first policy would have served old bytes for new versioned URLs (the stale-shell bug class from PITFALLS #25). The shell is now phone-only: drops ~115KB of harness assets (`/`, `app.js`, `style.css`, raw `phone.html` with its literal `__PP_VERSION__` placeholders) that the phone precached but could never render, and precaches exactly the 12 icons the phone renders.
- **Version single-sourced**: `server.js` derives `PP_VERSION` from `package.json` at boot (was a second hardcoded string); the smoke test asserts against `package.json` too. CONVENTIONS.md documents the bump policy (harness asset changes still require a bump — PITFALLS #24/#25; phone assets are content-hashed and don't).
- `public/toPng.js` and `extension/toPng.js` unified byte-identical (both must physically exist — the extension can only load its own packaged copy) with a new `test/dup.test.js` that fails the build on drift.
- `.gitignore` cleaned of dead entries (`proofpipe-native/…` dirs that don't exist, redundant `out.log`); stale `data/server.log` removed.

## v1.8.8 — grid density row sizing + phone horizontal overflow

### Fixed
- **Medium/Large grid tiles shrank vertically and clipped the thumbnail** (and with it the origin badge and time stats, which only stayed visible on the Small option). `overflow: hidden` on the grid ITEM made Chrome size auto rows to an equal share of the grid instead of the tile content whenever the content exceeded the visible height — rows collapsed below the square thumbnail, cropping the photo into a band and cutting off the meta row. The tile no longer clips (rounded top corners now live on `.thumb`, skeletons round `.skel-img`), so every density keeps content-sized rows and the badge + time row stay visible at every size.
- **Phone page had a tiny horizontal scroll.** The header ⋮ button's negative margin pulled its box 6px past the right edge of the viewport, widening the page by 6px. The pull now ends exactly at the viewport edge, so the page is no wider than the screen and only scrolls vertically.

## v1.8.7 — audit fixes: PC→phone chips, PC-origin auto-paste, harness grid/viewer polish

### Fixed
- **PC→phone image chips could not be opened on the phone** ("Loading…" then "Load failed"). The chip's thumbnail always loaded from the phone's own origin but tapping opened the ABSOLUTE URL the PC froze into the text row at send time (a host the phone can't always reach — multi-NIC / stale sends). Chips now resolve the full-res image from `location.origin`, exactly like the Recent-captures tiles.
- **Chips pointed at deleted captures 404'd forever.** Deleting a capture (single, bulk, or auto-cleanup) now purges the text rows that reference its media file, so the phone chip disappears instead of failing on every tap. A straggler chip (offline gap) is dropped with a "deleted on the PC" message instead of a misleading connection error.
- **PC-added captures re-pasted into the last chat when Auto-paste was on.** Auto-paste now only ever applies to PHONE-origin uploads — an image added on the PC itself is never re-pasted into a chat tab (matches the phone-side toggle's meaning and the harness auto-copy rule).
- **Bulk-delete undo downloaded every selected image at once.** The undo-blob fetch and the DELETE now run in small bounded batches, so a 50-image selection can't fire 50 concurrent multi-MB downloads (memory/bandwidth).
- **PC-sent texts stayed invisible during an SSE outage.** The reconnect tick now refreshes text/chip rows too, not just captures and files.
- **Fresh server boot logged a migration warning** (`migration v2: add origin: no such table: captures`) — the capture-table ALTERs now guard on the table's existence so new installs boot clean.
- `/api/files` ended with the `reply.send(); return reply;` pattern that PITFALLS #10 (and this file's own `/`, `/upload` comments) says can emit an empty compressed body — now a single `return reply.send(row)`.
- `extension/offscreen.js` added to `npm run lint` (every other extension entry point was checked).

### Changed (harness UI)
- **Thumbnail density S/M/L now keep square, distortion-free tiles** — the image was pinned at 110px tall while the tile widened to 210–250px (photos cropped into bands on M and L). Thumbnails scale with the density toggle (`aspect-ratio: 1/1`, cover crop).
- **Phone/PC origin badge is always visible** — moved from a tiny meta-row icon to a colored pill on the thumbnail (bottom-left), readable at every density.
- **Lightbox shows the full image, not a reduced one** — the original is contain-fit to the stage (small images enlarge to fill, large ones shrink to fit, no crop); wheel zoom still reveals actual pixels.
- **Lightbox action bar polished** — floating translucent pill, flat ghost buttons, Delete separated as the far-right danger action, caption + zoom hint read in the middle; caption ellipsizes on narrow windows.
- **Merge (Show all) no longer compresses the captures** — the grid keeps the flexible space at full tile size; the transfers list scrolls within at most 45% and its empty state collapses instead of squatting on half the column.

### Also in this release (phone viewer & header polish)
- **More options moved into the header** — the ⋮ icon button now sits centered between the status pill and the wordmark (44px tap target, Lucide `more-vertical.svg` added and precached, SW cache v31). The menu opens downward from the button instead of upward from the page bottom.
- **Per-capture Delete in the viewer** — a Delete button (danger-tinted, trash icon) appears for every server-backed capture. Confirm → `DELETE /api/captures/:id` → the tile leaves the strip and the viewer advances to the neighbor (or closes when it was the last). Unsent photos keep Retry/Discard; PC-sent chips (text-table rows, no capture id) intentionally have no Delete.
- **Viewer feels like a gallery** — swiping now renders the INCOMING neighbor in a second layer underneath the current image and both track the finger 1:1 (two-layer push); the commit slide animates via `transitionend` (with a reduced-motion fallback) instead of the old `setTimeout` teleport. Flicks are measured over the trailing ~90ms of movement (a lifetime average misjudged drag-then-flick), flicks must match the drag direction, and swiping past the ends of the list rubber-bands (0.35×) and springs back. Double-tap toggles 2.5× zoom centered on the tap point.

## v1.8.6 / ext v0.6.3 — phone layout density pass

### Changed
- **No dead zones**: status pill · More options · wordmark now share ONE header bar (the More menu drops down anchored to it); Auto-paste is a compact pill beside "Open on PC" in a shared actions row.
- **Thin text bar**: one-line "send text to PC…" field (40px) with a chevron expand toggle for drafting long text (up to 180px; Enter sends while collapsed, newline while expanded). The keyboard-mode swap hides the expand toggle and stretches the field.
- **Fixed: capture tiles squashed together** — the aspect-true `object-fit:contain` rework from v1.8.4 made variable-height tiles overlap inside the fixed-aspect badges; reverted to the proven square `object-fit:cover` tiles (previews are crops again; the viewer still shows the full image).
- Version stamp moved so phones pick up the new files (SW cache v27); `chevron-up.svg` icon added and precached.
- **Fixed: one-reload layout corruption (SW cache v28).** The service worker served navigations stale-while-revalidate, so after a layout change the phone could render the OLD HTML against freshly-fetched version-stamped CSS/JS — mismatched classes shredded the page until a second reload. Navigations are now network-first with the cache only as the offline fallback. Header pill also stops wrapping to two lines (ellipsizes instead).

## v1.8.5 / ext v0.6.3 — phone connection hotfix

### Fixed
- **Phone stuck on "connecting…" / PC shows "phone not connected"**: the polish pass removed the viewer copy-hint from the HTML but left its JS handler; `$('#viewer-copy-hint-x').onclick` on a null element threw at script load and every connection path below it (SSE, `checkServer`, boot, poll loop) never ran. The stale handler is deleted; an id audit confirms nothing else references a missing element.
- **Lesson re-learned (PITFALLS v1.8.2)**: the first hotfix shipped WITHOUT a version bump, so the phone kept the broken `phone.js?v=v1.8.4` from its 24h shell cache — same URL, same stale bytes. This bump makes the fixed script a never-cached URL. Rule confirmed: ANY client file change moves the version stamp in the same commit.

## v1.8.4 / ext v0.6.3 — reliable phone capture history and touch behavior

### Fixed
- **Phone swipe reloads:** removed document-level pull-to-refresh interception that hijacked ordinary downward swipes and could reload the PWA while browsing controls or captures. Live synchronization remains automatic through SSE, reconnect, visibility, and polling fallback.
- **Phone capture history:** server-backed captures now restore on phone startup and reconnect, while queued original blobs remain visible from IndexedDB until they sync. The phone uses existing server thumbnails for history and fetches full-resolution originals only when opened.
- **Capture presentation:** recent captures now have a labeled section, count, preserved aspect-ratio previews, a 100-item phone-side history window, and keyboard-accessible tile semantics.
- **Viewer gestures rebuilt (axis-locked):** the first ~10px of movement lock the gesture to horizontal or vertical for the life of the touch — diagonal jitter and vertical swipes can no longer trigger accidental navigation; zoomed pan and unzoomed swipe are decided by zoom level. Pan/swipe transform state is no longer read back from the live transform.
- **Viewer swipe affordance:** a one-time "swipe for next capture" hint appears until the first successful swipe (or when the viewer has fewer than two captures).
- **Clearer capture naming:** the phone's image picker is now labeled "Choose photos" (it opens the phone's photo picker); "Gallery" read as if it would browse ProofPipe's own capture history, which lives in the Recent captures strip below.
- **Accessibility:** added visible focus treatment and labels for key phone controls and capture tiles.
- **Keyboard mode:** when the soft keyboard opens (visualViewport shrink), the capture grid, action rows and chip strips step aside and the text area takes the freed space — no more crushed capture grid or hidden input while typing. Everything returns the moment the keyboard closes.
- **Layout resilience:** narrow phones (≤360px) wrap the header instead of clipping the status pill; short landscape screens tighten the text row and switch rows.
- **CSS dedup:** the duplicated `.ic` icon block, `.text-row`/`#text-input`/`#text-send` definitions and the double `.text-chip` styling were consolidated into single sources of truth (one 17px icon size for the whole surface).
- **Fixed: phone stuck on "connecting…" after the polish pass.** Removing the viewer's copy hint from the HTML left its JS dismiss handler behind; the `$('#viewer-copy-hint-x')` lookup returned null and the TypeError aborted `phone.js` at load — everything below that line (SSE, checkServer, boot, poll loop) never ran. The stale handler is removed, an id audit confirms no other JS references a missing element, and the SW cache is bumped to v26.
- **Polish pass (device feedback):** button faces are a single flex line (the icon no longer stacks above the label or leaves a phantom gap beside "File"); "Open on PC" is a compact secondary action; the text bar is shorter with a 44px send button whose icon is white; the "Recent captures" heading has breathing room from the count; the viewer's Copy button is removed (Download remains; copy stays on the PC side); gallery-style swipe — the image tracks the finger 1:1 and navigation commits past 25% width or a fast flick, sliding the neighbor in from the same edge. `phone.css` is now version-stamped and the SW cache bumped to v25 so installed PWAs pick up the new styles.

### Performance / quality
- Original uploads remain byte-for-byte unchanged; queued uploads continue using the original blobs. Thumbnail-only history rendering avoids downloading full-resolution images during startup.

## v1.8.3 / ext v0.6.3 — instant grid paint + debug-code removal

### Fixed
- **Grid paint delay** (regression from the v1.8.2 perf pass): tiles were
  added on `capture-ready` — before the thumbnail existed — and only painted
  after an onerror retry hit. The two SSE events are now SCOPED instead of
  merged: `capture-ready` fires only for auto captures (extension paste
  path, needs the pre-thumb original), `capture` fires for all captures
  once the thumbnail is on disk (the grid's paint signal — tiles appear
  fully rendered, instantly).
- Removed the tile onerror retry loop (no longer a paint mechanism).

### Extension (0.6.3)
- Removed all debug/trace machinery: `pp_trace` ring-buffer writers from
  background/offscreen/content, `getTrace`/`clearTrace` message handlers,
  and the popup's pipeline-trace box + copy button. Behavior is unchanged;
  the popup's user-facing status (undelivered count, per-site paste-fail
  hint) stays.

### Internal
- Shell script URLs are version-stamped (`/app.js?v=v1.8.3`); `/phone`
  injects the version too (replaceAll — see PITFALLS #26).
- Test port ranges made disjoint per suite.

## v1.8.2 / ext v0.6.2 — performance pass + auto-paste pipeline fixes

### Live-update fix (stale-tab freeze)
- **Shell JS is now version-stamped** (`/app.js?v=<version>`, same for
  phone.js): the shell's 24h `must-revalidate` cache kept serving OLD app.js
  across F5s (refresh revalidates only the HTML document, not subresources),
  so a tab could ignore new SSE events forever — grid frozen until a hard
  reload, with no update banner (HTML meta matched the server even though
  the JS was stale). A versioned URL is never cached, so ANY reload now
  lands matching JS. `/phone` also injects `__PP_VERSION__` now (global
  replace — the first occurrence only, which silently left the second
  placeholder in the HTML).
- Harness: an UNKNOWN SSE event type re-arms the version check — future
  contract changes surface the update banner instead of a silent freeze.
- Tests: port ranges made disjoint per suite (smoke was randomized into
  regression/ratelimit ranges — cross-suite port collisions produced flaky
  shared-state failures); new regression test locks the version-stamp contract.

### Performance (quality-neutral — originals stay byte-for-byte)

### Performance (quality-neutral — originals stay byte-for-byte)
- **Server**: `/upload` streams multipart straight to disk (no `toBuffer`
  heap copy → less GC jank during bursts); the image probe and thumbnail
  encode read from the stored file instead of a JS Buffer. Thumbnails encode
  ~2–4x faster (sharp effort 6→2, progressive JPEG, `fastShrinkOnLoad`) —
  grid copies only, originals untouched. `/media` + `/file` streams use
  256 KB readahead (was 64 KB). Static shell gets `must-revalidate`
  caching; gzip via `@fastify/compress` for text/JSON (registered BEFORE
  `@fastify/static`, whose streamed routes otherwise bypass the hooks).
  `UV_THREADPOOL_SIZE` 8→16; boot sweep uses `withFileTypes`.
- **Fixed en route**: `return reply` after `reply.send()` double-resolves the
  route and, under `@fastify/compress`, emits an EMPTY body — `/` and
  `/upload` restructured to a single send. Tests caught it (37/37 green).
- **Clients**: lightbox decodes the full-res image before the crossfade
  (no half-decoded frame); stats ride SSE events instead of a blind 15 s
  poll; the phone's transfers list is version-gated (`/api/files/version`);
  `fetchPriority: high` on the first viewport of grid thumbs; per-row
  `timeAgo`/`fullTime` memoization; SW cache bumped v19→v20.

### Auto-paste: fixed end-to-end (ext 0.6.1–0.6.2)
The phone → PC → chat pipeline died or duplicated silently at three stages;
all fixed and now observable via the popup's pipeline trace:
- **Media fetch through the SW** (`mediaBlob`): direct loopback fetches from
  public https pages are blocked by Chrome's Local Network Access — and the
  clipboard fallback needs focus, which auto-paste doesn't have. The
  background worker's fetches carry `host_permissions`; the Blob travels the
  message channel as-is (no base64).
- **Durable tab routing**: the last-focused chat tab persists in
  `chrome.storage.session` across MV3 service-worker idle restarts; the
  fallback prefers known chat sites over whatever tab happens to be active.
- **Relay watchdog** (1/min alarm): the offscreen SSE document is verified
  alive AND connected; a dead relay is rebuilt automatically. Its lifecycle
  (and every createDocument failure) is now traced — an empty trace used to
  mean "stage 0 died invisibly".
- **Paste staging + universal verification**: non-bubbling dispatch first,
  verified; bubbling only on a real rejection. Success is detected via
  `preventDefault` (`dispatchEvent() === false`) plus document-wide signals
  (unique filename incl. shadow DOM, editor length, img/canvas/blob: counts,
  `input` event) — fixes the 2x and 4x duplicate pastes on DeepSeek and
  other chat sites whose editors render chips/canvas instead of `<img>`.
  One PNG re-encode retry for PNG-only editors; captures that can neither
  paste nor copy queue and auto-copy on the next tab focus (popup shows the
  waiting count).

## v1.8.1 / ext v0.6.0 — audit fixes + extension port discovery

- **Fixed: SSE handler crash** on payload-less events (`delete-all` sends no
  payload); the full-refresh fallback branch is reachable again.
- **CSRF guard blocks DNS-rebinding**: `csrfSafe` now validates the `Host`
  header against loopback + the server's real LAN IPs — a rebinding page
  (evil.com → LAN IP, Origin === Host) can no longer pass the origin check
  and wipe captures cross-site. Regression test included.
- **Extension discovers the server port** (no more hardcoded 8787):
  `host_permissions` widened to portless loopback patterns; background,
  offscreen relay, popup and tray probe candidates and pin the origin that
  answers `/api/version` as ProofPipe (foreign apps rejected); the pin
  persists in `chrome.storage.local` across SW suspends and restarts.
  `PORT=<anything> npm start` now works end-to-end with the extension.
- **PC image uploads retry 429s** with backoff (≤5 tries) — large
  drag-drops no longer report the burst-cap tail as "failed".
- **Phone: file-queue count gets its own indicator** (`#file-queued`) —
  it no longer overwrites the text-queue chip; hides when drained.
- **Inbox auto-save dedup race closed**: `COPYFILE_EXCL` + suffix retry —
  two same-named phone files landing together can't overwrite each other.
- **QR cache never retains a rejected promise** (no poisoned 500 loops).
- **Boot sweep stats read chunked (64)** — a 5,000-file gallery no longer
  fires thousands of parallel stats at boot.
- **Settings persistence failures are logged** instead of swallowed.
- **Auto-copy retries once on window focus** (clipboard needs a focused
  document — captures that landed while backgrounded now land on copy).
- **Docs**: README v1.8 + new Configuration table; `npm test` globs
  `test/*.test.js`; relocation test updated for the intentional rmdir of
  emptied source dirs. UX_SWEEP.md removed (executed one-off plan).

## v1.8 / ext v0.5.0 — instant file transfer, auto-paste, UX sweep

- **Any file type, both directions**: `POST /api/files` streams uploads
  straight to `data/files/` (never buffered — memory stays flat for 1 GB
  files); 1 GB per-file cap (`PP_MAX_FILE_MB` override), own rate bucket
  and own 2000 MB store cap (`PP_MAX_FILES_MB`) so transfers never evict
  photo history or trip the photo limiter. Served back via `GET /file/:id`
  with Range/206 support, immutable caching, and forced-safe disposition
  (inline for media/PDF only — everything else downloads as an attachment,
  so no stored HTML ever renders on the LAN origin).
- **PC harness Transfers tab** (next to Captures, remembered) + "Show all"
  merge filter; "＋ File" button and smarter drag&drop (images → Captures,
  everything else → Transfers); XHR upload progress bars; SSE `file` /
  `file-deleted` events update both sides instantly without refetching.
- **Phone "File" button** beside Gallery with the same offline outbox
  pattern (IndexedDB queue, backoff flush, per-file progress); PC-sent
  files arrive as chips with Save / Open actions.
- **Inbox auto-save** (default ON): phone files are copied straight into
  `data/inbox/` — a real folder, zero clicks. Sidebar toggle on the PC,
  synced live with the phone via the SSE `settings` push.

### Hardening + UI/UX pass, PC→phone fix, auto-cleanup

- **Fixed: PC → phone image send was completely broken.** The chip link was
  built from the phone's own IP (the server reports `req.ip` as "phoneIp"),
  so the phone was asked to fetch the image from itself. Links now use the
  server's real LAN IPs, preferring the NIC on the phone's subnet.
- **Auto-cleanup at 80% storage** (off by default): when enabled, uploads
  pushing storage past 80% of the cap (500 MB, `PP_MAX_STORE_MB` override)
  delete the OLDEST captures until back under the threshold. Toggled from
  the PC sidebar or the phone's More menu; both stay in sync live via a
  new SSE `settings` event, and the flag survives restarts.
- **Phone capture cleanup**: More options now offers "Clear recent
  captures", "Clear PC-sent captures" (also wipes their server-side rows
  via the new origin-checked `DELETE /api/text`), and "Clear queued
  photos" — in addition to tapping the 📦 outbox chip.
- **Auto-paste hardening (ext)**: the harness itself is excluded from
  paste targets and from its own paste filter (no more self-feeding
  duplicate-capture loop); the server emits an instant `capture-ready`
  SSE event (original, no thumbnail wait) with relay-side dedupe so each
  capture pastes exactly once; uploads pasting into the harness are
  ignored; the extension tray no longer injects its floating "p" button
  on the harness. The popup has a pipeline trace box for debugging.
- **UI/UX pass, PC**: side card fits the viewport without an inner
  scrollbar (QR scales, compacted spacing, collapsible keyboard hints);
  the QR defaults to a real LAN IP — localhost is demoted and labeled
  unusable; "Delete all" is separated from "Select"; the toolbar shows
  capture count + total size; empty state is centered; text chips are
  RTL-safe (`unicode-bidi: plaintext`); the Live pill turns amber
  ("reconnecting…") while SSE is down; the NEW badge moved top-right.
- **UI/UX pass, phone**: one-line header (Capture sits in the thumb zone);
  auto-paste is a real switch row; the chip strip got edge fades and
  taller tap targets; failed tiles show a red "tap to retry" strip; the
  pull-to-refresh hint text is gone; a one-time PWA install nudge
  appears; the keyboard no longer covers the input.
- **ProofPipe.bat**: titled visible console that pauses on every exit
  path (no more vanishing window); the browser opens only after the
  server is listening. When the port is busy it says so and waits.
- **Fixed**: server DELETEs are origin-checked (CSRF guard); the boot
  orphan sweep no longer delays startup (grace window + post-listen);
  rate-limit buckets only sweep dead entries; toPng terminates a wedged
  worker instead of leaking it; TIFF originals get PNG thumbnails;
  phone chip thumbnails retry while the background thumbnail derives.
- **Security note update**: the DELETE guard stops *cross-site* browser
  requests, not direct LAN access — the no-auth model is unchanged.
### Auto-paste (ext v0.5.0)

- **Phone-side auto-paste toggle.** Flip "Auto-paste into chat: ON" on the
  phone and every new capture is pasted straight into the chat tab the user
  last had focused on the PC — no tray, no drag, no keystroke. Toggle off
  (or just don't flip it) and the old drag/copy workflow is untouched.
- **Server** (`/api/autopaste` GET/POST): the mode persists in
  `data/settings.json` across restarts; uploads carry an `auto` form field
  (falling back to the server-side mode) and their SSE capture events are
  tagged `"auto": true`.
- **Extension**: an offscreen document holds a live SSE connection to the
  server (MV3 service workers can't) and relays capture events to the
  background worker, which tracks the last-focused web tab
  (`tabs.onActivated` / `windows.onFocusChanged`, internal pages excluded).
  The capture is delivered as a synthetic `paste` event carrying a real
  File in a DataTransfer — works even when Chrome isn't the foreground app.
  Success is verified by diffing the target's content; sites that reject
  untrusted paste events fall back to clipboard + toast, remembered per
  site (`pp_paste_fail`) so the fallback is instant next time. When no
  valid tab exists, the toolbar icon badges "1" as a nudge.
- **Fixed**: `background.js` was missing from the manifest — the context
  menu and all service-worker fetches silently never ran. Now registered.
- New permissions: `offscreen` (SSE relay), `tabs` (last-tab tracking).

### Performance pass #2

- **Upload ack no longer waits for the thumbnail.** The phone gets "done" as
  soon as the original + DB row land; the grid thumbnail derives in the
  background and the SSE push fires once it exists (never a broken tile). The
  boot sweep regenerates thumbnails missing on disk (crash-window self-heal).
- **Keep-alive raised to 65s** (default was 5s < the phone's 10s poll): every
  poll/upload no longer pays a fresh TCP(+TLS) handshake.
- **SSE reload debounce 150ms → 50ms** — captures land on the grid ~100ms sooner.
- **Parallel uploads** — PC drag/drop/paste sends 3 concurrently, phone gallery
  2; multi-capture batches land ~2–3× faster.
- **Phone viewer gestures fixed**: the 120ms transform transition no longer
  re-fights every touchmove (no more rubber-band pinch); snap-back animates
  only after the fingers lift.
- **Phone recent tiles render from small bitmaps** (createImageBitmap resize)
  instead of decoding full 12MP originals for 84px tiles — the original blob
  stays untouched for upload/viewer/copy.
- **Queues flush immediately** on `online` / `visibilitychange` (previously up
  to 10s wait for the next tick).
- **Harness grid**: tile selection toggles one DOM node instead of rebuilding
  the whole grid per Ctrl+click; arrow-key nav caches cells/columns (no
  per-keypress DOM scan + layout read); `decoding="async"` on thumbnails;
  `content-visibility: auto` skips painting off-screen tiles.
- **Lightbox**: pan/zoom caches the untransformed image size — no forced
  layout per pointer/wheel event; wheel zoom is delta-proportional (smooth on
  trackpads); preload widened to ±2 neighbors.
- **Copy never freezes the page**: toPng encodes on a Worker (OffscreenCanvas)
  with an automatic main-thread fallback (MV3 pages block blob: workers); the
  last PNG per capture is cached for instant re-copy (harness + extension).
- **Copy clamp raised 4096 → 8192px** — every real phone photo (12–48MP) pastes
  at full 1:1; the clamp only guards memory on extreme shots.
- **Extension popup**: thumbnails stream in as object URLs (no base64 dataURL
  detour, no FileReader), lazy-loaded — popup opens much faster with many
  captures.
- **Server internals**: SQLite `synchronous = NORMAL` (WAL-recommended, fewer
  fsyncs), `os.networkInterfaces()` cached 3s, served `index.html` cached at
  boot, bulk deletes use async fs, `UV_THREADPOOL_SIZE=8` (server + .bat),
  upload rate limit 10 → 30 burst (multi-select gallery picks no longer 429).
- Tests updated for the async thumbnail (poll) + new rate limit; 19 passing.

### Audit fixes (post-v1.7)

- **Extension now survives HTTPS.** The background worker exposes its pinned host
  (`getHost`); the tray adopts it for DownloadURL drags and the direct-fetch
  fallback, and popup fallbacks include the https hosts. Previously drags broke
  entirely when the server ran under TLS.
- **Orphan sweep also removes orphaned thumbnails** (`t-<name>` files whose
  original has no DB row) — only known originals and their thumbnails survive.
- **`bytes` folded into the `captures` CREATE TABLE** — the ad-hoc `ALTER TABLE`
  outside the versioned migration system is gone.
- **Clipboard PNG helper deduplicated** into `public/toPng.js` +
  `extension/toPng.js` — four identical copies (app.js, phone.js, content.js,
  popup.js) removed.
- **Service worker shell v6** precaches the harness shell (`/app.js`,
  `/style.css`, `toPng.js`, icon set) — harness is offline-ready after install.
- **`npm run lint`** syntax-checks every script (`node --check`).
- **`ProofPipe.bat` ships in the repo root** (auto-`npm install` on first run).
- **`.gitattributes`** enforces LF line endings on Windows (`.bat` stays CRLF).
- **Tests:** 19 passing.

## v1.7 / ext v0.4.4 — performance pass

- Stats byte totals tracked in SQLite on write — no FS walks per request, boot
  backfill for rows that predate the column.
- Immutable 1-year cache on `/media/` (thumbnails/originals are content-addressed
  by timestamp+random).
- Upload encodes + writes parallelized; QR buffer cached per pinned IP;
  prepared statements hoisted; SSE heartbeat (25s) keeps connections alive.
- Incremental grid updates — no full DOM rebuild on SSE/delete.
- Extension tray: no boot fetch, poll diffs before render, bounded dataURL
  caches, 5-image prefetch.
- SW stale-while-revalidate shell (v5); phone tile blob URLs revoked on eviction.
- README rewrite; MIT LICENSE with Lucide attribution (docs commit).

## v1.6.1 — lightbox fixes

- Stage-wrapper centering (JS-only transform — no jump on zoom), no transition
  lag on wheel zoom, cursor-anchored zoom clamped ≥1×, pan clamped so the image
  stays reachable, pan anywhere on the stage via pointer capture, native img
  drag disabled, neighbor preload + fade swap, zoomed cursor states.

## v1.6 / ext v0.4.3

- SW cache v4 + icon precache; poll fallback detects text changes (textId in the
  version endpoint).
- QR NIC picker dropdown with validated `?ip=` + remembered choice.
- Phone outbox count reported to the PC (amber pill badge).
- Extension popup Captures/Texts tabs (texts tap-to-copy via bg + direct fallback).

## v1.5.1 / ext v0.4.2

- Lucide icon set replaces emoji (grid, lightbox, phone viewer, app icons via
  `gen-icons`).
- Phone: compact capture bar, textarea is the primary surface.
- PC: full-width text bar under header with auto-grow textarea and history dropdown.
- Extension: context-menu "Send to phone via ProofPipe" on selected text.

## v1.5 — bidirectional text sync

- `texts` table + `POST/GET /api/text` with source filter and 20-cap history;
  SSE `text` events.
- Harness send box + incoming chips; phone send box + chip strip; Android
  share-target in the manifest (Share → ProofPipe → PC).
- README flag-fix instructions for Android image copy.

## v1.4.3 / ext v0.3.4

- Permissive CORS + Private-Network-Access preflight on the server.
- Extension popup + tray fall back to direct fetch when the background-worker
  path fails; real error detail surfaced; Sync-now resets direct mode.

## v1.4.x

- v1.4: extension CORS-safe background SW + attach-all-unseen, upload re-encode
  (EXIF strip, 415 on non-images), orphan sweep, delete SSE push, outbox per-item
  retries + downscaled queue + clear button, idb null guards, pagination + load
  more, numeric PORT, no-store QR, `npm test` (6 smoke tests).
- v1.4.1: viewport-fit UI (harness app shell, phone exact-100dvh layout,
  overlay update banner).
- v1.4.2: compact side/QR card; phone tiles get copy/download; extension tray
  card fully draggable/clickable.

## v1.3.x

- v1.3: phone gallery import, tap-to-retry, pull-to-refresh, open-latest;
  harness zoom/pan lightbox, multi-select bulk ops, sort/filter, stats
  dashboard, update self-check, phone presence, SSE-to-phone.
- v1.3.1: tag system removed; modern dark dropdowns.

## v1.2.x

- v1.2: **auth removed (personal use)** — the pairing token was dropped by
  design; SSE instant push, fast phone capture path, toasts, NEW badges,
  lightbox, drop overlay, live status.
- v1.2.1: quiet server log, favicon, lightbox CSS cleanup.
- v1.2.2: overlapping-delete-button fix, centered pairing card.

## v1.1

- Capture + sync, pairing token, lightbox, clipboard copy, PC paste/drop upload,
  automatic extension attachment.

## Extension standalone releases

- v0.4.7 — current (see v1.7-era entries above).
- v0.4.4–v0.4.1 — tray/performance fixes (see v1.7 / v1.4.x entries).
- v0.4.0 — real tray *window* (popups can't host HTML5 drags); reverted in
  v0.4.1 to the single-click popup workflow; dragging lives in the p-tray.
- v0.3.8 — drag-to-chat via Chrome's DownloadURL mechanism (synthesizes a real
  File at the drop target); native thumbnail drag restored.
- v0.3.7–v0.3.3 — file-only drag payload fix, drag-initiation fixes, phone
  viewer, dual-host fallback, Sync-now.
- v0.3.0 — universal tray on all sites (p button → draggable captures carrying
  the real File), click-to-copy, minimal permissions.