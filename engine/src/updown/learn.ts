// How the BTC Up/Down autotrader learns from its own record (2026-11-01, owner: "the bot doesn't seem to be making
// profits … let it learn from its losses and record trade logs in order for it to self learn and improve").
//
// What its first day showed (45 paper trades, 20 won, −$112.66 after fees): on the trades it took, its model expected
// 26.3 wins, the market's prices 19.2, and it won 20. The market was right; the model was overconfident wherever it
// disagreed with the market, and every "edge" it traded was mostly that overconfidence. So it learns two things:
//
// 1. How much to trust its model against the market (`Calibration`). Every resolved window scores both on the same
//    10-second snapshots. The chance it trades on is market + w·(model − market), and w is the weight that would have
//    made those snapshots' forecasts closest to the results (least squares on the Brier score), per window length and
//    for mid-window against the last minute. It starts at 0.5, moves with the evidence, and weighs recent windows more.
//    A model the market beats ends up with a small w, so it stops seeing edges it doesn't have.
// 2. Kinds of trade that lose (`Patterns`). Over its last 7 days of closed trades, a kind (an underdog, a thin edge,
//    a 15-minute window with 2–4 minutes left…) with 15+ trades that lost at least 15% of its stake a trade, clearly
//    (two standard errors) and by 15 points more than the rest, is skipped. A kind that is nearly all its trades isn't one:
//    losing everywhere is the trust's job (above) and the day's loss stop's. Skipped trades are still filled and settled
//    on paper as "shadow" trades, outside the balance, so a kind that stops losing is let back in by itself.
//
// Each closed trade also gets a lesson in words (why it won or lost), and every change it makes to itself is written
// to its learning journal. Nothing here promises a profit: it makes the bot trade only where its record says it can.

import type { UpdownDur, UpdownLearnNote, UpdownLearnView, UpdownLesson, UpdownTrade } from '../../../api/_updownProtocol'

export type Band = 'mid' | 'end'
export const bandOf = (secondsLeft: number): Band => (secondsLeft < 60 ? 'end' : 'mid')

export const LEARN = {
  /** Where the trust in the model starts, and how many snapshots that start counts for. */
  prior: 0.5,
  priorN: 600,
  /** Each new snapshot weighs this much less than the one after it (a half-life of ~2,000 snapshots, ~70 windows). */
  decay: 1 - 1 / 3_000,
  /** Snapshots where model and market agree say nothing about which is better. */
  minGap: 0.02,
  /** A closed trade seeds the calibration as this many snapshots (one trade is one window's outcome). */
  tradeSeed: 10,
  /** A journal note when the trust moves this much. */
  noteStep: 0.05,
  patterns: { days: 7, minTrades: 15, maxRoi: -0.15, z: -2, worseBy: 0.15, liftRoi: -0.05, liftZ: -1 },
  /** Shadow trades a window may hold, per side. */
  shadowPerWindow: 2,
  notes: 60,
}

interface Cal { s1: number; s2: number; n: number }
const emptyCal = (): Cal => ({ s1: 0, s2: 0, n: 0 })
const key = (dur: UpdownDur, band: Band) => `${dur}:${band}`
const r4 = (n: number) => Math.round(n * 1e4) / 1e4

export interface LearnState {
  v: 1
  calib: Record<string, Cal>
  /** The weight last written to the journal, per key. */
  noted: Record<string, number>
  /** Kinds of trade it skips now, since when, and their record then. */
  blocked: Record<string, { since: number; trades: number; roi: number; pnl: number }>
  notes: UpdownLearnNote[]
  seeded: boolean
}

export const freshLearn = (): LearnState => ({ v: 1, calib: {}, noted: {}, blocked: {}, notes: [], seeded: false })

export interface SnapRow { p: number; market: number; left: number }

/** The kinds of trade the pattern learner watches. Direction (Up or Down) isn't one: which way BTC went on a given day
 *  is the market's regime, not a mistake to learn from. */
