# AGENTS.md — guidance for coding agents working in this repo

This file is read by coding agents (Claude Code, Cursor, Copilot, and similar)
before they start editing. It supplements the human-facing docs.

## Search tooling — use ripgrep (rg)

Always prefer **ripgrep (`rg`)** for repository text/code searches and file
listing.

- **Text/code search:** use `rg <pattern>` instead of `grep`.
- **File location:** use `rg --files` instead of `find` when locating files.
- **Respect `.gitignore`:** ripgrep obeys `.gitignore`/`.ignore`/`.git/info/exclude`
  by default — do **not** pass `-u/--no-ignore` unless the task explicitly asks
  to search ignored files (e.g. vendored/generated output).
- **No recursive `grep -r`:** never run `grep -r` over the tree; `rg` already
  recurses and is much faster on big trees like `node_modules` (which is
  gitignored here and skipped by default).
- `rg` is installed via **WinGet (`BurntSushi.ripgrep.MSVC`)**. Run
  `rg --version` to confirm it is on `PATH`.

Example:

```bash
rg "assetStamp" --type js       # search JS for the asset-stamp helper
rg --files | rg "test\.js$"     # list files, then filter
rg -l "serverFetch" public/ extension/   # list files containing a symbol
```

> For *structural* questions (who calls X, dead code, cross-service edges)
> the `codebase-memory` knowledge-graph MCP is even more precise — see
> `.agents/skills/codebase-memory/SKILL.md`. Use `rg` when you need raw text
> matches; use the graph for structure.

## Repo map & workflow

Quick orientation — full detail lives in the docs:

| What / where | Doc |
|---|---|
| Layout, naming, tests | `CONVENTIONS.md` |
| Platform gotchas (read before editing extension/server) | `PITFALLS.md` |
| Design rationale | `DESIGN.md` |
| Component-level breakdown | `COMPONENTS.md` |
| Wire contract (server routes) | `API.md` |
| User-facing overview & run instructions | `README.md` (run via `ProofPipe.bat` or `npm start`) |
| Change history | `CHANGELOG.md` |
| Render/measure the phone UI before claiming a layout fix | `dev/phone-lane.mjs` + `dev/seed-scratch.mjs` (PITFALLS #33) |
| Render/measure the PC harness before claiming a layout fix | `dev/pc-harness.mjs` (`seed`/`probe`/`shot`/`eval`) — the PC twin of `dev/phone-lane.mjs` |
| Verify a tray drag payload before claiming a drag fix | `dev/ext-tray-probe.mjs` — real drags in real Chrome, printing what each drop received (PITFALLS #56) |

- Backend is a single `server.js` (deliberate) plus extracted subsystems in
  `server/`; web UIs live in `public/`; the Chrome MV3 extension in `extension/`.
- Tests: `npm test` (`node --test test/*.test.js`), one server process per suite.
- Lint: `npm run lint` (= `eslint .`); this is the single gate.
- Requires **Node 20+**. Bump `package.json` version for behavior changes and
  add a `CHANGELOG.md` entry — see CONVENTIONS §6.