// Simulates ArcDexCurveRouter against Arc mainnet's real node — real Mercuri
// and SolonPad bonding curves, real native USDC — without broadcasting
// anything. The harness (contracts/test/sim/ArcDexCurveRouterSimHarness.sol)
// is injected with a state override and trades through a freshly deployed
// router inside one simulated call; see ArcDexRouterSimHarness.sol for why
// this isn't a Foundry fork test.
//
//   forge build && node scripts/sim-curve-router.mjs
//
// It trades the latest launch on each launchpad that's still on its curve,
// or the coins you name: MERCURI_TOKEN=0x… SOLON_TOKEN=0x… node scripts/sim-curve-router.mjs
import { readFileSync } from 'node:fs'
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, parseAbi, parseEther, formatEther } from 'viem'

const RPC = process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io'
const client = createPublicClient({ transport: http(RPC, { retryCount: 6, retryDelay: 1500 }) })

const OUT = process.env.FORGE_OUT ?? 'contracts/out' // where forge build wrote its artifacts
const artifact = JSON.parse(readFileSync(`${OUT}/ArcDexCurveRouterSimHarness.sol/ArcDexCurveRouterSimHarness.json`, 'utf8'))
const abi = artifact.abi
const code = artifact.deployedBytecode.object
const HARNESS = '0x00000000000000000000000000000000000c0de5'
const FUNDS = parseEther('1000') // native balance override = 1,000 USDC

const FEE_WALLET = '0x274262A0321A0701b0A46a3576e07aE881c286Bb'
const NO_REF = '0x0000000000000000000000000000000000000000'
const REFERRER = '0x000000000000000000000000000000000000bEEF'
const FEE = 200n // bps
const REF_SHARE = 1_500n // bps of the fee
const VALUE = parseEther('5') // 5 USDC a buy

// The launchpads (api/_curves.ts has the same addresses and topics).
const MERCURI = {
  name: 'Mercuri',
  env: 'MERCURI_TOKEN',
  factory: '0x8f5DfA0c48E14cCD03AE01795B8a95759BA859EB',
  deployBlock: 22_060_881n,
  launched: '0xd5059fc6aff1582502301b2f0e055effd0b2f5858717eaa699c7b23ec3c87676', // TokenCreated
}
const SOLON = {
  name: 'SolonPad',
  env: 'SOLON_TOKEN',
  factory: '0xd6b86b9B1bB64b941b21AaA6a0e3A673e8405A3b',
  deployBlock: 21_134_269n,
  launched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607', // TokenLaunched
}
const MERCURI_ABI = parseAbi([
  'function curveOf(address token) view returns (address)',
  'function phase() view returns (uint8)',
  'function progressBps() view returns (uint256)',
  'function quoteBuy(uint256 usdcIn) view returns (uint256 tokensOut, uint256 usdcUsed, uint256 fee, uint256 tax)',
])
const SOLON_ABI = parseAbi([
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
  'function graduated() view returns (bool)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
])

const ZERO = /^0x0{40}$/
const hex = n => '0x' + n.toString(16)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const usdc = v => `${formatEther(v)} USDC`

let failures = 0
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.log(`  ✗ ${msg}`) } }

async function run(name, fn) {
  console.log(`\n${name}`)
  try { await fn() } catch (e) { failures++; console.log(`  ✗ reverted: ${e.shortMessage ?? e.message}`.slice(0, 400)) }
  await sleep(1200) // stay under the public RPC's rate limit
}

async function sim(functionName, args, blockNumber) {
  const data = encodeFunctionData({ abi, functionName, args })
  const res = await client.call({ to: HARNESS, data, gas: 30_000_000n, blockNumber, stateOverride: [{ address: HARNESS, code, balance: FUNDS }] })
  return decodeFunctionResult({ abi, functionName, data: res.data })
}

/** The token's curve if it's still trading, with room left for a small buy. */
async function liveCurve(venue, token, blockNumber) {
  if (venue === MERCURI) {
    const curve = await client.readContract({ address: MERCURI.factory, abi: MERCURI_ABI, functionName: 'curveOf', args: [token], blockNumber })
    if (ZERO.test(curve)) return null
    const [phase, progress] = await Promise.all([
      client.readContract({ address: curve, abi: MERCURI_ABI, functionName: 'phase', blockNumber }),
      client.readContract({ address: curve, abi: MERCURI_ABI, functionName: 'progressBps', blockNumber }),
    ])
    return phase === 0 && progress < 9_000n ? curve : null
  }
  const t = await client.readContract({ address: SOLON.factory, abi: SOLON_ABI, functionName: 'getLaunchedToken', args: [token], blockNumber }).catch(() => null)
  if (!t?.exists || !ZERO.test(t.pairToken)) return null // not SolonPad's, or quoted in another ERC-20
  const [graduated, real, threshold] = await Promise.all([
    client.readContract({ address: t.curve, abi: SOLON_ABI, functionName: 'graduated', blockNumber }),
    client.readContract({ address: t.curve, abi: SOLON_ABI, functionName: 'realQuoteReserve', blockNumber }),
    client.readContract({ address: t.curve, abi: SOLON_ABI, functionName: 'graduationThreshold', blockNumber }),
  ])
  return !graduated && real * 10n < threshold * 9n ? t.curve : null
}