export const PATTERNS: { id: string; label: string; match: (t: Pick<UpdownTrade, 'dur' | 'lane' | 'price' | 'model' | 'edge' | 'secondsLeft'>) => boolean }[] = [
  { id: 'dur-5m', label: '5-minute windows', match: t => t.dur === '5m' },
  { id: 'dur-15m', label: '15-minute windows', match: t => t.dur === '15m' },
  { id: 'lane-b', label: 'last-minute lock-ins', match: t => t.lane === 'B' },
  { id: 'dog', label: 'underdogs (under 50¢)', match: t => t.price < 0.5 },
  { id: 'fav', label: 'favourites (50¢ and up)', match: t => t.price >= 0.5 },
  { id: 'p-30', label: 'asks under 30¢', match: t => t.price < 0.3 },
  { id: 'p-30-40', label: 'asks of 30–40¢', match: t => t.price >= 0.3 && t.price < 0.4 },
  { id: 'p-40-60', label: 'asks of 40–60¢', match: t => t.price >= 0.4 && t.price < 0.6 },
  { id: 'p-60', label: 'asks of 60¢ and up', match: t => t.price >= 0.6 },
  { id: 'edge-12', label: 'edges under 12¢', match: t => t.edge < 0.12 },
  { id: 'edge-12-20', label: 'edges of 12–20¢', match: t => t.edge >= 0.12 && t.edge < 0.2 },
  { id: 'edge-20', label: 'edges of 20¢ and up', match: t => t.edge >= 0.2 },
  { id: 'gap-25', label: 'the model 25¢+ away from the price', match: t => t.model - t.price >= 0.25 },
  { id: 'left-2', label: 'under 2 minutes left', match: t => t.secondsLeft < 120 },
  { id: 'left-2-4', label: '2–4 minutes left', match: t => t.secondsLeft >= 120 && t.secondsLeft < 240 },
  { id: 'left-4-8', label: '4–8 minutes left', match: t => t.secondsLeft >= 240 && t.secondsLeft < 480 },
  { id: 'left-8', label: '8 minutes or more left', match: t => t.secondsLeft >= 480 },
  { id: '5m-dog', label: 'underdogs in 5-minute windows', match: t => t.dur === '5m' && t.price < 0.5 },
  { id: '15m-dog', label: 'underdogs in 15-minute windows', match: t => t.dur === '15m' && t.price < 0.5 },
  { id: '5m-left-2-4', label: '5-minute windows with 2–4 minutes left', match: t => t.dur === '5m' && t.secondsLeft >= 120 && t.secondsLeft < 240 },
]
const PATTERN_BY_ID = new Map(PATTERNS.map(p => [p.id, p]))

const roiOf = (t: UpdownTrade) => (t.pnl ?? 0) / Math.max(1e-9, t.cost)
function summary(a: UpdownTrade[]) {
  const n = a.length
  if (!n) return { n, mean: 0, z: 0, pnl: 0, won: 0, staked: 0 }
  const r = a.map(roiOf)
  const mean = r.reduce((s, x) => s + x, 0) / n
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1))
  return { n, mean, z: sd > 0 ? mean / (sd / Math.sqrt(n)) : mean < 0 ? -Infinity : 0, pnl: a.reduce((s, t) => s + (t.pnl ?? 0), 0), won: a.filter(t => t.result === 'won').length, staked: a.reduce((s, t) => s + t.cost, 0) }
}

export class Learner {
  constructor(public s: LearnState = freshLearn(), private now: () => number = Date.now) {
    for (const k of Object.keys(this.s.calib)) this.s.calib[k] = { ...emptyCal(), ...this.s.calib[k] }
  }
  dirty = false

  private note(n: Omit<UpdownLearnNote, 'at'>) {
    this.s.notes.push({ at: this.now(), ...n })
    if (this.s.notes.length > LEARN.notes) this.s.notes.splice(0, this.s.notes.length - LEARN.notes)
    this.dirty = true
  }

  /** How much it trusts its model against the market, for a window length and the part of the window. */
  weight(dur: UpdownDur, band: Band): number {
    const c = this.s.calib[key(dur, band)] ?? emptyCal()
    const fit = c.s2 > 0 ? Math.min(1, Math.max(0, c.s1 / c.s2)) : LEARN.prior
    return (c.n * fit + LEARN.priorN * LEARN.prior) / (c.n + LEARN.priorN)
  }

  /** The chance it trades on: the market's, moved toward the model by what it has learned to trust the model. */
  blend(p: number, market: number | null, dur: UpdownDur, secondsLeft: number): number {
    if (market === null) return p
    return market + this.weight(dur, bandOf(secondsLeft)) * (p - market)
  }

