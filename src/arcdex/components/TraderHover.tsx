import { useRef, useState } from 'react'
import Avatar from './Avatar'
import { getFollowStats, getFollowing, getProfile, getTraderStats, socialWrite, type Profile } from '../api/social'
import { shortAddr, useTrader } from '../lib/identity'
import { t as T } from '../lib/i18n'

// Hover a trader anywhere → a mini profile card (fomo-style): picture,
// name, bio, followers/following, 7-day realized PnL, Follow button.

interface Card { profile: Profile | null; followers: number; following: number; pnl7d: number; iFollow: boolean }
const cache = new Map<string, { at: number; card: Promise<Omit<Card, 'iFollow'>> }>()

function loadCard(a: string) {
  const c = cache.get(a)
  if (c && Date.now() - c.at < 60_000) return c.card
  const card = Promise.all([getProfile(a).catch(() => null), getFollowStats(a).catch(() => ({ followers: 0, following: 0 })), getTraderStats(a, '7d').catch(() => null)])
    .then(([profile, f, s]) => ({ profile, followers: f.followers, following: f.following, pnl7d: s?.realized_pnl ?? 0 }))
  cache.set(a, { at: Date.now(), card })
  return card
}

export default function TraderHover({ address, children }: { address: string; children: React.ReactNode }) {
  const trader = useTrader()
  const a = address.toLowerCase()
  const [card, setCard] = useState<Card | null>(null)
  const [show, setShow] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const enter = () => {
    timer.current = setTimeout(async () => {
      setShow(true)
      const [base, mine] = await Promise.all([loadCard(a), trader.address ? getFollowing(trader.address).catch(() => []) : Promise.resolve([] as string[])])
      setCard({ ...base, iFollow: mine.includes(a) })
    }, 350)
  }
  const leave = () => { if (timer.current) clearTimeout(timer.current); setShow(false) }

  async function follow(e: React.MouseEvent) {
    e.stopPropagation()
    if (!card) return
    const on = card.iFollow
    setCard({ ...card, iFollow: !on, followers: card.followers + (on ? -1 : 1) })
    cache.delete(a)
    try { await socialWrite(trader, on ? 'unfollow' : 'follow', { target: a }) } catch { setCard(c => c && { ...c, iFollow: on, followers: c.followers + (on ? 1 : -1) }) }
  }

  const p = card?.profile
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} onMouseEnter={enter} onMouseLeave={leave}>
      {children}
      {show && (
        <span className="menu-pop" style={{ top: '100%', left: 0, width: 240, padding: 12, display: 'block', cursor: 'default' }} onClick={e => e.stopPropagation()}>
          <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <Avatar address={a} url={p?.avatar_url} size={40} />
            {trader.address && trader.address.toLowerCase() !== a && card && (
              <button className={`rail-follow${card.iFollow ? ' on' : ''}`} onClick={e => void follow(e)}>{card.iFollow ? T("Following") : T("Follow")}</button>
            )}
          </span>
          <span style={{ display: 'block', marginTop: 8, fontWeight: 800, fontSize: '0.9rem' }}>{p?.display_name || (p?.username ? `@${p.username}` : shortAddr(a))}</span>
          {p?.username && <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)' }}>@{p.username}</span>}
          {p?.bio && <span style={{ display: 'block', fontSize: '0.78rem', margin: '6px 0' }}>{p.bio}</span>}
          {card ? (
            <>
              <span style={{ display: 'block', fontSize: '0.74rem', color: 'var(--text-muted)', margin: '4px 0 8px' }}><b style={{ color: 'var(--text)' }}>{card.following}</b>{' '}{T("following ·")}{' '}<b style={{ color: 'var(--text)' }}>{card.followers}</b>{' '}{T("followers")}</span>
              <span style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 10px', borderRadius: 8, background: 'var(--bg-2)', fontSize: '0.74rem' }}>
                <span style={{ color: 'var(--text-muted)' }}>{T("7d PnL")}</span>
                <b className="sensitive" style={{ color: card.pnl7d >= 0 ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--mono)' }}>{card.pnl7d >= 0 ? '+' : '-'}${Math.abs(card.pnl7d).toFixed(2)}</b>
              </span>
            </>
          ) : <span style={{ display: 'block', fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 6 }}>{T("Loading…")}</span>}
        </span>
      )}
    </span>
  )
}
