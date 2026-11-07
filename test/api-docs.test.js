// API contract guard: API.md is the authoritative wire contract the native
// Android app targets (see README), but it is hand-maintained — nothing
// generates it, so a new route added to the server silently ships undocumented
// and a removed route lingers as fiction. This test parses the route
// REGISTRATIONS out of the server sources and cross-checks them against the
// `METHOD /path` tokens in API.md, in BOTH directions:
//
//   - every registered route must appear in API.md  (the doc is complete)
//   - every documented route must be registered     (the doc is not fiction)
//
// It is a static check (no server boot, no port range), like dup.test.js.
//
// Adding a route means documenting it as a backtick-quoted `METHOD /path`
// somewhere under a heading — the same convention every existing entry uses.
// Wildcard routes (`/media/*`) match any documented path under that prefix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_MD = fs.readFileSync(path.join(APP, 'API.md'), 'utf8');

// server.js is the composition root; server/*.js holds the extracted route
// modules. Any new route file must be picked up by this glob automatically.
function serverSources() {
  const files = ['server.js'];
  for (const f of fs.readdirSync(path.join(APP, 'server'))) {
    if (f.endsWith('.js')) files.push(path.join('server', f));
  }
  return files;
}

// every `app.<verb>('<path>'` registration, with the file it came from
function registeredRoutes() {
  // the path is a string literal (route paths are never built dynamically —
  // if one ever is, this test's failure is the correct signal to make it
  // literal or to teach this parser about it)
  const re = /\bapp\.(get|post|delete|put|patch)\(\s*(['"])([^'"]+)\2/g;
  const out = [];
  for (const rel of serverSources()) {
    const src = fs.readFileSync(path.join(APP, rel), 'utf8');
    for (const m of src.matchAll(re)) out.push({ method: m[1].toUpperCase(), path: m[3], file: rel });
  }
  return out;
}

// every backtick-quoted `METHOD /path` token in API.md, query strings stripped
function documentedRoutes() {
  const re = /`(GET|POST|DELETE|PUT|PATCH)\s+(\/[^`\s|]*)/g;
  const out = [];
  for (const m of API_MD.matchAll(re)) {
    const p = m[2].split('?')[0].replace(/\/+$/, '') || '/';
    out.push({ method: m[1], path: p });
  }
  return out;
}

const fmt = r => `${r.method} ${r.path}${r.file ? `  (${r.file})` : ''}`;

test('every registered server route is documented in API.md', () => {
  const docs = documentedRoutes();
  const missing = registeredRoutes().filter(r => !docs.some(d => {
    if (d.method !== r.method) return false;
    // `/media/*` covers `/media/<stored-name>` and `/media/t-<stored-name>`
    return r.path.endsWith('/*') ? d.path.startsWith(r.path.slice(0, -1)) : d.path === r.path;
  }));
  assert.deepEqual(
    missing.map(fmt), [],
    `undocumented route(s) — add them to API.md (and failing the reverse test is\nnot the fix):\n  ${missing.map(fmt).join('\n  ')}`,
  );
});

test('API.md documents no route the server does not register', () => {
  const registered = registeredRoutes();
  const stale = documentedRoutes().filter(d => !registered.some(r => {
    if (d.method !== r.method) return false;
    return r.path.endsWith('/*') ? d.path.startsWith(r.path.slice(0, -1)) : d.path === r.path;
  }));
  // de-duplicate: API.md repeats a few routes in prose (e.g. the poll model)
  const unique = [...new Map(stale.map(d => [`${d.method} ${d.path}`, d])).values()];
  assert.deepEqual(
    unique.map(fmt), [],
    `API.md documents route(s) the server no longer registers — remove or correct\nthem:\n  ${unique.map(fmt).join('\n  ')}`,
  );
});
