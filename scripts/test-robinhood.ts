// Robinhood Chain on ARCDEX: the checks every Across quote must pass
// before anything is signed (src/arcdex/lib/acrossQuote.ts), Robinhood
// Chain's market rows (api/robinhoodMarket.ts), trap pools and the price
// guard on quotes, stock tokens and routes.
// Offline, on real answers recorded 2026-10-04 (scripts/fixtures/across-*.json,
// rh-pools.json, rh-shrinu.json). With --live it also asks Across for fresh quotes and reads
// Robinhood Chain (no wallet, nothing sent).
// Run: bun scripts/test-robinhood.ts [--live]

import { readFileSync } from 'fs'

const { checkQuote, quoteUrl, AcrossError, ACROSS_TARGETS, ACROSS_HANDLERS, ARC_USDC, getAcrossQuote, acrossErrorText, quoteValue, quoteVerdict } = await import('../src/arcdex/lib/acrossQuote')
const { poolToCoin, mergeCoins, isWashPool, poolFeePct, markPools, isListedRh, RH_LAUNCHPADS } = await import('../src/arcdex/api/robinhoodMarket')
const { isLaunchpadCoin } = await import('../api/_launchpads')
const { isStockName, stockCompany, isStockToken, RH_QUOTES, USDG, STOCK_RESTRICTED, rhTokenInfo } = await import('../src/arcdex/lib/robinhood')
const { pathToPage, pageToPath } = await import('../src/arcdex/lib/router')
const { FEE_WALLET } = await import('../src/arcdex/lib/platform')

const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }
const fixture = (n: string) => JSON.parse(readFileSync(`scripts/fixtures/${n}.json`, 'utf8'))
const refuses = (f: () => unknown, m: string, why?: RegExp) => {
  try { f() } catch (e) {
    ok(e instanceof AcrossError && (!why || why.test((e as Error).message)), m)
    return
  }
  throw new Error('FAIL (accepted): ' + m)
}

const MOW = '0x0b7c6c138dc75622f4200d157b13fb93e6bd94fa'
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'
const BUYER = '0x414b6be4cf906739fbf7d49165beca5f4ceec3da' // the quotes were asked for these (public) wallets
const SELLER = '0x47f81f3402797686e90cc75601327b4bbcb1dda9'
const ATTACKER = '0x6666666666666666666666666666666666666666'
const buyReq = { side: 'buy' as const, token: MOW, amount: 5_000_000n, trader: BUYER, feeBps: 200 }
const sellReq = { side: 'sell' as const, token: MOW, amount: 10n ** 19n, trader: SELLER, feeBps: 200 }
const gasReq = { side: 'gas' as const, token: '', amount: 500_000n, trader: BUYER, feeBps: 0 }
const buy = fixture('across-buy'), sell = fixture('across-sell'), gas = fixture('across-gas')
const edit = (j: Record<string, unknown>, f: (c: any) => void) => { const c = structuredClone(j); f(c); return c }
const swapWord = (data: string, i: number, addr: string) => {
  const at = 10 + i * 64
  return data.slice(0, at) + addr.toLowerCase().replace('0x', '').padStart(64, '0') + data.slice(at + 64)
}

console.log('the quote ARCDEX asks for')
const bu = new URL(quoteUrl(buyReq)).searchParams
ok(bu.get('inputToken') === ARC_USDC && bu.get('outputToken') === MOW && bu.get('originChainId') === '5042' && bu.get('destinationChainId') === '4663', 'buy: USDC on Arc → the coin on Robinhood Chain')
ok(bu.get('appFee') === '0.02' && bu.get('appFeeRecipient') === FEE_WALLET, 'buy: 2% to the fee wallet')
ok(bu.get('refundOnOrigin') === 'true' && bu.get('recipient') === BUYER && bu.get('depositor') === BUYER, 'buy: refunds come back on Arc, delivered to the trader')
ok(bu.get('tradeType') === 'exactInput' && bu.get('slippage') === 'auto', 'exact input, Across sets the slippage')
const su = new URL(quoteUrl(sellReq)).searchParams
ok(su.get('inputToken') === MOW && su.get('outputToken') === ARC_USDC && su.get('originChainId') === '4663' && su.get('destinationChainId') === '5042', 'sell: the coin on Robinhood Chain → USDC on Arc')
ok(su.get('appFee') === '0.02' && !su.has('refundOnOrigin'), 'sell: 2%, refunds as Across decides (USDG there)')
const gu = new URL(quoteUrl(gasReq)).searchParams
ok(gu.get('outputToken') === '0x0000000000000000000000000000000000000000' && !gu.has('appFee'), 'gas: native ETH, no fee')

