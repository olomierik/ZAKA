import React, { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Send, Download, ArrowDownToLine, ArrowUpFromLine, History, LogOut, RefreshCw, User, Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { clearSession } from '../lib/auth'
import type { ZakaUser, ZakaTransaction, AppScreen } from '../types/zaka'

interface Props {
  user: ZakaUser
  token: string
  onNavigate: (screen: AppScreen) => void
  onLogout: () => void
  onBalanceUpdate?: (bal: string) => void
}

const glass: React.CSSProperties = {
  background: 'rgba(255,255,255,0.72)',
  backdropFilter: 'blur(24px) saturate(180%)',
  WebkitBackdropFilter: 'blur(24px) saturate(180%)',
  border: '1px solid rgba(255,255,255,0.68)',
  boxShadow: '0 8px 32px rgba(18,45,69,0.08), inset 0 1px 0 rgba(255,255,255,0.55)',
}

const glassInner: React.CSSProperties = {
  background: 'rgba(255,255,255,0.5)',
  border: '1px solid rgba(18,45,69,0.1)',
}

const spectral = 'linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b, #ffcd83, #7ef1b3)'

const actionButtons = [
  { id: 'send' as AppScreen, icon: Send, label: 'Send', color: '#122d45' },
  { id: 'receive' as AppScreen, icon: Download, label: 'Receive', color: '#1a8047' },
  { id: 'deposit' as AppScreen, icon: ArrowDownToLine, label: 'Add Money', color: '#1061a6' },
  { id: 'withdraw' as AppScreen, icon: ArrowUpFromLine, label: 'Cash Out', color: '#ba2b4c' },
]

function TxRow({ tx }: { tx: ZakaTransaction }) {
  const isIn = tx.type === 'receive' || tx.type === 'deposit'
  const iconMap = {
    send: <Send className="size-4" />,
    receive: <Download className="size-4" />,
    deposit: <ArrowDownToLine className="size-4" />,
    withdraw: <ArrowUpFromLine className="size-4" />,
  }
  const labelMap = {
    send: `To ${tx.counterpartyPhone ?? tx.counterparty ?? 'contact'}`,
    receive: `From ${tx.counterpartyPhone ?? tx.counterparty ?? 'contact'}`,
    deposit: 'Added money',
    withdraw: 'Cashed out',
  }

  return (
    <div className="flex items-center gap-3 py-3">
      <div
        className="flex size-9 shrink-0 items-center justify-center rounded-xl"
        style={{
          background: isIn ? 'rgba(26,128,71,0.10)' : 'rgba(18,45,69,0.07)',
          color: isIn ? 'var(--success)' : 'var(--ink-2)',
        }}
      >
        {iconMap[tx.type]}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate" style={{ color: 'var(--ink)' }}>
          {labelMap[tx.type]}
        </p>
        <p className="text-xs truncate" style={{ color: 'var(--subtle)' }}>
          {tx.description ?? new Date(tx.createdAt).toLocaleDateString('en-TZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-bold tabular-nums" style={{ color: isIn ? 'var(--success)' : 'var(--ink)' }}>
          {isIn ? '+' : '-'}{parseFloat(tx.amount).toFixed(2)} USDC
        </p>
        <p className="text-[10px] font-medium uppercase tracking-wide" style={{
          color: tx.status === 'complete' ? 'var(--success)' : tx.status === 'failed' ? 'var(--danger)' : 'var(--subtle)'
        }}>
          {tx.status}
        </p>
      </div>
    </div>
  )
}

export default function HomeScreen({ user, token, onNavigate, onLogout, onBalanceUpdate }: Props) {
  const [balance, setBalance] = useState<string | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(true)
  const [transactions, setTransactions] = useState<ZakaTransaction[]>([])
  const [txLoading, setTxLoading] = useState(true)
  const [copied, setCopied] = useState(false)

  const onBalanceUpdateRef = useRef(onBalanceUpdate)
  useEffect(() => { onBalanceUpdateRef.current = onBalanceUpdate }, [onBalanceUpdate])

  const fetchBalance = useCallback(async () => {
    setBalanceLoading(true)
    try {
      const res = await api.getBalance(token)
      setBalance(res.usdc)
      onBalanceUpdateRef.current?.(res.usdc)
    } catch {
      // keep previous value
    } finally {
      setBalanceLoading(false)
    }
  }, [token])

  const fetchTransactions = useCallback(async () => {
    setTxLoading(true)
    try {
      const res = await api.getTransactions(token)
      setTransactions(res.transactions)
    } catch {
      // keep previous
    } finally {
      setTxLoading(false)
    }
  }, [token])

  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void fetchBalance()
    void fetchTransactions()
    const id = setInterval(() => void fetchBalance(), 30_000)
    return () => clearInterval(id)
  }, [fetchBalance, fetchTransactions])

  const handleCopyAddress = async () => {
    await navigator.clipboard.writeText(user.walletAddress)
    setCopied(true)
    toast.success('Wallet address copied')
    setTimeout(() => setCopied(false), 2000)
  }

  const handleLogout = () => {
    clearSession()
    onLogout()
  }

  const initials = user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div className="relative min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      {/* ambient blobs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden>
        <div style={{ position: 'absolute', top: '5%', left: '5%', width: 300, height: 300, borderRadius: '50%', background: 'radial-gradient(circle, rgba(133,177,237,0.20) 0%, transparent 70%)', filter: 'blur(60px)' }} />
        <div style={{ position: 'absolute', bottom: '10%', right: '5%', width: 260, height: 260, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,205,131,0.18) 0%, transparent 70%)', filter: 'blur(55px)' }} />
      </div>

      <div className="relative z-10 mx-auto max-w-md px-4 pb-12 pt-6">
        {/* Top nav */}
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="flex size-10 items-center justify-center rounded-xl text-sm font-bold text-white select-none"
              style={{ background: 'var(--accent)' }}
            >
              {initials}
            </div>
            <div>
              <p className="text-xs font-medium" style={{ color: 'var(--subtle)' }}>Good day,</p>
              <p className="text-sm font-bold" style={{ color: 'var(--ink)' }}>{user.name.split(' ')[0]}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onNavigate('profile')}
              className="flex size-9 items-center justify-center rounded-xl transition-colors hover:bg-black/5"
              style={{ color: 'var(--muted)' }}
              aria-label="Profile"
            >
              <User className="size-4" />
            </button>
            <button
              onClick={handleLogout}
              className="flex size-9 items-center justify-center rounded-xl transition-colors hover:bg-black/5"
              style={{ color: 'var(--muted)' }}
              aria-label="Sign out"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </header>

        {/* Balance card */}
        <motion.section
          className="rounded-3xl p-5 mb-4 relative overflow-hidden"
          style={glass}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* spectral strip */}
          <div className="absolute top-0 left-0 right-0 h-1" style={{ background: spectral }} />

          <div className="flex items-start justify-between mt-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--muted)' }}>
                Available Balance
              </p>
              <AnimatePresence mode="wait">
                {balanceLoading ? (
                  <motion.div
                    key="loading"
                    className="h-10 w-40 rounded-xl animate-pulse mb-1"
                    style={{ background: 'rgba(18,45,69,0.08)' }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  />
                ) : (
                  <motion.div
                    key="balance"
                    className="flex items-baseline gap-1.5"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                  >
                    <span className="display text-4xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                      {balance !== null ? parseFloat(balance).toFixed(2) : '0.00'}
                    </span>
                    <span className="text-base font-semibold" style={{ color: 'var(--muted)' }}>USDC</span>
                  </motion.div>
                )}
              </AnimatePresence>
              <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
                ≈ {balance !== null ? (parseFloat(balance) * 2650).toLocaleString('sw-TZ') : '0'} TZS
              </p>
            </div>
            <button
              onClick={() => void fetchBalance()}
              disabled={balanceLoading}
              className="flex size-8 items-center justify-center rounded-xl transition-all hover:bg-black/5 disabled:opacity-40"
              style={{ color: 'var(--subtle)' }}
              aria-label="Refresh balance"
            >
              <RefreshCw className={`size-4 ${balanceLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* wallet address */}
          <button
            onClick={() => { void handleCopyAddress() }}
            className="mt-4 flex items-center gap-2 rounded-xl px-3 py-2 w-full transition-all hover:bg-black/5 active:scale-[0.98]"
            style={{ background: 'rgba(18,45,69,0.04)', border: '1px solid rgba(18,45,69,0.08)' }}
          >
            <span className="mono text-[11px] truncate flex-1 text-left" style={{ color: 'var(--subtle)' }}>
              {user.walletAddress}
            </span>
            {copied ? <Check className="size-3 shrink-0 text-green-600" /> : <Copy className="size-3 shrink-0" style={{ color: 'var(--subtle)' }} />}
          </button>
        </motion.section>

        {/* Action buttons */}
        <motion.div
          className="grid grid-cols-4 gap-3 mb-4"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
        >
          {actionButtons.map(({ id, icon: Icon, label, color }) => (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              className="flex flex-col items-center gap-2 rounded-2xl py-4 transition-all hover:scale-[1.04] active:scale-[0.97]"
              style={{
                background: 'rgba(255,255,255,0.80)',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                border: '1px solid rgba(255,255,255,0.68)',
                boxShadow: '0 4px 16px rgba(18,45,69,0.06)',
              }}
            >
              <div
                className="flex size-10 items-center justify-center rounded-xl"
                style={{ background: `${color}18`, color }}
              >
                <Icon className="size-4" />
              </div>
              <span className="text-[11px] font-semibold" style={{ color: 'var(--ink-2)' }}>{label}</span>
            </button>
          ))}
        </motion.div>

        {/* Recent transactions */}
        <motion.section
          className="rounded-3xl p-5"
          style={glass}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.14, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-bold" style={{ color: 'var(--ink)' }}>Recent Activity</h3>
            <button
              onClick={() => onNavigate('history')}
              className="text-xs font-semibold"
              style={{ color: 'var(--accent-hover)' }}
            >
              See all
            </button>
          </div>

          {txLoading ? (
            <div className="space-y-3 mt-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="size-9 rounded-xl animate-pulse" style={{ background: 'rgba(18,45,69,0.07)' }} />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-32 rounded animate-pulse" style={{ background: 'rgba(18,45,69,0.07)' }} />
                    <div className="h-2.5 w-20 rounded animate-pulse" style={{ background: 'rgba(18,45,69,0.05)' }} />
                  </div>
                  <div className="h-3 w-16 rounded animate-pulse" style={{ background: 'rgba(18,45,69,0.07)' }} />
                </div>
              ))}
            </div>
          ) : transactions.length === 0 ? (
            <div className="flex flex-col items-center py-8 gap-2">
              <History className="size-8 opacity-20" style={{ color: 'var(--ink)' }} />
              <p className="text-sm" style={{ color: 'var(--muted)' }}>No transactions yet</p>
              <p className="text-xs" style={{ color: 'var(--subtle)' }}>Send or receive money to get started</p>
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {transactions.slice(0, 5).map((tx) => <TxRow key={tx.id} tx={tx} />)}
            </div>
          )}
        </motion.section>
      </div>
    </div>
  )
}
