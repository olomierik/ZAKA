// End to end inside one process: a trade and a launch go through the
// MarketEngine and come out of the real WebSocket/REST server.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { LaunchInfo, ServerMessage, Trade } from '../../api/_marketProtocol'
import type { Config } from '../src/config'
import { setLogLevel } from '../src/log'
import { MarketEngine } from '../src/market/engine'
import { NullHistoryStore } from '../src/store/history'
import { MemoryHotStore } from '../src/store/hot'
import { DataApi, startServer } from '../src/ws/server'

setLogLevel('error')
const T = '0x' + 'a'.repeat(40)
const cfg = {
  role: 'all', port: 0, allowedOrigins: ['https://arcdex.online'], metricsToken: 'secret',
  maxConnsPerIp: 3, maxMsgsPerSec: 5, maxSubsPerConn: 4, restRatePerSec: 50,
} as unknown as Config

let srv: ReturnType<typeof startServer>
let engine: MarketEngine
let hot: MemoryHotStore
let base = ''

beforeAll(() => {
  hot = new MemoryHotStore()
  const history = new NullHistoryStore()
  const api = new DataApi(null, hot, history)
  srv = startServer({ cfg, api, health: () => ({ status: 'ok' }) })
  engine = new MarketEngine(srv.publisher, hot, history, null)
  api.attachEngine(engine)
  base = `127.0.0.1:${srv.server.port}`
})
afterAll(() => srv.stop())

const trade = (over: Partial<Trade> = {}): Trade => ({
  tradeId: '0xtx:1', chain: 'ARC', token: T, pair: `${T}/usdc`, pool: '0xpool', quote: '0x3600000000000000000000000000000000000000', side: 'BUY',
  baseAmount: 100, quoteAmount: 5, tokenAmount: 100, price: 0.05, priceUsd: 0.05, usdValue: 5, wallet: '0x' + 'b'.repeat(40),
  txHash: '0xtx', blockNumber: 500, logIndex: 1, timestamp: Date.now(), dex: 'uniswap-v4', launchpad: 'ARGUS', liquidity: 20_000, ...over,
})

/** A client that collects messages. */
async function client(origin = 'https://arcdex.online') {
  const ws = new WebSocket(`ws://${base}/ws`, { headers: { Origin: origin } } as never)
  const msgs: ServerMessage[] = []
  ws.onmessage = e => msgs.push(JSON.parse(String(e.data)))
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')) })
  const until = async (pred: (m: ServerMessage) => boolean, ms = 2_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { const m = msgs.find(pred); if (m) return m; await new Promise(r => setTimeout(r, 10)) }
    throw new Error('timed out waiting for message; got ' + JSON.stringify(msgs.map(m => m.t)))
  }
  return { ws, msgs, until, send: (o: unknown) => ws.send(JSON.stringify(o)) }
}

