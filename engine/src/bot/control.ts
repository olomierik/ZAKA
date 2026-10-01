// The owner's controls (POST /v1/bot/control): switch between paper and live
// trading, or sell every live position. Each request carries a message
// signed by the owner's wallet (BOT_OWNER_ADDRESS): the engine rebuilds the
// exact text (api/_marketProtocol.ts botControlMessage) and checks the
// signature, for ordinary wallets and contract wallets (ERC-1271/6492)
// alike. A signature is good for 5 minutes and once.

import { createPublicClient, fallback, http, isAddress, isHex, type Address, type Hex } from 'viem'
import { botControlMessage, type BotControl } from '../../../api/_marketProtocol'
import { ARC } from '../trading/live'
import { isTier } from './tiers'

export const MAX_AGE_MS = 5 * 60_000

export interface ControlRequest { control: BotControl; at: number; signature: Hex }

/** The request's shape, or why it's refused. */
export function parseControl(body: unknown): ControlRequest | string {
  if (!body || typeof body !== 'object') return 'expected a JSON object'
  const b = body as Record<string, unknown>
  const at = Number(b.at)
  if (!Number.isFinite(at)) return 'missing "at"'
  if (typeof b.signature !== 'string' || !isHex(b.signature) || b.signature.length < 132) return 'missing or bad "signature"'
  if (b.action === 'mode' && (b.mode === 'paper' || b.mode === 'live')) return { control: { action: 'mode', mode: b.mode }, at, signature: b.signature as Hex }
  if (b.action === 'close-live') return { control: { action: 'close-live' }, at, signature: b.signature as Hex }
  if (b.action === 'grant-tier') {
    const days = Number(b.days)
    if (typeof b.email !== 'string' || !b.email.includes('@')) return 'missing "email"'
    if (!isTier(b.tier)) return 'unknown tier'
    if (!Number.isInteger(days) || days < 0 || days > 3_660) return '"days" must be a whole number from 0 to 3660'
    return { control: { action: 'grant-tier', email: b.email.trim().toLowerCase(), tier: b.tier, days }, at, signature: b.signature as Hex }
  }
  return 'unknown action'
}

type Verify = (a: { address: Address; message: string; signature: Hex }) => Promise<boolean>

export class ControlVerifier {
  private used = new Map<string, number>()
  private verifyMessage: Verify

  constructor(readonly owner: Address | null, readUrls: string[], verify?: Verify) {
    this.verifyMessage = verify ?? (() => {
      const client = createPublicClient({ chain: ARC, transport: fallback(readUrls.map(u => http(u, { timeout: 10_000 }))) })
      return a => client.verifyMessage(a)
    })()
  }

  /** Whether `address` signed `message` (a wallet linking itself to an account). */
  signedBy(address: Address, message: string, signature: Hex): Promise<boolean> {
    return this.verifyMessage({ address, message, signature }).catch(() => false)
  }

  /** null when the owner signed this request; otherwise why not. */
  verify(r: ControlRequest, now = Date.now()): Promise<string | null> {
    return this.verifyText(botControlMessage(r.control, r.at), r.at, r.signature, now)
  }

  /** null when the owner signed `message` (made at `at`, within 5 minutes, used once); otherwise why not. The signal engine's controls use it too. */
  async verifyText(message: string, at: number, signature: Hex, now = Date.now()): Promise<string | null> {
    if (!this.owner || !isAddress(this.owner)) return 'no owner wallet is configured on the engine (BOT_OWNER_ADDRESS)'
    if (Math.abs(now - at) > MAX_AGE_MS) return 'the signature is too old (or the clock is off); sign again'
    const key = signature.toLowerCase()
    if (this.used.has(key)) return 'this signature was already used; sign again'
    const ok = await this.verifyMessage({ address: this.owner, message, signature }).catch(() => false)
    if (!ok) return "not signed by the owner's wallet"
    this.used.set(key, now)
    for (const [k, t] of this.used) if (now - t > MAX_AGE_MS * 2) this.used.delete(k)
    return null
  }
}
