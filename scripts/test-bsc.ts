// BNB Chain on ARCDEX, offline (2026-10-05): the market list's rows (four.meme's coins only, vouched for by
// four.meme's contract), curve progress, Relay's quotes checked (real ones recorded by scripts/capture-relay-bsc.ts
// pass, tampered ones are refused), four.meme's curve calls byte for byte, stages, safety ratings and routes.
// Run: bun scripts/test-bsc.ts   (live: bun scripts/sim-four.ts simulates four.meme's buy and sale on mainnet)

import relay from './fixtures/relay-bsc.json'
import swapsFx from './fixtures/bsc-swaps.json'
import { decodeFunctionData, parseAbi, toFunctionSelector, type Hex } from 'viem'

const core = await import('../api/_bscCore')
const { bscRows } = await import('../api/bscmarket')
const { checkRelayQuote, quoteBody, relayValueUsd, quoteVerdict, RELAY_ARC_DEPOSITORY, RELAY_BSC, EVM_NATIVE, BSC_ID } = await import('../src/arcdex/lib/relayQuote')
const { fourBuyCall, fourSellCall, fourMinOut } = await import('../src/arcdex/lib/fourMeme')
const { bscStage, bscStageInput } = await import('../src/arcdex/lib/coinStage')
const { bscSafety } = await import('../src/arcdex/lib/safety')
const { pathToPage, pageToPath } = await import('../src/arcdex/lib/router')
const { decodeBscSwap, bscPoolKind, filterOf, FOUR_PURCHASE, FOUR_SALE } = await import('../src/arcdex/api/bscSwaps')
const { FEE_WALLET } = await import('../src/arcdex/lib/platform')
import type { GtPools } from '../api/_rhCore'

const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const throws = (f: () => unknown, m: string, want?: RegExp) => {
  try { f() } catch (e) { if (want && !want.test((e as Error).message)) throw new Error(`FAIL: ${m} (threw "${(e as Error).message}")`); console.log('  ✓', m); return }
  throw new Error('FAIL: ' + m + ' (accepted)')
}
const H = 3_600_000
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

console.log('the market list')
const CURVE = '0xaaaa000000000000000000000000000000004444'
const GRAD = '0xbbbb000000000000000000000000000000004444'
const PLAIN = '0xcccc000000000000000000000000000000000001'
const pool = (dex: string, base: string, quote: string, extra: Record<string, unknown> = {}) => ({
  id: `bsc_${base.slice(0, 10)}${dex.length}`, type: 'pool',
  attributes: {
    address: `0x${dex.length.toString(16).padStart(2, '0')}${base.slice(4, 42)}`, name: 'MEME / WBNB', pool_created_at: new Date(Date.now() - 5 * H).toISOString(),
    base_token_price_usd: '0.0001', fdv_usd: '40000', market_cap_usd: null, reserve_in_usd: '12000',
    price_change_percentage: { m5: '1', h1: '2', h24: '30' }, transactions: { h24: { buys: 400, sells: 300, buyers: 120, sellers: 90 } }, volume_usd: { h24: '90000' }, ...extra,
  },
  relationships: { base_token: { data: { id: `bsc_${base}` } }, quote_token: { data: { id: `bsc_${quote}` } }, dex: { data: { id: dex } } },
})
const list: GtPools = {
  data: [pool('four-meme', CURVE, core.BNB_NATIVE), pool('pancakeswap_v2', GRAD, core.WBNB), pool('pancakeswap-v3-bsc', GRAD, core.BSC_USDT, { volume_usd: { h24: '10000' } }), pool('pancakeswap_v2', PLAIN, core.WBNB), pool('pancakeswap_v2', core.BSC_USDT, core.WBNB)] as never,
  included: [],
}
const parsed = core.parseBscPools(list)
ok(parsed.length === 4 && parsed.every(r => r.address !== core.BSC_USDT), 'a pool whose coin is a quote (USDT) is left out')
ok(parsed[0].launchpad === 'four.meme' && parsed[1].launchpad === 'four.meme' && parsed[3].launchpad === null, 'four.meme’s curve venue and a 4444 coin on PancakeSwap are four.meme’s; any other coin isn’t')
const merged = core.mergeBscCoins(parsed)
const grad = merged.find(r => r.address === GRAD)!
ok(merged.length === 3 && grad.volume24h === 100_000, 'one row per coin, volume summed over its pools')
ok(core.listedBsc(merged).map(r => r.address).sort().join() === [CURVE, GRAD].sort().join(), 'four.meme coins only: a coin with only plain-DEX pools isn’t listed')
ok(core.listedBsc(merged, a => (a === GRAD ? false : undefined)).map(r => r.address).join() === CURVE, 'a 4444 coin four.meme’s contract says it didn’t launch is dropped')
const paths = core.bscListPaths()
ok(paths.some(p => p.includes('/dexes/four-meme/pools')) && paths.some(p => p.includes('/dexes/pancakeswap_v2/pools')) && paths.some(p => p.includes('new_pools')), `a round reads four.meme, PancakeSwap and new pools (${paths.length} calls)`)
ok(core.isWashBsc({ ...grad, liquidity: 50, volume24h: 2_000_000 }) && !core.isWashBsc(grad), 'wash: millions through a pool with no liquidity')

