// The trade switch (site/tradeSwitch.ts): trading off everywhere or on one venue, by an admin wallet's signed message;
// refused for strangers, replays, old and altered signatures; kept across a restart; GLOBAL_KILL_SWITCH and
// KILL_SWITCH_VENUES from the engine's settings; every change in the append-only audit log; and the HTTP routes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { verifyMessage } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tradeSwitchMessage, type TradeSwitchControl, type TradeSwitchState } from '../../api/_marketProtocol'
import { MemoryBotStore, PostgresBotStore } from '../src/bot/store'
import { ControlVerifier } from '../src/bot/control'
import { adminAddresses, type Config } from '../src/config'
import { setLogLevel } from '../src/log'
import { parseSwitchRequest, SWITCH_KEY, TradeSwitch } from '../src/site/tradeSwitch'
import { NullHistoryStore } from '../src/store/history'
import { MemoryHotStore } from '../src/store/hot'
import { DataApi, startServer } from '../src/ws/server'

setLogLevel('error')
// Anvil's published test keys: an admin and a stranger.
const admin = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const stranger = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const T0 = Date.UTC(2026, 9, 15, 12)

const checker = () => new ControlVerifier(null, [], a => verifyMessage(a))
function makeSwitch(o: { store?: MemoryBotStore; env?: { all: boolean; venues: ('arc' | 'solana' | 'bnb')[] } } = {}) {
  const store = o.store ?? new MemoryBotStore()
  const check = checker()
  const sw = new TradeSwitch({ settings: store, audit: store, env: o.env ?? { all: false, venues: [] }, verify: (m, at, sig, now) => check.verifyAnyOf([admin.address], m, at, sig, now) })
  return { sw, store }
}
const signed = async (c: TradeSwitchControl, at = T0, by = admin) => ({ ...c, at, signature: await by.signMessage({ message: tradeSwitchMessage(c, at) }) })

describe('the request', () => {
  test('a scope, on or off, a reason, a time and a signature; nothing else', () => {
    const sig = '0x' + '1'.repeat(130)
    expect(parseSwitchRequest({ scope: 'solana', on: false, reason: 'router exploit', at: T0, signature: sig })).toMatchObject({ control: { scope: 'solana', on: false, reason: 'router exploit' } })
    expect(parseSwitchRequest({ scope: 'all', on: true, reason: '  all   clear ', at: T0, signature: sig })).toMatchObject({ control: { reason: 'all clear' } })
    expect(parseSwitchRequest({ scope: 'mars', on: false, reason: 'x y z', at: T0, signature: sig })).toMatch(/"scope" must be "all" or one of arc/)
    expect(parseSwitchRequest({ scope: 'arc', on: 'no', reason: 'x y z', at: T0, signature: sig })).toBe('"on" must be true or false')
    expect(parseSwitchRequest({ scope: 'arc', on: false, reason: 'no', at: T0, signature: sig })).toBe('"reason" must be 3 to 200 characters')
    expect(parseSwitchRequest({ scope: 'arc', on: false, reason: 'x'.repeat(201), at: T0, signature: sig })).toBe('"reason" must be 3 to 200 characters')
    expect(parseSwitchRequest({ scope: 'arc', on: false, reason: 'x y z', signature: sig })).toBe('missing "at"')
    expect(parseSwitchRequest({ scope: 'arc', on: false, reason: 'x y z', at: T0, signature: '0x12' })).toBe('missing or bad "signature"')
    expect(parseSwitchRequest(null)).toBe('expected a JSON object')
  })
  test('the message names the site, the change, the reason and the time', () => {
    expect(tradeSwitchMessage({ scope: 'bnb', on: false, reason: 'four.meme paused', }, T0)).toBe('ARCDEX trade switch\nSite: arcsense.site\nTurn trading OFF on BNB Chain\nReason: four.meme paused\nAt: 2026-10-15T12:00:00.000Z')
    expect(tradeSwitchMessage({ scope: 'all', on: true, reason: 'all clear' }, T0)).toContain('Turn trading ON on every venue')
  })
  test('admins come from ADMIN_EVM_ADDRESSES, else the owner; malformed entries are left out', () => {
    expect(adminAddresses(`${admin.address}, 0xnot-an-address ,${stranger.address}`, undefined)).toEqual([admin.address.toLowerCase(), stranger.address.toLowerCase()])
    expect(adminAddresses('', admin.address)).toEqual([admin.address.toLowerCase()])
    expect(adminAddresses(undefined, undefined)).toEqual([])
  })
})

