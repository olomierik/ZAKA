// The fee ledger (engine/src/fees): exact amounts, Arc fees read from the fee wallet's logs (each transfer once, the
// wallet's own trades left out), Relay's accruals and claims, Jupiter's referral token accounts, the nightly
// reconciliation (equal, short, extra, held balances), and the append-only table in Postgres.
import { describe, expect, test } from 'bun:test'
import { pad, toHex } from 'viem'
import {
  arcFeeReceipts, arcFeeRows, fromRaw, toRaw, sumAmounts, relayRows, reconcileArc, reconcileBalance, FeeLedger, MemoryFeeLedgerStore,
  ARC_FEE_SOURCE, type FeeRow,
} from '../src/fees/ledger'
import { FeeLedgerService } from '../src/fees/service'
import { JupiterFeeWatcher, balanceChange } from '../src/fees/jupiterWatch'
import { PostgresBotStore } from '../src/bot/store'
import { setLogLevel } from '../src/log'

setLogLevel('error')
const USDC = '0x3600000000000000000000000000000000000000'
const LOGGER = '0xfffffffffffffffffffffffffffffffffffffffe'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const WALLET = '0x274262a0321a0701b0a46a3576e07ae881c286bb'
const ROUTER = '0xd07583f7db671521aacfda2b4612ad187aa2924e'
const CURVE = '0xf8e8c8e2159e5bb8af91fd342bfe5b9db7a06441'
const STRANGER = '0x00000000000000000000000000000000000000aa'
const SOURCES = new Set(Object.keys(ARC_FEE_SOURCE))
let li = 0
const log = (token: string, from: string, to: string, raw: bigint, tx: string, block: number) => ({
  address: token, topics: [TRANSFER, pad(from as `0x${string}`), pad(to as `0x${string}`)], data: pad(toHex(raw)), transactionHash: tx, blockNumber: toHex(block), logIndex: toHex(li++),
})
/** An ERC-20 USDC transfer as Arc logs it: by the token (6 decimals) and the native logger (18). */
const usdc = (from: string, to: string, raw6: bigint, tx: string, block: number) => [log(USDC, from, to, raw6, tx, block), log(LOGGER, from, to, raw6 * 10n ** 12n, tx, block)]
/** A native USDC send: the logger alone. */
const native = (from: string, to: string, raw6: bigint, tx: string, block: number) => [log(LOGGER, from, to, raw6 * 10n ** 12n, tx, block)]
const settings = () => { const m = new Map<string, string>(); return { m, getSetting: async (k: string) => m.get(k) ?? null, setSetting: async (k: string, v: string) => { m.set(k, v) } } }

describe('exact amounts', () => {
  test('raw units to decimals and back, without floating point', () => {
    expect(fromRaw(1_234_567n, 6)).toBe('1.234567')
    expect(fromRaw(5_000_000n, 6)).toBe('5')
    expect(fromRaw(-1n, 6)).toBe('-0.000001')
    expect(fromRaw(0n, 6)).toBe('0')
    expect(toRaw('1.234567', 6)).toBe(1_234_567n)
    expect(toRaw('-0.000001', 6)).toBe(-1n)
    expect(toRaw('2.9999999', 6)).toBe(2_999_999n) // extra digits cut, never rounded up
    expect(sumAmounts(['0.1', '0.2', '0.000001'], 6)).toBe('0.300001') // 0.1 + 0.2 is exact here
  })
})

describe('Arc fees from the fee wallet\'s logs', () => {
  test('an ERC-20 transfer counts once, a native one counts, strangers and other recipients don\'t', () => {
    const logs = [
      ...usdc(ROUTER, WALLET, 50_000n, '0xa1', 100),          // $0.05 from the swap router (logged twice)
      ...native(CURVE, WALLET, 120_000n, '0xa2', 101),        // $0.12 from the curve router, natively
      ...usdc(STRANGER, WALLET, 9_000_000n, '0xa3', 102),     // a person's transfer: not a fee
      ...usdc(ROUTER, STRANGER, 1_000_000n, '0xa4', 103),     // the router paying someone else
    ]
    const r = arcFeeReceipts(logs, WALLET, SOURCES)
    expect([...r.values()].map(x => [x.tx, x.payer, x.raw])).toEqual([['0xa1', ROUTER, 50_000n], ['0xa2', CURVE, 120_000n]])
  })
  test('rows: one per transaction and payer, named by the contract, the wallet\'s own transactions left out', () => {
    const logs = [...usdc(ROUTER, WALLET, 50_000n, '0xb1', 200), ...usdc(ROUTER, WALLET, 70_000n, '0xb2', 201)]
    const rows = arcFeeRows(logs, WALLET, SOURCES, b => 1_790_000_000_000 + b, new Set(['0xb2']))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: `arc:0xb1:${ROUTER}`, source: 'arc-router', amount: '0.05', amountUsd: 0.05, block: 200, status: 'received', recipient: WALLET, at: 1_790_000_000_200 })
  })
})

