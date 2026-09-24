import { useCallback, useEffect, useRef, useState } from 'react'
import { parseAbiItem } from 'viem'
import Avatar from '../components/Avatar'
import { DepositModal, WithdrawModal } from '../components/CashModals'
import { client } from '../api/launchpad'
import { ARC_EXPLORER } from '../api/arcRpc'
import { getProfiles, getTransferNotes, type Profile, type TransferNote } from '../api/social'
import { shortAddr, useTrader } from '../lib/identity'
import { USDC, useCash } from '../lib/usdc'
import type { Page } from '../App'

// Cash in and out (fomo "Transfers"): USDC deposits and withdrawals read
// straight from Arc, plus cash sent between traders with its note.

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const WINDOW = 9_000n       // Arc's node rejects getLogs ranges of 10,000+ blocks
const STEP_WINDOWS = 8      // ~9.6h of history per "Load older"

interface Row { hash: string; block: bigint; dir: 'in' | 'out'; other: string; amount: number; note?: string | null; time?: number }

export default function TransfersPage({ navigate }: { navigate: (p: Page) => void }) {
  const trader = useTrader()
  const me = trader.address?.toLowerCase() ?? null
  const { cash } = useCash(me)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [scannedTo, setScannedTo] = useState<bigint | null>(null)
  const [notes, setNotes] = useState<Map<string, TransferNote>>(new Map())
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map())
  const [modal, setModal] = useState<'deposit' | 'withdraw' | null>(null)
  const cursor = useRef<bigint | null>(null)

  const scan = useCallback(async () => {
    if (!me) return
    setLoading(true)
    try {
      let to = cursor.current ?? await client.getBlockNumber()
      const found: Row[] = []
      for (let i = 0; i < STEP_WINDOWS && to > 0n; i++) {
        const from = to > WINDOW ? to - WINDOW + 1n : 0n
        const [outs, ins] = await Promise.all([
          client.getLogs({ address: USDC, event: TRANSFER, args: { from: me as `0x${string}` }, fromBlock: from, toBlock: to }),
          client.getLogs({ address: USDC, event: TRANSFER, args: { to: me as `0x${string}` }, fromBlock: from, toBlock: to }),
        ])
        for (const l of outs) found.push({ hash: l.transactionHash, block: l.blockNumber, dir: 'out', other: String(l.args.to).toLowerCase(), amount: Number(l.args.value) / 1e6, time: Number((l as { blockTimestamp?: bigint }).blockTimestamp ?? 0) * 1000 || undefined })
        for (const l of ins) found.push({ hash: l.transactionHash, block: l.blockNumber, dir: 'in', other: String(l.args.from).toLowerCase(), amount: Number(l.args.value) / 1e6, time: Number((l as { blockTimestamp?: bigint }).blockTimestamp ?? 0) * 1000 || undefined })
        to = from - 1n
      }
      cursor.current = to
      setScannedTo(to)
      setRows(r => [...r, ...found].sort((a, b) => Number(b.block - a.block)))
      setProfiles(await getProfiles(found.map(f => f.other)).catch(() => new Map()))
    } finally { setLoading(false) }
  }, [me])

  useEffect(() => {
    cursor.current = null; setRows([]); setScannedTo(null)
    if (!me) return
    void scan()
    void getTransferNotes(me, 100).then(n => setNotes(new Map(n.map(x => [x.tx_hash, x])))).catch(() => {})
  }, [me, scan])

  // Router/pool legs of trades also move USDC — label them so cash moves stand out.
  const label = (r: Row) => {
    const n = notes.get(r.hash.toLowerCase())
    if (n) return r.dir === 'out' ? 'Sent cash' : 'Received cash'
    return r.dir === 'in' ? 'Deposit / received' : 'Withdraw / sent'
  }

  return (
    <div className="token-page" style={{ maxWidth: 820 }}>
      <h2 style={{ margin: 0, fontSize: '1.4rem' }}>Transfers</h2>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>USDC moving in and out of your trading address on Arc.</div>
      {!me ? <div style={{ marginTop: 20, color: 'var(--text-muted)' }}>Connect or unlock a wallet to see your transfers.</div> : (
        <>
          <div style={{ marginTop: 14, padding: 16, borderRadius: 12, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1 }}><div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Total cash</div><div className="sensitive" style={{ fontSize: '1.6rem', fontWeight: 800, fontFamily: 'var(--mono)' }}>{cash === null ? '…' : `$${cash.toFixed(2)}`}</div></div>
            <button className="btn-ghost" onClick={() => setModal('withdraw')}>Withdraw</button>
            <button className="btn-primary" style={{ padding: '9px 18px' }} onClick={() => setModal('deposit')}>Deposit</button>
          </div>
          <div style={{ marginTop: 14, background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, overflow: 'hidden' }}>
            {rows.length === 0 && !loading ? <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.84rem' }}>No USDC transfers in this period.</div> : rows.map(r => {
              const n = notes.get(r.hash.toLowerCase())
              const p = profiles.get(r.other)
              return (
                <div key={r.hash + r.dir + r.other} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid var(--adx-card-border)', fontSize: '0.82rem' }}>
                  <span style={{ width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: r.dir === 'in' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)', color: r.dir === 'in' ? 'var(--green)' : 'var(--red)', flexShrink: 0 }}>{r.dir === 'in' ? '↓' : '↑'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b>{label(r)}</b>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'center' }}>
                      {r.dir === 'in' ? 'from' : 'to'}
                      <button onClick={() => navigate({ name: 'trader', address: r.other })} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}>
                        <Avatar address={r.other} url={p?.avatar_url} size={14} />{p?.username ? `@${p.username}` : shortAddr(r.other)}
                      </button>
                      {r.time ? ` · ${new Date(r.time).toLocaleString()}` : ''}
                    </div>
                    {n?.note && <div style={{ fontSize: '0.78rem', marginTop: 3 }}>“{n.note}”</div>}
                  </div>
                  <b className="sensitive" style={{ fontFamily: 'var(--mono)', color: r.dir === 'in' ? 'var(--green)' : 'var(--text)' }}>{r.dir === 'in' ? '+' : '-'}${r.amount.toFixed(2)}</b>
                  <a href={`${ARC_EXPLORER}/tx/${r.hash}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)' }}>↗</a>
                </div>
              )
            })}
            <div style={{ padding: 12, textAlign: 'center' }}>
              <button className="btn-ghost" disabled={loading || scannedTo === 0n} onClick={() => void scan()}>{loading ? 'Scanning Arc…' : 'Load older'}</button>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 6 }}>Includes USDC legs of your trades. Full history: <a href={`${ARC_EXPLORER}/address/${me}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--adx-accent)' }}>explorer</a></div>
            </div>
          </div>
        </>
      )}
      {modal === 'deposit' && <DepositModal trader={trader} navigate={navigate} onClose={() => setModal(null)} />}
      {modal === 'withdraw' && <WithdrawModal trader={trader} onClose={() => setModal(null)} />}
    </div>
  )
}
