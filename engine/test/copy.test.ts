// Copy trading (the build pack's Phase 7). Acceptance: "follower trade lands within the target window after the
// leader's; caps respected; tokens failing safety are skipped; stop switch halts mirroring immediately."
import { describe, expect, test } from 'bun:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { verifyMessage, type Address, type Hex } from 'viem'
import { COPY, COPY_TERMS_VERSION, copyTermsMessage, copyWithdrawMessage } from '../../api/_copyProtocol'
import type { SocialStats } from '../../api/_socialProtocol'
import { CopyApi } from '../src/copy/api'
import { CopyEngine, MemoryCopyStore, type CopyExec, type CopyOptions, type CopyWalletRow } from '../src/copy/engine'
import { allocate, buyFloor, leaderVerdict, parseRule, screen, sellAmount, shuffle, type Rating } from '../src/copy/rules'
import type { PoolInfo } from '../src/dex/pools'
import type { FeeRow } from '../src/fees/ledger'
import type { SafetyReport } from '../src/intel/scanner'
import type { BookTrade } from '../src/social/pnl'
import type { Fill, SendGuard } from '../src/trading/live'
import type { RoundTrip } from '../src/trading/preflight'
import { MemoryBotStore, PostgresBotStore } from '../src/bot/store'

const E18 = 10n ** 18n
const LEADER = '0x1111111111111111111111111111111111111111'
const OTHER_LEADER = '0x2222222222222222222222222222222222222222'
const COIN = '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0'
const RISKY = '0xdededededededededededededededededededede'
const BAD = '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0'
const UNRATED = '0x9999999999999999999999999999999999999999'
const FEE_WALLET = '0x274262a0321a0701b0a46a3576e07ae881c286bb' as Address
const POOL = { pool: '0xpool' } as unknown as PoolInfo
const DAY = 86_400_000

const stats = (o: Partial<SocialStats> = {}): SocialStats => ({ realized: '100', volume: '5000', trades: 40, buys: 20, sells: 20, wins: 12, counted: 18, coins: 6, unmatched: '0', first: 0, last: 0, ...o })

/** A copy wallet's executor, in memory: quotes `perUsd` tokens a dollar, refuses a floor it can't meet and a guard's no. */
class FakeExec implements CopyExec {
  usd: number
  tokens = new Map<string, bigint>()
  buys: { token: string; usd: number; slippageBps: number; floor: bigint | undefined }[] = []
  sells: { token: string; amount: bigint }[] = []
  sends: { to: string; usd: number }[] = []
  perUsd = 1_000n
  lossPct = 3
  /** Held between the simulation and signing: a stop can land there. */
  hold: Promise<void> | null = null
  failSend = false
  private n = 0
  constructor(readonly address: Address, usd: number, private clock: () => number, private delayMs: () => number) { this.usd = usd }
  async balanceUsd() { return this.usd }
  async tokenBalance(t: Address) { return this.tokens.get(t) ?? 0n }
  private stop(o: SendGuard) { const why = o.guard?.(); if (why) throw new Error(why) }
  async buy(_pool: PoolInfo, token: Address, usd: number, slippageBps: number, check?: (rt: RoundTrip) => string | null, o: SendGuard & { floor?: bigint } = {}) {
    this.stop(o)
    const quoted = BigInt(Math.round(usd * 1e6)) * this.perUsd * E18 / 1_000_000n
    if (o.floor && quoted < o.floor) throw new Error(`the price moved past the cap (quoted ${quoted}, at least ${o.floor} needed)`)
    const rt = { ok: true, lossPct: this.lossPct } as unknown as RoundTrip
    const bad = check?.(rt)
    if (bad) throw new Error(`pre-flight: ${bad}`)
    if (this.hold) await this.hold
    this.stop(o)
    if (usd > this.usd) throw new Error('buy would fail: not enough USDC')
    this.usd -= usd
    this.tokens.set(token, (this.tokens.get(token) ?? 0n) + quoted)
    this.buys.push({ token, usd, slippageBps, floor: o.floor })
    return { hash: `0xb${(++this.n).toString(16).padStart(63, '0')}` as Hex, tokens: quoted, usd, gasUsd: 0, at: this.clock() + this.delayMs(), roundTrip: rt }
  }
  async sell(_pool: PoolInfo, token: Address, amount: bigint, _slip: number, o: SendGuard = {}): Promise<Fill> {
    this.stop(o)
    if (this.hold) await this.hold
    this.stop(o)
    const have = this.tokens.get(token) ?? 0n
    if (amount > have) throw new Error('sell would fail: not enough tokens')
    this.tokens.set(token, have - amount)
    const usd = Number((amount * 1_000_000n) / (this.perUsd * E18)) / 1e6
    this.usd += usd
    this.sells.push({ token, amount })
    return { hash: `0x5${(++this.n).toString(16).padStart(63, '0')}` as Hex, tokens: amount, usd, gasUsd: 0, at: this.clock() + this.delayMs() }
  }
  async approveForSale() { return [] }
  async sendUsdc(to: Address, usd: number): Promise<Fill> {
    if (this.failSend) throw new Error('fetch failed')
    if (usd > this.usd) throw new Error('insufficient funds')
    this.usd -= usd
    this.sends.push({ to: to.toLowerCase(), usd })
    return { hash: `0x7${(++this.n).toString(16).padStart(63, '0')}` as Hex, tokens: 0n, usd, gasUsd: 0, at: this.clock() }
  }
}