describe('Relay\'s balance for the fee wallet', () => {
  test('first read: opening; then growth accrued, a drop claimed, no change nothing', () => {
    const at = 1_790_000_000_000
    const open = relayRows(null, [{ key: '792703809:usdc', symbol: 'USDC', amount: 3, usd: 3 }], at, WALLET)
    expect(open).toMatchObject([{ status: 'opening', amount: '3', amountUsd: 3, source: 'relay' }])
    const grew = relayRows({ '792703809:usdc': 3 }, [{ key: '792703809:usdc', symbol: 'USDC', amount: 3.25, usd: 3.25 }], at + 1, WALLET)
    expect(grew).toMatchObject([{ status: 'accrued', amount: '0.25', amountUsd: 0.25 }])
    const claimed = relayRows({ '792703809:usdc': 3.25 }, [], at + 2, WALLET)
    expect(claimed).toMatchObject([{ status: 'claimed', amount: '-3.25' }])
    expect(relayRows({ x: 1 }, [{ key: 'x', symbol: 'X', amount: 1, usd: 1 }], at, WALLET)).toEqual([])
  })
})

describe('reconciliation', () => {
  const rows = (logs: ReturnType<typeof usdc>) => arcFeeRows(logs, WALLET, SOURCES, () => 0, new Set())
  test('Arc: the ledger equal to an independent scan, to the unit', () => {
    const logs = [...usdc(ROUTER, WALLET, 50_000n, '0xc1', 300), ...native(CURVE, WALLET, 1n, '0xc2', 301)]
    const r = reconcileArc(rows(logs), arcFeeReceipts(logs, WALLET, SOURCES), 300, 301, 0)
    expect(r).toMatchObject({ ok: true, ledger: '0.050001', onchain: '0.050001', diff: '0' })
  })
  test('Arc: a fee on-chain the ledger missed, one it has that isn\'t on-chain, and one unit off are mismatches', () => {
    const logs = [...usdc(ROUTER, WALLET, 50_000n, '0xd1', 400), ...usdc(ROUTER, WALLET, 20_000n, '0xd2', 401)]
    const onchain = arcFeeReceipts(logs, WALLET, SOURCES)
    const missed = reconcileArc(rows(logs).slice(0, 1), onchain, 400, 401, 0)
    expect(missed).toMatchObject({ ok: false, diff: '-0.02' })
    expect((missed.detail.missing as string[])).toEqual([`0xd2:${ROUTER}`])
    const extra = reconcileArc([...rows(logs), { ...rows(logs)[0], id: `arc:0xd9:${ROUTER}` }], onchain, 400, 401, 0)
    expect(extra.ok).toBe(false)
    const off = rows(logs).map((r, i) => (i ? r : { ...r, amount: '0.050001' }))
    expect(reconcileArc(off, onchain, 400, 401, 0)).toMatchObject({ ok: false, diff: '0.000001' })
    // Rows outside the range aren't compared.
    expect(reconcileArc(rows(logs), arcFeeReceipts(logs.filter(l => l.blockNumber === toHex(400)), WALLET, SOURCES), 400, 400, 0).ok).toBe(true)
  })
  test('held balances: opening + received − claimed against the balance (Relay to the millionth)', () => {
    const r = (status: FeeRow['status'], amount: string, source: 'relay' | 'jupiter' = 'relay'): FeeRow => ({ id: `${status}${amount}`, at: 0, chain: 'solana', source, token: 'k', symbol: 'K', amount, amountUsd: null, recipient: 'r', tx: null, block: null, status })
    const ledger = [r('opening', '3'), r('accrued', '0.25'), r('claimed', '-1')]
    expect(reconcileBalance('relay', ledger, 'k', '2.25', 9, 0, 1_000n).ok).toBe(true)
    expect(reconcileBalance('relay', ledger, 'k', '2.2500004', 9, 0, 1_000n).ok).toBe(true)
    expect(reconcileBalance('relay', ledger, 'k', '2.26', 9, 0, 1_000n)).toMatchObject({ ok: false, diff: '-0.01' })
    expect(reconcileBalance('jupiter', [r('opening', '0.5', 'jupiter'), r('received', '0.001', 'jupiter')], 'k', '0.501', 9, 0).ok).toBe(true)
  })
})

describe('the ledger', () => {
  test('a row seen again is written once', async () => {
    const store = new MemoryFeeLedgerStore()
    const l = new FeeLedger(store)
    const rows = arcFeeRows(usdc(ROUTER, WALLET, 10_000n, '0xe1', 500), WALLET, SOURCES, () => 0, new Set())
    expect(await l.record(rows)).toBe(1)
    expect(await l.record(rows)).toBe(0)
    expect((await store.allFees()).length).toBe(1)
    const s = await l.summary()
    expect(s.bySource['arc-router']).toEqual({ usd: 0.01, rows: 1 })
  })
})

