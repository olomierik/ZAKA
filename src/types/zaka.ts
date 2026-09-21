export interface ZakaUser {
  id: string
  name: string
  phone: string
  email?: string
  walletId: string
  walletAddress: string
  createdAt: string
}

export interface ZakaTransaction {
  id: string
  type: 'send' | 'receive' | 'deposit' | 'withdraw'
  amount: string
  currency: 'USDC'
  status: 'pending' | 'complete' | 'failed'
  counterparty?: string
  counterpartyPhone?: string
  txHash?: string
  createdAt: string
  description?: string
}

export interface ZakaBalance {
  usdc: string
  loading: boolean
}

export type AppScreen =
  | 'splash'
  | 'login'
  | 'register'
  | 'home'
  | 'send'
  | 'receive'
  | 'deposit'
  | 'withdraw'
  | 'history'
  | 'profile'
