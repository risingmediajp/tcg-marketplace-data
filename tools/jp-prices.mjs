// TCGplayer prices AND card pictures for Japanese cards. TCGdex only has Cardmarket (EUR) for Japanese
// cards and no Japanese images since 2025, but TCGplayer sells them in its "Pokemon Japan" line
// (category 85) with a photo of each actual card. tcgcsv.com publishes TCGplayer's catalogue and prices
// daily as static JSON; its set abbreviations match TCGdex's Japanese set ids (M4, M2a, SV5a…), and
// products carry the printed number, so cards match exactly by set + number.
// Writes dist/tcgplayer-ja.json:
//   { updated, cards: { <jaCardId>: [productId, { holofoil: 13.43, … } | null, hasImage 0|1] } }
// The app uses it for a Japanese card's USD prices, its exact TCGplayer product link, and its picture
// (tcgplayer-cdn.tcgplayer.com/product/<productId>_in_400x400.jpg — hot-linked, never copied).
// tcgcsv usage guidelines (tcgcsv.com/docs#usage-guidelines): named User-Agent, ≥100 ms between requests,
// one request at a time, at most one sync per day and only when last-updated.txt is newer
// (~250 requests per sync; limit 10,000). The last sync is kept in cache/tcgcsv-ja.json (committed).
// Usage: node tools/jp-prices.mjs   (after build.mjs — needs dist/index-ja.json)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data-pipeline');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'tcgplayer-ja.json');
const BASE = 'https://tcgcsv.com/tcgplayer/85';
const UA = { 'User-Agent': 'TCGMarketplaceData/1.0 (+https://github.com/risingmediajp/tcg-marketplace-data)' };
const CACHE_FILE = path.join(ROOT, 'cache', 'tcgcsv-ja.json');
const MIN_CARDS = 1000; // fewer means something changed upstream: keep the last good sync
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
// "035/083" → "35"; codes like "SV-P 012" compare as printed (upper-case).
const normNum = (n) => { const s = String(n ?? '').split('/')[0].trim(); return /^\d+$/.test(s) ? String(Number(s)) : s.toUpperCase(); };
// TCGplayer printing → TCGdex pricing key (what the app's priceFor() reads).
const KEY = { Holofoil: 'holofoil', Normal: 'normal', 'Reverse Holofoil': 'reverse-holofoil', '1st Edition Holofoil': '1st-edition-holofoil', '1st Edition': '1st-edition-normal', Unlimited: 'unlimited-normal', 'Unlimited Holofoil': 'unlimited-holofoil' };