describe('the nightly reconciliation', () => {
  const opts = (store: MemoryFeeLedgerStore, chainLogs: ReturnType<typeof usdc>, scanned: { to: number }, alerts: string[]) => ({
    ledger: new FeeLedger(store), settings: settings(), wallet: WALLET, sources: [...SOURCES],
    scanArc: async (from: number, to: number) => chainLogs.filter(l => { const n = Number(BigInt(l.blockNumber)); return n >= from && n <= to }),
    ownTxs: async () => new Set<string>(),
    arcScannedTo: () => scanned.to,
    relayBalances: async () => [{ key: 'usdc', symbol: 'USDC', amount: 1.5, usd: 1.5 }],
    alert: (t: string) => alerts.push(t),
    runAfterMinute: 30,
  })
  test('starts after the block the program had reached, runs once a day after 00:30 UTC, and agrees', async () => {
    const store = new MemoryFeeLedgerStore()
    const before = [...usdc(ROUTER, WALLET, 9_000_000n, '0xf0', 900)] // fees from before the ledger existed
    const after = [...usdc(ROUTER, WALLET, 50_000n, '0xf1', 1_100), ...usdc(CURVE, WALLET, 30_000n, '0xf2', 1_150)]
    const scanned = { to: 1_000 }
    const alerts: string[] = []
    const svc = new FeeLedgerService(opts(store, [...before, ...after], scanned, alerts))
    await svc.begin() // the ledger's Arc rows start after block 1,000
    await svc.onArcLogs(after, () => 0, new Set())
    await svc.onRelayBalances([{ key: 'usdc', symbol: 'USDC', amount: 1, usd: 1 }], 1)
    await svc.onRelayBalances([{ key: 'usdc', symbol: 'USDC', amount: 1.5, usd: 1.5 }], 2)
    scanned.to = 1_300
    expect(await svc.tick(Date.UTC(2026, 9, 16, 0, 10))).toBeUndefined() // before 00:30: nothing
    expect((await store.recons(10)).length).toBe(0)
    await svc.tick(Date.UTC(2026, 9, 16, 0, 40))
    const rec = await store.recons(10)
    expect(rec.map(r => [r.source, r.scope, r.ok])).toEqual([['relay', 'balance usdc', true], ['arc', 'blocks 1001-1250', true]])
    expect(rec.find(r => r.source === 'arc')).toMatchObject({ ledger: '0.08', onchain: '0.08' })
    expect(alerts).toEqual([])
    await svc.tick(Date.UTC(2026, 9, 16, 5, 0)) // the same day: not again
    expect((await store.recons(10)).length).toBe(2)
  })
  test('a fee the ledger didn\'t record is a mismatch, and alerts', async () => {
    const store = new MemoryFeeLedgerStore()
    const logs = [...usdc(ROUTER, WALLET, 50_000n, '0xf3', 2_100), ...usdc(ROUTER, WALLET, 20_000n, '0xf4', 2_110)]
    const scanned = { to: 2_000 }
    const alerts: string[] = []
    const svc = new FeeLedgerService(opts(store, logs, scanned, alerts))
    await svc.begin()
    await svc.onArcLogs(logs.slice(0, 2), () => 0, new Set()) // the second fee's rows never written (say, the database was down)
    await svc.onRelayBalances([{ key: 'usdc', symbol: 'USDC', amount: 1.5, usd: 1.5 }], 1)
    scanned.to = 2_300
    const out = await svc.reconcile(Date.UTC(2026, 9, 16, 1))
    expect(out.find(r => r.source === 'arc')).toMatchObject({ ok: false, ledger: '0.05', onchain: '0.07', diff: '-0.02' })
    expect(alerts.length).toBe(1)
    expect(alerts[0]).toMatch(/mismatch: arc blocks 2001-2250/)
  })
})

