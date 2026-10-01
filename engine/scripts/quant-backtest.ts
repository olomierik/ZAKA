// Backtests and walk-forward validation of the signal engine (engine/src/quant) on recorded Arc trades.
//
//   bun engine/scripts/quant-backtest.ts --tapes <dir>[,<dir>…]   [--walkforward] [--folds 3] [--warmup-hours 6] [--out report.json]
//   bun engine/scripts/quant-backtest.ts --api https://arcdex-engine-production.up.railway.app --hours 48 [--save-tapes <dir>] …
//   bun engine/scripts/quant-backtest.ts … --config '{"gates":{"minSignalScore":80}}'
//
// Tapes: one JSON file per coin, {token, symbol, launchedAt, creator, launchpad, block?, trades: [{ts, s: 'B'|'S', p (USD price), u (USD), w (wallet), b (block), lq (pool USD depth)}]},
// the format engine/scripts/quant-backtest.ts --save-tapes writes. From --api, every launch the engine lists that's
// older than 20 minutes and has 30+ trades is fetched with its trades (the engine keeps 72 hours of trades).
// Nothing is sent anywhere; no keys are needed.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LaunchInfo, Trade } from '../../api/_marketProtocol'
import { DEFAULT_CONFIG, mergeConfig, validateConfig } from '../src/quant/config'
import { runBacktest, type ReplayData } from '../src/quant/backtest'
import { walkForward } from '../src/quant/walkforward'

const args = process.argv.slice(2)
const arg = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined }
const flag = (k: string) => args.includes(`--${k}`)

interface TapeFile { token: string; symbol?: string; launchedAt: number; creator?: string | null; launchpad?: string | null; block?: number | null; trades: { ts: number; s: string; p: number; u: number; w?: string | null; b?: number | null; lq?: number | null }[] }

export function fromTapes(files: TapeFile[]): ReplayData {
  const launches: LaunchInfo[] = [], trades: Trade[] = []
  for (const c of files) {
    const T = c.trades.filter(t => t.p > 0 && t.ts > 0 && (t.s === 'B' || t.s === 'S')).sort((a, b) => a.ts - b.ts || (a.b ?? 0) - (b.b ?? 0))
    if (T.length < 30) continue
    launches.push({ token: c.token, name: c.symbol ?? '', symbol: c.symbol ?? '', decimals: 18, creator: c.creator || null, txHash: '', blockNumber: c.block ?? T[0].b ?? 0, timestamp: c.launchedAt, pool: null, quote: null, launchpad: c.launchpad ?? 'ARGUS', chain: 'ARC', status: 'LIVE' })
    T.forEach((t, i) => trades.push({
      tradeId: `${c.token}:${i}`, chain: 'ARC', token: c.token, pair: `${c.token}/usdc`,
      // A side pool's trades (tiny depth) print wrong prices: they stay out of the coin's price.
      pool: (t.lq ?? 0) < 1_000 ? 'side' : 'main', quote: '0x3600000000000000000000000000000000000000',
      side: t.s === 'B' ? 'BUY' : 'SELL', baseAmount: t.u / t.p, quoteAmount: t.u, tokenAmount: t.u / t.p, price: t.p, priceUsd: t.p, usdValue: t.u,
      wallet: t.w ? t.w.toLowerCase() : null, txHash: `${c.token}:${i}`, blockNumber: t.b ?? 0, logIndex: i, timestamp: t.ts, dex: 'uniswap-v4', launchpad: c.launchpad ?? 'ARGUS', liquidity: t.lq ?? null,
    }))
  }
  return { launches, trades }
}

async function fromApi(base: string, hours: number, save?: string): Promise<TapeFile[]> {
  const get = async (p: string) => { for (let i = 0; ; i++) { try { const r = await fetch(base + p, { headers: { Origin: 'https://arcdex.online' } }); if (r.ok) return r.json(); throw new Error(`${r.status}`) } catch (e) { if (i >= 3) throw e; await Bun.sleep(1_000 * (i + 1)) } } }
  const now = Date.now()
  const launches = ((await get('/v1/tokens/new?limit=500')).launches as LaunchInfo[]).filter(l => now - l.timestamp > 20 * 60_000 && now - l.timestamp < hours * 3_600_000)
  console.log(`${launches.length} launches in the last ${hours}h`)
  const out: TapeFile[] = []
  for (const l of launches) {
    const T: Record<string, unknown>[] = []
    let before: number | undefined
    for (let page = 0; page < 20; page++) {
      const r = (await get(`/v1/tokens/${l.token}/trades?limit=500${before ? `&before=${before}` : ''}`)).trades as Record<string, unknown>[]
      if (!r.length) break
      T.push(...r); before = Math.min(...r.map(t => t.ts as number))
      if (r.length < 500) break
    }
    const seen = new Set<string>()
    const trades = T.filter(t => !seen.has(t.id as string) && seen.add(t.id as string)).map(t => ({ ts: t.ts as number, s: t.s as string, p: (t.pu ?? t.p) as number, u: (t.u ?? 0) as number, w: (t.w as string | null) ?? null, b: (t.b as number) ?? null, lq: (t.lq as number | null) ?? null }))
    if (trades.length < 30) continue
    const f: TapeFile = { token: l.token, symbol: l.symbol, launchedAt: l.timestamp, creator: l.creator, launchpad: l.launchpad, block: l.blockNumber, trades }
    out.push(f)
    if (save) { mkdirSync(save, { recursive: true }); writeFileSync(join(save, `${l.token}.json`), JSON.stringify(f)) }
  }
  console.log(`${out.length} coins with 30+ trades`)
  return out
}

