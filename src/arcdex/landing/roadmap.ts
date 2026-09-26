// The ARCDEX roadmap: what's live, then a new phase every week. One source
// for the landing page (#roadmap, translated), the whitepaper (/whitepaper)
// and the images made from it for X (scripts/whitepaper-assets.mjs).
// To move the plan, change ROADMAP_START: every phase is PHASE_DAYS long.

import { N_ } from '../lib/i18n'

export interface RoadmapItem {
  text: string
  /** Its engineering ships in the phase; it goes live once a partner,
   * an audit or a regulator allows (shown with †). */
  dep?: boolean
}
export interface Phase { n: number; title: string; items: RoadmapItem[] }

/** Phase 1 starts on this Monday (UTC); each phase runs PHASE_DAYS (7: Monday to Sunday). */
export const ROADMAP_START = '2026-09-28'
export const PHASE_DAYS = 7

/** Phase 0: already on arcdex.online. */
export const LIVE_NOW: string[] = [
  N_('Terminal for every Arc coin, with live trade flashes and risk scores'),
  N_('Fair-launch launchpad with anti-snipe limits; creators earn 60% of their tax'),
  N_('One-tap trading wallet with passkey, portfolio and safe withdrawals'),
  N_('Feed, follows, leaderboards, clans and 15% on-chain referral rewards'),
  N_('USDC deposits, Circle CCTP bridge, card and Apple Pay; 7 languages'),
  N_('$ARCD buyback and burn from platform fees'),
]

export const PHASES: Phase[] = [
  { n: 1, title: N_('Fair fees'), items: [
    { text: N_('Swap fee cut from 2% to 1%') },
    { text: N_('USDC cashback on every trade, 5–25% of the fee by 30-day volume') },
    { text: N_('Automatic profit cards with your invite link') },
  ] },
  { n: 2, title: N_('Trenches'), items: [
    { text: N_('Live board of every Arc launchpad: New, About to graduate, Graduated') },
    { text: N_('Safety filters: dev holdings, snipers, bundles, top-10 share, holders') },
    { text: N_('Saved presets, one-tap buys and an AI coin finder in plain words') },
  ] },
  { n: 3, title: N_('Follow the winners'), items: [
    { text: N_('Follow any wallet and get an alert on every buy and sell') },
    { text: N_('Copy any trade in one tap') },
    { text: N_('Installable app with push notifications') },
  ] },
  { n: 4, title: N_('Smart orders'), items: [
    { text: N_('Limit, take-profit, stop-loss and trailing-stop orders') },
    { text: N_('Auto-sell ladders and DCA') },
    { text: N_('Orders run from your own wallet: no custody') },
  ] },
  { n: 5, title: N_('Community'), items: [
    { text: N_('Telegram bot for alerts, quick buys and launches') },
    { text: N_('Launch a coin by posting on X'), dep: true },
    { text: N_('Live chat on every coin') },
    { text: N_('Seasons: points become fee discounts and cashback boosts; clan wars') },
  ] },
  { n: 6, title: N_('Launchpad v2 and ARCDEX Verified'), items: [
    { text: N_('Creators choose where fees go: to themselves, traders or holders'), dep: true },
    { text: N_('ARCDEX Verified: bundle and linked-wallet screening before a coin is listed') },
    { text: N_('Public safety-score API') },
  ] },
  { n: 7, title: N_('Access and more markets'), items: [
    { text: N_('Mobile money in and out: M-Pesa, Airtel Money, Mixx by Yas, MTN MoMo'), dep: true },
    { text: N_('Always-on orders and auto-copy with capped session keys'), dep: true },
    { text: N_('Perpetual futures'), dep: true },
    { text: N_('Responsible-trading tools: loss limits and cool-downs') },
  ] },
]

/** A phase's first and last day, as UTC dates. */
export function phaseDays(n: number): [Date, Date] {
  const start = new Date(`${ROADMAP_START}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() + (n - 1) * PHASE_DAYS)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + PHASE_DAYS - 1)
  return [start, end]
}

/** "28 Sept – 4 Oct" in the reader's language. */
export function phaseRange(n: number, lang = 'en'): string {
  const [a, b] = phaseDays(n)
  const f = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : lang, { day: 'numeric', month: 'short', timeZone: 'UTC' })
  return `${f.format(a)} – ${f.format(b)}`
}

/** Where a phase stands on `now`: done, now, or next. */
export function phaseStatus(n: number, now = Date.now()): 'done' | 'now' | 'next' {
  const [a, b] = phaseDays(n)
  if (now >= b.getTime() + 86_400_000) return 'done'
  return now >= a.getTime() ? 'now' : 'next'
}
