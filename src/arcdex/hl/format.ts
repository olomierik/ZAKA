// Numbers as the Hyperliquid pages show them.

/** Decimals for a price: whole dollars from $10,000, more as it gets smaller (up to 8). */
export function pxDp(px: number): number {
  if (!(px > 0)) return 2
  if (px >= 10_000) return 0
  if (px >= 1_000) return 1
  if (px >= 100) return 2
  if (px >= 10) return 3
  if (px >= 1) return 4
  return Math.min(8, 4 - Math.floor(Math.log10(px)))
}
export const fmtPx = (px: number | null | undefined) => px == null || !(px > 0) ? '—' : px.toLocaleString(undefined, { minimumFractionDigits: pxDp(px), maximumFractionDigits: pxDp(px) })
export const fmtNum = (n: number | null | undefined, dp: number) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })
export function compactUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}
export const pct = (n: number | null | undefined, dp = 2) => n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`
export const signedUsd = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const upDown = (n: number | null | undefined) => (n == null ? '' : n >= 0 ? 'fx-up' : 'fx-down')
/** What a number field keeps of what was typed: digits and one decimal point (a comma counts as one). */
export const sanitize = (s: string) => s.replace(/,/g, '.').replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1')