interface Follower { key: Hex; address: string; sign(m: string): Promise<Hex> }
function follower(): Follower {
  const key = generatePrivateKey(), acct = privateKeyToAccount(key)
  return { key, address: acct.address.toLowerCase(), sign: m => acct.signMessage({ message: m }) }
}

function world(o: Partial<CopyOptions> & { balance?: number; liquidity?: number | null; ratings?: Record<string, { rating: Rating; why: string | null }>; verdicts?: Record<string, string | null>; delayMs?: number } = {}) {
  let clock = 1_800_000_000_000
  const now = () => clock
  const execs = new Map<string, FakeExec>()
  const ledger: FeeRow[] = []
  let flagOff: string | null = null
  let tradingOn = true
  let leaderAfter: bigint | null = null
  const funders = new Map<string, { address: string; usd: number }[]>()
  let made = 0
  const store = o.store ?? new MemoryCopyStore()
  const opts: CopyOptions = {
    store,
    vault: {
      create: () => { made++; const address = privateKeyToAccount(generatePrivateKey()).address.toLowerCase(); return { address, enc: `enc:${address}` } },
      open: w => w.address as Hex,
    },
    makeExec: key => { let e = execs.get(key); if (!e) execs.set(key, (e = new FakeExec(key as Address, o.balance ?? 100, now, () => o.delayMs ?? 4_000))); return e },
    pool: t => (t === UNRATED + 'x' ? null : POOL),
    liquidityUsd: () => o.liquidity === undefined ? 100_000 : o.liquidity,
    symbol: () => 'COIN',
    screen: async t => o.ratings?.[t] ?? (t === BAD ? { rating: 'danger', why: 'honeypot: the sale reverted' } : t === RISKY ? { rating: 'risky', why: 'holders: top 10 hold 70%' } : t === UNRATED ? { rating: 'unknown', why: 'no report' } : { rating: 'safe', why: null }),
    leader: async a => (o.verdicts && a in o.verdicts ? o.verdicts[a] : null),
    leaders: async () => [{ address: LEADER, realized: '100', volume: '5000', trades: 40, winRate: 0.66, first: 0 }],
    leaderBalanceAt: async () => leaderAfter,
    feeBps: () => 200,
    feeWallet: FEE_WALLET,
    on: () => flagOff,
    tradingOn: () => tradingOn,
    verify: (address, message, signature) => verifyMessage({ address: address as Address, message, signature }),
    funders: async w => ({ list: funders.get(w.follower) ?? [], ledger: { scannedTo: 1, deposits: {}, contracts: [], wallets: [] } }),
    ledger: async rows => { ledger.push(...rows); return rows.length },
    now,
    ...o,
  }
  const engine = new CopyEngine(opts)
  let n = 0
  const trade = (x: Partial<BookTrade> = {}): BookTrade => {
    n++
    const tx = `0x${n.toString(16).padStart(64, 'f')}`
    return { id: `${tx}:0`, router: '0xd07583f7db671521aacfda2b4612ad187aa2924e', tx, block: 1_000 + n, logIndex: 0, at: clock - 1_500, trader: LEADER, token: COIN, side: 'buy', usdc: 100_000_000n, tokens: 98_000n * E18, fee: 2_000_000n, ...x }
  }
  const open = async (f: Follower) => {
    const at = clock
    const r = await engine.open(f.address, { at, signature: await f.sign(copyTermsMessage(f.address, COPY_TERMS_VERSION, at)) })
    expect(r.status).toBe(200)
  }
  return {
    engine, store, ledger, execs, trade, open,
    exec: async (f: Follower) => execs.get((await engine.me(f.address)).wallet!.address)!,
    tick: (ms: number) => { clock += ms },
    get clock() { return clock },
    setFlagOff: (why: string | null) => { flagOff = why },
    setTradingOn: (v: boolean) => { tradingOn = v },
    setLeaderAfter: (v: bigint | null) => { leaderAfter = v },
    setFunders: (f: string, list: { address: string; usd: number }[]) => funders.set(f, list),
  }
}

