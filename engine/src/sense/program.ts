// $SENSE buyback-and-burn and liquidity (owner, 2026-10-03): of the fees ARCSENSE collects, 30%
// buys back $SENSE and burns it, 70% goes to liquidity pools. Fee collection doesn't change:
// every fee still goes to the fee wallet. This ledger reads that wallet's activity on Arc so
// anyone can check the program on the landing page:
//
//   fees     USDC ARCSENSE's trading contracts paid the fee wallet in someone else's transaction:
//            the swap routers, the curve router, the launchpad, and the Universal Router (trades
//            in native-USDC pools) (FEE_SOURCES; SENSE_FEE_SOURCES adds more, e.g. the futures
//            contract on mainnet). Anything else that arrives (a person's transfer) isn't a fee.
//   buyback  a transaction the fee wallet sent that brought it $SENSE (outside a liquidity
//            add): what it paid for it, in USD
//   burn     $SENSE the fee wallet sent to 0x…dEaD
//   liquidity  a transaction the fee wallet sent that added liquidity to a pool (a Uniswap v4
//            ModifyLiquidity or v3 Mint with liquidity going in), or USDC it sent to a
//            liquidity target (the futures pool, once it's on mainnet): the value it put in.
//            Liquidity taken back out counts against it.
//
// What's owed: 30% / 70% of the fees since the program started. Pending = owed − done.
// Token values other than USDC come from the engine's own prices when the transaction is read.

import { pad } from 'viem'
import { hex, type RawLog } from '../../../api/_arcLogs'
import type { Rpc } from '../chain/http'
import { errMsg, log } from '../log'
import type { SenseEntry, SenseEntryKind, SenseProgramView } from './shared'

export const SENSE = '0x91402b32c4ab7915132b8b24e0d084e0428667ed'
export const FEE_WALLET = '0x274262a0321a0701b0a46a3576e07ae881c286bb'
export const DEAD = '0x000000000000000000000000000000000000dead'
const USDC = '0x3600000000000000000000000000000000000000'
const NATIVE_LOGGER = '0xfffffffffffffffffffffffffffffffffffffffe'
const ZERO = '0x0000000000000000000000000000000000000000'
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
/** Uniswap v4 PoolManager ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32). */
const MODIFY_LIQUIDITY = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec'
/** Uniswap v3 pool Mint(address,address,int24,int24,uint128,uint256,uint256) and Burn(address,int24,int24,uint128,uint256,uint256). */
const V3_MINT = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'
const V3_BURN = '0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c'

/** The contracts whose USDC to the fee wallet is ARCSENSE's fees. */
export const FEE_SOURCES = [
  '0xc519b929981f5375d67ab3930ffb100f0a606088', // ArcDexSwapRouter v1
  '0xd07583f7db671521aacfda2b4612ad187aa2924e', // ArcDexSwapRouter v2
  '0xf8e8c8e2159e5bb8af91fd342bfe5b9db7a06441', // ArcDexCurveRouter
  '0xef6a8fdaf0181e19cc2c7575ada4b9c279809a67', // ArcLaunchpad
  '0x8702463e73f74d0b6765abceb314ef07acb92650', // Universal Router 2.1.2 (native-USDC pools)
  '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1', // Universal Router 2.1.1
]

export const PROGRAM = {
  /** The program counts from 2026-10-04 00:00:00 UTC: the first block at or after it (found once the chain reaches it). */
  since: '2026-10-04T00:00:00Z',
  buybackPct: 30,
  liquidityPct: 70,
  /** Blocks per getLogs call (every Arc endpoint takes 9k), and slices per batch (two calls each: 12 calls, as funders.ts sends). */
  slice: 9_000,
  perBatch: 6,
  keepActions: 200,
  keepFees: 50,
}

export type EntryKind = SenseEntryKind
export type Entry = SenseEntry

export interface ProgramState {
  /** The program's first block (0 until the chain reaches PROGRAM.since). */
  startBlock: number
  scannedTo: number
  feesUsd: number
  buybackUsd: number
  senseBought: number
  senseBurned: number
  liquidityUsd: number
  unliquidityUsd: number
  feeDays: Record<string, number>
  actions: Entry[]
  fees: Entry[]
}

export const emptyState = (): ProgramState => ({
  startBlock: 0, scannedTo: 0, feesUsd: 0, buybackUsd: 0, senseBought: 0, senseBurned: 0,
  liquidityUsd: 0, unliquidityUsd: 0, feeDays: {}, actions: [], fees: [],
})

