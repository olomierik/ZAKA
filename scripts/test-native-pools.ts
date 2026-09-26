// Offline test of trading native-USDC Uniswap v4 pools through Uniswap's
// Universal Router (src/arcdex/api/universalRouter.ts): the command and
// action encodings the Arc deployments expect, ARCDEX's fee and the
// referrer's share on buys and sells, and the route a native pool gets.
// Run: bun scripts/test-native-pools.ts

import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, toFunctionSelector, type Address, type Hex } from 'viem'

const { NATIVE, CMD, ACT, EXACT_IN_SINGLE, ACTIONS_ROUTER_INPUT, feeShares, encodeNativeBuy, encodeNativeSell, sequentialPortions, netAfterFees, isNativePool, UR_ABI, PERMIT2_ABI } = await import('../src/arcdex/api/universalRouter')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }

const TOKEN = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1' as Address
const WALLET = '0x274262a0321a0701b0a46a3576e07ae881c286bb' as Address
const REF = '0x7777777777777777777777777777777777777777' as Address
const ME = '0x9999999999999999999999999999999999999999' as Address
const key = { currency0: NATIVE, currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: '0xb6a65950534f061618b4ae102fbcbb8541a8e0cc' as Address }
const bytesOf = (h: Hex) => h.slice(2).match(/../g)!.map(b => parseInt(b, 16))

console.log('the contracts\' functions')
ok(toFunctionSelector(UR_ABI.find(f => f.name === 'execute')!) === '0x3593564c', 'Universal Router execute(bytes,bytes[],uint256) = 0x3593564c')
ok(toFunctionSelector(PERMIT2_ABI.find(f => f.name === 'approve')!) === '0x87517c45', 'Permit2 approve(address,address,uint160,uint48) = 0x87517c45')
ok(CMD.V4_SWAP === 0x10 && CMD.TRANSFER === 0x05 && CMD.PAY_PORTION_FULL_PRECISION === 0x07 && CMD.SWEEP === 0x04, 'router commands as in Commands.sol')
ok(ACT.SWAP_EXACT_IN_SINGLE === 0x06 && ACT.SETTLE_ALL === 0x0c && ACT.TAKE === 0x0e && ACT.TAKE_ALL === 0x0f, 'v4 actions as in Actions.sol')

console.log('which pools')
ok(isNativePool(key, TOKEN) && isNativePool(key, TOKEN.toUpperCase().replace('0X', '0x')), 'native USDC / token is a native pool (any address case)')
ok(!isNativePool({ ...key, currency0: '0x3600000000000000000000000000000000000000' }, TOKEN), 'an ERC-20 USDC pool is not (ArcDexSwapRouter takes those)')
ok(!isNativePool({ ...key, currency1: REF }, TOKEN), 'nor a native pool for another token')

console.log('fee shares (ArcDexSwapRouter v2: 2%, 15% of it to the referrer)')
const withRef = feeShares(200, 1500, WALLET, REF)
ok(withRef.length === 2 && withRef[0].to === REF && withRef[0].bps === 30 && withRef[1].to === WALLET && withRef[1].bps === 170, 'with a referrer: 0.30% to them, 1.70% to the fee wallet')
ok(JSON.stringify(feeShares(200, 1500, WALLET, null)) === JSON.stringify([{ to: WALLET, bps: 200 }]), 'no referrer: all 2% to the fee wallet')
ok(feeShares(200, 1500, WALLET, NATIVE).length === 1 && feeShares(100, 0, WALLET, REF).length === 1 && feeShares(0, 1500, WALLET, REF).length === 0, 'zero referrer, v1 (no share) and a zero fee')
const odd = feeShares(150, 1500, WALLET, REF)
ok(odd[0].bps + odd[1].bps === 150 && odd[0].bps === 22.5, 'a fee that doesn\'t split into whole basis points still adds up')

