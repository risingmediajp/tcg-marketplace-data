// Small PCA: covariance + power iteration with deflation. Good enough for d ≤ ~1000, k ≤ ~256.

export function fitPca(vectors, k, iters = 60) {
  const n = vectors.length, d = vectors[0].length;
  const mean = new Float32Array(d);
  for (const v of vectors) for (let i = 0; i < d; i++) mean[i] += v[i] / n;
  const cov = new Float64Array(d * d);
  const x = new Float64Array(d);
  for (const v of vectors) {
    for (let i = 0; i < d; i++) x[i] = v[i] - mean[i];
    for (let i = 0; i < d; i++) { const xi = x[i]; if (!xi) continue; const row = i * d; for (let j = i; j < d; j++) cov[row + j] += xi * x[j]; }
  }
  for (let i = 0; i < d; i++) for (let j = i; j < d; j++) { cov[i * d + j] /= n; cov[j * d + i] = cov[i * d + j]; }

  const components = new Float32Array(k * d);
  const b = new Float64Array(d), nb = new Float64Array(d);
  for (let c = 0; c < k; c++) {
    for (let i = 0; i < d; i++) b[i] = Math.sin(i * 12.9898 + c * 78.233);
    for (let t = 0; t < iters; t++) {
      for (let i = 0; i < d; i++) { let s = 0; const row = i * d; for (let j = 0; j < d; j++) s += cov[row + j] * b[j]; nb[i] = s; }
      let norm = 0; for (let i = 0; i < d; i++) norm += nb[i] * nb[i]; norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < d; i++) b[i] = nb[i] / norm;
    }
    // eigenvalue and deflation
    let lambda = 0;
    for (let i = 0; i < d; i++) { let s = 0; const row = i * d; for (let j = 0; j < d; j++) s += cov[row + j] * b[j]; lambda += b[i] * s; }
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) cov[i * d + j] -= lambda * b[i] * b[j];
    for (let i = 0; i < d; i++) components[c * d + i] = b[i];
  }
  return { components, mean };
}
