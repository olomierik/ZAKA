// Deploying ArcDexCurveRouter from the owner's own wallet, in the browser
// (pages/DeployCurveRouter.tsx, at /deploy/curve-router), and proving it
// works: no terminal, no Foundry, no private key in an environment variable.
//
//   simulate()      before deploying: a fresh router, built from exactly the
//                   code that gets deployed, trades Arc's live Mercuri and
//                   SolonPad curves inside one simulated call. Nothing is sent.
//   deployRouter()  the one transaction: the owner's wallet deploys it.
//   verifyRouter()  after: the code on-chain is the tested build, its settings
//                   read back as deployed, and the same simulated trades run
//                   through it.
//
// The simulations inject ArcDexCurveRouterSimHarness (contracts/test/sim/)
// at a scratch address with a 1,000 USDC balance, through an eth_call state
// override, as scripts/sim-curve-router.mjs does from a terminal. The code
// is lib/curveRouterBuild.ts, generated from `forge build`.

import { decodeErrorResult, decodeFunctionResult, encodeDeployData, encodeFunctionData, formatEther, getAddress, parseAbi, parseEther, type Abi, type Address, type Hash, type Hex } from 'viem'
import { deployContract } from 'wagmi/actions'
import { MERCURI_FACTORY, MERCURI_TOKEN_CREATED, SOLONPAD_FACTORY, SOLON_TOKEN_LAUNCHED, type CurveVenue } from '../../../api/_curves'
import { scanLogs, type RawLog } from '../../../api/_arcLogs'
import { client } from '../api/launchpad'
import { arc, USDC_ADDRESS, wagmiConfig } from '../wagmi'
import { FEE_WALLET } from './arcd'
import { HARNESS_ABI, HARNESS_RUNTIME, ROUTER_ABI, ROUTER_BYTECODE, ROUTER_IMMUTABLES, ROUTER_RUNTIME } from './curveRouterBuild'
import { t as T } from './i18n'
import { ensureArc, promptWallet } from './tx'
import { hideWalletPrompt } from './walletPrompt'

/** What every deployment gets. The owner is the wallet that deploys it. */
export const ROUTER_SETUP = {
  mercuriFactory: getAddress(MERCURI_FACTORY),
  solonFactory: getAddress(SOLONPAD_FACTORY),
  usdc: getAddress(USDC_ADDRESS),
  feeWallet: getAddress(FEE_WALLET),
  feeBps: 200n,
  referralShareBps: 1_500n,
  version: 1n,
} as const

/** Owns ArcDexSwapRouter and ArcLaunchpad (AGENTS.md). */
export const ARCDEX_DEPLOYER = '0x414B6Be4CF906739FbF7D49165beCa5F4CeEC3dA' as Address

export const routerArgs = (owner: Address) =>
  [ROUTER_SETUP.mercuriFactory, ROUTER_SETUP.solonFactory, ROUTER_SETUP.usdc, ROUTER_SETUP.feeWallet, owner] as const

/** One line of a report: passed (true), failed (false) or a note (null). */
export interface Check { ok: boolean | null; text: string }
export type Report = (c: Check) => void

/** A coin still trading on its launchpad's curve. */
export interface Coin { token: Address; curve: Address }
export type Coins = Partial<Record<CurveVenue, Coin | null>>

// ── Reading the curves ─────────────────────────────────────────────────

interface Venue { name: CurveVenue; factory: Address; deployBlock: number; launched: string }
const VENUES: Venue[] = [
  { name: 'Mercuri', factory: ROUTER_SETUP.mercuriFactory, deployBlock: 22_060_881, launched: MERCURI_TOKEN_CREATED },
  { name: 'SolonPad', factory: ROUTER_SETUP.solonFactory, deployBlock: 21_134_269, launched: SOLON_TOKEN_LAUNCHED },
]

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
const ZERO = /^0x0{40}$/i