console.log('buy: native USDC in, fee first, then the swap, then any unswapped USDC back')
const value = 10n * 10n ** 18n // 10 USDC, 18 decimals
const buy = encodeNativeBuy(key, value, withRef, 123n, ME)
ok(buy.commands === '0x05051004', `commands: TRANSFER, TRANSFER, V4_SWAP, SWEEP (${buy.commands})`)
ok(buy.fees[0].amount === 3n * 10n ** 16n && buy.fees[1].amount === 17n * 10n ** 16n && buy.swapIn === value - 2n * 10n ** 17n, 'fees 0.03 + 0.17 USDC; 9.80 USDC swapped')
const [t0, t1] = buy.inputs.slice(0, 2).map(i => decodeAbiParameters(parseAbiParameters('address, address, uint256'), i))
ok(t0[0] === NATIVE && t0[1].toLowerCase() === REF && t0[2] === 3n * 10n ** 16n && t1[1].toLowerCase() === WALLET && t1[2] === 17n * 10n ** 16n, 'each TRANSFER: native USDC, recipient, exact amount')
const [acts, params] = decodeAbiParameters(ACTIONS_ROUTER_INPUT, buy.inputs[2])
ok(JSON.stringify(bytesOf(acts)) === JSON.stringify([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE_ALL]), 'V4_SWAP actions: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL')
const [sw] = decodeAbiParameters(EXACT_IN_SINGLE, params[0])
ok(sw.zeroForOne && sw.amountIn === buy.swapIn && sw.amountOutMinimum === 123n && sw.minHopPriceX36 === 0n && sw.hookData === '0x' && sw.poolKey.hooks.toLowerCase() === key.hooks && sw.poolKey.fee === 10_000 && sw.poolKey.tickSpacing === 200, 'the swap: native → token, the amount after fees, min out, the pool key')
// The same struct, written independently from IV4Router.sol's definition.
const independent = encodeAbiParameters(parseAbiParameters('((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)'), [[[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], true, buy.swapIn, 123n, 0n, '0x']])
ok(independent === params[0], 'matches ExactInputSingleParams{poolKey, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36, hookData} byte for byte')
const settle = decodeAbiParameters(parseAbiParameters('address, uint256'), params[1])
const take = decodeAbiParameters(parseAbiParameters('address, uint256'), params[2])
ok(settle[0] === NATIVE && settle[1] === buy.swapIn && take[0].toLowerCase() === TOKEN && take[1] === 123n, 'SETTLE_ALL native (at most the swap amount), TAKE_ALL the token (at least min out)')
ok(value - buy.fees.reduce((a, f) => a + f.amount, 0n) === buy.swapIn, 'every wei of msg.value is fee or swap input')
const refund = decodeAbiParameters(parseAbiParameters('address, address, uint256'), buy.inputs[3])
ok(buy.inputs.length === 4 && refund[0] === NATIVE && refund[1].toLowerCase() === ME && refund[2] === 0n, 'SWEEP native USDC to the trader, no minimum: a partial fill\'s unswapped USDC comes back, none is left in the router')
ok(encodeNativeBuy(key, value, [], 1n, ME).commands === '0x1004', 'no fee (router fee 0): V4_SWAP, SWEEP')
// Run the buy's commands the way the router does, against a pool that only
// fills part of the swap (it ran out of tokens): where does every wei go?
for (const fill of [buy.swapIn, buy.swapIn / 2n, 0n]) {
  let held = value
  const got = new Map<string, bigint>()
  const pay = (to: string, amt: bigint) => { got.set(to.toLowerCase(), (got.get(to.toLowerCase()) ?? 0n) + amt); held -= amt }
  bytesOf(buy.commands).forEach((c, i) => {
    if (c === CMD.TRANSFER) { const [, to, amt] = decodeAbiParameters(parseAbiParameters('address, address, uint256'), buy.inputs[i]); pay(to, amt) }
    else if (c === CMD.V4_SWAP) held -= fill // SETTLE_ALL pays the pool exactly what the swap used
    else if (c === CMD.SWEEP) { const [, to, min] = decodeAbiParameters(parseAbiParameters('address, address, uint256'), buy.inputs[i]); if (held < min) throw new Error('InsufficientETH'); pay(to, held) }
  })
  ok(held === 0n && got.get(REF) === 3n * 10n ** 16n && got.get(WALLET) === 17n * 10n ** 16n && (got.get(ME) ?? 0n) === buy.swapIn - fill, `pool takes ${Number(fill) / 1e18} of ${Number(buy.swapIn) / 1e18} USDC: ${Number(got.get(ME) ?? 0n) / 1e18} back to the trader, 0 left in the router`)
}

