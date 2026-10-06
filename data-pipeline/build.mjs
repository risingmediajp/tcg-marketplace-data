// Nightly data build for TCG Marketplace.
// Pulls the card catalogue + prices from TCGdex and writes static files the app downloads:
//   dist/index-<lang>.json   search index (sets, cards, species) per language
//   dist/home.json           showcase sections + remote config
// Incremental: set details and non-English card metadata are cached in cache/ (commit it),
// so after the first run only recent/new sets are re-fetched.
// Usage: node build.mjs [--langs en,ja] [--skip-home] [--skip-index]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateIndex, validateHome } from './validate.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(ROOT, 'cache');
const DIST = path.join(ROOT, 'dist');
const API = 'https://api.tcgdex.net/v2';
const ASSETS = 'https://assets.tcgdex.net';
const CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));

const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const LANGS = argVal('--langs')?.split(',') ?? CONFIG.languages;
const SKIP_HOME = args.includes('--skip-home');
const SKIP_INDEX = args.includes('--skip-index');

const DAY = 86400000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- HTTP (polite: limited concurrency, retries with backoff) ----------
async function fetchJson(url, opts = {}, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { 'User-Agent': 'tcg-marketplace-data/1.0', ...(opts.headers || {}) } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
    }
  }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const gql = (query) => fetchJson(`${API}/graphql`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
});

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
}

// ---------- catalogue ----------
const VARIANT_BITS = { normal: 1, reverse: 2, holo: 4, firstEdition: 8 };
const variantBits = (v = {}) => Object.entries(VARIANT_BITS).reduce((n, [k, b]) => (v[k] ? n | b : n), 0);

// English metadata for every card in one pass (GraphQL is English-only, 100 per page).
async function englishMeta() {
  const meta = new Map();
  for (let page = 1; ; page++) {
    const r = await gql(`{ cards(filters:{name:""}, pagination:{page:${page},count:100}) { id dexId rarity variants { normal reverse holo firstEdition } } }`);
    if (r?.errors) throw new Error('graphql: ' + JSON.stringify(r.errors[0]));
    const cards = r?.data?.cards ?? [];
    for (const c of cards) meta.set(c.id, { dex: c.dexId ?? [], rarity: c.rarity ?? '', vb: variantBits(c.variants) });
    if (cards.length < 100) break;
  }
  if (meta.size < 20000) throw new Error(`TCGdex returned only ${meta.size} English cards — API down? Keeping last published files.`);
  log(`en meta: ${meta.size} cards`);
  return meta;
}

// Set list + per-set card briefs, cached; recent or stale sets are refreshed.
async function loadSets(lang) {
  const cacheFile = path.join(CACHE, lang, 'sets.json');
  const cache = await readJson(cacheFile, {});
  const list = await fetchJson(`${API}/${lang}/sets`);
  if (!Array.isArray(list)) throw new Error(`${lang}: set list unavailable (TCGdex down?)`);
  const now = Date.now();
  const stale = list.filter(({ id }) => {
    const c = cache[id];
    if (!c) return true;
    const released = Date.parse(c.releaseDate || 0);
    return now - released < 400 * DAY || now - c._fetched > 30 * DAY;
  });
  log(`${lang}: ${list.length} sets, fetching ${stale.length}`);
  await pool(stale, 4, async ({ id }) => {
    const s = await fetchJson(`${API}/${lang}/sets/${encodeURIComponent(id)}`);
    if (s) cache[id] = { ...s, _fetched: now };
  });
  await writeJson(cacheFile, cache);
  return list.map(({ id }) => cache[id]).filter(Boolean);
}

// Metadata for cards that don't exist in English (Japanese, Korean, ... exclusives).
async function foreignMeta(lang, ids) {
  const cacheFile = path.join(CACHE, lang, 'meta.json');
  const cache = await readJson(cacheFile, {});
  const missing = ids.filter((id) => !cache[id]);
  if (missing.length) log(`${lang}: fetching metadata for ${missing.length} cards`);
  let done = 0;
  await pool(missing, 6, async (id) => {
    const c = await fetchJson(`${API}/${lang}/cards/${encodeURIComponent(id)}`);
    cache[id] = c ? { dex: c.dexId ?? [], rarity: c.rarity ?? '', vb: variantBits(c.variants) } : { dex: [], rarity: '', vb: 0 };
    if (++done % 500 === 0) { log(`${lang}: ${done}/${missing.length}`); await writeJson(cacheFile, cache); }
  });
  await writeJson(cacheFile, cache);
  return cache;
}