describe('the switch', () => {
  test('an admin turns Solana off: only Solana stops, the change is saved, audited and listed', async () => {
    const { sw, store } = makeSwitch()
    expect(sw.state(T0)).toMatchObject({ on: true, all: null, venues: {} })
    const r = await sw.control(await signed({ scope: 'solana', on: false, reason: 'Relay incident' }), T0 + 1_000)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, saved: true, audited: true })
    expect(sw.offWhy('solana')).toBe('Relay incident')
    expect(sw.offWhy('arc')).toBeNull()
    const s = (r.body.state as TradeSwitchState)
    expect(s.on).toBe(true) // the rest of trading goes on
    expect(s.venues.solana).toEqual({ reason: 'Relay incident', at: T0 + 1_000 })
    expect(s.history[0]).toEqual({ at: T0 + 1_000, scope: 'solana', on: false, reason: 'Relay incident' })
    expect(JSON.parse((await store.getSetting(SWITCH_KEY))!).venues.solana.reason).toBe('Relay incident')
    expect(await store.audit(10)).toEqual([{ at: T0 + 1_000, actor: admin.address.toLowerCase(), action: 'trade-switch', detail: { scope: 'solana', on: false, reason: 'Relay incident' } }])
    // The public state names no one.
    expect(JSON.stringify(sw.state())).not.toContain(admin.address.toLowerCase().slice(2))
  })
  test('everything off stops every venue; back on, each venue switched off on its own stays off', async () => {
    const { sw } = makeSwitch()
    await sw.control(await signed({ scope: 'bnb', on: false, reason: 'four.meme upgrade' }, T0), T0)
    await sw.control(await signed({ scope: 'all', on: false, reason: 'incident drill' }, T0 + 1), T0 + 1)
    expect(sw.state().on).toBe(false)
    for (const v of ['arc', 'solana', 'hyperliquid'] as const) expect(sw.offWhy(v)).toBe('incident drill')
    await sw.control(await signed({ scope: 'all', on: true, reason: 'drill over' }, T0 + 2), T0 + 2)
    expect(sw.state().on).toBe(true)
    expect(sw.offWhy('arc')).toBeNull()
    expect(sw.offWhy('bnb')).toBe('four.meme upgrade')
    expect(sw.state().history.map(h => `${h.scope}:${h.on}`)).toEqual(['all:true', 'all:false', 'bnb:false'])
  })
  test('refused: a stranger\'s signature, a replay, an old signature, a message altered after signing', async () => {
    const { sw, store } = makeSwitch()
    const fromStranger = await sw.control(await signed({ scope: 'all', on: false, reason: 'let me in' }, T0, stranger), T0)
    expect(fromStranger).toMatchObject({ status: 403, body: { error: 'not signed by an admin wallet' } })
    const ok = await signed({ scope: 'arc', on: false, reason: 'pause arc' })
    expect((await sw.control(ok, T0)).status).toBe(200)
    expect(await sw.control(ok, T0 + 1_000)).toMatchObject({ status: 403, body: { error: 'this signature was already used; sign again' } })
    expect(await sw.control(await signed({ scope: 'arc', on: true, reason: 'resume' }, T0), T0 + 6 * 60_000)).toMatchObject({ status: 403, body: { error: 'the signature is too old (or the clock is off); sign again' } })
    // Signed to turn Solana off, sent as "turn everything on".
    const altered = { ...(await signed({ scope: 'solana', on: false, reason: 'pause solana' }, T0 + 2)), scope: 'all', on: true }
    expect(await sw.control(altered, T0 + 2)).toMatchObject({ status: 403, body: { error: 'not signed by an admin wallet' } })
    expect(sw.offWhy('arc')).toBe('pause arc')
    expect(sw.state().on).toBe(true)
    expect((await store.audit(10)).length).toBe(1) // only the accepted change
  })
  test('kept across a restart', async () => {
    const store = new MemoryBotStore()
    await makeSwitch({ store }).sw.control(await signed({ scope: 'starknet', on: false, reason: 'AVNU outage' }), T0)
    const again = makeSwitch({ store }).sw
    await again.load()
    expect(again.offWhy('starknet')).toBe('AVNU outage')
    expect(again.state().history).toHaveLength(1)
  })
  test('GLOBAL_KILL_SWITCH and KILL_SWITCH_VENUES keep trading off whatever a wallet signs', async () => {
    const { sw } = makeSwitch({ env: { all: false, venues: ['solana'] } })
    expect(sw.offWhy('solana')).toBe('turned off on the engine (KILL_SWITCH_VENUES)')
    const r = await sw.control(await signed({ scope: 'solana', on: true, reason: 'resume solana' }), T0)
    expect(r.body.note).toMatch(/still off/)
    expect(sw.offWhy('solana')).toBe('turned off on the engine (KILL_SWITCH_VENUES)')
    const all = makeSwitch({ env: { all: true, venues: [] } }).sw
    expect(all.state()).toMatchObject({ on: false, env: { all: true } })
    expect(all.offWhy('arc')).toBe('turned off on the engine (GLOBAL_KILL_SWITCH)')
  })
  test('a database that fails still gets the switch applied at once; the answer says it wasn\'t saved', async () => {
    const store = new MemoryBotStore()
    store.setSetting = async () => { throw new Error('db down') }
    store.appendAudit = async () => { throw new Error('db down') }
    const { sw } = makeSwitch({ store })
    const r = await sw.control(await signed({ scope: 'all', on: false, reason: 'db outage drill' }), T0)
    expect(r).toMatchObject({ status: 200, body: { saved: false, audited: false } })
    expect(sw.state().on).toBe(false)
  })
  test('a malformed stored state is dropped field by field, not trusted', async () => {
    const store = new MemoryBotStore()
    await store.setSetting(SWITCH_KEY, JSON.stringify({ all: { reason: 5 }, venues: { arc: { reason: 'kept', at: 1 }, mars: { reason: 'x', at: 1 } }, history: [{ scope: 'all', on: 'x', at: 1 }] }))
    const { sw } = makeSwitch({ store })
    await sw.load()
    expect(sw.state()).toMatchObject({ on: true, all: null, venues: { arc: { reason: 'kept', at: 1 } }, history: [] })
    await store.setSetting(SWITCH_KEY, '{not json')
    await sw.load()
    expect(sw.state().venues).toEqual({})
  })
})