async function ready(w: ReturnType<typeof world>, f: Follower, rule: Record<string, unknown> = {}) {
  await w.engine.load()
  await w.open(f)
  const r = await w.engine.setRule(f.address, { leader: LEADER, maxPerTradeUsd: 25, slippageBps: 300, safety: 'not-danger', ...rule })
  expect(r.status).toBe(200)
  return { exec: await w.exec(f), rule: (await w.engine.me(f.address)).rules[0] }
}

describe('the rules, pure', () => {
  test('a rule\'s limits', () => {
    expect(parseRule({ leader: LEADER, maxPerTradeUsd: 25 })).toEqual({ leader: LEADER, maxPerTradeUsd: 25, slippageBps: COPY.defaultSlippageBps, safety: 'not-danger', enabled: true })
    expect(parseRule({ leader: 'nope', maxPerTradeUsd: 25 })).toMatch(/wallet address/)
    expect(parseRule({ leader: LEADER, maxPerTradeUsd: 0.5 })).toMatch(/between \$1 and \$500/)
    expect(parseRule({ leader: LEADER, maxPerTradeUsd: 501 })).toMatch(/between/)
    expect(parseRule({ leader: LEADER, maxPerTradeUsd: 5, slippageBps: 20 })).toMatch(/slippage cap/)
    expect(parseRule({ leader: LEADER, maxPerTradeUsd: 5, slippageBps: 1_600 })).toMatch(/slippage cap/)
    expect(parseRule({ leader: LEADER, maxPerTradeUsd: 5, safety: 'yolo' })).toMatch(/safety/)
  })
  test('who can be copied: verified history, and no wash-trade flag', () => {
    const now = 100 * DAY
    expect(leaderVerdict(null, now)).toMatch(/no verified trades/)
    expect(leaderVerdict({ periods: { all: stats({ first: 0 }) }, wash: { trader: LEADER, reasons: ['round-trips'], roundTrips: 9, mirrors: 0, share: 0.8 } as never }, now)).toMatch(/wash-trade filter/)
    expect(leaderVerdict({ periods: { all: stats({ trades: 9 }) }, wash: null }, now)).toMatch(/10\+ verified trades/)
    expect(leaderVerdict({ periods: { all: stats({ counted: 2 }) }, wash: null }, now)).toMatch(/3\+ sales/)
    expect(leaderVerdict({ periods: { all: stats({ first: now - 2 * DAY }) }, wash: null }, now)).toMatch(/3\+ days/)
    expect(leaderVerdict({ periods: { all: stats({ first: now - 4 * DAY }) }, wash: null }, now)).toBeNull()
  })
  test('the safety screen: a failed hard check is Danger, an unanswered essential one unknown, a risk flag Risky', () => {
    const r = (checks: SafetyReport['checks']): SafetyReport => ({ token: COIN, launchpad: 'Argus', at: 0, verdict: 'pass', score: 90, checks, template: null, honeypot: null })
    const ok = { id: 'contract', ok: true, hard: true, detail: 'standard' }
    expect(screen(r([ok]), null)).toEqual({ rating: 'safe', why: null })
    expect(screen(r([ok]), 'liquidity pulled')).toMatchObject({ rating: 'danger', why: 'rug guard: liquidity pulled' })
    expect(screen(null, null).rating).toBe('unknown')
    expect(screen(r([ok, { id: 'hook', ok: false, hard: true, detail: 'blocks sales' }]), null)).toMatchObject({ rating: 'danger', why: 'hook: blocks sales' })
    expect(screen(r([ok, { id: 'creator', ok: null, hard: true, detail: '?' }]), null).rating).toBe('unknown')
    expect(screen(r([ok, { id: 'clusters', ok: null, hard: true, detail: 'not traced' }]), null).rating).toBe('risky')
    expect(screen(r([ok, { id: 'holders', ok: false, hard: false, risk: true, detail: 'top 10 hold 70%' }]), null)).toMatchObject({ rating: 'risky' })
  })
  test('the buy floor is the leader\'s price less the cap', () => {
    // The leader's $100 paid $2 of fee; $98 reached the pool for 98,000 coins: 1,000 a dollar.
    const t = { usdc: 100_000_000n, fee: 2_000_000n, tokens: 98_000n * E18 }
    expect(buyFloor(10_000_000n, t, 300)).toBe(9_700n * E18)
    expect(buyFloor(10_000_000n, { ...t, tokens: 0n }, 300)).toBe(0n)
  })
  test('a sale sells the leader\'s share of the lot; sold out or unknown: all of it', () => {
    expect(sellAmount(1_000n, 400n, 600n)).toBe(400n)
    expect(sellAmount(1_000n, 990n, 10n)).toBe(1_000n)
    expect(sellAmount(1_000n, 400n, null)).toBe(1_000n)
    expect(sellAmount(0n, 400n, 600n)).toBe(0n)
  })
  test('the crowd\'s room is 2% of the pool, shared in order; every trade orders followers differently', () => {
    const m = allocate([{ key: 'a', usd: 15 }, { key: 'b', usd: 15 }, { key: 'c', usd: 15 }], 1_000)
    expect([...m.values()]).toEqual([15, 5, 0])
    expect([...allocate([{ key: 'a', usd: 15 }], null).values()]).toEqual([15])
    const firsts = new Set(Array.from({ length: 40 }, (_, i) => shuffle(['a', 'b', 'c', 'd'], `t${i}`)[0]))
    expect(firsts.size).toBe(4)
  })
})

