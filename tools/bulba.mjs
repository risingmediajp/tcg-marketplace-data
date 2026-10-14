// Bulbapedia access for the data tools. Bulbapedia answers GitHub's runners with HTTP 403, so when
// BULBA_PROXY (+ BULBA_KEY) is set — the nightly job's secrets — requests go through our own proxy
// (tools/bulba-proxy.mjs on the VPS), which simply forwards them. Locally they go direct.
// Both the API (bulbapedia.bulbagarden.net/w/api.php) and the image host (archives.bulbagarden.net)
// are covered. Keep the polite delays in the callers; the proxy adds none.

const UA = { 'User-Agent': 'TCGMarketplaceData/1.0 (risingmediajp@gmail.com)' };
const PROXY = process.env.BULBA_PROXY?.replace(/\/$/, '');
const KEY = process.env.BULBA_KEY;

export function bulbaUrl(url) {
  if (!PROXY) return url;
  const u = new URL(url);
  if (u.host === 'bulbapedia.bulbagarden.net') return `${PROXY}/api${u.search}`;
  if (u.host === 'archives.bulbagarden.net') return `${PROXY}/archives${u.pathname}`;
  return url;
}

export async function bulbaFetch(url, init = {}) {
  const headers = { ...UA, ...(init.headers ?? {}) };
  if (PROXY && KEY && /bulbagarden\.net/.test(url)) headers['X-Proxy-Key'] = KEY;
  return fetch(bulbaUrl(url), { ...init, headers });
}

export const viaProxy = !!PROXY;
