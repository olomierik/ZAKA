// The admin panel (engine/src/admin): sign-in with a nonce, expiry and replay protection, the allowlist, sessions and
// their audit; runtime flags (a signed change, protective flags only tightened); the fee sweeper (dry runs equal real
// runs, a second run the same day does nothing, failures and pauses alert); the routes; visitors by section.
import { describe, expect, test } from 'bun:test'
import { verifyMessage, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { AdminAuth, ADMIN_AUTH, adminSignInMessage } from '../src/admin/auth'
import { FeatureFlags, FLAGS_KEY } from '../src/admin/flags'
import { Sweeper, cronMinuteOfDay, report, MemorySweepStore, type OwedFee } from '../src/admin/sweeper'
import { AdminApi } from '../src/admin/api'
import { ControlVerifier } from '../src/bot/control'
import { MemoryBotStore, PostgresBotStore } from '../src/bot/store'
import { Traffic } from '../src/traffic'
import { flagChangeMessage, sweepRunMessage } from '../../api/_marketProtocol'
import { setLogLevel } from '../src/log'

setLogLevel('error')
// Anvil's published test keys: never funded on any real chain.
const admin = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const stranger = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a3d4cb8e6dc8fb8e6d0' as Hex)
const SITE = 'https://arcsense.site'
const T0 = Date.parse('2026-10-16T01:00:00Z')

function setup(over: Partial<ConstructorParameters<typeof AdminAuth>[0]> = {}) {
  const store = new MemoryBotStore()
  const alerts: string[] = []
  const auth = new AdminAuth({
    admins: [admin.address.toLowerCase()], origins: [SITE], ttlMinutes: 30,
    signedBy: (address, message, signature) => verifyMessage({ address, message, signature }),
    audit: store, alert: t => alerts.push(t), ...over,
  })
  return { store, alerts, auth }
}

async function signIn(auth: AdminAuth, who = admin, now = T0) {
  const n = auth.nonce({ address: who.address }, SITE, '1.2.3.4', now)
  if ('status' in n) throw new Error(n.error)
  const signature = await who.signMessage({ message: n.message })
  return { n, signature, r: await auth.verify({ nonce: n.nonce, signature }, SITE, '1.2.3.4', 'Firefox', now + 1_000) }
}

describe('admin sign-in', () => {
  test('the message names the site, the wallet, the nonce and when it expires (EIP-4361)', () => {
    const m = adminSignInMessage({ origin: SITE, address: admin.address, nonce: 'abc12345', issuedAt: T0, expiresAt: T0 + 300_000 })
    expect(m.split('\n')[0]).toBe('arcsense.site wants you to sign in with your Ethereum account:')
    expect(m).toContain(`\n${admin.address}\n`)
    expect(m).toContain('Nonce: abc12345')
    expect(m).toContain('Chain ID: 5042')
    expect(m).toContain(`Expiration Time: ${new Date(T0 + 300_000).toISOString()}`)
  })

  test('an admin signs in; the session works, is audited with IP and device, and alerts', async () => {
    const { store, alerts, auth } = setup()
    const { r } = await signIn(auth)
    expect('token' in r).toBe(true)
    if (!('token' in r)) return
    expect(r.expiresAt).toBe(T0 + 1_000 + 30 * 60_000)
    expect(auth.session(`Bearer ${r.token}`, T0 + 60_000)?.address).toBe(admin.address)
    const log = await store.audit(5)
    expect(log[0]).toMatchObject({ actor: admin.address.toLowerCase(), action: 'admin.login', detail: { ip: '1.2.3.4', device: 'Firefox' } })
    expect(alerts[0]).toContain('admin sign-in')
  })

  test('a replayed signature is refused: the nonce is spent on first use', async () => {
    const { auth } = setup()
    const { n, signature } = await signIn(auth)
    const again = await auth.verify({ nonce: n.nonce, signature }, SITE, '1.2.3.4', 'Firefox', T0 + 2_000)
    expect(again).toEqual({ status: 401, error: expect.stringContaining('already used') })
  })

  test('an expired request is refused', async () => {
    const { auth } = setup()
    const n = auth.nonce({ address: admin.address }, SITE, 'ip', T0)
    if ('status' in n) throw new Error()
    const signature = await admin.signMessage({ message: n.message })
    const r = await auth.verify({ nonce: n.nonce, signature }, SITE, 'ip', null, T0 + ADMIN_AUTH.nonceTtlMs + 1)
    expect(r).toEqual({ status: 401, error: expect.stringContaining('expired') })
  })

  test('a wallet not on the allowlist is refused, even with a valid signature', async () => {
    const { auth } = setup()
    const { r } = await signIn(auth, stranger)
    expect(r).toEqual({ status: 403, error: 'this wallet is not an admin' })
  })

  test('a signature by another key, or from another site, is refused; a failed try spends the nonce', async () => {
    const { auth } = setup()
    let n = auth.nonce({ address: admin.address }, SITE, 'ip', T0)
    if ('status' in n) throw new Error()
    const forged = await stranger.signMessage({ message: n.message })
    expect(await auth.verify({ nonce: n.nonce, signature: forged }, SITE, 'ip', null, T0)).toEqual({ status: 401, error: expect.stringContaining('does not match') })
    const good = await admin.signMessage({ message: n.message })
    expect(await auth.verify({ nonce: n.nonce, signature: good }, SITE, 'ip', null, T0)).toEqual({ status: 401, error: expect.stringContaining('already used') })
    n = auth.nonce({ address: admin.address }, SITE, 'ip', T0)
    if ('status' in n) throw new Error()
    const sig = await admin.signMessage({ message: n.message })
    expect(await auth.verify({ nonce: n.nonce, signature: sig }, 'https://evil.example', 'ip', null, T0)).toEqual({ status: 403, error: expect.stringContaining('same site') })
  })

  test('nonces only for the site, and only so many a minute from one IP', () => {
    const { auth } = setup()
    expect(auth.nonce({ address: admin.address }, 'https://evil.example', 'ip', T0)).toMatchObject({ status: 403 })
    expect(auth.nonce({ address: 'nope' }, SITE, 'ip', T0)).toMatchObject({ status: 400 })
    for (let i = 0; i < ADMIN_AUTH.noncesPerIpMinute; i++) expect('nonce' in auth.nonce({ address: admin.address }, SITE, 'ip9', T0)).toBe(true)
    expect(auth.nonce({ address: admin.address }, SITE, 'ip9', T0)).toMatchObject({ status: 429 })
    expect('nonce' in auth.nonce({ address: admin.address }, SITE, 'ip9', T0 + 60_000)).toBe(true)
  })

  test('sessions end when they expire, on logout, and all at once; each is audited', async () => {
    const { store, auth } = setup({ ttlMinutes: 5 })
    const a = (await signIn(auth)).r, b = (await signIn(auth)).r
    if (!('token' in a) || !('token' in b)) throw new Error()
    expect(auth.session(`Bearer ${a.token}`, T0 + 6 * 60_000)).toBeNull()
    const c = (await signIn(auth, admin, T0 + 10_000)).r
    if (!('token' in c)) throw new Error()
    expect(await auth.logout(`Bearer ${c.token}`, T0 + 20_000)).toBe(true)
    expect(auth.session(`Bearer ${c.token}`, T0 + 21_000)).toBeNull()
    const d = (await signIn(auth, admin, T0 + 30_000)).r
    if (!('token' in d)) throw new Error()
    expect(await auth.logoutAll(admin.address, T0 + 40_000)).toBe(2)
    expect(auth.session(`Bearer ${d.token}`, T0 + 41_000)).toBeNull()
    expect((await store.audit(10)).map(e => e.action)).toEqual(['admin.logout-all', 'admin.login', 'admin.logout', 'admin.login', 'admin.login', 'admin.login'])
    expect(auth.session('Bearer not-a-token-at-all-really', T0)).toBeNull()
    expect(auth.session(null, T0)).toBeNull()
  })

  test('no admin configured: sign-in says so', () => {
    const { auth } = setup({ admins: [] })
    expect(auth.nonce({ address: admin.address }, SITE, 'ip', T0)).toMatchObject({ status: 503 })
  })
})

const verifier = () => new ControlVerifier(null, [], a => verifyMessage(a))

describe('runtime flags', () => {
  const flagsFor = (store = new MemoryBotStore()) => {
    const v = verifier()
    return { store, flags: new FeatureFlags({ settings: store, audit: store, verify: (m, at, sig, now) => v.verifyAnyOf([admin.address.toLowerCase()], m, at, sig, now) }) }
  }
  const signed = async (flag: string, on: boolean, at = Date.now(), who = admin) => ({ flag, on, reason: 'testing it', at, signature: await who.signMessage({ message: flagChangeMessage(flag as never, on, 'testing it', at) }) })

  test('a signed change by the signed-in admin is applied, saved, audited, and read back after a restart', async () => {
    const { store, flags } = flagsFor()
    const r = await flags.change(await signed('jupiter', false), admin.address)
    expect(r.status).toBe(200)
    expect(flags.state().flags).toEqual({ jupiter: false })
    expect((await store.audit(1))[0]).toMatchObject({ action: 'flag.change', detail: { flag: 'jupiter', on: false } })
    const again = new FeatureFlags({ settings: store, audit: store, verify: async () => 'x' })
    await again.load()
    expect(again.state().flags).toEqual({ jupiter: false })
    expect(again.state().history[0]).toMatchObject({ flag: 'jupiter', on: false, reason: 'testing it' })
  })

  test('a protective flag can be turned on but never off at runtime', async () => {
    const { flags } = flagsFor()
    expect((await flags.change(await signed('withdrawLimits', true), admin.address)).status).toBe(200)
    const off = await flags.change(await signed('withdrawLimits', false), admin.address)
    expect(off.status).toBe(403)
    expect(String((off.body as { error: string }).error)).toContain('VITE_FLAG_WITHDRAW_LIMITS=off')
    expect(flags.state().flags.withdrawLimits).toBe(true)
  })

  test('refused: an unknown flag, a stranger\'s signature, another admin\'s session, a replay, a tampered change', async () => {
    const { flags } = flagsFor()
    expect((await flags.change({ ...(await signed('jupiter', true)), flag: 'everything' }, admin.address)).status).toBe(400)
    expect((await flags.change(await signed('jupiter', true, Date.now(), stranger), admin.address)).status).toBe(403)
    expect((await flags.change(await signed('jupiter', true), stranger.address)).body).toEqual({ error: 'sign with the wallet you signed in with' })
    const once = await signed('privy', true)
    expect((await flags.change(once, admin.address)).status).toBe(200)
    expect((await flags.change(once, admin.address)).status).toBe(403)
    expect((await flags.change({ ...(await signed('privy', true)), on: false }, admin.address)).status).toBe(403)
  })

  test('a malformed stored state is dropped flag by flag', async () => {
    const store = new MemoryBotStore()
    await store.setSetting(FLAGS_KEY, JSON.stringify({ at: 1, flags: { jupiter: false, bogus: true, privy: 'yes' } }))
    const f = new FeatureFlags({ settings: store, audit: store, verify: async () => 'x' })
    await f.load()
    expect(f.state().flags).toEqual({ jupiter: false })
  })
})

function sweeperFor(o: { owed?: OwedFee[]; relay?: { usd: number }[]; fail?: string; planFail?: boolean; paused?: string | null; min?: number } = {}) {
  const store = new MemoryBotStore()
  const runs = new MemorySweepStore()
  const alerts: string[] = []
  let owed = o.owed ?? [{ bot: 'night-owl', position: 'p1', usd: 6 }, { bot: 'kimi', position: 'p2', usd: 9 }]
  let sends = 0
  const sweeper = new Sweeper({
    store: runs, settings: store, audit: store, minUsd: o.min ?? 10,
    owedFees: () => owed,
    sendOwedFees: async () => {
      sends++
      if (o.fail) throw new Error(o.fail)
      const out = owed.map(f => ({ position: f.position, usd: f.usd, tx: `0x${f.position}` }))
      owed = []
      return out
    },
    relayBalances: async () => { if (o.planFail) throw new Error('relay 503'); return (o.relay ?? [{ usd: 42.5 }]).map((b, i) => ({ holder: `Relay 56:usdt${i}`, token: 'USDT', amount: String(b.usd), usd: b.usd })) },
    jupiterBalances: async () => [{ holder: 'RefAcct111', token: 'SOL', amount: '0.3', usd: null }],
    paused: () => o.paused ?? null,
    alert: t => alerts.push(t),
    schedule: { minuteOfDay: 3 * 60, mode: 'real' },
  })
  return { sweeper, runs, store, alerts, sends: () => sends }
}

describe('the fee sweeper', () => {
  test('the plan: bot fees to send, Relay and Jupiter to claim, small ones left under the threshold', async () => {
    const { sweeper } = sweeperFor({ relay: [{ usd: 42.5 }, { usd: 3 }] })
    const items = await sweeper.plan()
    expect(items.map(i => [i.source, i.action, i.below, i.usd])).toEqual([['bot-fees', 'engine', false, 15], ['relay', 'owner', false, 42.5], ['relay', 'owner', true, 3], ['jupiter', 'owner', false, null]])
  })

  test('a dry run acts on nothing, and its totals equal the real run\'s on the same state', async () => {
    const { sweeper, sends, alerts } = sweeperFor()
    const dry = await sweeper.run('dry', admin.address, T0)
    expect(sends()).toBe(0)
    expect(alerts).toEqual([])
    const real = await sweeper.run('real', admin.address, T0 + 1_000)
    expect(real.totals).toEqual(dry.totals)
    expect(dry.totals).toEqual({ engineUsd: 15, ownerUsd: 42.5, belowUsd: 0, items: 3 })
    expect(real).toMatchObject({ status: 'ok', sentUsd: 15 })
    expect(real.items[0].outcome).toEqual({ ok: true, tx: '0xp1' })
    expect(sends()).toBe(1)
    expect(alerts[0]).toContain('fee sweeper (real')
    expect(alerts[0]).toContain('to claim: claim at relay.link')
  })

  test('a second real run the same day is a no-op; the next day runs again', async () => {
    const { sweeper, sends, runs } = sweeperFor()
    await sweeper.run('real', admin.address, T0)
    const again = await sweeper.run('real', admin.address, T0 + 60_000)
    expect(again).toMatchObject({ status: 'noop', sentUsd: 0 })
    expect(sends()).toBe(1)
    const next = await sweeper.run('real', admin.address, T0 + 86_400_000)
    expect(next.status).toBe('ok')
    expect((await runs.sweepRuns(10)).map(r => r.status)).toEqual(['ok', 'noop', 'ok'])
  })

  test('a send that fails: partial, alerted, and the next run tries again (nothing is sent twice)', async () => {
    const s = sweeperFor({ fail: 'nonce too low' })
    const r = await s.sweeper.run('real', admin.address, T0)
    expect(r.status).toBe('partial')
    expect(r.items[0].outcome).toMatchObject({ ok: false, error: expect.stringContaining('nonce too low') })
    expect(s.alerts[0]).toContain('partial')
    expect((await s.sweeper.run('real', admin.address, T0 + 1_000)).status).toBe('partial')
    expect(s.sends()).toBe(2)
  })

  test('it can\'t read what\'s held: failed, alerted', async () => {
    const s = sweeperFor({ planFail: true })
    const r = await s.sweeper.run('real', admin.address, T0)
    expect(r).toMatchObject({ status: 'failed', note: expect.stringContaining('relay 503') })
    expect(s.alerts[0]).toContain('failed')
  })

  test('paused by the kill switch: nothing sent, the pause recorded and alerted', async () => {
    const s = sweeperFor({ paused: 'trading is off everywhere (the trade switch)' })
    const r = await s.sweeper.run('real', admin.address, T0)
    expect(r).toMatchObject({ status: 'paused', sentUsd: 0 })
    expect(s.sends()).toBe(0)
    expect(s.alerts[0]).toContain('paused')
  })

  test('bot fees under the threshold are listed and left alone', async () => {
    const s = sweeperFor({ owed: [{ bot: 'a', position: 'p', usd: 0.4 }] })
    const r = await s.sweeper.run('real', admin.address, T0)
    expect(r.items[0]).toMatchObject({ source: 'bot-fees', below: true })
    expect(r.items[0].outcome).toBeUndefined()
    expect(s.sends()).toBe(0)
  })

  test('the daily run: after its minute, once a day; real runs are audited', async () => {
    const s = sweeperFor()
    await s.sweeper.tick(Date.parse('2026-10-16T02:59:00Z'))
    expect(s.sends()).toBe(0)
    await s.sweeper.tick(Date.parse('2026-10-16T03:05:00Z'))
    await s.sweeper.tick(Date.parse('2026-10-16T03:10:00Z'))
    expect(s.sends()).toBe(1)
    expect((await s.store.audit(5)).map(e => [e.actor, e.action])).toEqual([['engine', 'sweep.run']])
  })

  test('SWEEPER_CRON\'s minute and hour; anything else is off', () => {
    expect(cronMinuteOfDay('0 3 * * *')).toBe(180)
    expect(cronMinuteOfDay('30 23 * * *')).toBe(23 * 60 + 30)
    expect(cronMinuteOfDay('*/5 * * * *')).toBeNull()
    expect(cronMinuteOfDay('0 25 * * *')).toBeNull()
    expect(report({ id: 'x', at: T0, day: '2026-10-16', mode: 'real', by: 'engine', status: 'ok', totals: { engineUsd: 0, ownerUsd: 0, belowUsd: 0, items: 0 }, sentUsd: 0, items: [] })).toContain('Sent $0.00')
  })
})

describe('the admin routes', () => {
  async function api() {
    const { store, auth } = setup()
    const v = verifier()
    const verify = (m: string, at: number, sig: Hex, now: number) => v.verifyAnyOf([admin.address.toLowerCase()], m, at, sig, now)
    const flags = new FeatureFlags({ settings: store, audit: store, verify })
    const { sweeper } = sweeperFor()
    const traffic = new Traffic(store)
    traffic.beat('visitor-aaaaaaaaaaaa', '9.9.9.9', Date.now(), 'futures')
    traffic.beat('visitor-bbbbbbbbbbbb', '9.9.9.9', Date.now(), 'nonsense')
    const a = new AdminApi({ auth, origins: [SITE], audit: store, verify, flags, sweeper, ledger: null, traffic, tradeSwitch: null, trades: null, bots: () => ({ bots: 3, running: 2, live: 1 }) })
    const call = (method: string, path: string, body?: unknown, token?: string, origin = SITE) => a.handle(new Request(`https://engine.test${path}`, {
      method, headers: { ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'user-agent': 'TestBrowser' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), new URL(`https://engine.test${path}`), '5.5.5.5', { wsClients: 7 })
    return { call, store }
  }

  test('sign in through the routes, then read; without a session everything but sign-in is refused', async () => {
    const { call } = await api()
    expect((await call('GET', '/v1/admin/live'))?.status).toBe(401)
    expect((await call('GET', '/v1/admin/audit', undefined, 'made-up-token-xxxxxxxxxx'))?.status).toBe(401)
    const n = (await call('POST', '/v1/admin/auth/nonce', { address: admin.address }))!.body as { nonce: string; message: string }
    const v = await call('POST', '/v1/admin/auth/verify', { nonce: n.nonce, signature: await admin.signMessage({ message: n.message }) })
    expect(v?.status).toBe(200)
    const token = (v!.body as { token: string }).token
    expect((await call('GET', '/v1/admin/me', undefined, token))?.body).toMatchObject({ address: admin.address })
    const live = (await call('GET', '/v1/admin/live', undefined, token))!.body as Record<string, unknown>
    expect(live).toMatchObject({ sockets: 7, bots: { bots: 3, running: 2, live: 1 }, traffic: { online: 2 } })
    expect((live.sections as Record<string, number>).futures).toBe(1)
    expect((live.sections as Record<string, number>).other).toBe(1)
    expect((live.admins as unknown[]).length).toBe(1)
    const fees = (await call('GET', '/v1/admin/fees', undefined, token))!.body as { plan: unknown[] }
    expect(fees.plan.length).toBe(3)
    const audit = (await call('GET', '/v1/admin/audit', undefined, token))!.body as { entries: { action: string }[] }
    expect(audit.entries[0].action).toBe('admin.login')
    expect((await call('GET', '/v1/admin/trades', undefined, token))?.status).toBe(503)
  })

  test('posts from another site are refused; a real sweep needs the admin\'s signature; a dry one doesn\'t', async () => {
    const { call } = await api()
    expect((await call('POST', '/v1/admin/auth/nonce', { address: admin.address }, undefined, 'https://evil.example'))?.status).toBe(403)
    const n = (await call('POST', '/v1/admin/auth/nonce', { address: admin.address }))!.body as { nonce: string; message: string }
    const token = ((await call('POST', '/v1/admin/auth/verify', { nonce: n.nonce, signature: await admin.signMessage({ message: n.message }) }))!.body as { token: string }).token
    expect((await call('POST', '/v1/admin/sweep', { mode: 'dry' }, token))?.body).toMatchObject({ run: { mode: 'dry', status: 'ok' } })
    expect((await call('POST', '/v1/admin/sweep', { mode: 'real' }, token))?.status).toBe(400)
    const at = Date.now()
    const bad = await stranger.signMessage({ message: sweepRunMessage(at) })
    expect((await call('POST', '/v1/admin/sweep', { mode: 'real', at, signature: bad }, token))?.status).toBe(403)
    const sig = await admin.signMessage({ message: sweepRunMessage(at) })
    expect((await call('POST', '/v1/admin/fees/claim', { at, signature: sig }, token))?.body).toMatchObject({ run: { mode: 'real', status: 'ok', sentUsd: 15 } })
  })

  test('with two admins, a real sweep is signed by the admin who is signed in, not the other one', async () => {
    const second = stranger
    const store = new MemoryBotStore()
    const admins = [admin.address.toLowerCase(), second.address.toLowerCase()]
    const auth = new AdminAuth({ admins, origins: [SITE], ttlMinutes: 30, signedBy: (address, message, signature) => verifyMessage({ address, message, signature }), audit: store })
    const v = verifier()
    const verify = (m: string, at: number, sig: Hex, now: number) => v.verifyAnyOf(admins, m, at, sig, now)
    const a = new AdminApi({ auth, origins: [SITE], audit: store, verify, flags: null, sweeper: sweeperFor().sweeper, ledger: null, traffic: null, tradeSwitch: null, trades: null, bots: null })
    const call = (path: string, body: unknown, token?: string) => a.handle(new Request(`https://engine.test${path}`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), new URL(`https://engine.test${path}`), 'ip')
    const n = (await call('/v1/admin/auth/nonce', { address: admin.address }))!.body as { nonce: string; message: string }
    const token = ((await call('/v1/admin/auth/verify', { nonce: n.nonce, signature: await admin.signMessage({ message: n.message }) }))!.body as { token: string }).token
    const at = Date.now()
    const r = await call('/v1/admin/sweep', { mode: 'real', at, signature: await second.signMessage({ message: sweepRunMessage(at) }) }, token)
    expect(r).toMatchObject({ status: 403, body: { error: 'sign with the wallet you signed in with' } })
  })

  test('the public flags, and a flag change through the routes', async () => {
    const { call } = await api()
    expect((await call('GET', '/v1/flags'))?.body).toMatchObject({ flags: {} })
    const n = (await call('POST', '/v1/admin/auth/nonce', { address: admin.address }))!.body as { nonce: string; message: string }
    const token = ((await call('POST', '/v1/admin/auth/verify', { nonce: n.nonce, signature: await admin.signMessage({ message: n.message }) }))!.body as { token: string }).token
    const at = Date.now()
    const signature = await admin.signMessage({ message: flagChangeMessage('walletsCard', false, 'not now', at) })
    expect((await call('POST', '/v1/admin/flags', { flag: 'walletsCard', on: false, reason: 'not now', at, signature }, token))?.status).toBe(200)
    expect((await call('GET', '/v1/flags'))?.body).toMatchObject({ flags: { walletsCard: false } })
    expect(await call('GET', '/v1/tokens/new')).toBeNull()
  })
})

// The sweep runs table against a real Postgres: PG_TEST_URL=postgres://… (skipped otherwise; use a scratch database).
const PG = process.env.PG_TEST_URL
describe.skipIf(!PG)('sweep runs in Postgres', () => {
  test('runs are added once and read back; updates, deletes and truncates are refused', async () => {
    const store = new PostgresBotStore(PG!)
    const id = `dry:2026-10-16:${Date.now()}`
    const run = { id, at: Date.now(), day: '2026-10-16', mode: 'dry' as const, by: admin.address.toLowerCase() as Address, status: 'ok' as const, totals: { engineUsd: 1, ownerUsd: 2, belowUsd: 0, items: 2 }, sentUsd: 0, items: [] }
    await store.appendSweepRun(run)
    await store.appendSweepRun({ ...run, status: 'failed' })
    expect((await store.sweepRuns(50)).find(r => r.id === id)?.status).toBe('ok')
    const { SQL } = await import('bun')
    const sql = new SQL(PG!)
    const refused = (q: PromiseLike<unknown>) => Promise.resolve(q).then(() => 'ran', (e: Error) => e.message)
    expect(await refused(sql`update arcdex_sweep_runs set status = 'x' where id = ${id}`)).toContain('append-only')
    expect(await refused(sql`delete from arcdex_sweep_runs where id = ${id}`)).toContain('append-only')
    expect(await refused(sql`truncate arcdex_sweep_runs`)).toContain('append-only')
  })
})
