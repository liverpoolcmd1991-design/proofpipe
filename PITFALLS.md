# Pitfalls & Platform Gotchas

Operational lessons and platform constraints across the Node.js server, SQLite storage, and Chromium Manifest V3 extension.

## 1. Node.js, Fastify & Storage

### 1.1 `UV_THREADPOOL_SIZE` must be set before first libuv work
Node.js initializes the libuv threadpool on the first async I/O or native addon load. `scripts/threadpool.cjs` (via `--require`) and the top of `server.js` set `UV_THREADPOOL_SIZE` before `sharp` is imported so thumbnail encoding cannot starve file I/O.

### 1.2 Fastify multipart stream truncation vs. `bodyLimit`
`@fastify/multipart` enforces its own `limits.fileSize` and sets `file.truncated = true` when exceeded. Always check `data.file.truncated` after reading a multipart stream and delete any partial temp file before returning HTTP `413`.

### 1.3 Cross-volume `fs.renameSync` (`EXDEV`)
Moving files or relocating the media directory across different drives or mount points throws `EXDEV`. Always fall back to copy + `fsync` + unlink when `renameSync` fails with `EXDEV`.

### 1.4 SQLite WAL checkpoints and hot backups
Never copy `proofpipe.db` while uncommitted frames remain in `proofpipe.db-wal`. `server/backup.js` acquires a write lock (`BEGIN IMMEDIATE`) and runs `PRAGMA wal_checkpoint(TRUNCATE)` so the main database file is self-contained before archiving.

### 1.5 Idempotent capture deduplication
When a phone retries an upload after a dropped connection, it sends the same client-generated `dedupe_key` (`key` field). `server/store.js` enforces a unique index (`idx_captures_dedupe`) and returns the existing row with `duplicate: true` on `SQLITE_CONSTRAINT_UNIQUE`, preventing duplicate captures and repeated extension auto-pastes.

---

## 2. Chromium MV3 Extension & Synthetic Paste

### 2.1 MV3 Service Worker lifetime and SSE
Chromium terminates idle MV3 background service workers after ~30 seconds, which drops direct `EventSource` connections. Keep the `EventSource('/events')` inside the offscreen document (`extension/offscreen.js`) and relay incoming frames to `background.js` via `chrome.runtime.sendMessage`.

### 2.2 ContentEditable / ProseMirror paste dispatch
Modern AI chat inputs (ProseMirror, Lexical, Quill) often ignore `document.execCommand('insertText')` for images and listen instead to `ClipboardEvent('paste')` carrying a `DataTransfer` with a `File` item. `extension/paste-logic.js` constructs a synthetic `ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })` and dispatches it directly on the active editor node.

### 2.3 PNG conversion for strict clipboard targets
Several web targets reject `image/webp` or `image/jpeg` blobs in synthetic paste or drag-and-drop events. Converting captures to `image/png` via an offscreen canvas (`toPng.js`) ensures compatibility across browsers and editors.

---

## 3. Testing & CI

### 3.1 Port range isolation across concurrent test files
`node --test` runs test files in parallel processes. Every test suite that spawns `server.js` must allocate ports through `nextPort()` in `test/port-ranges.js` (which hashes the test filename into a disjoint port block) so parallel suites never collide on `EADDRINUSE`.