describe('Jupiter\'s referral token accounts', () => {
  const REF = 'HLLmfX1M39GuG5dZf4QEPknFZKtV1cWEwXR55PoyHPir'
  const ACCT = 'EdYArNZD8aHN4tS34hU1WpgzyvfR13vJZhxSkWdLFkHQ'
  const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const tx = (sig: string, pre: string, post: string, err: unknown = null) => ({
    blockTime: 1_790_000_100, slot: 300_000_000, meta: { err, preTokenBalances: [{ accountIndex: 2, mint: MINT, uiTokenAmount: { amount: pre, decimals: 6 } }], postTokenBalances: [{ accountIndex: 2, mint: MINT, uiTokenAmount: { amount: post, decimals: 6 } }] },
    transaction: { message: { accountKeys: [{ pubkey: 'payer' }, { pubkey: 'x' }, { pubkey: ACCT }] }, signatures: [sig] },
  })
  test('the balance it starts with is opening; later fees received, claims claimed, failed transactions skipped', async () => {
    let balance = '1500000'
    let sigs: { signature: string; err: unknown }[] = [{ signature: 's0', err: null }]
    const txs: Record<string, unknown> = { s1: tx('s1', '1500000', '1505000'), s2: tx('s2', '1505000', '1505000', { InstructionError: [0, 'x'] }), s3: tx('s3', '1505000', '0') }
    const call = async <T>(method: string, params: unknown[]): Promise<T> => {
      if (method === 'getTokenAccountsByOwner') {
        const program = (params[1] as { programId: string }).programId
        return { value: program.startsWith('Tokenkeg') ? [{ pubkey: ACCT, account: { data: { parsed: { info: { mint: MINT, tokenAmount: { amount: balance, decimals: 6 } } } } } }] : [] } as T
      }
      if (method === 'getSignaturesForAddress') {
        const until = (params[1] as { until?: string; limit: number }).until
        const list = until ? sigs.slice(0, sigs.findIndex(s => s.signature === until)) : sigs.slice(0, (params[1] as { limit: number }).limit)
        return list as T
      }
      if (method === 'getTransaction') return (txs[params[0] as string] ?? null) as T
      throw new Error(method)
    }
    const store = new MemoryFeeLedgerStore()
    const ledger = new FeeLedger(store)
    const w = new JupiterFeeWatcher({ referral: REF, call, ledger, settings: settings() })
    await w.tick(1_790_000_000_000)
    expect(await store.allFees()).toMatchObject([{ id: `jupiter:opening:${ACCT}`, status: 'opening', amount: '1.5', amountUsd: 1.5 }])
    // Newest first, as Solana answers: a fee, a failed transaction, a claim of everything.
    sigs = [{ signature: 's3', err: null }, { signature: 's2', err: { x: 1 } }, { signature: 's1', err: null }, ...sigs]
    balance = '0'
    await w.tick()
    const rows = (await store.allFees()).filter(r => r.status !== 'opening').sort((a, b) => a.id.localeCompare(b.id))
    expect(rows.map(r => [r.tx, r.status, r.amount])).toEqual([['s1', 'received', '0.005'], ['s3', 'claimed', '-1.505']])
    await w.tick() // nothing new: nothing added
    expect((await store.allFees()).length).toBe(3)
    // opening 1.5 + 0.005 − 1.505 = 0, the balance now.
    expect(reconcileBalance('jupiter', await store.allFees(), MINT, '0', 6, 0).ok).toBe(true)
  })
  test('what a transaction changed an account by: zero when it isn\'t in it or failed', () => {
    expect(balanceChange(tx('a', '0', '10') as never, ACCT)).toBe(10n)
    expect(balanceChange(tx('a', '0', '10') as never, 'nobody')).toBe(0n)
    expect(balanceChange(tx('a', '0', '10', { e: 1 }) as never, ACCT)).toBe(0n)
  })
})

// The tables against a real Postgres: PG_TEST_URL=postgres://… (skipped otherwise; use a scratch database).
const PG = process.env.PG_TEST_URL
describe.skipIf(!PG)('the fee ledger in Postgres', () => {
  test('rows are added once and read back exactly; updates, deletes and truncates are refused', async () => {
    const store = new PostgresBotStore(PG!)
    const rows = arcFeeRows(usdc(ROUTER, WALLET, 123_456n, `0x${Date.now().toString(16)}`, 700), WALLET, SOURCES, () => Date.now(), new Set())
    expect(await store.appendFees(rows)).toBe(1)
    expect(await store.appendFees(rows)).toBe(0)
    const back = (await store.feeRows({ limit: 5, source: 'arc-router' })).find(r => r.id === rows[0].id)
    expect(back).toMatchObject({ amount: '0.123456', block: 700, status: 'received' })
    await store.appendRecon({ at: Date.now(), source: 'arc', scope: 'blocks 1-2', ledger: '0.1', onchain: '0.1', diff: '0', ok: true, detail: {} })
    const { SQL } = await import('bun')
    const sql = new SQL(PG!)
    const refused = (q: PromiseLike<unknown>) => Promise.resolve(q).then(() => 'ran', (e: Error) => e.message)
    expect(await refused(sql`update arcdex_fee_ledger set amount = 0`)).toMatch(/append-only/)
    expect(await refused(sql`delete from arcdex_fee_ledger`)).toMatch(/append-only/)
    expect(await refused(sql`truncate arcdex_fee_ledger`)).toMatch(/append-only/)
    expect(await refused(sql`delete from arcdex_fee_reconciliations`)).toMatch(/append-only/)
    await sql.close()
  })
})
