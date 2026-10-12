// The Trenches' live feed on the engine (api/_trenchProtocol.ts): one TrenchBook per chain, fed by Solana's and BNB
// Chain's launchpads and Robinhood Chain's pools (sol.ts, bsc.ts, hood.ts) and by Arc's own stream (the engine's
// trades, through EngineObserver). Every second each chain's ticks go to its trench_<chain> channel; smart wallets'
// trades go out as they happen; GET /v1/trench/<chain> answers with the launches and the smart-money view.
// TRENCH=off stops it; TRENCH_SOL, TRENCH_BNB, TRENCH_HOOD=off stop one chain's feed; TRENCH_SOL_WSS names
// Solana WebSocket endpoints (comma-separated; a paid node's URL stays server-side).

import type { ServerMessage, Trade } from '../../../api/_marketProtocol'
import { gtFetch } from '../../../api/_geckoterminal'
import { TRENCH_CHAINS, trenchChannel, type TrenchChain, type TrenchMessage, type TrenchSnapshot } from '../../../api/_trenchProtocol'
import { errMsg, log } from '../log'
import type { EngineObserver } from '../market/engine'
import { TrenchBook } from './book'
import { BscFeed, type BscPool } from './bsc'
import { HoodFeed, type HoodPool } from './hood'
import { NativePrices } from './prices'
import { SolFeed } from './sol'

export interface TrenchServiceOpts {
  publish: (topics: string[], msg: ServerMessage) => void
  wants: (topic: string) => boolean
  settings: { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> }
  /** The engine's own address, for its /api/*market lists. */
  listBase: string
  /** Arc: a coin's launch (name, symbol, picture, time). */
  arcMeta?: (token: string) => { symbol: string; name: string; image: string | null; launchedAt: number } | null
  feeds?: Partial<Record<'sol' | 'bnb' | 'hood', boolean>>
  solWss?: string[]
}

interface ListRow { address: string; pool?: string; dex?: string; quote?: string; decimals?: number | null; marketCap?: number; priceUsd?: number; offMarket?: boolean }

const GT_NET: Record<TrenchChain, string> = { arc: 'arc', hood: 'robinhood', sol: 'solana', bnb: 'bsc' }

export class TrenchService implements EngineObserver {
  readonly books: Record<TrenchChain, TrenchBook>
  readonly prices = new NativePrices()
  private sol: SolFeed | null = null
  private bsc: BscFeed | null = null
  private hood: HoodFeed | null = null
  private listed: Record<'sol' | 'bnb' | 'hood', Set<string>> = { sol: new Set(), bnb: new Set(), hood: new Set() }
  private bscPools: BscPool[] = []
  private hoodPools: HoodPool[] = []
  private metaTried = new Set<string>()
  private timers: ReturnType<typeof setInterval>[] = []

  constructor(private o: TrenchServiceOpts) {
    this.books = {
      arc: new TrenchBook('arc', undefined, () => true),
      hood: new TrenchBook('hood', undefined, t => this.listed.hood.has(t)),
      sol: new TrenchBook('sol', undefined, t => this.listed.sol.has(t)),
      bnb: new TrenchBook('bnb', undefined, t => this.listed.bnb.has(t)),
    }
  }

  private send = (m: TrenchMessage) => {
    const topic = trenchChannel(m.c)
    if (this.o.wants(topic)) this.o.publish([topic], m as ServerMessage)
  }

  private store(chain: TrenchChain) {
    return { load: () => this.o.settings.getSetting(`trench:${chain}`), save: (j: string) => this.o.settings.setSetting(`trench:${chain}`, j) }
  }

  async start() {
    await Promise.all(TRENCH_CHAINS.map(c => this.books[c].load(this.store(c)).catch(e => log.warn('trench: load failed', { chain: c, error: errMsg(e) }))))
    this.prices.start()
    await this.refreshLists().catch(() => {})
    const on = (k: 'sol' | 'bnb' | 'hood') => this.o.feeds?.[k] !== false
    if (on('sol')) { this.sol = new SolFeed({ book: this.books.sol, prices: this.prices, publish: this.send, wss: this.o.solWss }); this.sol.start() }
    if (on('bnb')) { this.bsc = new BscFeed({ book: this.books.bnb, prices: this.prices, publish: this.send, pools: () => this.bscPools }); this.bsc.start() }
    if (on('hood')) { this.hood = new HoodFeed({ book: this.books.hood, prices: this.prices, publish: this.send, pools: () => this.hoodPools }); this.hood.start() }
    this.timers.push(setInterval(() => this.tick(), 1_000))
    this.timers.push(setInterval(() => { for (const c of TRENCH_CHAINS) this.books[c].refreshSmart() }, 5_000))
    this.timers.push(setInterval(() => void this.refreshLists().catch(e => log.debug('trench: lists failed', { error: errMsg(e) })), 60_000))
    this.timers.push(setInterval(() => void this.saveAll(), 10 * 60_000))
    this.timers.push(setInterval(() => void this.resolveMeta(), 10_000))
    log.info('trench: following', { sol: !!this.sol, bnb: !!this.bsc, hood: !!this.hood, arc: true })
  }

  stop() {
    for (const t of this.timers) clearInterval(t)
    this.sol?.stop(); this.bsc?.stop(); this.hood?.stop(); this.prices.stop()
    void this.saveAll()
  }

  /** Each chain's last second, to its channel. */
  tick() {
    for (const c of TRENCH_CHAINS) {
      const ticks = this.books[c].ticks()
      if (c === 'arc' || !ticks.length) continue // Arc's coins tick on the market channel already
      this.send({ t: 'TTICKS', c, d: ticks })
    }
  }

