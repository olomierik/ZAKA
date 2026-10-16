// A stand-in engine for checking the social layer locally (Phase 6): the engine's own social code (verified boards and
// profiles, the wash-trade filter, comments, reports, mutes, moderation) and admin code, in memory, with no chain.
// The trade book is seeded with made-up router trades: two honest traders, the test wallet, a volume farmer and two
// wallets trading against each other. Wallet sign-in (/api/session) checks the signature locally.
//
//   bun engine/scripts/social-standin.ts
//   then run the site with VITE_ARCDEX_WS_URL=ws://localhost:8787/ws and open http://localhost:5173/leaderboard
//
// Admin: Anvil's first published test account (ADMIN=0x… to change it). Sessions use a throwaway secret.

import { verifyMessage, type Hex } from 'viem'
import type { BookTrade } from '../src/social/pnl'
import type { TradeBook } from '../src/social/book'

// The session secret is read when api/_session.ts loads, and the social and admin code import it: set it first, then
// load them (static imports would run before this line).
process.env.ARCDEX_SESSION_SECRET ??= 'stand-in-secret-for-local-checks-only-0123456789'
const { issueToken, signInMessage, SIGN_IN_BRANDS } = await import('../../api/_session')
const { AdminAuth } = await import('../src/admin/auth')
const { AdminApi } = await import('../src/admin/api')
const { ControlVerifier } = await import('../src/bot/control')
const { MemoryBotStore } = await import('../src/bot/store')
const { SocialBoards } = await import('../src/social/boards')
const { Moderation } = await import('../src/social/moderation')
const { SocialApi } = await import('../src/social/api')

