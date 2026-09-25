import { useState } from 'react'
import { ARC_EXPLORER } from '../api/arcRpc'
import type { ArgusOnchain, ArgusPool, ArgusTokenInfo } from '../api/argusMarket'
import { Who, type TradeRow } from './TokenSocialTabs'
import type { Profile } from '../api/social'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

// fomo's "About" card: description, 5M/1H/6H/24H changes, buys vs sells,
// buy vs sell volume, buyers vs sellers, links, and "View more" details.

const fmt = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(2)
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
function ago(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  return s < 3600 ? T('{n} min ago', { n: Math.floor(s / 60) }) : s < 86400 ? T('{n} hours ago', { n: Math.floor(s / 3600) }) : T('{n} days ago', { n: Math.floor(s / 86400) })
}

function Bar({ left, right, leftLabel, rightLabel }: { left: number; right: number; leftLabel: string; rightLabel: string }) {
  const total = left + right || 1
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', marginBottom: 4 }}><span><b>{leftLabel}</b></span><span><b>{rightLabel}</b></span></div>
      <div style={{ display: 'flex', gap: 3, height: 5 }}>
        <div style={{ flex: left / total || 0.001, background: 'var(--green)', borderRadius: 3 }} />
        <div style={{ flex: right / total || 0.001, background: '#f97316', borderRadius: 3 }} />
      </div>
    </div>
  )
}

