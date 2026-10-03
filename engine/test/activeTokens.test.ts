// What's trading now (2026-10-03, owner: "rank tokens to the top based on their activity"): each coin's trades and
// volume over the last minutes (TokenState.activity), the ranking (MarketEngine.active) and GET /v1/tokens/active.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ActiveToken, Trade } from '../../api/_marketProtocol'
import type { Config } from '../src/config'
import { setLogLevel } from '../src/log'
import { MarketEngine } from '../src/market/engine'
import { TokenState } from '../src/market/tokenState'
import { NullHistoryStore } from '../src/store/history'
import { MemoryHotStore } from '../src/store/hot'
import { DataApi, startServer } from '../src/ws/server'

setLogLevel('error')
const tok = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const NOW = Date.now()
let seq = 0
const trade = (token: string, minutesAgo: number, usd: number, side: 'BUY' | 'SELL' = 'BUY'): Trade => {
  seq++
  return {
    tradeId: `0xtx${seq}:1`, chain: 'ARC', token, pair: `${token}/usdc`, pool: `0xpool${token.slice(-4)}`, quote: '0x3600000000000000000000000000000000000000', side,
    baseAmount: 100, quoteAmount: usd, tokenAmount: 100, price: 0.05, priceUsd: 0.05, usdValue: usd, wallet: '0x' + 'b'.repeat(40),
    txHash: `0xtx${seq}`, blockNumber: 1_000 + seq, logIndex: 1, timestamp: NOW - minutesAgo * 60_000, dex: 'uniswap-v4', launchpad: 'ARGUS', liquidity: 20_000,
  }
}

describe('TokenState.activity', () => {
  test('counts the trades and volume of the last minutes only', () => {
    const st = new TokenState(tok(1))
    st.add(trade(tok(1), 2, 10), 1, NOW)
    st.add(trade(tok(1), 10, 20, 'SELL'), 2, NOW)
    st.add(trade(tok(1), 40, 30), 3, NOW)
    st.add(trade(tok(1), 300, 40), 4, NOW)
    expect(st.activity(15, NOW)).toEqual({ trades: 2, buys: 1, sells: 1, vol: 30 })
    expect(st.activity(60, NOW)).toEqual({ trades: 3, buys: 2, sells: 1, vol: 60 })
    expect(st.activity(1_440, NOW).trades).toBe(4)
  })
})

describe('what is trading now', () => {
  let srv: ReturnType<typeof startServer>
  let engine: MarketEngine
  let base = ''
  beforeAll(() => {
    const hot = new MemoryHotStore()
    const history = new NullHistoryStore()
    const api = new DataApi(null, hot, history)
    srv = startServer({ cfg: { role: 'all', port: 0, allowedOrigins: ['https://arcsense.site'], metricsToken: 'x', maxConnsPerIp: 3, maxMsgsPerSec: 5, maxSubsPerConn: 4, restRatePerSec: 50 } as unknown as Config, api, health: () => ({ status: 'ok' }) })
    engine = new MarketEngine(srv.publisher, hot, history, null)
    api.attachEngine(engine)
    base = `http://127.0.0.1:${srv.server.port}`
    // Busy now: 6 trades in the last 15 minutes.
    for (let i = 0; i < 6; i++) engine.onTrade(trade(tok(10), i, 5), { replay: true })
    // Big yesterday, quiet now: one trade 50 minutes ago, $5,000 of volume 20 hours ago.
    engine.onTrade(trade(tok(11), 50, 5), { replay: true })
    engine.onTrade(trade(tok(11), 1_200, 5_000), { replay: true })
    // Nothing in the last hour: left out.
    engine.onTrade(trade(tok(12), 90, 900), { replay: true })
    // A whale in the last hour: volume counts too ($2,000 → 20 points).
    engine.onTrade(trade(tok(13), 30, 2_000), { replay: true })
  })
  afterAll(() => srv.stop())

  test('ranks by recent trades and the hour\'s volume, not by the 24h volume', () => {
    const rows = engine.active(10)
    expect(rows.map(r => r.token)).toEqual([tok(13), tok(10), tok(11)])
    expect(rows[1]).toMatchObject({ trades15m: 6, trades1h: 6, buys1h: 6, vol1h: 30, score: 18.3 })
    expect(rows.find(r => r.token === tok(12))).toBeUndefined()
  })
  test('GET /v1/tokens/active', async () => {
    const r = await fetch(`${base}/v1/tokens/active?limit=2`)
    expect(r.status).toBe(200)
    const j = await r.json() as { tokens: ActiveToken[] }
    expect(j.tokens.map(t => t.token)).toEqual([tok(13), tok(10)])
    expect(j.tokens[0].stats.priceUsd).toBe(0.05)
  })
})