  private add(dur: UpdownDur, band: Band, d: number, err: number, w = 1) {
    if (Math.abs(d) < LEARN.minGap) return
    const k = key(dur, band)
    const c = this.s.calib[k] ?? (this.s.calib[k] = emptyCal())
    const l = Math.pow(LEARN.decay, w)
    c.s1 = c.s1 * l + w * d * err
    c.s2 = c.s2 * l + w * d * d
    c.n = c.n * l + w
    this.dirty = true
  }

  /** A resolved window's snapshots: each says how far the model and the market each were from the result. */
  observe(dur: UpdownDur, rows: SnapRow[], up: boolean) {
    const y = up ? 1 : 0
    for (const r of rows) this.add(dur, bandOf(r.left), r.p - r.market, y - r.market)
    this.journalTrust(rows.length)
  }

  /** On first start, the trades already closed seed the trust: each says how far the model was from the price paid. */
  seed(trades: UpdownTrade[]) {
    if (this.s.seeded) return
    this.s.seeded = true
    const closed = trades.filter(t => t.result !== 'open' && !t.shadow && !t.exit)
    for (const t of closed) {
      const market = t.market ?? t.price
      const raw = t.raw ?? t.model
      this.add(t.dur, bandOf(t.secondsLeft), raw - market, (t.result === 'won' ? 1 : 0) - market, LEARN.tradeSeed)
    }
    if (closed.length) {
      const exp = closed.reduce((s, t) => s + (t.raw ?? t.model), 0), mkt = closed.reduce((s, t) => s + (t.market ?? t.price), 0)
      this.note({ kind: 'start', k: 'Read its {n} closed trades: its model expected {e} wins, the market’s prices {m}, and it won {w}. It now trusts the market more where they disagree.', v: { n: String(closed.length), e: exp.toFixed(1), m: mkt.toFixed(1), w: String(closed.filter(t => t.result === 'won').length) } })
    }
    this.journalTrust(0)
    this.dirty = true
  }

  private journalTrust(samples: number) {
    for (const dur of ['5m', '15m'] as UpdownDur[]) for (const band of ['mid', 'end'] as Band[]) {
      const k = key(dur, band), w = this.weight(dur, band), was = this.s.noted[k] ?? LEARN.prior
      if (Math.abs(w - was) < LEARN.noteStep) continue
      this.s.noted[k] = w
      this.note({
        kind: 'trust',
        k: w < was ? 'Trusts its model less on {d} windows ({b}): {w}% of the way from the market’s price to its own (was {x}%). The market’s price has been closer to the results.' : 'Trusts its model more on {d} windows ({b}): {w}% of the way from the market’s price to its own (was {x}%). Its own forecasts have been closer to the results.',
        v: { d: dur, b: band === 'end' ? 'last minute' : 'mid-window', w: String(Math.round(w * 100)), x: String(Math.round(was * 100)) },
      })
    }
    void samples
  }

  /** The kind of trade a decision is, if it's one it has learned to skip. */
  skipFor(t: Parameters<(typeof PATTERNS)[number]['match']>[0]): string | null {
    for (const id of Object.keys(this.s.blocked)) { const p = PATTERN_BY_ID.get(id); if (p?.match(t)) return id }
    return null
  }
  labelOf(id: string) { return PATTERN_BY_ID.get(id)?.label ?? id }

