// /sense — $SENSE buyback-and-burn and liquidity (owner, 2026-10-03): 30% of ARCSENSE's fees buy
// back $SENSE and burn it, 70% go to liquidity pools. Everything here is read from the fee
// wallet on Arc by the engine (engine/src/sense/program.ts): fees in, buybacks, burns, liquidity
// added, and what's still owed. Anyone can check each transaction on the explorer.
//
// With the fee wallet connected, the owner's controls: buy $SENSE (its coin page) and burn the
// $SENSE the wallet holds (a transfer to 0x…dEaD). The ledger counts both by itself.

import { useEffect, useState } from 'react'
import { erc20Abi, formatUnits, type Address } from 'viem'
import { client } from '../api/launchpad'
import { engineApiUrl } from '../api/marketStream'
import { useTrader } from '../lib/identity'
import { t as T } from '../lib/i18n'
import { ARC_EXPLORER, FEE_WALLET } from '../lib/platform'
import { sendArc, txErrorText } from '../lib/tx'
import { waitForReceipt } from '../lib/receipts'
import { notifyBalances } from '../lib/balances'
import type { SenseEntry, SenseProgramView } from '../../../engine/src/sense/shared'
import type { Page } from '../App'

const SENSE = '0x91402b32C4Ab7915132b8B24e0d084E0428667ED'
const SENSE_POOL = '0x879394cd067942b06d9e15aa58420729b30944901bf107b5f7779a8c5c9de047'
const DEAD = '0x000000000000000000000000000000000000dEaD'

const usd = (n: number | null | undefined) => (n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const big = (n: number | null | undefined) => (n == null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0))
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : '—')

