// Who "you" are on ARCDEX: the wallet you trade from.
//
// If the in-browser trading wallet is unlocked, that's you — it trades and
// signs with no pop-ups (the one-tap flow). Otherwise it's the connected
// external wallet (MetaMask etc.). Profiles, theses, follows, positions and
// referral earnings all belong to this address, so they always match the
// wallet whose trades show up on-chain.

import { useCallback, useEffect, useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { currentAddress, getEmbeddedWalletClient, WALLET_EVENT } from './embeddedWallet'

export type TraderKind = 'trading-wallet' | 'wallet'

export interface Trader {
  address: `0x${string}` | null
  kind: TraderKind | null
  signMessage: (message: string) => Promise<`0x${string}`>
}

export function useEmbeddedAddress(): `0x${string}` | null {
  const [addr, setAddr] = useState(currentAddress())
  useEffect(() => {
    const onChange = () => setAddr(currentAddress())
    window.addEventListener(WALLET_EVENT, onChange)
    return () => window.removeEventListener(WALLET_EVENT, onChange)
  }, [])
  return addr
}

export function useTrader(): Trader {
  const embedded = useEmbeddedAddress()
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()

  const signMessage = useCallback(async (message: string) => {
    if (embedded) return getEmbeddedWalletClient().signMessage({ message })
    return signMessageAsync({ message })
  }, [embedded, signMessageAsync])

  return {
    address: embedded ?? address ?? null,
    kind: embedded ? 'trading-wallet' : address ? 'wallet' : null,
    signMessage,
  }
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
