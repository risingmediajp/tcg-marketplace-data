// TCGplayer product photos for English cards TCGdex has no image for (~1,600: Shiny Vaults, Trainer
// Galleries, trainer kits, promos, Shining Legends…). Same source and etiquette as jp-prices.mjs
// (tcgcsv.com, TCGplayer category 3 "Pokemon"), images only.
// Set matching: TCGdex's official abbreviation vs TCGplayer's (punctuation-insensitive), else the set's
// name contained in the group's name, else release date within 3 days. Card matching: printed number,
// and the product name must agree with the card name (both English) when a group has several candidates
// or when the set was matched loosely.
// Writes dist/tcgplayer-en.json: { updated, cards: { <enId>: [productId, null, 1] } } (same shape as
// tcgplayer-ja.json). Cached in cache/tcgcsv-en.json (committed), reused while tcgcsv is unchanged.
// Usage: node tools/en-images.mjs   (after build.mjs — needs dist/index-en.json)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data-pipeline');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'tcgplayer-en.json');
const BASE = 'https://tcgcsv.com/tcgplayer/3';
const UA = { 'User-Agent': 'TCGMarketplaceData/1.0 (+https://github.com/risingmediajp/tcg-marketplace-data)' };
const CACHE_FILE = path.join(ROOT, 'cache', 'tcgcsv-en.json');
const MIN_CARDS = 300;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function get(url) {
  for (let i = 1; ; i++) {
    try {
      await sleep(120);
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).results ?? [];
    } catch (e) {
      if (i >= 3) throw new Error(`${url}: ${e.message}`);
      await sleep(2000 * i);
    }
  }
}
const normNum = (n) => { const s = String(n ?? '').split('/')[0].trim(); return /^\d+$/.test(s) ? String(Number(s)) : s.toUpperCase(); };
const alnum = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
// "Charizard ex - 199/165" / "Noivern (1/30)" → "charizardex" / "noivern"
const productName = (p) => alnum(p.name.replace(/\s*[-–(]\s*[A-Za-z0-9]+\/\d+\)?\s*$/, '').replace(/\s*\(.*\)\s*$/, ''));
const day = (d) => Date.parse(String(d).slice(0, 10)) / 864e5;

async function sync(ix) {
  const need = new Map(); // setIndex -> Map(num -> [card])
  for (const c of ix.cards) {
    if (c[7]) continue;
    const [id, name, si, localId] = c;
    if (!need.has(si)) need.set(si, new Map());
    const k = normNum(localId);
    (need.get(si).get(k) ?? need.get(si).set(k, []).get(k)).push({ id, name: alnum(name) });
  }
  const groups = await get(`${BASE}/groups`);
  const byAbbr = new Map(groups.filter((g) => g.abbreviation).map((g) => [alnum(g.abbreviation), g]));
  const out = {};
  let matchedSets = 0;
  for (const [si, byNum] of need) {
    const s = ix.sets[si];
    let cands = [], loose = false;
    const a = byAbbr.get(alnum(s.abbr));
    if (a) cands = [a];
    else {
      const n = alnum(s.name);
      cands = groups.filter((g) => n.length >= 6 && alnum(g.name).includes(n));
      if (!cands.length && s.date) cands = groups.filter((g) => Math.abs(day(g.publishedOn) - day(s.date)) <= 3);
      loose = true;
    }
    if (!cands.length) continue;
    let best = null, bestHits = 0;
    for (const g of cands.slice(0, 4)) {
      let products;
      try { products = await get(`${BASE}/${g.groupId}/products`); } catch (e) { console.log(`::warning::${e.message}`); continue; }
      const hits = [];
      for (const p of products) {
        const num = (p.extendedData ?? []).find((e) => e.name === 'Number')?.value;
        if (!num || !(p.imageCount > 0 || p.imageUrl)) continue;
        const cs = byNum.get(normNum(num));
        if (!cs) continue;
        const pn = productName(p);
        // Several cards share a number (kits, sub-sets) or the set match was loose: the name must agree.
        const card = cs.length === 1 && !loose ? cs[0] : cs.find((c) => c.name === pn || (pn && (c.name.startsWith(pn) || pn.startsWith(c.name))));
        if (card) hits.push([card.id, p.productId, /\(/.test(p.name) ? 0 : 1]);
      }
      if (hits.length > bestHits) { bestHits = hits.length; best = hits; }
    }
    if (!best || (loose && bestHits < Math.min(5, byNum.size) )) continue;
    matchedSets++;
    for (const [id, pid, plain] of best) if (!out[id] || plain) out[id] = [pid, null, 1];
  }
  log(`tcgplayer-en: ${matchedSets}/${need.size} image-less sets matched, ${Object.keys(out).length} cards pictured`);
  return out;
}

const ix = JSON.parse(await fs.readFile(path.join(DIST, 'index-en.json'), 'utf8'));
const lastUpdated = (await (await fetch('https://tcgcsv.com/last-updated.txt', { headers: UA })).text()).trim();
const prev = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8').catch(() => 'null'));
const prevOk = prev?.v === 1 && Object.keys(prev.cards ?? {}).length >= MIN_CARDS;
let result = prevOk ? prev : null;
if (prevOk && prev.lastUpdated === lastUpdated) {
  log(`tcgplayer-en: tcgcsv unchanged since ${lastUpdated}, reusing ${Object.keys(prev.cards).length} cards`);
} else {
  const cards = await sync(ix);
  if (Object.keys(cards).length >= MIN_CARDS) {
    result = { v: 1, lastUpdated, updated: new Date().toISOString(), cards };
    await fs.writeFile(CACHE_FILE, JSON.stringify(result));
  } else console.log('::warning::too few English images matched — republishing the previous sync');
}
if (result) await fs.writeFile(OUT, JSON.stringify({ updated: result.updated, cards: result.cards }));
