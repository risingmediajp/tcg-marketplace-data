// Pictures for the Japanese cards nothing else covers (owner decision 2026-10-10: fill every gap).
// After TCGdex images, TCGplayer photos (jp-prices.mjs) and artwork-verified English twins
// (build-art-twins.mjs), what's left is vintage 1996–2006 sets, the Japan-only VS set and promos.
//   1. Vintage sets share their illustrations with the English sets of the same era: each Japanese card
//      is matched to its English print by species + a language-independent fingerprint (HP, stage,
//      retreat, attack costs and damage; energy by type) from TCGdex card details. Shown as "EN art".
//   2. VS (Japan-only): card scans from Bulbapedia, found through its API one page per card.
//   3. Promos and the rest with an official image (official-ja.mjs mapping): the pokemon-card.com image.
// Pictures from 2 and 3 are baked at 600 px into cache/thumbs/ja/<serie>/<set>/<localId>.webp (persisted
// on the thumbs-cache branch like the English thumbnails) and published under dist/thumbs/ja/.
// Output dist/ja-art.json: { v, cards: { <jaId>: <enId> | 1 } }   (1 = own picture under thumbs/ja/)
// Everything fetched is cached in cache/ja-art/ (committed) so nightly runs only handle new cards.
// Usage: node tools/fill-ja-art.mjs   (after build, jp-prices, the recog step and bake-card-thumbs)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data-pipeline');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, 'cache', 'ja-art');
const THUMBS = path.join(ROOT, 'cache', 'thumbs', 'ja');
const API = 'https://api.tcgdex.net/v2';
const BULBA = 'https://bulbapedia.bulbagarden.net/w/api.php';
const UA = { 'User-Agent': 'TCGMarketplaceData/1.0 (risingmediajp@gmail.com)' };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const readJson = async (f, fb) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fb; } };
const writeJson = (f, d) => fs.writeFile(f, JSON.stringify(d));
const exists = (f) => fs.access(f).then(() => true, () => false);

async function getJson(url, headers = UA, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) { console.log(`::warning::${url}: ${e.message}`); return null; }
      await sleep(1500 * i);
    }
  }
}
async function getBytes(url, headers = UA) {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i === 3) { console.log(`::warning::${url}: ${e.message}`); return null; }
      await sleep(1500 * i);
    }
  }
  return null;
}
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

// ---------- what's missing ----------
await fs.mkdir(CACHE, { recursive: true });
const ja = await readJson(path.join(DIST, 'index-ja.json'));
const en = await readJson(path.join(DIST, 'index-en.json'));
const artTwins = await readJson(path.join(DIST, 'art-twins-ja.json'), {});
const tcgp = (await readJson(path.join(DIST, 'tcgplayer-ja.json'), { cards: {} })).cards;
const official = await readJson(path.join(ROOT, 'cache', 'official-ja.json'), {});
const officialUrl = (id) => (official.cards ?? official)[id]?.url ?? (official.cards ?? official)[id];
const jaCards = ja.cards.map(([id, name, si, localId, dex]) => ({ id, name, si, set: ja.sets[si], localId, dex }));
const missing = jaCards.filter((c) => !ja.cards.find((t) => t[0] === c.id)[7] && !tcgp[c.id]?.[2] && !artTwins[c.id]);
log(`ja-art: ${missing.length} Japanese cards without any picture`);

const out = await readJson(path.join(CACHE, 'matches.json'), {}); // persisted results: jaId -> enId | 1
const stillMissing = () => missing.filter((c) => !out[c.id]);

// ---------- 1. vintage sets: fingerprint match against the English sets of the same era ----------
const POOLS = {
  PMCG1: ['base1'], PMCG2: ['base2', 'base1'], PMCG3: ['base3', 'base2'], PMCG4: ['base5'],
  PMCG5: ['gym1', 'gym2'], PMCG6: ['gym2', 'gym1'], neo1: ['neo1'], neo2: ['neo2', 'neo1'],
  neo3: ['neo3', 'neo2'], neo4: ['neo4', 'neo3'], PCG3: ['ex7'],
};
const details = await readJson(path.join(CACHE, 'details.json'), {}); // "lang:id" -> fingerprint fields
async function detail(lang, id) {
  const k = `${lang}:${id}`;
  if (details[k] !== undefined) return details[k];
  await sleep(80);
  const d = await getJson(`${API}/${lang}/cards/${encodeURIComponent(id)}`);
  details[k] = d ? {
    cat: d.category, hp: d.hp ?? null, stage: d.stage ?? null, retreat: d.retreat ?? null, energy: d.energyType ?? null,
    // Variable damage ("30×", "10+") is blank in TCGdex's Japanese data: compare fixed damage only.
    atk: (d.attacks ?? []).map((a) => `${[...(a.cost ?? [])].sort().join('+')}=${/^\d+$/.test(String(a.damage ?? '')) ? a.damage : ''}`),
    dex: d.dexId ?? [],
  } : null;
  return details[k];
}
// Pokémon: species + HP + stage + retreat + attacks. Energy: type. Trainers have no language-free key.
const fixedDmg = (a) => a.replace(/=(.*)$/, (m, v) => (/^\d+$/.test(v) ? `=${v}` : '='));
const fp = (d) => {
  if (!d) return null;
  if (d.cat === 'Pokemon') return `P|${d.dex.join(',')}|${d.hp}|${d.stage}|${d.retreat}|${d.atk.map(fixedDmg).join(';')}`;
  if (d.cat === 'Energy') return `E|${d.energy}`;
  return null;
};
const enIdx = new Map(en.sets.map((s, i) => [s.id, i]));
const enCardsBySet = (sid) => en.cards.filter((c) => c[2] === enIdx.get(sid) && c[7]).map(([id]) => id);

