import { useCallback, useEffect, useRef, useState } from 'react'
import { formatEther, getAddress, isAddress, type Address, type Hash } from 'viem'
import { useAccount } from 'wagmi'
import { openConnectModal } from '../components/ConnectWallet'
import { ARC_EXPLORER } from '../lib/arcd'
import { ARCDEX_DEPLOYER, deployCost, deployRouter, ROUTER_SETUP, shortAddress, simulate, verifyRouter, why, type Check, type Coins, type DeployCost, type SimOutcome, type Verified } from '../lib/curveRouterDeploy'
import { t as T } from '../lib/i18n'
import { useEmbeddedAddress } from '../lib/identity'
import { waitForReceipt } from '../lib/receipts'
import { txErrorText } from '../lib/tx'
import { arc } from '../wagmi'

// /deploy/curve-router — not linked from anywhere: the owner deploys
// ArcDexCurveRouter (2% on Mercuri and SolonPad curve trades) from their own
// wallet, in three steps: simulate it against the live curves, deploy it
// with one signature, and check the deployed contract. Nothing on ARCDEX
// changes until its address is set as VITE_ARCDEX_CURVE_ROUTER_ADDRESS.
// The work is in lib/curveRouterDeploy.ts.

// The router ARCDEX routes curve trades through now, if any: the variable
// api/curves.ts reads (not imported from there, so the coin pages' code
// stays in their own chunk).
const CONFIGURED = String(import.meta.env.VITE_ARCDEX_CURVE_ROUTER_ADDRESS ?? '').trim()
const CURRENT: Address | null = isAddress(CONFIGURED, { strict: false }) ? getAddress(CONFIGURED) : null

const SAVED = 'arcdex:curveRouterDeployed'
interface Saved { address: Address; hash: Hash; owner: Address }
function loadSaved(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(SAVED) ?? 'null') as Saved | null
    return s && isAddress(s.address) ? s : null
  } catch { return null }
}
function save(s: Saved) {
  try { localStorage.setItem(SAVED, JSON.stringify(s)) } catch { /* storage blocked */ }
}

const usdc = (v: bigint) => `${Number(formatEther(v)).toLocaleString('en-US', { maximumFractionDigits: 4 })} USDC`

const card: React.CSSProperties = { background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: '14px 16px', marginTop: 12 }
const muted: React.CSSProperties = { fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.55 }
const mono: React.CSSProperties = { fontFamily: 'var(--mono)', overflowWrap: 'anywhere' }

function Addr({ a }: { a: string }) {
  return <a href={`${ARC_EXPLORER}/address/${a}`} target="_blank" rel="noopener noreferrer" style={{ ...mono, color: 'var(--adx-accent)' }}>{a}</a>
}

function Lines({ lines, running }: { lines: Check[]; running?: string }) {
  if (!lines.length && !running) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }} data-testid="report">
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, fontSize: '0.8rem', lineHeight: 1.5 }}>
          <span style={{ flexShrink: 0, width: 14, fontWeight: 800, color: l.ok === true ? 'var(--green)' : l.ok === false ? 'var(--red)' : 'var(--text-muted)' }}>{l.ok === true ? '✓' : l.ok === false ? '✗' : '•'}</span>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere', color: l.ok === false ? '#fca5a5' : 'var(--text)' }}>{l.text}</span>
        </div>
      ))}
      {running && <div style={{ ...muted, fontSize: '0.78rem' }}>⏳ {running}</div>}
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section style={card}>
      <b style={{ fontSize: '0.95rem' }}>{n}. {title}</b>
      <div style={{ marginTop: 6 }}>{children}</div>
    </section>
  )
}

type DeployState =
  | { phase: 'idle' }
  | { phase: 'signing' }
  | { phase: 'mining'; hash: Hash }
  | { phase: 'done'; hash: Hash; address: Address }
  | { phase: 'error'; error: string; hash?: Hash }

interface CheckState { address: Address; running: boolean; lines: Check[]; result?: Verified }

