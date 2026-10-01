// Accounts, the marketplace and live bots (owner's request, 2026-09-30):
// email + 4-character passcode (bot/users.ts), resets by email
// (bot/mailer.ts), unique bot names and owners (bot/paperAccounts.ts), the
// 2% fee on winning trades, going live once the paper record is good enough
// (bot/userLive.ts) against a stand-in wallet, and the HTTP routes
// (ws/botApi.ts).
import { describe, expect, test } from 'bun:test'
import { pad, toHex, type Address, type Hex } from 'viem'
import type { MeResponse } from '../../api/_marketProtocol'
import { MemoryMailer, NoMailer } from '../src/bot/mailer'
import { PaperAccounts, slugOf, type PaperAccount, type PaperSignal } from '../src/bot/paperAccounts'
import { ScanFeed } from '../src/bot/scanFeed'
import { MemoryBotStore } from '../src/bot/store'
import { PROFIT_FEE, profitFee, readiness, READY, USER_LIVE, UserLive, WalletVault } from '../src/bot/userLive'
import { AUTH, Users } from '../src/bot/users'
import type { PoolInfo } from '../src/dex/pools'
import { USDC20, type LiveExecutor } from '../src/trading/live'
import { openPosition, recordSell, STRATEGIES, type Position } from '../src/trading/paper'
import { botApi } from '../src/ws/botApi'
import type { Rpc } from '../src/chain/http'

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const now = Date.UTC(2026, 8, 30, 12)
const settle = () => new Promise(r => setTimeout(r, 30))
const codeIn = (m: MemoryMailer) => /\n {4}(\S+)\n/.exec(m.sent[m.sent.length - 1].text)![1]

function setupUsers<M extends MemoryMailer | NoMailer = MemoryMailer>(mailer: M = new MemoryMailer() as M) {
  const store = new MemoryBotStore()
  return { store, mailer, users: new Users({ store, mailer, secret: 'test-secret' }) }
}

describe('accounts: email and a 4-character passcode', () => {
  test('sign up, sign in, and a session token that can\'t be forged', async () => {
    const { users } = setupUsers()
    expect(await users.signup('not-an-email', 'AB12', '1.1.1.1', now)).toMatchObject({ status: 400 })
    expect(await users.signup('a@b.co', 'AB1', '1.1.1.1', now)).toMatchObject({ status: 400 })
    expect(await users.signup('a@b.co', 'AB1!', '1.1.1.1', now)).toMatchObject({ status: 400 })
    const r = await users.signup(' Ann@Example.com ', 'Ab12', '1.1.1.1', now)
    if ('error' in r) throw new Error(r.error)
    expect(r.user.email).toBe('ann@example.com')
    expect(r.user.passHash).not.toContain('Ab12')
    expect(await users.signup('ann@example.com', 'Zz99', '1.1.1.1', now)).toMatchObject({ status: 409 })
    expect(users.userOf(r.token, now)?.id).toBe(r.user.id)
    const [id, issued, sig] = r.token.split('.')
    expect(users.userOf(`${id}.${Number(issued) + 1}.${sig}`, now)).toBeNull()
    expect(users.userOf(r.token, now + (AUTH.sessionDays + 1) * 86_400_000)).toBeNull()
    expect(await users.login('ann@example.com', 'ab12', '1.1.1.1', now)).toMatchObject({ status: 401 }) // case matters
    const again = await users.login('ANN@example.com', 'Ab12', '1.1.1.1', now)
    expect('token' in again && users.userOf(again.token, now)?.email).toBe('ann@example.com')
  })
  test('5 wrong passcodes lock the account for 15 minutes; an IP gets 30 wrong tries an hour', async () => {
    const { users } = setupUsers()
    await users.signup('b@x.io', 'Pass', '2.2.2.2', now)
    for (let i = 0; i < 5; i++) expect(await users.login('b@x.io', 'Nope', '2.2.2.2', now)).toMatchObject({ status: 401 })
    expect(await users.login('b@x.io', 'Pass', '2.2.2.2', now + 60_000)).toMatchObject({ status: 429, error: expect.stringMatching(/try again in 14 min/) })
    expect('token' in await users.login('b@x.io', 'Pass', '2.2.2.2', now + 16 * 60_000)).toBe(true)
    for (let i = 0; i < 30; i++) await users.login(`nobody${i}@x.io`, 'Nope', '3.3.3.3', now)
    expect(await users.login('b@x.io', 'Pass', '3.3.3.3', now)).toMatchObject({ status: 429 })
  })
  test('forgot: a new passcode by email, every device signed out; unknown emails look the same', async () => {
    const { users, mailer } = setupUsers()
    const r = await users.signup('c@x.io', 'Old1', '4.4.4.4', now) as { token: string }
    mailer.sent.length = 0
    expect(await users.forgot('nobody@x.io', '4.4.4.4', now)).toEqual({ ok: true })
    expect(mailer.sent).toHaveLength(0)
    expect(await users.forgot('c@x.io', '4.4.4.4', now + 1)).toEqual({ ok: true })
    expect(mailer.sent[0]).toMatchObject({ to: 'c@x.io', subject: 'Your new ARCDEX passcode' })
    const fresh = codeIn(mailer)
    expect(fresh).toMatch(AUTH.passcode)
    expect(users.userOf(r.token, now + 2)).toBeNull() // signed out everywhere
    expect(await users.login('c@x.io', 'Old1', '4.4.4.4', now + 2)).toMatchObject({ status: 401 })
    expect('token' in await users.login('c@x.io', fresh, '4.4.4.4', now + 3)).toBe(true)
    await users.forgot('c@x.io', '4.4.4.4', now + 60_000) // within 5 minutes: nothing new sent
    expect(mailer.sent).toHaveLength(1)
    const off = setupUsers(new NoMailer())
    await off.users.signup('d@x.io', 'Pass', '5.5.5.5', now)
    expect(await off.users.forgot('d@x.io', '5.5.5.5', now)).toMatchObject({ status: 503 })
  })
  test('a verification code confirms the email; codes are single-use with 5 tries', async () => {
    const { users, mailer } = setupUsers()
    const r = await users.signup('e@x.io', 'Pass', '6.6.6.6', now) as { user: import('../src/bot/users').User }
    await settle() // the code is sent in the background
    const code = codeIn(mailer)
    expect(users.verify(r.user, '000000' === code ? '111111' : '000000', now)).toMatch(/wrong code \(4 tries left\)/)
    expect(users.verify(r.user, code, now)).toBeNull()
    expect(r.user.verified).toBe(true)
    expect(users.verify(r.user, code, now)).toMatch(/no code is waiting/)
    expect(await users.challenge(r.user, 'withdraw:x', '{"to":"0xabc","usd":5}', 's', 'i', 'o', 10, now)).toBeNull()
    expect(users.confirm(r.user, 'withdraw:x', codeIn(mailer), now)).toBe('{"to":"0xabc","usd":5}')
  })
})

