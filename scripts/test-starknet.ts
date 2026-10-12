// Starknet swaps through AVNU (src/arcdex/starknet), offline on recorded answers (scripts/fixtures/avnu.json, from
// scripts/capture-avnu.ts): felts and selectors, real quotes and builds passing ARCDEX's checks, tampered ones refused,
// the fee, the price-impact verdict, routes, and the wallet API calls.
//   bun scripts/test-starknet.ts

import { readFileSync } from 'fs'
import { AVNU_EXCHANGE, ETH, STRK } from '../src/arcdex/starknet/net'
import { SEL, felt, fromU256, padAddress, parseUnits, sameFelt, u256 } from '../src/arcdex/starknet/felt'
import { checkBuild, checkQuote, minReceived, quoteUrl, routeNames, swapVerdict, type AvnuCall, type AvnuQuote, type SwapAsk } from '../src/arcdex/starknet/avnu'
import { detectWallets, invoke, networkOf, type SnWallet } from '../src/arcdex/starknet/wallet'

let failed = 0
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? '✓' : '✗'} ${what}`); if (!cond) failed++ }

const f = JSON.parse(readFileSync('scripts/fixtures/avnu.json', 'utf8')) as {
  taker: string; recipient: string; plain: AvnuQuote; plainBuild: { calls: AvnuCall[] }; withFee: AvnuQuote; withFeeBuild: { calls: AvnuCall[] }; multi: AvnuQuote
}
const ask: SwapAsk & { slippage: number } = { net: 'mainnet', sellToken: STRK, buyToken: ETH, sellAmount: 10n * 10n ** 18n, taker: f.taker, slippage: 0.01 }
const fee = { recipient: f.recipient, bps: 100 }
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

console.log('felts and selectors')
{
  ok(SEL.transfer === '0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e', 'transfer')
  ok(SEL.balanceOf === '0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e', 'balanceOf')
  ok(SEL.approve === '0x219209e083275171774dab1df80982e9df2096516f06319c5c6d71ae0a8480c', 'approve')
  ok(SEL.Transfer === '0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9', 'the Transfer event')
  ok(sameFelt('0x04718f5a', '0x4718F5A') && !sameFelt('0x1', '0x2') && !sameFelt('nope', 'nope'), 'addresses compare by value, not padding or case')
  ok(padAddress('0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d') === STRK, 'padded to 64 hex digits')
  const big = (1n << 200n) + 12345n
  ok(fromU256(...u256(big)) === big && fromU256('0x1', '0x0') === 1n && fromU256(`0x${(1n << 128n).toString(16)}`, '0x0') === null, 'u256 splits and joins; a low part past 128 bits is refused')
  ok(parseUnits('1.5', 18) === 1_500_000_000_000_000_000n && parseUnits('0.000001', 6) === 1n && parseUnits('0.0000001', 6) === null && parseUnits('1e5', 18) === null, 'typed amounts to units (too many decimals or not a number: refused)')
  ok(felt('-1') === null && felt('0x') === null && felt(12) === 12n, 'only felts are felts')
}

console.log('real quotes pass')
{
  ok(checkQuote(f.plain, ask, null) === null, `10 STRK → ETH, no fee: ${routeNames(f.plain.routes).join(', ')}`)
  ok(checkQuote(f.withFee, ask, fee) === null, 'with a 1% integrator fee')
  ok(checkQuote(f.withFee, ask, null) !== null && checkQuote(f.plain, ask, fee) !== null, 'a quote with the wrong fee is refused either way')
  ok(quoteUrl(ask, fee).includes('integratorFees=0x64') && !quoteUrl(ask, null).includes('integratorFees'), 'the fee is asked for in hex, and only when set')
  const hops: string[] = []
  for (let r: AvnuQuote['routes'][number] | undefined = f.multi.routes[0]; r; r = r.routes?.[0]) hops.push(r.name)
  ok(hops.length >= 2 && routeNames(f.multi.routes).join() === `${hops.join(' → ')} 100%`, `a multi-hop route reads as one: ${routeNames(f.multi.routes).join(', ')}`)
}

console.log('tampered quotes are refused')
{
  const t: [string, (q: AvnuQuote) => void][] = [
    ['another chain', q => { q.chainId = '0x534e5f5345504f4c4941' }],
    ['another sell token', q => { q.sellTokenAddress = ETH }],
    ['another buy token', q => { q.buyTokenAddress = STRK }],
    ['another amount', q => { q.sellAmount = '0x1' }],
    ['nothing to receive', q => { q.buyAmount = '0x0' }],
    ['a fee nobody asked for', q => { q.fee.integratorFeesBps = '0x64' }],
    ['routes that don’t add up', q => { q.routes[0].percent = 0.5 }],
    ['no route', q => { q.routes = [] }],
  ]
  for (const [name, mut] of t) { const q = clone(f.plain); mut(q); ok(checkQuote(q, ask, null) !== null, name) }
}

console.log('real builds pass')
{
  ok(checkBuild(f.plainBuild.calls, f.plain, ask, null) === null, `approve + multi_route_swap: ${f.plainBuild.calls.map(c => c.entrypoint).join(' + ')}`)
  ok(checkBuild(f.withFeeBuild.calls, f.withFee, ask, fee) === null, 'with the fee to its recipient')
  ok(checkBuild([f.plainBuild.calls[1]], f.plain, ask, null) === null, 'the swap alone (an allowance already there)')
  const min = minReceived(f.plainBuild.calls)!
  ok(min < BigInt(f.plain.buyAmount) && min * 1000n >= BigInt(f.plain.buyAmount) * 989n, 'its minimum is 1% under the quote')
}

console.log('tampered builds are refused')
{
  const swapIx = 1
  const t: [string, (c: AvnuCall[]) => AvnuCall[]][] = [
    ['an approval to someone else', c => { c[0].calldata[0] = f.taker; return c }],
    ['an unlimited approval', c => { c[0].calldata[1] = '0xffffffffffffffffffffffffffffffff'; c[0].calldata[2] = '0xffffffffffffffffffffffffffffffff'; return c }],
    ['an approval of another token', c => { c[0].contractAddress = ETH; return c }],
    ['a transfer instead of an approval', c => { c[0].entrypoint = 'transfer'; return c }],
    ['a swap on another contract', c => { c[swapIx].contractAddress = f.taker; return c }],
    ['another entry point', c => { c[swapIx].entrypoint = 'swap_exact_token_to'; return c }],
    ['selling another token', c => { c[swapIx].calldata[0] = ETH; return c }],
    ['selling more', c => { c[swapIx].calldata[1] = '0x8ac7230489e80001'; return c }],
    ['buying another token', c => { c[swapIx].calldata[3] = STRK; return c }],
    ['a minimum past the slippage', c => { const m = u256(BigInt(f.plain.buyAmount) * 9n / 10n); c[swapIx].calldata[6] = m[0]; c[swapIx].calldata[7] = m[1]; return c }],
    ['a minimum of nothing', c => { c[swapIx].calldata[6] = '0x0'; return c }],
    ['coins to someone else', c => { c[swapIx].calldata[8] = AVNU_EXCHANGE; return c }],
    ['a hidden fee', c => { c[swapIx].calldata[9] = '0x64'; c[swapIx].calldata[10] = f.recipient; return c }],
    ['an extra call', c => [...c, c[0]]],
    ['no calls', () => []],
    ['short calldata', c => { c[swapIx].calldata = c[swapIx].calldata.slice(0, 9); return c }],
  ]
  for (const [name, mut] of t) ok(checkBuild(mut(clone(f.plainBuild.calls)), f.plain, ask, null) !== null, name)
  const smuggled = clone(f.plainBuild.calls)
  smuggled.splice(1, 0, { contractAddress: STRK, entrypoint: 'transfer', calldata: [f.recipient, '0x8ac7230489e80000', '0x0'] })
  ok(checkBuild(smuggled, f.plain, ask, null) !== null, 'a transfer slipped in before the swap')
  const bpsOnly = clone(f.plainBuild.calls)
  bpsOnly[swapIx].calldata[9] = '0x64'
  ok(checkBuild(bpsOnly, f.plain, ask, null) !== null, 'a fee rate with no recipient named')
  const feeCalls = clone(f.withFeeBuild.calls)
  feeCalls[1].calldata[10] = '0x123'
  ok(checkBuild(feeCalls, f.withFee, ask, fee) !== null, 'the fee sent to another recipient')
  const feeRate = clone(f.withFeeBuild.calls)
  feeRate[1].calldata[9] = '0xc8'
  ok(checkBuild(feeRate, f.withFee, ask, fee) !== null, 'a higher fee rate to the right recipient')
}

console.log('price impact')
{
  const q = clone(f.plain)
  q.priceImpact = -1_400; ok(swapVerdict(q).ok && !swapVerdict(q).confirm, '14% loss: allowed')
  q.priceImpact = -1_500; ok(swapVerdict(q).ok && swapVerdict(q).confirm, '15%: needs a tick')
  q.priceImpact = -5_000; ok(!swapVerdict(q).ok, '50%: refused')
  q.priceImpact = 21; ok(swapVerdict(q).ok && swapVerdict(q).lossPct === 0, 'better than the market: no loss')
}

console.log('the wallet API')
{
  const asked: { type: string; params?: unknown }[] = []
  const fake: SnWallet = { id: 'test', name: 'Test wallet', icon: '', request: async c => { asked.push(c); return c.type === 'wallet_addInvokeTransaction' ? { transaction_hash: '0xabc' } : null } }
  ;(globalThis as Record<string, unknown>).window = { starknet_test: fake, starknet_dup: fake, starknetSomething: { id: 'x' }, ethereum: {} }
  const found = detectWallets()
  ok(found.length === 1 && found[0].id === 'test', 'finds an injected wallet once, and only objects that speak the wallet API')
  const hash = await invoke(fake, f.plainBuild.calls)
  const p = asked[0].params as { calls: { contract_address: string; entry_point: string; calldata: string[] }[] }
  ok(hash === '0xabc' && asked[0].type === 'wallet_addInvokeTransaction' && p.calls.length === 2 && p.calls[1].entry_point === 'multi_route_swap' && p.calls[1].contract_address === f.plainBuild.calls[1].contractAddress, 'sends the checked calls as wallet_addInvokeTransaction')
  ok(networkOf('0x534e5f4d41494e') === 'mainnet' && networkOf('0x534e5f5345504f4c4941') === 'sepolia' && networkOf('SN_GOERLI') === null, 'chain ids')
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall Starknet checks passed')
