// ESLint flat config (eslint v9). Rules applied per file-type so the mixed
// ESM/browser/extension codebase gets the right environments. `npm run lint`
// runs ONLY eslint: it parses every file it lints (syntax) AND applies the
// semantic rules — no-unused-vars / no-undef / no-dupe-keys etc. catch the
// classes of bug PITFALLS.md warns about. The old separate `node --check`
// pass over a hand-maintained file list was one forgotten edit away from
// false confidence; keep the globs below complete instead.
import js from '@eslint/js';
import globals from 'globals';

// Cross-script globals: several classic scripts are loaded together by a page,
// a manifest, or importScripts and call each other's top-level bindings. They
// are a real contract (a rename breaks the other file at RUNTIME), so they are
// declared here — no-undef then guards every OTHER undefined identifier, which
// is how load-order typos get caught before a browser ever sees them.
const CROSS_SCRIPT = {
  PPQueue: 'readonly',      // public/queue.js — used by phone.js
  toPng: 'readonly',        // public/toPng.js — used by app.js + extension pages
  PPDiscovery: 'readonly',  // extension/discovery.js — background/offscreen/popup/content
  PPPasteLogic: 'readonly', // extension/paste-logic.js — content.js
  PPBrowserTarget: 'readonly', // extension/browser-target.js — background/offscreen
  PPFiles: 'readonly',      // extension/files.js — background/popup/content
};

// A file that DEFINES one of the cross-script bindings must not have it
// declared as an external global in its own block (its top-level `const`
// would trip no-redeclare against the declaration above).
const DEFINES = {
  'extension/discovery.js': { PPDiscovery: 'off' },
  'extension/paste-logic.js': { PPPasteLogic: 'off' },
  'extension/files.js': { PPFiles: 'off' },
  'extension/browser-target.js': { PPBrowserTarget: 'off' },
  'extension/toPng.js': { toPng: 'off' },
};

// The codebase's documented error-swallowing idiom is `catch {}` (PITFALLS:
// best-effort cleanup must never break a request) — allow exactly that; true
// empty blocks (if/for) still error.
const ALLOW_EMPTY_CATCH = ['error', { allowEmptyCatch: true }];

const NO_UNUSED = {
  varsIgnorePattern: '^_',
  argsIgnorePattern: '^_',
  caughtErrors: 'none', // legacy catch (e) blocks are fine even when empty
  ignoreRestSiblings: true,
};

export default [
  { ignores: ['**/node_modules/**', '**/data/**', '.git/**', 'public/icons/**'] },

  // Node ESM: server + its extracted modules + the test suites (scripts/ too).
  // scripts/*.cjs is CommonJS but lints fine as a script — it MUST stay in a
  // glob (it's loaded via --require by npm start, so an unchecked edit would
  // otherwise surface only as a runtime crash).
  {
    files: ['server.js', 'server/*.js', 'scripts/*.js', 'scripts/*.cjs', 'test/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // MERGE, don't overwrite: a bare `rules:` key here would REPLACE the
      // recommended set wholesale — that bug silently disabled no-undef (and
      // every other recommended rule) project-wide, which is how an undefined
      // function call in phone.js survived lint as a boot-time crash.
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', NO_UNUSED],
      'no-empty': ALLOW_EMPTY_CATCH,
    },
  },

  // PC harness classic scripts (browser globals only)
  {
    files: ['public/app.js', 'public/phone.js', 'public/scan.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, ...CROSS_SCRIPT },
    },
    rules: {
      ...js.configs.recommended.rules, // merge — see the note above
      'no-unused-vars': ['error', NO_UNUSED],
      'no-empty': ALLOW_EMPTY_CATCH,
    },
  },

  // Pure browser classic scripts (queue/sw/toPng) — also loaded in node:vm tests
  {
    files: ['public/queue.js', 'public/sw.js', 'public/toPng.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.serviceworker, self: 'readonly' },
    },
    rules: {
      ...js.configs.recommended.rules, // merge — see the note above
      'no-unused-vars': ['error', NO_UNUSED],
      'no-empty': ALLOW_EMPTY_CATCH,
    },
  },

  // Chrome MV3 extension (classic scripts; chrome.* + service-worker globals)
  {
    files: ['extension/**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.serviceworker, chrome: 'readonly', self: 'readonly', ...CROSS_SCRIPT },
    },
    rules: {
      ...js.configs.recommended.rules, // merge — see the note above
      'no-unused-vars': ['error', NO_UNUSED],
      // Some listeners intentionally return values / are callback-shaped
      'no-empty': ALLOW_EMPTY_CATCH,
    },
  },
  // defining files: their own binding is declared HERE, not imported
  ...Object.entries(DEFINES).map(([file, own]) => ({
    files: [file],
    languageOptions: { globals: { ...own } },
  })),
];