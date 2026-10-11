// Arc's established coins from the engine's own trades (2026-10-06).
//
// The site's Arc list comes from GeckoTerminal, and GeckoTerminal answers the engine's IP with 429 for most of a
// build (one Railway IP, shared quota), so Arc's most-traded coins on plain Uniswap pools (ARCMAN, TOLLY…) came and
// went from the list. The engine sees every one of their swaps itself: price, liquidity, market cap and true trade
// counts. What it lacks for a coin no launch adapter reported is its name and age; those are read on-chain once
// (name()/symbol(), and the block its contract was created in) and kept in the settings.
//
// rows() gives the coins meeting the site's established rule (api/_launchpads.ts isEstablishedCoin) in the market
// list's own shape, and api/_argusCore.ts withArcExtra adds those the stored list lacks. A coin GeckoTerminal does
// list keeps its row (with its logo); only a missing market cap is filled from here.

import { ARGUS, NATIVE, USDC } from '../../../api/_arcSwaps'
import { ARCHIVE_RPCS, hex, rpcCall } from '../../../api/_arcLogs'
import type { ArgusPool } from '../../../api/_argusCore'
import { creationBlock, MAX_AGE_BLOCKS } from '../../../api/_holdersCore'
import { ESTABLISHED, isEstablishedCoin } from '../../../api/_launchpads'
import type { Rpc } from '../chain/http'
import { tokenMeta } from '../launchpads/adapter'
import { log, errMsg } from '../log'
import type { TokenState } from './tokenState'

export interface TokenInfo { name: string; symbol: string; createdAt: number | null; checkedAt: number }
export type TokenInfoBook = Record<string, TokenInfo>

interface Deps {
  tokens: Map<string, TokenState>
  /** Coins a launch adapter reported: the site lists those from their launch, not from here. */
  hasMeta: (token: string) => boolean
  pool: (pool: string) => { dex: string; quote: string } | undefined
  rpc: Rpc
  load?: () => Promise<string | null>
  save?: (json: string) => Promise<void>
  /** First block with the token's code (tests stub it). */
  createdBlock?: (token: string, head: number) => Promise<number | null>
  /** A block's time in ms (tests stub it). */
  blockTime?: (block: number) => Promise<number>
}

export const ESTABLISHED_BOOK = {
  /** A little under the site's rule, so a coin is read before it gets there. */
  minLiquidityUsd: ESTABLISHED.minLiquidityUsd * 0.8,
  minMarketCapUsd: ESTABLISHED.minMarketCapUsd * 0.8,
  minTrades24: ESTABLISHED.minTxns24h,
  /** Coins read per round, busiest first; a round every 20 seconds. */
  perRound: 3,
  /** A token whose reads failed is tried again after this. */
  retryMs: 10 * 60_000,
  /** Arc makes a block about every half second (the age of a token older than the holder index's window). */
  blockMs: 500,
}

const QUOTES: Record<string, string> = { [USDC]: 'USDC', [NATIVE]: 'USDC', [ARGUS]: 'ARGUS' }

export class EstablishedBook {
  private info: TokenInfoBook = {}
  private failed = new Map<string, number>()
  private loaded: Promise<void>
  private busy = false
  private dirty = false

  constructor(private d: Deps) {
    this.loaded = (d.load?.() ?? Promise.resolve(null)).then(j => {
      if (j) try { this.info = JSON.parse(j) as TokenInfoBook } catch { /* start over */ }
    }, () => {})
  }

  /** Coins that could be established by the engine's own numbers, busiest first. */
  candidates(now = Date.now()): { token: string; st: TokenState; vol: number }[] {
    const out: { token: string; st: TokenState; vol: number }[] = []
    for (const st of this.d.tokens.values()) {
      if (st.priceUsd === null || st.mainPool === null || this.d.hasMeta(st.token)) continue
      // The cheap fields first (stats() walks the minute ring); stats() then has the last word.
      if ((st.liquidityUsd ?? 0) < ESTABLISHED_BOOK.minLiquidityUsd || st.priceUsd * (st.supply ?? 0) < ESTABLISHED_BOOK.minMarketCapUsd || st.buys24 + st.sells24 < ESTABLISHED_BOOK.minTrades24) continue
      const s = st.stats(now)
      if ((s.liquidityUsd ?? 0) < ESTABLISHED_BOOK.minLiquidityUsd || (s.marketCapUsd ?? 0) < ESTABLISHED_BOOK.minMarketCapUsd || s.trades24 < ESTABLISHED_BOOK.minTrades24) continue
      out.push({ token: st.token, st, vol: s.vol24 })
    }
    return out.sort((a, b) => b.vol - a.vol)
  }

