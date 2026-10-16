// Alerts by web push (engine/src/alerts): the encryption against RFC 8291's own example and decrypted as a browser
// does, VAPID, which subscriptions and alerts are taken, price and activity alerts firing on Arc trades and Hyperliquid
// mids, delivery times (all within 10 seconds of the trigger), push services that refuse, and the routes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  b64u, encryptPush, generateVapidKeys, sendPush, subscriptionProblem, vapidAuthorization, vapidValid, type Subscription, type VapidKeys,
} from '../src/alerts/webpush'
import { MemoryPushStore, PUSH, PushAlerts, cleanAlert, priceMet } from '../src/alerts/service'
import type { Trade } from '../../api/_marketProtocol'
import type { Config } from '../src/config'
import { setLogLevel } from '../src/log'
import { NullHistoryStore } from '../src/store/history'
import { MemoryHotStore } from '../src/store/hot'
import { DataApi, startServer } from '../src/ws/server'

setLogLevel('error')
type Bytes = Uint8Array<ArrayBuffer>

// RFC 8291 §5 (Appendix A): the message, both key pairs, the auth secret, the salt, and the exact result.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  out: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

/** A browser's side: its key pair and auth secret, and RFC 8291 decryption with them. */
async function browser() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)) as Bytes
  const auth = crypto.getRandomValues(new Uint8Array(16)) as Bytes
  return { keys: { p256dh: b64u.encode(pub), auth: b64u.encode(auth) }, decrypt: (body: Bytes) => decrypt(body, kp.privateKey, pub, auth) }
}
async function hkdf(salt: Bytes, ikm: Bytes, info: string | Bytes, n: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: typeof info === 'string' ? new TextEncoder().encode(info) : info }, k, n * 8)) as Bytes
}
async function decrypt(body: Bytes, uaPrivate: CryptoKey, uaPublic: Bytes, auth: Bytes): Promise<string> {
  const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0), idlen = body[20]
  const asPublic = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen)
  expect(rs).toBe(4096)
  expect(idlen).toBe(65)
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPrivate, 256)) as Bytes
  const info = new Uint8Array([...new TextEncoder().encode('WebPush: info\0'), ...uaPublic, ...asPublic]) as Bytes
  const ikm = await hkdf(auth, ecdh, info, 32)
  const cek = await hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16), nonce = await hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct))
  expect(pt[pt.length - 1]).toBe(2)
  return new TextDecoder().decode(pt.slice(0, -1))
}

