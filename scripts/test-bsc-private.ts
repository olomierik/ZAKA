// Anti-MEV on BNB Chain (src/arcdex/lib/bscPrivate.ts): the trading wallet's signed transactions go to the private RPCs
// only, in order, the same bytes each time, never the public node; which answers move on and which stop; and the
// transport sending only `eth_sendRawTransaction` there. `--live` checks each private RPC as a browser would (CORS from
// arcsense.site and localhost:5173) and sends a transaction signed by a throwaway, unfunded key: each must validate it
// and refuse it for want of funds (nothing can land).
//   bun scripts/test-bsc-private.ts [--live]
import { createWalletClient, custom, keccak256, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'
import { BSC_PRIVATE_RPCS, BscPrivateError, bscMevStatus, privateSendTransport, sendRawPrivately } from '../src/arcdex/lib/bscPrivate'
import { BSC_RPC_BROWSER } from '../api/_bscCore'

let n = 0
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); n++; console.log('  ✓', m) }

const acct = privateKeyToAccount(generatePrivateKey())
const sign = (nonce = 0) => acct.signTransaction({ chainId: 56, type: 'legacy', nonce, to: acct.address, value: 0n, gas: 21_000n, gasPrice: 100_000_000n })
const raw = await sign()
const hash = keccak256(raw)
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const rpcOk = (result: unknown) => reply(200, { jsonrpc: '2.0', id: 1, result })
const rpcErr = (message: string, status = 200) => reply(status, { jsonrpc: '2.0', id: 1, error: { code: -32000, message } })

console.log('the private RPCs')
ok(BSC_PRIVATE_RPCS.length >= 2 && BSC_PRIVATE_RPCS.every(r => r.url.startsWith('https://')), 'at least two, over HTTPS')
ok(!BSC_PRIVATE_RPCS.some(r => (r.url as string) === BSC_RPC_BROWSER || /publicnode|dataseed|binance\.org/.test(r.url)), 'none of them a public node')

console.log('sending')
{
  const seen: { url: string; body: { method: string; params: Hex[] } }[] = []
  const h = await sendRawPrivately(raw, async (url, init) => { seen.push({ url, body: JSON.parse(String(init.body)) }); return rpcOk(hash) })
  ok(h === hash && seen.length === 1 && seen[0].url === BSC_PRIVATE_RPCS[0].url, 'the first private RPC takes it, and its hash comes back')
  ok(seen[0].body.method === 'eth_sendRawTransaction' && seen[0].body.params[0] === raw, 'eth_sendRawTransaction with the signed bytes, unchanged')
}
for (const [why, first] of [
  ['busy (429)', () => rpcErr('rate limit exceeded', 429)],
  ['down (502)', () => new Response('<html>bad gateway</html>', { status: 502 })],
  ['an answer that isn’t JSON-RPC', () => new Response('nope', { status: 200 })],
  ['a rate-limit error in the body', () => rpcErr('too many requests')],
] as const) {
  const sent: string[] = []
  const bodies: string[] = []
  const h = await sendRawPrivately(raw, async (url, init) => { sent.push(url); bodies.push(String(init.body)); return sent.length === 1 ? first() : rpcOk(hash) })
  ok(h === hash && sent.length === 2 && sent[1] === BSC_PRIVATE_RPCS[1].url && bodies[0] === bodies[1], `${why}: the next private RPC gets the same bytes`)
}
{
  const sent: string[] = []
  const h = await sendRawPrivately(raw, async url => { sent.push(url); if (sent.length === 1) throw new Error('connection reset'); return rpcOk(hash) })
  ok(h === hash && sent.length === 2, 'no answer at all (a lost connection): the next private RPC gets the same bytes, one hash, so at most one can land')
}
{
  let tries = 0
  const e = await sendRawPrivately(raw, async () => { tries++; return rpcErr('insufficient funds for gas * price + value: balance 0') }).catch(x => x)
  ok(e instanceof BscPrivateError && tries === 1 && /insufficient funds/.test(e.message), 'a refusal of the transaction itself: no other RPC is asked, and the reason comes back')
}
{
  let tries = 0
  const e = await sendRawPrivately(raw, async () => { tries++; return rpcErr('nonce too low') }).catch(x => x)
  ok(e instanceof BscPrivateError && tries === 1, '“nonce too low” isn’t taken as a send (that nonce may belong to another transaction)')
}
{
  const sent: string[] = []
  const h = await sendRawPrivately(raw, async url => { sent.push(url); return sent.length === 1 ? rpcErr('timeout', 504) : rpcErr('already known') })
  ok(h === hash && sent.length === 2, '“already known” (the first had it after all): a send, with its hash')
}
{
  let tries = 0
  const e = await sendRawPrivately(raw, async () => { tries++; throw new Error('network down') }).catch(x => x)
  ok(e instanceof BscPrivateError && tries === BSC_PRIVATE_RPCS.length && /network down/.test(e.message), 'every private RPC out: an error after each was tried, never the public node')
}
{
  const e = await sendRawPrivately(raw, async () => rpcOk('0x' + '1'.repeat(64))).catch(x => x)
  ok(e instanceof BscPrivateError, 'an RPC answering another transaction’s hash is refused')
}

