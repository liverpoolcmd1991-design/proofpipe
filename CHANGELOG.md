# Changelog

All notable changes to ProofPipe are documented in this file.

## [1.27.0] — 2026-11-15

### Added
- **Liquid Glass Background & Panel Warp with Chromatic Rim Refraction (`public/index.html`, `public/style.css`, `public/app.js`)**: Added `#pp-bg-warp` — a full-viewport optical displacement lattice & caustic light pool behind the glass surfaces — paired with cached-rect pointer-reactive 3D perspective tilt, hyperbolic corner shear, press rebound, masked prismatic border refraction, and `--lgx`/`--lgy` caustic highlights across `.side`, `.workbench-card`, `.rail-card`, `.modal-box`, and interactive controls with zero per-frame layout reads.
- **Tactile Water Click Ripples, Phone PWA Panel Warp & Micro-Interactions (`public/style.css`, `public/app.js`, `public/phone.css`, `public/phone.js`, `public/sw.js`)**: Added `.pp-bg-warp` backdrop displacement plus elastic pointer/touch warping on `.status-strip`, `.alt-btn`, `#outbox-info`, and `#more-menu.open`, coordinate-accurate expanding water ripples on clicks/taps, `Copied ✓` pop pulses, send plane-launch animation, lightbox rotate spin, Settings gear twist, capture thumbnail specular sweep, and notification sheen sweeps (`proofpipe-v41`), gated behind `prefers-reduced-motion: reduce`.
- **Extension Popup & Tray Panel Warp, Caustics & Click Feedback (`extension/popup.html`, `extension/popup.js`, `extension/tray-ui.js`, `extension/content.js`)**: Added `#pp-ext-warp` background optical warp and elastic panel warping across popup cards (`.qsend`, `.tabs`, `.ext-advanced`, `.item`, `.titem`) and the Shadow-DOM floating tray (`.panel` & `.fab`), water click ripples, send launch swoosh, sync/reload spin, and copy confirmation pop while keeping capture tile drag-and-drop rock steady.

---

## [1.26.0] — 2026-11-15

### Changed
- **Server & SQLite Performance (`server.js`, `server/store.js`, `server/settings.js`, `server/captures.js`, `server/files.js`, `server/cleanup.js`, `server/mediadir.js`, `server/browser.js`)**: Converted `rotateCapture()` to single-pass `autoOrient().rotate(deg)` with incremental byte accounting, added a bounded 3-worker thumbnail queue, cached async asset-stamped HTML (`/` & `/phone`), eliminated sync `fs` checks on hot `/media/*` & browser detection paths, added SQLite indexes (`idx_texts_source_id`, `idx_texts_kind_id`, `idx_files_created_at`), skipped unused `recent` queries on default `/api/stats`, collapsed file batch-deletes into a single SQLite transaction, and bounded-parallelized retention/move loops.
- **Desktop Workbench Rendering & Transfers (`public/app.js`, `public/style.css`, `public/toPng.js`)**: Replaced full DOM rebuilds with ID-keyed reconciliation in `renderCaptures()`, `renderFiles()`, and `renderTexts()`, added a 24 MB PNG LRU cache with in-flight deduplication and async `ClipboardItem` writes, added 2-worker concurrent uploads, lightbox neighbor prefetching, 350ms debounced SSE stats refreshes, pre-indexed release search haystacks, immediate `OffscreenCanvas` zeroing in `toPng.js`, and removed per-tile `backdrop-filter` compositor layers in the capture grid.
- **Phone PWA Viewer, Outbox & Compositor (`public/phone-viewer.js`, `public/phone.js`, `public/phone-files.js`, `public/phone.css`)**: Cached `#viewer-stage` bounding rect on `touchstart`/`resize`/`orientationchange` for reflow-free pinch/pan gestures, bounded remote viewer full-res blobs to a 4-item LRU cleared on `hideViewer()`, switched `flushOutbox()` existence verification to lightweight `getKey()`, short-circuited empty IDB scans, zeroed temporary `tileUrl()` canvases, fixed multi-item `trimRecent()`, skipped redundant SSE-open and active-SSE `visibilitychange` reloads, and removed per-chip `backdrop-filter` blur inside horizontal strips.
- **Chromium Extension Discovery, Caching & DOM Scans (`extension/`)**: Batched idempotent GET/HEAD fallback discovery in `discovery.js`, capped SW `prefetch` map to 4 entries with immediate eviction after `mediaBlob` consumption, deduplicated content-script `thumbsPending`/`blobsPending` fetches, removed eager 5x background full-res prefetches on tray poll, added popup `popupPngCache` LRU & promise deduplication, cached capture/text search haystacks across `content.js`/`popup.js`, replaced `querySelectorAll('*')` array allocations with `TreeWalker` shadow-host discovery in `paste-logic.js`, and removed per-cell `backdrop-filter` blur in `tray-ui.js`.