describe('GET /v1/trading/status and POST /v1/trading/control', () => {
  const cfg = { role: 'all', port: 0, allowedOrigins: ['https://arcsense.site'], metricsToken: 'secret', maxConnsPerIp: 3, maxMsgsPerSec: 5, maxSubsPerConn: 4, restRatePerSec: 50 } as unknown as Config
  let srv: ReturnType<typeof startServer>
  let base = ''
  beforeAll(() => {
    const api = new DataApi(null, new MemoryHotStore(), new NullHistoryStore())
    api.tradeSwitch = makeSwitch().sw
    srv = startServer({ cfg, api, health: () => ({ status: 'ok' }) })
    base = `http://127.0.0.1:${srv.server.port}`
  })
  afterAll(() => srv.stop())

  test('the status is public and never cached; a signed change applies at once', async () => {
    const before = await fetch(`${base}/v1/trading/status`, { headers: { origin: 'https://arcsense.site' } })
    expect(before.status).toBe(200)
    expect(before.headers.get('cache-control')).toBe('no-store')
    expect(before.headers.get('access-control-allow-origin')).toBe('https://arcsense.site')
    expect(await before.json()).toMatchObject({ on: true, venues: {} })
    const now = Date.now()
    const body = await signed({ scope: 'hyperliquid', on: false, reason: 'API incident' }, now)
    const post = await fetch(`${base}/v1/trading/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(post.status).toBe(200)
    const after = await (await fetch(`${base}/v1/trading/status`)).json() as TradeSwitchState
    expect(after.venues.hyperliquid?.reason).toBe('API incident')
  })
  test('refused without an admin signature, or with a bad body', async () => {
    const now = Date.now()
    const bad = await fetch(`${base}/v1/trading/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signed({ scope: 'all', on: false, reason: 'nope nope' }, now, stranger)) })
    expect(bad.status).toBe(403)
    const junk = await fetch(`${base}/v1/trading/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"scope":"all"}' })
    expect(junk.status).toBe(400)
    const status = await (await fetch(`${base}/v1/trading/status`)).json() as TradeSwitchState
    expect(status.on).toBe(true)
  })
})

// The audit table against a real Postgres: PG_TEST_URL=postgres://… (skipped otherwise; use a scratch database).
const PG = process.env.PG_TEST_URL
describe.skipIf(!PG)('the audit log in Postgres', () => {
  test('entries are added and read newest first; updates, deletes and truncates are refused', async () => {
    const store = new PostgresBotStore(PG!)
    const at = Date.now()
    await store.appendAudit({ at, actor: admin.address.toLowerCase(), action: 'trade-switch', detail: { scope: 'arc', on: false, reason: 'pg test' } })
    await store.appendAudit({ at: at + 1, actor: admin.address.toLowerCase(), action: 'trade-switch', detail: { scope: 'arc', on: true, reason: 'pg test over' } })
    const rows = await store.audit(2)
    expect(rows.map(r => r.detail.reason)).toEqual(['pg test over', 'pg test'])
    const { SQL } = await import('bun')
    const sql = new SQL(PG!)
    // Bun's SQL queries run when awaited: each is awaited here, and its error kept.
    const refused = (q: PromiseLike<unknown>) => Promise.resolve(q).then(() => 'ran', (e: Error) => e.message)
    expect(await refused(sql`update arcdex_admin_audit set actor = 'someone else'`)).toMatch(/append-only/)
    expect(await refused(sql`delete from arcdex_admin_audit`)).toMatch(/append-only/)
    expect(await refused(sql`truncate arcdex_admin_audit`)).toMatch(/append-only/)
    expect((await store.audit(2)).length).toBe(2)
    await sql.close()
  })
  test('the switch state survives in arcdex_bot_settings', async () => {
    const store = new PostgresBotStore(PG!)
    const check = checker()
    const sw = new TradeSwitch({ settings: store, audit: store, env: { all: false, venues: [] }, verify: (m, at, sig, now) => check.verifyAnyOf([admin.address], m, at, sig, now) })
    const now = Date.now()
    expect((await sw.control(await signed({ scope: 'ethereum', on: false, reason: 'pg persist' }, now), now)).body).toMatchObject({ saved: true, audited: true })
    const again = new TradeSwitch({ settings: new PostgresBotStore(PG!), audit: store, env: { all: false, venues: [] }, verify: async () => 'unused' })
    await again.load()
    expect(again.offWhy('ethereum')).toBe('pg persist')
  })
})

