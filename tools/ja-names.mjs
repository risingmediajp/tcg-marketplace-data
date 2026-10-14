// Official Japanese card names. TCGdex's names for older Japanese sets are machine translations of the
// English names ("ビルからのメール" for Bill's Maintenance, Unown letters as "d"), and the sets filled from
// TCGplayer (jp-prices.mjs) carry English names. Bulbapedia's card pages record the real Japanese name
// (the infobox "jname" field), so for every card whose English print we know — by matched English twin
// (fill-ja-art.mjs) or by its own page in a Japanese-only set ("Pikachu (Collection X 24)") — the
// name is read from there. Lookups are cached in cache/ja-art/jnames.json (committed); a card is
// looked up once. Rewrites dist/index-ja.json names in place.
// Usage: node tools/ja-names.mjs   (after jp-prices.mjs and fill-ja-art.mjs)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data-pipeline');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, 'cache', 'ja-art');
const BULBA = 'https://bulbapedia.bulbagarden.net/w/api.php';
const UA = { 'User-Agent': 'TCGMarketplaceData/1.0 (risingmediajp@gmail.com)' };
const MAX_NEW = 2500; // lookups per run (nightly runs finish the rest)
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const readJson = async (f, fb) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fb; } };

async function wikitext(titles) {
  await sleep(250);
  for (let i = 1; i <= 3; i++) {
    try {
      // Japanese-only prints are redirects to the Western print's page ("Pikachu (Premium Champion Pack 36)"
      // → "Pikachu (XY 42)"), which carries the jname: follow redirects and map texts back to what was asked.
      const r = await fetch(`${BULBA}?${new URLSearchParams({ action: 'query', prop: 'revisions', titles: titles.join('|'), rvprop: 'content', rvslots: 'main', redirects: 1, format: 'json' })}`, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const q = (await r.json())?.query ?? {};
      const byTitle = Object.fromEntries(Object.values(q.pages ?? {}).map((p) => [p.title, p.revisions?.[0]?.slots?.main?.['*'] ?? null]));
      const out = { ...byTitle };
      for (const { from, to } of [...(q.normalized ?? []), ...(q.redirects ?? [])]) if (byTitle[to] !== undefined || out[to] !== undefined) out[from] = out[to] ?? byTitle[to];
      return out;
    } catch (e) { if (i === 3) { console.log(`::warning::bulbapedia: ${e.message}`); return {}; } await sleep(1500 * i); }
  }
}
const jnameOf = (text) => text?.match(/\|\s*jname\s*=\s*([^\n|]+)/)?.[1]?.trim() ?? null;

const ja = await readJson(path.join(DIST, 'index-ja.json'));
const en = await readJson(path.join(DIST, 'index-en.json'));
const matches = await readJson(path.join(CACHE, 'matches.json'), {});
const jnames = await readJson(path.join(CACHE, 'jnames.json'), {}); // jaId -> name | null
const enById = new Map(en.cards.map((c) => [c[0], c]));

// Bulbapedia's own name for a Japanese set (its "(TCG)" page), resolved once per set and cached. A set
// whose page redirects to a Western set (Time Gazer → Astral Radiance) has no per-card pages under
// its own numbering, so it gets null.
const setPages = await readJson(path.join(CACHE, 'bulba-sets.json'), {});
async function bulbaSetName(s) {
  if (!s.en) return null;
  if (setPages[s.id] !== undefined) return setPages[s.id];
  await sleep(250);
  let name = null;
  try {
    const r = await fetch(`${BULBA}?${new URLSearchParams({ action: 'query', titles: `${s.en} (TCG)`, redirects: 1, format: 'json' })}`, { headers: UA });
    const j = await r.json();
    const target = j?.query?.redirects?.[0]?.to ?? Object.values(j?.query?.pages ?? {})[0]?.title;
    const missing = Object.values(j?.query?.pages ?? {})[0]?.missing !== undefined;
    if (target && !missing) {
      const base = target.replace(/ \(TCG\)$/, '');
      // Accept the page only if it is this set (same words, accents aside), not a Western set it redirects to.
      const norm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (norm(base) === norm(s.en)) name = base;
    }
  } catch { /* leave null */ }
  setPages[s.id] = name;
  await fs.writeFile(path.join(CACHE, 'bulba-sets.json'), JSON.stringify(setPages, null, 1));
  return name;
}
for (const s of ja.sets) if (s.en) await bulbaSetName(s);

// Bulbapedia page title for a card: "<English name> (<English set name> <number>)".
function titleFor(card) {
  const [id, name, si, localId] = card;
  const m = matches[id];
  if (typeof m === 'string' && enById.get(m)) {
    const e = enById.get(m);
    return `${e[1]} (${en.sets[e[2]].name} ${Number(e[3]) || e[3]})`;
  }
  const s = ja.sets[si];
  const page = setPages[s.id];
  if (page && /^[A-Za-z]/.test(name)) { // filled from TCGplayer: capitalised English name under the set's own page
    const cap = name.replace(/(^|\s)([a-z])/g, (q, a, b) => a + b.toUpperCase());
    return `${cap} (${page} ${Number(localId) || localId})`;
  }
  return null;
}

const todo = ja.cards.filter((c) => jnames[c[0]] === undefined && titleFor(c)).slice(0, MAX_NEW);
log(`ja-names: ${todo.length} cards to look up`);
let found = 0;
for (let i = 0; i < todo.length; i += 20) {
  const batch = todo.slice(i, i + 20);
  const texts = await wikitext(batch.map(titleFor));
  for (const c of batch) {
    // The API normalises titles (apostrophes, spacing): match loosely on the English name.
    const t = titleFor(c);
    const key = Object.keys(texts).find((k) => k === t) ?? Object.keys(texts).find((k) => k.toLowerCase() === t.toLowerCase());
    const jn = jnameOf(key ? texts[key] : null);
    jnames[c[0]] = jn;
    if (jn) found++;
  }
  if (i % 500 === 0 && i) await fs.writeFile(path.join(CACHE, 'jnames.json'), JSON.stringify(jnames));
}
await fs.writeFile(path.join(CACHE, 'jnames.json'), JSON.stringify(jnames));
log(`ja-names: ${found}/${todo.length} found this run`);

let renamed = 0;
for (const c of ja.cards) {
  const jn = jnames[c[0]];
  if (jn && jn !== c[1]) { c[1] = jn; renamed++; }
}
await fs.writeFile(path.join(DIST, 'index-ja.json'), JSON.stringify(ja));
log(`ja-names: ${renamed} card names corrected in index-ja.json`);
