// ARCSENSE futures on the engine: RedStone's signed prices (the chart and the keeper's prices),
// the keeper wallet (made here, its key encrypted under BOT_WALLET_SECRET like bots' wallets),
// the Arc testnet deployment, and the keeper.
//
//   GET /v1/perps/status                    deployment, keeper, oracle; what's still missing
//   GET /v1/perps/prices                    every pair's latest signed price and its 24 hours
//   GET /v1/perps/candles?feed=BTC&tf=1m    the chart (perps/candles.ts)
//   GET /v1/perps/state                     the contract as last read: markets and the pool
//   GET /v1/perps/trades?account=0x…        opens and closes, newest first: one trader's, or everyone's
//
// Settings (Railway): PERPS=off stops all of it. PERPS_AUTODEPLOY=off leaves deploying to
// someone else. PERPS_ADDRESS (+ PERPS_ORACLE, PERPS_USDC, PERPS_BLOCK) uses contracts deployed
// elsewhere. PERPS_OWNER owns new deployments (default: the owner's deploy wallet).
// PERPS_RPC: comma-separated testnet RPCs.

import { createPublicClient, createWalletClient, fallback, getAddress, http, isAddress, type Account, type Address, type Chain, type PublicClient, type Transport, type WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { BotWallet, WalletVault } from '../bot/userLive'
import { errMsg, log } from '../log'
import { PriceCandles, type CandleStore } from './candles'
import { DEPLOY_GAS_USDC, deployStep, verifyDeployment, type DeployStore } from './deploy'
import { PerpsEvents } from './events'
import { PerpsKeeper } from './keeper'
import { RedstoneFeed } from './redstone'
import {
  ARC_TESTNET, FEEDS, PERPS_TFS, REDSTONE, TESTNET_RPCS, symbolOf,
  type Feed, type PerpsDeployment, type PerpsPricesResponse, type PerpsStateResponse, type PerpsStatus, type PerpsTf,
} from './shared'

export interface Settings {
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string): Promise<void>
}

export interface PerpsServiceOptions {
  settings: Settings
  candleStore: CandleStore | null
  vault: WalletVault | null
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
}

const KEEPER_ID = 'perps-keeper'
const KEY_DEPLOYMENT = 'perps-testnet'

export class PerpsService {
  readonly feed: RedstoneFeed
  readonly candles: PriceCandles
  keeper: PerpsKeeper | null = null
  events: PerpsEvents | null = null
  deployment: PerpsDeployment | null = null
  keeperAddress: Address | null = null
  gasUsdc: number | null = null
  waiting: string | null = 'starting'
  private client: PublicClient
  private wallet: WalletClient<Transport, Chain, Account> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private eventsTimer: ReturnType<typeof setInterval> | null = null
  private env: Record<string, string | undefined>

  constructor(private o: PerpsServiceOptions) {
    this.env = o.env ?? process.env
    this.feed = new RedstoneFeed({
      feeds: FEEDS, signers: REDSTONE.signers, threshold: REDSTONE.threshold,
      gateways: REDSTONE.gateways, dataService: REDSTONE.dataService, fetch: o.fetch,
    })
    this.candles = new PriceCandles(o.candleStore, FEEDS)
    const rpcs = (this.env.PERPS_RPC?.split(',').map(s => s.trim()).filter(Boolean)) ?? [...TESTNET_RPCS]
    this.client = createPublicClient({
      chain: ARC_TESTNET,
      transport: fallback(rpcs.map(u => http(u, { timeout: 10_000, retryCount: 1 }))),
      batch: { multicall: true },
    }) as PublicClient
  }

  async start() {
    this.feed.onSnapshot(s => {
      for (const f of Object.values(s.feeds)) this.candles.tick(f.feed, f.price, f.ts)
    })
    await this.candles.load().catch(e => log.warn('perps: candles not loaded', { error: errMsg(e) }))
    this.feed.start()
    await this.setupKeeper().catch(e => { this.waiting = `keeper not set up: ${errMsg(e)}`; log.warn('perps: keeper not set up', { error: errMsg(e) }) })
    void this.step()
    this.timer = setInterval(() => void this.step(), 60_000)
    log.info('perps: started', { keeper: this.keeperAddress, deployment: this.deployment?.perps ?? null })
  }

  stop() {
    this.feed.stop()
    this.keeper?.stop()
    if (this.timer) clearInterval(this.timer)
    if (this.eventsTimer) clearInterval(this.eventsTimer)
  }