/** The latest launch still on its curve, scanning back up to ~3 days of blocks. */
async function findLaunch(venue, blockNumber) {
  const WINDOW = 9_000n // Arc's node rejects getLogs ranges of 10,000+ blocks
  for (let to = blockNumber, i = 0; to >= venue.deployBlock && i < 60; to -= WINDOW, i++) {
    const from = to - WINDOW + 1n > venue.deployBlock ? to - WINDOW + 1n : venue.deployBlock
    const logs = await client.request({ method: 'eth_getLogs', params: [{ address: venue.factory, topics: [venue.launched], fromBlock: hex(from), toBlock: hex(to) }] })
    for (const l of logs.reverse()) {
      const token = ('0x' + l.topics[1].slice(26)).toLowerCase()
      const curve = await liveCurve(venue, token, blockNumber)
      if (curve) return { token, curve }
    }
    await sleep(250)
  }
  return null
}

/** Tokens the curve itself gives for `spend` at this block, bought directly (not through the router). */
async function directBuy(venue, curve, spend, blockNumber) {
  if (venue === MERCURI) {
    const [tokensOut] = await client.readContract({ address: curve, abi: MERCURI_ABI, functionName: 'quoteBuy', args: [spend], blockNumber })
    return tokensOut
  }
  // SolonPad has no quote view: simulate the buy from the harness's address (its snipe tax is the recipient's).
  const data = encodeFunctionData({ abi: SOLON_ABI, functionName: 'buy', args: [spend, 1n, HARNESS] })
  const res = await client.call({ account: HARNESS, to: curve, data, value: spend, gas: 30_000_000n, blockNumber, stateOverride: [{ address: HARNESS, balance: FUNDS }] })
  return decodeFunctionResult({ abi: SOLON_ABI, functionName: 'buy', data: res.data })
}

function checkBuy(label, r, value, referred) {
  console.log(`  ${label}: tokens=${formatEther(r.received)} paid=${usdc(r.spent)} feeWallet=${usdc(r.feeWalletGain)} referrer=${usdc(r.referrerGain)}`)
  check(r.amountOut > 0n && r.amountOut === r.received, 'tokens received, as the router reported')
  check(r.spent === value, `paid exactly ${usdc(value)} (a small buy gets no refund)`)
  const fee = (value * FEE) / 10_000n
  if (referred) {
    const cut = (fee * REF_SHARE) / 10_000n
    check(r.referrerGain === cut, `referrer got 15% of the 2% fee (${usdc(cut)})`)
    check(r.feeWalletGain === fee - cut, `fee wallet got the other 85% (${usdc(fee - cut)})`)
  } else {
    check(r.feeWalletGain === fee, `fee wallet got exactly 2% (${usdc(fee)})`)
  }
  check(r.routerLeftNative === 0n && r.routerLeftTokens === 0n, 'router holds nothing afterwards')
}

function checkSell(label, r, referred) {
  const fee = r.feeWalletGain + r.referrerGain
  console.log(`  ${label}: received=${usdc(r.received)} feeWallet=${usdc(r.feeWalletGain)} referrer=${usdc(r.referrerGain)}`)
  check(r.received > 0n && r.amountOut === r.received, 'USDC received, as the router reported')
  check(fee === ((r.received + fee) * FEE) / 10_000n, "fee is exactly 2% of the curve's proceeds")
  if (referred) check(r.referrerGain > 0n && r.referrerGain === (fee * REF_SHARE) / 10_000n, 'referrer bound on the buy still earns 15% on a sell that named no one')
  check(r.routerLeftNative === 0n && r.routerLeftTokens === 0n, 'router holds nothing afterwards')
}

const blockNumber = await client.getBlockNumber()
console.log(`block ${blockNumber} via ${RPC}`)

for (const venue of [MERCURI, SOLON]) {
  const mercuri = venue === MERCURI
  let launch = null
  await run(`${venue.name}: a coin still on its curve`, async () => {
    const named = process.env[venue.env]?.trim().toLowerCase()
    launch = named ? { token: named, curve: await liveCurve(venue, named, blockNumber) } : await findLaunch(venue, blockNumber)
    check(!!launch?.curve, launch?.curve ? `${launch.token} (curve ${launch.curve})` : `none found — name one with ${venue.env}=0x…`)
  })
  if (!launch?.curve) continue

  await run(`${venue.name}: buy ${usdc(VALUE)} through the router`, async () => {
    const r = await sim('buy', [mercuri, launch.token, VALUE, NO_REF], blockNumber)
    checkBuy('buy', r, VALUE, false)
    const spend = VALUE - (VALUE * FEE) / 10_000n
    const direct = await directBuy(venue, launch.curve, spend, blockNumber)
    check(r.received === direct, `exactly the tokens the curve gives for the other 98% directly (${formatEther(direct)})`)
    if (mercuri) check(r.mercuriReferrerOfRouter.toLowerCase() === FEE_WALLET.toLowerCase(), "Mercuri's FeeManager now names ARCDEX's fee wallet as the router's referrer")
  })

  await run(`${venue.name}: referred round trip — buy ${usdc(VALUE)}, sell it all back`, async () => {
    const [bought, sold] = await sim('roundTrip', [mercuri, launch.token, VALUE, REFERRER], blockNumber)
    checkBuy('buy', bought, VALUE, true)
    checkSell('sell', sold, true)
  })
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
