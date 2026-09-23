export const config = { runtime: 'edge' }

export default async function handler(req: Request) {
  const url = new URL(req.url)
  const path = url.searchParams.get('path') ?? ''
  const upstream = `https://api.dexscreener.com${path}`
  const qs = new URLSearchParams()
  url.searchParams.forEach((v, k) => { if (k !== 'path') qs.set(k, v) })
  const full = qs.toString() ? `${upstream}?${qs}` : upstream

  const res = await fetch(full, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ARCDEX/1.0)',
      Accept: 'application/json',
    },
  })
  const body = await res.text()
  return new Response(body, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 's-maxage=5, stale-while-revalidate=10',
    },
  })
}
