// Measure live trade-to-client latency against a running engine.
//   bun engine/scripts/latency-check.ts [ws://localhost:8080/ws] [seconds]
// Subscribes to the market feed and new tokens, follows the busiest token's
// trades and 1s candles, and reports how long after its block each event
// reached this client. Block timestamps have 1-second resolution, so each
// figure carries up to ~1s of rounding.
import type { ServerMessage } from '../../api/_marketProtocol'

const url = process.argv[2] ?? 'ws://localhost:8080/ws'
const seconds = Number(process.argv[3] ?? 60)
const trades: number[] = [], launches: number[] = [], candleMatches: boolean[] = []
let followed: string | null = null
let lastTradePrice = new Map<string, number>()
let ticks = 0

const ws = new WebSocket(url)
const send = (o: unknown) => ws.send(JSON.stringify(o))
ws.onopen = () => { send({ action: 'subscribe', channel: 'market' }); send({ action: 'subscribe', channel: 'new_tokens' }) }
ws.onmessage = e => {
  const m = JSON.parse(String(e.data)) as ServerMessage
  const now = Date.now()
  if (m.t === 'TICKS') {
    ticks++
    if (!followed && m.d.length) {
      followed = [...m.d].sort((a, b) => b[5] - a[5])[0][0]
      send({ action: 'subscribe', channel: 'token', token: followed })
      send({ action: 'subscribe', channel: 'candles', token: followed, interval: '1s' })
      console.log('following', followed)
    }
  } else if (m.t === 'TRADE') {
    trades.push(now - m.d.ts)
    if (m.d.pu !== null) lastTradePrice.set(m.k, m.d.pu)
  } else if (m.t === 'CANDLE_UPDATE') {
    const p = lastTradePrice.get(m.k)
    if (p !== undefined) candleMatches.push(Math.abs(m.d[4] - p) < 1e-12 * Math.max(1, p))
  } else if (m.t === 'NEW_TOKEN') {
    launches.push(now - m.d.timestamp)
    console.log(`NEW_TOKEN ${m.d.symbol} (${m.d.launchpad} P${m.d.portal ?? '-'}) ${now - m.d.timestamp}ms after its block`)
  }
}
await new Promise(r => setTimeout(r, seconds * 1000))
ws.close()
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null }
console.log(JSON.stringify({
  seconds, ticks, followed,
  trades: { n: trades.length, p50: q(trades, 0.5), p90: q(trades, 0.9), max: q(trades, 1) },
  newTokens: { n: launches.length, p50: q(launches, 0.5), max: q(launches, 1) },
  candleCloseMatchesLastTrade: candleMatches.length ? `${candleMatches.filter(Boolean).length}/${candleMatches.length}` : 'n/a',
}, null, 1))
process.exit(0)
