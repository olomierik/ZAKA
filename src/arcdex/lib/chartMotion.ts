// How the charts move on their own: where a trade's pop flies (PriceChart)
// and which timeframe fits a coin's whole life (the GeckoTerminal embed).

/** A pop's flight: upward, anywhere from 45° left to 45° right of straight
 * up, 80–150px (times `scale`) — fixed per trade (from its key), so pops
 * landing together scatter different ways and a re-render never changes
 * their course. */
export function flightOf(key: string, scale = 1): { fx: number; fy: number } {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  h >>>= 0
  const angle = ((h % 1000) / 999 - 0.5) * (Math.PI / 2)
  const dist = (80 + ((h >>> 10) % 71)) * scale
  return { fx: Math.round(Math.sin(angle) * dist), fy: -Math.round(Math.cos(angle) * dist) }
}

/** The timeframe that fits a coin's whole life in the chart window: about
 * 60–120 candles (a 1-hour-old coin on 15m candles was four fat bars; a
 * month-old one, a sliver of its history). */
export function fitResolution(createdAt: string | null | undefined, now = Date.now()): string {
  const born = createdAt ? Date.parse(createdAt) : NaN
  if (!Number.isFinite(born)) return '15m'
  const hours = Math.max(0, now - born) / 3_600_000
  return hours < 2 ? '1m' : hours < 10 ? '5m' : hours < 30 ? '15m' : hours < 5 * 24 ? '1h' : hours < 20 * 24 ? '4h' : hours < 60 * 24 ? '12h' : '1d'
}
