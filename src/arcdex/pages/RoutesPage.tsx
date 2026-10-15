// /routes — every way to trade or move money on ARCDEX (lib/routes.ts), and how each provider is answering right now,
// checked from the visitor's own browser: three calls each, the middle time shown. Nothing here is estimated: a
// provider that doesn't answer shows as down.

import { useCallback, useEffect, useState } from 'react'
import { t as T, N_ } from '../lib/i18n'
import type { Page } from '../App'
import { engineApiUrl } from '../api/marketStream'
import { GROUP_LABEL, NOT_SUPPORTED, ROUTES, type ProviderId, type RouteGroup, type RouteStatus, type SupportedRoute } from '../lib/routes'
import { client } from '../api/launchpad'
import { FEE_ABI, routersInForce, type RouterId } from '../lib/routerFees'
import { pct } from '../lib/routerInfo'

interface Check { id: ProviderId; name: string; use: string; run: (signal: AbortSignal) => Promise<string> }

const rpc = (url: string, method: string) => async (signal: AbortSignal) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }), signal, cache: 'no-store' })
  const j = (await r.json()) as { result?: string | number; error?: { message?: string } }
  if (j.result === undefined) throw new Error(j.error?.message ?? `answered ${r.status}`)
  const n = typeof j.result === 'string' ? parseInt(j.result, 16) : j.result
  return method === 'getSlot' ? T('slot {n}', { n: n.toLocaleString() }) : T('block {n}', { n: n.toLocaleString() })
}
const reachable = (url: string, init?: RequestInit) => async (signal: AbortSignal) => {
  // Never from the browser's cache: every call measures a real round trip.
  const r = await fetch(url, { ...init, signal, cache: 'no-store' })
  // A 4xx is still an answer from a working service (the probe asks for nothing in particular).
  if (r.status >= 500) throw new Error(`answered ${r.status}`)
  return ''
}

