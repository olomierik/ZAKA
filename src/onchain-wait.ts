/**
 * Helpers for polling Circle transaction state.
 * Terminal states mean the transaction will not change further.
 */

const TERMINAL_STATES = new Set([
  'COMPLETE',
  'FAILED',
  'CANCELLED',
  'DENIED',
  'CONFIRMED',
])

export function isTerminalTransactionState(state: string): boolean {
  return TERMINAL_STATES.has(state.toUpperCase())
}
