// App icons: Lucide scan-line glyph, accent green on the dark card color.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// anchored to the repo root so this runs from any cwd (it lives in scripts/)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const glyph = fs.readFileSync(path.join(ROOT, 'public/icons/scan-line.svg'), 'utf8')
  .replaceAll('currentColor', '#22c55e')
  .replaceAll('stroke-width="2"', 'stroke-width="1.75"');

async function make(size, out) {
  const r = Math.round(size * 0.22);   // corner radius
  const inner = Math.round(size * 0.56);
  const off = Math.round((size - inner) / 2);
  const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${r}" fill="#17181a"/><rect x="1" y="1" width="${size - 2}" height="${size - 2}" rx="${r - 1}" fill="none" stroke="#2a2c2f" stroke-width="2"/></svg>`;
  const glyphPng = await sharp(Buffer.from(glyph)).resize(inner, inner).png().toBuffer();
  await sharp(Buffer.from(bg))
    .composite([{ input: glyphPng, top: off, left: off }])
    .png()
    .toFile(out);
  console.log('made', out);
}

await make(512, path.join(ROOT, 'public/icon-512.png'));
await make(192, path.join(ROOT, 'public/icon-192.png'));
// extension icons: Chrome renders the toolbar/favicon/manage-page sizes from
// these, so a single 128 left the small sizes visibly blurry when downscaled.
await make(128, path.join(ROOT, 'extension/icon.png'));
await make(48, path.join(ROOT, 'extension/icon48.png'));
await make(32, path.join(ROOT, 'extension/icon32.png'));
await make(16, path.join(ROOT, 'extension/icon16.png'));