describe('the copy wallet', () => {
  test('made only once the follower signs the terms; a new signature keeps the wallet', async () => {
    const w = world()
    await w.engine.load()
    const f = follower()
    expect((await w.engine.open(f.address, {})).status).toBe(400)
    const at = w.clock
    const wrong = await follower().sign(copyTermsMessage(f.address, COPY_TERMS_VERSION, at))
    expect((await w.engine.open(f.address, { at, signature: wrong })).status).toBe(403)
    const old = w.clock - 6 * 60_000
    expect((await w.engine.open(f.address, { at: old, signature: await f.sign(copyTermsMessage(f.address, COPY_TERMS_VERSION, old)) })).status).toBe(400)
    await w.open(f)
    const me = await w.engine.me(f.address)
    expect(me).toMatchObject({ accepted: COPY_TERMS_VERSION, stopped: false, wallet: { balanceUsd: 100, feeDueUsd: 0 } })
    const first = me.wallet!.address
    w.tick(1_000)
    await w.open(f)
    expect((await w.engine.me(f.address)).wallet!.address).toBe(first)
  })
  test('no vault (no engine-held wallets): nothing can be opened, and it says why', async () => {
    const w = world({ vault: null })
    await w.engine.load()
    expect(w.engine.why()).toBe('copy trading isn’t available yet')
    expect((await w.engine.open(follower().address, {})).status).toBe(503)
  })
  test('rules: one per leader, not yourself, leaders that pass the verified record only, at most 10', async () => {
    const w = world({ verdicts: { [OTHER_LEADER]: 'this wallet is left out of the leaderboards by the wash-trade filter' } })
    const f = follower()
    await ready(w, f)
    expect((await w.engine.setRule(f.address, { leader: f.address, maxPerTradeUsd: 5 })).body).toMatchObject({ error: expect.stringMatching(/yourself/) })
    expect((await w.engine.setRule(f.address, { leader: OTHER_LEADER, maxPerTradeUsd: 5 })).body).toMatchObject({ error: expect.stringMatching(/wash-trade/) })
    // A disabled rule can be kept for a leader that no longer qualifies.
    expect((await w.engine.setRule(f.address, { leader: OTHER_LEADER, maxPerTradeUsd: 5, enabled: false })).status).toBe(200)
    expect((await w.engine.setRule(f.address, { leader: LEADER, maxPerTradeUsd: 40 })).status).toBe(200)
    const me = await w.engine.me(f.address)
    expect(me.rules.map(r => [r.leader, r.maxPerTradeUsd])).toEqual([[LEADER, 40], [OTHER_LEADER, 5]])
    for (let i = 0; i < 8; i++) await w.engine.setRule(f.address, { leader: `0x${(i + 3).toString(16).repeat(40)}`, maxPerTradeUsd: 5 })
    expect((await w.engine.setRule(f.address, { leader: `0x${'e'.repeat(40)}`, maxPerTradeUsd: 5 })).body).toMatchObject({ error: expect.stringMatching(/at most 10/) })
    const g = follower()
    expect((await w.engine.setRule(g.address, { leader: LEADER, maxPerTradeUsd: 5 })).body).toMatchObject({ error: expect.stringMatching(/copy wallet first/) })
  })
})

