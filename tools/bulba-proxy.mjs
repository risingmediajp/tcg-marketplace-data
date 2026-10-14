// Tiny forwarding proxy for Bulbapedia, run on the VPS (systemd unit "bulba-proxy"). GitHub's runners
// get HTTP 403 from Bulbapedia; this box doesn't. It forwards exactly two things and nothing else:
//   GET /api?<query>        → https://bulbapedia.bulbagarden.net/w/api.php?<query>
//   GET /archives/<path>    → https://archives.bulbagarden.net/<path>
// Every request must carry X-Proxy-Key matching BULBA_KEY. Plain HTTP on PORT (default 8787): the
// data is a public wiki and the key only stops strangers using the box as a relay.
import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const KEY = process.env.BULBA_KEY;
if (!KEY) { console.error('BULBA_KEY is required'); process.exit(1); }
const UA = 'TCGMarketplaceData/1.0 (risingmediajp@gmail.com; proxy)';

http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' || req.headers['x-proxy-key'] !== KEY) { res.writeHead(403); return res.end(); }
    const u = new URL(req.url, 'http://x');
    let target;
    if (u.pathname === '/api') target = `https://bulbapedia.bulbagarden.net/w/api.php${u.search}`;
    else if (u.pathname.startsWith('/archives/')) target = `https://archives.bulbagarden.net${u.pathname.slice('/archives'.length)}`;
    else { res.writeHead(404); return res.end(); }
    const r = await fetch(target, { headers: { 'User-Agent': UA } });
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/octet-stream' });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.writeHead(502); res.end(String(e.message)); }
}).listen(PORT, () => console.log(`bulba-proxy on :${PORT}`));