console.log('four.meme’s curve')
const MAX = 800_000_000n * 10n ** 18n
ok(core.fourProgress(MAX, MAX) === 0 && core.fourProgress(0n, MAX) === 100 && core.fourProgress(MAX / 4n, MAX) === 75, 'progress is tokens sold of the 800M for sale: none 0%, all 100%, a quarter left 75%')
ok(core.fourProgress(MAX * 2n, MAX) === 0 && core.fourProgress(1n, 0n) === 0, 'nonsense from the contract reads as 0%, not a crash')
const snap = {
  updatedAt: Date.now(), cursor: 0, rounds: 1,
  pools: parsed.map(p => ({ ...p, seenAt: Date.now() })),
  four: { [CURVE]: { quote: core.BNB_NATIVE, graduated: false, progress: 82.5, at: Date.now() }, [GRAD]: { at: Date.now(), none: true as const } },
}
const rows = bscRows(snap)
ok(rows.length === 1 && rows[0].address === CURVE && rows[0].four?.progress === 82.5 && rows[0].graduated === false && rows[0].curveProgress === 82.5, 'the engine’s rows: four.meme’s word on each (82.5% along), and the coin it disowned left out')

console.log('stages and safety')
const row = (o: Partial<typeof grad>) => ({ ...grad, createdAt: Date.now() - 5 * H, ...o })
ok(bscStage(row({ four: { quote: core.BNB_NATIVE, graduated: false, progress: 82 } })) === 'near', 'on four.meme’s curve at 82%: Near bond')
ok(bscStage(row({ four: { quote: core.BNB_NATIVE, graduated: false, progress: 20 } })) === 'bonding', 'at 20%: Bonding')
ok(bscStage(row({ four: { quote: core.BNB_NATIVE, graduated: true, progress: 100 } })) === 'graduated', 'four.meme says graduated: off the curve')
ok(bscStageInput(row({ dex: 'four-meme', four: undefined })).onCurve && bscStageInput(row({ dex: 'four-meme', four: undefined })).progress === null, 'before four.meme answers, its venue means the curve, with no percentage')
ok(bscSafety(row({ liquidity: 50, volume24h: 2_000_000 })).level === 'danger', 'wash trading: Danger')
ok(bscSafety(row({ four: { quote: core.BNB_NATIVE, graduated: true, progress: 100 }, liquidity: 80_000, marketCap: 400_000, createdAt: Date.now() - 10 * 24 * H, traders24h: 400 })).level === 'safe', 'vouched for by four.meme, a deep pool, days old: Safe')