const CHECKS: Check[] = [
  { id: 'arc', name: 'Arc', use: N_('Spot, bridge'), run: rpc('https://rpc.mainnet.arc.io', 'eth_blockNumber') },
  { id: 'engine', name: 'ARCDEX engine', use: N_('Markets, live trades, testnet futures'), run: async signal => {
    if (!engineApiUrl) throw new Error('not set')
    const r = await fetch(`${engineApiUrl}/health`, { signal, cache: 'no-store' })
    const j = (await r.json()) as { status?: string; chain?: { lagBlocks?: number } }
    if (!r.ok && r.status !== 503) throw new Error(`answered ${r.status}`)
    if (j.status === 'down') throw new Error('down')
    return j.status === 'ok' ? T('in sync') : T('{n} blocks behind', { n: j.chain?.lagBlocks ?? '?' })
  } },
  { id: 'hyperliquid', name: 'Hyperliquid', use: N_('Futures, predictions'), run: reachable('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'exchangeStatus' }) }) },
  { id: 'relay', name: 'Relay', use: N_('Solana, BNB Chain, Hyperliquid funding'), run: reachable('https://api.relay.link/config/v2?originChainId=5042&destinationChainId=1337') },
  { id: 'jupiter', name: 'Jupiter', use: N_('Solana swaps'), run: async signal => {
    // Through the site's own proxy, which holds the key: 503 means it isn't switched on yet.
    const r = await fetch('/jup/swap/v2/order?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=10000000&swapMode=ExactIn', { signal, cache: 'no-store' })
    // Without the edge function (local dev) the path answers with the app's own page.
    if (r.status === 503 || r.status === 404 || !/json/.test(r.headers.get('content-type') ?? '')) throw new Error(T('not switched on'))
    if (r.status >= 500) throw new Error(`answered ${r.status}`)
    return ''
  } },
  { id: 'across', name: 'Across', use: N_('Robinhood Chain'), run: reachable('https://app.across.to/api/available-routes?originChainId=5042&destinationChainId=4663') },
  { id: 'circle', name: 'Circle CCTP', use: N_('Bridge'), run: reachable('https://iris-api.circle.com/v2/burn/USDC/fees/26/6') },
  { id: 'robinhood', name: 'Robinhood Chain', use: N_('Robinhood coins'), run: rpc('https://rpc.mainnet.chain.robinhood.com', 'eth_blockNumber') },
  { id: 'solana', name: 'Solana', use: N_('Solana coins and wallets'), run: rpc('https://solana-rpc.publicnode.com', 'getSlot') },
  { id: 'bsc', name: 'BNB Chain', use: N_('BNB Chain coins'), run: rpc('https://bsc-rpc.publicnode.com', 'eth_blockNumber') },
  { id: 'avnu', name: 'AVNU', use: N_('Starknet swaps'), run: reachable('https://starknet.api.avnu.fi/swap/v3/sources') },
  { id: 'starknet', name: 'Starknet', use: N_('Starknet wallets and swaps'), run: rpc('https://starknet-rpc.publicnode.com', 'starknet_blockNumber') },
]

interface Result { ok: boolean; ms: number | null; detail: string; at: number }

async function probe(c: Check): Promise<Result> {
  const times: number[] = []
  let detail = '', okCount = 0, last = ''
  for (let i = 0; i < 3; i++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 8_000)
    const t0 = performance.now()
    try { detail = await c.run(ctl.signal); times.push(performance.now() - t0); okCount++ }
    catch (e) { last = ctl.signal.aborted ? T('no answer in 8s') : String((e as Error).message ?? e) }
    finally { clearTimeout(timer) }
  }
  times.sort((a, b) => a - b)
  const ok = okCount >= 2
  return { ok, ms: times.length ? Math.round(times[Math.floor(times.length / 2)]) : null, detail: ok ? detail : last, at: Date.now() }
}

const STATUS_TEXT: Record<RouteStatus, string> = { live: N_('Live'), off: N_('Switched off'), testnet: N_('Testnet') }

export default function RoutesPage({ navigate }: { navigate: (p: Page) => void }) {
  const [health, setHealth] = useState<Partial<Record<ProviderId, Result>>>({})
  const [checking, setChecking] = useState(false)
  const check = useCallback(() => {
    setChecking(true)
    void Promise.all(CHECKS.map(c => probe(c).then(r => setHealth(h => ({ ...h, [c.id]: r }))))).finally(() => setChecking(false))
  }, [])
  useEffect(() => { check() }, [check])
  // The Arc routers' fee as it is on-chain now (their owner sets it), not as it was when this page was written.
  const [chainFee, setChainFee] = useState<Partial<Record<RouterId, number>>>({})
  useEffect(() => {
    for (const r of routersInForce()) {
      client.readContract({ address: r.address, abi: FEE_ABI, functionName: 'feeBps' }).then(b => setChainFee(f => ({ ...f, [r.id]: Number(b) })), () => {})
    }
  }, [])
  const feeOf = (r: SupportedRoute) => (r.onchain && chainFee[r.onchain] !== undefined ? pct(chainFee[r.onchain]!) : T(r.fee))
  useEffect(() => { const base = document.title; document.title = `${T('Supported routes')} | ARCDEX`; return () => { document.title = base } }, [])

  const groups: RouteGroup[] = ['spot', 'starknet', 'cross', 'bridge', 'futures']
  const dot = (ids: ProviderId[]) => {
    const rs = ids.map(id => health[id])
    if (rs.some(r => !r)) return 'pending'
    return rs.every(r => r!.ok) ? 'up' : 'down'
  }
  return (
    <div className="content-page rt-page" style={{ '--page-w': '1080px' } as React.CSSProperties}>
      <h1 className="page-h" style={{ marginBottom: 4 }}>{T('Supported routes')}</h1>
      <p className="rt-sub">{T('Every way to trade or move money on ARCDEX: the provider, ARCDEX’s fee, the usual time, and whether it’s live. Anything not listed isn’t supported.')}</p>

      <section className="spot-panel rt-health">
        <div className="rt-health-h">
          <b>{T('Providers right now')}</b>
          <button className="btn-ghost" disabled={checking} onClick={check}>{checking ? T('Checking…') : T('Check again')}</button>
        </div>
        <div className="rt-health-grid">
          {CHECKS.map(c => {
            const r = health[c.id]
            return (
              <div key={c.id} className={`rt-prov ${r ? (r.ok ? 'up' : 'down') : 'pending'}`}>
                <span className="rt-dot" aria-hidden />
                <div>
                  <b>{c.name}</b>
                  <small>{T(c.use)}</small>
                </div>
                <span className="rt-ms">{r ? (r.ok ? `${r.ms} ms` : T('Down')) : '…'}</span>
                {r?.detail && <small className="rt-detail">{r.detail}</small>}
              </div>
            )
          })}
        </div>
        <div className="fx-fine">{T('Measured from your browser: three calls each, the middle time shown.')}</div>
      </section>

      {groups.map(g => (
        <section key={g} className="rt-group">
          <h2>{T(GROUP_LABEL[g])}</h2>
          <div className="rt-table">
            <div className="rt-row rt-head"><span>{T('From → to')}</span><span>{T('Provider')}</span><span>{T('ARCDEX fee')}</span><span>{T('Usual time')}</span><span>{T('Status')}</span></div>
            {ROUTES.filter(r => r.group === g).map(r => (
              <div key={r.id} className="rt-row">
                <span className="rt-path">
                  <span><b>{T(r.from)}</b> → <b>{T(r.to)}</b></span>
                  <small>{T(r.notes)}</small>
                  {r.page && <button className="link-btn" onClick={() => navigate(r.page!)}>{T('Open')} →</button>}
                </span>
                <span className="rt-prov-cell"><span className={`rt-dot ${dot(r.providers)}`} aria-hidden /> {T(r.provider)}</span>
                <span><span className="rt-label">{T('ARCDEX fee')}</span>{feeOf(r)}</span>
                <span><span className="rt-label">{T('Usual time')}</span>{T(r.time)}</span>
                <span><span className={`rt-status ${r.status}`}>{T(STATUS_TEXT[r.status])}</span></span>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className="rt-group">
        <h2>{T('Not supported')}</h2>
        <ul className="rt-not">{NOT_SUPPORTED.map(s => <li key={s}>{T(s)}</li>)}</ul>
        <p className="fx-fine">{T('Network fees, and the provider’s own fee where it has one, come on top of ARCDEX’s; every quote shows them before you sign.')}</p>
      </section>
    </div>
  )
}