describe('web push', () => {
  test('RFC 8291’s own example, byte for byte', async () => {
    const out = await encryptPush({ p256dh: RFC.uaPublic, auth: RFC.auth }, b64u.decode(RFC.plaintext), { asPublic: b64u.decode(RFC.asPublic), asPrivate: RFC.asPrivate, salt: b64u.decode(RFC.salt) })
    expect(b64u.encode(out)).toBe(RFC.out)
  })

  test('a browser decrypts what the engine sends, with a fresh key and salt every time', async () => {
    const b = await browser()
    const msg = JSON.stringify({ title: 'BTC reached $70,000', body: '↑', url: '/futures/BTC' })
    const one = await encryptPush(b.keys, new TextEncoder().encode(msg)), two = await encryptPush(b.keys, new TextEncoder().encode(msg))
    expect(await b.decrypt(one)).toBe(msg)
    expect(b64u.encode(one.slice(0, 16))).not.toBe(b64u.encode(two.slice(0, 16)))
    expect(await b.decrypt(await encryptPush(b.keys, new Uint8Array(3000).fill(65)))).toBe('A'.repeat(3000))
  })

  test('VAPID: keys checked, the token signed for the push service’s origin, 12 hours at most', async () => {
    const k = await generateVapidKeys()
    expect(await vapidValid(k)).toBe(true)
    const other = await generateVapidKeys()
    expect(await vapidValid({ publicKey: k.publicKey, privateKey: other.privateKey })).toBe(false)
    expect(await vapidValid({ publicKey: 'nope', privateKey: k.privateKey })).toBe(false)
    const now = Date.UTC(2026, 9, 16)
    const h = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', k, 'https://arcsense.site', now)
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!
    expect(m[4]).toBe(k.publicKey)
    expect(JSON.parse(new TextDecoder().decode(b64u.decode(m[1])))).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(new TextDecoder().decode(b64u.decode(m[2])))).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://arcsense.site' })
    const pub = await crypto.subtle.importKey('raw', b64u.decode(k.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64u.decode(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`))).toBe(true)
  })

  test('only the browsers’ own push services, over plain https', async () => {
    const b = await browser()
    const sub = (endpoint: string) => ({ endpoint, keys: b.keys })
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) expect(subscriptionProblem(sub(ok))).toBeNull()
    for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://user:pw@fcm.googleapis.com/x', 'https://169.254.169.254/latest', 'https://api.push.apple.com.evil.example/x', 'https://evilpush.apple.com/x', 'https://x.notify.windows.com.evil.example/x', 'not a url']) expect(subscriptionProblem(sub(bad))).not.toBeNull()
    expect(subscriptionProblem({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'short', auth: b.keys.auth } })).toBe('bad keys')
    expect(subscriptionProblem(null)).toBe('no endpoint')
  })

  test('a push service’s answers: accepted, gone, ask to wait', async () => {
    const b = await browser(), k = await generateVapidKeys()
    const s: Subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: b.keys }
    let seen: Request | null = null
    const ok = await sendPush(s, { hi: 1 }, k, 'https://arcsense.site', { topic: 'a:b/c', fetcher: (async (u: string, init: RequestInit) => { seen = new Request(u, init); return new Response(null, { status: 201 }) }) as unknown as typeof fetch })
    expect(ok).toEqual({ ok: true, status: 201 })
    expect(seen!.headers.get('content-encoding')).toBe('aes128gcm')
    expect(seen!.headers.get('urgency')).toBe('high')
    expect(seen!.headers.get('ttl')).toBe('300')
    expect(seen!.headers.get('topic')).toBe('abc')
    expect(seen!.headers.get('authorization')).toStartWith('vapid t=')
    expect(JSON.parse(await b.decrypt(new Uint8Array(await seen!.arrayBuffer())))).toEqual({ hi: 1 })
    const gone = await sendPush(s, {}, k, 'x', { fetcher: (async () => new Response(null, { status: 410 })) as unknown as typeof fetch })
    expect(gone).toMatchObject({ ok: false, gone: true })
    const wait = await sendPush(s, {}, k, 'x', { fetcher: (async () => new Response(null, { status: 429, headers: { 'retry-after': '2' } })) as unknown as typeof fetch })
    expect(wait).toMatchObject({ ok: false, gone: false, retryAfterMs: 2000 })
  })
})

const ARC_COIN = '0x' + 'c'.repeat(40)
const price = (o: Partial<Record<string, unknown>> = {}) => ({ id: 'p-btc-70k', kind: 'price', venue: 'hl', market: 'BTC', dir: 'above', px: 70_000, title: 'BTC reached $70,000', body: 'Up from $68,000', url: '/futures/BTC', ...o })
const whale = (o: Partial<Record<string, unknown>> = {}) => ({ id: 'w-coin-5k', kind: 'activity', venue: 'arc', market: ARC_COIN, minUsd: 5_000, side: 'any', title: 'Whale {side} on PEPE: {usd}', body: 'A single trade of {usd}', url: `/token/${ARC_COIN}`, buyWord: 'buy', sellWord: 'sell', ...o })

describe('what an alert may be', () => {
  test('checked and cleaned', () => {
    expect(cleanAlert(price())).toMatchObject({ kind: 'price', venue: 'hl', market: 'BTC', px: 70_000, firedAt: null })
    expect(cleanAlert(price({ market: 'xyz:NVDA' }))).toMatchObject({ market: 'xyz:NVDA' })
    expect(cleanAlert(whale())).toMatchObject({ kind: 'activity', minUsd: 5_000, side: 'any' })
    expect(cleanAlert(price({ url: '//evil.example/x' }))).toBe('bad url')
    expect(cleanAlert(price({ url: 'https://evil.example' }))).toBe('bad url')
    expect(cleanAlert(price({ url: '/x"><script>' }))).toBe('bad url')
    expect(cleanAlert(price({ px: -1 }))).toBe('bad level')
    expect(cleanAlert(price({ market: 'BTC; drop' }))).toBe('bad market')
    expect(cleanAlert(whale({ venue: 'hl', market: 'BTC' }))).toBe('activity alerts are for Arc coins')
    expect(cleanAlert(whale({ minUsd: 1 }))).toBe('the amount must be between $10 and $10M')
    const a = cleanAlert(price({ title: 'BTC\u0000\u0007 up' + 'x'.repeat(500) }))
    expect(typeof a !== 'string' && a.title.length).toBe(120)
    expect(typeof a !== 'string' && /[\u0000-\u001f]/.test(a.title)).toBe(false)
  })
  test('a price meets its level from its side', () => {
    expect(priceMet({ dir: 'above', px: 10 }, 10)).toBe(true)
    expect(priceMet({ dir: 'above', px: 10 }, 9.99)).toBe(false)
    expect(priceMet({ dir: 'below', px: 10 }, 9)).toBe(true)
    expect(priceMet({ dir: 'below', px: 10 }, 11)).toBe(false)
  })
})

/** The engine's side, with a push service that records and a clock the test moves. */
async function setup(o: { status?: number[]; mids?: Record<string, Record<string, number>> } = {}) {
  const b = await browser()
  const keys: VapidKeys = await generateVapidKeys()
  let now = Date.UTC(2026, 9, 16, 12)
  const sent: { body: Bytes; at: number; headers: Headers }[] = []
  const statuses = [...(o.status ?? [])]
  const midCalls: string[] = []
  const store = new MemoryPushStore()
  const push = new PushAlerts({
    store, keys, subject: 'https://arcsense.site', now: () => now,
    fetcher: (async (_u: string, init: RequestInit) => { const r = new Request('https://fcm.googleapis.com/x', init); sent.push({ body: new Uint8Array(await r.arrayBuffer()) as Bytes, at: now, headers: r.headers }); return new Response(null, { status: statuses.shift() ?? 201 }) }) as unknown as typeof fetch,
    hlMids: async dex => { midCalls.push(dex); return o.mids?.[dex] ?? {} },
  })
  await push.load()
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: b.keys }
  const read = async (i: number) => JSON.parse(await b.decrypt(sent[i].body)) as { title: string; body: string; url: string; tag: string; at: number }
  return { b, push, store, sent, read, midCalls, subscription, tick: (ms: number) => { now += ms }, now: () => now }
}
const trade = (o: Partial<Trade> & { at: number }): Trade => ({
  tradeId: `0x${o.at}:1`, chain: 'ARC', token: ARC_COIN, pair: '', pool: '', quote: '', side: 'BUY', baseAmount: 1, quoteAmount: 1, tokenAmount: 1, price: 1,
  priceUsd: 0.01, usdValue: 100, wallet: null, txHash: '0x1', blockNumber: 1, logIndex: 1, timestamp: o.at, dex: 'uniswap-v4', launchpad: null, liquidity: null, ...o,
})
const flush = () => new Promise(r => setTimeout(r, 30))

describe('alerts firing', () => {
  test('an Arc price alert fires once, on the trade that reaches it, decrypted by the browser with its words', async () => {
    const t = await setup()
    const s = await t.push.subscribe({ subscription: t.subscription, alerts: [price({ id: 'arc-up', venue: 'arc', market: ARC_COIN, px: 0.02, title: 'PEPE reached $0.02', url: `/token/${ARC_COIN}` })] }, '1.1.1.1')
    expect(s.status).toBe(200)
    t.push.onTrade(trade({ at: t.now() - 1500, priceUsd: 0.019 }))
    await flush()
    expect(t.sent).toHaveLength(0)
    t.push.onTrade(trade({ at: t.now() - 1500, priceUsd: 0.021 }))
    await flush()
    expect(t.sent).toHaveLength(1)
    expect(await t.read(0)).toMatchObject({ title: 'PEPE reached $0.02', url: `/token/${ARC_COIN}`, tag: 'arc-up' })
    t.push.onTrade(trade({ at: t.now(), priceUsd: 0.03 }))
    await flush()
    expect(t.sent).toHaveLength(1)
    const auth = s.body as { id: string; token: string }
    const st = t.push.read(auth)
    expect((st.body as { alerts: { firedAt: number }[] }).alerts[0].firedAt).toBe(t.now())
    // The page sends its alerts again (it doesn't know what fired): the fired one stays fired and doesn't go off again.
    await t.push.setAlerts({ ...auth, alerts: [price({ id: 'arc-up', venue: 'arc', market: ARC_COIN, px: 0.02, title: 'PEPE reached $0.02', url: `/token/${ARC_COIN}` })] })
    t.push.onTrade(trade({ at: t.now(), priceUsd: 0.04 }))
    await flush()
    expect(t.sent).toHaveLength(1)
    // A new level is a new alert.
    await t.push.setAlerts({ ...auth, alerts: [price({ id: 'arc-up', venue: 'arc', market: ARC_COIN, px: 0.05, title: 'PEPE reached $0.05', url: `/token/${ARC_COIN}` })] })
    t.push.onTrade(trade({ at: t.now(), priceUsd: 0.06 }))
    await flush()
    expect(t.sent).toHaveLength(2)
  })

  test('a whale alert fills in the dollars and side, keeps to its side, and waits a minute between', async () => {
    const t = await setup()
    await t.push.subscribe({ subscription: t.subscription, alerts: [whale({ side: 'sell', buyWord: 'achat', sellWord: 'vente' })] }, '1.1.1.1')
    t.push.onTrade(trade({ at: t.now(), side: 'BUY', usdValue: 20_000 }))
    t.push.onTrade(trade({ at: t.now(), side: 'SELL', usdValue: 4_000 }))
    await flush()
    expect(t.sent).toHaveLength(0)
    t.push.onTrade(trade({ at: t.now(), side: 'SELL', usdValue: 12_345 }))
    await flush()
    expect(await t.read(0)).toMatchObject({ title: 'Whale vente on PEPE: $12.3K', body: 'A single trade of $12.3K' })
    t.tick(30_000)
    t.push.onTrade(trade({ at: t.now(), side: 'SELL', usdValue: 9_000 }))
    await flush()
    expect(t.sent).toHaveLength(1)
    t.tick(PUSH.activityCooldownMs)
    t.push.onTrade(trade({ at: t.now(), side: 'SELL', usdValue: 9_000 }))
    await flush()
    expect(t.sent).toHaveLength(2)
  })

  test('Hyperliquid: only the dexes alerts wait on are read, above and below, each once', async () => {
    const t = await setup({ mids: { '': { BTC: 70_100, ETH: 1_900 }, xyz: { 'xyz:NVDA': 120 } } })
    await t.push.tickHl()
    expect(t.midCalls).toEqual([])
    await t.push.subscribe({ subscription: t.subscription, alerts: [price(), price({ id: 'eth-down', market: 'ETH', dir: 'below', px: 2_000, title: 'ETH fell to $2,000' }), price({ id: 'nvda', market: 'xyz:NVDA', px: 150, title: 'NVDA $150' })] }, '1.1.1.1')
    await t.push.tickHl()
    await flush()
    expect(t.midCalls.sort()).toEqual(['', 'xyz'])
    expect(t.sent.map((_, i) => i)).toHaveLength(2)
    expect((await Promise.all([t.read(0), t.read(1)])).map(m => m.tag).sort()).toEqual(['eth-down', 'p-btc-70k'])
    t.midCalls.length = 0
    await t.push.tickHl()
    await flush()
    expect(t.sent).toHaveLength(2)
    expect(t.midCalls).toEqual(['xyz'])
  })

  test('delivery time: from the trade’s block to the push service accepting it, and the share within 10 seconds', async () => {
    const t = await setup()
    await t.push.subscribe({ subscription: t.subscription, alerts: [whale({ minUsd: 10 })] }, '1.1.1.1')
    for (const lag of [1_200, 2_000, 1_700]) { t.push.onTrade(trade({ at: t.now() - lag, usdValue: 50 })); await flush(); t.tick(PUSH.activityCooldownMs) }
    const st = t.push.stats()
    expect(st).toMatchObject({ subscriptions: 1, alerts: 1, waiting: 1, sent: 3, failed: 0, gone: 0 })
    expect(st.delivery).toEqual({ n: 3, p50Ms: 1_700, p95Ms: 2_000, maxMs: 2_000, withinShare: 1 })
    expect(JSON.stringify(st)).not.toContain('fcm.googleapis.com')
  })

  test('a push service that’s gone drops the subscription; one that keeps failing is dropped after 10; one that asks to wait is tried again', async () => {
    const gone = await setup({ status: [410] })
    await gone.push.subscribe({ subscription: gone.subscription, alerts: [whale({ minUsd: 10 })] }, '1.1.1.1')
    gone.push.onTrade(trade({ at: gone.now(), usdValue: 50 }))
    await flush()
    expect(gone.push.stats()).toMatchObject({ subscriptions: 0, gone: 1 })
    expect(gone.store.rows.size).toBe(0)

    const wait = await setup({ status: [429] })
    await wait.push.subscribe({ subscription: wait.subscription, alerts: [whale({ minUsd: 10 })] }, '1.1.1.1')
    wait.push.onTrade(trade({ at: wait.now(), usdValue: 50 }))
    await new Promise(r => setTimeout(r, 1_150))
    expect(wait.sent).toHaveLength(2)
    expect(wait.push.stats()).toMatchObject({ sent: 1, failed: 0 })

    const bad = await setup({ status: Array(PUSH.maxFails).fill(500) })
    await bad.push.subscribe({ subscription: bad.subscription, alerts: [whale({ minUsd: 10 })] }, '1.1.1.1')
    for (let i = 0; i < PUSH.maxFails; i++) { bad.push.onTrade(trade({ at: bad.now(), usdValue: 50 })); await flush(); bad.tick(PUSH.activityCooldownMs) }
    expect(bad.push.stats()).toMatchObject({ subscriptions: 0, failed: PUSH.maxFails })
  })

  test('a subscription answers to its token only; subscribing again replaces it; ten new ones an hour from one address', async () => {
    const t = await setup()
    const a = (await t.push.subscribe({ subscription: t.subscription, alerts: [price()] }, '2.2.2.2')).body as { id: string; token: string }
    expect(t.push.read({ id: a.id, token: 'wrong' }).status).toBe(401)
    expect((await t.push.setAlerts({ id: a.id, token: a.token, alerts: [price(), whale()] })).status).toBe(200)
    const again = (await t.push.subscribe({ subscription: t.subscription }, '2.2.2.2')).body as { id: string; token: string; alerts: unknown[] }
    expect(again.id).toBe(a.id)
    expect(again.alerts).toHaveLength(2)
    expect(t.push.read({ id: a.id, token: a.token }).status).toBe(401)
    expect(t.push.read({ id: a.id, token: again.token }).status).toBe(200)
    expect([...t.store.rows.values()]).toHaveLength(1)
    expect([...t.store.rows.values()][0].tokenHash).not.toContain(again.token)
    expect((await t.push.setAlerts({ id: a.id, token: again.token, alerts: Array.from({ length: 51 }, (_, i) => price({ id: `id-${i}` })) })).status).toBe(400)
    for (let i = 0; i < PUSH.subsPerIpHour - 1; i++) {
      const b = await browser()
      expect((await t.push.subscribe({ subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${i}`, keys: b.keys } }, '2.2.2.2')).status).toBe(200)
    }
    const b = await browser()
    expect((await t.push.subscribe({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/last', keys: b.keys } }, '2.2.2.2')).status).toBe(429)
    expect((await t.push.unsubscribe({ id: a.id, token: again.token })).status).toBe(200)
    expect(t.push.stats().subscriptions).toBe(PUSH.subsPerIpHour - 1)
  })

  test('alerts survive a restart, fired ones staying fired', async () => {
    const t = await setup()
    const s = (await t.push.subscribe({ subscription: t.subscription, alerts: [price({ id: 'arc-up', venue: 'arc', market: ARC_COIN, px: 0.02 })] }, '1.1.1.1')).body as { id: string; token: string }
    t.push.onTrade(trade({ at: t.now(), priceUsd: 0.05 }))
    await flush()
    const again = new PushAlerts({ store: t.store, keys: await generateVapidKeys(), subject: 'x', hlMids: async () => ({}), fetcher: (async () => new Response(null, { status: 201 })) as unknown as typeof fetch })
    await again.load()
    expect((again.read(s).body as { alerts: { firedAt: number | null }[] }).alerts[0].firedAt).toBe(t.now())
    expect(again.stats().waiting).toBe(0)
  })
})