  /** Re-reads its last 7 days of closed trades (shadow trades too) and decides which kinds to skip. */
  review(trades: UpdownTrade[]) {
    const now = this.now(), P = LEARN.patterns
    const recent = trades.filter(t => t.result !== 'open' && now - t.filledAt <= P.days * 86_400_000)
    for (const p of PATTERNS) {
      const a = recent.filter(t => p.match(t)), rest = recent.filter(t => !p.match(t))
      const s = summary(a), r = summary(rest)
      const on = this.s.blocked[p.id]
      if (!on) {
        if (s.n >= P.minTrades && s.pnl < 0 && s.mean <= P.maxRoi && s.z <= P.z && r.n >= 5 && r.mean - s.mean >= P.worseBy) {
          this.s.blocked[p.id] = { since: now, trades: s.n, roi: r4(s.mean), pnl: Math.round(s.pnl * 100) / 100 }
          this.note({ kind: 'skip', k: 'Skips this kind of trade from now on ({p}): its last {n} lost {r}% of their stake a trade ({won} won, {pnl}), against {o}% for its other trades. It keeps measuring them on paper.', v: { p: p.label, n: String(s.n), r: String(Math.round(-s.mean * 100)), won: String(s.won), pnl: `−$${Math.abs(s.pnl).toFixed(2)}`, o: r.n ? `${r.mean >= 0 ? '+' : '−'}${Math.abs(Math.round(r.mean * 100))}` : '0' } })
        }
      } else if (s.n === 0 || s.mean > P.liftRoi || s.z > P.liftZ) {
        delete this.s.blocked[p.id]
        this.note({ kind: 'lift', k: 'Trades this kind again ({p}): measured on paper since it skipped them, they’re no longer losing ({n} trades, {r}% a trade).', v: { p: p.label, n: String(s.n), r: `${s.mean >= 0 ? '+' : '−'}${Math.abs(Math.round(s.mean * 100))}` } })
      } else {
        on.trades = s.n; on.roi = r4(s.mean); on.pnl = Math.round(s.pnl * 100) / 100
      }
    }
    this.dirty = true
  }

  view(trades: UpdownTrade[]): UpdownLearnView {
    const now = this.now(), P = LEARN.patterns
    const recent = trades.filter(t => t.result !== 'open' && now - t.filledAt <= P.days * 86_400_000)
    const trust: UpdownLearnView['trust'] = []
    for (const dur of ['5m', '15m'] as UpdownDur[]) for (const band of ['mid', 'end'] as Band[]) {
      const c = this.s.calib[key(dur, band)] ?? emptyCal()
      trust.push({ dur, band, weight: r4(this.weight(dur, band)), samples: Math.round(c.n) })
    }
    const kinds = PATTERNS.map(p => {
      const s = summary(recent.filter(t => p.match(t)))
      return { id: p.id, label: p.label, trades: s.n, won: s.won, pnl: Math.round(s.pnl * 100) / 100, roi: r4(s.mean), skipped: Boolean(this.s.blocked[p.id]), since: this.s.blocked[p.id]?.since ?? null }
    }).filter(k => k.trades > 0 || k.skipped).sort((a, b) => Number(b.skipped) - Number(a.skipped) || a.roi - b.roi)
    return { trust, kinds, notes: [...this.s.notes].reverse(), rule: { minTrades: P.minTrades, maxRoi: P.maxRoi, days: P.days } }
  }
}

/** Why a closed trade won or lost, in words (keys are translated on the site). */
export function lessonOf(t: UpdownTrade): UpdownLesson {
  const c = (n: number) => String(Math.round(n * 100))
  const mkt = t.market ?? null
  if (t.shadow) return { k: t.pnl !== null && t.pnl > 0 ? 'Skipped by a lesson, and would have won {pnl}.' : 'Skipped by a lesson, and would have lost {pnl}: the lesson saved it.', v: { pnl: `$${Math.abs(t.pnl ?? 0).toFixed(2)}` } }
  if (t.exit === 'scalp' && (t.pnl ?? 0) > 0) return { k: 'Won: sold at the bid once the market paid what the model said it was worth.' }
  if (t.exit === 'stop') return { k: 'Cut early: the model turned against it, so it sold before the result.' }
  if (t.result === 'won') return mkt !== null && Math.abs((t.side === 'up' ? mkt : 1 - mkt) - t.price) < 0.03 && (t.raw ?? t.model) - t.price > 0.1
    ? { k: 'Won: the model was right and the market came round to it.' }
    : { k: 'Won: held to the result.' }
  if (t.secondsLeft < 60 || t.lane === 'B') return { k: 'Lost in the last minute: a late move in the average decided it.' }
  if (t.hi !== undefined && t.hi - t.price >= 0.05) return { k: 'Lost: it was {n}¢ up before reversing, and the exit didn’t take it.', v: { n: c(t.hi - t.price) } }
  // The market's chance of this side when it bought (or, on trades from before the log kept it, the price it paid).
  const m = mkt === null ? t.price : t.side === 'up' ? mkt : 1 - mkt
  return { k: 'Lost: the market’s {m}¢ was closer than the model’s {p}%. The model was overconfident.', v: { m: c(m), p: c(t.raw ?? t.model) } }
}
