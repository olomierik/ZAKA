// RedisHotStore against Bun's real Redis client, talking to a minimal
// in-test RESP server (the subset of commands the store uses). No Redis
// install needed; the protocol and pipelining are exercised for real.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { RedisClient } from 'bun'
import type { LaunchInfo, WireTrade } from '../../api/_marketProtocol'
import { setLogLevel } from '../src/log'
import { RedisHotStore, P } from '../src/store/hot'

setLogLevel('error')

type Sock = { write(d: string): void }
class MiniRedis {
  kv = new Map<string, string>()
  lists = new Map<string, string[]>()
  zsets = new Map<string, Map<string, number>>()
  ttl = new Map<string, number>()
  subs = new Map<string, Set<Sock>>()
  commands: string[][] = []
  private bufs = new Map<Sock, string>()

  handle(sock: Sock, chunk: string) {
    let buf = (this.bufs.get(sock) ?? '') + chunk
    for (;;) {
      const parsed = parse(buf)
      if (!parsed) break
      buf = buf.slice(parsed.used)
      sock.write(this.run(sock, parsed.args))
    }
    this.bufs.set(sock, buf)
  }

  run(sock: Sock, a: string[]): string {
    this.commands.push(a)
    const [cmd, ...r] = a
    const ok = '+OK\r\n', bulk = (s: string | null | undefined) => s == null ? '$-1\r\n' : `$${Buffer.byteLength(s)}\r\n${s}\r\n`
    const arr = (xs: (string | null)[]) => `*${xs.length}\r\n${xs.map(bulk).join('')}`
    const int = (n: number) => `:${n}\r\n`
    switch (cmd.toUpperCase()) {
      // Bun's client speaks RESP3: HELLO 3 → a map; pub/sub arrives as push frames.
      case 'HELLO': return `%3\r\n${bulk('server')}${bulk('redis')}${bulk('version')}${bulk('7.2.0')}${bulk('proto')}${int(3)}`
      case 'PING': return '+PONG\r\n'
      case 'SET': this.kv.set(r[0], r[1]); if (r[2]?.toUpperCase() === 'EX') this.ttl.set(r[0], Number(r[3])); return ok
      case 'GET': return bulk(this.kv.get(r[0]))
      case 'MGET': return arr(r.map(k => this.kv.get(k) ?? null))
      case 'EXPIRE': this.ttl.set(r[0], Number(r[1])); return int(1)
      case 'LPUSH': { const l = this.lists.get(r[0]) ?? []; l.unshift(...r.slice(1).reverse()); this.lists.set(r[0], l); return int(l.length) }
      case 'LTRIM': { const l = this.lists.get(r[0]) ?? []; this.lists.set(r[0], l.slice(Number(r[1]), Number(r[2]) + 1)); return ok }
      case 'LRANGE': { const l = this.lists.get(r[0]) ?? []; return arr(l.slice(Number(r[1]), Number(r[2]) + 1)) }
      case 'ZADD': { const z = this.zsets.get(r[0]) ?? new Map(); z.set(r[2], Number(r[1])); this.zsets.set(r[0], z); return int(1) }
      case 'ZREVRANGE': { const z = [...(this.zsets.get(r[0]) ?? new Map())].sort((x, y) => y[1] - x[1]).map(x => x[0]); return arr(z.slice(Number(r[1]), Number(r[2]) + 1)) }
      case 'ZREMRANGEBYSCORE': return int(0)
      case 'SCAN': { const pat = r[2].replace('*', ''); return `*2\r\n${bulk('0')}${arr([...this.kv.keys()].filter(k => k.startsWith(pat)))}` }
      case 'PUBLISH': { const s = this.subs.get(r[0]) ?? new Set(); for (const x of s) x.write(`>3\r\n${bulk('message')}${bulk(r[0])}${bulk(r[1])}`); return int(s.size) }
      case 'SUBSCRIBE': { const s = this.subs.get(r[0]) ?? new Set(); s.add(sock); this.subs.set(r[0], s); return `>3\r\n${bulk('subscribe')}${bulk(r[0])}${int(1)}` }
      default: return `-ERR unsupported ${cmd}\r\n`
    }
  }
}

