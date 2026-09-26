// Coins bought from this browser, per wallet: Portfolio checks these even
// before any index has the trade. Kept apart from lib/portfolio.ts so the
// swap widgets that record buys don't pull in Portfolio's loaders.

const isAddr = (a: string) => /^0x[0-9a-f]{40}$/.test(a)
const heldKey = (owner: string) => `arcdex:held:v1:${owner.toLowerCase()}`

export function remembered(owner: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(heldKey(owner)) ?? '[]') as unknown
    return Array.isArray(v) ? v.map(a => String(a).toLowerCase()).filter(isAddr) : []
  } catch { return [] }
}

/** Remember that `owner` traded `token`. */
export function rememberHolding(owner: string | null | undefined, token: string) {
  if (!owner || !isAddr(token.toLowerCase())) return
  try {
    const list = [token.toLowerCase(), ...remembered(owner).filter(a => a !== token.toLowerCase())].slice(0, 300)
    localStorage.setItem(heldKey(owner), JSON.stringify(list))
  } catch { /* storage blocked */ }
}
