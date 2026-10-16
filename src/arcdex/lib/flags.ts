// Feature flags (the build pack's 06: "every new feature sits behind a feature flag"). Each flag has a default here, and
// two ways to change it:
//   • at build time, VITE_FLAG_<NAME> ("on" or "off", e.g. VITE_FLAG_WITHDRAW_LIMITS=off) on Netlify, then a redeploy:
//     this always wins;
//   • while the site runs, from /admin → Flags (engine/src/admin/flags.ts): the engine serves GET /v1/flags, read when the
//     app starts and every 5 minutes, and kept in this browser for the next visit. A protective flag (SITE_FLAGS in
//     api/_marketProtocol.ts) is only ever turned on this way, never off: loosening a protection takes a deploy.
// Protections default on; a feature that needs an outside account (Privy) shows only once that account is configured.

import { useSyncExternalStore } from 'react'
import { SITE_FLAGS, isSiteFlag, type SiteFlag } from '../../../api/_marketProtocol'

type Env = Record<string, string | undefined>
const env: Env = ((import.meta as unknown as { env?: Env }).env) ?? {}

export const FLAGS = {
  /** New-address hold and daily limits on money leaving the trading wallet (lib/withdrawPolicy.ts). */
  withdrawLimits: true,
  /** The coin's safety rating right above Buy on every trade form, and the tick a Danger coin needs (lib/buyRisk.tsx). */
  buyRisk: true,
  /** The wallets card across chains on Portfolio (components/WalletsCard.tsx). */
  walletsCard: true,
  /** Solana swaps through Jupiter's Swap API V2 with ARCDEX's referral fee (lib/jupiter.ts). Works once the site's
   * proxy has JUPITER_API_KEY; until then (or while Jupiter is down) Solana swaps go through Relay. */
  jupiter: true,
  /** Sign-in with Privy (email or social), with its embedded EVM and Solana wallets (privy/state.ts). On, but offered only
   * once VITE_PRIVY_APP_ID is set (the owner set it on 2026-10-16); /admin can turn it off without a deploy. */
  privy: true,
  /** Price and whale alerts sent by the engine as web push, with ARCDEX closed (lib/push.ts). Needs the engine. */
  pushAlerts: true,
} as const satisfies Record<SiteFlag, boolean>
export type FlagName = SiteFlag
export type RuntimeFlags = Partial<Record<FlagName, boolean>>

const envName = (f: string) => `VITE_FLAG_${f.replace(/[A-Z]/g, c => `_${c}`).toUpperCase()}`
const CACHE = 'arcdex:flags'
const CACHE_MAX_MS = 86_400_000

/** Only known flags with true/false values. */
export function cleanRuntime(raw: unknown): RuntimeFlags {
  const out: RuntimeFlags = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw)) if (isSiteFlag(k) && typeof v === 'boolean') out[k] = v
  return out
}

function readCache(): RuntimeFlags {
  try {
    const j = JSON.parse(localStorage.getItem(CACHE) ?? 'null') as { at?: number; flags?: unknown } | null
    return j && Date.now() - (j.at ?? 0) < CACHE_MAX_MS ? cleanRuntime(j.flags) : {}
  } catch { return {} }
}

let runtime: RuntimeFlags = readCache()
const listeners = new Set<() => void>()

/** Whether `name` is on: VITE_FLAG_<NAME> when it says on or off, else the value set from /admin, else the default. */
export function flag(name: FlagName, source: Env = env, rt: RuntimeFlags = runtime): boolean {
  const v = (source[envName(name)] ?? '').trim().toLowerCase()
  if (/^(on|true|1|yes)$/.test(v)) return true
  if (/^(off|false|0|no)$/.test(v)) return false
  const r = rt[name]
  // A protective flag is never turned off from /admin.
  if (typeof r === 'boolean' && !(SITE_FLAGS[name].protective && r === false)) return r
  return FLAGS[name]
}

/** The flag, re-rendering when /admin changes it. */
export function useFlag(name: FlagName): boolean {
  return useSyncExternalStore(subscribe, () => flag(name), () => flag(name))
}

function subscribe(f: () => void) { listeners.add(f); return () => { listeners.delete(f) } }

function set(next: RuntimeFlags) {
  const same = JSON.stringify(next) === JSON.stringify(runtime)
  runtime = next
  try { localStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), flags: next })) } catch { /* storage blocked: this visit only */ }
  if (!same) for (const f of listeners) f()
}

/** Flags the engine just answered with (an admin's change): this browser follows them at once. */
export function applyRuntimeFlags(raw: unknown) { set(cleanRuntime(raw)) }

let started = false
/** Reads the flags set from /admin now and every 5 minutes. `engine`: the market engine's REST base; nothing without one. */
export function loadRuntimeFlags(engine: string) {
  if (started || !engine || typeof window === 'undefined') return
  started = true
  const read = () => fetch(`${engine}/v1/flags`, { cache: 'no-store', signal: AbortSignal.timeout(5_000) })
    .then(r => (r.ok ? r.json() as Promise<{ flags?: unknown }> : null))
    .then(j => { if (j) set(cleanRuntime(j.flags)) })
    .catch(() => { /* the engine is unreachable: the last flags read (or the defaults) stay */ })
  void read()
  setInterval(() => { if (document.visibilityState === 'visible') void read() }, 5 * 60_000)
}
