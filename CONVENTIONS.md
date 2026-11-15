# Conventions

This document defines the directory layout, architectural boundaries, and coding conventions for ProofPipe.

## 1. Repository Layout

| Path | Responsibility |
|---|---|
| `server.js` | Fastify bootstrap, SQLite schema migrations & prepared statements, static asset stamping, and lifecycle hooks. |
| `server/sqlite.js` | Built-in `node:sqlite` (`DatabaseSync`) adapter with transactional helper (`db.transaction(fn)`). |
| `server/store.js` | Capture ingestion (`sharp` header validation, EXIF auto-orient, WebP thumbnail generation, idempotent `dedupe_key` deduplication) and in-flight file-read tracking. |
| `server/captures.js` | Capture list/version/clear/delete routes and multipart `/upload` & `/share` handlers. |
| `server/files.js` | Streaming multipart file upload (`<= 500 MB`), listing, download, and deletion routes. |
| `server/text.js` | Two-way text/link relay routes (`POST /api/text`, `GET /api/text`, `DELETE /api/text`, `DELETE /api/text/:id`). |
| `server/settings.js` | Persistent settings (`settings.json`), `/api/settings`, `/api/autopaste`, `/api/autocleanup`, `/api/quality`, `/api/lan`, and `/api/stats` routes. |
| `server/lockfile.js` | Single-instance PID lock manager (`acquireLock`, `releaseLock`) probing stale instances before cleanup. |
| `server/cleanup.js` | Storage cap (`PP_MAX_STORE_MB` / `PP_MAX_FILES_MB`), age (`retentionDays`), and orphan-file eviction sweeps. |
| `server/backup.js` | Consistent SQLite WAL checkpoint + archive creation and multipart restore. |
| `server/mediadir.js` | Runtime capture directory validation, native folder picker, and safe directory migration. |
| `server/browser.js` | Local URL launch and clipboard copy helpers for the host OS. |
| `server/sse.js` | Server-Sent Events (`/events`) client registry, keepalive pings, and broadcast fan-out. |
| `server/ratelimit.js` | In-memory token-bucket rate limiter per IP and route category. |
| `server/bytes.js` | Centralized disk-usage byte counter across captures, thumbnails, and shared files. |
| `server/util.js` | Pure validation, image magic-byte sniffing, LAN IP discovery, filename sanitization, and env clamping utilities. |
| `public/index.html`, `public/app.js`, `public/style.css` | Desktop workbench (`/`): capture library, Messages & Clipboard dock, file transfer manager, System Settings modal, and QR pairing rail. |
| `public/shared.js`, `public/releases.js` | Shared browser helpers (`PPShared`: byte/time formatting, `xhrPost`) and structured release history (`PP_RELEASES`). |
| `public/phone.html`, `public/phone.js`, `public/phone.css` | Mobile capture PWA (camera shutter, gallery/file picker, full-screen text editor, and offline outbox). |
| `public/phone-viewer.js`, `public/phone-files.js` | Extracted Phone PWA modules for the fullscreen zoom/rotate capture viewer (`PPPhoneViewer`) and bi-directional file transfer/outbox sheet (`PPPhoneFiles`). |
| `public/queue.js` | Pure retry/backoff state machine shared by the phone offline outbox and unit tests. |
| `public/sw.js` | Service worker for the phone PWA shell. |
| `extension/` | Chromium Manifest V3 extension (`background.js`, `offscreen.js`, `discovery.js`, `tray-ui.js`, `content.js`, `paste-logic.js`, `files.js`, `popup.js`, `toPng.js`). |
| `scripts/` | Cross-platform background daemon CLI (`daemon.js`), Windows system tray launcher (`tray.ps1`, `ProofPipe.vbs`, `ProofPipe.bat`), threadpool preload, and build/test helpers. |
| `test/*.test.js` | Node.js built-in test runner suites (`node --test`). |

## 2. Server & Storage Rules

1. **Threadpool Sizing Before Native Imports**: `server.js` sets `process.env.UV_THREADPOOL_SIZE ||= '16'` before dynamically importing `sqlite` and `sharp` (and `npm start` preloads `scripts/threadpool.cjs`). Never move native imports above the `UV_THREADPOOL_SIZE` assignment.
2. **Prepared Statements Only**: All SQLite queries are pre-compiled at startup in `server.js` (`stmts`). Route handlers and cleanup sweeps call `stmts.*.get()` / `.all()` / `.run()` without runtime `db.prepare()` compilation.
3. **Scoped Body Limits**: Keep the default Fastify `bodyLimit` small (1 MB) for JSON routes; declare larger `bodyLimit` values explicitly on upload routes (`/upload`, `/share`, `/api/files`, `/api/restore`).
4. **Best-Effort Disk Cleanup**: File unlinks during deletion or rollback use `rmWithRetry` or `try { fs.unlinkSync(...) } catch {}` so a missing file on disk never blocks database row removal.

## 3. Client & Extension Scripts

1. **Classic Browser Scripts**: Files in `public/` and `extension/` run directly in the browser without a bundler. Cross-file globals (`PPShared`, `PP_RELEASES`, `PPPhoneViewer`, `PPPhoneFiles`, `PPQueue`, `PPDiscovery`, `PPPasteLogic`, `PPBrowserTarget`, `PPFiles`, `PPTrayUI`, `toPng`) are declared in `eslint.config.js`.
2. **Cache-Busted Shell Assets**: `server.js` stamps `__PP_VERSION__`, `__ASSET_APP__`, `__ASSET_STYLE__`, `__ASSET_SHARED__`, `__ASSET_RELEASES__`, and versioned `/phone` script tags with 10-character SHA-1 content hashes at startup.

## 4. Testing & Linting

- **Single Lint Gate**: `npm run lint` runs `eslint .` across server ESM modules, browser scripts, extension scripts, dev utilities, and test files.
- **Isolated Test Ports**: Every test suite that boots `server.js` reserves its own port via `test/port-ranges.js` and creates an isolated `DATA_DIR` in `os.tmpdir()`.
- **API Documentation Sync**: `test/api-docs.test.js` verifies that every route registered on the Fastify instance is documented in `API.md` and vice versa.

## 5. Versioning

When shipping user-visible features or protocol changes:
1. Bump `"version"` in `package.json`.
2. Add a release entry in `public/releases.js` and `CHANGELOG.md`.
3. Run `npm run lint` and `npm test` before committing.
