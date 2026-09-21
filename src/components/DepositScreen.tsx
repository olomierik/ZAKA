import React, { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, Copy, Check, ArrowDownToLine, Hexagon } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import type { ZakaUser } from '../types/zaka'

interface Props {
  user: ZakaUser
  token: string
  onBack: () => void
}

const glass: React.CSSProperties = {
  background: 'rgba(255,255,255,0.72)',
  backdropFilter: 'blur(24px) saturate(180%)',
  WebkitBackdropFilter: 'blur(24px) saturate(180%)',
  border: '1px solid rgba(255,255,255,0.68)',
  boxShadow: '0 8px 32px rgba(18,45,69,0.08), inset 0 1px 0 rgba(255,255,255,0.55)',
}

const glassInner: React.CSSProperties = {
  background: 'var(--input-bg)',
  border: '1px solid var(--input-border)',
}

const spectral = 'linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b, #ffcd83, #7ef1b3)'

const DEPOSIT_METHODS = [
  { id: 'crypto', label: 'USDC / Crypto', desc: 'From another wallet or exchange', Icon: Hexagon, disabled: false },
  { id: 'mpesa', label: 'M-Pesa', desc: 'Deposit via M-Pesa (coming soon)', Icon: ArrowDownToLine, disabled: true },
  { id: 'tigo', label: 'Tigo Pesa', desc: 'Deposit via Tigo Pesa (coming soon)', Icon: ArrowDownToLine, disabled: true },
]

export default function DepositScreen({ user: _user, token, onBack }: Props) {
  const [depositAddress, setDepositAddress] = useState('')
  const [network, setNetwork] = useState('')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [selectedMethod, setSelectedMethod] = useState('crypto')

  useEffect(() => {
    const load = async () => {
      try {
        const res = await api.getDepositAddress(token)
        setDepositAddress(res.address)
        setNetwork(res.network)
      } catch {
        toast.error('Could not load deposit address')
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [token])

  const copy = async () => {
    await navigator.clipboard.writeText(depositAddress)
    setCopied(true)
    toast.success('Address copied')
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden>
        <div style={{ position: 'absolute', top: '8%', right: '10%', width: 260, height: 260, borderRadius: '50%', background: 'radial-gradient(circle, rgba(16,97,166,0.14) 0%, transparent 70%)', filter: 'blur(55px)' }} />
      </div>

      <div className="relative z-10 mx-auto max-w-md px-4 pb-12 pt-6">
        <header className="mb-6 flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex size-10 items-center justify-center rounded-xl transition-all hover:bg-black/5"
            style={{ border: '1px solid var(--border)' }}
            aria-label="Back"
          >
            <ArrowLeft className="size-4" style={{ color: 'var(--ink)' }} />
          </button>
          <div>
            <h1 className="display text-lg font-bold" style={{ color: 'var(--ink)' }}>Add Money</h1>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>Deposit USDC to your wallet</p>
          </div>
        </header>

        <motion.div
          className="space-y-4"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Method selector */}
          <section className="rounded-3xl p-5 relative overflow-hidden" style={glass}>
            <div className="absolute top-0 left-0 right-0 h-1" style={{ background: spectral }} />
            <p className="text-xs font-semibold uppercase tracking-widest mb-3 mt-1" style={{ color: 'var(--muted)' }}>
              Choose deposit method
            </p>
            <div className="space-y-2">
              {DEPOSIT_METHODS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => !m.disabled && setSelectedMethod(m.id)}
                  disabled={m.disabled}
                  className="w-full flex items-center gap-3 rounded-2xl px-4 py-3 text-left transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    ...glassInner,
                    background: selectedMethod === m.id ? 'var(--surface-muted)' : 'var(--input-bg)',
                    border: selectedMethod === m.id ? '1.5px solid var(--accent)' : '1px solid var(--input-border)',
                  }}
                >
                  <div
                    className="flex size-9 items-center justify-center rounded-xl shrink-0"
                    style={{ background: selectedMethod === m.id ? 'var(--accent)' : 'rgba(18,45,69,0.08)', color: selectedMethod === m.id ? 'white' : 'var(--ink-2)' }}
                  >
                    <m.Icon className="size-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{m.label}</p>
                    <p className="text-xs" style={{ color: 'var(--subtle)' }}>{m.desc}</p>
                  </div>
                  {selectedMethod === m.id && <Check className="size-4 shrink-0" style={{ color: 'var(--success)' }} />}
                </button>
              ))}
            </div>
          </section>

          {/* Crypto deposit instructions */}
          {selectedMethod === 'crypto' && (
            <motion.section
              className="rounded-3xl p-5 space-y-4"
              style={glass}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
            >
              <div className="flex items-center gap-2">
                <ArrowDownToLine className="size-4" style={{ color: 'var(--accent-hover)' }} />
                <p className="text-sm font-bold" style={{ color: 'var(--ink)' }}>Your USDC Deposit Address</p>
              </div>

              {loading ? (
                <div className="h-12 rounded-2xl animate-pulse" style={{ background: 'rgba(18,45,69,0.07)' }} />
              ) : (
                <>
                  <button
                    onClick={() => { void copy() }}
                    className="w-full flex items-center justify-between rounded-2xl px-4 py-3 transition-all hover:bg-black/5 active:scale-[0.98]"
                    style={glassInner}
                  >
                    <span className="mono text-xs truncate pr-2 flex-1 text-left" style={{ color: 'var(--ink)' }}>
                      {depositAddress}
                    </span>
                    {copied
                      ? <Check className="size-4 shrink-0 text-green-600" />
                      : <Copy className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />
                    }
                  </button>

                  <div className="rounded-2xl p-3" style={{ background: 'rgba(16,97,166,0.07)', border: '1px solid rgba(16,97,166,0.15)' }}>
                    <p className="text-xs" style={{ color: 'var(--accent-hover)' }}>
                      Network: <strong>{network || 'Arc Testnet'}</strong> — only send USDC on this network.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>Steps to deposit:</p>
                    {[
                      'Copy the address above',
                      'Open your exchange or wallet app',
                      'Send USDC to this address on Arc Testnet',
                      'Balance updates within 1–3 minutes',
                    ].map((step, i) => (
                      <div key={step} className="flex items-start gap-2.5 text-xs" style={{ color: 'var(--ink-2)' }}>
                        <span className="flex size-4 items-center justify-center rounded-full shrink-0 text-[10px] font-bold text-white mt-0.5" style={{ background: 'var(--accent)' }}>
                          {i + 1}
                        </span>
                        {step}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </motion.section>
          )}
        </motion.div>
      </div>
    </div>
  )
}
