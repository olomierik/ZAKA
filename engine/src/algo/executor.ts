// Testnet execution: ARCDEX Algo's orders on the real futures contract (contracts/SensePerps.sol)
// on Arc testnet, from the agent's own wallet, with test USDC. Every trade is then an on-chain
// request the keeper fills with the first signed price after it, and a position anyone can check.
//
//   open    approve exactly the collateral and the execution fee, then requestOpen with the plan's
//           size, a worst acceptable entry 0.5% away, and its take-profit and stop-loss on-chain
//   close   approve the execution fee, then requestClose (the keeper fills it)
//   watch   every few seconds: a request that became a position (its real entry), a position the
//           keeper closed at its target or stop (the contract's own P&L), a request the contract
//           refused (price moved, pool) or that timed out (cancelled for a refund)
//
// The agent's wallet is made on the engine (its key encrypted under BOT_WALLET_SECRET, like the
// keeper's). Its gas and test USDC come from the keeper wallet, which is the test USDC's minter.

import { encodeFunctionData, getAddress, parseEventLogs, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from 'viem'
import type { AlgoMarket, AlgoTrade } from '../../../api/_algoProtocol'
import { PERPS_ABI, TEST_USDC_ABI } from '../perps/abi'
import type { PerpsTrade } from '../perps/events'
import type { Pos } from '../perps/shared'
import { errMsg, log } from '../log'

export interface ChainView {
  positions: [bigint, Pos][]
  requestIds: bigint[]
  execFee: bigint
  minCollateral: bigint
  requestTimeout: number
  usdc: bigint
  gasWei: bigint
}

/** What the executor needs from the chain: small, so tests can stand in for it. */
export interface PerpsChain {
  agent: Address
  marketId(m: AlgoMarket): number | null
  read(): Promise<ChainView>
  approve(amount: bigint): Promise<Hex>
  requestOpen(a: { marketId: number; isLong: boolean; collateral: bigint; size: bigint; acceptable: bigint; tp: bigint; sl: bigint }): Promise<{ tx: Hex; requestId: bigint | null }>
  requestClose(positionId: bigint): Promise<Hex>
  cancel(requestId: bigint): Promise<Hex>
  /** The contract's close of a position, once indexed (perps/events.ts). */
  closeOf(positionId: string): PerpsTrade | null
  /** The contract's refusal of a request, once indexed. */
  cancelledOf(requestId: string): PerpsTrade | null
  /** Tops up the agent's gas and test USDC from the keeper; says what it did or why it couldn't. */
  fund(view: ChainView): Promise<string | null>
}

const usdc6 = (x: number) => BigInt(Math.round(x * 1e6))
const px8 = (x: number) => BigInt(Math.round(x * 1e8))

export interface ExecEvents {
  filled(t: AlgoTrade, entry: number, positionId: string, at: number): void
  closed(t: AlgoTrade, exit: number, at: number, reason: string, onChain: { pnlUsd: number; feesUsd: number }): void
  failed(t: AlgoTrade, why: string): void
}

export interface ExecutorState { requests: [string, { id: string | null; at: number; tx: string }][] }

export class TestnetExecutor {
  /** Trade id → the open request that should become its position. */
  private requests = new Map<string, { id: bigint | null; at: number; tx: Hex }>()
  /** Trade ids with a close request in flight: when, and why. */
  private closing = new Map<string, { at: number; reason: string }>()
  view: ChainView | null = null
  lastError: string | null = null
  fundNote: string | null = null

  constructor(private chain: PerpsChain, private on: ExecEvents) {}

  get address() { return this.chain.agent }

  /** null when it can trade; otherwise what's missing. */
  missing(t: AlgoTrade | null = null): string | null {
    const v = this.view
    if (!v) return 'the futures contract has not been read yet'
    if (v.gasWei < 10n ** 16n) return `the agent wallet ${this.chain.agent} has no testnet USDC for gas`
    if (t) {
      const need = usdc6(t.collateralUsd) + v.execFee
      if (v.usdc < need) return `the agent wallet holds ${(Number(v.usdc) / 1e6).toFixed(2)} tUSDC, under the ${(Number(need) / 1e6).toFixed(2)} this trade needs`
      if (usdc6(t.collateralUsd) < v.minCollateral) return `collateral under the contract's minimum (${Number(v.minCollateral) / 1e6} tUSDC)`
    }
    return null
  }

  async open(t: AlgoTrade): Promise<void> {
    const mid = this.chain.marketId(t.market)
    const why = mid === null ? `${t.market} isn't a market on the contract` : this.missing(t)
    if (why) { this.on.failed(t, why); return }
    const v = this.view!
    const long = t.side === 'long'
    const collateral = usdc6(t.collateralUsd)
    try {
      await this.chain.approve(collateral + v.execFee)
      const r = await this.chain.requestOpen({
        marketId: mid!, isLong: long, collateral, size: usdc6(t.sizeUsd),
        acceptable: px8(long ? t.entry * 1.005 : t.entry * 0.995), tp: px8(t.tp), sl: px8(t.sl),
      })
      t.txOpen = r.tx
      this.requests.set(t.id, { id: r.requestId, at: Date.now(), tx: r.tx })
      log.info('algo: testnet order sent', { trade: t.id, market: t.market, side: t.side, size: t.sizeUsd, tx: r.tx })
    } catch (e) {
      this.lastError = errMsg(e)
      this.on.failed(t, `the order was not sent: ${errMsg(e).slice(0, 200)}`)
    }
  }

  async close(t: AlgoTrade, reason: string): Promise<void> {
    if (!t.positionId || this.closing.has(t.id)) return
    try {
      await this.chain.approve(this.view?.execFee ?? 0n)
      t.txClose = await this.chain.requestClose(BigInt(t.positionId))
      this.closing.set(t.id, { at: Date.now(), reason })
      log.info('algo: testnet close sent', { trade: t.id, reason, tx: t.txClose })
    } catch (e) {
      this.lastError = errMsg(e)
      log.warn('algo: testnet close failed', { trade: t.id, error: errMsg(e).slice(0, 200) })
    }
  }

  /** Brings the trades in line with the contract. */
  async reconcile(trades: AlgoTrade[], now: number): Promise<void> {
    let v: ChainView
    try { v = await this.chain.read() } catch (e) { this.lastError = errMsg(e); return }
    this.view = v
    this.fundNote = await this.chain.fund(v).catch(e => errMsg(e))
    const live = new Map(v.positions.map(([id, p]) => [String(id), p]))
    const pendingReq = new Set(v.requestIds.map(String))
    const claimed = new Set(trades.filter(t => t.positionId).map(t => t.positionId!))
    for (const t of trades) {
      if (t.status === 'pending') {
        const req = this.requests.get(t.id)
        if (!req) { this.on.failed(t, 'the order was lost in a restart before it was sent'); continue }
        const mid = this.chain.marketId(t.market)
        const match = [...live.entries()].find(([id, p]) => !claimed.has(id) && p.marketId === mid && p.isLong === (t.side === 'long') && Number(p.openedAt) * 1000 >= req.at - 120_000)
        if (match) {
          claimed.add(match[0])
          this.requests.delete(t.id)
          t.sizeUsd = Number(match[1].size) / 1e6
          t.collateralUsd = Number(match[1].collateral) / 1e6
          t.tp = Number(match[1].tp) / 1e8 || t.tp
          t.sl = Number(match[1].sl) / 1e8 || t.sl
          this.on.filled(t, Number(match[1].entryPrice) / 1e8, match[0], Number(match[1].openedAt) * 1000)
          continue
        }
        const cancelled = req.id !== null ? this.chain.cancelledOf(String(req.id)) : null
        if (cancelled) { this.requests.delete(t.id); this.on.failed(t, `the contract refused it: ${cancelled.reason ?? 'cancelled'}`); continue }
        if (req.id !== null && pendingReq.has(String(req.id)) && now - req.at > (v.requestTimeout + 30) * 1000) {
          await this.chain.cancel(req.id).catch(e => { this.lastError = errMsg(e) })
          this.requests.delete(t.id)
          this.on.failed(t, 'not filled in time: cancelled and refunded')
        }
      } else if (t.status === 'open' && t.positionId && !live.has(t.positionId)) {
        const c = this.chain.closeOf(t.positionId)
        if (!c) continue // closed on-chain, not indexed yet
        const reason = c.kind === 'takeProfit' ? 'take-profit' : c.kind === 'stopLoss' ? 'stop-loss' : c.kind === 'liquidated' ? 'liquidated' : (this.closing.get(t.id)?.reason ?? 'closed')
        this.closing.delete(t.id)
        t.txClose = c.tx
        const pnl = Number(c.pnl ?? 0) / 1e6, fees = Number(c.fees ?? 0) / 1e6
        this.on.closed(t, Number(c.price ?? 0) / 1e8, c.at, reason, { pnlUsd: pnl - fees, feesUsd: fees })
      } else if (t.status === 'open' && this.closing.has(t.id) && now - this.closing.get(t.id)!.at > (v.requestTimeout + 30) * 1000) {
        this.closing.delete(t.id) // the close timed out: the next candle asks again
      }
    }
  }

  toJSON(): ExecutorState {
    return { requests: [...this.requests].map(([k, r]) => [k, { id: r.id?.toString() ?? null, at: r.at, tx: r.tx }]) }
  }
  restore(j: ExecutorState | null) {
    for (const [k, r] of j?.requests ?? []) this.requests.set(k, { id: r.id ? BigInt(r.id) : null, at: r.at, tx: r.tx as Hex })
  }
}

/** The real chain, through viem. */
export function viemPerpsChain(o: {
  client: PublicClient
  agent: WalletClient<Transport, Chain, Account>
  keeper: WalletClient<Transport, Chain, Account> | null
  perps: Address
  usdc: Address
  markets: () => string[]
  closedTrades: (account: string) => PerpsTrade[]
  /** How much test USDC to mint the agent when it runs low, and the gas to send it. */
  topUpUsdc?: bigint
  topUpGasWei?: bigint
}): PerpsChain {
  const agent = getAddress(o.agent.account.address)
  const mined = async (hash: Hex) => {
    const r = await o.client.waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 500 })
    if (r.status !== 'success') throw new Error(`reverted on-chain (${hash})`)
    return r
  }
  const write = async (fn: string, args: readonly unknown[], address: Address = o.perps, abi: typeof PERPS_ABI | typeof TEST_USDC_ABI = PERPS_ABI) => {
    const { request } = await o.client.simulateContract({ address, abi, functionName: fn as never, args: args as never, account: o.agent.account })
    const hash = await o.agent.writeContract(request as never)
    return { hash, receipt: await mined(hash) }
  }
  let lastFundAt = 0
  return {
    agent,
    marketId: m => { const i = o.markets().indexOf(m); return i < 0 ? null : i },
    async read() {
      const c = { address: o.perps, abi: PERPS_ABI } as const
      const r = <T>(functionName: string, args?: readonly unknown[]) => o.client.readContract({ ...c, functionName: functionName as never, args: args as never }) as Promise<T>
      const [posIds, reqIds, execFee, minCollateral, requestTimeout, usdc, gasWei] = await Promise.all([
        r<readonly bigint[]>('positionIdsOf', [agent]), r<readonly bigint[]>('requestIdsOf', [agent]),
        r<bigint>('execFee'), r<bigint>('minCollateral'), r<bigint>('requestTimeout'),
        o.client.readContract({ address: o.usdc, abi: TEST_USDC_ABI, functionName: 'balanceOf', args: [agent] }) as Promise<bigint>,
        o.client.getBalance({ address: agent }),
      ])
      const poss = posIds.length ? await r<readonly unknown[]>('getPositions', [posIds]) : []
      return {
        positions: posIds.map((id, i) => [id, poss[i] as Pos] as [bigint, Pos]).filter(([, p]) => p.trader !== '0x0000000000000000000000000000000000000000'),
        requestIds: [...reqIds], execFee, minCollateral, requestTimeout: Number(requestTimeout), usdc, gasWei,
      }
    },
    async approve(amount) {
      return (await write('approve', [o.perps, amount], o.usdc, TEST_USDC_ABI)).hash
    },
    async requestOpen(a) {
      const { hash, receipt } = await write('requestOpen', [a.marketId, a.isLong, a.collateral, a.size, a.acceptable, 0n, a.tp, a.sl])
      const ev = parseEventLogs({ abi: PERPS_ABI, logs: receipt.logs, eventName: 'RequestCreated' as never, strict: false }) as unknown as { args: { id: bigint } }[]
      return { tx: hash, requestId: ev[0]?.args.id ?? null }
    },
    async requestClose(positionId) {
      return (await write('requestClose', [positionId, 0n])).hash
    },
    async cancel(requestId) {
      return (await write('cancelRequest', [requestId])).hash
    },
    closeOf: positionId => o.closedTrades(agent).find(t => t.positionId === positionId && t.kind !== 'opened' && t.kind !== 'cancelled') ?? null,
    cancelledOf: requestId => o.closedTrades(agent).find(t => t.kind === 'cancelled' && t.requestId === requestId) ?? null,
    async fund(v) {
      if (!o.keeper || Date.now() - lastFundAt < 60_000) return null
      const notes: string[] = []
      const gasNeed = o.topUpGasWei ?? 2n * 10n ** 17n // 0.2 testnet USDC
      if (v.gasWei < gasNeed / 4n) {
        lastFundAt = Date.now()
        const hash = await o.keeper.sendTransaction({ to: agent, value: gasNeed, account: o.keeper.account, chain: o.keeper.chain, data: '0x' })
        await mined(hash)
        notes.push(`gas from the keeper (${hash})`)
      }
      const usdcNeed = o.topUpUsdc ?? 10_000n * 10n ** 6n
      if (v.usdc < usdcNeed / 10n) {
        lastFundAt = Date.now()
        const data = encodeFunctionData({ abi: TEST_USDC_ABI, functionName: 'mint', args: [agent, usdcNeed - v.usdc] })
        const hash = await o.keeper.sendTransaction({ to: o.usdc, data, account: o.keeper.account, chain: o.keeper.chain })
        await mined(hash)
        notes.push(`${Number(usdcNeed - v.usdc) / 1e6} tUSDC minted (${hash})`)
      }
      return notes.length ? notes.join('; ') : null
    },
  }
}