// Species list for "search by Pokémon": the most common name among single-Pokémon cards.
function buildSpecies(cards) {
  const byDex = new Map();
  for (const c of cards) {
    if (c.dex.length !== 1) continue;
    const m = byDex.get(c.dex[0]) ?? new Map();
    m.set(c.name, (m.get(c.name) ?? 0) + 1);
    byDex.set(c.dex[0], m);
  }
  return [...byDex.entries()].sort((a, b) => a[0] - b[0]).map(([dex, names]) => {
    const [name] = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
    return [dex, name];
  });
}

async function buildIndex(lang, enMeta) {
  const sets = (await loadSets(lang))
    .filter((s) => !CONFIG.excludeSeries.includes(s.serie?.id)) // e.g. TCG Pocket: digital-only cards
    .sort((a, b) => (a.releaseDate || '').localeCompare(b.releaseDate || ''));
  const briefs = sets.flatMap((s, si) => (s.cards || []).map((c) => ({ ...c, si })));
  const foreign = lang === 'en' ? {} : await foreignMeta(lang, briefs.map((c) => c.id).filter((id) => !enMeta.has(id)));

  const rarities = [];
  const rarityIdx = (r) => { let i = rarities.indexOf(r); if (i < 0) { i = rarities.length; rarities.push(r); } return i; };
  const cards = briefs.map((c) => {
    const m = enMeta.get(c.id) ?? foreign[c.id] ?? { dex: [], rarity: '', vb: 0 };
    // Image: 0 = none, 1 = default assets path (lang/serie/set/localId), otherwise the explicit path.
    const s = sets[c.si];
    const img = !c.image ? 0
      : c.image === `${ASSETS}/${lang}/${s.serie?.id}/${s.id}/${c.localId}` ? 1
      : c.image.replace(`${ASSETS}/`, '');
    return { id: c.id, name: c.name, si: c.si, localId: c.localId, dex: m.dex, rarity: m.rarity, vb: m.vb, img };
  });

  const index = {
    v: 1, lang, built: new Date().toISOString(),
    sets: sets.map((s) => ({
      id: s.id, name: s.name, serie: s.serie?.id ?? '', serieName: s.serie?.name ?? '',
      date: s.releaseDate ?? '', official: s.cardCount?.official ?? 0, total: s.cardCount?.total ?? 0,
      abbr: s.abbreviation?.official ?? '', logo: s.logo ?? '',
    })),
    rarities: [],
    // card tuple: [id, name, setIndex, localId, dexIds, rarityIndex, variantBits, image(0|1|path)]
    cards: cards.map((c) => [c.id, c.name, c.si, c.localId, c.dex, rarityIdx(c.rarity), c.vb, c.img]),
    species: buildSpecies(cards),
  };
  index.rarities = rarities;
  validateIndex(index);
  return index;
}

// ---------- prices / showcase ----------
function usdOf(pricing) {
  const t = pricing?.tcgplayer;
  if (!t) return null;
  const vals = Object.values(t).filter((v) => v && typeof v === 'object').map((v) => v.marketPrice ?? v.midPrice).filter((n) => n > 0);
  return vals.length ? Math.max(...vals) : null;
}
const eurOf = (pricing) => pricing?.cardmarket?.trend || pricing?.cardmarket?.avg || null;

function showcaseCard(c) {
  return {
    id: c.id, name: c.name, setId: c.set?.id, setName: c.set?.name, localId: c.localId,
    image: c.image ?? null, rarity: c.rarity ?? '', usd: usdOf(c.pricing), eur: eurOf(c.pricing),
  };
}

