// The futures keeper: executes traders' and liquidity providers' requests, liquidates positions
// below their maintenance margin, and closes positions that reached their take-profit or
// stop-loss (contracts/SensePerps.sol).
//
// Fairness: a request is executed with the FIRST signed prices observed at or after it was made
// (still fresh enough for the contract), never a later, more convenient one. Liquidations and
// take-profit/stop-loss use the latest prices, checked every time new ones arrive.

import type { Address, Hex, PublicClient, WalletClient, Account, Chain, Transport } from 'viem'
import { PERPS_ABI } from './abi'
import type { RedstoneFeed, SignedPkg, Snapshot } from './redstone'
import { KIND, positionAt, symbolOf, type MarketOnChain, type Pos, type Req } from './shared'
import { errMsg, log } from '../log'

export { KIND, positionAt, type MarketOnChain, type Pos, type Req, type Side } from './shared'

export interface Action {
  type: 'execute' | 'liquidate' | 'tpsl'
  id: bigint
  snap: Snapshot
  feeds: string[]
  why: string
}

type SnapSource = Pick<RedstoneFeed, 'history' | 'latest'>


/** The first snapshot signed at or after `fromMs`, with every feed, still fresh at `nowMs`. */
export function firstFresh(feed: SnapSource, fromMs: number, feeds: string[], nowMs: number, maxAgeMs: number): Snapshot | null {
  for (const s of feed.history()) {
    if (s.ts < fromMs || s.ts < nowMs - maxAgeMs) continue
    if (feeds.every(f => s.feeds[f]?.ts === s.ts)) return s
  }
  return null
}

/** What the keeper should do now. Pure, for tests. */
export function plan(o: {
  nowMs: number
  requests: [bigint, Req][]
  positions: [bigint, Pos][]
  markets: MarketOnChain[]
  maxPriceAge: number
  requestTimeout: number
  feed: SnapSource
  skip?: (key: string) => boolean
}): Action[] {
  const actions: Action[] = []
  // A margin so a price isn't stale by the time the transaction lands.
  const maxAgeMs = Math.max(5, o.maxPriceAge - 10) * 1000
  const marketFeeds = o.markets.map(m => symbolOf(m.p.feedId))
  const latest = o.feed.latest()
  const sorted = [...o.requests].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  for (const [id, r] of sorted) {
    if (o.skip?.(`r${id}`)) continue
    const fromMs = Number(r.createdAt) * 1000
    if (r.kind === KIND.Open) {
      const m = o.markets[r.marketId]
      if (!m) continue
      const feed = symbolOf(m.p.feedId)
      if (r.triggerPrice === 0n) {
        if (o.nowMs > fromMs + o.requestTimeout * 1000 - 3_000) continue // expired: the trader cancels it
        const snap = firstFresh(o.feed, fromMs, [feed], o.nowMs, maxAgeMs)
        if (snap) actions.push({ type: 'execute', id, snap, feeds: [feed], why: 'market order' })
      } else {
        const p = latest?.feeds[feed]
        if (!latest || !p || latest.ts < fromMs || latest.ts < o.nowMs - maxAgeMs) continue
        const hit = r.isLong ? p.median <= r.triggerPrice : p.median >= r.triggerPrice
        if (hit) actions.push({ type: 'execute', id, snap: latest, feeds: [feed], why: 'limit reached' })
      }
    } else if (r.kind === KIND.Close) {
      const m = o.markets[r.marketId]
      if (!m) continue
      const feed = symbolOf(m.p.feedId)
      const snap = firstFresh(o.feed, fromMs, [feed], o.nowMs, maxAgeMs)
      if (snap) actions.push({ type: 'execute', id, snap, feeds: [feed], why: 'close' })
    } else if (r.kind === KIND.Deposit || r.kind === KIND.Withdraw) {
      if (r.kind === KIND.Deposit && o.nowMs > fromMs + o.requestTimeout * 1000 - 3_000) continue
      const active = o.markets.filter(m => m.long_.oi > 0n || m.short_.oi > 0n).map(m => symbolOf(m.p.feedId))
      const snap = active.length ? firstFresh(o.feed, fromMs, active, o.nowMs, maxAgeMs) : (latest ?? null)
      if (snap || !active.length) actions.push({ type: 'execute', id, snap: snap ?? emptySnap(o.nowMs), feeds: active, why: r.kind === KIND.Deposit ? 'deposit' : 'withdrawal' })
    }
  }
  if (!latest || latest.ts < o.nowMs - maxAgeMs) return actions
  const nowSec = Math.floor(o.nowMs / 1000)
  for (const [id, pos] of o.positions) {
    if (o.skip?.(`p${id}`)) continue
    const m = o.markets[pos.marketId]
    if (!m) continue
    const feed = marketFeeds[pos.marketId]
    const p = latest.feeds[feed]
    if (!p || latest.ts < Number(pos.openedAt) * 1000) continue
    if (positionAt(pos, m, p.median, nowSec).liquidatable) {
      actions.push({ type: 'liquidate', id, snap: latest, feeds: [feed], why: 'below maintenance margin' })
      continue
    }
    if (latest.ts < Number(pos.tpSlSetAt) * 1000) continue
    const tpHit = pos.tp !== 0n && (pos.isLong ? p.median >= pos.tp : p.median <= pos.tp)
    const slHit = pos.sl !== 0n && (pos.isLong ? p.median <= pos.sl : p.median >= pos.sl)
    if (tpHit || slHit) actions.push({ type: 'tpsl', id, snap: latest, feeds: [feed], why: tpHit ? 'take-profit' : 'stop-loss' })
  }
  return actions
}

