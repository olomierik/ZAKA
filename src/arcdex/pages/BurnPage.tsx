import { useCallback, useEffect, useState } from 'react'
import { formatUnits, parseAbi, parseUnits, type Address } from 'viem'
import { client } from '../api/launchpad'
import { sendArc, txErrorText } from '../lib/tx'
import { useTrader } from '../lib/identity'
import { t as T } from '../lib/i18n'
import { ARCD, ARCD_POOL, ARC_EXPLORER, BURN_ADDRESS, FEE_WALLET, compact, loadArcd, price, short, type ArcdStats } from '../lib/arcd'
import type { Page } from '../App'

// /burn — the $ARCD buyback-and-burn dashboard. Public: how much $ARCD has
// been burned, what's waiting in the fee wallet, every recent burn. When
// the fee wallet itself is connected, it also gets the two buttons that
// keep the promise: buy back $ARCD, then burn it (send to 0x…dEaD).

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)'])

function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  return s < 3600 ? T('{n} min ago', { n: Math.max(1, Math.floor(s / 60)) }) : s < 86400 ? T('{n} hours ago', { n: Math.floor(s / 3600) }) : T('{n} days ago', { n: Math.floor(s / 86400) })
}

export default function BurnPage({ navigate }: { navigate: (p: Page) => void }) {
  const [d, setD] = useState<ArcdStats | null>(null)
  const refresh = useCallback(() => void loadArcd(true).then(setD).catch(() => {}), [])
  useEffect(() => {
    refresh()
    const id = setInterval(() => { if (!document.hidden) refresh() }, 60_000)
    return () => clearInterval(id)
  }, [refresh])

  const trader = useTrader()
  const isFeeWallet = trader.address?.toLowerCase() === FEE_WALLET
  const burnedPct = d?.burnedPct ?? 0

  const card: React.CSSProperties = { background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: '12px 14px' }
  const stat = (label: string, value: string, color?: string) => (
    <div style={card}><div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{label}</div><div style={{ fontSize: '1.15rem', fontWeight: 800, fontFamily: 'var(--mono)', color, marginTop: 2 }}>{value}</div></div>
  )

  return (
    <div className="token-page content-page" style={{ '--page-w': '980px' } as React.CSSProperties}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 className="page-h">🔥 {T('$ARCD buyback & burn')}</h2>
          <div style={{ fontSize: '0.86rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5, maxWidth: 640 }}>
            {T('100% of ARCDEX’s fee revenue buys back $ARCD on the open market and sends it to the burn address, where no one can ever move it again.')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-primary" style={{ padding: '10px 16px' }} onClick={() => navigate({ name: 'argus', address: ARCD, pool: ARCD_POOL })}>{T('Buy $ARCD')}</button>
          <a className="btn-ghost" href="/#burn">{T('How it works')}</a>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginTop: 14 }}>
        {stat(T('$ARCD burned'), d ? compact(d.burned) : '…', '#fb923c')}
        {stat(T('Of supply burned'), d ? (burnedPct < 0.01 ? '0%' : burnedPct.toFixed(2) + '%') : '…', '#fb923c')}
        {stat(T('USDC in the fee wallet'), d?.feeWallet.usdc != null ? '$' + compact(d.feeWallet.usdc) : '…')}
        {stat(T('$ARCD in the fee wallet'), d?.feeWallet.arcd != null ? compact(d.feeWallet.arcd) : '…')}
        {d?.fees && stat(T('Swap fees generated'), '$' + compact(d.fees.feesUsdc))}
        {d?.fees && stat(T('Paid to referrers'), '$' + compact(d.fees.referralPaid))}
        {stat(T('$ARCD price'), price(d?.market?.priceUsd))}
        {stat(T('Market cap'), d?.market ? '$' + compact(d.market.fdvUsd) : '…')}
      </div>

      {isFeeWallet && <OwnerPanel stats={d} onDone={refresh} navigate={navigate} />}

      <div style={{ ...card, marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <b>{T('Recent burns')}</b>
          <a href={`${ARC_EXPLORER}/address/${BURN_ADDRESS}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.78rem', color: 'var(--adx-accent)' }}>{T('Full history on the Arc explorer')} ↗</a>
        </div>
        {!d ? <div style={{ color: 'var(--text-muted)', fontSize: '0.84rem' }}>{T('Loading…')}</div> : d.burns.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.84rem' }}>{T('No burns in the last 48 hours. Burns appear here the moment they land on-chain.')}</div>
        ) : d.burns.map(b => (
          <a key={b.tx + b.block} href={`${ARC_EXPLORER}/tx/${b.tx}`} target="_blank" rel="noopener noreferrer" className="reward-row" style={{ color: 'var(--text)' }}>
            <span>🔥 <b style={{ fontFamily: 'var(--mono)' }}>{compact(b.amount)} ARCD</b> <span style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>{T('from')} {short(b.from)}</span></span>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{b.time ? ago(b.time) : '#' + b.block} ↗</span>
          </a>
        ))}
      </div>

      <div style={{ marginTop: 14, fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.7 }}>
        <b style={{ color: 'var(--text)' }}>{T('Don’t trust — verify.')}</b> {T('Every buyback and burn is a public transaction from the fee wallet to the burn address.')}{' '}
        <a href={`${ARC_EXPLORER}/address/${FEE_WALLET}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--adx-accent)', fontFamily: 'var(--mono)' }}>{T('Fee wallet')} {short(FEE_WALLET)} ↗</a>{' · '}
        <a href={`${ARC_EXPLORER}/address/${BURN_ADDRESS}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--adx-accent)', fontFamily: 'var(--mono)' }}>{T('Burn address')} {short(BURN_ADDRESS)} ↗</a>{' · '}
        <a href={`${ARC_EXPLORER}/token/${ARCD}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--adx-accent)', fontFamily: 'var(--mono)' }}>$ARCD {short(ARCD)} ↗</a>
      </div>
    </div>
  )
}

/** Only shown to the fee wallet: 1) buy back, 2) burn what it holds. */
function OwnerPanel({ stats, onDone, navigate }: { stats: ArcdStats | null; onDone: () => void; navigate: (p: Page) => void }) {
  const trader = useTrader()
  const [bal, setBal] = useState<bigint | null>(null)
  const [amount, setAmount] = useState('')
  const [state, setState] = useState<'' | 'burning' | { tx: string } | { error: string }>('')

  const load = useCallback(async () => {
    if (!trader.address) return
    const b = await client.readContract({ address: ARCD as Address, abi: ERC20, functionName: 'balanceOf', args: [trader.address as Address] }).catch(() => null)
    setBal(b)
    if (b !== null) setAmount(a => a || formatUnits(b, 18))
  }, [trader.address])
  useEffect(() => { void load() }, [load])

  async function burn() {
    let value: bigint
    try { value = parseUnits(amount || '0', 18) } catch { setState({ error: T('Enter a valid amount') }); return }
    if (value <= 0n) { setState({ error: T('Enter a valid amount') }); return }
    if (bal !== null && value > bal) { setState({ error: T('That is more $ARCD than the fee wallet holds') }); return }
    if (!confirm(T('Burn {amount} $ARCD? This sends it to the burn address and cannot be undone.', { amount: compact(Number(formatUnits(value, 18))) }))) return
    setState('burning')
    try {
      const req = { address: ARCD as Address, abi: ERC20, functionName: 'transfer' as const, args: [BURN_ADDRESS as Address, value] as const }
      const hash = await sendArc(trader.kind, req as never)
      const rc = await client.waitForTransactionReceipt({ hash })
      if (rc.status !== 'success') throw new Error(T('Burn failed'))
      setState({ tx: hash }); setAmount('')
      void load(); onDone()
    } catch (e) {
      setState({ error: txErrorText(e) })
    }
  }

  const box: React.CSSProperties = { background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }
  return (
    <div style={{ marginTop: 16, background: 'rgba(251,146,60,0.06)', border: '1px solid rgba(251,146,60,0.35)', borderRadius: 14, padding: 18 }}>
      <b>🔑 {T('Fee wallet controls')}</b>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '4px 0 14px' }}>{T('You are connected as the ARCDEX fee wallet. Only this wallet sees these buttons.')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
        <div style={box}>
          <b style={{ fontSize: '0.9rem' }}>1. {T('Buy back $ARCD')}</b>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{T('USDC available')}: <b style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{stats?.feeWallet.usdc != null ? '$' + stats.feeWallet.usdc.toFixed(2) : '…'}</b></div>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{T('Buy $ARCD with the fee wallet’s USDC on its coin page. Keep a little USDC for gas.')}</div>
          <button className="btn-primary" onClick={() => navigate({ name: 'argus', address: ARCD, pool: ARCD_POOL })}>{T('Open $ARCD to buy')} →</button>
        </div>
        <div style={box}>
          <b style={{ fontSize: '0.9rem' }}>2. {T('Burn $ARCD')}</b>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{T('$ARCD in this wallet')}: <b style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{bal === null ? '…' : compact(Number(formatUnits(bal, 18)))}</b></div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="field" value={amount} inputMode="decimal" onChange={e => setAmount(e.target.value)} placeholder="0" style={{ fontFamily: 'var(--mono)' }} />
            <button className="btn-ghost" onClick={() => bal !== null && setAmount(formatUnits(bal, 18))}>{T('Max')}</button>
          </div>
          <button className="btn-primary" style={{ background: 'linear-gradient(135deg,#f97316,#ef4444)' }} disabled={state === 'burning'} onClick={() => void burn()}>
            {state === 'burning' ? T('Burning…') : '🔥 ' + T('Burn $ARCD')}
          </button>
          {typeof state === 'object' && 'tx' in state && (
            <a href={`${ARC_EXPLORER}/tx/${state.tx}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.78rem', color: '#86efac' }}>✓ {T('Burned — view transaction')} ↗</a>
          )}
          {typeof state === 'object' && 'error' in state && <div style={{ fontSize: '0.76rem', color: '#fca5a5' }}>{state.error}</div>}
        </div>
      </div>
    </div>
  )
}
