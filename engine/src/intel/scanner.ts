// One safety report per coin, from every check the engine can make. A coin
// gets signals only if every hard check passes; one that can't be answered
// yet leaves it pending, never passed. Risk checks (the creator's stake,
// serial launching, a copycat ticker) don't block: a coin failing only those
// is "risky", and the bot trades it small and out fast (a scalp; owner's
// decision, 2026-09-30).
//
//   contract (once)   the launchpad's own code (a template), or else: can
//                     anyone still mint, freeze, pause, switch trading off,
//                     change fees or limits, upgrade it or drain it; is it a
//                     proxy; can it self-destruct
//   hook (once)       no hook, a launchpad's own hook, or a custom one that
//                     can change swaps (hard fail)
//   honeypot          bought, passed on and sold by a probe (honeypot.ts);
//                     a round trip costing over 25% in a deep pool is a tax
//   liquidity         enough to trade (curves: can't be pulled)
//   holders (risk)    top 10 over 50%, or the creator over 15%
//   bundle            3+ wallets taking over 25% of the supply in the launch
//                     block and the two after it
//   clusters          3+ early buyers funded from one source, or by the creator
//   wash              a few wallets making most of the volume in round trips
//   creator           sold most of their own buy (the dump already happened)
//   serial (risk)     the creator launched 3+ other coins today
//   copycat (risk)    a bigger coin already uses the ticker

import type { LaunchInfo } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import type { PoolInfo } from '../dex/pools'
import { analyzeCode, EIP1967_BEACON, EIP1967_IMPLEMENTATION, NOBODY, type CodeFacts, type Power } from './bytecode'
import type { Clusters } from './clusters'
import type { Flow } from './flow'
import type { HoneypotResult } from './honeypot'
import type { Holders } from './holders'
import { cloneTarget, matchesTemplate, type CodeTemplate } from './templates'
import { TEMPLATES } from './templateData'

/** Implementations whose clones are a launchpad's standard coin (checked 2026-09-30: no mint, blacklist or pause). */
export const KNOWN_IMPLEMENTATIONS: Record<string, string> = {
  '0x1b74922c01ddfd9c77b37d02c0a236611e8fe500': 'Argus P7 token',
}
/** Hooks shared by many pools that were checked by hand. */
export const KNOWN_HOOKS: Record<string, string> = {
  // Records a price observation after each swap; used by graduated Peach and Faze pools (2026-09-30).
  '0xedf33da5bed98b5babda4d71f55962cf74462491': 'observation hook',
}
const TOKEN_TEMPLATES = Object.values(TEMPLATES).filter(t => / token$/.test(t.name))
const HOOK_TEMPLATES = Object.values(TEMPLATES).filter(t => / hook$/.test(t.name))
/** Powers that only matter while someone holds the key. */
const OWNER_POWERS: Power[] = ['mint', 'freeze', 'pause', 'trading', 'fees', 'limits', 'upgrade', 'drain']
/** v4 hook permission bits (low 14 bits of its address) that let a hook change or block swaps and exits. */
const HOOK_DANGER = [7 /* beforeSwap */, 3 /* beforeSwapReturnDelta */, 2 /* afterSwapReturnDelta */, 9 /* beforeRemoveLiquidity */]

export interface Check {
  id: string
  /** true pass, false fail, null not known yet */
  ok: boolean | null
  /** A hard check blocks signals when it fails, and keeps them pending while unknown. */
  hard: boolean
  /** A risk check doesn't block: failing it, or not knowing, makes the coin risky (traded small, out fast). */
  risk?: boolean
  detail: string
}

export interface SafetyReport {
  token: string
  launchpad: string
  at: number
  /** pass: every check passed; risky: every hard check passed, but a risk check didn't. */
  verdict: 'pass' | 'risky' | 'fail' | 'pending'
  /** 0–100, higher is safer: 100 minus penalties for failed and unknown checks. */
  score: number
  checks: Check[]
  template: string | null
  honeypot: HoneypotResult | null
}

export interface StaticFacts {
  template: string | null
  facts: CodeFacts | null
  owner: string | null
  ownerless: boolean
  proxy: boolean
  hook: { address: string; known: string | null; dangerous: boolean } | null
}

/** What the scanner needs about a coin right now (the engine fills it in). */
export interface ScanInput {
  meta: LaunchInfo
  pool: PoolInfo | null
  liquidityUsd: number | null
  onCurve: boolean
  flow: Flow
  /** Present once a deep scan ran: */
  honeypot?: HoneypotResult | null
  holders?: Holders | null
  clusters?: Clusters | null
  /** Coins using the same ticker that are bigger (by 24h volume or market cap). */
  biggerSameTicker: string[]
  /** The creator's other launches in the last 24h. */
  creatorLaunches24h: number
}

