// Live check of Starknet swaps through AVNU (src/arcdex/starknet), on mainnet, with nothing sent:
//   1. find an account that holds STRK (recent Transfer events),
//   2. quote 10 STRK → ETH and build it for that account; both must pass ARCDEX's checks,
//   3. simulate the exact transaction from that account (starknet_simulateTransactions, signature and fee skipped),
//      which must succeed and pay the account at least the minimum,
//   4. simulate it again with a minimum the route can't meet, which must be refused by AVNU's contract.
//   bun scripts/check-avnu.ts

import { AVNU_EXCHANGE, ETH, SN, STRK } from '../src/arcdex/starknet/net'
import { SEL, felt, fromU256, sameFelt, selector, toFelt, u256 } from '../src/arcdex/starknet/felt'
import { snBalance, snNonce, snRpc } from '../src/arcdex/starknet/rpc'
import { avnuBuild, avnuQuote, minReceived, routeNames, swapVerdict, type AvnuCall } from '../src/arcdex/starknet/avnu'

const net = 'mainnet' as const
const AMOUNT = 10n * 10n ** 18n

let failed = 0
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? '✓' : '✗'} ${what}`); if (!cond) failed++ }

interface Ev { from_address?: string; keys: string[]; data: string[] }
interface Invocation { contract_address: string; events?: { keys: string[]; data: string[] }[]; calls?: Invocation[]; revert_reason?: string }

async function holder(): Promise<string> {
  const head = await snRpc<number>(net, 'starknet_blockNumber', [])
  const r = await snRpc<{ events: Ev[] }>(net, 'starknet_getEvents', { filter: { from_block: { block_number: head - 60 }, to_block: 'latest', address: STRK, keys: [[SEL.Transfer]], chunk_size: 200 } })
  const senders = [...new Set(r.events.map(e => e.keys[1]))].filter(a => a && !sameFelt(a, AVNU_EXCHANGE))
  for (const a of senders.slice(0, 40)) {
    const bal = await snBalance(net, STRK, a).catch(() => 0n)
    if (bal < 50n * 10n ** 18n) continue
    // An account answers __execute__ simulations; a pool or a bridge doesn't. Try a do-nothing 0 STRK self-transfer.
    const sim = await simulate(a, [{ contractAddress: STRK, entrypoint: 'transfer', calldata: [a, '0x0', '0x0'] }]).catch(() => null)
    if (sim && !sim.revert) return a
  }
  throw new Error('no funded account found in the last 60 blocks')
}

function executeCalldata(calls: AvnuCall[]): string[] {
  const out = [toFelt(BigInt(calls.length))]
  for (const c of calls) out.push(c.contractAddress, selector(c.entrypoint), toFelt(BigInt(c.calldata.length)), ...c.calldata)
  return out
}

async function simulate(sender: string, calls: AvnuCall[]): Promise<{ revert: string | null; events: (Ev & { from_address: string })[] }> {
  const [nonce, block] = await Promise.all([
    snNonce(net, sender),
    snRpc<{ l1_gas_price: { price_in_fri: string }; l2_gas_price: { price_in_fri: string }; l1_data_gas_price: { price_in_fri: string } }>(net, 'starknet_getBlockWithTxHashes', { block_id: 'latest' }),
  ])
  const twice = (p: string) => toFelt((felt(p) ?? 1n) * 2n)
  const tx = {
    type: 'INVOKE', version: '0x3', sender_address: sender, calldata: executeCalldata(calls), signature: [], nonce,
    resource_bounds: {
      l1_gas: { max_amount: '0x0', max_price_per_unit: twice(block.l1_gas_price.price_in_fri) },
      l2_gas: { max_amount: toFelt(200_000_000n), max_price_per_unit: twice(block.l2_gas_price.price_in_fri) },
      l1_data_gas: { max_amount: toFelt(10_000n), max_price_per_unit: twice(block.l1_data_gas_price.price_in_fri) },
    },
    tip: '0x0', paymaster_data: [], account_deployment_data: [], nonce_data_availability_mode: 'L1', fee_data_availability_mode: 'L1',
  }
  const [r] = await snRpc<{ transaction_trace: { execute_invocation: Invocation | { revert_reason: string } } }[]>(net, 'starknet_simulateTransactions', {
    block_id: 'latest', transactions: [tx], simulation_flags: ['SKIP_VALIDATE', 'SKIP_FEE_CHARGE'],
  }, 30_000)
  const inv = r.transaction_trace.execute_invocation
  if ('revert_reason' in inv && !('contract_address' in inv)) return { revert: inv.revert_reason, events: [] }
  const events: (Ev & { from_address: string })[] = []
  const walk = (n: Invocation) => { for (const e of n.events ?? []) events.push({ ...e, from_address: n.contract_address }); for (const c of n.calls ?? []) walk(c) }
  walk(inv as Invocation)
  return { revert: (inv as Invocation).revert_reason ?? null, events }
}

const received = (events: (Ev & { from_address: string })[], token: string, to: string) =>
  events.filter(e => sameFelt(e.from_address, token) && sameFelt(e.keys[0], SEL.Transfer) && sameFelt(e.keys[2], to)).reduce((a, e) => a + (fromU256(e.data[0], e.data[1]) ?? 0n), 0n)

console.log('a funded account')
const taker = await holder()
console.log(`  · ${taker} (${Number(await snBalance(net, STRK, taker)) / 1e18} STRK)`)

console.log('quote and build (ARCDEX’s checks)')
const ask = { net, sellToken: STRK, buyToken: ETH, sellAmount: AMOUNT, taker, slippage: 0.01 }
const q = await avnuQuote(ask)
ok(true, `quoted 10 STRK → ${Number(BigInt(q.buyAmount)) / 1e18} ETH, ${routeNames(q.routes).join(', ')}, price impact ${q.priceImpact >= 0 ? "+" : ""}${(q.priceImpact / 100).toFixed(2)}% (AVNU: negative is a loss)`)
ok(swapVerdict(q).ok, 'within the price-impact limit')
const calls = await avnuBuild(q, ask)
const min = minReceived(calls)!
ok(calls.length >= 1 && calls[calls.length - 1].entrypoint === 'multi_route_swap', `built ${calls.length} call(s), checked: ${calls.map(c => c.entrypoint).join(' + ')}`)
ok(min > 0n && min <= BigInt(q.buyAmount), `minimum received ${Number(min) / 1e18} ETH (1% under the quote)`)

console.log('simulated on mainnet from that account (nothing sent)')
const sim = await simulate(taker, calls)
ok(sim.revert === null, `the swap goes through${sim.revert ? `: ${sim.revert.slice(0, 200)}` : ''}`)
const got = received(sim.events, ETH, taker)
ok(got >= min, `the account receives ${Number(got) / 1e18} ETH, at least the minimum`)
const strkOut = sim.events.filter(e => sameFelt(e.from_address, STRK) && sameFelt(e.keys[0], SEL.Transfer) && sameFelt(e.keys[1], taker)).reduce((a, e) => a + (fromU256(e.data[0], e.data[1]) ?? 0n), 0n)
ok(strkOut === AMOUNT, `and pays exactly 10 STRK`)

console.log('a minimum the route can’t meet')
const greedy = calls.map(c => (c.entrypoint === 'multi_route_swap' ? { ...c, calldata: c.calldata.map((x, i) => (i === 6 ? u256(BigInt(q.buyAmount) * 2n)[0] : i === 7 ? u256(BigInt(q.buyAmount) * 2n)[1] : x)) } : c))
const refused = await simulate(taker, greedy)
ok(refused.revert !== null, `refused by AVNU's contract${refused.revert ? `: ${refused.revert.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`)

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log(`\nall live AVNU checks passed (${SN[net].name})`)
