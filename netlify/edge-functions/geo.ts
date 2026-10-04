// The visitor's country, from Netlify's edge (the request's IP), for the stock-token gate
// (src/arcdex/lib/geo.ts): Robinhood's stock tokens aren't offered in some countries.
// Never cached: it's this visitor's answer.

interface GeoContext { geo?: { country?: { code?: string } } }

export default (_req: Request, context: GeoContext) =>
  new Response(JSON.stringify({ country: context.geo?.country?.code ?? null }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })

export const config = { path: '/geo' }