describe('copying a leader\'s buy', () => {
  test('lands within the window, at the rule\'s most, with the leader\'s price less the cap as its floor', async () => {
    const w = world({ delayMs: 4_000 })
    const f = follower()
    const { exec } = await ready(w, f)
    const t = w.trade()
    await w.engine.onLeaderTrade(t, w.clock)
    expect(exec.buys).toEqual([{ token: COIN, usd: 25, slippageBps: 300, floor: 24_250n * E18 }])
    const [e] = w.engine.executionsOf(f.address)
    expect(e).toMatchObject({ status: 'filled', usd: 25, side: 'buy', leaderTx: t.tx, feeUsd: 0.5 })
    expect(e.latencyMs).toBe(5_500) // the leader's block 1.5s ago, the copy's receipt 4s from now
    expect(e.latencyMs!).toBeLessThanOrEqual(COPY.windowMs)
    expect(w.engine.stats()).toMatchObject({ copies: 1, withinWindow: 1, p50Ms: 5_500 })
    expect((await w.engine.me(f.address)).lots).toEqual([{ leader: LEADER, token: COIN, tokens: (25_000n * E18).toString() }])
  })
  test('a smaller leader buy is copied at its own size (what reached the pool)', async () => {
    const w = world()
    const f = follower()
    const { exec } = await ready(w, f)
    await w.engine.onLeaderTrade(w.trade({ usdc: 10_000_000n, fee: 200_000n, tokens: 9_800n * E18 }), w.clock)
    expect(exec.buys.map(b => b.usd)).toEqual([9.8])
  })
  test('the wallet\'s USDC caps it: the gas reserve and the fee are kept back', async () => {
    const w = world({ balance: 10 })
    const f = follower()
    const { exec } = await ready(w, f, { maxPerTradeUsd: 50 })
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    // (10 − 0.30) / 1.02
    expect(exec.buys.map(b => b.usd)).toEqual([9.5])
    expect(exec.usd).toBeGreaterThanOrEqual(COPY.reserveUsd)
  })
  test('too little to copy: skipped, and it says so', async () => {
    const w = world({ balance: 1 })
    const f = follower()
    const { exec } = await ready(w, f)
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    expect(exec.buys).toEqual([])
    expect(w.engine.executionsOf(f.address)[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/under the \$1/) })
  })
  test('a price past the cap: skipped, nothing bought', async () => {
    const w = world()
    const f = follower()
    const { exec } = await ready(w, f)
    exec.perUsd = 900n // 10% worse than the leader got
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    expect(exec.buys).toEqual([])
    expect(w.engine.executionsOf(f.address)[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/moved more than your 3% cap/) })
  })
  test('all followers of one trade together buy at most 2% of the pool', async () => {
    const w = world({ liquidity: 1_000 })
    const fs = [follower(), follower(), follower()]
    await w.engine.load()
    for (const f of fs) { await w.open(f); await w.engine.setRule(f.address, { leader: LEADER, maxPerTradeUsd: 15 }) }
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    const spent = await Promise.all(fs.map(async f => (await w.exec(f)).buys.reduce((s, b) => s + b.usd, 0)))
    expect(spent.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20)
    expect(spent.sort((a, b) => b - a)).toEqual([15, 5, 0])
    const full = fs.flatMap(f => w.engine.executionsOf(f.address)).find(e => e.status === 'skipped')
    expect(full?.reason).toMatch(/2% of the pool/)
  })
  test('the leader\'s record and the coin\'s rating are asked once per trade, whatever the number of followers', async () => {
    let leaderAsks = 0, screenAsks = 0
    const w = world({ leader: async () => { leaderAsks++; return null }, screen: async () => { screenAsks++; return { rating: 'safe', why: null } } })
    await w.engine.load()
    for (let i = 0; i < 5; i++) { const f = follower(); await w.open(f); await w.engine.setRule(f.address, { leader: LEADER, maxPerTradeUsd: 5 }) }
    leaderAsks = 0
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    expect([leaderAsks, screenAsks]).toEqual([1, 1])
  })
  test('the same leader trade is copied once', async () => {
    const w = world()
    const f = follower()
    const { exec } = await ready(w, f)
    const t = w.trade()
    await Promise.all([w.engine.onLeaderTrade(t, w.clock), w.engine.onLeaderTrade(t, w.clock)])
    await w.engine.onLeaderTrade(t, w.clock)
    expect(exec.buys).toHaveLength(1)
  })
  test('a leader trade seen over a minute late isn\'t copied', async () => {
    const w = world()
    const f = follower()
    const { exec } = await ready(w, f)
    const t = w.trade({ at: w.clock - 61_000 })
    await w.engine.onLeaderTrade(t, w.clock)
    expect(exec.buys).toEqual([])
    expect(w.engine.executionsOf(f.address)[0].reason).toMatch(/too late/)
  })
  test('a leader that stopped qualifying (a new wash-trade flag) isn\'t copied', async () => {
    const leaders: Record<string, string | null> = {}
    const w = world({ verdicts: leaders })
    const f = follower()
    const { exec } = await ready(w, f)
    leaders[LEADER] = 'this wallet is left out of the leaderboards by the wash-trade filter'
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    expect(exec.buys).toEqual([])
    expect(w.engine.executionsOf(f.address)[0].reason).toMatch(/wash-trade/)
  })
})

