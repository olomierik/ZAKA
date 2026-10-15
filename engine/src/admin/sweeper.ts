// The fee sweeper (the build pack's Phase 4; 03 §7 "daily fee sweeper (idempotent, dry-run, thresholds, alerting)";
// 04: "take fees inside the trade and send them to a treasury; the Claim Fees button only consolidates what remains in
// platform-controlled addresses", "alerting on every run, sweep_runs records, dry-run mode, thresholds").
//
// ARCDEX's fees are paid to the fee wallet inside each trade. What can still sit elsewhere:
//   bot-fees   the 15% profit fee a live bot owes when its transfer didn't go through (retried every minute anyway):
//              the engine holds those wallets' keys, so a sweep sends what's owed to the fee wallet ('engine');
//   relay      Relay's app fees for the fee wallet (Solana, BNB Chain), held at Relay until claimed with the fee
//              wallet's signature ('owner': the engine never holds that key);
//   jupiter    Jupiter's referral fees, held in the referral account's token accounts until claimed with its key
//              ('owner').
// A run lists them all. Items under SWEEPER_MIN_USD are listed and left alone. A dry run acts on nothing; a real run
// sends the bot fees and reports what the owner should claim. The plan is the same function for both, so a dry run's
// totals equal a real run's on the same state.
//
// Idempotent: once a real run of a UTC day has gone through ('ok'), another real run that day is a no-op. A partial or
// failed one can run again: an owed fee is cleared when it's sent, so nothing is sent twice. The trade switch's
// "everything off", or SWEEPER=off, pauses real runs. Every run is kept in arcdex_sweep_runs (append-only), real runs go
// in the audit log, and a real run's report, a failure and a pause go to ALERT_WEBHOOK_URL.

import type { SweepItem, SweepRun } from '../../../api/_marketProtocol'
import type { AuditStore, SettingsStore } from '../site/tradeSwitch'
import { errMsg, log } from '../log'

export interface SweepStore {
  /** Adds a run (ignored when its id was seen before). */
  appendSweepRun(r: SweepRun): Promise<void>
  sweepRuns(limit: number): Promise<SweepRun[]>
}

export interface OwedFee { bot: string; position: string; usd: number }
export interface HeldBalance { holder: string; token: string; amount: string; usd: number | null }

export interface SweeperOptions {
  store: SweepStore
  settings: SettingsStore
  audit: AuditStore
  minUsd: number
  /** Fees live bots still owe, and a way to send them (each result names the position). */
  owedFees: () => OwedFee[]
  sendOwedFees: () => Promise<{ position: string; usd: number; tx?: string; error?: string }[]>
  relayBalances: () => Promise<HeldBalance[]>
  jupiterBalances?: (() => Promise<HeldBalance[]>) | null
  /** Why real runs are paused now (the trade switch, SWEEPER=off), or null. */
  paused: () => string | null
  alert?: (text: string) => void
  /** Scheduled runs: after this UTC minute of the day (SWEEPER_CRON's "M H"), once a day; 'off' for none. */
  schedule: { minuteOfDay: number; mode: 'real' | 'dry' } | 'off'
}

const STATE = 'sweeper-state'
const round = (n: number) => Math.round(n * 100) / 100
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10)

