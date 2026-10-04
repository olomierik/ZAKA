// /burn — $ARCDEX, the platform coin (since 2026-10-04): its burns, buybacks and liquidity. 30% of
// ARCDEX's fees buy back $ARCDEX and burn it, 70% go to liquidity pools. Everything here is read
// from Arc by the engine (engine/src/coin/program.ts): every burn since the coin launched (anyone's),
// and the fee wallet's fees in, buybacks, burns, liquidity added and what's still owed. Anyone can
// check each transaction on the explorer.
//
// With the fee wallet connected, the owner's controls: buy $ARCDEX (its coin page) and burn the
// $ARCDEX the wallet holds (a transfer to 0x…dEaD). The ledger counts both by itself.

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
import type { CoinEntry, CoinProgramView } from '../../../engine/src/coin/shared'
import type { Page } from '../App'

import { COIN, COIN_DEAD as DEAD, COIN_POOL, COIN_SUPPLY, fmtCompactUsd, fmtPct, fmtSmallUsd, useCoin, useCoinBurned } from '../lib/coin'

const usd = (n: number | null | undefined) => (n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const big = (n: number | null | undefined) => (n == null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0))
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : '—')

/** The ledger from the engine, every 15 seconds. */
export function useCoinProgram(): CoinProgramView | null | 'down' {
  const [v, setV] = useState<CoinProgramView | null | 'down'>(null)
  useEffect(() => {
    if (!engineApiUrl) { setV('down'); return }
    let alive = true
    const load = () => fetch(`${engineApiUrl}/v1/coin/program`, { signal: AbortSignal.timeout(10_000) })
      .then(r => (r.ok ? r.json() : null)).then((x: CoinProgramView | null) => { if (alive) setV(x ?? 'down') })
      .catch(() => { if (alive) setV(prev => prev ?? 'down') })
    void load()
    const id = setInterval(() => { if (!document.hidden) void load() }, 15_000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return v
}

export const ACTION_LABEL: Record<CoinEntry['kind'], string> = {
  fee: 'Fee in', buyback: 'Bought back', burn: 'Burned', liquidity: 'Liquidity added', unliquidity: 'Liquidity removed',
}

function Progress({ done, owed }: { done: number; owed: number }) {
  const pct = owed > 0 ? Math.min(100, (done / owed) * 100) : done > 0 ? 100 : 0
  return <div className="arcdex-bar"><span style={{ width: `${pct}%` }} /></div>
}

export default function ArcdexPage({ navigate }: { navigate: (p: Page) => void }) {
  const p = useCoinProgram()
  const trader = useTrader()
  const isFeeWallet = trader.address?.toLowerCase() === FEE_WALLET
  const [held, setHeld] = useState<bigint | null>(null)
  const [burning, setBurning] = useState<'' | 'confirm' | 'sending' | { done: string } | { error: string }>('')

  useEffect(() => {
    if (!isFeeWallet || !trader.address) return
    let alive = true
    const read = () => client.readContract({ address: COIN as Address, abi: erc20Abi, functionName: 'balanceOf', args: [trader.address as Address] })
      .then(b => { if (alive) setHeld(b) }).catch(() => {})
    void read()
    const id = setInterval(read, 15_000)
    return () => { alive = false; clearInterval(id) }
  }, [isFeeWallet, trader.address])

  async function burnAll() {
    if (!held || held === 0n) return
    setBurning('sending')
    try {
      const hash = await sendArc(trader.kind, { address: COIN as Address, abi: erc20Abi, functionName: 'transfer', args: [DEAD, held] })
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
  const q = useCoin()
  const b = v?.burned
  // What the dead wallet holds, read from Arc at once; the ledger's total until it answers.
  const dead = useCoinBurned()
  const burnedTotal = dead?.total ?? b?.total ?? null
  const burnedPct = dead?.pct ?? b?.pct ?? null
  return (
    <div className="token-page content-page arcdex-page">
      <h2 className="page-h">🔥 {T('$ARCDEX burn')}</h2>
      <p className="arcdex-lead">
        {T('$ARCDEX is ARCDEX’s platform coin. 30% of ARCDEX’s fees buy it back and burn it, and 70% go to liquidity pools. Every number below is read from Arc, so anyone can check it.')}
      </p>

      {/* The coin, and every burn since it launched (anyone's, not only the program's). */}
      <div className="arcdex-grid">
        <div className="arcdex-card">
          <span>{T('Price')}</span>
          <b>{fmtSmallUsd(q?.priceUsd)} <small className={(q?.change24h ?? 0) >= 0 ? 'up-txt' : 'down-txt'}>{fmtPct(q?.change24h)}</small></b>
          <small>{T('Market cap')}: {fmtCompactUsd(q?.marketCapUsd)}</small>
        </div>
        <div className="arcdex-card">
          <span>{T('Burned forever')}</span>
          <b>{big(burnedTotal)} <small>/ {big(COIN_SUPPLY)}</small></b>
          <div className="arcdex-bar"><span style={{ width: `${Math.min(100, burnedPct ?? 0)}%` }} /></div>
          <small>{burnedPct != null ? T('{pct}% of the supply', { pct: burnedPct.toFixed(2) }) : '…'}</small>
        </div>
        <div className="arcdex-card">
          <span>{T('Burned in 24 hours')}</span>
          <b>{big(b?.h24)}</b>
          <small>{T('7 days')}: {big(b?.d7)}</small>
        </div>
        <div className="arcdex-card">
          <span>{T('Burns')}</span>
          <b>{b ? b.count.toLocaleString() : '—'}</b>
          <small>{b && !b.complete ? T('Still reading the history…') : T('Since the coin launched')}</small>
        </div>
      </div>
      <button className="btn-primary arcdex-buy" onClick={() => navigate({ name: 'argus', address: COIN.toLowerCase(), pool: COIN_POOL })}>{T('Buy $ARCDEX')} →</button>

      {v && v.burns.length > 0 && (
        <>
          <h3 className="arcdex-h">{T('Every burn')}</h3>
          <div className="fx-table-wrap">
            <table className="fx-table">
              <thead><tr><th>{T('Time')}</th><th>$ARCDEX</th><th>{T('From')}</th><th /></tr></thead>
              <tbody>
                {v.burns.map(x => (
                  <tr key={`${x.tx}:${x.amount}`}>
                    <td><small>{when(x.at)}</small></td>
                    <td>🔥 {big(x.amount)}</td>
                    <td><small style={{ fontFamily: 'var(--mono)' }}>{x.from.toLowerCase() === FEE_WALLET ? T('Fee wallet') : `${x.from.slice(0, 6)}…${x.from.slice(-4)}`}</small></td>
                    <td><a href={`${ARC_EXPLORER}/tx/${x.tx}`} target="_blank" rel="noreferrer">↗</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className="arcdex-h">{T('Where the fees go')}</h3>

      {p === 'down' && <div className="arcdex-note">{T('The ledger can’t be reached right now. Try again in a moment.')}</div>}
      {v && !v.program.started && <div className="arcdex-note">{T('The program starts {date}. From then on, every fee counts.', { date: new Date(v.program.since).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }) })}</div>}

      <div className="arcdex-grid">
        <div className="arcdex-card">
          <span>{T('Fees collected')}</span>
          <b>{usd(tt?.feesUsd)}</b>
          <small>{v ? T('since {date}', { date: new Date(v.program.since).toLocaleDateString() }) : ''}</small>
        </div>
        <div className="arcdex-card">
          <span>{T('Bought back (30%)')}</span>
          <b>{usd(tt?.buybackUsd)} <small>/ {usd(tt?.buybackOwedUsd)}</small></b>
          {tt && <Progress done={tt.buybackUsd} owed={tt.buybackOwedUsd} />}
          <small>{v?.pending.buybackUsd ? `${usd(v.pending.buybackUsd)} ${T('still to buy')}` : T('Up to date')}</small>
        </div>
        <div className="arcdex-card">
          <span>{T('Burned by the fee wallet')}</span>
          <b>{big(tt?.coinBurned)}</b>
          <small>{T('In total at the dead address')}: {big(tt?.deadBalance)}</small>
        </div>
        <div className="arcdex-card">
          <span>{T('Added to liquidity (70%)')}</span>
          <b>{usd(tt?.liquidityUsd)} <small>/ {usd(tt?.liquidityOwedUsd)}</small></b>
          {tt && <Progress done={tt.liquidityUsd} owed={tt.liquidityOwedUsd} />}
          <small>{v?.pending.liquidityUsd ? `${usd(v.pending.liquidityUsd)} ${T('still to add')}` : T('Up to date')}</small>
        </div>
      </div>

      {isFeeWallet && (
        <div className="arcdex-owner">
          <b>{T('Fee wallet connected')}</b>
          <div className="arcdex-steps">
            <div>
              <span>1. {T('Buy back')}</span>
              <small>{v?.pending.buybackUsd ? `${usd(v.pending.buybackUsd)} ${T('to buy now')}` : T('Nothing owed right now')}</small>
              <button className="btn-primary" onClick={() => navigate({ name: 'argus', address: COIN.toLowerCase(), pool: COIN_POOL })}>{T('Buy $ARCDEX')} →</button>
            </div>
            <div>
              <span>2. {T('Burn')}</span>
              <small>{T('This wallet holds')} {held == null ? '…' : big(Number(formatUnits(held, 18)))} $ARCDEX</small>
              {burning === 'confirm' ? (
                <span className="arcdex-confirm">
                  <button className="btn-danger" onClick={() => void burnAll()}>{T('Yes, burn it all')}</button>
                  <button className="btn-ghost" onClick={() => setBurning('')}>{T('Cancel')}</button>
                </span>
              ) : (
                <button className="btn-primary" disabled={!held || burning === 'sending'} onClick={() => setBurning('confirm')}>
                  {burning === 'sending' ? T('Burning…') : T('Burn all $ARCDEX in this wallet')}
                </button>
              )}
              {typeof burning === 'object' && 'done' in burning && <small className="arcdex-ok">✓ {T('Burned. The ledger shows it within a minute.')}</small>}
              {typeof burning === 'object' && 'error' in burning && <small className="arcdex-bad">⚠ {burning.error}</small>}
            </div>
            <div>
              <span>3. {T('Add liquidity')}</span>
              <small>{v?.pending.liquidityUsd ? `${usd(v.pending.liquidityUsd)} ${T('to add')}` : T('Nothing owed right now')}</small>
              <small>{T('Add it from this wallet to a pool (or to the futures pool on mainnet); the ledger counts it by itself.')}</small>
            </div>
          </div>
        </div>
      )}

      <h3 className="arcdex-h">{T('Buybacks, burns and liquidity')}</h3>
      {!v ? <div className="arcdex-note">{T('Loading…')}</div> : !v.actions.length ? (
        <div className="arcdex-note">{T('Nothing yet: the first buyback and burn will show here.')}</div>
      ) : (
        <div className="fx-table-wrap">
          <table className="fx-table">
            <thead><tr><th>{T('Time')}</th><th>{T('Event')}</th><th>{T('Value')}</th><th>$ARCDEX</th><th /></tr></thead>
            <tbody>
              {v.actions.map(a => (
                <tr key={`${a.tx}:${a.kind}`}>
                  <td><small>{when(a.at)}</small></td>
                  <td>{T(ACTION_LABEL[a.kind])}</td>
                  <td>{usd(a.usd)}</td>
                  <td>{a.coin ? big(a.coin) : '—'}</td>
                  <td><a href={`${ARC_EXPLORER}/tx/${a.tx}`} target="_blank" rel="noreferrer">↗</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="arcdex-h">{T('Latest fees')}</h3>
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
      ) : <div className="arcdex-note">{v ? T('No fees since the program started.') : T('Loading…')}</div>}

      <p className="arcdex-fine">
        {T('How it’s counted: fees are the USDC ARCDEX’s trading contracts pay the fee wallet (the swap routers, the curve router, the launchpad and the Universal Router). A buyback is a fee-wallet transaction that brought $ARCDEX in; a burn is $ARCDEX it sent to 0x…dEaD; liquidity is value it put into a pool. Burning reduces supply; it doesn’t promise any price.')}{' '}
        <a href={`${ARC_EXPLORER}/address/${FEE_WALLET}`} target="_blank" rel="noreferrer">{T('The fee wallet on the explorer')} ↗</a>
      </p>
    </div>
  )
}
