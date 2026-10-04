// Portfolio's Robinhood Chain section: coins held there, valued live, each
// with Sell to USDC (back to Arc), and the ETH kept there for gas. Shown only
// when the wallet holds something on Robinhood Chain.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Page } from '../App'
import Sheet from './Sheet'
import { ChainIcon } from './Chains'
import { RhLogo, StockTag } from './Robinhood'
import RobinhoodTrade from './RobinhoodTrade'
import { loadRhHoldings, type RhHolding } from '../lib/rhPortfolio'
import { onBalances } from '../lib/balances'
import { t as T } from '../lib/i18n'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const amountFmt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toLocaleString(undefined, { maximumFractionDigits: 4 })

export default function RobinhoodHoldings({ owner, navigate, onValue }: { owner: string; navigate: (p: Page) => void; onValue?: (usd: number) => void }) {
  const [coins, setCoins] = useState<RhHolding[]>([])
  const [eth, setEth] = useState(0)
  const [sell, setSell] = useState<RhHolding | null>(null)
  const seq = useRef(0)

  const load = useCallback(() => {
    const n = ++seq.current
    loadRhHoldings(owner).then(r => {
      if (n !== seq.current) return
      setCoins(r.coins); setEth(r.eth)
      onValue?.(r.coins.reduce((s, c) => s + c.valueUsd, 0))
    }).catch(() => {})
  }, [owner, onValue])

  useEffect(() => {
    setCoins([]); setEth(0); onValue?.(0)
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 60_000)
    const off = onBalances(load)
    return () => { clearInterval(id); off() }
  }, [load, onValue])

  if (coins.length === 0 && eth === 0) return null
  return (
    <div className="rh-holdings">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 0 10px' }}>
        <b style={{ fontSize: '0.95rem', display: 'inline-flex', alignItems: 'center', gap: 6 }}><ChainIcon chain="Robinhood" size={16} /> {T('On Robinhood Chain')}</b>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }} className="sensitive">{T('Gas')}: {eth.toPrecision(2)} ETH</span>
      </div>
      {coins.map(h => (
        <div key={h.address} className="arc-card" style={{ padding: '10px 12px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={() => navigate({ name: 'rh-token', address: h.address, pool: h.pool })}
            style={{ display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 220px', minWidth: 0, background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
            <RhLogo src={h.image} symbol={h.symbol} size={34} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', gap: 6, alignItems: 'center' }}>{h.symbol}{h.stock && <StockTag />}</span>
                <span className="sensitive" style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{h.priceUsd > 0 ? money(h.valueUsd) : '—'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 3 }}>
                <span className="mono sensitive">{amountFmt(h.balance)} {h.symbol}</span>
                <span className="mono">{h.priceUsd >= 1 ? `$${h.priceUsd.toFixed(4)}` : h.priceUsd > 0 ? `$${h.priceUsd.toPrecision(4)}` : '—'}</span>
              </div>
            </div>
          </button>
          <button onClick={() => setSell(h)} style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 8, fontWeight: 700, fontSize: '0.76rem', cursor: 'pointer', background: 'rgba(239,68,68,0.12)', color: 'var(--red)', border: '1px solid rgba(239,68,68,0.35)' }}>{T('Sell to USDC')}</button>
        </div>
      ))}
      <Sheet open={!!sell} onClose={() => setSell(null)} title={sell ? T('Sell {symbol}', { symbol: sell.symbol }) : undefined}>
        {sell && <RobinhoodTrade key={sell.address} token={sell.address} symbol={sell.symbol} decimals={sell.decimals} priceUsd={sell.priceUsd} stock={sell.stock}
          initialMode="sell" onTraded={load} />}
      </Sheet>
    </div>
  )
}