export default function DeployCurveRouter() {
  const { address: wallet, chainId } = useAccount()
  const embedded = useEmbeddedAddress()

  const [sim, setSim] = useState<{ running: boolean; lines: Check[]; outcome?: SimOutcome }>({ running: false, lines: [] })
  const [cost, setCost] = useState<DeployCost | 'error' | null>(null)
  const [deploy, setDeploy] = useState<DeployState>({ phase: 'idle' })
  const [check, setCheck] = useState<CheckState | null>(null)
  const [saved, setSaved] = useState<Saved | null>(loadSaved)
  const [manual, setManual] = useState('')
  const [copied, setCopied] = useState(false)
  const checkRef = useRef<HTMLDivElement>(null)

  // What deploying costs from the connected wallet, and what it holds (again after deploying).
  const deployed = deploy.phase === 'done'
  useEffect(() => {
    setCost(null)
    if (!wallet) return
    let alive = true
    void deployCost(wallet).then(c => { if (alive) setCost(c) }, () => { if (alive) setCost('error') })
    return () => { alive = false }
  }, [wallet, deployed])

  const runSim = useCallback(async () => {
    setSim({ running: true, lines: [] })
    const lines: Check[] = []
    try {
      const outcome = await simulate(c => { lines.push(c); setSim({ running: true, lines: [...lines] }) })
      setSim({ running: false, lines, outcome })
    } catch (e) {
      lines.push({ ok: false, text: why(e) })
      setSim({ running: false, lines, outcome: { ran: true, passed: false, coins: {} } })
    }
  }, [])

  const runCheck = useCallback(async (address: Address, opts: { owner?: Address; coins?: Coins; fresh?: boolean; atBlock?: bigint } = {}) => {
    setCheck({ address, running: true, lines: [] })
    setCopied(false)
    setTimeout(() => checkRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
    const lines: Check[] = []
    try {
      const result = await verifyRouter(address, c => { lines.push(c); setCheck({ address, running: true, lines: [...lines] }) }, opts)
      setCheck({ address, running: false, lines, result })
    } catch (e) {
      lines.push({ ok: false, text: why(e) })
      setCheck({ address, running: false, lines, result: { passed: false, owner: null, coins: {} } })
    }
  }, [])

  async function doDeploy() {
    if (!wallet) return
    if (sim.outcome?.ran && !sim.outcome.passed && !confirm(T('The simulation found problems. Deploy anyway?'))) return
    setDeploy({ phase: 'signing' })
    let hash: Hash | undefined
    try {
      hash = await deployRouter(wallet)
      setDeploy({ phase: 'mining', hash })
      const receipt = await waitForReceipt(hash)
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(T('The deployment failed on-chain.'))
      const address = getAddress(receipt.contractAddress)
      const s = { address, hash, owner: wallet }
      save(s); setSaved(s)
      setDeploy({ phase: 'done', hash, address })
      void runCheck(address, { owner: wallet, coins: sim.outcome?.coins, fresh: true, atBlock: receipt.blockNumber })
    } catch (e) {
      setDeploy({ phase: 'error', error: txErrorText(e), hash })
    }
  }

  const simDone = !!sim.outcome && !sim.running
  const busy = deploy.phase === 'signing' || deploy.phase === 'mining'
  const lowBalance = cost && cost !== 'error' && cost.balance < cost.cost * 2n
  const manualOk = isAddress(manual.trim())

  return (
    <div className="token-page content-page" style={{ '--page-w': '820px' } as React.CSSProperties}>
      <h2 className="page-h">{T('Deploy the curve router')}</h2>
      <div style={{ ...muted, marginTop: 6, fontSize: '0.86rem' }}>
        {T("ArcDexCurveRouter takes ARCDEX's 2% fee on Mercuri and SolonPad curve trades. Deploy it once, from your own wallet. Nothing on ARCDEX changes until you switch it on (step 4).")}
      </div>

      {CURRENT && (
        <div style={{ ...card, borderColor: 'rgba(34,197,94,0.4)' }}>
          <div style={{ fontSize: '0.84rem' }}>✓ {T('ARCDEX already routes curve trades through')} <Addr a={CURRENT} /></div>
          <button className="btn-ghost" style={{ marginTop: 8 }} disabled={check?.running} onClick={() => void runCheck(CURRENT)}>{T('Check it')}</button>
        </div>
      )}

      <section style={card}>
        <b style={{ fontSize: '0.95rem' }}>{T('What gets deployed')}</b>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, max-content) 1fr', gap: '6px 14px', marginTop: 8, fontSize: '0.8rem' }}>
          <span style={muted}>{T('Contract')}</span><span>{T('ArcDexCurveRouter v1, compiled from contracts/ArcDexCurveRouter.sol: the code its 43 tests ran')}</span>
          <span style={muted}>{T('Fee')}</span><span>{T("2% of each curve trade, in USDC; 15% of it to the trader's referrer")}</span>
          <span style={muted}>{T('Fee wallet')}</span><span><Addr a={ROUTER_SETUP.feeWallet} /></span>
          <span style={muted}>{T('Owner')}</span><span>{T("The wallet that deploys it. It can change the fee (up to 2%), the referral share and the fee wallet, and pause trading. It can't touch traders' funds: the router holds none between trades.")}</span>
          <span style={muted}>{T('Launchpads')}</span><span>Mercuri <Addr a={ROUTER_SETUP.mercuriFactory} /> · SolonPad <Addr a={ROUTER_SETUP.solonFactory} /></span>
        </div>
      </section>

      <Step n={1} title={T('Simulate it (nothing is sent)')}>
        <div style={muted}>{T("A router built from this exact code buys 5 USDC of a live Mercuri and SolonPad coin and sells it back, inside a simulated transaction on Arc. It checks the fee, the referral share and that the router keeps nothing.")}</div>
        <button className="btn-primary" style={{ marginTop: 10, padding: '10px 16px' }} disabled={sim.running} onClick={() => void runSim()}>
          {sim.running ? T('Simulating…') : sim.outcome ? T('Simulate again') : T('Run the simulation')}
        </button>
        <Lines lines={sim.lines} running={sim.running ? T('Finding a coin on each curve and simulating its trades…') : undefined} />
        {simDone && sim.outcome!.ran && (
          <div style={{ marginTop: 8, fontWeight: 700, fontSize: '0.84rem', color: sim.outcome!.passed ? 'var(--green)' : 'var(--red)' }}>
            {sim.outcome!.passed ? T('All simulated trades passed.') : T('The simulation found problems: see the ✗ lines above.')}
          </div>
        )}
      </Step>

      <Step n={2} title={T('Deploy it from your wallet')}>
        {!wallet ? (
          <>
            <div style={muted}>{T('Connect the wallet that will own the router: MetaMask, Rabby, a hardware wallet… It pays the deployment gas in USDC.')}</div>
            {embedded && <div style={{ ...muted, marginTop: 4 }}>{T("The trading wallet can't deploy it: the owner should be a wallet you hold outside this site.")}</div>}
            <button className="btn-primary" style={{ marginTop: 10, padding: '10px 16px' }} onClick={openConnectModal}>{T('Connect Wallet')}</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: '0.8rem' }}>{T('Owner')}: <span style={mono}>{wallet}</span></div>
            {wallet.toLowerCase() !== ARCDEX_DEPLOYER.toLowerCase() && (
              <div style={{ ...muted, marginTop: 4, fontSize: '0.76rem' }}>{T("ARCDEX's swap router and launchpad are owned by {deployer}. Deploying from that wallet keeps one owner for all three; any wallet you control works.", { deployer: shortAddress(ARCDEX_DEPLOYER) })}</div>
            )}
            {chainId !== arc.id && <div style={{ ...muted, marginTop: 4 }}>{T('Your wallet is on another network: it will be asked to switch to Arc.')}</div>}
            <div style={{ ...muted, marginTop: 6 }}>
              {cost === null ? T('Estimating the cost…')
                : cost === 'error' ? T("Couldn't estimate the cost; your wallet shows it before you confirm.")
                : T('Costs about {cost} in gas. Your wallet has {balance}.', { cost: usdc(cost.cost), balance: usdc(cost.balance) })}
            </div>
            {lowBalance && <div style={{ fontSize: '0.8rem', color: '#fca5a5', marginTop: 4 }}>{T('Add a little USDC to this wallet on Arc for gas first.')}</div>}
            <button
              className="btn-primary" style={{ marginTop: 10, padding: '10px 16px' }}
              disabled={!simDone || busy || deploy.phase === 'done'}
              onClick={() => void doDeploy()}
            >
              {deploy.phase === 'signing' ? T('Confirm in your wallet…')
                : deploy.phase === 'mining' ? T('Deploying…')
                : deploy.phase === 'done' ? T('Deployed')
                : !simDone ? T('Run the simulation first')
                : sim.outcome!.ran && !sim.outcome!.passed ? T('Deploy anyway')
                : T('Deploy the router')}
            </button>
          </>
        )}
        {(deploy.phase === 'mining' || deploy.phase === 'done' || (deploy.phase === 'error' && deploy.hash)) && (
          <div style={{ ...muted, marginTop: 8 }}>
            <a href={`${ARC_EXPLORER}/tx/${'hash' in deploy ? deploy.hash : ''}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--adx-accent)' }}>{T('View on explorer ↗')}</a>
          </div>
        )}
        {deploy.phase === 'done' && (
          <div style={{ marginTop: 8, fontSize: '0.84rem' }} data-testid="deployed">✓ {T('Deployed at')} <Addr a={deploy.address} /></div>
        )}
        {deploy.phase === 'error' && <div style={{ marginTop: 8, fontSize: '0.8rem', color: '#fca5a5' }}>{deploy.error}</div>}
        {saved && deploy.phase !== 'done' && (
          <div style={{ ...muted, marginTop: 10, fontSize: '0.76rem' }}>
            {T('Deployed from this browser before:')} <Addr a={saved.address} />{' '}
            <button className="btn-ghost" style={{ padding: '3px 8px', fontSize: '0.74rem' }} disabled={check?.running} onClick={() => void runCheck(saved.address, { owner: saved.owner })}>{T('Check it')}</button>
          </div>
        )}
      </Step>

      <div ref={checkRef}>
        <Step n={3} title={T('Check the deployed contract')}>
          <div style={muted}>{T('Compares its code with the tested build, reads its settings back and simulates the same trades through it. This runs by itself after deploying; you can also check a router deployed another way.')}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <input className="field" value={manual} onChange={e => setManual(e.target.value)} placeholder="0x…" spellCheck={false} style={{ fontFamily: 'var(--mono)' }} aria-label={T('Router address')} />
            <button className="btn-ghost" style={{ flexShrink: 0, whiteSpace: 'nowrap' }} disabled={!manualOk || check?.running} onClick={() => void runCheck(getAddress(manual.trim()))}>{T('Check it')}</button>
          </div>
          {check && (
            <>
              <div style={{ fontSize: '0.8rem', marginTop: 10 }}>{T('Router')}: <Addr a={check.address} /></div>
              <Lines lines={check.lines} running={check.running ? T('Checking…') : undefined} />
              {check.result && (
                <div style={{ marginTop: 8, fontWeight: 700, fontSize: '0.84rem', color: check.result.passed ? 'var(--green)' : 'var(--red)' }} data-testid="verdict">
                  {check.result.passed ? T('Every check passed.') : T("Some checks failed: don't switch this router on.")}
                </div>
              )}
            </>
          )}
        </Step>
      </div>

      <Step n={4} title={T('Switch it on')}>
        {check?.result?.passed ? (
          check.address.toLowerCase() === CURRENT?.toLowerCase() ? (
            <div style={{ fontSize: '0.84rem' }}>✓ {T('ARCDEX already uses this router.')}</div>
          ) : (
            <>
              <div style={muted}>{T('Set this address as VITE_ARCDEX_CURVE_ROUTER_ADDRESS in Vercel (project app → Settings → Environment Variables, Production), then redeploy. From then on, curve trades go through it with the 2% fee.')}</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{ ...mono, fontSize: '0.8rem', padding: '7px 10px', borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--adx-card-border)' }}>{check.address}</code>
                <button className="btn-ghost" onClick={() => { void navigator.clipboard?.writeText(check.address).then(() => setCopied(true), () => {}) }}>{copied ? T('Copied ✓') : T('Copy address')}</button>
              </div>
            </>
          )
        ) : (
          <div style={muted}>{T('Once a deployed router passes every check, its address shows here, ready to switch on.')}</div>
        )}
      </Step>
    </div>
  )
}