function emptySnap(nowMs: number): Snapshot {
  return { ts: nowMs, fetchedAt: nowMs, feeds: {} }
}

/** The signed packages for `feeds` from a snapshot, as the contract takes them. */
export function pricesArg(snap: Snapshot, feeds: string[]) {
  const out: { feedId: Hex; value: bigint; timestampMs: bigint; signature: Hex }[] = []
  for (const f of feeds) {
    for (const p of snap.feeds[f]?.pkgs ?? ([] as SignedPkg[])) out.push({ feedId: p.feedId, value: p.value, timestampMs: p.timestampMs, signature: p.signature })
  }
  return out
}

export interface KeeperOptions {
  client: PublicClient
  wallet: WalletClient<Transport, Chain, Account>
  perps: Address
  feed: RedstoneFeed
  everyMs?: number
  now?: () => number
}

export interface KeeperChainState {
  at: number
  requests: [bigint, Req][]
  positions: [bigint, Pos][]
  markets: MarketOnChain[]
  pool: {
    poolAmount: bigint
    totalReserved: bigint
    totalCollateral: bigint
    totalSupply: bigint
    paused: boolean
    execFee: bigint
    minCollateral: bigint
    requestTimeout: number
    maxPriceAge: number
    lpCooldown: number
  }
}

export class PerpsKeeper {
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private backoff = new Map<string, number>()
  state: KeeperChainState | null = null
  lastRun: number | null = null
  executed = 0
  errors = 0
  lastError: string | null = null