console.log('real quotes pass')
const qb = checkQuote(buyReq, buy)
ok(qb.chainId === 5042 && qb.spender === ACROSS_TARGETS[5042] && qb.tx.to.toLowerCase() === ACROSS_TARGETS[5042], 'buy: signed on Arc, to the SpokePool')
ok(qb.minOut > 0n && qb.expectedOut >= qb.minOut && qb.appFee > 0n && qb.outDecimals === 18, 'buy: expected and minimum out, the fee in the coin')
ok(Math.abs(Number(qb.appFee) / Number(qb.expectedOut + qb.appFee) - 0.019) < 0.002, 'buy: the fee is ~2% of what the swap delivered')
const qs = checkQuote(sellReq, sell)
ok(qs.chainId === 4663 && qs.spender === ACROSS_TARGETS[4663] && qs.outDecimals === 6, 'sell: signed on Robinhood Chain, to the periphery, paid in USDC')
ok(qs.appFee === 31_686n, 'sell: the fee in USDC ($0.0317)')
const qg = checkQuote(gasReq, gas)
ok(qg.appFee === 0n && qg.minOut > 0n, 'gas: no fee, a minimum of ETH')

console.log('anything else is refused')
refuses(() => checkQuote(buyReq, edit(buy, c => { c.swapTx.to = ATTACKER })), 'a transaction to another contract', /contract/)
refuses(() => checkQuote(buyReq, edit(buy, c => { c.swapTx.chainId = 1 })), 'a transaction on another chain')
refuses(() => checkQuote(buyReq, edit(buy, c => { c.swapTx.value = '1' })), 'a transaction sending native funds')
refuses(() => checkQuote({ ...buyReq, trader: ATTACKER }, buy), 'a deposit from someone else', /from you/)
refuses(() => checkQuote({ ...buyReq, amount: 6_000_000n }, buy), 'another amount')
refuses(() => checkQuote({ ...buyReq, token: NVDA }, buy), 'another coin delivered')
refuses(() => checkQuote(buyReq, edit(buy, c => { c.swapTx.data = swapWord(c.swapTx.data, 1, ATTACKER) })), 'delivered to an unknown address', /address/)
refuses(() => checkQuote(buyReq, edit(buy, c => { c.swapTx.data = swapWord(c.swapTx.data, 6, '0x1') })), 'a deposit to another chain')
refuses(() => checkQuote(buyReq, edit(buy, c => { c.swapTx.data = (c.swapTx.data as string).split(BUYER.slice(2)).join(ATTACKER.slice(2)).replace(ATTACKER.slice(2), BUYER.slice(2)) })), 'instructions that pay someone else', /pay you/)
refuses(() => checkQuote(buyReq, edit(buy, c => { c.swapTx.data = (c.swapTx.data as string).split(FEE_WALLET.slice(2)).join(ATTACKER.slice(2)) })), 'a fee that goes elsewhere', /fee/)
refuses(() => checkQuote(buyReq, edit(buy, c => { c.checks.allowance.spender = ATTACKER })), 'an approval for another spender', /approve/)
refuses(() => checkQuote(buyReq, edit(buy, c => { c.crossSwapType = 'anyToAny' })), 'an unexpected route')
refuses(() => checkQuote(buyReq, edit(buy, c => { c.minOutputAmount = '0' })), 'no minimum received')
refuses(() => checkQuote(buyReq, edit(buy, c => { c.swapTx.data = '0xdeadbeef' })), 'a transaction that can’t be read')
refuses(() => checkQuote(buyReq, edit(buy, c => { delete c.swapTx })), 'no transaction')
refuses(() => checkQuote({ ...sellReq, trader: ATTACKER }, sell), 'a sale from someone else')
refuses(() => checkQuote({ ...sellReq, amount: 1n }, sell), 'a sale of another amount')
refuses(() => checkQuote(sellReq, edit(sell, c => { c.swapTx.to = ACROSS_TARGETS[5042] })), 'a sale sent to the Arc contract')
refuses(() => checkQuote(sellReq, buy), 'a buy offered as a sale')
refuses(() => checkQuote(gasReq, edit(gas, c => { c.fees.total.details.app = { amount: '5' } })), 'a fee on gas')
ok(ACROSS_HANDLERS[4663] && ACROSS_HANDLERS[5042], 'each destination has its known handler')