/** The ledger from the engine, every 15 seconds. */
export function useSenseProgram(): SenseProgramView | null | 'down' {
  const [v, setV] = useState<SenseProgramView | null | 'down'>(null)
  useEffect(() => {
    if (!engineApiUrl) { setV('down'); return }
    let alive = true
    const load = () => fetch(`${engineApiUrl}/v1/sense/program`, { signal: AbortSignal.timeout(10_000) })
      .then(r => (r.ok ? r.json() : null)).then((x: SenseProgramView | null) => { if (alive) setV(x ?? 'down') })
      .catch(() => { if (alive) setV(prev => prev ?? 'down') })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 15_000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return v
}

export const ACTION_LABEL: Record<SenseEntry['kind'], string> = {
  fee: 'Fee in', buyback: 'Bought back', burn: 'Burned', liquidity: 'Liquidity added', unliquidity: 'Liquidity removed',
}

function Progress({ done, owed }: { done: number; owed: number }) {
  const pct = owed > 0 ? Math.min(100, (done / owed) * 100) : done > 0 ? 100 : 0
  return <div className="sense-bar"><span style={{ width: `${pct}%` }} /></div>
}

export default function SensePage({ navigate }: { navigate: (p: Page) => void }) {
  const p = useSenseProgram()
  const trader = useTrader()
  const isFeeWallet = trader.address?.toLowerCase() === FEE_WALLET
  const [held, setHeld] = useState<bigint | null>(null)
  const [burning, setBurning] = useState<'' | 'confirm' | 'sending' | { done: string } | { error: string }>('')

  useEffect(() => {
    if (!isFeeWallet || !trader.address) return
    let alive = true
    const read = () => client.readContract({ address: SENSE, abi: erc20Abi, functionName: 'balanceOf', args: [trader.address as Address] })
      .then(b => { if (alive) setHeld(b) }).catch(() => {})
    void read()
    const id = setInterval(read, 15_000)
    return () => { alive = false; clearInterval(id) }
  }, [isFeeWallet, trader.address])

  async function burnAll() {
    if (!held || held === 0n) return
    setBurning('sending')
    try {
      const hash = await sendArc(trader.kind, { address: SENSE, abi: erc20Abi, functionName: 'transfer', args: [DEAD, held] })
      await waitForReceipt(hash)
      notifyBalances()
      setHeld(0n)
      setBurning({ done: hash })
    } catch (e) {
      setBurning({ error: txErrorText(e) })
    }
  }

  const v = p && p !== 'down' ? p : null
  const tt = v?.totals
  return (
    <div className="token-page content-page sense-page">
      <h2 className="page-h">🔥 {T('$SENSE buyback & burn')}</h2>
      <p className="sense-lead">
        {T('Of the fees ARCSENSE collects, 30% buy back $SENSE and burn it, and 70% go to liquidity pools. Every number below is read from the fee wallet on Arc, so anyone can check it.')}
      </p>

      {p === 'down' && <div className="sense-note">{T('The ledger can’t be reached right now. Try again in a moment.')}</div>}
      {v && !v.program.started && <div className="sense-note">{T('The program starts {date}. From then on, every fee counts.', { date: new Date(v.program.since).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }) })}</div>}

      <div className="sense-grid">
        <div className="sense-card">
          <span>{T('Fees collected')}</span>
          <b>{usd(tt?.feesUsd)}</b>
          <small>{v ? T('since {date}', { date: new Date(v.program.since).toLocaleDateString() }) : ''}</small>
        </div>
        <div className="sense-card">
          <span>{T('Bought back (30%)')}</span>
          <b>{usd(tt?.buybackUsd)} <small>/ {usd(tt?.buybackOwedUsd)}</small></b>
          {tt && <Progress done={tt.buybackUsd} owed={tt.buybackOwedUsd} />}
          <small>{v?.pending.buybackUsd ? `${usd(v.pending.buybackUsd)} ${T('still to buy')}` : T('Up to date')}</small>
        </div>
        <div className="sense-card">
          <span>{T('$SENSE burned')}</span>
          <b>{big(tt?.senseBurned)}</b>
          <small>{T('In total at the dead address')}: {big(tt?.deadBalance)}</small>
        </div>
        <div className="sense-card">
          <span>{T('Added to liquidity (70%)')}</span>
          <b>{usd(tt?.liquidityUsd)} <small>/ {usd(tt?.liquidityOwedUsd)}</small></b>
          {tt && <Progress done={tt.liquidityUsd} owed={tt.liquidityOwedUsd} />}
          <small>{v?.pending.liquidityUsd ? `${usd(v.pending.liquidityUsd)} ${T('still to add')}` : T('Up to date')}</small>
        </div>
      </div>

      {isFeeWallet && (
        <div className="sense-owner">
          <b>{T('Fee wallet connected')}</b>
          <div className="sense-steps">
            <div>
              <span>1. {T('Buy back')}</span>
              <small>{v?.pending.buybackUsd ? `${usd(v.pending.buybackUsd)} ${T('to buy now')}` : T('Nothing owed right now')}</small>
              <button className="btn-primary" onClick={() => navigate({ name: 'argus', address: SENSE.toLowerCase(), pool: SENSE_POOL })}>{T('Buy $SENSE')} →</button>
            </div>
            <div>
              <span>2. {T('Burn')}</span>
              <small>{T('This wallet holds')} {held == null ? '…' : big(Number(formatUnits(held, 18)))} $SENSE</small>
              {burning === 'confirm' ? (
                <span className="sense-confirm">
                  <button className="btn-danger" onClick={() => void burnAll()}>{T('Yes, burn it all')}</button>
                  <button className="btn-ghost" onClick={() => setBurning('')}>{T('Cancel')}</button>
                </span>
              ) : (
                <button className="btn-primary" disabled={!held || burning === 'sending'} onClick={() => setBurning('confirm')}>
                  {burning === 'sending' ? T('Burning…') : T('Burn all $SENSE in this wallet')}
                </button>
              )}
              {typeof burning === 'object' && 'done' in burning && <small className="sense-ok">✓ {T('Burned. The ledger shows it within a minute.')}</small>}
              {typeof burning === 'object' && 'error' in burning && <small className="sense-bad">⚠ {burning.error}</small>}
            </div>
            <div>
              <span>3. {T('Add liquidity')}</span>
              <small>{v?.pending.liquidityUsd ? `${usd(v.pending.liquidityUsd)} ${T('to add')}` : T('Nothing owed right now')}</small>
              <small>{T('Add it from this wallet to a pool (or to the futures pool on mainnet); the ledger counts it by itself.')}</small>
            </div>
          </div>
        </div>
      )}

      <h3 className="sense-h">{T('Buybacks, burns and liquidity')}</h3>
      {!v ? <div className="sense-note">{T('Loading…')}</div> : !v.actions.length ? (
        <div className="sense-note">{T('Nothing yet: the first buyback and burn will show here.')}</div>
      ) : (
        <div className="fx-table-wrap">
          <table className="fx-table">
            <thead><tr><th>{T('Time')}</th><th>{T('Event')}</th><th>{T('Value')}</th><th>$SENSE</th><th /></tr></thead>
            <tbody>
              {v.actions.map(a => (
                <tr key={`${a.tx}:${a.kind}`}>
                  <td><small>{when(a.at)}</small></td>
                  <td>{T(ACTION_LABEL[a.kind])}</td>
                  <td>{usd(a.usd)}</td>
                  <td>{a.sense ? big(a.sense) : '—'}</td>
                  <td><a href={`${ARC_EXPLORER}/tx/${a.tx}`} target="_blank" rel="noreferrer">↗</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="sense-h">{T('Latest fees')}</h3>
      {v?.fees.length ? (
        <div className="fx-table-wrap">
          <table className="fx-table">
            <tbody>
              {v.fees.map(f => (
                <tr key={f.tx}><td><small>{when(f.at)}</small></td><td>{usd(f.usd)}</td><td><a href={`${ARC_EXPLORER}/tx/${f.tx}`} target="_blank" rel="noreferrer">↗</a></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="sense-note">{v ? T('No fees since the program started.') : T('Loading…')}</div>}

      <p className="sense-fine">
        {T('How it’s counted: fees are the USDC ARCSENSE’s trading contracts pay the fee wallet (the swap routers, the curve router, the launchpad and the Universal Router). A buyback is a fee-wallet transaction that brought $SENSE in; a burn is $SENSE it sent to 0x…dEaD; liquidity is value it put into a pool. Burning reduces supply; it doesn’t promise any price.')}{' '}
        <a href={`${ARC_EXPLORER}/address/${FEE_WALLET}`} target="_blank" rel="noreferrer">{T('The fee wallet on the explorer')} ↗</a>
      </p>
    </div>
  )
}