console.log('Relay: graduated coins')
const COIN = relay.coin
const base = { chain: 'bsc' as const, mint: COIN, evm: FEE_WALLET, sol: '', feeBps: 200 }
const reqs = {
  buy: { ...base, side: 'buy' as const, amount: 5_000_000n },
  sell: { ...base, side: 'sell' as const, amount: 1000n * 10n ** 18n },
  'swap-bnb': { ...base, side: 'swap' as const, inToken: EVM_NATIVE, outToken: COIN, amount: 10n ** 16n },
  'swap-usdt': { ...base, side: 'swap' as const, inToken: core.BSC_USDT, outToken: COIN, amount: 5n * 10n ** 18n },
  'swap-out': { ...base, side: 'swap' as const, inToken: COIN, outToken: EVM_NATIVE, amount: 1000n * 10n ** 18n },
  gas: { ...base, side: 'gas' as const, mint: '', amount: 500_000n, feeBps: 0 },
}
const body = quoteBody(reqs.buy)
ok(body.originChainId === 5042 && body.destinationChainId === BSC_ID && body.recipient === FEE_WALLET && body.user === FEE_WALLET && (body.appFees as { recipient: string }[])[0].recipient === FEE_WALLET, 'a buy: from Arc to BNB Chain, to the trader’s same address, ARCDEX’s fee to the fee wallet')
ok(quoteBody(reqs['swap-bnb']).originChainId === BSC_ID && quoteBody(reqs['swap-bnb']).destinationChainId === BSC_ID && quoteBody(reqs['swap-bnb']).originCurrency === EVM_NATIVE, 'a swap: BNB Chain to BNB Chain, native BNB in')
ok(quoteBody(reqs.gas).destinationCurrency === EVM_NATIVE && !('appFees' in quoteBody(reqs.gas)), 'the BNB top-up: native BNB, no fee')
for (const [name, req] of Object.entries(reqs)) {
  const q = checkRelayQuote(req, (relay as Record<string, unknown>)[name] as never)
  ok(q.evmTx && !q.solTx, `a real ${name} quote passes`)
}
const qb = checkRelayQuote(reqs.buy, relay.buy as never)
ok(qb.evmTx!.call.to === RELAY_ARC_DEPOSITORY && qb.evmTx!.approve?.amount === 5_000_000n && qb.signChain === 5042, 'the buy: exactly 5 USDC approved to Relay’s depository on Arc, then the deposit')
const qn = checkRelayQuote(reqs['swap-bnb'], relay['swap-bnb'] as never)
ok(qn.evmTx!.call.to === RELAY_BSC.router && qn.evmTx!.call.value === 10n ** 16n && !qn.evmTx!.approve && qn.signChain === BSC_ID, 'BNB in: straight to Relay’s router with exactly the BNB, no approval')
const qs = checkRelayQuote(reqs.sell, relay.sell as never)
ok(qs.evmTx!.call.to === RELAY_BSC.approvalProxy && qs.evmTx!.approve?.spender === RELAY_BSC.approvalProxy && qs.evmTx!.approve.amount === reqs.sell.amount, 'a sale: exactly the coins approved to Relay’s approval proxy, which takes them')

