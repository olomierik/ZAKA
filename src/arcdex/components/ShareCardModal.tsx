import { useEffect, useState } from 'react'
import { renderCard, tweetUrl, type CardData } from '../lib/shareCard'

// Preview + share actions for a trade card. On phones "Share" hands the
// image straight to WhatsApp/Telegram/X via the system share sheet.

export default function ShareCardModal({ card, text, referralsLive = false, onClose }: { card: CardData; text: string; referralsLive?: boolean; onClose: () => void }) {
  const [blob, setBlob] = useState<Blob | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    let objectUrl: string | null = null
    renderCard(card).then(b => {
      if (!alive) return
      objectUrl = URL.createObjectURL(b)
      setBlob(b); setUrl(objectUrl)
    }).catch(e => alive && setErr(e instanceof Error ? e.message : 'Could not render card'))
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [card])

  const file = blob ? new File([blob], `arcdex-${card.symbol}.png`, { type: 'image/png' }) : null
  const canNativeShare = !!file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })

  const download = () => {
    if (!url) return
    const a = document.createElement('a')
    a.href = url; a.download = `arcdex-${card.symbol}.png`; a.click()
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(640px, 100%)', background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 14, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <b>Share your trade</b>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.1rem' }}>✕</button>
        </div>
        {url ? <img src={url} alt="Trade card" style={{ width: '100%', borderRadius: 10, display: 'block' }} />
          : <div style={{ aspectRatio: '1200 / 630', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', background: 'var(--bg-2)', borderRadius: 10 }}>{err || 'Rendering…'}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {canNativeShare && (
            <button onClick={() => void navigator.share({ files: [file!], text: `${text} ${card.link}` }).catch(() => {})} style={btn('var(--adx-accent)')}>Share…</button>
          )}
          <a href={tweetUrl(text, card.link)} target="_blank" rel="noopener noreferrer" style={{ ...btn('#000'), textDecoration: 'none', border: '1px solid #333' }}>Post on X</a>
          <button onClick={download} disabled={!url} style={btn('var(--bg-2)')}>Download image</button>
          <button onClick={() => { void navigator.clipboard?.writeText(card.link); setCopied(true) }} style={btn('var(--bg-2)')}>{copied ? 'Link copied ✓' : 'Copy my referral link'}</button>
        </div>
        {referralsLive && (
          <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '10px 0 0' }}>
            Anyone who starts trading through your link earns you 15% of their trading fees in USDC — paid automatically on every trade.
          </p>
        )}
      </div>
    </div>
  )
}

function btn(bg: string): React.CSSProperties {
  return { padding: '9px 14px', borderRadius: 8, border: '1px solid var(--adx-card-border)', background: bg, color: '#fff', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer' }
}
