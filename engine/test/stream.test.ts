// ChainStream + WsProvider reliability, against in-memory fakes of a chain
// (test doubles only — no fake data ever reaches a production path).
import { describe, expect, test } from 'bun:test'
import type { RawLog } from '../../api/_arcLogs'
import type { Rpc } from '../src/chain/http'
import { ChainStream, logId, type DispatchCtx } from '../src/chain/stream'
import { WsProvider, type WsFactory } from '../src/chain/wsProvider'
import { setLogLevel } from '../src/log'

setLogLevel('error')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const hex = (n: number) => '0x' + n.toString(16)

/** A tiny chain: blocks with logs, served over a fake JSON-RPC WebSocket and getLogs. */
class FakeChain {
  head = 1_000
  logs: RawLog[] = []
  sockets: FakeSocket[] = []
  deliverLive = true
  addLog(block: number, i: number): RawLog {
    const l: RawLog = { address: '0xpool', topics: ['0xswap'], data: '0x', blockNumber: hex(block), blockTimestamp: hex(Math.floor(Date.now() / 1000)), transactionHash: '0x' + block.toString(16).padStart(64, '0'), logIndex: hex(i) }
    this.logs.push(l)
    return l
  }
  /** Mine a block: heads + (optionally) live logs to every open socket. */
  mine(logsInBlock = 1) {
    this.head++
    const made = Array.from({ length: logsInBlock }, (_, i) => this.addLog(this.head, i))
    for (const s of this.sockets) s.push(this.head, this.deliverLive ? made : [])
    return made
  }
  fetchLogs = async (_f: unknown, from: number, to: number) => ({
    logs: this.logs.filter(l => parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to),
    scannedTo: to,
  })
  rpc: Rpc = {
    call: async <T>(m: string) => (m === 'eth_blockNumber' ? hex(this.head) : null) as T,
    batch: async () => [],
  }
  factory: WsFactory = url => { const s = new FakeSocket(url); this.sockets.push(s); return s }
}

class FakeSocket {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  subs = new Map<string, 'logs' | 'newHeads'>()
  private n = 0
  constructor(readonly url: string) { setTimeout(() => { this.readyState = 1; this.onopen?.({}) }, 1) }
  send(raw: string) {
    const m = JSON.parse(raw) as { id: number; method: string; params: unknown[] }
    if (m.method === 'eth_subscribe') {
      const id = `sub${++this.n}`
      this.subs.set(id, m.params[0] as 'logs' | 'newHeads')
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: m.id, result: id }) }), 1)
    } else setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: m.id, result: true }) }), 1)
  }
  push(block: number, logs: RawLog[]) {
    if (this.readyState !== 1) return
    for (const [id, kind] of this.subs) {
      if (kind === 'newHeads') this.onmessage?.({ data: JSON.stringify({ method: 'eth_subscription', params: { subscription: id, result: { number: hex(block), timestamp: hex(Math.floor(Date.now() / 1000)), hash: '0x' } } }) })
      else for (const l of logs) this.onmessage?.({ data: JSON.stringify({ method: 'eth_subscription', params: { subscription: id, result: l } }) })
    }
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.({}), 1) }
}

function setup(opts: { cursor?: number | null; staleHeadMs?: number } = {}) {
  const chain = new FakeChain()
  const got: { id: string; ctx: DispatchCtx }[] = []
  let saved: number | null = opts.cursor ?? null
  const ws = new WsProvider(['wss://a', 'wss://b'], { staleHeadMs: opts.staleHeadMs ?? 60_000, factory: chain.factory })
  const stream = new ChainStream(ws, chain.rpc, chain.fetchLogs, { get: async () => saved, set: async b => { saved = b } },
    async (logs, ctx) => { for (const l of logs) got.push({ id: logId(l), ctx }) },
    { filters: [{ topics: ['0xswap'] }], reconcileMs: 30, backfillOnStartBlocks: 50, backfillMaxBlocks: 500 })
  return { chain, ws, stream, got, cursor: () => saved }
}

describe('ChainStream', () => {
  test('backfills from the saved cursor in chain order, then streams live, each log once', async () => {
    const { chain, stream, got } = setup({ cursor: 990 })
    for (let b = 991; b <= 1_000; b++) chain.addLog(b, 0) // happened while the engine was down
    await stream.start()
    await sleep(150)
    expect(stream.mode).toBe('live')
    const live = [...chain.mine(2), ...chain.mine(1)]
    await sleep(150)
    await stream.drain()
    const ids = got.map(g => g.id)
    expect(new Set(ids).size).toBe(ids.length) // no duplicates, even though reconcile re-fetches live blocks
    expect(ids.slice(0, 10)).toEqual(chain.logs.slice(0, 10).map(logId)) // backfill first, in order
    for (const l of live) expect(ids).toContain(logId(l))
    stream.stop()
  })

  test('recovers events the socket never delivered', async () => {
    const { chain, stream, got } = setup({ cursor: 1_000 })
    await stream.start()
    await sleep(80)
    chain.deliverLive = false // socket drops logs but still sends heads
    const missed = [...chain.mine(1), ...chain.mine(1), ...chain.mine(1)]
    chain.mine(0); chain.mine(0); chain.mine(0) // reconcile trails the head by 2 blocks
    await sleep(200)
    await stream.drain()
    for (const l of missed) expect(got.map(g => g.id)).toContain(logId(l))
    stream.stop()
  })

  test('first start with no cursor replays the configured window as replay (not broadcast)', async () => {
    const { chain, stream, got } = setup({ cursor: null })
    const old = chain.addLog(980, 0)
    old.blockTimestamp = hex(Math.floor(Date.now() / 1000) - 3_600) // an hour old
    await stream.start()
    await sleep(120)
    await stream.drain()
    const g = got.find(x => x.id === logId(old))!
    expect(g.ctx.replay).toBe(true)
    stream.stop()
  })

  test('after a dropped connection the gap is backfilled and the cursor persisted', async () => {
    const { chain, stream, got, cursor } = setup({ cursor: 1_000 })
    await stream.start()
    await sleep(80)
    for (const s of chain.sockets) s.close()           // provider drops us
    const whileDown = [chain.mine(1)[0], chain.mine(1)[0]] // logs mined with nobody listening
    await sleep(1_500)                                   // reconnect (backoff ~0.5s) + reconcile
    chain.mine(1); chain.mine(0); chain.mine(0)
    await sleep(200)
    await stream.persist()
    for (const l of whileDown) expect(got.map(x => x.id)).toContain(logId(l))
    expect(cursor()).toBeGreaterThanOrEqual(1_002)
    stream.stop()
  })
})

describe('WsProvider', () => {
  test('re-subscribes after reconnecting and fails over to the next provider when stale', async () => {
    const chain = new FakeChain()
    const ws = new WsProvider(['wss://a', 'wss://b'], { staleHeadMs: 300, factory: chain.factory })
    const heads: number[] = []
    ws.subscribeHeads(h => heads.push(h.number))
    let reconnected = 0
    ws.onReconnect = () => { reconnected++ }
    ws.start()
    await sleep(50)
    chain.mine(0)
    await sleep(20)
    expect(heads).toEqual([1_001])
    // The provider goes quiet (no heads): the watchdog must drop it and move on.
    await sleep(1_800)
    expect(chain.sockets.length).toBeGreaterThanOrEqual(2)
    expect(chain.sockets[1].url).toBe('wss://b')
    expect(reconnected).toBeGreaterThanOrEqual(1)
    chain.mine(0)
    await sleep(20)
    expect(heads).toContain(1_002) // the subscription was restored on the new socket
    ws.stop()
  })
})