  /** The keeper's wallet: made once, its key encrypted under BOT_WALLET_SECRET. */
  private async setupKeeper() {
    if (!this.o.vault) {
      this.waiting = 'the engine has no wallet secret (BOT_WALLET_SECRET), so it has no keeper wallet'
      return
    }
    let w: BotWallet | null = null
    const saved = await this.o.settings.getSetting(KEEPER_ID)
    if (saved) w = JSON.parse(saved) as BotWallet
    if (!w) {
      w = this.o.vault.create(KEEPER_ID)
      await this.o.settings.setSetting(KEEPER_ID, JSON.stringify(w))
      log.info('perps: keeper wallet made', { address: w.address })
    }
    const account = privateKeyToAccount(this.o.vault.open(w, KEEPER_ID))
    this.keeperAddress = account.address
    const rpcs = (this.env.PERPS_RPC?.split(',').map(s => s.trim()).filter(Boolean)) ?? [...TESTNET_RPCS]
    // Transactions go to one endpoint (a fallback could send one twice).
    this.wallet = createWalletClient({ account, chain: ARC_TESTNET, transport: http(rpcs[0], { timeout: 15_000 }) })
  }

  private deployStore(): DeployStore {
    return {
      get: async () => {
        const s = await this.o.settings.getSetting(KEY_DEPLOYMENT)
        return s ? JSON.parse(s) as PerpsDeployment : null
      },
      set: async d => { await this.o.settings.setSetting(KEY_DEPLOYMENT, JSON.stringify(d)) },
    }
  }

  /** Every minute: the deployment, then the keeper once there is one. */
  private async step() {
    try {
      if (this.keeperAddress) {
        const bal = await this.client.getBalance({ address: this.keeperAddress })
        this.gasUsdc = Number(bal) / 1e18
      }
      const override = this.env.PERPS_ADDRESS
      if (override && isAddress(override)) {
        this.deployment = {
          chainId: ARC_TESTNET.id, perps: getAddress(override),
          oracle: this.env.PERPS_ORACLE && isAddress(this.env.PERPS_ORACLE) ? getAddress(this.env.PERPS_ORACLE) : null,
          usdc: this.env.PERPS_USDC && isAddress(this.env.PERPS_USDC) ? getAddress(this.env.PERPS_USDC) : null,
          block: Number(this.env.PERPS_BLOCK) || null, seeded: true, at: null,
        }
      } else {
        this.deployment = await this.deployStore().get()
        const done = this.deployment?.perps && this.deployment.seeded
        if (!done) {
          if (!this.wallet || !this.keeperAddress) return
          if (/^(0|off|false|no)$/i.test(this.env.PERPS_AUTODEPLOY?.trim() ?? '')) {
            this.waiting = 'futures aren\'t deployed yet, and deploying from the engine is switched off (PERPS_AUTODEPLOY)'
            return
          }
          if ((this.gasUsdc ?? 0) < DEPLOY_GAS_USDC) {
            this.waiting = `the keeper wallet ${this.keeperAddress} needs testnet USDC for gas (at least ${DEPLOY_GAS_USDC}): get it from faucet.circle.com (Arc Testnet)`
            return
          }
          this.waiting = 'deploying the futures contracts on Arc testnet'
          this.deployment = await deployStep({ client: this.client, wallet: this.wallet, store: this.deployStore(), owner: this.ownerOverride() })
          const wrong = await verifyDeployment(this.client, this.deployment)
          if (wrong) log.error('perps: deployment check failed', { error: wrong })
        }
      }
      if (this.deployment?.perps && this.wallet && !this.keeper) {
        this.keeper = new PerpsKeeper({ client: this.client, wallet: this.wallet, perps: this.deployment.perps as Address, feed: this.feed })
        this.keeper.start()
        log.info('perps: keeper running', { perps: this.deployment.perps, keeper: this.keeperAddress })
      }
      if (this.deployment?.perps && !this.events) {
        const ev = new PerpsEvents(this.client, this.deployment.perps as Address, this.deployment.block)
        this.events = ev
        const pollEvents = () => {
          const ms = this.keeper?.state?.markets
          if (ms) ev.setMarkets(PerpsEvents.feedsOf(ms))
          else if (!ms) return // the market names first
          void ev.poll()
        }
        this.eventsTimer = setInterval(pollEvents, 4_000)
      }
      this.waiting = this.keeper && (this.gasUsdc ?? 0) < 0.05
        ? `the keeper wallet ${this.keeperAddress} is almost out of testnet USDC for gas: top it up at faucet.circle.com (Arc Testnet)`
        : null
    } catch (e) {
      this.waiting = `deployment step failed: ${errMsg(e)}`
      log.warn('perps: step failed', { error: errMsg(e) })
    }
  }

