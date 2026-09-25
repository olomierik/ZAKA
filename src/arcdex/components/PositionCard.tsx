import { useCallback, useEffect, useState } from 'react'
import { formatUnits, parseAbi, type Address } from 'viem'
import { client } from '../api/launchpad'
import { getProfile, getTraderPositions } from '../api/social'
import { referralLink } from '../lib/referral'
import { shortAddr, type Trader } from '../lib/identity'
import { useRouterInfo } from '../lib/routerInfo'
import ShareCardModal from './ShareCardModal'
import type { CardData } from '../lib/shareCard'
import type { TradeRow } from './TokenSocialTabs'
import { t as T } from '../lib/i18n'

// "Your position" on a coin: what you hold now, what you paid, your PnL,
// and a one-tap share card — the brag that brings new users in.
//
// Cost basis comes from your trades through ARCDEX (indexed from the
// router's own events — exact). If you traded this coin elsewhere, it
// falls back to your trades in the recent GeckoTerminal window.

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

interface Props {
  token: string
  symbol: string
  image: string | null
  priceUsd: number
  trader: Trader
  rows: TradeRow[]
  refreshKey: number
  onPositionUsd: (usd: number | null) => void
}

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n) >= 1e3 ? (Math.abs(n) / 1e3).toFixed(2) + 'K' : Math.abs(n).toFixed(2)}`

export default function PositionCard({ token, symbol, image, priceUsd, trader, rows, refreshKey, onPositionUsd }: Props) {
  const me = trader.address
  const info = useRouterInfo()
  const [bal, setBal] = useState<number | null>(null)
  const [basis, setBasis] = useState<{ bought: number; sold: number; source: 'arcdex' | 'recent' } | null>(null)
  const [share, setShare] = useState<{ card: CardData; text: string } | null>(null)

  const load = useCallback(async () => {
    if (!me) { setBal(null); setBasis(null); return }
    const raw = await client.readContract({ address: token as Address, abi: ERC20, functionName: 'balanceOf', args: [me] }).catch(() => null)
    setBal(raw === null ? null : Number(formatUnits(raw, 18)))
    const pos = (await getTraderPositions(me).catch(() => [])).find(p => p.token === token.toLowerCase())
    if (pos && pos.bought_usdc > 0) { setBasis({ bought: pos.bought_usdc, sold: pos.sold_usdc, source: 'arcdex' }); return }
    const mine = rows.filter(r => r.maker?.toLowerCase() === me.toLowerCase())
    const bought = mine.filter(r => r.kind === 'buy').reduce((s, r) => s + r.usd, 0)
    const sold = mine.filter(r => r.kind === 'sell').reduce((s, r) => s + r.usd, 0)
    setBasis(bought > 0 ? { bought, sold, source: 'recent' } : null)
  }, [me, token, rows])

  useEffect(() => { void load() }, [load, refreshKey])

  const value = bal !== null ? bal * priceUsd : null
  useEffect(() => { onPositionUsd(value !== null && value > 0.01 ? value : null) }, [value, onPositionUsd])

  if (!me || bal === null || (bal * priceUsd < 0.01 && !basis)) return null

  const pnl = basis && value !== null ? value + basis.sold - basis.bought : null
  const pnlPct = pnl !== null && basis && basis.bought > 0 ? (pnl / basis.bought) * 100 : null
  const up = (pnl ?? 0) >= 0
  // Sold out (dust left): fomo lists it under Closed, with realized PnL.
  const closed = value !== null && value < 0.01

  async function openShare() {
    if (!me || pnlPct === null || pnl === null || !basis) return
    const profile = await getProfile(me).catch(() => null)
    const link = referralLink(me, profile)
    setShare({
      text: `${up ? 'Up' : 'Down'} ${Math.abs(pnlPct).toFixed(1)}% on $${symbol} ${up ? '🚀' : ''} Trading Arc memecoins on ARCDEX:`,
      card: {
        symbol, tokenImage: image,
        headline: `${up ? '+' : '-'}${Math.abs(pnlPct).toFixed(1)}%`,
        headlineColor: up ? '#22c55e' : '#ef4444',
        lines: [`${up ? '+' : '-'}${money(Math.abs(pnl))} PnL`, `Invested ${money(basis.bought)}`, 'on Arc · arcdex.online'],
        trader: profile?.username ? `@${profile.username}` : shortAddr(me),
        traderAddress: me,
        link,
      },
    })
  }

  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, marginTop: 16 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--adx-card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700, fontSize: '0.85rem' }}>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{T("Your position")}<span style={{ fontSize: '0.62rem', fontWeight: 700, padding: '2px 7px', borderRadius: 99, background: closed ? 'rgba(148,163,184,0.15)' : 'rgba(34,197,94,0.15)', color: closed ? 'var(--text-muted)' : 'var(--green)' }}>{closed ? T("Closed") : T("Open")}</span>
        </span>
        {pnlPct !== null && <button onClick={() => void openShare()} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: up ? 'var(--green)' : 'var(--adx-accent)', color: '#fff', fontWeight: 700, cursor: 'pointer', fontSize: '0.74rem' }}>{T("Share PnL")}</button>}
      </div>
      <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: '0.8rem' }}>
        <Stat label={T("Value")} value={value !== null ? money(value) : '—'} />
        <Stat label={T("Holding")} value={`${bal >= 1e6 ? (bal / 1e6).toFixed(2) + 'M' : bal >= 1e3 ? (bal / 1e3).toFixed(1) + 'K' : bal.toFixed(2)} ${symbol}`} />
        {basis && <Stat label={T("Invested")} value={money(basis.bought)} />}
        {pnl !== null && <Stat label={closed ? T('Realized PnL') : T('PnL')} value={`${up ? '+' : ''}${money(pnl)}${pnlPct !== null ? ` (${up ? '+' : ''}${pnlPct.toFixed(1)}%)` : ''}`} color={up ? 'var(--green)' : 'var(--red)'} />}
      </div>
      {basis?.source === 'recent' && <div style={{ padding: '0 16px 12px', fontSize: '0.68rem', color: 'var(--text-muted)' }}>{T("Cost basis from your recent trades on this pool.")}</div>}
      {share && <ShareCardModal card={share.card} text={share.text} referralsLive={info?.version === 2} onClose={() => setShare(null)} />}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.68rem', marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 700, fontFamily: 'var(--mono)', color }}>{value}</div>
    </div>
  )
}
