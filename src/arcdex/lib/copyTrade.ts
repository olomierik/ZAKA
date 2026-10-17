// Copy trading from the user's own wallet (owner, 2026-10-17: "copy trading from the user's own wallet"): while ARCDEX is
// open, the built-in trading wallet copies the Arc trades of the wallets it follows, under the follower's rules. Nothing
// is custodial: the trading wallet is the user's (its key lives in this browser), and ARCDEX never holds the funds. With
// every ARCDEX tab closed nothing is copied.
//
// A leader's trade arrives on the wallet tracker's live channel (lib/walletTracker.ts) with its coin and pool. A buy is
// copied in the same pool: through ArcDexSwapRouter (v4 or v3 pools against USDC or ARGUS), or through Uniswap's
// Universal Router for a native-USDC v4 pool, with ARCDEX's fee taken in the same transaction as the swap widget takes
// it. It's sized by the rule (a fixed amount, or the leader's own size up to the rule's most), never past the day's
// budget or what the wallet can spend after gas. Coins still on a launchpad's own curve aren't copied. Before anything
// is signed:
//   • the trade switch (lib/tradeSwitch.ts) and the walletCopy flag;
//   • the leader's trade is fresh (under a minute old);
//   • the coin's safety rating as the Trenches show it (lib/safety.ts): the engine's scan where it has one, else the
//     coin's market data. Danger never; Safe only under "Safe coins only"; a coin with neither isn't copied;
//   • the swap simulated with the exact amount (as though the exact approval had landed, lib/fastBuy.ts), and its price,
//     ARCDEX's fee aside, no worse than the leader's by more than the rule's slippage; the minimum received is set from it.
// A leader's sale sells the same share of the coins copied from that leader (the share of its holding it sold), never
// coins that came from elsewhere. Every copy, skip and failure is logged with why.

import { encodeFunctionData, erc20Abi, formatUnits, parseUnits, type Address, type Hex } from 'viem'
import { client } from '../api/launchpad'
import { argusPoolToArcToken, buildSwapRoute, cachedArgusMarket, copycatOf, type SwapRoute } from '../api/argusMarket'
import { engineApiUrl, getEngineToken } from '../api/marketStream'
import { encodeNativeBuy, encodeNativeSell, feeShares, netAfterFees, permit2Allowance, quoteExactIn, universalRouter, PERMIT2, PERMIT2_ABI, UR_ABI, type FeeShare } from '../api/universalRouter'
import type { CoinSafety } from '../../../api/_marketProtocol'
import type { WalletTradeWire } from '../../../api/_trenchProtocol'
import { ARC_USDC } from './acrossQuote'
import { SWAP_ROUTER_ADDRESS, loadRouterInfo, routerConfigured, type RouterInfo } from './routerInfo'
import { ROUTER_FEES, routerCall } from './routerCalls'
import { gasWithAllowance, usdcAllowanceOverride } from './fastBuy'
import { sendArc } from './tx'
import { waitForReceipt } from './receipts'
import { waitForAllowance } from './rpc'
import { referrerFor } from './referral'
import { assertTradingOn } from './tradeSwitch'
import { arcSafety, type SafetyLevel } from './safety'
import { riskOf, tokenRisk, type Risk } from './risk'
import { arcStageInput } from './coinStage'
import { N_ } from './i18n'
import { rememberHolding } from './held'
import { notifyBalances } from './balances'
import { arc } from '../wagmi'
import { COPY, getCopySettings, getLots, logEvent, setLots, spentToday, type CopyEvent, type CopyRule, type CopySettings } from './copySettings'
export * from './copySettings'

const USDC = ARC_USDC as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address

// ── decisions (pure, tested in scripts/test-copy-trade.ts) ────────────────

/** Why a copy was skipped: an English key for t(), with its numbers apart, so the log reads in the viewer's language. */
export interface Why { why: string; whyVars?: Record<string, string | number> }
export type Plan = { usd: number } | Why

