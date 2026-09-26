// Offline test of round-3 pieces: the risk score (lib/risk.ts), decoding
// on-chain swaps into Terminal flashes (api/marketPulse.ts) and the fast
// receipt wait (lib/receipts.ts).
// Run: bun scripts/test-risk-pulse.ts

import { encodeAbiParameters } from 'viem'

const { riskOf, tokenRisk } = await import('../src/arcdex/lib/risk')
const { pulseOf } = await import('../src/arcdex/api/marketPulse')
const { waitForReceipt } = await import('../src/arcdex/lib/receipts')
const { ARC_RPC } = await import('../src/arcdex/lib/rpc')
const { RECENT_RPC } = await import('../api/_arcLogs')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }

console.log('risk score')
const H = 3_600_000, D = 24 * H
ok(riskOf({ honeypot: true, liquidityUsd: 1e6 }).score === 100, 'a honeypot is 100 (high) whatever else is true')
const healthy = riskOf({ liquidityUsd: 250_000, marketCapUsd: 2_000_000, ageMs: 40 * D, holders: 3_000, txns24h: 900, buys24h: 500, sells24h: 400, change24h: -4 })
ok(healthy.level === 'low' && healthy.score < 10, `deep, old, widely held coin: low (${healthy.score})`)
const fresh = riskOf({ liquidityUsd: 700, marketCapUsd: 120_000, ageMs: 10 * 60_000, holders: 6, txns24h: 3 })
ok(fresh.level === 'high' && fresh.score >= 60, `10-minute-old coin on $700 of liquidity, 6 holders: high (${fresh.score})`)
ok(fresh.factors[0].key.startsWith('Very thin liquidity'), 'its biggest reason comes first: very thin liquidity')
const mid = riskOf({ liquidityUsd: 3_000, marketCapUsd: 30_000, ageMs: 20 * 60_000, txns24h: 30 })
ok(mid.level === 'medium', `new coin with $3K liquidity: medium (${mid.score})`)
const onCurve = riskOf({ liquidityUsd: 3_000, marketCapUsd: 30_000, ageMs: 20 * 60_000, txns24h: 30, curve: true })
ok(onCurve.score < mid.score, `the same on a launchpad curve (liquidity can't be pulled) scores lower (${onCurve.score} < ${mid.score})`)
const fake = riskOf({ liquidityUsd: 250_000, marketCapUsd: 2_000_000, ageMs: 40 * D, holders: 3_000, txns24h: 900, copycat: 'USDT' })
ok(fake.score >= healthy.score + 25 && fake.factors.some(f => f.key.startsWith('Uses the')), 'a fake USDT gets +25 and says why')
const dumped = riskOf({ liquidityUsd: 500, marketCapUsd: 5_000, ageMs: 20 * D, txns24h: 0, change24h: -90 })
ok(dumped.level === 'high', `dead, dumped coin on $500 of liquidity: high (${dumped.score})`)
const withPage = riskOf({ liquidityUsd: 60_000, marketCapUsd: 600_000, ageMs: 3 * D, holders: 800, txns24h: 200, top10Pct: 62, devPct: 25, taxBps: 1_000 })
const noPage = riskOf({ liquidityUsd: 60_000, marketCapUsd: 600_000, ageMs: 3 * D, holders: 800, txns24h: 200 })
ok(withPage.score - noPage.score === 45, `a coin page's checks add up: top-10 62%, dev 25%, 10% tax (+45: ${noPage.score} → ${withPage.score})`)
ok(riskOf({ launchedAt: Date.now() - 30 * 60_000, liquidityUsd: 1e6, holders: 5_000, txns24h: 50 }).factors.some(f => f.key === 'Launched {age} ago' && f.vars?.age === '30m'), 'age from the launch time: "Launched 30m ago"')
ok(riskOf({ liquidityUsd: 1e6, holders: 5_000, txns24h: 50, ageMs: 90 * D }).factors.length === 0, 'nothing worth saying for a clean coin')
const row = tokenRisk({ address: '0x' + 'ab'.repeat(20), symbol: 'EURC', name: 'x', decimals: 18, logoUrl: '', price: 1, priceChange5m: 0, priceChange1h: 0, priceChange24h: 0, volume24h: 1_000, marketCap: 100_000, liquidity: 50_000, ageMs: 5 * D, launchpad: 'Argus', poolAddress: '', txCount24h: 40, holderCount: 300, buys24h: 20, sells24h: 20, verified: true, graduated: false, bondingProgress: null, spark: [], quoteSymbol: 'USDC' })
ok(row.factors.some(f => f.key.startsWith('Uses the') && f.vars?.sym === 'EURC'), 'a Terminal row reusing the EURC ticker is flagged as a copycat')