const vintage = stillMissing().filter((c) => POOLS[c.set.id]);
if (vintage.length) {
  log(`ja-art: fingerprinting ${vintage.length} vintage cards`);
  const poolFp = new Map(); // setId -> Map(fp -> [enId])
  for (const [jset, pool] of Object.entries(POOLS)) {
    if (!vintage.some((c) => c.set.id === jset)) continue;
    for (const esid of pool) {
      if (poolFp.has(esid)) continue;
      const m = new Map();
      for (const eid of enCardsBySet(esid)) {
        const f = fp(await detail('en', eid));
        if (f) (m.get(f) ?? m.set(f, []).get(f)).push(eid);
      }
      poolFp.set(esid, m);
    }
  }
  // Second tier for TCGdex data quirks (stage/retreat typos, one blank damage): species + HP + attack
  // costs, still unique within the paired set.
  const loose = (d) => (d?.cat === 'Pokemon' ? `L|${d.dex.join(',')}|${d.hp}|${d.atk.map((a) => a.split('=')[0]).join(';')}` : null);
  const poolLoose = new Map();
  for (const [esid, m] of poolFp) {
    const lm = new Map();
    for (const eid of enCardsBySet(esid)) { const l = loose(details[`en:${eid}`]); if (l) (lm.get(l) ?? lm.set(l, []).get(l)).push(eid); }
    poolLoose.set(esid, lm);
  }
  let hit = 0, hitLoose = 0;
  for (const c of vintage) {
    const d = await detail('ja', c.id);
    const f = fp(d), l = loose(d);
    if (!f) continue;
    let done = false;
    for (const esid of POOLS[c.set.id]) {
      const cands = poolFp.get(esid)?.get(f);
      if (cands?.length === 1) { out[c.id] = cands[0]; hit++; done = true; break; }
    }
    if (done || !l) continue;
    for (const esid of POOLS[c.set.id]) {
      const cands = poolLoose.get(esid)?.get(l);
      if (cands?.length === 1) { out[c.id] = cands[0]; hitLoose++; break; }
    }
  }
  if (hitLoose) log(`ja-art: vintage loose-matched ${hitLoose} more`);
  await writeJson(path.join(CACHE, 'details.json'), details);
  log(`ja-art: vintage matched ${hit}/${vintage.length}`);
}

// ---------- 1b. vintage leftovers (trainers, energy, look-alike Pokémon): Bulbapedia by Japanese name ----------
// Bulbapedia card pages carry the Japanese name, so searching it with the English set's name returns
// "Switch (Base Set 95)" → base1-95. Only a title in one of the paired English sets is accepted.
const bulbaNames = await readJson(path.join(CACHE, 'bulba-names.json'), {}); // jaId -> enId | null
const enSetByName = new Map(en.sets.map((s) => [s.name.toLowerCase(), s.id]));
const leftovers = stillMissing().filter((c) => POOLS[c.set.id] && bulbaNames[c.id] === undefined);
if (leftovers.length) {
  let got = 0;
  for (const c of leftovers) {
    const poolNames = POOLS[c.set.id].map((id) => en.sets.find((s) => s.id === id)?.name).filter(Boolean);
    await sleep(300);
    const r = await getJson(`${BULBA}?action=query&list=search&srsearch=${encodeURIComponent(`"${c.name}" ${poolNames[0]}`)}&srlimit=8&format=json`);
    let found = null;
    for (const { title } of r?.query?.search ?? []) {
      const m = title.match(/^(.*) \((.+?) (\d+)\)$/);
      if (!m) continue;
      const setId = enSetByName.get(m[2].toLowerCase());
      if (!setId || !POOLS[c.set.id].includes(setId)) continue;
      const enId = `${setId}-${Number(m[3])}`;
      if (!en.cards.some((x) => x[0] === enId && x[7])) continue;
      // The search also hits pages that merely contain the name ("カツラ" → Blaine's Magmar): the page's
      // own Japanese-name field must be exactly this card's name.
      await sleep(250);
      const w = await getJson(`${BULBA}?action=query&prop=revisions&titles=${encodeURIComponent(title)}&rvprop=content&rvslots=main&format=json`);
      const text = Object.values(w?.query?.pages ?? {})[0]?.revisions?.[0]?.slots?.main?.['*'] ?? '';
      const jnames = [...text.matchAll(/\|\s*jname\s*=\s*([^\n|]+)/g)].map((x) => x[1].trim());
      if (!jnames.includes(c.name.trim())) continue;
      found = enId; break;
    }
    bulbaNames[c.id] = found;
    if (found) { out[c.id] = found; got++; }
  }
  await writeJson(path.join(CACHE, 'bulba-names.json'), bulbaNames);
  log(`ja-art: Bulbapedia name lookups matched ${got}/${leftovers.length}`);
}
for (const c of stillMissing()) if (bulbaNames[c.id]) out[c.id] = bulbaNames[c.id];

