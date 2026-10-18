// The owner's analytics (src/analytics.ts): what the site may send, how each trade is checked on its chain, and what
// the report counts.
import { describe, expect, test } from 'bun:test'
import { ANALYTICS, Analytics, MemoryAnalyticsStore, parseTrade, verifyTrade, walletOf, type ChainCall, type SiteTradeRow } from '../src/analytics'
import type { FeeRow } from '../src/fees/ledger'

const A = '0x' + 'ab'.repeat(20)
const B = '0x' + 'cd'.repeat(20)
const C = '0x' + 'ef'.repeat(20)
const SOLW = 'So1aNaWa11etAddre55xxxxxxxxxxxxxxxxxxxxxxx'
const tx = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const sig = (n: number) => '5'.repeat(80) + String(n).padStart(4, '1').replace(/0/g, '2')
const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 17, 12)

const trade = (o: Partial<Record<string, unknown>> = {}) => ({ chain: 'arc', venue: 'arc-router', side: 'buy', address: A, usd: 25, feeUsd: 0.125, coin: '0x' + '11'.repeat(20), tx: tx(1), ...o })

describe('what the site may send', () => {
  test('wallets: EVM lower-cased, Solana as written, nothing else', () => {
    expect(walletOf(A.toUpperCase().replace('0X', '0x'))).toBe(A)
    expect(walletOf(SOLW)).toBe(SOLW)
    expect(walletOf('0x123')).toBeNull()
    expect(walletOf(42)).toBeNull()
  })
  test('a trade is checked field by field', () => {
    const ok = parseTrade(trade(), NOW) as SiteTradeRow
    expect(ok.id).toBe(`arc:${tx(1)}`)
    expect(ok.status).toBe('pending')
    expect(parseTrade(trade({ chain: 'dogechain' }), NOW)).toEqual({ error: 'unknown chain' })
    expect(parseTrade(trade({ address: 'nope' }), NOW)).toEqual({ error: 'bad address' })
    expect(parseTrade(trade({ side: 'hold' }), NOW)).toEqual({ error: 'bad side' })
    expect(parseTrade(trade({ usd: 0 }), NOW)).toEqual({ error: 'bad amount' })
    expect(parseTrade(trade({ usd: ANALYTICS.maxUsd + 1 }), NOW)).toEqual({ error: 'bad amount' })
    expect(parseTrade(trade({ feeUsd: 30 }), NOW)).toEqual({ error: 'bad fee' })
    expect(parseTrade(trade({ tx: '0x12' }), NOW)).toEqual({ error: 'bad transaction' })
    // A Solana trade needs a signature, not an EVM hash; venue names are kept short and plain.
    expect(parseTrade(trade({ chain: 'solana', address: SOLW }), NOW)).toEqual({ error: 'bad transaction' })
    expect((parseTrade(trade({ chain: 'solana', address: SOLW, tx: sig(1) }), NOW) as SiteTradeRow).id).toBe(`solana:${sig(1)}`)
    expect((parseTrade(trade({ venue: '<script>' }), NOW) as SiteTradeRow).venue).toBe('other')
    // Hyperliquid's order ids can't be looked up here: kept, marked so.
    expect((parseTrade(trade({ chain: 'hyperliquid', tx: '123456' }), NOW) as SiteTradeRow).status).toBe('unverified')
  })
})

describe('checking a trade on its chain', () => {
  const evm = (receipt: unknown): ChainCall => async () => receipt
  const row = parseTrade(trade(), NOW) as SiteTradeRow
  test('EVM: succeeded and sent by that wallet', async () => {
    expect(await verifyTrade(row, evm({ status: '0x1', from: A.toUpperCase().replace('0X', '0x') }))).toBe('ok')
    expect(await verifyTrade(row, evm({ status: '0x0', from: A }))).toBe('failed')
    expect(await verifyTrade(row, evm({ status: '0x1', from: B }))).toBe('mismatch')
    expect(await verifyTrade(row, evm(null))).toBeNull()
  })
  test('Solana: no error, and the wallet signed it', async () => {
    const s = parseTrade(trade({ chain: 'solana', address: SOLW, tx: sig(2) }), NOW) as SiteTradeRow
    const tx = (signer: string, err: unknown = null): ChainCall => async () => ({ meta: { err }, transaction: { message: { accountKeys: [{ pubkey: signer, signer: true }, { pubkey: 'x', signer: false }] } } })
    expect(await verifyTrade(s, tx(SOLW))).toBe('ok')
    expect(await verifyTrade(s, tx('someoneElse1111111111111111111111111111111'))).toBe('mismatch')
    expect(await verifyTrade(s, tx(SOLW, { InstructionError: [0, 'x'] }))).toBe('failed')
    expect(await verifyTrade(s, async () => null)).toBeNull()
  })
})

