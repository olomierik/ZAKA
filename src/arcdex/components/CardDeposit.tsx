import { useEffect, useRef, useState } from 'react'
import { onrampStatus, startCardDeposit } from '../api/social'
import type { Trader } from '../lib/identity'
import { t as T, N_ } from '../lib/i18n'

// Buy USDC on Arc with a debit card, Apple Pay or Google Pay (bank transfer
// in some regions) — Circle's Onramp widget, embedded. KYC and payment
// happen inside the widget; the USDC lands straight in this wallet on Arc.
// The session is minted by /api/onramp for the signed-in wallet only.

type Stage = 'checking' | 'off' | 'ready' | 'starting' | 'open' | 'submitted' | 'settled' | 'error'

const NOT_COMPLETED: Record<string, string> = {
  CANCELED_BY_CUSTOMER: N_('You closed the purchase. Nothing was charged.'),
  NO_PAYMENT_OPTIONS: N_('No card payment options are available in your country yet. Try Crypto or From another chain.'),
  CUSTOMER_PENDING_REVIEW: N_('Your identity check is under review. You can come back once it clears.'),
  CUSTOMER_REJECTED: N_('The payment provider could not verify your identity, so the purchase was stopped.'),
  PAYMENT_PROVIDER_ERROR: N_('The payment provider had a problem. You were not charged — try again in a moment.'),
  SESSION_TIMEOUT: N_('The session expired after 30 minutes. Start again.'),
}

export default function CardDeposit({ trader, onSettled }: { trader: Trader; onSettled: () => void }) {
  const [stage, setStage] = useState<Stage>('checking')
  const [sandbox, setSandbox] = useState(false)
  const [msg, setMsg] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const widget = useRef<{ close: () => void } | null>(null)

  useEffect(() => {
    void onrampStatus().then(s => { setSandbox(s.sandbox); setStage(s.enabled ? 'ready' : 'off') })
    return () => { widget.current?.close(); widget.current = null }
  }, [])

  async function start() {
    setStage('starting'); setMsg('')
    try {
      const [{ session, widgetBaseUrl }, { createOnrampKit, parseOnrampSession }] = await Promise.all([
        startCardDeposit(trader),
        import('@circle-fin/onramp-kit'),
      ])
      if (!box.current) return
      widget.current?.close()
      setStage('open')
      widget.current = createOnrampKit({ widgetBaseUrl }).mountIframe({
        session: parseOnrampSession(session),
        container: box.current,
        title: T('Buy USDC on Arc'),
        onDepositSubmitted: () => { setStage('submitted'); setMsg(T("Payment received — your USDC is on its way to Arc.")) },
        onDepositSettled: ({ payload }) => {
          setStage('settled')
          setMsg(payload.amount ? T("{usd} of USDC arrived in your wallet on Arc. You're ready to trade.", { usd: '$' + payload.amount.toFixed(2) }) : T("USDC arrived in your wallet on Arc. You're ready to trade."))
          onSettled()
        },
        onDepositNotCompleted: ({ code }) => { setStage('error'); setMsg(NOT_COMPLETED[code] ? T(NOT_COMPLETED[code]) : T("The purchase did not complete. You were not charged.")) },
        onInitializationError: () => { setStage('error'); setMsg(T("The payment window could not load. Check that pop-up or tracker blockers allow onramp.arc.io, then try again.")) },
      })
    } catch (e) {
      setStage('error')
      setMsg(e instanceof Error ? e.message : T("Could not start a card deposit"))
    }
  }

  if (stage === 'checking') return <Note>{T("Checking card deposits…")}</Note>
  if (stage === 'off') return (
    <Note>{T("Card deposits are being switched on. Until then, buy USDC on any exchange and send it on Arc, or bring USDC from another chain.")}</Note>
  )

  const showWidget = stage === 'open' || stage === 'submitted' || stage === 'settled'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {sandbox && <div style={{ fontSize: '0.72rem', color: '#fcd34d', textAlign: 'center' }}>{T("Test mode — no real money moves.")}</div>}
      {(stage === 'ready' || stage === 'starting' || stage === 'error') && (
        <>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{T("Pay with a debit card, Apple Pay or Google Pay (bank transfer in some countries). USDC goes straight to your")}{' '}{trader.kind === 'trading-wallet' ? T("trading wallet") : T("wallet")}{' '}{T("on Arc — ready to trade, no bridging. A quick identity check may be needed the first time. Credit cards aren't supported.")}</div>
          <button className="btn-primary" onClick={() => void start()} disabled={stage === 'starting'}>{stage === 'starting' ? T("Opening…") : stage === 'error' ? T("Try again") : T("Buy USDC")}</button>
        </>
      )}
      {msg && (
        <div style={{ fontSize: '0.78rem', padding: '8px 10px', borderRadius: 8, textAlign: 'center',
          color: stage === 'error' ? '#fca5a5' : '#86efac', background: stage === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)' }}>{msg}</div>
      )}
      <div ref={box} style={{ width: '100%', height: showWidget ? 620 : 0, borderRadius: 10, overflow: 'hidden', background: showWidget ? '#fff' : undefined }} />
      <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', textAlign: 'center' }}>{T("Powered by Circle. Card processing and identity checks are handled by Circle's payment partner, not ARCDEX.")}</div>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5 }}>{children}</div>
}