/** The token's curve if it's still trading, with room left for a small buy. */
async function liveCurve(venue: Venue, token: Address, blockNumber: bigint): Promise<Address | null> {
  if (venue.name === 'Mercuri') {
    const curve = await client.readContract({ address: venue.factory, abi: MERCURI_ABI, functionName: 'curveOf', args: [token], blockNumber })
    if (ZERO.test(curve)) return null
    const [phase, progress] = await Promise.all([
      client.readContract({ address: curve, abi: MERCURI_ABI, functionName: 'phase', blockNumber }),
      client.readContract({ address: curve, abi: MERCURI_ABI, functionName: 'progressBps', blockNumber }),
    ])
    return phase === 0 && progress < 9_000n ? curve : null
  }
  const t = await client.readContract({ address: venue.factory, abi: SOLON_ABI, functionName: 'getLaunchedToken', args: [token], blockNumber }).catch(() => null)
  if (!t?.exists || !ZERO.test(t.pairToken)) return null // not SolonPad's, or quoted in another ERC-20
  const [graduated, real, threshold] = await Promise.all([
    client.readContract({ address: t.curve, abi: SOLON_ABI, functionName: 'graduated', blockNumber }),
    client.readContract({ address: t.curve, abi: SOLON_ABI, functionName: 'realQuoteReserve', blockNumber }),
    client.readContract({ address: t.curve, abi: SOLON_ABI, functionName: 'graduationThreshold', blockNumber }),
  ])
  return !graduated && real * 10n < threshold * 9n ? t.curve : null
}

const MAX_CANDIDATES = 200

/** The latest launch still on its curve, searching back from `head` to the
 * launchpad's first block (in growing spans); null if none is. */
async function findLiveCoin(venue: Venue, head: bigint): Promise<Coin | null> {
  const h = Number(head)
  let checked = 0
  let span = 100_000
  for (let to = h; to >= venue.deployBlock;) {
    const from = Math.max(venue.deployBlock, to - span + 1)
    const { scannedTo, parts } = await scanLogs({ address: venue.factory, topics: [venue.launched] }, from, to, { head: h, reduce: (logs: RawLog[]) => logs })
    if (scannedTo < to) throw new Error(T("Couldn't read {venue}'s launches: the network is busy. Try again.", { venue: venue.name }))
    for (const l of parts.flat().reverse()) {
      if (!l.topics[1]) continue
      if (++checked > MAX_CANDIDATES) return null
      const token = getAddress('0x' + l.topics[1].slice(26))
      const curve = await liveCurve(venue, token, head)
      if (curve) return { token, curve }
    }
    to = from - 1
    span *= 4
  }
  return null
}

// ── Simulated trades ───────────────────────────────────────────────────

const HARNESS = '0x00000000000000000000000000000000000c0de5' as Address
// Called by name, with the arguments built at run time.
const harnessAbi: Abi = HARNESS_ABI
const routerAbi: Abi = ROUTER_ABI
const FUNDS = parseEther('1000') // the harness's simulated balance
const VALUE = parseEther('5') // 5 USDC a buy
const REFERRER = '0x000000000000000000000000000000000000bEEF' as Address
const NO_REF = '0x0000000000000000000000000000000000000000' as Address

/** One trade's outcome, as the harness measured it. */
interface Traded {
  amountOut: bigint
  received: bigint
  spent: bigint
  feeWalletGain: bigint
  referrerGain: bigint
  routerLeftNative: bigint
  routerLeftTokens: bigint
  mercuriReferrerOfRouter: Address
}

/** The RPC ignored or refused the state override: nothing can be simulated. */
class NoOverride extends Error {}

async function harness(functionName: 'buy' | 'roundTrip' | 'buyVia' | 'roundTripVia', args: readonly unknown[], blockNumber: bigint): Promise<unknown> {
  const data = encodeFunctionData({ abi: harnessAbi, functionName, args })
  let res: { data?: Hex }
  try {
    res = await client.call({ to: HARNESS, data, gas: 30_000_000n, blockNumber, stateOverride: [{ address: HARNESS, code: HARNESS_RUNTIME, balance: FUNDS }] })
  } catch (e) {
    if (!revertData(e) && refusedOverride(e)) throw new NoOverride(why(e))
    throw e
  }
  // An empty answer: the call reached a plain address, so the harness wasn't injected.
  if (!res.data || res.data === '0x') throw new NoOverride('the RPC ignored the state override')
  return decodeFunctionResult({ abi: harnessAbi, functionName, data: res.data })
}

const usdc = (v: bigint) => `${Number(formatEther(v)).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC`
const amount = (v: bigint) => Number(formatEther(v)).toLocaleString('en-US', { maximumFractionDigits: 2 })
const pct = (bps: bigint) => `${Number(bps) / 100}%`
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

interface Fees { feeBps: bigint; referralShareBps: bigint; feeWallet: Address }

