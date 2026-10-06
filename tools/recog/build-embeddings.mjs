// Builds the image-recognition gallery the app matches photos against:
//   dist/embed-meta.json, dist/embed-<lang>.json (ids), dist/embed-<lang>.bin (int8 count×dim)
// Incremental: raw float embeddings are cached per card in data-pipeline/cache/embed/<lang>.bin(+.json),
// so later runs only embed new cards. Settings: data-pipeline/config.json → "recognition".
// Usage: node tools/recog/build-embeddings.mjs [--langs en,ja]

import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadIndex, imageUrl, cardImage, pool, toTensor, loadModel, REGIONS } from './common.mjs';

const CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'data-pipeline/config.json'), 'utf8')).recognition;
const argLangs = process.argv.includes('--langs') ? process.argv[process.argv.indexOf('--langs') + 1].split(',') : null;
const LANGS = argLangs ?? CONFIG.langs;
const CACHE = path.join(ROOT, 'data-pipeline', 'cache', 'embed');
const DIST = path.join(ROOT, 'data-pipeline', 'dist');
const region = REGIONS[CONFIG.region];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function readCache(lang) {
  try {
    const ids = JSON.parse(await fs.readFile(path.join(CACHE, `${lang}.json`), 'utf8'));
    if (ids.model !== CONFIG.model || ids.region !== CONFIG.region) return new Map(); // settings changed: rebuild
    const buf = await fs.readFile(path.join(CACHE, `${lang}.bin`));
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return new Map(ids.ids.map((id, i) => [id, all.slice(i * ids.dim, (i + 1) * ids.dim)]));
  } catch { return new Map(); }
}
async function writeCache(lang, map) {
  const ids = [...map.keys()];
  const dim = ids.length ? map.get(ids[0]).length : 0;
  const all = new Float32Array(ids.length * dim);
  ids.forEach((id, i) => all.set(map.get(id), i * dim));
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(path.join(CACHE, `${lang}.bin`), Buffer.from(all.buffer));
  await fs.writeFile(path.join(CACHE, `${lang}.json`), JSON.stringify({ model: CONFIG.model, region: CONFIG.region, dim, ids }));
}

const embed = await loadModel(CONFIG.model);
const raw = {};
for (const lang of LANGS) {
  const ix = await loadIndex(lang);
  const cache = await readCache(lang);
  const cards = ix.cards.filter((c) => c[7]).map((c) => ({ id: c[0], url: imageUrl(ix, c) }));
  // Japanese cards TCGdex has no image for: official images (official-ja.mjs), fetched politely
  // and never written to disk — only the fingerprint is kept.
  if (lang === 'ja') {
    let official = {};
    try { official = JSON.parse(await fs.readFile(path.join(ROOT, 'data-pipeline', 'cache', 'official-ja.json'), 'utf8')); } catch { /* not built */ }
    for (const [id, url] of Object.entries(official)) cards.push({ id, url, official: true });
  }
  const todo = cards.filter((c) => !cache.has(c.id));
  log(`${lang}: ${cards.length} cards with images, ${todo.length} to embed`);
  let done = 0, missing = 0;
  for (let i = 0; i < todo.length; i += 32) {
    const chunk = todo.slice(i, i + 32);
    const bufs = new Array(chunk.length);
    await pool(chunk.filter((c) => !c.official), 8, async (c) => { bufs[chunk.indexOf(c)] = await cardImage(lang, c.id, c.url); });
    // Official site: two at a time with a pause, memory only.
    await pool(chunk.filter((c) => c.official), 2, async (c) => {
      bufs[chunk.indexOf(c)] = await cardImage(lang, c.id, c.url, { persist: false });
      await new Promise((r) => setTimeout(r, 400));
    });
    const ok = chunk.map((c, k) => ({ c, b: bufs[k] })).filter((x) => x.b);
    missing += chunk.length - ok.length;
    for (let j = 0; j < ok.length; j += 16) {
      const part = ok.slice(j, j + 16);
      const tensors = [];
      for (const { b } of part) { try { tensors.push(await toTensor(b, region)); } catch { tensors.push(null); } }
      const good = part.filter((_, k) => tensors[k]);
      const vecs = await embed(tensors.filter(Boolean));
      good.forEach(({ c }, k) => cache.set(c.id, vecs[k]));
    }
    done += chunk.length;
    if (done % 1024 < 32 || done === todo.length) { log(`${lang}: ${done}/${todo.length} (${missing} without image)`); await writeCache(lang, cache); }
  }
  await writeCache(lang, cache);
  // Keep only cards still in the index (in index order).
  raw[lang] = cards.filter((c) => cache.has(c.id)).map((c) => [c.id, cache.get(c.id)]);
}

// Optional PCA (fit on all galleries) to shrink the app download, then int8.
const rawDim = raw[LANGS[0]][0][1].length;
let dim = rawDim, project = (v) => v, meta = {};
if (CONFIG.pcaDims && CONFIG.pcaDims < rawDim) {
  const { fitPca } = await import('./pca.mjs');
  const sample = Object.values(raw).flat().map(([, v]) => v);
  const { components, mean } = fitPca(sample, CONFIG.pcaDims);
  dim = CONFIG.pcaDims;
  project = (v) => {
    const p = new Float32Array(dim);
    for (let k = 0; k < dim; k++) { let s = 0; for (let i = 0; i < rawDim; i++) s += components[k * rawDim + i] * (v[i] - mean[i]); p[k] = s; }
    let n = 0; for (const x of p) n += x * x; n = Math.sqrt(n) || 1;
    return p.map((x) => x / n);
  };
  meta = { pca: Buffer.from(components.buffer).toString('base64'), mean: Buffer.from(mean.buffer).toString('base64') };
}
for (const [lang, rows] of Object.entries(raw)) {
  const bin = new Int8Array(rows.length * dim);
  rows.forEach(([, v], i) => { const p = project(v); for (let k = 0; k < dim; k++) bin[i * dim + k] = Math.max(-127, Math.min(127, Math.round(p[k] * 127))); });
  await fs.writeFile(path.join(DIST, `embed-${lang}.bin`), Buffer.from(bin.buffer));
  await fs.writeFile(path.join(DIST, `embed-${lang}.json`), JSON.stringify(rows.map(([id]) => id)));
  log(`wrote embed-${lang}: ${rows.length} × ${dim} (${(bin.length / 1048576).toFixed(1)} MB)`);
}
await fs.writeFile(path.join(DIST, 'embed-meta.json'), JSON.stringify({
  model: CONFIG.model, region: REGIONS[CONFIG.region], dim, rawDim, langs: Object.keys(raw), built: new Date().toISOString(), ...meta,
}));
log('done');
