// Reading recorded trades back for the signal engine: its warm-up after a
// restart (wallet records and coin tapes rebuilt from the last hours) and its
// validation runs (quant/validator.ts). From the market engine's own tables
// (arcdex_mkt_trades, arcdex_mkt_tokens), in pages, in chain order.

import type { SQL } from 'bun'
import type { LaunchInfo, Trade } from '../../../api/_marketProtocol'
import { rowToLaunch, rowToTrade, type Row } from '../store/history'
import type { ReplayData } from './backtest'

export interface Cursor { ts: number; block: number; log: number }

const PAGE = 5_000

/** One page of trades after `after`, oldest first: launchpad coins only (of `launchpads`, or any launchpad when null). */
export async function tradesPage(sql: SQL, from: number, to: number, launchpads: string[] | null, after: Cursor | null, limit = PAGE): Promise<Trade[]> {
  const a = after ?? { ts: from - 1, block: -1, log: -1 }
  const rows = (await sql.unsafe(
    `select * from arcdex_mkt_trades where ts >= $1 and ts < $2 and (($3::text[] is null and launchpad is not null) or launchpad = any($3))
       and (ts, block_number, log_index) > ($4::timestamptz, $5::bigint, $6::int)
     order by ts, block_number, log_index limit $7`,
    [new Date(from).toISOString(), new Date(to).toISOString(), launchpads, new Date(a.ts).toISOString(), a.block, a.log, limit],
  )) as Row[]
  return rows.map(rowToTrade)
}

/** Launches of `launchpads` (null: all) launched between the two times. */
export async function launchesBetween(sql: SQL, from: number, to: number, launchpads: string[] | null): Promise<LaunchInfo[]> {
  const rows = (await sql.unsafe(
    `select * from arcdex_mkt_tokens where launched_at >= $1 and launched_at < $2 and ($3::text[] is null or launchpad = any($3)) order by launched_at`,
    [new Date(from).toISOString(), new Date(to).toISOString(), launchpads],
  )) as Row[]
  return rows.map(rowToLaunch)
}

/** Every trade between the two times, page by page (`onPage` sees each page as it comes; yields between pages). */
export async function eachTrade(sql: SQL, from: number, to: number, launchpads: string[] | null, onPage: (t: Trade[]) => void | Promise<void>, max = 5_000_000): Promise<number> {
  let after: Cursor | null = null, n = 0
  for (;;) {
    const page = await tradesPage(sql, from, to, launchpads, after)
    if (!page.length) break
    await onPage(page)
    n += page.length
    const last = page[page.length - 1]
    after = { ts: last.timestamp, block: last.blockNumber, log: last.logIndex }
    if (page.length < PAGE || n >= max) break
    await new Promise(r => setTimeout(r, 0))
  }
  return n
}

/** A replay's data: launches (from a day before `from`, so warm-up coins have their launch) and every trade. */
export async function loadReplay(sql: SQL, from: number, to: number, launchpads: string[] | null): Promise<ReplayData> {
  const launches = await launchesBetween(sql, from - 86_400_000, to, launchpads)
  const trades: Trade[] = []
  await eachTrade(sql, from, to, launchpads, p => { trades.push(...p) })
  return { launches, trades }
}
