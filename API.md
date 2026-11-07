# ProofPipe API Contract

Authoritative HTTP + SSE contract between the phone client (PWA, and the native Android app) and the ProofPipe PC server. Hand-maintained, but **guarded**: `test/api-docs.test.js` parses every `app.<method>('…')` registration out of `server.js` and `server/*.js` and fails the build if a route is missing here (or if a route documented here no longer exists). When that test fails, add the route below — do not weaken the test.

**Base URL:** the PC's LAN origin, `SCHEME://ip:PORT` (default `http://<lan-ip>:8787`, scheme `http` — see `GET /api/lan`).

**Content:** JSON unless noted. Multipart uploads use `multipart/form-data`.

**Auth/CSRF:** mutations require a same-origin request (the phone PWA passes via host match). A native app posts from its own origin — if the server's CSRF check rejects it, add the app as a trusted origin (see `csrfSafe` in `server.js`). The browser extension is trusted only when its origin is **exactly** the id derived from `extension/manifest.json`'s `key` (override with `PP_EXTENSION_ID` for a packed build); any other `chrome-extension://` origin is refused like a cross-site request. All mutations are rate-limited per IP (photo bucket / file bucket); a `429` means back off ~1.5s for the whole class.

---

## Shells (HTML)

The server renders both HTML shells through handlers (not the static mount) so
the version and the content-hashed asset URLs can be injected per request.

### `GET /`
The PC harness shell (`public/index.html`). `__PP_VERSION__` is replaced with
`PP_VERSION`, and `__ASSET_STYLE__` / `__ASSET_APP__` with the SHA-1 content
stamps of `style.css` / `app.js` — a byte change to either asset revs its own
URL, so no manual version bump is needed for asset tweaks. Served with
`Cache-Control: public, max-age=86400, must-revalidate`.

### `GET /phone`
The phone PWA shell (`public/phone.html`). Same stamping for `phone.css` /
`phone.js`, but served `no-store` — a cached document rendered against newer
stamped assets is what shredded the phone layout after updates.

---

## Uploads (photos / captures)

### `POST /upload`
Store one photo capture. Multipart fields, in this order:

