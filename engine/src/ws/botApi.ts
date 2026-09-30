// The Autotrade account, dashboard and marketplace routes (owner's request,
// 2026-09-30). Everything a signed-in owner does goes through a session
// token (Authorization: Bearer …, bot/users.ts); the marketplace is public
// and never shows an owner.
//
//   POST /v1/auth/signup {email, passcode}        an account; its session
//   POST /v1/auth/login {email, passcode}         a session (5 wrong tries lock it 15 min)
//   POST /v1/auth/forgot {email}                  a new passcode by email (Resend)
//   POST /v1/auth/verify/send · /v1/auth/verify {code}   confirm the email
//   POST /v1/auth/passcode {current, next}        change it (other devices signed out)
//   POST /v1/auth/logout-all                      sign out every device
//   GET  /v1/me                                   the owner and every bot of theirs
//   POST /v1/me/bots {name, strategies}           a new bot
//   POST /v1/me/claim  (X-Paper-Key)              a browser-key bot joins the account
//   GET|POST /v1/me/bots/:slug                    one bot; POST acts on it (deposit, start, stop,
//                                                 strategies, rename, reset, mode, live-wallet, sell-live)
//   GET  /v1/me/bots/:slug/trades?limit&before    its whole trade log
//   POST /v1/me/bots/:slug/withdraw/code {to, amountUsd}   emails a code for exactly that
//   POST /v1/me/bots/:slug/withdraw {code}        sends it
//   GET  /v1/bots?sort=pnl|winrate|new|live       the marketplace
//   GET  /v1/bots/:slug                           one bot, public: positions, trades, what it learned

import type { MeResponse, PaperAction } from '../../../api/_marketProtocol'
import type { PaperAccount, PaperAccounts } from '../bot/paperAccounts'
import type { User, Users } from '../bot/users'
import { metrics } from '../metrics'

type Json = (status: number, body: unknown, cache?: string) => Response

const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return '' } }
const bearer = (req: Request) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? null
const money = (n: number) => `$${n.toFixed(2)}`

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get('content-length') ?? 0) > 4_096) return null
  const b = await req.json().catch(() => null)
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : null
}

