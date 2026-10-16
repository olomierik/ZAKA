// Referral rebates in the fee ledger (engine/src/fees/referrals.ts): the routers' events become rebate rows (the trader,
// the whole fee, the share in force), the reader keeps up and never records a row twice, and the nightly reconciliation
// checks each rebate against the routers' own events, the transfer that paid it, the share of the fee, the referrer the
// router holds for that trader, and what the fee wallet got.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, pad, toEventSelector, toFunctionSelector, toHex } from 'viem'
import {
  DEFAULT_SHARE_BPS, REFERRAL_ROUTERS, REFERRER_OF, T_BOUND, T_PAID, T_SHARE, T_SWAPPED, ReferralWatcher, decodeRebates, learnShares, rateOk, rebateRows,
  reconcileReferrals, routerPayments, shareAt, type RouterLog,
} from '../src/fees/referrals'
import { FeeLedger, MemoryFeeLedgerStore, reconcileArc, arcFeeRows, ARC_FEE_SOURCE, type FeeRow } from '../src/fees/ledger'
import { PostgresBotStore } from '../src/bot/store'
import { setLogLevel } from '../src/log'

setLogLevel('error')
const USDC = '0x3600000000000000000000000000000000000000'
const LOGGER = '0xfffffffffffffffffffffffffffffffffffffffe'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const WALLET = '0x274262a0321a0701b0a46a3576e07ae881c286bb'
const SWAP = '0xd07583f7db671521aacfda2b4612ad187aa2924e'
const CURVE = '0xf8e8c8e2159e5bb8af91fd342bfe5b9db7a06441'
const COIN = '0x00000000000000000000000000000000000c0141'
const REF = '0x00000000000000000000000000000000000000f1'
const OTHER_REF = '0x00000000000000000000000000000000000000f2'
const TRADER = '0x00000000000000000000000000000000000000b1'
const TRADER2 = '0x00000000000000000000000000000000000000b2'
const p = (a: string) => pad(a as `0x${string}`)
let li = 0
const L = (address: string, topics: string[], data: `0x${string}`, tx: string, block: number): RouterLog =>
  ({ address, topics, data, transactionHash: tx, blockNumber: toHex(block), logIndex: toHex(li++) })
const u = (...v: bigint[]) => encodeAbiParameters(v.map(() => ({ type: 'uint256' })), v)

// What the routers emit, built from the same signatures the contracts declare.
const swapped = (router: string, trader: string, tokenIn: string, tokenOut: string, fee: bigint, tx: string, block: number) =>
  L(router, [T_SWAPPED, p(trader), p(tokenIn), p(tokenOut)], encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], [1_000_000n, 5n, USDC, fee]), tx, block)
const referralPaid = (router: string, ref: string, trader: string, amount: bigint, tx: string, block: number) => L(router, [T_PAID, p(ref), p(trader), p(USDC)], u(amount), tx, block)
const bound = (router: string, trader: string, ref: string, tx: string, block: number) => L(router, [T_BOUND, p(trader), p(ref)], '0x', tx, block)
const shareUpdated = (router: string, from: bigint, to: bigint, tx: string, block: number) => L(router, [T_SHARE], u(from, to), tx, block)
const xfer = (token: string, from: string, to: string, raw: bigint, tx: string, block: number) => L(token, [TRANSFER, p(from), p(to)], pad(toHex(raw)), tx, block)
/** An ERC-20 USDC transfer is logged by USDC (6 decimals) and by the native logger (18); a native send by the logger only. */
const usdcXfer = (from: string, to: string, raw6: bigint, tx: string, block: number) => [xfer(USDC, from, to, raw6, tx, block), xfer(LOGGER, from, to, raw6 * 10n ** 12n, tx, block)]
const nativeXfer = (from: string, to: string, raw18: bigint, tx: string, block: number) => [xfer(LOGGER, from, to, raw18, tx, block)]