/** What's wrong with a simulated buy of `value`, in words; empty if nothing. */
function buyProblems(r: Traded, value: bigint, referred: boolean, f: Fees): string[] {
  const bad: string[] = []
  if (!(r.amountOut > 0n && r.amountOut === r.received)) bad.push(`received ${amount(r.received)} tokens, the router reported ${amount(r.amountOut)}`)
  if (r.spent !== value) bad.push(`paid ${usdc(r.spent)} instead of ${usdc(value)}`)
  const fee = (value * f.feeBps) / 10_000n
  const cut = referred ? (fee * f.referralShareBps) / 10_000n : 0n
  if (r.referrerGain !== cut) bad.push(`the referrer got ${usdc(r.referrerGain)} instead of ${usdc(cut)}`)
  if (r.feeWalletGain !== fee - cut) bad.push(`the fee wallet got ${usdc(r.feeWalletGain)} instead of ${usdc(fee - cut)}`)
  if (r.routerLeftNative !== 0n || r.routerLeftTokens !== 0n) bad.push('the router kept part of the trade')
  return bad
}

/** What's wrong with a simulated sale, in words; empty if nothing. */
function sellProblems(r: Traded, referred: boolean, f: Fees): string[] {
  const bad: string[] = []
  const fee = r.feeWalletGain + r.referrerGain
  if (!(r.received > 0n && r.amountOut === r.received)) bad.push(`received ${usdc(r.received)}, the router reported ${usdc(r.amountOut)}`)
  if (fee !== ((r.received + fee) * f.feeBps) / 10_000n) bad.push(`the fee was ${usdc(fee)} of the curve's ${usdc(r.received + fee)}, not ${pct(f.feeBps)}`)
  if (referred && r.referrerGain !== (fee * f.referralShareBps) / 10_000n) bad.push(`the referrer got ${usdc(r.referrerGain)} of the ${usdc(fee)} fee`)
  if (r.routerLeftNative !== 0n || r.routerLeftTokens !== 0n) bad.push('the router kept part of the trade')
  return bad
}

/** Tokens the curve itself gives for `spend`, bought directly (not through the router). */
async function directBuy(venue: CurveVenue, curve: Address, spend: bigint, blockNumber: bigint): Promise<bigint> {
  if (venue === 'Mercuri') {
    const [tokensOut] = await client.readContract({ address: curve, abi: MERCURI_ABI, functionName: 'quoteBuy', args: [spend], blockNumber })
    return tokensOut
  }
  // SolonPad has no quote view: simulate the buy from the harness's address (its snipe tax is the recipient's).
  const { result } = await client.simulateContract({
    address: curve, abi: SOLON_ABI, functionName: 'buy', args: [spend, 1n, HARNESS], value: spend, account: HARNESS,
    gas: 30_000_000n, blockNumber, stateOverride: [{ address: HARNESS, balance: FUNDS }],
  })
  return result
}

/** A report line from a list of problems: passed if there are none. */
const line = (text: string, bad: string[]): Check => ({ ok: bad.length === 0, text: bad.length ? `${text} ✗ ${bad.join('; ')}` : text })

interface TradeRun {
  /** The router to trade through; a fresh one (built from the tested code) if absent. */
  router?: Address
  fees: Fees
  /** Coins to trade, found by an earlier run; each venue's latest live coin otherwise. */
  coins?: Coins
  /** Whether Mercuri must name the fee wallet as the router's referrer (a fresh router). */
  fresh: boolean
  /** Simulate at this block or later: the block a router was just deployed in. */
  atBlock?: bigint
}

