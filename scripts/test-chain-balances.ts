// The wallets card's Ethereum and Arbitrum balances (src/arcdex/lib/chainBalances.ts): JSON-RPC requests, the next
// node on failure, base units kept as bigint, the dollar value, and Arc USDC's two decimals. Offline (fetch stubbed).
//   bun scripts/test-chain-balances.ts
import { arcUsdcSame, balanceUsd, EXTRA_CHAINS, EXTRA_CHAIN_LIST, readChainBalance, stableUsd } from '../src/arcdex/lib/chainBalances'

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
const usdcTok = (raw: bigint) => ({ ...EXTRA_CHAINS.Ethereum.tokens[0], raw })
const b = { native: 2_000_000_000_000_000_000n, tokens: [usdcTok(10_500_000n)] }
check(balanceUsd(b, 2500) === 10.5 + 5000, '2 ETH at $2,500 plus $10.50 of USDC')
check(balanceUsd(b, null) === 10.5, 'ETH price unknown: only the USDC counts')
check(balanceUsd({ native: 0n, tokens: [usdcTok(0n)] }, 2500) === 0, 'nothing held: $0')

console.log('every chain the card reads (2026-10-18): its coin and dollar tokens')
check(EXTRA_CHAIN_LIST.join() === 'Robinhood,BNB,Base,Arbitrum,Ethereum', 'Robinhood Chain, BNB Chain, Base, Arbitrum and Ethereum')
{
  // Robinhood Chain: ETH, Paxos's USDG and the second token named USDG, each read and counted at $1.
  const { f, calls } = stub(c => c.method === 'eth_getBalance' ? { result: '0x' + (10n ** 15n).toString(16) }
    : { result: '0x' + ((c.params[0] as { to: string }).to === EXTRA_CHAINS.Robinhood.tokens[0].address ? 1_000_000n : 2_500_000n).toString(16) })
  const r = await readChainBalance('Robinhood', ME, f)
  check(r.tokens.length === 2 && r.tokens[0].raw === 1_000_000n && r.tokens[1].raw === 2_500_000n && r.native === 10n ** 15n, 'one USDG (6 decimals), 2.5 of the other USDG and 0.001 ETH')
  check(calls.filter(c => c.method === 'eth_call').map(c => (c.params[0] as { to: string }).to).join() === EXTRA_CHAINS.Robinhood.tokens.map(t => t.address).join(), 'both USDG contracts asked')
  check(stableUsd(r) === 3.5 && balanceUsd(r, 2000) === 5.5, 'the dollars: $3.50 of USDG, plus the ETH at its price')
  check(EXTRA_CHAINS.Robinhood.tokens[0].address === '0x5fc5360d0400a0fd4f2af552add042d716f1d168', 'the first USDG is Paxos’s Global Dollar, the one the trade forms take')
}
{
  // BNB Chain: BNB, USDT and USDC, both with 18 decimals.
  const { f } = stub(c => c.method === 'eth_getBalance' ? { result: '0x' + (2n * 10n ** 16n).toString(16) } : { result: '0x' + (5n * 10n ** 18n).toString(16) })
  const r = await readChainBalance('BNB', ME, f)
  check(EXTRA_CHAINS.BNB.native === 'BNB' && stableUsd(r) === 10 && balanceUsd(r, 600) === 22, '5 USDT and 5 USDC (18 decimals) and 0.02 BNB at $600')
}

console.log('Arc USDC: 18 decimals native, 6 as the ERC-20, the same money')
check(arcUsdcSame(12_345_678_000_000_000_000n, 12_345_678n), 'native 12.345678 (18 decimals) is the ERC-20’s 12.345678 (6 decimals)')
check(arcUsdcSame(12_345_678_999_999_999_999n, 12_345_678n), 'native dust below 6 decimals is the same balance')
check(!arcUsdcSame(12_345_679_000_000_000_000n, 12_345_678n), 'a millionth of a dollar apart is not')

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