  async saveAll() {
    for (const c of TRENCH_CHAINS) await this.books[c].save(this.store(c)).catch(e => log.warn('trench: save failed', { chain: c, error: errMsg(e) }))
  }

  // ── Arc, from the engine's own trades ─────────────────────────────────

  onTrade(t: Trade, ctx: { replay: boolean }) {
    if (ctx.replay || t.side === 'UNKNOWN' || !(t.usdValue && t.usdValue > 0) || !(t.tokenAmount > 0)) return
    const meta = this.o.arcMeta?.(t.token) ?? null
    const st = this.books.arc.trade({
      token: t.token, wallet: t.wallet, side: t.side === 'BUY' ? 'buy' : 'sell', usd: t.usdValue, tokens: t.tokenAmount, ts: t.timestamp,
      priceUsd: t.priceUsd, liquidityUsd: t.liquidity, meta: meta ? { symbol: meta.symbol, name: meta.name, image: meta.image } : null,
    }, meta?.launchedAt ?? 0)
    if (st) this.send({ t: 'TSMART', c: 'arc', d: st })
  }

  // ── the chains' lists (what the site's lanes show) ─────────────────────

  private async list(path: string): Promise<ListRow[]> {
    const r = await fetch(`${this.o.listBase}${path}`, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`${path} ${r.status}`)
    const j = (await r.json()) as { rows?: ListRow[] }
    return Array.isArray(j.rows) ? j.rows : []
  }

  async refreshLists() {
    const supplyOf = (r: ListRow) => (r.marketCap && r.priceUsd && r.priceUsd > 0 ? r.marketCap / r.priceUsd : 0)
    const [sol, bnb, hood] = await Promise.allSettled([this.list('/api/solmarket'), this.list('/api/bscmarket'), this.list('/api/rhmarket')])
    if (sol.status === 'fulfilled' && sol.value.length) this.listed.sol = new Set(sol.value.map(r => r.address))
    if (bnb.status === 'fulfilled' && bnb.value.length) {
      this.listed.bnb = new Set(bnb.value.map(r => r.address.toLowerCase()))
      this.bscPools = bnb.value
        .filter(r => r.pool && (r.dex === 'pancakeswap_v2' || r.dex === 'pancakeswap-v3-bsc') && r.quote)
        .map(r => ({ pool: r.pool!.toLowerCase(), kind: r.dex === 'pancakeswap_v2' ? 'v2' as const : 'v3' as const, coin: r.address.toLowerCase(), quote: r.quote!.toLowerCase(), coinDecimals: r.decimals ?? 18, supply: supplyOf(r) || 1e9 }))
    }
    if (hood.status === 'fulfilled' && hood.value.length) {
      this.listed.hood = new Set(hood.value.map(r => r.address.toLowerCase()))
      // A pool quoted in another listed coin is priced from that coin's own price in the list.
      const rowOf = new Map(hood.value.map(r => [r.address.toLowerCase(), r]))
      this.hoodPools = hood.value
        .filter(r => r.pool && !r.offMarket && r.quote && (r.pool.length === 66 || r.pool.length === 42))
        .map(r => {
          const q = rowOf.get(r.quote!.toLowerCase())
          return { pool: r.pool!.toLowerCase(), coin: r.address.toLowerCase(), quote: r.quote!.toLowerCase(), coinDecimals: r.decimals ?? 18, supply: supplyOf(r), quoteUsd: q?.priceUsd ?? null, quoteDecimals: q?.decimals ?? 18 }
        })
    }
  }

  /** Names for coins smart wallets bought that the feed never saw launch (GeckoTerminal, two a chain each round). */
  private async resolveMeta() {
    for (const c of ['sol', 'bnb', 'hood'] as const) {
      const book = this.books[c]
      const todo = book.smartView().buying.filter(b => !b.s && !this.metaTried.has(`${c}:${b.t}`)).slice(0, 2)
      for (const b of todo) {
        this.metaTried.add(`${c}:${b.t}`)
        try {
          const r = await gtFetch(`/networks/${GT_NET[c]}/tokens/${b.t}`, { signal: AbortSignal.timeout(8_000) })
          if (!r.ok) continue
          const j = (await r.json()) as { data?: { attributes?: { name?: string; symbol?: string; image_url?: string | null } } }
          const a = j.data?.attributes
          if (a?.symbol) book.setMeta(b.t, { symbol: a.symbol.slice(0, 24), name: (a.name ?? a.symbol).slice(0, 48), image: a.image_url && /^https:\/\//.test(a.image_url) ? a.image_url : null })
        } catch { /* asked once; shown by address */ }
      }
    }
    if (this.metaTried.size > 20_000) this.metaTried.clear()
  }

  // ── what the site reads ────────────────────────────────────────────────

  snapshot(chain: TrenchChain, now = Date.now()): TrenchSnapshot {
    const b = this.books[chain]
    const feed = chain === 'sol' ? this.sol : chain === 'bnb' ? this.bsc : chain === 'hood' ? this.hood : null
    const connected = chain === 'arc' ? true : !!feed?.connected
    return {
      chain, at: now, live: connected && now - b.lastEventAt < 60_000, lastEventAt: b.lastEventAt, perMin: b.perMin(),
      launches: b.recentLaunches(300), smart: b.smartView(now),
    }
  }

  health() {
    const now = Date.now()
    return Object.fromEntries(TRENCH_CHAINS.map(c => {
      const s = this.snapshot(c, now)
      return [c, { live: s.live, perMin: s.perMin, launches: s.launches.length, followed: s.smart.followed, smart: s.smart.smart }]
    }))
  }
}
