// Each coin page's own title and link preview (2026-10-05, owner: "we have no users; compare us with DexScreener").
// The app is one page: every coin link was served the same head, so a shared link showed the site's generic card and a
// search engine saw the same title on every coin. DexScreener's coin pages read "ARGUS $13.02M - Argus / USDC on Arc".
// Here, before a coin page leaves Netlify, its head gets the coin's title, description, logo and canonical link, from
// the engine's /api/coinmeta (a few hundred bytes, 1.5s at most; without an answer the page goes out unchanged).
// Cached at Netlify's edge for 2 minutes per URL.

const ENGINE = 'https://arcdex-engine-production.up.railway.app'
const SITE = 'https://arcsense.site'
/** $ARCDEX, which /spot opens. */
const COIN = '0x4b93446882d29e094181b2fae14b126577a2676c'

interface Coin {
  chain: 'arc' | 'robinhood' | 'solana' | 'bsc'
  address: string
  symbol: string
  name: string
  image: string | null
  launchpad: string | null
  quote: string | null
  priceUsd: number | null
  marketCapUsd: number | null
  change24h: number | null
}

const CHAIN_NAME = { arc: 'Arc', robinhood: 'Robinhood Chain', solana: 'Solana', bsc: 'BNB Chain' } as const

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function usd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  if (n >= 1) return `$${n.toFixed(n >= 100 ? 0 : 2)}`
  return `$${n.toPrecision(4)}`
}

export function coinHead(c: Coin, url: string): { title: string; description: string; image: string } {
  const pair = `${c.symbol}${c.quote ? ` / ${c.quote}` : ''}`
  const title = `${c.symbol} ${usd(c.marketCapUsd)} | ${c.name} · ${pair} on ${CHAIN_NAME[c.chain]} | ARCDEX`
  const chg = c.change24h == null ? '' : `, ${c.change24h >= 0 ? '+' : ''}${c.change24h.toFixed(1)}% in 24h`
  const description = `${c.name} (${c.symbol}) price ${usd(c.priceUsd)}, market cap ${usd(c.marketCapUsd)}${chg}. Live chart, trades, holders and a safety rating${c.launchpad ? `; launched on ${c.launchpad}` : ''}. Buy ${c.symbol} in one tap on ARCDEX.`
  const image = c.image
    ? `https://wsrv.nl/?url=${encodeURIComponent(c.image.replace(/^ipfs:\/\//, 'https://dweb.link/ipfs/'))}&w=400&h=400&fit=cover&output=png`
    : `${SITE}/arcdex-og.png`
  void url
  return { title, description, image }
}

export function rewriteHead(html: string, c: Coin, url: string): string {
  const h = coinHead(c, url)
  const tags = [
    `<title>${esc(h.title)}</title>`,
    `<meta name="description" content="${esc(h.description)}" />`,
    `<meta property="og:title" content="${esc(h.title)}" />`,
    `<meta property="og:description" content="${esc(h.description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:image" content="${esc(h.image)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta name="twitter:card" content="${c.image ? 'summary' : 'summary_large_image'}" />`,
    `<meta name="twitter:title" content="${esc(h.title)}" />`,
    `<meta name="twitter:description" content="${esc(h.description)}" />`,
    `<meta name="twitter:image" content="${esc(h.image)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
  ].join('\n    ')
  return html
    .replace(/<title>[\s\S]*?<\/title>\s*/, '')
    .replace(/<meta name="description"[^>]*>\s*/, '')
    .replace(/<meta property="og:(title|description|url|image|type)"[^>]*>\s*/g, '')
    .replace(/<meta name="twitter:(card|title|description|image)"[^>]*>\s*/g, '')
    .replace(/<link rel="canonical"[^>]*>\s*/, '')
    .replace('</head>', `    ${tags}\n  </head>`)
}

/** The coin a path names: /token/0x…, /solana/token/…, /bnb/token/…, /robinhood/token/…, or /spot ($ARCDEX). */
export function coinOf(pathname: string): { chain: Coin['chain']; address: string } | null {
  if (pathname === '/spot' || pathname === '/spot/') return { chain: 'arc', address: COIN }
  const m = /^\/(?:(solana|bnb|bsc|robinhood)\/)?token\/([^/?#]+)\/?$/.exec(pathname)
  if (!m) return null
  const chain = m[1] === 'solana' ? 'solana' : m[1] === 'bnb' || m[1] === 'bsc' ? 'bsc' : m[1] === 'robinhood' ? 'robinhood' : 'arc'
  const address = decodeURIComponent(m[2])
  if (chain === 'solana' ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : !/^0x[0-9a-fA-F]{40}$/.test(address)) return null
  return { chain, address }
}

interface Ctx { next: () => Promise<Response> }

export default async (req: Request, context: Ctx): Promise<Response> => {
  const res = await context.next()
  if (!(res.headers.get('content-type') ?? '').includes('text/html')) return res
  const u = new URL(req.url)
  const which = coinOf(u.pathname)
  if (!which) return res
  let coin: Coin | null = null
  try {
    const r = await fetch(`${ENGINE}/api/coinmeta?chain=${which.chain}&address=${encodeURIComponent(which.address)}`, { signal: AbortSignal.timeout(1_500) })
    coin = r.ok ? ((await r.json()) as { coin: Coin | null }).coin : null
  } catch { /* the engine's slow or down: the page goes out as it is */ }
  if (!coin) return res
  const url = `${SITE}${u.pathname}${u.search}`
  const html = rewriteHead(await res.text(), coin, url)
  const headers = new Headers(res.headers)
  headers.delete('content-length')
  headers.set('cache-control', 'public, max-age=0, must-revalidate')
  headers.set('netlify-cdn-cache-control', 'public, s-maxage=120, stale-while-revalidate=600')
  return new Response(html, { status: res.status, headers })
}

export const config = { path: ['/token/*', '/solana/token/*', '/bnb/token/*', '/bsc/token/*', '/robinhood/token/*', '/spot'], cache: 'manual' }