  private ownerOverride(): Address | undefined {
    const o = this.env.PERPS_OWNER
    return o && isAddress(o) ? getAddress(o) : undefined
  }

  /** What ARCDEX Algo's testnet executor borrows (engine/src/algo): the chain client, the keeper's
   * wallet (it funds the agent: gas, and test USDC it mints) and the markets in id order. */
  algoAccess(): { client: PublicClient; keeper: WalletClient<Transport, Chain, Account> | null; markets: () => string[] } | null {
    return { client: this.client, keeper: this.wallet, markets: () => (this.keeper?.state?.markets ?? []).map(m => symbolOf(m.p.feedId)) }
  }

  status(now = Date.now()): PerpsStatus {
    const last = this.feed.latest()
    return {
      enabled: true,
      chainId: ARC_TESTNET.id,
      deployment: this.deployment,
      waiting: this.waiting,
      keeper: {
        address: this.keeperAddress, gasUsdc: this.gasUsdc,
        lastRun: this.keeper?.lastRun ?? null, executed: this.keeper?.executed ?? 0,
        errors: this.keeper?.errors ?? 0, lastError: this.keeper?.lastError ?? null,
      },
      oracle: {
        lastTs: last?.ts ?? null, ageSec: last ? Math.round((now - last.ts) / 1000) : null,
        fetchedAt: this.feed.fetchedAt, errors: this.feed.errors, gateway: this.feed.gateway(),
      },
    }
  }

  prices(now = Date.now()): PerpsPricesResponse {
    const feeds: PerpsPricesResponse['feeds'] = {}
    for (const f of FEEDS) {
      const s = this.candles.stats(f, now)
      if (s) feeds[f] = s
    }
    return { ts: this.feed.latest()?.ts ?? null, feeds }
  }

  state(): PerpsStateResponse {
    const s = this.keeper?.state
    return {
      at: s?.at ?? Date.now(),
      perps: this.deployment?.perps ?? null,
      markets: (s?.markets ?? []).map((m, id) => ({
        id, feed: symbolOf(m.p.feedId), enabled: m.p.enabled, maxLeverage: Number(m.p.maxLeverage),
        openFeeBps: Number(m.p.openFeeBps), closeFeeBps: Number(m.p.closeFeeBps), liquidationBps: Number(m.p.liquidationBps),
        borrowRatePerHour: String(m.p.borrowRatePerHour), maxOiLong: String(m.p.maxOiLong), maxOiShort: String(m.p.maxOiShort),
        oiLong: String(m.long_.oi), oiShort: String(m.short_.oi),
      })),
      pool: s ? {
        poolAmount: String(s.pool.poolAmount), totalReserved: String(s.pool.totalReserved), totalCollateral: String(s.pool.totalCollateral),
        totalSupply: String(s.pool.totalSupply), paused: s.pool.paused, execFee: String(s.pool.execFee), minCollateral: String(s.pool.minCollateral),
        requestTimeout: s.pool.requestTimeout, maxPriceAge: s.pool.maxPriceAge, lpCooldown: s.pool.lpCooldown,
      } : null,
    }
  }

  /** GET /v1/perps/… (null for any other path). */
  handle(url: URL, json: (status: number, body: unknown, cache?: string) => Response): Response | null {
    const p = url.pathname
    if (p === '/v1/perps/status') return json(200, this.status(), 'public, max-age=5')
    if (p === '/v1/perps/prices') return json(200, this.prices(), 'public, max-age=2')
    if (p === '/v1/perps/state') return json(200, this.state(), 'public, max-age=2')
    if (p === '/v1/perps/trades') {
      const account = url.searchParams.get('account')
      if (account && !isAddress(account)) return json(400, { error: 'not an address' })
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50))
      return json(200, { trades: this.events?.list(account, limit) ?? [] }, account ? 'no-store' : 'public, max-age=3')
    }
    if (p === '/v1/perps/candles') {
      const feed = (url.searchParams.get('feed') ?? '').toUpperCase()
      const tf = (url.searchParams.get('tf') ?? '1m') as PerpsTf
      if (!(FEEDS as readonly string[]).includes(feed)) return json(400, { error: 'unknown feed' })
      if (!PERPS_TFS.includes(tf)) return json(400, { error: 'unknown timeframe' })
      const limit = Math.max(1, Math.min(1_000, Number(url.searchParams.get('limit')) || 500))
      return json(200, { feed, tf, bars: this.candles.candles(feed as Feed, tf, limit) }, 'public, max-age=5')
    }
    return null
  }
}
