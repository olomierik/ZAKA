// Signing Hyperliquid actions, exactly as the official Python SDK does (hyperliquid/utils/signing.py), and checked
// against that SDK's own test vectors (scripts/test-hyperliquid.ts).
//
// Two schemes:
// - "L1" actions (orders, cancels, leverage, …): the action is msgpack-encoded (msgpack.ts), followed by the nonce
//   (8 bytes, big-endian), a vault flag (0, or 1 + the vault's 20 bytes) and, when set, 0 + expiresAfter (8 bytes);
//   keccak of that is the "connectionId" of a phantom agent { source: 'a' mainnet | 'b' testnet, connectionId },
//   signed as EIP-712 type Agent in the domain { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: 0x0 }.
// - User-signed actions (transfers, withdrawals, approving an agent or a builder fee, account modes): the action's own
//   fields, signed as EIP-712 type "HyperliquidTransaction:<Name>" in the domain { name: 'HyperliquidSignTransaction',
//   version: '1', chainId: <signatureChainId>, verifyingContract: 0x0 }. The action carries signatureChainId (any chain
//   the wallet signs on; a browser wallet must use its current chain) and hyperliquidChain ('Mainnet' | 'Testnet').
//
// Pitfalls the SDK warns about, handled here: field order matters (actions are built in the SDK's order), numbers go
// as strings without trailing zeros (floatToWire), and addresses are lower-cased before signing.

import { keccak256, type Hex } from 'viem'
import { msgpack, type Packable } from './msgpack'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Signs EIP-712 typed data. The trading wallet's local account and wagmi's signTypedData both fit. */
export interface TypedDataSigner {
  address: `0x${string}`
  signTypedData: (td: TypedData) => Promise<Hex>
}

export interface TypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` }
  types: Record<string, { name: string; type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}

export interface Signature { r: Hex; s: Hex; v: number }

/** A number as Hyperliquid's wire wants it: at most 8 decimals, no trailing zeros, no "-0" (the SDK's float_to_wire). */
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8)
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`floatToWire would round ${x}`)
  let s = rounded.replace(/\.?0+$/, '')
  if (s === '-0' || s === '') s = '0'
  return s
}

/** The SDK's float_to_int(x, power): x × 10^power as an integer, refusing anything that would round. */
export function floatToInt(x: number, power: number): bigint {
  const withDecimals = x * 10 ** power
  if (Math.abs(Math.round(withDecimals) - withDecimals) >= 1e-3) throw new Error(`floatToInt would round ${x}`)
  return BigInt(Math.round(withDecimals))
}

function hexBytes(h: string): Uint8Array {
  const s = h.startsWith('0x') ? h.slice(2) : h
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

function u64(n: number | bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}

/** keccak(msgpack(action) ‖ nonce ‖ vault ‖ expiresAfter): the L1 action's connection id. */
export function actionHash(action: Packable, vaultAddress: string | null, nonce: number, expiresAfter: number | null = null): Hex {
  const parts: Uint8Array[] = [msgpack(action), u64(nonce)]
  if (vaultAddress === null) parts.push(new Uint8Array([0]))
  else parts.push(new Uint8Array([1]), hexBytes(vaultAddress.toLowerCase()))
  if (expiresAfter !== null) parts.push(new Uint8Array([0]), u64(expiresAfter))
  const len = parts.reduce((n, p) => n + p.length, 0)
  const data = new Uint8Array(len)
  let o = 0
  for (const p of parts) { data.set(p, o); o += p.length }
  return keccak256(data)
}

export function l1TypedData(hash: Hex, mainnet: boolean): TypedData {
  return {
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO_ADDRESS },
    types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    primaryType: 'Agent',
    message: { source: mainnet ? 'a' : 'b', connectionId: hash },
  }
}

/** The fields each user-signed action is signed over (the SDK's *_SIGN_TYPES), by primary type. */
export const USER_SIGNED: Record<string, { name: string; type: string }[]> = {
  'HyperliquidTransaction:UsdSend': [
    { name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' },
    { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' },
  ],
  'HyperliquidTransaction:Withdraw': [
    { name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' },
    { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' },
  ],
  'HyperliquidTransaction:UsdClassTransfer': [
    { name: 'hyperliquidChain', type: 'string' }, { name: 'amount', type: 'string' },
    { name: 'toPerp', type: 'bool' }, { name: 'nonce', type: 'uint64' },
  ],
  'HyperliquidTransaction:SendAsset': [
    { name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' },
    { name: 'sourceDex', type: 'string' }, { name: 'destinationDex', type: 'string' },
    { name: 'token', type: 'string' }, { name: 'amount', type: 'string' },
    { name: 'fromSubAccount', type: 'string' }, { name: 'nonce', type: 'uint64' },
  ],
  'HyperliquidTransaction:ApproveAgent': [
    { name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' },
    { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' },
  ],
  'HyperliquidTransaction:ApproveBuilderFee': [
    { name: 'hyperliquidChain', type: 'string' }, { name: 'maxFeeRate', type: 'string' },
    { name: 'builder', type: 'address' }, { name: 'nonce', type: 'uint64' },
  ],
  'HyperliquidTransaction:UserSetAbstraction': [
    { name: 'hyperliquidChain', type: 'string' }, { name: 'user', type: 'address' },
    { name: 'abstraction', type: 'string' }, { name: 'nonce', type: 'uint64' },
  ],
}

export function userSignedTypedData(primaryType: keyof typeof USER_SIGNED, action: Record<string, unknown>): TypedData {
  const chainId = parseInt(String(action.signatureChainId), 16)
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('signatureChainId must be a hex chain id')
  const fields = USER_SIGNED[primaryType]
  // Only the declared fields are signed (the action's type and signatureChainId aren't).
  const message: Record<string, unknown> = {}
  for (const f of fields) message[f.name] = f.type === 'uint64' ? BigInt(action[f.name] as number) : action[f.name]
  return {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: ZERO_ADDRESS },
    types: { [primaryType]: fields },
    primaryType,
    message,
  }
}

/** A 65-byte signature as Hyperliquid's { r, s, v }. */
export function splitSignature(sig: Hex): Signature {
  const h = sig.slice(2)
  if (h.length !== 130) throw new Error('signature must be 65 bytes')
  let v = parseInt(h.slice(128, 130), 16)
  if (v < 27) v += 27
  return { r: `0x${h.slice(0, 64)}`, s: `0x${h.slice(64, 128)}`, v }
}

export async function signL1(signer: TypedDataSigner, action: Packable, nonce: number, mainnet: boolean, vaultAddress: string | null = null, expiresAfter: number | null = null): Promise<Signature> {
  const hash = actionHash(action, vaultAddress, nonce, expiresAfter)
  return splitSignature(await signer.signTypedData(l1TypedData(hash, mainnet)))
}

export async function signUserAction(signer: TypedDataSigner, primaryType: keyof typeof USER_SIGNED, action: Record<string, unknown>): Promise<Signature> {
  return splitSignature(await signer.signTypedData(userSignedTypedData(primaryType, action)))
}