console.log('Across’s own errors in words')
ok(/below what Across/.test(acrossErrorText('AMOUNT_TOO_LOW', '')) && /can’t route/.test(acrossErrorText(undefined, 'Unable to find tokenDetails for address: 0x11')), 'too small, unknown token')
ok(/slippage/i.test(acrossErrorText(undefined, 'Insufficient slippage tolerance. Minimum recommended slippage is 0.0500')), 'anything else as Across said it')

console.log('the market list')
const pools = fixture('rh-pools')
const tokens = new Map((pools.included as { type: string; attributes: { address: string; name: string; symbol: string } }[]).filter(i => i.type === 'token').map(i => [i.attributes.address.toLowerCase(), i.attributes]))
const rows = (pools.data as never[]).map(p => poolToCoin(p, tokens as never)).filter(Boolean) as NonNullable<ReturnType<typeof poolToCoin>>[]
ok(rows.length > 0 && rows.every(r => !RH_QUOTES.has(r.address)), 'USDG and WETH are quotes, never rows')
const zyn = rows.find(r => r.symbol === 'ZYNOREK')!
ok(zyn && isWashPool(zyn, Date.parse('2026-10-05T00:00:00Z')), 'a pool traded by 1 wallet each way is wash (ZYNOREK: $68M "volume")')
ok(!isWashPool(rows.find(r => r.symbol === 'SI')!, Date.parse('2026-10-05T00:00:00Z')), 'a busy pool is not')
ok(isWashPool(zyn, zyn.createdAt + 3 * 3600_000) && !isWashPool(zyn, zyn.createdAt + 3600_000), 'a pool under 2 hours old gets a pass')
ok(!isWashPool({ ...zyn, volume24h: 800 }, Date.parse('2026-10-05T00:00:00Z')), 'a quiet pool with few traders is not (a stock token’s slow day)')
const merged = mergeCoins(rows)
const nvda = merged.find(r => r.address === NVDA)!
const nvdaPools = rows.filter(r => r.address === NVDA)
ok(nvdaPools.length >= 2 && merged.filter(r => r.address === NVDA).length === 1, 'one row per coin (NVDA has several pools)')
ok(Math.abs(nvda.volume24h - nvdaPools.reduce((s, r) => s + r.volume24h, 0)) < 1, 'its volume is the sum of its pools')
ok(nvda.quote === USDG && nvda.stock, 'NVDA: quoted in USDG, a stock token by name')
ok(rows.find(r => r.symbol === 'AVGO')?.quoteSymbol === 'NVDA', 'a pool quoted in another coin keeps that quote’s ticker (AVGO/NVDA)')
ok(merged.find(r => r.symbol === 'MOW')?.quoteSymbol === 'ETH', 'MOW trades against native ETH')

console.log('trap pools (SHRINU / USDG at 20% and 55%, priced ~300× under its real pool)')
ok(poolFeePct('SHRINU / USDG 20%') === 20 && poolFeePct('NVDA / USDG 0.05%') === 0.05 && poolFeePct('MOW / WETH') === null, 'the fee tier is read from the pool’s name')
const shr = fixture('rh-shrinu')
const shrTokens = new Map([[shr.data.attributes.address.toLowerCase(), shr.data.attributes]])
const shrPools = (shr.included as never[]).map(p => poolToCoin(p, shrTokens as never)).filter(Boolean) as NonNullable<ReturnType<typeof poolToCoin>>[]
const trap = shrPools.slice().sort((a, b) => b.liquidity - a.liquidity)[0]
ok(shrPools.length === 3 && trap.feePct === 20, 'the deepest SHRINU pool by "liquidity" is the 20% trap')
const marked = markPools(shrPools)
ok(marked[0].quoteSymbol === 'WETH' && marked[0].feePct === 0.3 && !marked[0].offMarket, 'its best market is the busy WETH 0.3% pool')
ok(marked.slice(1).every(p => p.offMarket), 'both trap pools are off the market')
const shrRow = mergeCoins(shrPools)[0]
ok(Math.abs(shrRow.priceUsd / Number(shr.data.attributes.price_usd) - 1) < 0.01 && shrRow.liquidity < 200_000, 'the coin’s row: the real pool’s price and depth')
ok(Math.abs(shrRow.volume24h - marked[0].volume24h) < 1, 'trap pools’ volume isn’t counted')
const fakeTrap = { ...marked[0], pool: '0xfake', feePct: null, traders24h: 0, volume24h: 0, liquidity: 5e6, priceUsd: marked[0].priceUsd / 300 }
ok(markPools([fakeTrap, marked[0]])[1].offMarket && markPools([fakeTrap, marked[0]])[0].pool === marked[0].pool, 'a trap without a fee in its name: an idle pool far off the busy one’s price')
ok(!markPools([marked[0], { ...marked[0], pool: '0xother', priceUsd: marked[0].priceUsd * 1.2 }])[1].offMarket, 'a second real pool 20% away is still a market')

