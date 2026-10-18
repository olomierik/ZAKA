// Admins by email (engine/src/admin/privyIdentity.ts): Privy's identity token, checked against Privy's keys for
// ARCDEX's app, names an admin email; the sign-in is signed by one of that account's own wallets.
import { describe, expect, test } from 'bun:test'
import { verifyMessage, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { AdminAuth } from '../src/admin/auth'
import { adminEmails, emailHash, PrivyIdentityCheck } from '../src/admin/privyIdentity'
import { MemoryBotStore } from '../src/bot/store'
import { setLogLevel } from '../src/log'

setLogLevel('error')
const APP = 'cmtestapp0000000000000000'
const SITE = 'https://arcsense.site'
const T0 = Date.parse('2026-10-17T10:00:00Z')
// Anvil's published test keys.
const privyWallet = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex)
const otherWallet = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex)

const enc = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')

async function keys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { pair, jwk: { ...jwk, kid: 'k1', alg: 'ES256', use: 'sig' } }
}

async function token(pair: CryptoKeyPair, claims: Record<string, unknown>, kid = 'k1') {
  const head = enc({ alg: 'ES256', typ: 'JWT', kid })
  const body = enc({ iss: 'privy.io', aud: APP, sub: 'did:privy:abc', iat: T0 / 1000 - 10, exp: T0 / 1000 + 3600, ...claims })
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${head}.${body}`))
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`
}

const linked = (email: string, wallet: string) => JSON.stringify([
  { type: 'email', address: email, verified_at: 1 },
  { type: 'wallet', address: wallet, chain_type: 'ethereum', wallet_client_type: 'privy' },
  { type: 'wallet', address: 'So11111111111111111111111111111111111111112', chain_type: 'solana' },
])

async function setup(emails = ['boss@example.com']) {
  const k = await keys()
  let calls = 0
  const check = new PrivyIdentityCheck({
    appId: APP, emails, emailHashes: [],
    fetcher: async url => { calls++; expect(url).toBe(`https://auth.privy.io/api/v1/apps/${APP}/jwks.json`); return new Response(JSON.stringify({ keys: [k.jwk] })) },
  })
  const store = new MemoryBotStore()
  const auth = new AdminAuth({ admins: [], origins: [SITE], ttlMinutes: 30, signedBy: (address, message, signature) => verifyMessage({ address, message, signature }), audit: store, byEmail: check })
  return { k, check, auth, store, calls: () => calls }
}

async function signIn(auth: AdminAuth, who: typeof privyWallet, identityToken?: string) {
  const n = auth.nonce({ address: who.address }, SITE, '1.2.3.4', T0)
  if ('status' in n) throw new Error(n.error)
  const signature = await who.signMessage({ message: n.message })
  return auth.verify({ nonce: n.nonce, signature, identityToken }, SITE, '1.2.3.4', 'Chrome', T0 + 1_000)
}

