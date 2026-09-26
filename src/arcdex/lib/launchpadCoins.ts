// Which coins are ArcLaunchpad (bonding-curve) coins.
//
// Every /token/0x… link opens the Argus coin page, and search, the
// discovery panel, the feed and profiles all link coins that way. A
// launchpad coin has no Uniswap pool there ("No routable pool") and can only
// be bought on its curve — so the coin page checks this list first and
// opens the launchpad coin page instead. The list is small (/api/launchpad,
// CDN-cached) and fetched once, early.

let known: Set<string> | null = null
let loading: Promise<Set<string>> | null = null

export function loadLaunchpadCoins(): Promise<Set<string>> {
  if (known) return Promise.resolve(known)
  loading ??= fetch('/api/launchpad')
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`launchpad index ${r.status}`))))
    .then((j: { launches?: { token: string }[] }) => (known = new Set((j.launches ?? []).map(l => l.token.toLowerCase()))))
    .catch(e => { loading = null; throw e })
  return loading
}

/** true / false once the list is in; null while it's loading. */
export function isLaunchpadCoinNow(address: string): boolean | null {
  return known ? known.has(address.toLowerCase()) : null
}

/** Whether `address` trades on ArcLaunchpad's curve. If the list can't be
 * fetched, the launchpad contract itself is asked. */
export async function isLaunchpadCoin(address: string): Promise<boolean> {
  try {
    return (await loadLaunchpadCoins()).has(address.toLowerCase())
  } catch {
    const { getCurve } = await import('../api/launchpad')
    return !!(await getCurve(address as `0x${string}`).catch(() => null))
  }
}

/** A coin launched in this tab — known before the index catches up. */
export function rememberLaunchpadCoin(address: string) {
  (known ??= new Set()).add(address.toLowerCase())
}
