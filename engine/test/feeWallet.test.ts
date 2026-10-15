// The engine's fee wallet from FEE_RECIPIENT_EVM (src/feeWallet.ts; docs/REPO_MAP.md D4).
import { describe, expect, test } from 'bun:test'
import { getAddress } from 'viem'
import { DEFAULT_FEE_WALLET, FEE_RECIPIENT, feeRecipientFrom } from '../src/feeWallet'
import { PROFIT_FEE } from '../src/bot/userLive'
import { FEE_WALLET } from '../src/coin/program'

describe('fee wallet', () => {
  test('unset: the fee wallet since ARCDEX', () => {
    expect(feeRecipientFrom(undefined)).toBe(DEFAULT_FEE_WALLET)
    expect(feeRecipientFrom('  ')).toBe(DEFAULT_FEE_WALLET)
  })
  test('an address moves it, checksummed whatever its case', () => {
    const want = getAddress('0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a')
    expect(feeRecipientFrom(' 0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a ')).toBe(want)
    expect(feeRecipientFrom('0x5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A')).toBe(want)
  })
  test('a typo keeps the default: fees never go to an address nobody meant', () => {
    expect(feeRecipientFrom('0x274262A0321A0701b0A46a3576e07aE881c286B')).toBe(DEFAULT_FEE_WALLET)
    expect(feeRecipientFrom('multisig')).toBe(DEFAULT_FEE_WALLET)
  })
  test('the profit fee and the $ARCDEX program both follow it', () => {
    expect(PROFIT_FEE.wallet).toBe(FEE_RECIPIENT)
    expect(FEE_WALLET).toBe(FEE_RECIPIENT.toLowerCase())
  })
})
