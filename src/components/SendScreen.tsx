import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, Search, Check, AlertCircle } from 'lucide-react'
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

export default function SendScreen({ user: _user, token, onBack, onSuccess }: Props) {
  const [step, setStep] = useState<Step>('recipient')
  const [phone, setPhone] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [txId, setTxId] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ name: string; phone: string }>>([])
  const [searching, setSearching] = useState(false)
  const [selectedContact, setSelectedContact] = useState<{ name: string; phone: string } | null>(null)

  const handleSearch = async (q: string) => {
    setPhone(q)
    setSelectedContact(null)
    if (q.length < 3) { setSearchResults([]); return }
    setSearching(true)
    try {
      const res = await api.getUsers(token, q)
      setSearchResults(res.users)
    } catch {
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }

  const handleSelectContact = (contact: { name: string; phone: string }) => {
    setSelectedContact(contact)
    setPhone(contact.phone)
    setSearchResults([])
    setStep('amount')
  }

  const handleSend = async () => {
    setLoading(true)
    try {
      const res = await api.send(token, { toPhone: normalisePhone(phone), amount, note: note || undefined })
      setTxId(res.txId)
      setStep('success')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Transfer failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="relative min-h-dvh overflow-x-hidden"
      style={{ background: 'var(--bg-gradient)' }}
    >
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div style={{ position: 'absolute', top: '8%', right: '8%', width: 240, height: 240, borderRadius: '50%', background: 'radial-gradient(circle, rgba(133,177,237,0.20) 0%, transparent 70%)', filter: 'blur(50px)' }} />
      </div>

      <div className="relative z-10 mx-auto max-w-md px-4 pb-10 pt-6">
        {/* Header */}
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
          {/* Step 1: Recipient */}
          {step === 'recipient' && (
            <motion.div key="recipient" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.28 }}>
              <div className="rounded-3xl p-5" style={glass.card}>
                <p className="text-sm font-semibold mb-3" style={{ color: 'var(--ink)' }}>Who are you sending to?</p>
                <div className="rounded-2xl px-4 py-3 flex items-center gap-2 mb-2" style={glass.inner}>
                  <Search className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => void handleSearch(e.target.value)}
                    placeholder="+255 712 345 678 or name"
                    className="w-full bg-transparent text-sm outline-none placeholder:opacity-40"
                    style={{ color: 'var(--ink)' }}
                    inputMode="tel"
                    autoFocus
                  />
                  {searching && (
                    <svg className="size-4 animate-spin shrink-0" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--subtle)' }}>
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
                    </svg>
                  )}
                </div>

                {searchResults.length > 0 && (
                  <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                    {searchResults.map((c) => (
                      <button
                        key={c.phone}
                        onClick={() => handleSelectContact(c)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-black/5 transition-colors"
                      >
                        <div className="flex size-8 items-center justify-center rounded-full text-xs font-bold text-white shrink-0" style={{ background: 'var(--accent)' }}>
                          {c.name[0]}
                        </div>
                        <div>
                          <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{c.name}</p>
                          <p className="text-xs" style={{ color: 'var(--subtle)' }}>{c.phone}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {phone.length >= 10 && searchResults.length === 0 && !searching && (
                  <button
                    onClick={() => setStep('amount')}
                    className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white mt-3 transition-all hover:scale-[1.01] active:scale-[0.99]"
                    style={{ background: 'var(--accent)' }}
                  >
                    Send to {phone}
                  </button>
                )}
              </div>
            </motion.div>
          )}

          {/* Step 2: Amount */}
          {step === 'amount' && (
            <motion.div key="amount" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.28 }}>
              <div className="rounded-3xl p-5 space-y-4" style={glass.card}>
                {selectedContact && (
                  <div className="flex items-center gap-3 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
                    <div className="flex size-10 items-center justify-center rounded-full text-sm font-bold text-white" style={{ background: 'var(--accent)' }}>
                      {selectedContact.name[0]}
                    </div>
                    <div>
                      <p className="text-sm font-bold" style={{ color: 'var(--ink)' }}>{selectedContact.name}</p>
                      <p className="text-xs" style={{ color: 'var(--subtle)' }}>{selectedContact.phone}</p>
                    </div>
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
                    <button
                      key={a}
                      onClick={() => setAmount(a)}
                      className="flex-1 rounded-xl py-2 text-xs font-semibold transition-all hover:scale-[1.04] active:scale-[0.97]"
                      style={{
                        background: amount === a ? 'var(--accent)' : 'rgba(18,45,69,0.06)',
                        color: amount === a ? 'white' : 'var(--ink-2)',
                      }}
                    >
                      ${a}
                    </button>
                  ))}
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--muted)' }}>Note (optional)</p>
                  <div className="rounded-2xl px-4 py-3" style={glass.inner}>
                    <input
                      type="text"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. Rent, lunch, etc."
                      className="w-full bg-transparent text-sm outline-none placeholder:opacity-40"
                      style={{ color: 'var(--ink)' }}
                      maxLength={60}
                    />
                  </div>
                </div>

                <button
                  onClick={() => setStep('confirm')}
                  disabled={!amount || parseFloat(amount) <= 0}
                  className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: 'var(--accent)' }}
                >
                  Review Transfer
                </button>
              </div>
            </motion.div>
          )}

          {/* Step 3: Confirm */}
          {step === 'confirm' && (
            <motion.div key="confirm" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.28 }}>
              <div className="rounded-3xl p-5 space-y-4" style={glass.card}>
                <p className="text-sm font-bold" style={{ color: 'var(--ink)' }}>Confirm Transfer</p>

                <div className="rounded-2xl p-4 space-y-3" style={{ background: 'rgba(18,45,69,0.04)', border: '1px solid var(--border)' }}>
                  {[
                    { label: 'To', value: selectedContact ? `${selectedContact.name} (${phone})` : phone },
                    { label: 'Amount', value: `${parseFloat(amount).toFixed(2)} USDC` },
                    { label: 'Est. in TZS', value: `≈ ${(parseFloat(amount) * 2650).toLocaleString('sw-TZ')} TZS` },
                    { label: 'Fee', value: 'Free on Arc' },
                    ...(note ? [{ label: 'Note', value: note }] : []),
                  ].map(({ label, value }) => (
                    <div key={label} className="flex justify-between text-sm">
                      <span style={{ color: 'var(--muted)' }}>{label}</span>
                      <span className="font-semibold" style={{ color: 'var(--ink)' }}>{value}</span>
                    </div>
                  ))}
                </div>

                <div className="flex items-start gap-2 rounded-2xl p-3" style={{ background: 'rgba(255,205,131,0.15)', border: '1px solid rgba(255,205,131,0.4)' }}>
                  <AlertCircle className="size-4 shrink-0 mt-0.5" style={{ color: '#b45309' }} />
                  <p className="text-xs" style={{ color: '#92400e' }}>
                    This transfer is instant and cannot be reversed. Confirm the recipient is correct.
                  </p>
                </div>

                <button
                  onClick={() => { void handleSend() }}
                  disabled={loading}
                  className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
                  style={{ background: 'var(--accent)' }}
                >
                  {loading
                    ? <span className="flex items-center justify-center gap-2">
                        <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" /></svg>
                        Sending...
                      </span>
                    : `Send ${parseFloat(amount).toFixed(2)} USDC`
                  }
                </button>
              </div>
            </motion.div>
          )}

          {/* Success */}
          {step === 'success' && (
            <motion.div key="success" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}>
              <div className="rounded-3xl p-8 flex flex-col items-center text-center space-y-4" style={glass.card}>
                <motion.div
                  className="flex size-16 items-center justify-center rounded-full"
                  style={{ background: 'rgba(26,128,71,0.12)' }}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 200, damping: 16, delay: 0.1 }}
                >
                  <Check className="size-8" style={{ color: 'var(--success)' }} />
                </motion.div>
                <div>
                  <h2 className="display text-2xl font-bold" style={{ color: 'var(--ink)' }}>Sent!</h2>
                  <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
                    {parseFloat(amount).toFixed(2)} USDC sent to {selectedContact?.name ?? phone}
                  </p>
                </div>
                {txId && (
                  <p className="mono text-[11px]" style={{ color: 'var(--subtle)' }}>TX: {txId.slice(0, 20)}...</p>
                )}
                <button
                  onClick={onSuccess}
                  className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white"
                  style={{ background: 'var(--accent)' }}
                >
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
