// TCGplayer data for Japanese cards — and the Japanese sets TCGdex lists without any cards.
// TCGdex only has Cardmarket (EUR) for Japanese cards, no Japanese images since 2025, and 68 Japanese
// sets (ADV, LEGEND, XY, S-era halves…) with set headers but zero cards (tester audit 2026-10-13).
// TCGplayer sells all of it in its "Pokemon Japan" line (category 85): tcgcsv.com publishes that
// catalogue and prices daily as static JSON. Set codes mostly match TCGdex's (M4, SV5a…); older sets and
// twin halves are matched by release date.
// What this writes:
//   dist/tcgplayer-ja.json  { updated, cards: { <jaCardId>: [productId, { holofoil: 13.43, … } | null, hasImage 0|1] } }
//   dist/index-ja.json      rewritten: empty sets filled with cards built from TCGplayer products (English
//                           names — the official Japanese names come later from tools/ja-names.mjs),
//                           every set gets `en` (TCGplayer's English set name), and sets that still have
//                           no cards (incl. the Chinese CS* sets TCGdex files under Japanese) are dropped.
// tcgcsv usage guidelines (tcgcsv.com/docs#usage-guidelines): named User-Agent, ≥100 ms between requests,
// one request at a time, one sync per day and only when last-updated.txt is newer. The last sync (cards,
// filled sets, English names) is kept in cache/tcgcsv-ja.json (committed) and re-applied on other days.
// Usage: node tools/jp-prices.mjs   (after build.mjs — needs dist/index-ja.json and dist/index-en.json)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data-pipeline');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'tcgplayer-ja.json');
const IX_FILE = path.join(DIST, 'index-ja.json');
const BASE = 'https://tcgcsv.com/tcgplayer/85';
const UA = { 'User-Agent': 'TCGMarketplaceData/1.0 (+https://github.com/risingmediajp/tcg-marketplace-data)' };
const CACHE_FILE = path.join(ROOT, 'cache', 'tcgcsv-ja.json');
const CACHE_V = 4;
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
// TCGdex-style local id for a TCGplayer number: "35/83" → "035", "SV-P 012" → "SV-P 012".
const localIdOf = (n) => { const s = String(n ?? '').split('/')[0].trim(); return /^\d+$/.test(s) ? s.padStart(3, '0') : s; };
const productNum = (p) => (p.extendedData ?? []).find((e) => e.name === 'Number')?.value;
const productRarity = (p) => { const r = (p.extendedData ?? []).find((e) => e.name === 'Rarity')?.value ?? ''; return /^none$/i.test(r) ? '' : r; };
// "Mega Floette ex - 115/083" → "Mega Floette ex"
const cardName = (p) => p.name.replace(/\s*[-–]\s*[A-Za-z0-9-]+\s*\d*\/\d+\s*$/, '').replace(/\s*\(.*\)\s*$/, '').trim();
// TCGplayer printing → TCGdex pricing key (what the app's priceFor() reads).
const KEY = { Holofoil: 'holofoil', Normal: 'normal', 'Reverse Holofoil': 'reverse-holofoil', '1st Edition Holofoil': '1st-edition-holofoil', '1st Edition': '1st-edition-normal', Unlimited: 'unlimited-normal', 'Unlimited Holofoil': 'unlimited-holofoil' };
const day = (d) => Date.parse(String(d).slice(0, 10)) / 864e5;
const groupEnName = (g) => g.name.replace(/^[A-Za-z0-9.+-]+:\s*/, '').trim();

// Species by English name, longest name first, so "Mega Charizard X ex" → Charizard, "Mr. Mime" → Mr. Mime.
function speciesFinder(en) {
  const list = en.species.map(([dex, name]) => [dex, name.toLowerCase()]).sort((a, b) => b[1].length - a[1].length);
  return (name) => {
    const n = ` ${name.toLowerCase()} `;
    const hit = list.find(([, s]) => n.includes(` ${s} `) || n.includes(`'s ${s} `));
    return hit ? [hit[0]] : [];
  };
}

