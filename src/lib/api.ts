/**
 * ZAKA API client.
 * Calls Supabase Edge Functions when VITE_SUPABASE_URL is set,
 * otherwise falls back to the local Bun server at /api (dev only).
 */
import { supabase } from './supabase'
import type { ZakaUser, ZakaTransaction } from '../types/zaka'

// ── routing ───────────────────────────────────────────────────────────────────

const USE_EDGE = !!(import.meta.env.VITE_SUPABASE_URL as string | undefined)

// ── edge function helper ──────────────────────────────────────────────────────

async function callEdge<T>(fn: string, body: Record<string, unknown>, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await supabase.functions.invoke(fn, { body, headers }) as { data: unknown; error: unknown }
  if (result.error) throw new Error((result.error as { message?: string }).message ?? 'Edge function error')
  return result.data as T
}

// ── local server helper ───────────────────────────────────────────────────────

async function callServer<T>(path: string, body: Record<string, unknown>, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const data = await res.json() as { error?: string } & T
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

async function fetchServer<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { 'Authorization': `Bearer ${token}` } })
  const data = await res.json() as { error?: string } & T
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

// ── public API ────────────────────────────────────────────────────────────────

export const api = {

  register: async (body: { name: string; phone: string; pin: string }): Promise<{ user: ZakaUser; token: string }> => {
    if (USE_EDGE) return callEdge<{ user: ZakaUser; token: string }>('register', body)
    return callServer('/auth/register', body)
  },

  login: async (body: { phone: string; pin: string }): Promise<{ user: ZakaUser; token: string }> => {
    if (USE_EDGE) return callEdge<{ user: ZakaUser; token: string }>('login', body)
    return callServer('/auth/login', body)
  },

  // ── wallet ──────────────────────────────────────────────────────────────────

  getBalance: async (token: string): Promise<{ usdc: string }> => {
    if (USE_EDGE) return callEdge<{ usdc: string }>('get-balance', {}, token)
    return fetchServer('/wallet/balance', token)
  },

  getDepositAddress: async (token: string): Promise<{ address: string; network: string }> => {
    if (USE_EDGE) {
      // Read directly from Supabase DB via auth
      const { data: { user } } = await supabase.auth.getUser(token)
      if (!user) throw new Error('Not authenticated')
      const { data, error } = await supabase
        .from('users')
        .select('walletAddress')
        .eq('id', user.id)
        .single()
      if (error) throw new Error(error.message)
      const row = data as { walletAddress: string }
      return { address: row.walletAddress, network: 'Arc Testnet' }
    }
    return fetchServer('/wallet/deposit-address', token)
  },

  send: async (token: string, body: { toPhone: string; amount: string; note?: string }): Promise<{ txId: string; status: string }> => {
    if (USE_EDGE) return callEdge<{ txId: string; status: string }>('send-usdc', body, token)
    return callServer('/wallet/send', body, token)
  },

  withdraw: async (token: string, body: { phone: string; amount: string; provider: string }): Promise<{ reference: string; status: string; message: string }> => {
    if (USE_EDGE) return callEdge<{ reference: string; status: string; message: string }>('withdraw', body, token)
    return callServer('/wallet/withdraw', body, token)
  },

  getTransactions: async (token: string): Promise<{ transactions: ZakaTransaction[] }> => {
    if (USE_EDGE) {
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
    }
    return fetchServer('/wallet/transactions', token)
  },

  getUsers: async (token: string, query: string): Promise<{ users: Array<{ name: string; phone: string }> }> => {
    if (query.length < 3) return { users: [] }
    if (USE_EDGE) {
      const { data: { user } } = await supabase.auth.getUser(token)
      if (!user) throw new Error('Not authenticated')
      const { data, error } = await supabase
        .from('users')
        .select('name, phone')
        .neq('id', user.id)
        .or(`phone.ilike.%${query}%,name.ilike.%${query}%`)
        .limit(8)
      if (error) throw new Error(error.message)
      return { users: (data ?? []) as Array<{ name: string; phone: string }> }
    }
    return fetchServer(`/users/search?q=${encodeURIComponent(query)}`, token)
  },

  txStatus: async (token: string, txId: string): Promise<{ status: string; txHash?: string }> => {
    if (USE_EDGE) return callEdge<{ status: string; txHash?: string }>('tx-status', { txId }, token)
    return fetchServer(`/wallet/tx/${txId}`, token)
  },
}