---

## [1.25.0] — 2026-11-15

### Added
- **Capture Rotation & Batch Delete Endpoints (`server/store.js`, `server/captures.js`, `API.md`)**: Added `POST /api/captures/:id/rotate` (`deg` 90/180/270) with atomic thumbnail regeneration and `rev` version tracking in `GET /api/captures/version`, plus `{ ids }` selective batch deletion on `DELETE /api/captures`.
- **Desktop Lightbox, Capture Grid Multi-Select, Focus Trap & Liquid Glass Notification Dock (`public/index.html`, `public/style.css`, `public/app.js`)**: Added Fit/100%/200% zoom, pan, persistent 90° CW rotation, pixel dimensions (`W × H px`), `Phone`/`PC` origin badge, `N / Total` counter, Capture Grid batch selection (`#captures-select-btn`, `#captures-select-all`, `#captures-delete-selected`), `Tab`/`Shift+Tab` modal focus trapping with opener focus restoration, a non-blocking bottom-right Liquid Glass swipe-dismissible notification dock (`#pc-notif-dock`), initial shimmer skeletons (`#grid` / `#file-list`), and `#conn-banner` with manual `Retry now`; removed the duplicate rail Settings trigger (`#settings-btn`).
- **Mobile Viewer HUD/Gestures, Liquid Glass Toasts, Batch Selection & Offline Icon Sync (`public/phone.html`, `public/phone.css`, `public/phone-viewer.js`, `public/phone.js`, `public/sw.js`)**: Added a top viewer HUD bar, inline remote loading/retry, stage prev/next arrows, `syncRotFitScale()` rotation fitting, pinch-zoom, vertical swipe-to-dismiss, single-tap chrome toggle, `Save rotation` (server & IndexedDB outbox), `#select-toggle` / long-press `#batch-bar` multi-select, composer char count/URL badge/`Paste & Send`, Liquid Glass swipe-dismissible `.flash` & `#undo-toast`, and offline SW precaching for `chevron-left.svg` / `chevron-right.svg` (`proofpipe-v37`).
- **Extension Tray Quadrant Anchoring, Liquid Glass Page Toasts & Parity (`extension/`)**: Added dynamic 4-quadrant FAB anchoring (`placePanel()`) with clamped FAB restore positions, a non-blocking bottom-right Liquid Glass swipe-dismissible toast stack (`PPTrayUI.toast`), live search filtering, `Phone`/`PC` origin badges, per-item delete buttons, `Open Workbench`, live Auto-Paste target indicator (`Target: ...`), quick per-cell `Paste`, and unreachable-server recovery actions.

---

## [1.24.0] — 2026-11-14

