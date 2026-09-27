// Mercuri's and SolonPad's bonding curves — what the site
// (src/arcdex/api/curves.ts) and the market engine (engine/src/launchpads/)
// share: addresses, events, and reading a curve's trades from its logs.
// No dependencies, so it stays tiny in the browser bundle.
//
// ── Blockchain specifics (Arc mainnet, chain 5042) ────────────────────────
// Each launch deploys its own curve contract, announced by the factory:
//   Mercuri   LaunchFactory 0x8f5D…59EB (github.com/mercuri-finance/mercuri-launch-contracts, v1.0.0)
//     TokenCreated(address indexed token, address indexed curve, address indexed creator,
//                  address deployer, string name, string symbol, string metadataURI,
//                  bytes32 configHash, LaunchConfig config)
//     the curve: Buy(address indexed trader | usdcIn (net), tokensOut, fee, tax, realUsdc, sold)
//                Sell(address indexed trader | tokensIn, usdcOut (net), fee, realUsdc, sold)
//     Price after a trade = (virtualUsdc + realUsdc) / (virtualTokens − sold).
//   SolonPad  Pons V2 factory 0xd6b8…5A3b (github.com/solonlend/solonpad-skill)
//     TokenLaunched(address indexed token, address indexed curve, address indexed deployer,
//                   address pairToken, uint256 launchConfigId, uint256 graduationThreshold)
//     the curve: CurveBuy(address indexed buyer, address indexed recipient | quoteIn (gross), tokensOut, fee, tax)
//                CurveSell(address indexed seller, address indexed recipient | tokensIn, quoteOut (net), fee, tax)
// Amounts are native USDC (18 decimals) and 18-decimal tokens.
// Any contract can emit an event with the same signature: a curve is only
// trusted once its launchpad's factory names it (curveOf / getLaunchedToken).

export const MERCURI_FACTORY = '0x8f5dfa0c48e14ccd03ae01795b8a95759ba859eb'
export const MERCURI_FEE_MANAGER = '0x31d1bfe59b783f4c077f853f962d1355afb52580'
export const SOLONPAD_FACTORY = '0xd6b86b9b1bb64b941b21aaa6a0e3a673e8405a3b'

// ArcDexCurveRouter (contracts/ArcDexCurveRouter.sol, VERSION 1), deployed on
// Arc mainnet 2026-09-27 by the owner from /deploy/curve-router. Mercuri and
// SolonPad curve trades go through it and pay ARCDEX's fee.
export const CURVE_ROUTER = '0xf8e8c8e2159e5bb8af91fd342bfe5b9db7a06441'

/** The curve router in force, lower-cased, from VITE_ARCDEX_CURVE_ROUTER_ADDRESS:
 * an address overrides CURVE_ROUTER, `off` turns routing off ('': curve
 * trades then go to the curve directly, with no ARCDEX fee), and anything
 * else (unset, empty, not an address) keeps CURVE_ROUTER. */
export function curveRouterFrom(env: string | undefined): string {
  const v = (env ?? '').trim().toLowerCase()
  if (v === 'off') return ''
  return /^0x[0-9a-f]{40}$/.test(v) ? v : CURVE_ROUTER
}

// topic0 of each event (checked against the published sources in scripts/test-curves.ts)
export const MERCURI_TOKEN_CREATED = '0xd5059fc6aff1582502301b2f0e055effd0b2f5858717eaa699c7b23ec3c87676'
export const MERCURI_BUY = '0x2c5cc05b9a7b53e2478a9af1c94ec079b5be7c669be3df98ad86d28237f689e7'
export const MERCURI_SELL = '0x20a7fc03b19d7f251cc907f177ff82194c6aebe9a2b47e1cd734dcb6bf772cc2'
export const SOLON_TOKEN_LAUNCHED = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607'
export const SOLON_BUY = '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455'
export const SOLON_SELL = '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df'