describe('safety: coins failing the screen are skipped', () => {
  test('Danger and unrated coins are never bought; Risky only under not-danger; a costly round trip is skipped', async () => {
    const w = world()
    const a = follower(), b = follower()
    await w.engine.load()
    await w.open(a); await w.engine.setRule(a.address, { leader: LEADER, maxPerTradeUsd: 10, safety: 'not-danger' })
    await w.open(b); await w.engine.setRule(b.address, { leader: LEADER, maxPerTradeUsd: 10, safety: 'safe-only' })
    for (const token of [BAD, UNRATED, RISKY]) await w.engine.onLeaderTrade(w.trade({ token }), w.clock)
    const ea = await w.exec(a), eb = await w.exec(b)
    expect(ea.buys.map(x => x.token)).toEqual([RISKY])
    expect(eb.buys).toEqual([])
    const why = (f: Follower, token: string) => w.engine.executionsOf(f.address).find(e => e.token === token)?.reason
    expect(why(a, BAD)).toMatch(/Danger: honeypot/)
    expect(why(a, UNRATED)).toMatch(/couldn.t finish/)
    expect(why(b, RISKY)).toMatch(/Safe coins only/)
    ea.lossPct = 25
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    expect(ea.buys).toHaveLength(1)
    expect(w.engine.executionsOf(a.address).at(-1)!.reason).toMatch(/safety screen \(pre-flight: buying and selling straight back costs 25.0%\)/)
  })
})

describe('the stop switch halts mirroring immediately', () => {
  test('stopped before the leader trades: nothing copied', async () => {
    const w = world()
    const f = follower()
    const { exec } = await ready(w, f)
    await w.engine.setStopped(f.address, { stopped: true })
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    expect(exec.buys).toEqual([])
    expect(w.engine.executionsOf(f.address)[0].reason).toBe('stopped: you paused copying')
    await w.engine.setStopped(f.address, { stopped: false })
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    expect(exec.buys).toHaveLength(1)
  })
  test('stopped while a copy is under way: the copy never signs', async () => {
    for (const how of ['stop', 'delete', 'disable', 'flag'] as const) {
      const w = world()
      const f = follower()
      const { exec, rule } = await ready(w, f)
      let release!: () => void
      exec.hold = new Promise(r => { release = r })
      const run = w.engine.onLeaderTrade(w.trade(), w.clock)
      await new Promise(r => setTimeout(r, 5))
      expect(w.engine.busy(f.address)).toBe(true)
      if (how === 'stop') await w.engine.setStopped(f.address, { stopped: true })
      if (how === 'delete') await w.engine.deleteRule(f.address, { id: rule.id })
      if (how === 'disable') await w.engine.setRule(f.address, { leader: LEADER, maxPerTradeUsd: 25, enabled: false })
      if (how === 'flag') w.setFlagOff('copy trading is off: an admin turns it on from /admin → Flags')
      release()
      await run
      expect(exec.buys).toEqual([])
      expect(w.engine.executionsOf(f.address)[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/^stopped: /) })
    }
  })
  test('ARCDEX\'s trade switch stops copied buys; sales still follow the leader out', async () => {
    const w = world()
    const f = follower()
    const { exec } = await ready(w, f)
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    w.setTradingOn(false)
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    expect(exec.buys).toHaveLength(1)
    expect(w.engine.executionsOf(f.address).at(-1)!.reason).toMatch(/trading on Arc is paused/)
    await w.engine.onLeaderTrade(w.trade({ side: 'sell', tokens: 98_000n * E18 }), w.clock)
    expect(exec.sells).toHaveLength(1)
  })
})