/** Buys, then a referred round trip, on each venue's live coin. Returns the coins traded, or null when the RPC can't simulate. */
async function tradeChecks(run: TradeRun, report: Report): Promise<{ coins: Coins; failed: boolean } | null> {
  // A block every node has (the head can be one ahead of some), but never
  // one before the router's own deployment.
  const head = (await client.getBlockNumber()) - 1n
  const blockNumber = run.atBlock && run.atBlock > head ? run.atBlock : head
  const coins: Coins = {}
  let failed = false
  let tested = 0
  for (const venue of VENUES) {
    const mercuri = venue.name === 'Mercuri'
    let coin = run.coins?.[venue.name]
    if (coin === undefined) {
      try { coin = await findLiveCoin(venue, blockNumber) } catch (e) { report({ ok: false, text: why(e) }); failed = true; continue }
    } else if (coin && !(await liveCurve(venue, coin.token, blockNumber))) {
      coin = await findLiveCoin(venue, blockNumber).catch(() => null) // it graduated since
    }
    coins[venue.name] = coin ?? null
    if (!coin) { report({ ok: null, text: T('{venue}: no coin is on its curve right now, so its trades were not simulated.', { venue: venue.name }) }); continue }
    const found: Check = { ok: true, text: T('{venue}: trading {coin} on its curve', { venue: venue.name, coin: shortAddress(coin.token) }) }

    try {
      const args = [mercuri, coin.token, VALUE, NO_REF]
      // The coin is reported with its first trade, so an RPC that can't simulate leaves no half-report.
      const r = (await harness(run.router ? 'buyVia' : 'buy', run.router ? [run.router, ...args] : args, blockNumber)
        .catch((e: unknown) => { if (!(e instanceof NoOverride)) report(found); throw e })) as Traded
      report(found)
      const bad = buyProblems(r, VALUE, false, run.fees)
      const direct = await directBuy(venue.name, coin.curve, VALUE - (VALUE * run.fees.feeBps) / 10_000n, blockNumber)
      if (r.received !== direct) bad.push(`got ${amount(r.received)} tokens, buying the rest directly gets ${amount(direct)}`)
      if (mercuri && run.fresh && r.mercuriReferrerOfRouter.toLowerCase() !== run.fees.feeWallet.toLowerCase()) bad.push(`Mercuri names ${r.mercuriReferrerOfRouter} as the router's referrer, not the fee wallet`)
      const c = line(T('Buy {value} through the router: exactly {fee} to the fee wallet, and the rest bought {tokens} tokens, as many as buying on the curve directly', { value: usdc(VALUE), tokens: amount(r.received), fee: pct(run.fees.feeBps) }), bad)
      report(c)
      failed ||= !c.ok

      const [bought, sold] = (await harness(run.router ? 'roundTripVia' : 'roundTrip', run.router ? [run.router, mercuri, coin.token, VALUE, REFERRER] : [mercuri, coin.token, VALUE, REFERRER], blockNumber)) as [Traded, Traded]
      const rt = line(T('Referred buy, then sell it all back: {share} of each fee to the referrer, the rest to the fee wallet, nothing left in the router', { share: pct(run.fees.referralShareBps) }), [...buyProblems(bought, VALUE, true, run.fees), ...sellProblems(sold, true, run.fees)])
      report(rt)
      failed ||= !rt.ok
      tested++
    } catch (e) {
      if (e instanceof NoOverride) return null
      report({ ok: false, text: `${venue.name}: ${why(e)}` })
      failed = true
    }
  }
  if (tested === 0 && !failed) { report({ ok: false, text: T('No coin is on a Mercuri or SolonPad curve right now: nothing could be simulated.') }); failed = true }
  return { coins, failed }
}

export interface SimOutcome {
  /** false: the RPC couldn't simulate (no state overrides), so nothing ran. */
  ran: boolean
  passed: boolean
  coins: Coins
}

/** Before deploying: a fresh router, built from the code that gets
 * deployed, trades each launchpad's live coin in a simulated call. */
export async function simulate(report: Report): Promise<SimOutcome> {
  const fees = { feeBps: ROUTER_SETUP.feeBps, referralShareBps: ROUTER_SETUP.referralShareBps, feeWallet: ROUTER_SETUP.feeWallet }
  const r = await tradeChecks({ fees, fresh: true }, report)
  if (!r) {
    report({ ok: null, text: T("This network's RPC can't run the simulation (it doesn't take state overrides). You can still deploy: the checks after deploying compare its code with the tested build.") })
    return { ran: false, passed: false, coins: {} }
  }
  return { ran: true, passed: !r.failed, coins: r.coins }
}

// ── Deploying ──────────────────────────────────────────────────────────

export interface DeployCost { gas: bigint; cost: bigint; balance: bigint }

/** What deploying from `owner` should cost, and what the wallet holds (native USDC, 18 decimals). */
export async function deployCost(owner: Address): Promise<DeployCost> {
  const data = encodeDeployData({ abi: ROUTER_ABI, bytecode: ROUTER_BYTECODE, args: routerArgs(owner) })
  const [gas, gasPrice, balance] = await Promise.all([
    client.estimateGas({ account: owner, data }),
    client.getGasPrice(),
    client.getBalance({ address: owner }),
  ])
  return { gas, cost: gas * gasPrice, balance }
}

