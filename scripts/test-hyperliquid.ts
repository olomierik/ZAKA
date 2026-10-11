// Hyperliquid: signing, order wires and rounding, checked offline. The signing vectors are the official Python SDK's
// own (hyperliquid-python-sdk tests/signing_test.py): if these pass, the venue recovers the signer we meant.
//   bun scripts/test-hyperliquid.ts

import { privateKeyToAccount } from 'viem/accounts'
import { actionHash, floatToInt, floatToWire, signL1, signUserAction, type TypedDataSigner } from '../src/arcdex/hl/signing'
import { msgpack } from '../src/arcdex/hl/msgpack'
import { ASSET, marketPrice, onGrid, orderAction, orderWire, outcomeCoin, roundPrice, roundSize, type OrderRequest } from '../src/arcdex/hl/wire'
import { readFileSync } from 'fs'
import { checkDeposit, checkWithdraw, FundingError } from '../src/arcdex/hl/fundingQuote'
import { groupOutcomes } from '../src/arcdex/hl/markets'
import { buildOutcomeOrder, buildPerpOrders, estLiquidation, outcomeBuilder, perpBuilder } from '../src/arcdex/hl/exec'

let failed = 0
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? '✓' : '✗'} ${what}`); if (!cond) failed++ }
const big = (h: string) => BigInt(h)

const account = privateKeyToAccount('0x0123456789012345678901234567890123456789012345678901234567890123')
const signer: TypedDataSigner = { address: account.address, signTypedData: td => account.signTypedData(td as Parameters<typeof account.signTypedData>[0]) }
const same = (sig: { r: string; s: string; v: number }, r: string, s: string, v: number) => big(sig.r) === big(r) && big(sig.s) === big(s) && sig.v === v

console.log('msgpack')
ok([...msgpack({ a: 1, b: 'x' })].join() === [0x82, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0xa1, 0x78].join(), 'a map keeps key order, small ints and short strings')
ok([...msgpack(100000000000)].slice(0, 1)[0] === 0xcf, 'an integer past 32 bits is uint64, as Python packs it')
ok([...msgpack(200)].join() === '204,200' && [...msgpack(-5)].join() === '251', 'uint8 and negative fixint')
ok([...msgpack('x'.repeat(40))].slice(0, 2).join() === '217,40', 'a 40-byte string is str8')

console.log('L1 signing (the SDK vectors)')
const order = (sz: number, px: number, type: Parameters<typeof orderWire>[0]['type'], cloid?: string) =>
  orderAction([orderWire({ asset: 1, isBuy: true, px, sz, reduceOnly: false, type, cloid })])
{
  const a = orderAction([orderWire({ asset: 4, isBuy: true, px: 1670.1, sz: 0.0147, reduceOnly: false, type: { limit: { tif: 'Ioc' } } })])
  ok(actionHash(a, null, 1677777606040) === '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908', 'the phantom agent of a production order')
}
{
  const dummy = { type: 'dummy', num: floatToInt(1000, 8) }
  ok(same(await signL1(signer, dummy, 0, true), '0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298', '0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8', 27), 'a plain action, mainnet')
  ok(same(await signL1(signer, dummy, 0, false), '0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510', '0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613', 28), '… testnet')
  const vault = '0x1719884eb866cb12b2287399b15f7db5e7d775ea'
  ok(same(await signL1(signer, dummy, 0, true, vault), '0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239', '0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c', 28), 'with a vault address')
}
{
  const gtc = order(100, 100, { limit: { tif: 'Gtc' } })
  ok(same(await signL1(signer, gtc, 0, true), '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e', '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e', 28), 'a limit order, mainnet')
  ok(same(await signL1(signer, gtc, 0, false), '0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54', '0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5', 27), '… testnet')
  const withCloid = order(100, 100, { limit: { tif: 'Gtc' } }, '0x00000000000000000000000000000001')
  ok(same(await signL1(signer, withCloid, 0, true), '0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3', '0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da', 27), 'with a client order id')
  const sl = order(100, 100, { trigger: { triggerPx: 103, isMarket: true, tpsl: 'sl' } })
  ok(same(await signL1(signer, sl, 0, true), '0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9', '0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405', 27), 'a stop-loss trigger order')
}

console.log('user-signed actions (the SDK vectors)')
{
  const msg = { destination: '0x5e9ee1089755c3435139848e47e6635505d5a13a', amount: '1', time: 1687816341423, signatureChainId: '0x66eee', hyperliquidChain: 'Testnet' }
  ok(same(await signUserAction(signer, 'HyperliquidTransaction:UsdSend', msg), '0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073', '0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7', 27), 'a USDC send')
  ok(same(await signUserAction(signer, 'HyperliquidTransaction:Withdraw', msg), '0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9', '0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881', 28), 'a withdrawal')
}

console.log('wire numbers')
ok(floatToWire(100) === '100' && floatToWire(1670.1) === '1670.1' && floatToWire(0.0147) === '0.0147' && floatToWire(-0) === '0', 'no trailing zeros, no -0')
ok(floatToInt(1000, 8) === 100000000000n && floatToInt(0.00001231, 8) === 1231n, 'the SDK float_to_int cases')
let threw = false
try { floatToWire(0.123456789) } catch { threw = true }
ok(threw, 'a number that would round is refused')

console.log('rounding to the venue grid')
ok(roundPrice(83046.55, 5, true) === 83047, 'BTC (szDecimals 5): 5 significant figures, 1 decimal allowed, so a whole dollar here')
ok(roundPrice(1670.123, 4, true) === 1670.1, 'ETH-like: 5 significant figures')
ok(roundPrice(0.000123456, 0, true) === 0.000123, 'a tiny price: at most 6 decimals for a perp with szDecimals 0')
ok(roundPrice(0.991574, 0, false) === 0.99157, 'an outcome price: 5 significant figures, 8 decimals')
ok(marketPrice(100, true, 0.05, 2, true) === 105 && marketPrice(100, false, 0.05, 2, true) === 95, 'a market order: mid ± slippage')
ok(marketPrice(1.23456, true, 0.01, 1, true) === 1.247 && marketPrice(1.23456, false, 0.01, 1, true) === 1.2222, 'buys round up, sells down')
ok(roundSize(0.123456789, 5) === 0.12345 && roundSize(12.99, 0) === 12, 'sizes round down to the lot')
ok(onGrid(1670.1, 4, true) && !onGrid(1670.12, 4, true) && onGrid(83000, 5, true) && !onGrid(0.1234567, 0, true), 'checking a limit price')

console.log('asset ids (Hyperliquid\'s asset-ids page)')
ok(ASSET.hip3(1, 0) === 110000 && ASSET.hip3(10, 3) === 200003, 'a builder-deployed perp: 100000 + dex × 10000 + index')
ok(ASSET.outcome(1, 0) === 100000010 && outcomeCoin(1, 0) === '#10' && ASSET.outcome(11153, 0) === 100111530, 'an outcome side: 100000000 + 10 × outcome + side')
ok(ASSET.isPerp(0) && ASSET.isPerp(110000) && !ASSET.isPerp(10_005) && !ASSET.isPerp(100000010), 'perps vs spot and outcomes')
ok(JSON.stringify(orderAction([orderWire({ asset: 0, isBuy: true, px: 1, sz: 1, reduceOnly: false, type: { limit: { tif: 'Ioc' } } })], { b: '0xABCDEF0000000000000000000000000000000001', f: 50 }).builder) === '{"b":"0xabcdef0000000000000000000000000000000001","f":50}', 'the builder address is lower-cased')

console.log('funding through Relay (real quotes, recorded by hand on 2026-10-11)')
{
  const fx = JSON.parse(readFileSync('scripts/fixtures/hl-relay.json', 'utf8'))
  const user = fx.user as string
  const dep = checkDeposit(user, 25_000_000n, fx.deposit)
  ok(dep.direction === 'in' && dep.inUsd === 25 && dep.outUsd > 24.9 && dep.id.startsWith('0x'), `a $25 deposit passes: $${dep.outUsd} arrives`)
  const wd = checkWithdraw(user, 2_500_000_000n, fx.withdraw)
  ok(wd.direction === 'out' && wd.inUsd === 25 && wd.outUsd > 24.9, `a $25 withdrawal passes: $${wd.outUsd} arrives`)
  const refused = (f: () => unknown) => { try { f(); return false } catch (e) { return e instanceof FundingError } }
  const clone = (x: unknown) => JSON.parse(JSON.stringify(x))
  const tamper = (base: unknown, edit: (j: any) => void) => { const j = clone(base); edit(j); return j }
  ok(refused(() => checkDeposit(user, 26_000_000n, fx.deposit)), 'a deposit of another amount')
  ok(refused(() => checkDeposit('0x2222222222222222222222222222222222222222', 25_000_000n, fx.deposit)), 'a deposit for another account')
  ok(refused(() => checkDeposit(user, 25_000_000n, tamper(fx.deposit, j => { j.details.recipient = '0x3333333333333333333333333333333333333333' }))), 'a deposit paid to someone else')
  ok(refused(() => checkDeposit(user, 25_000_000n, tamper(fx.deposit, j => { const a = j.steps.find((s: any) => s.id === 'approve'); if (a) a.items[0].data.data = a.items[0].data.data.slice(0, 74) + 'f'.repeat(64) }))), 'an unlimited approval')
  ok(refused(() => checkDeposit(user, 25_000_000n, tamper(fx.deposit, j => { const d = j.steps.find((s: any) => s.id === 'deposit'); d.items[0].data.to = '0x4444444444444444444444444444444444444444' }))), 'a deposit to another contract')
  ok(refused(() => checkDeposit(user, 25_000_000n, tamper(fx.deposit, j => { const d = j.steps.find((s: any) => s.id === 'deposit'); d.items[0].data.value = '1000' }))), 'native value on a deposit')
  ok(refused(() => checkDeposit(user, 25_000_000n, tamper(fx.deposit, j => { j.details.currencyOut.amount = '2000000000' }))), 'a deposit eaten by fees')
  ok(refused(() => checkDeposit(user, 25_000_000n, tamper(fx.deposit, j => { j.steps.push({ id: 'extra', kind: 'transaction', items: [{ data: { to: '0x1', data: '0x', value: '0' } }] }) }))), 'an extra step')
  ok(refused(() => checkWithdraw(user, 2_500_000_000n, tamper(fx.withdraw, j => { j.steps[1].items[0].data.action.parameters.destination = '0x5555555555555555555555555555555555555555' }))), 'a withdrawal sent to someone else on Hyperliquid')
  ok(refused(() => checkWithdraw(user, 2_500_000_000n, tamper(fx.withdraw, j => { j.steps[1].items[0].data.action.parameters.amount = '250.000000' }))), 'a withdrawal of more than asked')
  ok(refused(() => checkWithdraw(user, 2_500_000_000n, tamper(fx.withdraw, j => { j.details.recipient = '0x6666666666666666666666666666666666666666' }))), 'a withdrawal paid to someone else on Arc')
  ok(refused(() => checkWithdraw(user, 2_500_000_000n, tamper(fx.withdraw, j => { j.steps[0].items[0].data.sign.value.depositor = '0x7777777777777777777777777777777777777777' }))), 'an authorization naming another depositor')
  ok(refused(() => checkWithdraw(user, 2_500_000_000n, tamper(fx.withdraw, j => { j.steps[1].items[0].data.action.parameters.sourceDex = 'xyz' }))), 'a withdrawal from another balance')
  ok(refused(() => checkWithdraw(user, 2_500_000_000n, tamper(fx.withdraw, j => { j.steps[1].items[0].data.action.parameters.nonce = 1 }))), 'mismatched nonces')
  const other = '0x8888888888888888888888888888888888888888'
  ok(refused(() => checkDeposit(user, 25_000_000n, tamper(fx.deposit, j => { j.protocol.v2.orderData.output.payments[0].recipient = other }))), 'an order that pays someone else')
  ok(refused(() => checkDeposit(user, 25_000_000n, tamper(fx.deposit, j => { j.protocol.v2.orderData.output.calls = [{ to: other, data: '0x' }] }))), 'an order that makes calls')
  ok(refused(() => checkDeposit(user, 25_000_000n, tamper(fx.deposit, j => { j.protocol.v2.orderData.inputs[0].refunds[0].recipient = other }))), 'an order that refunds someone else')
  ok(refused(() => checkDeposit(user, 25_000_000n, tamper(fx.deposit, j => { j.protocol.v2.orderId = '0x' + '9'.repeat(64) }))), 'a deposit that funds another order')
  ok(refused(() => checkWithdraw(user, 2_500_000_000n, tamper(fx.withdraw, j => { j.protocol.v2.paymentDetails.amount = '1' }))), 'an order paid with another amount')
  ok(refused(() => checkWithdraw(user, 2_500_000_000n, tamper(fx.withdraw, j => { j.protocol.v2.orderData.output.payments[0].currency = '0x' + '1'.repeat(40) }))), 'an order paying another token')
  ok(refused(() => checkWithdraw(user, 2_500_000_000n, tamper(fx.withdraw, j => { j.steps[0].items[0].data.sign.value.id = '0x' + '9'.repeat(64) }))), 'an authorization for another order')
}

console.log('outcome markets (a live snapshot, recorded on 2026-10-11)')
{
  const raw = JSON.parse(readFileSync('scripts/fixtures/hl-outcomes.json', 'utf8'))
  const groups = groupOutcomes(raw.outcomes, raw.questions)
  const titles = groups.map(g => g.title)
  ok(groups.length > 100 && titles.every(t => t && !t.includes('template') && !t.includes('|')), `${groups.length} markets, every title readable`)
  ok(titles.some(t => /^Silver above \$60\.7 at Oct 12, 13:35 UTC\?$/.test(t)), 'a price market on an xyz commodity: "Silver above $60.7 at Oct 12, 13:35 UTC?"')
  ok(titles.some(t => /^HYPE touches \$75 by Nov 1\?$/.test(t)), 'a touch market: "HYPE touches $75 by Nov 1?"')
  ok(titles.includes('Anthropic first-day market cap above $1.5T?'), 'an IPO market cap market in trillions')
  const match = groups.find(g => g.title === 'RB Leipzig vs PSV Eindhoven')
  ok(!!match && match.multi && match.members.map(m => m.label).join() === 'RB Leipzig,Draw,PSV Eindhoven,Other' && match.category === 'sports', 'a match: its three results and the fallback, grouped')
  const bucket = groups.find(g => g.title.startsWith('BTC price at'))
  ok(!!bucket && bucket.members[0].label === 'Under $81,334' && bucket.members[1].label === '$81,334 – $84,653' && bucket.members[2].label === '$84,653 or more', 'price buckets read as ranges')
  const nfl = groups.find(g => g.members[0].template === 'sportsContestWinner')
  ok(!!nfl && nfl.members[0].sides[0].name === 'TEN' && nfl.members[0].sides[1].name === 'HOU', 'a two-sided match names its sides by team')
  ok(groups.every(g => g.members.every(m => m.sides[0].asset === 100_000_000 + 10 * m.outcome && m.sides[1].coin === `#${10 * m.outcome + 1}`)), 'every side trades as its own asset and coin')
  const cats = new Set(groups.map(g => g.category))
  ok(['crypto', 'stocks', 'indices', 'commodities', 'sports', 'economics', 'companies'].every(c => cats.has(c as never)), 'every category Liquid shows is filled')
}

