// A stand-in engine for checking copy trading locally (Phase 7): the engine's own copy code (copy/engine.ts, the
// routes, the rules) with its real wallet vault and the verified boards over a seeded trade book, in memory, with no
// chain. Copy wallets trade through an in-memory executor that fills at a fixed price after a short delay.
//
//   bun engine/scripts/copy-standin.ts
//   then run the site with VITE_ARCDEX_WS_URL=ws://localhost:8787/ws and open http://localhost:5173/copy
//
// Stand-in only (never on the real engine):
//   POST /standin/fund {address, usd}                 credits a copy wallet's USDC
//   POST /standin/trade {side, usd, token?, ago?}      a leader (Alice) trade through ARCDEX's router, copied as live
// Sessions use a throwaway secret; the vault a random one.

import { randomBytes } from 'node:crypto'
import { verifyMessage, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { BookTrade } from '../src/social/pnl'
import type { CopyExec } from '../src/copy/engine'
import type { PoolInfo } from '../src/dex/pools'
import type { Fill } from '../src/trading/live'

process.env.ARCDEX_SESSION_SECRET ??= 'stand-in-secret-for-local-checks-only-0123456789'
const { issueToken, signInMessage, SIGN_IN_BRANDS } = await import('../../api/_session')
const { SocialBoards } = await import('../src/social/boards')
const { CopyEngine, MemoryCopyStore } = await import('../src/copy/engine')
const { CopyApi } = await import('../src/copy/api')
const { leaderVerdict } = await import('../src/copy/rules')
const { WalletVault } = await import('../src/bot/userLive')
const { AdminAuth } = await import('../src/admin/auth')
const { AdminApi } = await import('../src/admin/api')
const { ControlVerifier } = await import('../src/bot/control')
const { MemoryBotStore } = await import('../src/bot/store')

const PORT = Number(process.env.PORT ?? 8787)
const ORIGINS = (process.env.ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(',')
// Admin (the /admin Copy trading tab): Anvil's first published test account.
const ADMIN = (process.env.ADMIN ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266').toLowerCase()
const COIN = '0x4b93446882d29e094181b2fae14b126577a2676c'
const BAD = '0x00000000000000000000000000000000000bad01'
const E18 = 10n ** 18n
const PER_USD = 50_000n // coins a dollar, in the pool and for every copy
const DELAY_MS = Number(process.env.DELAY_MS ?? 2_500)

// ── the seeded trade book: Alice qualifies (12 trades over 5 days), Bob doesn't (3 trades) ─────────
const ALICE = '0x00000000000000000000000000000000000a11ce', BOB = '0x0000000000000000000000000000000000000b0b'
const trades: BookTrade[] = []
let block = 31_000_000, at = Date.now() - 5 * 86_400_000, n = 0
const add = (trader: string, side: 'buy' | 'sell', usd: number, tokens: bigint, gap = 3_600) => {
  block += gap; at += gap * 1_000; n++
  const tx = `0x${n.toString(16).padStart(64, '0')}`
  const t: BookTrade = { id: `${tx}:0`, router: '0xd07583f7db671521aacfda2b4612ad187aa2924e', tx, block, logIndex: 0, at, trader, token: COIN, side, usdc: BigInt(Math.round(usd * 1e6)), tokens, fee: BigInt(Math.round(usd * 0.005 * 1e6)) }
  trades.push(t)
  return t
}
for (let i = 0; i < 6; i++) { add(ALICE, 'buy', 100, 4_000_000n * E18, 20_000); add(ALICE, 'sell', 115 + i * 3, 4_000_000n * E18, 30_000) }
add(BOB, 'buy', 50, 2_000_000n * E18); add(BOB, 'sell', 40, 2_000_000n * E18); add(BOB, 'buy', 20, 1_000_000n * E18)
const book = {
  version: 1, get size() { return trades.length }, all: () => trades, of: (a: string) => trades.filter(t => t.trader === a.toLowerCase()),
  traders: () => [...new Set(trades.map(t => t.trader))], scannedTo: async () => block, checkedTo: async () => block, checks: async () => [],
}
const boards = new SocialBoards(book)

// ── copy wallets trade here ──────────────────────────────────────────────
const balances = new Map<string, number>()
const holdings = new Map<string, bigint>()
let txn = 0
class StandinExec implements CopyExec {
  constructor(readonly address: Address) {}
  async balanceUsd() { return balances.get(this.address.toLowerCase()) ?? 0 }
  async tokenBalance(token: Address) { return holdings.get(`${this.address.toLowerCase()}|${token}`) ?? 0n }
  async buy(_p: PoolInfo, token: Address, usd: number, _s: number, check?: (rt: never) => string | null, o: { guard?: () => string | null; floor?: bigint } = {}) {
    const stop = () => { const why = o.guard?.(); if (why) throw new Error(why) }
    stop()
    const quoted = BigInt(Math.round(usd * 1e6)) * PER_USD * E18 / 1_000_000n
    if (o.floor && quoted < o.floor) throw new Error('the price moved past the cap')
    const bad = check?.({ ok: true, lossPct: token === BAD ? 40 : 2 } as never)
    if (bad) throw new Error(`pre-flight: ${bad}`)
    await new Promise(r => setTimeout(r, DELAY_MS))
    stop()
    const a = this.address.toLowerCase()
    balances.set(a, (balances.get(a) ?? 0) - usd)
    holdings.set(`${a}|${token}`, (holdings.get(`${a}|${token}`) ?? 0n) + quoted)
    return { hash: `0x${(++txn).toString(16).padStart(64, 'c')}` as Hex, tokens: quoted, usd, gasUsd: 0.004, at: Date.now(), roundTrip: null }
  }
  async sell(_p: PoolInfo, token: Address, amount: bigint, _s: number, o: { guard?: () => string | null } = {}): Promise<Fill> {
    if (o.guard?.()) throw new Error(o.guard()!)
    await new Promise(r => setTimeout(r, DELAY_MS))
    const a = this.address.toLowerCase()
    holdings.set(`${a}|${token}`, (holdings.get(`${a}|${token}`) ?? 0n) - amount)
    const usd = Number((amount * 1_000_000n) / (PER_USD * E18)) / 1e6
    balances.set(a, (balances.get(a) ?? 0) + usd)
    return { hash: `0x${(++txn).toString(16).padStart(64, '5')}` as Hex, tokens: amount, usd, gasUsd: 0.004, at: Date.now() }
  }
  async approveForSale() { return [] }
  async sendUsdc(to: Address, usd: number): Promise<Fill> {
    const a = this.address.toLowerCase()
    if ((balances.get(a) ?? 0) < usd) throw new Error('insufficient funds')
    balances.set(a, (balances.get(a) ?? 0) - usd)
    console.log(`[standin] ${a} sent $${usd} to ${to}`)
    return { hash: `0x${(++txn).toString(16).padStart(64, '7')}` as Hex, tokens: 0n, usd, gasUsd: 0.004, at: Date.now() }
  }
}

const vault = new WalletVault(randomBytes(32).toString('hex'))
const leaderHolding = () => trades.filter(t => t.trader === ALICE).reduce((s, t) => s + (t.side === 'buy' ? t.tokens : -t.tokens), 0n)
const copy = new CopyEngine({
  store: new MemoryCopyStore(), vault,
  makeExec: key => new StandinExec(privateKeyToAccount(key).address),
  pool: () => ({ pool: '0xpool' } as unknown as PoolInfo),
  liquidityUsd: () => 50_000,
  symbol: t => (t === COIN ? 'ARCD' : 'SCAM'),
  screen: async t => (t === BAD ? { rating: 'danger', why: 'honeypot: the sale reverted' } : { rating: 'safe', why: null }),
  leader: async a => leaderVerdict(await boards.trader(a), Date.now()),
  leaders: async limit => (await boards.board('all', 100)).rows.filter(r => !leaderVerdict({ periods: { all: r.stats }, wash: null }, Date.now())).slice(0, limit)
    .map(r => ({ address: r.trader, realized: r.stats.realized, volume: r.stats.volume, trades: r.stats.trades, winRate: r.stats.counted ? r.stats.wins / r.stats.counted : null, first: r.stats.first })),
  leaderBalanceAt: async () => leaderHolding(),
  feeBps: () => 50,
  feeWallet: '0x274262A0321A0701b0A46a3576e07aE881c286Bb',
  on: () => null,
  tradingOn: () => true,
  verify: (address, message, signature) => verifyMessage({ address: address as Address, message, signature }),
  funders: async w => ({ list: [], ledger: w.funding ?? { scannedTo: 0, deposits: {}, contracts: [], wallets: [] } }),
  alert: t => console.log(`[alert] ${t}`),
})
await copy.load()
const api = new CopyApi({ engine: copy, origins: ORIGINS })
const store = new MemoryBotStore()
const v = new ControlVerifier(null, [], a => verifyMessage(a))
const auth = new AdminAuth({ admins: [ADMIN], origins: ORIGINS, ttlMinutes: 30, signedBy: (address, message, signature) => verifyMessage({ address, message, signature }), audit: store, alert: t => console.log(`[alert] ${t}`) })
const admin = new AdminApi({ auth, origins: ORIGINS, audit: store, verify: (m, t, sig, now) => v.verifyAnyOf([ADMIN], m, t, sig, now), flags: null, sweeper: null, ledger: null, traffic: null, tradeSwitch: null, trades: null, bots: null, copy: () => copy })

const cors = (req: Request) => ({ 'Access-Control-Allow-Origin': ORIGINS.includes(req.headers.get('origin') ?? '') ? req.headers.get('origin')! : ORIGINS[0], Vary: 'Origin', 'X-Arcdex-Served-By': 'stand-in' })
const json = (req: Request, status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } })

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(req), 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } })
    if (url.pathname === '/v1/flags') return json(req, 200, { at: Date.now(), flags: { copyTrading: true }, history: [] })
    const r = await api.handle(req, url)
    if (r) return json(req, r.status, r.body)
    const a = await admin.handle(req, url, '127.0.0.1')
    if (a) return json(req, a.status, a.body)
    if (url.pathname.startsWith('/v1/social/trader/')) return json(req, 200, await boards.trader(url.pathname.split('/').pop()!))
    if (req.method === 'POST' && url.pathname === '/standin/fund') {
      const b = await req.json() as { address: string; usd: number }
      balances.set(b.address.toLowerCase(), (balances.get(b.address.toLowerCase()) ?? 0) + b.usd)
      return json(req, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/standin/trade') {
      const b = await req.json() as { side: 'buy' | 'sell'; usd: number; token?: string; ago?: number }
      const tokens = BigInt(Math.round(b.usd * 1e6)) * PER_USD * E18 / 1_000_000n
      const t = add(ALICE, b.side, b.usd, b.side === 'sell' ? leaderHolding() / 2n || tokens : tokens, 1)
      t.at = Date.now() - (b.ago ?? 1_500)
      if (b.token) t.token = b.token.toLowerCase()
      void copy.onLeaderTrade(t, Date.now())
      return json(req, 200, { id: t.id })
    }
    if (req.method === 'POST' && url.pathname === '/api/session') {
      const b = await req.json().catch(() => null) as { address?: string; issuedAt?: string; nonce?: string; signature?: Hex } | null
      if (!b?.address || !b.issuedAt || !b.nonce || !b.signature) return json(req, 400, { error: 'Bad sign-in message' })
      for (const brand of SIGN_IN_BRANDS) {
        if (await verifyMessage({ address: b.address as Hex, message: signInMessage(b.address, b.issuedAt, b.nonce, brand), signature: b.signature }).catch(() => false)) {
          return json(req, 200, { address: b.address.toLowerCase(), ...await issueToken(b.address) })
        }
      }
      return json(req, 401, { error: 'Signature does not match this wallet' })
    }
    if (url.pathname === '/v1/trading/status') return json(req, 200, { at: Date.now(), on: true, all: null, venues: {}, env: { all: false, venues: [] }, history: [] })
    if (url.pathname === '/v1/traffic/beat') return json(req, 200, { online: 1, today: 1, total: 1 })
    return json(req, 404, { error: 'not in the stand-in' })
  },
})
console.log(`copy stand-in on http://localhost:${PORT} (leader ${ALICE}, ${trades.length} trades)`)
