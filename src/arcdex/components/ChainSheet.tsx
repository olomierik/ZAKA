// Phones: the chain picker as a bottom sheet (2026-11-03, owner: "users can not change to other networks on mobile
// phones, it sticks to arc"). The top bar's network menu was hidden on phones, so outside the Trenches nothing changed
// the chain; and the Trenches' own small menu closed on any window resize, which phones fire whenever the address bar
// slides in or out, so a tap could close it before the pick landed. A sheet has big rows, isn't clipped by the bar's
// sideways scroll, and only closes on a tap outside, Back or Esc.

import Sheet, { afterSheetClose } from './Sheet'
import ChainLogo from './ChainLogo'
import { CHAINS, CHAIN_LIST, type TChain } from '../lib/chains'
import { t as T } from '../lib/i18n'

export default function ChainSheet({ open, chain, onClose, onPick }: { open: boolean; chain: TChain; onClose: () => void; onPick: (c: TChain) => void }) {
  // The sheet keeps a history entry while open: navigate only once it has stepped back over it.
  const pick = (c: TChain) => { onClose(); if (c !== chain) afterSheetClose(() => onPick(c)) }
  return (
    <Sheet open={open} onClose={onClose} title={T('Chains')}>
      <div className="chain-sheet" role="listbox" aria-label={T('Chain')}>
        {CHAIN_LIST.map(c => (
          <button key={c} role="option" aria-selected={c === chain} className={c === chain ? 'on' : ''} onClick={() => pick(c)}>
            <ChainLogo chain={c} size={26} />
            <span className="chain-sheet-name">{CHAINS[c].name}<small>{CHAINS[c].native}</small></span>
            {c === chain && <b aria-hidden>✓</b>}
          </button>
        ))}
      </div>
    </Sheet>
  )
}
