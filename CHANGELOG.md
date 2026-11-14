# Changelog

All notable changes to ProofPipe are documented in this file.

## [1.24.0] — 2026-11-14

### Added
- **Byte-Level Phone Photo Upload Progress (`public/phone.js`)**: Replaced indeterminate `fetch()` uploads with `XMLHttpRequest` (`xhr.upload.onprogress`) and a weighted concurrent transfer tracker driving the Liquid Glass status wave (`--xfer-scale`) and live percentage readout.
- **Two-Way Extension Quick Send (`extension/popup.html`, `extension/popup.js`, `extension/background.js`, `extension/manifest.json`)**: Added an inline text/URL composer (`Enter` sends), one-click active `Tab Link` sender, and one-click visible `Screenshot` uploader (`activeTab` + `/upload`, delivered live to phone and desktop workbench).
- **Cross-Platform Daemon CLI & Windows System Tray (`scripts/daemon.js`, `scripts/tray.ps1`, `ProofPipe.bat`)**: Added detached daemon management (`npm run daemon -- start|stop|restart|status|logs|tray|autostart`), log rotation, OS login autostart configuration, and a native WinForms `NotifyIcon` tray controller.

### Changed
- **Extension Liquid Glass Overhaul & Cleanup (`extension/`)**: Unified the in-page floating tray (`content.js`), toolbar popup, and context-menu toasts onto the dark Liquid Glass palette while removing deprecated `dataUrl` base64 relay paths and duplicate inline styles.

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