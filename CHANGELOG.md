# Changelog

All notable changes to ProofPipe are documented in this file.

## [1.23.0] — 2026-11-07

### Added
- **Streamlined What's New Web Page**: Replaced the legacy desktop workbench at `/` with a focused release history page detailing what each ProofPipe version adds, with interactive component filters (`Server & Storage`, `Phone PWA`, `Chrome Extension`) and instant search.
- **Explicit Media Kind on Text Shares**: Added explicit `kind: "media"` classification in `POST /api/text` alongside URL fallback detection so PC-shared captures are unambiguously typed in the `texts` table.

### Changed
- **Per-Route Multipart Body Limits**: Reduced the default Fastify `bodyLimit` from 21 MB to 1 MB globally while scoping the 21 MB limit strictly to `/upload` and `/share`.
- **Documentation Overhaul**: Replaced legacy UI/pixel-measurement documentation with concise architectural, API, convention, and release docs.

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