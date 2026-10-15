// Feature flags (the build pack's 06: "every new feature sits behind a feature flag"). Each flag has a default here and
// can be set at build time with VITE_FLAG_<NAME> ("on" or "off", e.g. VITE_FLAG_WITHDRAW_LIMITS=off) on Netlify, and
// redeployed. Protections default on; features that need an outside account (Privy) default off until it's configured.

type Env = Record<string, string | undefined>
const env: Env = ((import.meta as unknown as { env?: Env }).env) ?? {}

export const FLAGS = {
  /** New-address hold and daily limits on money leaving the trading wallet (lib/withdrawPolicy.ts). */
  withdrawLimits: true,
  /** The wallets card across chains on Portfolio (components/WalletsCard.tsx). */
  walletsCard: true,
  /** Sign-in with Privy (email or social), with its embedded EVM and Solana wallets. Needs VITE_PRIVY_APP_ID. */
  privy: false,
} as const
export type FlagName = keyof typeof FLAGS

const envName = (f: string) => `VITE_FLAG_${f.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`

/** Whether `name` is on: VITE_FLAG_<NAME> when it says on or off, else the default. */
export function flag(name: FlagName, source: Env = env): boolean {
  const v = (source[envName(name)] ?? '').trim().toLowerCase()
  if (/^(on|true|1|yes)$/.test(v)) return true
  if (/^(off|false|0|no)$/.test(v)) return false
  return FLAGS[name]
}
