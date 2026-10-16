// Checks the engine's verified PnL against the chain, recomputed independently (the build pack's Phase 6: "PnL on
// profiles matches an independent on-chain recomputation").
//
// Independent of engine/src/social: its own scan (plain JSON-RPC, every slice must answer or the check fails), its own
// decoding (viem's ABI decoder on the event as the contracts declare it), and exact fractions instead of the engine's
// micro-USDC integers. The engine rounds each sale down twice (proceeds and cost), so its realized PnL may differ from
// the exact figure by at most 2 micro-USDC a sale; volumes and counts must match exactly.
//
//   bun scripts/verify-pnl.ts                       the 10 best traders of the engine's all-time board
//   bun scripts/verify-pnl.ts --top 25
//   bun scripts/verify-pnl.ts 0xabc… 0xdef…        these wallets
//   options: --engine <url> (default production), --rpc <url> (an archive RPC to use alone)
//
// Exits 1 on any mismatch, or when part of the chain couldn't be read.

import { decodeEventLog, parseAbi, toEventSelector, type Hex } from 'viem'

// ── what it reads (written out here, not imported from the engine) ──────────
export const ROUTERS = [
  '0xc519b929981f5375d67ab3930ffb100f0a606088', // ArcDexSwapRouter v1
  '0xd07583f7db671521aacfda2b4612ad187aa2924e', // ArcDexSwapRouter v2
  '0xf8e8c8e2159e5bb8af91fd342bfe5b9db7a06441', // ArcDexCurveRouter
]
export const FROM_BLOCK = 22_548_761
export const USDC = '0x3600000000000000000000000000000000000000'
export const SWAPPED_ABI = parseAbi(['event Swapped(address indexed user, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address feeToken, uint256 fee)'])
export const SWAPPED = toEventSelector(SWAPPED_ABI[0])
const WINDOW_MS: Record<string, number | null> = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000, all: null }

export interface Trade { id: string; block: number; logIndex: number; trader: string; token: string; buy: boolean; usdc: bigint; tokens: bigint; at: number }
export interface RawLog { address: string; topics: Hex[]; data: Hex; transactionHash: string; blockNumber: string; logIndex: string }

/** The router trades in a batch of logs: a coin bought with USDC or sold for it, each event once, in chain order. */
export function decodeSwapped(logs: RawLog[], timeOf: (block: number) => number): Trade[] {
  const out = new Map<string, Trade>()
  for (const l of logs) {
    if (!ROUTERS.includes(l.address.toLowerCase())) continue
    let ev
    try { ev = decodeEventLog({ abi: SWAPPED_ABI, topics: l.topics as [Hex, ...Hex[]], data: l.data }) } catch { continue }
    const { user, tokenIn, tokenOut, amountIn, amountOut } = ev.args
    const inUsdc = tokenIn.toLowerCase() === USDC, outUsdc = tokenOut.toLowerCase() === USDC
    if (inUsdc === outUsdc) continue
    const block = parseInt(l.blockNumber, 16), logIndex = parseInt(l.logIndex, 16)
    const id = `${l.transactionHash.toLowerCase()}:${logIndex}`
    out.set(id, {
      id, block, logIndex, trader: user.toLowerCase(), token: (inUsdc ? tokenOut : tokenIn).toLowerCase(), buy: inUsdc,
      usdc: inUsdc ? amountIn : amountOut, tokens: inUsdc ? amountOut : amountIn, at: timeOf(block),
    })
  }
  return [...out.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
}

// ── exact fractions ─────────────────────────────────────────────────────────
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a }
export class Frac {
  readonly n: bigint; readonly d: bigint
  constructor(n: bigint, d = 1n) {
    if (d === 0n) throw new Error('division by zero')
    if (d < 0n) { n = -n; d = -d }
    const g = gcd(n, d) || 1n
    this.n = n / g; this.d = d / g
  }
  add(o: Frac) { return new Frac(this.n * o.d + o.n * this.d, this.d * o.d) }
  sub(o: Frac) { return new Frac(this.n * o.d - o.n * this.d, this.d * o.d) }
  mul(o: Frac) { return new Frac(this.n * o.n, this.d * o.d) }
  div(o: Frac) { return new Frac(this.n * o.d, this.d * o.n) }
  /** In micro-USDC, as a number (for comparing and printing). */
  micro() { return Number(this.n) / Number(this.d) }
}
const F = (v: bigint) => new Frac(v)

export interface ExactStats { realized: Frac; unmatched: Frac; volume: bigint; trades: number; buys: number; sells: number; counted: number; wins: number; sales: number; allSales: number; nearZero: number }

/** A wallet's numbers over a window, exactly: average cost per coin in chain order; sales in the window realize
 * against costs from any time before them; tokens sold beyond what was bought here have no cost (unmatched). */
