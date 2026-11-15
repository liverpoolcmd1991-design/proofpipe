# ProofPipe

ProofPipe is a local-network sync server, mobile Progressive Web App (PWA), and Chromium Manifest V3 extension that pipes photos, text, and files between a phone and a PC over LAN with zero cloud dependencies.

## Components

1. **Local Fastify + SQLite Server (`server.js` & `server/`)**
   - Stores captures, bi-directional text history, transferred files, and runtime configuration in built-in SQLite (`node:sqlite`, `data/proofpipe.db`, WAL mode) with media blobs on disk (`data/captures/`, `data/files/`, and `data/inbox/`).
   - Broadcasts real-time Server-Sent Events (`/events`) to connected browser extensions, workbench tabs, and phone clients.
   - Modularized into `store.js`, `captures.js`, `files.js`, `text.js`, `settings.js`, `lockfile.js`, `cleanup.js`, `backup.js`, `mediadir.js`, `browser.js`, `sse.js`, `ratelimit.js`, `bytes.js`, and `util.js`.

2. **Desktop Workbench (`public/index.html`, `public/app.js`, `public/style.css`, `public/shared.js`, `public/releases.js`)**
   - Served at `/`: live capture library, bi-directional Messages & Clipboard dock, file transfer manager, System Settings modal, What's New dialog, and LAN QR pairing rail.

3. **Phone Capture PWA (`public/phone.html`, `public/phone.js`, `public/phone-viewer.js`, `public/phone-files.js`, `public/phone.css`, `public/queue.js`, `public/sw.js`)**
   - Served at `http://<lan-ip>:8787/phone` (or `https://` when TLS certs exist).
   - Provides one-tap camera shutter, photo gallery upload with live XHR progress, file upload, fullscreen zoom/rotate viewer, full-screen text editor, and durable IndexedDB offline queues.

4. **Chromium Auto-Paste Extension (`extension/`)**
   - Manifest V3 extension (`background.js`, `offscreen.js`, `discovery.js`, `tray-ui.js`, `content.js`, `paste-logic.js`, `files.js`, `popup.js`, `toPng.js`) that relays `/events`, supports one-click Quick Send (note/URL, active tab link, visible screenshot), and injects captured items directly into active browser editors or via the floating Liquid Glass drag tray.

## Quick Start

Requires **Node.js 22+** (uses built-in `node:sqlite`).

```bash
npm install
npm start
```

- Open `http://localhost:8787` to access the desktop workbench and scan the LAN pairing QR code with your phone.
- Load `extension/` as an unpacked extension in `chrome://extensions` (Developer Mode) to enable automatic paste, Quick Send, and the floating capture tray.

## Scripts

- `npm start` — Start the server (preloads `scripts/threadpool.cjs` to set `UV_THREADPOOL_SIZE=16` before libuv initializes).
- `npm run daemon -- <start|stop|restart|status|logs|tray|autostart>` — Manage the detached background daemon and OS login autostart (on Windows, double-click `ProofPipe.vbs` for zero-console tray-only mode, or run `ProofPipe.bat --console` for a foreground terminal).
- `npm test` — Run all automated test suites (`node --test "test/*.test.js"`).
- `npm run build` / `npm run lint` — Run ESLint across server, client, extension, dev utilities, and test files.
- `npm run icons` — Regenerate PNG icon assets from source vector primitives.
- `npm run gen-cert` — Generate optional self-signed TLS certificates (`data/key.pem` & `data/cert.pem`) to enable HTTPS LAN mode automatically.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | Listen port for HTTP (or HTTPS when `data/key.pem` and `data/cert.pem` exist). |
| `PP_DATA` | `./data` | Root directory for `proofpipe.db`, `settings.json`, media, files, and backups. |
| `PP_MAX_STORE_MB` | `500` | Default capture auto-cleanup threshold in MB before runtime Settings override. |
| `PP_MAX_FILES_MB` | `2000` | Default transferred-files storage cap in MB for eviction sweeps. |
| `PP_MAX_FILE_MB` | `1024` | Maximum single file upload size in MB for `/api/files`. |
| `PP_RATE_CAPACITY` | `120` | Token-bucket burst capacity for photo uploads. |
| `PP_RATE_REFILL_PER_MIN` | `240` | Token-bucket refill rate per minute for photo uploads. |
| `PP_FILE_RATE_CAPACITY` | `60` | Token-bucket burst capacity for file transfers. |
| `PP_FILE_RATE_REFILL_PER_MIN` | `60` | Token-bucket refill rate per minute for file transfers. |
| `PP_OPEN_BROWSER` | `0` | Set to `1` to open the desktop workbench automatically once listening. |
| `PP_EXTENSION_ID` | *(from `extension/manifest.json`)* | Optional 32-char extension ID override for CSRF origin pinning. |
| `PP_LOG` | *(unset)* | Set to `1`, `debug`, or `trace` for verbose request logging. |
| `UV_THREADPOOL_SIZE` | `16` | Libuv threadpool size used by `sharp` image processing and SQLite I/O. |