  /** One round: names and ages for the busiest coins not read yet. */
  async refresh(now = Date.now()): Promise<number> {
    await this.loaded
    if (this.busy) return 0
    this.busy = true
    let read = 0
    try {
      const todo = this.candidates(now).filter(c => !this.info[c.token] && now - (this.failed.get(c.token) ?? 0) > ESTABLISHED_BOOK.retryMs).slice(0, ESTABLISHED_BOOK.perRound)
      // A pool's quote other than USDC or ARGUS is named too (WETH, cirBTC…).
      const quotes = new Set<string>()
      for (const c of todo) {
        const q = this.d.pool(c.st.mainPool!)?.quote
        if (q && !QUOTES[q] && !this.info[q]) quotes.add(q)
      }
      const head = todo.length ? Number(BigInt(await this.d.rpc.call<string>('eth_blockNumber', []))) : 0
      for (const c of todo) {
        try {
          const m = await tokenMeta(this.d.rpc, c.token)
          if (!m.symbol) throw new Error('no symbol')
          const block = await (this.d.createdBlock ?? ((t, h) => creationBlock(t, h, null)))(c.token, head)
          // No code anywhere in the holder index's window: older than it.
          const createdAt = block === null ? now - MAX_AGE_BLOCKS * ESTABLISHED_BOOK.blockMs : await (this.d.blockTime ?? blockTimeMs)(block)
          this.info[c.token] = { name: m.name || m.symbol, symbol: m.symbol, createdAt, checkedAt: now }
          read++
        } catch (e) {
          this.failed.set(c.token, now)
          log.debug('established: read failed', { token: c.token, error: errMsg(e) })
        }
      }
      for (const q of quotes) {
        const m = await tokenMeta(this.d.rpc, q).catch(() => null)
        if (m?.symbol) this.info[q] = { name: m.name || m.symbol, symbol: m.symbol, createdAt: null, checkedAt: now }
      }
      if (read || quotes.size) this.dirty = true
      if (this.dirty && this.d.save) { this.dirty = false; await this.d.save(JSON.stringify(this.info)).catch(() => { this.dirty = true }) }
    } finally { this.busy = false }
    return read
  }

  /** The coins meeting the site's established rule, as market-list rows. */
  rows(now = Date.now()): ArgusPool[] {
    const out: ArgusPool[] = []
    for (const { token, st } of this.candidates(now)) {
      const i = this.info[token]
      if (!i || i.createdAt === null) continue
      const s = st.stats(now)
      const liquidityUsd = s.liquidityUsd ?? 0, marketCapUsd = s.marketCapUsd ?? 0
      if (!isEstablishedCoin({ symbol: i.symbol, liquidityUsd, ageMs: now - i.createdAt, marketCapUsd, txns24h: s.trades24 })) continue
      const p = this.d.pool(st.mainPool!)
      const v3 = p?.dex === 'uniswap-v3'
      const quote = p?.quote ?? USDC
      out.push({
        pool: st.mainPool!, dex: v3 ? 'uniswap-v3-arc' : 'uniswap-v4-arc',
        token: { address: token, symbol: i.symbol, name: i.name, image: null },
        quote: { address: quote, symbol: QUOTES[quote] ?? this.info[quote]?.symbol ?? '?' },
        priceUsd: st.priceUsd ?? 0,
        change: { m5: s.chg.m5 ?? 0, h1: s.chg.h1 ?? 0, h6: s.chg.h6 ?? 0, h24: s.chg.h24 ?? 0 },
        volume24h: s.vol24, liquidityUsd, marketCapUsd, fdvUsd: null,
        txns24h: { buys: s.buys24, sells: s.sells24 },
        createdAt: new Date(i.createdAt).toISOString(),
        launchpad: v3 ? 'Uniswap V3' : 'Uniswap V4',
      })
    }
    return out
  }

  /** Every known coin's market cap from the engine (for list rows GeckoTerminal left without one). */
  capOf(token: string, now = Date.now()): number | null {
    const st = this.d.tokens.get(token)
    if (!st || st.priceUsd === null) return null
    const mc = st.stats(now).marketCapUsd
    return mc && mc > 0 ? mc : null
  }

  get known() { return Object.keys(this.info).length }
}

async function blockTimeMs(block: number): Promise<number> {
  for (const url of [...new Set(ARCHIVE_RPCS)]) {
    try {
      const b = await rpcCall<{ timestamp: string } | null>(url, 'eth_getBlockByNumber', [hex(block), false], 6_000)
      if (b?.timestamp) return Number(BigInt(b.timestamp)) * 1000
    } catch { /* the next endpoint */ }
  }
  throw new Error(`block ${block}: no time`)
}