console.log('building orders')
{
  const tif = (o: OrderRequest) => ('limit' in o.type ? o.type.limit.tif : null)
  const btc = { coin: 'BTC', dex: '', symbol: 'BTC', name: 'Bitcoin', asset: 0, szDecimals: 5, maxLeverage: 40, onlyIsolated: false, category: 'crypto' as const, markPx: 83000, midPx: 83000, oraclePx: 83000, prevDayPx: 82000, change24h: 1.2, volume24h: 1e9, openInterestUsd: 3e9, funding: 0.00001 }
  const long = buildPerpOrders({ market: btc, isBuy: true, usd: 100, kind: 'market', mid: 83000, tp: 90000, sl: 80000 })
  ok(long.orders.length === 3 && long.grouping === 'normalTpsl', 'a market long with a take-profit and a stop-loss: three orders, grouped')
  ok(tif(long.orders[0]) === 'Ioc' && long.px === 85490 && long.sz === 0.0012, 'the entry: IOC, the price capped at mid + 3%, the size on the lot')
  const [, tp, sl] = long.orders
  ok(!tp.isBuy && tp.reduceOnly && 'trigger' in tp.type && tp.type.trigger.tpsl === 'tp' && tp.type.trigger.triggerPx === 90000, 'the take-profit: a reduce-only sell triggered at 90,000')
  ok(!sl.isBuy && sl.reduceOnly && 'trigger' in sl.type && sl.type.trigger.tpsl === 'sl' && sl.type.trigger.isMarket, 'the stop-loss: a market sell once 80,000 trades')
  const limit = buildPerpOrders({ market: btc, isBuy: false, usd: 50, kind: 'limit', limitPx: 85123.4, postOnly: true, mid: 83000 })
  ok(tif(limit.orders[0]) === 'Alo' && limit.px === 85123, 'a post-only limit, its price on the grid')
  const liq = estLiquidation(83000, true, 10, 40)!
  ok(liq > 74000 && liq < 76000, `a 10× long's liquidation, estimated: ${liq.toFixed(0)}`)
  const yes = buildOutcomeOrder({ outcome: 10464, side: 0, isBuy: true, usd: 20, px: 0.5, kind: 'market' })
  ok(yes.asset === 100104640 && yes.sz === 40 && yes.px === 0.52 && tif(yes) === 'Ioc', '$20 of Yes at 0.50: 40 contracts, IOC at 0.52')
  ok(perpBuilder({ builderReady: false, approvedF: 100 }) === null && perpBuilder({ builderReady: true, approvedF: 100 })?.f === 50, 'no builder fee until the builder can receive it')
  ok(outcomeBuilder({ builderReady: true, approvedF: 100 }, true) === null && outcomeBuilder({ builderReady: true, approvedF: 100 }, false)?.f === 100, 'outcome markets: the builder fee on sells only')
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall Hyperliquid checks passed')
