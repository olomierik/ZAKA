import { useEffect, useRef, useState } from 'react'
import { ConnectButton } from './ConnectWallet'
import { useDisconnect } from 'wagmi'
import Avatar from './Avatar'
import { DepositModal, WithdrawModal } from './CashModals'
import SupportModal from './SupportModal'
import { enableAlertNotifications } from './DiscoveryPanel'
import { getProfile, signOutEverywhere, type Profile } from '../api/social'
import { hasPasskey, lock } from '../lib/embeddedWallet'
import { shortAddr, useTrader } from '../lib/identity'
import { DEFAULT_PREFS, setPrefs, usePrefs } from '../lib/prefs'
import { LANGS, setLang, t, useLang, type Lang } from '../lib/i18n'
import { useCash } from '../lib/usdc'
import type { Page } from '../App'

// Top-right account area, fomo-style: "$X cash · Deposit", then the avatar
// menu (profile, manage account, settings, transfers, blur balances,
// rewards, clans, contact support, lock / disconnect).

type SettingsTab = 'trading' | 'account' | 'notifications' | 'language'

export default function AccountMenu({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  const prefs = usePrefs()
  const lang = useLang()
  const { cash } = useCash(trader.address)
  const { disconnect } = useDisconnect()
  const [open, setOpen] = useState(false)
  const [deposit, setDeposit] = useState(false)
  const [withdraw, setWithdraw] = useState(false)
  const [settings, setSettings] = useState<SettingsTab | null>(null)
  const [support, setSupport] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { if (trader.address) void getProfile(trader.address).then(setProfile).catch(() => {}) }, [trader.address])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  if (!trader.address) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <LangQuick />
      <ConnectButton />
    </div>
  )

  const go = (p: Page) => { setOpen(false); navigate(p) }
  const item = (icon: string, label: string, onClick: () => void, right?: React.ReactNode) => (
    <button className="menu-item" onClick={onClick}><span style={{ width: 18 }}>{icon}</span>{label}{right && <span style={{ marginLeft: 'auto' }}>{right}</span>}</button>
  )

  return (
    <div ref={ref} style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
      <button onClick={() => setDeposit(true)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', background: 'var(--bg-3)', border: '1px solid var(--adx-card-border)', borderRadius: 8, padding: '3px 10px', cursor: 'pointer', color: 'var(--text)', lineHeight: 1.2 }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 700, fontFamily: 'var(--mono)' }}><span className="sensitive">{cash === null ? '…' : `$${cash.toFixed(2)}`}</span> <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{t('cash')}</span></span>
        <span style={{ fontSize: '0.64rem', color: 'var(--adx-accent)', fontWeight: 700 }}>{t('Deposit')}</span>
      </button>
      <button onClick={() => setOpen(o => !o)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }} title={shortAddr(trader.address)}>
        <Avatar address={trader.address} url={profile?.avatar_url} size={30} ring={trader.kind === 'trading-wallet' ? '#facc15' : undefined} />
      </button>

      {open && (
        <div className="menu-pop" style={{ top: 40, right: 0 }}>
          <div style={{ padding: '6px 10px 8px', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            {profile?.username ? `@${profile.username}` : shortAddr(trader.address)} · {trader.kind === 'trading-wallet' ? `⚡ ${t('trading wallet')}` : t('wallet')}
          </div>
          {item('☺', t('Your profile'), () => go({ name: 'trader', address: trader.address! }))}
          {item('👤', t('Manage account'), () => { setOpen(false); setSettings('account') })}
          {item('⚙', t('Settings'), () => { setOpen(false); setSettings('trading') })}
          {item('▤', t('Portfolio'), () => go({ name: 'portfolio' }))}
          {item('↑', t('Withdraw'), () => { setOpen(false); setWithdraw(true) })}
          {item('⇅', t('Transfers'), () => go({ name: 'transfers' }))}
          {item('◌', t('Blur balances'), () => setPrefs(p => ({ blur: !p.blur })), <Toggle on={prefs.blur} />)}
          {item('✦', t('Rewards'), () => go({ name: 'rewards' }))}
          {item('⚑', t('Clans'), () => go({ name: 'clans' }))}
          {item('🌐', t('Language'), () => { setOpen(false); setSettings('language') }, <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{LANGS.find(l => l.code === lang)?.name}</span>)}
          {item('✉', t('Contact support'), () => { setOpen(false); setSupport(true) })}
          <div style={{ borderTop: '1px solid var(--adx-card-border)', margin: '6px 0' }} />
          {trader.kind === 'trading-wallet'
            ? item('🔒', t('Lock trading wallet'), () => { setOpen(false); lock() })
            : item('⏻', t('Disconnect wallet'), () => { setOpen(false); disconnect() })}
        </div>
      )}

      {deposit && <DepositModal trader={trader} navigate={navigate} onClose={() => setDeposit(false)} />}
      {withdraw && <WithdrawModal trader={trader} onClose={() => setWithdraw(false)} />}
      {settings && <SettingsModal initial={settings} onClose={() => setSettings(null)} onSupport={() => { setSettings(null); setSupport(true) }} />}
      {support && <SupportModal onClose={() => setSupport(false)} />}
    </div>
  )
}

/** Language picker shown before a wallet is connected. */
function LangQuick() {
  const lang = useLang()
  return (
    <select className="disc-select lang-quick" value={lang} onChange={e => void setLang(e.target.value as Lang)} title={t('Language')} aria-label={t('Language')}>
      {LANGS.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
    </select>
  )
}

function Toggle({ on }: { on: boolean }) {
  return <span style={{ display: 'inline-block', width: 28, height: 16, borderRadius: 99, background: on ? 'var(--adx-accent)' : 'var(--bg-4)', position: 'relative' }}><span style={{ position: 'absolute', top: 2, left: on ? 14 : 2, width: 12, height: 12, borderRadius: '50%', background: '#fff', transition: 'left 0.15s' }} /></span>
}

export function SettingsModal({ onClose, initial = 'trading', onSupport }: { onClose: () => void; initial?: SettingsTab; onSupport?: () => void }) {
  const prefs = usePrefs()
  const trader = useTrader()
  const lang = useLang()
  const [tab, setTab] = useState<SettingsTab>(initial)
  const [buy, setBuy] = useState(prefs.buyPresets.map(String))
  const [sell, setSell] = useState(prefs.sellPresets.map(String))
  const [saved, setSaved] = useState(false)
  const [signOut, setSignOut] = useState<'' | 'busy' | 'done' | string>('')

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
  const toggleRow = (label: string, hint: string, on: boolean, set: (v: boolean) => void) => (
    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: '0.84rem', cursor: 'pointer' }}>
      <span>{label}<div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{hint}</div></span>
      <input type="checkbox" checked={on} onChange={e => set(e.target.checked)} />
    </label>
  )

  async function doSignOutEverywhere() {
    setSignOut('busy')
    try { await signOutEverywhere(trader); setSignOut('done') } catch (e) { setSignOut(e instanceof Error ? e.message : t('Could not sign out')) }
  }

  const TABS: [SettingsTab, string][] = [['trading', t('Trading')], ['account', t('Account')], ['notifications', t('Notifications')], ['language', t('Language')]]

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ width: 'min(480px, 100%)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{t('Settings')}</b><button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button></div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {TABS.map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`disc-sub${tab === k ? ' active' : ''}`}>{l}</button>)}
        </div>

        {tab === 'trading' && (
          <>
            <div><b style={{ fontSize: '0.86rem' }}>{t('Quick trade presets')}</b><div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '2px 0 8px' }}>{t('Your one-tap buy amounts and sell percentages.')}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', marginBottom: 6 }}><span>{t('Buy presets (USDC)')}</span><button className="disc-link" onClick={() => { setBuy(DEFAULT_PREFS.buyPresets.map(String)); setSell(DEFAULT_PREFS.sellPresets.map(String)) }}>↺ {t('Reset')}</button></div>
              {grid(buy, setBuy, '$', '')}
              <div style={{ fontSize: '0.74rem', margin: '10px 0 6px' }}>{t('Sell presets (% of holding)')}</div>
              {grid(sell, setSell, '', '%')}
              <button className="btn-primary" style={{ width: '100%', marginTop: 10 }} onClick={save}>{saved ? t('Saved ✓') : t('Save presets')}</button>
            </div>
            {toggleRow(t('Blur balances'), t('Hide your cash and PnL on screen (hover to peek)'), prefs.blur, v => setPrefs({ blur: v }))}
          </>
        )}

        {tab === 'account' && (
          <>
            <div style={{ fontSize: '0.84rem' }}><b>{t('Account and addresses')}</b>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.7 }}>
                {t('Trading as')}: <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)', wordBreak: 'break-all' }}>{trader.address ?? t('not connected')}</span><br />
                {t('Type')}: {trader.kind === 'trading-wallet' ? `⚡ ${t('One-tap trading wallet (self-custody, encrypted in this browser)')}` : trader.kind === 'wallet' ? t('Connected wallet') : '—'}
              </div>
            </div>
            <div style={{ fontSize: '0.84rem' }}><b>{t('Security')}</b>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.6 }}>
                {t('Your wallet is your account — there is no password to steal. Signing in only asks your wallet to sign a free message.')}
              </div>
              <div className="reward-row" style={{ padding: '10px 0' }}>
                <span>{t('Two-factor (passkey) on the trading wallet')}<div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('Set up or turn off in the Trading wallet panel (right side).')}</div></span>
                <b style={{ color: hasPasskey() ? 'var(--green)' : 'var(--text-muted)', fontSize: '0.78rem' }}>{hasPasskey() ? t('On') : t('Off')}</b>
              </div>
              <div className="reward-row" style={{ padding: '10px 0', borderBottom: 'none' }}>
                <span>{t('Sign out of all devices')}<div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('Ends every ARCDEX sign-in for this wallet, everywhere. Your funds are not affected.')}</div></span>
                <button className="btn-ghost" disabled={!trader.address || signOut === 'busy'} onClick={() => void doSignOutEverywhere()}>{signOut === 'busy' ? '…' : signOut === 'done' ? t('Done ✓') : t('Sign out')}</button>
              </div>
              {signOut && signOut !== 'busy' && signOut !== 'done' && <div style={{ fontSize: '0.72rem', color: '#fca5a5' }}>{signOut}</div>}
            </div>
            {onSupport && <button className="btn-ghost" onClick={onSupport}>✉ {t('Contact support')}</button>}
          </>
        )}

        {tab === 'notifications' && (
          <>
            {toggleRow(t('Alert sound'), t('Beep when a trader you follow moves'), prefs.alertSound, v => setPrefs({ alertSound: v }))}
            {toggleRow(t('Desktop notifications'), t('Get alerts while ARCDEX is in a background tab'), prefs.alertNotify, async v => {
              if (!v) { setPrefs({ alertNotify: false }); return }
              if (await enableAlertNotifications()) setPrefs({ alertNotify: true })
              else alert(t('Notifications are blocked for this site. Allow them in your browser settings, then try again.'))
            })}
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.84rem' }}>
              <span>{t('Minimum alert size')}</span>
              <select className="disc-select" value={prefs.alertMinUsd} onChange={e => setPrefs({ alertMinUsd: Number(e.target.value) })}>
                {[0, 10, 100, 1000].map(v => <option key={v} value={v}>{v === 0 ? t('Any size') : `>$${v >= 1000 ? '1K' : v}`}</option>)}
              </select>
            </label>
          </>
        )}

        {tab === 'language' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {LANGS.map(l => (
              <button key={l.code} onClick={() => void setLang(l.code)} className="menu-item" style={{ border: `1px solid ${lang === l.code ? 'var(--adx-accent)' : 'var(--adx-card-border)'}`, borderRadius: 8 }}>
                <span style={{ flex: 1, textAlign: 'left' }}>{l.name}</span>{lang === l.code && <span style={{ color: 'var(--adx-accent)' }}>✓</span>}
              </button>
            ))}
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('Coin names, usernames and theses stay as their authors wrote them.')}</div>
          </div>
        )}
      </div>
    </div>
  )
}
