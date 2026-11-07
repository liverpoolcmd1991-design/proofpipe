// Dev-only: seed a scratch ProofPipe instance so the phone "PC-sent" lane can be
// rendered with every chip variant at once (plain text, link, capture, both file
// directions, "show older texts", "load older transfers"). Never touches data/.
//
//   PP_DATA=<tmpdir> PORT=8899 node server.js      # the scratch instance
//   node dev/seed-scratch.mjs                      # this seeder
//   node dev/phone-lane.mjs probe http://127.0.0.1:8899/phone.html
const PORT = Number(process.env.PORT) || 8899;
const B = `http://127.0.0.1:${PORT}`;

const post = (p, body) => fetch(B + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json());

const wait = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(B + '/api/lan?device=phone'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('scratch server never came up');
};

await wait();

const HOST = `127.0.0.1:${PORT}`;
const CAPS = ['1789235760661-wcte2x.jpg', '1789235768346-j48cg3.jpg', '1789238785530-i5c4j1.jpg', '1789281385206-sdicjk.jpg'];

// 6 PC-sent captures (> the client's SHOW=5, so the inline "show older" appears)
for (const c of CAPS) await post('/api/text', { body: `http://${HOST}/media/${c}`, source: 'pc' });
// two more duplicates so the count is clearly over 5
await post('/api/text', { body: `http://${HOST}/media/${CAPS[0]}`, source: 'pc' });
await post('/api/text', { body: `http://${HOST}/media/${CAPS[1]}`, source: 'pc' });

// a plain text chip and a link chip, in the same lane as the captures
await post('/api/text', { body: 'The algebra PDF is in the shared folder', source: 'pc' });
await post('/api/text', { body: 'https://libretexts.org/bookshelves/abstract_algebra', source: 'pc' });

// 20 transfers -> exactly one full page, so "Load older transfers" shows
const mk = (name, dir) => {
  const fd = new FormData();
  fd.set('dir', dir);
  fd.set('file', new Blob([`seed ${name}\n`], { type: 'text/plain' }), name);
  return fetch(B + '/api/files', { method: 'POST', body: fd }).then(r => r.json());
};
const names = [
  'Dana Ernst - An Inquiry-Based Approach to Abstract Algebra (Northern Arizona University, LibreTexts) - libgen.li.pdf',
  'fc0c9ca8-f324-4266-a0a9-a562c4a3356c_Chapter_01_Sets_Functions_and_Cardinality.md',
  'site-photos.zip', 'notes.txt', 'contract-v3-final.pdf', 'screenshot.png',
  'budget-2026.xlsx', 'reading-list.md', 'diagram.svg', 'invoice-0042.pdf',
  'meeting-notes.md', 'photo-original.jpg', 'archive.tar.gz', 'slides.pptx',
  'resume.pdf', 'dataset.csv', 'logo-final-final.png', 'styles.css',
  'app.js', 'README.md',
];
for (let i = 0; i < names.length; i++) await mk(names[i], i % 4 === 3 ? 'phone' : 'pc');

const v = await fetch(B + '/api/files/version').then(r => r.json());
const t = await fetch(B + '/api/text?source=pc&limit=20').then(r => r.json());
console.log('seeded: files=' + v.n + ' pcTexts=' + t.length);