console.log('launchpad coins only (owner, 2026-10-04)')
const onPad = (dex: string) => poolToCoin({ ...(pools.data as any[]).find(p => p.attributes.name.startsWith('MOW')), relationships: { ...(pools.data as any[]).find(p => p.attributes.name.startsWith('MOW')).relationships, dex: { data: { id: dex } } } } as never, tokens as never)!
ok(onPad('bankr-robinhood').launchpad === 'Bankr' && onPad('pons-v2-dex').launchpad === 'Pons' && onPad('clanker-robinhood').launchpad === 'Clanker', 'a pool on a launchpad’s venue names its launchpad (Bankr, Pons’s DEX, Clanker)')
ok(onPad('uniswap-v4-robinhood').launchpad === null && onPad('up-v3').launchpad === null && !('up-v3' in RH_LAUNCHPADS), 'a plain DEX pool names none (Uniswap, Up V3)')
const mowRow = merged.find(r => r.symbol === 'MOW')!
ok(!mowRow.launchpad && !mowRow.stock && !isListedRh(mowRow), 'a coin whose pools are all on plain DEXes isn’t listed (MOW, in the recorded pools)')
const mixed = mergeCoins([onPad('uniswap-v4-robinhood'), { ...onPad('bankr-robinhood'), pool: '0xbankr', traders24h: 1, volume24h: 10 }])[0]
ok(mixed.launchpad === 'Bankr' && isListedRh(mixed) && mixed.pool !== '0xbankr', 'one launchpad pool lists the coin, whichever pool is its busiest')
ok(isListedRh(nvda) && nvda.stock && !nvda.launchpad, 'a stock token is listed (until the chain says it’s an impostor)')
ok(['Argus', 'ARGUS', 'ARCDEX', 'Mercuri', 'SolonPad', 'Peach', 'Faze', 'Aka.fun', 'o1', 'Minara', 'Long.supply', 'Minara.fun', 'Argus (Arc)'].every(isLaunchpadCoin), 'Arc: every launchpad the engine and the market list name')
ok(![null, undefined, '', 'Other', 'other', 'Uniswap V4 (Arc)', 'uniswap-v3-arc', 'Curve'].some(isLaunchpadCoin), 'Arc: "Other" (a contract no launchpad made), plain DEXes and nothing at all aren’t listed')