/** A referred buy through the swap router: fee 2% of $1 (20,000 units), 15% of it (3,000) to the referrer. */
function swapTrade(tx: string, block: number, o: { fee?: bigint; cut?: bigint; ref?: string; trader?: string; paidTo?: string; bind?: boolean } = {}) {
  const fee = o.fee ?? 20_000n, cut = o.cut ?? (fee * 1500n) / 10_000n, ref = o.ref ?? REF, trader = o.trader ?? TRADER
  const events = [...(o.bind ? [bound(SWAP, trader, ref, tx, block)] : []), referralPaid(SWAP, ref, trader, cut, tx, block), swapped(SWAP, trader, USDC, COIN, fee, tx, block)]
  const transfers = [...usdcXfer(SWAP, o.paidTo ?? ref, cut, tx, block), ...usdcXfer(SWAP, WALLET, fee - cut, tx, block)]
  return { events, transfers, fee, cut }
}
const settings = () => { const m = new Map<string, string>(); return { m, getSetting: async (k: string) => m.get(k) ?? null, setSetting: async (k: string, v: string) => { m.set(k, v) } } }

describe('rebates from the routers’ events', () => {
  test('the event topics and referrerOf are the routers’ own, read from their Solidity sources', () => {
    for (const file of ['ArcDexSwapRouter.sol', 'ArcDexCurveRouter.sol']) {
      const src = readFileSync(new URL(`../../contracts/${file}`, import.meta.url), 'utf8')
      const sig = (name: string) => {
        const m = new RegExp(`event ${name}\\(([^)]*)\\)`, 's').exec(src)!
        return `${name}(${m[1].split(',').map(a => a.trim().split(/\s+/)[0]).join(',')})`
      }
      expect(toEventSelector(sig('ReferralPaid'))).toBe(T_PAID)
      expect(toEventSelector(sig('Swapped'))).toBe(T_SWAPPED)
      expect(toEventSelector(sig('ReferrerBound'))).toBe(T_BOUND)
      expect(toEventSelector(sig('ReferralShareUpdated'))).toBe(T_SHARE)
      expect(src).toMatch(/mapping\(address => address\) public referrerOf/)
      expect(src).toMatch(/referralShareBps = 1_500/)
    }
    expect(REFERRER_OF).toBe(toFunctionSelector('referrerOf(address)'))
    expect(Object.keys(REFERRAL_ROUTERS)).toEqual([SWAP, CURVE])
  })

  test('a referred trade: one rebate row with the trader, the whole fee and the share in force', () => {
    const t = swapTrade('0xaa01', 1000)
    const rebates = decodeRebates(t.events, {})
    expect(rebates).toHaveLength(1)
    expect(rebates[0]).toMatchObject({ router: SWAP, referrer: REF, trader: TRADER, token: USDC, amount: 3000n, fee: 20_000n, shareBps: 1500 })
    const [row] = rebateRows(rebates, () => 1_700_000_000_000)
    expect(row).toMatchObject({ id: expect.stringMatching(/^ref:0xaa01:\d+$/), chain: 'arc', source: 'arc-referral', status: 'rebate', amount: '0.003', amountUsd: 0.003, recipient: REF, trader: TRADER, tx: '0xaa01', block: 1000 })
    expect(row.meta).toMatchObject({ router: SWAP, fee: '20000', shareBps: 1500, decimals: 6 })
  })

  test('a trade with no referrer has no rebate', () => {
    expect(decodeRebates([swapped(SWAP, TRADER, USDC, COIN, 20_000n, '0xaa02', 1001)], {})).toEqual([])
  })

  test('the share in force: 15% from the constructor, then each ReferralShareUpdated from its own position on', () => {
    expect(shareAt({}, SWAP, 5, 0)).toBe(DEFAULT_SHARE_BPS)
    const h = learnShares({}, [shareUpdated(SWAP, 1500n, 2000n, '0xs1', 100)])
    const at = Number(BigInt(h[SWAP][0][1]))
    expect(shareAt(h, SWAP, 99, 0)).toBe(1500)
    expect(shareAt(h, SWAP, 100, at + 1)).toBe(2000)
    expect(shareAt(h, SWAP, 100, at)).toBe(1500)
    expect(shareAt(h, CURVE, 200, 0)).toBe(1500)
    expect(learnShares(h, [shareUpdated(SWAP, 1500n, 2000n, '0xs1', 100)].map(l => ({ ...l, logIndex: toHex(at) })))[SWAP]).toHaveLength(1)
  })

  test('payments out of the routers: an ERC-20 USDC transfer counted once, native USDC in 6 decimals', () => {
    const pay = routerPayments([...usdcXfer(SWAP, REF, 3000n, '0xp1', 1), ...nativeXfer(CURVE, REF, 4_000_000_000_000_123n, '0xp2', 2)])
    expect(pay.get(`0xp1:${SWAP}:${REF}:${USDC}`)).toBe(3000n)
    expect(pay.get(`0xp2:${CURVE}:${REF}:${USDC}`)).toBe(4000n)
  })

  test('the rate: exact on the swap router, within a unit on the curve router', () => {
    expect(rateOk({ router: SWAP, fee: 20_000n, amount: 3000n, shareBps: 1500 })).toBe(true)
    expect(rateOk({ router: SWAP, fee: 20_000n, amount: 3001n, shareBps: 1500 })).toBe(false)
    expect(rateOk({ router: CURVE, fee: 20_001n, amount: 2999n, shareBps: 1500 })).toBe(true)
    expect(rateOk({ router: CURVE, fee: 20_000n, amount: 3002n, shareBps: 1500 })).toBe(false)
    expect(rateOk({ router: SWAP, fee: null, amount: 3000n, shareBps: 1500 })).toBe(false)
  })
})

