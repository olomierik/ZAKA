import React, { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, Copy, Check, Download } from 'lucide-react'
import { toast } from 'sonner'
import QRCode from 'qrcode'
import type { ZakaUser } from '../types/zaka'

interface Props {
  user: ZakaUser
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

export default function ReceiveScreen({ user, token: _token, onBack }: Props) {
  // walletAddress is already on the user object from login — no network call needed
  const depositAddress = user.walletAddress ?? ''
  const network = 'Arc Testnet'
  const loading = false
  const [copied, setCopied] = useState<'phone' | 'address' | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Generate QR as soon as address is known
  useEffect(() => {
    if (!depositAddress) return
    // Encode as plain address — most wallets scan this reliably
    QRCode.toDataURL(depositAddress, {
      width: 300,
      margin: 2,
      color: { dark: '#122d45', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    }).then(setQrDataUrl).catch(console.error)
  }, [depositAddress])

  const copy = async (text: string, key: 'phone' | 'address') => {
    await navigator.clipboard.writeText(text)
    setCopied(key)
    toast.success('Copied to clipboard')
    setTimeout(() => setCopied(null), 2000)
  }

  const downloadQR = () => {
    if (!qrDataUrl) return
    const a = document.createElement('a')
    a.href = qrDataUrl
    a.download = `zaka-${user.name.replace(/\s+/g, '-').toLowerCase()}-wallet-qr.png`
    a.click()
    toast.success('QR code downloaded')
  }

  return (
    <div className="relative min-h-dvh overflow-x-hidden" style={{ background: 'var(--bg-gradient)' }}>
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div style={{ position: 'absolute', top: '5%', left: '10%', width: 260, height: 260, borderRadius: '50%', background: 'radial-gradient(circle, rgba(26,128,71,0.14) 0%, transparent 70%)', filter: 'blur(55px)' }} />
      </div>

      <div className="relative z-10 mx-auto max-w-md px-4 pb-10 pt-6">
        <header className="mb-6 flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex size-10 items-center justify-center rounded-xl transition-all hover:bg-black/5"
            style={{ border: '1px solid var(--border)' }}
          >
            <ArrowLeft className="size-4" style={{ color: 'var(--ink)' }} />
          </button>
          <h1 className="display text-lg font-bold" style={{ color: 'var(--ink)' }}>Receive Money</h1>
        </header>

        <motion.div
          className="space-y-4"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* Phone / ID card */}
          <section className="rounded-3xl p-5" style={glass.card}>
            <p className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: 'var(--muted)' }}>
              Share your ZAKA ID
            </p>
            <div className="flex items-center gap-4 mb-4">
              <div className="flex size-14 items-center justify-center rounded-2xl text-xl font-bold text-white shrink-0" style={{ background: 'var(--accent)' }}>
                {user.name[0]}
              </div>
              <div className="min-w-0">
                <p className="font-bold text-base truncate" style={{ color: 'var(--ink)' }}>{user.name}</p>
                <p className="text-sm" style={{ color: 'var(--muted)' }}>{user.phone}</p>
              </div>
            </div>
            <button
              onClick={() => void copy(user.phone, 'phone')}
              className="w-full flex items-center justify-between rounded-2xl px-4 py-3 transition-all hover:bg-black/5 active:scale-[0.98]"
              style={glass.inner}
            >
              <span className="text-sm font-medium" style={{ color: 'var(--ink)' }}>{user.phone}</span>
              {copied === 'phone'
                ? <Check className="size-4 text-green-600 shrink-0" />
                : <Copy className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />}
            </button>
            <p className="mt-3 text-xs text-center" style={{ color: 'var(--subtle)' }}>
              Anyone on ZAKA can send money to your phone number
            </p>
          </section>

          {/* QR code card */}
          <section className="rounded-3xl p-5" style={glass.card}>
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'var(--muted)' }}>
                Wallet QR Code
              </p>
              {qrDataUrl && (
                <button
                  onClick={downloadQR}
                  className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all hover:scale-[1.03] active:scale-[0.97]"
                  style={{ background: 'rgba(18,45,69,0.07)', color: 'var(--ink-2)' }}
                >
                  <Download className="size-3.5" />
                  Download
                </button>
              )}
            </div>

            {loading || !qrDataUrl ? (
              <div className="mx-auto h-56 w-56 rounded-2xl animate-pulse" style={{ background: 'rgba(18,45,69,0.07)' }} />
            ) : (
              <div className="flex flex-col items-center gap-3">
                <div className="rounded-2xl overflow-hidden p-3" style={{ background: 'white', boxShadow: '0 4px 20px rgba(18,45,69,0.10)' }}>
                  <img src={qrDataUrl} alt="Wallet QR code" width={224} height={224} className="block" />
                </div>
                <p className="text-xs text-center" style={{ color: 'var(--subtle)' }}>
                  Scan to send USDC to {user.name.split(' ')[0]}'s wallet
                </p>
              </div>
            )}

            {/* Address row */}
            {!loading && depositAddress && (
              <button
                onClick={() => void copy(depositAddress, 'address')}
                className="mt-4 w-full flex items-center justify-between rounded-2xl px-4 py-3 transition-all hover:bg-black/5 active:scale-[0.98]"
                style={glass.inner}
              >
                <span className="mono text-xs truncate pr-2 flex-1 text-left" style={{ color: 'var(--ink)' }}>
                  {depositAddress}
                </span>
                {copied === 'address'
                  ? <Check className="size-4 text-green-600 shrink-0" />
                  : <Copy className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />}
              </button>
            )}
            <p className="mt-2 text-xs" style={{ color: 'var(--subtle)' }}>
              Network: <span className="font-semibold" style={{ color: 'var(--ink-2)' }}>{network || 'Arc Testnet'}</span> — USDC only
            </p>
          </section>

          {/* Tips */}
          <section className="rounded-3xl p-4" style={glass.card}>
            <p className="text-xs font-bold mb-2" style={{ color: 'var(--ink)' }}>Tips</p>
            <ul className="space-y-1.5">
              {[
                'Only send USDC on Arc Testnet to this address',
                'Minimum deposit: 1 USDC',
                'Deposits reflect within 1–3 minutes',
              ].map((tip) => (
                <li key={tip} className="flex items-start gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                  <span className="shrink-0 rounded-full" style={{ background: 'var(--accent)', width: 6, height: 6, marginTop: 5 }} />
                  {tip}
                </li>
              ))}
            </ul>
          </section>
        </motion.div>
        {/* hidden canvas used by qrcode lib */}
        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  )
}
