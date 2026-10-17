// Live check of copy trading's buy path (lib/copyTrade.ts) on Arc mainnet, nothing sent: recent real trades from the
// engine (their coin and pool), each routed as a copy would be (ArcDexSwapRouter, or Uniswap's Universal Router for a
// native-USDC pool), rated as the copy rates it (the engine's scan, else the coin's market data), and a $1 copy simulated
// from an address holding USDC, as though its exact approval had landed, with its price (ARCDEX's fee aside) compared to
// the leader's. Run: VITE_ARCDEX_WS_URL=wss://arcdex-engine-production.up.railway.app/ws bun scripts/check-copy-trade.ts
import { createPublicClient, formatUnits, http, erc20Abi, type Address } from 'viem'

const { buildSwapRoute } = await import('../src/arcdex/api/argusMarket')
const { routerCall } = await import('../src/arcdex/lib/routerCalls')
const { usdcAllowanceOverride } = await import('../src/arcdex/lib/fastBuy')
const { encodeNativeBuy, feeShares, quoteExactIn, universalRouter, UR_ABI } = await import('../src/arcdex/api/universalRouter')
const { dryPool, priceAllows, ratingOf, safetyAllows, DEFAULT_RULE } = await import('../src/arcdex/lib/copyTrade')

const E = 'https://arcdex-engine-production.up.railway.app'
const H = { origin: 'https://arcsense.site' }
const client = createPublicClient({ transport: http('https://rpc.mainnet.arc.io') })
const USDC = '0x3600000000000000000000000000000000000000' as Address
const ROUTER = '0xD07583f7DB671521AAcFdA2b4612AD187aA2924e' as Address
const FEE_WALLET = '0x274262A0321A0701b0A46a3576e07aE881c286Bb' as Address
const ME = '0x4cd00e387622c35bddb9b4c962c136462338bc31' as Address // holds USDC, never approved the router
const AMOUNT = 1_000_000n
const FEE_BPS = Number(await client.readContract({ address: ROUTER, abi: [{ name: 'feeBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const, functionName: 'feeBps' }))

if (!process.env.VITE_ARCDEX_WS_URL) console.log('(VITE_ARCDEX_WS_URL unset: coins are rated from nothing, so every one reads unrated)\n')
const active = (await fetch(`${E}/v1/tokens/active?limit=40`, { headers: H }).then(r => r.json())) as { tokens: { token: string }[] }
const count = { tried: 0, routed: 0, simulated: 0, native: 0, dry: 0, rated: 0, priceOk: 0 }
for (const a of active.tokens.slice(0, 25)) {
  const j = (await fetch(`${E}/v1/tokens/${a.token}/trades?limit=5`, { headers: H }).then(r => r.json())) as { trades?: { s: string; pl: string; u: number | null; ba: number; w: string | null }[] }
  const t = (j.trades ?? []).find(x => x.s === 'B' && x.pl && x.u && x.ba > 0)
  if (!t) continue
  count.tried++
  const token = a.token as Address
  const route = await buildSwapRoute(token, t.pl).catch(() => null)
  const sym = await client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => token.slice(0, 8))
  if (!route || route.kind === 'curve') { console.log(`  · ${sym}: ${route ? 'on its curve' : 'no route'}, skipped as a copy would`); continue }
  count.routed++
  const level = await ratingOf(token, String(sym))
  if (level !== 'unrated') count.rated++
  const why = safetyAllows(level, DEFAULT_RULE(t.w ?? '0x0'))
  const dec = await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
  try {
    let out: bigint
    if (route.kind === 'v4native') {
      const ur = await universalRouter()
      const shares = feeShares(FEE_BPS, 1500, FEE_WALLET, null)
      const value = AMOUNT * 10n ** 12n
      const q = await quoteExactIn(route.key, true, encodeNativeBuy(route.key, value, shares, 0n, ME).swapIn).catch(e => { if (dryPool(e)) return 0n; throw e })
      if (q === 0n) { count.dry++; console.log(`  · ${sym}: native pool with no liquidity at its price, skipped as a copy would`); continue }
      const call = encodeNativeBuy(route.key, value, shares, (q * 97n) / 100n, ME)
      await client.simulateContract({ address: ur, abi: UR_ABI, functionName: 'execute', args: [call.commands, call.inputs, BigInt(Math.floor(Date.now() / 1000) + 300)], value, account: ME })
      out = q
      count.native++
    } else {
      const call = routerCall({ version: 2, feeBps: FEE_BPS, referralShareBps: 1500 }, route, { buy: true, tokenIn: USDC, tokenOut: token, amountIn: AMOUNT, minOut: 1n, referrer: '0x0000000000000000000000000000000000000000', deadline: BigInt(Math.floor(Date.now() / 1000) + 300) })
      out = (await client.simulateContract({ address: ROUTER, ...call, account: ME, stateOverride: usdcAllowanceOverride(ME, ROUTER, AMOUNT) } as never) as { result: bigint }).result
    }
    const ours = 1 / Number(formatUnits(out, dec))
    const theirs = (t.u ?? 0) / t.ba
    const off = priceAllows(ours, theirs, 3, FEE_BPS)
    if (!off) count.priceOk++
    count.simulated++
    console.log(`  ✓ ${sym}: ${route.kind}, rated ${level}${why ? ` (a copy would skip: ${why})` : ''}; $1 buys ${Number(formatUnits(out, dec)).toFixed(2)}, ${(((ours * (1 - FEE_BPS / 1e4)) / theirs - 1) * 100).toFixed(1)}% vs the leader's price, fee aside${off ? ' (over 3%: skipped)' : ''}`)
  } catch (e) {
    console.log(`  ✗ ${sym} (${route.kind}): simulation reverted: ${(e as Error).message.split('\n').find(l => /revert|reason/i.test(l)) ?? (e as Error).message.split('\n')[0]}`)
  }
}
// The busiest coins are often pools whose liquidity was just pulled; the deepest native-USDC pools in the market list
// show the Universal Router path on pools that can be bought.
const market = (await fetch(`${E}/api/argus`, { headers: H }).then(r => r.json())) as { pools?: { pool: string; token: { address: string; symbol: string }; quote: { address: string }; liquidityUsd: number }[] }
for (const p of (market.pools ?? []).filter(p => /^0x0{40}$/i.test(p.quote.address)).sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, 4)) {
  const route = await buildSwapRoute(p.token.address, p.pool).catch(() => null)
  if (route?.kind !== 'v4native') continue
  try {
    const ur = await universalRouter()
    const shares = feeShares(FEE_BPS, 1500, FEE_WALLET, null)
    const value = AMOUNT * 10n ** 12n
    const q = await quoteExactIn(route.key, true, encodeNativeBuy(route.key, value, shares, 0n, ME).swapIn)
    const call = encodeNativeBuy(route.key, value, shares, (q * 97n) / 100n, ME)
    await client.simulateContract({ address: ur, abi: UR_ABI, functionName: 'execute', args: [call.commands, call.inputs, BigInt(Math.floor(Date.now() / 1000) + 300)], value, account: ME })
    count.native++; count.simulated++
    const level = await ratingOf(p.token.address, p.token.symbol)
    console.log(`  ✓ ${p.token.symbol} ($${Math.round(p.liquidityUsd).toLocaleString()} liquidity): v4native through ${ur}, rated ${level}; $1 buys ${Number(formatUnits(q, 18)).toFixed(2)}`)
  } catch (e) {
    console.log(`  ✗ ${p.token.symbol} (v4native): ${(e as Error).message.split('\n')[0]}`)
  }
}

console.log(`\n${count.tried} coins with a recent buy; ${count.routed} routable; ${count.simulated} simulated (${count.native} through the Universal Router; ${count.dry} native pools dry); ${count.rated} rated; ${count.priceOk} within 3% of the leader's price`)
if (!count.simulated) process.exit(1)