/** Deploys the router from the connected external wallet (the owner). */
export async function deployRouter(owner: Address): Promise<Hash> {
  await ensureArc()
  const prompted = await promptWallet()
  try {
    return await deployContract(wagmiConfig, { abi: ROUTER_ABI, bytecode: ROUTER_BYTECODE, args: routerArgs(owner), account: owner, chainId: arc.id })
  } finally {
    if (prompted) hideWalletPrompt()
  }
}

// ── Verifying a deployed router ───────────────────────────────────────

/** `code` with zeros where the immutables go, as in the build. */
function maskImmutables(code: string): string {
  let out = code.toLowerCase()
  for (const [start, length] of ROUTER_IMMUTABLES) {
    const a = 2 + start * 2
    out = out.slice(0, a) + '0'.repeat(length * 2) + out.slice(a + length * 2)
  }
  return out
}
const noMetadata = (code: string) => code.replace(/a264697066735822[0-9a-f]{68}64736f6c6343[0-9a-f]{6}0033$/, '')

/** Whether the code at an address is the tested build. */
function codeMatch(code: string): 'exact' | 'metadata' | 'different' {
  if (code.length !== ROUTER_RUNTIME.length) return 'different'
  const deployed = maskImmutables(code)
  const tested = ROUTER_RUNTIME.toLowerCase()
  if (deployed === tested) return 'exact'
  return noMetadata(deployed) === noMetadata(tested) ? 'metadata' : 'different'
}

export interface Verified {
  passed: boolean
  owner: Address | null
  coins: Coins
}

/** Checks the router at `address`: its code, its settings, and simulated
 * trades through it. `owner` is who should own it (the deploying wallet). */
export async function verifyRouter(address: Address, report: Report, opts: { owner?: Address; coins?: Coins; fresh?: boolean; atBlock?: bigint } = {}): Promise<Verified> {
  let failed = false
  const fail = (text: string) => { report({ ok: false, text }); failed = true }

  // Right after deploying, a node that trails by a block may not have the code yet.
  let code: Hex | undefined
  for (let i = 0; i < (opts.fresh ? 12 : 1); i++) {
    if (i) await new Promise(r => setTimeout(r, 500))
    code = await client.getCode({ address })
    if (code && code !== '0x') break
  }
  if (!code || code === '0x') { fail(T('There is no contract at {address}.', { address })); return { passed: false, owner: null, coins: {} } }
  const match = codeMatch(code)
  if (match === 'different') { fail(T("The contract at this address isn't ArcDexCurveRouter v1 as tested.")); return { passed: false, owner: null, coins: {} } }
  report({ ok: true, text: match === 'exact' ? T('Its code is ArcDexCurveRouter v1, byte for byte as tested') : T('Its code is ArcDexCurveRouter v1 as tested (only the compiler metadata differs)') })

  const read = <R>(functionName: string) => client.readContract({ address, abi: routerAbi, functionName }) as Promise<R>
  const [owner, feeWallet, feeBps, referralShareBps, paused, version, mercuriFactory, solonFactory, usdcToken] = await Promise.all([
    read<Address>('owner'), read<Address>('feeWallet'), read<bigint>('feeBps'), read<bigint>('referralShareBps'), read<boolean>('paused'),
    read<bigint>('VERSION'), read<Address>('mercuriFactory'), read<Address>('solonFactory'), read<Address>('usdc'),
  ])
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

  if (opts.owner && !same(owner, opts.owner)) fail(T('Its owner is {owner}, not your wallet.', { owner }))
  else report({ ok: opts.owner ? true : null, text: opts.owner ? T('Owned by your wallet, {owner}', { owner }) : T('Owned by {owner}', { owner }) })

  if (same(feeWallet, ROUTER_SETUP.feeWallet)) report({ ok: true, text: T("Fees go to ARCDEX's fee wallet, {wallet}", { wallet: feeWallet }) })
  else fail(T("Fees go to {wallet}, not ARCDEX's fee wallet {expected}.", { wallet: feeWallet, expected: ROUTER_SETUP.feeWallet }))

  const settingsOk = feeBps === ROUTER_SETUP.feeBps && referralShareBps === ROUTER_SETUP.referralShareBps && !paused && version === ROUTER_SETUP.version
  const settings = T('Fee {fee} of each trade, {share} of it to the referrer; {state}', { fee: pct(feeBps), share: pct(referralShareBps), state: paused ? T('paused') : T('open for trading') })
  if (settingsOk) report({ ok: true, text: settings })
  else fail(settings)

  if (same(mercuriFactory, ROUTER_SETUP.mercuriFactory) && same(solonFactory, ROUTER_SETUP.solonFactory) && same(usdcToken, ROUTER_SETUP.usdc)) {
    report({ ok: true, text: T('Trades coins of the Mercuri factory {mercuri} and the SolonPad factory {solon}', { mercuri: shortAddress(mercuriFactory), solon: shortAddress(solonFactory) }) })
  } else {
    fail(`factories ${mercuriFactory} / ${solonFactory}, USDC ${usdcToken}: not the ones ARCDEX deploys with`)
  }

  const trades = await tradeChecks({ router: address, fees: { feeBps, referralShareBps, feeWallet }, coins: opts.coins, fresh: !!opts.fresh, atBlock: opts.atBlock }, report)
  if (!trades) report({ ok: null, text: T("This network's RPC can't simulate trades (no state overrides), so they were skipped.") })
  else failed ||= trades.failed
  return { passed: !failed, owner, coins: trades?.coins ?? {} }
}