/** How much a leader's buy is copied with, or why not. */
export function planBuy(o: { rule: CopyRule; settings: Pick<CopySettings, 'on' | 'dailyCapUsd'>; spentTodayUsd: number; cashUsd: number; leaderUsd: number; ageMs: number }): Plan {
  if (!o.settings.on) return { why: N_('copying is off') }
  if (!o.rule.on) return { why: N_('this leader is paused') }
  if (o.ageMs > COPY.staleMs) return { why: N_('the leader’s trade reached ARCDEX {s}s late'), whyVars: { s: Math.round(o.ageMs / 1000) } }
  const want = o.rule.sizing === 'match' ? Math.min(o.leaderUsd, o.rule.maxUsd) : o.rule.maxUsd
  const left = o.settings.dailyCapUsd - o.spentTodayUsd
  const spendable = o.cashUsd - COPY.gasReserveUsd
  const usd = Math.floor(Math.min(want, left, spendable) * 100) / 100
  if (usd < COPY.minUsd) {
    if (left < COPY.minUsd) return { why: N_('the day’s budget is spent') }
    if (spendable < COPY.minUsd) return { why: N_('not enough USDC in the trading wallet') }
    return { why: N_('under the ${n} minimum'), whyVars: { n: COPY.minUsd } }
  }
  return { usd }
}

/** Whether a coin rated `level` may be copied under `rule`, or why not. */
export function safetyAllows(level: SafetyLevel | 'unrated', rule: CopyRule): string | null {
  if (level === 'danger') return N_('the coin is rated Danger')
  if (level === 'checking' || level === 'unrated') return N_('the coin hasn’t been safety-checked yet')
  if (rule.safety === 'safe-only' && level !== 'safe') return N_('the coin is rated Risky (this leader copies Safe coins only)')
  return null
}

/** Whether a copy's price is close enough to the leader's, in dollars per coin: `ours` is what the copy pays all in,
 * `theirs` the leader's price at the pool (the engine reads trades from the pool's own swap). ARCDEX's fee (`feeBps`)
 * comes off ours first, so the fee every copy pays never counts as slippage. */
export function priceAllows(ours: number, theirs: number, slippagePct: number, feeBps = 0): Why | null {
  if (!(ours > 0) || !(theirs > 0)) return null
  const worse = ((ours * (1 - feeBps / 10_000)) / theirs - 1) * 100
  return worse > slippagePct ? { why: N_('the price is {pct}% worse than the leader’s'), whyVars: { pct: worse.toFixed(1) } } : null
}

/** How many of the copied coins a leader's sale sells: the share of its holding it sold (all of them once it's sold out). */
export function sellAmount(lot: bigint, leaderSold: bigint, leaderLeft: bigint): bigint {
  if (lot <= 0n || leaderSold <= 0n) return 0n
  const had = leaderSold + leaderLeft
  if (leaderLeft * 10_000n <= had * BigInt(Math.round(COPY.soldOutShare * 10_000))) return lot
  return (lot * leaderSold) / had
}

// ── reading the chain and the engine ───────────────────────────────────────

const decimalsCache = new Map<string, number>()
async function decimalsOf(token: Address): Promise<number> {
  const k = token.toLowerCase()
  if (!decimalsCache.has(k)) decimalsCache.set(k, Number(await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })))
  return decimalsCache.get(k)!
}
const symbolCache = new Map<string, Promise<string>>()
/** A coin's ticker from its own contract, for trades that arrive without one (coins the engine has no launch record for). */
const symbolOf = (token: string) => {
  const k = token.toLowerCase()
  if (!symbolCache.has(k)) symbolCache.set(k, client.readContract({ address: k as Address, abi: erc20Abi, functionName: 'symbol' }).then(String).catch(() => ''))
  return symbolCache.get(k)!
}
const balanceOf = (token: Address, owner: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })

