import React, { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Users, ArrowLeftRight, AlertTriangle, CheckCircle,
  RefreshCw, Search, Shield, Ban, RotateCcw, X,
  TrendingUp, DollarSign, Activity, ChevronRight, Eye
} from 'lucide-react'
import { toast } from 'sonner'

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL as string
const ADMIN_SECRET_KEY = 'zaka_admin_secret' // stored in sessionStorage

type Tab = 'overview' | 'users' | 'transactions'

interface AdminStats {
  totalUsers: number
  totalTransactions: number
  totalFeesCollected: string
}

// KYC tier config — single source of truth for the admin UI
const KYC_TIERS: Record<number, { label: string; limit: string; color: string }> = {
  1: { label: 'Tier 1', limit: '$50,000 / mo',  color: '#5fbeff' },
  2: { label: 'Tier 2', limit: '$100,000 / mo', color: '#af8ff4' },
  3: { label: 'Tier 3', limit: 'Unlimited',     color: '#7ef1b3' },
}

interface AdminUser {
  id: string
  name: string
  phone: string
  email?: string
  walletAddress: string
  createdAt: string
  kycTier?: number
  suspended?: boolean
  suspendReason?: string
}

interface AdminTx {
  id: string
  userId: string
  type: string
  amount: string
  platformFee?: string
  status: string
  counterparty?: string
  counterpartyPhone?: string
  circleTxId?: string
  txHash?: string
  description?: string
  createdAt: string
  adminNote?: string
}

function useAdminApi() {
  const secret = sessionStorage.getItem(ADMIN_SECRET_KEY) ?? ''

  const call = useCallback(async (action: string, method = 'GET', body?: object, extra = '') => {
    const url = `${SUPABASE_URL}/functions/v1/admin?action=${action}${extra}`
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-admin-secret': secret,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
      throw new Error(err.error ?? res.statusText)
    }
    return res.json() as Promise<unknown>
  }, [secret])

  return { call }
}

