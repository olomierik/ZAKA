// Autotrade tiers (owner's request, 2026-09-30: "tiers based on signal
// quality: the highest tier gets the highest-quality signals, even at a small
// % gain, with a strategy made for them. Everything free by default, but the
// system ready for the day we charge, and users already having seen what it
// does"). The tier table is here, the one source: the engine enforces it, and
// GET /v1/tiers shows it to the site and the landing page.
//
//   Free     paper trading, 1 bot, Standard signals
//   Tier 1   live trading, 3 bots, Standard signals
//   Tier 2   live, 5 bots, Core and Standard, ahead of Tier 1 in a crowd
//   Tier 3   live, 5 bots, Prime signals and the Precision strategy, first
//            in line on every signal, half the profit fee
//
// What earns a tier: $ARCD in the wallets an account links (each link is a
// signature from that wallet, tierLinkMessage), or the owner's grant (a
// subscription paid some other way; POST /v1/bot/control grant-tier, signed
// by the owner's wallet), whichever is higher.
//
// Until tiers are enforced, every account gets every grade and strategy, 5
// bots and live trading, at the standard fee, and no one is ahead of anyone in
// a crowd: the tier each account would have is shown, so everyone sees what
// each tier's signals do before anything is charged. They start by
// themselves at TIERS_ENFORCE_AT (owner's decision, 2026-09-30: live trading
// for every account without $ARCD until 3 October 2026, 00:00 UTC, then
// tiers), or at once with TIERS_ENFORCED=true.

import type { AccessView, BotStrategy, SignalGrade, TierId, TierInfo } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import { log, errMsg } from '../log'

export const ARCD = '0x4b93446882d29e094181b2fae14b126577a2676c'
const BASE_FEE_PCT = 15
const ALL_STRATEGIES: BotStrategy[] = ['snipe', 'scalp', 'second-leg', 'precision']
const SIGNAL_STRATEGIES: BotStrategy[] = ['snipe', 'scalp', 'second-leg']

export const TIERS: TierInfo[] = [
  { id: 'free', name: 'Free', minArcd: 0, maxBots: 1, live: false, grades: ['standard'], strategies: SIGNAL_STRATEGIES, priority: 0, profitFeePct: BASE_FEE_PCT, perks: ['Paper trading', '1 bot', 'Standard signals'] },
  { id: 't1', name: 'Tier 1', minArcd: 5_000_000, maxBots: 3, live: true, grades: ['standard'], strategies: SIGNAL_STRATEGIES, priority: 1, profitFeePct: BASE_FEE_PCT, perks: ['Live trading', 'Up to 3 bots', 'Standard signals'] },
  { id: 't2', name: 'Tier 2', minArcd: 20_000_000, maxBots: 5, live: true, grades: ['core', 'standard'], strategies: SIGNAL_STRATEGIES, priority: 2, profitFeePct: BASE_FEE_PCT, perks: ['Live trading', 'Up to 5 bots', 'Core and Standard signals', 'Ahead of Tier 1 when a signal is crowded'] },
  { id: 't3', name: 'Tier 3', minArcd: 50_000_000, maxBots: 5, live: true, grades: ['prime', 'core', 'standard'], strategies: ALL_STRATEGIES, priority: 3, profitFeePct: BASE_FEE_PCT / 2, perks: ['Live trading', 'Up to 5 bots', 'Prime signals and the Precision strategy', 'First in line on every signal', 'Half the profit fee: 7.5% instead of 15%'] },
]
const TOP = TIERS[TIERS.length - 1]
const byId = (id: TierId) => TIERS.find(t => t.id === id)!
export const isTier = (x: unknown): x is TierId => typeof x === 'string' && TIERS.some(t => t.id === x)

/** What an account brings: its linked wallets and the owner's grant. */
export interface TierHolder { wallets?: { address: string; at: number }[] | null; grant?: { tier: TierId; until: number } | null }

/** $ARCD balances are read again after this long. */
const STALE_MS = 10 * 60_000

export class Tiers {
  private held = new Map<string, { arcd: number; at: number }>()
  private reading = new Set<string>()

  /** `enforceAt`: when tiers start by themselves (ms); `enforced`: now, whatever the time. */
  constructor(private o: { enforced: boolean; rpc: Rpc | null; enforceAt?: number | null }) {}