describe('WebSocket API', () => {
  test('subscribe → snapshot, then TRADE / PRICE / VOLUME / LIQUIDITY / CANDLE on a trade', async () => {
    const c = await client()
    c.send({ action: 'subscribe', channel: 'token', token: T })
    c.send({ action: 'subscribe', channel: 'candles', token: T, interval: '1s' })
    await c.until(m => m.t === 'SNAPSHOT')
    await c.until(m => m.t === 'SUBSCRIBED' && m.c === `candles:${T}:1s`)
    const t0 = performance.now()
    engine.onTrade(trade(), { replay: false, receivedAt: Date.now() })
    const tr = await c.until(m => m.t === 'TRADE') as Extract<ServerMessage, { t: 'TRADE' }>
    const ms = performance.now() - t0
    expect(tr.d.id).toBe('0xtx:1')
    expect(tr.d.s).toBe('B')
    const p = await c.until(m => m.t === 'PRICE_UPDATE') as Extract<ServerMessage, { t: 'PRICE_UPDATE' }>
    expect(p.d.pu).toBe(0.05)
    const v = await c.until(m => m.t === 'VOLUME_UPDATE') as Extract<ServerMessage, { t: 'VOLUME_UPDATE' }>
    expect([v.d.v, v.d.bc, v.d.sc]).toEqual([5, 1, 0])
    await c.until(m => m.t === 'LIQUIDITY_UPDATE')
    const cu = await c.until(m => m.t === 'CANDLE_UPDATE') as Extract<ServerMessage, { t: 'CANDLE_UPDATE' }>
    expect(cu.i).toBe('1s')
    expect(cu.d[4]).toBe(0.05)
    expect(ms).toBeLessThan(200) // engine → socket, in-process
    c.ws.close()
  })

  test('replayed (backfilled) trades update state but are not broadcast', async () => {
    const c = await client()
    c.send({ action: 'subscribe', channel: 'trades', token: T })
    await c.until(m => m.t === 'SUBSCRIBED')
    engine.onTrade(trade({ tradeId: '0xold:1', txHash: '0xold', blockNumber: 400, timestamp: Date.now() - 3_600_000 }), { replay: true })
    await new Promise(r => setTimeout(r, 100))
    expect(c.msgs.some(m => m.t === 'TRADE')).toBe(false)
    expect(engine.statsOf(T)!.trades24).toBe(2)
    c.ws.close()
  })

  test('NEW_TOKEN reaches new_tokens subscribers once, even if the launch is seen twice', async () => {
    const c = await client()
    c.send({ action: 'subscribe', channel: 'new_tokens' })
    await c.until(m => m.t === 'SUBSCRIBED')
    const l: LaunchInfo = { token: '0x' + 'c'.repeat(40), name: 'Test', symbol: 'TST', decimals: 18, creator: null, txHash: '0x1', blockNumber: 1, timestamp: Date.now(), pool: null, quote: null, launchpad: 'ARGUS', chain: 'ARC', status: 'LIVE' }
    engine.onLaunch(l, { replay: false, initialPriceUsd: 0.001 })
    engine.onLaunch(l, { replay: false })
    const n = await c.until(m => m.t === 'NEW_TOKEN') as Extract<ServerMessage, { t: 'NEW_TOKEN' }>
    expect(n.d.symbol).toBe('TST')
    await new Promise(r => setTimeout(r, 50))
    expect(c.msgs.filter(m => m.t === 'NEW_TOKEN').length).toBe(1)
    expect(engine.statsOf(l.token)!.priceUsd).toBe(0.001) // visible with a price before its first trade
    c.ws.close()
  })

  test('validation, subscription cap and message rate limit', async () => {
    const c = await client()
    c.send({ action: 'subscribe', channel: 'token', token: 'nope' })
    expect((await c.until(m => m.t === 'ERROR') as Extract<ServerMessage, { t: 'ERROR' }>).d.code).toBe('bad_token')
    await new Promise(r => setTimeout(r, 1_100)) // refill
    for (let i = 0; i < 5; i++) c.send({ action: 'subscribe', channel: 'price', token: '0x' + String(i).repeat(40) })
    await c.until(m => m.t === 'ERROR' && m.d.code === 'too_many_subscriptions')
    for (let i = 0; i < 20; i++) c.send({ action: 'ping' })
    await c.until(m => m.t === 'ERROR' && m.d.code === 'rate_limited')
    c.ws.close()
  })

  test('foreign origins and too many connections per IP are refused', async () => {
    await expect(client('https://evil.example')).rejects.toThrow()
    const open = [await client(), await client(), await client()]
    await expect(client()).rejects.toThrow()
    open.forEach(o => o.ws.close())
  })
})

describe('REST API', () => {
  test('token, trades, candles, new tokens, market', async () => {
    const get = async (p: string) => { const r = await fetch(`http://${base}${p}`, { headers: { Origin: 'https://arcdex.online' } }); return { status: r.status, cors: r.headers.get('access-control-allow-origin'), body: await r.json() as Record<string, unknown> } }
    const tok = await get(`/v1/tokens/${T}`)
    expect(tok.status).toBe(200)
    expect(tok.cors).toBe('https://arcdex.online')
    expect((tok.body.stats as { priceUsd: number }).priceUsd).toBe(0.05)
    const trades = await get(`/v1/tokens/${T}/trades?limit=10`)
    expect((trades.body.trades as { id: string }[]).map(t => t.id)).toEqual(['0xtx:1', '0xold:1'])
    const candles = await get(`/v1/tokens/${T}/candles?interval=1m`)
    expect((candles.body.candles as unknown[]).length).toBeGreaterThanOrEqual(1)
    expect((await get(`/v1/tokens/${T}/candles?interval=7m`)).status).toBe(400)
    expect(((await get('/v1/tokens/new')).body.launches as { symbol: string }[])[0].symbol).toBe('TST')
    expect(((await get('/v1/market')).body.tokens as unknown[]).length).toBeGreaterThanOrEqual(1)
    expect((await get('/v1/tokens/0xnothex/trades')).status).toBe(404)
  })

  test('/metrics needs the token; /health is public', async () => {
    expect((await fetch(`http://${base}/metrics`)).status).toBe(401)
    expect((await fetch(`http://${base}/metrics`, { headers: { Authorization: 'Bearer secret' } })).status).toBe(200)
    expect((await fetch(`http://${base}/health`)).status).toBe(200)
  })
})