export const LIMITS = {
  minLiquidityUsd: 1_000,
  maxRoundTripPct: 25,
  deepPoolUsd: 2_000,
  maxTop10Pct: 50,
  maxCreatorPct: 15,
  maxBundleSupplyPct: 25,
  maxCreatorSoldPct: 50,
  maxTop3VolumePct: 70,
  maxRoundTripVolumePct: 50,
  maxCreatorLaunches24h: 3,
}

/** Contract and hook facts: read once per coin. */
export async function staticFacts(rpc: Rpc, token: string, pool: PoolInfo | null): Promise<StaticFacts> {
  const code = await rpc.call<string>('eth_getCode', [token, 'latest'])
  let facts = analyzeCode(code)
  let template: string | null = null
  const impl = cloneTarget(code)
  if (impl) {
    template = KNOWN_IMPLEMENTATIONS[impl] ?? null
    facts = analyzeCode(await rpc.call<string>('eth_getCode', [impl, 'latest']))
  } else {
    template = TOKEN_TEMPLATES.find(t => matchesTemplate(code, t))?.name ?? null
  }
  const [ownerRaw, implSlot, beaconSlot] = await Promise.all([
    facts.powers.has('owner') ? rpc.call<string>('eth_call', [{ to: token, data: '0x8da5cb5b' }, 'latest']).catch(() => null) : Promise.resolve(null),
    rpc.call<string>('eth_getStorageAt', [token, EIP1967_IMPLEMENTATION, 'latest']).catch(() => '0x'),
    rpc.call<string>('eth_getStorageAt', [token, EIP1967_BEACON, 'latest']).catch(() => '0x'),
  ])
  const owner = ownerRaw && ownerRaw.length >= 66 ? ('0x' + ownerRaw.slice(-40)).toLowerCase() : null
  const nonZero = (v: string) => /[1-9a-f]/i.test(v.replace(/^0x/, ''))
  let hook: StaticFacts['hook'] = null
  const h = pool?.dex === 'uniswap-v4' ? pool.hooks?.toLowerCase() : null
  if (h && h !== '0x' + '0'.repeat(40)) {
    let known: string | null = KNOWN_HOOKS[h] ?? null
    if (!known) {
      const hc = await rpc.call<string>('eth_getCode', [h, 'latest']).catch(() => null)
      known = HOOK_TEMPLATES.find((t: CodeTemplate) => matchesTemplate(hc, t))?.name ?? null
    }
    const bits = parseInt(h.slice(-4), 16) & 0x3fff
    hook = { address: h, known, dangerous: HOOK_DANGER.some(b => bits & (1 << b)) }
  }
  return { template, facts, owner, ownerless: !facts.powers.has('owner') || (owner !== null && NOBODY.has(owner)), proxy: nonZero(implSlot) || nonZero(beaconSlot), hook }
}

