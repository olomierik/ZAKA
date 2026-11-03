// Phones pick the chain from a bottom sheet (components/ChainSheet.tsx), from the top bar on every page and from the
// Trenches' own bar (2026-11-03, owner: "users can not change to other networks on mobile phones, it sticks to arc").
//   bun scripts/test-chain-sheet.tsx
import { readFileSync } from 'node:fs'
import type { ReactElement, ReactNode } from 'react'

const listeners = new Map<string, Set<() => void>>()
;(globalThis as { window?: unknown }).window = {
  addEventListener: (t: string, f: () => void) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(f) },
  removeEventListener: (t: string, f: () => void) => { listeners.get(t)?.delete(f) },
}
;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const { default: ChainSheet } = await import('../src/arcdex/components/ChainSheet')
const { CHAIN_LIST } = await import('../src/arcdex/lib/chains')

let fails = 0
const check = (ok: boolean, msg: string) => { if (!ok) fails++; console.log(ok ? '  ✓' : '  ✗', msg) }

/** The option buttons in what ChainSheet returns (the Sheet element's children), without rendering the portal. */
function options(el: ReactElement): ReactElement<{ onClick: () => void; 'aria-selected': boolean }>[] {
  const out: ReactElement<{ onClick: () => void; 'aria-selected': boolean }>[] = []
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (!n || typeof n !== 'object' || !('props' in n)) return
    const e = n as ReactElement<{ role?: string; children?: ReactNode }>
    if (e.props.role === 'option') out.push(e as never)
    walk(e.props.children)
  }
  walk(el)
  return out
}

console.log('the sheet')
{
  const picked: string[] = []
  let closed = 0
  const el = ChainSheet({ open: true, chain: 'arc', onClose: () => { closed++ }, onPick: c => { picked.push(c) } })
  const opts = options(el)
  check(opts.length === CHAIN_LIST.length, `a row for every chain (${opts.length})`)
  check(opts[0].props['aria-selected'] === true && opts.slice(1).every(o => !o.props['aria-selected']), 'the current chain is marked')

  opts[2].props.onClick()
  check(closed === 1 && picked.length === 0, 'a pick closes the sheet first, and waits for its history entry to go')
  listeners.get('popstate')?.forEach(f => f())
  check(picked.join() === CHAIN_LIST[2], `…then switches to ${CHAIN_LIST[2]} once Back has run`)

  opts[0].props.onClick()
  await new Promise(r => setTimeout(r, 400))
  check(closed === 2 && picked.length === 1, 'picking the chain already on just closes it')
}

console.log('where it opens')
{
  const css = readFileSync('src/arcdex/terminal.css', 'utf8')
  const phone = css.slice(css.indexOf('@media (max-width: 767px)'))
  const phoneBlock = phone.slice(0, phone.indexOf('\n}\n'))
  check(!/\.tm-net[^-{]*\{\s*display:\s*none/.test(phoneBlock) && !/,\s*\.tm-net\s*\{\s*display:\s*none/.test(phoneBlock), 'the top bar’s network button isn’t hidden on phones')
  const nav = readFileSync('src/arcdex/components/NavBar.tsx', 'utf8')
  check(/mobile \? setNetSheet\(true\)/.test(nav) && /<ChainSheet open=\{netSheet\}/.test(nav), 'on phones it opens the chain sheet, from every page')
  check(/!\(mobile && TRENCHES\.has\(page\.name\)\)/.test(nav), '…except on the Trenches, whose bar has its own (one button, not two)')
  const tr = readFileSync('src/arcdex/pages/Trenches.tsx', 'utf8')
  const sel = tr.slice(tr.indexOf('function ChainSelect'))
  check(/<ChainSheet /.test(sel) && !/addEventListener\('resize'/.test(sel), 'the Trenches picker uses the sheet, and nothing closes it on a resize (phones fire one as the address bar slides)')
}

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