const addr = (topic: string | undefined) => (topic ? `0x${topic.slice(26)}`.toLowerCase() : ZERO)
const amount = (l: RawLog) => BigInt(!l.data || l.data === '0x' ? 0 : l.data.slice(0, 66))
const r2 = (n: number) => Math.round(n * 1e6) / 1e6

/** Each token's flow into and out of `wallet` in one transaction's logs. USDC is read from both of
 * its log sources (the token at 0x3600…, 6 decimals; the native logger, 18 decimals): an ERC-20
 * transfer appears in both, a native one only in the logger, so the larger of the two is the flow. */
export function flowsOf(logs: RawLog[], wallet: string, decimals: (token: string) => number) {
  const w = wallet.toLowerCase()
  const erc = new Map<string, { in: number; out: number }>()
  const usdc = { erc: { in: 0, out: 0 }, native: { in: 0, out: 0 } }
  const senders = new Map<string, number>() // USDC in, by sender (ERC-20 and native, larger of the two per sender)
  const sendersErc = new Map<string, number>()
  const sendersNative = new Map<string, number>()
  for (const l of logs) {
    if (l.topics[0]?.toLowerCase() !== TRANSFER || l.topics.length < 3) continue
    const token = l.address.toLowerCase()
    const from = addr(l.topics[1])
    const to = addr(l.topics[2])
    if (from !== w && to !== w) continue
    if (token === NATIVE_LOGGER || token === USDC) {
      const v = Number(amount(l)) / (token === USDC ? 1e6 : 1e18)
      const side = token === USDC ? usdc.erc : usdc.native
      if (to === w) {
        side.in += v
        const m = token === USDC ? sendersErc : sendersNative
        m.set(from, (m.get(from) ?? 0) + v)
      }
      if (from === w) side.out += v
      continue
    }
    const f = erc.get(token) ?? { in: 0, out: 0 }
    const v = Number(amount(l)) / 10 ** decimals(token)
    if (to === w) f.in += v
    if (from === w) f.out += v
    erc.set(token, f)
  }
  for (const s of new Set([...sendersErc.keys(), ...sendersNative.keys()])) senders.set(s, Math.max(sendersErc.get(s) ?? 0, sendersNative.get(s) ?? 0))
  const usdcFlow = { in: Math.max(usdc.erc.in, usdc.native.in), out: Math.max(usdc.erc.out, usdc.native.out) }
  return { usdc: usdcFlow, tokens: erc, usdcSenders: senders }
}

/** Whether a transaction's logs add or remove pool liquidity (Uniswap v4 or v3). */
export function liquidityOf(logs: RawLog[]): 'add' | 'remove' | null {
  for (const l of logs) {
    const t = l.topics[0]?.toLowerCase()
    if (t === MODIFY_LIQUIDITY) {
      // data: tickLower, tickUpper, liquidityDelta (int256), salt
      const delta = BigInt.asIntN(256, BigInt(`0x${l.data.slice(2 + 64 * 2, 2 + 64 * 3)}`))
      if (delta > 0n) return 'add'
      if (delta < 0n) return 'remove'
    }
    if (t === V3_MINT) return 'add'
    if (t === V3_BURN) return 'remove'
  }
  return null
}

export interface ClassifyCtx {
  feeWallet: string
  sense: string
  /** The contracts whose USDC to the fee wallet is a fee. */
  feeSources: Set<string>
  /** Where USDC the fee wallet sends counts as liquidity (the futures pool on mainnet). */
  liquidityTargets: Set<string>
  priceOf: (token: string) => number | null
  decimals: (token: string) => number
}