describe('copying a leader\'s sale', () => {
  test('sells the share of the follower\'s lot that the leader sold of its own holding', async () => {
    const w = world()
    const f = follower()
    const { exec } = await ready(w, f)
    await w.engine.onLeaderTrade(w.trade(), w.clock) // 25,000 coins
    w.setLeaderAfter(58_800n * E18) // the leader sold 39,200 of 98,000: 40%
    await w.engine.onLeaderTrade(w.trade({ side: 'sell', tokens: 39_200n * E18, usdc: 40_000_000n }), w.clock)
    expect(exec.sells.map(s => s.amount)).toEqual([10_000n * E18])
    expect((await w.engine.me(f.address)).lots[0].tokens).toBe((15_000n * E18).toString())
    w.setLeaderAfter(0n) // sold out
    await w.engine.onLeaderTrade(w.trade({ side: 'sell', tokens: 58_800n * E18, usdc: 60_000_000n }), w.clock)
    expect(exec.sells.map(s => s.amount)).toEqual([10_000n * E18, 15_000n * E18])
    expect((await w.engine.me(f.address)).lots).toEqual([])
  })
  test('nothing held from this leader\'s copies: nothing sold (coins from elsewhere are left alone)', async () => {
    const w = world()
    const f = follower()
    const { exec } = await ready(w, f)
    exec.tokens.set(COIN, 5_000n * E18)
    await w.engine.onLeaderTrade(w.trade({ side: 'sell' }), w.clock)
    expect(exec.sells).toEqual([])
    expect(w.engine.executionsOf(f.address)[0].reason).toMatch(/hold none/)
  })
  test('the leader\'s balance can\'t be read: the whole lot is sold', async () => {
    const w = world()
    const f = follower()
    const { exec } = await ready(w, f)
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    w.setLeaderAfter(null)
    await w.engine.onLeaderTrade(w.trade({ side: 'sell', tokens: 1n * E18 }), w.clock)
    expect(exec.sells.map(s => s.amount)).toEqual([25_000n * E18])
  })
})

describe('fees and withdrawals', () => {
  test('every copy owes ARCDEX\'s fee; from $0.25 it\'s sent to the fee wallet and recorded in the fee ledger', async () => {
    const w = world()
    const f = follower()
    const { exec } = await ready(w, f, { maxPerTradeUsd: 10 })
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    expect((await w.engine.me(f.address)).wallet!.feeDueUsd).toBe(0.2)
    expect(await w.engine.settleFees()).toBe(0) // under $0.25
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    expect(await w.engine.settleFees()).toBe(1)
    expect(exec.sends).toEqual([{ to: FEE_WALLET, usd: 0.4 }])
    expect((await w.engine.me(f.address)).wallet).toMatchObject({ feeDueUsd: 0, feesPaidUsd: 0.4 })
    expect(w.ledger).toEqual([expect.objectContaining({ source: 'arc-copy', amount: '0.400000', amountUsd: 0.4, recipient: FEE_WALLET, status: 'received', trader: f.address })])
  })
  test('a fee that can\'t be sent stays owed', async () => {
    const w = world()
    const f = follower()
    const { exec } = await ready(w, f)
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    exec.failSend = true
    expect(await w.engine.settleFees()).toBe(0)
    expect((await w.engine.me(f.address)).wallet!.feeDueUsd).toBe(0.5)
  })
  test('withdrawals: signed by the follower, once, only to the follower or a funder, fees owed paid first', async () => {
    const w = world()
    const f = follower()
    const { exec } = await ready(w, f)
    await w.engine.onLeaderTrade(w.trade(), w.clock) // $25 spent, $0.50 owed
    const ask = async (to: string, amountUsd: number, signer = f) => {
      w.tick(1_000) // a fresh signature each time: one is used once, refused or not
      const at = w.clock
      return w.engine.withdraw(f.address, { to, amountUsd, at, signature: await signer.sign(copyWithdrawMessage(f.address, to, amountUsd, at)) })
    }
    const stranger = '0x3333333333333333333333333333333333333333'
    expect((await ask(stranger, 10)).status).toBe(403)
    expect((await ask(f.address, 10, follower())).status).toBe(403)
    w.setFunders(f.address, [{ address: stranger, usd: 100 }])
    expect((await ask(stranger, 10)).status).toBe(200)
    expect(exec.sends).toEqual([{ to: FEE_WALLET, usd: 0.5 }, { to: stranger, usd: 10 }])
    // Everything left: refused, a little is kept for gas.
    expect((await ask(f.address, 64.5)).body).toMatchObject({ error: expect.stringMatching(/at most \$64\.45/) })
    const at = w.clock
    const sig = await f.sign(copyWithdrawMessage(f.address, f.address, 5, at))
    expect((await w.engine.withdraw(f.address, { to: f.address, amountUsd: 5, at, signature: sig })).status).toBe(200)
    expect((await w.engine.withdraw(f.address, { to: f.address, amountUsd: 5, at, signature: sig })).body).toMatchObject({ error: expect.stringMatching(/used already/) })
  })
})

