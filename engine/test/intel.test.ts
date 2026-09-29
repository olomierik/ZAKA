// The safety scanner's pure pieces: reading what a contract can do from its
// code (intel/bytecode.ts), code templates (intel/templates.ts), and what a
// honeypot probe's result means (intel/honeypot.ts). The probe itself runs
// against mainnet in engine/scripts/check-honeypot-probe.ts.
import { describe, expect, test } from 'bun:test'
import { toFunctionSelector } from 'viem'
import { analyzeCode } from '../src/intel/bytecode'
import { interpret } from '../src/intel/honeypot'
import { cloneTarget, field, learnTemplate, matchesTemplate, varyingRanges } from '../src/intel/templates'

const sel = (s: string) => toFunctionSelector(s).slice(2)
const push4 = (s: string) => '63' + sel(s) // PUSH4 <selector>

describe('what a contract can do', () => {
  test('finds a mint and a blacklist among its functions', () => {
    const f = analyzeCode('0x' + push4('mint(address,uint256)') + push4('blacklist(address)') + push4('transfer(address,uint256)') + '00')
    expect(f.powers.get('mint')).toEqual(['mint(address,uint256)'])
    expect(f.powers.get('freeze')).toEqual(['blacklist(address)'])
    expect(f.powers.has('fees')).toBe(false)
  })
  test('a plain token has none', () => {
    const f = analyzeCode('0x' + push4('transfer(address,uint256)') + push4('approve(address,uint256)') + '00')
    expect(f.powers.size).toBe(0)
  })
  test('DELEGATECALL and SELFDESTRUCT as instructions', () => {
    expect(analyzeCode('0x5af4').delegatecall).toBe(true)
    expect(analyzeCode('0x33ff').selfdestruct).toBe(true)
  })
  test('the same bytes inside pushed data are not instructions', () => {
    const f = analyzeCode('0x61f4ff' + '00') // PUSH2 0xf4ff
    expect(f.delegatecall).toBe(false)
    expect(f.selfdestruct).toBe(false)
  })
  test('a minimal proxy names what it forwards to', () => {
    const impl = '1b74922c01ddfd9c77b37d02c0a236611e8fe500'
    const clone = `0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`
    expect(analyzeCode(clone).cloneOf).toBe('0x' + impl)
    expect(cloneTarget(clone)).toBe('0x' + impl)
    expect(cloneTarget('0x6080')).toBeNull()
  })
})

describe('code templates', () => {
  const body = (a: string, fee: string) => '0x6080' + a + '5b' + fee + '00ff'
  const addr = (c: string) => c.repeat(40)
  const codes = [body(addr('1'), '0064'), body(addr('2'), '012c'), body(addr('3'), '0064')]
  const t = learnTemplate('test', codes)

  test('learns the ranges each copy fills in', () => {
    expect(varyingRanges(codes)).toEqual([[2, 21], [23, 24]])
    expect(t.mask).toEqual([[2, 21], [23, 24]])
  })
  test('a new copy with its own values matches', () => {
    expect(matchesTemplate(body(addr('9'), '00c8'), t)).toBe(true)
  })
  test('one changed byte outside those ranges does not', () => {
    expect(matchesTemplate(body(addr('9'), '00c8').replace(/ff$/, 'fe'), t)).toBe(false)
  })
  test('another size does not', () => {
    expect(matchesTemplate(body(addr('9'), '00c8') + '00', t)).toBe(false)
    expect(matchesTemplate(null, t)).toBe(false)
  })
  test('reads a named value a copy filled in', () => {
    const named = { ...t, fields: { quote: 0 } }
    expect(field(body(addr('a'), '0001'), named, 'quote')).toBe('0x' + addr('a'))
    expect(field(body(addr('a'), '0001'), named, 'missing')).toBeNull()
  })
  test('needs at least three copies to learn from', () => {
    expect(() => learnTemplate('x', codes.slice(0, 2))).toThrow()
  })
})

describe('what a honeypot probe means', () => {
  const base = { bought: true, swapOut: 1000n, received: 1000n, transferred: true, sellerReceived: 1000n, sold: true, soldFor: 980_000n, error: '0x' as const }
  const IN = 1_000_000n
  test('bought, passed on and sold: ok, with the round trip cost', () => {
    const r = interpret(base, IN)
    expect(r.verdict).toBe('ok')
    expect(r.roundTripLossPct).toBe(2)
    expect(r.buyTaxPct).toBe(0)
    expect(r.transferTaxPct).toBe(0)
  })
  test('a tax taken in the token on the way in and between wallets', () => {
    const r = interpret({ ...base, received: 900n, sellerReceived: 855n }, IN)
    expect(r.buyTaxPct).toBe(10)
    expect(r.transferTaxPct).toBe(5)
  })
  test('the sale reverts: honeypot', () => {
    expect(interpret({ ...base, sold: false, soldFor: 0n, error: '0xa5baf151' }, IN)).toMatchObject({ verdict: 'honeypot', error: '0xa5baf151' })
  })
  test('passing coins to another wallet reverts: honeypot', () => {
    expect(interpret({ ...base, transferred: false, sellerReceived: 0n, sold: false, soldFor: 0n }, IN).verdict).toBe('honeypot')
  })
  test('the pool won\'t trade with the probe: untradeable, not honeypot', () => {
    expect(interpret({ ...base, bought: false, swapOut: 0n, received: 0n }, IN).verdict).toBe('untradeable')
  })
  test('the buy returns nothing (no liquidity yet): untradeable, not honeypot', () => {
    const r = interpret({ ...base, swapOut: 0n, received: 0n, transferred: false, sellerReceived: 0n, sold: false, soldFor: 0n }, IN)
    expect(r.verdict).toBe('untradeable')
    expect(r.error).toMatch(/no liquidity/)
  })
})
