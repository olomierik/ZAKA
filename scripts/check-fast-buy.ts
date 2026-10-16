// Live check of the trading wallet's fast buy (lib/fastBuy.ts) on Arc mainnet, nothing sent: a $1 $ARCDEX buy through
// ArcDexSwapRouter, simulated from an address holding USDC that never approved the router. Without the allowance
// override it's refused; with it, it goes through, its gas is measured, and the override's slot reads back as the
// allowance. Run: bun scripts/check-fast-buy.ts
import { createPublicClient, encodeFunctionData, erc20Abi, http, type Address } from 'viem'

const { buildSwapRoute } = await import('../src/arcdex/api/argusMarket')
const { ROUTER_V2 } = await import('../src/arcdex/components/ArgusSwapWidget')
const { usdcAllowanceOverride, gasWithAllowance } = await import('../src/arcdex/lib/fastBuy')
const { COIN, COIN_POOL } = await import('../src/arcdex/lib/coin')

const ok = (c: unknown, m: string) => { if (!c) { console.error('  ✗', m); process.exit(1) } console.log('  ✓', m) }
const client = createPublicClient({ transport: http('https://rpc.mainnet.arc.io') })
const USDC = '0x3600000000000000000000000000000000000000' as Address
const ROUTER = '0xD07583f7DB671521AAcFdA2b4612AD187aA2924e' as Address
// Relay's depository on Arc: holds USDC, and has never approved ARCDEX's router.
const ME = '0x4cd00e387622c35bddb9b4c962c136462338bc31' as Address
const AMOUNT = 1_000_000n
const ZERO = '0x0000000000000000000000000000000000000000' as Address

const bal = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [ME] })
const allowance = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [ME, ROUTER] })
ok(bal >= AMOUNT && allowance < AMOUNT, `the test address holds $${(Number(bal) / 1e6).toFixed(0)} and hasn't approved the router`)
const read = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [ME, ROUTER], stateOverride: usdcAllowanceOverride(ME, ROUTER, AMOUNT) })
ok(read === AMOUNT, 'the override sets exactly allowance(owner, router)')

const route = await buildSwapRoute(COIN, COIN_POOL)
ok(route?.kind === 'v4', `$ARCDEX's route is a v4 pool`)
if (route?.kind !== 'v4') process.exit(1)
const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
const call = { address: ROUTER, abi: ROUTER_V2, functionName: 'swapExactInV4' as const, args: [route.buyKeys, USDC, AMOUNT, 1n, deadline, ZERO] as const, account: ME }
const plain = await client.simulateContract(call as never).then(() => 'went through', (e: Error) => (e.message.split('\n').find(l => /allowance/i.test(l)) ?? e.message.split('\n')[0]).trim())
ok(/allowance/i.test(plain), `without the approval, the buy is refused (${plain.slice(0, 60)})`)
const { result } = await client.simulateContract({ ...call, stateOverride: usdcAllowanceOverride(ME, ROUTER, AMOUNT) } as never) as { result: bigint }
ok(result > 0n, `as though approved, it buys ${(Number(result) / 1e18).toFixed(0)} $ARCDEX for $1`)
const data = encodeFunctionData({ abi: ROUTER_V2, functionName: 'swapExactInV4', args: call.args as never })
const gas = await gasWithAllowance(client as never, ME, ROUTER, data, ROUTER, AMOUNT)
ok(gas > 50_000n && gas < 3_000_000n, `its gas is measured: ${gas} with 30% headroom`)
const less = await client.simulateContract({ ...call, stateOverride: usdcAllowanceOverride(ME, ROUTER, AMOUNT - 1n) } as never).then(() => 'went through', () => 'refused')
ok(less === 'refused', 'an allowance one unit short is refused: the approval sent is exactly what the swap needs')
console.log('\nfast buy checks passed')
