import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useAdminHint } from '../lib/adminSession'
import { JITO_TIP } from '../lib/jito'
import { ConnectButton, OPEN_DEPOSIT } from './ConnectWallet'
import { markReturning } from '../lib/returning'
import { useDisconnect } from 'wagmi'
import Avatar from './Avatar'
import { enableAlertNotifications } from '../lib/notify'
import { getProfile, signOutEverywhere, type Profile } from '../api/social'
import { accountOwner, hasPasskey, lock } from '../lib/embeddedWallet'
import { shortAddr, useTrader } from '../lib/identity'
import { DEFAULT_PREFS, setPrefs, usePrefs } from '../lib/prefs'
import { t } from '../lib/i18n'
import { useCash } from '../lib/usdc'
import type { Page } from '../App'
import { isPrivyWallet, privySignOut, usePrivyState } from '../privy/state'
import { PrivyAccountPanel } from '../privy/PrivyAccount'

// Top-right account area, fomo-style: "$X cash · Deposit", then the avatar menu with what's yours (profile, account,
// settings, withdraw, transfers, rewards, support, sign out). Pages that are in the top bar or its More menu aren't
// repeated here (owner, 2026-10-17: "nothing repeated on our platform"); the language is the top bar's.

type SettingsTab = 'trading' | 'account' | 'notifications'

// The windows open on a click, so their code (deposit and withdraw, with the Solana cross-chain form behind them) loads
// then, not with every page (2026-10-16, the build pack's Phase 3: it was ~60 KB on every first load).
const DepositModal = lazy(() => import('./CashModals').then(m => ({ default: m.DepositModal })))
const WithdrawModal = lazy(() => import('./CashModals').then(m => ({ default: m.WithdrawModal })))
const SupportModal = lazy(() => import('./SupportModal'))

