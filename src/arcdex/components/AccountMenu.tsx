import { useEffect, useRef, useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { useDisconnect } from 'wagmi'
import Avatar from './Avatar'
import { DepositModal } from './CashModals'
import { getProfile, type Profile } from '../api/social'
import { lock } from '../lib/embeddedWallet'
import { shortAddr, useTrader } from '../lib/identity'
import { DEFAULT_PREFS, setPrefs, usePrefs } from '../lib/prefs'
import { useCash } from '../lib/usdc'
import type { Page } from '../App'

// Top-right account area, fomo-style: "$X cash · Deposit", then the avatar
// menu (profile, settings, transfers, blur balances, rewards, clans).

export default function AccountMenu({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  const prefs = usePrefs()
  const { cash } = useCash(trader.address)
  const { disconnect } = useDisconnect()
  const [open, setOpen] = useState(false)
  const [deposit, setDeposit] = useState(false)
  const [settings, setSettings] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { if (trader.address) void getProfile(trader.address).then(setProfile).catch(() => {}) }, [trader.address])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  if (!trader.address) return <ConnectKitButton />

  const go = (p: Page) => { setOpen(false); navigate(p) }
  const item = (icon: string, label: string, onClick: () => void, right?: React.ReactNode) => (
    <button className="menu-item" onClick={onClick}><span style={{ width: 18 }}>{icon}</span>{label}{right && <span style={{ marginLeft: 'auto' }}>{right}</span>}</button>
  )

  return (
    <div ref={ref} style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
      <button onClick={() => setDeposit(true)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', background: 'var(--bg-3)', border: '1px solid var(--adx-card-border)', borderRadius: 8, padding: '3px 10px', cursor: 'pointer', color: 'var(--text)', lineHeight: 1.2 }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 700, fontFamily: 'var(--mono)' }}><span className="sensitive">{cash === null ? '…' : `$${cash.toFixed(2)}`}</span> <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>cash</span></span>
        <span style={{ fontSize: '0.64rem', color: 'var(--adx-accent)', fontWeight: 700 }}>Deposit</span>
      </button>
      <button onClick={() => setOpen(o => !o)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }} title={shortAddr(trader.address)}>
        <Avatar address={trader.address} url={profile?.avatar_url} size={30} ring={trader.kind === 'trading-wallet' ? '#facc15' : undefined} />
      </button>

      {open && (
        <div className="menu-pop" style={{ top: 40, right: 0 }}>
          <div style={{ padding: '6px 10px 8px', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            {profile?.username ? `@${profile.username}` : shortAddr(trader.address)} · {trader.kind === 'trading-wallet' ? '⚡ trading wallet' : 'wallet'}
          </div>
          {item('☺', 'Your profile', () => go({ name: 'trader', address: trader.address! }))}
          {item('⚙', 'Settings', () => { setOpen(false); setSettings(true) })}
          {item('⇅', 'Transfers', () => go({ name: 'transfers' }))}
          {item('◌', 'Blur balances', () => setPrefs(p => ({ blur: !p.blur })), <Toggle on={prefs.blur} />)}
          {item('✦', 'Rewards', () => go({ name: 'rewards' }))}
          {item('⚑', 'Clans', () => go({ name: 'clans' }))}
          <div style={{ borderTop: '1px solid var(--adx-card-border)', margin: '6px 0' }} />
          {trader.kind === 'trading-wallet'
            ? item('🔒', 'Lock trading wallet', () => { setOpen(false); lock() })
            : item('⏻', 'Disconnect wallet', () => { setOpen(false); disconnect() })}
        </div>
      )}

      {deposit && <DepositModal trader={trader} navigate={navigate} onClose={() => setDeposit(false)} />}
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
    </div>
  )
}

function Toggle({ on }: { on: boolean }) {
  return <span style={{ display: 'inline-block', width: 28, height: 16, borderRadius: 99, background: on ? 'var(--adx-accent)' : 'var(--bg-4)', position: 'relative' }}><span style={{ position: 'absolute', top: 2, left: on ? 14 : 2, width: 12, height: 12, borderRadius: '50%', background: '#fff', transition: 'left 0.15s' }} /></span>
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const prefs = usePrefs()
  const trader = useTrader()
  const [buy, setBuy] = useState(prefs.buyPresets.map(String))
  const [sell, setSell] = useState(prefs.sellPresets.map(String))
  const [saved, setSaved] = useState(false)

  const save = () => {
    const b = buy.map(Number).filter(n => Number.isFinite(n) && n > 0).slice(0, 4)
    const s = sell.map(Number).filter(n => Number.isFinite(n) && n > 0 && n <= 100).slice(0, 4)
    setPrefs({ buyPresets: b.length === 4 ? b : DEFAULT_PREFS.buyPresets, sellPresets: s.length === 4 ? s : DEFAULT_PREFS.sellPresets })
    setSaved(true); setTimeout(() => setSaved(false), 1500)
  }
  const grid = (vals: string[], set: (v: string[]) => void, prefix: string, suffix: string) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
      {vals.map((v, i) => (
        <div key={i} style={{ position: 'relative' }}>
          {prefix && <span style={{ position: 'absolute', left: 9, top: 9, color: 'var(--text-muted)', fontSize: '0.86rem' }}>{prefix}</span>}
          <input className="field" type="number" min="0" value={v} onChange={e => set(vals.map((x, j) => (j === i ? e.target.value : x)))} style={{ paddingLeft: prefix ? 20 : 11, textAlign: 'center', fontWeight: 700 }} />
          {suffix && <span style={{ position: 'absolute', right: 9, top: 9, color: 'var(--text-muted)', fontSize: '0.86rem' }}>{suffix}</span>}
        </div>
      ))}
    </div>
  )

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>Settings</b><button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button></div>

        <div><b style={{ fontSize: '0.86rem' }}>Quick trade presets</b><div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '2px 0 8px' }}>Your one-tap buy amounts and sell percentages.</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', marginBottom: 6 }}><span>Buy presets (USDC)</span><button className="disc-link" onClick={() => { setBuy(DEFAULT_PREFS.buyPresets.map(String)); setSell(DEFAULT_PREFS.sellPresets.map(String)) }}>↺ Reset</button></div>
          {grid(buy, setBuy, '$', '')}
          <div style={{ fontSize: '0.74rem', margin: '10px 0 6px' }}>Sell presets (% of holding)</div>
          {grid(sell, setSell, '', '%')}
          <button className="btn-primary" style={{ width: '100%', marginTop: 10 }} onClick={save}>{saved ? 'Saved ✓' : 'Save presets'}</button>
        </div>

        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.84rem', cursor: 'pointer' }}>
          <span>Blur balances<div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Hide your cash and PnL on screen (hover to peek)</div></span>
          <input type="checkbox" checked={prefs.blur} onChange={e => setPrefs({ blur: e.target.checked })} />
        </label>
        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.84rem', cursor: 'pointer' }}>
          <span>Alert sound<div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Beep when a trader you follow moves</div></span>
          <input type="checkbox" checked={prefs.alertSound} onChange={e => setPrefs({ alertSound: e.target.checked })} />
        </label>

        <div style={{ fontSize: '0.84rem' }}><b>Account and addresses</b>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.7 }}>
            Trading as: <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{trader.address ?? 'not connected'}</span><br />
            Type: {trader.kind === 'trading-wallet' ? '⚡ One-tap trading wallet (self-custody, encrypted in this browser — back up its key from the right panel)' : trader.kind === 'wallet' ? 'Connected wallet' : '—'}
          </div>
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Language: English</div>
      </div>
    </div>
  )
}
