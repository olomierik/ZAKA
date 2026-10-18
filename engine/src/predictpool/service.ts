// The prediction pool on the engine (Arc testnet only): the pool keeper's wallet (made here, its key encrypted under
// BOT_WALLET_SECRET; it signs every price and settlement and sends the keeper's transactions), its gas (sent from the
// futures keeper's wallet), the deployment, and the keeper (keeper.ts).
//
//   GET /v1/predict/pool/status             the deployment, the keeper, what's still missing
//   GET /v1/predict/pool/state              the pool (cash, queue, tracked P&L, fees) and the markets it has traded
//   GET /v1/predict/pool/fills?account=0x…  fills, refunds and payouts, newest first: one trader's, or everyone's
//
// Settings (Railway): PREDICT_POOL=off stops it. PREDICT_POOL_AUTODEPLOY=off leaves deploying to someone else.
// PREDICT_POOL_ADDRESS (+ PREDICT_POOL_BLOCK) uses a pool deployed elsewhere (its signer must be this keeper).

import { createWalletClient, getAddress, http, isAddress, parseEther, type Account, type Address, type Chain, type PublicClient, type Transport, type WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { BotWallet, WalletVault } from '../bot/userLive'
import type { PerpsService, Settings } from '../perps/service'
import { ARC_TESTNET, TESTNET_RPCS } from '../perps/shared'
import { errMsg, log } from '../log'
import { POOL_DEPLOY_GAS_USDC, deployPool, verifyPool, type PoolDeployStore } from './deploy'
import { PredictPoolKeeper, type PoolMarketData } from './keeper'
import { PREDICT_POOL_ABI } from './abi'
import type { PredictPoolDeployment, PredictPoolStatus } from './shared'

const KEEPER_ID = 'predict-pool-keeper'
const KEY_DEPLOYMENT = 'predict-pool-testnet'
/** Gas the keeper is topped up to from the futures keeper, and below what. */
const GAS_TOPUP = 0.5
const GAS_LOW = 0.15

export interface PredictPoolServiceOptions {
  settings: Settings
  vault: WalletVault | null
  perps: PerpsService
  data: PoolMarketData
  env?: Record<string, string | undefined>
  /** How often the keeper runs (ms); the deployment step runs every 15 seconds. */
  keeperEveryMs?: number
  stepEveryMs?: number
}

export class PredictPoolService {
  keeper: PredictPoolKeeper | null = null
  deployment: PredictPoolDeployment | null = null
  keeperAddress: Address | null = null
  gasUsdc: number | null = null
  waiting: string | null = 'starting'
  private wallet: WalletClient<Transport, Chain, Account> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTopup = 0
  private env: Record<string, string | undefined>

  constructor(private o: PredictPoolServiceOptions) {
    this.env = o.env ?? process.env
  }

  private get client(): PublicClient | null {
    return this.o.perps.algoAccess()?.client ?? null
  }

  async start() {
    await this.setupKeeper().catch(e => { this.waiting = `keeper not set up: ${errMsg(e)}`; log.warn('predict pool: keeper not set up', { error: errMsg(e) }) })
    void this.step()
    this.timer = setInterval(() => void this.step(), this.o.stepEveryMs ?? 15_000)
    log.info('predict pool: started', { keeper: this.keeperAddress })
  }

  stop() {
    this.keeper?.stop()
    if (this.timer) clearInterval(this.timer)
  }

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
      log.info('predict pool: keeper wallet made', { address: w.address })
    }
    const account = privateKeyToAccount(this.o.vault.open(w, KEEPER_ID))
    this.keeperAddress = account.address
    const rpcs = (this.env.PERPS_RPC?.split(',').map(s => s.trim()).filter(Boolean)) ?? [...TESTNET_RPCS]
    this.wallet = createWalletClient({ account, chain: ARC_TESTNET, transport: http(rpcs[0], { timeout: 15_000 }) })
  }

  private store(): PoolDeployStore {
    return {
      get: async () => {
        const s = await this.o.settings.getSetting(KEY_DEPLOYMENT)
        return s ? JSON.parse(s) as PredictPoolDeployment : null
      },
      set: async d => { await this.o.settings.setSetting(KEY_DEPLOYMENT, JSON.stringify(d)) },
    }
  }

  /** The futures keeper sends the pool keeper gas when it runs low (at most every 5 minutes). */
  private async topUp() {
    const funder = this.o.perps.algoAccess()?.keeper
    if (!funder || !this.keeperAddress || Date.now() - this.lastTopup < 5 * 60_000) return
    if ((this.gasUsdc ?? 0) >= GAS_LOW) return
    const have = this.client ? Number(await this.client.getBalance({ address: funder.account.address })) / 1e18 : 0
    if (have < GAS_TOPUP + 0.1) return
    this.lastTopup = Date.now()
    const hash = await funder.sendTransaction({ to: this.keeperAddress, value: parseEther(String(GAS_TOPUP)), account: funder.account, chain: funder.chain, data: '0x' })
    await this.client?.waitForTransactionReceipt({ hash, timeout: 60_000 })
    log.info('predict pool: keeper gas from the futures keeper', { tx: hash })
  }

  private async step() {
    const client = this.client
    if (!this.o.vault) return // setupKeeper said why
    try {
      if (!client) { this.waiting = 'futures (PERPS) are off, and the pool runs on their testnet USDC'; return }
      if (this.keeperAddress) {
        this.gasUsdc = Number(await client.getBalance({ address: this.keeperAddress })) / 1e18
        await this.topUp().catch(e => log.warn('predict pool: gas top-up failed', { error: errMsg(e) }))
        this.gasUsdc = Number(await client.getBalance({ address: this.keeperAddress })) / 1e18
      }
      const override = this.env.PREDICT_POOL_ADDRESS
      if (override && isAddress(override)) {
        if (!this.deployment) {
          const pool = getAddress(override)
          const [token, usdc, signer] = await Promise.all([
            client.readContract({ address: pool, abi: PREDICT_POOL_ABI, functionName: 'token' }),
            client.readContract({ address: pool, abi: PREDICT_POOL_ABI, functionName: 'usdc' }),
            client.readContract({ address: pool, abi: PREDICT_POOL_ABI, functionName: 'signer' }),
          ])
          this.deployment = { chainId: ARC_TESTNET.id, pool, token, usdc, signer, block: Number(this.env.PREDICT_POOL_BLOCK) || null, at: null }
        }
      } else if (!this.deployment?.pool) {
        this.deployment = await this.store().get()
        if (!this.deployment?.pool) {
          if (!this.wallet || !this.keeperAddress) return
          const usdc = this.o.perps.deployment?.usdc
          if (!usdc || !isAddress(usdc)) { this.waiting = 'waiting for the futures’ test USDC to be deployed'; return }
          if (/^(0|off|false|no)$/i.test(this.env.PREDICT_POOL_AUTODEPLOY?.trim() ?? '')) {
            this.waiting = 'the pool isn’t deployed yet, and deploying from the engine is switched off (PREDICT_POOL_AUTODEPLOY)'
            return
          }
          if ((this.gasUsdc ?? 0) < POOL_DEPLOY_GAS_USDC) {
            this.waiting = `the pool keeper ${this.keeperAddress} needs testnet USDC for gas (it gets it from the futures keeper, or faucet.circle.com)`
            return
          }
          this.waiting = 'deploying the prediction pool on Arc testnet'
          this.deployment = await deployPool({ client, wallet: this.wallet, store: this.store(), usdc: getAddress(usdc), owner: this.ownerOverride() })
        }
        const wrong = await verifyPool(client, this.deployment, this.keeperAddress)
        if (wrong) log.error('predict pool: deployment check failed', { error: wrong })
      }
      if (this.deployment?.pool && this.wallet && !this.keeper) {
        this.keeper = new PredictPoolKeeper({
          client, wallet: this.wallet, pool: this.deployment.pool as Address, fromBlock: this.deployment.block, data: this.o.data,
          everyMs: this.o.keeperEveryMs,
        })
        await this.keeper.readState().catch(() => null)
        this.keeper.start()
        log.info('predict pool: keeper running', { pool: this.deployment.pool, keeper: this.keeperAddress })
      }
      this.waiting = this.keeper && (this.gasUsdc ?? 0) < 0.02
        ? `the pool keeper ${this.keeperAddress} is almost out of testnet USDC for gas`
        : this.keeper ? null : this.waiting
    } catch (e) {
      this.waiting = `the pool’s step failed: ${errMsg(e)}`
      log.warn('predict pool: step failed', { error: errMsg(e) })
    }
  }

  private ownerOverride(): Address | undefined {
    const o = this.env.PERPS_OWNER
    return o && isAddress(o) ? getAddress(o) : undefined
  }

  status(): PredictPoolStatus {
    const k = this.keeper
    return {
      enabled: true, chainId: ARC_TESTNET.id, deployment: this.deployment, waiting: this.waiting,
      keeper: {
        address: this.keeperAddress, gasUsdc: this.gasUsdc, lastRun: k?.lastRun ?? null,
        filled: k?.filled ?? 0, rejected: k?.rejected ?? 0, settled: k?.settled ?? 0, errors: k?.errors ?? 0, lastError: k?.lastError ?? null,
      },
    }
  }

  /** GET /v1/predict/pool/… (null for any other path). */
  handle(url: URL, json: (status: number, body: unknown, cache?: string) => Response): Response | null {
    const p = url.pathname
    if (p === '/v1/predict/pool/status') return json(200, this.status(), 'public, max-age=5')
    if (p === '/v1/predict/pool/state') return json(200, { state: this.keeper?.state ?? null, markets: this.keeper?.marketViews() ?? [] }, 'public, max-age=3')
    if (p === '/v1/predict/pool/fills') {
      const account = url.searchParams.get('account')
      if (account && !isAddress(account)) return json(400, { error: 'not an address' })
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50))
      return json(200, { fills: this.keeper?.list(account, limit) ?? [] }, account ? 'no-store' : 'public, max-age=3')
    }
    return null
  }
}
