# ProofPipe

ProofPipe is a local-network sync server, mobile Progressive Web App (PWA), and Chromium Manifest V3 extension that pipes photos, text, and files between a phone and a PC over LAN with zero cloud dependencies.

## Components

1. **Local Fastify + SQLite Server (`server.js` & `server/`)**
   - Stores captures, bi-directional text history, transferred files, and runtime configuration in built-in SQLite (`node:sqlite`, `data/proofpipe.db`, WAL mode) with media blobs on disk (`data/media/` and `data/files/`).
   - Broadcasts real-time Server-Sent Events (`/events`) to connected browser extensions and phone clients.
   - Enforces automatic storage eviction, consistent SQLite backups, and token-bucket rate limiting.

2. **Desktop Workbench (`public/index.html`, `public/app.js`, `public/style.css`)**
   - **Desktop Workbench (`/`)**: Live capture library, bi-directional Messages & Clipboard dock, file transfer manager, System Settings modal, and LAN QR pairing rail.

3. **Phone Capture PWA (`public/phone.html`, `public/phone.js`, `public/phone.css`)**
   - Served at `http://<lan-ip>:8787/phone`.
   - Provides one-tap camera shutter, photo gallery upload, file upload, and a full-screen text editor for bi-directional text sharing.
   - Queues captures in IndexedDB (`public/queue.js`) when offline or out of Wi-Fi range and drains them automatically on reconnect.

4. **Chromium Auto-Paste Extension (`extension/`)**
   - Manifest V3 extension that subscribes to `/events` via an offscreen document and injects newly arrived phone captures or texts directly into the active browser tab (or staging tray).

## Quick Start

Requires **Node.js 22+** (uses built-in `node:sqlite`).

```bash
npm install
npm start
```

- Open `http://localhost:8787` to access the desktop workbench and scan the LAN pairing QR code with your phone.
- Load `extension/` as an unpacked extension in `chrome://extensions` (Developer Mode) to enable automatic paste and drag-tray integration.

## Scripts

- `npm start` — Start the server (preloads `scripts/threadpool.cjs` to size `UV_THREADPOOL_SIZE` before libuv initializes).
- `npm run daemon -- <start|stop|restart|status|logs|tray|autostart>` — Manage the detached background daemon and OS login autostart (plus `ProofPipe.bat` / `ProofPipe.bat --console` on Windows).
- `npm test` — Run all automated test suites (`node --test "test/*.test.js"`).
- `npm run lint` — Run ESLint across server, client, extension, and test files.
- `npm run icons` — Regenerate PNG icon assets from source vector primitives.
- `npm run gen-cert` — Generate optional self-signed TLS certificates for HTTPS LAN mode.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | HTTP listen port (`1`–`65535`). |
| `HOST` | `0.0.0.0` | Bind address. |
| `DATA_DIR` | `./data` | Root directory for SQLite DB, media, files, and backups. |
| `MAX_STORAGE_MB` | `2048` | Storage ceiling in MB (`50`–`500000`) before automatic eviction. |
| `RETENTION_DAYS` | `30` | Maximum capture age in days (`1`–`3650`). |
| `HTTPS_PORT` | `0` | Optional HTTPS port when `data/certs/` exists (`0` disables). |