const step = (j: any, id: string) => j.steps.find((s: any) => s.id === id).items[0].data
const tampers: [keyof typeof reqs, string, (j: any) => void, RegExp][] = [
  ['buy', 'delivered to another address', j => { j.details.recipient = '0x1111111111111111111111111111111111111111' }, /another address|pays another/],
  ['buy', 'another coin', j => { j.details.currencyOut.currency.address = '0x2222222222222222222222222222222222224444' }, /delivers another token/],
  ['buy', 'an unlimited approval', j => { const d = step(j, 'approve'); d.data = d.data.slice(0, 74) + 'f'.repeat(64) }, /exactly the amount/],
  ['buy', 'a deposit to another contract', j => { step(j, 'deposit').to = '0x1111111111111111111111111111111111111111' }, /doesn’t know/],
  ['buy', 'a fee that isn’t 2%', j => { j.fees.app.amount = '500000' }, /fee isn’t ARCDEX’s/],
  ['sell', 'paid to another Arc address', j => { j.details.recipient = '0x1111111111111111111111111111111111111111' }, /another address|pays another/],
  ['sell', 'approved to another spender', j => { const d = step(j, 'approve'); d.data = d.data.replace(RELAY_BSC.approvalProxy.slice(2), '1111111111111111111111111111111111111111') }, /doesn’t know/],
  ['sell', 'more coins approved than sold', j => { const d = step(j, 'approve'); d.data = d.data.slice(0, 74) + (2000n * 10n ** 18n).toString(16).padStart(64, '0') }, /exactly the amount/],
  ['sell', 'the trade sent to another contract', j => { step(j, 'deposit').to = '0x1111111111111111111111111111111111111111' }, /doesn’t know/],
  ['sell', 'instructions that don’t name the trader', j => { const d = step(j, 'deposit'); d.data = d.data.split(FEE_WALLET.slice(2).toLowerCase()).join('1'.repeat(40)) }, /don’t name you/],
  ['sell', 'native funds sent', j => { step(j, 'deposit').value = '1' }, /native funds/],
  ['sell', 'no fee', j => { j.fees.app.amount = '0' }, /fee isn’t ARCDEX’s/],
  ['swap-bnb', 'more BNB than asked', j => { step(j, 'swap').value = (2n * 10n ** 16n).toString() }, /another amount of BNB/],
  ['swap-bnb', 'BNB to another contract', j => { step(j, 'swap').to = '0x1111111111111111111111111111111111111111' }, /doesn’t know/],
  ['swap-bnb', 'an approval for BNB', j => { j.steps.unshift({ id: 'approve', kind: 'transaction', items: [{ data: { ...step(j, 'swap') } }] }) }, /native coin/],
  ['swap-bnb', 'another chain', j => { step(j, 'swap').chainId = 1 }, /another chain/],
  ['swap-usdt', 'USDT approved to another spender', j => { const d = step(j, 'approve'); d.data = d.data.replace(RELAY_BSC.approvalProxy.slice(2), '1111111111111111111111111111111111111111') }, /doesn’t know/],
  ['swap-usdt', 'another token approved', j => { step(j, 'approve').to = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' }, /another token/],
  ['swap-out', 'paid in something other than BNB', j => { j.details.currencyOut.currency.address = core.BSC_USDT }, /delivers another token/],
  ['swap-out', 'an extra step', j => { j.steps.push({ id: 'claim', kind: 'transaction', items: [{ data: {} }] }) }, /unexpected step/],
  ['gas', 'a fee on the top-up', j => { j.fees.app = { ...j.fees.app, amount: '10000' } }, /fee on gas/],
]
for (const [name, what, f, want] of tampers) {
  const j = clone((relay as Record<string, unknown>)[name]) as any
  f(j)
  throws(() => checkRelayQuote(reqs[name], j), `refused (${name}): ${what}`, want)
}
const fair = relayValueUsd({ appFeeUsd: 0.16, relayFeeUsd: 0.02 }, 8, 7.7)
ok(fair && quoteVerdict(fair) === 'ok', `a BNB buy priced in dollars: impact ${(fair!.impact * 100).toFixed(1)}%, ok`)
ok(quoteVerdict(relayValueUsd({ appFeeUsd: 0.16, relayFeeUsd: 0.02 }, 8, 40)) === 'off-market', 'a quote paying 5× the market: refused (off-market)')

console.log('four.meme’s curve calls')
const MANAGER = parseAbi(['function buyTokenAMAP(address token, uint256 funds, uint256 minAmount) payable', 'function sellToken(address token, uint256 amount, uint256 minFunds)'])
const bq = { side: 'buy' as const, token: CURVE, quote: core.BNB_NATIVE, funds: 10n ** 16n, tokens: 1_000_000n * 10n ** 18n, fee: 10n ** 14n, value: 10n ** 16n, approval: 0n }
const minTokens = fourMinOut(bq, 500)
ok(minTokens === 950_000n * 10n ** 18n, 'the minimum is the quote less the slippage (5%)')
const buy = fourBuyCall(bq, minTokens)
const db = decodeFunctionData({ abi: MANAGER, data: buy.data as Hex })
ok(buy.to === core.FOUR.manager && buy.data.startsWith(toFunctionSelector('buyTokenAMAP(address,uint256,uint256)')) && buy.value === bq.value
  && db.functionName === 'buyTokenAMAP' && (db.args[0] as string).toLowerCase() === CURVE && db.args[1] === bq.funds && db.args[2] === minTokens,
  'a buy: TokenManager2’s buyTokenAMAP(coin, funds, minimum), the BNB sent as value')
const sq = { side: 'sell' as const, token: CURVE, quote: core.BNB_NATIVE, amount: 500_000n * 10n ** 18n, funds: 4n * 10n ** 15n, fee: 4n * 10n ** 13n }
const sell = fourSellCall(sq, fourMinOut(sq, 500))
const ds = decodeFunctionData({ abi: MANAGER, data: sell.data as Hex })
ok(sell.to === core.FOUR.manager && sell.value === 0n && ds.functionName === 'sellToken' && ds.args[1] === sq.amount && ds.args[2] === (sq.funds * 95n) / 100n,
  'a sale: sellToken(coin, amount, minimum), no value sent')

console.log('live trades from the chain (real logs, scripts/fixtures/bsc-swaps.json)')
ok(bscPoolKind('four-meme') === 'four' && bscPoolKind('pancakeswap_v2') === 'v2' && bscPoolKind('pancakeswap-v3-bsc') === 'v3' && bscPoolKind('pancakeswap-infinity-clmm') === null, 'four.meme’s curve, PancakeSwap v2 and v3 are read on the chain; other venues stay on GeckoTerminal')
const fourCoin = swapsFx.four.coin!
const fourMeta = { pool: core.FOUR.manager, kind: 'four' as const, coin: fourCoin, quote: core.BNB_NATIVE, coinDecimals: 18, quoteDecimals: 18 }
const fl = filterOf(fourMeta)
ok(fl.address === core.FOUR.manager && JSON.stringify(fl.topics) === JSON.stringify([[FOUR_PURCHASE, FOUR_SALE]]), 'a curve coin: four.meme’s manager, its purchase and sale events')
const fourSwaps = swapsFx.four.logs.map(l => decodeBscSwap(l as never, fourMeta)).filter(Boolean)
const others = swapsFx.four.logs.filter(l => `0x${l.data.slice(26, 66)}` !== fourCoin)
ok(fourSwaps.length > 0 && fourSwaps.length === swapsFx.four.logs.length - others.length, `the coin’s own trades only (${fourSwaps.length} of ${swapsFx.four.logs.length} four.meme trades)`)
const f0 = fourSwaps[0]!
ok(/^0x[0-9a-f]{40}$/.test(f0.maker ?? '') && f0.tokenAmount > 0 && f0.quoteAmount > 0 && Math.abs(f0.price - f0.quoteAmount / f0.tokenAmount) < 1e-18 && f0.time > Date.parse('2026-10-01'), 'each names its trader, amounts, price and the block’s time')
ok(fourSwaps.every(s => s!.kind === 'buy' || s!.kind === 'sell'), 'buys and sells by their event')
ok(decodeBscSwap({ ...swapsFx.four.logs[0], address: '0x1111111111111111111111111111111111111111' } as never, fourMeta) === null, 'the same event from another contract: ignored')
const v2Meta = { pool: swapsFx.v2.pair, kind: 'v2' as const, coin: swapsFx.v2.coin, quote: swapsFx.v2.quote, coinDecimals: 18, quoteDecimals: 18 }
const v2Swaps = swapsFx.v2.logs.map(l => decodeBscSwap(l as never, v2Meta)).filter((x): x is NonNullable<typeof x> => !!x)
const prices = v2Swaps.map(s => s.price).sort((a, b) => a - b)
const median = prices[Math.floor(prices.length / 2)]
ok(v2Swaps.length === swapsFx.v2.logs.length && prices.every(p => p > median * 0.8 && p < median * 1.25), `a PancakeSwap v2 pair: every swap decoded, prices together (${v2Swaps.length}, median ${median.toExponential(3)} BNB)`)
ok(v2Swaps.some(s => s.kind === 'buy') && v2Swaps.every(s => !s.maker), 'buys and sells; the maker is looked up (the pair names the router)')
ok(decodeBscSwap({ ...swapsFx.v2.logs[0], address: '0x1111111111111111111111111111111111111111' } as never, v2Meta) === null, 'another pair’s swap: ignored')

console.log('routes')
const p = pathToPage(`/bnb/token/${COIN.toUpperCase().replace('0X', '0x')}`, '?pool=0xABCDEF0000000000000000000000000000000001')
ok(p?.name === 'bsc-token' && p.address === COIN && p.pool === '0xabcdef0000000000000000000000000000000001', 'a coin’s link: address and pool lowercased')
ok(pageToPath(p!) === `/bnb/token/${COIN}?pool=0xabcdef0000000000000000000000000000000001` && pathToPage('/bsc', '')?.name === 'bsc' && pathToPage('/bnb', '')?.name === 'bsc', 'and back; /bnb and /bsc are the markets')
ok(pathToPage('/bnb/token/notanaddress', '')?.name === 'bsc', 'a malformed address opens the markets')

console.log('\nall BNB Chain checks passed')