console.log('sell: token in through Permit2, fees out of the proceeds, the rest to the trader')
const sell = encodeNativeSell(key, 5n * 10n ** 24n, withRef, 777n, ME)
ok(sell.commands === '0x10070704', `commands: V4_SWAP, PAY_PORTION_FULL_PRECISION ×2, SWEEP (${sell.commands})`)
const [sActs, sParams] = decodeAbiParameters(ACTIONS_ROUTER_INPUT, sell.inputs[0])
ok(JSON.stringify(bytesOf(sActs)) === JSON.stringify([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE]), 'V4_SWAP actions: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE')
const [ss] = decodeAbiParameters(EXACT_IN_SINGLE, sParams[0])
ok(!ss.zeroForOne && ss.amountIn === 5n * 10n ** 24n, 'the swap: token → native, the whole amount')
const sSettle = decodeAbiParameters(parseAbiParameters('address, uint256'), sParams[1])
const sTake = decodeAbiParameters(parseAbiParameters('address, address, uint256'), sParams[2])
ok(sSettle[0].toLowerCase() === TOKEN && sSettle[1] === 5n * 10n ** 24n, 'SETTLE_ALL the token from the trader (through Permit2)')
ok(sTake[0] === NATIVE && sTake[1] === '0x0000000000000000000000000000000000000002' && sTake[2] === 0n, 'TAKE all the native USDC to the router itself (ADDRESS_THIS, OPEN_DELTA)')
const p1 = decodeAbiParameters(parseAbiParameters('address, address, uint256'), sell.inputs[1])
const p2 = decodeAbiParameters(parseAbiParameters('address, address, uint256'), sell.inputs[2])
const sw2 = decodeAbiParameters(parseAbiParameters('address, address, uint256'), sell.inputs[3])
ok(p1[1].toLowerCase() === REF && p2[1].toLowerCase() === WALLET && sw2[0] === NATIVE && sw2[1].toLowerCase() === ME && sw2[2] === 777n, 'portions to the referrer then the fee wallet; SWEEP the rest to the trader, at least min out')

// Run the router's own arithmetic: each portion is of what's left at that moment.
for (const gross of [10n ** 18n, 123_456_789_012_345_678_901n, 7n * 10n ** 15n + 3n]) {
  let held = gross
  const paid = [p1[2], p2[2]].map(p => { const a = (held * p) / 10n ** 18n; held -= a; return a })
  const wantRef = (gross * 30n) / 10_000n, wantWallet = (gross * 170n) / 10_000n
  const close = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= gross / 10n ** 15n + 2n
  ok(close(paid[0], wantRef) && close(paid[1], wantWallet) && held === netAfterFees(gross, withRef), `${Number(gross) / 1e18} USDC out: ${Number(paid[0]) / 1e18} to the referrer, ${Number(paid[1]) / 1e18} to ARCDEX, ${Number(held) / 1e18} to the trader`)
}
ok(sequentialPortions([200])[0] === 2n * 10n ** 16n, 'one share: 2% of the proceeds')
const one = encodeNativeSell(key, 10n ** 18n, feeShares(200, 1500, WALLET, null), 1n, ME)
ok(one.commands === '0x100704', 'no referrer: one PAY_PORTION to the fee wallet')

console.log('ALL NATIVE POOL CHECKS PASSED')
