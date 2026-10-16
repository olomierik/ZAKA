// The stand-in for @privy-io/react-auth/solana (scripts/privy-mock/react-auth.tsx says what it's for): the Privy
// account's Solana wallet, which signs by returning what it was given (and logs it).

import { useCallback } from 'react'
import { MOCK_SOL, _useExporter, _log, useSolanaMock } from './react-auth'

const wallet = { address: MOCK_SOL, standardWallet: { name: 'Privy' } }

export const defaultSolanaRpcsPlugin = () => ({ id: 'mock-solana-rpcs' })
export function useWallets() { return { ready: true, wallets: useSolanaMock() ? [wallet] : [] } }
export function useExportWallet() { return { exportWallet: _useExporter('export-sol') } }
export function useSignTransaction() {
  return { signTransaction: useCallback(async ({ transaction }: { transaction: Uint8Array }) => { _log(`sol-sign:${transaction.length}`); return { signedTransaction: transaction } }, []) }
}
export function useSignMessage() {
  return { signMessage: useCallback(async ({ message }: { message: Uint8Array }) => { _log(`sol-message:${message.length}`); return { signature: new Uint8Array(64) } }, []) }
}