  /** Whether tiers are enforced at `now`. */
  enforcedAt(now = Date.now()) { return this.o.enforced || (this.o.enforceAt != null && now >= this.o.enforceAt) }
  get enforced() { return this.enforcedAt() }
  get enforceAt(): number | null { return this.o.enforced ? null : this.o.enforceAt ?? null }
  list(): TierInfo[] { return TIERS }

  /** $ARCD in these wallets (null until every one has been read once); stale ones are read again in the background. */
  arcdOf(addresses: string[], now = Date.now()): number | null {
    let sum = 0, known = true
    for (const a of addresses) {
      const h = this.held.get(a.toLowerCase())
      if (!h || now - h.at > STALE_MS) void this.read(a)
      if (h) sum += h.arcd; else known = false
    }
    return known ? sum : null
  }

  /** Reads a wallet's $ARCD (18 decimals). */
  async read(address: string): Promise<number | null> {
    const a = address.toLowerCase()
    if (!this.o.rpc || this.reading.has(a)) return this.held.get(a)?.arcd ?? null
    this.reading.add(a)
    try {
      const data = '0x70a08231' + a.slice(2).padStart(64, '0')
      const hex = await this.o.rpc.call<string>('eth_call', [{ to: ARCD, data }, 'latest'], 8_000)
      const arcd = Number(BigInt(hex && hex !== '0x' ? hex : '0x0') / 10n ** 12n) / 1e6
      this.held.set(a, { arcd, at: Date.now() })
      return arcd
    } catch (e) {
      log.warn('tiers: $ARCD balance not read', { wallet: a, error: errMsg(e) })
      return this.held.get(a)?.arcd ?? null
    } finally { this.reading.delete(a) }
  }

  /** The tier an account's $ARCD or grant earns. */
  entitled(u: TierHolder | null, now = Date.now()): { tier: TierInfo; via: AccessView['via']; arcdHeld: number | null } {
    const wallets = (u?.wallets ?? []).map(w => w.address)
    const arcdHeld = wallets.length ? this.arcdOf(wallets, now) : 0
    const byArcd = [...TIERS].reverse().find(t => (arcdHeld ?? 0) >= t.minArcd) ?? TIERS[0]
    const grant = u?.grant && u.grant.until > now && isTier(u.grant.tier) ? byId(u.grant.tier) : null
    if (grant && grant.priority > byArcd.priority) return { tier: grant, via: 'grant', arcdHeld }
    return { tier: byArcd, via: byArcd.id === 'free' ? 'none' : 'arcd', arcdHeld }
  }

  /** What an account gets now: its tier's rights when tiers are enforced; everything, at the standard fee and no one ahead, until then. */
  access(u: TierHolder | null, now = Date.now()): AccessView {
    const e = this.entitled(u, now)
    const next = TIERS.find(t => t.priority === e.tier.priority + 1) ?? null
    const enforced = this.enforcedAt(now)
    const base = {
      enforced, enforceAt: this.enforceAt, entitled: e.tier.id, via: e.via, arcdHeld: e.arcdHeld,
      wallets: (u?.wallets ?? []).map(w => w.address),
      grant: u?.grant && u.grant.until > now ? u.grant : null,
      next: next ? { tier: next.id, needArcd: Math.max(0, next.minArcd - (e.arcdHeld ?? 0)) } : null,
    }
    if (!enforced) return { ...base, grades: TOP.grades, strategies: TOP.strategies, maxBots: TOP.maxBots, live: true, profitFeePct: BASE_FEE_PCT, priority: 0 }
    const t = e.tier
    return { ...base, grades: t.grades, strategies: t.strategies, maxBots: t.maxBots, live: t.live, profitFeePct: t.profitFeePct, priority: t.priority }
  }

  /** The lowest tier that gets a grade (for "Prime signals: Tier 3"). */
  static tierFor(grade: SignalGrade): TierInfo { return TIERS.find(t => t.grades.includes(grade)) ?? TOP }
  static tierForStrategy(s: BotStrategy): TierInfo { return TIERS.find(t => t.strategies.includes(s)) ?? TOP }
}

/** Access for an account that has no owner (an older browser-key bot): Free once enforced. */
export const NO_OWNER: TierHolder = { wallets: [], grant: null }
