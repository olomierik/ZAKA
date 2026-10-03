// /futures — perpetual futures, coming soon (ARCSENSE, 2026-10-03). The
// markets planned first, with their live index prices from the Chainlink
// feeds on Arc mainnet the futures will be priced against, and what to
// expect. Nothing here trades yet.

import { useEffect, useState } from 'react'
import { client } from '../api/launchpad'
import { agoShort } from '../lib/ago'
import { t as T } from '../lib/i18n'
import type { Page } from '../App'

/** Chainlink Data Feeds on Arc mainnet (reference-data-directory, feeds-arc-mainnet.json; 8 decimals). */
const FEEDS: { symbol: string; name: string; address: `0x${string}` }[] = [
  { symbol: 'BTC', name: 'Bitcoin', address: '0xa109B535C70C8Be9995be64Bb6751AcDB27e03De' },
  { symbol: 'ETH', name: 'Ether', address: '0x50FCDD99D6762D1C170DC6A9111db944AEE6D364' },
  { symbol: 'SOL', name: 'Solana', address: '0x2d04D354f5fDaE3De723df475745B0a9B4edf90C' },
]
const ROUND_ABI = [{ type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [
  { name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' }, { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' }, { name: 'answeredInRound', type: 'uint80' },
] }] as const

interface Quote { price: number; updatedAt: number }

function useIndexPrices(): Record<string, Quote | null> {
  const [q, setQ] = useState<Record<string, Quote | null>>({})
  useEffect(() => {
    let alive = true
    const load = () => {
      for (const f of FEEDS) {
        void client.readContract({ address: f.address, abi: ROUND_ABI, functionName: 'latestRoundData' })
          .then(r => { if (alive) setQ(prev => ({ ...prev, [f.symbol]: { price: Number(r[1]) / 1e8, updatedAt: Number(r[3]) * 1000 } })) })
          .catch(() => { if (alive) setQ(prev => ({ ...prev, [f.symbol]: prev[f.symbol] ?? null })) })
      }
    }
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return q
}

const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function FuturesPage({ navigate }: { navigate: (p: Page) => void }) {
  const prices = useIndexPrices()
  const POINTS: [string, string][] = [
    [T('USDC in, USDC out'), T('Margin, profits and fees are all in USDC, the currency Arc runs on.')],
    [T('Chainlink prices'), T('Positions are priced by Chainlink feeds on Arc, not by thin pools anyone can push.')],
    [T('Fees fund the pool'), T('Fees from $SENSE trading are added as liquidity for futures trading.')],
  ]
  return (
    <div className="content-page soon-page">
      <div className="soon-hero">
        <span className="soon-badge">{T('Coming soon')}</span>
        <h2 className="page-h">📊 {T('Perpetual futures')}</h2>
        <p className="soon-lead">{T('Long or short BTC, ETH and SOL with up to 10× leverage, settled in USDC and priced by Chainlink. Testnet first, then mainnet after an independent audit.')}</p>
      </div>

      <div className="soon-markets">
        {FEEDS.map(f => {
          const q = prices[f.symbol]
          return (
            <div key={f.symbol} className="soon-market">
              <div className="soon-market-head"><b>{f.symbol}-PERP</b><span>{f.name}</span></div>
              <div className="soon-market-price">{q ? usd(q.price) : '…'}</div>
              <div className="soon-market-foot">
                <span>{T('Up to 10× leverage')}</span>
                <span>{q ? T('updated {t} ago', { t: agoShort(q.updatedAt) }) : ' '}</span>
              </div>
            </div>
          )
        })}
      </div>
      <div className="soon-note">{T('Live prices from Chainlink on Arc, the feeds futures will use.')}</div>

      <div className="soon-points">
        {POINTS.map(([title, body]) => <div key={title} className="soon-point"><b>{title}</b><span>{body}</span></div>)}
      </div>

      <div className="soon-cta">
        <button className="btn-primary" onClick={() => navigate({ name: 'terminal' })}>{T('Trade spot now')} →</button>
      </div>
    </div>
  )
}
