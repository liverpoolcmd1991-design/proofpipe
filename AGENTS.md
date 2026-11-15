# AGENTS.md — Guidance for Coding Agents

This file supplements the project documentation for coding agents working in the ProofPipe repository.

## Search Tooling

Prefer **ripgrep (`rg`)** when installed on the host system, or scoped `grep -rnE` excluding `node_modules` and `data`.

- Respect `.gitignore` by default and skip generated/runtime directories (`data/`, `node_modules/`).
- For structural questions across services, consult `.agents/skills/codebase-memory/SKILL.md` when available.

## Repository Map & Workflow

| Area | Document |
|---|---|
| Directory layout, module boundaries, conventions | `CONVENTIONS.md` |
| Platform & protocol pitfalls (server, SQLite, MV3 extension) | `PITFALLS.md` |
| HTTP & SSE wire contract | `API.md` |
| Overview, setup, configuration | `README.md` |
| Release history | `CHANGELOG.md` |
| Chrome drag-payload verification utility | `dev/ext-tray-probe.mjs` |

- **Backend**: `server.js` plus extracted modules in `server/` (`sqlite.js`, `store.js`, `sse.js`, `captures.js`, `files.js`, `text.js`, `settings.js`, `lockfile.js`, `browser.js`, `backup.js`, `cleanup.js`, `mediadir.js`, `ratelimit.js`, `bytes.js`, `util.js`).
- **Web Frontends**: `public/index.html` + `public/shared.js` + `public/releases.js` + `public/app.js` + `public/style.css` (Desktop workbench at `/` with System Settings and What's New modals) and `public/phone.html` + `public/shared.js` + `public/phone-viewer.js` + `public/phone-files.js` + `public/phone.js` + `public/phone.css` (Mobile capture PWA at `/phone`).
- **Extension**: `extension/` (Chromium Manifest V3 auto-paste, drag-tray, `discovery.js`, `tray-ui.js`, and two-way Quick Send popup).
- **Daemon & Tray Launcher**: `scripts/daemon.js` (cross-platform background CLI), `scripts/tray.ps1`, `ProofPipe.vbs`, `ProofPipe.bat`.
- **Tests**: `npm test` (`node --test "test/*.test.js"`), running isolated server instances per test suite.
- **Lint**: `npm run lint` (`eslint .`).
- **Runtime**: Node.js 22+. Bump `package.json` version and add `public/releases.js` + `CHANGELOG.md` entries when shipping new features or behavior changes.