async function sync(ix) {
  const setByCode = new Map(ix.sets.map((s, i) => [s.id.toLowerCase(), i]));
  const cardsBySet = new Map();
  for (const [id, , si, localId] of ix.cards) {
    if (!cardsBySet.has(si)) cardsBySet.set(si, new Map());
    cardsBySet.get(si).set(normNum(localId), id);
  }
  // Set codes: exact, or TCGdex's "p" for TCGplayer's "+" (SM3p = SM3+).
  const code = (a) => a.toLowerCase().replace(/\+$/, 'p');
  const all = await get(`${BASE}/groups`);
  const byCode = new Map(all.filter((g) => g.abbreviation).map((g) => [code(g.abbreviation), g]));
  // Older sets have no code on TCGplayer: candidates released within 2 days of ours; the one whose
  // card numbers match best wins (needs ≥30% of the set).
  const day = (d) => Date.parse(String(d).slice(0, 10)) / 864e5;
  const plan = [];
  ix.sets.forEach((s, si) => {
    const g = byCode.get(s.id.toLowerCase());
    if (g) plan.push({ si, cands: [g] });
    else if (s.date) {
      const cands = all.filter((x) => !x.abbreviation && Math.abs(day(x.publishedOn) - day(s.date)) <= 2);
      if (cands.length) plan.push({ si, cands, byDate: true });
    }
  });
  log(`tcgplayer-ja: ${plan.length} of ${ix.sets.length} Japanese sets have TCGplayer candidates`);

  const out = {};
  const fetched = new Map();
  const load = async (g) => {
    if (!fetched.has(g.groupId)) fetched.set(g.groupId, { products: await get(`${BASE}/${g.groupId}/products`), prices: await get(`${BASE}/${g.groupId}/prices`) });
    return fetched.get(g.groupId);
  };
  for (const { si, cands, byDate } of plan) {
    const byNum = cardsBySet.get(si);
    if (!byNum) continue;
    let products, prices;
    try {
      let bestHits = -1;
      for (const g of cands) {
        const d = await load(g);
        const hits = d.products.filter((p) => byNum.has(normNum((p.extendedData ?? []).find((e) => e.name === 'Number')?.value))).length;
        if (hits > bestHits) { bestHits = hits; ({ products, prices } = d); }
      }
      if (byDate && bestHits < byNum.size * 0.3) continue;
    } catch (e) { console.log(`::warning::${e.message}`); continue; }
    const priceBy = new Map();
    for (const p of prices) {
      const v = p.marketPrice ?? p.midPrice;
      if (!(v > 0) || !KEY[p.subTypeName]) continue;
      if (!priceBy.has(p.productId)) priceBy.set(p.productId, {});
      priceBy.get(p.productId)[KEY[p.subTypeName]] = v;
    }
    // One product per printed number. Preference: plain card over pattern/stamp variants
    // ("… (Master Ball Pattern)"), then priced, then pictured.
    const score = (p) => (!/\(/.test(p.name) ? 4 : 0) + (priceBy.has(p.productId) ? 2 : 0) + (p.imageCount > 0 || p.imageUrl ? 1 : 0);
    const best = new Map();
    for (const p of products) {
      const num = (p.extendedData ?? []).find((e) => e.name === 'Number')?.value;
      const id = num && byNum.get(normNum(num));
      if (!id) continue;
      const cur = best.get(id);
      if (!cur || score(p) > score(cur)) best.set(id, p);
    }
    for (const [id, p] of best) {
      const img = p.imageCount > 0 || p.imageUrl ? 1 : 0;
      if (priceBy.has(p.productId) || img) out[id] = [p.productId, priceBy.get(p.productId) ?? null, img];
    }
  }
  return out;
}

const ix = JSON.parse(await fs.readFile(path.join(DIST, 'index-ja.json'), 'utf8'));
const lastUpdated = (await (await fetch('https://tcgcsv.com/last-updated.txt', { headers: UA })).text()).trim();
const prev = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8').catch(() => 'null'));
const prevOk = prev?.v === 3 && Object.keys(prev.cards ?? {}).length >= MIN_CARDS;

let result = prevOk ? prev : null;
if (prevOk && prev.lastUpdated === lastUpdated) {
  log(`tcgplayer-ja: tcgcsv unchanged since ${lastUpdated}, reusing ${Object.keys(prev.cards).length} cards`);
} else {
  const cards = await sync(ix);
  const n = Object.keys(cards).length;
  const priced = Object.values(cards).filter((c) => c[1]).length;
  const pictured = Object.values(cards).filter((c) => c[2]).length;
  log(`tcgplayer-ja: ${n} of ${ix.cards.length} Japanese cards matched (${priced} priced, ${pictured} pictured)`);
  if (n >= MIN_CARDS) {
    result = { v: 3, lastUpdated, updated: new Date().toISOString(), cards };
    await fs.writeFile(CACHE_FILE, JSON.stringify(result));
  } else {
    console.log('::warning::too few Japanese cards matched — republishing the previous sync');
  }
}
if (result) await fs.writeFile(OUT, JSON.stringify({ updated: result.updated, cards: result.cards }));
else console.log('::warning::no TCGplayer Japan data to publish');
