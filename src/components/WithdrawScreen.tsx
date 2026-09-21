import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, Check, AlertCircle, Phone } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import type { ZakaUser } from '../types/zaka'

interface Props {
  user: ZakaUser
  token: string
  balance: string
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

const spectral = 'linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b, #ffcd83, #7ef1b3)'

const PROVIDERS = [
  { id: 'mpesa', label: 'M-Pesa', country: 'TZ' },
  { id: 'tigo', label: 'Tigo Pesa', country: 'TZ' },
  { id: 'airtel', label: 'Airtel Money', country: 'TZ' },
  { id: 'halopesa', label: 'HaloPesa', country: 'TZ' },
]

const QUICK_AMOUNTS = ['5', '10', '20', '50', '100']

type Step = 'form' | 'confirm' | 'success'

export default function WithdrawScreen({ user, token, balance, onBack, onSuccess }: Props) {
  const [step, setStep] = useState<Step>('form')
  const [provider, setProvider] = useState('mpesa')
  const [phone, setPhone] = useState(user.phone)
  const [amount, setAmount] = useState('')
  const [loading, setLoading] = useState(false)
  const [reference, setReference] = useState('')

  const maxAmount = parseFloat(balance || '0')
  const amountNum = parseFloat(amount || '0')
  const tzsAmount = (amountNum * 2650).toLocaleString('sw-TZ')
  const fee = amountNum > 0 ? Math.max(0.1, amountNum * 0.005).toFixed(2) : '0.00'
  const receive = amountNum > 0 ? Math.max(0, amountNum - parseFloat(fee)) : 0

  const isValid = amountNum > 0 && amountNum <= maxAmount && phone.length >= 10

  const handleWithdraw = async () => {
    setLoading(true)
    try {
      const res = await api.withdraw(token, { phone, amount, provider })
      setReference(res.reference)
      setStep('success')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Withdrawal failed')
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
        <div style={{ position: 'absolute', top: '6%', left: '8%', width: 260, height: 260, borderRadius: '50%', background: 'radial-gradient(circle, rgba(186,43,76,0.10) 0%, transparent 70%)', filter: 'blur(55px)' }} />
      </div>

      <div className="relative z-10 mx-auto max-w-md px-4 pb-10 pt-6">
        <header className="mb-6 flex items-center gap-3">
          <button
            onClick={step === 'form' ? onBack : () => setStep('form')}
            className="flex size-10 items-center justify-center rounded-xl transition-all hover:bg-black/5"
            style={{ border: '1px solid var(--border)' }}
          >
            <ArrowLeft className="size-4" style={{ color: 'var(--ink)' }} />
          </button>
          <h1 className="display text-lg font-bold" style={{ color: 'var(--ink)' }}>Cash Out</h1>
        </header>

        <AnimatePresence mode="wait">
          {step === 'form' && (
            <motion.div key="form" className="space-y-4" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
              {/* Balance */}
              <div className="rounded-2xl px-4 py-3 flex items-center justify-between" style={glass.inner}>
                <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>Available</span>
                <span className="display text-lg font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                  {parseFloat(balance || '0').toFixed(2)} USDC
                </span>
              </div>

              {/* Provider */}
              <section className="rounded-3xl p-5 relative overflow-hidden" style={glass.card}>
                <div className="absolute top-0 left-0 right-0 h-1" style={{ background: spectral }} />
                <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>
                  Mobile Money Provider
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setProvider(p.id)}
                      className="flex items-center gap-2 rounded-2xl px-3 py-2.5 text-left transition-all hover:scale-[1.02] active:scale-[0.98]"
                      style={{
                        background: provider === p.id ? 'rgba(18,45,69,0.08)' : 'rgba(255,255,255,0.5)',
                        border: provider === p.id ? '1.5px solid var(--accent)' : '1px solid rgba(18,45,69,0.1)',
                      }}
                    >
                      <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{p.label}</span>
                      {provider === p.id && <Check className="size-3 ml-auto shrink-0" style={{ color: 'var(--success)' }} />}
                    </button>
                  ))}
                </div>
              </section>

              {/* Phone */}
              <section className="rounded-3xl p-5" style={glass.card}>
                <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: 'var(--muted)' }}>
                  {PROVIDERS.find(p => p.id === provider)?.label} Phone Number
                </p>
                <div className="rounded-2xl px-4 py-3 flex items-center gap-2" style={glass.inner}>
                  <Phone className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+255 712 345 678"
                    className="w-full bg-transparent text-sm font-medium outline-none"
                    style={{ color: 'var(--ink)' }}
                    inputMode="tel"
                  />
                </div>
              </section>

              {/* Amount */}
              <section className="rounded-3xl p-5 space-y-3" style={glass.card}>
                <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Amount (USDC)</p>
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
                    style={{ color: amountNum > maxAmount ? 'var(--danger)' : 'var(--ink)' }}
                  />
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-xs" style={{ color: 'var(--subtle)' }}>≈ {tzsAmount} TZS</span>
                    <button
                      onClick={() => setAmount(maxAmount.toFixed(2))}
                      className="text-xs font-semibold"
                      style={{ color: 'var(--accent-hover)' }}
                    >
                      Max
                    </button>
                  </div>
                </div>

                <div className="flex gap-2">
                  {QUICK_AMOUNTS.map((a) => (
                    <button
                      key={a}
                      onClick={() => setAmount(a)}
                      disabled={parseFloat(a) > maxAmount}
                      className="flex-1 rounded-xl py-2 text-xs font-semibold transition-all hover:scale-[1.04] active:scale-[0.97] disabled:opacity-30"
                      style={{
                        background: amount === a ? 'var(--accent)' : 'rgba(18,45,69,0.06)',
                        color: amount === a ? 'white' : 'var(--ink-2)',
                      }}
                    >
                      ${a}
                    </button>
                  ))}
                </div>

                {amountNum > 0 && (
                  <div className="rounded-xl px-3 py-2.5 space-y-1.5" style={{ background: 'rgba(18,45,69,0.04)', border: '1px solid var(--border)' }}>
                    {[
                      { label: 'Amount', value: `${amountNum.toFixed(2)} USDC` },
                      { label: 'Fee (0.5%)', value: `${fee} USDC` },
                      { label: 'You receive', value: `${receive.toFixed(2)} USDC ≈ ${(receive * 2650).toLocaleString('sw-TZ')} TZS` },
                    ].map(({ label, value }) => (
                      <div key={label} className="flex justify-between text-xs">
                        <span style={{ color: 'var(--muted)' }}>{label}</span>
                        <span className="font-semibold" style={{ color: 'var(--ink)' }}>{value}</span>
                      </div>
                    ))}
                  </div>
                )}

                {amountNum > maxAmount && (
                  <p className="text-xs" style={{ color: 'var(--danger)' }}>Exceeds available balance</p>
                )}
              </section>

              <button
                onClick={() => setStep('confirm')}
                disabled={!isValid}
                className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'var(--accent)' }}
              >
                Continue to Confirm
              </button>
            </motion.div>
          )}

          {step === 'confirm' && (
            <motion.div key="confirm" className="space-y-4" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.28 }}>
              <div className="rounded-3xl p-5 space-y-4" style={glass.card}>
                <p className="text-sm font-bold" style={{ color: 'var(--ink)' }}>Confirm Cash Out</p>
                <div className="rounded-2xl p-4 space-y-3" style={{ background: 'rgba(18,45,69,0.04)', border: '1px solid var(--border)' }}>
                  {[
                    { label: 'Provider', value: PROVIDERS.find(p => p.id === provider)?.label ?? provider },
                    { label: 'Phone', value: phone },
                    { label: 'Amount', value: `${amountNum.toFixed(2)} USDC` },
                    { label: 'Fee', value: `${fee} USDC` },
                    { label: 'You receive', value: `${receive.toFixed(2)} USDC` },
                    { label: 'In TZS', value: `≈ ${(receive * 2650).toLocaleString('sw-TZ')} TZS` },
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
                    Funds will be sent to your {PROVIDERS.find(p => p.id === provider)?.label} number. This action cannot be undone.
                  </p>
                </div>

                <button
                  onClick={() => { void handleWithdraw() }}
                  disabled={loading}
                  className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
                  style={{ background: 'var(--accent)' }}
                >
                  {loading
                    ? <span className="flex items-center justify-center gap-2">
                        <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" /></svg>
                        Processing...
                      </span>
                    : 'Confirm Cash Out'
                  }
                </button>
              </div>
            </motion.div>
          )}

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
                  <h2 className="display text-2xl font-bold" style={{ color: 'var(--ink)' }}>On its way!</h2>
                  <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
                    {receive.toFixed(2)} USDC → {PROVIDERS.find(p => p.id === provider)?.label} {phone}
                  </p>
                  <p className="mt-0.5 text-xs" style={{ color: 'var(--subtle)' }}>
                    Funds arrive within 1–5 minutes
                  </p>
                </div>
                {reference && (
                  <p className="mono text-[11px]" style={{ color: 'var(--subtle)' }}>Ref: {reference}</p>
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
