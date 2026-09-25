// Launchpad adapters. The core engine knows nothing about any launchpad:
// each adapter says which logs it wants, turns its launch events into a
// LaunchInfo, and (optionally) its own bonding-curve trades into Trades.
// Adding a launchpad = writing one adapter and listing it in main.ts.

import type { RawLog } from '../../../api/_arcLogs'
import type { LaunchInfo, Trade } from '../../../api/_marketProtocol'
import type { Rpc } from '../chain/http'
import type { LogFilterWs } from '../chain/wsProvider'
import type { PoolRegistry } from '../dex/pools'

export interface AdapterContext {
  rpc: Rpc
  pools: PoolRegistry
}

export interface LaunchpadAdapter {
  /** Shown to users as the launchpad, e.g. "ARGUS". */
  readonly name: string
  /** What to stream from the chain for this launchpad. */
  filters(): LogFilterWs[]
  /** Whether a log belongs to this adapter. */
  matches(l: RawLog): boolean
  /** A launch → LaunchInfo. Null for this adapter's other logs. */
  parseLaunch(l: RawLog, ctx: AdapterContext): Promise<LaunchInfo | null>
  /** Trades executed on the launchpad itself (bonding curves), if it has any. */
  parseTrade?(l: RawLog, ctx: AdapterContext): Promise<Trade | null>
}

export class AdapterRegistry {
  constructor(readonly adapters: LaunchpadAdapter[]) {}
  filters(): LogFilterWs[] { return this.adapters.flatMap(a => a.filters()) }
  find(l: RawLog): LaunchpadAdapter | undefined { return this.adapters.find(a => a.matches(l)) }
}

// ── ABI helpers shared by adapters ─────────────────────────────────────

const decoder = new TextDecoder('utf-8', { fatal: false })

/** Printable, trimmed, length-capped — launch metadata is set by anyone
 * and is never trusted (no control characters, no markup tricks). */
export function cleanText(s: string, max = 64): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max)
}

/** An ABI-encoded `string` whose offset sits in head word `headIndex` of
 * `data` (event data or a call result). Null if the encoding is invalid. */
export function abiString(data: string, headIndex: number, maxBytes = 512): string | null {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  const w = (i: number) => hex.slice(i * 64, (i + 1) * 64)
  if (hex.length < (headIndex + 1) * 64) return null
  const offset = Number(BigInt('0x' + w(headIndex)))
  if (!Number.isSafeInteger(offset) || offset % 32 !== 0 || offset * 2 + 64 > hex.length) return null
  const len = Number(BigInt('0x' + hex.slice(offset * 2, offset * 2 + 64)))
  if (!Number.isSafeInteger(len) || len > maxBytes || offset * 2 + 64 + len * 2 > hex.length) return null
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = parseInt(hex.slice(offset * 2 + 64 + i * 2, offset * 2 + 66 + i * 2), 16)
  return decoder.decode(bytes)
}

/** An ERC-20 name()/symbol() result: ABI string, or bytes32 on old tokens. */
export function erc20String(result: string | null | undefined): string | null {
  if (!result || result === '0x') return null
  const hex = result.slice(2)
  if (hex.length === 64) {
    const bytes = hex.match(/../g)!.map(b => parseInt(b, 16)).filter(b => b !== 0)
    return decoder.decode(new Uint8Array(bytes))
  }
  return abiString(result, 0)
}

/** name(), symbol(), decimals() in one batch. */
export async function tokenMeta(rpc: Rpc, token: string): Promise<{ name: string | null; symbol: string | null; decimals: number | null }> {
  const call = (data: string) => ({ method: 'eth_call', params: [{ to: token, data }, 'latest'] })
  const [n, s, d] = await rpc.batch<string>([call('0x06fdde03'), call('0x95d89b41'), call('0x313ce567')]).catch(() => [null, null, null])
  const dec = d && d !== '0x' ? Number(BigInt(d)) : NaN
  return { name: erc20String(n), symbol: erc20String(s), decimals: Number.isInteger(dec) && dec >= 0 && dec <= 36 ? dec : null }
}

/** Only links a browser can safely open as an image. */
export function cleanImage(uri: string | null): string | null {
  if (!uri) return null
  const u = cleanText(uri, 400)
  if (/^ipfs:\/\/[a-zA-Z0-9]+(\/[\w.-]+)*$/.test(u)) return `https://ipfs.io/ipfs/${u.slice(7)}`
  return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null
}
