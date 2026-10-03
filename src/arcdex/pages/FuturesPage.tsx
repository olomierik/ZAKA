// /futures — ARCSENSE perpetual futures, live on Arc testnet (owner, 2026-10-03: "a USDC pool,
// BTC/ETH/SOL up to 10x, testnet first, then an audit before mainnet").
//
// Every price here is the oracle's: RedStone's signed prices, the same ones positions open,
// close and liquidate at (contracts/SensePerps.sol, SenseOracle). The engine records them for the
// chart and runs the keeper (engine/src/perps). Trading uses test USDC (tUSDC: 1,000 a day from
// the faucet button); gas is Arc testnet's native USDC, from Circle's faucet.
//
// Orders are two steps: the request goes on-chain, then the keeper fills it with the first price
// signed after it (usually 15 to 30 seconds), so nobody trades on a price they already saw.

import { useEffect, useMemo, useRef, useState } from 'react'
import PriceChart, { type ChartResolution, type ChartSource } from '../components/PriceChart'
import type { Tick } from '../lib/candles'
import type { Address } from 'viem'
import { sendSupport } from '../api/social'
import { useTrader, shortAddr } from '../lib/identity'
import { t as T } from '../lib/i18n'
import { openConnectModal } from '../components/ConnectWallet'
import { openTradingWallet } from '../lib/tradingWalletSheet'
import {
  dpOf, fetchCandles, PERPS_ABI, perpsErrorText, px, sendTestnet, TEST_USDC_ABI, toPrice, toUsdc, usd,
  useAccountPerps, usePerpsPrices, usePerpsState, usePerpsStatus, usePerpsTrades,
} from '../lib/perps'
import {
  CIRCLE_FAUCET, KIND, liquidationPriceOf, positionAt,
  type MarketOnChain, type PerpsFeedPrice, type PerpsMarketView, type PerpsTf, type PerpsTradeView, type Pos, type Req,
} from '../../../engine/src/perps/shared'
import type { Page } from '../App'

interface Pair { sym: string; name: string }
/** Every pair on the screen, against USDC; the contract's markets are the tradable ones. */
const PAIRS: Pair[] = [
  { sym: 'BTC', name: 'Bitcoin' },
  { sym: 'ETH', name: 'Ether' },
  { sym: 'SOL', name: 'Solana' },
  { sym: 'BNB', name: 'BNB' },
  { sym: 'XRP', name: 'XRP' },
  { sym: 'AVAX', name: 'Avalanche' },
  { sym: 'LINK', name: 'Chainlink' },
  { sym: 'DOGE', name: 'Dogecoin' },
]
const EXPLORER = 'https://testnet.arcscan.app'

const fmt = (n: number | null | undefined, dp: number) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })
const money = (n: number | null | undefined) => (n == null ? '—' : `$${fmt(n, 2)}`)
const signed = (n: number) => `${n >= 0 ? '+' : '−'}$${fmt(Math.abs(n), 2)}`
const pctTxt = (n: number | null | undefined) => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
const nowSec = () => Math.floor(Date.now() / 1000)

/** The contract's view of a market (from the engine's last read), in the shape the math takes. */
function onChainMarket(m: PerpsMarketView): MarketOnChain {
  const zero = { oi: 0n, sizeOverEntry: 0n, collateral: 0n, reserved: 0n }
  return {
    p: {
      feedId: '0x', enabled: m.enabled, maxLeverage: m.maxLeverage, openFeeBps: m.openFeeBps, closeFeeBps: m.closeFeeBps,
      liquidationBps: m.liquidationBps, borrowRatePerHour: BigInt(m.borrowRatePerHour), maxOiLong: BigInt(m.maxOiLong), maxOiShort: BigInt(m.maxOiShort),
    },
    // The borrow index isn't in the summary: P&L shown here leaves out the (small) borrow fee
    // since the last read; the contract settles it exactly.
    borrowIndex: 0n, lastBorrowUpdate: BigInt(nowSec()), long_: { ...zero, oi: BigInt(m.oiLong) }, short_: { ...zero, oi: BigInt(m.oiShort) },
  }
}

// ─── the chart ───────────────────────────────────────────────────────────────

const ORACLE_RESOLUTIONS: ChartResolution[] = ['1m', '5m', '15m', '1h', '4h', '1d']

/** The spot chart (components/PriceChart.tsx: line or candles, the live end of the line, legend,
 * indicators, %/log/auto, fullscreen) on the oracle's candles, its last point following each new
 * signed price. */
function OracleChart({ sym, live }: { sym: string; live: PerpsFeedPrice | undefined }) {
  const source = useMemo<ChartSource>(() => ({
    id: `perps:${sym}`,
    load: res => fetchCandles(sym, res as PerpsTf).then(bars => bars.map(b => ({ time: Math.floor(b[0] / 1000), open: b[1], high: b[2], low: b[3], close: b[4], volume: 0 }))),
    refreshMs: 10_000,
    resolutions: ORACLE_RESOLUTIONS,
    volume: false,
  }), [sym])
  // Every signed price since the page opened, as the chart's live ticks.
  const [ticks, setTicks] = useState<Tick[]>([])
  useEffect(() => { setTicks([]) }, [sym])
  useEffect(() => {
    if (!live) return
    setTicks(prev => (prev.length && prev[prev.length - 1].time >= live.ts ? prev : [...prev, { time: live.ts, priceUsd: live.price, usd: 0 }].slice(-600)))
  }, [live])
  return (
    <PriceChart
      poolAddress={null} source={source} ticks={ticks} live={Boolean(live)}
      liveTitle={T('Oracle prices, signed every 10 seconds')} symbol={`${sym}-USDC`}
    />
  )
}

