import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { formatUnits, parseAbi, type Address } from 'viem'
import { client } from '../api/launchpad'
import { socialWrite } from '../api/social'
import CardDeposit from './CardDeposit'
import { shortAddr, type Trader } from '../lib/identity'
import { USDC, useCash, useSendToken, useSendUsdc } from '../lib/usdc'
import { txErrorText } from '../lib/tx'
import { FunderChips, PasscodeField, useWithdrawGuard } from './WithdrawGuard'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'
import { openTradingWallet } from '../lib/tradingWalletSheet'

// fomo-style cash flows: Deposit (USDC on Arc, or bridge from another
// chain), Withdraw (to any Arc address; a coin too, from Portfolio) and Send
// cash to a trader with a note. Everything is plain USDC on Arc — gas is paid
// in USDC too. From the trading wallet, anything not going back to the wallet
// that funded it asks for the passcode (WithdrawGuard).

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b style={{ fontSize: '1rem' }}>{title}</b>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.1rem' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function DepositModal({ trader, navigate, onClose, initial = 'crypto' }: { trader: Trader; navigate: (p: Page) => void; onClose: () => void; initial?: 'crypto' | 'bridge' | 'card' }) {
  const [mode, setMode] = useState<'crypto' | 'bridge' | 'card'>(initial)
  const { refresh } = useCash(trader.address)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const addr = trader.address
  useEffect(() => { if (addr) void QRCode.toDataURL(addr, { margin: 1, width: 220, color: { dark: '#0b1628', light: '#ffffff' } }).then(setQr).catch(() => {}) }, [addr])

  const opt = (m: typeof mode, title: string, sub: string, icon: string) => (
    <button onClick={() => setMode(m)} style={{ display: 'flex', gap: 12, alignItems: 'center', textAlign: 'left', padding: 12, borderRadius: 10, cursor: 'pointer', color: 'var(--text)', background: mode === m ? 'rgba(59,130,246,0.12)' : 'var(--bg-2)', border: `1px solid ${mode === m ? 'var(--adx-accent)' : 'var(--adx-card-border)'}` }}>
      <span style={{ fontSize: '1.2rem' }}>{icon}</span>
      <span><b style={{ display: 'block', fontSize: '0.86rem' }}>{title}</b><span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{sub}</span></span>
    </button>
  )

  return (
    <Modal title={T("Deposit with")} onClose={onClose}>
      {!addr ? (
        <div style={{ fontSize: '0.84rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {T("Connect a wallet or create a trading wallet first.")}
          <button className="btn-primary" onClick={() => { onClose(); openTradingWallet() }}>{T("Open trading wallet")}</button>
        </div>
      ) : (
        <>
          {opt('crypto', T('Crypto'), T('Send USDC on Arc from any wallet or exchange'), '⎘')}
          {opt('bridge', T('From another chain'), T('Move USDC to Arc with Circle CCTP (Ethereum, Base, …)'), '⇄')}
          {opt('card', T('Card, Apple Pay, Google Pay'), T('Buy USDC straight to Arc'), '💳')}
          {mode === 'crypto' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, paddingTop: 4 }}>
              {qr && <img src={qr} alt={T("Deposit address QR code")} style={{ width: 180, height: 180, borderRadius: 10 }} />}
              <div style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem', wordBreak: 'break-all', textAlign: 'center' }}>{addr}</div>
              <button className="btn-ghost" onClick={() => { void navigator.clipboard?.writeText(addr); setCopied(true) }}>{copied ? T("Copied ✓") : T("Copy address")}</button>
              <div style={{ fontSize: '0.72rem', color: '#fcd34d', textAlign: 'center', lineHeight: 1.5 }}>{T("Send only")}{' '}<b>{T("USDC on the Arc network")}</b>{' '}{T("to this address")}{trader.kind === 'trading-wallet' ? T(" (your one-tap trading wallet)") : ''}{T(". Other tokens or networks can be lost.")}</div>
            </div>
          )}
          {mode === 'bridge' && <button className="btn-primary" onClick={() => { onClose(); navigate({ name: 'bridge', dir: 'in' }) }}>{T("Open Bridge")}</button>}
          {mode === 'card' && <CardDeposit trader={trader} onSettled={refresh} />}
        </>
      )}
    </Modal>
  )
}

/** A coin to send instead of USDC (Portfolio → Send). */
export interface WithdrawAsset { address: Address; symbol: string; decimals: number }

const BALANCE_ABI = parseAbi(['function balanceOf(address) view returns (uint256)'])

