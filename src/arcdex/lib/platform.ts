// The platform's on-chain constants.

/** The fee wallet since ARCDEX; the default while VITE_FEE_RECIPIENT_EVM isn't set (docs/REPO_MAP.md D4). */
export const DEFAULT_FEE_WALLET = '0x274262a0321a0701b0a46a3576e07ae881c286bb'

/** The fee recipient from an environment value: a valid address, lowercased, else the default (a typo can't send fees nowhere). */
export function feeRecipientFrom(raw: string | undefined): string {
  const v = String(raw ?? '').trim()
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : DEFAULT_FEE_WALLET
}

/**
 * Where every platform fee the site sets goes: Relay's and Across's app fees, the bridge fee, the $3 launch fee,
 * Hyperliquid's builder fee and a new curve router's fee wallet. VITE_FEE_RECIPIENT_EVM on Netlify moves it (to a
 * multisig, say) with no code change; the Across edge function reads the same variable. The Arc routers keep the
 * fee wallet set on-chain (setFeeWallet, by their owner).
 */
export const FEE_WALLET = feeRecipientFrom((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_FEE_RECIPIENT_EVM)

/**
 * ARCDEX's fee on spot trades it routes off Arc (Relay: Solana, BNB Chain; Across: Robinhood Chain): 0.5% (owner's
 * decision D2, 2026-10-15; it was the Arc swap router's 2%). The Arc routers' fee is on-chain (feeBps, set by their
 * owner with setFeeBps(50); /admin shows and sends it).
 */
export const SPOT_FEE_BPS = 50

export const ARC_EXPLORER = 'https://explorer.arc.io'
