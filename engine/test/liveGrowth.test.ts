// Live trades at $2, growing with what the trades made (owner, 2026-10-01:
// "live trades at $2 each; as the capital increases, the trade size increases
// based on the PnL gained"), and the platform's own bot keeping its growth
// across a restart.
import { describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import { Bot } from '../src/bot/bot'
import { DEFAULT_LIMITS, LiveTrader } from '../src/bot/liveTrader'
import { LIVE_SIZE, liveTradeSize, sizeForLive } from '../src/bot/sizing'
import { MemoryBotStore } from '../src/bot/store'
import type { Rpc } from '../src/chain/http'
import type { PoolRegistry } from '../src/dex/pools'
import type { MarketEngine } from '../src/market/engine'
import type { LiveExecutor } from '../src/trading/live'
import { openPosition, QUICK_EXITS, recordSell, STRATEGIES, type Position } from '../src/trading/paper'

describe('a live trade\'s size', () => {
  test('$2 to start, grown by the share its realized profit added to the capital it went live with', () => {
    expect(LIVE_SIZE.baseUsd).toBe(2)
    expect(liveTradeSize({ startUsd: 10, pnlUsd: 0 })).toEqual({ sizeUsd: 2, growthPct: 0 })
    expect(liveTradeSize({ startUsd: 10, pnlUsd: 5 })).toEqual({ sizeUsd: 3, growthPct: 50 })
    expect(liveTradeSize({ startUsd: 10, pnlUsd: 10 })).toEqual({ sizeUsd: 4, growthPct: 100 })
    // A bigger wallet grows the same share: 5% on $1,000 is $2.10.
    expect(liveTradeSize({ startUsd: 1_000, pnlUsd: 50 }).sizeUsd).toBe(2.1)
  })
  test('never under $2 (a loss, no start recorded), never over the cap', () => {
    expect(liveTradeSize({ startUsd: 10, pnlUsd: -6 }).sizeUsd).toBe(2)
    expect(liveTradeSize({ startUsd: null, pnlUsd: 50 }).sizeUsd).toBe(2)
    expect(liveTradeSize({ startUsd: 10, pnlUsd: 1_000 }).sizeUsd).toBe(50)
    expect(liveTradeSize({ startUsd: 10, pnlUsd: 1_000, maxUsd: 25 }).sizeUsd).toBe(25)
  })
  test('above $2, at most 20% of what the wallet holds now: a bot that withdrew its profit trades less', () => {
    expect(liveTradeSize({ startUsd: 10, pnlUsd: 10, worthUsd: 20 }).sizeUsd).toBe(4)
    expect(liveTradeSize({ startUsd: 10, pnlUsd: 10, worthUsd: 12 }).sizeUsd).toBe(2.4)
    expect(liveTradeSize({ startUsd: 10, pnlUsd: 10, worthUsd: 5 }).sizeUsd).toBe(2)
  })
  test('the pool and the costs: a trade that can\'t net anything at the take-profit isn\'t one', () => {
    const g = liveTradeSize({ startUsd: 10, pnlUsd: 0 })
    expect(sizeForLive({ ...g, takeProfit: QUICK_EXITS.tp1Multiple, roundTripPct: 2, liquidityUsd: 50_000 })).toMatchObject({ sizeUsd: 2 })
    expect(sizeForLive({ ...g, takeProfit: QUICK_EXITS.tp1Multiple, roundTripPct: 14, liquidityUsd: 50_000 })).toMatchObject({ key: 'costly' })
    expect(sizeForLive({ ...g, takeProfit: QUICK_EXITS.tp1Multiple, roundTripPct: 2, liquidityUsd: 40 })).toMatchObject({ key: 'too-thin' })
  })
})

describe('the platform\'s own bot wallet', () => {
  const settle = () => new Promise(r => setTimeout(r, 10))
  function setup(store: MemoryBotStore, wallet: { balance: number }) {
    const exec = { address: '0x' + 'ab'.repeat(20) as Address, balanceUsd: async () => wallet.balance } as unknown as LiveExecutor
    let bot: Bot | null = null
    const live = new LiveTrader({ exec, limits: DEFAULT_LIMITS, positions: () => bot!.positions, params: s => STRATEGIES[s], save: p => bot!.persist(p) })
    const engine = { metas: new Map(), tokens: new Map() } as unknown as MarketEngine
    const rpc = { call: async () => { throw new Error('no chain here') }, batch: async () => [] } as unknown as Rpc
    bot = new Bot({ rpc, engine, pools: { get: () => null } as unknown as PoolRegistry, store, publish: () => {}, mode: 'live', live })
    return bot
  }
  /** A closed live trade that made `pnl`. */
  const closedLive = (id: string, pnl: number): Position => {
    const p: Position = { ...openPosition({ id, strategy: 'scalp', token: '0x' + 'c4'.repeat(20), symbol: 'C', launchpad: 'ARGUS', signalId: id, price: 1, cost: 0, now: Date.now() - 60_000 }), mode: 'live' }
    recordSell(p, p.qty, p.sizeUsd + pnl, Date.now(), 'tp1')
    return p
  }
  test('trades start at its base, grow with what its live trades made, and keep that across a restart; going live again starts over', async () => {
    const store = new MemoryBotStore()
    await store.setSetting('mode', 'live')
    const wallet = { balance: 15 }
    const bot = setup(store, wallet)
    await bot.start()
    await settle()
    expect(bot.liveSize()).toMatchObject({ sizeUsd: 2, growthPct: 0, pnlUsd: 0, startUsd: 15 })
    // A live trade that made $7.50 on its $15: half again, $3.
    const p = closedLive('w1', 7.5)
    bot.positions.push(p)
    bot.persist(p)
    bot.persist(p) // saved again (a fee, a late receipt): counted once
    expect(bot.liveSize()).toMatchObject({ sizeUsd: 3, growthPct: 50, pnlUsd: 7.5 })
    expect(bot.status().live.sizing).toEqual({ tradeUsd: 3, growthPct: 50, pnlUsd: 7.5, startUsd: 15 })
    // A restart reads its growth back.
    const again = setup(store, wallet)
    await again.start()
    await settle()
    expect(again.liveSize()).toMatchObject({ sizeUsd: 3, pnlUsd: 7.5, startUsd: 15 })
    // Going live again measures from the balance then.
    wallet.balance = 22.5
    expect(await again.setMode('live')).toEqual({ ok: true })
    expect(again.liveSize()).toMatchObject({ sizeUsd: 2, pnlUsd: 0, startUsd: 22.5 })
  })
})
