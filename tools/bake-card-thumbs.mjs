// Card thumbnails on our own fast host. The card image host (assets.tcgdex.net) takes 1–3 s per image
// with no CDN, so every English card's grid image is baked once into a ~10 KB WebP:
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
const ASSETS = 'https://assets.tcgdex.net';
const args = process.argv.slice(2);
const MAX_NEW = Number(args[args.indexOf('--max-new') + 1]) || (args.includes('--max-new') ? 0 : 8000);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ixFile = path.join(DIST, 'index-en.json');
const ix = JSON.parse(await fs.readFile(ixFile, 'utf8'));
const missingFile = path.join(CACHE, '_missing.json');
await fs.mkdir(CACHE, { recursive: true });
const missing = new Set(JSON.parse(await fs.readFile(missingFile, 'utf8').catch(() => '[]')));

// Same rule as the app (www/js/data/cardindex.js image()): 1 = default path, string = explicit path.
const relPath = ([, , si, localId, , , , img]) => {
  if (!img) return null;
  const s = ix.sets[si];
  return img === 1 ? `en/${s.serie}/${s.id}/${localId}` : img;
};
const SAFE = /^[A-Za-z0-9._/-]+$/;
const exists = (f) => fs.access(f).then(() => true, () => false);

const todo = [];
const bySet = new Map(); // si -> { need, have }
for (const c of ix.cards) {
  const rel = relPath(c);
  // Odd ids ("?", "!") stay on the image host: the app uses the same SAFE test.
  if (!rel || missing.has(rel) || !SAFE.test(rel)) continue;
  const st = bySet.get(c[2]) ?? { need: 0, have: 0 };
  bySet.set(c[2], st);
  st.need++;
  if (await exists(path.join(CACHE, `${rel}.webp`))) st.have++;
  else todo.push({ rel, si: c[2] });
}
// Newest sets first: they're what people browse most.
todo.sort((a, b) => (ix.sets[b.si].date || '').localeCompare(ix.sets[a.si].date || ''));
const batch = todo.slice(0, MAX_NEW);
log(`thumbs: ${todo.length} to bake, ${batch.length} this run`);

let done = 0, failed = 0, bytes = 0, next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < batch.length) {
    const { rel, si } = batch[next++];
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`${ASSETS}/${rel}/low.webp`, { headers: { 'User-Agent': 'tcg-marketplace-data/1.0' } });
        if (r.status === 404) { missing.add(rel); bySet.get(si).need--; break; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const out = await sharp(Buffer.from(await r.arrayBuffer())).resize({ width: 200 }).webp({ quality: 68 }).toBuffer();
        const file = path.join(CACHE, `${rel}.webp`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, out);
        bytes += out.length; done++; bySet.get(si).have++;
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
let complete = 0;
ix.sets.forEach((s, si) => {
  const st = bySet.get(si);
  if (st && st.need > 0 && st.have >= st.need) { s.tb = 1; complete++; } else delete s.tb;
});
await fs.writeFile(ixFile, JSON.stringify(ix));
log(`thumbs: ${complete}/${ix.sets.length} sets complete`);
