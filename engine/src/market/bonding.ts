// Argus coins on their launch curve, and how close each is to graduating (2026-10-04, owner: "near-bonding coins on Arc
// show only one; you know the market cap for bonding"). The site's market list comes from GeckoTerminal, which carries a
// few dozen Argus coins; this engine sees every launch (Portal 7 alone, ~3,000 a day). Here every launch it tracks that
// traded in the last 6 hours gets its progress, served at GET /v1/bonding for the coin board's Near bond column.
//
// Progress is by market cap: a launch graduates ("bonds") when its pool's price reaches the bond tick in its Portal
// record, so the market cap there is the graduation market cap, and the coin's share of it is 1.0001^-(ticks to go)
// (price moves 0.01% a tick). Each launch's record (start and bond ticks, hook) is read once; every 30 seconds its hook's
// bonded() and the pool's current tick (v4's StateView) are read for the coins still on their curve, in batches.

import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from 'viem'
import type { Rpc } from '../chain/http'
import type { MarketEngine } from './engine'
import { PORTAL7, PORTAL8 } from '../launchpads/argus'
import { log, errMsg } from '../log'
import { metrics } from '../metrics'
import type { BondingCoin } from '../../../api/_marketProtocol'

export type { BondingCoin }

const P7 = parseAbi(['function launches(address) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId, int24 tickBond, address quoteAsset)'])
const P8 = parseAbi(['function launches(address) view returns (address hook, address escrow, address locker, uint256 positionId, int24 tickStart, int24 tickBond, bool tokenIsToken0)'])
const HOOK = parseAbi(['function bonded() view returns (bool)'])
const SV = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)'])
/** v4's StateView on Arc. */
const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
const ZERO = '0x0000000000000000000000000000000000000000'

export const BONDING = {
  everyMs: 30_000,
  /** Launches this recent are followed (older ones have graduated or died). */
  maxAgeMs: 48 * 3_600_000,
  /** …and only those that traded this recently. */
  activeMs: 6 * 3_600_000,
  /** At most this many a round, the most recently traded first. */
  maxCoins: 400,
  /** eth_calls per batch (the public RPC drops items from larger ones when busy; a dropped read is asked next round). */
  batch: 25,
} as const

/** Share of the graduation market cap, 0–100: price moves 0.01% a tick toward the bond tick. */
export function mcProgress(tick: number, tickStart: number, tickBond: number): number | null {
  const span = tickBond - tickStart
  if (span === 0) return null
  const toGo = (tickBond - tick) * Math.sign(span)
  if (toGo <= 0) return 100
  return Math.max(0, Math.min(100, 100 * Math.pow(1.0001, -toGo)))
}

interface Rec { tickStart: number; tickBond: number; hook: string }

export class BondingBook {
  /** Each launch's record (null: none, or no bond tick), read once. */
  private recs = new Map<string, Rec | null>()
  /** Launches that graduated: off their curve for good. */
  private bonded = new Set<string>()
  private view: BondingCoin[] = []
  private busy = false
  at = 0

  constructor(private o: { rpc: Rpc; engine: MarketEngine; now?: () => number }) {}

  start(everyMs: number = BONDING.everyMs) {
    const run = () => { void this.refresh().catch(e => { metrics.inc('bonding_errors'); log.debug('bonding: refresh failed', { error: errMsg(e) }) }) }
    run()
    return setInterval(run, everyMs)
  }

  /** The coins still on their curve, closest to graduating first. */
  list(limit = 100): BondingCoin[] { return this.view.slice(0, limit) }

