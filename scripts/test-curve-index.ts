// Offline test of the Mercuri and SolonPad coin index behind the Terminal's
// rows for both launchpads (api/_curveIndex.ts, served by
// /api/launchpad?of=curves through api/_curvesRoute.ts) and its browser side
// (src/arcdex/api/curveMarket.ts): launches from the factories' events,
// 24h stats from the curves' trade events, each curve's state from its
// view functions, graduated coins' pools from GeckoTerminal, which coins are
// listed — and one whole build against an in-memory chain.
// Run: bun scripts/test-curve-index.ts

import { encodeAbiParameters, encodeFunctionResult, parseAbi, toFunctionSelector, type Hex } from 'viem'
import type { RawLog } from '../api/_arcLogs'

const ix = await import('../api/_curveIndex')
const cv = await import('../api/_curves')
const { curveRowToArcToken, getCurveMarket } = await import('../src/arcdex/api/curveMarket')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const near = (a: number | null | undefined, b: number, tol = 1e-9) => a != null && Math.abs(a - b) <= Math.abs(b) * tol + 1e-12

const E18 = 10n ** 18n
const a = (b: string) => '0x' + b.repeat(20)
const topic = (x: string) => '0x' + x.slice(2).padStart(64, '0')
const hex = (n: number) => '0x' + n.toString(16)
// Today (the route below runs on the real clock).
const NOW = Math.floor(Date.now() / 1000)
const NATIVE = '0x0000000000000000000000000000000000000000'
const USDC20 = '0x3600000000000000000000000000000000000000'
const HEAD = 23_000_000
const u = (...v: bigint[]) => encodeAbiParameters(v.map(() => ({ type: 'uint256' })), v)
let n = 0
const log = (address: string, topics: string[], data: string, ts = NOW, block = HEAD - 100): RawLog => ({
  address, topics, data, blockNumber: hex(block), blockTimestamp: hex(ts), transactionHash: '0x' + (++n).toString(16).padStart(64, '0'), logIndex: '0x0',
})