console.log('quotes valued at the market price')
const mowPrice = rows.find(r => r.symbol === 'MOW')!.priceUsd
const vBuy = quoteValue(qb, 5, mowPrice)!
ok(quoteVerdict(vBuy) === 'ok' && Math.abs(vBuy.impact) < 0.03 && vBuy.cost > vBuy.impact, 'MOW $5 buy: under 3% price impact, fees on top')
const vSell = quoteValue(qs, 10, mowPrice)!
ok(quoteVerdict(vSell) === 'ok' && Math.abs(vSell.impact) < 0.03, 'MOW sale of 10: under 3% price impact')
const shrPrice = shrRow.priceUsd
const trapBuy = fixture('across-trap-buy'), trapSell = fixture('across-trap-sell')
const asQuote = (j: any, side: 'buy' | 'sell') => ({ side, expectedOut: BigInt(j.expectedOutputAmount), appFee: BigInt(j.fees.total.details.app.amount), outDecimals: j.outputToken.decimals, bridgeFeeUsd: Number(j.fees.total.details.bridge.amountUsd) })
const vTrapBuy = quoteValue(asQuote(trapBuy, 'buy'), 25, shrPrice)!
ok(vTrapBuy.rate > 100 && quoteVerdict(vTrapBuy) === 'off-market', `a $25 SHRINU buy routed through the trap pays ${Math.round(vTrapBuy.rate)}× the market: refused`)
const vTrapSell = quoteValue(asQuote(trapSell, 'sell'), 1_000_000, shrPrice)!
ok(vTrapSell.impact > 0.99 && quoteVerdict(vTrapSell) === 'refuse', 'a ~$7 SHRINU sale routed through it pays $0.01: refused, no tick box')
const synth = (rate: number, side: 'buy' | 'sell' = 'sell') => quoteVerdict(quoteValue({ side, expectedOut: BigInt(Math.round(rate * 100 * 1e6)), appFee: 0n, outDecimals: 6, bridgeFeeUsd: 0 }, 100, 1))
ok(synth(0.97) === 'ok' && synth(0.8) === 'confirm' && synth(0.49) === 'refuse', 'price impact: fine at 3%, a tick box at 20%, refused at 51%')
ok(synth(1.2) === 'ok' && synth(1.3) === 'off-market', 'better than the market: fine at +20% (a stale price), refused at +30%')
ok(quoteVerdict(quoteValue({ side: 'sell', expectedOut: 84_000_000n, appFee: 0n, outDecimals: 6, bridgeFeeUsd: 2 }, 100, 1)) === 'confirm', 'a tick box when fees and impact together pass 15%')
ok(quoteValue(qb, 5, 0) === null && quoteVerdict(null) === 'unpriced' && quoteValue(qg, 0.5, 1) === null, 'no market price (or the gas top-up): unpriced, never "ok"')

console.log('stock tokens')
ok(isStockName('NVIDIA • Robinhood Token') && !isStockName('MowCat') && !isStockName(null), 'by name')
ok(stockCompany('Broadcom • Robinhood Token') === 'Broadcom', 'the company')
const spy = poolToCoin({ id: 'robinhood_0x1', attributes: { address: '0x1', name: 'SPY / USDG' }, relationships: { base_token: { data: { id: 'robinhood_0x2222222222222222222222222222222222222222' } }, quote_token: { data: { id: `robinhood_${USDG}` } } } } as never,
  new Map([['0x2222222222222222222222222222222222222222', { address: '0x2222222222222222222222222222222222222222', name: 'SPDR S&amp;P 500 ETF Trust • Robinhood Token', symbol: 'SPY' }]]) as never)
ok(spy?.name === 'SPDR S&P 500 ETF Trust • Robinhood Token' && spy.stock && spy.quoteSymbol === 'USDG', 'GeckoTerminal’s escaped names are read as written (S&P)')
ok(['US', 'CA', 'GB', 'CH', 'AE', 'IR', 'KP'].every(c => STOCK_RESTRICTED.has(c)) && !STOCK_RESTRICTED.has('TZ') && !STOCK_RESTRICTED.has('KE'), 'restricted countries (not Tanzania or Kenya)')

console.log('routes')
const v4 = '0x5291cfd042d8a771a510534ee31090bc4f4dc72724871e8f321aecfd12332a9a'
ok(JSON.stringify(pathToPage('/robinhood', '')) === JSON.stringify({ name: 'robinhood' }), '/robinhood')
const pg = pathToPage(`/robinhood/token/${MOW.toUpperCase().replace('0X', '0x')}`, `?pool=${v4}`)
ok(pg?.name === 'rh-token' && pg.address === MOW && pg.pool === v4, 'a coin with its v4 pool (32-byte id)')
ok(pageToPath(pg!) === `/robinhood/token/${MOW}?pool=${v4}`, 'and back')
ok((pathToPage(`/robinhood/token/${MOW}`, '?pool=junk') as { pool?: string }).pool === '', 'a bad pool is dropped')
ok(pathToPage('/robinhood/token/0x12', '')?.name === 'robinhood', 'a bad address opens the markets')
ok(pathToPage(`/token/${MOW}`, '')?.name === 'argus', 'Arc’s /token links are unchanged')

