import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Eye, EyeOff, Phone } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { saveSession } from '../lib/auth'
import type { ZakaUser } from '../types/zaka'

interface Props {
  mode: 'login' | 'register'
  onSwitch: (mode: 'login' | 'register') => void
  onSuccess: (user: ZakaUser, token: string) => void
}

const glass: React.CSSProperties = {
  background: 'rgba(255,255,255,0.78)',
  backdropFilter: 'blur(24px) saturate(180%)',
  WebkitBackdropFilter: 'blur(24px) saturate(180%)',
  border: '1px solid rgba(255,255,255,0.72)',
  boxShadow: '0 8px 32px rgba(18,45,69,0.08), inset 0 1px 0 rgba(255,255,255,0.55)',
}

const glassInner: React.CSSProperties = {
  background: 'rgba(255,255,255,0.5)',
  border: '1px solid rgba(18,45,69,0.1)',
}

export default function AuthScreen({ mode, onSwitch, onSuccess }: Props) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [loading, setLoading] = useState(false)

  const isRegister = mode === 'register'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!phone.trim() || pin.length < 4) {
      toast.error('Enter your phone number and a 4-digit PIN')
      return
    }
    if (isRegister && !name.trim()) {
      toast.error('Enter your full name')
      return
    }

    setLoading(true)
    try {
      const result = isRegister
        ? await api.register({ name: name.trim(), phone: phone.trim(), pin })
        : await api.login({ phone: phone.trim(), pin })

      saveSession(result.user, result.token)
      toast.success(isRegister ? `Welcome to ZAKA, ${result.user.name}!` : `Welcome back, ${result.user.name}!`)
      onSuccess(result.user, result.token)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden" style={{ background: 'var(--bg-gradient)' }}>
      {/* blobs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden>
        <div style={{ position: 'absolute', top: '5%', right: '5%', width: 280, height: 280, borderRadius: '50%', background: 'radial-gradient(circle, rgba(133,177,237,0.22) 0%, transparent 70%)', filter: 'blur(60px)' }} />
        <div style={{ position: 'absolute', bottom: '10%', left: '5%', width: 240, height: 240, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,205,131,0.20) 0%, transparent 70%)', filter: 'blur(55px)' }} />
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-md flex-1 flex-col px-4 pb-10 pt-12">
        {/* Brand header */}
        <motion.div
          className="mb-8"
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex items-center gap-3 mb-6">
            <div
              className="flex size-10 items-center justify-center rounded-xl shadow-md"
              style={{ background: 'var(--accent)' }}
            >
              <span className="display text-lg font-bold text-white">Z</span>
            </div>
            <span className="display text-xl font-bold" style={{ color: 'var(--ink)' }}>ZAKA</span>
          </div>

          <h2 className="display text-3xl font-bold" style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}>
            {isRegister ? 'Create account' : 'Welcome back'}
          </h2>
          <p className="mt-1.5 text-sm" style={{ color: 'var(--muted)' }}>
            {isRegister ? 'Join thousands sending money instantly' : 'Sign in to your ZAKA account'}
          </p>
        </motion.div>

        {/* Form card */}
        <motion.form
          onSubmit={(e) => { void handleSubmit(e) }}
          className="rounded-3xl p-5 space-y-4"
          style={glass}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
        >
          <AnimatePresence mode="wait">
            {isRegister && (
              <motion.div
                key="name"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3 }}
              >
                <label className="block text-xs font-semibold uppercase tracking-widest mb-1.5" style={{ color: 'var(--muted)' }}>
                  Full Name
                </label>
                <div className="rounded-2xl px-4 py-3" style={glassInner}>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Amina Juma"
                    className="w-full bg-transparent text-sm font-medium outline-none placeholder:opacity-40"
                    style={{ color: 'var(--ink)' }}
                    autoComplete="name"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest mb-1.5" style={{ color: 'var(--muted)' }}>
              Phone Number
            </label>
            <div className="rounded-2xl px-4 py-3 flex items-center gap-2" style={glassInner}>
              <Phone className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+255 712 345 678"
                className="w-full bg-transparent text-sm font-medium outline-none placeholder:opacity-40"
                style={{ color: 'var(--ink)' }}
                autoComplete="tel"
                inputMode="tel"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest mb-1.5" style={{ color: 'var(--muted)' }}>
              {isRegister ? 'Create PIN' : 'PIN'}
            </label>
            <div className="rounded-2xl px-4 py-3 flex items-center gap-2" style={glassInner}>
              <input
                type={showPin ? 'text' : 'password'}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••"
                className="w-full bg-transparent text-sm font-medium outline-none tracking-widest placeholder:opacity-40"
                style={{ color: 'var(--ink)' }}
                inputMode="numeric"
                maxLength={6}
              />
              <button type="button" onClick={() => setShowPin(!showPin)} className="shrink-0 p-0.5">
                {showPin
                  ? <EyeOff className="size-4" style={{ color: 'var(--subtle)' }} />
                  : <Eye className="size-4" style={{ color: 'var(--subtle)' }} />
                }
              </button>
            </div>
            {isRegister && (
              <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>4–6 digits, keep it safe</p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 mt-2"
            style={{ background: 'var(--accent)' }}
          >
            {loading
              ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z" />
                  </svg>
                  {isRegister ? 'Creating account...' : 'Signing in...'}
                </span>
              )
              : isRegister ? 'Create Account' : 'Sign In'
            }
          </button>
        </motion.form>

        {/* Switch mode */}
        <motion.p
          className="mt-5 text-center text-sm"
          style={{ color: 'var(--muted)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          {isRegister ? 'Already have an account?' : "Don't have an account?"}
          {' '}
          <button
            type="button"
            onClick={() => onSwitch(isRegister ? 'login' : 'register')}
            className="font-semibold underline underline-offset-2"
            style={{ color: 'var(--accent-hover)' }}
          >
            {isRegister ? 'Sign In' : 'Create one'}
          </button>
        </motion.p>
      </div>
    </div>
  )
}
