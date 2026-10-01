// The validation run, on its own thread: reads the recorded trades of the last
// hours from the engine's Postgres, runs the walk-forward (quant/
// walkforward.ts) with the engine's current settings, and posts the report
// back. A replay of a day or two takes minutes of CPU, so it never runs on the
// thread that serves the market.

import { SQL } from 'bun'
import type { QuantConfig } from './config'
import { loadReplay } from './history'
import { walkForward } from './walkforward'

declare const self: Worker

self.onmessage = async (e: MessageEvent<{ databaseUrl: string; hours: number; config: QuantConfig; folds: number }>) => {
  const { databaseUrl, hours, config, folds } = e.data
  const sql = new SQL(databaseUrl, { max: 1, idleTimeout: 30, connectionTimeout: 15 })
  try {
    const to = Date.now(), from = to - hours * 3_600_000
    const data = await loadReplay(sql, from, to, config.launchpads)
    if (data.trades.length < 1_000) { self.postMessage({ ok: false, error: `only ${data.trades.length} recorded trades in the last ${hours}h: not enough to validate` }); return }
    const report = await walkForward(data, { base: config, folds, warmupMs: Math.min(6, hours / 6) * 3_600_000 })
    self.postMessage({ ok: true, report, trades: data.trades.length, coins: data.launches.length })
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  } finally {
    await sql.close({ timeout: 5 }).catch(() => {})
  }
}
