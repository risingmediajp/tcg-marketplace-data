// Logos for the sets TCGdex has none for (owner decision 2026-10-10: fill every gap).
//   - Other-language sets (fr/de/es/it/pt) are the same products as the English sets: use the English
//     logo of the same set id.
//   - Japanese sets: the logo image on the set's Bulbapedia page, found through the Bulbapedia API
//     (search for the set code, take the "(TCG)" page that mentions it, pick its "… Logo …" image).
// Logos are baked like TCGdex's (build.mjs bakeLogos) into cache/logos/<lang>_<set>.webp (committed) and
// published in dist/logos/; the index files get `lf` for the sets filled. Lookups are cached in
// cache/bulba-logos.json so a set is searched once.
// Usage: node tools/fill-logos.mjs   (after build.mjs)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data-pipeline');
const DIST = path.join(ROOT, 'dist');
const LOGOS = path.join(ROOT, 'cache', 'logos');
const LOOKUP = path.join(ROOT, 'cache', 'bulba-logos.json');
const BULBA = 'https://bulbapedia.bulbagarden.net/w/api.php';
const UA = { 'User-Agent': 'TCGMarketplaceData/1.0 (risingmediajp@gmail.com)' };
const LANGS = ['en', 'ja', 'fr', 'de', 'es', 'it', 'pt'];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const readJson = async (f, fb) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fb; } };
const exists = (f) => fs.access(f).then(() => true, () => false);
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

async function api(params) {
  await sleep(250);
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(`${BULBA}?${new URLSearchParams({ ...params, format: 'json' })}`, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { if (i === 3) { console.log(`::warning::bulbapedia: ${e.message}`); return null; } await sleep(1500 * i); }
  }
}

// Bulbapedia set page for a Japanese set code → logo image URL (or null). Guard against a wrong search
// hit: the page must be a "(TCG)" page whose text mentions the code as a whole word.
async function bulbaLogo(code, name) {
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9])${esc(code)}([^A-Za-z0-9]|$)`, 'i');
  // Candidates: the page named after the set, then pages the code or the set's name turns up.
  const titles = [`${name} (TCG)`];
  for (const q of [`"${code}" TCG`, `"${name}" TCG`]) {
    const s = await api({ action: 'query', list: 'search', srsearch: q, srlimit: 5, srwhat: 'text' });
    for (const t of (s?.query?.search ?? []).map((x) => x.title)) if (/\(TCG\)$/.test(t) && !titles.includes(t)) titles.push(t);
  }
  const nameRe = new RegExp(esc(name), 'i');
  for (const title of titles.slice(0, 5)) {
    const p = await api({ action: 'query', prop: 'revisions|images', titles: title, rvprop: 'content', rvslots: 'main', imlimit: 100 });
    const page = Object.values(p?.query?.pages ?? {})[0];
    const text = page?.revisions?.[0]?.slots?.main?.['*'] ?? '';
    if (!re.test(text) && !nameRe.test(text)) continue; // page must mention the set's code or name
    const imgs = (page.images ?? []).map((i) => i.title).filter((t) => /logo/i.test(t) && !/Project TCG/i.test(t));
    // Prefer a file naming this code, then a Japanese-marked one, then any logo on the page.
    const pick = imgs.find((t) => re.test(t)) ?? imgs.find((t) => /\bJP\b/i.test(t)) ?? imgs[0];
    if (!pick) continue;
    const info = await api({ action: 'query', titles: pick, prop: 'imageinfo', iiprop: 'url' });
    const url = Object.values(info?.query?.pages ?? {})[0]?.imageinfo?.[0]?.url;
    if (url) return { page: title, file: pick, url };
  }
  return null;
}

await fs.mkdir(LOGOS, { recursive: true });
await fs.mkdir(path.join(DIST, 'logos'), { recursive: true });
const lookup = await readJson(LOOKUP, {});
const indexes = {};
for (const l of LANGS) indexes[l] = await readJson(path.join(DIST, `index-${l}.json`), null);
const enLf = new Map((indexes.en?.sets ?? []).filter((s) => s.lf).map((s) => [s.id, s.lf]));

let shared = 0, bulba = 0, failed = 0;
for (const lang of LANGS) {
  const ix = indexes[lang];
  if (!ix) continue;
  let changed = false;
  for (const s of ix.sets) {
    if (s.lf) continue;
    // Same set in English → same logo.
    if (lang !== 'en' && lang !== 'ja' && enLf.has(s.id)) { s.lf = enLf.get(s.id); shared++; changed = true; continue; }
    // Bulbapedia (Japanese sets, and English sets TCGdex has no logo for).
    const file = `${lang}_${safe(s.id)}.webp`;
    const cached = path.join(LOGOS, file);
    if (await exists(cached)) { s.lf = `logos/${file}`; changed = true; continue; }
    if (!(lang === 'ja' || lang === 'en')) continue;
    if (lookup[`${lang}:${s.id}`] === null && !process.env.RETRY_LOGOS) continue; // searched before, nothing there
    if (lookup[`${lang}:${s.id}`] === null) delete lookup[`${lang}:${s.id}`];
    const hit = lookup[`${lang}:${s.id}`] ?? await bulbaLogo(s.id, s.name);
    lookup[`${lang}:${s.id}`] = hit;
    await fs.writeFile(LOOKUP, JSON.stringify(lookup, null, 1));
    if (!hit) { failed++; continue; }
    await sleep(400);
    let bytes = null;
    try { const r = await fetch(hit.url, { headers: UA }); if (r.ok) bytes = Buffer.from(await r.arrayBuffer()); } catch { /* skip */ }
    if (!bytes) { failed++; continue; }
    try {
      await fs.writeFile(cached, await sharp(bytes).resize({ width: 240, height: 110, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer());
      s.lf = `logos/${file}`; bulba++; changed = true;
    } catch (e) { console.log(`::warning::${hit.file}: ${e.message}`); failed++; }
  }
  if (changed) await fs.writeFile(path.join(DIST, `index-${lang}.json`), JSON.stringify(ix));
}
// Every cached logo is published (build.mjs only copies the TCGdex ones).
for (const f of await fs.readdir(LOGOS)) if (f.endsWith('.webp')) await fs.copyFile(path.join(LOGOS, f), path.join(DIST, 'logos', f));
const left = LANGS.flatMap((l) => (indexes[l]?.sets ?? []).filter((s) => !s.lf && s.official > 0).map((s) => `${l}:${s.id}`));
log(`logos: ${shared} shared from English, ${bulba} from Bulbapedia, ${failed} not found; ${left.length} sets still without: ${left.slice(0, 30).join(' ')}${left.length > 30 ? ' …' : ''}`);