export default function AccountMenu({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  // An account opened from a Solana wallet (lib/solAccount.ts): signed out, not locked.
  const solOwner = trader.kind === 'trading-wallet' ? accountOwner() : null
  // An email or social sign-in (Privy): its wallet is the connected one.
  const privy = usePrivyState()
  const isAdmin = useAdminHint(trader.address, privy.authenticated ? privy.label : null)
  const viaPrivy = trader.kind === 'wallet' && isPrivyWallet(trader.address)
  const prefs = usePrefs()
  const { cash } = useCash(trader.address)
  const { disconnect } = useDisconnect()
  const [open, setOpen] = useState(false)
  const [deposit, setDeposit] = useState(false)
  const [welcome, setWelcome] = useState(false)
  const [withdraw, setWithdraw] = useState(false)
  const [settings, setSettings] = useState<SettingsTab | null>(null)
  const [support, setSupport] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { if (trader.address) void getProfile(trader.address).then(setProfile).catch(() => {}) }, [trader.address])
  // After a first sign-in (ConnectWallet.tsx logIn): the deposit window, saying the wallet is ready.
  useEffect(() => {
    const open = (e: Event) => { setWelcome(!!(e as CustomEvent<{ welcome?: boolean }>).detail?.welcome); setDeposit(true) }
    window.addEventListener(OPEN_DEPOSIT, open)
    return () => window.removeEventListener(OPEN_DEPOSIT, open)
  }, [])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  if (!trader.address) return <ConnectButton label={t('Log in')} />

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
        <Avatar address={trader.address} url={profile?.avatar_url} size={30} ring={solOwner ? '#ab9ff2' : trader.kind === 'trading-wallet' ? '#facc15' : undefined} />
      </button>

      {open && (
        <div className="menu-pop" style={{ top: 40, right: 0 }}>
          <div style={{ padding: '6px 10px 8px', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            {profile?.username ? `@${profile.username}` : shortAddr(trader.address)} · {solOwner ? `◎ ${t('Solana account')}` : viaPrivy ? `✉ ${privy.label ?? t('email sign-in')}` : trader.kind === 'trading-wallet' ? `⚡ ${t('trading wallet')}` : t('wallet')}
          </div>
          {item('☺', t('Your profile'), () => go({ name: 'trader', address: trader.address! }))}
          {item('👤', t('Manage account'), () => { setOpen(false); setSettings('account') })}
          {viaPrivy && item('🔑', t('Export keys'), () => { setOpen(false); setSettings('account') })}
          {item('⚙', t('Settings'), () => { setOpen(false); setSettings('trading') })}
          {item('↑', t('Withdraw'), () => { setOpen(false); setWithdraw(true) })}
          {item('⇅', t('Transfers'), () => go({ name: 'transfers' }))}
          {item('◌', t('Blur balances'), () => setPrefs(p => ({ blur: !p.blur })), <Toggle on={prefs.blur} />)}
          {item('✦', t('Rewards'), () => go({ name: 'rewards' }))}
          {isAdmin && item('📈', t('Analytics'), () => go({ name: 'admin', tab: 'analytics' }))}
          {isAdmin && item('🛡', t('Admin'), () => go({ name: 'admin' }))}
          {item('✉', t('Contact support'), () => { setOpen(false); setSupport(true) })}
          <div style={{ borderTop: '1px solid var(--adx-card-border)', margin: '6px 0' }} />
          {solOwner
            ? item('⏻', t('Sign out'), () => { setOpen(false); markReturning(false); lock() })
            : viaPrivy
            ? item('⏻', t('Sign out'), () => { setOpen(false); markReturning(false); void privySignOut() })
            : trader.kind === 'trading-wallet'
            ? item('🔒', t('Lock trading wallet'), () => { setOpen(false); lock() })
            : item('⏻', t('Disconnect wallet'), () => { setOpen(false); markReturning(false); disconnect() })}
        </div>
      )}

      <Suspense fallback={null}>
        {deposit && <DepositModal trader={trader} navigate={navigate} welcome={welcome} onClose={() => { setDeposit(false); setWelcome(false) }} />}
        {withdraw && <WithdrawModal trader={trader} onClose={() => setWithdraw(false)} />}
        {support && <SupportModal onClose={() => setSupport(false)} />}
      </Suspense>
      {settings && <SettingsModal initial={settings} onClose={() => setSettings(null)} onSupport={() => { setSettings(null); setSupport(true) }} />}
    </div>
  )
}

function Toggle({ on }: { on: boolean }) {
  return <span style={{ display: 'inline-block', width: 28, height: 16, borderRadius: 99, background: on ? 'var(--adx-accent)' : 'var(--bg-4)', position: 'relative' }}><span style={{ position: 'absolute', top: 2, left: on ? 14 : 2, width: 12, height: 12, borderRadius: '50%', background: '#fff', transition: 'left 0.15s' }} /></span>
}

export function SettingsModal({ onClose, initial = 'trading', onSupport }: { onClose: () => void; initial?: SettingsTab; onSupport?: () => void }) {
  const prefs = usePrefs()
  const trader = useTrader()
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

  // The language is the top bar's (EN), not a second picker here.
  const TABS: [SettingsTab, string][] = [['trading', t('Trading')], ['account', t('Account')], ['notifications', t('Notifications')]]

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
            {/* Anti-MEV (lib/jito.ts): Solana trades ARCDEX sends go to Jito as a bundle only, with a tip. */}
            {toggleRow(t('🛡 Anti-MEV on Solana (Jito)'), t('Sends your Solana trades to Jito as a private bundle instead of the public network, so sandwich bots can’t trade around them. Adds a small tip.'), prefs.antiMev, v => setPrefs({ antiMev: v }))}
            {prefs.antiMev && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text-muted)' }}>{t('Jito tip')}</span>
                {JITO_TIP.choices.map(l => (
                  <button key={l} className={`disc-sub${prefs.jitoTipLamports === l ? ' active' : ''}`} onClick={() => setPrefs({ jitoTipLamports: l })}
                    title={t('{sol} SOL per trade', { sol: (l / 1e9).toString() })}>
                    {l === 10_000 ? t('Low') : l === 50_000 ? t('Normal') : t('Fast')} · {(l / 1e9).toFixed(5)} SOL
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'account' && (
          <>
            {trader.kind === 'wallet' && isPrivyWallet(trader.address) && <PrivyAccountPanel />}
            <div style={{ fontSize: '0.84rem' }}><b>{t('Account and addresses')}</b>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.7 }}>
                {t('Trading as')}: <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)', wordBreak: 'break-all' }}>{trader.address ?? t('not connected')}</span><br />
                {t('Type')}: {trader.kind === 'trading-wallet' && accountOwner() ? `◎ ${t('ARCDEX account of your Solana wallet {w}', { w: shortAddr(accountOwner()!) })}` : trader.kind === 'trading-wallet' ? `⚡ ${t('One-tap trading wallet (self-custody, encrypted in this browser)')}` : trader.kind === 'wallet' && isPrivyWallet(trader.address) ? `✉ ${t('Email & social sign-in (Privy)')}` : trader.kind === 'wallet' ? t('Connected wallet') : '—'}
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

      </div>
    </div>
  )
}