// ─── listing requests ────────────────────────────────────────────────────────

/** "List your coin": a request to the team, sent as a support ticket (topic other) from the signed-in wallet. */
function ListingModal({ onClose }: { onClose: () => void }) {
  const trader = useTrader()
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [site, setSite] = useState('')
  const [contact, setContact] = useState('')
  const [notes, setNotes] = useState('')
  const [state, setState] = useState<'' | 'sending' | 'sent' | { error: string }>('')
  const validToken = /^0x[0-9a-fA-F]{40}$/.test(token.trim())
  const ready = name.trim().length >= 2 && validToken && contact.trim().length >= 3
  async function send() {
    setState('sending')
    const message = ['Coin listing request', `Project: ${name.trim()}`, `Token: ${token.trim()}`, site.trim() && `Website or X: ${site.trim()}`, notes.trim() && `Notes: ${notes.trim()}`].filter(Boolean).join('\n')
    try { await sendSupport(trader, { category: 'other', message: message.slice(0, 2000), contact: contact.trim() }); setState('sent') }
    catch (e) { setState({ error: e instanceof Error ? e.message : T('Could not send — try again') }) }
  }
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{T('List your coin')}</b><button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button></div>
        {state === 'sent' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', textAlign: 'center', padding: '10px 0' }}>
            <div style={{ fontSize: '2rem' }}>✓</div>
            <b>{T('Request sent')}</b>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{T('The ARCSENSE team reviews every request. If it fits, we will reach out.')}</div>
            <button className="btn-primary" style={{ width: '100%' }} onClick={onClose}>{T('Done')}</button>
          </div>
        ) : !trader.address ? (
          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{T('Connect or unlock a wallet first, so we can reach you about your coin.')}</div>
        ) : (
          <>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{T('Want your coin listed on ARCSENSE? Tell us about it and the team will review it.')}</div>
            <label className="field-label">{T('Project name')}<input className="field" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></label>
            <label className="field-label">{T('Token contract address')}<input className="field" value={token} onChange={e => setToken(e.target.value)} placeholder="0x…" style={{ fontFamily: 'var(--mono)' }} /></label>
            {token.trim() && !validToken && <div className="fx-hint-bad">{T('That address looks wrong.')}</div>}
            <label className="field-label">{T('Website or X (optional)')}<input className="field" value={site} maxLength={200} onChange={e => setSite(e.target.value)} placeholder="https://…" /></label>
            <label className="field-label">{T('How can we reach you?')}<input className="field" value={contact} maxLength={120} onChange={e => setContact(e.target.value)} placeholder={T('X, Telegram or email')} /></label>
            <label className="field-label">{T('Anything else? (optional)')}<textarea className="field" rows={3} maxLength={800} value={notes} onChange={e => setNotes(e.target.value)} style={{ resize: 'vertical', fontFamily: 'inherit' }} /></label>
            {typeof state === 'object' && <div className="fx-hint-bad">⚠ {state.error}</div>}
            <button className="btn-primary" disabled={!ready || state === 'sending'} onClick={() => void send()}>{state === 'sending' ? T('Sending…') : T('Send request')}</button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── the page ────────────────────────────────────────────────────────────────

type Tab = 'positions' | 'orders' | 'history' | 'pool'

export default function FuturesPage({ navigate }: { navigate: (p: Page) => void }) {
  const status = usePerpsStatus()
  const prices = usePerpsPrices()
  const state = usePerpsState()
  const trader = useTrader()
  const dep = status?.deployment?.perps ? status.deployment : null
  const live = Boolean(dep && state?.pool)
  const { view, refresh } = useAccountPerps(trader.address as Address | null, dep)
  const myTrades = usePerpsTrades(trader.address)
  const allTrades = usePerpsTrades(null)

  const [sym, setSym] = useState('BTC')
  const [tab, setTab] = useState<Tab>('positions')
  const [listing, setListing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const marketOf = (s: string) => state?.markets.find(m => m.feed === s) ?? null
  const market = marketOf(sym)
  const feed = prices?.feeds[sym as keyof typeof prices.feeds]
  const mark = feed?.price ?? 0
  const dp = dpOf(mark || 1)
  const pool = state?.pool ?? null

  // The last price's direction, for the ticker's color.
  const [dir, setDir] = useState<'' | 'up' | 'down'>('')
  const prevMark = useRef(0)
  useEffect(() => {
    if (prevMark.current && mark) setDir(mark > prevMark.current ? 'up' : mark < prevMark.current ? 'down' : dir)
    prevMark.current = mark
  }, [mark]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { prevMark.current = 0; setDir('') }, [sym])

  async function run(label: string, steps: () => Promise<string | void>) {
    setBusy(label)
    setNote(null)
    try {
      const done = await steps()
      setNote({ ok: true, text: done || T('Sent.') })
    } catch (e) {
      setNote({ ok: false, text: perpsErrorText(e) })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  /** Approves the futures contract for exactly `amount` of test USDC if it can't take that much yet. */
  async function approveFor(amount: bigint) {
    if (!dep?.usdc || !dep.perps) throw new Error(T('Futures aren’t deployed yet.'))
    if ((view?.allowance ?? 0n) >= amount) return
    await sendTestnet(trader.kind, { address: dep.usdc as Address, abi: TEST_USDC_ABI, functionName: 'approve', args: [dep.perps, amount] })
  }

  const execFee = pool ? BigInt(pool.execFee) : 20_000n
  const perpsAddr = dep?.perps as Address | undefined

  return (
    <div className="fx-page">
      <div className="fx-top">
        <div className="fx-title">
          <h2 className="page-h">📊 {T('Perpetual futures')}</h2>
          <span className="fx-net">{T('Arc testnet')}</span>
        </div>
        <button className="btn-ghost fx-list-btn" onClick={() => setListing(true)}>＋ {T('List your coin')}</button>
      </div>

      <div className="fx-banner">
        <b>{live ? T('Futures are live on Arc testnet.') : T('Futures open on Arc testnet in a moment.')}</b>{' '}
        {T('Trade with free test USDC: nothing here is real money. Mainnet follows an independent audit.')}
      </div>

      <div className="fx-markets" role="tablist">
        {PAIRS.map(p => {
          const f = prices?.feeds[p.sym as keyof NonNullable<typeof prices>['feeds']]
          const tradable = Boolean(marketOf(p.sym))
          return (
            <button key={p.sym} role="tab" aria-selected={p.sym === sym} className={`fx-market${p.sym === sym ? ' active' : ''}`} onClick={() => setSym(p.sym)}>
              <b>{p.sym}-USDC{!tradable && live ? <small className="fx-soon"> {T('soon')}</small> : null}</b>
              <span>{fmt(f?.price, dpOf(f?.price ?? 1))}</span>
              <span className={f?.change24h == null ? '' : f.change24h >= 0 ? 'fx-up' : 'fx-down'}>{pctTxt(f?.change24h)}</span>
            </button>
          )
        })}
      </div>

      <div className="fx-stats">
        <div className="fx-stat-main">
          <span className="fx-pair">{sym}-USDC <small>{T('Perp')}</small></span>
          <span className={`fx-last ${dir === 'up' ? 'fx-up' : dir === 'down' ? 'fx-down' : ''}`}>{fmt(mark || null, dp)}</span>
        </div>
        <div><span>{T('24h change')}</span><b className={feed?.change24h == null ? '' : feed.change24h >= 0 ? 'fx-up' : 'fx-down'}>{pctTxt(feed?.change24h)}</b></div>
        <div><span>{T('24h high')}</span><b>{fmt(feed?.high24h, dp)}</b></div>
        <div><span>{T('24h low')}</span><b>{fmt(feed?.low24h, dp)}</b></div>
        <div><span>{T('Open interest')}</span><b>{market ? `${money(usd(BigInt(market.oiLong)))} / ${money(usd(BigInt(market.oiShort)))}` : '—'}</b></div>
        <div><span>{T('Max leverage')}</span><b>{market ? `${market.maxLeverage}×` : '10×'}</b></div>
      </div>

      <div className="fx-main">
        <div className="fx-chart-card">
          <OracleChart sym={sym} live={feed} />
          <div className="fx-source">
            {prices?.ts ? T('Oracle prices from RedStone, signed every 10 seconds: the prices positions open, close and liquidate at.') : T('Oracle prices are loading…')}
          </div>
        </div>

        <OrderPanel
          sym={sym} market={market} mark={mark} live={live} pool={pool} execFee={execFee} view={view} trader={trader}
          busy={busy} waiting={!dep ? T('Futures are being set up on Arc testnet. Trading opens in a moment.') : null}
          onFaucet={() => dep?.usdc && run('faucet', async () => {
            await sendTestnet(trader.kind, { address: dep.usdc as Address, abi: TEST_USDC_ABI, functionName: 'faucet', args: [] })
            return T('1,000 test USDC added to your wallet.')
          })}
          onOpen={o => perpsAddr && market && run('open', async () => {
            // The margin and two keeper fees: this order's and its close's later, so closing needs no approval.
            await approveFor(o.collateral + 2n * execFee)
            await sendTestnet(trader.kind, {
              address: perpsAddr, abi: PERPS_ABI, functionName: 'requestOpen',
              args: [market.id, o.isLong, o.collateral, o.size, o.acceptable, o.trigger, o.tp, o.sl],
            })
            setTab('orders')
            return o.trigger ? T('Limit order placed: it fills when the oracle price reaches it.') : T('Order sent: it fills at the next oracle price, usually within 30 seconds.')
          })}
        />
      </div>

      {note && <div className={`fx-note ${note.ok ? 'ok' : 'bad'}`}>{note.ok ? '✓' : '⚠'} {note.text}</div>}

      <div className="fx-panel">
        <div className="fx-tabs">
          {([
            ['positions', `${T('Positions')}${view?.positions.length ? ` (${view.positions.length})` : ''}`],
            ['orders', `${T('Orders')}${view?.requests.length ? ` (${view.requests.length})` : ''}`],
            ['history', T('History')],
            ['pool', T('Liquidity pool')],
          ] as [Tab, string][]).map(([k, label]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        {!trader.address && tab !== 'pool' ? (
          <div className="fx-empty">
            {T('Connect a wallet or unlock your trading wallet to see your positions.')}{' '}
            <button className="link-btn" onClick={openConnectModal}>{T('Connect wallet')}</button> · <button className="link-btn" onClick={openTradingWallet}>{T('Trading wallet')}</button>
          </div>
        ) : tab === 'positions' ? (
          <Positions
            view={view} state={state} prices={prices} busy={busy}
            onClose={(id, pos) => perpsAddr && run('close', async () => {
              await approveFor(execFee)
              const m = state?.markets[pos.marketId]
              const p = m ? prices?.feeds[m.feed as keyof NonNullable<typeof prices>['feeds']]?.price : null
              // Worst exit: 1% from the current price (0: any price, when there isn't one).
              const worst = p ? toPrice(pos.isLong ? p * 0.99 : p * 1.01) : 0n
              await sendTestnet(trader.kind, { address: perpsAddr, abi: PERPS_ABI, functionName: 'requestClose', args: [id, worst] })
              setTab('orders')
              return T('Close sent: it fills at the next oracle price.')
            })}
            onTpSl={(id, tp, sl) => perpsAddr && run('tpsl', async () => {
              await sendTestnet(trader.kind, { address: perpsAddr, abi: PERPS_ABI, functionName: 'setTpSl', args: [id, tp, sl] })
              return T('Take-profit and stop-loss saved.')
            })}
          />
        ) : tab === 'orders' ? (
          <Orders
            view={view} state={state} timeout={pool?.requestTimeout ?? 120} busy={busy}
            onCancel={id => perpsAddr && run('cancel', async () => {
              await sendTestnet(trader.kind, { address: perpsAddr, abi: PERPS_ABI, functionName: 'cancelRequest', args: [id] })
              return T('Cancelled and refunded.')
            })}
          />
        ) : tab === 'history' ? (
          <History trades={myTrades} />
        ) : (
          <PoolPanel
            pool={pool} view={view} signedIn={Boolean(trader.address)} execFee={execFee} busy={busy}
            onDeposit={amount => perpsAddr && run('deposit', async () => {
              await approveFor(amount + execFee)
              const supply = BigInt(pool?.totalSupply ?? '0')
              const value = BigInt(pool?.poolAmount ?? '0')
              const expected = supply > 0n && value > 0n ? (amount * supply) / value : amount
              await sendTestnet(trader.kind, { address: perpsAddr, abi: PERPS_ABI, functionName: 'requestDeposit', args: [amount, (expected * 98n) / 100n] })
              setTab('orders')
              return T('Deposit sent: the keeper adds it to the pool within a minute.')
            })}
            onWithdraw={shares => perpsAddr && run('withdraw', async () => {
              await approveFor(execFee)
              const supply = BigInt(pool?.totalSupply ?? '0')
              const value = BigInt(pool?.poolAmount ?? '0')
              const expected = supply > 0n ? (shares * value) / supply : 0n
              await sendTestnet(trader.kind, { address: perpsAddr, abi: PERPS_ABI, functionName: 'requestWithdraw', args: [shares, (expected * 95n) / 100n] })
              setTab('orders')
              return T('Withdrawal sent: the keeper pays it out within a minute.')
            })}
          />
        )}
      </div>

      <LiveTrades trades={allTrades} />

      <div className="soon-points">
        {([
          [T('USDC in, USDC out'), T('Margin, profits and fees are all in USDC, the currency Arc runs on.')],
          [T('Testnet first'), T('Futures run on Arc testnet first, then on mainnet after an independent audit.')],
          [T('Fees fund liquidity'), T('70% of ARCSENSE’s fees go to liquidity pools, and 30% buy back $SENSE and burn it.')],
        ] as [string, string][]).map(([title, body]) => <div key={title} className="soon-point"><b>{title}</b><span>{body}</span></div>)}
      </div>
      <div className="soon-cta"><button className="btn-ghost" onClick={() => navigate({ name: 'terminal' })}>{T('Trade spot now')} →</button></div>

      {listing && <ListingModal onClose={() => setListing(false)} />}
    </div>
  )
}

// ─── the order panel ─────────────────────────────────────────────────────────

interface OpenOrder { isLong: boolean; collateral: bigint; size: bigint; acceptable: bigint; trigger: bigint; tp: bigint; sl: bigint }

function OrderPanel(props: {
  sym: string
  market: PerpsMarketView | null
  mark: number
  live: boolean
  pool: NonNullable<ReturnType<typeof usePerpsState>>['pool'] | null
  execFee: bigint
  view: ReturnType<typeof useAccountPerps>['view']
  trader: ReturnType<typeof useTrader>
  busy: string | null
  waiting: string | null
  onFaucet: () => void
  onOpen: (o: OpenOrder) => void
}) {
  const { sym, market, mark, live, pool, execFee, view, trader, busy, waiting } = props
  const [side, setSide] = useState<'long' | 'short'>('long')
  const [kind, setKind] = useState<'market' | 'limit'>('market')
  const [margin, setMargin] = useState('100')
  const [leverage, setLeverage] = useState(5)
  const [limitPrice, setLimitPrice] = useState('')
  const [slip, setSlip] = useState(1)
  const [showTpSl, setShowTpSl] = useState(false)
  const [tp, setTp] = useState('')
  const [sl, setSl] = useState('')
  useEffect(() => { setLimitPrice(''); setTp(''); setSl('') }, [sym])

  const maxLev = market?.maxLeverage ?? 10
  useEffect(() => { if (leverage > maxLev) setLeverage(maxLev) }, [maxLev, leverage])
  const dp = dpOf(mark || 1)
  const isLong = side === 'long'
  const entry = kind === 'limit' && +limitPrice > 0 ? +limitPrice : mark
  const m = Math.max(0, +margin || 0)
  const size = m * leverage
  const openFee = market ? (size * market.openFeeBps) / 10_000 : size * 0.0008
  const closeFeeBps = market?.closeFeeBps ?? 8
  const liqBps = market?.liquidationBps ?? 100
  const collateral = m - openFee
  // Liquidated once collateral + P&L < (maintenance + closing fee) of size (SensePerps._close).
  const liq = entry && size ? (isLong ? entry * (1 - (collateral - size * (liqBps + closeFeeBps) / 10_000) / size) : entry * (1 + (collateral - size * (liqBps + closeFeeBps) / 10_000) / size)) : null
  const minMargin = pool ? usd(BigInt(pool.minCollateral)) : 2
  const need = toUsdc(m) + 2n * execFee
  const gasOk = (view?.gas ?? 0n) > 2n * 10n ** 15n // ~0.002 testnet USDC
  const usdcOk = view ? view.usdc >= need : false
  const faucetReady = !view || !view.lastFaucetAt || nowSec() >= view.lastFaucetAt + 86_400

  const tpN = +tp, slN = +sl
  const tpBad = tp !== '' && entry > 0 && (isLong ? tpN <= entry : tpN >= entry)
  const slBad = sl !== '' && entry > 0 && (isLong ? slN >= entry : slN <= entry)
  const ready = live && market?.enabled && entry > 0 && m >= minMargin && leverage >= 1 && !tpBad && !slBad && (kind === 'market' || +limitPrice > 0)

  function submit() {
    const trigger = kind === 'limit' ? toPrice(+limitPrice) : 0n
    const base = kind === 'limit' ? +limitPrice : mark
    const acceptable = toPrice(isLong ? base * (1 + slip / 100) : base * (1 - slip / 100))
    props.onOpen({
      isLong, collateral: toUsdc(m), size: toUsdc(m) * BigInt(leverage), acceptable, trigger,
      tp: tp ? toPrice(tpN) : 0n, sl: sl ? toPrice(slN) : 0n,
    })
  }

  let action: JSX.Element
  if (waiting) action = <button className="fx-go" disabled>⏳ {waiting}</button>
  else if (!market) action = <button className="fx-go" disabled>{T('This pair opens for trading soon')}</button>
  else if (!trader.address) action = <button className="fx-go" onClick={openConnectModal}>{T('Connect wallet to trade')}</button>
  else if (view && !gasOk) action = (
    <a className="fx-go fx-go-link" href={CIRCLE_FAUCET} target="_blank" rel="noreferrer">⛽ {T('Get testnet USDC for gas (Circle faucet)')}</a>
  )
  else if (view && !usdcOk) action = (
    <button className="fx-go" disabled={!faucetReady || busy !== null} onClick={props.onFaucet}>
      {busy === 'faucet' ? T('Getting test USDC…') : faucetReady ? `🚰 ${T('Get 1,000 test USDC')}` : T('Faucet used today: come back tomorrow')}
    </button>
  )
  else action = (
    <button className={`fx-go ${isLong ? 'long' : 'short'}`} disabled={!ready || busy !== null} onClick={submit}>
      {busy === 'open' ? T('Sending…') : `${isLong ? T('Long') : T('Short')} ${sym} ${leverage}×`}
    </button>
  )

  return (
    <div className="fx-order">
      <div className="fx-side">
        <button className={isLong ? 'long active' : 'long'} onClick={() => setSide('long')}>{T('Long')}</button>
        <button className={!isLong ? 'short active' : 'short'} onClick={() => setSide('short')}>{T('Short')}</button>
      </div>
      <div className="fx-kind">
        <button className={kind === 'market' ? 'active' : ''} onClick={() => setKind('market')}>{T('Market')}</button>
        <button className={kind === 'limit' ? 'active' : ''} onClick={() => setKind('limit')}>{T('Limit')}</button>
      </div>
      {kind === 'limit' && (
        <label className="field-label">{T('Limit price')}
          <input className="field" inputMode="decimal" value={limitPrice} placeholder={fmt(mark || null, dp)} onChange={e => setLimitPrice(e.target.value.replace(/[^0-9.]/g, ''))} />
        </label>
      )}
      <label className="field-label">
        <span style={{ display: 'flex', justifyContent: 'space-between' }}>{T('Margin (test USDC)')}{view && <small className="fx-bal">{T('Balance')}: {fmt(usd(view.usdc), 2)}</small>}</span>
        <input className="field" inputMode="decimal" value={margin} onChange={e => setMargin(e.target.value.replace(/[^0-9.]/g, ''))} />
      </label>
      <div className="fx-presets">{[10, 50, 100, 500].map(v => <button key={v} onClick={() => setMargin(String(v))}>${v}</button>)}</div>
      <label className="field-label">{T('Leverage')} <b className="fx-lev">{leverage}×</b>
        <input type="range" min={1} max={maxLev} step={1} value={leverage} onChange={e => setLeverage(+e.target.value)} />
      </label>
      <div className="fx-ticks">{[1, 2, 5, 10].filter(v => v <= maxLev).map(v => <button key={v} className={v === leverage ? 'active' : ''} onClick={() => setLeverage(v)}>{v}×</button>)}</div>

      <button className="link-btn fx-tpsl-toggle" onClick={() => setShowTpSl(x => !x)}>{showTpSl ? '−' : '+'} {T('Take-profit / stop-loss')}</button>
      {showTpSl && (
        <div className="fx-tpsl">
          <label className="field-label">{T('Take-profit price')}<input className="field" inputMode="decimal" value={tp} onChange={e => setTp(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
          <label className="field-label">{T('Stop-loss price')}<input className="field" inputMode="decimal" value={sl} onChange={e => setSl(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
          {(tpBad || slBad) && <div className="fx-hint-bad">{isLong ? T('For a long, the take-profit is above the entry and the stop-loss below it.') : T('For a short, the take-profit is below the entry and the stop-loss above it.')}</div>}
        </div>
      )}

      <div className="fx-summary">
        <div><span>{kind === 'limit' ? T('Limit price') : T('Entry price')}</span><b>{fmt(entry || null, dp)}{kind === 'market' && <small> ±{slip}%</small>}</b></div>
        <div><span>{T('Position size')}</span><b>{size ? money(size) : '—'}{entry && size ? <small> · {fmt(size / entry, size / entry >= 1 ? 4 : 6)} {sym}</small> : null}</b></div>
        <div><span>{T('Opening fee')}</span><b>{money(openFee)}</b></div>
        <div><span>{T('Est. liquidation')}</span><b className="fx-down">{fmt(liq, dp)}</b></div>
        <div><span>{T('Borrow fee')}</span><b>{market ? `${(Number(BigInt(market.borrowRatePerHour)) / 1e16).toFixed(4)}% / h` : '—'}</b></div>
        <div><span>{T('Keeper fee')}</span><b>{money(usd(execFee))}</b></div>
      </div>
      <div className="fx-slip">{T('Max price move')}: {[0.5, 1, 2].map(v => <button key={v} className={v === slip ? 'active' : ''} onClick={() => setSlip(v)}>{v}%</button>)}</div>
      {action}
      <div className="fx-fine">{T('Your order fills at the first oracle price signed after it reaches the chain, usually within 30 seconds. If it would fill beyond your max price move, it’s cancelled and refunded.')}</div>
    </div>
  )
}

// ─── the panels ──────────────────────────────────────────────────────────────

type StateResp = ReturnType<typeof usePerpsState>
type PricesResp = ReturnType<typeof usePerpsPrices>
type ViewT = ReturnType<typeof useAccountPerps>['view']

function Positions({ view, state, prices, busy, onClose, onTpSl }: {
  view: ViewT; state: StateResp; prices: PricesResp; busy: string | null
  onClose: (id: bigint, pos: Pos) => void
  onTpSl: (id: bigint, tp: bigint, sl: bigint) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [tp, setTp] = useState('')
  const [sl, setSl] = useState('')
  if (!view) return <div className="fx-empty">{T('Loading…')}</div>
  if (!view.positions.length) return <div className="fx-empty">{T('No open positions.')}</div>
  const closing = new Set(view.requests.filter(([, r]) => r.kind === KIND.Close).map(([, r]) => String(r.positionId)))
  return (
    <div className="fx-table-wrap">
      <table className="fx-table">
        <thead><tr>
          <th>{T('Market')}</th><th>{T('Size')}</th><th>{T('Entry')}</th><th>{T('Mark')}</th><th>{T('P&L')}</th><th>{T('Liq. price')}</th><th>{T('TP / SL')}</th><th />
        </tr></thead>
        <tbody>
          {view.positions.map(([id, pos]) => {
            const mv = state?.markets[pos.marketId]
            const feed = mv?.feed ?? '?'
            const mark = prices?.feeds[feed as keyof NonNullable<PricesResp>['feeds']]?.price ?? 0
            const m = mv ? onChainMarket(mv) : null
            const r = m && mark ? positionAt({ ...pos, borrowIndex: 0n }, m, toPrice(mark), nowSec()) : null
            const pnl = r ? usd(r.pnl) : null
            const lp = m ? px(liquidationPriceOf({ ...pos, borrowIndex: 0n }, m, nowSec())) : null
            const dp = dpOf(px(pos.entryPrice))
            const key = String(id)
            return (
              <tr key={key}>
                <td><b>{feed}</b> <span className={pos.isLong ? 'fx-up' : 'fx-down'}>{pos.isLong ? T('Long') : T('Short')}</span><small> {(Number(pos.size) / Number(pos.collateral)).toFixed(1)}×</small></td>
                <td>{money(usd(pos.size))}<small> · {money(usd(pos.collateral))}</small></td>
                <td>{fmt(px(pos.entryPrice), dp)}</td>
                <td>{fmt(mark || null, dp)}</td>
                <td className={pnl == null ? '' : pnl >= 0 ? 'fx-up' : 'fx-down'}>{pnl == null ? '—' : signed(pnl)}<small> {pnl == null ? '' : pctTxt((pnl / usd(pos.collateral)) * 100)}</small>{r?.liquidatable && <small className="fx-down"> {T('liquidating')}</small>}</td>
                <td className="fx-down">{fmt(lp, dp)}</td>
                <td>
                  {editing === key ? (
                    <span className="fx-tpsl-edit">
                      <input className="field" placeholder={T('TP')} value={tp} onChange={e => setTp(e.target.value.replace(/[^0-9.]/g, ''))} />
                      <input className="field" placeholder={T('SL')} value={sl} onChange={e => setSl(e.target.value.replace(/[^0-9.]/g, ''))} />
                      <button className="btn-ghost" disabled={busy !== null} onClick={() => { onTpSl(id, tp ? toPrice(+tp) : 0n, sl ? toPrice(+sl) : 0n); setEditing(null) }}>{T('Save')}</button>
                    </span>
                  ) : (
                    <button className="link-btn" onClick={() => { setEditing(key); setTp(pos.tp ? String(px(pos.tp)) : ''); setSl(pos.sl ? String(px(pos.sl)) : '') }}>
                      {pos.tp ? fmt(px(pos.tp), dp) : '—'} / {pos.sl ? fmt(px(pos.sl), dp) : '—'} ✎
                    </button>
                  )}
                </td>
                <td>{closing.has(key) ? <small>{T('Closing…')}</small> : <button className="btn-ghost" disabled={busy !== null} onClick={() => onClose(id, pos)}>{T('Close')}</button>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Orders({ view, state, timeout, busy, onCancel }: {
  view: ViewT; state: StateResp; timeout: number; busy: string | null; onCancel: (id: bigint) => void
}) {
  const [, setNow] = useState(0)
  useEffect(() => { const id = setInterval(() => setNow(x => x + 1), 1_000); return () => clearInterval(id) }, [])
  if (!view) return <div className="fx-empty">{T('Loading…')}</div>
  if (!view.requests.length) return <div className="fx-empty">{T('No pending orders.')}</div>
  const what = (r: Req) => {
    const feed = state?.markets[r.marketId]?.feed ?? '?'
    if (r.kind === KIND.Open) return `${r.triggerPrice ? T('Limit') : T('Market')} ${r.isLong ? T('Long') : T('Short')} ${feed} · ${money(usd(r.size))}${r.triggerPrice ? ` @ ${fmt(px(r.triggerPrice), dpOf(px(r.triggerPrice)))}` : ''}`
    if (r.kind === KIND.Close) return `${T('Close')} ${feed} #${r.positionId}`
    if (r.kind === KIND.Deposit) return `${T('Deposit')} ${money(usd(r.amount))}`
    return `${T('Withdraw')} ${fmt(usd(r.amount), 2)} sLP`
  }
  return (
    <div className="fx-table-wrap">
      <table className="fx-table">
        <thead><tr><th>{T('Order')}</th><th>{T('Status')}</th><th>{T('Age')}</th><th /></tr></thead>
        <tbody>
          {view.requests.map(([id, r]) => {
            const age = Math.max(0, nowSec() - Number(r.createdAt))
            const limit = r.kind === KIND.Open && r.triggerPrice !== 0n
            const canCancel = limit || age >= timeout
            const status = limit ? T('Waiting for its price') : age < timeout ? T('Waiting for the next oracle price…') : T('Not filled: cancel it for a full refund')
            return (
              <tr key={String(id)}>
                <td>{what(r)}</td>
                <td><small>{status}</small></td>
                <td><small>{age < 120 ? `${age}s` : `${Math.floor(age / 60)}m`}</small></td>
                <td>{canCancel && <button className="btn-ghost" disabled={busy !== null} onClick={() => onCancel(id)}>{T('Cancel')}</button>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const KIND_LABEL: Record<PerpsTradeView['kind'], string> = {
  opened: 'Opened', closed: 'Closed', liquidated: 'Liquidated', takeProfit: 'Take-profit', stopLoss: 'Stop-loss', cancelled: 'Cancelled',
}

function History({ trades }: { trades: PerpsTradeView[] | null }) {
  if (!trades) return <div className="fx-empty">{T('Loading…')}</div>
  if (!trades.length) return <div className="fx-empty">{T('No trades yet.')}</div>
  return (
    <div className="fx-table-wrap">
      <table className="fx-table">
        <thead><tr><th>{T('Time')}</th><th>{T('Event')}</th><th>{T('Market')}</th><th>{T('Price')}</th><th>{T('P&L')}</th><th>{T('Paid out')}</th><th /></tr></thead>
        <tbody>
          {trades.map(t => {
            const pnl = t.pnl ? usd(BigInt(t.pnl)) : null
            const p = t.price ? px(BigInt(t.price)) : null
            return (
              <tr key={`${t.tx}:${t.kind}:${t.positionId ?? t.requestId}`}>
                <td><small>{new Date(t.at).toLocaleString()}</small></td>
                <td>{T(KIND_LABEL[t.kind])}{t.reason ? <small> · {t.reason}</small> : null}</td>
                <td>{t.market ?? '—'} {t.isLong == null ? '' : <span className={t.isLong ? 'fx-up' : 'fx-down'}>{t.isLong ? T('Long') : T('Short')}</span>}</td>
                <td>{p == null ? '—' : fmt(p, dpOf(p))}</td>
                <td className={pnl == null ? '' : pnl >= 0 ? 'fx-up' : 'fx-down'}>{pnl == null ? (t.size ? money(usd(BigInt(t.size))) : '—') : signed(pnl)}</td>
                <td>{t.payout ? money(usd(BigInt(t.payout))) : '—'}</td>
                <td><a href={`${EXPLORER}/tx/${t.tx}`} target="_blank" rel="noreferrer">↗</a></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PoolPanel({ pool, view, signedIn, execFee, busy, onDeposit, onWithdraw }: {
  pool: NonNullable<StateResp>['pool'] | null; view: ViewT; signedIn: boolean; execFee: bigint; busy: string | null
  onDeposit: (amount: bigint) => void; onWithdraw: (shares: bigint) => void
}) {
  const [dep, setDep] = useState('100')
  const [wd, setWd] = useState('')
  if (!pool) return <div className="fx-empty">{T('The pool opens once futures are deployed on Arc testnet.')}</div>
  const value = usd(BigInt(pool.poolAmount))
  const reserved = usd(BigInt(pool.totalReserved))
  const supply = usd(BigInt(pool.totalSupply))
  const sharePrice = supply > 0 ? value / supply : 1
  const mine = view ? usd(view.shares) : 0
  const cooldownLeft = view ? Math.max(0, view.lastDepositAt + pool.lpCooldown - nowSec()) : 0
  return (
    <div className="fx-pool">
      <div className="fx-pool-stats">
        <div><span>{T('Pool')}</span><b>{money(value)}</b></div>
        <div><span>{T('Reserved for open positions')}</span><b>{money(reserved)}</b></div>
        <div><span>{T('Use')}</span><b>{value ? `${((reserved / value) * 100).toFixed(1)}%` : '—'}</b></div>
        <div><span>{T('Share price')}</span><b>{fmt(sharePrice, 4)}</b></div>
        <div><span>{T('Your shares')}</span><b>{fmt(mine, 2)} sLP <small>≈ {money(mine * sharePrice)}</small></b></div>
      </div>
      <p className="fx-fine">{T('The pool takes the other side of every trade: it keeps traders’ losses and borrow fees and pays their profits. Each position’s largest possible profit is set aside when it opens, so the pool can always pay.')}</p>
      {signedIn ? (
        <div className="fx-pool-forms">
          <div>
            <label className="field-label">{T('Deposit test USDC')}<input className="field" inputMode="decimal" value={dep} onChange={e => setDep(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
            <button className="btn-primary" disabled={busy !== null || !(+dep > 0) || (view ? view.usdc < toUsdc(+dep) + execFee : true)} onClick={() => onDeposit(toUsdc(+dep))}>{busy === 'deposit' ? T('Sending…') : T('Deposit')}</button>
          </div>
          <div>
            <label className="field-label">{T('Withdraw shares (sLP)')}<input className="field" inputMode="decimal" value={wd} placeholder={fmt(mine, 2)} onChange={e => setWd(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
            <button className="btn-ghost" disabled={busy !== null || !(+wd > 0) || +wd > mine || cooldownLeft > 0} onClick={() => onWithdraw(toUsdc(+wd))}>{busy === 'withdraw' ? T('Sending…') : T('Withdraw')}</button>
            {cooldownLeft > 0 && <small className="fx-fine">{T('Shares can leave 15 minutes after your last deposit.')} {Math.ceil(cooldownLeft / 60)} min</small>}
          </div>
        </div>
      ) : (
        <div className="fx-empty"><button className="link-btn" onClick={openConnectModal}>{T('Connect wallet')}</button> {T('to add liquidity.')}</div>
      )}
    </div>
  )
}

/** The latest opens and closes by everyone: futures activity as it happens. */
function LiveTrades({ trades }: { trades: PerpsTradeView[] | null }) {
  if (!trades?.length) return null
  return (
    <div className="fx-live">
      <div className="fx-live-h"><span className="fx-dot" /> {T('Latest futures trades')}</div>
      <div className="fx-live-list">
        {trades.slice(0, 12).map(t => {
          const pnl = t.pnl ? usd(BigInt(t.pnl)) : null
          return (
            <div key={`${t.tx}:${t.kind}:${t.positionId}`} className="fx-live-row">
              <span>{shortAddr(t.trader)}</span>
              <span>{T(KIND_LABEL[t.kind])} {t.market} {t.isLong == null ? '' : t.isLong ? T('Long') : T('Short')}</span>
              <span className={pnl == null ? '' : pnl >= 0 ? 'fx-up' : 'fx-down'}>{pnl == null ? (t.size ? money(usd(BigInt(t.size))) : '') : signed(pnl)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
