import React from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, Copy, Check, Shield, Bell, HelpCircle, LogOut } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { clearSession } from '../lib/auth'
import type { ZakaUser } from '../types/zaka'

interface Props {
  user: ZakaUser
  onBack: () => void
  onLogout: () => void
}

const glass = {
  card: {
    background: 'rgba(255,255,255,0.72)',
    backdropFilter: 'blur(24px) saturate(180%)',
    WebkitBackdropFilter: 'blur(24px) saturate(180%)',
    border: '1px solid rgba(255,255,255,0.68)',
    boxShadow: '0 8px 32px rgba(18,45,69,0.08), inset 0 1px 0 rgba(255,255,255,0.55)',
  } as React.CSSProperties,
}

const MENU = [
  { icon: Shield, label: 'Security', sub: 'PIN & account protection' },
  { icon: Bell, label: 'Notifications', sub: 'Transaction alerts' },
  { icon: HelpCircle, label: 'Help & Support', sub: 'Contact us or read FAQs' },
]

export default function ProfileScreen({ user, onBack, onLogout }: Props) {
  const [copied, setCopied] = useState(false)
  const initials = user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()

  const copyAddress = async () => {
    await navigator.clipboard.writeText(user.walletAddress)
    setCopied(true)
    toast.success('Address copied')
    setTimeout(() => setCopied(false), 2000)
  }

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
          <h1 className="display text-lg font-bold" style={{ color: 'var(--ink)' }}>Profile</h1>
        </header>

        <motion.div
          className="space-y-4"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          {/* Avatar + name */}
          <section className="rounded-3xl p-6 flex flex-col items-center gap-3" style={glass.card}>
            <div
              className="flex size-20 items-center justify-center rounded-3xl text-2xl font-bold text-white"
              style={{ background: 'var(--accent)', boxShadow: '0 8px 24px rgba(18,45,69,0.20)' }}
            >
              {initials}
            </div>
            <div className="text-center">
              <h2 className="display text-xl font-bold" style={{ color: 'var(--ink)' }}>{user.name}</h2>
              <p className="text-sm mt-0.5" style={{ color: 'var(--muted)' }}>{user.phone}</p>
            </div>
            <button
              onClick={() => { void copyAddress() }}
              className="flex items-center gap-2 rounded-xl px-3 py-2 transition-all hover:bg-black/5"
              style={{ background: 'rgba(18,45,69,0.04)', border: '1px solid var(--border)' }}
            >
              <span className="mono text-[11px]" style={{ color: 'var(--subtle)' }}>
                {user.walletAddress.slice(0, 12)}...{user.walletAddress.slice(-6)}
              </span>
              {copied ? <Check className="size-3 text-green-600" /> : <Copy className="size-3" style={{ color: 'var(--subtle)' }} />}
            </button>
          </section>

          {/* Account info */}
          <section className="rounded-3xl p-5 space-y-3" style={glass.card}>
            <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>Account Info</p>
            {[
              { label: 'ZAKA ID', value: user.id.slice(0, 12) + '...' },
              { label: 'Joined', value: new Date(user.createdAt).toLocaleDateString('en-TZ', { day: 'numeric', month: 'long', year: 'numeric' }) },
              { label: 'Network', value: 'Arc Testnet (USDC)' },
            ].map(({ label, value }) => (
              <div key={label} className="flex justify-between items-center text-sm py-1">
                <span style={{ color: 'var(--muted)' }}>{label}</span>
                <span className="font-semibold" style={{ color: 'var(--ink)' }}>{value}</span>
              </div>
            ))}
          </section>

          {/* Menu */}
          <section className="rounded-3xl overflow-hidden" style={glass.card}>
            {MENU.map(({ icon: Icon, label, sub }, i) => (
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
              </button>
            ))}
          </section>

          {/* Logout */}
          <button
            onClick={() => { clearSession(); onLogout() }}
            className="w-full flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99]"
            style={{ background: 'rgba(186,43,76,0.08)', color: 'var(--danger)', border: '1px solid rgba(186,43,76,0.15)' }}
          >
            <LogOut className="size-4" />
            Sign Out
          </button>
        </motion.div>
      </div>
    </div>
  )
}