describe('admin by email (Privy identity token)', () => {
  test('an admin email signs in with its own Privy wallet; the session works and is audited', async () => {
    const { k, auth, store } = await setup()
    const r = await signIn(auth, privyWallet, await token(k.pair, { linked_accounts: linked('Boss@Example.com', privyWallet.address) }))
    expect('token' in r).toBe(true)
    if (!('token' in r)) return
    expect(auth.session(`Bearer ${r.token}`, T0 + 60_000)?.email).toBe('boss@example.com')
    expect(auth.emailAdminWallets(T0 + 60_000)).toEqual([privyWallet.address.toLowerCase()])
    expect((await store.audit(1))[0]).toMatchObject({ action: 'admin.login', detail: { by: 'email' } })
  })

  test('Google sign-ins count by their email; linked accounts may come as an array', async () => {
    const { k, auth } = await setup()
    const accounts = [{ type: 'google_oauth', email: 'boss@example.com', subject: '1' }, { type: 'wallet', address: privyWallet.address.toLowerCase(), chain_type: 'ethereum' }]
    expect('token' in await signIn(auth, privyWallet, await token(k.pair, { linked_accounts: accounts }))).toBe(true)
  })

  test('refused: another email, another wallet, no token, a wallet that did not sign', async () => {
    const { k, auth } = await setup()
    const stranger = await signIn(auth, privyWallet, await token(k.pair, { linked_accounts: linked('someone@example.com', privyWallet.address) }))
    expect(stranger).toMatchObject({ status: 403, error: expect.stringContaining('not an admin email') })
    const notTheirs = await signIn(auth, otherWallet, await token(k.pair, { linked_accounts: linked('boss@example.com', privyWallet.address) }))
    expect(notTheirs).toMatchObject({ status: 403, error: expect.stringContaining('same Privy account') })
    expect(await signIn(auth, privyWallet)).toMatchObject({ status: 403, error: 'this wallet is not an admin' })
    // The token alone isn't a sign-in: the signature must be that wallet's.
    const n = auth.nonce({ address: privyWallet.address }, SITE, '1.2.3.4', T0)
    if ('status' in n) throw new Error(n.error)
    const forged = await otherWallet.signMessage({ message: n.message })
    const r = await auth.verify({ nonce: n.nonce, signature: forged, identityToken: await token(k.pair, { linked_accounts: linked('boss@example.com', privyWallet.address) }) }, SITE, '1.2.3.4', 'x', T0 + 1_000)
    expect(r).toMatchObject({ status: 401 })
  })

  test('refused: a token signed by another key, for another app, from another issuer, or expired', async () => {
    const { k, check } = await setup()
    const other = await keys()
    const good = { linked_accounts: linked('boss@example.com', privyWallet.address) }
    expect(await check.identity(await token(other.pair, good), T0)).toBeNull()
    expect(await check.identity(await token(k.pair, { ...good, aud: 'cmsomeoneelse000000000000' }), T0)).toBeNull()
    expect(await check.identity(await token(k.pair, { ...good, iss: 'evil.io' }), T0)).toBeNull()
    expect(await check.identity(await token(k.pair, { ...good, exp: T0 / 1000 - 1 }), T0)).toBeNull()
    expect(await check.identity('not.a.jwt', T0)).toBeNull()
    const ok = await check.identity(await token(k.pair, good), T0)
    expect(ok?.emails).toEqual(['boss@example.com'])
    expect(ok?.wallets).toEqual([privyWallet.address.toLowerCase()])
  })

  test('a session ends once its email is no longer an admin email', async () => {
    const k = await keys()
    const list = ['boss@example.com']
    const check = new PrivyIdentityCheck({ appId: APP, emails: list, emailHashes: [], fetcher: async () => new Response(JSON.stringify({ keys: [k.jwk] })) })
    const auth = new AdminAuth({ admins: [], origins: [SITE], ttlMinutes: 30, signedBy: (address, message, signature) => verifyMessage({ address, message, signature }), audit: new MemoryBotStore(), byEmail: check })
    const r = await signIn(auth, privyWallet, await token(k.pair, { linked_accounts: linked('boss@example.com', privyWallet.address) }))
    if (!('token' in r)) throw new Error('no session')
    check.isAdminEmail = () => false
    expect(auth.session(`Bearer ${r.token}`, T0 + 60_000)).toBeNull()
  })

  test('the keys are read once an hour; ADMIN_EMAILS is parsed; the owner is known by hash only', async () => {
    const { k, check, calls } = await setup()
    const t = await token(k.pair, { linked_accounts: linked('boss@example.com', privyWallet.address) })
    await check.identity(t, T0)
    await check.identity(t, T0 + 60_000)
    expect(calls()).toBe(1)
    expect(adminEmails(' A@b.co , nope, a@b.co,c@d.io')).toEqual(['a@b.co', 'c@d.io'])
    const owner = new PrivyIdentityCheck({ appId: APP, emails: [] })
    expect(owner.configured).toBe(true)
    expect(emailHash(' X@Y.Z ')).toBe(emailHash('x@y.z'))
  })
})