// ── Login gate ────────────────────────────────────────────────────────────────
function AdminLogin({ onLogin }: { onLogin: () => void }) {
  const [secret, setSecret] = useState('')
  const [loading, setLoading] = useState(false)

  const tryLogin = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/admin?action=stats`, {
        headers: {
          'x-admin-secret': secret,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        },
      })
      if (res.status === 403) { toast.error('Wrong admin secret'); return }
      sessionStorage.setItem(ADMIN_SECRET_KEY, secret)
      onLogin()
    } catch {
      toast.error('Connection failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#0b1623 0%,#0d2540 100%)' }}>
      <motion.div
        className="w-full max-w-sm mx-4 rounded-3xl p-8 flex flex-col gap-6"
        style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)' }}
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-14 items-center justify-center rounded-2xl" style={{ background: 'linear-gradient(135deg,#1261a6,#0a3d6b)' }}>
            <Shield className="size-7 text-white" />
          </div>
          <h1 className="text-xl font-bold text-white">ZAKA Admin</h1>
          <p className="text-xs text-white/40">Business management console</p>
        </div>
        <div className="flex flex-col gap-3">
          <input
            type="password"
            placeholder="Admin secret"
            value={secret}
            onChange={e => setSecret(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void tryLogin() }}
            className="w-full rounded-xl px-4 py-3 text-sm text-white outline-none"
            style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}
          />
          <button
            onClick={() => { void tryLogin() }}
            disabled={loading || !secret}
            className="w-full rounded-xl py-3 text-sm font-semibold text-white disabled:opacity-40 transition-opacity"
            style={{ background: 'linear-gradient(135deg,#1261a6,#0a3d6b)' }}
          >
            {loading ? 'Verifying…' : 'Enter Console'}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color: string
}) {
  return (
    <div className="rounded-2xl p-5 flex flex-col gap-3" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="flex size-10 items-center justify-center rounded-xl" style={{ background: color + '22' }}>
        <Icon className="size-5" style={{ color }} />
      </div>
      <div>
        <p className="text-2xl font-bold text-white">{value}</p>
        <p className="text-xs font-medium text-white/50">{label}</p>
        {sub && <p className="text-[10px] text-white/30 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

// ── Overview tab ──────────────────────────────────────────────────────────────
function Overview({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [failed, setFailed] = useState<AdminTx[]>([])

  useEffect(() => {
    api.call('stats').then(d => setStats(d as AdminStats)).catch(() => toast.error('Could not load stats'))
    api.call('transactions', 'GET', undefined, '&status=failed&page=0')
      .then(d => setFailed((d as { transactions: AdminTx[] }).transactions ?? []))
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-3 gap-3">
        <StatCard icon={Users}       label="Total Users"    value={stats?.totalUsers ?? '—'}        color="#5fbeff" />
        <StatCard icon={ArrowLeftRight} label="Total Txs"   value={stats?.totalTransactions ?? '—'} color="#7ef1b3" />
        <StatCard icon={DollarSign}  label="Fees Collected" value={stats ? `$${stats.totalFeesCollected}` : '—'} sub="1% per tx" color="#ffcd83" />
      </div>
      {failed.length > 0 && (
        <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(240,92,107,0.30)' }}>
          <div className="px-4 py-3 flex items-center gap-2" style={{ background: 'rgba(240,92,107,0.12)' }}>
            <AlertTriangle className="size-4" style={{ color: '#f05c6b' }} />
            <span className="text-sm font-semibold" style={{ color: '#f05c6b' }}>{failed.length} Failed Transaction{failed.length !== 1 ? 's' : ''}</span>
          </div>
          {failed.slice(0, 5).map((tx, i) => (
            <div key={tx.id} className="px-4 py-3 flex items-center justify-between gap-3 text-xs"
              style={{ borderTop: i > 0 ? '1px solid rgba(255,255,255,0.06)' : 'none' }}>
              <div>
                <p className="font-semibold text-white/80">{tx.counterparty ?? '—'} · {parseFloat(tx.amount).toFixed(2)} USDC</p>
                <p className="text-white/40 mt-0.5">{new Date(tx.createdAt).toLocaleString()}</p>
              </div>
              <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ background: 'rgba(240,92,107,0.18)', color: '#f05c6b' }}>failed</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Users tab ─────────────────────────────────────────────────────────────────
function UsersTab({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [users, setUsers]   = useState<AdminUser[]>([])
  const [q, setQ]           = useState('')
  const [page, setPage]     = useState(0)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<AdminUser | null>(null)
  const [suspendReason, setSuspendReason] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    api.call('users', 'GET', undefined, `&page=${page}&q=${encodeURIComponent(q)}`)
      .then(d => setUsers((d as { users: AdminUser[] }).users ?? []))
      .catch(e => toast.error((e as Error).message))
      .finally(() => setLoading(false))
  }, [api, page, q])

  useEffect(() => { load() }, [load])

  const upgradeTier = async (u: AdminUser, tier: number) => {
    try {
      await api.call('set-tier', 'POST', { userId: u.id, tier })
      toast.success(`${u.name} upgraded to Tier ${tier}`)
      setSelected(s => s ? { ...s, kycTier: tier } : s)
      load()
    } catch (e) { toast.error((e as Error).message) }
  }

  const suspend = async (u: AdminUser) => {
    try {
      await api.call('suspend', 'POST', { userId: u.id, reason: suspendReason })
      toast.success(`${u.name} suspended`)
      setSelected(null)
      load()
    } catch (e) { toast.error((e as Error).message) }
  }

  const unsuspend = async (u: AdminUser) => {
    try {
      await api.call('unsuspend', 'POST', { userId: u.id })
      toast.success(`${u.name} reinstated`)
      load()
    } catch (e) { toast.error((e as Error).message) }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)' }}>
        <Search className="size-4 text-white/40 shrink-0" />
        <input className="flex-1 bg-transparent text-sm text-white placeholder:text-white/30 outline-none"
          placeholder="Search by name, phone or email…" value={q}
          onChange={e => { setQ(e.target.value); setPage(0) }} />
      </div>

      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
        {loading && <div className="py-8 text-center text-white/30 text-sm">Loading…</div>}
        {!loading && users.length === 0 && <div className="py-8 text-center text-white/30 text-sm">No users found</div>}
        {users.map((u, i) => (
          <div key={u.id}
            className="flex items-center gap-3 px-4 py-3.5 cursor-pointer hover:bg-white/5 transition-colors"
            style={{ borderTop: i > 0 ? '1px solid rgba(255,255,255,0.06)' : 'none' }}
            onClick={() => setSelected(u)}
          >
            <div className="flex size-9 items-center justify-center rounded-full shrink-0 text-sm font-bold text-white"
              style={{ background: u.suspended ? 'rgba(240,92,107,0.25)' : 'rgba(95,190,255,0.20)' }}>
              {u.name?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white truncate">{u.name}</p>
              <p className="text-xs text-white/40 truncate">{u.phone}</p>
            </div>
            {(() => { const t = KYC_TIERS[u.kycTier ?? 1]; return (
              <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: t.color + '22', color: t.color }}>{t.label}</span>
            )})()}
            {u.suspended && (
              <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ background: 'rgba(240,92,107,0.18)', color: '#f05c6b' }}>suspended</span>
            )}
            <ChevronRight className="size-4 text-white/20 shrink-0" />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
          className="flex-1 rounded-xl py-2 text-sm text-white/60 disabled:opacity-30 transition-opacity"
          style={{ border: '1px solid rgba(255,255,255,0.10)' }}>← Prev</button>
        <span className="text-xs text-white/30">Page {page + 1}</span>
        <button disabled={users.length < 25} onClick={() => setPage(p => p + 1)}
          className="flex-1 rounded-xl py-2 text-sm text-white/60 disabled:opacity-30 transition-opacity"
          style={{ border: '1px solid rgba(255,255,255,0.10)' }}>Next →</button>
      </div>

      {/* User detail drawer */}
      <AnimatePresence>
        {selected && (
          <motion.div className="fixed inset-0 z-50 flex items-end"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ background: 'rgba(0,0,0,0.65)' }} onClick={() => setSelected(null)}>
            <motion.div className="w-full rounded-t-3xl p-6 flex flex-col gap-5"
              style={{ background: '#0d1829', border: '1px solid rgba(255,255,255,0.10)' }}
              initial={{ y: 80 }} animate={{ y: 0 }} exit={{ y: 80 }}
              onClick={e => e.stopPropagation()}>
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-bold text-white">{selected.name}</h3>
                  <p className="text-xs text-white/40 mt-0.5">{selected.phone} · {selected.email ?? 'no email'}</p>
                  <p className="text-[10px] text-white/25 mt-1 font-mono break-all">{selected.walletAddress}</p>
                </div>
                <button onClick={() => setSelected(null)}><X className="size-5 text-white/40" /></button>
              </div>
              <div className="flex flex-col gap-3 text-xs" style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '12px 14px' }}>
                <div className="flex justify-between"><span className="text-white/40">Status</span><span className={selected.suspended ? 'text-red-400' : 'text-green-400'}>{selected.suspended ? 'Suspended' : 'Active'}</span></div>
                <div className="flex justify-between"><span className="text-white/40">KYC Tier</span>
                  {(() => { const t = KYC_TIERS[selected.kycTier ?? 1]; return <span className="font-bold" style={{ color: t.color }}>{t.label} — {t.limit}</span> })()}
                </div>
                <div className="flex justify-between"><span className="text-white/40">Joined</span><span className="text-white/70">{new Date(selected.createdAt).toLocaleDateString()}</span></div>
                {selected.suspendReason && <div className="flex justify-between gap-4"><span className="text-white/40 shrink-0">Reason</span><span className="text-red-300 text-right">{selected.suspendReason}</span></div>}
              </div>
              {/* KYC Tier upgrade */}
              <div className="flex flex-col gap-2">
                <p className="text-[11px] font-semibold text-white/40 uppercase tracking-wider">Upgrade KYC Tier</p>
                <div className="grid grid-cols-3 gap-2">
                  {([1,2,3] as const).map(tier => {
                    const t = KYC_TIERS[tier]
                    const isCurrent = (selected.kycTier ?? 1) === tier
                    return (
                      <button key={tier} disabled={isCurrent} onClick={() => { void upgradeTier(selected, tier) }}
                        className="rounded-xl py-2.5 flex flex-col items-center gap-0.5 text-xs font-bold transition-opacity disabled:opacity-40"
                        style={{ background: t.color + (isCurrent ? '30' : '15'), color: t.color, border: `1px solid ${t.color}${isCurrent ? '60' : '30'}` }}>
                        <span>{t.label}</span>
                        <span className="text-[9px] font-medium opacity-70">{t.limit}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
              {!selected.suspended ? (
                <div className="flex flex-col gap-2">
                  <input className="rounded-xl px-3 py-2.5 text-sm text-white outline-none"
                    style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(240,92,107,0.30)' }}
                    placeholder="Reason for suspension…" value={suspendReason}
                    onChange={e => setSuspendReason(e.target.value)} />
                  <button onClick={() => { void suspend(selected) }}
                    className="w-full rounded-xl py-3 text-sm font-semibold flex items-center justify-center gap-2"
                    style={{ background: 'rgba(240,92,107,0.15)', color: '#f05c6b', border: '1px solid rgba(240,92,107,0.30)' }}>
                    <Ban className="size-4" /> Suspend Account
                  </button>
                </div>
              ) : (
                <button onClick={() => { void unsuspend(selected) }}
                  className="w-full rounded-xl py-3 text-sm font-semibold flex items-center justify-center gap-2"
                  style={{ background: 'rgba(126,241,179,0.12)', color: '#7ef1b3', border: '1px solid rgba(126,241,179,0.25)' }}>
                  <CheckCircle className="size-4" /> Reinstate Account
                </button>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Transactions tab ──────────────────────────────────────────────────────────
function TransactionsTab({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [txs, setTxs]     = useState<AdminTx[]>([])
  const [page, setPage]   = useState(0)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<AdminTx | null>(null)
  const [circleLog, setCircleLog] = useState<object | null>(null)
  const [resolveNote, setResolveNote] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    api.call('transactions', 'GET', undefined, `&page=${page}&status=${status}`)
      .then(d => setTxs((d as { transactions: AdminTx[] }).transactions ?? []))
      .catch(e => toast.error((e as Error).message))
      .finally(() => setLoading(false))
  }, [api, page, status])

  useEffect(() => { load() }, [load])

  const viewCircleLog = async (tx: AdminTx) => {
    if (!tx.circleTxId || tx.circleTxId.startsWith('demo-')) {
      setCircleLog({ note: 'Demo transaction — no Circle log' })
      return
    }
    try {
      const data = await api.call('tx', 'GET', undefined, `&id=${tx.circleTxId}`)
      setCircleLog(data as object)
    } catch (e) { toast.error((e as Error).message) }
  }

  const retry = async (tx: AdminTx) => {
    try {
      const d = await api.call('retry', 'POST', { txRecordId: tx.id }) as { newTxId: string }
      toast.success('Retried — new tx: ' + d.newTxId)
      load()
    } catch (e) { toast.error((e as Error).message) }
  }

  const resolve = async (tx: AdminTx) => {
    try {
      await api.call('resolve', 'POST', { txRecordId: tx.id, note: resolveNote })
      toast.success('Marked as resolved')
      setSelected(null)
      load()
    } catch (e) { toast.error((e as Error).message) }
  }

  const statusColor = (s: string) => ({
    complete: '#7ef1b3', pending: '#ffcd83', failed: '#f05c6b',
  }[s] ?? '#aaa')

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        {['', 'pending', 'failed', 'complete'].map(s => (
          <button key={s} onClick={() => { setStatus(s); setPage(0) }}
            className="rounded-full px-3 py-1.5 text-xs font-semibold transition-all"
            style={{
              background: status === s ? 'rgba(95,190,255,0.18)' : 'rgba(255,255,255,0.06)',
              color: status === s ? '#5fbeff' : 'rgba(255,255,255,0.45)',
              border: `1px solid ${status === s ? 'rgba(95,190,255,0.35)' : 'rgba(255,255,255,0.08)'}`,
            }}>
            {s === '' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
        {loading && <div className="py-8 text-center text-white/30 text-sm">Loading…</div>}
        {!loading && txs.length === 0 && <div className="py-8 text-center text-white/30 text-sm">No transactions</div>}
        {txs.map((tx, i) => (
          <div key={tx.id}
            className="flex items-center gap-3 px-4 py-3.5 cursor-pointer hover:bg-white/5 transition-colors"
            style={{ borderTop: i > 0 ? '1px solid rgba(255,255,255,0.06)' : 'none' }}
            onClick={() => { setSelected(tx); setCircleLog(null); setResolveNote('') }}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold uppercase text-white/50">{tx.type}</span>
                <span className="text-sm font-semibold text-white">{parseFloat(tx.amount).toFixed(2)} USDC</span>
                {tx.platformFee && <span className="text-[10px] text-white/30">fee: {parseFloat(tx.platformFee).toFixed(4)}</span>}
              </div>
              <p className="text-xs text-white/40 truncate mt-0.5">{tx.counterparty ?? '—'} · {new Date(tx.createdAt).toLocaleString()}</p>
            </div>
            <span className="text-[10px] font-bold uppercase rounded-full px-2 py-0.5" style={{ background: statusColor(tx.status) + '22', color: statusColor(tx.status) }}>{tx.status}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button disabled={page === 0} onClick={() => setPage(p => p - 1)}
          className="flex-1 rounded-xl py-2 text-sm text-white/60 disabled:opacity-30"
          style={{ border: '1px solid rgba(255,255,255,0.10)' }}>← Prev</button>
        <span className="text-xs text-white/30">Page {page + 1}</span>
        <button disabled={txs.length < 50} onClick={() => setPage(p => p + 1)}
          className="flex-1 rounded-xl py-2 text-sm text-white/60 disabled:opacity-30"
          style={{ border: '1px solid rgba(255,255,255,0.10)' }}>Next →</button>
      </div>

      {/* Transaction detail drawer */}
      <AnimatePresence>
        {selected && (
          <motion.div className="fixed inset-0 z-50 flex items-end overflow-y-auto"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ background: 'rgba(0,0,0,0.65)' }} onClick={() => setSelected(null)}>
            <motion.div className="w-full rounded-t-3xl p-6 flex flex-col gap-4 max-h-[85vh] overflow-y-auto"
              style={{ background: '#0d1829', border: '1px solid rgba(255,255,255,0.10)' }}
              initial={{ y: 80 }} animate={{ y: 0 }} exit={{ y: 80 }}
              onClick={e => e.stopPropagation()}>
              <div className="flex items-start justify-between">
                <div>
                  <span className="text-[10px] font-bold uppercase" style={{ color: statusColor(selected.status) }}>{selected.status}</span>
                  <h3 className="text-lg font-bold text-white mt-0.5">{parseFloat(selected.amount).toFixed(2)} USDC</h3>
                  <p className="text-xs text-white/40">{selected.type} · {new Date(selected.createdAt).toLocaleString()}</p>
                </div>
                <button onClick={() => setSelected(null)}><X className="size-5 text-white/40" /></button>
              </div>

              {/* Details */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                {[
                  ['To', selected.counterparty ?? '—'],
                  ['Platform fee', selected.platformFee ? parseFloat(selected.platformFee).toFixed(4) + ' USDC' : '—'],
                  ['Circle TX', selected.circleTxId ? selected.circleTxId.slice(0, 16) + '…' : '—'],
                  ['TX Hash', selected.txHash ? selected.txHash.slice(0, 14) + '…' : '—'],
                  ['Note', selected.description ?? '—'],
                  ['Admin note', selected.adminNote ?? '—'],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <p className="text-white/35">{k}</p>
                    <p className="text-white/80 mt-0.5 break-all">{v}</p>
                  </div>
                ))}
              </div>

              {/* Circle log */}
              <button onClick={() => { void viewCircleLog(selected) }}
                className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm text-white/60 transition-colors hover:bg-white/5"
                style={{ border: '1px solid rgba(255,255,255,0.10)' }}>
                <Eye className="size-4" /> View Circle API log
              </button>
              {circleLog && (
                <pre className="text-[10px] text-white/50 rounded-xl p-3 overflow-x-auto"
                  style={{ background: 'rgba(0,0,0,0.30)' }}>
                  {JSON.stringify(circleLog, null, 2)}
                </pre>
              )}

              {/* Actions */}
              <div className="flex flex-col gap-2 pt-1">
                {selected.status === 'failed' && (
                  <button onClick={() => { void retry(selected) }}
                    className="w-full rounded-xl py-3 text-sm font-semibold flex items-center justify-center gap-2"
                    style={{ background: 'rgba(255,205,131,0.12)', color: '#ffcd83', border: '1px solid rgba(255,205,131,0.25)' }}>
                    <RotateCcw className="size-4" /> Retry Transaction
                  </button>
                )}
                {selected.status !== 'complete' && (
                  <div className="flex flex-col gap-2">
                    <input className="rounded-xl px-3 py-2.5 text-sm text-white outline-none"
                      style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(126,241,179,0.25)' }}
                      placeholder="Resolution note (optional)…" value={resolveNote}
                      onChange={e => setResolveNote(e.target.value)} />
                    <button onClick={() => { void resolve(selected) }}
                      className="w-full rounded-xl py-3 text-sm font-semibold flex items-center justify-center gap-2"
                      style={{ background: 'rgba(126,241,179,0.12)', color: '#7ef1b3', border: '1px solid rgba(126,241,179,0.25)' }}>
                      <CheckCircle className="size-4" /> Mark as Resolved
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Main admin panel ──────────────────────────────────────────────────────────
export default function AdminPanel() {
  const [authed, setAuthed] = useState(() => !!sessionStorage.getItem(ADMIN_SECRET_KEY))
  const [tab, setTab] = useState<Tab>('overview')
  const api = useAdminApi()

  if (!authed) return <AdminLogin onLogin={() => setAuthed(true)} />

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'overview',     label: 'Overview',     icon: Activity },
    { id: 'users',        label: 'Users',         icon: Users },
    { id: 'transactions', label: 'Transactions',  icon: ArrowLeftRight },
  ]

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'linear-gradient(135deg,#06101d 0%,#0b1829 100%)' }}>
      {/* Header */}
      <div className="sticky top-0 z-20 px-5 pt-safe-top"
        style={{ background: 'rgba(6,16,29,0.92)', borderBottom: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(16px)' }}>
        <div className="flex items-center justify-between py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-xl" style={{ background: 'linear-gradient(135deg,#1261a6,#0a3d6b)' }}>
              <Shield className="size-4 text-white" />
            </div>
            <div>
              <p className="text-sm font-bold text-white leading-none">ZAKA Admin</p>
              <p className="text-[10px] text-white/35">Business Console</p>
            </div>
          </div>
          <button onClick={() => { sessionStorage.removeItem(ADMIN_SECRET_KEY); setAuthed(false) }}
            className="text-xs text-white/30 hover:text-white/60 transition-colors">Sign out</button>
        </div>
        {/* Tab bar */}
        <div className="flex gap-1 pb-3">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setTab(id)}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold transition-all"
              style={{
                background: tab === id ? 'rgba(95,190,255,0.15)' : 'transparent',
                color: tab === id ? '#5fbeff' : 'rgba(255,255,255,0.35)',
              }}>
              <Icon className="size-3.5" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 px-4 py-5 max-w-2xl mx-auto w-full">
        <AnimatePresence mode="wait">
          <motion.div key={tab}
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}>
            {tab === 'overview'     && <Overview api={api} />}
            {tab === 'users'        && <UsersTab api={api} />}
            {tab === 'transactions' && <TransactionsTab api={api} />}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Platform info footer */}
      <div className="px-5 py-4 text-center">
        <p className="text-[10px] text-white/20">ZAKA · Platform fee 1% per transaction · Gas paid by sender</p>
        <p className="text-[10px] text-white/15 mt-0.5">support@zakaapp.com</p>
      </div>
    </div>
  )
}