  private async calls(list: { to: string; data: Hex }[]): Promise<(Hex | null)[]> {
    const out: (Hex | null)[] = []
    for (let i = 0; i < list.length; i += BONDING.batch) {
      const chunk = list.slice(i, i + BONDING.batch)
      const res = await this.o.rpc.batch<Hex>(chunk.map(c => ({ method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] })), 15_000).catch(() => chunk.map(() => null))
      out.push(...res)
    }
    return out
  }

  async refresh(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const now = (this.o.now ?? Date.now)()
      const { metas, tokens } = this.o.engine
      const cands = [...metas.values()]
        .filter(m => m.launchpad === 'ARGUS' && (m.portal === 7 || m.portal === 8) && m.pool && now - m.timestamp < BONDING.maxAgeMs && !this.bonded.has(m.token))
        .map(m => ({ m, st: tokens.get(m.token) }))
        .filter(x => x.st && (x.st.priceUsd ?? 0) > 0 && (x.st.supply ?? 0) > 0 && now - x.st.lastTradeAt < BONDING.activeMs)
        .sort((a, b) => b.st!.lastTradeAt - a.st!.lastTradeAt)
        .slice(0, BONDING.maxCoins)

      // 1. Records not read yet.
      const unread = cands.filter(x => !this.recs.has(x.m.token))
      const recRes = await this.calls(unread.map(x => ({ to: x.m.portal === 7 ? PORTAL7 : PORTAL8, data: encodeFunctionData({ abi: x.m.portal === 7 ? P7 : P8, functionName: 'launches', args: [x.m.token as Hex] }) })))
      unread.forEach((x, i) => {
        const r = recRes[i]
        if (!r || r === '0x') return // asked again next round
        try {
          if (x.m.portal === 7) {
            const d = decodeFunctionResult({ abi: P7, functionName: 'launches', data: r })
            this.recs.set(x.m.token, d[0] === ZERO ? null : { tickStart: Number(d[1]), tickBond: Number(d[9]), hook: (d[4] as string).toLowerCase() })
          } else {
            const d = decodeFunctionResult({ abi: P8, functionName: 'launches', data: r })
            this.recs.set(x.m.token, d[0] === ZERO ? null : { tickStart: Number(d[4]), tickBond: Number(d[5]), hook: (d[0] as string).toLowerCase() })
          }
        } catch { this.recs.set(x.m.token, null) }
      })

      // 2. Graduated yet, and 3. the pool's tick, for those with a record.
      const live = cands.filter(x => { const r = this.recs.get(x.m.token); return r && r.tickBond !== r.tickStart })
      const res = await this.calls(live.flatMap(x => [
        { to: this.recs.get(x.m.token)!.hook, data: encodeFunctionData({ abi: HOOK, functionName: 'bonded' }) },
        { to: STATE_VIEW, data: encodeFunctionData({ abi: SV, functionName: 'getSlot0', args: [x.m.pool as Hex] }) },
      ]))
      const view: BondingCoin[] = []
      live.forEach((x, i) => {
        const bondedRaw = res[2 * i], slotRaw = res[2 * i + 1]
        try {
          if (bondedRaw && bondedRaw !== '0x' && decodeFunctionResult({ abi: HOOK, functionName: 'bonded', data: bondedRaw })) { this.bonded.add(x.m.token); return }
          if (!slotRaw || slotRaw === '0x') return
          const tick = Number(decodeFunctionResult({ abi: SV, functionName: 'getSlot0', data: slotRaw })[1])
          const rec = this.recs.get(x.m.token)!
          const progress = mcProgress(tick, rec.tickStart, rec.tickBond)
          // At or past its bond tick it has graduated (its hook's answer may have been dropped this round).
          if (progress === null || progress >= 100) return
          const st = x.st!
          const day = st.stats(now)
          const mc = st.priceUsd! * st.supply!
          view.push({
            token: x.m.token, symbol: x.m.symbol, name: x.m.name, image: x.m.image ?? null, portal: x.m.portal!, pool: x.m.pool!, createdAt: x.m.timestamp,
            creator: x.m.creator, priceUsd: st.priceUsd!, marketCapUsd: mc, bondMarketCapUsd: progress > 0 ? mc / (progress / 100) : 0,
            liquidityUsd: st.liquidityUsd, volume24h: day.vol24, buys24h: day.buys24, sells24h: day.sells24, progress,
          })
        } catch { /* a coin it couldn't read: next round */ }
      })
      this.view = view.sort((a, b) => b.progress - a.progress)
      this.at = now
      metrics.set('bonding_coins', view.length)
    } finally { this.busy = false }
  }
}
