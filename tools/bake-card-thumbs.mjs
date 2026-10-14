// Card thumbnails on our own fast host (300 px: sharp in grids on 3x phones, and an instant clear picture
// on the card page while the full-size image loads). The card image host (assets.tcgdex.net) takes 1–3 s per image
// with no CDN, so every English card's grid image is baked once into a ~20 KB WebP:
//   cache/thumbs/<same path as the image host>.webp   (persisted: Actions cache + thumbs-cache branch)
//   dist/thumbs/...                                     (published on Pages next to the indexes)
// Sets whose cards are all baked get `tb: 1` in index-en.json; the app only asks for thumbs of those
// sets and falls back to the image CDN / image host if a thumb is ever missing.
// Japanese cards shown with their English twin's art use these too.
// Usage: node tools/bake-card-thumbs.mjs [--max-new N]   (new downloads per run; default 8000)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data-pipeline');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, 'cache', 'thumbs');
const WIDTH = 300, QUALITY = 68; // ~20 KB each
// Made from the full-size image (the host's low.webp is only 245 px wide).
const ASSETS = 'https://assets.tcgdex.net';
const args = process.argv.slice(2);
const MAX_NEW = Number(args[args.indexOf('--max-new') + 1]) || (args.includes('--max-new') ? 0 : 8000);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// English and Japanese indexes (Japanese cards that still have a TCGdex image: ~3,900 older cards).
const LANGS = ['en', 'ja'];
const ixs = {};
for (const l of LANGS) ixs[l] = JSON.parse(await fs.readFile(path.join(DIST, `index-${l}.json`), 'utf8'));
const missingFile = path.join(CACHE, '_missing.json');
await fs.mkdir(CACHE, { recursive: true });
const missing = new Set(JSON.parse(await fs.readFile(missingFile, 'utf8').catch(() => '[]')));

// Same rule as the app (www/js/data/cardindex.js image()): 1 = default path, string = explicit path.
const relPath = (lang, [, , si, localId, , , , img]) => {
  if (!img) return null;
  const s = ixs[lang].sets[si];
  return img === 1 ? `${lang}/${s.serie}/${s.id}/${localId}` : img;
};
const SAFE = /^[A-Za-z0-9._/-]+$/;
const exists = (f) => fs.access(f).then(() => true, () => false);

const todo = [];
const bySet = new Map(); // "lang:si" -> { need, have }
for (const lang of LANGS) for (const c of ixs[lang].cards) {
  const rel = relPath(lang, c);
  // Odd ids ("?", "!") stay on the image host: the app uses the same SAFE test.
  if (!rel || missing.has(rel) || !SAFE.test(rel)) continue;
  const key = `${lang}:${c[2]}`;
  const st = bySet.get(key) ?? { need: 0, have: 0, lang, si: c[2] };
  bySet.set(key, st);
  st.need++;
  if (await exists(path.join(CACHE, `${rel}.webp`))) st.have++;
  else todo.push({ rel, key, date: ixs[lang].sets[c[2]].date || '' });
}
// Newest sets first: they're what people browse most.
todo.sort((a, b) => b.date.localeCompare(a.date));
const batch = todo.slice(0, MAX_NEW);
log(`thumbs: ${todo.length} to bake, ${batch.length} this run`);

let done = 0, failed = 0, bytes = 0, next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < batch.length) {
    const { rel, key } = batch[next++];
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`${ASSETS}/${rel}/high.webp`, { headers: { 'User-Agent': 'tcg-marketplace-data/1.0' } });
        if (r.status === 404) { missing.add(rel); bySet.get(key).need--; break; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const out = await sharp(Buffer.from(await r.arrayBuffer())).resize({ width: WIDTH }).webp({ quality: QUALITY }).toBuffer();
        const file = path.join(CACHE, `${rel}.webp`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, out);
        bytes += out.length; done++; bySet.get(key).have++;
        break;
      } catch (e) {
        if (i === 2) failed++;
        else await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
      }
    }
    if ((done + failed) % 1000 === 0 && done) log(`  ${done} baked, ${failed} failed`);
  }
}));
await fs.writeFile(missingFile, JSON.stringify([...missing].sort()));
log(`thumbs: ${done} new (${(bytes / 1048576).toFixed(1)} MB), ${failed} failed, ${missing.size} have no image`);

// Publish: dist/thumbs mirrors the cache; mark complete sets.
await fs.rm(path.join(DIST, 'thumbs'), { recursive: true, force: true });
await fs.cp(CACHE, path.join(DIST, 'thumbs'), { recursive: true, filter: (src) => !src.endsWith('_missing.json') });
for (const lang of LANGS) {
  let complete = 0;
  ixs[lang].sets.forEach((s, si) => {
    const st = bySet.get(`${lang}:${si}`);
    if (st && st.need > 0 && st.have >= st.need) { s.tb = 1; complete++; } else delete s.tb;
  });
  await fs.writeFile(path.join(DIST, `index-${lang}.json`), JSON.stringify(ixs[lang]));
  log(`thumbs: ${lang} ${complete}/${ixs[lang].sets.length} sets complete`);
}