console.log('the trading wallet’s transport')
{
  const inner: string[] = []
  const priv: string[] = []
  let on = true
  const wallet = createWalletClient({
    account: acct, chain: bsc,
    transport: privateSendTransport(custom({
      async request({ method }: { method: string }) {
        inner.push(method)
        if (method === 'eth_chainId') return '0x38'
        if (method === 'eth_sendRawTransaction') return 'PUBLIC'
        throw new Error(`unexpected ${method}`)
      },
    }), () => on, async (url, init) => { priv.push(url); return rpcOk(keccak256((JSON.parse(String(init.body)) as { params: Hex[] }).params[0])) }),
  })
  const tx = { to: acct.address, value: 0n, gas: 21_000n, gasPrice: 100_000_000n, nonce: 7, type: 'legacy' as const }
  const h = await wallet.sendTransaction(tx)
  ok(priv.length === 1 && !inner.includes('eth_sendRawTransaction') && h === keccak256(await sign(7)), 'anti-MEV on: the signed transaction goes to the private RPC, not the public node')
  ok(inner.length > 0 && inner.every(m => m !== 'eth_sendRawTransaction'), 'everything else (chain id, reads) stays on the public node')
  on = false
  inner.length = 0
  const h2 = await wallet.sendTransaction({ ...tx, nonce: 8 })
  ok((h2 as string) === 'PUBLIC' && priv.length === 1 && inner.includes('eth_sendRawTransaction'), 'anti-MEV off: sent as before, through the public node')
}

console.log('what the trade form says')
ok(bscMevStatus('trading-wallet', true) === 'private' && bscMevStatus('trading-wallet', false) === 'off', 'the trading wallet: private, or off')
ok(bscMevStatus('wallet', true) === 'wallet' && bscMevStatus(undefined, true) === 'wallet' && bscMevStatus('solana-account', true) === 'wallet', 'an external wallet: not covered, whatever the setting')

if (process.argv.includes('--live')) {
  console.log('live (nothing funded)')
  for (const rpc of BSC_PRIVATE_RPCS) {
    for (const origin of ['https://arcsense.site', 'http://localhost:5173']) {
      const pre = await fetch(rpc.url, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
      const allow = pre.headers.get('access-control-allow-origin')
      ok(pre.status < 300 && (allow === '*' || allow === origin) && /content-type/i.test(pre.headers.get('access-control-allow-headers') ?? ''), `${rpc.name}: a browser on ${origin} may POST JSON (preflight ${pre.status}, allow-origin ${allow})`)
    }
    const r = await fetch(rpc.url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://arcsense.site' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
    ok((await r.json() as { result?: string }).result === '0x38' && r.headers.get('access-control-allow-origin') !== null, `${rpc.name}: BNB Chain (chain id 56), CORS on the answer`)
    const t0 = Date.now()
    const e = await sendRawPrivately(await sign(), (url, init) => fetch(url === rpc.url ? url : rpc.url, init)).catch(x => x)
    ok(e instanceof BscPrivateError && /insufficient funds/i.test(e.message), `${rpc.name}: takes eth_sendRawTransaction and validates it (refused for want of funds, ${Date.now() - t0} ms)`)
  }
}

console.log(`\n${n} checks passed`)
