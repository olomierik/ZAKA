// Card deposits through MoonPay (api/moonpay.ts, 2026-10-18): the checkout URL signed for the signed-in wallet only.
import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { createMoonpay, moonpaySignature, moonpayUrl, MOONPAY_CURRENCY } from '../../api/moonpay'
import { createSiteApi } from '../src/site/siteApi'

const ME = '0x1111111111111111111111111111111111111111'
const PK = 'pk_live_abc123', SK = 'sk_live_xyz789'
const signedIn = async (t: string | null) => (t === 'good' ? { address: ME, iat: 1 } : null)
const post = (token: string | null, body: unknown = {}) =>
  new Request('http://e/api/moonpay', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })

/** MoonPay's own Node example: HMAC-SHA256 of `new URL(url).search` under the secret key, base64. */
const reference = (url: string, secret: string) => createHmac('sha256', secret).update(new URL(url).search).digest('base64')

describe('MoonPay checkout', () => {
  test('the signature is MoonPay\'s: base64 HMAC-SHA256 of the query string, appended last and URL-encoded', async () => {
    const url = await moonpayUrl({ publishableKey: PK, secretKey: SK, wallet: ME, redirectUrl: 'https://arcsense.site/portfolio' })
    const [unsigned, sig] = url.split('&signature=')
    expect(decodeURIComponent(sig)).toBe(reference(unsigned, SK))
    expect(await moonpaySignature(new URL(unsigned).search, SK)).toBe(reference(unsigned, SK))
    const u = new URL(url)
    expect(u.origin).toBe('https://buy.moonpay.com')
    expect(u.searchParams.get('apiKey')).toBe(PK)
    expect(u.searchParams.get('currencyCode')).toBe(MOONPAY_CURRENCY)
    expect(MOONPAY_CURRENCY).toBe('usdc_arc')
    expect(u.searchParams.get('walletAddress')).toBe(ME)
    expect(u.searchParams.get('redirectURL')).toBe('https://arcsense.site/portfolio')
    expect([...u.searchParams.keys()].at(-1)).toBe('signature')
    // Swapping the wallet breaks the signature.
    const swapped = unsigned.replace(ME, '0x2222222222222222222222222222222222222222')
    expect(reference(swapped, SK)).not.toBe(decodeURIComponent(sig))
  })

  test('test keys open MoonPay\'s sandbox', async () => {
    expect(new URL(await moonpayUrl({ publishableKey: 'pk_test_1', secretKey: 'sk_test_1', wallet: ME })).origin).toBe('https://buy-sandbox.moonpay.com')
    const h = createMoonpay({ publishableKey: 'pk_test_1', secretKey: 'sk_test_1', verify: signedIn, revoked: async () => false })
    expect(await (await h(new Request('http://e/api/moonpay'))).json()).toEqual({ enabled: true, sandbox: true })
  })

  test('off without both keys, or with keys from different modes', async () => {
    for (const [publishableKey, secretKey] of [[null, null], [PK, null], [null, SK], ['pk_test_1', SK], [PK, 'sk_test_1'], ['nonsense', SK]] as const) {
      const h = createMoonpay({ publishableKey, secretKey, verify: signedIn, revoked: async () => false })
      expect(await (await h(new Request('http://e/api/moonpay'))).json()).toEqual({ enabled: false, sandbox: false })
      expect((await h(post('good'))).status).toBe(503)
    }
  })

  test('only for the signed-in wallet, whatever the body says; refusals', async () => {
    const h = createMoonpay({ publishableKey: PK, secretKey: SK, verify: signedIn, revoked: async () => false })
    const r = await h(post('good', { walletAddress: '0x2222222222222222222222222222222222222222' }))
    expect(r.status).toBe(200)
    const { url } = await r.json() as { url: string }
    expect(new URL(url).searchParams.get('walletAddress')).toBe(ME)
    expect(url).not.toContain(SK)
    expect((await h(post(null))).status).toBe(401)
    expect((await h(post('forged'))).status).toBe(401)
    expect((await createMoonpay({ publishableKey: PK, secretKey: SK, verify: signedIn, revoked: async () => true })(post('good'))).status).toBe(401)
    expect((await h(new Request('http://e/api/moonpay', { method: 'PUT' }))).status).toBe(405)
  })

  test('the engine serves it as a write', async () => {
    const api = createSiteApi({ databaseUrl: null, indexEveryMs: 0, warm: false })
    expect(api.names).toContain('moonpay')
    const r = await api.handle(new Request('http://e/api/moonpay'), new URL('http://e/api/moonpay'))
    expect(r.status).toBe(200)
    expect(r.headers.get('X-Arcdex-Served-By')).toBe('engine')
    expect(await r.json()).toHaveProperty('enabled')
  })
})
