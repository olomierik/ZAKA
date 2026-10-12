// RPC settings and speed test (the network menu's last item): each chain's nodes, measured from this browser, with
// the one in use first. A faster node can be put first, and up to two of the visitor's own added (lib/rpcSettings.ts).

import { useEffect, useState } from 'react'
import ChainLogo from './ChainLogo'
import { CHAINS, useChain } from '../lib/chains'
import { addNode, endpoints, hostOf, isDefaultOrder, measureNode, OPEN_RPC_SETTINGS, removeNode, resetRpc, RPC_CHAINS, RPC_PROVIDERS, setPrimary, useRpcSettings, type NodeSpeed, type RpcChain } from '../lib/rpcSettings'
import { t as T } from '../lib/i18n'

type Result = NodeSpeed | 'testing' | { error: string }

/** Mounted once (App): opens on the network menu's "RPC settings". */
export default function RpcSettingsHost() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const f = () => setOpen(true)
    window.addEventListener(OPEN_RPC_SETTINGS, f)
    return () => window.removeEventListener(OPEN_RPC_SETTINGS, f)
  }, [])
  return open ? <RpcSettingsModal onClose={() => setOpen(false)} /> : null
}

function RpcSettingsModal({ onClose }: { onClose: () => void }) {
  const picked = useChain()
  const [chain, setChain] = useState<RpcChain>(picked)
  useRpcSettings()
  const list = endpoints(chain)
  const [results, setResults] = useState<Record<string, Result>>({})
  const [url, setUrl] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const test = (urls = endpoints(chain).map(e => e.url)) => {
    for (const u of urls) {
      setResults(r => ({ ...r, [u]: 'testing' }))
      void measureNode(chain, u)
        .then(m => setResults(r => ({ ...r, [u]: m })))
        .catch(e => setResults(r => ({ ...r, [u]: { error: e instanceof Error ? e.message : String(e) } })))
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setResults({}); test() }, [chain])

  const best = Math.max(0, ...Object.values(results).map(r => (typeof r === 'object' && 'head' in r ? r.head : 0)))
  const add = () => {
    const problem = addNode(chain, url)
    if (problem) { setErr(T(problem)); return }
    setErr(null)
    const u = url.trim()
    setUrl('')
    test([u])
  }
  const ms = (n: number) => `${Math.round(n)} ms`

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card tr-modal rpc-modal" onClick={e => e.stopPropagation()}>
        <div className="tr-modal-h"><b>{T('RPC · {chain}', { chain: CHAINS[chain].name })}</b><button className="tr-x" onClick={onClose} aria-label={T('Close')}>✕</button></div>
        <div className="tr-seg tr-lane-tabs">
          {RPC_CHAINS.map(c => <button key={c} className={chain === c ? 'on' : ''} onClick={() => setChain(c)}><ChainLogo chain={c} size={14} /> {CHAINS[c].short}</button>)}
        </div>
        <p className="rpc-why">
          {T('These are the nodes ARCDEX reads {chain} through: balances, quotes, and the simulation every trade runs before you sign. The first one is used; a node that throttles or fails steps aside for 30 seconds and the next answers. Put a node first if it’s faster: the numbers below are measured from this browser, right now.', { chain: CHAINS[chain].name })}
        </p>
        <div className="rpc-add">
          <input placeholder={chain === 'sol' ? 'https://mainnet.helius-rpc.com/?api-key=…' : 'https://…alchemy.com/v2/… or https://…quiknode.pro/…'} value={url} onChange={e => { setUrl(e.target.value); setErr(null) }} onKeyDown={e => { if (e.key === 'Enter') add() }} aria-label={T('Your node')} />
          <button className="tr-done" onClick={add} disabled={!url.trim()}>{T('Add')}</button>
        </div>
        {err && <div className="rpc-err">{err}</div>}
        <table className="rpc-table">
          <thead><tr><th>{T('Node')}</th><th>{T('Latency')}</th><th>{T('Call')}</th><th>{T('Head')}</th><th /></tr></thead>
          <tbody>
            {list.map((e, i) => {
              const r = results[e.url]
              const ok = r && typeof r === 'object' && 'head' in r ? r : null
              const lag = ok ? ok.head - best : null
              return (
                <tr key={e.url} className={i === 0 ? 'first' : ''}>
                  <td><b>{e.kind === 'own' ? T('Your node {n}', { n: e.name.slice(-1) }) : e.name}</b><small>{e.kind === 'arcdex' ? T('dedicated') : hostOf(e.url)}</small></td>
                  <td className={ok ? (ok.latencyMs < 200 ? 'fast' : ok.latencyMs < 500 ? '' : 'slow') : ''}>{r === 'testing' ? '…' : ok ? ms(ok.latencyMs) : r ? '—' : ''}</td>
                  <td>{r === 'testing' ? '…' : ok ? ms(ok.callMs) : r ? '—' : ''}</td>
                  <td>{ok ? (lag === 0 ? T('head') : lag) : r && r !== 'testing' ? <span className="rpc-fail" title={(r as { error: string }).error}>{T('failed')}</span> : ''}</td>
                  <td className="rpc-acts">
                    {i === 0 ? <span className="rpc-use">{T('In use')}</span> : <button onClick={() => setPrimary(chain, e.url)}>{T('Use first')}</button>}
                    {e.kind === 'own' && <button onClick={() => removeNode(chain, e.url)}>{T('Remove')}</button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="rpc-note">
          {T('Only reads follow this order: transactions are sent as before, and live trade feeds keep their own nodes. Your own node must use HTTPS and come from a known provider ({list}), because a node can lie about balances and simulations.', { list: RPC_PROVIDERS.slice(0, 14).join(', ') + '…' })}
        </p>
        <div className="tr-modal-f">
          <button className="tr-ghost" onClick={() => test()}>{T('Test all')}</button>
          <span className="tr-grow" />
          {!isDefaultOrder(chain) && <button className="tr-ghost" onClick={() => resetRpc(chain)}>{T('Reset to defaults')}</button>}
          <button className="tr-done" onClick={onClose}>{T('Done')}</button>
        </div>
      </div>
    </div>
  )
}