| field | required | value |
|---|---|---|
| `source` | yes | `phone` \| `pc` — must be sent **before** the `photo` part |
| `photo` | yes | the image file part (name: `capture.<ext>`; `ext` from the blob's real type) |
| `auto` | no | `1`/`true` — auto-paste intent (phone origin only; server setting used when absent) |
| `key` | no | phone idempotency key, `^[A-Za-z0-9_-]{8,32}$` — minted once per capture, reused on retries |

Server-side semantics:
- **Origin:** `source === 'phone'` → `origin: 'phone'`, else `'pc'`. Auto-paste only ever applies to phone origin.
- **Idempotency:** a retry of an already-landed capture (same `key`) is answered with the **original row** and `duplicate: true`, never a duplicate row.
- **File cap:** 20 MB per part (`@fastify/multipart fileSize: 20MB`). Over-cap → `413 { error: 'file too large' }`.
- **Pixel cap:** 64 MP (`MAX_PIXELS` in `server/store.js`) — every real phone sensor mode, so a full-resolution capture is never refused and the sender never has to downscale one to fit. Over-cap → `413 { error: 'too many pixels' }`, which is **terminal** exactly like the byte cap (the same bytes can never be accepted). Published to senders as `quality.maxPixels`.
- **Decoding:** the original bytes are stored untouched; a thumbnail is derived in the background (`t-<name>`). A sharp decode failure is `415` and is **retryable** (a newer build may know the format).
- **Rate limit:** photo token bucket.

**200 response:**
```json
{ "id": 12, "file": "1717000000000-abc123.jpg", "duplicate": true }
```
`file` is the stored name (also the `/media/<file>` path segment and `t-<file>` the thumbnail). `duplicate` present only on retries.

**Errors:** `400 no file`, `403 cross-site request blocked`, `413 file too large`, `415` (undecodable), `429 too many uploads, slow down`, `500 failed to store capture`.

### `POST /share`
Android/web-share target ("Share → ProofPipe"). Multipart via `req.parts()` — file parts are stored exactly like `/upload` captures (origin `phone`, auto-paste follows the server toggle); text fields `text`/`title`/`url` become a phone→PC text.

Responds `303` redirect to `/phone?shared=1` (or `?shared=error`). The native app can ignore the redirect and inspect the result instead — but must **consume the full request body** so the parser isn't left mid-stream.

---

## Captures

### `GET /api/captures?limit=100&before=<id>`
Newest-first, keyset pagination. `before` = capture `id` for older pages. `limit` clamped to `[1,200]`, default `100`.

**200:** array of capture rows (DB columns, camel-cased where the client uses them):
```json
[ { "id": 12, "file": "1717000000000-abc123.jpg", "created_at": "2024-05-29 12:00:00", "bytes": 2048000, "origin": "phone", "dedupe_key": null } ]
```

### `GET /api/captures/version`
Fingerprint for cheap change detection (poll fallback).
```json
{ "n": 87, "latest": 12, "textId": 4 }
```

### `DELETE /api/captures`
Delete all captures. **200:**
```json
{ "ok": true, "deleted": 87 }
```
Partial file-removal failure → `500 { deleted, failedFiles, error }`.

### `DELETE /api/captures/:id`
Delete one capture. **200:** `{ "ok": true }`; `404` if absent; `500 { error }` if DB delete worked but file removal failed.

---

## Files (arbitrary file transfer)

### `POST /api/files`
Store one file (phone→PC or PC→phone). Multipart, `dir` (or legacy `source`) field **before** the file part: `phone` \| `pc`. Body limit = `MAX_FILE_BYTES + 8MB`; per-part cap `MAX_FILE_BYTES`.

**200:** the stored file row:
```json
{ "id": 3, "name": "report.pdf", "file": "1717000000000-abc123.pdf", "mime": "application/pdf", "bytes": 9000, "dir": "phone", "created_at": "2024-05-29 12:00:00" }
```
Phone-origin files are auto-copied to the PC inbox (when `filesToInbox` is on).

**Errors:** `400 no file`, `413 file too large`, `429`, `403`, `500`.

### `GET /api/files?limit=20&before=<id>`
Newest-first keyset, same shape as captures. `limit` clamped `[1,200]`, default `100` (phone uses `20`).

### `GET /api/files/version`
```json
{ "n": 3, "latest": 3 }
```

### `GET /file/:id`
Stream the stored file with **Range** support (`Accept-Ranges: bytes`, `206`), immutable cache (`Cache-Control: public, max-age=31536000, immutable`), correct `Content-Disposition`. `404` if absent.

### `DELETE /api/files/:id`
**200:** `{ "ok": true }`; `404` if absent.

### `DELETE /api/files`
Delete transferred files, in the same two shapes `DELETE /api/captures` has (captures are unaffected — use `DELETE /api/captures` for those):

- **No body** — delete **every** file. Select + delete run inside one transaction, then the bytes are unlinked in bounded chunks. Emits **one** payload-less `file-deleted` SSE event.
- **`{ "ids": [...] }`** (JSON body) — delete exactly those rows, for the PC's bulk bar. Unknown, already-deleted, duplicate and non-positive ids are ignored rather than refused, so the caller can ask for a SET. Rows are removed through the same per-row deletion the `:id` route uses, with bounded concurrency, and the batch emits **one** `file-deleted` event carrying `ids`:
```json
{ "type": "file-deleted", "ids": [3, 4] }
```
  A non-array `ids` is `400`.

**200:** `{ "ok": true, "deleted": 12, "failed": 0 }` — `deleted` is the number of rows actually removed (a second call on an empty set returns `{ "ok": true, "deleted": 0, "failed": 0 }`). With an `ids` body a partial unlink failure is still `200`, with `ok: false` and `failed` counting the rows whose bytes could not be removed — the request itself succeeded, so it must not read as one that did not.
**500:** `{ "ok": false, "deleted": 12, "failed": 2, "error": "some files could not be removed" }` — the no-body wipe found that many bytes it could not unlink (the DB and disk are deliberately reported separately rather than claiming a clean wipe).
`403` on a cross-site request.

---

## Texts (phone↔PC text/chat chips)

### `POST /api/text`
Body `{ "body": string, "source": "phone"|"pc" }`. `body` trimmed + capped 10,000 chars. URLs matching `^https?://…/media/` are classified `kind: "media"` (capped at 200) vs `"text"` (capped at 20). **200:**
```json
{ "id": 4, "ok": true }
```
Errors: `400 empty text`, `403`.

### `GET /api/text?source=phone|pc&limit=10`
Latest texts. `source` optional (all when omitted). `limit` clamped `[1,20]`, default `10`.
```json
[ { "id": 4, "body": "hi", "source": "phone", "created_at": "…", "kind": "text" } ]
```

### `DELETE /api/text?source=phone|pc`
Clear sent texts. `source` optional (all when omitted). **200:** `{ "ok": true, "removed": n }`.

### `DELETE /api/text/:id`
Delete ONE text row (the phone's swipe-down-to-delete on a PC-sent chip). **200:** `{ "ok": true, "removed": 1 }` (or `0` if it was already gone). Errors: `400 bad id`, `403`.

---

## Status / discovery / settings

### `GET /api/lan?device=phone&outbox=<n>`
LAN discovery + phone presence heartbeat. The phone **pings this periodically** (`device=phone`, `outbox` = current queued count) to register itself and drive `phoneLastSeen`.
```json
{ "ips": ["192.168.1.5", "10.0.0.2"], "port": 8787, "scheme": "http" }
```

### `GET /api/stats`
Dashboard + phone presence. The phone reads `phoneLastSeen` for offline detection.
```json
{
  "version": "v1.22.0",
  "count": 87,
  "bytes": 178400000,
  "cap": 524288000,
  "files": { "count": 3, "bytes": 50000 },
  "mediaDir": "/home/user/data/media",
  "phoneLastSeen": 1717000000000,
  "phoneOnline": true,
  "phoneOutbox": 2,
  "phoneIp": "192.168.1.7",
  "phoneCount": 1,
  "phones": [ { "ip": "192.168.1.7", "lastSeen": 1717000000000, "outbox": 2 } ],
  "sseClients": 1,
  "recent": [
    { "kind": "capture", "id": 87, "label": "Capture", "dir": "phone", "at": "2026-09-14 16:33:04" },
    { "kind": "file", "id": 12, "label": "slides-final.pptx", "dir": "pc", "at": "2026-09-14 16:20:11" }
  ]
}
```
- `cap` — the resolved storage cap for the **captures** total, in bytes
  (`settings.storageCapMB || PP_MAX_STORE_MB`, default 500 MB). It is the
  denominator for `bytes`, sent here so a capacity meter is honest on first paint
  instead of waiting for `/api/settings`.
- `recent` — the last **3** arrivals across both libraries, newest first, for the
  harness rail's "did it land?" list. `kind` is `capture` | `file`; `dir` is the
  direction (a capture's `origin`, a file's `dir`); `label` is a display string
  (`Capture` for a capture — which has no file name — or the file's own name);
  `at` is the raw `created_at` string, the same one `GET /api/captures` returns.

### `GET /api/version`
```json
{ "version": "v1.22.0" }
```
`version` is derived from `package.json` at boot (`v` + the `version` field), so
it always carries a leading `v`.

### `POST /api/open-latest`
Ask the PC harness to open the latest capture (phone "Open on PC" button). **200:** `{ "ok": true }`.

### `GET /api/settings`
The aggregated settings bundle — one request instead of eight. Shaped to match
the individual endpoints below 1:1, so a client can map it directly, and it is
the exact payload the SSE `settings` event carries (applying the event needs no
refetch). The detected-browser LIST is deliberately **not** included (it needs a
registry probe and only changes on install — call `GET /api/browsers`).
```json
{
  "version": "v1.22.0",
  "autoPaste": { "auto": false },
  "autoCleanup": { "on": false, "cap": 524288000, "used": 178400000 },
  "filesInbox": { "on": true },
  "quality": { "on": false, "level": 80 },
  "storageCap": { "capMb": 500, "custom": false },
  "retention": { "days": 0 },
  "inboxDir": { "path": null, "def": "…/data/inbox" },
  "mediaDir": { "path": "…/data", "def": "…/data" },
  "browser": "default"
}
```

Every setting below is server-persisted and broadcast to connected clients as
an SSE `settings` event, so both UIs stay in sync without polling. Every `POST`
is CSRF-checked (`403 cross-site request blocked`); per-route `400`s are listed
with each endpoint.

### `GET /api/autopaste` → `{ "auto": false }`
### `POST /api/autopaste` — body `{ "auto": boolean }` → `{ "ok": true, "auto": true }`
### `GET /api/quality` → `{ "on": false, "level": 80, "maxPixels": 64000000 }`
### `POST /api/quality` — body `{ "on": boolean, "level": number }` → `{ "ok": true, ... }`
`level` is `1–100`. Errors: `400 on must be a boolean`, `400 level must be 1-100`.
`on` is the **only** switch that may reduce a phone photo's resolution. `maxPixels`
is the server's own accept ceiling (`server/store.js MAX_PIXELS`), republished
here so a sender never has to guess a limit — guessing low is a silent
downscale. It is read-only (the POST does not accept it) and does not resize
anything: the phone quotes it when it reports a `413 too many pixels` refusal.
The same object appears as `quality` in `GET /api/settings`, and the POST's
reply echoes `{ ok, on, level }`, so a client must leave a `maxPixels` it did not
receive untouched.

### `GET /api/files-inbox` → `{ "on": true }`
### `POST /api/files-inbox` — body `{ "on": boolean }` → `{ "ok": true, "on": true }`
Controls whether phone-origin transfers are auto-copied to the PC inbox.
Errors: `400 on must be a boolean`.

### Storage governance

#### `GET /api/autocleanup` → `{ "on": false, "cap": 524288000, "used": 178400000 }`
`cap` / `used` are **bytes** (the cap comes from `storageCap` below or
`PP_MAX_STORE_MB`).
#### `POST /api/autocleanup` — body `{ "on": boolean }` → `{ "ok": true, "on": true }`
Enabling trims to 80% of the cap immediately. Errors: `400 on must be a boolean`.

#### `GET /api/storage-cap` → `{ "capMb": 500, "custom": false }`
`custom: false` means the default (`PP_MAX_STORE_MB`) is in effect.
#### `POST /api/storage-cap` — body `{ "capMb": number|null }` → `{ "ok": true, "capMb": 500 }`
`50–1048576` MB; `null` resets to the default. Applies immediately when
auto-cleanup is on. Errors: `400 cap must be 50–1048576 MB`.

#### `GET /api/retention` → `{ "days": 0 }`
#### `POST /api/retention` — body `{ "days": number }` → `{ "ok": true, "days": 30 }`
`0` = off, max `3650`. A positive value sweeps immediately. Errors:
`400 days must be 0–3650 (0 = off)`.

#### `GET /api/inbox-dir` → `{ "path": null, "def": "…/data/inbox" }`
`path` is `null` while the default is in use.
#### `POST /api/inbox-dir` — body `{ "path": string|null }` → `{ "ok": true, "path": "D:\\inbox" }`
`null` resets to the default. An absolute, writable path is required, and it
must not sit inside the captures/files folders. Errors: `400 an absolute folder
path is required`, `400 cannot be inside the captures or files folder`,
`400 folder is not writable`.

#### `GET /api/media-dir` → `{ "path": "…", "def": "…" }`
#### `POST /api/media-dir` — body `{ "path": string }` → `{ "ok": true, "path": "D:\\proofpipe" }`
Relocates captures + files + inbox **together**. Paths switch only after every
entry has moved, and a failure rolls the moves back; cross-drive moves fall back
to copy + remove (`EXDEV`). The DB always stays in `PP_DATA`/`data`. Errors:
`400 an absolute folder path is required`, `400 folders cannot be nested inside
each other`, `400 folder is not writable`, `409 relocation already in progress`,
`500 move failed, rolled back`.

#### `GET /api/browsers` → `{ "browsers": [ { "id": "chrome", "name": "Google Chrome", "path": "C:\\…\\chrome.exe" } ], "current": "default" }`
Windows-only detection (curated install paths, then the `App Paths` registry
keys, so a custom install location still resolves); the list is empty on other
platforms. A stored pick whose browser was uninstalled reports
`current: "default"`. Cached for 5 minutes.
#### `POST /api/browsers` — body `{ "id": string }` → `{ "ok": true, "browser": "chrome" }`
`id` is one of the listed ids, or `"default"`. Errors: `400 unknown browser`.

### PC-only administration

Both routes below spawn a process on the PC itself, so they are refused with
`403` for any non-loopback caller (`available from this PC only`) — a LAN client
must not be able to pop a dialog on, or write an archive to, the PC's screen and
disk.

#### `POST /api/pick-folder`
Opens the native Windows folder picker on the PC screen and returns the chosen
path. A web page can never learn an absolute path from the browser's own dialog
(sandbox), which is why the SERVER opens it. Windows-only. A second concurrent
call gets `409 a picker is already open on the PC`.
```json
{ "path": "D:\\captures" }
```
Closing the dialog without choosing returns `{ "cancelled": true }`.
Errors: `400 Windows only`, `403 available from this PC only`.

#### `POST /api/backup` — body `{ "dir": string }`
Zips the whole ProofPipe state — the DB (WAL-checkpointed **inside** a write
transaction, so a concurrent upload can't slip between the checkpoint and the
copy), settings, captures, transfer files and inbox — into
`<dir>/proofpipe-backup-<timestamp>.zip`. The destination must already exist and
be writable (no folders are created for you). Windows-only. A second concurrent
call gets `409 a backup is already running`.
```json
{ "ok": true, "path": "D:\\backups\\proofpipe-backup-2026-09-13-08-00-00.zip", "bytes": 12345678 }
```
Errors: `400 an absolute destination folder is required`, `400 destination is not
a folder`, `400 destination folder is not writable`, `400 Windows only
(PowerShell Compress-Archive)`, `409 a backup is already running`,
`500 backup failed — see the server console`.

### `GET /qr.png?ip=<lan-ip>`
Pairing QR (PNG, `Cache-Control: no-store`). Encodes `SCHEME://<ip>:<port>/phone`. The native app's "scan QR to pair" flow reads the same URL to derive the PC address.

---

## Media serving

### `GET /media/<stored-name>` and `GET /media/t-<stored-name>`
Serve a capture original or its thumbnail from the live captures dir. Immutable cache, **Range** support (`206`). `t-*.tiff` names carry PNG bytes (mime handled accordingly). `404` on any path traversal / bad name.

---

## SSE — `GET /events`

Server-sent events stream. Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`. Initial `retry: 2000`; heartbeat `: hb` comment every 25s. Up to `maxClients` (oldest evicted when full).

Each `data:` line is either a bare type string or JSON `{ ...payload, type }`. **`type` always wins** — a payload key can never spoof it. Event types:

| type | payload | meaning |
|---|---|---|
| `capture` | `{ capture, auto, autoTarget }` | a capture's thumbnail is ready (all captures — the grid's paint signal) |
| `capture-ready` | `{ capture, auto, autoTarget }` | a phone capture is ready to auto-paste (fires before the thumb). `autoTarget` = the PC `settings.browser` pick (`default`/`chrome`/`edge`/…) — the extension pastes only when the tag names its browser (see `extension/browser-target.js`) |
| `file` | `{ row, type }` | a file landed (`row` = full file row, `dir` phone/pc) |
| `file-deleted` | `{ id }` | a file was deleted |
| `text` | — (payload `{ type:"text" }` or bare) | texts changed (chips must refresh) |
| `deleted` | — | captures were deleted |
| `settings` | `{ ...settings, type }` | a server setting changed (auto-paste, quality, files-inbox…) |
| `open-latest` | — | phone should trigger "open on PC" |
| `phone` | — (bare string) | phone presence changed — see below. Pushed on transitions only, so routine keep-alive pings stay silent |

Phone client behavior to replicate:
- `capture`/`capture-ready` with `capture.file`: upsert the tile by `file` (fade server thumb in over the local bitmap). If `origin === 'pc'` and it's new → flash "New capture from PC".
- `file` with `dir === 'pc'`: unshift into the PC-files list.
- On SSE open: mark live, set status connected, refetch recent. On error: mark reconnecting; the adaptive poll takes over.

---

## Client offline/poll model (to replicate)

- **Presence:** ping `GET /api/lan?device=phone&outbox=<n>` on an adaptive cadence (the phone polls every 10–60s) **and** keep one SSE stream open with `GET /events?device=phone`.
  - `phoneOnline` (see `/api/stats`) = a ping within ~90s **AND** no observed "the phone's stream closed" verdict. The stream is the phone's live wire: its close is knowable immediately, so the harness retires/restores the pairing QR in seconds instead of after the window.
  - The close verdict waits out a 4s grace (EventSource auto-retries in 2s, a page reload re-opens in ~1s), and **any phone ping clears it** — a phone that is pingable can never be reported gone, so a phone whose SSE never connected still reads as online.
  - A `phone` event is pushed on each transition (arriving, and the close verdict after the grace). Harnesses that cannot see the stream should also re-read `/api/stats` every 15s **while a phone is believed online** as the clock backstop.
- **Adaptive poll:** with SSE live and no queued work → 60s idle tick; else 10s fast tick. Re-check on `visibilitychange`/`online`.
- **Offline queues:** photos (outbox) and files queue durably with exponential backoff `5s * 2^tries` capped 5min; concurrency 2; `413` poisons (never resend); `415` is retryable; `429` pauses the whole queue 1.5s. Text queue caps at 20 (5 if storage full). See `public/queue.js` (`PPQueue`) — the pure policy, transliterated to `SyncPolicy`.
- **Idempotency keys:** mint once per capture at capture/queue time, frozen in the queued record, reused on every retry.