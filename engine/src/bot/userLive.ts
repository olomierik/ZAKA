// Live trading for visitors' bots (owner's request, 2026-09-30: "the self
// learning starts in paper trading, and once the bot improves, toggle LIVE
// for the same bot"; "a 2% fee on each trade's profit to the platform fee
// wallet; losing trades aren't charged").
//
//   ready    a bot can go live once its paper record shows it: 20+ closed
//            paper trades, a 55%+ win rate, a profit factor of 1.2+ and a
//            net profit (READY). The owner must be signed in with a
//            verified email.
//   wallet   each live bot has its own wallet, made on the engine: the
//            owner funds it with USDC on Arc, and the engine trades from it
//            while every device is off. Its key is encrypted with
//            AES-256-GCM under BOT_WALLET_SECRET (32 bytes, hex, set on
//            Railway by the owner) and never leaves the engine. Without the
//            secret, no bot can go live. This makes the engine the custodian
//            of what owners deposit: keep the secret and the database safe.
//   trades   the bot wallet's existing executor and trader (trading/live.ts,
//            bot/liveTrader.ts): Uniswap v4 pools against USDC, each trade
//            sized for the bot's profit target, capped at $50 and at 20% of
//            what the wallet is worth (read before each buy), the bot's own
//            learned exits, the rug guard, retries on a failing sale. Every
//            buy is simulated with its sale first, as the bot's wallet, and
//            sent only if both go through (trading/preflight.ts)
//   fee      a winning live trade sends 2% of its profit to the platform
//            fee wallet (0x2742…86Bb) right after it closes; a loss pays
//            nothing. Paper bots are charged the same fee virtually, so
//            their results read like live ones.
//   money out  a withdrawal needs a code emailed to the owner, bound to
//            that amount and address (bot/users.ts challenge)

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Address, Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { BotReadiness } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import type { PoolInfo } from '../dex/pools'
import { errMsg, log } from '../log'
import type { LiveExecutor } from '../trading/live'
import { stats, type Position } from '../trading/paper'
import { emptyLedger, FUNDER, knownFunders, scanFunding, type FundingLedger } from './funders'
import { LiveTrader, type LiveLimits } from './liveTrader'

export const READY = { minTrades: 20, minWinRate: 0.55, minProfitFactor: 1.2 }
export const USER_LIVE = {
  maxTradeUsd: 50,
  /** A bot goes live with at least this in its wallet. */
  minBalanceUsd: 10,
  /** Never traded: gas for the exits and the fee. */
  reserveUsd: 1,
  maxOpen: 3,
  maxOpenScalp: 2,
  slippageBps: 1_000,
  exitSlippageBps: [1_500, 3_500, 6_000],
  /** Every buy is simulated with its sale first (trading/preflight.ts); none whose round trip costs more than this. */
  maxRoundTripPct: 20,
  /** No trade over this share of what the wallet is worth (its USDC, read before the buy, plus open trades). */
  maxShareOfBalance: 0.2,
  /** The day's loss limit: this share of the wallet, between the two amounts. */
  dailyLossPct: 10, dailyLossMinUsd: 5, dailyLossMaxUsd: 100,
  /** Live stops (back to paper) once the wallet and its open trades are worth this share of what it went live with. */
  stopBelowPct: 50,
}
export const PROFIT_FEE = { bps: 200, wallet: '0x274262A0321A0701b0A46a3576e07aE881c286Bb' as Address }

/** The platform's share of a trade's profit: 2% of a win, nothing on a loss. */
export const profitFee = (pnlUsd: number | null) => (pnlUsd !== null && pnlUsd > 0 ? Math.round(pnlUsd * PROFIT_FEE.bps) / 10_000 : 0)

/** Whether a bot's paper record is good enough to trade live. */
/**
 * Going live on the team's record (2026-09-30, owner: "the time a new bot
 * takes to start trading; they work together as a team"): the team's trades on
 * the bot's strategies, the last 7 days (every bot's, paper and live, one per
 * signal), meet READY, and the bot has 5 closed paper trades of its own
 * without a net loss. Otherwise its own 20.
 */
export const TEAM_READY = { minOwn: 5, days: 7 }