/** The ledger as the engine fills it: the fee wallet's receipts (fees/ledger.ts) and the rebates. */
function ledgerFor(trades: ReturnType<typeof swapTrade>[]) {
  const transfers = trades.flatMap(t => t.transfers)
  const events = trades.flatMap(t => t.events)
  const feeRows = arcFeeRows(transfers as never, WALLET, new Set(Object.keys(ARC_FEE_SOURCE)), () => 1, new Set())
  const rebates = rebateRows(decodeRebates(events, {}), () => 1)
  return { events, transfers, feeRows, rebates }
}
const feeWallet = (rows: FeeRow[]) => new Map(rows.map(r => [`${r.tx}:${r.id.split(':')[2]}`, BigInt(Math.round(Number(r.amount) * 1e6))]))
const bindings = (pairs: [string, string, string | null][]) => new Map(pairs.map(([r, t, ref]) => [`${r}:${t}`, ref]))

describe('the nightly reconciliation', () => {
  const base = () => ledgerFor([swapTrade('0xb001', 2000, { bind: true }), swapTrade('0xb002', 2001), swapTrade('0xb003', 2002, { trader: TRADER2, ref: OTHER_REF, bind: true })])
  const okBound = bindings([[SWAP, TRADER, REF], [SWAP, TRADER2, OTHER_REF]])
  const run = (o: Partial<Parameters<typeof reconcileReferrals>[0]> & { l?: ReturnType<typeof base> } = {}) => {
    const l = o.l ?? base()
    return reconcileReferrals({ rows: l.rebates, events: l.events, transfers: l.transfers, bound: okBound, feeWallet: feeWallet(l.feeRows), shares: {}, from: 2000, to: 2010, at: 1, ...o })
  }

  test('everything agrees: ok, totals to the unit, bindings counted', () => {
    const r = run()
    expect(r).toMatchObject({ source: 'referral', scope: 'blocks 2000-2010', ledger: '0.009', onchain: '0.009', diff: '0', ok: true })
    expect(r.detail).toMatchObject({ rebates: 3, events: 3, referrers: 2, bindings: 2, missing: [], extra: [], unpaid: [], wrongRate: [], wrongReferrer: [], feeWalletOff: [] })
  })

  test('a rebate the ledger missed', () => {
    const l = base(); l.rebates.pop()
    const r = run({ l })
    expect(r.ok).toBe(false)
    expect((r.detail.missing as string[])).toHaveLength(1)
  })

  test('a ledger row no event backs', () => {
    const l = base()
    l.rebates.push({ ...l.rebates[0], id: 'ref:0xdead:7', tx: '0xdead' })
    expect(run({ l }).detail.extra).toEqual(['ref:0xdead:7'])
  })

  test('a ledger amount that differs from the event', () => {
    const l = base(); l.rebates[0] = { ...l.rebates[0], amount: '0.0031' }
    const r = run({ l })
    expect(r.ok).toBe(false)
    expect(r.detail.wrongAmount).toEqual([l.rebates[0].id])
    expect(r.diff).toBe('0.0001')
  })

  test('an event with no payment to the referrer behind it', () => {
    const l = ledgerFor([swapTrade('0xc001', 2003, { paidTo: STR('0xee') })])
    const r = run({ l, bound: okBound })
    expect(r.detail.unpaid).toHaveLength(1)
    expect(r.ok).toBe(false)
  })

  test('a rebate over the share of the fee', () => {
    const l = ledgerFor([swapTrade('0xc002', 2004, { cut: 4000n })])
    expect(run({ l }).detail.wrongRate).toHaveLength(1)
  })

  test('the share changed on-chain: rebates at the new share pass, at the old one fail', () => {
    const change = shareUpdated(SWAP, 1500n, 2000n, '0xc0ff', 2004)
    const good = ledgerFor([swapTrade('0xc003', 2005, { cut: 4000n })])
    expect(run({ l: { ...good, events: [change, ...good.events] } }).ok).toBe(true)
    const old = ledgerFor([swapTrade('0xc004', 2005)])
    expect(run({ l: { ...old, events: [change, ...old.events] } }).detail.wrongRate).toHaveLength(1)
  })

  test('a referrer the router doesn’t hold for that trader', () => {
    const r = run({ bound: bindings([[SWAP, TRADER, OTHER_REF], [SWAP, TRADER2, OTHER_REF]]) })
    expect(r.ok).toBe(false)
    expect(r.detail.wrongReferrer).toHaveLength(2)
    expect(run({ bound: bindings([[SWAP, TRADER2, OTHER_REF]]) }).detail.wrongReferrer).toHaveLength(2)
  })

  test('the fee wallet short of the fee less the rebate', () => {
    const l = base()
    l.feeRows[0] = { ...l.feeRows[0], amount: '0.016' }
    expect(run({ l }).detail.feeWalletOff).toHaveLength(1)
  })

  test('the curve router: native USDC, a unit of rounding allowed', () => {
    const tx = '0xd001'
    // A fee of 20,006.999… units, in native USDC's 18 decimals: cut to 6, the fee is 20,006 and 15% of it 3,000.9, while
    // the share the router sends (cut from its own 18 decimals) is 3,001.05… → 3,001: one unit over, the rounding allowed.
    const fee18 = 20_006_999_999_999_999n, cut18 = (fee18 * 1500n) / 10_000n
    const events = [referralPaid(CURVE, REF, TRADER, cut18 / 10n ** 12n, tx, 2006), swapped(CURVE, TRADER, USDC, COIN, fee18 / 10n ** 12n, tx, 2006)]
    const transfers = [...nativeXfer(CURVE, REF, cut18, tx, 2006), ...nativeXfer(CURVE, WALLET, fee18 - cut18, tx, 2006)]
    const feeRows = arcFeeRows(transfers as never, WALLET, new Set(Object.keys(ARC_FEE_SOURCE)), () => 1, new Set())
    const rebates = rebateRows(decodeRebates(events, {}), () => 1)
    const r = run({ l: { events, transfers, feeRows, rebates }, bound: bindings([[CURVE, TRADER, REF]]) })
    expect(r.ok).toBe(true)
    expect(rebates[0].amount).toBe('0.003001')
    expect(rateOk({ router: SWAP, fee: 20_006n, amount: 3001n, shareBps: 1500 })).toBe(false)
  })

  test('rows outside the range are left for their own night', () => {
    const l = base()
    expect(run({ l, from: 3000, to: 3010, events: [], transfers: [] })).toMatchObject({ ok: true, ledger: '0', onchain: '0' })
  })

  test('the fee wallet’s own reconciliation ignores rebate rows', () => {
    const l = base()
    const receipts = new Map(l.feeRows.map(r => [r.id.split(':').slice(1).join(':'), { raw: BigInt(Math.round(Number(r.amount) * 1e6)) }]))
    expect(reconcileArc([...l.feeRows, ...l.rebates], receipts, 2000, 2010, 1).ok).toBe(true)
  })
})
function STR(s: string) { return `0x${s.slice(2).padStart(40, '0')}` }