console.log('swaps → Terminal flashes')
const USDC = '0x3600000000000000000000000000000000000000'
const TOKEN = '0x' + 'c0'.repeat(20)
const POOL = '0x' + 'aa'.repeat(32)
const V3POOL = '0x' + 'bb'.repeat(20)
const lookup = {
  pool: (p: string) => (p === POOL || p === V3POOL ? { token: TOKEN, quote: USDC } : undefined),
  curve: (t: string) => t === TOKEN,
}
const w = (types: string[], vals: bigint[]) => encodeAbiParameters(types.map(type => ({ type })), vals)
const E18 = 10n ** 18n
// USDC (0x36…) < token (0xc0…): USDC is currency0. v4 amounts are the swapper's.
const v4 = (a0: bigint, a1: bigint, i = 0) => ({ address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', topics: ['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', POOL, '0x' + '00'.repeat(32)], data: w(['int256', 'int256', 'uint256', 'uint256', 'int256', 'uint256'], [a0, a1, 2n ** 96n, 10n ** 20n, 0n, 3000n]), blockNumber: '0x10', transactionHash: '0x' + (0x70 + i).toString(16).padStart(64, '0'), logIndex: '0x' + i.toString(16) })
const buy = pulseOf('v4', v4(-120_000_000n, 60_000n * E18), lookup)
ok(buy?.side === 'buy' && buy.token === TOKEN && Math.abs((buy.usd ?? 0) - 120) < 1e-9, 'v4: USDC in, tokens out → a $120 buy of that coin')
const sell = pulseOf('v4', v4(40_000_000n, -20_000n * E18, 1), lookup)
ok(sell?.side === 'sell' && Math.abs((sell.usd ?? 0) - 40) < 1e-9, 'v4: tokens in, USDC out → a $40 sell')
// v3 amounts are the pool's: the pool paying tokens out is a buy.
const v3log = { address: V3POOL, topics: ['0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', '0x' + '00'.repeat(32), '0x' + '00'.repeat(32)], data: w(['int256', 'int256', 'uint256', 'uint256', 'int256'], [5_000_000n, -2_500n * E18, 2n ** 96n, 10n ** 20n, 0n]), blockNumber: '0x10', transactionHash: '0x' + '81'.repeat(32), logIndex: '0x0' }
ok(pulseOf('v3', v3log, lookup)?.side === 'buy', 'v3: pool pays tokens out → a buy')
const curveLog = { address: '0xef6a8fdaf0181e19cc2c7575ada4b9c279809a67', topics: ['0x2c76e7a47fd53e2854856ac3f0a5f3ee40d15cfaa82266357ea9779c486ab9c3', '0x' + TOKEN.slice(2).padStart(64, '0'), '0x' + '73'.repeat(20).padStart(64, '0')], data: w(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'], [0n, 12_500_000n, 1_000n * E18, 0n, 0n, 0n]), blockNumber: '0x10', transactionHash: '0x' + '82'.repeat(32), logIndex: '0x0' }
const c = pulseOf('curve', curveLog, lookup)
ok(c?.side === 'sell' && c.usd === 12.5, 'launchpad Trade(isBuy=false) → a $12.50 sell')
ok(pulseOf('v4', { ...v4(-1n, 1n), topics: [v4(-1n, 1n).topics[0], '0x' + 'ee'.repeat(32)] }, lookup) === null, 'a pool the Terminal doesn\'t list is ignored')
ok(pulseOf('curve', { ...curveLog, topics: [curveLog.topics[0], '0x' + '11'.repeat(32), curveLog.topics[2]] }, lookup) === null, 'an unlisted launchpad coin is ignored')
ok(pulseOf('v4', { ...v4(-1n, 1n), removed: true }, lookup) === null, 'a log undone by a reorg is ignored')

console.log('fast receipts')
let calls: string[] = []
let publicHasIt = false
const receipt = { transactionHash: '0x' + '99'.repeat(32), status: '0x1', blockNumber: '0x20', blockHash: '0x' + '44'.repeat(32), transactionIndex: '0x0', from: '0x' + '11'.repeat(20), to: USDC, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [], logsBloom: '0x' + '00'.repeat(256), type: '0x2', contractAddress: null }
globalThis.fetch = (async (url: string) => {
  calls.push(url)
  // The public RPC's node is a block behind; Blockdaemon has it after ~300ms.
  const has = url === ARC_RPC ? publicHasIt : calls.filter(u => u === RECENT_RPC).length >= 2
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: has ? receipt : null }), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch
const t0 = Date.now()
const rc = await waitForReceipt(receipt.transactionHash as `0x${string}`)
const took = Date.now() - t0
ok(rc.status === 'success' && rc.blockNumber === 32n, 'returns the formatted receipt (status success, block 32)')
ok(took < 600, `found as soon as either endpoint has it (${took}ms), from the one that does`)
ok(calls.includes(ARC_RPC) && calls.includes(RECENT_RPC), 'asks both endpoints')
calls = []; publicHasIt = true
const t1 = Date.now()
await waitForReceipt(receipt.transactionHash as `0x${string}`)
ok(Date.now() - t1 < 100, 'already mined: answered on the first ask')
let hung = 0
globalThis.fetch = (async (url: string) => {
  if (url === RECENT_RPC) { hung++; return new Promise<Response>(() => {}) } // never answers
  calls.push(url)
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: calls.length >= 3 ? receipt : null }), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch
calls = []
const t2 = Date.now()
await waitForReceipt(receipt.transactionHash as `0x${string}`)
ok(Date.now() - t2 < 900 && hung === 1, `an endpoint that hangs is asked once, and doesn't slow the other (${Date.now() - t2}ms)`)
console.log('ALL RISK / PULSE / RECEIPT CHECKS PASSED')
process.exit(0)
