// Offline test of Portfolio's loader (lib/portfolio.ts): which coins it
// checks, what it keeps and how it prices them.
// Run: bun scripts/test-portfolio.ts
//
// Stubbed: the market list, the launchpad index, the router-trade index,
// Transfer logs, the multicall balances and GeckoTerminal.

// @ts-expect-error — Bun built-in module; bun-types isn't installed
import { mock } from 'bun:test'

const store = new Map<string, string>()
const g = globalThis as Record<string, unknown>
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }

const OWNER = '0x9999999999999999999999999999999999999999'
const USDC = '0x3600000000000000000000000000000000000000'
const A = (n: number) => ('0x' + String(n).repeat(40)).slice(0, 42)
const MARKET = A(1), CURVE = A(2), BOUGHT = A(3), SENT = A(4), NFT = A(5), EMPTY = A(6), ROUTED = A(7)

const bal: Record<string, bigint> = {
  [MARKET]: 2_000n * 10n ** 18n, [CURVE]: 5n * 10n ** 17n, [BOUGHT]: 10n ** 18n, [SENT]: 3n * 10n ** 6n, [NFT]: 1n, [EMPTY]: 0n, [ROUTED]: 4n * 10n ** 18n, [USDC]: 99n,
}
const decimals: Record<string, number | null> = { [MARKET]: 18, [CURVE]: 18, [BOUGHT]: 18, [SENT]: 6, [NFT]: null, [ROUTED]: 18 }
const checked = new Set<string>()

mock.module('../src/arcdex/wagmi', () => ({ MULTICALL3: '0xcA11bde05977b3631167028862bE2a173976CA11', arc: { id: 5042 } }))
mock.module('../src/arcdex/lib/tokenMeta', () => ({
  loadMarket: async () => [{ address: MARKET, symbol: 'MKT', name: 'Market', image: 'https://img/mkt.png', priceUsd: 0.01, pool: '0x' + 'ab'.repeat(32) }],
}))
mock.module('../src/arcdex/lib/launchpadCoins', () => ({ loadLaunchpadCoins: async () => new Set([CURVE, EMPTY]) }))
mock.module('../src/arcdex/api/social', () => ({ getTraderPositions: async () => [{ token: ROUTED }] }))
mock.module('../src/arcdex/lib/recentLogs', () => ({
  recentLogs: async () => [{ address: SENT.toUpperCase().replace('0X', '0x') }, { address: NFT }],
}))
mock.module('../src/arcdex/api/launchpad', () => ({
  client: {
    multicall: async ({ contracts }: { contracts: { address: string; functionName: string }[] }) => contracts.map(c => {
      const a = c.address.toLowerCase()
      if (c.functionName === 'balanceOf') { checked.add(a); return { status: 'success', result: bal[a] ?? 0n } }
      if (c.functionName === 'decimals') return decimals[a] == null ? { status: 'failure' } : { status: 'success', result: decimals[a] }
      if (c.functionName === 'symbol') return { status: 'success', result: 'S' + a.slice(2, 3) }
      if (c.functionName === 'name') return { status: 'success', result: 'Name ' + a.slice(2, 3) }
      return { status: 'failure' }
    }),
  },
  getLaunchpadToken: async (a: string) => a === CURVE ? { address: CURVE, symbol: 'CRV', name: 'Curve coin', priceUsd: 0.5, metadata: { image: 'https://img/crv.png' } } : null,
}))
mock.module('../src/arcdex/api/gtClient', () => ({
  gtGet: async (path: string) => ({
    data: path.includes(SENT) ? [{ attributes: { address: SENT, price_usd: '2', symbol: 'SNT', name: 'Sent coin', image_url: 'missing.png' } }] : [],
  }),
}))

const { loadHoldings, rememberHolding } = await import('../src/arcdex/lib/portfolio')
const ok = (c: unknown, m: string) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓', m) }

rememberHolding(OWNER, BOUGHT)
const h = await loadHoldings(OWNER as `0x${string}`)
const by = new Map(h.map(x => [x.address, x]))
console.log(h.map(x => `${x.symbol} ${x.balance} × $${x.priceUsd} = $${x.valueUsd}`).join('\n'))

ok(checked.has(BOUGHT), 'a coin bought in this browser is checked')
ok(checked.has(ROUTED), 'a coin traded through the router (index) is checked')
ok(checked.has(SENT), 'a token sent to the wallet (Transfer logs) is checked, whatever the case of its address')
ok(checked.has(CURVE) && checked.has(MARKET), 'launchpad and market-list coins are checked')
ok(!checked.has(USDC), 'USDC is cash, not a coin')
ok(!by.has(EMPTY as `0x${string}`), 'a zero balance is left out')
ok(!by.has(NFT as `0x${string}`), 'an NFT (no decimals) is left out')
ok(by.get(MARKET as `0x${string}`)?.valueUsd === 20 && by.get(MARKET as `0x${string}`)?.symbol === 'MKT', 'market coin: 2,000 × $0.01 = $20')
ok(by.get(CURVE as `0x${string}`)?.priceUsd === 0.5 && by.get(CURVE as `0x${string}`)?.launchpad === true && by.get(CURVE as `0x${string}`)?.valueUsd === 0.25, 'launchpad coin priced on its curve')
ok(by.get(SENT as `0x${string}`)?.balance === 3 && by.get(SENT as `0x${string}`)?.valueUsd === 6 && by.get(SENT as `0x${string}`)?.image === null, 'other token: its own decimals, GeckoTerminal price, no placeholder image')
ok(by.get(ROUTED as `0x${string}`)?.priceUsd === 0 && by.get(ROUTED as `0x${string}`)?.symbol === 'S7', 'unpriced coin kept, named from the chain')
ok(h[0].address === MARKET && h[h.length - 1].priceUsd === 0, 'most valuable first')
console.log('ALL PORTFOLIO CHECKS PASSED')
