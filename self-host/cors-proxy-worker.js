// Optional Cloudflare Worker CORS proxy for getvid.
// Lets the page read sites/CDNs that don't send CORS headers (generic page scan,
// Streamable/Telegram files…). Deploy it (free tier is fine), then in getvid's settings
// set "CORS proxy" to:  https://<worker-name>.<your-subdomain>.workers.dev/?url={url}
//
// Only the origins below may use it, so it doesn't turn into a public open proxy.
const ALLOWED_ORIGINS = [
  'https://YOUR-GITHUB-USER.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Disposition, Content-Range',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (!allowed) return new Response('Forbidden origin', { status: 403, headers: cors });
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: cors });

    let target;
    try { target = new URL(new URL(req.url).searchParams.get('url')); } catch { return new Response('Bad url', { status: 400, headers: cors }); }
    if (!/^https?:$/.test(target.protocol)) return new Response('Bad url', { status: 400, headers: cors });

    const headers = new Headers({ 'User-Agent': UA, Accept: '*/*' });
    const range = req.headers.get('Range');
    if (range) headers.set('Range', range);
    const upstream = await fetch(target, { method: req.method, headers, redirect: 'follow' });

    const out = new Headers(upstream.headers);
    out.delete('set-cookie');
    out.delete('content-security-policy');
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
