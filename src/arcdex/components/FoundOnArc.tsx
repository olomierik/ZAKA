// Under the Terminal's list while its search box has text: coins from all of
// Arc (lib/coinFinder.ts: the engine, GeckoTerminal, the chain) that the list
// isn't showing, so a name or a pasted contract address always finds its coin.

import { useMemo } from 'react'
import Avatar from './Avatar'
import { useCoinFinder } from '../lib/coinFinder'
import { shortAddr } from '../lib/identity'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'

const money = (n: number | null) => n == null ? '—' : `$${n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2)}`
const NONE: never[] = []

export default function FoundOnArc({ query, shown, navigate }: { query: string; shown: Set<string>; navigate: (p: Page) => void }) {
  const { results, searching, noToken, notLaunchpad } = useCoinFinder(query, NONE, 12)
  const extra = useMemo(() => results.filter(c => !shown.has(c.address)), [results, shown])
  if (query.trim().length < 2 || (!searching && !extra.length && !noToken && !notLaunchpad)) return null
  return (
    <div className="found-arc">
      <div className="found-arc-h">{T('More on Arc')} <span>{T('coins not in this list')}</span></div>
      {searching && !extra.length && <div className="found-arc-note">{T('Searching all of Arc…')}</div>}
      {noToken && <div className="found-arc-note">{T('No token at this address on Arc.')}</div>}
      {notLaunchpad && <div className="found-arc-note">{T('This token wasn’t launched on a launchpad, so ARCDEX doesn’t list it: coins from unknown contracts can be malicious.')}</div>}
      {extra.map(c => (
        <button key={c.address} className="found-arc-row" onClick={() => navigate({ name: 'argus', address: c.address, pool: c.pool ?? '' })}>
          {c.image ? <img src={c.image} alt="" width={28} height={28} style={{ borderRadius: '50%', flexShrink: 0 }} /> : <Avatar address={c.address} size={28} />}
          <span className="found-arc-name">
            <b>{c.symbol}</b> <span>{c.name !== c.symbol ? c.name : ''}</span>
            <small>{shortAddr(c.address)}{c.launchpad ? ` · ${c.launchpad}` : ''}</small>
          </span>
          <span className="found-arc-mc">{c.marketCapUsd != null ? `${T('MC')} ${money(c.marketCapUsd)}` : c.source === 'chain' ? T('not listed yet') : ''}</span>
        </button>
      ))}
    </div>
  )
}