export function exactStats(trades: readonly Trade[], since: number): ExactStats {
  const held = new Map<string, { tokens: bigint; cost: Frac }>()
  const s: ExactStats = { realized: F(0n), unmatched: F(0n), volume: 0n, trades: 0, buys: 0, sells: 0, counted: 0, wins: 0, sales: 0, allSales: 0, nearZero: 0 }
  for (const t of trades) {
    const h = held.get(t.token) ?? { tokens: 0n, cost: F(0n) }
    held.set(t.token, h)
    const inWindow = t.at >= since
    if (inWindow) { s.trades++; s.volume += t.usdc; if (t.buy) s.buys++; else s.sells++ }
    if (t.buy) { h.tokens += t.tokens; h.cost = h.cost.add(F(t.usdc)); continue }
    const matched = t.tokens < h.tokens ? t.tokens : h.tokens
    const proceeds = t.tokens === 0n ? F(0n) : F(t.usdc).mul(new Frac(matched, t.tokens))
    const cost = h.tokens === 0n ? F(0n) : h.cost.mul(new Frac(matched, h.tokens))
    h.tokens -= matched
    h.cost = h.cost.sub(cost)
    s.allSales++
    if (!inWindow) continue
    s.sales++
    const pnl = proceeds.sub(cost)
    s.realized = s.realized.add(pnl)
    s.unmatched = s.unmatched.add(F(t.usdc).sub(proceeds))
    if (matched > 0n) {
      s.counted++
      if (pnl.n > 0n) s.wins++
      if (Math.abs(pnl.micro()) <= 2) s.nearZero++ // the engine's rounding can tip such a sale either side of zero
    }
  }
  return s
}

const toMicro = (dec: string) => { const neg = dec.startsWith('-'); const [i, f = ''] = dec.replace('-', '').split('.'); const v = BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6)); return neg ? -v : v }

export interface EngineStats { realized: string; volume: string; unmatched: string; trades: number; buys: number; sells: number; wins: number; counted: number }
export interface Finding { field: string; engine: string; chain: string; ok: boolean }

/** Compares one window's numbers: counts and volume exactly; realized and unmatched within the engine's rounding. */
export function compare(engine: EngineStats, exact: ExactStats): Finding[] {
  const out: Finding[] = []
  const eq = (field: string, a: number | bigint, b: number | bigint) => out.push({ field, engine: String(a), chain: String(b), ok: a === b })
  eq('trades', engine.trades, exact.trades)
  eq('buys', engine.buys, exact.buys)
  eq('sells', engine.sells, exact.sells)
  eq('counted sales', engine.counted, exact.counted)
  out.push({ field: 'won', engine: String(engine.wins), chain: String(exact.wins), ok: Math.abs(engine.wins - exact.wins) <= exact.nearZero })
  eq('volume (µUSDC)', toMicro(engine.volume), exact.volume)
  // The engine rounds each sale's proceeds and cost down to a micro-USDC, and a coin's remaining cost carries the
  // rounding of its earlier sales: its figures are within 2 µUSDC a sale of the exact ones.
  const near = (field: string, dec: string, f: Frac, bound: number) => {
    const diff = Number(toMicro(dec)) - f.micro()
    out.push({ field, engine: dec, chain: (f.micro() / 1e6).toFixed(6), ok: Math.abs(diff) <= bound })
  }
  near('realized', engine.realized, exact.realized, 2 * exact.allSales + 1)
  near('unmatched', engine.unmatched, exact.unmatched, exact.sales + 1)
  const realizedCents = (Number(toMicro(engine.realized)) - exact.realized.micro()) / 1e4
  out.push({ field: 'realized, to the cent', engine: engine.realized, chain: (exact.realized.micro() / 1e6).toFixed(2), ok: Math.abs(realizedCents) < 1 })
  return out
}

