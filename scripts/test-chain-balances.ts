// The wallets card's Ethereum and Arbitrum balances (src/arcdex/lib/chainBalances.ts): JSON-RPC requests, the next
// node on failure, base units kept as bigint, the dollar value, and Arc USDC's two decimals. Offline (fetch stubbed).
//   bun scripts/test-chain-balances.ts
import { arcUsdcSame, balanceUsd, EXTRA_CHAINS, readChainBalance } from '../src/arcdex/lib/chainBalances'

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }

const ME = '0x' + 'Ab'.repeat(20)
type Call = { url: string; method: string; params: unknown[] }

/** A stand-in fetch: `answer(url, method, params)` returns a JSON-RPC body, a status to fail with, or throws. */
function stub(answer: (c: Call) => { result?: string; error?: { message: string } } | number) {
  const calls: Call[] = []
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: unknown[] }
    const c = { url, method: body.method, params: body.params }
    calls.push(c)
    const a = answer(c)
    if (typeof a === 'number') return new Response('nope', { status: a })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...a }), { status: 200 })
  }) as unknown as typeof fetch
  return { f, calls }
}

console.log('reading a balance')
{
  const wei = 1_500_000_000_000_000_000n // 1.5 ETH
  const usdc = 12_345_678n                 // $12.345678
  const { f, calls } = stub(c => c.method === 'eth_getBalance' ? { result: '0x' + wei.toString(16) } : { result: '0x' + usdc.toString(16).padStart(64, '0') })
  const b = await readChainBalance('Ethereum', ME, f)
  check(b.native === wei && b.usdc === usdc && b.chain === 'Ethereum', 'ETH in wei and USDC in its 6-decimal units, as bigint')
  const call = calls.find(c => c.method === 'eth_call')!
  const tx = call.params[0] as { to: string; data: string }
  check(tx.to === EXTRA_CHAINS.Ethereum.usdc, 'USDC’s balance asked of Ethereum’s USDC contract')
  check(tx.data === '0x70a08231' + '000000000000000000000000' + ME.slice(2).toLowerCase(), 'balanceOf(address), the address padded to 32 bytes')
  check(calls.every(c => c.url === EXTRA_CHAINS.Ethereum.rpcs[0]), 'the first node answers both')
  check((calls.find(c => c.method === 'eth_getBalance')!.params as string[])[0] === ME, 'the balance read for the address asked')
}

console.log('the next node on failure')
{
  const [first, second] = EXTRA_CHAINS.Arbitrum.rpcs
  const { f, calls } = stub(c => {
    if (c.url === first && c.method === 'eth_getBalance') return 429
    if (c.url === first) return { error: { message: 'limit exceeded' } }
    return c.method === 'eth_getBalance' ? { result: '0x0' } : { result: '0x' + 5_000_000n.toString(16) }
  })
  const b = await readChainBalance('Arbitrum', ME, f)
  check(b.usdc === 5_000_000n && b.native === 0n, 'a throttled node and a node answering an error are both passed over')
  check(calls.filter(c => c.url === second).length === 2, 'the second node answers both reads')
}
{
  const { f } = stub(c => { if (c.method === 'eth_call') throw new Error('down'); return { result: '0x1' } })
  let threw = false
  try { await readChainBalance('Arbitrum', ME, f) } catch { threw = true }
  check(threw, 'no node answering: it throws (the card says it couldn’t reach the chain), it never reads 0')
}
{
  const { f } = stub(c => c.method === 'eth_call' ? { result: '0x' } : { result: '0x0' })
  const b = await readChainBalance('Ethereum', ME, f)
  check(b.usdc === 0n, 'an empty eth_call answer reads as no USDC')
}

console.log('dollars')
const b = { chain: 'Ethereum' as const, native: 2_000_000_000_000_000_000n, usdc: 10_500_000n }
check(balanceUsd(b, 2500) === 10.5 + 5000, '2 ETH at $2,500 plus $10.50 of USDC')
check(balanceUsd(b, null) === 10.5, 'ETH price unknown: only the USDC counts')
check(balanceUsd({ chain: 'Arbitrum', native: 0n, usdc: 0n }, 2500) === 0, 'nothing held: $0')

console.log('Arc USDC: 18 decimals native, 6 as the ERC-20, the same money')
check(arcUsdcSame(12_345_678_000_000_000_000n, 12_345_678n), 'native 12.345678 (18 decimals) is the ERC-20’s 12.345678 (6 decimals)')
check(arcUsdcSame(12_345_678_999_999_999_999n, 12_345_678n), 'native dust below 6 decimals is the same balance')
check(!arcUsdcSame(12_345_679_000_000_000_000n, 12_345_678n), 'a millionth of a dollar apart is not')

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