// ── bots: names, owners, fees, the marketplace ─────────────────────────

const T = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1'
const pool: PoolInfo = { pool: '0xpool', dex: 'uniswap-v4', currency0: USDC20, currency1: T, fee: 10_000, tickSpacing: 200, hooks: null, base: T, quote: USDC20, baseIs0: false, baseDecimals: 18, quoteDecimals: 6 }

/** A stand-in bot wallet: buys at $1 a token, sells at `sellAt`, records every call. */
function stubWallet(o: { balance: number; sellAt: number }) {
  const calls: string[] = []
  let held = 0n
  const exec = {
    address: '0x' + 'ab'.repeat(20) as Address,
    ready: async () => '0x' as Address,
    balanceUsd: async () => o.balance,
    buy: async (_p: PoolInfo, _t: Address, usd: number) => { calls.push(`buy ${usd}`); held = BigInt(Math.round(usd * 1e6)) * 10n ** 12n; o.balance -= usd; return { hash: '0xb' as Hex, tokens: held, usd, gasUsd: 0.01, at: Date.now() } },
    approveForSale: async () => [],
    tokenBalance: async () => held,
    sell: async (_p: PoolInfo, _t: Address, amount: bigint) => { const usd = Number(amount) / 1e18 * o.sellAt; calls.push(`sell ${usd.toFixed(2)}`); held -= amount; o.balance += usd; return { hash: '0xs' as Hex, tokens: amount, usd, gasUsd: 0.01, at: Date.now() } },
    sendUsdc: async (to: Address, usd: number) => { calls.push(`send ${usd} to ${to}`); o.balance -= usd; return { hash: '0xf' as Hex, tokens: 0n, usd, gasUsd: 0.001, at: Date.now() } },
  }
  return { calls, exec: exec as unknown as LiveExecutor, o }
}

function setupBots(o: { live?: boolean; balance?: number; sellAt?: number; rpc?: Rpc } = {}) {
  const store = new MemoryBotStore()
  const wallet = stubWallet({ balance: o.balance ?? 100, sellAt: o.sellAt ?? 1.2 })
  const live = new UserLive({ vault: o.live === false ? null : new WalletVault('11'.repeat(32)), makeExec: () => wallet.exec, pools: () => pool, rpc: o.rpc })
  let price = 1
  const accounts = new PaperAccounts({ speed: null, store, priceOf: () => price, params: s => STRATEGIES[s], live })
  return { store, accounts, wallet, live, setPrice: (p: number) => { price = p } }
}
const sig = (o: Partial<PaperSignal> = {}): PaperSignal => ({ id: 's1', token: T, symbol: 'COIN', launchpad: 'Argus', price: 1, strategy: 'scalp', roundTripPct: 2, liquidityUsd: 50_000, ...o })
/** A closed paper trade that won or lost. */
function paperTrade(i: number, win: boolean): Position {
  const p = openPosition({ id: `p${i}`, strategy: 'scalp', token: `0x${String(i).padStart(40, '0')}`, symbol: 'X', launchpad: 'Argus', signalId: 'x', price: 1, cost: 0.01, now: now - 3_600_000 + i * 60_000 })
  p.mode = 'paper'
  recordSell(p, p.qty, p.qty * (win ? 1.2 : 0.9), p.openedAt + 60_000, win ? 'tp1' : 'stop')
  return p
}

