// Contract code templates: "is this the launchpad's own contract, byte for
// byte, apart from the values each deployment fills in?"
//
// Launchpads deploy the same contract for every coin (a token, a v4 hook, a
// curve). Each copy differs only where the deployment writes its own values
// into the code: its coin's address, an escrow, a fee. A template records the
// code's size, those byte ranges (learned by comparing real instances,
// engine/scripts/learn-templates.ts) and a hash of everything else. A copy
// that matches runs exactly the launchpad's code, so it can't hide a mint,
// a blacklist or a sell block that the launchpad's contract doesn't have.

import { keccak256 } from 'viem'

export interface CodeTemplate {
  /** e.g. "Peach curve", "Argus P7 hook" */
  name: string
  /** Runtime code size in bytes. */
  size: number
  /** [start, end] byte ranges (inclusive) that differ between deployments. */
  mask: readonly (readonly [number, number])[]
  /** keccak256 of the code with the masked bytes zeroed. */
  hash: string
  /** Named masked ranges (index into `mask`), e.g. { quote: 0 }: the value a copy filled in there. */
  fields?: Record<string, number>
}

const strip = (code: string) => code.toLowerCase().replace(/^0x/, '')

/** The code with `mask`'s bytes zeroed, as 0x-hex. */
export function maskedCode(code: string, mask: CodeTemplate['mask']): string {
  const hex = strip(code).split('')
  for (const [s, e] of mask) for (let i = s; i <= e && i * 2 + 1 < hex.length; i++) { hex[i * 2] = '0'; hex[i * 2 + 1] = '0' }
  return '0x' + hex.join('')
}

/** Byte ranges where any of `codes` differ from the first (all the same size). */
export function varyingRanges(codes: string[]): [number, number][] {
  const hs = codes.map(strip)
  const n = hs[0].length / 2
  if (hs.some(h => h.length !== hs[0].length)) throw new Error('codes differ in size: not one template')
  const runs: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const b = hs[0].slice(i * 2, i * 2 + 2)
    if (hs.every(h => h.slice(i * 2, i * 2 + 2) === b)) continue
    const last = runs[runs.length - 1]
    if (last && i - last[1] <= 1) last[1] = i; else runs.push([i, i])
  }
  return runs
}

/** Byte ranges of every PUSH instruction's value in `code`. */
export function pushValues(code: string): [number, number][] {
  const hex = strip(code)
  const out: [number, number][] = []
  for (let i = 0; i < hex.length / 2;) {
    const op = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (op >= 0x60 && op <= 0x7f) { const n = op - 0x5f; out.push([i + 1, i + n]); i += 1 + n } else i++
  }
  return out
}

/** Varying ranges widened to the whole value they sit in: a setting baked
 * into the code is a PUSH value, and a sample may only show some of its
 * bytes varying (a fee of 100 vs 300 differs in the low byte; 100 vs 1000
 * in both). Merged where they overlap. */
export function widenToValues(ranges: [number, number][], code: string): [number, number][] {
  const values = pushValues(code)
  const wide = ranges.map(([s, e]) => {
    for (const [vs, ve] of values) if (vs <= e && ve >= s) { s = Math.min(s, vs); e = Math.max(e, ve) }
    return [s, e] as [number, number]
  }).sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const r of wide) { const last = out[out.length - 1]; if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else out.push([...r]) }
  return out
}

/** A template from real instances of one contract (at least 3, so each
 * varying range shows up; more is safer). */
export function learnTemplate(name: string, codes: string[]): CodeTemplate {
  if (codes.length < 3) throw new Error(`${name}: need at least 3 instances`)
  const mask = widenToValues(varyingRanges(codes), codes[0])
  return { name, size: strip(codes[0]).length / 2, mask, hash: keccak256(maskedCode(codes[0], mask) as `0x${string}`) }
}

export function matchesTemplate(code: string | null | undefined, t: CodeTemplate): boolean {
  if (!code || strip(code).length / 2 !== t.size) return false
  return keccak256(maskedCode(code, t.mask) as `0x${string}`) === t.hash
}

/** The values a copy filled in, in mask order (e.g. its escrow's address). */
export function filledIn(code: string, t: CodeTemplate): string[] {
  const h = strip(code)
  return t.mask.map(([s, e]) => '0x' + h.slice(s * 2, (e + 1) * 2))
}

/** A filled-in value as an address: a 20-byte value, or a 32-byte word
 * holding one (its first 12 bytes zero). Null if it isn't one. */
export function asAddress(v: string | null | undefined): string | null {
  const h = (v ?? '').toLowerCase().replace(/^0x/, '')
  if (h.length === 40) return '0x' + h
  if (h.length === 64 && /^0{24}/.test(h)) return '0x' + h.slice(24)
  return null
}

/** A named value a copy filled in (see `fields`), or null. Addresses come back as addresses. */
export function field(code: string, t: CodeTemplate, name: string): string | null {
  const i = t.fields?.[name]
  const v = i === undefined ? null : filledIn(code, t)[i] ?? null
  return v === null ? null : asAddress(v) ?? v
}

/** EIP-1167 minimal proxy (45 bytes): the implementation it delegates to, else null. */
export function cloneTarget(code: string | null | undefined): string | null {
  const m = /^(?:0x)?363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code ?? '')
  return m ? '0x' + m[1].toLowerCase() : null
}
