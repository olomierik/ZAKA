import { useEffect, useMemo, useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import Avatar from '../components/Avatar'
import ProfileEditor from '../components/ProfileEditor'
import {
  getProfile, getProfiles, getReferralPayouts, getReferralStats, getReferredUsers, triggerIndex,
  type Profile, type ReferralPayout, type ReferralStats, type ReferredUser,
} from '../api/social'
import { getCreatorRewards, LAUNCHPAD_ADDRESS, type CreatorReward } from '../api/launchpad'
import { ARC_EXPLORER } from '../api/arcRpc'
import { shortAddr, useTrader } from '../lib/identity'
import { referralLink } from '../lib/referral'
import { pct, useRouterInfo } from '../lib/routerInfo'
import { tweetUrl } from '../lib/shareCard'
import type { Page } from '../App'

// Rewards (fomo parity): total earned, this week, your /r/ link, and tabs
// for Referrals (share of your referrals' fees, paid by the swap router in
// the same transaction), Creator rewards (60% of your launchpad coins'
// creator tax) and History (every payout).

type Tab = 'referrals' | 'creator' | 'history'
const money = (n: number) => `$${n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2)}`
function ago(iso: string) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}
const USDC = '0x3600000000000000000000000000000000000000'

export default function RewardsPage({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  const me = trader.address
  const info = useRouterInfo()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [stats, setStats] = useState<ReferralStats | null>(null)
  const [payouts, setPayouts] = useState<ReferralPayout[]>([])
  const [referred, setReferred] = useState<ReferredUser[]>([])
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())
  const [creator, setCreator] = useState<CreatorReward[] | null>(null)
  const [tab, setTab] = useState<Tab>('referrals')
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!me) return
    triggerIndex()
    void getProfile(me).then(setProfile).catch(() => {})
    void getReferralStats(me).then(setStats).catch(() => {})
    void getReferralPayouts(me, 200).then(setPayouts).catch(() => {})
    void getReferredUsers(me).then(async r => {
      setReferred(r)
      if (r.length) setProfiles(await getProfiles(r.map(x => x.user_address)).catch(() => new Map()))
    }).catch(() => {})
  }, [me])
  useEffect(() => {
    if (!me || tab !== 'creator' || creator !== null) return
    void getCreatorRewards(me).then(setCreator).catch(() => setCreator([]))
  }, [me, tab, creator])

  const live = info?.version === 2
  const sharePct = info?.referralShareBps ? pct(info.referralShareBps) : '15%'
  const link = me ? referralLink(me, profile) : ''
  const usdcPayouts = payouts.filter(p => p.token.toLowerCase() === USDC)
  const weekAgo = Date.now() - 7 * 86_400_000
  const thisWeek = usdcPayouts.filter(p => Date.parse(p.block_time) >= weekAgo).reduce((s, p) => s + p.amount, 0)
  const creatorTotal = creator?.reduce((s, c) => s + c.earnedUsdc, 0) ?? 0
  const total = (stats?.earned_usdc ?? 0) + creatorTotal
  // Per referred wallet: what they've paid you.
  const byUser = useMemo(() => {
    const m = new Map<string, number>()
    usdcPayouts.forEach(p => m.set(p.user_address, (m.get(p.user_address) ?? 0) + p.amount))
    return m
  }, [usdcPayouts])

  const name = (a: string) => { const p = profiles.get(a.toLowerCase()); return p?.username ? `@${p.username}` : shortAddr(a) }

  return (
    <div className="token-page" style={{ maxWidth: 820, padding: 16 }}>
      <h2 style={{ margin: 0, fontSize: '1.4rem' }}>Rewards</h2>
      <div style={{ fontSize: '0.86rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
        Earn <b style={{ color: 'var(--text)' }}>{sharePct} of the trading fees</b> of everyone you bring to ARCDEX, in USDC, on every trade they make, for good. Launch a coin and earn 60% of its creator tax too.
      </div>

      {!live && (
        <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 10, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.35)', color: '#fcd34d', fontSize: '0.8rem' }}>
          Referral payouts switch on with the next router upgrade. Links you share now are remembered by the people who click them.
        </div>
      )}

      {!me ? (
        <div style={{ marginTop: 20 }}>
          <ConnectKitButton.Custom>{({ show }) => <button onClick={show} style={btn('var(--adx-accent)')}>Connect wallet to get your link</button>}</ConnectKitButton.Custom>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 8 }}>Or unlock your trading wallet in the right panel.</div>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginTop: 16 }}>
            <Stat label="Total earned" value={stats ? money(total) : '…'} color="var(--green)" big />
            <Stat label="This week" value={stats ? money(thisWeek) : '…'} />
            <Stat label="Traders referred" value={stats ? String(stats.referred_users) : '…'} />
          </div>

          <div style={{ marginTop: 14, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6 }}>Your referral link</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input readOnly value={link} onFocus={e => e.currentTarget.select()} style={{ flex: 1, minWidth: 220, padding: '10px 12px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: '0.84rem' }} />
              <button onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500) }} style={btn('var(--adx-accent)')}>{copied ? 'Copied ✓' : 'Copy'}</button>
              <a href={tweetUrl('Trading Arc memecoins on ARCDEX — live charts, see who’s buying, one-tap trades. Join me:', link)} target="_blank" rel="noopener noreferrer" style={{ ...btn('#000'), textDecoration: 'none', border: '1px solid #333' }}>Post on 𝕏</a>
            </div>
            {!profile?.username && (
              <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 10 }}>
                Want a short link like <span style={{ fontFamily: 'var(--mono)' }}>arcdex.online/r/yourname</span>?{' '}
                <button onClick={() => setEditing(true)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--adx-accent)', cursor: 'pointer', fontSize: '0.76rem' }}>Pick a username</button>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 4, marginTop: 18, borderBottom: '1px solid var(--adx-card-border)' }}>
            {([['referrals', `Referrals · ${sharePct}`], ['creator', 'Creator rewards'], ['history', 'History']] as [Tab, string][]).map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} style={{ padding: '8px 14px', background: 'none', border: 'none', borderBottom: `2px solid ${tab === k ? 'var(--adx-accent)' : 'transparent'}`, color: tab === k ? 'var(--text)' : 'var(--text-muted)', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer' }}>{l}</button>
            ))}
          </div>

          {tab === 'referrals' && (
            <div>
              {referred.length === 0 ? (
                <Empty>No one has joined through your link yet. Share it on 𝕏, Telegram or Discord — every trader who signs up through it pays you {sharePct} of their fees.</Empty>
              ) : referred.map(r => (
                <div key={r.user_address} className="reward-row">
                  <button onClick={() => navigate({ name: 'trader', address: r.user_address })} style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0 }}>
                    <Avatar address={r.user_address} url={profiles.get(r.user_address)?.avatar_url} size={28} />
                    <span style={{ textAlign: 'left' }}><b>{name(r.user_address)}</b><div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>joined {ago(r.block_time)}</div></span>
                  </button>
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--green)' }}>+{money(byUser.get(r.user_address) ?? 0)}</span>
                </div>
              ))}
              <div style={{ marginTop: 14, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                <b style={{ color: 'var(--text)' }}>How it works</b><br />
                1. Someone opens your link and makes their first trade on ARCDEX.<br />
                2. The swap router records you as their referrer on-chain — permanently.<br />
                3. On every trade they make after that, {sharePct} of the {info ? pct(info.feeBps) : ''} platform fee goes straight to your wallet in USDC, in the same transaction. No claiming, no minimums.
              </div>
            </div>
          )}

          {tab === 'creator' && (
            <div>
              {creator === null ? <Empty>Reading your launches from the chain…</Empty> : creator.length === 0 ? (
                <Empty>
                  You haven't launched a coin on ARCDEX yet. Launch one, set a creator tax of 0–3%, and 60% of it is paid to you in USDC on every trade — automatically.
                  {LAUNCHPAD_ADDRESS && <div style={{ marginTop: 12 }}><button onClick={() => navigate({ name: 'launchpad' })} style={btn('var(--adx-accent)')}>Launch a coin</button></div>}
                </Empty>
              ) : creator.map(c => (
                <div key={c.token} className="reward-row">
                  <button onClick={() => navigate({ name: 'token', address: c.token })} style={{ background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
                    <b>${c.symbol}</b>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>creator tax {c.creatorTaxBps / 100}% · you get {(c.creatorTaxBps * 0.6 / 100).toFixed(2)}% of volume · {c.trades} trades · {money(c.volumeUsdc)} volume{c.windowCapped ? ' (last 3 days)' : ''}</div>
                  </button>
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--green)' }}>+{money(c.earnedUsdc)}</span>
                </div>
              ))}
            </div>
          )}

          {tab === 'history' && (
            <div>
              {payouts.length === 0 ? <Empty>No payouts yet.</Empty> : payouts.map(p => (
                <div key={p.tx_hash + p.log_index} className="reward-row">
                  <span style={{ fontSize: '0.8rem' }}>Referral fee from <button onClick={() => navigate({ name: 'trader', address: p.user_address })} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--adx-accent)', cursor: 'pointer', fontWeight: 600 }}>{name(p.user_address)}</button>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}> · {ago(p.block_time)}</span></span>
                  <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span style={{ fontFamily: 'var(--mono)', color: 'var(--green)' }}>{p.token.toLowerCase() === USDC ? `+${money(p.amount)}` : `+${p.amount} ${shortAddr(p.token)}`}</span>
                    <a href={`${ARC_EXPLORER}/tx/${p.tx_hash}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)' }}>↗</a>
                  </span>
                </div>
              ))}
            </div>
          )}

          <button onClick={() => navigate({ name: 'trader', address: me })} style={{ ...btn('var(--bg-2)'), marginTop: 16 }}>View my profile</button>
        </>
      )}

      {editing && me && <ProfileEditor trader={trader} profile={profile} onSaved={setProfile} onClose={() => setEditing(false)} />}
    </div>
  )
}

function Stat({ label, value, color, big }: { label: string; value: string; color?: string; big?: boolean }) {
  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{label}</div>
      <div className="sensitive" style={{ fontSize: big ? '1.6rem' : '1.3rem', fontWeight: 800, fontFamily: 'var(--mono)', color, marginTop: 2 }}>{value}</div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem', lineHeight: 1.5 }}>{children}</div>
}

function btn(bg: string): React.CSSProperties {
  return { padding: '10px 16px', borderRadius: 8, border: '1px solid var(--adx-card-border)', background: bg, color: '#fff', fontWeight: 700, fontSize: '0.84rem', cursor: 'pointer' }
}
