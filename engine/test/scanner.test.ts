// The safety report (intel/scanner.ts assess) and the pure pieces it reads:
// trading flow (flow.ts), holders from transfers (holders.ts) and funding
// clusters (clusters.ts).
import { describe, expect, test } from 'bun:test'
import type { LaunchInfo } from '../../api/_marketProtocol'
import { analyzeCode } from '../src/intel/bytecode'
import { clustersOf, firstFunders, firstFunding, groupFunders, resolveFunders } from '../src/intel/clusters'
import { computeFlow, type TapeTrade } from '../src/intel/flow'
import { holdersFromLogs } from '../src/intel/holders'
import { assess, type ScanInput, type StaticFacts } from '../src/intel/scanner'

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const T = (o: Partial<TapeTrade>): TapeTrade => ({ block: 100, ts: 0, wallet: A(1), side: 'BUY', usd: 10, tokens: 1_000, price: 0.01, ...o })
const LAUNCH = 100

describe('flow', () => {
  test('buyers, sellers, sellers besides the creator', () => {
    const f = computeFlow([T({ wallet: A(1) }), T({ wallet: A(2) }), T({ wallet: A(2), side: 'SELL', block: 110, ts: 3_600_000 }), T({ wallet: A(9), side: 'SELL', block: 120 })], { launchBlock: LAUNCH, creator: A(9), supply: 1e6 })
    expect(f.buyers).toBe(2)
    expect(f.sellers).toBe(2)
    expect(f.outsideSellers).toBe(1) // A(2) bought and sold; the creator's sale doesn't count
  })
  test('bundle: buys in the launch block and the two after', () => {
    const f = computeFlow([T({ wallet: A(1), block: 100, tokens: 100_000 }), T({ wallet: A(2), block: 102, tokens: 100_000 }), T({ wallet: A(3), block: 103, tokens: 100_000 })], { launchBlock: LAUNCH, creator: null, supply: 1e6 })
    expect(f.bundle.wallets).toBe(2)
    expect(f.bundle.supplyPct).toBe(20)
  })
  test('creator: bought at launch, sold most of it', () => {
    const f = computeFlow([T({ wallet: A(9), block: 100, tokens: 1_000 }), T({ wallet: A(9), side: 'SELL', block: 150, tokens: 800 })], { launchBlock: LAUNCH, creator: A(9), supply: 1e6 })
    expect(f.creator.boughtAtLaunch).toBe(true)
    expect(f.creator.soldTokensPct).toBe(80)
  })
  test('wash: round trips by a few wallets', () => {
    const rt = [1, 2].flatMap(w => [0, 1, 2].flatMap(k => [T({ wallet: A(w), ts: k * 60_000, usd: 100 }), T({ wallet: A(w), side: 'SELL', ts: k * 60_000 + 30_000, usd: 100 })]))
    const f = computeFlow([...rt, T({ wallet: A(3), usd: 10 })], { launchBlock: LAUNCH, creator: null, supply: 1e6 })
    expect(f.roundTripVolumePct).toBeGreaterThan(95)
    expect(f.top3VolumePct).toBe(100)
  })
  test('price path: peak multiple and the fall from it', () => {
    const f = computeFlow([T({ price: 1 }), T({ price: 12, block: 101 }), T({ price: 4, block: 102 })], { launchBlock: LAUNCH, creator: null, supply: 1e6 })
    expect(f.peakMultiple).toBe(12)
    expect(f.drawdownFromPeak).toBeCloseTo(2 / 3, 6)
  })
})

describe('holders', () => {
  const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const topic = (a: string) => '0x' + a.slice(2).padStart(64, '0')
  const tx = (from: string, to: string, v: bigint) => ({ topics: [TRANSFER, topic(from), topic(to)], data: '0x' + v.toString(16).padStart(64, '0') })
  const E18 = 10n ** 18n
  test('balances from transfers, pool and burns excluded', () => {
    const POOL = A(500), ZERO = A(0)
    const h = holdersFromLogs([tx(ZERO, POOL, 1_000_000n * E18), tx(POOL, A(1), 100_000n * E18), tx(POOL, A(2), 50_000n * E18), tx(A(2), A(0xdead), 10_000n * E18)], 1_000_000, 18, { exclude: new Set([POOL]), creator: A(2) })
    expect(h.holders).toBe(2)
    expect(h.top10Pct).toBeCloseTo(14, 6)
    expect(h.creatorPct).toBeCloseTo(4, 6)
    expect(h.top[0]).toEqual({ address: A(1), pct: 10 })
  })
})