function readTapes(dirs: string): TapeFile[] {
  const byToken = new Map<string, TapeFile>()
  for (const dir of dirs.split(',')) {
    if (!existsSync(dir)) { console.warn(`no such folder: ${dir}`); continue }
    for (const fn of readdirSync(dir)) {
      if (!fn.endsWith('.json')) continue
      const c = JSON.parse(readFileSync(join(dir, fn), 'utf8')) as TapeFile
      if (!c.token || !Array.isArray(c.trades)) continue
      const had = byToken.get(c.token)
      if (!had || had.trades.length < c.trades.length) byToken.set(c.token, c)
    }
  }
  return [...byToken.values()]
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`
function printStats(label: string, s: { trades: number; win_rate: number; profit_factor: number | null; expectancy_pct: number; net_pnl: number; max_drawdown_pct: number; average_hold_min: number; tp_hit_rates: number[]; stop_rate: number }) {
  console.log(`  ${label.padEnd(26)} ${String(s.trades).padStart(4)} trades  won ${(s.win_rate * 100).toFixed(0).padStart(3)}%  PF ${s.profit_factor ?? '—'}  expectancy ${pct(s.expectancy_pct)}  net $${s.net_pnl.toFixed(2)}  max DD ${s.max_drawdown_pct}%  hold ${s.average_hold_min}m  TP ${s.tp_hit_rates.map(x => `${Math.round(x * 100)}%`).join('/')}  stops ${Math.round(s.stop_rate * 100)}%`)
}

if (import.meta.main) {
  const tapes = arg('tapes') ? readTapes(arg('tapes')!) : arg('api') ? await fromApi(arg('api')!, Number(arg('hours') ?? 48), arg('save-tapes')) : null
  if (!tapes) { console.error('give --tapes <dir> or --api <engine url>'); process.exit(1) }
  const lps = (arg('launchpads') ?? 'ARGUS').split(',')
  let config = mergeConfig(DEFAULT_CONFIG, { launchpads: lps })
  if (arg('config')) config = mergeConfig(config, JSON.parse(arg('config')!))
  const bad = validateConfig(config)
  if (bad) { console.error(bad); process.exit(1) }
  const data = fromTapes(tapes.filter(t => lps.includes(t.launchpad ?? 'ARGUS')))
  const ts = data.trades.map(t => t.timestamp)
  const first = Math.min(...ts), last = Math.max(...ts)
  console.log(`${data.launches.length} coins, ${data.trades.length} trades, ${new Date(first).toISOString()} → ${new Date(last).toISOString()}`)
  const warm = Number(arg('warmup-hours') ?? 6) * 3_600_000
  if (flag('walkforward')) {
    const wf = await walkForward(data, { base: config, folds: Number(arg('folds') ?? 3), warmupMs: warm, onProgress: m => console.log(`  … ${m}`) })
    console.log('\nWalk-forward')
    for (const f of wf.folds) {
      console.log(` fold ${f.fold}: chose "${f.chosen}" (${f.why})`)
      printStats('train', f.trainStats); printStats('validate', f.validateStats); printStats('test (out of sample)', f.testStats)
    }
    printStats('ALL OUT OF SAMPLE', wf.oos)
    if (arg('out')) writeFileSync(arg('out')!, JSON.stringify(wf, null, 2))
  } else {
    const r = await runBacktest(data, { config, from: first + warm, to: last })
    const rep = r.report
    console.log(`\nBacktest ${new Date(rep.from).toISOString()} → ${new Date(rep.to).toISOString()} (${(rep.ms / 1000).toFixed(1)}s): ${rep.signals} signals, ${rep.traded} traded, ${rep.rejected} rejected`)
    console.log('  rejected because:', Object.entries(rep.rejectReasons).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', '))
    if (flag('why')) {
      // Every refusal, numbers taken out, most common first.
      const norm = new Map<string, number>()
      for (const s of r.signals) for (const w of ((s as unknown as { why_trade_rejected: string[] }).why_trade_rejected ?? [])) for (const part of w.split('; ')) { const k = part.replace(/\$?-?[\d.,]+%?/g, '#').slice(0, 110); norm.set(k, (norm.get(k) ?? 0) + 1) }
      for (const [k, v] of [...norm].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`    ${String(v).padStart(4)}  ${k}`)
    }
    printStats('ALL', rep.totals)
    for (const [name, rows] of [['by strategy', rep.byStrategy], ['by score', rep.byScore], ['by token age', rep.byAge], ['by liquidity', rep.byLiquidity], ['by regime', rep.byRegime]] as const) {
      console.log(` ${name}`)
      for (const b of rows) printStats(b.key, b.stats)
    }
    console.log('  exits:', JSON.stringify(rep.totals.exit_reasons))
    if (arg('out')) writeFileSync(arg('out')!, JSON.stringify({ report: rep, positions: r.positions }, null, 2))
  }
}