// ── reading the chain ───────────────────────────────────────────────────────
const RECENT = { url: 'https://rpc.blockdaemon.mainnet.arc.io', depth: 600_000, span: 100_000 }
const ARCHIVES = ['https://rpc.beamrpc.com', 'https://rpc.mainnet.arc.io', 'https://rpc.quicknode.mainnet.arc.io']
const ARCHIVE_SPAN = 9_000

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`)
  const j = await r.json() as { result?: T; error?: { message: string } }
  if (j.error) throw new Error(`${new URL(url).host}: ${j.error.message}`)
  return j.result as T
}

/** Every router Swapped event of these traders from FROM_BLOCK to `to`. Throws when any slice can't be read. */
async function scan(traders: string[], to: number, only?: string): Promise<RawLog[]> {
  const head = parseInt(await rpc<string>(only ?? RECENT.url, 'eth_blockNumber', []), 16)
  if (head < to) throw new Error(`the RPC is at block ${head}, behind the engine's ${to}`)
  const chunks: { from: number; to: number; urls: string[] }[] = []
  for (let a = FROM_BLOCK; a <= to;) {
    const recent = !only && a >= head - RECENT.depth
    const span = only ? ARCHIVE_SPAN : recent ? RECENT.span : ARCHIVE_SPAN
    const b = Math.min(to, a + span - 1)
    chunks.push({ from: a, to: b, urls: only ? [only] : recent ? [RECENT.url, ...ARCHIVES] : ARCHIVES })
    a = b + 1
  }
  const topics = [SWAPPED, traders.map(t => `0x${t.slice(2).padStart(64, '0')}`)]
  const logs: RawLog[] = []
  let next = 0, done = 0
  const worker = async (w: number) => {
    while (next < chunks.length) {
      const c = chunks[next++]
      let last: unknown
      for (let i = 0; i < 6; i++) {
        const url = c.urls[(w + i) % c.urls.length]
        try {
          logs.push(...await rpc<RawLog[]>(url, 'eth_getLogs', [{ address: ROUTERS, topics, fromBlock: `0x${c.from.toString(16)}`, toBlock: `0x${c.to.toString(16)}` }]))
          last = null
          break
        } catch (e) { last = e; await new Promise(r => setTimeout(r, 500 * (i + 1))) }
      }
      if (last) throw new Error(`blocks ${c.from}–${c.to} couldn't be read: ${last instanceof Error ? last.message : String(last)}`)
      if (++done % 100 === 0) process.stderr.write(`  ${done}/${chunks.length} slices read\n`)
    }
  }
  await Promise.all(Array.from({ length: only ? 2 : 5 }, (_, w) => worker(w)))
  return logs
}

async function blockTimes(blocks: number[], only?: string): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const urls = only ? [only] : [RECENT.url, ...ARCHIVES]
  for (const b of [...new Set(blocks)]) {
    let ok = false
    for (const url of urls) {
      try {
        const blk = await rpc<{ timestamp: string } | null>(url, 'eth_getBlockByNumber', [`0x${b.toString(16)}`, false])
        if (blk) { out.set(b, parseInt(blk.timestamp, 16) * 1000); ok = true; break }
      } catch { /* the next RPC */ }
    }
    if (!ok) throw new Error(`block ${b}'s time couldn't be read`)
  }
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (k: string) => { const i = args.indexOf(k); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v }
  const engine = (opt('--engine') ?? 'https://arcdex-engine-production.up.railway.app').replace(/\/$/, '')
  const top = Number(opt('--top') ?? 10)
  const only = opt('--rpc')
  let traders = args.filter(a => /^0x[0-9a-fA-F]{40}$/.test(a)).map(a => a.toLowerCase())
  if (!traders.length) {
    const board = await fetch(`${engine}/v1/social/board?period=all&limit=${top}`).then(r => r.json()) as { rows: { trader: string }[] }
    traders = board.rows.map(r => r.trader)
    if (!traders.length) { console.log('The engine’s board has no traders yet.'); return }
  }
  console.log(`Checking ${traders.length} wallet(s) against ${engine}`)
  const views = await Promise.all(traders.map(async t => {
    const r = await fetch(`${engine}/v1/social/trader/${t}`)
    if (!r.ok) throw new Error(`the engine answered ${r.status} for ${t}`)
    return await r.json() as { at: number; scannedTo: number; tradeCount: number; periods: Record<string, EngineStats> }
  }))
  const to = Math.min(...views.map(v => v.scannedTo))
  if (views.some(v => v.scannedTo !== to)) throw new Error('the engine read further between requests: run it again')
  console.log(`Reading the routers' events up to block ${to} (the engine's last block read)…`)
  const logs = await scan(traders, to, only)
  const times = await blockTimes(logs.map(l => parseInt(l.blockNumber, 16)), only)
  const trades = decodeSwapped(logs, b => times.get(b)!)
  let bad = 0
  for (const [i, t] of traders.entries()) {
    const v = views[i]
    const mine = trades.filter(x => x.trader === t)
    console.log(`\n${t}: ${mine.length} router trades on the chain, the engine has ${v.tradeCount}`)
    if (mine.length !== v.tradeCount) { bad++; console.log('  ✗ trade count differs') }
    for (const [period, ms] of Object.entries(WINDOW_MS)) {
      const since = ms === null ? 0 : v.at - ms
      const f = compare(v.periods[period], exactStats(mine, since))
      const failed = f.filter(x => !x.ok)
      bad += failed.length
      console.log(`  ${period.padEnd(4)} ${failed.length ? '✗' : '✓'} realized ${v.periods[period].realized} USDC, volume ${v.periods[period].volume}, ${v.periods[period].trades} trades`)
      for (const x of failed) console.log(`        ${x.field}: engine ${x.engine}, chain ${x.chain}`)
    }
  }
  console.log(bad ? `\n${bad} mismatch(es)` : '\nEvery number matches the chain.')
  process.exit(bad ? 1 : 0)
}

if (import.meta.main) main().catch(e => { console.error(`✗ ${e instanceof Error ? e.message : String(e)}`); process.exit(1) })
