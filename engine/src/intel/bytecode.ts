// What a contract can do, from its runtime code alone: the functions it
// exposes (the 4-byte selectors its dispatcher compares against), and
// whether it can delegate its code elsewhere or destroy itself. No source
// or ABI needed, which is the point: most launched coins publish neither.
//
// It sees the function a contract exposes, not who may call it. A mint()
// is only a danger if someone still holds the key to it, which is why the
// scanner pairs this with the owner (see scanner.ts): renounced, or the
// launchpad's own contract, it's inert.

import { toFunctionSelector } from 'viem'

export type Power = 'mint' | 'freeze' | 'pause' | 'trading' | 'fees' | 'limits' | 'exempt' | 'upgrade' | 'drain' | 'owner'

/** Known signatures of each power. Selectors are computed, not copied. */
const SIGNATURES: Record<Power, string[]> = {
  mint: ['mint(address,uint256)', 'mint(uint256)', 'mintTo(address,uint256)', 'mintFor(address,uint256)', 'issue(uint256)', 'mint(address)', 'ownerMint(address,uint256)', 'airdropMint(address[],uint256[])'],
  freeze: [
    'blacklist(address)', 'blacklist(address,bool)', 'addToBlacklist(address)', 'setBlacklist(address,bool)', 'blacklistAddress(address,bool)',
    'addBots(address[])', 'setBots(address[],bool)', 'setBot(address,bool)', 'addBot(address)', 'blockBots(address[])', 'setSniper(address,bool)',
    'freeze(address)', 'freezeAccount(address,bool)', 'setIsBlacklisted(address,bool)', 'updateBlacklist(address,bool)', 'banAddress(address)',
  ],
  pause: ['pause()', 'setPaused(bool)', 'togglePause()'],
  trading: ['enableTrading()', 'openTrading()', 'setTradingEnabled(bool)', 'setTradingOpen(bool)', 'setTrading(bool)', 'startTrading()', 'toggleTrading()', 'setSwapEnabled(bool)'],
  fees: [
    'setFee(uint256)', 'setFees(uint256,uint256)', 'setTaxes(uint256,uint256)', 'setBuyFee(uint256)', 'setSellFee(uint256)', 'setTax(uint256)',
    'setTaxFeePercent(uint256)', 'updateFees(uint256,uint256)', 'setSwapFee(uint256)', 'setBuyTax(uint256)', 'setSellTax(uint256)',
    'updateBuyFees(uint256,uint256,uint256)', 'updateSellFees(uint256,uint256,uint256)', 'setFeeBps(uint16)',
  ],
  limits: ['setMaxTxAmount(uint256)', 'setMaxWalletSize(uint256)', 'setMaxTxPercent(uint256)', 'setMaxWallet(uint256)', 'updateMaxTxAmount(uint256)', 'setMaxSellAmount(uint256)'],
  exempt: ['excludeFromFee(address)', 'setExcludedFromFee(address,bool)', 'excludeFromFees(address,bool)', 'setIsFeeExempt(address,bool)', 'excludeFromMaxTransaction(address,bool)'],
  upgrade: ['upgradeTo(address)', 'upgradeToAndCall(address,bytes)', 'setImplementation(address)'],
  // (burnFrom isn't here: OpenZeppelin's needs the holder's allowance.)
  drain: ['withdraw()', 'withdrawTokens(address)', 'rescueTokens(address)', 'emergencyWithdraw()', 'recoverERC20(address,uint256)', 'setBalance(address,uint256)'],
  owner: ['owner()', 'transferOwnership(address)', 'renounceOwnership()', 'getOwner()'],
}

/** selector → [power, signature] */
export const RISKY: ReadonlyMap<string, readonly [Power, string]> = new Map(
  (Object.entries(SIGNATURES) as [Power, string[]][]).flatMap(([p, sigs]) => sigs.map(s => [toFunctionSelector(s), [p, s] as const] as const)),
)

export interface CodeFacts {
  size: number
  /** Every PUSH4 immediate: the selectors a dispatcher checks (and some constants). */
  selectors: Set<string>
  /** Risky functions it exposes, by power. */
  powers: Map<Power, string[]>
  delegatecall: boolean
  selfdestruct: boolean
  /** EIP-1167 minimal proxy target, if it is one. */
  cloneOf: string | null
}

/** Opcodes and PUSH4 values, skipping PUSH data so bytes inside it aren't read as opcodes. */
export function analyzeCode(code: string): CodeFacts {
  const hex = code.toLowerCase().replace(/^0x/, '')
  const n = hex.length / 2
  const selectors = new Set<string>()
  let delegatecall = false, selfdestruct = false
  for (let i = 0; i < n;) {
    const op = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (op >= 0x60 && op <= 0x7f) {
      const len = op - 0x5f
      if (len === 4) selectors.add('0x' + hex.slice(i * 2 + 2, i * 2 + 10))
      i += 1 + len
      continue
    }
    if (op === 0xf4) delegatecall = true
    if (op === 0xff) selfdestruct = true
    // Past INVALID (0xfe) the rest is usually the metadata hash, not code.
    i++
  }
  const powers = new Map<Power, string[]>()
  for (const s of selectors) {
    const hit = RISKY.get(s)
    if (hit) powers.set(hit[0], [...(powers.get(hit[0]) ?? []), hit[1]])
  }
  const m = /^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/.exec(hex)
  return { size: n, selectors, powers, delegatecall, selfdestruct, cloneOf: m ? '0x' + m[1] : null }
}

/** EIP-1967 storage slots: an upgradeable proxy keeps its implementation (or beacon) here. */
export const EIP1967_IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
export const EIP1967_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
export const EIP1967_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'

/** Addresses that mean "nobody": renounced ownership. */
export const NOBODY = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', '0xdead000000000000000042069420694206942069'])