describe('clusters', () => {
  const log = (from: string, block: number, tx = '0xt' + block) => ({ topics: ['0x', '0x' + from.slice(2).padStart(64, '0')], blockNumber: '0x' + block.toString(16), logIndex: '0x0', transactionHash: tx })
  test('the first sender funded each wallet', () => {
    const f = firstFunders(new Map([[A(1), [log(A(70), 20), log(A(71), 10)]], [A(2), []]]))
    expect(f.get(A(1))).toBe(A(71))
    expect(f.get(A(2))).toBeNull()
  })
  test('a payment from a contract names who sent that transaction', () => {
    const POOL_MANAGER = A(50), DISPERSE = A(51)
    const first = firstFunding(new Map([
      [A(1), [log(POOL_MANAGER, 10, '0xs1')]], // sold something: its own transaction
      [A(2), [log(DISPERSE, 11, '0xd')]], [A(3), [log(DISPERSE, 11, '0xd')]], // one person, through a disperse contract
      [A(4), [log(A(70), 12)]], // a person paid it directly
      [A(5), [log(POOL_MANAGER, 13, '0xlost')]], // the transaction couldn't be read
    ]))
    const f = resolveFunders(first, new Set([POOL_MANAGER, DISPERSE]), new Map([['0xs1', A(1)], ['0xd', A(99)]]))
    expect(f.get(A(1))).toBe(A(0)) // says nothing, like a bridge mint
    expect(f.get(A(2))).toBe(A(99))
    expect(f.get(A(3))).toBe(A(99))
    expect(f.get(A(4))).toBe(A(70))
    expect(f.get(A(5))).toBeNull()
  })
  test('sellers paid by the PoolManager are not a cluster', () => {
    const PM = A(50)
    const first = firstFunding(new Map([1, 2, 3, 4].map(i => [A(i), [log(PM, 10 + i, '0xs' + i)]])))
    const f = resolveFunders(first, new Set([PM]), new Map([1, 2, 3, 4].map(i => ['0xs' + i, A(i)])))
    expect(groupFunders(f, null, null, new Set()).groups).toEqual([])
  })
  test('three wallets from one source are a cluster; a hub or a bridge mint is not', () => {
    const funders = new Map([[A(1), A(70)], [A(2), A(70)], [A(3), A(70)], [A(4), A(80)], [A(5), A(80)], [A(6), A(80)], [A(7), A(0)], [A(8), A(0)], [A(9), A(0)]])
    const c = groupFunders(funders, null, null, new Set([A(80)]))
    expect(c.groups).toEqual([{ funder: A(70), wallets: [A(1), A(2), A(3)] }])
  })
  test('wallets funded by the creator, or from the creator\'s own source', () => {
    const c = groupFunders(new Map([[A(1), A(99)], [A(2), A(99)], [A(3), A(60)], [A(4), A(60)]]), A(99), A(60), new Set())
    expect(c.creatorFunded).toEqual([A(1), A(2)])
    expect(c.sameSourceAsCreator).toEqual([A(3), A(4)])
  })
})

describe('clusters over the chain (stubbed)', () => {
  // Seen 2026-09-30: a funder that paid 482 wallets in the window got no
  // answer over the whole window from the endpoint asked, and counting only
  // the last 10k blocks found none (it paid these buyers hours earlier), so a
  // clean coin was blocked as a cluster. Now the window is counted in slices.
  const BLOCK = 200_000, F = A(0xf00d)
  const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0')
  const buyers = [A(1), A(2), A(3), A(4)]
  const rpc = (o: { wholeWindow: boolean; paidInSlices: number; failSlice?: boolean }) => ({
    async call<T>(): Promise<T> { throw new Error('unused') },
    async batch<T>(calls: { method: string; params: unknown[] }[]): Promise<(T | null)[]> {
      return calls.map(c => {
        if (c.method === 'eth_getCode') return '0x' as T // the funder is a person
        const q = c.params[0] as { topics: (string | null)[]; fromBlock: string; toBlock: string }
        const from = parseInt(q.fromBlock, 16), to = parseInt(q.toBlock, 16)
        if (q.topics[1] === null) // a buyer's funding: F paid it ~3 hours before the coin
          return [{ topics: ['0x', pad(F), q.topics[2]], blockNumber: '0x' + (BLOCK - 20_000).toString(16), logIndex: '0x0', transactionHash: '0x1' }] as T
        if (to - from > 50_000) return (o.wholeWindow ? [] : null) as T // the whole window: no answer (shorter ranges are answered)
        if (o.failSlice && from === BLOCK - 99_999) return null
        // F's payouts, all ~3 hours back: `paidInSlices` wallets
        return (from <= BLOCK - 20_000 && BLOCK - 20_000 <= to
          ? Array.from({ length: o.paidInSlices }, (_, k) => ({ topics: ['0x', pad(F), pad(A(100 + k))] })) : []) as T
      })
    },
  })
  test('a hub counted in slices is a hub, not a cluster', async () => {
    const c = await clustersOf(rpc({ wholeWindow: false, paidInSlices: 482 }), buyers, null, BLOCK)
    expect(c.groups).toEqual([])
  })
  test('a small funder counted in slices is a cluster', async () => {
    const c = await clustersOf(rpc({ wholeWindow: false, paidInSlices: 4 }), buyers, null, BLOCK)
    expect(c.groups).toEqual([{ funder: F, wallets: buyers }])
  })
  test('a slice without an answer: counted as a hub', async () => {
    const c = await clustersOf(rpc({ wholeWindow: false, paidInSlices: 4, failSlice: true }), buyers, null, BLOCK)
    expect(c.groups).toEqual([])
  })
})