describe('bots: unique names, owners and the marketplace', () => {
  test('a name is unique on the platform, whatever its case or spacing', () => {
    const { accounts } = setupBots()
    expect(slugOf('Night  Owl!')).toBe('night-owl')
    expect('account' in accounts.create(now, { name: 'Night Owl', strategies: ['scalp'] }, 'u1')!).toBe(true)
    expect(accounts.create(now, { name: 'night owl', strategies: ['scalp'] }, 'u2')).toEqual({ error: expect.stringMatching(/"night owl" is taken/) })
    const other = accounts.create(now, { name: 'Moon', strategies: ['scalp'] }, 'u2') as { account: PaperAccount }
    expect(accounts.act(other.account, { action: 'rename', name: 'NIGHT-OWL' }, now)).toMatch(/taken/)
    expect(accounts.act(other.account, { action: 'rename', name: 'Sun' }, now)).toBeNull()
    expect(accounts.bySlugOf('moon')).toBeNull()
    expect(accounts.bySlugOf('sun')?.id).toBe(other.account.id)
  })
  test('an account has its own bots (5 at most); a browser-key bot can be claimed', () => {
    const { accounts } = setupBots()
    for (let i = 0; i < 5; i++) accounts.create(now, { name: `Bot ${i}`, strategies: ['scalp'] }, 'owner')
    expect(accounts.create(now, { name: 'One more', strategies: ['scalp'] }, 'owner')).toEqual({ error: 'an account can have 5 bots' })
    const anon = accounts.create(now, { name: 'Anon', strategies: ['scalp'] }) as { key: string; account: PaperAccount }
    expect(accounts.claim(anon.key, 'owner', now)).toBe('an account can have 5 bots')
    expect((accounts.claim(anon.key, 'friend', now) as PaperAccount).ownerId).toBe('friend')
    expect(accounts.claim(anon.key, 'thief', now)).toBe('this bot belongs to another account')
    expect(accounts.owned('owner', 'anon')).toBeNull()
    expect(accounts.owned('friend', 'anon')?.name).toBe('Anon')
  })
  test('15% of a winning trade\'s profit goes to the platform; a loss pays nothing', () => {
    expect(profitFee(10)).toBe(1.5)
    expect(profitFee(-3)).toBe(0)
    const { accounts, setPrice } = setupBots()
    const a = (accounts.create(now, { name: 'Payer', strategies: ['scalp'] }, 'u') as { account: PaperAccount }).account
    accounts.act(a, { action: 'deposit', amount: 100 }, now); accounts.act(a, { action: 'start' }, now)
    accounts.onSignal(sig(), now)
    setPrice(1.2)
    accounts.onPrice(T, 1.2, now + 1_000, false, true) // half sold at the take-profit
    const p = a.positions[0]
    expect(p.status).toBe('open')
    expect(p.feeUsd).toBeUndefined() // the fee is on the trade's profit, once it's closed
    setPrice(1.0)
    accounts.onPrice(T, 1.0, now + 1_500, false, true) // the rest at the break-even stop
    expect(p.status).toBe('closed')
    const gross = (p.pnlUsd ?? 0) + (p.feeUsd ?? 0)
    expect(gross).toBeGreaterThan(0)
    expect(p.feeUsd).toBeCloseTo(gross * 0.15, 4)
    expect(a.feesPaidUsd).toBeCloseTo(p.feeUsd!, 6)
    expect(p.note).toMatch(/Took half the profit/)
    accounts.onSignal(sig({ id: 's2', token: '0x' + 'c3'.repeat(20) }), now + 2_000)
    accounts.onPrice('0x' + 'c3'.repeat(20), 0.8, now + 3_000, false, true)
    expect(a.positions[1]).toMatchObject({ exitReason: 'stop' })
    expect(a.positions[1].feeUsd).toBeUndefined()
  })
  test('the marketplace shows every funded bot with its P&L and open positions, and never its owner', async () => {
    const { accounts, setPrice } = setupBots()
    const a = (accounts.create(now, { name: 'Leader', strategies: ['scalp'] }, 'secret-owner') as { account: PaperAccount }).account
    accounts.create(now, { name: 'Idle', strategies: ['scalp'] }, 'x') // never funded: not listed
    accounts.act(a, { action: 'deposit', amount: 100 }, now); accounts.act(a, { action: 'start' }, now)
    accounts.onSignal(sig(), now)
    setPrice(1.1)
    const { bots, total } = accounts.market('pnl', 10, now)
    expect(total).toBe(1)
    expect(bots[0]).toMatchObject({ slug: 'leader', name: 'Leader', mode: 'paper', running: true, positions: [{ symbol: 'COIN', mode: 'paper' }] })
    expect(bots[0].positions[0].pnlUsd!).toBeGreaterThan(0)
    expect(JSON.stringify(bots)).not.toContain('secret-owner')
    const d = await accounts.publicDetail('LEADER', now)
    expect(d?.slug).toBe('leader')
  })
})