/** The engine's scan of a coin, waiting up to ~6s for a first report; null when the engine can't say. */
async function scanOf(token: string): Promise<CoinSafety | null> {
  if (!engineApiUrl) return null
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${engineApiUrl}/v1/safety?tokens=${token.toLowerCase()}`, { cache: 'no-store', signal: AbortSignal.timeout(6_000) }).catch(() => null)
    const j = r?.ok ? (await r.json().catch(() => null)) as { safety?: Record<string, CoinSafety | null> } | null : null
    const s = j?.safety?.[token.toLowerCase()]
    if (s === null) return null
    if (s && s.at > 0) return s
    await new Promise(res => setTimeout(res, 2_000))
  }
  return null
}

const NEUTRAL: Risk = { score: 0, level: 'low', factors: [] }

/** The coin's market risk as the Trenches score it: from this browser's market list, else the engine's live numbers.
 * Null when neither knows the coin. */
async function marketOf(token: string, symbol: string): Promise<{ risk: Risk; onCurve: boolean } | null> {
  const p = cachedArgusMarket()?.find(x => x.token.address.toLowerCase() === token)
  if (p) { const row = argusPoolToArcToken(p); return { risk: tokenRisk(row), onCurve: arcStageInput(row).onCurve } }
  const e = await getEngineToken(token).catch(() => null)
  const s = e?.stats
  if (!s) return null
  return {
    risk: riskOf({
      liquidityUsd: s.liquidityUsd, marketCapUsd: s.marketCapUsd, launchedAt: e.meta?.timestamp ?? null, holders: null,
      txns24h: s.trades24, buys24h: s.buys24, sells24h: s.sells24, change24h: s.chg.h24, copycat: copycatOf(symbol, token),
    }),
    onCurve: false,
  }
}

/** The coin's rating as the rest of the site shows it: the engine's scan where it has one, its market data otherwise. */
export async function ratingOf(token: string, symbol: string): Promise<SafetyLevel | 'unrated'> {
  const k = token.toLowerCase()
  const [scan, market] = await Promise.all([scanOf(k), marketOf(k, symbol)])
  if (!scan && !market) return 'unrated'
  return arcSafety({ symbol, address: k }, market?.risk ?? NEUTRAL, scan, market?.onCurve ?? false).level
}

let feeWalletP: { at: number; p: Promise<Address> } | null = null
/** Who gets the fee on a Universal Router copy: the referrer the swap router holds for this wallet (else the one this
 * visitor arrived with, never itself) and the router's fee wallet, as the swap widget pays them. */
async function sharesFor(info: RouterInfo, me: Address): Promise<FeeShare[]> {
  if (!feeWalletP || Date.now() - feeWalletP.at > 10 * 60_000) {
    feeWalletP = { at: Date.now(), p: client.readContract({ address: SWAP_ROUTER_ADDRESS, abi: ROUTER_FEES, functionName: 'feeWallet' }) }
    feeWalletP.p.catch(() => { feeWalletP = null })
  }
  const [feeWallet, bound] = await Promise.all([
    feeWalletP.p,
    info.version === 2 ? client.readContract({ address: SWAP_ROUTER_ADDRESS, abi: ROUTER_FEES, functionName: 'referrerOf', args: [me] }).catch(() => ZERO) : Promise.resolve(ZERO),
  ])
  const referrer = bound.toLowerCase() !== ZERO ? bound : info.version === 2 ? await referrerFor(me) : ZERO
  const paid = referrer.toLowerCase() === ZERO || referrer.toLowerCase() === me.toLowerCase() ? null : referrer
  return feeShares(info.feeBps, info.referralShareBps, feeWallet, paid)
}

const routeCache = new Map<string, Promise<SwapRoute | null>>()
const routeOf = (token: string, pool: string) => {
  const k = `${token}:${pool}`.toLowerCase()
  if (!routeCache.has(k)) routeCache.set(k, buildSwapRoute(token, pool).catch(() => null))
  return routeCache.get(k)!
}

// ── copying ────────────────────────────────────────────────────────────────

export interface CopyContext {
  /** The trading wallet's address (it signs locally, without pop-ups). */
  me: Address
  /** Still allowed to send right now: the master switch, the flag, the rule (asked again before each transaction). */
  stillOn: (leader: string) => boolean
}

const evId = (t: WalletTradeWire) => `${t.w.toLowerCase()}:${t.t.toLowerCase()}:${t.ts}:${t.side}:${t.u}`

/** Copies one leader trade (Arc), logging what happened. */
export async function copyTrade(t: WalletTradeWire, ctx: CopyContext, now = Date.now()): Promise<CopyEvent> {
  const settings = getCopySettings()
  const leader = t.w.toLowerCase()
  const rule = settings.rules.find(r => r.leader === leader)
  if (!t.s) t = { ...t, s: (await symbolOf(t.t)).slice(0, 24) }
  const base = { id: evId(t), at: now, leader, token: t.t.toLowerCase(), symbol: t.s || `${t.t.slice(0, 6)}…`, side: t.side } as const
  const done = (e: Partial<CopyEvent> & Pick<CopyEvent, 'status'>): CopyEvent => { const ev = { ...base, ...e }; logEvent(ctx.me, ev); return ev }
  if (!rule) return { ...base, status: 'skipped', why: N_('not a leader you copy') }
  try {
    if (t.c !== 'arc') return done({ status: 'skipped', why: N_('only Arc trades are copied for now') })
    if (t.side === 'S') return await copySell(t, rule, ctx, done)
    return await copyBuy(t, rule, settings, ctx, done, now)
  } catch (e) {
    const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
    return done({ status: 'failed', why: m.split('\n')[0].slice(0, 160) })
  }
}

type Done = (e: Partial<CopyEvent> & Pick<CopyEvent, 'status'>) => CopyEvent

/** A trading-wallet transaction, sent and waited for. */
async function sendWait(req: unknown): Promise<{ hash: Hex; ok: boolean }> {
  const hash = await sendArc('trading-wallet', req as never)
  return { hash, ok: (await waitForReceipt(hash)).status === 'success' }
}

/** Uniswap's quoter refusing because the pool has no liquidity left at its price (V4Quoter's NotEnoughLiquidity, wrapped
 * in UnexpectedRevertBytes): nobody can trade there through Uniswap until the price moves back into a position. */
export function dryPool(e: unknown): boolean {
  for (let x = e as { raw?: unknown; data?: unknown; cause?: unknown } | undefined, i = 0; x && i < 10; x = x.cause as typeof x, i++) {
    for (const d of [x.raw, x.data]) if (typeof d === 'string' && /^0x6190b2b0[0-9a-f]{128}7a5ed734/i.test(d)) return true
  }
  return false
}

const keepOf = (rule: CopyRule) => (x: bigint) => (x * BigInt(Math.round((100 - rule.slippagePct) * 100))) / 10_000n

async function copyBuy(t: WalletTradeWire, rule: CopyRule, settings: CopySettings, ctx: CopyContext, done: Done, now: number): Promise<CopyEvent> {
  const token = t.t.toLowerCase() as Address
  const cashUsd = Number(formatUnits(await balanceOf(USDC, ctx.me), 6))
  const plan = planBuy({ rule, settings, spentTodayUsd: spentToday(ctx.me, now), cashUsd, leaderUsd: t.u, ageMs: now - t.ts })
  if ('why' in plan) return done({ status: 'skipped', ...plan })
  if (!t.p) return done({ status: 'skipped', why: N_('the leader’s pool isn’t known') })
  if (!routerConfigured) return done({ status: 'skipped', why: N_('ARCDEX’s router isn’t configured on this build') })
  const [route, info, level] = await Promise.all([routeOf(token, t.p), loadRouterInfo(), ratingOf(token, t.s)])
  const unsafe = safetyAllows(level, rule)
  if (unsafe) return done({ status: 'skipped', why: unsafe })
  if (!route) return done({ status: 'skipped', why: N_('no route to buy this coin through ARCDEX') })
  if (route.kind === 'curve') return done({ status: 'skipped', why: N_('the coin is still on its launchpad’s curve, which isn’t copied yet') })
  if (!info) return done({ status: 'skipped', why: N_('ARCDEX’s router couldn’t be read') })

  await assertTradingOn('arc')
  const amountIn = parseUnits(plan.usd.toFixed(2), 6)
  const decimals = await decimalsOf(token)
  const theirs = t.n > 0 ? t.u / t.n : 0
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
  const keep = keepOf(rule)
  const priced = (out: bigint) => priceAllows(plan.usd / Number(formatUnits(out, decimals)), theirs, rule.slippagePct, info.feeBps)
  const before = await balanceOf(token, ctx.me)
  let tx: Hex, minOut: bigint

  if (route.kind === 'v4native') {
    // Native USDC (18 decimals) goes in as the transaction's value: no approval at all.
    const [ur, shares] = await Promise.all([universalRouter(), sharesFor(info, ctx.me)])
    const value = amountIn * 10n ** 12n
    const out = await quoteExactIn(route.key, true, encodeNativeBuy(route.key, value, shares, 0n, ctx.me).swapIn).catch(e => { if (dryPool(e)) return 0n; throw e })
    if (!(out > 0n)) return done({ status: 'skipped', why: N_('the pool has no liquidity at its price right now') })
    const pricey = priced(out)
    if (pricey) return done({ status: 'skipped', ...pricey })
    minOut = keep(out)
    const call = encodeNativeBuy(route.key, value, shares, minOut, ctx.me)
    const args = [call.commands, call.inputs, deadline] as const
    await client.simulateContract({ address: ur, abi: UR_ABI, functionName: 'execute', args, value, account: ctx.me })
    if (!ctx.stillOn(t.w)) return done({ status: 'skipped', why: N_('copying was stopped') })
    const r = await sendWait({ address: ur, abi: UR_ABI, functionName: 'execute', args: [...args], value })
    if (!r.ok) return done({ status: 'failed', why: N_('the swap reverted'), tx: r.hash })
    tx = r.hash
  } else {
    const referrer = info.version === 2 ? await referrerFor(ctx.me) : ZERO
    const allowance = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [ctx.me, SWAP_ROUTER_ADDRESS] })
    const needsApprove = allowance < amountIn
    const override = needsApprove ? usdcAllowanceOverride(ctx.me, SWAP_ROUTER_ADDRESS, amountIn) : undefined
    const sim = routerCall(info, route, { buy: true, tokenIn: USDC, tokenOut: token, amountIn, minOut: 1n, referrer, deadline })
    const { result } = await client.simulateContract({ address: SWAP_ROUTER_ADDRESS, ...sim, account: ctx.me, ...(override ? { stateOverride: override } : {}) } as never) as { result: bigint }
    if (!(result > 0n)) return done({ status: 'skipped', why: N_('the swap would return nothing') })
    const pricey = priced(result)
    if (pricey) return done({ status: 'skipped', ...pricey })
    minOut = keep(result)
    const call = routerCall(info, route, { buy: true, tokenIn: USDC, tokenOut: token, amountIn, minOut, referrer, deadline })
    if (!ctx.stillOn(t.w)) return done({ status: 'skipped', why: N_('copying was stopped') })
    if (needsApprove) {
      // As the fast buy does: gas and fees set here, the approval and the swap sent back to back.
      const data = (encodeFunctionData as (p: unknown) => Hex)({ abi: call.abi, functionName: call.functionName, args: call.args })
      const [gas, fees] = await Promise.all([gasWithAllowance(client as never, ctx.me, SWAP_ROUTER_ADDRESS, data, SWAP_ROUTER_ADDRESS, amountIn), client.estimateFeesPerGas()])
      const a = await sendArc('trading-wallet', { address: USDC, abi: erc20Abi, functionName: 'approve', args: [SWAP_ROUTER_ADDRESS, amountIn] } as never)
      tx = await sendArc('trading-wallet', { address: SWAP_ROUTER_ADDRESS, ...call, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, chainId: arc.id } as never)
      const [ra, rs] = await Promise.all([waitForReceipt(a), waitForReceipt(tx)])
      if (ra.status !== 'success') return done({ status: 'failed', why: N_('the approval failed'), tx: a })
      if (rs.status !== 'success') return done({ status: 'failed', why: N_('the swap reverted'), tx })
    } else {
      const r = await sendWait({ address: SWAP_ROUTER_ADDRESS, ...call })
      if (!r.ok) return done({ status: 'failed', why: N_('the swap reverted'), tx: r.hash })
      tx = r.hash
    }
  }

  const got = (await balanceOf(token, ctx.me)) - before
  const received = got > 0n ? got : minOut
  const lots = getLots(ctx.me)
  const i = lots.findIndex(l => l.leader === t.w.toLowerCase() && l.token === token)
  if (i >= 0) lots[i] = { ...lots[i], raw: (BigInt(lots[i].raw) + received).toString(), spentUsd: lots[i].spentUsd + plan.usd, at: Date.now() }
  else lots.unshift({ leader: t.w.toLowerCase(), token, symbol: t.s, raw: received.toString(), decimals, spentUsd: plan.usd, at: Date.now() })
  setLots(ctx.me, lots)
  rememberHolding(ctx.me, token)
  notifyBalances()
  return done({ status: 'filled', usd: plan.usd, tx, lagMs: Date.now() - t.ts })
}

async function copySell(t: WalletTradeWire, rule: CopyRule, ctx: CopyContext, done: Done): Promise<CopyEvent> {
  const token = t.t.toLowerCase() as Address
  const lots = getLots(ctx.me)
  const i = lots.findIndex(l => l.leader === t.w.toLowerCase() && l.token === token)
  if (i < 0) return done({ status: 'skipped', why: N_('no coins copied from this leader to sell') })
  if (!rule.sells) return done({ status: 'skipped', why: N_('this leader’s sales aren’t copied (your rule)') })
  if (!getCopySettings().on || !rule.on) return done({ status: 'skipped', why: N_('copying is off') })
  if (!t.p) return done({ status: 'skipped', why: N_('the leader’s pool isn’t known') })
  const lot = lots[i]
  const [route, info, leftRaw, held] = await Promise.all([routeOf(token, t.p), loadRouterInfo(), balanceOf(token, t.w as Address), balanceOf(token, ctx.me)])
  if (!route || route.kind === 'curve' || !info) return done({ status: 'skipped', why: N_('no route to sell this coin through ARCDEX') })
  const soldRaw = parseUnits(String(t.n), lot.decimals)
  let amount = sellAmount(BigInt(lot.raw), soldRaw, leftRaw)
  if (amount > held) amount = held
  if (amount <= 0n) return done({ status: 'skipped', why: N_('nothing left of the copied coins to sell') })

  await assertTradingOn('arc')
  const stopped = () => !ctx.stillOn(t.w)
  const keep = keepOf(rule)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
  let tx: Hex, usd: number

  if (route.kind === 'v4native') {
    // The coin comes in through Permit2: exact amounts, to Permit2 and from Permit2 to the router for 30 minutes.
    const [ur, shares] = await Promise.all([universalRouter(), sharesFor(info, ctx.me)])
    const toPermit2 = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [ctx.me, PERMIT2] })
    if (toPermit2 < amount) {
      if (stopped()) return done({ status: 'skipped', why: N_('copying was stopped') })
      const a = await sendWait({ address: token, abi: erc20Abi, functionName: 'approve', args: [PERMIT2, amount] })
      if (!a.ok) return done({ status: 'failed', why: N_('the approval failed'), tx: a.hash })
      await waitForAllowance(client, token, ctx.me, PERMIT2, amount)
    }
    if (await permit2Allowance(ctx.me, token, ur) < amount) {
      if (stopped()) return done({ status: 'skipped', why: N_('copying was stopped') })
      const a = await sendWait({ address: PERMIT2, abi: PERMIT2_ABI, functionName: 'approve', args: [token, ur, amount, Math.floor(Date.now() / 1000) + 1800] })
      if (!a.ok) return done({ status: 'failed', why: N_('the approval failed'), tx: a.hash })
      for (let k = 0; k < 20 && await permit2Allowance(ctx.me, token, ur) < amount; k++) await new Promise(res => setTimeout(res, 500))
    }
    const gross = await quoteExactIn(route.key, false, amount).catch(e => { if (dryPool(e)) return 0n; throw e })
    if (!(gross > 0n)) return done({ status: 'skipped', why: N_('the pool has no liquidity at its price right now') })
    const proceeds = netAfterFees(gross, shares)
    const call = encodeNativeSell(route.key, amount, shares, keep(proceeds), ctx.me)
    const args = [call.commands, call.inputs, deadline] as const
    await client.simulateContract({ address: ur, abi: UR_ABI, functionName: 'execute', args, account: ctx.me })
    if (stopped()) return done({ status: 'skipped', why: N_('copying was stopped') })
    const r = await sendWait({ address: ur, abi: UR_ABI, functionName: 'execute', args: [...args] })
    if (!r.ok) return done({ status: 'failed', why: N_('the sale reverted'), tx: r.hash })
    tx = r.hash
    usd = Number(formatUnits(proceeds, 18))
  } else {
    const referrer = info.version === 2 ? await referrerFor(ctx.me) : ZERO
    const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [ctx.me, SWAP_ROUTER_ADDRESS] })
    if (allowance < amount) {
      if (stopped()) return done({ status: 'skipped', why: N_('copying was stopped') })
      const a = await sendWait({ address: token, abi: erc20Abi, functionName: 'approve', args: [SWAP_ROUTER_ADDRESS, amount] })
      if (!a.ok) return done({ status: 'failed', why: N_('the approval failed'), tx: a.hash })
      await waitForAllowance(client, token, ctx.me, SWAP_ROUTER_ADDRESS, amount)
    }
    const sim = routerCall(info, route, { buy: false, tokenIn: token, tokenOut: USDC, amountIn: amount, minOut: 1n, referrer, deadline })
    const { result } = await client.simulateContract({ address: SWAP_ROUTER_ADDRESS, ...sim, account: ctx.me } as never) as { result: bigint }
    const call = routerCall(info, route, { buy: false, tokenIn: token, tokenOut: USDC, amountIn: amount, minOut: keep(result), referrer, deadline })
    if (stopped()) return done({ status: 'skipped', why: N_('copying was stopped') })
    const r = await sendWait({ address: SWAP_ROUTER_ADDRESS, ...call })
    if (!r.ok) return done({ status: 'failed', why: N_('the sale reverted'), tx: r.hash })
    tx = r.hash
    usd = Number(formatUnits(result, 6))
  }

  const left = getLots(ctx.me)
  const j = left.findIndex(l => l.leader === lot.leader && l.token === token)
  if (j >= 0) left[j] = { ...left[j], raw: (BigInt(left[j].raw) > amount ? BigInt(left[j].raw) - amount : 0n).toString(), at: Date.now() }
  setLots(ctx.me, left)
  notifyBalances()
  return done({ status: 'filled', usd, tx, lagMs: Date.now() - t.ts })
}