describe('the safety report', () => {
  const meta: LaunchInfo = { token: A(1), name: 'C', symbol: 'C', decimals: 18, creator: A(9), txHash: '0x', blockNumber: LAUNCH, timestamp: 0, pool: null, quote: null, launchpad: 'Peach', chain: 'ARC', status: 'LIVE' }
  const trusted: StaticFacts = { template: 'Peach token', facts: null, owner: null, ownerless: true, proxy: false, hook: null }
  const flow = computeFlow([T({ wallet: A(1) }), T({ wallet: A(2), block: 120 })], { launchBlock: LAUNCH, creator: A(9), supply: 1e6 })
  const clean: ScanInput = {
    meta, pool: null, liquidityUsd: 5_000, onCurve: false, flow,
    honeypot: { verdict: 'ok', buyTaxPct: 0, transferTaxPct: 0, roundTripLossPct: 2, error: null },
    holders: { holders: 40, top10Pct: 30, creatorPct: 2, top: [] },
    clusters: { groups: [], creatorFunded: [], sameSourceAsCreator: [], unknown: 0 },
    biggerSameTicker: [], creatorLaunches24h: 0,
  }
  const failed = (s: StaticFacts, i: ScanInput) => assess(s, i).checks.filter(c => c.ok === false).map(c => c.id)

  test('a clean coin passes', () => {
    const r = assess(trusted, clean)
    expect(r.verdict).toBe('pass')
    expect(r.score).toBe(95) // "sellers" not yet known (no one besides the creator has sold)
  })
  test('anything not yet known keeps it pending, never passed', () => {
    expect(assess(trusted, { ...clean, honeypot: undefined }).verdict).toBe('pending')
    // Funding not traced in time (2026-09-30): a risk flag, not a block, so a signal isn't held for minutes.
    expect(assess(trusted, { ...clean, clusters: null }).verdict).toBe('risky')
    expect(assess(trusted, { ...clean, clusters: undefined }).verdict).toBe('pending')
    expect(assess(trusted, { ...clean, liquidityUsd: null }).verdict).toBe('pending')
  })
  test('honeypot, untradeable, and a tax in a deep pool fail', () => {
    expect(failed(trusted, { ...clean, honeypot: { ...clean.honeypot!, verdict: 'honeypot', error: '0xa5baf151' } })).toEqual(['honeypot'])
    expect(failed(trusted, { ...clean, honeypot: { ...clean.honeypot!, verdict: 'untradeable' } })).toEqual(['honeypot'])
    expect(failed(trusted, { ...clean, honeypot: { ...clean.honeypot!, roundTripLossPct: 40 } })).toEqual(['honeypot'])
    expect(failed(trusted, { ...clean, honeypot: { ...clean.honeypot!, transferTaxPct: 12 } })).toEqual(['honeypot'])
  })
  test('a costly round trip in a thin pool is price impact, not a tax (but thin fails liquidity)', () => {
    expect(failed(trusted, { ...clean, liquidityUsd: 800, honeypot: { ...clean.honeypot!, roundTripLossPct: 40 } })).toEqual(['liquidity'])
  })
  test('code: an owner who can still mint or freeze fails; renounced passes', () => {
    const code = analyzeCode('0x' + '63' + '40c10f19' + '63' + 'f9f92be4' + '63' + '8da5cb5b' + '00')
    const live: StaticFacts = { template: null, facts: code, owner: A(77), ownerless: false, proxy: false, hook: null }
    const r = assess(live, clean)
    expect(r.checks.find(c => c.id === 'contract')).toMatchObject({ ok: false })
    expect(r.checks.find(c => c.id === 'contract')!.detail).toMatch(/mint, freeze/)
    expect(assess({ ...live, owner: A(0), ownerless: true }, clean).verdict).toBe('pass')
  })
  test('upgradeable proxies and custom swap-changing hooks fail', () => {
    const plain: StaticFacts = { template: null, facts: analyzeCode('0x00'), owner: null, ownerless: true, proxy: true, hook: null }
    expect(failed(plain, clean)).toEqual(['proxy'])
    const hooked: StaticFacts = { ...trusted, hook: { address: A(0x2044), known: null, dangerous: true } }
    expect(failed(hooked, clean)).toEqual(['hook'])
    expect(assess({ ...trusted, hook: { address: A(0x2044), known: 'Argus P7 hook', dangerous: true } }, clean).verdict).toBe('pass')
  })
  test('bundles, clusters, wash and a creator who dumped fail', () => {
    const bundled = computeFlow([1, 2, 3].map(w => T({ wallet: A(w), block: 100, tokens: 100_000 })), { launchBlock: LAUNCH, creator: A(9), supply: 1e6 })
    expect(failed(trusted, { ...clean, flow: bundled })).toEqual(['bundle'])
    expect(failed(trusted, { ...clean, clusters: { ...clean.clusters!, groups: [{ funder: A(70), wallets: [A(1), A(2), A(3)] }] } })).toEqual(['clusters'])
    expect(failed(trusted, { ...clean, clusters: { ...clean.clusters!, creatorFunded: [A(1), A(2)] } })).toEqual(['clusters'])
    const washed = computeFlow([1, 2].flatMap(w => Array.from({ length: 6 }, (_, k) => T({ wallet: A(w), side: k % 2 ? 'SELL' : 'BUY', ts: k * 30_000, usd: 100 }))).concat(Array.from({ length: 10 }, (_, k) => T({ wallet: A(10 + k), usd: 1 }))), { launchBlock: LAUNCH, creator: A(9), supply: 1e6 })
    expect(failed(trusted, { ...clean, flow: washed })).toEqual(['wash'])
    const dumped = computeFlow([T({ wallet: A(9), tokens: 1_000 }), T({ wallet: A(9), side: 'SELL', tokens: 900, block: 130 })], { launchBlock: LAUNCH, creator: A(9), supply: 1e6 })
    expect(failed(trusted, { ...clean, flow: dumped })).toEqual(['creator'])
    expect(assess(trusted, { ...clean, flow: dumped }).verdict).toBe('fail')
  })
  test('a big holder, a serial creator or a copycat makes the coin risky, not failed', () => {
    const risky = (i: ScanInput) => { const r = assess(trusted, i); return [r.verdict, r.checks.filter(c => c.risk && c.ok !== true).map(c => c.id)] }
    expect(risky({ ...clean, holders: { ...clean.holders!, top10Pct: 70 } })).toEqual(['risky', ['holders']])
    expect(risky({ ...clean, holders: { ...clean.holders!, creatorPct: 49.9 } })).toEqual(['risky', ['holders']])
    expect(risky({ ...clean, creatorLaunches24h: 5 })).toEqual(['risky', ['serial']])
    expect(risky({ ...clean, biggerSameTicker: [A(55)] })).toEqual(['risky', ['copycat']])
    // Holders not known yet: assume the worst, trade it as risky.
    expect(risky({ ...clean, holders: undefined })).toEqual(['risky', ['holders']])
    expect(risky({ ...clean, holders: null })).toEqual(['risky', ['holders']])
    // A hard failure still wins.
    expect(assess(trusted, { ...clean, creatorLaunches24h: 5, clusters: { ...clean.clusters!, groups: [{ funder: A(70), wallets: [A(1), A(2), A(3)] }] } }).verdict).toBe('fail')
    expect(assess(trusted, { ...clean, creatorLaunches24h: 5, honeypot: undefined }).verdict).toBe('pending')
  })
  test('a coin on its launchpad curve needs no probe or pool liquidity', () => {
    expect(assess(trusted, { ...clean, onCurve: true, honeypot: undefined, liquidityUsd: null }).verdict).toBe('pass')
  })
})