export default function AboutPanel({ address, symbol, info, pool, chain, rows, supply, profiles, navigate }: {
  address: string; symbol: string; info: ArgusTokenInfo | null; pool: ArgusPool | null; chain: ArgusOnchain | null
  rows: TradeRow[]; supply: number | null; profiles: Map<string, Profile>; navigate: (p: Page) => void
}) {
  const [more, setMore] = useState(false)
  const [copied, setCopied] = useState(false)
  const buyVol = rows.filter(r => r.kind === 'buy').reduce((s, r) => s + r.usd, 0)
  const sellVol = rows.filter(r => r.kind === 'sell').reduce((s, r) => s + r.usd, 0)
  const buyers = new Set(rows.filter(r => r.kind === 'buy' && r.maker).map(r => r.maker!.toLowerCase())).size
  const sellers = new Set(rows.filter(r => r.kind === 'sell' && r.maker).map(r => r.maker!.toLowerCase())).size
  const changes: [string, number | undefined][] = [['5M', pool?.change.m5], ['1H', pool?.change.h1], ['6H', pool?.change.h6], ['24H', pool?.change.h24]]
  const link = (href: string, label: string) => /^https?:\/\//i.test(href)
    ? <a key={href} href={href} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 7, fontSize: '0.74rem', border: '1px solid var(--adx-card-border)', color: 'var(--text)', textDecoration: 'none', background: 'var(--bg-2)' }}>{label}</a> : null
  const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return T('Website') } }
  const row = (k: string, v: React.ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: '0.78rem', padding: '5px 0', borderBottom: '1px dashed rgba(255,255,255,0.06)' }}><span style={{ color: 'var(--text-muted)' }}>{k}</span><span style={{ textAlign: 'right' }}>{v}</span></div>
  )

  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, marginTop: 16, padding: 14 }}>
      <div style={{ fontWeight: 800, fontSize: '0.9rem' }}>{T("About")}{' '}{symbol}</div>
      {info?.description && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5, margin: '6px 0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: more ? undefined : 60, overflow: 'hidden' }}>{info.description}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, margin: '8px 0 12px' }}>
        {changes.map(([k, v]) => (
          <div key={k} style={{ textAlign: 'center', padding: '6px 0', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)' }}>
            <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{k}</div>
            <div style={{ fontSize: '0.74rem', fontWeight: 700, color: (v ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{v == null ? '—' : `${v >= 0 ? '▲' : '▼'}${Math.abs(v).toFixed(2)}%`}</div>
          </div>
        ))}
      </div>
      {pool && <Bar left={pool.txns24h.buys} right={pool.txns24h.sells} leftLabel={T('{n} buys', { n: pool.txns24h.buys.toLocaleString() })} rightLabel={T('{n} sells', { n: pool.txns24h.sells.toLocaleString() })} />}
      {rows.length > 0 && <Bar left={buyVol} right={sellVol} leftLabel={T('{v} vol.', { v: '$' + fmt(buyVol) })} rightLabel={T('{v} vol.', { v: '$' + fmt(sellVol) })} />}
      {rows.length > 0 && <Bar left={buyers} right={sellers} leftLabel={T('{n} buyers', { n: buyers })} rightLabel={T('{n} sellers', { n: sellers })} />}
      {rows.length > 0 && <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', marginTop: -4, marginBottom: 8 }}>{T("Volume and wallets from the last")}{' '}{rows.length}{' '}{T("trades.")}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {info?.websites.filter((w, i, all) => all.findIndex(x => host(x) === host(w)) === i).map(w => link(w, `🌐 ${host(w)}`))}
        {info?.twitter && link(`https://x.com/${info.twitter}`, '𝕏 Twitter')}
        {info?.telegram && link(`https://t.me/${info.telegram}`, 'Telegram')}
        {info?.discord && link(info.discord, 'Discord')}
        {link(`https://x.com/search?q=${encodeURIComponent(`${address} OR $${symbol}`)}`, T('Search on 𝕏'))}
      </div>
      {more && (
        <div style={{ marginTop: 12 }}>
          {row(T('Launchpad'), chain?.portal ? `Argus · Portal ${chain.portal}` : pool?.dex === 'argus' ? 'Argus' : pool?.dex ?? '—')}
          {row(T('Supply'), supply ? fmt(supply) : '—')}
          {row(T('Network'), 'Arc')}
          {row(T('Created'), pool?.createdAt ? ago(pool.createdAt) : '—')}
          {row(T('Contract address'), <span style={{ display: 'inline-flex', gap: 6 }}><a href={`${ARC_EXPLORER}/token/${address}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--adx-accent)', fontFamily: 'var(--mono)' }}>{short(address)}</a><button onClick={() => { void navigator.clipboard?.writeText(address); setCopied(true) }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}>{copied ? '✓' : '⧉'}</button></span>)}
          {pool && row(T('Pool'), <span style={{ fontFamily: 'var(--mono)' }} title={pool.pool}>{short(pool.pool)}</span>)}
          {chain?.creator && row(T(chain.creatorLabel), <Who address={chain.creator} profiles={profiles} navigate={navigate} />)}
          {chain?.hook && row(T('Hook'), <a href={`${ARC_EXPLORER}/address/${chain.hook}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--adx-accent)', fontFamily: 'var(--mono)' }}>{short(chain.hook)}</a>)}
          {chain?.buyTaxBps != null && row(T('Creator tax'), T('{buy}% buy · {sell}% sell', { buy: chain.buyTaxBps / 100, sell: (chain.sellTaxBps ?? 0) / 100 }))}
          {row(T('Bonded'), chain?.bonded == null ? '—' : chain.bonded ? T('Yes — graduated') : T('Not yet'))}
          {info?.gtScore != null && row(T('GT score'), `${info.gtScore.toFixed(0)} / 100`)}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {link(`https://argus.world/token/${address}`, 'argus.world')}
            {pool && link(`https://www.geckoterminal.com/arc/pools/${pool.pool}`, 'GeckoTerminal')}
            {link(`${ARC_EXPLORER}/token/${address}`, T('Explorer'))}
          </div>
        </div>
      )}
      <div style={{ textAlign: 'center', marginTop: 10 }}>
        <button onClick={() => setMore(m => !m)} style={{ background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text-muted)', borderRadius: 7, padding: '4px 12px', fontSize: '0.72rem', cursor: 'pointer' }}>{more ? T("View less") : T("View more")}</button>
      </div>
    </div>
  )
}
