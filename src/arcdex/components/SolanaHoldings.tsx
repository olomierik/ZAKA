// Portfolio's Solana section (2026-10-04): the coins held in the trading wallet's Solana address and in the connected
// Solana wallet app, valued live (the market list's price, else GeckoTerminal's), each with Sell to USDC (back to Arc),
// and the SOL kept for fees. Shown only when something is held there.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Page } from '../App'
import Sheet from './Sheet'
import { ChainIcon } from './Chains'
import { RhLogo } from './Robinhood'
import SolanaTrade from './SolanaTrade'
import { cachedSolMarket } from '../api/solanaMarket'
import { gtDirect } from '../api/gtClient'
import { solBalance, solHoldings } from '../lib/solana'
import { pickSolSigner, useSolanaWallets, type SolSigner } from '../lib/solanaWallet'
import { onBalances } from '../lib/balances'
import { SOL_QUOTES } from '../../../api/_solCore'
import { t as T } from '../lib/i18n'

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const amountFmt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toLocaleString(undefined, { maximumFractionDigits: 4 })

interface Held { mint: string; owner: SolSigner; symbol: string; image: string | null; pool: string; decimals: number; balance: number; priceUsd: number; valueUsd: number }

/** GeckoTerminal's prices for mints the market list doesn't carry (30 a call). */
async function gtPrices(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (let i = 0; i < mints.length; i += 30) {
    const d = await gtDirect<{ data?: { attributes?: { token_prices?: Record<string, string | null> } } }>(`/simple/networks/solana/token_price/${mints.slice(i, i + 30).join(',')}`).catch(() => null)
    for (const [k, v] of Object.entries(d?.data?.attributes?.token_prices ?? {})) { const n = Number(v); if (n > 0) out.set(k, n) }
  }
  return out
}

export default function SolanaHoldings({ navigate, onValue }: { navigate: (p: Page) => void; onValue?: (usd: number) => void }) {
  const sol = useSolanaWallets()
  const [coins, setCoins] = useState<Held[]>([])
  const [solBal, setSolBal] = useState(0)
  const [sell, setSell] = useState<Held | null>(null)
  const seq = useRef(0)
  const owners: [SolSigner, string][] = [...(sol.trading ? [['trading', sol.trading] as [SolSigner, string]] : []), ...(sol.external ? [['external', sol.external.address] as [SolSigner, string]] : [])]
  const key = owners.map(o => o[1]).join(',')

  const load = useCallback(async () => {
    const n = ++seq.current
    if (!owners.length) { setCoins([]); setSolBal(0); onValue?.(0); return }
    const market = new Map(cachedSolMarket().map(c => [c.address, c]))
    const lists = await Promise.all(owners.map(async ([who, addr]) => ({ who, list: await solHoldings(addr).catch(() => []), sol: await solBalance(addr).catch(() => 0) })))
    const raw = lists.flatMap(l => l.list.filter(h => !SOL_QUOTES.has(h.mint)).map(h => ({ ...h, who: l.who })))
    const prices = await gtPrices([...new Set(raw.filter(h => !market.get(h.mint)?.priceUsd).map(h => h.mint))])
    if (n !== seq.current) return
    const rows = raw.map((h): Held => {
      const m = market.get(h.mint)
      const price = m?.priceUsd || prices.get(h.mint) || 0
      return { mint: h.mint, owner: h.who, symbol: m?.symbol ?? `${h.mint.slice(0, 4)}…`, image: m?.image ?? null, pool: m?.pool ?? '', decimals: h.decimals, balance: h.amount, priceUsd: price, valueUsd: h.amount * price }
    }).filter(r => r.valueUsd >= 0.01 || r.priceUsd === 0).sort((a, b) => b.valueUsd - a.valueUsd)
    setCoins(rows); setSolBal(lists.reduce((s, l) => s + l.sol, 0))
    onValue?.(rows.reduce((s, c) => s + c.valueUsd, 0))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, onValue])

  useEffect(() => {
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 60_000)
    const off = onBalances(() => void load())
    return () => { clearInterval(id); off() }
  }, [load])

  if (coins.length === 0 && solBal === 0) return null
  return (
    <div className="rh-holdings">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '18px 0 10px' }}>
        <b style={{ fontSize: '0.95rem', display: 'inline-flex', alignItems: 'center', gap: 6 }}><ChainIcon chain="Solana" size={16} /> {T('On Solana')}</b>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }} className="sensitive">SOL: {solBal.toPrecision(2)}</span>
      </div>
      {coins.map(h => (
        <div key={h.owner + h.mint} className="arc-card" style={{ padding: '10px 12px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={() => navigate({ name: 'sol-token', address: h.mint, pool: h.pool })}
            style={{ display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 220px', minWidth: 0, background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
            <RhLogo src={h.image} symbol={h.symbol} size={34} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.symbol}{owners.length > 1 && <small style={{ color: 'var(--text-muted)', fontWeight: 500 }}> · {h.owner === 'trading' ? T('trading wallet') : sol.external?.name}</small>}</span>
                <span className="sensitive" style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{h.priceUsd > 0 ? money(h.valueUsd) : '—'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 3 }}>
                <span className="mono sensitive">{amountFmt(h.balance)} {h.symbol}</span>
                <span className="mono">{h.priceUsd >= 1 ? `$${h.priceUsd.toFixed(4)}` : h.priceUsd > 0 ? `$${h.priceUsd.toPrecision(4)}` : '—'}</span>
              </div>
            </div>
          </button>
          <button onClick={() => { pickSolSigner(h.owner); setSell(h) }} style={{ marginLeft: 'auto', padding: '6px 12px', borderRadius: 8, fontWeight: 700, fontSize: '0.76rem', cursor: 'pointer', background: 'rgba(239,68,68,0.12)', color: 'var(--red)', border: '1px solid rgba(239,68,68,0.35)' }}>{T('Sell to USDC')}</button>
        </div>
      ))}
      <Sheet open={!!sell} onClose={() => setSell(null)} title={sell ? T('Sell {symbol}', { symbol: sell.symbol }) : undefined}>
        {sell && <SolanaTrade key={sell.owner + sell.mint} mint={sell.mint} symbol={sell.symbol} decimals={sell.decimals} priceUsd={sell.priceUsd}
          initialMode="sell" onTraded={() => void load()} />}
      </Sheet>
    </div>
  )
}