### Added
- **Byte-Level Phone Photo Upload Progress (`public/phone.js`)**: Replaced indeterminate `fetch()` uploads with `XMLHttpRequest` (`xhr.upload.onprogress`) and a weighted concurrent transfer tracker driving the Liquid Glass status wave (`--xfer-scale`) and live percentage readout.
- **Two-Way Extension Quick Send (`extension/popup.html`, `extension/popup.js`, `extension/background.js`, `extension/manifest.json`)**: Added an inline text/URL composer (`Enter` sends), one-click active `Tab Link` sender, and one-click visible `Screenshot` uploader (`activeTab` + `/upload`, delivered live to phone and desktop workbench).
- **Cross-Platform Daemon CLI & Windows System Tray (`scripts/daemon.js`, `scripts/tray.ps1`, `ProofPipe.vbs`, `ProofPipe.bat`)**: Added detached daemon management (`npm run daemon -- start|stop|restart|status|logs|tray|autostart`), log rotation, OS login autostart configuration, a native WinForms `NotifyIcon` tray controller, and a zero-console GUI-subsystem launcher (`ProofPipe.vbs`).

### Changed
- **Extension Liquid Glass Overhaul & Cleanup (`extension/`)**: Unified the in-page floating tray (`content.js`), toolbar popup, and context-menu toasts onto the dark Liquid Glass palette while removing deprecated `dataUrl` base64 relay paths and duplicate inline styles.
- **Full-Repo Dead Code & Asset Cleanup**: Removed unreferenced screenshots (`public/assets/`), unused SVG/CSS tokens and selectors (`public/style.css`, `public/phone.css`, `public/icons/activity.svg`), unreferenced DOM IDs (`public/index.html`), dead share/message shims (`public/phone.js`, `extension/content.js`, `public/sw.js`), unused `bun.lock`, and stale version placeholders (`API.md`, `public/index.html`).

---

## [1.23.0] — 2026-11-08

### Added
- **PC Destructive Action Safety & Undo (`public/index.html`, `public/app.js`)**: Added a Liquid Glass confirmation dialog (`#pc-confirm-backdrop`) for bulk destructive actions (`Clear All`, `Clear Files`, `Remove Selected`, `Clear History`) and a 5-second Undo snackbar (`#pc-undo-toast`) for single-item photo, file, and message deletions.
- **Two-Way Photo Sync & Sectioned Phone Inbox (`public/phone.js`, `public/phone.html`)**: PC-origin captures now appear automatically in the phone's gallery with a `PC` badge (`#recent .ok-badge.pc-origin`), and the phone's PC inbox lane includes a clear `From your PC` section header.
- **Live PC Upload Progress (`#pc-transfer-pill`) & Full-Window Drop Overlay (`#drop-hint`)**: Replaced bare `fetch` uploads on the PC workbench with `XMLHttpRequest` upload progress tracking (`xhr.upload.onprogress`) and upgraded drag-and-drop to a non-layout-shifting full-window glass overlay with `dragDepth` tracking.
- **Hover Photo Actions, Copyable Pairing Link & Structured Message Rows**: Replaced cramped 4-button photo card footers with floating glass hover actions + primary `Copy` footer, added a one-click copyable phone URL pill under the pairing QR code, and added directional `Phone`/`PC` origin badges, timestamps, and `Open ↗` URL links to the Messages & Clipboard dock.
- **Liquid Glass Chrome Extension Popup (`extension/popup.html`)**: Overhauled the extension popup to the deep-space Liquid Glass palette with segmented pill tabs and a collapsible `Connection & site options` drawer.

### Changed
- **Unified Auto-Save in System Settings**: Storage ceiling and retention inputs now auto-save with debounced feedback (`#settings-save-state`) alongside toggle switches and custom popover selects.
- **Per-Route Multipart Body Limits & Pre-Compiled SQL**: Scoped the 21 MB multipart body limit strictly to `/upload` and `/share`, added explicit `kind: "media"` classification in `POST /api/text`, and pre-compiled all hot-path SQLite statements.

---

## [1.22.0] — 2026-10-24

