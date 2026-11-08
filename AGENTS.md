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

- **Backend**: `server.js` plus extracted modules in `server/` (`sqlite.js`, `store.js`, `sse.js`, `captures.js`, `files.js`, `browser.js`, `backup.js`, `cleanup.js`, `mediadir.js`, `ratelimit.js`, `bytes.js`, `util.js`).
- **Web Frontends**: `public/index.html` + `public/app.js` + `public/style.css` (Desktop workbench at `/` with System Settings modal window) and `public/phone.html` + `public/phone.js` + `public/phone.css` (Mobile capture PWA at `/phone`).
- **Extension**: `extension/` (Chromium Manifest V3 auto-paste and drag-tray extension).
- **Tests**: `npm test` (`node --test "test/*.test.js"`), running isolated server instances per test suite.
- **Lint**: `npm run lint` (`eslint .`).
- **Runtime**: Node.js 22+. Bump `package.json` version and add a `CHANGELOG.md` entry when shipping new features or behavior changes.