const PORT = Number(process.env.PORT ?? 8787)
const ADMIN = (process.env.ADMIN ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266').toLowerCase()
const ORIGINS = (process.env.ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(',')
const COIN = (process.env.COIN ?? '0x4b93446882d29e094181b2fae14b126577a2676c').toLowerCase()
const COIN2 = '0x00000000000000000000000000000000000c0102'
const usd = (n: number) => BigInt(Math.round(n * 1e6))

// ── the seeded trade book ────────────────────────────────────────────────
export const WALLETS = {
  alice: '0x00000000000000000000000000000000000a11ce',
  bob: '0x0000000000000000000000000000000000000b0b',
  me: ADMIN,
  farmer: '0x00000000000000000000000000000000000fa4a1',
  twinA: '0x00000000000000000000000000000000000a0a0a',
  twinB: '0x00000000000000000000000000000000000b0b0b',
}
const trades: BookTrade[] = []
let block = 30_000_000, at = Date.now() - 3 * 86_400_000, n = 0
const add = (trader: string, token: string, side: 'buy' | 'sell', usdc: number, tokens: bigint, gap = 1) => {
  block += gap; at += gap * 1_000; n++
  const tx = `0x${n.toString(16).padStart(64, '0')}`
  trades.push({ id: `${tx}:0`, router: '0xd07583f7db671521aacfda2b4612ad187aa2924e', tx, block, logIndex: 0, at, trader, token, side, usdc: usd(usdc), tokens, fee: usd(usdc * 0.005) })
}
add(WALLETS.alice, COIN, 'buy', 200, 1_000_000n * 10n ** 18n); add(WALLETS.alice, COIN, 'sell', 340, 1_000_000n * 10n ** 18n, 3_600)
add(WALLETS.alice, COIN2, 'buy', 50, 10n ** 21n, 60); add(WALLETS.alice, COIN2, 'sell', 41, 10n ** 21n, 900)
add(WALLETS.bob, COIN, 'buy', 120, 500_000n * 10n ** 18n, 30); add(WALLETS.bob, COIN, 'sell', 150, 250_000n * 10n ** 18n, 1_800); add(WALLETS.bob, COIN, 'sell', 95, 250_000n * 10n ** 18n, 600)
add(WALLETS.me, COIN, 'buy', 25, 100_000n * 10n ** 18n, 40); add(WALLETS.me, COIN, 'buy', 25, 80_000n * 10n ** 18n, 300); add(WALLETS.me, COIN, 'sell', 61.5, 180_000n * 10n ** 18n, 7_200)
for (let i = 0; i < 6; i++) { add(WALLETS.farmer, COIN2, 'buy', 50, 10n ** 22n, 20); add(WALLETS.farmer, COIN2, 'sell', 49.6, 10n ** 22n, 60) }
for (let i = 0; i < 4; i++) {
  add(WALLETS.twinA, COIN2, 'buy', 100, 5n * 10n ** 22n, 100); add(WALLETS.twinB, COIN2, 'sell', 99, 5n * 10n ** 22n, 1)
  add(WALLETS.twinB, COIN2, 'buy', 400, 49n * 10n ** 21n, 50); add(WALLETS.twinA, COIN2, 'sell', 395, 5n * 10n ** 22n, 1)
}
const book = {
  version: 1, size: trades.length, all: () => trades, of: (a: string) => trades.filter(t => t.trader === a.toLowerCase()),
  traders: () => [...new Set(trades.map(t => t.trader))], scannedTo: async () => block, checkedTo: async () => block - 5_000,
  checks: async () => [{ at: Date.now() - 3_600_000, from: 29_990_000, to: block - 5_000, trades: trades.length, ok: true, missing: [], extra: [], changed: [] }],
}

// ── theses (normally in the site's Supabase) and the rest ────────────────
export const THESES: Record<number, { author: string; body: string; token: string }> = {
  101: { author: WALLETS.alice, body: 'Volume is real here, holding for the bond.', token: COIN },
  102: { author: WALLETS.bob, body: 'Dev keeps building. Small bag.', token: COIN },
}
const store = new MemoryBotStore()
const v = new ControlVerifier(null, [], a => verifyMessage(a))
const verify = (m: string, t: number, sig: Hex, now: number) => v.verifyAnyOf([ADMIN], m, t, sig, now)
const moderation = new Moderation({ store, settings: store, audit: store, verify, thesis: async id => THESES[id] ?? null })
await moderation.load()
await moderation.comment(WALLETS.bob, 'thesis:101', 'Agreed, the buyers look organic.', Date.now() - 600_000)
await moderation.comment(WALLETS.farmer, `coin:arc:${COIN}`, 'FREE AIRDROP claim at https://arcdex-airdrop.example <img src=x onerror=alert(1)>', Date.now() - 300_000)
await moderation.comment(WALLETS.alice, `coin:arc:${COIN}`, 'Careful, that link above is a scam.', Date.now() - 200_000)
const social = new SocialApi({ book: book as unknown as TradeBook, boards: new SocialBoards(book), moderation, origins: ORIGINS })
const auth = new AdminAuth({ admins: [ADMIN], origins: ORIGINS, ttlMinutes: 30, signedBy: (address, message, signature) => verifyMessage({ address, message, signature }), audit: store, alert: t => console.log(`[alert] ${t}`) })
const admin = new AdminApi({ auth, origins: ORIGINS, audit: store, verify, flags: null, sweeper: null, ledger: null, traffic: null, tradeSwitch: null, trades: null, moderation, bots: null })

const cors = (req: Request) => ({ 'Access-Control-Allow-Origin': ORIGINS.includes(req.headers.get('origin') ?? '') ? req.headers.get('origin')! : ORIGINS[0], Vary: 'Origin', 'X-Arcdex-Served-By': 'stand-in' })
const json = (req: Request, status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } })

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(req), 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } })
    const s = await social.handle(req, url)
    if (s) return json(req, s.status, s.body)
    const r = await admin.handle(req, url, '127.0.0.1')
    if (r) return json(req, r.status, r.body)
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
    if (url.pathname === '/v1/flags') return json(req, 200, { at: 0, flags: {}, history: [] })
    if (url.pathname === '/v1/traffic/beat') return json(req, 200, { online: 1, today: 1, total: 1 })
    return json(req, 404, { error: 'not in the stand-in' })
  },
})
console.log(`social stand-in on http://localhost:${PORT} (admin ${ADMIN}, ${trades.length} trades, coin ${COIN})`)
