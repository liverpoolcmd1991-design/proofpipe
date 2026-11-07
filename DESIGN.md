# DESIGN.md — ProofPipe visual system

Single source of truth for visual decisions. Values below are **extracted from
the shipped CSS** (`public/style.css`, `public/phone.css`) — they describe what
the product is, not what it should become. If you change a token, change it
here and in both `:root` blocks in the same commit.

ProofPipe is a dark, quiet, utilitarian tool. One accent color (green), one
danger color (red), neutral grays for everything else. Images are the color;
chrome stays out of the way.

---

## 1. Color tokens

### Core tokens (CSS custom properties, defined in `:root` of both stylesheets)

| Token | Value | Role |
|---|---|---|
| `--bg` | `#0e0f10` | Page background (both UIs) |
| `--card` | `#1c1f22` | Card / raised surface (header, modal, text bar) — 1.16:1 on `--bg` |
| `--card2` | `#26292d` | Inset surface — inputs, tiles, buttons, chips — 1.31:1 on `--bg` |
| `--border` | `#3a3f44` | **Passive dividers only** (1.80:1 on `--bg`). Never a control outline |
| `--ctl` | `#6e757c` | **Interactive control boundaries** — buttons, tiles, inputs, switches, selectable rows, segmented-control tracks. 4.11:1 on `--bg`, 3.55:1 on `--card`, 3.13:1 on `--card2`, clearing WCAG 1.4.11 everywhere. **Wired in BOTH UIs** — the harness draws every control with it and keeps `--border` for passive surfaces only |
| `--ctl-hover` | `#868d94` | The hover step above `--ctl`: 5.71:1 on `--bg`, 4.93:1 on `--card`, 4.35:1 on `--card2`. Replaced the grandfathered `#4a4d50`, which measured 1.95:1 on `--card` — a hover state nobody could see |
| `--seg` | `#202327` | **The ONE segmented-control track** (PC). 1.16:1 on `--card`, i.e. it sits with the card and under `--card2`: a track is a *slot*, and `--ctl` on its edge is what makes it a control. Lets the items drop their own borders, which is how the toolbar reaches a single 32px height with one boundary instead of four |
| `--text-bright` | `#f5f5f3` | Strongest text — headings only (PC only; phone uses `--text`) |
| `--text` | `#e8e8e6` | Default body text |
| `--muted` | `#a6a9ab` | Secondary text, meta rows, inactive icons, switch thumbs |
| `--faint` | `#96989a` | Tertiary text — hints, timestamps (PC only). ≥4.5:1 on both `--card` and `--card2` |
| `--accent` | `#22c55e` | THE interactive color: focus rings, live dots, checked switches, phone-origin, positive states |
| `--danger` | `#ef4444` | Destructive borders/fills, offline dot, failed tiles |

Surfaces stack `--bg → --card → --card2`. Never introduce a new gray; pick the
nearest existing one.

