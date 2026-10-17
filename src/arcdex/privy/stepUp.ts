// When a Privy account has to prove it's still its owner before money or keys leave it (the build pack's 04: "step-up
// auth for export and withdraw"). Pure, so it's tested on its own (scripts/test-privy.ts).
//
// With two-step verification (MFA) on, Privy asks for the second factor itself: that check is Privy's, server side, and
// the strongest one. Without it, the account must have signed in on this tab recently: 5 minutes for exporting a key,
// 15 for sending somewhere else. The time is kept in this tab's memory only (a reload or a new tab starts with none),
// so it slows down someone who finds the site open, but it can't stop someone with the browser's developer tools: MFA
// does.

export const STEP_UP = {
  /** Exporting a key: signed in within this long, or MFA. */
  exportFreshMs: 5 * 60_000,
  /** Sending to an address that isn't the account's own: signed in within this long, or MFA. */
  sendFreshMs: 15 * 60_000,
} as const

export type StepUpAction = 'export' | 'send'
/** none: go ahead. mfa: Privy asks for the second factor first. relogin: sign in again first. */
export type StepUpNeed = 'none' | 'mfa' | 'relogin'

export function stepUpNeed(action: StepUpAction, s: { lastAuthAt: number | null; mfa: boolean; now: number }, p = STEP_UP): StepUpNeed {
  if (s.mfa) return 'mfa'
  const fresh = action === 'export' ? p.exportFreshMs : p.sendFreshMs
  return s.lastAuthAt !== null && s.now >= s.lastAuthAt && s.now - s.lastAuthAt <= fresh ? 'none' : 'relogin'
}

/** Whether `to` is one of the account's own addresses (its EVM address on any chain, or its Solana address): no step-up. */
export function isOwnAddress(to: string, own: { evm: string | null; sol: string | null }): boolean {
  const t = to.trim()
  if (!t) return false
  if (own.evm && /^0x[0-9a-fA-F]{40}$/.test(t) && t.toLowerCase() === own.evm.toLowerCase()) return true
  // Solana addresses are case-sensitive base58.
  return !!own.sol && t === own.sol
}

/** A label for the account: its email, else the social account it signed in with. Never a wallet address. */
export function accountLabel(user: {
  email?: { address?: string } | null
  google?: { email?: string } | null
  apple?: { email?: string } | null
  twitter?: { username?: string | null } | null
  discord?: { username?: string | null } | null
} | null | undefined): string | null {
  if (!user) return null
  const twitter = user.twitter?.username ? `@${user.twitter.username}` : null
  return user.email?.address ?? user.google?.email ?? user.apple?.email ?? twitter ?? user.discord?.username ?? null
}

/** Privy app ids are lowercase letters and digits (25 of them, "cm…" or "cl…"). Anything else (spaces, quotes, an app
 * secret, which has underscores) isn't one, and Privy stays off. */
export const isPrivyAppId = (s: string): boolean => /^[a-z0-9]{16,40}$/.test(s)
