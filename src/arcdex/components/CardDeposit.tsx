import { useEffect, useRef, useState } from 'react'
import { moonpayStatus, onrampStatus, signMoonpay, startCardDeposit, startMoonpay, type MoonpayStatus } from '../api/social'
import type { Trader } from '../lib/identity'
import { t as T, N_ } from '../lib/i18n'

// Buy USDC on Arc with a card. Two checkouts, both delivering straight to this wallet on Arc:
// - MoonPay (api/moonpay.ts, 2026-10-18): Visa or Mastercard, in the countries MoonPay serves (Tanzania among them,
//   where Circle's partner offers no payment method). Its SDK (@moonpay/moonpay-js) opens the checkout over the page;
//   the engine signs it for this wallet. Where the SDK can't load, the engine's signed URL opens in a new window.
// - Circle's Onramp widget, embedded (api/onramp.ts): debit card, Apple Pay, Google Pay, bank transfer in some regions.
// KYC and payment happen with the provider; ARCDEX never sees card details.

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
  const [circleOn, setCircleOn] = useState(false)
  const [mp, setMp] = useState<MoonpayStatus | null>(null)
  const [mpBusy, setMpBusy] = useState(false)
  const [mpMsg, setMpMsg] = useState<{ text: string; url?: string; err?: boolean } | null>(null)
  const [msg, setMsg] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const widget = useRef<{ close: () => void } | null>(null)
  const mpSdk = useRef<{ close: () => void } | null>(null)

  useEffect(() => {
    void Promise.all([onrampStatus(), moonpayStatus()]).then(([c, m]) => {
      setSandbox(c.sandbox); setCircleOn(c.enabled); setMp(m)
      setStage(c.enabled || m.enabled ? 'ready' : 'off')
    })
    return () => { widget.current?.close(); widget.current = null; mpSdk.current?.close(); mpSdk.current = null }
  }, [])

  /** MoonPay's checkout over the page (its SDK), signed by the engine for this wallet. False when the SDK can't be
   * used here (not loaded, no key), so the caller falls back to the signed URL. */
  async function openMpOverlay(): Promise<boolean> {
    if (!mp?.apiKey || !trader.address) return false
    const { loadMoonPay } = await import('@moonpay/moonpay-js')
    const init = await loadMoonPay().catch(() => undefined)
    if (!init) return false
    const sdk = init({
      flow: 'buy',
      environment: mp.sandbox ? 'sandbox' : 'production',
      variant: 'overlay',
      params: { apiKey: mp.apiKey, currencyCode: mp.currency ?? 'usdc_arc', walletAddress: trader.address, baseCurrencyCode: 'usd' },
      handlers: {
        onTransactionCompleted: async () => {
          setMpMsg({ text: T('Payment received — your USDC is on its way to Arc.') })
          onSettled()
        },
      },
    })
    if (!sdk) return false
    const { signature } = await signMoonpay(trader, sdk.generateUrlForSigning())
    sdk.updateSignature(signature)
    mpSdk.current?.close()
    mpSdk.current = sdk
    sdk.show()
    return true
  }

  async function startMp() {
    setMpBusy(true); setMpMsg(null)
    try {
      if (await openMpOverlay().catch(() => false)) {
        setMpMsg({ text: T('MoonPay is open. Your USDC arrives in this wallet on Arc once the payment clears, usually within minutes.') })
        return
      }
      // Without the SDK: the engine's signed URL, in a new tab. The tab can't be opened before the click's await, so
      // where the browser blocks it a link is shown instead.
      const { url } = await startMoonpay(trader)
      // (Not 'noopener': with it window.open returns null, which reads as blocked.)
      const w = window.open(url, '_blank')
      if (w) w.opener = null
      setMpMsg(w
        ? { text: T('MoonPay opened in a new window. Your USDC arrives in this wallet on Arc once the payment clears, usually within minutes.'), url }
        : { text: T('Your browser blocked the new window. Open MoonPay here:'), url })
    } catch (e) {
      setMpMsg({ text: e instanceof Error ? e.message : T('Could not start a card deposit'), err: true })
    } finally { setMpBusy(false) }
  }

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
        onDepositNotCompleted: ({ code }) => {
          setStage('error')
          const why = NOT_COMPLETED[code] ? T(NOT_COMPLETED[code]) : T("The purchase did not complete. You were not charged.")
          setMsg(code === 'NO_PAYMENT_OPTIONS' && mp?.enabled ? `${why} ${T('Try Visa or Mastercard through MoonPay above.')}` : why)
        },
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

  const wallet = trader.kind === 'trading-wallet' ? T("trading wallet") : T("wallet")
  const showWidget = stage === 'open' || stage === 'submitted' || stage === 'settled'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {mp?.enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {mp.sandbox && <div style={{ fontSize: '0.72rem', color: '#fcd34d', textAlign: 'center' }}>{T("Test mode — no real money moves.")}</div>}
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            <b style={{ color: 'var(--text)' }}>{T('Visa or Mastercard')}</b>{' · '}
            {T('Pay in your own currency through MoonPay. USDC goes straight to your {wallet} on Arc. MoonPay checks your identity the first time.', { wallet })}
          </div>
          <button className="btn-primary" onClick={() => void startMp()} disabled={mpBusy}>{mpBusy ? T("Opening…") : T('Buy USDC with a card')}</button>
          {mpMsg && (
            <div style={{ fontSize: '0.78rem', padding: '8px 10px', borderRadius: 8, textAlign: 'center',
              color: mpMsg.err ? '#fca5a5' : 'var(--text-muted)', background: mpMsg.err ? 'rgba(239,68,68,0.1)' : 'var(--bg-tertiary, rgba(127,127,127,0.08))' }}>
              {mpMsg.text}{mpMsg.url && <>{' '}<a href={mpMsg.url} target="_blank" rel="noopener noreferrer">{T('Open MoonPay')}</a></>}
            </div>
          )}
          <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', textAlign: 'center' }}>{T("Card processing and identity checks are handled by MoonPay, not ARCDEX.")}</div>
        </div>
      )}
      {circleOn && (
        <>
          {mp?.enabled && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: 4 }}>{T('Or Circle’s checkout: debit card, Apple Pay, Google Pay')}</div>}
          {sandbox && <div style={{ fontSize: '0.72rem', color: '#fcd34d', textAlign: 'center' }}>{T("Test mode — no real money moves.")}</div>}
          {(stage === 'ready' || stage === 'starting' || stage === 'error') && (
            <>
              {!mp?.enabled && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{T("Pay with a debit card, Apple Pay or Google Pay (bank transfer in some countries). USDC goes straight to your")}{' '}{wallet}{' '}{T("on Arc — ready to trade, no bridging. A quick identity check may be needed the first time. Credit cards aren't supported.")}</div>}
              <button className={mp?.enabled ? 'btn-ghost' : 'btn-primary'} onClick={() => void start()} disabled={stage === 'starting'}>{stage === 'starting' ? T("Opening…") : stage === 'error' ? T("Try again") : T("Buy USDC")}</button>
            </>
          )}
          {msg && (
            <div style={{ fontSize: '0.78rem', padding: '8px 10px', borderRadius: 8, textAlign: 'center',
              color: stage === 'error' ? '#fca5a5' : '#86efac', background: stage === 'error' ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)' }}>{msg}</div>
          )}
          <div ref={box} style={{ width: '100%', height: showWidget ? 620 : 0, borderRadius: 10, overflow: 'hidden', background: showWidget ? '#fff' : undefined }} />
          <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', textAlign: 'center' }}>{T("Powered by Circle. Card processing and identity checks are handled by Circle's payment partner, not ARCDEX.")}</div>
        </>
      )}
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5 }}>{children}</div>
}