  constructor(private o: KeeperOptions) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.o.everyMs ?? 2_500)
    this.o.feed.onSnapshot(() => void this.tick())
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private now() {
    return (this.o.now ?? Date.now)()
  }

  /** Reads the contract: pending requests, open positions, markets and the pool. */
  async read(): Promise<KeeperChainState> {
    const c = { address: this.o.perps, abi: PERPS_ABI } as const
    // Separate reads; the engine's client batches them into Multicall3 calls (perps/service.ts).
    const r = <T>(functionName: string) => this.o.client.readContract({ ...c, functionName: functionName as never }) as Promise<T>
    const [reqIds, posIds, markets, poolAmount, totalReserved, totalCollateral, totalSupply, paused, execFee, minCollateral, requestTimeout, maxPriceAge, lpCooldown] =
      await Promise.all([
        r<readonly bigint[]>('pendingRequestIds'), r<readonly bigint[]>('openPositionIds'), r<unknown>('getMarkets'),
        r<bigint>('poolAmount'), r<bigint>('totalReserved'), r<bigint>('totalCollateral'), r<bigint>('totalSupply'),
        r<boolean>('paused'), r<bigint>('execFee'), r<bigint>('minCollateral'), r<bigint>('requestTimeout'),
        r<bigint>('maxPriceAge'), r<bigint>('lpCooldown'),
      ])
    const [reqs, poss] = await Promise.all([
      reqIds.length ? this.o.client.readContract({ ...c, functionName: 'getRequests', args: [reqIds] }) : Promise.resolve([] as readonly unknown[]),
      posIds.length ? this.o.client.readContract({ ...c, functionName: 'getPositions', args: [posIds] }) : Promise.resolve([] as readonly unknown[]),
    ])
    const state: KeeperChainState = {
      at: this.now(),
      requests: reqIds.map((id, i) => [id, reqs[i] as unknown as Req] as [bigint, Req]).filter(([, r]) => r.kind !== KIND.None),
      positions: posIds.map((id, i) => [id, poss[i] as unknown as Pos] as [bigint, Pos]).filter(([, p]) => p.trader !== '0x0000000000000000000000000000000000000000'),
      markets: markets as unknown as MarketOnChain[],
      pool: {
        poolAmount, totalReserved, totalCollateral, totalSupply, paused, execFee, minCollateral,
        requestTimeout: Number(requestTimeout), maxPriceAge: Number(maxPriceAge), lpCooldown: Number(lpCooldown),
      },
    }
    this.state = state
    return state
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      const s = await this.read()
      const now = this.now()
      for (const [k, until] of this.backoff) if (until <= now) this.backoff.delete(k)
      const actions = plan({
        nowMs: now, requests: s.requests, positions: s.positions, markets: s.markets,
        maxPriceAge: s.pool.maxPriceAge, requestTimeout: s.pool.requestTimeout, feed: this.o.feed,
        skip: k => this.backoff.has(k),
      })
      for (const a of actions) await this.run(a)
      this.lastRun = this.now()
    } catch (e) {
      this.errors++
      this.lastError = errMsg(e)
      if (this.errors % 10 === 1) log.warn('perps keeper: tick failed', { error: this.lastError })
    } finally {
      this.busy = false
    }
  }

  private async run(a: Action) {
    const key = `${a.type === 'execute' ? 'r' : 'p'}${a.id}`
    const functionName = a.type === 'execute' ? 'executeRequest' : a.type === 'liquidate' ? 'liquidate' : 'executeTpSl'
    const args = [a.id, pricesArg(a.snap, a.feeds)] as const
    try {
      const { request } = await this.o.client.simulateContract({
        address: this.o.perps, abi: PERPS_ABI, functionName, args, account: this.o.wallet.account,
      })
      const hash = await this.o.wallet.writeContract(request)
      const receipt = await this.o.client.waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 500 })
      if (receipt.status !== 'success') throw new Error(`reverted on-chain (${hash})`)
      this.executed++
      log.info('perps keeper', { action: a.type, id: String(a.id), why: a.why, priceTs: a.snap.ts, tx: hash })
    } catch (e) {
      this.errors++
      this.lastError = `${a.type} ${a.id}: ${errMsg(e)}`
      // Not again for 20 seconds: a newer price may make it go through.
      this.backoff.set(key, this.now() + 20_000)
      log.warn('perps keeper: action failed', { action: a.type, id: String(a.id), why: a.why, error: errMsg(e).slice(0, 300) })
    }
  }
}