/** SWEEPER_CRON's minute and hour ("0 3 * * *": 03:00 UTC); null for anything else. */
export function cronMinuteOfDay(cron: string | undefined): number | null {
  const m = /^\s*(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/.exec(cron ?? '')
  if (!m) return null
  const min = Number(m[1]), hour = Number(m[2])
  return min < 60 && hour < 24 ? hour * 60 + min : null
}

export class Sweeper {
  private running = false

  constructor(private o: SweeperOptions) {}

  /** What a run would act on now. */
  async plan(): Promise<SweepItem[]> {
    const items: SweepItem[] = []
    const min = this.o.minUsd
    const owed = this.o.owedFees()
    if (owed.length) {
      const usd = round(owed.reduce((s, f) => s + f.usd, 0))
      const bots = new Set(owed.map(f => f.bot)).size
      items.push({ id: 'bot-fees', source: 'bot-fees', holder: `${bots} bot wallet${bots === 1 ? '' : 's'}`, token: 'USDC', amount: usd.toFixed(2), usd, action: 'engine', below: usd < min, how: 'sent from each bot wallet to the fee wallet' })
    }
    for (const b of await this.o.relayBalances()) {
      if (!(Number(b.amount) > 0)) continue
      items.push({ id: `relay:${b.token}`, source: 'relay', holder: b.holder, token: b.token, amount: b.amount, usd: b.usd, action: 'owner', below: b.usd !== null && b.usd < min, how: 'claim at relay.link, signed by the fee wallet' })
    }
    for (const b of await (this.o.jupiterBalances?.() ?? Promise.resolve([]))) {
      if (!(Number(b.amount) > 0)) continue
      items.push({ id: `jupiter:${b.holder}`, source: 'jupiter', holder: b.holder, token: b.token, amount: b.amount, usd: b.usd, action: 'owner', below: b.usd !== null && b.usd < min, how: 'claim at referral.jup.ag, signed by the referral account' })
    }
    return items
  }

  private totals(items: SweepItem[]): SweepRun['totals'] {
    const sum = (f: (i: SweepItem) => boolean) => round(items.filter(f).reduce((s, i) => s + (i.usd ?? 0), 0))
    return { engineUsd: sum(i => i.action === 'engine' && !i.below), ownerUsd: sum(i => i.action === 'owner' && !i.below), belowUsd: sum(i => i.below), items: items.length }
  }

  private async state(): Promise<{ day: string | null; scheduled: string | null }> {
    const s = await this.o.settings.getSetting(STATE).catch(() => null)
    try { return s ? JSON.parse(s) : { day: null, scheduled: null } } catch { return { day: null, scheduled: null } }
  }

  /** A run. `by`: the admin's address, or 'engine' for a scheduled one. */
  async run(mode: 'dry' | 'real', by: string, now = Date.now()): Promise<SweepRun> {
    const day = dayOf(now)
    const base = { id: `${mode}:${day}:${now}`, at: now, day, mode, by: by.toLowerCase() }
    if (this.running) return { ...base, status: 'noop', totals: { engineUsd: 0, ownerUsd: 0, belowUsd: 0, items: 0 }, sentUsd: 0, items: [], note: 'a sweep is already running' }
    this.running = true
    let run: SweepRun
    try {
      const st = await this.state()
      if (mode === 'real' && st.day === day) {
        run = { ...base, status: 'noop', totals: { engineUsd: 0, ownerUsd: 0, belowUsd: 0, items: 0 }, sentUsd: 0, items: [], note: 'today\'s sweep already went through' }
        await this.save(run)
        return run
      }
      let items: SweepItem[]
      try { items = await this.plan() } catch (e) {
        run = { ...base, status: 'failed', totals: { engineUsd: 0, ownerUsd: 0, belowUsd: 0, items: 0 }, sentUsd: 0, items: [], note: `couldn't read what's held: ${errMsg(e).slice(0, 200)}` }
        await this.finish(run)
        return run
      }
      const totals = this.totals(items)
      const pausedWhy = mode === 'real' ? this.o.paused() : null
      if (mode === 'dry' || pausedWhy) {
        run = { ...base, status: pausedWhy ? 'paused' : 'ok', totals, sentUsd: 0, items, ...(pausedWhy ? { note: pausedWhy } : {}) }
        await this.finish(run)
        return run
      }
      // Real: send what the engine can, report the rest.
      let sentUsd = 0, failed = 0
      const bot = items.find(i => i.id === 'bot-fees' && !i.below)
      if (bot) {
        type Sent = { position: string; usd: number; tx?: string; error?: string }
        const results: Sent[] = await this.o.sendOwedFees().catch((e): Sent[] => [{ position: '*', usd: bot.usd ?? 0, error: errMsg(e) }])
        const bad = results.filter(r => r.error)
        sentUsd = round(results.filter(r => !r.error).reduce((s, r) => s + r.usd, 0))
        failed += bad.length
        bot.outcome = bad.length ? { ok: false, error: `${bad.length} of ${results.length} not sent: ${bad[0].error?.slice(0, 160)}` } : { ok: true, ...(results[0]?.tx ? { tx: results[0].tx } : {}) }
      }
      run = { ...base, status: failed ? 'partial' : 'ok', totals, sentUsd, items }
      await this.finish(run)
      if (run.status === 'ok') await this.o.settings.setSetting(STATE, JSON.stringify({ ...st, day })).catch(e => log.warn('sweeper: state not saved', { error: errMsg(e) }))
      return run
    } finally {
      this.running = false
    }
  }

  private async save(run: SweepRun) {
    await this.o.store.appendSweepRun(run).catch(e => log.error('sweeper: run not recorded', { error: errMsg(e) }))
  }

  private async finish(run: SweepRun) {
    await this.save(run)
    if (run.mode === 'real') {
      await this.o.audit.appendAudit({ at: run.at, actor: run.by, action: 'sweep.run', detail: { id: run.id, status: run.status, totals: run.totals, sentUsd: run.sentUsd, note: run.note ?? null } })
        .catch(e => log.error('sweeper: not audited', { error: errMsg(e) }))
      this.o.alert?.(report(run))
    }
    if (run.status === 'failed' || run.status === 'partial') log.error('sweeper: run did not go through', { id: run.id, status: run.status, note: run.note })
    else log.info('sweeper: run', { id: run.id, status: run.status, totals: run.totals, sentUsd: run.sentUsd })
  }

  /** The daily run, when it's due. */
  async tick(now = Date.now()) {
    if (this.o.schedule === 'off') return
    const d = new Date(now)
    if (d.getUTCHours() * 60 + d.getUTCMinutes() < this.o.schedule.minuteOfDay) return
    const st = await this.state()
    const day = dayOf(now)
    if (st.scheduled === day) return
    await this.o.settings.setSetting(STATE, JSON.stringify({ ...(await this.state()), scheduled: day })).catch(() => {})
    await this.run(this.o.schedule.mode, 'engine', now).catch(e => {
      log.error('sweeper: scheduled run failed', { error: errMsg(e) })
      this.o.alert?.(`ARCDEX fee sweeper: the scheduled run failed: ${errMsg(e).slice(0, 200)}`)
    })
  }

  recent(limit = 20) { return this.o.store.sweepRuns(limit) }
}

/** The run in a few lines, for the alert. */
export function report(r: SweepRun): string {
  const head = `ARCDEX fee sweeper (${r.mode}, ${r.day}): ${r.status}${r.note ? ` (${r.note})` : ''}`
  const lines = r.items.filter(i => !i.below).map(i => `• ${i.source} ${i.holder}: ${i.amount} ${i.token}${i.usd !== null ? ` ($${i.usd.toFixed(2)})` : ''}, ${i.action === 'engine' ? (i.outcome ? (i.outcome.ok ? 'sent' : `not sent: ${i.outcome.error}`) : 'to send') : `to claim: ${i.how}`}`)
  const tail = `Sent $${r.sentUsd.toFixed(2)}; for the owner to claim $${r.totals.ownerUsd.toFixed(2)}; under the threshold $${r.totals.belowUsd.toFixed(2)}.`
  return [head, ...lines, tail].join('\n')
}

export class MemorySweepStore implements SweepStore {
  private runs = new Map<string, SweepRun>()
  async appendSweepRun(r: SweepRun) { if (!this.runs.has(r.id)) this.runs.set(r.id, structuredClone(r)) }
  async sweepRuns(limit: number) { return [...this.runs.values()].sort((a, b) => b.at - a.at).slice(0, limit).map(r => structuredClone(r)) }
}