// ── Errors, in words ───────────────────────────────────────────────────

// Every error the router and the two curves revert with.
const CURVE_ERRORS = parseAbi([
  // Mercuri's BondingCurve (v1.0.0)
  'error Expired()', 'error NotTrading()', 'error NotPending()', 'error Slippage()', 'error Unauthorized()',
  'error InitialBuyTooLarge()', 'error TransferFailed()', 'error InsufficientGasForGraduation()',
  // SolonPad's Pons V2 curve
  'error AlreadyGraduated()', 'error CurveGraduated()', 'error InsufficientInputAmount()', 'error InsufficientLiquidity()',
  'error InsufficientOutputAmount()', 'error InternalSwapRequiresOperator()', 'error MinimumOutputRequired()',
  'error NativeValueMismatch(uint256 supplied, uint256 expected)', 'error NotInitialized()',
  'error SlippageExceeded(uint256 actual, uint256 minimum)', 'error UnexpectedNativeValue()',
])
const ROUTER_ERRORS = routerAbi.filter(x => x.type === 'error')
const ERRORS = [...ROUTER_ERRORS, ...CURVE_ERRORS.filter(e => !ROUTER_ERRORS.some(r => 'name' in r && r.name === e.name))] as Abi

type ErrLike = { message?: unknown; shortMessage?: unknown; details?: unknown; data?: unknown; cause?: unknown }

/** Whether the RPC refused the state override itself (rather than the call reverting). */
function refusedOverride(e: unknown): boolean {
  for (let c = e as ErrLike | undefined, i = 0; c && typeof c === 'object' && i < 6; c = c.cause as ErrLike | undefined, i++) {
    if ((c as { code?: unknown }).code === -32602) return true // invalid params
    // Only the node's own words: viem's message repeats the call's arguments, the override included.
    if (typeof c.details === 'string' && /override|unknown (field|param)|too many (params|arguments)|not supported|unsupported/i.test(c.details)) return true
  }
  return false
}

function revertData(e: unknown): Hex | null {
  for (let c = e as ErrLike | undefined, i = 0; c && typeof c === 'object' && i < 6; c = c.cause as ErrLike | undefined, i++) {
    const d = c.data
    const data = typeof d === 'string' ? d : d && typeof d === 'object' && typeof (d as { data?: unknown }).data === 'string' ? (d as { data: string }).data : null
    if (data?.startsWith('0x') && data.length >= 10) return data as Hex
  }
  return null
}

/** What went wrong, in words: the revert's error when it's a known one. */
export function why(e: unknown): string {
  const data = revertData(e)
  if (data) {
    try {
      const d = decodeErrorResult({ abi: ERRORS, data })
      return `reverted with ${d.errorName}(${(d.args ?? []).map(String).join(', ')})`
    } catch { return `reverted with unknown error ${data.slice(0, 10)}` }
  }
  const x = e as ErrLike | undefined
  const m = typeof x?.shortMessage === 'string' ? x.shortMessage : typeof x?.message === 'string' ? x.message : String(e)
  return m.split('\n')[0].slice(0, 300)
}