function parse(buf: string): { args: string[]; used: number } | null {
  if (!buf.startsWith('*')) return null
  let i = buf.indexOf('\r\n'); if (i < 0) return null
  const n = Number(buf.slice(1, i)); let pos = i + 2
  const args: string[] = []
  for (let k = 0; k < n; k++) {
    const j = buf.indexOf('\r\n', pos); if (j < 0) return null
    const len = Number(buf.slice(pos + 1, j)); const start = j + 2
    if (Buffer.byteLength(buf.slice(start)) < len + 2) return null
    // byte-accurate slice for UTF-8 payloads
    const bytes = Buffer.from(buf.slice(start)); const s = bytes.subarray(0, len).toString()
    args.push(s); pos = start + s.length + 2
  }
  return { args, used: pos }
}

let redis: MiniRedis
let server: { port: number; stop(closeActive?: boolean): void }
let url = ''
beforeAll(() => {
  redis = new MiniRedis()
  server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data(sock, d) { redis.handle(sock as unknown as Sock, Buffer.from(d).toString()) } } }) as unknown as typeof server
  url = `redis://127.0.0.1:${server.port}`
})
afterAll(() => server.stop(true))

const wire = (i: number): WireTrade => ({ id: `0xtx${i}:0`, k: '0xtok', pl: 'p', q: 'q', s: 'B', ba: 1, qa: 1, p: 1, pu: 1, u: 1, w: null, tx: `0xtx${i}`, b: i, li: 0, ts: 1_000 + i, dx: 'uniswap-v4', lp: 'ARGUS', lq: null })

describe('RedisHotStore', () => {
  test('writes are pipelined and read back; lists capped; TTLs set', async () => {
    const store = new RedisHotStore(new RedisClient(url), () => new RedisClient(url))
    for (let i = 0; i < 205; i++) store.pushTrade('0xtok', wire(i))
    store.putState('0xtok', { state: { p: 1 }, stats: { priceUsd: 1 } })
    const l: LaunchInfo = { token: '0xtok', name: 'Tok 🚀', symbol: 'TOK', decimals: 18, creator: null, txHash: '0x', blockNumber: 1, timestamp: 1, pool: null, quote: null, launchpad: 'ARGUS', chain: 'ARC', status: 'LIVE' }
    store.putMeta('0xtok', l)
    store.pushLaunch(l)
    await store.flush()
    await store.setCursor(12_345)
    expect(await store.getCursor()).toBe(12_345)
    const trades = await store.getTrades('0xtok', 500)
    expect(trades.length).toBe(200)            // capped
    expect(trades[0].id).toBe('0xtx204:0')     // newest first
    expect((await store.getState('0xtok'))?.stats).toEqual({ priceUsd: 1 })
    expect((await store.getMeta('0xtok'))?.name).toBe('Tok 🚀')
    expect((await store.getLaunches(10))[0].symbol).toBe('TOK')
    expect(await store.getActive(5)).toEqual(['0xtok'])
    expect(redis.ttl.get(`${P}tok:0xtok`)).toBe(7 * 86_400)
    expect(redis.ttl.get(`${P}trades:0xtok`)).toBe(2 * 86_400)
    expect(await store.ping()).toBeGreaterThanOrEqual(0)
    store.close()
  })

  test('events fan out over pub/sub to another process', async () => {
    const a = new RedisHotStore(new RedisClient(url), () => new RedisClient(url))
    const b = new RedisHotStore(new RedisClient(url), () => new RedisClient(url))
    const got: string[] = []
    await b.onEvent(m => got.push(m))
    a.publish(JSON.stringify({ topics: ['market'], msg: { t: 'PONG', ts: 1 } }))
    const end = Date.now() + 2_000
    while (!got.length && Date.now() < end) await new Promise(r => setTimeout(r, 10))
    expect(JSON.parse(got[0]).topics).toEqual(['market'])
    a.close(); b.close()
  })
})
