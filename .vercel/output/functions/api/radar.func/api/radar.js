// Vercel serverless proxy for RadarDex API — fixes CORS
// All requests to /api/radar?path=<path> are forwarded to api.radardex.pro
export const config = { runtime: 'edge' };
const RADAR_BASE = 'https://api.radardex.pro';
export default async function handler(req) {
    const url = new URL(req.url);
    const path = url.searchParams.get('path') ?? '/tokens';
    // Forward all other query params except 'path'
    const upstream = new URL(`${RADAR_BASE}${path}`);
    url.searchParams.forEach((val, key) => {
        if (key !== 'path')
            upstream.searchParams.set(key, val);
    });
    try {
        const res = await fetch(upstream.toString(), {
            headers: { 'Accept': 'application/json', 'User-Agent': 'ARCDEX/1.0' },
            signal: AbortSignal.timeout(12000),
        });
        const body = await res.text();
        return new Response(body, {
            status: res.status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=15, s-maxage=30',
            },
        });
    }
    catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
    }
}
//# sourceMappingURL=radar.js.map