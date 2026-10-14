// Official Japanese names (and Pokédex numbers) from the pokemon-card.com database mirror
// (type-null/PTCG-database, MIT; cloned to cache/ptcg-db by tools/recog/official-ja.mjs). It covers
// the modern eras by set code + printed number, which is exactly what the sets filled from TCGplayer
// (tools/jp-prices.mjs — English names) lack. Bulbapedia (tools/ja-names.mjs) covers the vintage sets.
// Cards still named in English after this are listed so the gap is visible. Rewrites dist/index-ja.json.
// Usage: node tools/ja-official-names.mjs   (after jp-prices.mjs and ja-names.mjs)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data-pipeline');
const DIST = path.join(ROOT, 'dist');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const exists = (f) => fs.access(f).then(() => true, () => false);

// The clone made by official-ja.mjs, or the app repo's copy when running locally.
let DB = path.join(ROOT, 'cache', 'ptcg-db', 'data_jp');
if (!(await exists(DB))) DB = path.resolve(ROOT, '..', '..', 'tcg-marketplace', 'data-pipeline', 'cache', 'ptcg-db', 'data_jp');
if (!(await exists(DB))) { console.log('::warning::ptcg-db not available — Japanese official names skipped'); process.exit(0); }

const ix = JSON.parse(await fs.readFile(path.join(DIST, 'index-ja.json'), 'utf8'));
const folders = new Set(await fs.readdir(DB));
// TCGdex set ids vs the database's folder names: exact first, then case-insensitive, then "+" ↔ "p".
// Twin halves and "-B" boxes carry the database's own codes.
const ALIAS = {
  XY1a: 'XY1-Bx', XY1b: 'XY1-By', XY5a: 'XY5-Bg', XY5b: 'XY5-Bt', XY8a: 'XY8-Bb', XY8b: 'XY8-Br', XY11a: 'XY11-Bb', XY11b: 'XY11-Br',
  XY9: 'XY9-B', XY10: 'XY10-B', L1a: 'L1-Bhg', L1b: 'L1-Bss', L2: 'L2-B', L3: 'L3-B', 'XY-P': 'XYP', 'SM-P': 'SMP', 'S-P': 'SP', 'SV-P': 'SVP',
};
const folderFor = (id) => {
  if (ALIAS[id] && folders.has(ALIAS[id])) return ALIAS[id];
  if (folders.has(id)) return id;
  const low = id.toLowerCase();
  return [...folders].find((f) => f.toLowerCase() === low || f.toLowerCase() === low.replace(/p$/, '+')) ?? null;
};
const normNum = (n) => { const s = String(n ?? '').split('/')[0].trim(); return /^\d+$/.test(s) ? String(Number(s)) : s.toUpperCase(); };

let renamed = 0, dexed = 0;
const stillEnglish = {};
for (const [si, s] of ix.sets.entries()) {
  const cards = ix.cards.filter((c) => c[2] === si);
  if (!cards.some((c) => /^[A-Za-z]/.test(c[1]))) continue;
  const folder = folderFor(s.id);
  if (!folder) { stillEnglish[s.id] = cards.filter((c) => /^[A-Za-z]/.test(c[1])).length; continue; }
  const byNum = new Map();
  for (const f of await fs.readdir(path.join(DB, folder))) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(await fs.readFile(path.join(DB, folder, f), 'utf8'));
      if (d.number && d.name && !byNum.has(normNum(d.number))) byNum.set(normNum(d.number), d);
    } catch { /* skip */ }
  }
  let left = 0;
  for (const c of cards) {
    if (!/^[A-Za-z]/.test(c[1])) continue;
    const d = byNum.get(normNum(c[3]));
    if (!d) { left++; continue; }
    c[1] = d.name; renamed++;
    if (d.pokedex_number && !c[4].length) { c[4] = [d.pokedex_number]; dexed++; }
  }
  if (left) stillEnglish[s.id] = left;
}
await fs.writeFile(path.join(DIST, 'index-ja.json'), JSON.stringify(ix));
log(`ja-official-names: ${renamed} names from the official database (${dexed} Pokédex numbers added)`);
const left = Object.values(stillEnglish).reduce((a, b) => a + b, 0);
if (left) log(`ja-official-names: ${left} cards still English-named: ${Object.entries(stillEnglish).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([s, n]) => `${s}:${n}`).join(' ')}`);
