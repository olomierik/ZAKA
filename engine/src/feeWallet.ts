// Where the engine sends the platform's fees: each winning live trade's profit share (bot/userLive.ts PROFIT_FEE), and
// the fee wallet the $ARCDEX program reads (coin/program.ts) and a new futures deployment pays (perps/deploy.ts).
// FEE_RECIPIENT_EVM on Railway moves it (to a multisig, say) with no code change (docs/REPO_MAP.md D4); unset or not an
// address, it's the fee wallet since ARCDEX, so a typo can't send fees nowhere. The site reads VITE_FEE_RECIPIENT_EVM
// the same way (src/arcdex/lib/platform.ts): set both to the same wallet.
import { getAddress, type Address } from 'viem'
import { log } from './log'

export const DEFAULT_FEE_WALLET = '0x274262A0321A0701b0A46a3576e07aE881c286Bb' as Address

/** The fee wallet from an environment value, checksummed; the default when it's unset or not an address. */
export function feeRecipientFrom(raw: string | undefined): Address {
  const v = String(raw ?? '').trim()
  if (!v) return DEFAULT_FEE_WALLET
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return getAddress(v.toLowerCase())
  log.warn('FEE_RECIPIENT_EVM is not an address: fees stay with the default fee wallet', { default: DEFAULT_FEE_WALLET })
  return DEFAULT_FEE_WALLET
}

/** The engine's fee wallet (FEE_RECIPIENT_EVM, else the default). */
export const FEE_RECIPIENT = feeRecipientFrom(process.env.FEE_RECIPIENT_EVM)
