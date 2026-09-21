/**
 * ZAKA API client — uses Supabase directly for data,
 * and calls Supabase Edge Functions for Circle SDK operations.
 */
import { supabase } from './supabase'
import type { ZakaUser, ZakaTransaction } from '../types/zaka'

// ── helpers ───────────────────────────────────────────────────────────────────

async function callEdge<T>(fn: string, body: Record<string, unknown>, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await supabase.functions.invoke(fn, { body, headers }) as { data: unknown; error: unknown }
  if (result.error) throw new Error((result.error as { message?: string }).message ?? 'Edge function error')
  return result.data as T
}

// ── auth ──────────────────────────────────────────────────────────────────────

export const api = {
  register: async (body: { name: string; phone: string; pin: string }): Promise<{ user: ZakaUser; token: string }> => {
    return callEdge<{ user: ZakaUser; token: string }>('register', body)
  },

  login: async (body: { phone: string; pin: string }): Promise<{ user: ZakaUser; token: string }> => {
    return callEdge<{ user: ZakaUser; token: string }>('login', body)
  },

  // ── wallet ────────────────────────────────────────────────────────────────

  getBalance: async (token: string): Promise<{ usdc: string }> => {
    return callEdge<{ usdc: string }>('get-balance', {}, token)
  },

  getDepositAddress: async (token: string): Promise<{ address: string; network: string }> => {
    // Read wallet address directly from DB — no secret needed
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) throw new Error('Not authenticated')
    const { data, error } = await supabase
      .from('users')
      .select('walletAddress')
      .eq('id', user.id)
      .single()
    if (error) throw new Error(error.message)
    const row = data
    return { address: row.walletAddress, network: 'Arc Testnet' }
  },

  send: async (token: string, body: { toPhone: string; amount: string; note?: string }): Promise<{ txId: string; status: string }> => {
    return callEdge<{ txId: string; status: string }>('send-usdc', body, token)
  },

  withdraw: async (token: string, body: { phone: string; amount: string; provider: string }): Promise<{ reference: string; status: string; message: string }> => {
    return callEdge<{ reference: string; status: string; message: string }>('withdraw', body, token)
  },

  getTransactions: async (token: string): Promise<{ transactions: ZakaTransaction[] }> => {
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) throw new Error('Not authenticated')
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('userId', user.id)
      .order('createdAt', { ascending: false })
      .limit(50)
    if (error) throw new Error(error.message)
    return { transactions: (data ?? []) as ZakaTransaction[] }
  },

  getUsers: async (token: string, query: string): Promise<{ users: Array<{ name: string; phone: string }> }> => {
    if (query.length < 3) return { users: [] }
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) throw new Error('Not authenticated')
    const { data, error } = await supabase
      .from('users')
      .select('name, phone')
      .neq('id', user.id)
      .or(`phone.ilike.%${query}%,name.ilike.%${query}%`)
      .limit(8)
    if (error) throw new Error(error.message)
    return { users: (data ?? []) }
  },

  txStatus: async (token: string, txId: string): Promise<{ status: string; txHash?: string }> => {
    return callEdge<{ status: string; txHash?: string }>('tx-status', { txId }, token)
  },
}