### Added
- **Hot Media Folder Relocation (`POST /api/media-dir/move`)**: Relocate the active capture directory at runtime with cross-volume copy+fsync fallback, collision checking, and rollback on failure.
- **Native Folder Picker (`POST /api/media-dir/pick`)**: Added an OS-native folder selection endpoint on Windows (`FolderBrowserDialog` via PowerShell) with single-flight locking.
- **Scheduled Hot Backups (`server/backup.js`)**: Automated daily SQLite snapshots (`VACUUM INTO`) paired with media hard-link trees (or copy fallback) and retention pruning down to the newest 3 backups.

---

## [1.21.0] — 2026-09-18

### Added
- **In-Viewer Photo Rotation (`POST /api/captures/:id/rotate`)**: Rotate stored captures by 90°, 180°, or 270° directly from the phone viewer; rewrites both the primary image and its 256px WebP thumbnail atomically.
- **Coalesced Multi-File Deletion (`DELETE /api/files`)**: Bulk file deletion emits a single coalesced SSE frame containing all removed IDs so connected clients update state without N-way refetch storms.
- **Extended Thumbnail Retry Window**: Increased phone thumbnail retry backoff to 12 attempts (up to 5s ceiling) to tolerate large rate-limited upload bursts.

---

## [1.20.0] — 2026-08-12

### Added
- **Bi-Directional File Pipe (`server/files.js`)**: Stream arbitrary files up to 500 MB between PC and phone via `/api/files` with safe filename sanitization, content-disposition download headers, and atomic temp-to-final disk writes.
- **Rate-Limit Backpressure Recovery**: Phone upload worker pool pauses for 1.5s on HTTP `429` responses so token buckets refill without dropping active captures into the offline fallback queue.
- **Phone Sort Order Persistence**: Added Newest, Oldest, and Name sorting across phone captures and inbox lanes, persisted in `localStorage`.

---

## [1.18.0] — 2026-07-04

### Added
- **Chromium Floating Drag Tray (`extension/content.js`)**: Added an in-page floating tray for pages where synthetic clipboard paste is restricted, supporting native HTML5 drag-and-drop of PNG captures and files.
- **PNG Data-URL Pre-Conversion (`extension/toPng.js`)**: Converts JPEG and WebP captures into PNG in the extension offscreen document so strict paste targets accept image drops cleanly.
- **ProseMirror & Lexical Paste Target Engine (`extension/paste-logic.js`)**: Dedicated target discovery and synthetic `ClipboardEvent('paste')` dispatch for rich-text editors used by Claude, ChatGPT, Gemini, and Notion.

---

## [1.15.0] — 2026-05-29

### Added
- **IndexedDB Offline Outbox (`public/queue.js`)**: Captures taken while offline or disconnected from Wi-Fi are persisted in IndexedDB with exponential backoff + jitter and drained automatically when SSE or polling reconnects.
- **Content-Hashed Deduplication**: Server computes SHA-256 content hashes over uploaded image buffers inside a 10-second sliding window so retried requests return the existing capture row idempotently.
- **Client-Side JPEG Quality Control**: Phone PWA supports configurable client-side canvas downscaling and JPEG quality presets before upload.

---

## [1.10.0] — 2026-04-15

### Added
- **Bi-Directional Text & Link Pipe (`/api/text`)**: Send text snippets and URLs between phone and PC with real-time SSE broadcast and one-tap clipboard copy.
- **QR Pairing & Multi-NIC Switcher (`/qr.png`, `/api/lan`)**: Dynamic QR code generation for instant phone pairing, with automatic filtering of virtual adapters (WSL, Hyper-V, Docker, VPNs) and manual subnet selection.
- **Automatic Storage Eviction (`server/cleanup.js`)**: Enforces `MAX_STORAGE_MB` (evicting down to 80% high-water mark) and `RETENTION_DAYS` age limits across captures and orphan files.

---

## [1.0.0] — 2026-03-01

### Added
- **Initial Release**: Fastify + `better-sqlite3` local capture server, `sharp` WebP thumbnail pipeline, `/events` Server-Sent Events hub, Phone camera PWA (`/phone`), and Chromium MV3 auto-paste extension.