/** One transaction touching the fee wallet: what it was, for the program. */
export function classify(txFrom: string, logs: RawLog[], ctx: ClassifyCtx): Omit<Entry, 'tx' | 'block' | 'at'>[] {
  const w = ctx.feeWallet.toLowerCase()
  const f = flowsOf(logs, w, ctx.decimals)
  const sense = f.tokens.get(ctx.sense) ?? { in: 0, out: 0 }
  const value = (token: string, n: number) => (n ? n * (ctx.priceOf(token) ?? 0) : 0)
  const out: Omit<Entry, 'tx' | 'block' | 'at'>[] = []

  if (txFrom.toLowerCase() !== w) {
    // Someone else's transaction: USDC from ARCSENSE's trading contracts is a fee; liquidity
    // coming back from a target counts against liquidity; anything else isn't counted.
    let fee = 0
    let back = 0
    for (const [s, v] of f.usdcSenders) {
      if (ctx.liquidityTargets.has(s)) back += v
      else if (ctx.feeSources.has(s)) fee += v
    }
    if (fee > 0) out.push({ kind: 'fee', usd: r2(fee) })
    if (back > 0) out.push({ kind: 'unliquidity', usd: r2(back) })
    return out
  }

  // The fee wallet's own transaction.
  const burned = logs.filter(l => l.address.toLowerCase() === ctx.sense && l.topics[0]?.toLowerCase() === TRANSFER && addr(l.topics[1]) === w && addr(l.topics[2]) === DEAD)
    .reduce((s, l) => s + Number(amount(l)) / 10 ** ctx.decimals(ctx.sense), 0)
  if (burned > 0) out.push({ kind: 'burn', usd: r2(value(ctx.sense, burned)), sense: r2(burned) })

  // A buyback: $SENSE came in for something else going out. Checked before liquidity, since a
  // pool's hook can touch liquidity during an ordinary swap.
  const netSense = sense.in - sense.out
  if (netSense > 0) {
    let paid = f.usdc.out - f.usdc.in
    for (const [t, x] of f.tokens) if (t !== ctx.sense) paid += value(t, x.out - x.in)
    if (paid > 0) {
      out.push({ kind: 'buyback', usd: r2(paid), sense: r2(netSense) })
      return out
    }
  }

  // A swap through a pool whose hook touches liquidity brings a token in: not a liquidity add.
  // Nor is a transaction that sends tokens out a liquidity removal.
  const anyIn = f.usdc.in > f.usdc.out || [...f.tokens.values()].some(x => x.in > x.out)
  const anyOut = f.usdc.out > f.usdc.in || [...f.tokens.values()].some(x => x.out > x.in)
  const raw = liquidityOf(logs)
  const lq = raw === 'add' ? (anyIn ? null : 'add') : raw === 'remove' ? (anyOut ? null : 'remove') : null
  if (lq) {
    // The value the wallet put in (or took out), every token at its price, USDC at $1.
    let usd = lq === 'add' ? f.usdc.out - f.usdc.in : f.usdc.in - f.usdc.out
    for (const [t, x] of f.tokens) usd += lq === 'add' ? value(t, x.out - x.in) : value(t, x.in - x.out)
    if (usd > 0) out.push({ kind: lq === 'add' ? 'liquidity' : 'unliquidity', usd: r2(usd) })
    return out
  }
  const toTargets = logs.filter(l => (l.address.toLowerCase() === USDC) && l.topics[0]?.toLowerCase() === TRANSFER && addr(l.topics[1]) === w && ctx.liquidityTargets.has(addr(l.topics[2])))
    .reduce((s, l) => s + Number(amount(l)) / 1e6, 0)
  if (toTargets > 0) out.push({ kind: 'liquidity', usd: r2(toTargets) })
  return out
}

/** Folds entries into the state (totals, recent lists, fees by day). */
export function apply(s: ProgramState, entries: Entry[]): ProgramState {
  const next: ProgramState = { ...s, feeDays: { ...s.feeDays }, actions: [...s.actions], fees: [...s.fees] }
  for (const e of entries) {
    if (e.kind === 'fee') {
      next.feesUsd = r2(next.feesUsd + e.usd)
      const day = new Date(e.at ?? Date.now()).toISOString().slice(0, 10)
      next.feeDays[day] = r2((next.feeDays[day] ?? 0) + e.usd)
      next.fees.unshift(e)
    } else {
      if (e.kind === 'buyback') { next.buybackUsd = r2(next.buybackUsd + e.usd); next.senseBought = r2(next.senseBought + (e.sense ?? 0)) }
      if (e.kind === 'burn') next.senseBurned = r2(next.senseBurned + (e.sense ?? 0))
      if (e.kind === 'liquidity') next.liquidityUsd = r2(next.liquidityUsd + e.usd)
      if (e.kind === 'unliquidity') next.unliquidityUsd = r2(next.unliquidityUsd + e.usd)
      next.actions.unshift(e)
    }
  }
  next.actions = next.actions.slice(0, PROGRAM.keepActions)
  next.fees = next.fees.slice(0, PROGRAM.keepFees)
  const days = Object.keys(next.feeDays).sort()
  for (const d of days.slice(0, Math.max(0, days.length - 60))) delete next.feeDays[d]
  return next
}