export function readinessWithTeam(positions: Position[], team: Position[]): BotReadiness {
  const own = readiness(positions)
  const ts = stats(team)
  const pf = ts.profitFactor === Infinity ? 99 : ts.profitFactor
  const teamOk = ts.closed >= READY.minTrades && (ts.winRate ?? 0) >= READY.minWinRate && (pf ?? 0) >= READY.minProfitFactor && ts.totalPnlUsd > 0
  const viaTeam = teamOk && own.trades >= TEAM_READY.minOwn && own.pnlUsd >= 0
  return {
    ...own, ok: own.ok || viaTeam, via: own.ok ? 'own' : viaTeam ? 'team' : null,
    team: { trades: ts.closed, winRate: ts.winRate, profitFactor: pf, pnlUsd: ts.totalPnlUsd, ok: teamOk },
    need: { ...own.need, minOwnWithTeam: TEAM_READY.minOwn },
  }
}

export function readiness(positions: Position[]): BotReadiness {
  const s = stats(positions.filter(p => p.mode !== 'live' && p.status === 'closed'))
  const pf = s.profitFactor === Infinity ? 99 : s.profitFactor
  const ok = s.closed >= READY.minTrades && (s.winRate ?? 0) >= READY.minWinRate && (pf ?? 0) >= READY.minProfitFactor && s.totalPnlUsd > 0
  return { ok, trades: s.closed, winRate: s.winRate, profitFactor: pf, pnlUsd: s.totalPnlUsd, need: READY }
}

export interface BotWallet {
  address: string
  /** v1:base64(iv ‖ tag ‖ ciphertext), the account id as associated data. */
  enc: string
  createdAt: number
  /** When it last went live, and the wallet's balance then (the stop-loss for the whole wallet). */
  since?: number | null
  startBalanceUsd?: number | null
  feesPaidUsd?: number
  /** Its deposits, read from the chain (bot/funders.ts): who may receive a withdrawal without an emailed code. */
  funding?: FundingLedger
}

/** Makes and opens bots' wallets with one 32-byte secret. */
export class WalletVault {
  private key: Buffer
  constructor(secretHex: string) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(secretHex)) throw new Error('BOT_WALLET_SECRET must be 32 bytes as 64 hex characters')
    this.key = Buffer.from(secretHex.replace(/^0x/, ''), 'hex')
  }
  create(accountId: string, now = Date.now()): BotWallet {
    const pk = generatePrivateKey()
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.key, iv)
    c.setAAD(Buffer.from(accountId))
    const ct = Buffer.concat([c.update(Buffer.from(pk.slice(2), 'hex')), c.final()])
    return { address: privateKeyToAccount(pk).address.toLowerCase(), enc: `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`, createdAt: now, feesPaidUsd: 0 }
  }
  open(w: BotWallet, accountId: string): Hex {
    const raw = Buffer.from(w.enc.replace(/^v1:/, ''), 'base64')
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12))
    d.setAAD(Buffer.from(accountId))
    d.setAuthTag(raw.subarray(12, 28))
    const pk = `0x${Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('hex')}` as Hex
    if (privateKeyToAccount(pk).address.toLowerCase() !== w.address.toLowerCase()) throw new Error('wallet key does not match its address')
    return pk
  }
}

export interface LiveHooks {
  positions: () => Position[]
  save: (p: Position) => void
  params: ConstructorParameters<typeof LiveTrader>[0]['params']
}

/** Every live bot's trader, balance and money-out, on the engine. */
export class UserLive {
  private traders = new Map<string, LiveTrader>()
  private balances = new Map<string, { usd: number; at: number }>()

  private scanning = new Map<string, Promise<FundingLedger>>()

  /** `rpc`: reads the wallets' deposits (the funders a withdrawal without an emailed code may go to). */
  constructor(private o: { vault: WalletVault | null; makeExec: (key: Hex) => LiveExecutor; pools: (token: string) => PoolInfo | null; why?: string | null; rpc?: Rpc | null }) {}

  /** The wallets that funded this bot wallet (its deposits scanned up to now; one scan at a time per wallet). Null without a way to read the chain. */
  async funders(w: BotWallet, now = Date.now()): Promise<{ address: string; usd: number }[] | null> {
    const rpc = this.o.rpc
    if (!rpc) return null
    let run = this.scanning.get(w.address)
    if (!run) {
      run = (async () => {
        const l = w.funding ?? emptyLedger()
        // A new ledger starts before the wallet was made (counting blocks generously).
        const head = l.scannedTo ? 0 : Number(BigInt(await rpc.call<string>('eth_blockNumber', [])))
        const start = l.scannedTo ? l.scannedTo + 1 : Math.max(0, head - Math.ceil((now - w.createdAt) / FUNDER.msPerBlock) - FUNDER.margin)
        return scanFunding(rpc, w.address, l, start)
      })().finally(() => this.scanning.delete(w.address))
      this.scanning.set(w.address, run)
    }
    try {
      w.funding = await run
      return knownFunders(w.funding)
    } catch (e) { log.warn('user live: funding scan failed', { error: errMsg(e) }); return w.funding ? knownFunders(w.funding) : null }
  }

