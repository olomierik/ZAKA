// /sitemap.xml (2026-10-05): every listed coin's page, so search engines find them the way they find DexScreener's.
// From the engine's /api/coinmeta?sitemap=1; cached at Netlify's edge for an hour.

const ENGINE = 'https://arcdex-engine-production.up.railway.app'
const SITE = 'https://arcsense.site'
const PAGES = ['/', '/app', '/solana', '/bnb', '/robinhood', '/swap', '/bridge', '/futures', '/spot']

interface Page { chain: 'arc' | 'robinhood' | 'solana' | 'bsc'; address: string; pool: string | null }

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const pagePath = (p: Page) => {
  const pool = p.pool ? `?pool=${encodeURIComponent(p.pool)}` : ''
  return p.chain === 'arc' ? `/token/${p.address}${pool}` : p.chain === 'solana' ? `/solana/token/${p.address}${pool}`
    : p.chain === 'bsc' ? `/bnb/token/${p.address}${pool}` : `/robinhood/token/${p.address}${pool}`
}

export default async (): Promise<Response> => {
  let coins: Page[] = []
  try {
    const r = await fetch(`${ENGINE}/api/coinmeta?sitemap=1`, { signal: AbortSignal.timeout(8_000) })
    if (r.ok) coins = ((await r.json()) as { pages?: Page[] }).pages ?? []
  } catch { /* the static pages alone */ }
  const urls = [...PAGES, ...coins.slice(0, 5_000).map(pagePath)]
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${xmlEsc(SITE + u)}</loc></url>`).join('\n')}\n</urlset>\n`
  return new Response(body, {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate', 'netlify-cdn-cache-control': 'public, s-maxage=3600, stale-while-revalidate=86400' },
  })
}

export const config = { path: '/sitemap.xml', cache: 'manual' }