// Vintage Japanese sets (1996–2001) had no collector numbers. TCGdex numbers them arbitrarily and names
// them by machine translation ("ビルからのメール" for Mail from Bill); TCGplayer carries every card with its
// English name and a photo of the actual Japanese print, unnumbered. Such a set — TCGplayer products
// unnumbered, TCGdex rows without pictures — is REBUILT from TCGplayer: numbered in product order, each
// card linked to its English print by name in the paired Western set (VINTAGE_EN) so tools/ja-names.mjs
// can read the official Japanese name from Bulbapedia and the scanner knows the twin artwork.
const VINTAGE_EN = {
  PMCG1: 'base1', PMCG2: 'base2', PMCG3: 'base3', PMCG4: 'base5', PMCG5: 'gym1', PMCG6: 'gym2',
  neo1: 'neo1', neo2: 'neo2', neo3: 'neo3', neo4: 'neo4',
  E1: 'ecard1', E2: 'ecard2', E3: 'ecard2', E4: 'ecard3', E5: 'ecard3', // e-series halves ↔ Expedition / Aquapolis / Skyridge
  PCG3: 'ex7', PCG1: 'ex6', PCG2: 'ex6', PCG4: 'ex9', PCG5: 'ex10', PCG6: 'ex11', PCG8: 'ex12', PCG9: 'ex13',
};
const alnum = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function sync(ix, en) {
  const findSpecies = speciesFinder(en);
  const cardsBySet = new Map(); // si -> Map(num -> id)
  const picturedBySet = new Map(); // si -> cards with a TCGdex image
  for (const [id, , si, localId, , , , img] of ix.cards) {
    if (!cardsBySet.has(si)) cardsBySet.set(si, new Map());
    cardsBySet.get(si).set(normNum(localId), id);
    if (img) picturedBySet.set(si, (picturedBySet.get(si) ?? 0) + 1);
  }
  const enSetIdx = new Map(en.sets.map((s, i) => [s.id, i]));
  const enByName = (setId) => {
    const m = new Map();
    for (const c of en.cards) if (c[2] === enSetIdx.get(setId)) (m.get(alnum(c[1])) ?? m.set(alnum(c[1]), []).get(alnum(c[1]))).push(c);
    return m;
  };
  const code = (a) => a.toLowerCase().replace(/\+$/, 'p');
  const all = await get(`${BASE}/groups`);
  const byCode = new Map(all.filter((g) => g.abbreviation).map((g) => [code(g.abbreviation), g]));
  // Candidates per set: the same code, else groups released within 2 days. Sets with cards pick the
  // candidate whose numbers match best; empty sets can't, so twin halves released together
  // (XY1a/XY1b ↔ Collection X/Y) are paired by order: TCGdex's "a" with the lower TCGplayer group id.
  const plan = [];
  ix.sets.forEach((s, si) => {
    const empty = !cardsBySet.get(si)?.size;
    const g = byCode.get(s.id.toLowerCase());
    if (g) { plan.push({ si, cands: [g], empty }); return; }
    if (!s.date) return;
    // Within 2 days of TCGdex's date; failing that, within 45 days (TCGdex and TCGplayer disagree on a few
    // vintage release dates — the card-count guard keeps a wrong set out).
    const cands = all.filter((x) => Math.abs(day(x.publishedOn) - day(s.date)) <= 45 && !ix.sets.some((o) => o !== s && code(x.abbreviation ?? '') === o.id.toLowerCase()));
    if (cands.length) plan.push({ si, cands, byDate: true, empty });
  });
  log(`tcgplayer-ja: ${plan.length} of ${ix.sets.length} Japanese sets have TCGplayer candidates`);

  const out = {}, enNames = {}, synth = {}, enMatches = {};
  const fetched = new Map();
  const load = async (g) => {
    if (!fetched.has(g.groupId)) fetched.set(g.groupId, { products: await get(`${BASE}/${g.groupId}/products`), prices: await get(`${BASE}/${g.groupId}/prices`) });
    return fetched.get(g.groupId);
  };
  for (const { si, cands, byDate, empty } of plan) {
    const s = ix.sets[si];
    let byNum = cardsBySet.get(si) ?? new Map();
    // A set whose TCGdex rows have no pictures and whose TCGplayer products are unnumbered gets REBUILT.
    const unpictured = !empty && (picturedBySet.get(si) ?? 0) < byNum.size * 0.1;
    let products, prices, group, mode = null;
    try {
      // Per candidate: numbered products against a set with cards → match by card numbers; otherwise
      // (empty set, or unnumbered vintage products) → by card count against TCGdex's total, twins
      // released together (XY1a/XY1b ↔ Collection X/Y) paired by order (TCGdex "a" ↔ lower group id).
      let bestHits = -1, bestGap = Infinity;
      const ordered = [...cands].sort((a, b) => a.groupId - b.groupId);
      const twinK = ix.sets.filter((o) => o.date === s.date && !cardsBySet.get(ix.sets.indexOf(o))?.size).sort((a, b) => a.id.localeCompare(b.id)).indexOf(s);
      const target = s.total || s.official || 0;
      for (const [k, g] of ordered.entries()) {
        const d = await load(g);
        const count = d.products.length;
        const numbered = d.products.filter((p) => productNum(p)).length;
        if (!empty && numbered >= count * 0.5) {
          const hits = d.products.filter((p) => byNum.has(normNum(productNum(p)))).length;
          if (hits > bestHits && (mode !== 'count' || hits >= byNum.size * 0.3)) { bestHits = hits; mode = 'num'; ({ products, prices } = d); group = g; }
        } else if (mode !== 'num') {
          const gap = Math.floor(Math.abs(count - (target || count)) / 10) + (k === twinK ? 0 : 0.5);
          const close = !target || Math.abs(count - target) <= Math.max(15, target * 0.4);
          if (count >= 5 && close && gap < bestGap) { bestGap = gap; bestHits = count; mode = 'count'; ({ products, prices } = d); group = g; }
        }
      }
      if (!mode) continue;
      if (mode === 'num' && byDate && bestHits < byNum.size * 0.3) continue;
    } catch (e) { console.log(`::warning::${e.message}`); continue; }
    enNames[s.id] = groupEnName(group);
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
    const rebuild = mode === 'count' && !empty && unpictured;
    if (rebuild) {
      // Replace TCGdex's rows: product order, numbered 001…, English names, linked to the English print.
      const pool = VINTAGE_EN[s.id] ? enByName(VINTAGE_EN[s.id]) : null;
      const rows = [];
      let n = 0;
      byNum = new Map();
      for (const p of products.filter((p) => !/\(/.test(p.name) || !products.some((q) => q !== p && cardName(q) === cardName(p)))) {
        const name = cardName(p);
        const localId = String(++n).padStart(3, '0');
        const id = `${s.id}-${localId}`;
        const pr = priceBy.get(p.productId) ?? {};
        const vb = (pr['reverse-holofoil'] ? 2 : 0) | (pr.holofoil ? 4 : 0) | (pr.normal || !pr.holofoil ? 1 : 0);
        rows.push([id, name, localId, findSpecies(name), productRarity(p), vb]);
        byNum.set(normNum(localId), id);
        const twins = pool?.get(alnum(name));
        if (twins?.length === 1 && twins[0][7]) enMatches[id] = twins[0][0];
        out[id] = [p.productId, priceBy.get(p.productId) ?? null, p.imageCount > 0 || p.imageUrl ? 1 : 0];
      }
      synth[s.id] = rows;
      continue;
    }
    if (empty) {
      // Build the set's cards from the products (English names for now).
      const bestByNum = new Map();
      for (const p of products) {
        const num = productNum(p);
        if (!num) continue;
        const k = normNum(num);
        if (!bestByNum.has(k) || score(p) > score(bestByNum.get(k))) bestByNum.set(k, p);
      }
      const rows = [];
      for (const [, p] of [...bestByNum.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
        const localId = localIdOf(productNum(p));
        const id = `${s.id}-${localId}`;
        const name = cardName(p);
        const pr = priceBy.get(p.productId) ?? {};
        const vb = (pr['reverse-holofoil'] ? 2 : 0) | (pr.holofoil ? 4 : 0) | (pr.normal || !pr.holofoil ? 1 : 0);
        rows.push([id, name, localId, findSpecies(name), productRarity(p), vb]);
        byNum.set(normNum(productNum(p)), id);
      }
      synth[s.id] = rows;
    }
    const best = new Map();
    for (const p of products) {
      const id = byNum.get(normNum(productNum(p)));
      if (!id) continue;
      const cur = best.get(id);
      if (!cur || score(p) > score(cur)) best.set(id, p);
    }
    for (const [id, p] of best) {
      const img = p.imageCount > 0 || p.imageUrl ? 1 : 0;
      if (priceBy.has(p.productId) || img) out[id] = [p.productId, priceBy.get(p.productId) ?? null, img];
    }
  }
  return { cards: out, enNames, synth, enMatches };
}

// Apply a sync's filled sets + English names to the index, then drop sets that still have no cards.
function applyToIndex(ix, { enNames, synth }) {
  const rarityIdx = (r) => { let i = ix.rarities.indexOf(r); if (i < 0) { i = ix.rarities.length; ix.rarities.push(r); } return i; };
  const count = new Map();
  for (const c of ix.cards) count.set(c[2], (count.get(c[2]) ?? 0) + 1);
  let added = 0;
  ix.sets.forEach((s, si) => {
    if (enNames[s.id]) s.en = enNames[s.id];
    if (!synth[s.id]) return;
    if (count.get(si)) ix.cards = ix.cards.filter((c) => c[2] !== si); // rebuilt set: TCGdex rows out
    for (const [id, name, localId, dex, rarity, vb] of synth[s.id]) {
      ix.cards.push([id, name, si, localId, dex, rarityIdx(rarity), vb, 0]);
      added++;
    }
    count.set(si, synth[s.id].length);
  });
  const keep = ix.sets.map((s, si) => (count.get(si) ?? 0) > 0);
  const newIndex = new Map();
  ix.sets = ix.sets.filter((s, si) => { if (!keep[si]) return false; newIndex.set(si, newIndex.size); return true; });
  const dropped = keep.filter((k) => !k).length;
  ix.cards = ix.cards.filter((c) => keep[c[2]]).map((c) => { c[2] = newIndex.get(c[2]); return c; });
  // Species list: make sure every dex number used has an entry (name = first card's name with that species).
  const have = new Set(ix.species.map(([d]) => d));
  for (const c of ix.cards) for (const d of c[4]) if (!have.has(d)) { have.add(d); ix.species.push([d, c[1]]); }
  return { added, dropped };
}

const ix = JSON.parse(await fs.readFile(IX_FILE, 'utf8'));
const en = JSON.parse(await fs.readFile(path.join(DIST, 'index-en.json'), 'utf8'));
const lastUpdated = (await (await fetch('https://tcgcsv.com/last-updated.txt', { headers: UA })).text()).trim();
const prev = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8').catch(() => 'null'));
const prevOk = prev?.v === CACHE_V && Object.keys(prev.cards ?? {}).length >= MIN_CARDS;

let result = prevOk ? prev : null;
if (prevOk && prev.lastUpdated === lastUpdated) {
  log(`tcgplayer-ja: tcgcsv unchanged since ${lastUpdated}, reusing ${Object.keys(prev.cards).length} cards`);
} else {
  const r = await sync(ix, en);
  const n = Object.keys(r.cards).length;
  const priced = Object.values(r.cards).filter((c) => c[1]).length;
  const pictured = Object.values(r.cards).filter((c) => c[2]).length;
  log(`tcgplayer-ja: ${n} Japanese cards matched (${priced} priced, ${pictured} pictured); ${Object.keys(r.synth).length} empty sets filled from TCGplayer`);
  if (n >= MIN_CARDS) {
    result = { v: CACHE_V, lastUpdated, updated: new Date().toISOString(), ...r };
    await fs.writeFile(CACHE_FILE, JSON.stringify(result));
  } else {
    console.log('::warning::too few Japanese cards matched — republishing the previous sync');
  }
}
if (result) {
  const { added, dropped } = applyToIndex(ix, result);
  // English-print links for rebuilt vintage sets → the art/name tools' match table.
  if (result.enMatches && Object.keys(result.enMatches).length) {
    const mf = path.join(ROOT, 'cache', 'ja-art', 'matches.json');
    const m = JSON.parse(await fs.readFile(mf, 'utf8').catch(() => '{}'));
    const rebuiltSets = new Set(Object.keys(result.synth));
    for (const k of Object.keys(m)) if (rebuiltSets.has(k.replace(/-[^-]+$/, '')) && !result.enMatches[k]) delete m[k]; // stale TCGdex ids
    Object.assign(m, result.enMatches);
    await fs.mkdir(path.dirname(mf), { recursive: true });
    await fs.writeFile(mf, JSON.stringify(m));
  }
  await fs.writeFile(IX_FILE, JSON.stringify(ix));
  await fs.writeFile(OUT, JSON.stringify({ updated: result.updated, cards: result.cards }));
  log(`index-ja: +${added} cards in filled sets, ${dropped} empty sets dropped → ${ix.sets.length} sets, ${ix.cards.length} cards`);
} else console.log('::warning::no TCGplayer Japan data to publish');
