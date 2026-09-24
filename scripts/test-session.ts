// Checks wallet sign-in (api/session.ts + api/_session.ts) end to end with
// a throwaway key generated here.   bun scripts/test-session.ts
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

process.env.ARCDEX_SESSION_SECRET = 'test-secret-'.padEnd(48, 'x')
const { default: handler } = await import('../api/session')
const { verifyToken, signInMessage } = await import('../api/_session')

const acct = privateKeyToAccount(generatePrivateKey())
const other = privateKeyToAccount(generatePrivateKey())
const nonce = 'abc123XYZ789'
let fails = 0
const ok = (c: boolean, m: string) => { if (c) console.log('  ✓', m); else { fails++; console.log('  ✗', m) } }

async function post(body: unknown) {
  const res = await handler(new Request('https://arcdex.online/api/session', { method: 'POST', body: JSON.stringify(body) }))
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const issuedAt = new Date().toISOString()
const sig = await acct.signMessage({ message: signInMessage(acct.address, issuedAt, nonce) })

const good = await post({ address: acct.address, issuedAt, nonce, signature: sig })
ok(good.status === 200 && typeof good.json.token === 'string', 'valid signature → session token')
ok((await verifyToken(good.json.token as string)) === acct.address.toLowerCase(), 'token verifies back to the signer')

const wrongAddr = await post({ address: other.address, issuedAt, nonce, signature: sig })
ok(wrongAddr.status === 401, 'someone else\'s signature for this wallet → 401')

const tamperedMsg = await post({ address: acct.address, issuedAt, nonce: 'differentNonce1', signature: sig })
ok(tamperedMsg.status === 401, 'signature over a different message → 401')

const oldIssued = new Date(Date.now() - 60 * 60 * 1000).toISOString()
const oldSig = await acct.signMessage({ message: signInMessage(acct.address, oldIssued, nonce) })
const stale = await post({ address: acct.address, issuedAt: oldIssued, nonce, signature: oldSig })
ok(stale.status === 400, 'hour-old signed message → rejected (no replay)')

const [payload, mac] = (good.json.token as string).split('.')
const forgedPayload = btoa(JSON.stringify({ a: other.address.toLowerCase(), exp: 9_999_999_999 })).replace(/=+$/, '')
ok((await verifyToken(`${forgedPayload}.${mac}`)) === null, 'forged token for another address → rejected')
ok((await verifyToken(`${payload}.${mac.slice(0, -2)}AA`)) === null, 'tampered MAC → rejected')

console.log(fails ? `\n${fails} FAILED` : '\nALL SESSION CHECKS PASSED')
process.exit(fails ? 1 : 0)