**The surface steps and the two border tokens are measured, not eyeballed.** The
pre-2026-09 set sat 1.07–1.16:1 apart, so a card on the page was a visual no-op
and every shape was carried by a `--border` at **1.37:1** — the screen read as
near-identical grey rectangles and no element could look primary (which is why
§7's "one primary action per view" was unenforceable in practice). Text contrast
was never the problem: `--text` 15.6:1, `--muted` 8.1:1 on `--bg`.

Two rules follow, and both are load-bearing:

- **A control's outline must clear 3:1 against the FILL it sits on, not just the
  page.** `#5c636a` clears 3:1 on `--bg` (3.15:1) but is only 2.72:1 on `--card`,
  and every `.alt-btn` fills with `--card` — so it was the wrong pick. `--ctl` is
  `#6e757c` because it is the first value that clears 3:1 on all three surfaces.
- **1.4.11 applies to controls, not hairlines.** Do not "fix" a passive divider by
  pointing it at `--ctl`; that just makes the layout loud. Dividers stay on
  `--border`.

A third rule makes the first two usable, and is what the harness shipped without
until 2026-09:

- **Every boundary is one of exactly two things, and the split is enforced.** A
  control is drawn with `--ctl` and hovers to `--ctl-hover`. A passive surface —
  card, band rule, dialog box, separator, info box, status pill, decorative
  glyph tile, transient status row — stays on `--border`. That split is what lets
  a control read as a control *without* making the layout loud: cards stay
  1.16–1.31:1 apart while controls stand 3.13–4.11:1 proud of them. Before it,
  the harness drew all 26 boundaries with the same 1.56:1 hairline, so nothing
  could look primary and the toolbar accumulated seven competing emphasis levels
  trying to compensate. `test/harness-ui.test.js` pins the list of control
  selectors, so a new one cannot quietly ship on `--border`.

Changing any of these means re-deriving the others: raising `--card2` is what
forced `--faint` to `#96989a` (its ≥4.5:1 contract is against the surfaces, and
`#8a8c8e` drops to 4.2:1 on the raised `--card2`).

### Semantic / status colors (one-off hexes — do NOT invent more)

| Hex | Used for | Where |
|---|---|---|
| `#f59e0b` (amber) | warning / pending / reconnecting — outbox badge, SSE-reconnecting dot, phone upload "pending" tick | both UIs |
| `#fbbf24` | inline warning text ("phone hasn't connected") and the phone queue bar's label | PC `.hint .warn`, phone `#outbox-info` |
| `#12271b` / `#2a2113` / `#2a1416` | **status-strip backgrounds** — connected / reconnecting / offline-or-unpaired. Low-alpha tints of the three status hues on `--bg`; text on each measures ≥12.8:1 and the dot ≥6.9:1, so the tint never costs legibility | phone `.status-strip[data-state="ok"/"warn"/"off"]` |
| `#151a2e` (blue tint) | **status-strip background for work in flight** — a transfer running. Deliberately NOT the warn tint: amber means "reconnecting…" and would read as a fault while a send is going fine. Held as the `--tint-busy` / `--tint-busy-bd` token pair, so the strip's paints are all tokens (the three above are the grandfathered one-offs) | phone `.status-strip[data-state="busy"]` |
| `#b45309` | update-banner background (amber-800, white text) | PC |
| `#fca5a5` | danger TEXT on dark (Delete buttons, error text) — never `--danger` for text, it's too dark to read | both |
| `#60a5fa` (blue) | "from PC" direction identity (transfer rows, outgoing text arrows) | PC |
| `#4a4d50` | **retired as a border color** — it was "the ONLY approved border-hover color", but at 1.72–2.26:1 it was invisible. Use `--ctl-hover` | both (historical) |

### Interaction color rules

- **Accent green means "working/connected/positive"** — never decorative.
- Focus-visible = `outline: 2px solid var(--accent); outline-offset: 1–2px`,
  or a soft ring `box-shadow: 0 0 0 2px rgba(34,197,94,.15–.35)` on inputs.
- Danger buttons tint text `#fca5a5` and only take a red border/hover fill
  (`rgba(239,68,68,.12)`); solid red fills are reserved for status dots and
  the failed-tile banner.
- On-accent text is always `#000` (badges, checked switches, NEW badge) —
  white-on-green fails contrast and is forbidden.
- Direction identity: phone/green (`--accent`), PC/blue (`#60a5fa`). Both UIs
  follow this for origin badges and transfer direction rows.

---

## 2. Spacing scale

Base rhythm is **4px**; the codebase consistently uses this ladder:

```
2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 20 · 24 · 32 · 44
```

| Step | Typical use |
|---|---|
| 2–4px | micro-gaps inside segmented controls, icon nudges |
| 6–8px | grid gaps (8 phone / 12 PC), chip gaps, action-button gaps |
| 10–14px | control padding (buttons, inputs, chips), list row padding |
| 16–20px | card padding (16 side card / 18 main card), modal padding |
| 24px | header horizontal padding, section spacing |
| 32px | main content horizontal padding |
| 44px | minimum tap target (phone touch controls, close buttons) |

Rules:
- Card padding: `18px` (main), `16px` (sidebar). Modals: `16–22px`.
- Phone honors safe areas via `env(safe-area-inset-*)` — never hardcode top
  or bottom padding on the phone without `max(Npx, env(...))`.
- Do not introduce odd values (7, 9, 11, 13, 15) for NEW spacing; existing
  ones are grandfathered.
- **Desktop minimum target is 28×28 CSS px.** WCAG 2.5.8's floor is 24×24; 28 is
  the desktop-comfortable size and what the harness ships. The painted box may be
  smaller than the target where growing it would distort a dense composite — the
  Undo pill inside a toast expands its hit area with a positioned `::after`
  rather than making every toast 8px taller. It is also why the PC toolbar's
  segmented track is 32px with a **1px** inset (28px items) and not 2px.
- **The PC harness has one band height and one row height, both tokens.**
  `--topbar-h: 64px` is the unified brand + compose band (§7) and `--row: 32px`
  (declared on `.toolbar`) is the height every control in the toolbar row reads.
  A control that arrives on its own baseline is the bug this prevents — the row
  used to hold ten controls on three of them (31 / 23 / 22px).
- **Phone vertical order** (top → bottom): status strip · recent-captures heading
  · gallery (`flex: 1`) · composer · PC-sent lane · secondary row ·
  `.shutter-bar`. The gallery leads because "did it land?" is the question this
  screen answers; the primary action is last because that is where the thumb is.
  The grid is wrapped in `.gallery` — one `flex: 1` box — because an empty
  library sets `#recent { display: none }`, and with nothing left to absorb the
  free space the composer and the shutter bunched at the top of the screen.
  The composer must stay **above** the PC-sent lane (a guard in
  `test/phone-ui.test.js` asserts it).
- `.wrap` carries **no bottom padding**: `.shutter-bar` is the last thing on
  screen and owns the bottom safe-area inset, so it can paint to the edge. The
  `body.kb-open` block restores the inset for the composer, which is bottom-most
  while the bar is hidden.

---

## 3. Typography

### Families

```css
/* UI (both UIs) */
system-ui, -apple-system, "Segoe UI", sans-serif;
/* monospace (paths, hashes, technical strings) */
ui-monospace, Consolas, monospace;
```

No webfonts. No other stacks.

### Base sizes & line-heights

| Context | Size / line-height |
|---|---|
| PC body | `15px / 1.5` |
| Phone body | `16px / 1.4` |
| Inputs/textarea | `14.5–15px / 1.45–1.5` |

### Type ladder (px — as shipped)

| Size | Weight | Use |
|---|---|---|
| 17 | 700 | brand / page title (h1) |
| 16 | 650–700 | card headings (h3), empty-state titles |
| 14–15 | 500–600 | buttons (`.vbtn` 600), primary controls |
| 13–13.5 | 400–600 | default secondary text, toasts, meta |
| 11–12.5 | 400–700 | meta rows, timestamps, hints, small buttons |
| 9.5–10.5 | 700–800 | badges (NEW, ✓, PC chip badge) |

Rules:
- Headings: `--text-bright`, weight 650–700, slight `letter-spacing: .01em`.
- Muted hierarchy: `--text` → `--muted` → `--faint`. Don't jump levels.
- Timestamps/meta are always 10.5–12px and `--muted`/`--faint`.
- Mixed-direction (RTL/Arabic) user text sets `unicode-bidi: plaintext`.

---

## 4. Border radii

| Radius | Use |
|---|---|
| `999px` | pills, toasts, switches, progress bars, round badges |
| `16–18px` | hero controls (shutter, drop box), page-level cards (16) |
| `14px` | phone modals/sheets, viewer buttons, textareas (phone) |
| `12px` | capture tiles, lightbox bar, PC text-history dropdown |
| `10px` | small inputs, chips, transfer rows, upload rows |
| `8px` | buttons (all PC variants), icon boxes, small badges |
| `5–6px` | tiny badges, thumbnail corners inside chips |

Scale meaning: bigger = more "surface", smaller = more "control". A rule of
thumb that matches the code: interactive controls 8, containers 10–16,
pills 999.

## 5. Shadows & elevation

Elevation is rare and subtle — borders do the work; shadow = floating:

| Pattern | Use |
|---|---|
| `0 6px 24px rgba(0,0,0,.4)` | toasts, banners |
| `0 10px 40px rgba(0,0,0,.5)` | dropdown panels |
| `0 12px 60px rgba(0,0,0,.6)` | modals, lightbox image |
| `0 1px 6px rgba(0,0,0,.5)` | small floating badges (sel-check) |
| none | cards, buttons, inputs — border only |

Lightbox/drop overlay additionally dim the world:
`rgba(0,0,0,.6–.92)` + optional `backdrop-filter: blur(2–3px)`.

## 6. Transitions & motion

| Token | Use |
|---|---|
| `.12s` | tile hover lift, viewer transform snap-back, control press scale |
| `.13–.18s` | surface reveals (panels, dialogs, lightbox, bars, chips) |
| `.14s` | hover/press colour feedback (background, border, color) |
| `.15s` | opacity fades (tile actions, lightbox crossfade), menu arrows |
| `.18s ease` | switch/track color transitions |
| `.2s ease` | progress-bar width, row removal slide |
| `.25s ease` | toast enter/exit |

- Transform/opacity only. Never animate layout properties (`width` on bars is
  grandfathered).
- The light-sweep sheen (`.sheen`) is the single flourish — hover/active only,
  transform-only, and on **buttons only** (`.alt-btn`, `.shutter`, `.vbtn`). It
  used to run on the chips too, where it streaked light across the one part of
  the card that is content — the thumbnail — and forced an `overflow: hidden`
  those components only carried to keep the streak inside.
- **Reveals ride on `.hidden`.** Both surfaces show and hide panes, bars and
  dialogs by dropping `.hidden` (display:none → visible), and `:not(.hidden)`
  animations replay only on that transition — a no-op `classList.toggle` on an
  already-visible element changes nothing, so a re-render never replays an
  entrance. Elements that need an EXIT transition use `[data-open]` instead
  (the harness settings modal).
- Only the parts that are re-created (a newly built phone chip, an upload row)
  carry a JS-added entrance class, and JS removes it right after — the strip's
  reconcile pass re-inserts existing nodes, which would otherwise replay it.
- Any keyframe on a transform-positioned element must restate that transform
  (`#lb-bar` is centred by `translateX(-50%)`; the animation carries it in its
  `from`), and a press scale on `#lb-prev`/`#lb-next` must include their
  `translateY(-50%)`.
- Gesture surfaces keep their own overrides: `.swiping` sets `transition:none`
  for the duration of the drag and `.snap` owns the spring back (PITFALLS #31).
- **`prefers-reduced-motion: reduce` kills ALL animation/transition globally**
  in both stylesheets. Any new animation is automatically covered — don't
  opt out.
- Micro-interactions: `:active { transform: scale(.97–.99) }` on phone tappables.

## 7. Component rules

### Buttons

| Class | Variant | Look |
|---|---|---|
| `.btn` | default (PC) | `--card2` bg, border, 8px radius |
| `.btn.ghost` | quiet | no background |
| `.btn.danger` | destructive | `#fca5a5` text, red border on hover only |
| `.toolbtn` | toolbar | same as `.btn` + inline icon support |
| `.toolbar .toolbtn` | toolbar row | one height for the whole row (`--row: 32px`), padding `0 12px` |
| `.toolbar .icon-btn` | toolbar icon control | a 32px square (never under the 28px floor) |
| `.view-tabs` | segmented track | `--seg` fill + ONE `--ctl` outline, 1px inset, 32px tall; its items carry **no** border and **no** fill of their own |
| `.menu-item` | a row inside a menu panel | full-width, `--row` tall, hover = a 5% white wash, chosen = `--card2` + a ✓ (**never** inverted) |
| `.menu-item.active` | a menu row in a mode | the same fill as `[aria-pressed="true"]` — a menu's open state is a fill change, NOT an inversion |
| `.toolbtn.active` / `.tab-btn.active` | selected | **inverted**: white bg, black text |
| `.toolbtn.danger` | destructive toolbar | `#fca5a5` text, red border on hover |
| `.mini-btn` | compact sidebar | 12px text, 4×10 padding |
| `.act-panel` (tile) | the tile's overlay actions | ONE translucent `rgba(0,0,0,.78)` + `--ctl` pill holding two glyphs and a `⋯` — 92×34 at every density |
| `.capture .act` | a glyph inside that panel | transparent, white icon, 28×28: the PANEL is the chrome, never four separate squares |
| `.f-actions .act` | transfer rows | outlined 12px, `.del` tinted danger |
| `.vbtn` / `.alt-btn` | phone | `--card` bg, `--ctl` outline, 14px radius, 44px+ targets, `:active` scale |
| `.alt-btn.sec` | phone secondary row | the 2-up Choose photos · Send file cells, `min-height: 52px` |
| `.shutter` | phone primary | **`#fff` fill, `#0e0f10` text, 60px, in `.shutter-bar`** — the ONE inverted surface on the screen |
| `.linkbtn` | inline link | muted, underlined, no border |

Button rules:
- One primary action per view; everything else is quiet/outline. On the phone
  that primary is **the shutter**, and it is the only `#fff` surface: inverted
  white is this system's emphasis language (`.toolbtn.active`, the PC toast), so
  a screen has exactly one of them. Everything else is `--card` + `--ctl`.
  Before 2026-09 nothing was quiet *or* primary — every surface was the same
  `--card` — while the brightest element on the phone was the SECONDARY
  `#text-send` (`#fff` at 19.2:1 against a card at 1.08:1). If you are tempted to
  make a second thing white, you are re-ranking the screen; do that deliberately.
- The primary action belongs in the **thumb zone**. A 60px `#fff` shutter at the
  top of the screen is a button the hand holding the phone cannot reach.
- `:active` states on an inverted fill cannot be a colour swap — `--accent` on
  `#fff` is 2.2:1. The shutter's busy state rides a green `box-shadow` ring.
- Destructive actions are visually separated (`margin-left`, dashed border,
  confirm dialog) and **always** confirm via the in-app dialog — `confirmDialog`
  (PC) or `phoneConfirm` (phone): default = Cancel, focus on Cancel, Esc and
  backdrop = cancel. Native `window.confirm` is banned on both (it blocks the
  main thread, freezes phone animations, and focuses OK).
- **Separation means a different LIST, not just a different colour.** The phone's
  More sheet put four destructive bulk actions in the same 8px rhythm as the
  auto-cleanup switch and the quality slider, and only `Delete all` carried
  `.danger` — so `Clear PC-sent captures` (which also wipes the PC-side history)
  read *quieter* than a JPEG quality slider. The three `clear-*` actions now sit
  under their own heading inside a dashed rail (`.menu-group`), all marked
  danger, and the single irreversible one is set apart again below it.
- A sheet's `.alt-btn` rows are LIST ITEMS: they take `.btn-face` for the
  icon + label line and `justify-items: start`. `.alt-btn` is a
  `place-items: center` grid for the picker row, which stacked the icon *above*
  the label wherever that wrapper was missing.
- Every icon-only button needs `aria-label`; every focus state is visible.
- Active/selected states never use the accent for toggle groups — selected =
  **inverted (white on black)**; accent is reserved for live/positive.

### Top band & toolbar (PC harness)

The harness's window top is **one** band, `--topbar-h: 64px`: brand · **Recent
texts** glance · compose field · Send · (status · Settings). It used to be two stacked bands — a ~49px
header whose right half was permanently empty plus a ~69px compose bar holding a
1338px-wide single-line field — 118px of chrome for one idea. Rules:

- **The field is a DEFINITE 560px (`width: 560px`) and pinned to the band's
  end**, which is where Send already sat. A field the width of the window is a
  measure nobody reads, and the cap is what keeps Send from being the thing that
  moves. Definite rather than `flex-basis: 560px`, because an auto-sized flex item
  contributes its *content* width to its parent's intrinsic size: in the band's
  compose group that made the group measure itself 517px (glance + gap + the bare
  textarea) and shrink the field to **185px** to fit inside its own group —
  measured live at 1440×900. A definite width is the item's contribution, the
  group comes out 784px, and the field keeps its 452px of measure.
- **Nothing is ever inserted after Send inside the band.** The inbound text used
  to be its sibling: an arriving message displaced the button by 350px. (The
  glance sits *before* the field, so the pair is sized as a whole and Send and the
  mail icon keep their x1372.)
- **The newest text is a glance BESIDE the field, not a card above the library.**
  `#text-recent` is a 210px column in the band — an 11px label over one 28px row,
  both directions, click to copy — and the band's **mail icon** opens the dialog
  with the whole history. As a card at the top of the library (three rows under a
  36px header) it was 178.5px of the card and pushed the first capture row to
  y339.5, so the one question it answers — *did my last message land?* — was paid
  for out of the captures it pushed down. In the band it costs the grid nothing
  (measured: the card opens on the toolbar, first capture row y147). One text is
  also what keeps the column small enough to sit beside a real field: 210 + 14 +
  560 fits inside 1024px with room to spare, and below that the glance stands down
  (`display: none` under 1024px) and the mail icon carries it alone — the same
  width-gating the filter chips use.
- **The toolbar row holds five controls on one baseline**: the segmented view
  switch, the sort menu, the size menu, ＋ File, and the ⋯ overflow (Select ·
  Show both lists · the two wipes). Everything occasional lives behind the ⋯; the
  row's glance stays on *which view · which subset · in what order · at what size*.
- **A menu's panel is a `role="group"`**, not a fake `role="menu"`: its rows are
  real buttons and one of them is a switch (`.show-all-toggle`), which the menu
  role cannot describe. One trigger → one panel, `.open`-gated (the phone's More
  sheet is the same shape). Escape closes it in the **capture** phase, so one
  keypress settles the menu without also closing the layer under it.
- **A screen still has exactly ONE inverted (`#fff`) surface.** In the toolbar
  that is the active view segment; a chosen sort/size row is a fill plus a ✓, and
  a chosen filter chip is an accent **tint**. Before P1 an idle Captures view had
  two (the active tab *and* the active density segment), so neither could look
  primary.
- **The row's middle third filters, and it filters BOTH lists.** A search field
  (`/` focuses it) plus three origin chips — *All · From phone · From this PC* —
  narrow what is on screen. This is the side rail's old origin legend, moved into
  the toolbar and made clickable: the same vocabulary, as a control instead of a
  key for something you could already see. A capture filters by `origin`, a
  transfer row by `dir`, and a pre-v2 row with `origin: null` counts as the
  normal (phone) case — so the filter and the tile badge can never disagree about
  the same row. The filter is client-side over what is loaded: no request per
  keystroke, and no second index to keep honest.
- **A filter change is add/remove, never a rebuild** (`syncGrid`, not
  `renderGrid`), so the tiles that survive keep their decoded thumbnails, their
  scroll position and the keyboard cursor.
- **Filtering is never destructive and never lies.** "No captures yet." is a
  claim about the data; `#empty-filtered` and the transfers lane's filtered copy
  are separate states with a way out (Clear). The tab count reads `n of total`
  while a filter is on — `· 14 ·` beside three tiles is the kind of number that
  makes a user think the filter is broken.

### The status rail & first run (PC harness)

The rail is **264px**, not 320. At 320px it was 22% of a 1440px window and, once
the phone was paired, the QR left — the column measured **331.8px of 742px empty
(44.7%)** at 1440×900 and 511.8px of 922px (55.5%) at 1920×1080. It is four cards
now, each answering a question:

- **Status** — what "Live" means. `● Connected` · `Synced 2m ago`, or
  `Not connected` when a paired phone has gone quiet (amber, not red: silence is
  cold, not absent). The pill is one word; this is the sentence.
- **Pair phone** — the single QR on the page, unchanged; it shows whenever no
  phone is reachable and disappears on pairing.
- **Storage** — a 4px meter plus one sentence. `31.5 MB` answered nothing without
  the cap beside it; `31.5 MB of 5 GB · 14 captures` is the same information in a
  glance instead of three lines of arithmetic. The denominator rides `/api/stats`
  (`cap`) so the bar is honest on first paint rather than reading 0% until
  `/api/settings` lands. Past 80% the fill turns `--danger` — the same threshold
  auto-cleanup uses — and the `role="progressbar"` carries both `aria-valuenow`
  (a percentage) and `aria-valuetext` (the real pair).
- **Recent** — the last three arrivals across both libraries, newest first,
  assembled server-side from two bounded 3-row queries. This is the "did it
  land?" answer and it is what fills the column honestly. **Kind is the glyph
  and direction is its colour**, and the colour is never the only carrier: each
  row spells the direction out in an `.sr-only` span.

The cards **stretch** (`align-items: stretch`) — the column used to centre a stack
of labels, which is what left the space empty.

**Below 900px the rail is a DRAWER, not a column.** It used to be a second grid
row capped at `40dvh` with its own scrollbar, beside the library's own scroller:
TWO nested scroll regions in a 700px window (measured overflow: 108.9px past a
280px cap). Out of flow, on a veil, there is exactly one. The trigger lives in the
top band and renders only below the breakpoint; the breakpoint test in JS is the
trigger's own computed `display`, so there is no second copy of the number. The
drawer traps Tab, joins the Escape ladder at the **bottom** (z-index 320, under
the lightbox's 350), closes on an outside press, and closes when the window widens
past the breakpoint — a translated panel left open over the library is a bug.

**First run is a state, not an error message.** When nothing has ever arrived AND
no phone has ever paired, `#setup` replaces `#empty`: one card, three steps in
order. Steps 2–3 dim to 45% until the phone has actually connected (a progress
affordance: you cannot send from a phone that has not paired, so a step you cannot
do should look like it). Step 1 deliberately renders **no second QR** — the code
lives in the rail, and a copy here is the exact bug
`test/harness-ui.test.js` pins. An empty library *after* a phone has been seen is
the ordinary `#empty` state instead, and `#empty` defers to the setup card so two
empty boxes can never be up at once.

**`.main-card.no-data` hides the tools that can do nothing.** On a fresh install
the toolbar offered sort, size, search, the origin chips, Select and Delete-all
over a 996×661 void — every control present, none able to act. The gate hides the
MANAGE tools (`.filters`, the sort/size menus, Select, both wipes) and keeps the
two a first-run screen is FOR: the view switch and the compose field. ＋File stays
— it is how the first data arrives. The markup ships with the class, so there is
no frame where the tools are live before the first `/api/stats` reply, and ONE
verdict from ONE payload (`anyData`) drives both the card and the gate.

### Tiles & rows (PC harness)

- **The tile's meta row carries the TIME, not `#14`.** A database id is not
  information the user can use; the clock is the thing they are ordering by, and
  a relative label cannot answer it at day granularity (three captures are all
  "2h ago" on a busy afternoon). Today → `14:31`, yesterday → `Yest 14:31`,
  older → `13 Sep`. The relative label still lives in the tile's accessible name
  and its hover title, which is where a label that moves belongs.
- **Size on demand, empty at rest**: the byte size fades in on hover /
  `focus-within`. The row stays quiet until you ask it something.
- **A badge marks the EXCEPTION.** Most captures come from the phone, so
  PC-origin content gets the small blue chip and phone-origin content gets none —
  that deletes fourteen badges that said nothing and leaves one that says
  something.
- **Transfer rows have no actions at rest.** Two glyph squares (Open, Save) plus
  a `⋯`, 28×28, revealed on hover / `focus-within`, with the row's own surface
  answering Enter (open), ⌘S (save) and ⌫ (delete) — a control that can be tabbed
  to is a control the user can see. Three identical text buttons in every row was
  27 targets and 27 tab stops for 9 files, none of which named its file.
- **A tile carries the same two-plus-`⋯` shape in ONE panel**, not four loose
  squares: Copy and Send to phone stay up (they are what the library exists for),
  and Download plus Delete sit behind the `⋯` where a destructive action cannot
  neighbour the one the user came for. The panel is 92×34 at every density — the
  old row of four 27×21 squares needed ~120px, so on a 110px S-density tile it
  wrapped 2×2 *over the photo it belonged to*. Measured at 1440×900: **0**
  sub-28px targets, three 28×28 glyphs on one row at density S (120px tile) and M
  (165px tile).
- **Rows group under sticky day headers** (Today · Yesterday · Earlier this week
  · a date). A header is a SIBLING row, not a wrapper, so a delete can never
  disturb a group and an SSE insert can target one directly; every pass over the
  list goes through `transferRows()` so a header can never be painted as a row.
- **A panel that belongs to a scrolling list is `position: fixed`**, placed from
  its trigger's rect and dismissed on scroll. An absolutely-positioned panel
  inside a scroll container is clipped by it — and the last visible row, where a
  menu is most likely to be opened, is exactly the clipped one. **A fixed panel
  is only viewport-relative while nothing above it transforms**, so an open row or
  tile panel is moved into the BODY for its lifetime (`toggleRowMenu` /
  `closeRowMenu`): a tile lifts on hover, and as a child of that tile the panel
  resolved against the tile and landed 400px off (PITFALLS #51).

### The bulk bar (PC harness)

- **Its primary is Copy N.** One gesture writes every selected capture to the
  clipboard (encode → one `clipboard.write`), with the button reporting progress:
  a control that does nothing visible for ten seconds reads as broken. A platform
  that keeps only one image is **told about**, never silently half-copied.
- **`#fff` is spent here too** — the bulk bar is a docked overlay with its own
  emphasis scale, and its primary is the one action in it that creates rather
  than destroys. It is `.cap-only`: a file has no image bytes to put on the
  clipboard, so the button is absent on Transfers rather than a no-op.
- **Entry decides the exit.** A tile's selection box is an IMPLICIT entry — the
  bar is up because something is selected — so an empty selection closes the bar
  and leaves Select mode with it ("0 selected" over a dead Copy is a menu with
  nothing in it). The ⋯ menu's **Select** (`S`, `⌘A`) is a DELIBERATE entry: it
  pins the bar open, because Select all and Cancel are what an empty bar is for.
- **Destructive actions sit at the far end**, past a gap. An action that cannot
  be undone is never shoulder-to-shoulder with the one that can.

### Status strip (phone header)

`.status-strip` replaced the wordmark row. The phone's `<h1>proofpipe</h1>` held
the centre of the header while the one fact that decides whether a photo reaches
the PC — the connection — was an 8px dot plus 11px text in the corner, and §3
files 11px as "meta". The user launched the app from a home-screen icon; they
know its name. The top of the screen belongs to the state.

- Anatomy: `[dot] state · detail [⋮]`. The state word is 13.5px/650 `--text`; the
  detail (`N sent · auto-paste on`) is 12px `--muted`, ellipsised, `min-width: 0`.
- **The background is tinted by state** (`data-state="ok" | "warn" | "off" |
  "busy", the tint hexes in §1), driven from the SAME class ladder as the dot so
  the two can never disagree. An 8px colour-only dot is invisible peripherally; a
  tinted bar is not — that is the whole point of the component.
- **`busy` is a state, not a fault** — it is the strip's work-in-flight tint,
  raised while a transfer runs (file sends report progress into the strip's
  detail line instead of owning a band of their own, which the keyboard used to
  hide outright). Blue, the same "in flight" cue the PC uses; the state word and
  the dot do not change, only the paint.
- `#status` is the live region. The detail is **deliberately not** one: a count
  that ticks up on every capture must not be re-announced each time.
- **Three states, not two.** A phone that has never reached the PC since the page
  loaded reports `not paired — scan the QR on your PC · same Wi-Fi`, not
  `offline`. "Offline" claims a connection that *dropped*, which sends a first-run
  user hunting for a Wi-Fi problem when the fix is on the other device.
  `everConnected` (first successful poll or SSE open) is what separates them.
- The `⋮` is a 44px target at the strip's right end. It needs no negative-margin
  pull to reach the wall: the strip is the flex child that reaches the page
  padding, and pulling a button past that edge is what made the page 6px wider
  than the screen (v1.8.8).
- **The `⋮` is the sheet's ONLY entry point.** A labelled "More" cell in the
  action row was a second door to the same room: it duplicated the control, had
  to report its own `aria-expanded`, and forced the outside-click handler to
  exclude it by name or the click's own bubble closed the panel it had just
  opened. One control per panel — and the row it freed went back to the pickers,
  which are the reason that row exists.
- The queue count lives in **exactly one place** — the amber bar above the
  shutter (`#outbox-info`). It used to be duplicated into the status line, which
  let the header assert a queue the bar contradicted, and let "offline — photos
  queued" claim a queue that could be empty.

### Inputs

- Background `--card2` (PC) / `--card` (phone), border `--ctl` in both, radius
  8–14. A control's outline clears 3:1 against its own fill as well as the page
  — see §1.
- Focus: `border-color: var(--accent)` + `box-shadow: 0 0 0 2px rgba(34,197,94,.15)`,
  `outline: none`. Never leave default browser focus rings on inputs.
- **The PC compose field is one row tall in the top band** (`height: var(--tb-ctl)`,
  `max-height: var(--tb-ctl)`, `overflow-y: auto`). It used to auto-grow to 150px,
  which was fine in a bar that sized itself and is wrong in a fixed 64px band: a
  long draft pushed the whole library down and moved Send off its baseline. Long
  drafts scroll inside the field. The phone still auto-grows (coalesced to one
  frame) because its composer is not inside a fixed band.
- Selects (`.pp-sel`): custom chevron via inline SVG background; native popup
  restyled to `--card`.

### Switches (toggle pattern)

PC `.auto-copy-toggle input` / phone `.switch-row` — same anatomy: 999px track
(`--card2` + border), thumb (`--muted`), checked = accent track + black thumb
+ `translateX`. Phone drives state via `aria-checked` on the row (CSS never
depends on the checkbox being visible). Focus ring `rgba(34,197,94,.35)`.

### Cards

- `.card`: `--card` bg, 1px border, 16px radius, 18px padding.
- A card that is a **grid item** (`.main-card` in the harness `.view`) must
  declare `min-width: 0`: a grid item's automatic minimum is its *min-content*
  size and `1fr` is really `minmax(auto, 1fr)`, so one long unbreakable string
  inside (a file name, an absolute path) inflates the column and pushes the card
  past the viewport. `min-width: 0` on the inner flex row is NOT enough — it
  only lowers the minimum a shrink can reach, not the min-content contribution.
- `.main-card.droptarget`: dashed border when empty (drag-and-drop affordance).
- Empty states: centered via grid, three text tiers
  (`.empty-title` `#cfd0d2` → `.empty-sub` muted → `.empty-hint` faint).

### Chips / pills / badges

- `.pill`: 999px, `--card2`, meta text + `.dot` status.
- `.dot`: 8px circle. `ok` = accent (+ one-shot pulse on load), `warn` = amber
  (SSE reconnecting), `off` = danger (offline).
- Chips (text/file/media): `--card2`, `--ctl` outline, 10px radius (PC) or
  999px pill (phone), ellipsis, `unicode-bidi: plaintext`, tap = copy,
  hover/active = accent border. **The outline is `--ctl`, not `--border`** — a
  chip is *tapped*, so its edge is a control boundary and owes 1.4.11 its 3:1;
  on `--border` it measured 1.56:1 against the page and the inbox lane read as a
  row of cards you could not see.
- **Phone PC-sent rich content is a CARD, not a pill** — a capture and a file
  arrive from the same place and do the same job, so both render with one
  anatomy: a 42px leading visual (thumbnail, its placeholder, or the file-kind
  icon tile) · a title/sub meta block · the direction badge in the trailing
  slot. Same 12px radius, same width (`min(76vw, 248px)`), same 58px height, so
  the two lanes stack on one axis. The capture card keeps `.text-chip` for the
  strip behaviours that class owns (swipe gesture, reconcile key, focus ring)
  and takes the geometry back with `.text-chip.media-chip`. Plain texts stay
  pills: text has no thumbnail and no second line.
- **Direction identity is not negotiable per component**: PC content badges
  `#60a5fa` (capture card, file card, viewer badge), phone content the accent.
  A green "PC" badge is a bug.
- **A badge is ONE rendering, not one per component.** The capture card put the
  text `PC` in the trailing slot with no glyph; the file card put a bare glyph
  there with no text — same slot, same meaning, two components. Every direction
  badge is now **icon + label** (`.chip-badge` → `<i class="ic ic-pc">` + `PC` /
  `Phone`), in the capture card, the file card and the viewer alike. The
  `title` and the accessible name still spell it out; the glyph is the visual
  shorthand. When you add a fourth place that shows a direction, copy the badge
  whole rather than re-deriving it.
- **The phone's PC-sent lane's two strips are ONE component.** `#text-in` and
  `#files` are declared in a single rule (`.text-in, #files`), because as two
  blocks they drifted and every difference was visible: 2px of side padding on
  both pushed the chips in from the page's 18px gutter, and their bottom padding
  plus `#inbox`'s gap produced a 14 / 12 / 4px rhythm between the strips, the
  "more rows" row and the tip. The 32px bottom padding is the swipe's travel
  window *inside* the border-box; a matching negative margin hands it back to
  the layout, so `#inbox`'s `gap: 8px` is the lane's only vertical spacing and
  every gap in it measures 8px.
- Strips that mix 44px pills with 58px cards set `align-items:center`; the
  default `stretch` dragged the pills to the card height.
- **The strips' edge fade is per edge** (`.at-start` / `.at-end`, set by
  `trackStripEdges()`). A fade belongs only on an edge with content past it:
  applied unconditionally, a strip parked at its start ran its first chip
  through the 0→14px transparent ramp, so that chip's left border was simply not
  drawn — and a strip that did not overflow faded both ends for nothing. The
  mask itself stays in CSS; JS only sets the two custom properties.
- **"More rows" is ONE control in ONE place.** Each strip is followed by a
  full-width centred `.lane-more` row (`#text-load-more` / `#files-load-more`),
  the same static markup in `phone.html` for both, and neither carries a count:
  the text lane's used to be an item built *inside* its strip — on a 7-row lane
  it sat past the last chip, reachable only by scrolling the strip to its end,
  where the edge fade ate it — and its `(n)` came from the raw row count, so it
  could promise three and reveal one (duplicate sends of a capture are suppressed
  at render time). Same job, two components, and a number that lied.
- **The phone's PC-sent lane prints ONE gesture tip.** Both its strips
  (`#text-in`, `#files`) swipe down to remove, and both hints were gated by the
  same `pp_chip_hint` flag and dismissed together — so a lane holding texts AND
  files printed the same sentence twice, one line apart, and the two lines read
  as a divider between two groups instead of as one lane. The single
  `#chip-hint` is driven by `updateInbox()`, the only place that sees both
  strips; neither loader owns it.
- **A badge must mark the EXCEPTION, not the normal case.** The phone's capture
  tiles wore a green ✓ on every single one via `#recent .ok-badge::after` — a
  badge that is always present carries no information, and it spent the
  top-right corner of every 96px thumbnail, the only part of the UI that is
  content. The tick is now an arrival confirmation (`.just-sent`, added by JS on
  a live landing, held for `JUST_SENT_MS`, then faded over `JUST_SENT_FADE_MS`
  and removed — a confirmation that vanishes between two frames reads as a
  glitch, so its exit is a fade, and the reduced-motion block makes that
  instant); `.pending` and `.failed` persist because those are the states worth
  interrupting for. The transient class must be out-specified by the persistent
  ones, or a tile can wear a ✓ and a spinner at once, and re-arming mid-fade has
  to restore full strength before re-timing.

### Toasts / feedback

- Both toasts and the confirm text print server strings verbatim (file names,
  absolute paths), so they are capped and told where they may break:
  `#toasts { max-width: min(92vw, 620px) }`, `.toast { overflow-wrap: anywhere }`,
  `.confirm-box { max-width: min(380px, 92vw) }` + `overflow-wrap: anywhere` on
  its paragraph. An unbreakable 120-char name used to make the centred toast
  wider than the viewport and push the confirm text out of its box.
- PC `.toast`: **white pill, black text** (deliberate contrast inversion —
  it must be readable over any image), 999px, `.show` = fade+rise, optional
  Undo button + shrinking countdown bar (10s). Because it is *interactive* on
  the PC (Undo), it lifts clear of the lightbox action bar (`bottom: 86px`)
  while the viewer is open — the same bottom-center collision PITFALLS #34
  fixed on the phone.
- Phone `.flash`: identical visual language, auto-remove 1.6s. Renders at the
  **top** of the screen (safe-area aware) — at the bottom it sat over the
  viewer action bar and blocked its buttons — and is `pointer-events:none`:
  a status message must never be a tap target. ONE reused node, so a burst
  replaces the message instead of stacking pills on the same spot.
- Phone `#undo-toast`: the one **interactive** phone snackbar (`pointer-events:
  auto`) — bottom-center, 6s window with a shrinking bar and an Undo button.
  Bottom is safe here because the viewer overlay sits above it and no chip
  gesture can start under the viewer. Use it whenever a phone action can be
  deferred; inert status still belongs to `.flash`.
- **Wrapping is per toast, not a house rule.** Both print a server string (a
  file name), but they are different shapes: `.flash` is a rounded **rect** at
  the top with room for a second line, and its messages explain a *reason*
  ("«120-char name» is over the size cap") where the cut-off part is the part
  that matters — so it wraps (`overflow-wrap: anywhere`). `#undo-toast` is a
  999px **pill**: wrapping a 116-char name turned it into thirteen lines —
  measured 195×226px of white over the whole lane, the tip, the picker row and
  part of the shutter, with the name squeezed into a 94px column. It is clamped
  to ONE line (`white-space: nowrap` + `text-overflow: ellipsis` on the message,
  which is the flex item that gives way, `min-width: 0`). The clip is **visual
  only** — the live region keeps the whole string, so a screen reader still
  announces the full name. A pill must stay a pill.
- Skeletons: `.skel-img` (PC) / `#recent-loading .skel-tile` (phone) — the
  sweep is a translated gradient **overlay** (`::after`, `transform:
  translateX(-100%) → 100%`), never an animated `background-position`: the old
  form repainted every placeholder every frame for the whole load, the overlay
  runs on the compositor.
- Upload progress: 4px bar, accent fill, `--card`/`--border` track. The fill
  is driven by `transform: scaleX(fraction)`, not `width` — a layout property
  animating for the length of an upload repaints every frame.
- Countdown bars (`#toasts .toast-undo-bar`, phone `#undo-toast .undo-bar`)
  shrink with `scaleX(1) → scaleX(0)` (`transform-origin: left center`) for the
  same reason. Any new "time remaining" bar follows this pattern.

### Modals & overlays

Fixed backdrop `rgba(0,0,0,.6)` + blur, `place-items: center` grid, `.dir-box`/
`.confirm-box` (max-width 380–460px). Click on backdrop = cancel; Esc = cancel.

**z-index ladder** (harness): toolbar menus 60 < lightbox 100 < banner 150 <
drop/dir/file-sheet 300 < settings 350 < dir-picker 370 < toasts 380 < confirm
400. Two rules hold it together:

- **A dialog opened FROM a modal outranks it.** The storage folder picker is
  only reachable from Settings, so it sits at 370, above the Settings veil
  (350); at 300 it rendered dimmed underneath and every click in it hit the
  Settings backdrop instead.
- **Feedback outranks the layer that produced it, but never a destructive
  confirm.** Toasts are 380: above Settings (350) so a toggle's confirmation is
  not a dimmed pill behind the veil, below confirm (400) so an interactive
  Undo can never cover a Delete.
- **A popup that belongs to a control floats above its own surface and nothing
  else.** The toolbar menus are 60: over the tiles and rows they open onto, under
  every dialog and under the banner (150). They are `position: absolute` inside a
  `.mpop` wrapper, so they need no portal and cannot outlive their trigger.

Layer order has behavior attached, not just paint: one Escape closes **only the
top layer** (harness `escLayer()`, phone `closeTopOverlay()`), and the focus
trap is a **stack** (`trapStack`), so closing an inner dialog hands the keyboard
back to the modal that is still open — a single-slot trap retired the outer
dialog's trap for good. (PITFALLS #44 — layer order is behavior, not just
paint.)
Phone dialogs (`#file-sheet`, `#confirm`) dim harder (`rgba(0,0,0,.75)`) and
share the 400 slot; each modal's ✕ is a child of its own box, never of the
fixed overlay (there it positions against the viewport and strands itself in a
screen corner).

### Icons

Lucide stroke SVGs in `public/icons/`, rendered as **colorable CSS masks**:

```css
.ic { background-color: currentColor; mask: var(--m) center/contain no-repeat; }
.ic-copy { --m: url('/icons/clipboard-copy.svg'); }
```

Never inline SVG paths in JS/HTML when a mask class works. Size via
`font-size`/`width: 1em` context; 12–18px typical.

### Accessibility contract

- `prefers-reduced-motion` respected globally (see §6).
- **Non-text contrast (WCAG 1.4.11).** Every interactive control's boundary
  clears 3:1 against *both* the surface behind it and the fill inside it — see
  §1 for why that is two tokens and why `--ctl` is `#6e757c`. Text contrast was
  never the gap: the phone measured 6.0–15.6:1 on text while every shape sat at
  1.07–1.37:1, which is what made a screen full of buttons look like a screen
  full of grey rectangles.
- **Target size (WCAG 2.5.8).** Every interactive target is ≥28×28 CSS px — see
  §2. The phone was always at 44px+; the harness shipped 27×21 tile actions,
  27×23 density segments, a 38×22 switch, a 58×16 text toggle and a ~20px Undo
  pill, all of them reachable only after finding them.
- Focus-visible everywhere (accent outline), never removed without replacement.
- Destructive dialogs default to Cancel; Esc always cancels.
- Status messages use `role="status"` (phone flash, popup status). A live
  region must not BE the interactive element: the phone queue chip and the PC
  `#toasts` stack are wrappers with the announcer as a sibling/child, and the
  PC's ONE persistent live region is the visually empty `#toast-announcer`
  (`.sr-only`, written by `announce()`), because a region created with its
  content already inside it is often not announced at all. (PITFALLS #45.)
- Color is never the only signal: selection = ✓ badge + outline; failed tile =
  border + "not sent" banner; direction = icon + color. Anything drawn ONLY in
  CSS (badges, spinners, banners) is invisible to assistive tech — mirror the
  state into the element's accessible name (phone tiles: `setTileState`).
