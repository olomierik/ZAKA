// End-to-end check of ARCDEX's social backend against a live deployment,
// using two throwaway wallets generated here. Every write is undone at the
// end (unfollow, unlike, delete thesis), so it leaves no data behind.
//   bun scripts/test-social-live.ts [https://arcdex.online]
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const BASE = process.argv[2] ?? 'https://arcdex.online'
const ARGUS = '0xece5ca8bf9220718e5727754026757512212cb3c'
const env = await Bun.file(new URL('../.env', import.meta.url)).text()
const SB_URL = env.match(/^VITE_SUPABASE_URL=(.*)$/m)![1].trim()
const SB_KEY = env.match(/^VITE_SUPABASE_ANON_KEY=(.*)$/m)![1].trim()

let fails = 0
const ok = (c: boolean, m: string) => { if (c) console.log('  ✓', m); else { fails++; console.log('  ✗', m) } }

const msg = (a: string, issued: string, nonce: string) => ['Sign in to ARCDEX (arcdex.online)', '', 'This only proves you own this wallet. It is not a transaction and costs nothing.', '', `Wallet: ${a.toLowerCase()}`, `Issued: ${issued}`, `Nonce: ${nonce}`].join('\n')

async function signIn(pk: `0x${string}`) {
  const acct = privateKeyToAccount(pk)
  const issuedAt = new Date().toISOString(), nonce = 'e2e' + Math.random().toString(36).slice(2, 12)
  const signature = await acct.signMessage({ message: msg(acct.address, issuedAt, nonce) })
  const r = await fetch(`${BASE}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: acct.address, issuedAt, nonce, signature }) })
  const j = await r.json() as { token?: string; error?: string }
  return { address: acct.address.toLowerCase(), token: j.token, status: r.status, error: j.error }
}
const social = async (token: string | undefined, body: Record<string, unknown>) => {
  const r = await fetch(`${BASE}/api/social`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, unknown> }
}
const read = async (path: string) => (await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } })).json() as Promise<unknown[]>

const A = await signIn(generatePrivateKey()), B = await signIn(generatePrivateKey())
ok(A.status === 200 && !!A.token, `sign-in with a wallet signature (${A.status}${A.error ? ' ' + A.error : ''})`)
ok((await social(undefined, { action: 'follow', target: B.address })).status === 401, 'writes without a session are rejected')

ok((await social(A.token, { action: 'follow', target: B.address })).status === 200, 'A follows B')
ok((await read(`arcdex_follows?follower=eq.${A.address}&following=eq.${B.address}`)).length === 1, 'follow is publicly readable')

const t = await social(A.token, { action: 'thesis', token: ARGUS, body: 'e2e test thesis — deleted immediately' })
const id = (t.json.thesis as { id?: number } | undefined)?.id
ok(t.status === 200 && typeof id === 'number', 'A posts a thesis')
ok((await social(B.token, { action: 'like', thesis_id: id })).status === 200, 'B likes it')
const tv = await read(`arcdex_theses_v?id=eq.${id}&select=likes`) as { likes: number }[]
ok(Number(tv[0]?.likes) === 1, 'like count reads back as 1')
ok((await social(B.token, { action: 'thesis.delete', id })).status === 200 && (await read(`arcdex_theses?id=eq.${id}`)).length === 1, 'B cannot delete A\'s thesis')
ok((await social(A.token, { action: 'thesis', token: ARGUS, body: 'x'.repeat(281) })).status === 400, 'a thesis over 280 chars is rejected')

// clean up
await social(B.token, { action: 'unlike', thesis_id: id })
await social(A.token, { action: 'thesis.delete', id })
await social(A.token, { action: 'unfollow', target: B.address })
ok((await read(`arcdex_theses?id=eq.${id}`)).length === 0, 'cleanup: thesis deleted by its author')
ok((await read(`arcdex_follows?follower=eq.${A.address}`)).length === 0, 'cleanup: unfollowed')

console.log(fails ? `\n${fails} FAILED` : '\nALL LIVE SOCIAL CHECKS PASSED')
process.exit(fails ? 1 : 0)