describe('kept across a restart', () => {
  test('wallets, rules, lots and executions come back', async () => {
    const store = new MemoryBotStore()
    const w = world({ store })
    const f = follower()
    await ready(w, f)
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    const again = world({ store })
    await again.engine.load()
    const me = await again.engine.me(f.address)
    expect(me.rules).toHaveLength(1)
    expect(me.executions).toHaveLength(1)
    expect(me.lots).toEqual([{ leader: LEADER, token: COIN, tokens: (25_000n * E18).toString() }])
    expect(me.wallet!.feeDueUsd).toBe(0.5)
  })
})

describe('the routes', () => {
  test('status and leaders are public; the rest needs a wallet session and the site\'s origin', async () => {
    const w = world()
    await w.engine.load()
    const f = follower()
    const api = new CopyApi({ engine: w.engine, origins: ['https://arcsense.site'], session: async t => (t === 'good' ? { address: f.address, iat: 0 } : null) })
    const call = async (path: string, o: { method?: string; token?: string; origin?: string; body?: unknown } = {}) => {
      const headers: Record<string, string> = {}
      if (o.token) headers.authorization = `Bearer ${o.token}`
      if (o.origin) headers.origin = o.origin
      const req = new Request(`http://x${path}`, { method: o.method ?? 'GET', headers, body: o.body ? JSON.stringify(o.body) : undefined })
      return (await api.handle(req, new URL(req.url)))!
    }
    expect(await call('/v1/copy/status')).toMatchObject({ status: 200, body: { on: true, terms: COPY_TERMS_VERSION, feeBps: 200 } })
    expect(await call('/v1/copy/leaders')).toMatchObject({ status: 200, body: { leaders: [{ address: LEADER, followers: 0 }] } })
    expect((await call('/v1/copy/me')).status).toBe(401)
    expect((await call('/v1/copy/me', { token: 'good' })).status).toBe(200)
    const at = w.clock
    const body = { at, signature: await f.sign(copyTermsMessage(f.address, COPY_TERMS_VERSION, at)) }
    expect((await call('/v1/copy/open', { method: 'POST', token: 'good', body })).status).toBe(403) // no origin
    expect((await call('/v1/copy/open', { method: 'POST', token: 'good', origin: 'https://evil.example', body })).status).toBe(403)
    expect((await call('/v1/copy/open', { method: 'POST', origin: 'https://arcsense.site', body })).status).toBe(401)
    expect(await call('/v1/copy/open', { method: 'POST', token: 'good', origin: 'https://arcsense.site', body })).toMatchObject({ status: 200, body: { accepted: COPY_TERMS_VERSION } })
    expect(await call('/v1/copy/stop', { method: 'POST', token: 'good', origin: 'https://arcsense.site', body: { stopped: true } })).toMatchObject({ status: 200, body: { stopped: true } })
    expect(await call('/v1/copy/nope', { token: 'good' })).toMatchObject({ status: 404 })
  })
  test('off: the status says why, and no copy is made', async () => {
    const w = world()
    const f = follower()
    const { exec } = await ready(w, f)
    w.setFlagOff('copy trading is off: an admin turns it on from /admin → Flags')
    expect(w.engine.status()).toMatchObject({ on: false, why: expect.stringMatching(/admin/) })
    await w.engine.onLeaderTrade(w.trade(), w.clock)
    expect(exec.buys).toEqual([])
  })
})

const PG = process.env.PG_TEST_URL
describe.skipIf(!PG)('Postgres (PG_TEST_URL)', () => {
  test('copy wallets, rules and executions round-trip; executions are append-only', async () => {
    const store = new PostgresBotStore(PG!)
    const w = world({ store })
    const f = follower()
    await ready(w, f)
    await w.engine.onLeaderTrade(w.trade({ tx: `0x${Date.now().toString(16).padStart(64, '0')}` }), w.clock)
    const again = world({ store })
    await again.engine.load()
    const me = await again.engine.me(f.address)
    expect(me.rules).toHaveLength(1)
    expect(me.executions[0]).toMatchObject({ status: 'filled', usd: 25 })
    expect(me.lots[0].tokens).toBe((25_000n * E18).toString())
    const row: CopyWalletRow | undefined = (await store.copyWallets()).find(x => x.follower === f.address)
    expect(row?.enc).toMatch(/^enc:/)
    const { SQL } = await import('bun')
    const sql = new SQL(PG!)
    const refused = (q: PromiseLike<unknown>) => Promise.resolve(q).then(() => 'ran', (e: Error) => e.message)
    expect(await refused(sql`update arcdex_copy_executions set row = '{}' where follower = ${f.address}`)).toMatch(/append-only/)
    expect(await refused(sql`delete from arcdex_copy_executions where follower = ${f.address}`)).toMatch(/append-only/)
    await sql.close()
  })
})
