// The visitor's country and, where the edge knows it, their state or province (from the request's IP), for the
// stock-token gate and the Hyperliquid gate (src/arcdex/lib/geo.ts): Robinhood's stock tokens aren't offered in some
// countries, and Hyperliquid's terms exclude the US, Ontario and sanctioned places. Never cached: it's this visitor's.

interface GeoContext { geo?: { country?: { code?: string }; subdivision?: { code?: string } } }

export default (_req: Request, context: GeoContext) =>
  new Response(JSON.stringify({ country: context.geo?.country?.code ?? null, subdivision: context.geo?.subdivision?.code ?? null }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })

export const config = { path: '/geo' }