describe('live: the same bot, from paper to its own wallet', () => {
  const owner = { verified: true }
  function readyBot(o: Parameters<typeof setupBots>[0] = {}) {
    const s = setupBots(o)
    const a = (s.accounts.create(now, { name: 'Pro', strategies: ['scalp'] }, 'owner') as { account: PaperAccount }).account
    for (let i = 0; i < READY.minTrades; i++) a.positions.push(paperTrade(i, i % 4 !== 0)) // 75% won
    return { ...s, a }
  }
  test('many live bots, one signal: they share its cap in a fair order, with staggered take-profits (bot/crowd.ts)', async () => {
    const s = setupBots({ balance: 1_000 })
    const bots: PaperAccount[] = []
    for (let k = 0; k < 6; k++) {
      const a = (s.accounts.create(now, { name: `Crowd ${k}`, strategies: ['scalp'] }, `owner${k}`) as { account: PaperAccount }).account
      for (let i = 0; i < READY.minTrades; i++) a.positions.push({ ...paperTrade(i, i % 4 !== 0), id: `c${k}-${i}` })
      s.accounts.createWallet(a, now)
      expect(await s.accounts.setMode(a, 'live', owner, now)).toBeNull()
      s.accounts.act(a, { action: 'start' }, now)
      bots.push(a)
    }
    // A $1,334 pool, a +6% take-profit (the quick exits): the bots together buy at most $10 (a quarter of the take-profit in price impact). Each wants $2 (the live base: nothing made yet).
    s.accounts.onSignal(sig({ id: 'crowd-1', liquidityUsd: 1_334 }), Date.now(), { signal: { id: 'crowd-1', token: T, strategy: 'scalp' } as never, pool, meta: { token: T, symbol: 'COIN', launchpad: 'Argus' } as never })
    await settle()
    const live = bots.map(a => a.positions.find(p => p.mode === 'live' && p.signalId === 'crowd-1'))
    const inIt = live.filter(Boolean)
    expect(inIt).toHaveLength(5)
    expect(s.wallet.calls.filter(c => c.startsWith('buy '))).toEqual(['buy 2', 'buy 2', 'buy 2', 'buy 2', 'buy 2'])
    const byRank = [...inIt].sort((x, y) => x!.crowd!.rank - y!.crowd!.rank)
    expect(byRank.map(p => p!.exits!.tp1Multiple)).toEqual([1.06, 1.0627, 1.0653, 1.068, 1.0706])
    expect(byRank[0]!.crowd).toMatchObject({ bots: 5, usd: 10, capUsd: 10 })
    const out = bots[live.findIndex(p => !p)]
    expect(out.skips[0].text).toMatch(/bots already bought \$10\.00 of this coin, its cap \(\$10\.00.*you're ahead next time/)
    // The next signal: the bot left out goes first.
    const T2 = '0x' + 'b2'.repeat(20)
    s.accounts.onSignal(sig({ id: 'crowd-2', token: T2, liquidityUsd: 1_334 }), Date.now(), { signal: { id: 'crowd-2', token: T2, strategy: 'scalp' } as never, pool: { ...pool, currency1: T2 as Address, base: T2 as Address }, meta: { token: T2, symbol: 'TWO', launchpad: 'Argus' } as never })
    await settle()
    expect(out.positions.find(p => p.signalId === 'crowd-2')?.crowd?.rank).toBe(0)
  })
  test('a live bot trades Prime signals with Precision, and passes over grades not proven at live speed', async () => {
    const { accounts, a, wallet } = readyBot({ balance: 100 })
    accounts.createWallet(a, now)
    await accounts.setMode(a, 'live', owner, now)
    accounts.act(a, { action: 'start' }, now)
    const ctx = (id: string, token: string) => ({ signal: { id, token, strategy: 'scalp' } as never, pool: { ...pool, currency1: token as Address, base: token as Address }, meta: { token, symbol: 'COIN', launchpad: 'Argus' } as never })
    const prime = { score: 80, grade: 'live' as const, tier: 'A' as const, rank: null, parts: [], level: 'prime' as const, liveOk: true, liveWhy: null }
    accounts.onSignal(sig({ id: 'pr1', quality: prime }), Date.now(), ctx('pr1', T))
    await settle()
    const p = a.positions.find(x => x.mode === 'live' && x.signalId === 'pr1')!
    expect(p).toMatchObject({ strategy: 'precision', grade: 'prime', sizeUsd: 2 }) // the $2 live base: its trades haven't made anything yet
    expect(p.exits).toMatchObject({ tp1Multiple: 1.1, tp1SellPct: 1 })
    const T2 = '0x' + 'b3'.repeat(20)
    const standard = { ...prime, level: 'standard' as const, liveOk: false, liveWhy: 'live bots trade Prime signals, and other grades once proven at live speed' }
    accounts.onSignal(sig({ id: 'st1', token: T2, quality: standard }), Date.now(), ctx('st1', T2))
    await settle()
    expect(a.positions.some(x => x.signalId === 'st1')).toBe(false)
    expect(a.skips[0].text).toMatch(/not traded live: live bots trade Prime signals/)
    expect(wallet.calls.filter(c => c.startsWith('buy '))).toEqual(['buy 2'])
  })
  test('ready once the paper record is: 20 trades, 55% won, a profit factor of 1.2, a net profit', () => {
    expect(readiness([paperTrade(1, true)]).ok).toBe(false)
    const { a } = readyBot()
    const r = readiness(a.positions)
    expect(r).toMatchObject({ ok: true, trades: 20 })
    expect(r.winRate).toBe(0.75)
  })
  test('going live needs the engine\'s secret, a signed-in owner, the record, a wallet and $10 in it (no verified email)', async () => {
    expect(await readyBot({ live: false }).accounts.setMode(readyBot({ live: false }).a, 'live', owner, now)).toMatch(/BOT_WALLET_SECRET/)
    const { accounts, a, wallet } = readyBot({ balance: 5 })
    expect(await accounts.setMode(a, 'live', null, now)).toMatch(/sign in/)
    expect(await accounts.setMode(a, 'live', { verified: false }, now)).toMatch(/make its live wallet first/)
    expect(await accounts.setMode(a, 'live', owner, now)).toMatch(/make its live wallet first/)
    expect(accounts.createWallet(a, now)).toBeNull()
    expect(a.live!.address).toMatch(/^0x[0-9a-f]{40}$/)
    expect(a.live!.enc).toMatch(/^v1:/)
    expect(JSON.stringify(a)).not.toMatch(/0x[0-9a-f]{64}/) // the key is never stored in the clear
    expect(await accounts.setMode(a, 'live', owner, now)).toMatch(/send at least \$10/)
    wallet.o.balance = 100
    expect(await accounts.setMode(a, 'live', owner, now)).toBeNull()
    expect(a).toMatchObject({ mode: 'live', live: { startBalanceUsd: 100 } })
    const notReady = setupBots()
    const b = (notReady.accounts.create(now, { name: 'Newbie', strategies: ['scalp'] }, 'owner') as { account: PaperAccount }).account
    notReady.accounts.createWallet(b, now)
    expect(await notReady.accounts.setMode(b, 'live', owner, now)).toMatch(/not ready yet: it needs 20\+ closed paper trades \(has 0\)/)
  })
  test('a live bot buys $2 from its wallet, sells all of it at the quick take-profit (+6%), and sends 15% of the profit to the fee wallet', async () => {
    const { accounts, a, wallet } = readyBot({ balance: 100, sellAt: 1.2 })
    accounts.createWallet(a, now)
    await accounts.setMode(a, 'live', owner, now)
    accounts.act(a, { action: 'start' }, now)
    const signal = { id: 'sig-live', token: T, strategy: 'scalp' } as never
    accounts.onSignal(sig(), Date.now(), { signal, pool, meta: { token: T, symbol: 'COIN', launchpad: 'Argus' } as never })
    await settle()
    const p = a.positions.find(x => x.mode === 'live')!
    expect(wallet.calls[0]).toMatch(/^buy \d+(\.\d+)?$/)
    expect(p).toMatchObject({ status: 'open', strategy: 'scalp', sizeUsd: 2, tuningVersion: 1, grade: 'standard' }) // the $2 live base
    expect(p.crowd).toMatchObject({ rank: 0, bots: 1, usd: 2 })
    expect(p.targetUsd).toBeGreaterThan(0)
    expect(p.exits).toMatchObject({ tp1Multiple: 1.06, tp1SellPct: 1, stopLoss: 0.93, maxHoldMin: 10 })
    expect(accounts.holds(T)).toBe(true)
    expect(p.feeUsd).toBeUndefined()
    accounts.onPrice(T, 1.2, Date.now(), false, true) // past +6%: all of it sold
    await settle()
    expect(p).toMatchObject({ status: 'closed', exitReason: 'tp1' })
    expect(p.feeUsd).toBeGreaterThan(0)
    expect(wallet.calls).toContain(`send ${p.feeUsd} to ${PROFIT_FEE.wallet}`)
    expect(p.txs?.some(t => t.kind === 'fee')).toBe(true)
    expect(p.feeDue).toBe(0)
    expect(accounts.view(a).live).toMatchObject({ closed: 1, feesPaidUsd: p.feeUsd })
  })
  test('live trades start at $2 and grow in step with what the trades made (2026-10-01)', async () => {
    const { accounts, a, wallet, live, setPrice } = readyBot({ balance: 10, sellAt: 1.2 })
    accounts.createWallet(a, now)
    expect(await accounts.setMode(a, 'live', owner, now)).toBeNull()
    accounts.act(a, { action: 'start' }, now)
    expect(a.live).toMatchObject({ startBalanceUsd: 10, pnlUsd: 0 })
    const ctx = (id: string, token: string) => ({ signal: { id, token, strategy: 'scalp' } as never, pool: { ...pool, currency1: token as Address, base: token as Address }, meta: { token, symbol: 'COIN', launchpad: 'Argus' } as never })
    const token = (n: number) => '0x' + n.toString(16).padStart(2, '0').repeat(20)
    const refresh = () => live.balance(a.id, live.existing(a.id), true)
    // The first trade: $2, sold at the quick take-profit; what it made (after gas and the 15% fee) is its growth.
    accounts.onSignal(sig({ id: 'g1', token: token(0xd1) }), Date.now(), ctx('g1', token(0xd1)))
    await settle()
    expect(wallet.calls[0]).toBe('buy 2')
    setPrice(1.2)
    accounts.onPrice(token(0xd1), 1.2, Date.now(), false, true)
    await settle()
    const first = a.positions.find(p => p.signalId === 'g1')!
    expect(first).toMatchObject({ status: 'closed', exitReason: 'tp1' })
    expect(a.live!.pnlUsd).toBeCloseTo(first.pnlUsd!, 9)
    expect(first.pnlUsd!).toBeGreaterThan(0.3)
    // Made $5 on its $10 (50%): $3 a trade, once the wallet holds it.
    a.live!.pnlUsd = 5
    wallet.o.balance = 15
    await refresh()
    expect(accounts.view(a).live?.sizing).toEqual({ tradeUsd: 3, growthPct: 50, pnlUsd: 5 })
    setPrice(1)
    accounts.onSignal(sig({ id: 'g2', token: token(0xd2) }), Date.now(), ctx('g2', token(0xd2)))
    await settle()
    expect(wallet.calls.filter(c => c.startsWith('buy '))).toEqual(['buy 2', 'buy 3'])
    // Its profit withdrawn: above $2, a trade is at most 20% of what the wallet holds.
    a.live!.pnlUsd = 10
    wallet.o.balance = 10
    await refresh()
    expect(accounts.liveGrowth(a, 10)).toEqual({ sizeUsd: 2, growthPct: 100 })
    // A net loss never takes it under $2.
    a.live!.pnlUsd = -4
    expect(accounts.liveGrowth(a, 6).sizeUsd).toBe(2)
  })
  test('a fee that can\'t be sent yet is owed: held back from withdrawals and sent at the next try', async () => {
    const { accounts, a, wallet } = readyBot({ balance: 100, sellAt: 1.2 })
    accounts.createWallet(a, now)
    await accounts.setMode(a, 'live', owner, now)
    accounts.act(a, { action: 'start' }, now)
    const send = wallet.exec.sendUsdc.bind(wallet.exec)
    let down = true
    ;(wallet.exec as unknown as { sendUsdc: typeof send }).sendUsdc = async (to, usd) => { if (down) throw new Error('node busy'); return send(to, usd) }
    accounts.onSignal(sig(), Date.now(), { signal: { id: 'sig-fee', token: T, strategy: 'scalp' } as never, pool, meta: { token: T, symbol: 'COIN', launchpad: 'Argus' } as never })
    await settle()
    accounts.onPrice(T, 1.2, Date.now(), false, true)
    await settle()
    const p = a.positions.find(x => x.mode === 'live')!
    expect(p).toMatchObject({ status: 'closed', exitReason: 'tp1' })
    expect(p.feeUsd).toBeGreaterThan(0)
    expect(p.feeDue).toBe(p.feeUsd) // owed: the send failed
    expect(p.txs?.some(t => t.kind === 'fee')).toBe(false)
    const bal = wallet.o.balance
    expect(await accounts.withdrawable(a)).toBeCloseTo(Math.floor((bal - USER_LIVE.reserveUsd / 5 - p.feeUsd!) * 100) / 100, 6) // the fee stays in the wallet
    down = false
    accounts.tick(Date.now() + 61_000) // retried after a minute
    await settle()
    expect(p.feeDue).toBe(0)
    expect(wallet.calls).toContain(`send ${p.feeUsd} to ${PROFIT_FEE.wallet}`)
    expect(p.txs?.some(t => t.kind === 'fee')).toBe(true)
  })
  test('a small live wallet: no buy over 20% of what it is worth, read before the buy', async () => {
    const { accounts, a, wallet } = readyBot({ balance: 20, sellAt: 1.2 })
    accounts.createWallet(a, now)
    await accounts.setMode(a, 'live', owner, now)
    accounts.act(a, { action: 'start' }, now)
    accounts.onSignal(sig(), Date.now(), { signal: { id: 'sig-small', token: T, strategy: 'scalp' } as never, pool, meta: { token: T, symbol: 'COIN', launchpad: 'Argus' } as never })
    await settle()
    const bought = Number(/^buy (\d+(?:\.\d+)?)$/.exec(wallet.calls[0] ?? '')?.[1])
    expect(bought).toBeGreaterThan(0)
    expect(bought).toBeLessThanOrEqual(4) // 20% of $20
    expect(accounts.view(a).protections).toMatchObject({ maxTradeSharePct: 20 })
  })
  test('a rug alarm sells a live position at once; withdrawals go only where asked', async () => {
    const { accounts, a, wallet } = readyBot({ balance: 100, sellAt: 0.9 })
    accounts.createWallet(a, now)
    await accounts.setMode(a, 'live', owner, now)
    accounts.act(a, { action: 'start' }, now)
    accounts.onSignal(sig(), Date.now(), { signal: { id: 'x', token: T, strategy: 'scalp' } as never, pool, meta: { token: T, symbol: 'COIN', launchpad: 'Argus' } as never })
    await settle()
    accounts.onPrice(T, 0.97, Date.now(), false, true, { at: Date.now(), text: 'liquidity fell 50%' })
    await settle()
    const p = a.positions.find(x => x.mode === 'live')!
    expect(p).toMatchObject({ status: 'closed', exitReason: 'rug', note: 'Rug guard: liquidity fell 50%' })
    expect(p.feeUsd).toBeUndefined() // a loss pays no fee
    const to = '0x' + 'cd'.repeat(20) as Address
    expect(await accounts.withdraw(a, to, 10_000, now)).toEqual({ error: expect.stringMatching(/at most/) })
    expect(await accounts.withdraw(a, to, 20, now)).toEqual({ hash: '0xf' })
    expect(wallet.calls[wallet.calls.length - 1]).toBe(`send 20 to ${to}`)
  })
})

describe('why coins are passed over', () => {
  test('counted by each watched coin\'s main reason', () => {
    const f = new ScanFeed()
    const base = (t: string) => ({ token: t, symbol: 'C', launchpad: 'Argus', launchedAt: now, priceUsd: 1, marketCapUsd: 1, liquidityUsd: 1 })
    f.record(base('0x1'), { status: 'watching', stage: 'snipe', reasons: [], keys: ['snipe:buyers', 'scalp:move'] }, now)
    f.record(base('0x2'), { status: 'watching', stage: 'snipe', reasons: [], keys: ['snipe:buyers'] }, now)
    f.record(base('0x3'), { status: 'rejected', stage: 'safety', reasons: [], keys: ['safety:honeypot'] }, now)
    f.record(base('0x4'), { status: 'signal', stage: 'snipe', reasons: [], strategy: 'snipe' }, now)
    const r = f.rejections(now)
    expect(r.watching).toBe(3)
    expect(r.top[0]).toEqual({ key: 'snipe:buyers', label: 'snipe: not enough buyers yet', coins: 2 })
    expect(r.top[1]).toMatchObject({ key: 'safety:honeypot', coins: 1 })
  })
})

describe('the HTTP routes', () => {
  test('sign up, see my bots, create one, the marketplace, and withdrawals need a verified email', async () => {
    const { store, accounts } = setupBots()
    const mailer = new MemoryMailer()
    const users = new Users({ store, mailer, secret: 's' })
    const call = async (method: string, path: string, body?: unknown, token?: string) => {
      const req = new Request(`http://engine${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
      const res = await botApi(req, new URL(req.url), '9.9.9.9', { users, accounts }, (status, b) => new Response(JSON.stringify(b), { status }))
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }
    expect((await call('GET', '/v1/me')).status).toBe(401)
    const up = await call('POST', '/v1/auth/signup', { email: 'f@x.io', passcode: 'Ok42' })
    const token = up.body.token as string
    expect(up.status).toBe(200)
    const made = await call('POST', '/v1/me/bots', { name: 'Route Bot', strategies: ['scalp', 'snipe'] }, token)
    expect(made.status).toBe(200)
    expect(await call('POST', '/v1/me/bots/route-bot', { action: 'deposit', amount: 50 }, token)).toMatchObject({ status: 200 })
    const me = (await call('GET', '/v1/me', undefined, token)).body as unknown as MeResponse
    expect(me.user).toEqual({ email: 'f@x.io', verified: false, createdAt: expect.any(Number) })
    expect(me.bots.map(b => b.slug)).toEqual(['route-bot'])
    expect(me.bots[0].deposited).toBe(1_050) // a new bot starts with $1,000 of virtual USDC
    const market = await call('GET', '/v1/bots')
    expect((market.body.bots as { slug: string }[]).map(b => b.slug)).toEqual(['route-bot'])
    expect(JSON.stringify(market.body)).not.toContain('f@x.io')
    expect((await call('POST', '/v1/me/bots/route-bot/withdraw/code', { to: '0x' + 'cd'.repeat(20), amountUsd: 5 }, token)).body.error).toMatch(/verify your email/)
    const other = (await call('POST', '/v1/auth/signup', { email: 'g@x.io', passcode: 'Ok43' })).body.token as string
    expect((await call('POST', '/v1/me/bots/route-bot', { action: 'stop' }, other)).status).toBe(404) // not theirs
    expect((await call('POST', '/v1/auth/login', { email: 'f@x.io', passcode: 'Ok42' })).status).toBe(200)
  })

  test('without email: live with no verified email, and money out only with the passcode, back to a wallet that funded the bot', async () => {
    const funder = '0x' + 'f1'.repeat(20), dust = '0x' + 'd0'.repeat(20), stranger = '0x' + 'cd'.repeat(20)
    // The chain, as the engine reads it: $40 from the funder, $0.50 from a dust sender, $30 from a contract (a sale).
    const router = '0x' + 'ee'.repeat(20)
    const rpc: Rpc = {
      call: async <T>(method: string) => (method === 'eth_blockNumber' ? '0x200000' : null) as T,
      batch: async <T>(calls: { method: string; params: unknown[] }[]) => calls.map((c, i) => {
        if (c.method === 'eth_getCode') return ((c.params[0] as string) === router ? '0x6080' : '0x') as T
        const f = c.params[0] as { topics: string[] }
        if (i > 0) return [] as T
        const log = (from: string, usd: number, tx: string) => ({ address: USDC20, topics: [TRANSFER_TOPIC, pad(from as Hex), f.topics[2]], data: toHex(BigInt(Math.round(usd * 1e6))), blockNumber: '0x1', transactionHash: tx, logIndex: '0x0' })
        return [log(funder, 40, '0xa1'), log(dust, 0.5, '0xa2'), log(router, 30, '0xa3')] as T
      }),
    }
    const { store, accounts, wallet } = setupBots({ rpc, balance: 100 })
    const users = new Users({ store, mailer: new NoMailer(), secret: 's' })
    const call = async (method: string, path: string, body?: unknown, token?: string) => {
      const req = new Request(`http://engine${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
      const res = await botApi(req, new URL(req.url), '9.9.9.9', { users, accounts }, (status, b) => new Response(JSON.stringify(b), { status }))
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }
    const token = (await call('POST', '/v1/auth/signup', { email: 'h@x.io', passcode: 'Ok42' })).body.token as string
    await call('POST', '/v1/me/bots', { name: 'No Mail', strategies: ['scalp'] }, token)
    const a = accounts.bySlugOf('no-mail')!
    for (let i = 0; i < READY.minTrades; i++) a.positions.push(paperTrade(i, i % 4 !== 0))
    expect((await call('POST', '/v1/me/bots/no-mail', { action: 'live-wallet' }, token)).status).toBe(200)
    expect(await call('POST', '/v1/me/bots/no-mail', { action: 'mode', mode: 'live' }, token)).toMatchObject({ status: 200, body: { account: { mode: 'live' } } })
    // The funders: the $40 wallet; not the $0.50 one (under $1 and 5%), not the contract.
    expect((await call('GET', '/v1/me/bots/no-mail/funders', undefined, token)).body).toEqual({ funders: [{ address: funder, usd: 40 }], known: true })
    const out = (to: string, passcode: string) => call('POST', '/v1/me/bots/no-mail/withdraw', { to, amountUsd: 10, passcode }, token)
    expect(await out(funder, 'Nope')).toMatchObject({ status: 401, body: { error: 'wrong passcode' } })
    expect((await out(stranger, 'Ok42')).body.error).toMatch(/goes back only to a wallet that funded this bot/)
    expect((await out(dust, 'Ok42')).body.error).toMatch(/funded this bot/)
    expect(await out(funder, 'Ok42')).toMatchObject({ status: 200, body: { hash: '0xf' } })
    expect(wallet.calls[wallet.calls.length - 1]).toBe(`send 10 to ${funder}`)
    // Wrong passcodes count toward the sign-in lockout.
    for (let i = 0; i < AUTH.maxFails; i++) await out(funder, 'Nope')
    expect((await out(funder, 'Ok42')).body.error).toMatch(/too many wrong passcodes/)
  })
})

describe('profit notifications (GET /v1/me/profits)', () => {
  test('an owner\'s winning trades since a moment, newest first; losses and other owners\' bots left out', () => {
    const { accounts } = setupBots()
    const mine = (accounts.create(now, { name: 'Winner', strategies: ['scalp'] }, 'owner') as { account: PaperAccount }).account
    const theirs = (accounts.create(now, { name: 'Someone Else', strategies: ['scalp'] }, 'other') as { account: PaperAccount }).account
    mine.positions.push(paperTrade(1, true), paperTrade(2, false), paperTrade(3, true))
    theirs.positions.push(paperTrade(4, true))
    const all = accounts.profitsOf('owner', 0)
    expect(all.map(p => p.id)).toEqual(['p3', 'p1'])
    expect(all[0]).toMatchObject({ bot: 'Winner', slug: 'winner', mode: 'paper', symbol: 'X' })
    expect(all[0].pnlUsd).toBeGreaterThan(0)
    expect(accounts.profitsOf('owner', all[1].closedAt).map(p => p.id)).toEqual(['p3'])
    expect(accounts.profitsOf('nobody', 0)).toEqual([])
  })
})
