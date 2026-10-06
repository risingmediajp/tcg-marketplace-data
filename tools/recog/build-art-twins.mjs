// Display pictures for Japanese cards that have no image of their own: the English print with the
// SAME ILLUSTRATION, found by comparing artwork fingerprints (not just Pokémon + timing — that picked
// a different illustration of the same Pokémon). Better no picture than a wrong one.
//   dist/art-twins-ja.json { "<ja id>": "<en id>" }
// Uses the raw (pre-PCA) art-crop embeddings cached by build-embeddings.mjs.
// Usage: node tools/recog/build-art-twins.mjs [--report]

import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadIndex, dot } from './common.mjs';

const SAME_ART = 0.80; // raw-embedding cosine; set from --report (same-art pairs vs different-art pairs)
const CACHE = path.join(ROOT, 'data-pipeline', 'cache', 'embed');

async function readEmbeds(lang) {
  const meta = JSON.parse(await fs.readFile(path.join(CACHE, `${lang}.json`), 'utf8'));
  const buf = await fs.readFile(path.join(CACHE, `${lang}.bin`));
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return new Map(meta.ids.map((id, i) => [id, all.subarray(i * meta.dim, (i + 1) * meta.dim)]));
}

const en = await loadIndex('en'), ja = await loadIndex('ja');
const [enVec, jaVec] = await Promise.all([readEmbeds('en'), readEmbeds('ja')]);

// English prints with an image, grouped by Pokémon (dex numbers).
const enByDex = new Map();
for (const c of en.cards) {
  if (!c[7] || !c[4]?.length || !enVec.has(c[0])) continue;
  const k = [...c[4]].sort().join(',');
  if (!enByDex.has(k)) enByDex.set(k, []);
  enByDex.get(k).push(c[0]);
}

const out = {};
const best = [];
for (const c of ja.cards) {
  if (c[7] || !c[4]?.length) continue;           // has its own picture, or not a Pokémon
  const v = jaVec.get(c[0]);
  if (!v) continue;                              // no fingerprint (no official image either)
  let top = null, s1 = -1, s2 = -1;
  for (const id of enByDex.get([...c[4]].sort().join(',')) ?? []) {
    const s = dot(v, enVec.get(id));
    if (s > s1) { s2 = s1; s1 = s; top = id; } else if (s > s2) s2 = s;
  }
  if (!top) continue;
  best.push(s1);
  if (s1 >= SAME_ART) out[c[0]] = top;
}

if (process.argv.includes('--report')) {
  const hist = new Array(10).fill(0);
  for (const s of best) hist[Math.min(9, Math.max(0, Math.floor(s * 10)))]++;
  console.log('best same-Pokémon English match per Japanese card (raw cosine):');
  hist.forEach((n, i) => console.log(`  ${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}: ${'#'.repeat(Math.round(n / 25))} ${n}`));
}
await fs.writeFile(path.join(ROOT, 'data-pipeline', 'dist', 'art-twins-ja.json'), JSON.stringify(out));
console.log(`Japanese cards without a picture: ${best.length} compared; same-art English print found for ${Object.keys(out).length} (≥ ${SAME_ART})`);
