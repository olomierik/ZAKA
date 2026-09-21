import React, { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, Send, Download, ArrowDownToLine, ArrowUpFromLine, Search } from 'lucide-react'
import { api } from '../lib/api'
import type { ZakaTransaction } from '../types/zaka'

interface Props {
  token: string
  onBack: () => void
}

const glass = {
  card: {
    background: 'rgba(255,255,255,0.72)',
    backdropFilter: 'blur(24px) saturate(180%)',
    WebkitBackdropFilter: 'blur(24px) saturate(180%)',
    border: '1px solid rgba(255,255,255,0.68)',
    boxShadow: '0 8px 32px rgba(18,45,69,0.08), inset 0 1px 0 rgba(255,255,255,0.55)',
  } as React.CSSProperties,
  inner: {
    background: 'rgba(255,255,255,0.5)',
    border: '1px solid rgba(18,45,69,0.1)',
  } as React.CSSProperties,
}

const FILTERS = ['All', 'Sent', 'Received', 'Deposit', 'Withdrawal'] as const
type Filter = typeof FILTERS[number]

const iconMap = {
  send: Send,
  receive: Download,
  deposit: ArrowDownToLine,
  withdraw: ArrowUpFromLine,
}

export default function HistoryScreen({ token, onBack }: Props) {
  const [transactions, setTransactions] = useState<ZakaTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('All')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const fetch = async () => {
      try {
        const res = await api.getTransactions(token)
        setTransactions(res.transactions)
      } finally {
        setLoading(false)
      }
    }
    void fetch()
  }, [token])

  const filtered = transactions.filter((tx) => {
    const matchFilter =
      filter === 'All' ||
      (filter === 'Sent' && tx.type === 'send') ||
      (filter === 'Received' && tx.type === 'receive') ||
      (filter === 'Deposit' && tx.type === 'deposit') ||
      (filter === 'Withdrawal' && tx.type === 'withdraw')

    const matchSearch =
      !search ||
      tx.counterparty?.toLowerCase().includes(search.toLowerCase()) ||
      tx.counterpartyPhone?.includes(search) ||
      tx.description?.toLowerCase().includes(search.toLowerCase())

    return matchFilter && matchSearch
  })

  return (
    <div
      className="relative min-h-dvh overflow-x-hidden"
      style={{ background: 'var(--bg-gradient)' }}
    >
      <div className="relative z-10 mx-auto max-w-md px-4 pb-10 pt-6">
        <header className="mb-6 flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex size-10 items-center justify-center rounded-xl transition-all hover:bg-black/5"
            style={{ border: '1px solid var(--border)' }}
          >
            <ArrowLeft className="size-4" style={{ color: 'var(--ink)' }} />
          </button>
          <h1 className="display text-lg font-bold" style={{ color: 'var(--ink)' }}>Transaction History</h1>
        </header>

        {/* Search */}
        <div className="rounded-2xl px-4 py-3 flex items-center gap-2 mb-4" style={glass.inner}>
          <Search className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search transactions..."
            className="w-full bg-transparent text-sm outline-none placeholder:opacity-40"
            style={{ color: 'var(--ink)' }}
          />
        </div>

        {/* Filters */}
        <div className="flex gap-2 mb-4 overflow-x-auto pb-1 scrollbar-hide">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="shrink-0 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all"
              style={{
                background: filter === f ? 'var(--accent)' : 'rgba(255,255,255,0.72)',
                color: filter === f ? 'white' : 'var(--ink-2)',
                border: `1px solid ${filter === f ? 'transparent' : 'rgba(18,45,69,0.10)'}`,
              }}
            >
              {f}
            </button>
          ))}
        </div>

        {/* List */}
        <motion.section
          className="rounded-3xl"
          style={glass.card}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          {loading ? (
            <div className="p-5 space-y-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="size-9 rounded-xl animate-pulse" style={{ background: 'rgba(18,45,69,0.07)' }} />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-36 rounded animate-pulse" style={{ background: 'rgba(18,45,69,0.07)' }} />
                    <div className="h-2.5 w-24 rounded animate-pulse" style={{ background: 'rgba(18,45,69,0.05)' }} />
                  </div>
                  <div className="h-3 w-16 rounded animate-pulse" style={{ background: 'rgba(18,45,69,0.07)' }} />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center py-12 gap-2">
              <p className="text-sm" style={{ color: 'var(--muted)' }}>No transactions found</p>
            </div>
          ) : (
            <div className="divide-y px-5" style={{ borderColor: 'var(--border)' }}>
              {filtered.map((tx) => {
                const isIn = tx.type === 'receive' || tx.type === 'deposit'
                const Icon = iconMap[tx.type]
                return (
                  <div key={tx.id} className="flex items-center gap-3 py-3.5">
                    <div
                      className="flex size-9 shrink-0 items-center justify-center rounded-xl"
                      style={{
                        background: isIn ? 'rgba(26,128,71,0.10)' : 'rgba(18,45,69,0.07)',
                        color: isIn ? 'var(--success)' : 'var(--ink-2)',
                      }}
                    >
                      <Icon className="size-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: 'var(--ink)' }}>
                        {tx.type === 'send' && `To ${tx.counterpartyPhone ?? tx.counterparty ?? 'contact'}`}
                        {tx.type === 'receive' && `From ${tx.counterpartyPhone ?? tx.counterparty ?? 'contact'}`}
                        {tx.type === 'deposit' && 'Added money'}
                        {tx.type === 'withdraw' && `Cashed out to ${tx.description ?? 'mobile'}`}
                      </p>
                      <p className="text-xs" style={{ color: 'var(--subtle)' }}>
                        {new Date(tx.createdAt).toLocaleDateString('en-TZ', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold tabular-nums" style={{ color: isIn ? 'var(--success)' : 'var(--ink)' }}>
                        {isIn ? '+' : '-'}{parseFloat(tx.amount).toFixed(2)}
                      </p>
                      <p className="text-[10px] font-medium uppercase" style={{ color: 'var(--subtle)' }}>USDC</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </motion.section>
      </div>
    </div>
  )
}
