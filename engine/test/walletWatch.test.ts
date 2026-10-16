// The wallet tracker (trench/walletWatch.ts, TrenchService.walletView, the `wallet` channel).
import { describe, expect, test } from 'bun:test'
import { WalletWatch, WATCH } from '../src/trench/walletWatch'
import { TrenchService } from '../src/trench/service'
import { parseClientMessage, topicOf } from '../../api/_marketProtocol'
import { tradeTopic, walletTopic, type WalletTradeWire } from '../../api/_trenchProtocol'
import type { FeedTrade } from '../src/trench/book'

const EVM = '0xAbCdEf0000000000000000000000000000001234'
const SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const trade = (wallet: string | null, side: 'buy' | 'sell' = 'buy', ts = 1_000, usd = 50): FeedTrade => ({ token: '0xcoin', wallet, side, usd, tokens: 1_000, ts, mcapUsd: 20_000 })

function harness() {
  const subs = new Set<string>()
  const pushed: { topic: string; d: WalletTradeWire }[] = []
  const w = new WalletWatch({ wants: t => subs.has(t), publish: (topic, d) => pushed.push({ topic, d }) })
  return { w, subs, pushed }
}

describe('the wallet channel', () => {
  test('an EVM wallet is one topic for every EVM chain; Solana keeps its case', () => {
    expect(walletTopic(EVM)).toBe(`wallet:evm:${EVM.toLowerCase()}`)
    expect(tradeTopic('arc', EVM)).toBe(walletTopic(EVM)!)
    expect(tradeTopic('bnb', EVM.toLowerCase())).toBe(walletTopic(EVM)!)
    expect(tradeTopic('hood', EVM)).toBe(walletTopic(EVM)!)
    expect(walletTopic(SOL)).toBe(`wallet:sol:${SOL}`)
    expect(tradeTopic('sol', SOL)).toBe(walletTopic(SOL)!)
    expect(walletTopic('0x123')).toBeNull()
    expect(walletTopic('not a wallet!')).toBeNull()
  })
  test('subscriptions are checked and map to the same topics', () => {
    const m = parseClientMessage(JSON.stringify({ action: 'subscribe', channel: 'wallet', wallet: EVM }))
    expect('error' in m).toBe(false)
    if ('error' in m) return
    expect(m.wallet).toBe(EVM.toLowerCase())
    expect(topicOf({ channel: 'wallet', wallet: m.wallet })).toBe(walletTopic(EVM)!)
    const s = parseClientMessage(JSON.stringify({ action: 'subscribe', channel: 'wallet', wallet: SOL }))
    expect('error' in s ? null : topicOf({ channel: 'wallet', wallet: s.wallet })).toBe(walletTopic(SOL)!)
    expect(parseClientMessage(JSON.stringify({ action: 'subscribe', channel: 'wallet', wallet: 'x' }))).toEqual({ error: 'bad_wallet' })
    expect(parseClientMessage(JSON.stringify({ action: 'subscribe', channel: 'wallet' }))).toEqual({ error: 'bad_wallet' })
  })
})

describe('WalletWatch', () => {
  test('nothing is kept or pushed for wallets nobody follows', () => {
    const { w, pushed } = harness()
    w.record('arc', trade(EVM), null)
    expect(pushed.length).toBe(0)
    expect(w.size()).toBe(0)
  })
  test('a followed wallet’s trades are pushed at once and kept, on any of its chains', () => {
    const { w, subs, pushed } = harness()
    subs.add(walletTopic(EVM)!)
    w.record('arc', trade(EVM, 'buy', 1_000), { symbol: 'AAA', image: null, mcap: 9_000 })
    w.record('bnb', trade(EVM.toLowerCase(), 'sell', 2_000), null)
    w.record('sol', trade(SOL), null)
    expect(pushed.map(p => [p.topic, p.d.c, p.d.side])).toEqual([[walletTopic(EVM)!, 'arc', 'B'], [walletTopic(EVM)!, 'bnb', 'S']] as string[][])
    expect(pushed[0].d.s).toBe('AAA')
    expect(pushed[0].d.m).toBe(20_000)
    expect(w.view(EVM)!.map(t => t.c)).toEqual(['bnb', 'arc'])
  })
  test('a look at a wallet’s page starts keeping its trades', () => {
    const { w } = harness()
    expect(w.view(SOL)).toEqual([])
    w.record('sol', trade(SOL, 'buy', 5), null)
    expect(w.view(SOL)!.length).toBe(1)
    expect(w.view('nope')).toBeNull()
  })
  test('at most WATCH.keep trades a wallet, the newest kept', () => {
    const { w, subs } = harness()
    subs.add(walletTopic(EVM)!)
    for (let i = 0; i < WATCH.keep + 20; i++) w.record('arc', trade(EVM, 'buy', i), null)
    const v = w.view(EVM)!
    expect(v.length).toBe(WATCH.keep)
    expect(v[0].ts).toBe(WATCH.keep + 19)
  })
  test('a wallet nobody watched for a day is dropped', () => {
    const { w } = harness()
    w.view(EVM, 0)
    w.view(SOL, WATCH.idleMs + 1)
    expect(w.size()).toBe(1)
  })
  test('trades without a wallet are ignored', () => {
    const { w, subs, pushed } = harness()
    subs.add(walletTopic(EVM)!)
    w.record('arc', trade(null), null)
    expect(pushed.length).toBe(0)
  })
})

describe('TrenchService.walletView', () => {
  const svc = () => {
    const subs = new Set<string>()
    const out: unknown[] = []
    const s = new TrenchService({
      publish: (_t, m) => out.push(m), wants: t => subs.has(t),
      settings: { getSetting: async () => null, setSetting: async () => {} }, listBase: 'http://127.0.0.1:1',
    })
    return { s, subs, out }
  }
  test('every book’s trades reach the tracker, and a followed wallet’s are published as WTRADE', () => {
    const { s, subs, out } = svc()
    subs.add(walletTopic(EVM)!)
    s.books.bnb.trade({ ...trade(EVM.toLowerCase()), token: '0xcoin' })
    s.books.sol.trade({ ...trade(SOL), token: 'Mint1111111111111111111111111111111111111' })
    expect(out).toHaveLength(1)
    expect((out[0] as { t: string; d: WalletTradeWire }).t).toBe('WTRADE')
    expect((out[0] as { d: WalletTradeWire }).d.c).toBe('bnb')
  })
  test('the view carries a record per chain the wallet traded on, and its kept trades', () => {
    const { s } = svc()
    expect(s.walletView(EVM)!.trades).toEqual([])
    const t0 = Date.now() - 10 * 60_000
    s.books.bnb.trade({ token: '0xcoin', wallet: EVM.toLowerCase(), side: 'buy', usd: 100, tokens: 1_000, ts: t0 })
    s.books.bnb.trade({ token: '0xcoin', wallet: EVM.toLowerCase(), side: 'sell', usd: 150, tokens: 1_000, ts: t0 + 120_000 })
    const v = s.walletView(EVM)!
    expect(v.trades.map(t => t.side)).toEqual(['S', 'B'])
    const bnb = v.records.find(r => r.c === 'bnb')
    expect(bnb?.trades).toBe(1)
    expect(bnb?.pnl).toBe(50)
    expect(v.records.some(r => r.c === 'sol')).toBe(false)
    expect(s.walletView('bad')).toBeNull()
  })
})