/** The report, from static facts and what the engine knows now (pure). */
export function assess(s: StaticFacts, i: ScanInput): SafetyReport {
  const checks: Check[] = []
  const add = (id: string, ok: boolean | null, hard: boolean, detail: string) => checks.push({ id, ok, hard, detail })
  const risk = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, hard: false, risk: true, detail })
  const trusted = s.template !== null
  const launchpadOwned = s.owner !== null && (s.owner === i.meta.entry?.toLowerCase() || s.owner === (i.meta.pool ?? '').toLowerCase())

  // Contract
  if (trusted) add('contract', true, true, `${s.template}: the launchpad's standard code`)
  else {
    const held = OWNER_POWERS.filter(p => s.facts?.powers.has(p))
    const keyHeld = !s.ownerless && !launchpadOwned
    add('contract', held.length === 0 || !keyHeld, true, held.length === 0 ? 'no mint, freeze, pause, fee or upgrade functions'
      : keyHeld ? `${s.owner ? `owner ${s.owner}` : 'someone (roles, no owner())'} can still: ${held.join(', ')}` : `can ${held.join(', ')}, but ownership is renounced`)
    add('proxy', !s.proxy, true, s.proxy ? 'upgradeable proxy: its code can be replaced' : 'not a proxy')
    add('selfdestruct', !s.facts?.selfdestruct, true, s.facts?.selfdestruct ? 'can self-destruct' : 'no self-destruct')
  }
  // Hook
  if (s.hook) {
    const ok = s.hook.known !== null || !s.hook.dangerous
    add('hook', ok, true, s.hook.known ? `${s.hook.known} (${s.hook.address})` : s.hook.dangerous ? `custom hook ${s.hook.address} can change or block swaps` : `custom hook ${s.hook.address}, no swap-changing permissions`)
  }
  // Honeypot and tax (pool coins; a curve is the launchpad's own contract)
  if (!i.onCurve) {
    const hp = i.honeypot
    if (hp === undefined || hp === null || hp.verdict === 'unknown') add('honeypot', null, true, hp?.error ? `not probed yet: ${hp.error.slice(0, 80)}` : 'not probed yet')
    else if (hp.verdict === 'honeypot') add('honeypot', false, true, `a holder can't sell (reverted ${hp.error?.slice(0, 10) ?? ''})`)
    else if (hp.verdict === 'untradeable') add('honeypot', false, true, `can't be traded: ${hp.error ?? 'the pool refused'}`)
    else {
      const deep = (i.liquidityUsd ?? 0) >= LIMITS.deepPoolUsd
      const taxed = deep && (hp.roundTripLossPct ?? 0) > LIMITS.maxRoundTripPct
      const tokenTax = Math.max(hp.buyTaxPct ?? 0, hp.transferTaxPct ?? 0)
      add('honeypot', !taxed && tokenTax <= 10, true, `sold back fine; round trip ${hp.roundTripLossPct}%${deep ? '' : ' (thin pool: includes price impact)'}${tokenTax ? `, ${tokenTax}% taken in the token` : ''}`)
    }
    add('liquidity', i.liquidityUsd === null ? null : i.liquidityUsd >= LIMITS.minLiquidityUsd, true, i.liquidityUsd === null ? 'liquidity not known yet' : `$${Math.round(i.liquidityUsd).toLocaleString()} in the pool`)
  } else add('liquidity', true, true, 'on its launchpad curve: liquidity can\'t be pulled')

  // Holders (risk: a big holder can dump on the bot, so it trades small and gets out fast)
  if (i.holders === undefined) risk('holders', null, 'holders not read yet')
  else if (i.holders === null) risk('holders', null, 'holders could not be read')
  else risk('holders', i.holders.top10Pct <= LIMITS.maxTop10Pct && i.holders.creatorPct <= LIMITS.maxCreatorPct,
    `${i.holders.holders} holders; top 10 hold ${i.holders.top10Pct.toFixed(1)}%, the creator ${i.holders.creatorPct.toFixed(1)}%`)

  // Bundling, clusters, wash
  const b = i.flow.bundle
  add('bundle', !(b.wallets >= 3 && (b.supplyPct ?? 0) > LIMITS.maxBundleSupplyPct), true, `${b.wallets} wallets bought ${b.supplyPct?.toFixed(1) ?? '?'}% of supply in the first 3 blocks`)
  if (i.clusters === undefined) add('clusters', null, true, 'funding not traced yet')
  // Not traced in time: a risk, not a block (a signal within 2 minutes; the coin trades as a small scalp).
  else if (i.clusters === null) risk('clusters', null, 'funding could not be traced in time')
  else {
    const c = i.clusters
    const bad = c.groups.length > 0 || c.creatorFunded.length >= 2 || c.sameSourceAsCreator.length >= 2
    add('clusters', !bad, true, bad
      ? [c.groups.map(g => `${g.wallets.length} buyers funded by ${g.funder}`).join('; '), c.creatorFunded.length ? `${c.creatorFunded.length} funded by the creator` : '', c.sameSourceAsCreator.length ? `${c.sameSourceAsCreator.length} funded from the creator's source` : ''].filter(Boolean).join('; ')
      : 'early buyers funded independently')
  }
  const washy = i.flow.trades >= 20 && i.flow.top3VolumePct > LIMITS.maxTop3VolumePct && i.flow.roundTripVolumePct > LIMITS.maxRoundTripVolumePct
  add('wash', !washy, true, `top 3 wallets make ${i.flow.top3VolumePct.toFixed(0)}% of volume; ${i.flow.roundTripVolumePct.toFixed(0)}% is round trips`)

  // Creator: one who already sold most of their buy has dumped (hard); a serial launcher is a risk
  const sold = i.flow.creator.soldTokensPct
  add('creator', !(sold !== null && sold > LIMITS.maxCreatorSoldPct), true, sold !== null ? `sold ${sold.toFixed(0)}% of their buy` : 'hasn\'t sold')
  risk('serial', i.creatorLaunches24h < LIMITS.maxCreatorLaunches24h, `${i.creatorLaunches24h} other launches today`)
  risk('copycat', i.biggerSameTicker.length === 0,i.biggerSameTicker.length ? `a bigger coin already uses $${i.meta.symbol}: ${i.biggerSameTicker[0]}` : 'ticker not taken by a bigger coin')
  // Evidence, not a requirement
  add('sellers', i.flow.outsideSellers > 0 ? true : null, false, `${i.flow.outsideSellers} holders besides the creator have sold`)

  const hard = checks.filter(c => c.hard)
  const verdict = hard.some(c => c.ok === false) ? 'fail' : hard.some(c => c.ok === null) ? 'pending' : checks.some(c => c.risk && c.ok !== true) ? 'risky' : 'pass'
  const score = Math.max(0, 100 - checks.reduce((s, c) => s + (c.ok === false ? (c.hard ? 30 : c.risk ? 20 : 10) : c.ok === null ? 5 : 0), 0))
  return { token: i.meta.token, launchpad: i.meta.launchpad, at: Date.now(), verdict, score, checks, template: s.template, honeypot: i.honeypot ?? null }
}