// Mercuri's LaunchConfig: $6,000 virtual USDC on 1,066,666,666 virtual tokens, 800M on the curve + 200M for the pool.
const CONFIG = [6_000n * E18, 1_066_666_666n * E18, 800_000_000n * E18, 200_000_000n * E18, E18, 50_000_000n * E18, 100, 5_000, 2_000, 9_900, 120] as const
const LAUNCH_CONFIG = { type: 'tuple', components: [
  { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
  { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint32' }] } as const
const M_TOKEN = a('b1'), M_CURVE = a('c1'), CREATOR = a('d1'), TRADER = a('e1')
const S_TOKEN = a('b2'), S_CURVE = a('c2')
const G_TOKEN = a('b3'), G_CURVE = a('c3') // a Mercuri coin that has graduated
const tokenCreated = (token = M_TOKEN, curve = M_CURVE, ts = NOW - 3_600, name = 'Mercury Frog', symbol = 'MFROG', uri = 'ipfs://bafyfrog/meta.json', factory = cv.MERCURI_FACTORY) =>
  log(factory, [cv.MERCURI_TOKEN_CREATED, topic(token), topic(curve), topic(CREATOR)],
    encodeAbiParameters([{ type: 'address' }, { type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'bytes32' }, LAUNCH_CONFIG],
      [a('99') as Hex, name, symbol, uri, ('0x' + 'ab'.repeat(32)) as Hex, CONFIG]), ts, HEAD - 5_000)
const tokenLaunched = (pair = NATIVE, token = S_TOKEN, curve = S_CURVE, ts = NOW - 7_200) =>
  log(cv.SOLONPAD_FACTORY, [cv.SOLON_TOKEN_LAUNCHED, topic(token), topic(curve), topic(CREATOR)], u(BigInt(pair), 1n, 10_000n * E18), ts, HEAD - 4_000)
// Mercuri Buy: 9.9 net in, 1.3M tokens, 0.1 fee, 0.5 tax; after it 1,000 real USDC, 100M sold. Sell: 400k tokens for 2.7 net.
const mBuy = (ts: number, curve = M_CURVE) => log(curve, [cv.MERCURI_BUY, topic(TRADER)], u(99n * E18 / 10n, 1_300_000n * E18, E18 / 10n, E18 / 2n, 1_000n * E18, 100_000_000n * E18), ts)
const mSell = (ts: number, curve = M_CURVE) => log(curve, [cv.MERCURI_SELL, topic(TRADER)], u(400_000n * E18, 27n * E18 / 10n, 3n * E18 / 100n, 997n * E18, 99_600_000n * E18), ts)
// SolonPad buy: 10.2 gross in, 0.1 fee, 0.1 tax → 10 on the curve for 2M tokens.
const sBuy = (ts: number) => log(S_CURVE, [cv.SOLON_BUY, topic(TRADER), topic(TRADER)], u(102n * E18 / 10n, 2_000_000n * E18, E18 / 10n, E18 / 10n), ts)
const PRICE_AFTER_BUY = 7_000 / 966_666_666, PRICE_AFTER_SELL = 6_997 / 967_066_666

console.log('selectors (the functions the index reads)')
for (const [k, sig] of Object.entries({ phase: 'phase()', price: 'price()', progressBps: 'progressBps()', graduated: 'graduated()', realQuoteReserve: 'realQuoteReserve()', getReserves: 'getReserves()', totalSupply: 'totalSupply()', name: 'name()', symbol: 'symbol()', decimals: 'decimals()' }))
  ok(cv.SEL[k as keyof typeof cv.SEL] === toFunctionSelector('function ' + sig), `${sig} = ${cv.SEL[k as keyof typeof cv.SEL]}`)
ok(cv.MERCURI_DEPLOY_BLOCK === 22_060_881 && cv.SOLONPAD_DEPLOY_BLOCK === 21_134_269 && ix.FIRST_BLOCK === cv.SOLONPAD_DEPLOY_BLOCK, 'the factories\' deploy blocks (Mercuri 22,060,881, SolonPad 21,134,269): the launch history starts at the older one')

console.log('launches from the factories')
const m = ix.decodeCurveLaunch(tokenCreated())!
ok(m.launchpad === 'Mercuri' && m.token === M_TOKEN && m.curve === M_CURVE && m.creator === CREATOR && m.name === 'Mercury Frog' && m.symbol === 'MFROG', 'Mercuri: token, curve, creator, name and symbol from TokenCreated')
ok(near(m.open, 6_000 / 1_066_666_666) && m.supply === 1_000_000_000 && m.uri === 'ipfs://bafyfrog/meta.json' && m.ts === NOW - 3_600, 'Mercuri: opening price from the virtual reserves, supply = curve + pool, metadata URI, launch time')
ok(ix.decodeCurveLaunch(tokenCreated(M_TOKEN, M_CURVE, NOW, 'x', 'y', '', a('66'))) === null, 'a TokenCreated from any other contract is ignored')
const s0 = ix.decodeCurveLaunch(tokenLaunched())!
ok(s0.launchpad === 'SolonPad' && s0.token === S_TOKEN && s0.curve === S_CURVE && s0.goal === (10_000n * E18).toString() && s0.symbol === '', 'SolonPad: token, curve and graduation goal; named later from the token')
ok(ix.decodeCurveLaunch(tokenLaunched(a('77'))) === null, 'a SolonPad curve quoted in another ERC-20 (a tokenized stock) is left out')

console.log('trades → 24h volume, buys, sells, price and change')
const c = ix.decodeCurveLaunch(tokenCreated())!
ok(ix.addTrade(c, mBuy(NOW - 600), NOW) && ix.addTrade(c, mSell(NOW - 300), NOW), 'a buy and a sell on its curve')
ok(!ix.addTrade(c, mBuy(NOW, a('66')), NOW) && !ix.addTrade(c, sBuy(NOW), NOW), 'another contract\'s trade, or another launchpad\'s event, is not this coin\'s')
let st = ix.coinStats(c, NOW)
ok(near(st.vol24, 10.5 + 2.7) && st.buys24 === 1 && st.sells24 === 1, `24h volume $${st.vol24.toFixed(2)} (what the buyer paid, what the seller got), 1 buy, 1 sell`)
ok(near(st.price, PRICE_AFTER_SELL) && c.last === NOW - 300, 'price after the last trade; last trade time')
ok(near(st.change24, (PRICE_AFTER_SELL / (6_000 / 1_066_666_666) - 1) * 100), `a coin launched within the day changes against its opening price (${st.change24.toFixed(2)}%)`)
const old = ix.decodeCurveLaunch(tokenCreated(M_TOKEN, M_CURVE, NOW - 5 * 86_400))!
ix.addTrade(old, mBuy(NOW - 25 * 3_600), NOW); ix.addTrade(old, mSell(NOW - 60), NOW)
st = ix.coinStats(old, NOW)
ok(near(st.vol24, 2.7) && st.buys24 === 0 && near(st.change24, (PRICE_AFTER_SELL / PRICE_AFTER_BUY - 1) * 100), 'a trade 25h ago is out of the volume, and its price is the one 24h ago')
ix.prune(old, NOW + 2 * 3_600)
ok(old.b!.length === 1 && near(old.pre, PRICE_AFTER_BUY), 'buckets older than 26h are dropped, their last price carried')
ix.prune(old, NOW + 30 * 3_600)
ok(old.b === undefined && near(old.pre, PRICE_AFTER_SELL) && ix.coinStats(old, NOW + 30 * 3_600).vol24 === 0, 'a coin with no trade in the window: no buckets, no volume')
const noTime = { ...mBuy(0), blockTimestamp: undefined, blockNumber: hex(HEAD - 7_200) }
ok(ix.logTime(noTime, NOW, HEAD) === NOW - 3_600 && ix.logTime(mBuy(NOW - 5), NOW, HEAD) === NOW - 5, 'a log without its block\'s time: estimated from how far behind the head it is (2 blocks a second)')
const sc = ix.decodeCurveLaunch(tokenLaunched())!
ix.addTrade(sc, sBuy(NOW - 100), NOW)
ok(near(ix.coinStats(sc, NOW).price, 10 / 2_000_000) && near(ix.coinStats(sc, NOW).vol24, 10.2), 'SolonPad: the trade\'s price on the curve (fees aside), and what the buyer paid')

console.log('the curve\'s state')
const W = (v: bigint) => encodeAbiParameters([{ type: 'uint256' }], [v])
const ERC20 = parseAbi(['function name() view returns (string)'])
let mc = ix.decodeCurveLaunch(tokenCreated())!
let rd = ix.stateRead(mc)
ok(rd.calls.length === 4 && rd.calls[0].params[0] && (rd.calls[3].method === 'eth_getBalance'), 'Mercuri: phase, price, progress and the USDC it holds (supply is in the launch event)')
ok(rd.apply([W(0n), W(7n * 10n ** 12n), W(2_500n), '0x' + (1_000n * E18).toString(16)], NOW * 1000), 'answers applied')
ok(near(mc.priceUsd, 7e-6) && mc.progress === 0.25 && near(mc.liquidityUsd, 1_000) && mc.graduated === false && mc.stateAt === NOW * 1000, 'price $0.000007, 25% to graduation, $1,000 in the curve, still live')
ok(!ix.stateRead(mc).apply([null, W(1n), W(1n), null], NOW * 1000 + 1) && mc.stateAt === NOW * 1000, 'a curve that doesn\'t answer keeps its last state')
rd = ix.stateRead(mc)
rd.apply([W(2n), W(0n), W(10_000n), '0x0'], NOW * 1000)
ok(mc.graduated === true, 'phase 2: graduated')
let sx = ix.decodeCurveLaunch(tokenLaunched())!
rd = ix.stateRead(sx)
ok(rd.calls.length === 7, 'SolonPad, first read: graduated, reserves, raised, and the token\'s decimals, name, symbol, supply')
const symbol32 = '0x' + Buffer.from('SCAT').toString('hex').padEnd(64, '0')
ok(rd.apply([W(0n), encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [3_000n * E18, 600_000_000n * E18]), W(2_500n * E18), W(18n), encodeFunctionResult({ abi: ERC20, functionName: 'name', result: 'Solon Cat' }), symbol32, W(1_000_000_000n * E18)], NOW * 1000), 'answers applied')
ok(sx.name === 'Solon Cat' && sx.symbol === 'SCAT' && near(sx.priceUsd, 5e-6) && near(sx.liquidityUsd, 2_500) && sx.progress === 0.25 && sx.supply === 1e9, 'named (ABI string and bytes32), price from the reserves, $2,500 raised of $10,000, 1B supply')
ok(ix.stateRead(sx).calls.length === 3, 'later reads: only the curve')
sx = ix.decodeCurveLaunch(tokenLaunched())!
ok(!ix.stateRead(sx).apply([W(0n), encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [E18, E18]), W(0n), null, null, null, null], NOW * 1000) && sx.symbol === '', 'a token that doesn\'t answer at all is read again next time')

console.log('what to read first')
const coin = (block: number, extra: Partial<import('../api/_curveIndex').CurveCoin> = {}) => ({ ...ix.decodeCurveLaunch(tokenCreated(a((block % 250).toString(16).padStart(2, '0')), a((block % 250 + 1).toString(16).padStart(2, '0'))))!, block, ...extra })
const never1 = coin(10), never2 = coin(20), hot = coin(5, { stateAt: 1 }), closing = coin(6, { stateAt: NOW * 1000, progress: 0.99 }),
  stale = coin(7, { stateAt: 1, progress: 0.1 }), fresh = coin(8, { stateAt: NOW * 1000, progress: 0.1 }), grad = coin(9, { stateAt: 1, graduated: true })
const order = ix.pickForRefresh([stale, fresh, grad, never1, hot, closing, never2], new Set([hot.curve]), NOW * 1000, 10)
ok(order.map(x => x.block).join() === '20,10,5,6,7', 'never read (newest first), just traded, about to graduate, then stale; a fresh or graduated curve waits')

console.log('graduated coins: their pool, from GeckoTerminal')
const g = { ...ix.decodeCurveLaunch(tokenCreated(G_TOKEN, G_CURVE))!, graduated: true, stateAt: 1, priceUsd: 0 }
ok(ix.dueForGecko([g, mc], NOW * 1000, 10).length === 2 && ix.geckoPath([G_TOKEN]) === `/networks/arc/tokens/multi/${G_TOKEN}?include=top_pools`, 'due: graduated coins without a recent read')
const POOL_ID = '0x' + 'ee'.repeat(32)
ix.applyGecko(new Map([[G_TOKEN, g]]), {
  data: [{ id: 'arc_' + G_TOKEN, type: 'token', attributes: { address: G_TOKEN, price_usd: '0.00002', fdv_usd: '20000', market_cap_usd: null, total_reserve_in_usd: '15000.5', volume_usd: { h24: '4321' } }, relationships: { top_pools: { data: [{ id: 'arc_' + POOL_ID, type: 'pool' }] } } }],
  included: [{ id: 'arc_' + POOL_ID, type: 'pool', attributes: { address: POOL_ID, price_change_percentage: { h24: '-12.5' }, transactions: { h24: { buys: 40, sells: 25 } } },
    relationships: { base_token: { data: { id: 'arc_' + G_TOKEN, type: 'token' } }, quote_token: { data: { id: 'arc_' + USDC20, type: 'token' } } } }],
}, NOW * 1000)
ok(g.pool === POOL_ID && g.gecko?.price === 0.00002 && g.gecko.mcap === 20_000 && g.gecko.liq === 15_000.5 && g.gecko.vol === 4_321 && g.gecko.chg === -12.5 && g.gecko.buys === 40, 'price, market cap (FDV when no cap), liquidity, volume, change, txns and its top pool')
const gr = ix.toRow(g, NOW)
ok(gr.quote === USDC20, 'and that pool\'s quote token (here ERC-20 USDC), so its live swaps decode right')
ok(gr.pool === POOL_ID && gr.priceUsd === 0.00002 && gr.marketCapUsd === 20_000 && gr.liquidityUsd === 15_000.5 && gr.volume24h === 4_321 && gr.buys24h === 40 && gr.change24h === -12.5 && gr.graduated && gr.progress === null, 'its row: the pool\'s market, opening on the pool')
ok(ix.dueForGecko([g], NOW * 1000 + 60_000, 10).length === 0 && ix.dueForGecko([g], NOW * 1000 + 3 * 60_000, 10).length === 1, 're-read every 2 minutes')

console.log('which coins get a row')
const dead = { ...ix.decodeCurveLaunch(tokenCreated(a('41'), a('42'), NOW - 10 * 86_400))!, stateAt: 1, liquidityUsd: 9.5, priceUsd: 1e-6 }
const rich = { ...ix.decodeCurveLaunch(tokenCreated(a('43'), a('44'), NOW - 10 * 86_400))!, stateAt: 1, liquidityUsd: 500, priceUsd: 1e-5 }
const young = ix.decodeCurveLaunch(tokenCreated(a('45'), a('46'), NOW - 86_400))!
const busy = ix.decodeCurveLaunch(tokenCreated(a('47'), a('48'), NOW - 10 * 86_400))!
ix.addTrade(busy, mBuy(NOW - 60, a('48')), NOW)
const unnamed = ix.decodeCurveLaunch(tokenLaunched())!
ok(!ix.isListed(dead, NOW) && ix.isListed(rich, NOW) && ix.isListed(young, NOW) && ix.isListed(busy, NOW) && ix.isListed(g, NOW) && !ix.isListed(unnamed, NOW), 'listed: graduated, traded today, $10+ in the curve, or launched in the last 3 days; not an old quiet one with $9.50 left, nor one not yet named')
const rows = ix.listRows([dead, rich, young, busy, g], NOW)
ok(rows.map(r => r.token).join() === [G_TOKEN, busy.token, rich.token, young.token].join(), 'busiest first, then the most USDC, then the newest')
const rr = rows.find(r => r.token === rich.token)!
ok(rr.pool === rich.curve && rr.quote === NATIVE && rr.marketCapUsd === 1e-5 * 1e9 && rr.liquidityUsd === 500 && rr.progress === null && rr.launchedAt === (NOW - 10 * 86_400) * 1000, 'a curve coin\'s row: opens on its curve, market cap = price × supply')

console.log('one whole build, against an in-memory chain')
const gLaunch = tokenCreated(G_TOKEN, G_CURVE, NOW - 2 * 86_400, 'Grad', 'GRAD', 'https://img.example/grad.png')
gLaunch.blockNumber = hex(HEAD - 3_000)
const LOGS: RawLog[] = [tokenCreated(), tokenLaunched(), gLaunch]
const TRADES: RawLog[] = [mBuy(NOW - 120), mSell(NOW - 60), sBuy(NOW - 30)]
const scans: string[] = []
const answers: Record<string, string> = {
  [`${M_CURVE}|${cv.SEL.phase}`]: W(0n), [`${M_CURVE}|${cv.SEL.price}`]: W(7n * 10n ** 12n), [`${M_CURVE}|${cv.SEL.progressBps}`]: W(2_500n),
  [`${G_CURVE}|${cv.SEL.phase}`]: W(2n), [`${G_CURVE}|${cv.SEL.price}`]: W(0n), [`${G_CURVE}|${cv.SEL.progressBps}`]: W(10_000n),
  [`${S_CURVE}|${cv.SEL.graduated}`]: W(0n), [`${S_CURVE}|${cv.SEL.getReserves}`]: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [3_000n * E18, 600_000_000n * E18]),
  [`${S_CURVE}|${cv.SEL.realQuoteReserve}`]: W(2_500n * E18), [`${S_TOKEN}|${cv.SEL.decimals}`]: W(18n), [`${S_TOKEN}|${cv.SEL.name}`]: encodeFunctionResult({ abi: ERC20, functionName: 'name', result: 'Solon Cat' }),
  [`${S_TOKEN}|${cv.SEL.symbol}`]: encodeFunctionResult({ abi: ERC20, functionName: 'name', result: 'SCAT' }), [`${S_TOKEN}|${cv.SEL.totalSupply}`]: W(1_000_000_000n * E18),
}
const batches: number[] = []
let clock = NOW * 1000
const io: import('../api/_curveIndex').IndexIO = {
  head: () => Promise.resolve(HEAD),
  scan(f, from, to) {
    const launches = f.address !== undefined
    scans.push(`${launches ? 'launches' : 'trades'} ${from}-${to}`)
    // The first launch scan is cut short: the history takes more than one build.
    const cut = launches && from === ix.FIRST_BLOCK ? HEAD - 4_500 : to
    const src = launches ? LOGS : TRADES
    return Promise.resolve({ logs: src.filter(l => parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= cut), scannedTo: cut })
  },
  batch(calls) {
    batches.push(calls.length)
    return Promise.resolve(calls.map(k => k.method === 'eth_getBalance' ? '0x' + (1_000n * E18).toString(16) : answers[`${(k.params[0] as { to: string }).to}|${(k.params[0] as { data: string }).data}`] ?? null))
  },
  gecko: () => Promise.resolve({ data: [{ id: 'x', type: 'token', attributes: { address: G_TOKEN, price_usd: '0.00002', market_cap_usd: '20000', total_reserve_in_usd: '15000', volume_usd: { h24: '4000' } } }] }),
  image: uri => Promise.resolve(uri.endsWith('.png') ? uri : 'https://img.example/frog.png'),
}
const state = ix.emptyState(HEAD)
ok(state.launchesTo === ix.FIRST_BLOCK - 1 && state.tradesTo === HEAD - ix.TRADE_HISTORY_BLOCKS - 1, 'a new index: the launch history from the first factory, trades from about a day back')
await ix.updateIndex(state, io, 12_000, () => clock)
ok(state.launchesTo === HEAD - 4_500 && state.tradesTo === HEAD - ix.TRADE_HISTORY_BLOCKS - 1 && scans.join() === `launches ${ix.FIRST_BLOCK}-${HEAD}`, 'first build: part of the launch history; trades wait until every curve is known')
ok(state.coins.length === 1 && state.coins[0].token === M_TOKEN && state.coins[0].stateAt === clock && batches.length === 1, 'the coin found so far has its state read')
clock += 20_000
await ix.updateIndex(state, io, 12_000, () => clock)
ok(state.launchesTo === HEAD && state.tradesTo === HEAD && scans.length === 3, 'second build: the rest of the launches, then the day of trades')
const byToken = new Map(state.coins.map(x => [x.token, x]))
const sm = ix.coinStats(byToken.get(M_TOKEN)!, Math.floor(clock / 1000)), ss = ix.coinStats(byToken.get(S_TOKEN)!, Math.floor(clock / 1000))
ok(near(sm.vol24, 13.2) && sm.buys24 === 1 && sm.sells24 === 1 && near(ss.vol24, 10.2), 'every curve\'s trades counted')
ok(byToken.get(S_TOKEN)!.symbol === 'SCAT' && byToken.get(G_TOKEN)!.graduated === true && byToken.get(G_TOKEN)!.gecko?.vol === 4_000, 'SolonPad coin named, graduated coin found and its pool\'s market read')
ok(byToken.get(M_TOKEN)!.image === 'https://img.example/frog.png' && byToken.get(M_TOKEN)!.uri === undefined && byToken.get(G_TOKEN)!.image === 'https://img.example/grad.png', 'images from the metadata (or the URI itself when it is one)')
ok(batches.every(b => b <= ix.BATCH_CALLS), `state reads batched (${batches.join(', ')} calls)`)
const built = ix.listRows(state.coins, Math.floor(clock / 1000))
ok(built.length === 3 && built.map(r => r.token).join() === [G_TOKEN, M_TOKEN, S_TOKEN].join() && built.every(r => r.symbol && r.pool), `rows, busiest first: ${built.map(r => `${r.symbol} (${r.launchpad}, $${r.volume24h.toFixed(1)})`).join(', ')}`)
clock += 20_000
await ix.updateIndex(state, io, 12_000, () => clock)
ok(scans.length === 3, 'up to date: a later build reads no logs until the chain moves')

console.log('the route (/api/launchpad?of=curves), with the chain, GeckoTerminal and Supabase faked')
// Supabase's `arcdex_kv`, in memory; the route reads its settings when first imported.
process.env.SUPABASE_URL = 'https://supa.test'
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test'
const kv = new Map<string, { value: unknown; updated_at: string }>()
const kvReads: string[] = []
const realFetch = globalThis.fetch
const rpcAnswer = (b: { method: string; params: unknown[] }): unknown => {
  if (b.method === 'eth_blockNumber') return hex(HEAD)
  if (b.method === 'eth_getLogs') {
    const f = b.params[0] as { address?: string[]; topics: string[][]; fromBlock: string; toBlock: string }
    const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16)
    return (f.address ? LOGS : TRADES).filter(l => parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to)
  }
  if (b.method === 'eth_getBalance') return '0x' + (1_000n * E18).toString(16)
  if (b.method === 'eth_call') { const p = b.params[0] as { to: string; data: string }; return answers[`${p.to}|${p.data}`] }
  return null
}
let gtCalls = 0, rpcCalls = 0
type RpcReq = { id: number; method: string; params: unknown[] }
const reply = (body: unknown, status = 200) => Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
  const sent = typeof init?.body === 'string' ? init.body : '{}'
  if (url.startsWith('https://supa.test/rest/v1/arcdex_kv')) {
    if ((init?.method ?? 'GET') === 'GET') {
      const key = decodeURIComponent(/key=eq\.([^&]+)/.exec(url)![1])
      kvReads.push(key)
      const row = kv.get(key)
      return reply(row ? [row] : [])
    }
    for (const r of JSON.parse(sent) as { key: string; value: unknown; updated_at: string }[]) kv.set(r.key, { value: structuredClone(r.value), updated_at: r.updated_at })
    return reply('', 201)
  }
  if (/geckoterminal|coingecko/.test(url)) { gtCalls++; return reply({ data: [] }) }
  if (url.startsWith('https://img.example')) return reply({})
  if (url.startsWith('https://ipfs.io/')) return reply({ image: 'https://img.example/frog.png' })
  const body = JSON.parse(sent) as RpcReq | RpcReq[]
  rpcCalls++
  const one = (x: RpcReq) => {
    const r = rpcAnswer(x)
    return r === undefined || r === null ? { jsonrpc: '2.0', id: x.id, error: { code: 3, message: 'execution reverted' } } : { jsonrpc: '2.0', id: x.id, result: r }
  }
  return reply(Array.isArray(body) ? body.map(one) : one(body))
})
const realNow = Date.now
let shift = 0
Date.now = () => realNow() + shift
type Served = { complete: boolean; indexed: number; updatedAt: string | null; coins: import('../api/_curveIndex').CurveMarketRow[] }
try {
  const { default: launchpad } = await import('../api/launchpad')
  const req = () => new Request('https://arcdex.online/api/launchpad?of=curves')
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) } }
  const settle = async () => { await Promise.all(pending.splice(0)) }

  // A first visit: nothing built yet — an empty answer at once, the build in the background.
  let res = await launchpad(req(), ctx)
  let body = await res.json() as Served
  ok(res.status === 200 && !body.complete && body.coins.length === 0 && res.headers.get('cache-control') === 'no-store' && pending.length === 1, 'first visit: answered at once (empty, not cached) while the index builds in the background')
  await settle()
  const rows = kv.get('curves:rows:v1')?.value as Served | undefined, lock = kv.get('curves:building')?.value
  ok(rows?.coins.length === 3 && rows.complete && kv.has('curves:state:v1') && lock === 0, 'the build saved the rows and the whole index, and released its lock')

  res = await launchpad(req(), ctx)
  body = await res.json() as Served
  ok(body.complete && body.indexed === 3 && body.coins.length === 3 && res.headers.get('cache-control') === 'public, s-maxage=30, stale-while-revalidate=600', `next visit: ${body.coins.map(r => r.symbol).join(', ')}, CDN-cached`)
  const frog = body.coins.find(r => r.token === M_TOKEN)!
  ok(frog.launchpad === 'Mercuri' && frog.pool === M_CURVE && near(frog.volume24h, 13.2) && frog.image === 'https://img.example/frog.png' && near(frog.liquidityUsd, 1_000), 'a coin as served: its launchpad, curve, 24h volume, image, liquidity')
  ok(gtCalls === 1, 'GeckoTerminal asked once, for the graduated coin')
  const grad = body.coins.find(r => r.token === G_TOKEN)!
  ok(grad.graduated && grad.priceUsd === null && grad.marketCapUsd === null, 'a graduated coin GeckoTerminal had nothing on: no price rather than its opening one')
  const reads = kvReads.length
  await (await launchpad(req(), ctx)).json()
  ok(kvReads.length === reads && pending.length === 0, 'while the index in memory is fresh, requests read nothing from Supabase')

  // 45s later: out of date — the last rows at once, an update behind them.
  shift = 45_000
  const rpcBefore = rpcCalls
  const savedBefore = (kv.get('curves:rows:v1')!.value as { updatedAt: number }).updatedAt
  res = await launchpad(req(), ctx)
  body = await res.json() as Served
  ok(body.coins.length === 3 && pending.length === 1, 'out of date: the last rows at once, and one update in the background')
  await launchpad(req(), ctx)
  ok(pending.length === 1, 'one builder at a time')
  await settle()
  ok(rpcCalls > rpcBefore && (kv.get('curves:rows:v1')!.value as { updatedAt: number }).updatedAt >= savedBefore + 45_000 && kv.get('curves:building')?.value === 0, 'updated from the chain, saved, lock released')

  // Another instance saved newer rows: served from Supabase, no build here.
  shift = 90_000
  kv.set('curves:rows:v1', { value: { ...(kv.get('curves:rows:v1')!.value as Served), updatedAt: Date.now(), indexed: 999 }, updated_at: new Date().toISOString() })
  res = await launchpad(req(), ctx)
  body = await res.json() as Served
  ok(body.indexed === 999 && pending.length === 0, 'rows another instance saved just now are served as they are')
  const own = await launchpad(new Request('https://arcdex.online/api/launchpad'))
  const ownBody = await own.json() as { launches?: unknown[]; coins?: unknown }
  ok(own.status === 200 && Array.isArray(ownBody.launches) && ownBody.coins === undefined, 'without ?of=curves: ARCDEX\'s own launchpad index, as before')

  console.log('the browser side')
  globalThis.fetch = (() => reply({ coins: [
    { ...frog },
    { ...frog, token: 'not an address' },
    { ...frog, token: a('71'), symbol: '' },
    { ...frog, token: a('72'), launchpad: 'Other' },
    { ...frog, token: a('73'), image: 'javascript:alert(1)', progress: 7, graduated: 'yes', quote: 'nonsense' },
  ] }))
  const got = await getCurveMarket()
  ok(got.length === 2 && got[0].token === M_TOKEN && got[1].image === null && got[1].progress === 1 && got[1].graduated === false && got[1].quote === NATIVE, 'rows checked: bad addresses, missing symbols and unknown launchpads dropped; an unsafe image, an out-of-range progress, a non-boolean flag and a bad quote cleaned')
  const { withCurveCoins } = await import('../src/arcdex/lib/tokenMeta')
  const meta = (address: string, volume24h: number) => ({ address, symbol: address.slice(2, 5), name: '', image: null, priceUsd: 1, pool: '', change24h: 0, change1h: 0, marketCapUsd: null, volume24h, liquidityUsd: 0, bonded: null, createdAt: null })
  const gtList = [meta(a('01'), 900), meta(a('02'), 50), meta(a('03'), 70), meta(a('04'), 10)] // a carried coin (70) sits out of volume order
  const merged = withCurveCoins(gtList, [meta(a('11'), 60), meta(a('02'), 999), meta(a('12'), 5_000), meta(a('13'), 0)])
  ok(merged.map(x => x.address.slice(2, 4)).join() === '12,01,11,02,03,04,13', 'the shared market list: curve coins placed by volume, GeckoTerminal\'s own order kept, no coin twice')
  ok(withCurveCoins(gtList, []) === gtList, 'no curve coins: the same list')
  const t = curveRowToArcToken(got[0], NOW * 1000)
  ok(t.launchpad === 'Mercuri' && t.poolAddress === M_CURVE && t.quoteSymbol === 'USDC' && t.quoteAddress === '0x0000000000000000000000000000000000000000' && t.volume24h === got[0].volume24h && t.txCount24h === got[0].buys24h + got[0].sells24h, 'a Terminal row: Mercuri badge, opens on its curve, quoted in native USDC, with its volume and trades')
  ok(t.ageMs === NOW * 1000 - got[0].launchedAt && t.bondingProgress === 25 && t.verified, 'its age from the launch, progress in %, launched by the factory itself')
} finally {
  globalThis.fetch = realFetch
  Date.now = realNow
}
console.log('\nall curve index checks passed')
