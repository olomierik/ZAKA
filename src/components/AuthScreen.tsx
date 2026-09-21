import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Eye, EyeOff, Phone, Mail, ArrowLeft, User } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { saveSession } from '../lib/auth'
import { normalisePhone, isValidPhone } from '../lib/phone'
import type { ZakaUser } from '../types/zaka'

interface Props {
  mode: 'login' | 'register'
  onSwitch: (mode: 'login' | 'register') => void
  onSuccess: (user: ZakaUser, token: string) => void
}

type AuthView = 'form' | 'forgot' | 'forgot-sent'

export default function AuthScreen({ mode, onSwitch, onSuccess }: Props) {
  const [name, setName]       = useState('')
  const [phone, setPhone]     = useState('')
  const [pin, setPin]         = useState('')
  const [email, setEmail]     = useState('')
  const [showPin, setShowPin] = useState(false)
  const [loading, setLoading] = useState(false)
  const [view, setView]       = useState<AuthView>('form')

  const isRegister = mode === 'register'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const normPhone = normalisePhone(phone)
    if (!phone.trim() || pin.length < 4) {
      toast.error('Enter your phone number and a 4-digit PIN'); return
    }
    if (!isValidPhone(phone)) {
      toast.error('Enter a valid Tanzanian phone number'); return
    }
    if (isRegister && !name.trim()) {
      toast.error('Enter your full name'); return
    }
    setLoading(true)
    try {
      const result = isRegister
        ? await api.register({ name: name.trim(), phone: normPhone, pin })
        : await api.login({ phone: normPhone, pin })
      saveSession(result.user, result.token)
      toast.success(isRegister ? `Welcome to ZAKA, ${result.user.name}!` : `Welcome back, ${result.user.name}!`)
      onSuccess(result.user, result.token)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !email.includes('@')) { toast.error('Enter a valid email address'); return }
    setLoading(true)
    try {
      await api.requestPinReset(email.trim())
      setView('forgot-sent')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send reset email')
    } finally { setLoading(false) }
  }

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden" style={{ background: 'var(--bg-gradient)' }}>

      {/* Ambient blobs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden>
        <div style={{ position:'absolute', top:'4%', right:'4%', width:280, height:280, borderRadius:'50%',
          background:'radial-gradient(circle, rgba(133,177,237,0.22) 0%, transparent 70%)', filter:'blur(70px)' }} />
        <div style={{ position:'absolute', bottom:'8%', left:'4%', width:240, height:240, borderRadius:'50%',
          background:'radial-gradient(circle, rgba(175,143,244,0.18) 0%, transparent 70%)', filter:'blur(60px)' }} />
        <div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', width:320, height:320, borderRadius:'50%',
          background:'radial-gradient(circle, rgba(255,205,131,0.12) 0%, transparent 65%)', filter:'blur(80px)' }} />
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-md flex-1 flex-col px-4 pb-10 pt-12">
        <AnimatePresence mode="wait">

          {/* ── Forgot PIN ── */}
          {view === 'forgot' && (
            <motion.div key="forgot"
              initial={{ opacity:0, x:24 }} animate={{ opacity:1, x:0 }} exit={{ opacity:0, x:-24 }}
              transition={{ duration:0.3, ease:[0.22,1,0.36,1] }}>
              <button onClick={() => setView('form')}
                className="mb-6 flex items-center gap-2 text-sm font-semibold"
                style={{ color:'var(--accent-hover)' }}>
                <ArrowLeft className="size-4" /> Back to sign in
              </button>
              <div className="mb-8">
                <h2 className="display text-3xl font-bold" style={{ color:'var(--ink)', letterSpacing:'-0.03em' }}>Reset PIN</h2>
                <p className="mt-1.5 text-sm" style={{ color:'var(--muted)' }}>We'll email you a reset link</p>
              </div>
              <form onSubmit={(e) => { void handleForgot(e) }} className="zaka-card space-y-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-widest mb-1.5" style={{ color:'var(--muted)' }}>
                    Email Address
                  </label>
                  <div className="zaka-input-wrap">
                    <Mail className="size-4 shrink-0" style={{ color:'var(--subtle)' }} />
                    <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                      placeholder="you@example.com" autoComplete="email" inputMode="email" />
                  </div>
                </div>
                <button type="submit" disabled={loading}
                  className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:brightness-110 active:scale-[0.99]"
                  style={{ background:'var(--accent)' }}>
                  {loading ? 'Sending...' : 'Send Reset Link'}
                </button>
              </form>
            </motion.div>
          )}

          {/* ── Forgot sent ── */}
          {view === 'forgot-sent' && (
            <motion.div key="sent"
              initial={{ opacity:0, scale:0.95 }} animate={{ opacity:1, scale:1 }} transition={{ duration:0.4 }}
              className="flex flex-col items-center justify-center flex-1 text-center gap-4">
              <div className="flex size-20 items-center justify-center rounded-3xl text-3xl"
                style={{ background:'rgba(74,222,128,0.12)' }}>📧</div>
              <h2 className="display text-2xl font-bold" style={{ color:'var(--ink)' }}>Check your email</h2>
              <p className="text-sm max-w-xs" style={{ color:'var(--muted)' }}>
                We sent a reset link to <strong style={{ color:'var(--ink)' }}>{email}</strong>. Click the link to set a new PIN.
              </p>
              <button onClick={() => { setView('form'); setEmail('') }}
                className="mt-4 text-sm font-semibold underline underline-offset-2"
                style={{ color:'var(--accent-hover)' }}>
                Back to Sign In
              </button>
            </motion.div>
          )}

          {/* ── Main form ── */}
          {view === 'form' && (
            <motion.div key={mode} initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }} transition={{ duration:0.25 }}>

              <motion.div className="mb-8"
                initial={{ opacity:0, y:-16 }} animate={{ opacity:1, y:0 }}
                transition={{ duration:0.5, ease:[0.22,1,0.36,1] }}>
                <div className="flex items-center gap-3 mb-6">
                  <div className="flex size-10 items-center justify-center rounded-xl shadow-md"
                    style={{ background:'var(--accent)' }}>
                    <span className="display text-lg font-bold text-white">Z</span>
                  </div>
                  <span className="display text-xl font-bold" style={{ color:'var(--ink)' }}>ZAKA</span>
                </div>
                <h2 className="display text-3xl font-bold" style={{ color:'var(--ink)', letterSpacing:'-0.03em' }}>
                  {isRegister ? 'Create account' : 'Welcome back'}
                </h2>
                <p className="mt-1.5 text-sm" style={{ color:'var(--muted)' }}>
                  {isRegister ? 'Join thousands sending money instantly' : 'Sign in to your ZAKA account'}
                </p>
              </motion.div>

              <motion.form onSubmit={e => { void handleSubmit(e) }}
                className="zaka-card space-y-4"
                initial={{ opacity:0, y:20 }} animate={{ opacity:1, y:0 }}
                transition={{ duration:0.5, delay:0.1, ease:[0.22,1,0.36,1] }}>

                <AnimatePresence mode="wait">
                  {isRegister && (
                    <motion.div key="name"
                      initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:'auto' }}
                      exit={{ opacity:0, height:0 }} transition={{ duration:0.3 }}>
                      <label className="block text-xs font-semibold uppercase tracking-widest mb-1.5"
                        style={{ color:'var(--muted)' }}>Full Name</label>
                      <div className="zaka-input-wrap">
                        <User className="size-4 shrink-0" style={{ color:'var(--subtle)' }} />
                        <input type="text" value={name} onChange={e => setName(e.target.value)}
                          placeholder="Amina Juma" autoComplete="name" />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-widest mb-1.5"
                    style={{ color:'var(--muted)' }}>Phone Number</label>
                  <div className="zaka-input-wrap">
                    <Phone className="size-4 shrink-0" style={{ color:'var(--subtle)' }} />
                    <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                      placeholder="0750 401 012 or +255 750 401 012"
                      autoComplete="tel" inputMode="tel" />
                  </div>
                  <p className="mt-1 text-xs" style={{ color:'var(--subtle)' }}>
                    Accepted: 0750401012 · 255750401012 · +255750401012
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-widest mb-1.5"
                    style={{ color:'var(--muted)' }}>
                    {isRegister ? 'Create PIN' : 'PIN'}
                  </label>
                  <div className="zaka-input-wrap">
                    <input type={showPin ? 'text' : 'password'}
                      value={pin}
                      onChange={e => setPin(e.target.value.replace(/\D/g,'').slice(0,6))}
                      placeholder="••••"
                      className="tracking-widest"
                      inputMode="numeric" maxLength={6} />
                    <button type="button" onClick={() => setShowPin(!showPin)} className="shrink-0 p-0.5">
                      {showPin
                        ? <EyeOff className="size-4" style={{ color:'var(--subtle)' }} />
                        : <Eye    className="size-4" style={{ color:'var(--subtle)' }} />}
                    </button>
                  </div>
                  {isRegister && (
                    <p className="mt-1 text-xs" style={{ color:'var(--subtle)' }}>4–6 digits, keep it safe</p>
                  )}
                </div>

                <button type="submit" disabled={loading}
                  className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white transition-all hover:brightness-110 hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 mt-2"
                  style={{ background:'var(--accent)' }}>
                  {loading
                    ? <span className="flex items-center justify-center gap-2">
                        <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"/>
                        </svg>
                        {isRegister ? 'Creating account...' : 'Signing in...'}
                      </span>
                    : isRegister ? 'Create Account' : 'Sign In'
                  }
                </button>

                {!isRegister && (
                  <button type="button" onClick={() => setView('forgot')}
                    className="w-full text-center text-xs font-semibold pt-1 hover:underline"
                    style={{ color:'var(--accent-hover)' }}>
                    Forgot PIN? Reset via email
                  </button>
                )}
              </motion.form>

              <motion.p className="mt-5 text-center text-sm" style={{ color:'var(--muted)' }}
                initial={{ opacity:0 }} animate={{ opacity:1 }} transition={{ delay:0.3 }}>
                {isRegister ? 'Already have an account?' : "Don't have an account?"}
                {' '}
                <button type="button" onClick={() => onSwitch(isRegister ? 'login' : 'register')}
                  className="font-semibold underline underline-offset-2 hover:brightness-110"
                  style={{ color:'var(--accent-hover)' }}>
                  {isRegister ? 'Sign In' : 'Create one'}
                </button>
              </motion.p>
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </div>
  )
}
