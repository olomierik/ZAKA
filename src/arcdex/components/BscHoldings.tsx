// Portfolio's BNB Chain section (2026-10-05): the coins held at the trader's address on BNB Chain (the trading wallet's
// or the connected wallet's: the same address as on Arc), valued live (the market list's price, else GeckoTerminal's),
// each with Sell (to USDC on Arc, BNB or USDT; a coin on four.meme's curve, for BNB), and the BNB kept for gas. Coins
// checked: those bought from this browser and the market list, in one multicall. Shown only when something is held.

import { useCallback, useEffect, useRef, useState } from 'react'
import { formatUnits } from 'viem'
import type { Page } from '../App'
import Sheet from './Sheet'
import { ChainIcon } from './Chains'
import { RhLogo } from './Robinhood'
import BscTrade from './BscTrade'
import { cachedBscMarket, type FourInfo } from '../api/bscMarket'
import { gtDirect } from '../api/gtClient'
import { bnbBalance, bscBalances, heldBsc } from '../lib/bsc'
import { onBalances } from '../lib/balances'
import { BSC_QUOTES, readFour, BSC_RPC_BROWSER } from '../../../api/_bscCore'
import { t as T } from '../lib/i18n'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const amountFmt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toLocaleString(undefined, { maximumFractionDigits: 4 })

interface Held { token: string; symbol: string; image: string | null; pool: string; decimals: number; balance: number; priceUsd: number; valueUsd: number; four: FourInfo | null | undefined }

/** GeckoTerminal's prices for tokens the market list doesn't carry (30 a call). */
async function gtPrices(tokens: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (let i = 0; i < tokens.length; i += 30) {
    const d = await gtDirect<{ data?: { attributes?: { token_prices?: Record<string, string | null> } } }>(`/simple/networks/bsc/token_price/${tokens.slice(i, i + 30).join(',')}`).catch(() => null)
    for (const [k, v] of Object.entries(d?.data?.attributes?.token_prices ?? {})) { const n = Number(v); if (n > 0) out.set(k.toLowerCase(), n) }
  }
  return out
}

export default function BscHoldings({ owner, navigate, onValue }: { owner: string | null; navigate: (p: Page) => void; onValue?: (usd: number) => void }) {
  const [coins, setCoins] = useState<Held[]>([])
  const [bnb, setBnb] = useState(0)
  const [sell, setSell] = useState<Held | null>(null)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const n = ++seq.current
    if (!owner) { setCoins([]); setBnb(0); onValue?.(0); return }
    const market = new Map(cachedBscMarket().map(c => [c.address, c]))
    const tokens = [...new Set([...heldBsc(owner), ...market.keys()])].filter(t => !BSC_QUOTES.has(t))
    const [bal, gas] = await Promise.all([bscBalances(tokens, owner).catch(() => new Map<string, bigint>()), bnbBalance(owner).catch(() => 0)])
    const held = [...bal.keys()]
    const [prices, four] = await Promise.all([
      gtPrices(held.filter(t => !market.get(t)?.priceUsd)),
      readFour(held, [BSC_RPC_BROWSER]).catch(() => new Map<string, FourInfo | null>()),
    ])
    if (n !== seq.current) return
    const rows = held.map((t): Held => {
      const m = market.get(t)
      const decimals = m?.decimals ?? 18
      const balance = Number(formatUnits(bal.get(t)!, decimals))
      const price = m?.priceUsd || prices.get(t) || 0
      return { token: t, symbol: m?.symbol ?? `${t.slice(0, 6)}…`, image: m?.image ?? null, pool: m?.pool ?? '', decimals, balance, priceUsd: price, valueUsd: balance * price, four: four.has(t) ? four.get(t) : m?.four }
    }).filter(r => r.valueUsd >= 0.01 || r.priceUsd === 0).sort((a, b) => b.valueUsd - a.valueUsd)
    setCoins(rows); setBnb(gas)
    onValue?.(rows.reduce((s, c) => s + c.valueUsd, 0))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, onValue])

  useEffect(() => {
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 60_000)
    const off = onBalances(() => void load())
    return () => { clearInterval(id); off() }
  }, [load])

  if (coins.length === 0 && bnb === 0) return null
  return (
    <div className="rh-holdings">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 0 10px' }}>
        <b style={{ fontSize: '0.95rem', display: 'inline-flex', alignItems: 'center', gap: 6 }}><ChainIcon chain="BNB" size={16} /> {T('On BNB Chain')}</b>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }} className="sensitive">BNB: {bnb.toPrecision(2)}</span>
      </div>
      {coins.map(h => (
        <div key={h.token} className="arc-card" style={{ padding: '10px 12px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={() => navigate({ name: 'bsc-token', address: h.token, pool: h.pool })}
            style={{ display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 220px', minWidth: 0, background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
            <RhLogo src={h.image} symbol={h.symbol} size={34} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.symbol}</span>
                <span className="sensitive" style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{h.priceUsd > 0 ? money(h.valueUsd) : '—'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 3 }}>
                <span className="mono sensitive">{amountFmt(h.balance)} {h.symbol}</span>
                <span className="mono">{h.priceUsd >= 1 ? `$${h.priceUsd.toFixed(4)}` : h.priceUsd > 0 ? `$${h.priceUsd.toPrecision(4)}` : '—'}</span>
              </div>
            </div>
          </button>
          <button onClick={() => setSell(h)} style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 8, fontWeight: 700, fontSize: '0.76rem', cursor: 'pointer', background: 'rgba(239,68,68,0.12)', color: 'var(--red)', border: '1px solid rgba(239,68,68,0.35)' }}>{T('Sell')}</button>
        </div>
      ))}
      <Sheet open={!!sell} onClose={() => setSell(null)} title={sell ? T('Sell {symbol}', { symbol: sell.symbol }) : undefined}>
        {sell && <BscTrade key={sell.token} token={sell.token} symbol={sell.symbol} decimals={sell.decimals} priceUsd={sell.priceUsd} four={sell.four}
          initialMode="sell" onTraded={() => void load()} />}
      </Sheet>
    </div>
  )
}
