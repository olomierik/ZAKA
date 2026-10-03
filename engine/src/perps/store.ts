// Futures candles in the engine's Postgres (perps/candles.ts). Writes are batched: the bars that
// changed are written every 15 seconds.

import { SQL } from 'bun'
import type { CandleStore } from './candles'
import type { PerpsBar } from './shared'
import { errMsg, log } from '../log'

const SCHEMA = `
create table if not exists arcsense_perps_candles (
  feed text not null, tf text not null, t bigint not null,
  o double precision not null, h double precision not null, l double precision not null, c double precision not null,
  primary key (feed, tf, t)
);
`

export class PostgresCandleStore implements CandleStore {
  private sql: SQL
  private ready: Promise<void>
  private dirty = new Map<string, { feed: string; tf: string; bar: PerpsBar }>()
  private timer: ReturnType<typeof setInterval>

  constructor(url: string) {
    this.sql = new SQL(url)
    this.ready = this.sql.unsafe(SCHEMA).then(() => undefined, e => log.error('perps store: schema failed', { error: errMsg(e) }))
    this.timer = setInterval(() => void this.flush(), 15_000)
  }

  async load(feed: string, tf: '1m' | '1h', since: number): Promise<PerpsBar[]> {
    await this.ready
    const rows = await this.sql`select t, o, h, l, c from arcsense_perps_candles where feed = ${feed} and tf = ${tf} and t >= ${since} order by t`
    return rows.map((r: { t: string | number; o: number; h: number; l: number; c: number }) => [Number(r.t), Number(r.o), Number(r.h), Number(r.l), Number(r.c)] as PerpsBar)
  }

  save(feed: string, tf: '1m' | '1h', bar: PerpsBar) {
    this.dirty.set(`${feed}:${tf}:${bar[0]}`, { feed, tf, bar: [...bar] as PerpsBar })
  }

  prune(tf: '1m', before: number) {
    void this.ready
      .then(() => this.sql`delete from arcsense_perps_candles where tf = ${tf} and t < ${before}`)
      .catch(e => log.warn('perps store: prune failed', { error: errMsg(e) }))
  }

  async flush() {
    if (!this.dirty.size) return
    const rows = [...this.dirty.values()]
    this.dirty.clear()
    try {
      await this.ready
      for (const { feed, tf, bar } of rows) {
        const [t, o, h, l, c] = bar
        await this.sql`insert into arcsense_perps_candles (feed, tf, t, o, h, l, c) values (${feed}, ${tf}, ${t}, ${o}, ${h}, ${l}, ${c})
          on conflict (feed, tf, t) do update set h = excluded.h, l = excluded.l, c = excluded.c`
      }
    } catch (e) {
      log.warn('perps store: candles not saved', { error: errMsg(e) })
    }
  }

  close() {
    clearInterval(this.timer)
  }
}
