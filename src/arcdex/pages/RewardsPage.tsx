import { useEffect, useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import ProfileEditor from '../components/ProfileEditor'
import { getProfile, getReferralStats, triggerIndex, type Profile, type ReferralStats } from '../api/social'
import { useTrader } from '../lib/identity'
import { referralLink } from '../lib/referral'
import { pct, useRouterInfo } from '../lib/routerInfo'
import { tweetUrl } from '../lib/shareCard'
import type { Page } from '../App'

// Invite & earn: every trader you bring pays you a share of their trading
// fees in USDC, on every trade, forever — enforced by the swap router.

export default function RewardsPage({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  const me = trader.address
  const info = useRouterInfo()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [stats, setStats] = useState<ReferralStats | null>(null)
  const [editing, setEditing] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!me) return
    triggerIndex()
    void getProfile(me).then(setProfile).catch(() => {})
    void getReferralStats(me).then(setStats).catch(() => {})
  }, [me])

  const live = info?.version === 2
  const sharePct = info?.referralShareBps ? pct(info.referralShareBps) : '15%'
  const link = me ? referralLink(me, profile) : ''

  return (
    <div className="token-page" style={{ maxWidth: 760 }}>
      <h2 style={{ margin: 0, fontSize: '1.4rem' }}>Invite & earn</h2>
      <div style={{ fontSize: '0.86rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
        Share your link. When someone starts trading on ARCDEX through it, you earn <b style={{ color: 'var(--text)' }}>{sharePct} of their trading fees</b> in USDC — sent to your wallet automatically on every trade they make, for good.
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
          <div style={{ marginTop: 18, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: 16 }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6 }}>Your invite link</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input readOnly value={link} onFocus={e => e.currentTarget.select()} style={{ flex: 1, minWidth: 220, padding: '10px 12px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: '0.84rem' }} />
              <button onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true) }} style={btn('var(--adx-accent)')}>{copied ? 'Copied ✓' : 'Copy'}</button>
              <a href={tweetUrl('Trading Arc memecoins on ARCDEX — live charts, see who’s buying, one-tap trades. Join me:', link)} target="_blank" rel="noopener noreferrer" style={{ ...btn('#000'), textDecoration: 'none', border: '1px solid #333' }}>Post on X</a>
            </div>
            {!profile?.username && (
              <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 10 }}>
                Want a short link like <span style={{ fontFamily: 'var(--mono)' }}>arcdex.online/?ref=yourname</span>?{' '}
                <button onClick={() => setEditing(true)} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--adx-accent)', cursor: 'pointer', fontSize: '0.76rem' }}>Pick a username</button>
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginTop: 14 }}>
            <Stat label="Traders you referred" value={stats ? String(stats.referred_users) : '…'} />
            <Stat label="Earned (USDC)" value={stats ? `$${stats.earned_usdc.toFixed(2)}` : '…'} color="var(--green)" />
            <Stat label="Payouts" value={stats ? String(stats.payouts) : '…'} />
          </div>

          <div style={{ marginTop: 18, fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            <b style={{ color: 'var(--text)' }}>How it works</b><br />
            1. Someone opens your link and makes their first trade on ARCDEX.<br />
            2. The swap router records you as their referrer on-chain — permanently.<br />
            3. On every trade they make after that, {sharePct} of the {info ? pct(info.feeBps) : ''} platform fee goes straight to your wallet in USDC, in the same transaction. No claiming, no minimums.
          </div>

          <button onClick={() => navigate({ name: 'trader', address: me })} style={{ ...btn('var(--bg-2)'), marginTop: 16 }}>View my profile</button>
        </>
      )}

      {editing && me && <ProfileEditor trader={trader} profile={profile} onSaved={setProfile} onClose={() => setEditing(false)} />}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '1.3rem', fontWeight: 800, fontFamily: 'var(--mono)', color, marginTop: 2 }}>{value}</div>
    </div>
  )
}

function btn(bg: string): React.CSSProperties {
  return { padding: '10px 16px', borderRadius: 8, border: '1px solid var(--adx-card-border)', background: bg, color: '#fff', fontWeight: 700, fontSize: '0.84rem', cursor: 'pointer' }
}
