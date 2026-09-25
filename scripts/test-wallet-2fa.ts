// Offline test of the trading wallet's encryption, including passkey 2FA.
// Run: bun scripts/test-wallet-2fa.ts
//
// The browser APIs the module touches (localStorage, window events,
// navigator.credentials) are stubbed; the passkey returns a fixed PRF
// secret per credential, like a real authenticator would. The crypto is
// the real WebCrypto implementation.

// @ts-expect-error — Bun built-in module; bun-types isn't installed
import { mock } from 'bun:test'

// wagmi/connectkit aren't needed for key handling — stub the chain module.
mock.module('../src/arcdex/wagmi', () => ({ arc: { id: 5042000, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } } }))

const store = new Map<string, string>()
const g = globalThis as Record<string, unknown>
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
g.window = { dispatchEvent: () => true, PublicKeyCredential: function () {} }
g.PublicKeyCredential = g.window && (g.window as Record<string, unknown>).PublicKeyCredential

// A fake authenticator: PRF(secret, salt) = SHA-256(secret ‖ salt).
let authenticatorPresent = true
const secret = crypto.getRandomValues(new Uint8Array(32))
const prf = async (salt: Uint8Array) => crypto.subtle.digest('SHA-256', new Uint8Array([...secret, ...salt]))
const rawId = crypto.getRandomValues(new Uint8Array(16)).buffer
g.navigator = {
  credentials: {
    create: async (o: { publicKey: { extensions: { prf: { eval: { first: Uint8Array } } } } }) => ({
      rawId, getClientExtensionResults: () => ({ prf: { enabled: true } }), // PRF output only on use
    }),
    get: async (o: { publicKey: { extensions: { prf: { eval: { first: Uint8Array } } } } }) => {
      if (!authenticatorPresent) { const e = new Error('cancelled'); (e as { name: string }).name = 'NotAllowedError'; throw e }
      const first = await prf(o.publicKey.extensions.prf.eval.first)
      return { getClientExtensionResults: () => ({ prf: { results: { first } } }) }
    },
  },
}

const w = await import('../src/arcdex/lib/embeddedWallet')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const fails = async (p: Promise<unknown>, want: RegExp, m: string) => {
  try { await p } catch (e) { ok(want.test((e as Error).message), `${m} (${(e as Error).message})`); return }
  throw new Error('FAIL: should have thrown — ' + m)
}

const addr = await w.createWallet('hunter22')
ok(!w.hasPasskey(), 'new wallet is passcode-only (v1)')
w.lock()
ok((await w.unlock('hunter22')) === addr, 'v1 unlock with passcode')
await fails(w.unlock('wrong!!'), /Wrong passcode/, 'v1 rejects wrong passcode')
const pk = await w.exportPrivateKey('hunter22')

await w.enablePasskey('hunter22')
ok(w.hasPasskey(), '2FA on (v2)')
const blob = JSON.parse(store.get('arcdex.embeddedWallet.v1')!)
ok(blob.v === 2 && blob.passkey?.id && blob.passkey?.prfSalt, 'blob records the credential and PRF salt, not the secret')
w.lock()
ok((await w.unlock('hunter22')) === addr, 'v2 unlock with passcode + passkey')
ok((await w.exportPrivateKey('hunter22')) === pk, 'same key after enabling 2FA')
await fails(w.unlock('wrong!!'), /Wrong passcode/, 'v2 rejects wrong passcode even with the passkey')
authenticatorPresent = false
await fails(w.unlock('hunter22'), /cancelled/, 'v2 needs the passkey — passcode alone fails')
authenticatorPresent = true

// The passcode-only key must NOT open a v2 blob (the passkey is really mixed in).
const salt = Uint8Array.from(atob(blob.salt), c => c.charCodeAt(0))
const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('hunter22'), 'PBKDF2', false, ['deriveKey'])
const passOnly = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250_000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
let opened = true
try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(atob(blob.iv), c => c.charCodeAt(0)) }, passOnly, Uint8Array.from(atob(blob.ciphertext), c => c.charCodeAt(0))) } catch { opened = false }
ok(!opened, 'passcode-derived key alone cannot decrypt the v2 blob')

await fails(w.enablePasskey('hunter22'), /already on/, 'enabling twice is refused')
await w.disablePasskey('hunter22')
ok(!w.hasPasskey(), '2FA off again (v1)')
authenticatorPresent = false
w.lock()
ok((await w.unlock('hunter22')) === addr, 'v1 unlock works without the passkey after disabling')
console.log('ALL WALLET 2FA CHECKS PASSED')
