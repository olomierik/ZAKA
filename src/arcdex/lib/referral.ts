// Referral links: arcdex.online/?ref=<username or 0xaddress>
//
// The first referral a visitor arrives with is remembered in this browser
// (first-touch; a later link doesn't overwrite it) and passed to the swap
// router on their trades. The router binds it on-chain on the first
// referred swap, permanently — from then on the referrer earns 15% of that
// wallet's fees in USDC, automatically, on every trade (router v2).

// Type-only: the Supabase client is loaded lazily (only when a username
// needs resolving), so capturing ?ref= on page load stays tiny.
import type { Profile } from '../api/social'

const KEY = 'arcdex:ref'
const ZERO = '0x0000000000000000000000000000000000000000'

export function captureReferral(): void {
  try {
    const url = new URL(window.location.href)
    const ref = url.searchParams.get('ref')?.trim()
    if (!ref) return
    const valid = /^0x[0-9a-fA-F]{40}$/.test(ref) || /^@?[a-zA-Z0-9_]{3,20}$/.test(ref)
    if (valid && !localStorage.getItem(KEY)) localStorage.setItem(KEY, ref.toLowerCase().replace(/^@/, ''))
    // Tidy the address bar so the link isn't copied around with ?ref=.
    url.searchParams.delete('ref')
    window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash)
  } catch { /* storage blocked — no referral, nothing else breaks */ }
}

export function storedReferral(): string | null {
  try { return localStorage.getItem(KEY) } catch { return null }
}

let resolved: { ref: string; address: string | null } | null = null

/** The referrer address to pass to the router for `self`'s trades, or the
 * zero address. Never returns `self` (the router ignores that anyway). */
export async function referrerFor(self: string): Promise<`0x${string}`> {
  const ref = storedReferral()
  if (!ref) return ZERO
  if (!resolved || resolved.ref !== ref) {
    let address: string | null = null
    if (/^0x[0-9a-f]{40}$/.test(ref)) address = ref
    else {
      const { getProfileByUsername } = await import('../api/social')
      address = (await getProfileByUsername(ref).catch(() => null))?.address ?? null
    }
    resolved = { ref, address }
  }
  const a = resolved.address
  return (a && a !== self.toLowerCase() ? a : ZERO) as `0x${string}`
}

export function referralLink(address: string, profile?: Profile | null): string {
  return `https://arcdex.online/?ref=${profile?.username ?? address.toLowerCase()}`
}
