// Scheduling the validation runs: on a timer (SIG_VALIDATE_EVERY_HOURS), and
// when the owner asks. Each run's report is stored (arcdex_sig_backtest_runs)
// and its out-of-sample results are what the live gate reads (quant/risk.ts).
// One run at a time, on a worker thread (quant/validator.worker.ts).

import type { QuantValidationRun } from '../../../api/_quantProtocol'
import { log } from '../log'
import { metrics } from '../metrics'
import type { SignalEngine } from './engine'
import type { WalkForwardReport } from './walkforward'

export class Validator {
  running = false
  last: QuantValidationRun | null = null
  next: number | null = null

  constructor(private o: { engine: SignalEngine; databaseUrl: string | null; hours: number; everyHours: number; folds: number }) {}

  /** Starts the timer: the first run 15 minutes after start, then every `everyHours`. */
  start() {
    if (!this.o.databaseUrl || this.o.everyHours <= 0) return
    const first = 15 * 60_000
    this.next = Date.now() + first
    setTimeout(() => { void this.run('timer'); setInterval(() => void this.run('timer'), this.o.everyHours * 3_600_000) }, first)
  }

  /** The last stored run, after a restart. */
  restore(run: QuantValidationRun | null) {
    this.last = run
    if (run?.oos) this.o.engine.oos = { ...run.oos, at: run.at }
  }

  run(why: string): Promise<QuantValidationRun | null> {
    if (this.running) return Promise.resolve(null)
    if (!this.o.databaseUrl) return Promise.resolve(null)
    this.running = true
    const started = Date.now()
    log.info('quant: validation started', { why, hours: this.o.hours })
    return new Promise(resolve => {
      const w = new Worker(new URL('./validator.worker.ts', import.meta.url).href)
      const done = (r: QuantValidationRun) => {
        this.running = false
        this.last = r
        if (this.o.everyHours > 0) this.next = Date.now() + this.o.everyHours * 3_600_000
        if (r.ok && r.oos) this.o.engine.oos = { ...r.oos, at: r.at }
        this.o.engine.d.store.saveBacktest({ id: r.id, at: r.at, kind: 'walkforward', data: r as unknown as Record<string, unknown> })
        this.o.engine.riskEvent({ at: r.at, mode: 'paper', kind: 'validation', detail: r.summary })
        metrics.latency('quant_validation_ms', Date.now() - started)
        log.info('quant: validation finished', { ok: r.ok, summary: r.summary, ms: Date.now() - started })
        w.terminate()
        resolve(r)
      }
      const id = `wf:${started}`
      w.onmessage = (e: MessageEvent<{ ok: boolean; report?: WalkForwardReport; error?: string; trades?: number; coins?: number }>) => {
        const m = e.data
        if (!m.ok || !m.report) { done({ id, at: Date.now(), kind: 'walkforward', ok: false, summary: `validation failed: ${m.error ?? 'no report'}`, oos: null, error: m.error }); return }
        const oos = m.report.oos
        done({
          id, at: Date.now(), kind: 'walkforward', ok: true, oos,
          summary: `${m.trades} trades of ${m.coins} coins over ${this.o.hours}h, ${m.report.folds.length} folds: ${oos.trades} out-of-sample trades, ${Math.round(oos.win_rate * 100)}% won, profit factor ${oos.profit_factor ?? '—'}, ${oos.expectancy_pct}% a trade, max drawdown ${oos.max_drawdown_pct}%`,
          folds: m.report.folds.map(f => ({ fold: f.fold, chosen: f.chosen, why: f.why, test: f.testStats })),
        })
      }
      w.onerror = e => done({ id, at: Date.now(), kind: 'walkforward', ok: false, summary: `validation crashed: ${e.message}`, oos: null, error: e.message })
      w.postMessage({ databaseUrl: this.o.databaseUrl, hours: this.o.hours, config: this.o.engine.cfg, folds: this.o.folds })
    })
  }
}