describe('the reader', () => {
  function chain(all: RouterLog[], transfers: RouterLog[], head: number, opts: { cap?: number } = {}) {
    const calls: { kind: string; from: number; to: number }[] = []
    return {
      calls,
      scan: async (f: { address?: string[]; topics: (string | string[] | null)[] }, from: number, to: number) => {
        const kind = f.address ? 'events' : 'transfers'
        calls.push({ kind, from, to })
        const end = opts.cap ? Math.min(to, from + opts.cap - 1) : to
        const src = f.address ? all : transfers
        return { logs: src.filter(l => { const b = Number(BigInt(l.blockNumber)); return b >= from && b <= end }), scannedTo: end }
      },
      head: async () => head,
    }
  }

  test('reads to 50 blocks behind the head, records each rebate once, resumes where it stopped, then reconciles', async () => {
    const t1 = swapTrade('0xe001', 100, { bind: true }), t2 = swapTrade('0xe002', 140)
    const c = chain([...t1.events, ...t2.events], [...t1.transfers, ...t2.transfers], 300, { cap: 120 })
    const store = new MemoryFeeLedgerStore()
    const ledger = new FeeLedger(store)
    const s = settings()
    const alerts: string[] = []
    const w = new ReferralWatcher({
      ledger, settings: s, scan: c.scan, head: c.head, from: 50, runAfterMinute: 40,
      times: async bs => new Map(bs.map(b => [b, b * 1000])),
      referrerOf: async pairs => pairs.map(() => REF), alert: a => alerts.push(a),
    })
    const night = Date.UTC(2026, 9, 16, 1, 0)
    await w.tick(Date.UTC(2026, 9, 16, 0, 10))
    expect(await w.scannedTo()).toBe(169)
    expect((await store.allFees('arc-referral')).map(r => r.tx)).toEqual(['0xe001', '0xe002'])
    expect((await store.allFees('arc-referral'))[0].at).toBe(100_000)
    await w.tick(Date.UTC(2026, 9, 16, 0, 20))
    expect(await w.scannedTo()).toBe(250)
    expect(await store.allFees('arc-referral')).toHaveLength(2)
    expect(await store.recons(5)).toHaveLength(0)
    await w.tick(night)
    const [rec] = await store.recons(5)
    expect(rec).toMatchObject({ source: 'referral', scope: 'blocks 50-250', ok: true, ledger: '0.006' })
    expect(alerts).toEqual([])
    // Once a day.
    await w.tick(night + 60_000)
    expect(await store.recons(5)).toHaveLength(1)
    // A restart picks up where it stopped.
    const w2 = new ReferralWatcher({ ledger, settings: s, scan: c.scan, head: c.head, from: 50, times: async () => new Map(), referrerOf: async p => p.map(() => REF) })
    expect(await w2.scannedTo()).toBe(250)
  })

  test('a share change read on an earlier night still prices later rebates', async () => {
    const change = shareUpdated(SWAP, 1500n, 2000n, '0xe0c0', 60)
    const later = swapTrade('0xe0c1', 400, { cut: 4000n })
    const events = [change, ...later.events], transfers = later.transfers
    let head = 200
    const c = { scan: async (f: { address?: string[] }, from: number, to: number) => ({ logs: (f.address ? events : transfers).filter(l => { const b = Number(BigInt(l.blockNumber)); return b >= from && b <= to }), scannedTo: to }) }
    const store = new MemoryFeeLedgerStore()
    const w = new ReferralWatcher({ ledger: new FeeLedger(store), settings: settings(), scan: c.scan, head: async () => head, from: 50, times: async bs => new Map(bs.map(b => [b, 1])), referrerOf: async pairs => pairs.map(() => REF) })
    await w.tick(Date.UTC(2026, 9, 16, 1, 0))
    head = 500
    await w.tick(Date.UTC(2026, 9, 17, 1, 0))
    const recs = await store.recons(5)
    expect(recs.map(r => [r.scope, r.ok])).toEqual([['blocks 151-450', true], ['blocks 50-150', true]])
    expect((await store.allFees('arc-referral'))[0].meta?.shareBps).toBe(2000)
  })

  test('a mismatch is alerted and kept', async () => {
    const t = swapTrade('0xf001', 100)
    const c = chain(t.events, t.transfers, 200)
    const store = new MemoryFeeLedgerStore()
    const mismatches: string[] = []
    const ledger = new FeeLedger(store, r => mismatches.push(r.scope))
    const alerts: string[] = []
    const w = new ReferralWatcher({
      ledger, settings: settings(), scan: c.scan, head: c.head, from: 50,
      times: async bs => new Map(bs.map(b => [b, 1])), referrerOf: async pairs => pairs.map(() => OTHER_REF), alert: a => alerts.push(a),
    })
    await w.tick(Date.UTC(2026, 9, 16, 0, 5))
    const r = await w.reconcile(Date.UTC(2026, 9, 16, 2, 0))
    expect(r?.ok).toBe(false)
    expect(r?.detail.wrongReferrer).toHaveLength(1)
    expect(mismatches).toEqual(['blocks 50-150'])
    expect(alerts[0]).toContain('referral rebates blocks 50-150')
  })

  test('the summary counts rebates apart from income', async () => {
    const l = ledgerFor([swapTrade('0xa101', 10), swapTrade('0xa102', 11, { trader: TRADER2, ref: OTHER_REF })])
    const ledger = new FeeLedger(new MemoryFeeLedgerStore())
    await ledger.record([...l.feeRows, ...l.rebates])
    const s = await ledger.summary()
    expect(s.rebates).toEqual({ usdc: '0.006', usd: 0.01, rows: 2, referrers: 2 })
    expect(s.bySource['arc-referral']).toBeUndefined()
    expect(s.bySource['arc-router']).toEqual({ usd: 0.03, rows: 2 })
  })
})

const PG = process.env.PG_TEST_URL
describe.skipIf(!PG)('rebate rows in Postgres', () => {
  test('the trader and the evidence are kept; rows are still never changed', async () => {
    const store = new PostgresBotStore(PG!)
    const tx = `0x${Date.now().toString(16)}`
    const [row] = rebateRows(decodeRebates(swapTrade(tx, 900).events, {}), () => Date.now())
    expect(await store.appendFees([row])).toBe(1)
    expect(await store.appendFees([row])).toBe(0)
    const back = (await store.allFees('arc-referral')).find(r => r.id === row.id)
    expect(back).toMatchObject({ amount: '0.003', recipient: REF, trader: TRADER, status: 'rebate', meta: { router: SWAP, fee: '20000', shareBps: 1500 } })
    const { SQL } = await import('bun')
    const sql = new SQL(PG!)
    const err = await sql`update arcdex_fee_ledger set amount = 1 where id = ${row.id}`.then(() => 'ran', (e: Error) => e.message)
    expect(err).toContain('append-only')
  })
})