describe('the analytics service', () => {
  const make = (call: ChainCall, extra: Partial<ConstructorParameters<typeof Analytics>[0]> = {}) => {
    const store = new MemoryAnalyticsStore()
    return { store, an: new Analytics({ store, call, ...extra }) }
  }

  test('a wallet counts once, and one IP brings at most 30 new wallets an hour', () => {
    const { store, an } = make(async () => null)
    expect(an.signin({ address: A, kind: 'privy' }, 'ip1', NOW)).toEqual({ ok: true })
    expect(an.signin({ address: A, kind: 'privy' }, 'ip1', NOW + 1000)).toEqual({ ok: true })
    expect(store.users.size).toBe(1)
    for (let i = 0; i < ANALYTICS.newWalletsPerIpHour - 1; i++) an.signin({ address: '0x' + i.toString(16).padStart(40, '0'), kind: 'wallet' }, 'ip1', NOW)
    expect(an.signin({ address: B, kind: 'wallet' }, 'ip1', NOW)).toEqual({ error: 'too many new wallets from here' })
    expect(an.signin({ address: B, kind: 'wallet' }, 'ip2', NOW)).toEqual({ ok: true })
    expect(an.signin({ address: 'nope' }, 'ip3', NOW)).toEqual({ error: 'bad address' })
  })

  test('trades are stored once, then checked: counted, failed, or given up on', async () => {
    const receipts = new Map<string, unknown>([[tx(1), { status: '0x1', from: A }], [tx(2), { status: '0x0', from: A }]])
    const { store, an } = make(async (_c, _m, params) => receipts.get(String((params as string[])[0])) ?? null)
    expect(await an.trade(trade(), 'ip', NOW)).toMatchObject({ ok: true, new: true })
    expect(await an.trade(trade(), 'ip', NOW)).toMatchObject({ ok: true, new: false })
    await an.trade(trade({ tx: tx(2) }), 'ip', NOW)
    await an.trade(trade({ tx: tx(3) }), 'ip', NOW)
    await an.checkPending(NOW + 10_000)
    const st = (n: number) => store.trades.get(`arc:${tx(n)}`)!.status
    expect([st(1), st(2), st(3)]).toEqual(['ok', 'failed', 'pending'])
    // Not found for 20 minutes: no longer looked for.
    await an.checkPending(NOW + ANALYTICS.giveUpMs + 1)
    expect(st(3)).toBe('unverified')
  })

  test('fees: router trades from before the ledger count from the book, not the fee wallet’s own, fractions of a cent kept', async () => {
    const { an } = make(async () => null, {
      feeWallet: C.toUpperCase().replace('0X', '0x'),
      chainTrades: () => [
        { tx: tx(11), at: NOW - 20 * DAY, trader: B, usd: 1000, feeUsd: 10, side: 'buy', token: 'x' }, // before the ledger: counted
        { tx: tx(12), at: NOW - 19 * DAY, trader: C, usd: 300, feeUsd: 3, side: 'buy', token: 'x' }, // the fee wallet's own: not income
        { tx: tx(13), at: NOW - 1000, trader: B, usd: 0.5, feeUsd: 0.0025, side: 'buy', token: 'x' }, // the ledger has it: once
      ],
      fees: async () => [
        { at: NOW - 10 * DAY, status: 'received', amountUsd: 0.000002, source: 'arc-router' },
        { at: NOW - 1000, status: 'received', amountUsd: 0.0025, source: 'arc-curve' },
      ] as FeeRow[],
    })
    const r = await an.report(30, NOW)
    expect(r.fees.total).toBe(10.002502)
    expect(r.fees.d1).toBe(0.0025)
    expect(r.fees.bySource).toEqual({ 'arc-router': 10.000002, 'arc-curve': 0.0025 })
    // With no Arc rows in the ledger yet, every router trade's fee comes from the book.
    const { an: none } = make(async () => null, { chainTrades: () => [{ tx: tx(14), at: NOW - 1000, trader: B, usd: 1, feeUsd: 0.005, side: 'buy', token: 'x' }], fees: async () => [] })
    expect((await none.report(30, NOW)).fees.total).toBe(0.005)
  })

  test('the report counts checked trades, router trades read from the chain once, and the ledger’s fees', async () => {
    const { store, an } = make(async () => ({ status: '0x1', from: A }), {
      chainTrades: () => [
        { tx: tx(1).toUpperCase().replace('0X', '0x'), at: NOW - 1000, trader: A, usd: 25, feeUsd: 0.5, side: 'buy', token: 'x' }, // also sent by the site: once
        { tx: tx(9), at: NOW - 3 * DAY, trader: B, usd: 100, feeUsd: 2, side: 'sell', token: 'y' },
      ],
      fees: async () => [
        { at: NOW - 1000, status: 'received', amountUsd: 0.5, source: 'arc-router' },
        { at: NOW - 3 * DAY, status: 'accrued', amountUsd: 1.25, source: 'relay' },
        { at: NOW - 2000, status: 'claimed', amountUsd: -1, source: 'relay' },
        { at: NOW - 2000, status: 'rebate', amountUsd: 0.1, source: 'arc-referral' },
      ] as FeeRow[],
      traffic: async () => ({ online: 3, today: 40, total: 900, at: NOW }),
    })
    an.signin({ address: A, kind: 'privy' }, 'ip', NOW - 1000)
    an.signin({ address: SOLW, kind: 'solana' }, 'ip', NOW - 2 * DAY)
    await an.trade(trade({ at: NOW }), 'ip', NOW - 1000)
    await an.trade(trade({ chain: 'solana', address: SOLW, tx: sig(5), usd: 40 }), 'ip', NOW - 1000) // never checked: not counted
    await an.checkPending(NOW - 500)
    store.trades.get(`solana:${sig(5)}`)!.status = 'pending'

    const r = await an.report(30, NOW)
    expect(r.users.total).toBe(2)
    expect(r.users.byKind).toEqual({ privy: 1, solana: 1 })
    expect(r.trades.total).toBe(2)
    expect(r.trades.volume.total).toBe(125)
    expect(r.trades.d1).toBe(1)
    expect(r.traders).toMatchObject({ total: 2, d1: 1, d7: 2 })
    expect(r.trades.byChain).toEqual({ arc: { trades: 2, volumeUsd: 125 } })
    // The router trade from before the ledger's first Arc row (tx9) adds its fee from the trade book.
    expect(r.fees.total).toBe(3.75)
    expect(r.fees.d1).toBe(0.5)
    expect(r.fees.bySource).toEqual({ 'arc-router': 2.5, relay: 1.25 })
    expect(r.funnel).toEqual({ visitorsToday: 40, signedIn24h: 1, traded24h: 1 })
    expect(r.checks.pending).toBe(1)
    expect(r.daily).toHaveLength(31)
    expect(r.daily.at(-1)).toMatchObject({ trades: 1, volumeUsd: 25, feesUsd: 0.5, traders: 1 })
    expect(r.topTraders[0]).toMatchObject({ address: B, volumeUsd: 100 })

    // Everyone's page: the same totals, and no wallet or transaction anywhere in it.
    const p = await an.publicStats(30, NOW)
    expect(p.users.total).toBe(2)
    expect(p.trades.volume.total).toBe(125)
    expect(p.fees.total).toBe(3.75)
    expect(p.visitors).toEqual({ online: 3, today: 40, total: 900 })
    expect(p.latest[0]).toEqual({ chain: 'arc', venue: 'arc-router', side: 'buy', usd: 25, coin: expect.any(String), at: expect.any(Number) })
    const text = JSON.stringify(p).toLowerCase()
    for (const secret of [A, B, SOLW, tx(1), tx(9), sig(5)]) expect(text).not.toContain(secret.toLowerCase())
    expect('topTraders' in p || 'checks' in p || 'funnel' in p).toBe(false)
    // Worked out at most every 30 seconds.
    expect(await an.publicStats(30, NOW + 10_000)).toBe(p)
    expect(await an.publicStats(30, NOW + 31_000)).not.toBe(p)
  })
})