describe('the push routes', () => {
  const cfg = { role: 'all', port: 0, allowedOrigins: ['https://arcsense.site'], metricsToken: 'secret', maxConnsPerIp: 3, maxMsgsPerSec: 5, maxSubsPerConn: 4, restRatePerSec: 50 } as unknown as Config
  let srv: ReturnType<typeof startServer>
  let base = ''
  let push: PushAlerts
  beforeAll(async () => {
    const api = new DataApi(null, new MemoryHotStore(), new NullHistoryStore())
    push = new PushAlerts({ store: new MemoryPushStore(), keys: await generateVapidKeys(), subject: 'x', hlMids: async () => ({}), fetcher: (async () => new Response(null, { status: 201 })) as unknown as typeof fetch })
    api.push = push
    srv = startServer({ cfg, api, health: () => ({ status: 'ok' }) })
    base = `http://127.0.0.1:${srv.server.port}`
  })
  afterAll(() => srv.stop())
  const post = (path: string, body: unknown, origin: string | null = 'https://arcsense.site') =>
    fetch(`${base}/v1/push/${path}`, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) })

  test('the key and the stats for anyone; subscriptions from the site only', async () => {
    expect((await (await fetch(`${base}/v1/push/key`)).json()).publicKey).toBe(push.publicKey)
    expect((await (await fetch(`${base}/v1/push/stats`)).json())).toMatchObject({ enabled: true, subscriptions: 0 })
    const b = await browser()
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/route', keys: b.keys }
    expect((await post('subscribe', { subscription }, 'https://evil.example')).status).toBe(403)
    expect((await post('subscribe', { subscription }, null)).status).toBe(403)
    const r = await post('subscribe', { subscription, alerts: [price()] })
    expect(r.status).toBe(200)
    const { id, token } = await r.json() as { id: string; token: string }
    expect((await post('state', { id, token })).status).toBe(200)
    expect((await post('test', { id, token, title: 'ARCDEX', body: 'Alerts are on' })).status).toBe(200)
    expect((await post('test', { id, token })).status).toBe(429)
    expect((await post('alerts', { id, token: 'x', alerts: [] })).status).toBe(401)
    expect((await post('unsubscribe', { id, token })).status).toBe(200)
    expect((await post('nope', {})).status).toBe(404)
  })
})

const PG = process.env.PG_TEST_URL
describe.skipIf(!PG)('push subscriptions in Postgres', () => {
  test('kept, replaced by endpoint, removed', async () => {
    const { PostgresBotStore } = await import('../src/bot/store')
    const store = new PostgresBotStore(PG!)
    const endpoint = `https://fcm.googleapis.com/fcm/send/pg-${Date.now()}`
    const row = { id: `pg1-${Date.now()}`, tokenHash: 'h', endpoint, p256dh: 'p', auth: 'a', alerts: [], created: 1, updated: 1, fails: 0, lastOk: null, lastTest: null }
    await store.putPushSub(row)
    await store.putPushSub({ ...row, id: `pg2-${Date.now()}`, alerts: [cleanAlert(price()) as never] })
    const mine = (await store.pushSubs()).filter(r => r.endpoint === endpoint)
    expect(mine).toHaveLength(1)
    expect(mine[0].alerts).toHaveLength(1)
    await store.deletePushSub(mine[0].id)
    expect((await store.pushSubs()).filter(r => r.endpoint === endpoint)).toHaveLength(0)
  })
})