/** What the landing page shows (GET /v1/sense/program). */
export function view(s: ProgramState, deadBalance: number | null, now = Date.now(), since = PROGRAM.since): SenseProgramView {
  const started = s.startBlock > 0
  const buybackOwed = r2(s.feesUsd * PROGRAM.buybackPct / 100)
  const liquidityOwed = r2(s.feesUsd * PROGRAM.liquidityPct / 100)
  const liquidityNet = r2(s.liquidityUsd - s.unliquidityUsd)
  return {
    at: now,
    program: { since, startBlock: s.startBlock || null, started, buybackPct: PROGRAM.buybackPct, liquidityPct: PROGRAM.liquidityPct, feeWallet: FEE_WALLET, sense: SENSE, dead: DEAD },
    scannedTo: s.scannedTo,
    totals: {
      feesUsd: s.feesUsd,
      buybackOwedUsd: buybackOwed, buybackUsd: s.buybackUsd, senseBought: s.senseBought, senseBurned: s.senseBurned,
      liquidityOwedUsd: liquidityOwed, liquidityUsd: liquidityNet,
      /** Every $SENSE at the dead address, the program's and anyone else's. */
      deadBalance,
    },
    pending: { buybackUsd: Math.max(0, r2(buybackOwed - s.buybackUsd)), liquidityUsd: Math.max(0, r2(liquidityOwed - liquidityNet)) },
    feeDays: Object.entries(s.feeDays).sort(([a], [b]) => a.localeCompare(b)).slice(-30).map(([day, usd]) => ({ day, usd })),
    actions: s.actions.slice(0, 50),
    fees: s.fees.slice(0, 20),
  }
}
export type ProgramView = SenseProgramView

export interface Settings {
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string): Promise<void>
}

const KEY = 'sense-program'

/** Reads the fee wallet's activity every 30 seconds and keeps the ledger (saved in the settings). */
export class SenseProgram {
  state: ProgramState = emptyState()
  deadBalance: number | null = null
  private busy = false
  private timer: ReturnType<typeof setInterval> | null = null
  private decimals = new Map<string, number>([[USDC, 6], [SENSE, 18]])
  private ctx: ClassifyCtx

  constructor(private o: { rpc: Rpc; settings: Settings; priceOf: (token: string) => number | null; feeSources?: string[]; liquidityTargets?: string[]; since?: string }) {
    this.ctx = {
      feeWallet: FEE_WALLET, sense: SENSE,
      feeSources: new Set([...FEE_SOURCES, ...(o.feeSources ?? [])].map(a => a.toLowerCase())),
      liquidityTargets: new Set((o.liquidityTargets ?? []).map(a => a.toLowerCase())),
      priceOf: t => (t === USDC ? 1 : o.priceOf(t)),
      decimals: t => this.decimals.get(t) ?? 18,
    }
  }

