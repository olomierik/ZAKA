/**
 * Normalise Tanzanian phone numbers to E.164 (+255xxxxxxxxx).
 * Accepts: 0750401012 | 255750401012 | +255750401012
 */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('255') && digits.length === 12) return `+${digits}`
  if (digits.startsWith('0') && digits.length === 10) return `+255${digits.slice(1)}`
  if (digits.length === 9) return `+255${digits}` // already stripped leading 0/255
  // Already starts with + — return as-is after stripping spaces
  if (raw.trim().startsWith('+')) return raw.trim().replace(/\s/g, '')
  return raw.trim()
}

export function isValidPhone(raw: string): boolean {
  const n = normalisePhone(raw)
  return /^\+255[67]\d{8}$/.test(n)
}
