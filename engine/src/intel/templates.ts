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

/** A template from real instances of one contract (at least 3, so each
 * varying range shows up; more is safer). */
export function learnTemplate(name: string, codes: string[]): CodeTemplate {
  if (codes.length < 3) throw new Error(`${name}: need at least 3 instances`)
  const mask = varyingRanges(codes)
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

/** A named value a copy filled in (see `fields`), or null. */
export function field(code: string, t: CodeTemplate, name: string): string | null {
  const i = t.fields?.[name]
  return i === undefined ? null : filledIn(code, t)[i] ?? null
}

/** EIP-1167 minimal proxy (45 bytes): the implementation it delegates to, else null. */
export function cloneTarget(code: string | null | undefined): string | null {
  const m = /^(?:0x)?363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(code ?? '')
  return m ? '0x' + m[1].toLowerCase() : null
}
