import { useEffect, useState } from 'react'
import { parseAbi, type Address } from 'viem'
import { client } from '../api/launchpad'
import type { ArgusOnchain, ArgusTokenInfo } from '../api/argusMarket'
import type { TradeRow } from './TokenSocialTabs'
import { t as T } from '../lib/i18n'

// Plain-language risk flags for a coin — the protection fomo's users say
// they're missing ("I was exit liquidity"). Everything here is read from
// the chain or GeckoTerminal; nothing is a guess presented as fact.

const ERC20 = parseAbi(['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)'])

interface Flag { level: 'ok' | 'warn' | 'bad'; text: string }

interface Props {
  token: string
  info: ArgusTokenInfo | null
  chain: ArgusOnchain | null
  liquidityUsd: number | null
  rows: TradeRow[]
}

const fmt = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`

export default function SafetyPanel({ token, info, chain, liquidityUsd, rows }: Props) {
  const creator = chain?.creator ?? null
  const [devPct, setDevPct] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    setDevPct(null)
    if (!creator) return
    Promise.all([
      client.readContract({ address: token as Address, abi: ERC20, functionName: 'totalSupply' }),
      client.readContract({ address: token as Address, abi: ERC20, functionName: 'balanceOf', args: [creator as Address] }),
    ]).then(([supply, bal]) => { if (alive && supply > 0n) setDevPct(Number((bal * 10_000n) / supply) / 100) }).catch(() => {})
    return () => { alive = false }
  }, [token, creator])

  const flags: Flag[] = []
  if (info?.isHoneypot) flags.push({ level: 'bad', text: T('GeckoTerminal flags a honeypot risk — you may not be able to sell') })

  if (creator) {
    const devSells = rows.filter(r => r.maker?.toLowerCase() === creator.toLowerCase() && r.kind === 'sell')
    const sold = devSells.reduce((s, r) => s + r.usd, 0)
    const payout = chain?.creatorLabel === 'Creator payout wallet'
    if (sold > 0) flags.push({ level: 'bad', text: T(payout ? 'Creator payout wallet sold {usd} in recent trades' : 'Dev sold {usd} in recent trades', { usd: fmt(sold) }) })
    else if (rows.length > 0) flags.push({ level: 'ok', text: T(payout ? 'No creator payout wallet sells in the last {n} trades' : 'No dev sells in the last {n} trades', { n: rows.length }) })
    if (devPct !== null) flags.push({ level: devPct > 10 ? 'warn' : 'ok', text: T(payout ? 'Creator payout wallet holds {pct}% of supply' : 'Dev holds {pct}% of supply', { pct: devPct.toFixed(2) }) })
  }

  const buyTax = chain?.buyTaxBps, sellTax = chain?.sellTaxBps
  if (buyTax != null && sellTax != null) {
    const high = Math.max(buyTax, sellTax) >= 300
    flags.push({ level: high ? 'warn' : 'ok', text: T('Creator tax {buy}% buy · {sell}% sell', { buy: buyTax / 100, sell: sellTax / 100 }) + (high ? ' ' + T('(maximum)') : '') })
  }

  if (info?.top10Pct != null) {
    const t = info.top10Pct
    flags.push({ level: t > 50 ? 'bad' : t > 30 ? 'warn' : 'ok', text: T('Top 10 wallets hold {pct}%', { pct: t.toFixed(1) }) })
  }
  if (liquidityUsd != null && liquidityUsd > 0 && liquidityUsd < 5_000) {
    flags.push({ level: 'warn', text: T('Thin liquidity ({usd}) — trades move the price a lot', { usd: fmt(liquidityUsd) }) })
  }
  if (info?.gtScore != null && info.gtScore < 30) flags.push({ level: 'warn', text: T('Low GeckoTerminal trust score ({score}/100)', { score: info.gtScore.toFixed(0) }) })
  if (chain?.bonded) flags.push({ level: 'ok', text: T('Bonded — graduated from its launch curve') })

  if (flags.length === 0) return null
  const color = { ok: '#22c55e', warn: '#f59e0b', bad: '#ef4444' }
  const bad = flags.filter(f => f.level === 'bad').length, warn = flags.filter(f => f.level === 'warn').length

  return (
    <div style={{ background: 'var(--adx-card-bg)', border: `1px solid ${bad ? 'rgba(239,68,68,0.4)' : 'var(--adx-card-border)'}`, borderRadius: 12, marginTop: 16 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--adx-card-border)', display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '0.85rem' }}>
        <span>{T("Safety check")}</span>
        <span style={{ fontSize: '0.72rem', color: bad ? color.bad : warn ? color.warn : color.ok }}>
          {bad ? T(bad > 1 ? '{n} red flags' : '{n} red flag', { n: bad }) : warn ? T(warn > 1 ? '{n} cautions' : '{n} caution', { n: warn }) : T("Looks clean")}
        </span>
      </div>
      <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 7 }}>
        {flags.sort((a, b) => ({ bad: 0, warn: 1, ok: 2 }[a.level] - { bad: 0, warn: 1, ok: 2 }[b.level])).map(f => (
          <div key={f.text} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: '0.78rem' }}>
            <span style={{ color: color[f.level], fontWeight: 800, width: 12, flexShrink: 0 }}>{f.level === 'ok' ? '✓' : '!'}</span>
            <span>{f.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
