// Offline test of trading Mercuri's and SolonPad's own bonding curves
// (src/arcdex/api/curves.ts): the contracts' functions and events as
// published, the buy and sell calls ARCDEX sends (straight to a curve, and
// through ARCDEX's curve router), and the coin page's trades decoded from
// the curves' events.
// Run: bun scripts/test-curves.ts

import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toFunctionSelector, type AbiFunction, type Address, type Hex } from 'viem'

// ARCDEX's curve router, named before the modules load, as a build names it.
const ROUTER = '0x8a791620dd6260079bf849dc5567adc3f2fdc318' as Address
process.env.VITE_ARCDEX_CURVE_ROUTER_ADDRESS = '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318'

const c = await import('../src/arcdex/api/curves')
const { curveMeta, decodeSwap } = await import('../src/arcdex/api/poolSwaps')
const ok = (cond: unknown, m: string) => { if (!cond) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-12

const TOKEN = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1' as Address
const CURVE = '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0' as Address
const ME = '0x9999999999999999999999999999999999999999' as Address
const WALLET = '0x274262a0321a0701b0a46a3576e07ae881c286bb' as Address
const sel = (abi: readonly unknown[], name: string) => toFunctionSelector((abi as AbiFunction[]).find(f => f.type === 'function' && f.name === name)!)

console.log('the contracts, as published')
// Selectors and topics taken from the published sources: SolonPad's
// abis/PonsV2BondingCurve.json and abis/PonsV2LaunchFactory.json, and
// Mercuri's src/BondingCurve.sol and src/LaunchFactory.sol (v1.0.0).
const SOLON = { buy: '0x59a87bc1', sell: '0xd04c6983', currentSnipeTaxBps: '0xd7e1ef39', getReserves: '0x0902f1ac', graduated: '0xe7c2b772', isNativeQuote: '0xdc08e094' }
const MERC = { buy: '0x2afaca20', sell: '0x8a038a54', quoteBuy: '0x4beb394c', quoteSell: '0xa64190c4', price: '0xa035b1fe', progressBps: '0x6c1eba15' }
for (const [f, s] of Object.entries(SOLON)) ok(sel(c.SOLONPAD_CURVE_ABI, f) === s, `SolonPad curve ${f} = ${s}`)
for (const [f, s] of Object.entries(MERC)) ok(sel(c.MERCURI_CURVE_ABI, f) === s, `Mercuri curve ${f} = ${s}`)
ok(sel(c.MERCURI_FACTORY_ABI, 'curveOf') === '0x05adc47e' && sel(c.SOLONPAD_FACTORY_ABI, 'getLaunchedToken') === '0x3cf28b5a', 'factories: Mercuri curveOf, SolonPad getLaunchedToken')
ok(c.MERCURI_BUY === '0x2c5cc05b9a7b53e2478a9af1c94ec079b5be7c669be3df98ad86d28237f689e7' && c.MERCURI_SELL === '0x20a7fc03b19d7f251cc907f177ff82194c6aebe9a2b47e1cd734dcb6bf772cc2', 'Mercuri Buy/Sell event topics')
ok(c.SOLON_BUY === '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455' && c.SOLON_SELL === '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df', 'SolonPad CurveBuy/CurveSell event topics')
ok(c.MERCURI_FACTORY.toLowerCase() === '0x8f5dfa0c48e14ccd03ae01795b8a95759ba859eb' && c.SOLONPAD_FACTORY.toLowerCase() === '0xd6b86b9b1bb64b941b21aaa6a0e3a673e8405a3b', 'factory addresses (deployments/5042.json, addresses.json)')

const mercuri: import('../src/arcdex/api/curves').CurveInfo = {
  venue: 'Mercuri', curve: CURVE, token: TOKEN, canBuy: true, graduated: false, feeBps: 100, creatorTaxBps: 0, priceUsd: 0.0000075, progress: 0.2,
  name: 'Coin', symbol: 'COIN', supply: 1e9, virtual: { usdc: 6_000n * 10n ** 18n, tokens: 1_066_666_666n * 10n ** 18n },
}
const solon: import('../src/arcdex/api/curves').CurveInfo = { ...mercuri, venue: 'SolonPad', creatorTaxBps: 200, virtual: undefined }

console.log('the calls ARCDEX sends')
const value = 25n * 10n ** 18n, minOut = 123n, deadline = 1_900_000_000n
const mb = c.curveBuyCall(mercuri, value, minOut, ME, WALLET, deadline)
ok(mb.address === CURVE && mb.value === value && encodeFunctionData(mb as never) === encodeFunctionData({ abi: parseAbi(['function buy(uint256,address,uint256) payable']), functionName: 'buy', args: [minOut, WALLET, deadline] }),
  'Mercuri buy: msg.value = the USDC, min tokens out, ARCDEX\'s fee wallet as referrer, a deadline (tokens go to the sender)')
const sb = c.curveBuyCall(solon, value, minOut, ME, WALLET, deadline)
ok(sb.value === value && encodeFunctionData(sb as never) === encodeFunctionData({ abi: parseAbi(['function buy(uint256,uint256,address) payable']), functionName: 'buy', args: [value, minOut, ME] }),
  'SolonPad buy: quoteIn equal to msg.value (NativeValueMismatch otherwise), min out, the trader as recipient')
const ms = c.curveSellCall(mercuri, 7n * 10n ** 20n, 5n, ME, WALLET, deadline)
ok(ms.value === undefined && encodeFunctionData(ms as never) === encodeFunctionData({ abi: parseAbi(['function sell(uint256,uint256,address,uint256)']), functionName: 'sell', args: [7n * 10n ** 20n, 5n, WALLET, deadline] }),
  'Mercuri sell: tokens in, min USDC out, referrer, deadline; no value')
const ss = c.curveSellCall(solon, 7n * 10n ** 20n, 5n, ME, WALLET, deadline)
ok(ss.value === undefined && encodeFunctionData(ss as never) === encodeFunctionData({ abi: parseAbi(['function sell(uint256,uint256,address)']), functionName: 'sell', args: [7n * 10n ** 20n, 5n, ME] }),
  'SolonPad sell: tokens in, min USDC out, the trader as recipient; no value')

console.log('through ARCDEX\'s curve router (contracts/ArcDexCurveRouter.sol)')
// Selectors from the compiled contract (forge inspect ArcDexCurveRouter methodIdentifiers).
const ROUTER_SEL = { buyMercuri: '0xed547f55', sellMercuri: '0xc3d2df3f', buySolon: '0xc5f0a0e8', sellSolon: '0x3e799daa', feeBps: '0x24a9d853', referralShareBps: '0x47c9bc2d' }
for (const [f, s] of Object.entries(ROUTER_SEL)) ok(sel(c.CURVE_ROUTER_ABI, f) === s, `router ${f} = ${s}`)
ok(c.curveRouterConfigured && c.CURVE_ROUTER_ADDRESS === ROUTER, 'VITE_ARCDEX_CURVE_ROUTER_ADDRESS is read (lower-cased)')
ok(c.curveSpender(mercuri) === ROUTER && c.curveSpender(solon) === ROUTER, 'a sell is approved to the router, not the curve')
const router = { address: ROUTER, feeBps: 200, referralShareBps: 1_500 }
const REF = '0x7777777777777777777777777777777777777777' as Address
ok(c.routerSpend(router, value) === 245n * 10n ** 17n, 'the curve gets 98% of the value: 24.50 of 25 USDC (the router keeps 2%)')
const rmb = c.routerBuyCall(mercuri, router, value, minOut, REF, deadline)
ok(rmb.address === ROUTER && rmb.value === value && encodeFunctionData(rmb as never) === encodeFunctionData({ abi: parseAbi(['function buyMercuri(address,uint256,uint256,address) payable']), functionName: 'buyMercuri', args: [TOKEN, minOut, deadline, REF] }),
  'Mercuri buy: buyMercuri(token, min tokens out, deadline, referrer) with the whole value (the router takes its fee from it)')
const rsb = c.routerBuyCall(solon, router, value, minOut, REF, deadline)
ok(rsb.value === value && encodeFunctionData(rsb as never) === encodeFunctionData({ abi: parseAbi(['function buySolon(address,uint256,uint256,address) payable']), functionName: 'buySolon', args: [TOKEN, minOut, deadline, REF] }),
  'SolonPad buy: buySolon(token, min tokens out, deadline, referrer)')
const rms = c.routerSellCall(mercuri, router, 7n * 10n ** 20n, 5n, REF, deadline)
ok(rms.value === undefined && encodeFunctionData(rms as never) === encodeFunctionData({ abi: parseAbi(['function sellMercuri(address,uint256,uint256,uint256,address)']), functionName: 'sellMercuri', args: [TOKEN, 7n * 10n ** 20n, 5n, deadline, REF] }),
  'Mercuri sell: sellMercuri(token, tokens in, min USDC out after the fee, deadline, referrer); no value')
const rss = c.routerSellCall(solon, router, 7n * 10n ** 20n, 5n, REF, deadline)
ok(rss.value === undefined && encodeFunctionData(rss as never) === encodeFunctionData({ abi: parseAbi(['function sellSolon(address,uint256,uint256,uint256,address)']), functionName: 'sellSolon', args: [TOKEN, 7n * 10n ** 20n, 5n, deadline, REF] }),
  'SolonPad sell: sellSolon(token, tokens in, min USDC out after the fee, deadline, referrer); no value')

console.log('trades from the curves\' events')
const topic = (a: string) => ('0x' + a.slice(2).padStart(64, '0')) as Hex
const log = (topics: string[], data: Hex, address = CURVE) => ({ address, topics, data, blockNumber: '0x10', transactionHash: '0x' + 'ab'.repeat(32), logIndex: '0x3', blockTimestamp: '0x66f5a000' })
const E18 = 10n ** 18n
// Mercuri Buy: 9.9 net USDC in, 0.1 fee, 0.5 snipe tax; after it the curve holds 1,000 real USDC with 100M tokens sold.
const mBuy = log([c.MERCURI_BUY, topic(ME)], encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256,uint256,uint256'), [99n * E18 / 10n, 1_500_000n * E18, E18 / 10n, E18 / 2n, 1_000n * E18, 100_000_000n * E18]))
const d1 = c.decodeCurveTrade(mBuy, 'Mercuri', mercuri.virtual)
ok(d1?.kind === 'buy' && d1.trader === ME && near(d1.tokenAmount, 1_500_000) && Math.abs(d1.usdc - 10.5) < 1e-9, 'Mercuri Buy: the trader (indexed), tokens out, USDC paid = net + fee + tax')
ok(d1 && Math.abs(d1.price - 7_000 / 966_666_666) < 1e-15, `  price after it = (virtual + real USDC) / (virtual tokens − sold) = $${d1?.price.toPrecision(4)}`)
const mSell = log([c.MERCURI_SELL, topic(ME)], encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256,uint256'), [400_000n * E18, 27n * E18 / 10n, 3n * E18 / 100n, 997n * E18, 99_600_000n * E18]))
const d2 = c.decodeCurveTrade(mSell, 'Mercuri', mercuri.virtual)
ok(d2?.kind === 'sell' && near(d2.tokenAmount, 400_000) && Math.abs(d2.usdc - 2.7) < 1e-9 && Math.abs(d2.price - 6_997 / 967_066_666) < 1e-15, 'Mercuri Sell: tokens in, USDC received, price after it')
// SolonPad CurveBuy: 10 USDC in, 0.1 fee, 0.2 creator tax → 9.7 on the curve for 970,000 tokens.
const sBuy = log([c.SOLON_BUY, topic('0x' + '11'.repeat(20)), topic(ME)], encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'), [10n * E18, 970_000n * E18, E18 / 10n, E18 / 5n]))
const d3 = c.decodeCurveTrade(sBuy, 'SolonPad')
ok(d3?.kind === 'buy' && d3.trader === ME && near(d3.usdc, 10) && near(d3.tokenAmount, 970_000) && Math.abs(d3.price - 0.00001) < 1e-15, 'SolonPad CurveBuy: the recipient as trader, USDC paid, price on the curve (fee and tax aside)')
const sSell = log([c.SOLON_SELL, topic(ME), topic(ME)], encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'), [100_000n * E18, 97n * E18 / 100n, E18 / 100n, E18 / 50n]))
const d4 = c.decodeCurveTrade(sSell, 'SolonPad')
ok(d4?.kind === 'sell' && Math.abs(d4.usdc - 0.97) < 1e-9 && Math.abs(d4.price - 0.00001) < 1e-15, 'SolonPad CurveSell: USDC received, price on the curve (received + fee + tax per token)')
ok(c.decodeCurveTrade({ ...mBuy, topics: [c.SOLON_BUY, mBuy.topics[1]] }, 'Mercuri', mercuri.virtual) === null && c.decodeCurveTrade(mBuy, 'SolonPad') === null && c.decodeCurveTrade({ ...mBuy, data: '0x1234' }, 'Mercuri', mercuri.virtual) === null && c.decodeCurveTrade(mBuy, 'Mercuri') === null,
  'other events, the other launchpad\'s events, short data and a Mercuri curve without its reserves: ignored')

console.log('into the coin page\'s trades (api/poolSwaps.ts)')
const meta = curveMeta(mercuri)
ok(meta.pool === CURVE && meta.quote === '0x0000000000000000000000000000000000000000' && meta.quoteDecimals === 18 && meta.curve?.venue === 'Mercuri', 'the curve as the page\'s market, quoted in native USDC')
const sw = decodeSwap(mBuy, meta)
ok(sw?.kind === 'buy' && sw.maker === ME && sw.id === `${'0x' + 'ab'.repeat(32)}:3` && sw.block === 16 && sw.time === 0x66f5a000 * 1000 && Math.abs(sw.quoteAmount - 10.5) < 1e-9, 'a Buy becomes a swap with its maker, id, block and time')
ok(decodeSwap({ ...mBuy, address: '0x' + 'dd'.repeat(20) }, meta) === null, 'the same event from another contract (a copycat curve) is ignored')
const viaRouter = decodeSwap({ ...mBuy, topics: [c.MERCURI_BUY, topic(ROUTER)] }, meta)
ok(viaRouter?.kind === 'buy' && viaRouter.maker === null, 'a trade through the curve router names the router: no maker yet, so the page looks up the transaction\'s sender')

console.log('which curve router is in force (api/_curves.ts)')
const { CURVE_ROUTER, curveRouterFrom } = await import('../api/_curves')
const { getAddress } = await import('viem')
// As the owner copied it from /deploy/curve-router: its checksum catches a mistyped character.
ok(getAddress(CURVE_ROUTER) === '0xF8e8C8E2159e5Bb8af91fD342BfE5b9DB7a06441', 'the deployed router, 0xF8e8…6441 (checksum matches)')
ok(curveRouterFrom(undefined) === CURVE_ROUTER && curveRouterFrom('') === CURVE_ROUTER && curveRouterFrom('  ') === CURVE_ROUTER, 'unset or empty: the deployed router')
ok(curveRouterFrom(' 0x8A791620dd6260079BF849Dc5567aDC3F2FdC318 ') === ROUTER, 'an address overrides it (trimmed, lower-cased)')
ok(curveRouterFrom('off') === '' && curveRouterFrom(' OFF ') === '', '`off` turns routing off')
ok(curveRouterFrom('0x1234') === CURVE_ROUTER && curveRouterFrom('router') === CURVE_ROUTER, 'anything else keeps the deployed router')

console.log('ALL CURVE CHECKS PASSED')