console.log('the /across proxy (netlify/edge-functions/across.ts)')
const proxy = await import('../netlify/edge-functions/across')
const site = 'https://arcsense.site'
const same = new Headers({ 'sec-fetch-site': 'same-origin' })
const pathOf = (r: Parameters<typeof quoteUrl>[0]) => quoteUrl(r).slice('https://app.across.to/api'.length)
const buyPath = pathOf(buyReq)
const okReq = (path: string, h = same) => proxy.acrossRequest(new URL(site + '/across' + path), h)
ok('path' in okReq(buyPath) && (okReq(buyPath) as { path: string }).path.startsWith('/swap/approval?'), 'forwards ARCDEX’s own buy quote')
ok('path' in okReq(pathOf(sellReq)) && 'path' in okReq(pathOf(gasReq)), 'and its sale and gas quotes')
ok('path' in okReq('/deposit/status?depositTxnRef=0x' + 'ab'.repeat(32)), 'and a deposit’s status')
ok('error' in okReq(buyPath, new Headers({ 'sec-fetch-site': 'cross-site' })) && 'error' in okReq(buyPath, new Headers()), 'refuses other sites’ pages and requests that don’t say where they come from')
ok('error' in okReq(buyPath.replace('originChainId=5042', 'originChainId=1')), 'refuses a route that isn’t Arc ⇄ Robinhood Chain')
ok('error' in okReq(buyPath.replace(FEE_WALLET, ATTACKER)), 'refuses a fee to anyone but the fee wallet')
ok('error' in okReq(buyPath.replace('appFee=0.02', 'appFee=0.5')), 'refuses a fee over 2%')
ok('error' in okReq('/deposits?depositor=' + BUYER) && 'error' in okReq('/deposit/status?depositTxnRef=0x12'), 'refuses anything else')
{
  const realFetch = globalThis.fetch
  const g = globalThis as unknown as { Netlify?: unknown }
  const env: Record<string, string> = {}
  g.Netlify = { env: { get: (k: string) => env[k] } }
  const seen: { url: string; auth: string | null }[] = []
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    seen.push({ url: String(u), auth: new Headers(init?.headers).get('authorization') })
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const call = (path: string, h: HeadersInit = { 'sec-fetch-site': 'same-origin' }, method = 'GET') => proxy.default(new Request(site + '/across' + path, { headers: h, method }))
    ok((await call(buyPath)).status === 503 && seen.length === 0, 'without a key: 503, nothing forwarded (the site then asks Across directly)')
    env.ACROSS_API_KEY = 'test-key-not-real'
    env.ACROSS_INTEGRATOR_ID = '0x1a2b'
    const r = await call(buyPath)
    ok(r.status === 200 && r.headers.get('x-arcsense-across') === 'key', 'with a key: Across’s answer, marked as sent with the key')
    ok(seen[0]?.auth === 'Bearer test-key-not-real' && seen[0].url.startsWith('https://app.across.to/api/swap/approval?'), 'the key goes only in the Authorization header, to Across')
    ok(new URL(seen[0].url).searchParams.get('integratorId') === '0x1a2b' && new URL(seen[0].url).searchParams.get('appFeeRecipient') === FEE_WALLET, 'the integrator ID is added; the request is otherwise as asked')
    ok((await call(buyPath, { 'sec-fetch-site': 'cross-site' })).status === 403 && (await call(buyPath, undefined, 'POST')).status === 405 && seen.length === 1, 'other sites and other methods are refused, never forwarded')
  } finally {
    globalThis.fetch = realFetch
    delete g.Netlify
  }
}

if (process.argv.includes('--live')) {
  console.log('live (no wallet, nothing sent)')
  ok(await isStockToken(NVDA) && !(await isStockToken(MOW)), 'on-chain: NVDA is on Robinhood’s stock beacon, MOW isn’t')
  const info = await rhTokenInfo(MOW)
  ok(info?.symbol === 'MOW' && info.decimals === 18, 'reads a token on Robinhood Chain')
  const q = await getAcrossQuote({ ...buyReq, trader: FEE_WALLET })
  ok(q.minOut > 0n && q.fillSeconds > 0, `a fresh $5 MOW buy quote passes (≈${(Number(q.expectedOut) / 1e18).toFixed(2)} MOW, Across ${q.bridgeFeeUsd.toFixed(3)} USD)`)
  const qn = await getAcrossQuote({ ...buyReq, token: NVDA, trader: FEE_WALLET })
  ok(qn.minOut > 0n, `a $5 NVDA buy quote passes (≈${(Number(qn.expectedOut) / 1e18).toFixed(5)} NVDA)`)
  const qgl = await getAcrossQuote({ ...gasReq, trader: FEE_WALLET })
  ok(qgl.appFee === 0n, `a $0.50 gas quote passes (≈${(Number(qgl.expectedOut) / 1e18).toFixed(6)} ETH)`)
}

console.log('\nall Robinhood Chain checks passed')
