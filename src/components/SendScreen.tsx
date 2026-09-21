import React, { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, Search, Check, AlertCircle, User, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { normalisePhone } from '../lib/phone'
import type { ZakaUser } from '../types/zaka'

interface Props {
  user: ZakaUser
  token: string
  onBack: () => void
  onSuccess: () => void
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

const QUICK_AMOUNTS = ['1', '5', '10', '20', '50']

type Step = 'recipient' | 'amount' | 'confirm' | 'success'

// Detect what the user typed
function detectInputType(val: string): 'address' | 'phone' | 'name' {
  if (/^0x[0-9a-fA-F]{10,40}$/i.test(val)) return 'address'
  if (/^[+\d\s()-]{7,}$/.test(val)) return 'phone'
  return 'name'
}

interface Recipient {
  label: string        // display name or shortened address
  sublabel: string     // phone or full address
  phone?: string       // set for ZAKA users
  address?: string     // set for 0x addresses
  isZaka: boolean
  avatarLetter: string
}

export default function SendScreen({ user: _user, token, onBack, onSuccess }: Props) {
  const [step, setStep] = useState<Step>('recipient')
  const [query, setQuery] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [txId, setTxId] = useState('')
  const [recipientName, setRecipientName] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ name: string; phone: string }>>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<Recipient | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-detect and search as user types
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setSelected(null)

    const q = query.trim()
    if (!q) { setSearchResults([]); return }

    // If it looks like a complete wallet address, resolve it immediately
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
      setSearchResults([])
      return
    }

    // Otherwise search ZAKA users by phone/name
    if (q.length < 2) { setSearchResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const normalised = normalisePhone(q)
        const res = await api.getUsers(token, normalised !== q ? normalised : q)
        setSearchResults(res.users)
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 280)
  }, [query, token])

  const resolvedRecipient: Recipient | null = (() => {
    if (selected) return selected
    const q = query.trim()
    if (!q) return null
    // Full 0x address typed directly
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
      return {
        label: q.slice(0, 6) + '...' + q.slice(-4),
        sublabel: q,
        address: q,
        isZaka: false,
        avatarLetter: '0x',
      }
    }
    return null
  })()

  const canProceed = !!resolvedRecipient

  const handleSelectContact = (c: { name: string; phone: string }) => {
    const r: Recipient = {
      label: c.name,
      sublabel: c.phone,
      phone: c.phone,
      isZaka: true,
      avatarLetter: c.name[0]?.toUpperCase() ?? '?',
    }
    setSelected(r)
    setQuery(c.name)
    setSearchResults([])
    setStep('amount')
  }

  const handleProceedWithQuery = () => {
    if (!resolvedRecipient) return
    setStep('amount')
  }

  const handleSend = async () => {
    if (!resolvedRecipient) return
    setLoading(true)
    try {
      const body: { toPhone?: string; toAddress?: string; amount: string; note?: string } = {
        amount,
        note: note || undefined,
      }
      if (resolvedRecipient.phone) {
        body.toPhone = normalisePhone(resolvedRecipient.phone)
      } else if (resolvedRecipient.address) {
        body.toAddress = resolvedRecipient.address
      }

      const res = await api.send(token, body)
      setTxId(res.txId)
      setRecipientName(res.recipient ?? resolvedRecipient.label)
      setStep('success')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Transfer failed')
    } finally {
      setLoading(false)
    }
  }

  const inputType = detectInputType(query)

  return (
    <div className="relative min-h-dvh overflow-x-hidden" style={{ background: 'var(--bg-gradient)' }}>
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div style={{ position: 'absolute', top: '8%', right: '8%', width: 240, height: 240, borderRadius: '50%', background: 'radial-gradient(circle, rgba(133,177,237,0.20) 0%, transparent 70%)', filter: 'blur(50px)' }} />
      </div>

      <div className="relative z-10 mx-auto max-w-md px-4 pb-10 pt-6">
        <header className="mb-6 flex items-center gap-3">
          <button
            onClick={step === 'recipient' ? onBack : () => setStep(step === 'amount' ? 'recipient' : step === 'confirm' ? 'amount' : 'recipient')}
            className="flex size-10 items-center justify-center rounded-xl transition-all hover:bg-black/5"
            style={{ border: '1px solid var(--border)' }}
          >
            <ArrowLeft className="size-4" style={{ color: 'var(--ink)' }} />
          </button>
          <div>
            <h1 className="display text-lg font-bold" style={{ color: 'var(--ink)' }}>Send Money</h1>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Step {step === 'recipient' ? 1 : step === 'amount' ? 2 : step === 'confirm' ? 3 : '—'} of 3
            </p>
          </div>
        </header>

        <AnimatePresence mode="wait">
          {/* ── Step 1: Recipient ── */}
          {step === 'recipient' && (
            <motion.div key="recipient" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.28 }}>
              <div className="rounded-3xl p-5 space-y-3" style={glass.card}>
                <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Who are you sending to?</p>

                {/* Smart input */}
                <div className="rounded-2xl px-4 py-3 flex items-center gap-2" style={glass.inner}>
                  <Search className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Name, phone number, or 0x address"
                    className="w-full bg-transparent text-sm outline-none placeholder:opacity-40"
                    style={{ color: 'var(--ink)' }}
                    autoFocus
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                  {searching && (
                    <svg className="size-4 animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
                    </svg>
                  )}
                </div>

                {/* Input type hint */}
                {query.length > 0 && (
                  <div className="flex items-center gap-1.5 px-1">
                    {inputType === 'address' ? (
                      <><Wallet className="size-3" style={{ color: 'var(--subtle)' }} /><span className="text-xs" style={{ color: 'var(--subtle)' }}>Wallet address detected</span></>
                    ) : inputType === 'phone' ? (
                      <><User className="size-3" style={{ color: 'var(--subtle)' }} /><span className="text-xs" style={{ color: 'var(--subtle)' }}>Searching ZAKA users by phone...</span></>
                    ) : (
                      <><User className="size-3" style={{ color: 'var(--subtle)' }} /><span className="text-xs" style={{ color: 'var(--subtle)' }}>Searching ZAKA users by name...</span></>
                    )}
                  </div>
                )}

                {/* ZAKA user search results */}
                {searchResults.length > 0 && (
                  <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                    {searchResults.map((c) => (
                      <button
                        key={c.phone}
                        onClick={() => handleSelectContact(c)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-black/5 active:bg-black/10 transition-colors"
                      >
                        <div className="flex size-9 items-center justify-center rounded-full text-xs font-bold text-white shrink-0" style={{ background: 'var(--accent)' }}>
                          {c.name[0]?.toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate" style={{ color: 'var(--ink)' }}>{c.name}</p>
                          <p className="text-xs truncate" style={{ color: 'var(--subtle)' }}>{c.phone}</p>
                        </div>
                        <div className="ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: 'rgba(26,128,71,0.12)', color: 'var(--success)' }}>
                          ZAKA
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* No results hint for phone/name search */}
                {query.length >= 3 && searchResults.length === 0 && !searching && inputType !== 'address' && (
                  <p className="text-xs px-1" style={{ color: 'var(--muted)' }}>
                    No ZAKA users found. You can also paste a wallet address (0x...) to send directly.
                  </p>
                )}

                {/* Resolved recipient preview (address or selected) */}
                {resolvedRecipient && (
                  <div className="rounded-2xl p-3 flex items-center gap-3" style={{ background: resolvedRecipient.isZaka ? 'rgba(26,128,71,0.08)' : 'rgba(18,45,69,0.05)', border: `1px solid ${resolvedRecipient.isZaka ? 'rgba(26,128,71,0.2)' : 'var(--border)'}` }}>
                    <div className="flex size-9 items-center justify-center rounded-full text-xs font-bold text-white shrink-0"
                      style={{ background: resolvedRecipient.isZaka ? 'var(--success)' : 'var(--accent)' }}>
                      {resolvedRecipient.isZaka ? resolvedRecipient.avatarLetter : <Wallet className="size-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate" style={{ color: 'var(--ink)' }}>{resolvedRecipient.label}</p>
                      <p className="text-xs truncate" style={{ color: 'var(--subtle)' }}>{resolvedRecipient.sublabel}</p>
                    </div>
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                      style={resolvedRecipient.isZaka
                        ? { background: 'rgba(26,128,71,0.12)', color: 'var(--success)' }
                        : { background: 'rgba(18,45,69,0.08)', color: 'var(--muted)' }}>
                      {resolvedRecipient.isZaka ? 'ZAKA' : 'External'}
                    </span>
                  </div>
                )}

                {canProceed && (
                  <button
                    onClick={handleProceedWithQuery}
                    className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99]"
                    style={{ background: 'var(--accent)' }}
                  >
                    Continue
                  </button>
                )}
              </div>
            </motion.div>
          )}

          {/* ── Step 2: Amount ── */}
          {step === 'amount' && (
            <motion.div key="amount" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.28 }}>
              <div className="rounded-3xl p-5 space-y-4" style={glass.card}>
                {resolvedRecipient && (
                  <div className="flex items-center gap-3 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
                    <div className="flex size-10 items-center justify-center rounded-full text-sm font-bold text-white shrink-0"
                      style={{ background: resolvedRecipient.isZaka ? 'var(--success)' : 'var(--accent)' }}>
                      {resolvedRecipient.isZaka ? resolvedRecipient.avatarLetter : <Wallet className="size-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold truncate" style={{ color: 'var(--ink)' }}>{resolvedRecipient.label}</p>
                      <p className="text-xs truncate" style={{ color: 'var(--subtle)' }}>{resolvedRecipient.sublabel}</p>
                    </div>
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                      style={resolvedRecipient.isZaka
                        ? { background: 'rgba(26,128,71,0.12)', color: 'var(--success)' }
                        : { background: 'rgba(18,45,69,0.08)', color: 'var(--muted)' }}>
                      {resolvedRecipient.isZaka ? 'ZAKA' : 'External'}
                    </span>
                  </div>
                )}

                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--muted)' }}>Amount (USDC)</p>
                  <div className="rounded-2xl p-4" style={glass.inner}>
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^0-9.]/g, '')
                        if (v === '' || /^\d*\.?\d*$/.test(v)) setAmount(v)
                      }}
                      placeholder="0.00"
                      className="display w-full bg-transparent text-4xl font-bold tabular-nums outline-none placeholder:text-slate-300"
                      style={{ color: 'var(--ink)' }}
                      autoFocus
                    />
                    <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
                      ≈ {amount ? (parseFloat(amount || '0') * 2650).toLocaleString('sw-TZ') : '0'} TZS
                    </p>
                  </div>
                </div>

                <div className="flex gap-2">
                  {QUICK_AMOUNTS.map((a) => (
                    <button key={a} onClick={() => setAmount(a)}
                      className="flex-1 rounded-xl py-2 text-xs font-semibold transition-all hover:scale-[1.04] active:scale-[0.97]"
                      style={{ background: amount === a ? 'var(--accent)' : 'rgba(18,45,69,0.06)', color: amount === a ? 'white' : 'var(--ink-2)' }}>
                      ${a}
                    </button>
                  ))}
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--muted)' }}>Note (optional)</p>
                  <div className="rounded-2xl px-4 py-3" style={glass.inner}>
                    <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. Rent, lunch, etc."
                      className="w-full bg-transparent text-sm outline-none placeholder:opacity-40"
                      style={{ color: 'var(--ink)' }} maxLength={60} />
                  </div>
                </div>

                <button onClick={() => setStep('confirm')} disabled={!amount || parseFloat(amount) <= 0}
                  className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: 'var(--accent)' }}>
                  Review Transfer
                </button>
              </div>
            </motion.div>
          )}

          {/* ── Step 3: Confirm ── */}
          {step === 'confirm' && (
            <motion.div key="confirm" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.28 }}>
              <div className="rounded-3xl p-5 space-y-4" style={glass.card}>
                <p className="text-sm font-bold" style={{ color: 'var(--ink)' }}>Confirm Transfer</p>

                <div className="rounded-2xl p-4 space-y-3" style={{ background: 'rgba(18,45,69,0.04)', border: '1px solid var(--border)' }}>
                  {[
                    { label: 'To', value: resolvedRecipient ? `${resolvedRecipient.label}` : query },
                    { label: 'Via', value: resolvedRecipient?.isZaka ? 'ZAKA user' : 'External wallet' },
                    { label: 'Amount', value: `${parseFloat(amount).toFixed(2)} USDC` },
                    { label: 'Est. in TZS', value: `≈ ${(parseFloat(amount) * 2650).toLocaleString('sw-TZ')} TZS` },
                    { label: 'Fee', value: 'Free on Arc' },
                    ...(note ? [{ label: 'Note', value: note }] : []),
                  ].map(({ label, value }) => (
                    <div key={label} className="flex justify-between text-sm gap-2">
                      <span className="shrink-0" style={{ color: 'var(--muted)' }}>{label}</span>
                      <span className="font-semibold text-right break-all" style={{ color: 'var(--ink)' }}>{value}</span>
                    </div>
                  ))}
                </div>

                {!resolvedRecipient?.isZaka && (
                  <div className="flex items-start gap-2 rounded-2xl p-3" style={{ background: 'rgba(255,205,131,0.15)', border: '1px solid rgba(255,205,131,0.4)' }}>
                    <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: '#b45309' }} />
                    <p className="text-xs" style={{ color: '#92400e' }}>
                      Sending to an external wallet. Double-check the address — this cannot be reversed.
                    </p>
                  </div>
                )}

                <div className="flex items-start gap-2 rounded-2xl p-3" style={{ background: 'rgba(255,205,131,0.10)', border: '1px solid rgba(255,205,131,0.3)' }}>
                  <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: '#b45309' }} />
                  <p className="text-xs" style={{ color: '#92400e' }}>
                    This transfer is instant and cannot be reversed. Confirm the recipient is correct.
                  </p>
                </div>

                <button onClick={() => { void handleSend() }} disabled={loading}
                  className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
                  style={{ background: 'var(--accent)' }}>
                  {loading
                    ? <span className="flex items-center justify-center gap-2">
                        <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" /></svg>
                        Sending...
                      </span>
                    : `Send ${parseFloat(amount).toFixed(2)} USDC`}
                </button>
              </div>
            </motion.div>
          )}

          {/* ── Success ── */}
          {step === 'success' && (
            <motion.div key="success" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
              <div className="rounded-3xl p-8 flex flex-col items-center text-center space-y-4" style={glass.card}>
                <motion.div className="flex size-16 items-center justify-center rounded-full" style={{ background: 'rgba(26,128,71,0.12)' }}
                  initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 16, delay: 0.1 }}>
                  <Check className="size-8" style={{ color: 'var(--success)' }} />
                </motion.div>
                <div>
                  <h2 className="display text-2xl font-bold" style={{ color: 'var(--ink)' }}>Sent!</h2>
                  <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
                    {parseFloat(amount).toFixed(2)} USDC sent to {recipientName || resolvedRecipient?.label || query}
                  </p>
                </div>
                {txId && (
                  <p className="mono text-[11px]" style={{ color: 'var(--subtle)' }}>TX: {txId.slice(0, 20)}...</p>
                )}
                <button onClick={onSuccess} className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white" style={{ background: 'var(--accent)' }}>
                  Back to Home
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
