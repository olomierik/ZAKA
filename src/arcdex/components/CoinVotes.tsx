import { useEffect, useState } from 'react'
import { N_, t as T } from '../lib/i18n'
import { VOTE_KINDS, applyVote, bullishPct, castVote, getVotes, myVote, votesAvailable, type VoteChain, type VoteCounts, type VoteKind } from '../lib/votes'

const EMOJI: Record<VoteKind, string> = { rocket: '🚀', fire: '🔥', poop: '💩', flag: '🚩' }
const LABEL: Record<VoteKind, string> = { rocket: N_('To the moon'), fire: N_('Hot'), poop: N_('Bad'), flag: N_('Red flag') }

/** Community sentiment on a coin, as DexScreener shows it: four reactions, one per visitor, with their counts. */
export default function CoinVotes({ chain, address }: { chain: VoteChain; address: string }) {
  const [counts, setCounts] = useState<VoteCounts | null>(null)
  const [mine, setMine] = useState<VoteKind | null>(() => myVote(chain, address))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setMine(myVote(chain, address))
    setCounts(null)
    setErr(null)
    const ctl = new AbortController()
    const read = () => void getVotes(chain, address, ctl.signal).then(c => { if (c) setCounts(c) })
    // Read at once (a tab opened in the background too), then every 30s while it's in view.
    read()
    const id = setInterval(() => { if (document.visibilityState === 'visible') read() }, 30_000)
    const onShow = () => { if (document.visibilityState === 'visible') read() }
    document.addEventListener('visibilitychange', onShow)
    return () => { ctl.abort(); clearInterval(id); document.removeEventListener('visibilitychange', onShow) }
  }, [chain, address])

  if (!votesAvailable()) return null

  const vote = async (k: VoteKind) => {
    if (busy) return
    const from = mine
    const to = from === k ? null : k
    const before = counts
    setBusy(true); setErr(null); setMine(to)
    if (counts) setCounts(applyVote(counts, from, to))
    try {
      setCounts(await castVote(chain, address, to))
    } catch (e) {
      setMine(from); setCounts(before)
      setErr(/too many/i.test(String((e as Error)?.message)) ? T('Too many votes from here, try again later') : T('Couldn’t save your vote. Try again.'))
    } finally { setBusy(false) }
  }

  const total = counts ? counts.rocket + counts.fire + counts.poop + counts.flag : 0
  const bull = counts ? bullishPct(counts) : null
  return (
    <div className="spot-panel coin-votes">
      <div className="spot-panel-h">
        <span>{T('Community sentiment')}</span>
        <small className="cv-total">{total === 1 ? T('1 vote') : T('{n} votes', { n: total.toLocaleString() })}</small>
      </div>
      <div className="cv-row" role="group" aria-label={T('Community sentiment')}>
        {VOTE_KINDS.map(k => (
          <button key={k} type="button" className={`cv-btn cv-${k}${mine === k ? ' on' : ''}`} aria-pressed={mine === k} disabled={busy}
            title={mine === k ? T('Pick again to take your vote back') : T(LABEL[k])} onClick={() => void vote(k)}>
            <span className="cv-emoji" aria-hidden>{EMOJI[k]}</span>
            <span className="cv-n">{counts ? counts[k].toLocaleString() : '—'}</span>
          </button>
        ))}
      </div>
      {bull !== null && (
        <div className="cv-bar" title={T('{pct}% of votes are 🚀 or 🔥', { pct: bull })}>
          <i style={{ width: `${bull}%` }} />
        </div>
      )}
      {err && <small className="cv-err">{err}</small>}
    </div>
  )
}