// ---------- 2 + 3. own pictures: bake into cache/thumbs/ja ----------
async function bake(c, bytes) {
  const file = path.join(THUMBS, safe(c.set.serie), safe(c.set.id), `${safe(c.localId)}.webp`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, await sharp(bytes).resize({ width: 600, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer());
  out[c.id] = 1;
}
const thumbPath = (c) => path.join(THUMBS, safe(c.set.serie), safe(c.set.id), `${safe(c.localId)}.webp`);
// Cards whose picture was baked on an earlier run (cache restored) but whose match record was lost.
for (const c of stillMissing()) if (await exists(thumbPath(c))) out[c.id] = 1;

// VS (Japan-only): Bulbapedia card pages are linked from the set page as "Name (VS N)".
const vs = stillMissing().filter((c) => c.set.id === 'VS1');
if (vs.length) {
  const pages = await readJson(path.join(CACHE, 'bulba-vs.json'), null) ?? await (async () => {
    const r = await getJson(`${BULBA}?action=query&prop=links&titles=${encodeURIComponent('Pokémon VS (TCG)')}&pllimit=500&plnamespace=0&format=json`);
    const links = Object.values(r?.query?.pages ?? {})[0]?.links ?? [];
    const byNum = {};
    for (const { title } of links) { const m = title.match(/\(VS (\d+)\)$/); if (m) byNum[String(Number(m[1]))] = title; }
    await writeJson(path.join(CACHE, 'bulba-vs.json'), byNum);
    return byNum;
  })();
  let got = 0;
  for (const c of vs) {
    const title = pages[String(Number(c.localId))];
    if (!title) continue;
    await sleep(300);
    const r = await getJson(`${BULBA}?action=query&prop=images&titles=${encodeURIComponent(title)}&imlimit=50&format=json`);
    const imgs = (Object.values(r?.query?.pages ?? {})[0]?.images ?? []).map((i) => i.title).filter((t) => /VS\d+\.(jpe?g|png)$/i.test(t));
    if (!imgs.length) continue;
    await sleep(300);
    const info = await getJson(`${BULBA}?action=query&titles=${encodeURIComponent(imgs[0])}&prop=imageinfo&iiprop=url&format=json`);
    const url = Object.values(info?.query?.pages ?? {})[0]?.imageinfo?.[0]?.url;
    if (!url) continue;
    await sleep(500);
    const bytes = await getBytes(url);
    if (bytes) { await bake(c, bytes); got++; }
  }
  log(`ja-art: VS scans ${got}/${vs.length}`);
}

// Official pokemon-card.com image (promos and recent cards TCGplayer doesn't carry).
const off = stillMissing().filter((c) => officialUrl(c.id));
if (off.length) {
  let got = 0;
  for (const c of off) {
    await sleep(400);
    const bytes = await getBytes(officialUrl(c.id), { 'User-Agent': 'Mozilla/5.0 (compatible; TCGMarketplaceData/1.0)' });
    if (bytes) { await bake(c, bytes); got++; }
  }
  log(`ja-art: official images ${got}/${off.length}`);
}

// ---------- publish ----------
await writeJson(path.join(CACHE, 'matches.json'), out);
const cards = Object.fromEntries(Object.entries(out).filter(([id]) => missing.some((c) => c.id === id) || out[id] === 1));
await writeJson(path.join(DIST, 'ja-art.json'), { v: 1, cards });
if (await exists(THUMBS)) await fs.cp(THUMBS, path.join(DIST, 'thumbs', 'ja'), { recursive: true });
const left = stillMissing();
log(`ja-art: ${Object.keys(cards).length} filled (${Object.values(cards).filter((v) => v === 1).length} own pictures), ${left.length} still without`);
const perSet = {};
for (const c of left) perSet[c.set.id] = (perSet[c.set.id] ?? 0) + 1;
if (left.length) log('  remaining by set:', Object.entries(perSet).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}:${n}`).join(' '));
