import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, Copy, Check, Shield, Bell, HelpCircle, LogOut, Moon, Sun, Globe, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { clearSession } from '../lib/auth'
import { useTheme } from '../lib/theme'
import { useI18n, LANG_LABELS, type Lang } from '../lib/i18n'
import type { ZakaUser } from '../types/zaka'

interface Props {
  user: ZakaUser
  onBack: () => void
  onLogout: () => void
}

const LANGS: Lang[] = ['en', 'zh', 'fr', 'de', 'ar']

export default function ProfileScreen({ user, onBack, onLogout }: Props) {
  const [copied, setCopied] = useState(false)
  const [showLangs, setShowLangs] = useState(false)
  const { theme, toggleTheme, isDark } = useTheme()
  const { lang, setLang, t } = useI18n()
  const initials = user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()

  const card: React.CSSProperties = {
    background: 'var(--surface)',
    backdropFilter: 'blur(28px) saturate(200%)',
    WebkitBackdropFilter: 'blur(28px) saturate(200%)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--card-shadow)',
  }

  const copyAddress = async () => {
    await navigator.clipboard.writeText(user.walletAddress)
    setCopied(true)
    toast.success(t.copied)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative min-h-dvh overflow-x-hidden" style={{ background: 'var(--bg-gradient)' }}>
      {/* ambient */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden>
        <div style={{ position:'absolute', top:'5%', right:'10%', width:280, height:280, borderRadius:'50%', background:'radial-gradient(circle, rgba(95,190,255,0.12) 0%, transparent 70%)', filter:'blur(60px)' }} />
        <div style={{ position:'absolute', bottom:'8%', left:'8%', width:220, height:220, borderRadius:'50%', background:'radial-gradient(circle, rgba(175,143,244,0.12) 0%, transparent 70%)', filter:'blur(55px)' }} />
      </div>

      <div className="relative z-10 mx-auto max-w-md px-4 pb-10 pt-6">
        <header className="mb-6 flex items-center gap-3">
          <button onClick={onBack} className="flex size-10 items-center justify-center rounded-xl transition-all hover:bg-black/5" style={{ border: '1px solid var(--border)', color: 'var(--ink)' }}>
            <ArrowLeft className="size-4" />
          </button>
          <h1 className="display text-lg font-bold" style={{ color: 'var(--ink)' }}>{t.profile}</h1>
        </header>

        <motion.div className="space-y-4" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.22,1,0.36,1] }}>

          {/* Avatar card */}
          <section className="rounded-3xl p-6 flex flex-col items-center gap-3 relative overflow-hidden" style={card}>
            <div className="absolute top-0 left-0 right-0 h-1 spectral" />
            <motion.div
              className="flex size-20 items-center justify-center rounded-3xl text-2xl font-bold text-white relative"
              style={{ background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%)', boxShadow: '0 8px 24px rgba(18,45,69,0.20)' }}
              whileHover={{ scale: 1.04 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            >
              <div className="absolute inset-0 rounded-3xl" style={{ background: 'linear-gradient(145deg, rgba(255,255,255,0.18) 0%, transparent 55%)' }} />
              <span className="relative z-10">{initials}</span>
            </motion.div>
            <div className="text-center">
              <h2 className="display text-xl font-bold" style={{ color: 'var(--ink)' }}>{user.name}</h2>
              <p className="text-sm mt-0.5" style={{ color: 'var(--muted)' }}>{user.phone}</p>
            </div>
            <button onClick={() => { void copyAddress() }} className="flex items-center gap-2 rounded-xl px-3 py-2 transition-all hover:bg-black/5 active:scale-[0.98]" style={{ background: 'rgba(18,45,69,0.04)', border: '1px solid var(--border)' }}>
              <span className="mono text-[11px]" style={{ color: 'var(--subtle)' }}>
                {user.walletAddress.slice(0, 12)}...{user.walletAddress.slice(-6)}
              </span>
              {copied ? <Check className="size-3 text-green-600 shrink-0" /> : <Copy className="size-3 shrink-0" style={{ color: 'var(--subtle)' }} />}
            </button>
          </section>

          {/* Preferences */}
          <section className="rounded-3xl overflow-hidden" style={card}>
            <p className="text-xs font-semibold uppercase tracking-widest px-5 pt-4 pb-2" style={{ color: 'var(--muted)' }}>Preferences</p>

            {/* Dark mode toggle */}
            <button
              onClick={toggleTheme}
              className="w-full flex items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-black/5 active:bg-black/8"
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <div className="flex size-9 items-center justify-center rounded-xl shrink-0" style={{ background: isDark ? 'rgba(91,163,232,0.15)' : 'rgba(18,45,69,0.06)' }}>
                {isDark
                  ? <Sun className="size-4" style={{ color: 'var(--accent)' }} />
                  : <Moon className="size-4" style={{ color: 'var(--ink-2)' }} />}
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{isDark ? t.lightMode : t.darkMode}</p>
                <p className="text-xs" style={{ color: 'var(--subtle)' }}>{theme === 'dark' ? 'Currently: Dark' : 'Currently: Light'}</p>
              </div>
              {/* Toggle pill */}
              <div
                className="relative flex-shrink-0 rounded-full transition-colors duration-300"
                style={{
                  width: 44, height: 26,
                  background: isDark ? 'var(--accent)' : 'rgba(18,45,69,0.15)',
                }}
              >
                <motion.div
                  className="absolute top-1 rounded-full bg-white"
                  style={{ width: 18, height: 18 }}
                  animate={{ left: isDark ? 22 : 4 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 36 }}
                />
              </div>
            </button>

            {/* Language picker */}
            <button
              onClick={() => setShowLangs(v => !v)}
              className="w-full flex items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-black/5"
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <div className="flex size-9 items-center justify-center rounded-xl shrink-0" style={{ background: 'rgba(18,45,69,0.06)' }}>
                <Globe className="size-4" style={{ color: 'var(--ink-2)' }} />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{t.language}</p>
                <p className="text-xs" style={{ color: 'var(--subtle)' }}>{LANG_LABELS[lang]}</p>
              </div>
              <motion.div animate={{ rotate: showLangs ? 90 : 0 }} transition={{ duration: 0.2 }}>
                <ChevronRight className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />
              </motion.div>
            </button>

            <AnimatePresence>
              {showLangs && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                  style={{ overflow: 'hidden', borderTop: '1px solid var(--border)' }}
                >
                  <div className="px-5 py-2 flex flex-wrap gap-2">
                    {LANGS.map((l) => (
                      <button
                        key={l}
                        onClick={() => { setLang(l); setShowLangs(false) }}
                        className="rounded-xl px-4 py-2 text-sm font-semibold transition-all hover:scale-[1.04] active:scale-[0.97]"
                        style={{
                          background: lang === l ? 'var(--accent)' : 'rgba(18,45,69,0.06)',
                          color: lang === l ? 'white' : 'var(--ink-2)',
                          border: lang === l ? 'none' : '1px solid var(--border)',
                        }}
                      >
                        {LANG_LABELS[l]}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          {/* Account info */}
          <section className="rounded-3xl p-5 space-y-3" style={card}>
            <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Account Info</p>
            {[
              { label: 'ZAKA ID', value: user.id.slice(0, 14) + '...' },
              { label: 'Joined', value: new Date(user.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) },
              { label: 'Network', value: 'Arc Testnet' },
            ].map(({ label, value }) => (
              <div key={label} className="flex justify-between items-center text-sm py-1">
                <span style={{ color: 'var(--muted)' }}>{label}</span>
                <span className="font-semibold" style={{ color: 'var(--ink)' }}>{value}</span>
              </div>
            ))}
          </section>

          {/* Menu */}
          <section className="rounded-3xl overflow-hidden" style={card}>
            {([
              { Icon: Shield, label: 'Security', sub: 'PIN & account protection', href: null },
              { Icon: Bell, label: 'Notifications', sub: 'Transaction alerts', href: null },
              { Icon: HelpCircle, label: 'Help & Support', sub: 'support@zakaapp.com', href: 'mailto:support@zakaapp.com' },
            ] as { Icon: React.ElementType; label: string; sub: string; href: string | null }[]).map(({ Icon, label, sub, href }, i) => (
              href ? (
                <a
                  key={label}
                  href={href}
                  className="w-full flex items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-black/5"
                  style={{ borderTop: i > 0 ? '1px solid var(--border)' : 'none', textDecoration: 'none' }}
                >
                  <div className="flex size-9 items-center justify-center rounded-xl shrink-0" style={{ background: 'rgba(18,45,69,0.06)' }}>
                    <Icon className="size-4" style={{ color: 'var(--ink-2)' }} />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{label}</p>
                    <p className="text-xs" style={{ color: 'var(--accent)' }}>{sub}</p>
                  </div>
                  <ChevronRight className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />
                </a>
              ) : (
                <button
                  key={label}
                  className="w-full flex items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-black/5"
                  style={{ borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}
                >
                  <div className="flex size-9 items-center justify-center rounded-xl shrink-0" style={{ background: 'rgba(18,45,69,0.06)' }}>
                    <Icon className="size-4" style={{ color: 'var(--ink-2)' }} />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{label}</p>
                    <p className="text-xs" style={{ color: 'var(--subtle)' }}>{sub}</p>
                  </div>
                  <ChevronRight className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />
                </button>
              )
            ))}
          </section>

          {/* Sign out */}
          <motion.button
            onClick={() => { clearSession(); onLogout() }}
            className="w-full flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-semibold transition-all"
            style={{ background: 'rgba(186,43,76,0.08)', color: 'var(--danger)', border: '1px solid rgba(186,43,76,0.15)' }}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
          >
            <LogOut className="size-4" />
            {t.signOut}
          </motion.button>

        </motion.div>
      </div>
    </div>
  )
}
