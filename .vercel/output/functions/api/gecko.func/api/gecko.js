export const config = { runtime: 'edge' };
export default async function handler(req) {
    const url = new URL(req.url);
    const path = url.searchParams.get('path') ?? '';
    const upstream = `https://api.geckoterminal.com/api/v2${path}`;
    const qs = new URLSearchParams();
    url.searchParams.forEach((v, k) => { if (k !== 'path')
        qs.set(k, v); });
    const full = qs.toString() ? `${upstream}?${qs}` : upstream;
    const res = await fetch(full, {
        headers: {
            Accept: 'application/json;version=20230302',
            'User-Agent': 'ARCDEX/1.0',
        },
    });
    const body = await res.text();
    return new Response(body, {
        status: res.status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 's-maxage=10, stale-while-revalidate=20',
        },
    });
}
//# sourceMappingURL=gecko.js.map