// Admin wallets through Privy (2026-10-18): Privy makes a wallet for every account, so an admin who signs in with Privy
// (by email or with MetaMask) signs with that Privy wallet, not the admin wallet. The account's linked admin wallet
// makes it an admin.
describe('admin wallet linked to a Privy account', () => {
  const adminWallet = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as Hex)
  const viaMetaMask = (privy: string, external: string) => JSON.stringify([
    { type: 'wallet', address: external, chain_type: 'ethereum', wallet_client_type: 'metamask' },
    { type: 'wallet', address: privy, chain_type: 'ethereum', wallet_client_type: 'privy' },
  ])
  async function setupWallets(admins: string[]) {
    const k = await keys()
    const check = new PrivyIdentityCheck({ appId: APP, emails: [], emailHashes: [], fetcher: async () => new Response(JSON.stringify({ keys: [k.jwk] })) })
    const store = new MemoryBotStore()
    const auth = new AdminAuth({ admins, origins: [SITE], ttlMinutes: 30, signedBy: (address, message, signature) => verifyMessage({ address, message, signature }), audit: store, byEmail: check })
    return { k, check, auth, store }
  }

  test('the Privy wallet of an account linked to an admin wallet signs in, acts as an admin, and is audited', async () => {
    const { k, auth, store } = await setupWallets([adminWallet.address.toLowerCase()])
    const r = await signIn(auth, privyWallet, await token(k.pair, { linked_accounts: viaMetaMask(privyWallet.address, adminWallet.address) }))
    if (!('token' in r)) throw new Error(r.error)
    expect(auth.session(`Bearer ${r.token}`, T0 + 60_000)?.linked).toBe(adminWallet.address.toLowerCase())
    expect(auth.emailAdminWallets(T0 + 60_000)).toEqual([privyWallet.address.toLowerCase()])
    const audit = (await store.audit(10)).find(a => a.action === 'admin.login')
    expect(audit?.detail).toMatchObject({ by: 'linked-wallet', linked: adminWallet.address.toLowerCase() })
  })

  test('the admin wallet itself still signs in with no token at all', async () => {
    const { auth } = await setupWallets([adminWallet.address.toLowerCase()])
    expect('token' in await signIn(auth, adminWallet)).toBe(true)
  })

  test('refused: no admin wallet linked, a wallet outside the account, no token, a forged token', async () => {
    const { k, auth } = await setupWallets([adminWallet.address.toLowerCase()])
    const plain = await signIn(auth, privyWallet, await token(k.pair, { linked_accounts: viaMetaMask(privyWallet.address, otherWallet.address) }))
    expect(plain).toMatchObject({ status: 403, error: expect.stringContaining('no admin wallet linked') })
    const outside = await signIn(auth, otherWallet, await token(k.pair, { linked_accounts: viaMetaMask(privyWallet.address, adminWallet.address) }))
    expect(outside).toMatchObject({ status: 403, error: 'sign with a wallet of the same Privy account' })
    expect(await signIn(auth, privyWallet)).toMatchObject({ status: 403, error: 'this wallet is not an admin' })
    const other = await keys()
    const forged = await signIn(auth, privyWallet, await token(other.pair, { linked_accounts: viaMetaMask(privyWallet.address, adminWallet.address) }))
    expect(forged).toMatchObject({ status: 403 })
  })

  test('the session ends once the linked wallet is no longer an admin', async () => {
    const admins = [adminWallet.address.toLowerCase()]
    const { k, auth } = await setupWallets(admins)
    const r = await signIn(auth, privyWallet, await token(k.pair, { linked_accounts: viaMetaMask(privyWallet.address, adminWallet.address) }))
    if (!('token' in r)) throw new Error(r.error)
    admins.length = 0
    expect(auth.session(`Bearer ${r.token}`, T0 + 60_000)).toBeNull()
    expect(auth.emailAdminWallets(T0 + 60_000)).toEqual([])
  })
})