export async function botApi(req: Request, url: URL, ip: string, d: { users: Users | null; accounts: PaperAccounts | null }, json: Json): Promise<Response> {
  const { users, accounts } = d
  if (!users || !accounts) return json(503, { error: 'bots are not running in this process' })
  const p = url.pathname
  const now = Date.now()

  // ── the marketplace (public) ──
  if (req.method === 'GET' && p === '/v1/bots') {
    const sort = url.searchParams.get('sort')
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100))
    return json(200, accounts.market(sort === 'winrate' || sort === 'new' || sort === 'live' ? sort : 'pnl', limit, now), 'public, max-age=5')
  }
  const pub = /^\/v1\/bots\/([^/]+)$/.exec(p)
  if (req.method === 'GET' && pub) {
    const bot = await accounts.publicDetail(decode(pub[1]), now)
    return bot ? json(200, { bot }, 'public, max-age=5') : json(404, { error: 'no bot by that name' })
  }

  if (req.method !== 'POST' && req.method !== 'GET') return json(405, { error: 'method not allowed' })

  // ── accounts ──
  const signedIn = (u: User, token: string) => {
    // A bot this browser made before accounts existed joins the account.
    const key = req.headers.get('x-paper-key')
    const claimed = key ? accounts.claim(key, u.id, now) : null
    if (claimed && typeof claimed !== 'string') accounts.flush()
    return json(200, { token, user: users.view(u), claimed: claimed && typeof claimed !== 'string' ? claimed.slug : null })
  }
  if (req.method === 'POST' && (p === '/v1/auth/signup' || p === '/v1/auth/login')) {
    const b = await readBody(req)
    if (!b) return json(400, { error: 'expected a JSON object' })
    const r = p.endsWith('signup') ? await users.signup(b.email, b.passcode, ip, now) : await users.login(b.email, b.passcode, ip, now)
    if ('error' in r) { metrics.inc(p.endsWith('signup') ? 'auth_signup_refused' : 'auth_login_refused'); return json(r.status, { error: r.error }) }
    metrics.inc(p.endsWith('signup') ? 'auth_signups' : 'auth_logins')
    return signedIn(r.user, r.token)
  }
  if (req.method === 'POST' && p === '/v1/auth/forgot') {
    const b = await readBody(req)
    const r = await users.forgot(b?.email, ip, now)
    return 'error' in r ? json(r.status, { error: r.error }) : json(200, { ok: true, message: 'If that email has an account, a new passcode is on its way.' })
  }

  const u = users.userOf(bearer(req), now)
  if (!u) return json(401, { error: 'sign in first' })

  if (req.method === 'POST' && p === '/v1/auth/verify/send') {
    const bad = await users.sendVerify(u, now)
    return bad ? json(400, { error: bad }) : json(200, { ok: true })
  }
  if (req.method === 'POST' && p === '/v1/auth/verify') {
    const b = await readBody(req)
    const bad = users.verify(u, b?.code, now)
    return bad ? json(400, { error: bad }) : json(200, { user: users.view(u) })
  }
  if (req.method === 'POST' && p === '/v1/auth/passcode') {
    const b = await readBody(req)
    const r = await users.changePasscode(u, b?.current, b?.next, now)
    return 'error' in r ? json(r.status, { error: r.error }) : json(200, { token: r.token, user: users.view(u) })
  }
  if (req.method === 'POST' && p === '/v1/auth/logout-all') { users.signOutEverywhere(u, now); return json(200, { ok: true }) }

  // ── the owner's bots ──
  if (req.method === 'GET' && p === '/v1/me') {
    const bots = accounts.ofOwner(u.id)
    await Promise.all(bots.map(a => accounts.refreshLive(a)))
    const me: MeResponse = { user: users.view(u), bots: bots.map(a => accounts.view(a, now)), email: users.mailEnabled, maxBots: 5, liveAvailable: accounts.liveAvailable }
    return json(200, me)
  }
  if (req.method === 'POST' && p === '/v1/me/bots') {
    const b = await readBody(req)
    if (!b) return json(400, { error: 'expected a JSON object' })
    const made = accounts.create(now, { name: b.name as string | undefined ?? '', strategies: b.strategies as never }, u.id)
    if (!made) return json(503, { error: 'Autotrade is full right now' })
    if ('error' in made) return json(400, { error: made.error })
    accounts.flush()
    metrics.inc('paper_accounts_created')
    return json(200, { account: accounts.view(made.account, now) })
  }
  if (req.method === 'POST' && p === '/v1/me/claim') {
    const r = accounts.claim(req.headers.get('x-paper-key'), u.id, now)
    if (typeof r === 'string') return json(400, { error: r })
    accounts.flush()
    return json(200, { account: accounts.view(r, now) })
  }

  const m = /^\/v1\/me\/bots\/([^/]+)(\/trades|\/withdraw\/code|\/withdraw)?$/.exec(p)
  const a: PaperAccount | null = m ? accounts.owned(u.id, decode(m[1])) : null
  if (!m) return json(404, { error: 'not found' })
  if (!a) return json(404, { error: 'no bot of yours by that name' })

  if (!m[2] && req.method === 'GET') { await accounts.refreshLive(a); return json(200, { account: accounts.view(a, now) }) }
  if (!m[2] && req.method === 'POST') {
    const b = await readBody(req) as PaperAction | null
    if (!b) return json(400, { error: 'expected a JSON object' })
    let bad: string | null
    if (b.action === 'mode') bad = await accounts.setMode(a, b.mode === 'live' ? 'live' : 'paper', u, now)
    else if (b.action === 'live-wallet') bad = accounts.createWallet(a, now)
    else if (b.action === 'sell-live') { accounts.sellLive(a, now); bad = null }
    else bad = accounts.act(a, b, now)
    if (bad) return json(400, { error: bad })
    accounts.flush()
    await accounts.refreshLive(a)
    return json(200, { account: accounts.view(a, now) })
  }
  if (m[2] === '/trades' && req.method === 'GET') {
    const n = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100))
    return json(200, { trades: await accounts.trades(a, n, Number(url.searchParams.get('before')) || undefined), total: a.tradesLogged })
  }
  if (m[2] === '/withdraw/code' && req.method === 'POST') {
    if (!u.verified) return json(400, { error: 'verify your email first: withdrawal codes go to it' })
    const b = await readBody(req)
    const to = typeof b?.to === 'string' ? b.to.trim() : ''
    const usd = Math.floor(Number(b?.amountUsd) * 100) / 100
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return json(400, { error: 'enter an Arc wallet address (0x…)' })
    if (a.live && to.toLowerCase() === a.live.address.toLowerCase()) return json(400, { error: 'that is the bot\'s own wallet' })
    const max = await accounts.withdrawable(a)
    if (max === null) return json(400, { error: 'this bot has no live wallet, or its balance can\'t be read' })
    if (!(usd > 0) || usd > max) return json(400, { error: `at most ${money(max)} can be withdrawn now` })
    const bad = await users.challenge(u, `withdraw:${a.id}`, JSON.stringify({ to: to.toLowerCase(), usd }), `Confirm a withdrawal from ${a.name}`,
      `Withdraw ${money(usd)} USDC from your bot "${a.name}" to ${to}. Enter this code in Autotrade to confirm; it works for 10 minutes.`,
      'Didn\'t ask for this? Don\'t enter the code, and change your passcode: someone may know it.', undefined, now)
    return bad ? json(400, { error: bad }) : json(200, { ok: true, message: `A code is on its way to ${u.email}.` })
  }
  if (m[2] === '/withdraw' && req.method === 'POST') {
    const b = await readBody(req)
    const r = users.confirm(u, `withdraw:${a.id}`, b?.code, now)
    if (typeof r !== 'string') return json(400, { error: r.error })
    const { to, usd } = JSON.parse(r) as { to: `0x${string}`; usd: number }
    const sent = await accounts.withdraw(a, to, usd, now)
    if ('error' in sent) return json(400, { error: sent.error })
    metrics.inc('bot_withdrawals')
    return json(200, { hash: sent.hash, account: accounts.view(a, now) })
  }
  return json(404, { error: 'not found' })
}
