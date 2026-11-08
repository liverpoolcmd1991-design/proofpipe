# ProofPipe API Contract

HTTP and Server-Sent Events (SSE) contract between ProofPipe clients (Phone PWA, Chrome extension, and web page) and the local Fastify server. Guarded by `test/api-docs.test.js`.

- **Base URL**: `SCHEME://<lan-ip>:<port>` (default `http://<lan-ip>:8787`, see `GET /api/lan`).
- **Content**: JSON unless noted. Uploads use `multipart/form-data`.
- **CSRF & Rate Limiting**: Mutating requests require a same-origin request or the authorized `chrome-extension://` origin. Mutations are rate-limited per IP by token bucket (`429` indicates the caller should pause ~1.5s).

---

## HTML Shells

### `GET /`
Serves `public/index.html` (the ProofPipe desktop workbench, including the built-in System Settings modal sheet) with `__PP_VERSION__`, `__ASSET_STYLE__`, and `__ASSET_APP__` stamped at request time.

### `GET /phone`
Serves `public/phone.html` (the mobile capture PWA shell) with `__PP_VERSION__`, `__ASSET_PHONE_STYLE__`, and `__ASSET_PHONE__` stamped and `Cache-Control: no-store`.

---

## Uploads (Photos & Shares)

### `POST /upload`
Store one photo capture (`multipart/form-data`, 21 MB body limit, 20 MB per-file cap, 64 MP pixel limit).
- `source`: `'phone'` | `'pc'` (sent before `photo`)
- `photo`: image file part
- `auto`: optional `'1'`/`'true'` auto-paste flag
- `key`: optional idempotency key (`^[A-Za-z0-9_-]{8,32}$`)

Returns `{ "id": 12, "file": "1717000000000-abc123.jpg", "duplicate": true }`.

### `POST /share`
Web Share Target endpoint (`multipart/form-data`, 21 MB body limit). Stores shared image parts as phone captures and shared text/title/url fields as phone-to-PC text entries, then responds with `303` redirect to `/phone?shared=1`.

---

## Captures

### `GET /api/captures?limit=100&before=<id>`
Newest-first keyset-paginated list of stored captures (`limit` clamped to `1..200`, default `100`).

### `GET /api/captures/version`
Lightweight change-detection fingerprint: `{ "n": 87, "latest": 12, "textId": 4 }`.

### `DELETE /api/captures`
Delete all captures from SQLite and disk. Returns `{ "ok": true, "deleted": 87 }`.

### `DELETE /api/captures/:id`
Delete a single capture by ID. Returns `{ "ok": true }` or `404`.

---

## Files (Arbitrary File Transfer)

### `POST /api/files`
Upload a file (`multipart/form-data`, up to `MAX_FILE_BYTES`). Place `dir` (`'phone'` | `'pc'`) before the file part. Returns the stored file record.

### `GET /api/files?limit=20&before=<id>`
Newest-first keyset-paginated list of transferred files (`limit` clamped to `1..200`).

### `GET /api/files/version`
Returns `{ "n": 3, "latest": 3 }`.

### `GET /file/:id`
Streams the stored file with HTTP `Range` support (`206 Partial Content`) and `Content-Disposition`.

### `DELETE /api/files/:id`
Delete a single transferred file by ID. Returns `{ "ok": true }` or `404`.

### `DELETE /api/files`
Delete all transferred files (when called with no body) or a specific set of IDs (`{ "ids": [3, 4] }`). Broadcasts a single coalesced `file-deleted` SSE event.

---

## Texts (Bi-Directional Text & Media Links)

### `POST /api/text`
Store a text message (`{ "body": string, "source": "phone"|"pc", "kind"?: "text"|"media" }`). Trimmed and capped at 10,000 characters. Explicit `kind: "media"` or URLs matching `/media/` are stored with `kind: 'media'` (retained up to 200 rows); plain texts are stored with `kind: 'text'` (retained up to 20 rows).

### `GET /api/text?source=phone|pc&limit=10`
List recent text rows (`limit` clamped to `1..20`, default `10`).