  get available(): { ok: boolean; why: string | null } {
    return this.o.vault ? { ok: true, why: null } : { ok: false, why: this.o.why ?? 'live trading for bots isn\'t switched on yet: the platform owner sets BOT_WALLET_SECRET on the engine' }
  }

  createWallet(accountId: string, now = Date.now()): BotWallet | string {
    if (!this.o.vault) return this.available.why!
    return this.o.vault.create(accountId, now)
  }

  /** The bot's trader (made once), or null when it has no wallet or the engine can't trade live. */
  trader(accountId: string, wallet: BotWallet | undefined, hooks: LiveHooks): LiveTrader | null {
    const have = this.traders.get(accountId)
    if (have) return have
    if (!this.o.vault || !wallet) return null
    let exec: LiveExecutor
    try { exec = this.o.makeExec(this.o.vault.open(wallet, accountId)) } catch (e) { log.error('user live: wallet did not open', { error: errMsg(e) }); return null }
    const limits: LiveLimits = { maxTradeUsd: USER_LIVE.maxTradeUsd, dailyLossUsd: USER_LIVE.dailyLossMinUsd, maxOpen: USER_LIVE.maxOpen, maxOpenScalp: USER_LIVE.maxOpenScalp, slippageBps: USER_LIVE.slippageBps, exitSlippageBps: USER_LIVE.exitSlippageBps, reserveUsd: USER_LIVE.reserveUsd, preflight: true, maxRoundTripPct: USER_LIVE.maxRoundTripPct, maxShareOfBalance: USER_LIVE.maxShareOfBalance }
    const t = new LiveTrader({ exec, limits, positions: hooks.positions, params: hooks.params, save: hooks.save })
    t.setPools(this.o.pools)
    this.traders.set(accountId, t)
    return t
  }

  existing(accountId: string) { return this.traders.get(accountId) ?? null }

  /** The wallet's USDC (cached 15s unless `fresh`); also sets the day's loss limit from it. */
  async balance(accountId: string, trader: LiveTrader | null, fresh = false): Promise<number | null> {
    const hit = this.balances.get(accountId)
    if (!fresh && hit && Date.now() - hit.at < 15_000) return hit.usd
    if (!trader) return hit?.usd ?? null
    try {
      await trader.refreshBalance()
      const usd = trader.balance!.usd
      this.balances.set(accountId, { usd, at: Date.now() })
      trader.limits.dailyLossUsd = Math.min(USER_LIVE.dailyLossMaxUsd, Math.max(USER_LIVE.dailyLossMinUsd, Math.round(usd * USER_LIVE.dailyLossPct) / 100))
      return usd
    } catch (e) { log.debug('user live: balance read failed', { error: errMsg(e) }); return hit?.usd ?? null }
  }

  cachedBalance(accountId: string) { return this.balances.get(accountId)?.usd ?? null }

  /** Sends a closed winning trade's fee (p.feeDue) to the platform fee wallet. Returns the tx hash, or throws. */
  async payFee(trader: LiveTrader, p: Position): Promise<string> {
    const fee = p.feeDue ?? 0
    const f = await trader.executor.sendUsdc(PROFIT_FEE.wallet, fee)
    p.txs = [...(p.txs ?? []), { kind: 'fee', hash: f.hash, at: f.at, usd: fee, gasUsd: f.gasUsd }]
    p.feeDue = 0
    trader.event({ kind: 'sell', token: p.token, symbol: p.symbol, hash: f.hash, text: `Platform fee: $${fee.toFixed(4)} (2% of the $${((p.pnlUsd ?? 0) + (p.feeUsd ?? 0)).toFixed(2)} profit on $${p.symbol})` })
    return f.hash
  }

  /** Sends `usd` of the wallet's USDC to `to` (the owner confirmed it: an emailed code, or the passcode to a wallet that funded it). */
  async withdraw(accountId: string, trader: LiveTrader, to: Address, usd: number): Promise<{ hash: string }> {
    const f = await trader.executor.sendUsdc(to, usd)
    trader.event({ kind: 'mode', hash: f.hash, text: `Withdrew $${usd.toFixed(2)} to ${to}` })
    this.balances.delete(accountId)
    return { hash: f.hash }
  }
}
