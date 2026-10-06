// Official image links for Japanese cards that TCGdex has no image for (owner decision 2026-10-03).
// Card identity comes from type-null/PTCG-database (MIT; data_jp scraped from the official Japanese
// card database), whose set code + number map 1:1 onto TCGdex ids ("M2a" + "112" -> "M2a-112").
// The images themselves are only ever fetched once to compute a fingerprint and are not stored
// (see build-embeddings.mjs). Output: data-pipeline/cache/official-ja.json { tcgdexId: imageUrl }.
// Usage: node tools/recog/official-ja.mjs   (clones/updates the dataset sparsely into cache/ptcg-db)

import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ROOT, loadIndex } from './common.mjs';

const REPO = path.join(ROOT, 'data-pipeline', 'cache', 'ptcg-db');
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

try {
  await fs.access(path.join(REPO, '.git'));
  run('git pull -q --depth 1', REPO);
} catch {
  await fs.rm(REPO, { recursive: true, force: true });
  run(`git clone -q --depth 1 --filter=blob:none --sparse https://github.com/type-null/PTCG-database.git "${REPO}"`, ROOT);
  run('git sparse-checkout set data_jp', REPO);
}

const ja = await loadIndex('ja');
const imageless = new Set(ja.cards.filter((c) => !c[7]).map((c) => c[0]));
const out = {};
const dir = path.join(REPO, 'data_jp');
for (const set of await fs.readdir(dir)) {
  for (const f of await fs.readdir(path.join(dir, set))) {
    if (!f.endsWith('.json')) continue;
    try {
      const r = JSON.parse(await fs.readFile(path.join(dir, set, f), 'utf8'));
      const id = `${r.set_name}-${r.number}`;
      if (r.img && imageless.has(id) && /^https:\/\/www\.pokemon-card\.com\//.test(r.img)) out[id] = r.img;
    } catch { /* malformed record */ }
  }
}
await fs.writeFile(path.join(ROOT, 'data-pipeline', 'cache', 'official-ja.json'), JSON.stringify(out));
console.log(`imageless Japanese cards: ${imageless.size}; official image found for ${Object.keys(out).length}`);