export function WithdrawModal({ trader, onClose, asset, onSent }: { trader: Trader; onClose: () => void; asset?: WithdrawAsset; onSent?: () => void }) {
  const coin = asset && asset.address.toLowerCase() !== USDC.toLowerCase() ? asset : null
  const { cash, refresh } = useCash(trader.address)
  const [coinBal, setCoinBal] = useState<bigint | null>(null)
  const coinAddr = coin?.address ?? null
  const refreshCoin = useCallback(() => {
    if (!coinAddr || !trader.address) return
    void client.readContract({ address: coinAddr, abi: BALANCE_ABI, functionName: 'balanceOf', args: [trader.address] }).then(setCoinBal).catch(() => {})
  }, [coinAddr, trader.address])
  useEffect(() => { refreshCoin() }, [refreshCoin])
  const send = useSendToken(trader)
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // Anywhere but back to the wallet that funded it needs the passcode.
  const guard = useWithdrawGuard(trader, to)

  async function go() {
    if (busy) return
    setBusy(true); setMsg(null)
    try {
      await guard.confirm()
      const h = coin ? await send(coin.address, coin.decimals, to.trim(), amount) : await send(USDC, 6, to.trim(), amount)
      setMsg({ ok: true, text: coin ? `Sent ${amount} ${coin.symbol} — tx ${shortAddr(h)}` : `Sent $${amount} — tx ${shortAddr(h)}` })
      setAmount(''); guard.setPasscode(''); refresh(); refreshCoin(); onSent?.()
    } catch (e) {
      setMsg({ ok: false, text: txErrorText(e) })
    } finally { setBusy(false) }
  }

  const available = coin
    ? (coinBal === null ? '…' : `${Number(formatUnits(coinBal, coin.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${coin.symbol}`)
    : (cash === null ? '…' : `$${cash.toFixed(2)}`)
  const max = () => {
    if (coin) { if (coinBal !== null) setAmount(formatUnits(coinBal, coin.decimals)) }
    else if (cash !== null) setAmount(Math.max(0, cash - 0.05).toFixed(2))
  }
  const blocked = busy || !to || !amount || (guard.needsPasscode && !guard.passcode)

  return (
    <Modal title={coin ? T('Send {symbol}', { symbol: coin.symbol }) : T("Withdraw USDC")} onClose={onClose}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{T("Available:")}{' '}<b className="sensitive" style={{ color: 'var(--text)' }}>{available}</b></div>
      <FunderChips guard={guard} onPick={a => setTo(a)} />
      <input className="field" placeholder={T("Arc address 0x…")} value={to} onChange={e => setTo(e.target.value.trim())} />
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="field" type="number" min="0" placeholder={coin ? T('Amount ({symbol})', { symbol: coin.symbol }) : T("Amount (USDC)")} value={amount} onChange={e => setAmount(e.target.value)} />
        <button className="btn-ghost" onClick={max}>{T("Max")}</button>
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{coin ? T("Arc gas is paid in USDC, so keep a little USDC for it. Only send to an address on the Arc network.") : T("Arc gas is paid in USDC — Max leaves $0.05 for it. Only send to an address on the Arc network.")}</div>
      <PasscodeField guard={guard} onEnter={() => { if (!blocked) void go() }} />
      {msg && <div style={{ fontSize: '0.78rem', color: msg.ok ? '#86efac' : '#fca5a5' }}>{msg.text}</div>}
      <button className="btn-primary" disabled={blocked} onClick={() => void go()} style={{ opacity: blocked ? 0.5 : 1 }}>{busy ? T("Sending…") : coin ? T('Send {symbol}', { symbol: coin.symbol }) : T("Withdraw")}</button>
    </Modal>
  )
}

export function SendCashModal({ trader, to, toName, onClose }: { trader: Trader; to: string; toName: string; onClose: () => void }) {
  const { cash, refresh } = useCash(trader.address)
  const send = useSendUsdc(trader)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // Cash leaving the trading wallet for someone else needs the passcode.
  const guard = useWithdrawGuard(trader, to)

  async function go() {
    if (busy) return
    setBusy(true); setMsg(null)
    try {
      await guard.confirm()
      const h = await send(to, amount)
      if (note.trim()) await socialWrite(trader, 'transfer.note', { tx_hash: h, note: note.trim() }).catch(() => {})
      setMsg({ ok: true, text: `Sent $${amount} to ${toName}` }); setAmount(''); setNote(''); guard.setPasscode(''); refresh()
    } catch (e) {
      setMsg({ ok: false, text: txErrorText(e) })
    } finally { setBusy(false) }
  }
  const blocked = busy || !amount || !trader.address || (guard.needsPasscode && !guard.passcode)

  return (
    <Modal title={T('Send cash to {name}', { name: toName })} onClose={onClose}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{T("Your cash:")}{' '}<b className="sensitive" style={{ color: 'var(--text)' }}>{cash === null ? '…' : `$${cash.toFixed(2)}`}</b></div>
      <input className="field" type="number" min="0" placeholder="$0" value={amount} onChange={e => setAmount(e.target.value)} style={{ fontSize: '1.2rem', fontFamily: 'var(--mono)' }} />
      <textarea className="field" placeholder={T("Add a note (optional)")} maxLength={200} rows={2} value={note} onChange={e => setNote(e.target.value)} style={{ resize: 'vertical', fontFamily: 'inherit' }} />
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{note.length}{T("/200 · Sent instantly as USDC on Arc to")}{' '}{shortAddr(to)}.</div>
      <PasscodeField guard={guard} onEnter={() => { if (!blocked) void go() }} />
      {msg && <div style={{ fontSize: '0.78rem', color: msg.ok ? '#86efac' : '#fca5a5' }}>{msg.text}</div>}
      <button className="btn-primary" disabled={blocked} onClick={() => void go()} style={{ opacity: blocked ? 0.5 : 1 }}>{!trader.address ? T("Connect a wallet to send") : busy ? T("Sending…") : T("Send")}</button>
    </Modal>
  )
}
