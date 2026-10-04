// The coin board's safety (bot/boardSafety.ts, Bot.boardSafety, GET /v1/safety?tokens=…): what the site reads of a
// report, and the scans asking for it queues: a full scan for a young coin, the sell test alone for an older one, two at
// a time (the top of the page first), a fresh report not scanned again, and a coin the engine doesn't track as null.
import { describe, expect, test } from 'bun:test'
import type { LaunchInfo } from '../../api/_marketProtocol'
import { BOARD, boardView } from '../src/bot/boardSafety'
import { Bot } from '../src/bot/bot'
import { MemoryBotStore } from '../src/bot/store'
import type { Rpc } from '../src/chain/http'
import type { PoolRegistry } from '../src/dex/pools'
import type { SafetyReport } from '../src/intel/scanner'
import type { MarketEngine } from '../src/market/engine'
import { TokenState } from '../src/market/tokenState'

const settle = () => new Promise(r => setTimeout(r, 20))
const report = (token: string, checks: SafetyReport['checks']): SafetyReport =>
  ({ token, launchpad: 'ARGUS', at: Date.now(), verdict: 'pass', score: 90, checks, template: null, honeypot: null })

describe('what the site reads of a report', () => {
  test('failed hard checks, failed risk checks, whether it sold back, and the launcher', () => {
    const v = boardView(report('0x1', [
      { id: 'honeypot', ok: false, hard: true, detail: "a holder can't sell" },
      { id: 'holders', ok: false, hard: false, risk: true, detail: 'top 10 hold 70%' },
      { id: 'serial', ok: true, hard: false, risk: true, detail: '0 other launches today' },
      { id: 'clusters', ok: null, hard: true, detail: 'funding not traced yet' },
    ]), { coins: 7, dumps: 5 })
    expect(v.fails).toEqual([{ id: 'honeypot', detail: "a holder can't sell" }])
    expect(v.risks).toEqual([{ id: 'holders', detail: 'top 10 hold 70%' }])
    expect(v.sellable).toBe(false)
    expect(v.launcher).toEqual({ coins: 7, dumps: 5 })
    expect(v.deep).toBe(true)
  })
  test('a coin on its launchpad curve has no sell test: the curve buys back', () => {
    expect(boardView(report('0x1', [{ id: 'liquidity', ok: true, hard: true, detail: 'on its launchpad curve' }]), null).sellable).toBe(true)
  })
  test('the sell test not run yet: unknown, not safe', () => {
    const v = boardView(report('0x1', [{ id: 'honeypot', ok: null, hard: true, detail: 'not probed yet' }]), null)
    expect(v.sellable).toBeNull()
    expect(v.fails).toEqual([])
  })
  test('no report yet', () => {
    expect(boardView(null, { coins: 0, dumps: 0 })).toEqual({ at: 0, fails: [], risks: [], sellable: null, launcher: { coins: 0, dumps: 0 }, deep: false, creator: null })
    expect(boardView(null, null, '0xabc').creator).toBe('0xabc')
  })
})

describe('the scans the board asks for', () => {
  const now = Date.now()
  const coin = (n: number, ageMin: number): LaunchInfo => ({ token: '0x' + String(n).padStart(40, '0'), name: `C${n}`, symbol: `C${n}`, decimals: 18, creator: '0x' + 'cc'.repeat(20), txHash: '0x', blockNumber: 1, timestamp: now - ageMin * 60_000, pool: null, quote: null, launchpad: 'ARGUS', chain: 'ARC', status: 'LIVE' })

  class BoardBot extends Bot {
    calls: { token: string; deep: boolean; probe: boolean }[] = []
    hold: Promise<void> | null = null
    override async report(token: string, deep: boolean, o: { probe?: boolean } = {}): Promise<SafetyReport> {
      this.calls.push({ token, deep, probe: !!o.probe })
      if (this.hold) await this.hold
      const r = report(token, [{ id: 'honeypot', ok: true, hard: true, detail: 'sold back fine' }])
      ;(this as unknown as { reports: Map<string, SafetyReport> }).reports.set(token, r)
      return r
    }
  }
  const setup = (coins: LaunchInfo[]) => {
    const engine = { metas: new Map(coins.map(c => [c.token, c])), tokens: new Map(coins.map(c => [c.token, new TokenState(c.token)])) } as unknown as MarketEngine
    return new BoardBot({ rpc: {} as Rpc, engine, pools: { get: () => null } as unknown as PoolRegistry, store: new MemoryBotStore(), publish: () => {}, mode: 'paper', speed: null })
  }

  test('a young coin gets the full scan, an older one the sell test alone; unknown coins are null', async () => {
    const young = coin(1, 30), old = coin(2, 2 * 24 * 60)
    const bot = setup([young, old])
    const stranger = '0x' + '99'.repeat(20)
    const first = bot.boardSafety([young.token, old.token, stranger])
    expect(first[young.token]).toMatchObject({ at: 0, sellable: null, launcher: { coins: 0, dumps: 0 }, creator: '0x' + 'cc'.repeat(20) })
    expect(first[stranger]).toBeNull()
    await settle()
    expect(bot.calls).toEqual(expect.arrayContaining([{ token: young.token, deep: true, probe: false }, { token: old.token, deep: false, probe: true }]))
    const second = bot.boardSafety([young.token, old.token])
    expect(second[young.token]?.sellable).toBe(true)
    expect(second[young.token]?.at).toBeGreaterThan(0)
    await settle()
    expect(bot.calls).toHaveLength(2) // fresh reports aren't scanned again
  })

  test('two scans at a time, the top of the page first, the rest waiting their turn', async () => {
    const coins = [1, 2, 3, 4, 5].map(n => coin(n, 10))
    const bot = setup(coins)
    let release!: () => void
    bot.hold = new Promise(r => { release = r })
    bot.boardSafety(coins.map(c => c.token))
    await settle()
    expect(bot.calls).toHaveLength(BOARD.concurrency)
    expect(bot.calls.map(c => c.token)).toEqual([coins[0].token, coins[1].token]) // the first coins asked for first
    bot.boardSafety(coins.map(c => c.token)) // asking again while queued doesn't queue twice
    release(); bot.hold = null
    await settle(); await settle()
    expect(bot.calls.map(c => c.token).sort()).toEqual(coins.map(c => c.token).sort())
  })

  test('at most BOARD.maxTokens coins a request', () => {
    const bot = setup([])
    const many = Array.from({ length: BOARD.maxTokens + 30 }, (_, i) => '0x' + String(i + 1).padStart(40, '0'))
    expect(Object.keys(bot.boardSafety(many))).toHaveLength(BOARD.maxTokens)
  })
})
