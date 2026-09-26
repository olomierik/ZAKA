// The launchpad's search, as on Argus: press ⌘K (Ctrl K) or click it, type a
// name, a ticker (with or without the $) or an address, and up to eight
// matches drop down. The arrow keys move through them and Enter opens one;
// "View all matches" (or Enter with none picked) shows every match in the
// list below, which filters as you type. Escape closes it.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LaunchpadToken } from '../api/launchpad'
import { normQuery, searchCoins } from '../lib/coinSearch'
import { pctText } from '../lib/spark'
import { t as T } from '../lib/i18n'

const MAX = 8
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
const usd = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`

interface Props {
  coins: LaunchpadToken[]
  value: string
  onChange: (q: string) => void
  onOpen: (t: LaunchpadToken) => void
  /** Show every match in the list. */
  onViewAll: () => void
}

export default function CoinSearch({ coins, value, onChange, onOpen, onViewAll }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const all = useMemo(() => searchCoins(coins, value, t => t.priceUsd), [coins, value])
  const top = all.slice(0, MAX)
  const rows = top.length + (all.length ? 1 : 0) // the matches, then "View all"
  const q = normQuery(value)

  // ⌘K / Ctrl K from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        input.current?.focus()
        input.current?.select()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const show = open && !!q
  // The panel hangs from the box's left edge, or its right one when there's
  // no room to the right.
  useLayoutEffect(() => {
    const box = input.current?.getBoundingClientRect(), el = panel.current
    if (show && box && el) el.classList.toggle('flip', box.left + el.offsetWidth > window.innerWidth - 8)
  }, [show])

  const close = () => { setOpen(false); setActive(-1) }
  const pick = (t: LaunchpadToken) => { close(); input.current?.blur(); onOpen(t) }
  const viewAll = () => { close(); input.current?.blur(); onViewAll() }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows) return
      e.preventDefault()
      setOpen(true)
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive(a => (a < 0 ? (step > 0 ? 0 : rows - 1) : (a + step + rows) % rows))
    } else if (e.key === 'Enter') {
      if (!q) return
      e.preventDefault()
      if (active >= 0 && active < top.length) pick(top[active])
      else if (active < 0 && all.length === 1) pick(all[0]) // one match (a full address): open it
      else viewAll()
    } else if (e.key === 'Escape') {
      close()
      input.current?.blur()
    }
  }

  return (
    <div className="cs">
      <input ref={input} className="lp-search" value={value} placeholder={T('🔍 Name, ticker or address')}
        role="combobox" aria-expanded={show} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={show && active >= 0 ? `${listId}-${active}` : undefined}
        onChange={e => { onChange(e.target.value); setOpen(true); setActive(-1) }}
        onFocus={() => setOpen(true)} onBlur={close} onKeyDown={onKeyDown} />
      {!value && <kbd className="cs-kbd" aria-hidden="true">{MAC ? '⌘K' : 'Ctrl K'}</kbd>}
      {show && (
        <div ref={panel} className="cs-panel" role="listbox" id={listId} onMouseDown={e => e.preventDefault()}>
          {top.length === 0 && (
            <div className="cs-empty">{T('No coin matches "{q}". Check the spelling, or paste its full contract address.', { q: value.trim() })}</div>
          )}
          {top.map((t, i) => {
            const chg = t.stats?.change24
            return (
              <div key={t.address} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                className={`cs-item${i === active ? ' on' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => pick(t)}>
                <span className="cs-img">
                  {t.metadata?.image ? <img src={t.metadata.image} alt="" loading="lazy" /> : t.symbol.slice(0, 1)}
                </span>
                <span className="cs-main">
                  <b>${t.symbol}{t.curve.graduated && <em>{T('✓ Graduated')}</em>}</b>
                  <small>{t.name} · {t.address.slice(0, 6)}…{t.address.slice(-4)}</small>
                </span>
                <span className="cs-side">
                  <b>{usd(t.priceUsd * 1e9)}</b>
                  {chg !== undefined && <small className={chg > 0.05 ? 'up' : chg < -0.05 ? 'down' : ''}>{pctText(chg)}</small>}
                </span>
              </div>
            )
          })}
          {all.length > 0 && (
            <div id={`${listId}-${top.length}`} role="option" aria-selected={active === top.length}
              className={`cs-all${active === top.length ? ' on' : ''}`} onMouseEnter={() => setActive(top.length)} onClick={viewAll}>
              {T('View all {n} matches', { n: all.length })}
            </div>
          )}
          <div className="cs-hint">{T('↑↓ to move · Enter to open · Esc to close')}</div>
        </div>
      )}
    </div>
  )
}