  async start() {
    const saved = await this.o.settings.getSetting(KEY).catch(() => null)
    if (saved) {
      try { this.state = { ...emptyState(), ...JSON.parse(saved) as ProgramState } } catch { /* start over */ }
    }
    void this.tick()
    this.timer = setInterval(() => void this.tick(), 30_000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  view() {
    return view(this.state, this.deadBalance, Date.now(), this.o.since ?? PROGRAM.since)
  }

  async tick(deadline = Date.now() + 25_000) {
    if (this.busy) return
    this.busy = true
    try {
      const rpc = this.o.rpc
      const head = Number(BigInt(await rpc.call<string>('eth_blockNumber', [])))
      if (!this.state.startBlock) {
        // The first block at or after the program's start, once the chain gets there.
        const start = await this.firstBlockAt(Date.parse(this.o.since ?? PROGRAM.since) / 1000, head)
        if (start === null) return
        this.state = { ...this.state, startBlock: start, scannedTo: start - 1 }
        await this.o.settings.setSetting(KEY, JSON.stringify(this.state)).catch(() => {})
        log.info('sense program: counting from', { block: start })
      }
      const w = pad(FEE_WALLET as `0x${string}`)
      let from = this.state.scannedTo + 1
      while (from <= head && Date.now() < deadline) {
        const slices: [number, number][] = []
        for (let a = from; a <= head && slices.length < PROGRAM.perBatch; a += PROGRAM.slice) slices.push([a, Math.min(head, a + PROGRAM.slice - 1)])
        const reqs = slices.flatMap(([a, b]) => [
          { method: 'eth_getLogs', params: [{ address: [USDC, NATIVE_LOGGER, SENSE], topics: [TRANSFER, null, w], fromBlock: hex(a), toBlock: hex(b) }] },
          { method: 'eth_getLogs', params: [{ address: [USDC, NATIVE_LOGGER, SENSE], topics: [TRANSFER, w], fromBlock: hex(a), toBlock: hex(b) }] },
        ])
        const res = await rpc.batch<RawLog[]>(reqs)
        let done = 0
        const logs: RawLog[] = []
        for (let i = 0; i < slices.length; i++) {
          const a = res[2 * i], b = res[2 * i + 1]
          if (!a || !b) break // the contiguous prefix only
          logs.push(...a, ...b)
          done = i + 1
        }
        if (!done) break
        await this.process(logs)
        this.state.scannedTo = slices[done - 1][1]
        from = this.state.scannedTo + 1
        await this.o.settings.setSetting(KEY, JSON.stringify(this.state)).catch(e => log.warn('sense program: not saved', { error: errMsg(e) }))
        if (done < slices.length) break
      }
      const bal = await rpc.call<string>('eth_call', [{ to: SENSE, data: `0x70a08231${DEAD.slice(2).padStart(64, '0')}` }, 'latest']).catch(() => null)
      if (bal) this.deadBalance = Number(BigInt(bal)) / 1e18
    } catch (e) {
      log.warn('sense program: scan failed', { error: errMsg(e) })
    } finally {
      this.busy = false
    }
  }

  /** The transactions in these logs, each classified once. */
  private async process(logs: RawLog[]) {
    const byTx = new Map<string, { block: number; logs: RawLog[] }>()
    for (const l of logs) {
      const k = l.transactionHash.toLowerCase()
      const g = byTx.get(k) ?? { block: Number(BigInt(l.blockNumber)), logs: [] }
      if (!g.logs.some(x => x.logIndex === l.logIndex)) g.logs.push(l)
      byTx.set(k, g)
    }
    if (!byTx.size) return
    const hashes = [...byTx.keys()]
    const txs = await this.o.rpc.batch<{ from: string } | null>(hashes.map(h => ({ method: 'eth_getTransactionByHash', params: [h] })))
    const mine = hashes.filter((h, i) => txs[i]?.from?.toLowerCase() === FEE_WALLET)
    // The fee wallet's own transactions: every log in them (other tokens, pool events).
    if (mine.length) {
      const receipts = await this.o.rpc.batch<{ logs: RawLog[] } | null>(mine.map(h => ({ method: 'eth_getTransactionReceipt', params: [h] })))
      mine.forEach((h, i) => { if (receipts[i]) byTx.get(h)!.logs = receipts[i]!.logs })
      await this.learnDecimals(mine.flatMap(h => byTx.get(h)!.logs))
    }
    const blocks = [...new Set([...byTx.values()].map(g => g.block))]
    const times = await this.o.rpc.batch<{ timestamp: string } | null>(blocks.map(b => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] })))
    const timeOf = new Map(blocks.map((b, i) => [b, times[i] ? Number(BigInt(times[i]!.timestamp)) * 1000 : null]))
    const entries: Entry[] = []
    hashes.forEach((h, i) => {
      const from = txs[i]?.from
      if (!from) return
      const g = byTx.get(h)!
      for (const e of classify(from, g.logs, this.ctx)) entries.push({ ...e, tx: h, block: g.block, at: timeOf.get(g.block) ?? null })
    })
    entries.sort((a, b) => a.block - b.block)
    this.state = apply(this.state, entries)
  }

  /** The first block whose timestamp is at or after `ts` (seconds), or null while the chain is before it. */
  private async firstBlockAt(ts: number, head: number): Promise<number | null> {
    const timeOf = async (n: number) => Number(BigInt((await this.o.rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [hex(n), false])).timestamp))
    if (await timeOf(head) < ts) return null
    // Arc makes about two blocks a second; start the search a little further back than that.
    let lo = Math.max(1, head - Math.ceil((Date.now() / 1000 - ts) * 2.5) - 10_000)
    while (lo > 1 && await timeOf(lo) >= ts) lo = Math.max(1, lo - 500_000)
    let hi = head
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (await timeOf(mid) < ts) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Decimals of tokens the fee wallet moved that the ledger hasn't seen (read once). */
  private async learnDecimals(logs: RawLog[]) {
    const unknown = [...new Set(logs.filter(l => l.topics[0]?.toLowerCase() === TRANSFER).map(l => l.address.toLowerCase()))]
      .filter(t => !this.decimals.has(t) && t !== NATIVE_LOGGER)
    if (!unknown.length) return
    const res = await this.o.rpc.batch<string>(unknown.map(t => ({ method: 'eth_call', params: [{ to: t, data: '0x313ce567' }, 'latest'] })))
    unknown.forEach((t, i) => { if (res[i]) this.decimals.set(t, Number(BigInt(res[i]!))) })
  }
}
