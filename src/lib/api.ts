// ZAKA API client — talks to the Express backend over /api proxy

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  })
  const data = await res.json() as Record<string, unknown>
  if (!res.ok) throw new Error(typeof data['error'] === 'string' ? data['error'] : 'Request failed')
  return data as T
}

export const api = {
  // Auth
  register: (body: { name: string; phone: string; pin: string }) =>
    apiFetch<{ user: import('../types/zaka').ZakaUser; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  login: (body: { phone: string; pin: string }) =>
    apiFetch<{ user: import('../types/zaka').ZakaUser; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Wallet
  getBalance: (token: string) =>
    apiFetch<{ usdc: string }>('/wallet/balance', {
      headers: { Authorization: `Bearer ${token}` },
    }),

  getDepositAddress: (token: string) =>
    apiFetch<{ address: string; network: string }>('/wallet/deposit-address', {
      headers: { Authorization: `Bearer ${token}` },
    }),

  send: (token: string, body: { toPhone: string; amount: string; note?: string }) =>
    apiFetch<{ txId: string; status: string }>('/wallet/send', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}` },
    }),

  withdraw: (token: string, body: { phone: string; amount: string; provider: string }) =>
    apiFetch<{ reference: string; status: string; message: string }>('/wallet/withdraw', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}` },
    }),

  getTransactions: (token: string) =>
    apiFetch<{ transactions: import('../types/zaka').ZakaTransaction[] }>('/wallet/transactions', {
      headers: { Authorization: `Bearer ${token}` },
    }),

  getUsers: (token: string, query: string) =>
    apiFetch<{ users: Array<{ name: string; phone: string }> }>(`/users/search?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),

  txStatus: (token: string, txId: string) =>
    apiFetch<{ status: string; txHash?: string }>(`/wallet/tx/${txId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
}
