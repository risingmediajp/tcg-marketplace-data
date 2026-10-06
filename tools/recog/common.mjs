// Shared by the recognition pipeline and its evaluation: card images, preprocessing, embeddings.
// The app runs the SAME model + preprocessing in the WebView, so changes here must be mirrored there.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ort from 'onnxruntime-node';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const IMG_CACHE = path.join(ROOT, 'data-pipeline', 'cache', 'img');
const ASSETS = 'https://assets.tcgdex.net';

export async function loadIndex(lang) {
  return JSON.parse(await fs.readFile(path.join(ROOT, 'data-pipeline', 'dist', `index-${lang}.json`), 'utf8'));
}

// Same rule as CardIndex.image(): 0 none, 1 default path, else explicit path.
export function imageUrl(ix, tuple, quality = 'low') {
  const [, , si, localId, , , , img] = tuple;
  if (!img) return null;
  const set = ix.sets[si];
  const base = img === 1 ? `${ix.lang}/${set.serie}/${set.id}/${localId}` : img;
  return `${ASSETS}/${base}/${quality}.webp`;
}

// Downloads (once) and returns the card image buffer, or null.
// persist=false: keep the image in memory only (official Japanese images are never stored).
export async function cardImage(lang, id, url, { persist = true } = {}) {
  const file = path.join(IMG_CACHE, lang, `${encodeURIComponent(id)}.webp`);
  if (persist) { try { return await fs.readFile(file); } catch { /* not cached */ } }
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'tcg-marketplace-data/1.0 (card fingerprinting; contact risingmediajp@gmail.com)' } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(String(r.status));
      const buf = Buffer.from(await r.arrayBuffer());
      if (persist) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, buf);
      }
      return buf;
    } catch { await new Promise((res) => setTimeout(res, 1500 * (i + 1))); }
  }
  return null;
}

export async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// ---- model ----
export const SIZE = 224;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

// Crop region of a card image to embed. 'full' = whole card; 'art' = the illustration box area.
export const REGIONS = {
  full: { top: 0, left: 0, width: 1, height: 1 },
  art: { top: 0.09, left: 0.07, width: 0.86, height: 0.47 },
};

// Image buffer -> NCHW float32 tensor (squashed to SIZE×SIZE, ImageNet normalisation).
export async function toTensor(buf, region = REGIONS.full) {
  const img = sharp(buf).removeAlpha();
  const { width, height } = await img.metadata();
  const r = {
    left: Math.round(region.left * width), top: Math.round(region.top * height),
    width: Math.max(1, Math.round(region.width * width)), height: Math.max(1, Math.round(region.height * height)),
  };
  const raw = await sharp(buf).removeAlpha().extract(r).resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer();
  const out = new Float32Array(3 * SIZE * SIZE);
  for (let p = 0; p < SIZE * SIZE; p++) {
    for (let c = 0; c < 3; c++) out[c * SIZE * SIZE + p] = (raw[p * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  return out;
}

export async function loadModel(file) {
  const session = await ort.InferenceSession.create(path.join(ROOT, 'tools', 'models', file));
  const input = session.inputNames[0], output = session.outputNames[0];
  // Embedding: DINOv2 → CLS token concatenated with mean of patch tokens; classifiers → logits.
  return async function embed(tensors) {
    const n = tensors.length;
    const batch = new Float32Array(n * 3 * SIZE * SIZE);
    tensors.forEach((t, i) => batch.set(t, i * t.length));
    const res = await session.run({ [input]: new ort.Tensor('float32', batch, [n, 3, SIZE, SIZE]) });
    const o = res[output];
    const data = o.data instanceof Float32Array ? o.data : Float32Array.from(o.data, Number);
    const vecs = [];
    if (o.dims.length === 3) {
      const [, tokens, dim] = o.dims;
      for (let i = 0; i < n; i++) {
        const v = new Float32Array(dim * 2);
        const base = i * tokens * dim;
        for (let d = 0; d < dim; d++) v[d] = data[base + d];
        for (let t = 1; t < tokens; t++) for (let d = 0; d < dim; d++) v[dim + d] += data[base + t * dim + d] / (tokens - 1);
        vecs.push(normalize(v));
      }
    } else {
      const dim = o.dims[1];
      for (let i = 0; i < n; i++) vecs.push(normalize(data.slice(i * dim, (i + 1) * dim)));
    }
    return vecs;
  };
}

export function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return v.map((x) => x / s);
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
