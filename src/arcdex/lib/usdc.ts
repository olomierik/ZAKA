// USDC cash: balance of whoever is trading, and sending it (withdraw /
// send-to-a-trader). Works for the one-tap trading wallet (no pop-up) and
// for a connected external wallet (wagmi).

import { useCallback, useEffect, useState } from 'react'
import { parseAbi, parseUnits, type Address, type Hex } from 'viem'
import { client } from '../api/launchpad'
import { sendArc } from './tx'
import { verifyPasscode } from './embeddedWallet'
import { isFunder } from './funders'
import type { Trader } from './identity'

export const USDC = '0x3600000000000000000000000000000000000000' as Address
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)'])

export async function usdcBalance(address: string): Promise<number> {
  const raw = await client.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [address as Address] })
  return Number(raw) / 1e6
}

/** Live USDC balance (whole USDC) for `address`, refreshed every 15s. */
export function useCash(address: string | null): { cash: number | null; refresh: () => void } {
  const [cash, setCash] = useState<number | null>(null)
  const refresh = useCallback(() => {
    if (!address) { setCash(null); return }
    void usdcBalance(address).then(setCash).catch(() => {})
  }, [address])
  useEffect(() => {
    refresh()
    const id = setInterval(() => { if (!document.hidden) refresh() }, 15_000)
    return () => clearInterval(id)
  }, [refresh])
  return { cash, refresh }
}

/** From the trading wallet, only a wallet that funded it can receive cash
 * without the passcode (lib/funders.ts). */
export function needsPasscode(trader: Trader, to: string): boolean {
  return trader.kind === 'trading-wallet' && !!trader.address && /^0x[0-9a-fA-F]{40}$/.test(to) && !isFunder(trader.address, to)
}

/** Returns a function that sends USDC from the trader's wallet and waits
 * for it to confirm. From the trading wallet to a wallet that didn't fund
 * it, `passcode` must open the wallet (and its passkey, with 2FA on). */
export function useSendUsdc(trader: Trader) {
  return useCallback(async (to: string, amount: string, passcode?: string): Promise<Hex> => {
    if (!trader.address) throw new Error('Connect or unlock a wallet first')
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('That is not a valid Arc address')
    if (to.toLowerCase() === trader.address.toLowerCase()) throw new Error('That is your own wallet')
    const value = parseUnits(amount, 6)
    if (value <= 0n) throw new Error('Enter an amount')
    if (needsPasscode(trader, to)) {
      if (!passcode) throw new Error('Enter your passcode to send to a wallet that did not fund this one')
      await verifyPasscode(passcode)
    }
    const req = { address: USDC, abi: ERC20, functionName: 'transfer' as const, args: [to as Address, value] as const }
    const hash = await sendArc(trader.kind, req as never)
    const rc = await client.waitForTransactionReceipt({ hash })
    if (rc.status !== 'success') throw new Error('Transfer failed')
    return hash
  }, [trader])
}