async function buildHome(enIndex) {
  const sets = enIndex.sets;
  const idsBySet = new Map();
  for (const [id, , si] of enIndex.cards) {
    const sid = sets[si].id;
    if (!idsBySet.has(sid)) idsBySet.set(sid, []);
    idsBySet.get(sid).push(id);
  }
  // Main-line recent sets (skip empty "collection" sets with no official numbering).
  const recent = sets.filter((s) => s.official > 0 && s.date).slice(-CONFIG.recentSets);

  const grailRe = new RegExp(CONFIG.grailRarityPattern, 'i');
  const grailIds = enIndex.cards
    .filter(([, , si, , , ri]) => CONFIG.grailSeries.includes(sets[si].serie) && grailRe.test(enIndex.rarities[ri]))
    .map(([id]) => id);

  const recentIds = recent.flatMap((s) => idsBySet.get(s.id) ?? []);
  const ids = [...new Set([...recentIds, ...grailIds])];
  log(`home: pricing ${ids.length} cards (${recentIds.length} recent, ${grailIds.length} grail pool)`);
  const details = (await pool(ids, 6, (id) => fetchJson(`${API}/en/cards/${encodeURIComponent(id)}`))).filter(Boolean);
  const byId = new Map(details.map((d) => [d.id, d]));

  const priced = (list) => list.map((id) => byId.get(id)).filter(Boolean).map(showcaseCard).filter((c) => c.usd > 0 && c.image);
  const top = (list, n) => list.sort((a, b) => b.usd - a.usd).slice(0, n);

  const recentSet = new Set(recentIds);
  // Brand-new sets can take a week or two to get prices; feature the newest set that has them.
  const newest = [...recent].reverse()
    .map((s) => ({ s, cards: top(priced(idsBySet.get(s.id) ?? []), 12) }))
    .find((x) => x.cards.length >= 5) ?? { s: recent[recent.length - 1], cards: [] };
  const heating = details
    .filter((d) => {
      const cm = d.pricing?.cardmarket;
      return d.image && usdOf(d.pricing) >= CONFIG.heatingMinUsd && cm?.avg7 > 1 && cm?.avg30 > 1;
    })
    .map((d) => ({ ...showcaseCard(d), change7: +((d.pricing.cardmarket.avg7 / d.pricing.cardmarket.avg30 - 1) * 100).toFixed(1) }))
    .filter((c) => c.change7 > 0)
    .sort((a, b) => b.change7 - a.change7)
    .filter(function perSetCap(c) { this[c.setId] = (this[c.setId] ?? 0) + 1; return this[c.setId] <= 2; }, {})
    .slice(0, 12);

  const home = {
    v: 1,
    built: new Date().toISOString(),
    pricesAsOf: details.map((d) => d.pricing?.tcgplayer?.updated).filter(Boolean).sort().pop() ?? null,
    config: CONFIG.remote,
    sections: [
      { id: 'chase', title: 'Chase Cards', subtitle: 'Top value · newest sets', cards: top(priced(recentIds), 15) },
      { id: 'heating', title: 'Heating Up', subtitle: 'Rising this week', cards: heating },
      { id: 'grails', title: 'Grails', subtitle: 'Vintage legends', cards: top(priced(grailIds.filter((id) => !recentSet.has(id))), 15) },
      { id: 'newset', title: newest.s.name, subtitle: `New set · ${newest.s.date}`, setId: newest.s.id, cards: newest.cards },
    ],
  };
  await bakeThumbs(home);
  validateHome(home);
  return home;
}

// The card image host can take 1–16 s per image, so every card on the home screen ships as a
// compact WebP next to home.json (dist/img/<id>.webp, ~25–35 KB each): the first screen is instant.
async function bakeThumbs(home) {
  const { default: sharp } = await import('sharp');
  const dir = path.join(DIST, 'img');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const cards = [...new Map(home.sections.flatMap((s) => s.cards).map((c) => [c.id, c])).values()];
  let bytes = 0;
  await pool(cards, 4, async (c) => {
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(`${c.image}/high.webp`, { headers: { 'User-Agent': 'tcg-marketplace-data/1.0' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const out = await sharp(Buffer.from(await r.arrayBuffer())).resize({ width: 420 }).webp({ quality: 74 }).toBuffer();
        const file = `${c.id.replace(/[^A-Za-z0-9._-]/g, '_')}.webp`;
        await fs.writeFile(path.join(dir, file), out);
        bytes += out.length;
        c.thumb = `img/${file}`;
        return;
      } catch { await new Promise((res) => setTimeout(res, 1500 * (i + 1))); }
    }
  });
  for (const s of home.sections) for (const c of s.cards) c.thumb = cards.find((x) => x.id === c.id)?.thumb ?? null;
  log(`home thumbs: ${cards.filter((c) => c.thumb).length}/${cards.length} baked, ${(bytes / 1024).toFixed(0)} KB`);
}

// ---------- main ----------
await fs.mkdir(DIST, { recursive: true });
const enMeta = await englishMeta();
const indexes = {};
for (const lang of LANGS) {
  if (SKIP_INDEX && lang !== 'en') continue;
  try {
    indexes[lang] = await buildIndex(lang, enMeta);
  } catch (e) {
    // One bad language must not block the others: keep its last published file and flag it.
    if (lang === 'en') throw e;
    console.log(`::warning::index-${lang} skipped: ${e.message}`);
    continue;
  }
  if (!SKIP_INDEX) {
    await writeJson(path.join(DIST, `index-${lang}.json`), indexes[lang]);
    log(`wrote index-${lang}.json: ${indexes[lang].cards.length} cards, ${indexes[lang].species.length} species`);
  }
}
if (!SKIP_HOME) {
  const en = indexes.en ?? (await buildIndex('en', enMeta));
  const home = await buildHome(en);
  await writeJson(path.join(DIST, 'home.json'), home);
  log(`wrote home.json: ${home.sections.map((s) => `${s.id}=${s.cards.length}`).join(' ')}`);
}
await writeJson(path.join(DIST, 'version.json'), {
  built: new Date().toISOString(),
  indexes: Object.fromEntries(Object.entries(indexes).map(([l, i]) => [l, i.built])),
});
log('done');