### `DELETE /api/text?source=phone|pc`
Clear text rows (optionally filtered by `source`). Returns `{ "ok": true, "removed": n }`.

### `DELETE /api/text/:id`
Delete a single text row by ID. Returns `{ "ok": true, "removed": 1 }`.

---

## Status, Discovery & Settings

### `GET /api/lan?device=phone&outbox=<n>`
Returns LAN IPv4 addresses, port, and scheme (`{ "ips": [...], "port": 8787, "scheme": "http" }`). When called with `device=phone`, records a phone presence heartbeat and outbox count.

### `GET /api/stats`
Returns server version, capture count and byte usage, storage cap, file count/bytes, active media directory, phone presence status, and the 3 most recent arrivals.

### `GET /api/version`
Returns `{ "version": "v1.23.0" }`.

### `POST /api/open-latest`
Broadcasts an `open-latest` event and opens the newest capture on the host PC.

### `GET /api/settings`
Returns the aggregated server settings bundle (`version`, `autoPaste`, `autoCleanup`, `filesInbox`, `quality`, `storageCap`, `retention`, `inboxDir`, `mediaDir`, `browser`).

### `GET /api/autopaste`
Returns `{ "auto": false }`.

### `POST /api/autopaste`
Updates the default auto-paste setting (`{ "auto": boolean }`).

### `GET /api/quality`
Returns `{ "on": false, "level": 80, "maxPixels": 64000000 }`.

### `POST /api/quality`
Updates client compression preferences (`{ "on": boolean, "level": 1..100 }`).

### `GET /api/files-inbox`
Returns `{ "on": true }`.

### `POST /api/files-inbox`
Controls whether phone-uploaded files are automatically copied to the PC inbox directory (`{ "on": boolean }`).

### `GET /api/autocleanup`
Returns `{ "on": false, "cap": 524288000, "used": 178400000 }`.

### `POST /api/autocleanup`
Enables or disables automatic storage cleanup at 80% of the cap (`{ "on": boolean }`).

### `GET /api/storage-cap`
Returns `{ "capMb": 500, "custom": false }`.

### `POST /api/storage-cap`
Sets the capture storage cap in MB (`50..1048576` or `null` for default).

### `GET /api/retention`
Returns `{ "days": 0 }`.

### `POST /api/retention`
Sets the capture retention window in days (`0..3650`, where `0` disables age-based eviction).

### `GET /api/inbox-dir`
Returns `{ "path": null, "def": ".../data/inbox" }`.

### `POST /api/inbox-dir`
Sets or resets (`null`) the PC file inbox directory path.

### `GET /api/media-dir`
Returns `{ "path": "...", "def": "..." }`.

### `POST /api/media-dir`
Relocates the captures, files, and inbox directories atomically to a new writable absolute path, rolling back on error.

### `GET /api/browsers`
Lists detected browsers on Windows and the active target browser ID.

### `POST /api/browsers`
Selects the target browser ID (`"default"` or a detected browser ID) for auto-paste filtering.

### `POST /api/pick-folder`
Loopback-only Windows helper that opens a native folder picker dialog and returns `{ "path": "..." }` or `{ "cancelled": true }`.

### `POST /api/backup`
Loopback-only Windows helper that checkpoints SQLite inside a write transaction and creates a timestamped backup archive in the specified `{ "dir": "..." }`.

### `GET /qr.png?ip=<lan-ip>`
Generates a PNG QR code encoding `SCHEME://<ip>:<port>/phone` (`Cache-Control: no-store`).

---

## Media Serving & Event Stream

### `GET /media/<stored-name>` and `GET /media/t-<stored-name>`
Streams a stored capture or its WebP/PNG thumbnail with immutable cache headers and HTTP `Range` support (`206`).

### `GET /events`
Server-Sent Events stream (`text/event-stream`). Emits `capture`, `capture-ready`, `file`, `file-deleted`, `text`, `deleted`, `settings`, `open-latest`, and `phone` events.