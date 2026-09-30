import { useEffect, useState } from 'react'
import { renderCard, tweetUrl, type CardData } from '../lib/shareCard'
import { t as T } from '../lib/i18n'

// Preview + share actions for a card image: a trade card (`card`), or any
// other card drawn by `render` (a bot's P&L card). On phones "Share" hands the
// image straight to WhatsApp/Telegram/X via the system share sheet.

type Props = {
  text: string
  onClose: () => void
  referralsLive?: boolean
  title?: string
} & ({ card: CardData; render?: undefined; fileName?: undefined; link?: undefined } | { card?: undefined; render: () => Promise<Blob>; fileName: string; link: string })

export default function ShareCardModal(props: Props) {
  const { text, onClose, referralsLive = false } = props
  const link = props.card ? props.card.link : props.link
  const fileName = props.card ? `arcdex-${props.card.symbol}.png` : props.fileName
  const [blob, setBlob] = useState<Blob | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    let objectUrl: string | null = null
    const draw = props.card ? renderCard(props.card) : props.render()
    draw.then(b => {
      if (!alive) return
      objectUrl = URL.createObjectURL(b)
      setBlob(b); setUrl(objectUrl)
    }).catch(e => alive && setErr(e instanceof Error ? e.message : T("Could not render card")))
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.card, props.render])

  const file = blob ? new File([blob], fileName, { type: 'image/png' }) : null
  const canNativeShare = !!file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })

  const download = () => {
    if (!url) return
    const a = document.createElement('a')
    a.href = url; a.download = fileName; a.click()
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(640px, 100%)', background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 14, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <b>{props.title ?? T("Share your trade")}</b>
          <button onClick={onClose} aria-label={T('Close')} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.1rem' }}>✕</button>
        </div>
        {url ? <img src={url} alt={T("Trade card")} style={{ width: '100%', borderRadius: 10, display: 'block' }} />
          : <div style={{ aspectRatio: '1200 / 630', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', background: 'var(--bg-2)', borderRadius: 10 }}>{err || T("Rendering…")}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {canNativeShare && (
            <button onClick={() => void navigator.share({ files: [file!], text: `${text} ${link}` }).catch(() => {})} style={btn('var(--adx-accent)')}>{T("Share…")}</button>
          )}
          <a href={tweetUrl(text, link)} target="_blank" rel="noopener noreferrer" style={{ ...btn('#000'), textDecoration: 'none', border: '1px solid #333' }}>{T("Post on X")}</a>
          <button onClick={download} disabled={!url} style={btn('var(--bg-2)')}>{T("Download image")}</button>
          <button onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true) }} style={btn('var(--bg-2)')}>{copied ? T("Link copied ✓") : props.card ? T("Copy my referral link") : T('Copy link')}</button>
        </div>
        {referralsLive && (
          <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '10px 0 0' }}>{T("Anyone who starts trading through your link earns you 15% of their trading fees in USDC — paid automatically on every trade.")}</p>
        )}
      </div>
    </div>
  )
}

function btn(bg: string): React.CSSProperties {
  return { padding: '9px 14px', borderRadius: 8, border: '1px solid var(--adx-card-border)', background: bg, color: '#fff', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer' }
}
