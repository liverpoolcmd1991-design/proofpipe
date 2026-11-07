// Duplicate-file guard: public/toPng.js and extension/toPng.js must stay
// byte-identical. Both copies have to physically exist (the web UIs load the
// served copy; the extension loads its packaged copy — Chrome content scripts
// can't reach ../public), so the only way to keep them from drifting is to
// fail the build when they do. When one copy needs a fix, apply it to both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('public/toPng.js and extension/toPng.js are byte-identical', () => {
  const pub = fs.readFileSync(path.join(APP, 'public', 'toPng.js'), 'utf8');
  const ext = fs.readFileSync(path.join(APP, 'extension', 'toPng.js'), 'utf8');
  assert.equal(ext, pub, 'toPng.js copies drifted — apply changes to BOTH public/toPng.js and extension/toPng.js');
});