// Function selectors the engine reads with.
export const SEL = {
  token: '0xfc0c546a',            // token()
  curveOf: '0x05adc47e',          // Mercuri factory curveOf(address)
  virtualUsdc: '0xe2c1936c',      // Mercuri curve virtualUsdc()
  virtualTokens: '0x1d3dad09',    // Mercuri curve virtualTokens()
  getLaunchedToken: '0x3cf28b5a', // SolonPad factory getLaunchedToken(address)
  getReserves: '0x0902f1ac',      // SolonPad curve getReserves()
} as const

export type CurveVenue = 'Mercuri' | 'SolonPad'

export interface CurveTrade {
  kind: 'buy' | 'sell'
  /** Mercuri's trader; SolonPad's recipient (who got the tokens or the USDC). */
  trader: string
  tokenAmount: number
  /** USDC paid in (buy, fees included) or received (sell, after fees). */
  usdc: number
  /** Price right after the trade (Mercuri, from the reserves in the event)
   * or the trade's own price on the curve, fees aside (SolonPad), USDC per token. */
  price: number
  /** Mercuri: the USDC the curve holds after the trade (its liquidity). */
  reserveUsdc: number | null
}

const w = (data: string, i: number) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64))
const addr = (topic: string) => ('0x' + topic.slice(26)).toLowerCase()

/** The venue whose trade event this log's topic0 is, if any (the emitter still needs verifying). */
export function curveVenueOfTopic(topic0: string | undefined): CurveVenue | null {
  return topic0 === MERCURI_BUY || topic0 === MERCURI_SELL ? 'Mercuri' : topic0 === SOLON_BUY || topic0 === SOLON_SELL ? 'SolonPad' : null
}

/** One of a curve's Buy/Sell logs, or null for any other log. Mercuri's
 * price needs the curve's virtual reserves (18 decimals). */
export function decodeCurveTrade(l: { topics: string[]; data: string }, venue: CurveVenue, virtual?: { usdc: bigint; tokens: bigint }): CurveTrade | null {
  const t0 = l.topics[0]
  if (venue === 'Mercuri') {
    const buy = t0 === MERCURI_BUY
    if ((!buy && t0 !== MERCURI_SELL) || l.topics.length < 2 || !virtual || l.data.length < 2 + 64 * (buy ? 6 : 5)) return null
    const tokens = buy ? w(l.data, 1) : w(l.data, 0)
    // What the trader paid (usdcIn + fee + tax) or received (usdcOut).
    const usdc = buy ? w(l.data, 0) + w(l.data, 2) + w(l.data, 3) : w(l.data, 1)
    const realUsdc = w(l.data, buy ? 4 : 3), sold = w(l.data, buy ? 5 : 4)
    const y = virtual.tokens - sold
    if (tokens === 0n || y <= 0n) return null
    return { kind: buy ? 'buy' : 'sell', trader: addr(l.topics[1]), tokenAmount: Number(tokens) / 1e18, usdc: Number(usdc) / 1e18, price: Number(virtual.usdc + realUsdc) / Number(y), reserveUsdc: Number(realUsdc) / 1e18 }
  }
  const buy = t0 === SOLON_BUY
  if ((!buy && t0 !== SOLON_SELL) || l.topics.length < 3 || l.data.length < 2 + 64 * 4) return null
  const [a, b, fee, tax] = [0, 1, 2, 3].map(i => w(l.data, i))
  const tokens = buy ? b : a
  if (tokens === 0n) return null
  // The curve's side of the trade, fees and taxes aside.
  const onCurve = buy ? a - fee - tax : b + fee + tax
  if (onCurve <= 0n) return null
  return { kind: buy ? 'buy' : 'sell', trader: addr(l.topics[2]), tokenAmount: Number(tokens) / 1e18, usdc: Number(buy ? a : b) / 1e18, price: Number(onCurve) / Number(tokens), reserveUsdc: null }
}

/** The log filter for one curve's trades. */
export function curveTradeFilter(curve: string, venue: CurveVenue) {
  return { address: curve.toLowerCase(), topics: [venue === 'Mercuri' ? [MERCURI_BUY, MERCURI_SELL] : [SOLON_BUY, SOLON_SELL]] }
}
