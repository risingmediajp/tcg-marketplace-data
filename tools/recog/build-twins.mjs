// Japanese "art twins": TCGdex has no images for Japanese sets since ~April 2025, but those cards
// are usually reprinted in English with the same artwork a few months later (MEGA Dream ex → Ascended
// Heroes). The scanner recognises the English print by its art and then offers these Japanese cards.
//   dist/twins-ja.json  { "<en card id>": ["<ja card id>", …] }
// Candidates: Japanese cards WITHOUT an image whose Pokémon (dex numbers) and card kind (ex, V, VMAX,
// VSTAR, BREAK, GX, plain) match an English card WITH an image released 0–10 months later.

import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadIndex } from './common.mjs';

const MONTH = 30.5 * 86400e3;
const kind = (name) => {
  const n = String(name);
  for (const k of ['VMAX', 'VSTAR', 'BREAK', 'GX', 'EX']) if (new RegExp(`${k}\\b`).test(n)) return k;
  if (/ex\b/.test(n)) return 'ex';
  if (/\bV\b|V$/.test(n)) return 'V';
  return '';
};
// Trainer-owned Pokémon ("N's Zoroark ex" / "Nのゾロアークex") are different cards from plain ones.
const owned = (name) => /'s |の/.test(name);

const en = await loadIndex('en'), ja = await loadIndex('ja');
const date = (ix, c) => Date.parse(ix.sets[c[2]].date || 0);
const key = (ix, c) => `${[...c[4]].sort().join(',')}|${kind(c[1])}|${owned(c[1]) ? 'owned' : ''}`;

const enByKey = new Map();
for (const c of en.cards) {
  if (!c[7] || !c[4]?.length) continue;
  const k = key(en, c);
  if (!enByKey.has(k)) enByKey.set(k, []);
  enByKey.get(k).push(c);
}

const twins = {};
let jaNoImage = 0, linked = 0;
for (const c of ja.cards) {
  if (c[7] || !c[4]?.length) continue;
  jaNoImage++;
  const t = date(ja, c);
  const matches = (enByKey.get(key(ja, c)) ?? []).filter((e) => { const d = date(en, e) - t; return d >= -1 * MONTH && d <= 10 * MONTH; });
  if (!matches.length) continue;
  linked++;
  for (const e of matches) (twins[e[0]] ??= []).push(c[0]);
}
await fs.writeFile(path.join(ROOT, 'data-pipeline', 'dist', 'twins-ja.json'), JSON.stringify(twins));
console.log(`Japanese Pokémon cards without images: ${jaNoImage}; linked to an English art twin: ${linked}; English cards with twins: ${Object.keys(twins).length}`);
