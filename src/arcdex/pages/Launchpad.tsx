import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { openConnectModal } from '../components/ConnectWallet'
import { formatUnits, parseEventLogs, parseUnits, type Address } from 'viem'
import { getAllLaunchpadTokens, client, LAUNCHPAD_ADDRESS, LAUNCHPAD_ABI, type LaunchpadToken } from '../api/launchpad'
import { sendArc, txErrorText } from '../lib/tx'
import { waitForAllowance } from '../lib/rpc'
import { LAUNCH_FEE_USDC, LAUNCH_FEE_WALLET, feeCredit, saveFeeCredit, spendFeeCredit } from '../lib/launchFee'
import { GRADUATING_PCT, rememberLaunchpadCoin } from '../lib/launchpadCoins'
import { subscribeLaunchpadTrades, type LaunchpadLiveTrade } from '../api/launchpadRpc'
import { isUnlocked } from '../lib/embeddedWallet'
import { quickBuyLaunchpad } from '../lib/quickTrade'
import { uploadTokenImage, uploadTokenMetadata, buildInlineMetadataURI } from '../lib/mediaUpload'
import { useTrader } from '../lib/identity'
import type { Page } from '../App'
import { t as T, N_ } from '../lib/i18n'
import CoinCard, { type CardFlash } from '../components/CoinCard'
import CoinSearch from '../components/CoinSearch'
import { matchScore, normQuery } from '../lib/coinSearch'
import { toggleWatch, usePrefs } from '../lib/prefs'
import { riskOf } from '../lib/risk'
import { useNow } from '../lib/ago'
import { waitForReceipt } from '../lib/receipts'
import { previewToken } from '../lib/launchPreview'

function short(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}` }

const USDC_ADDR = '0x3600000000000000000000000000000000000000' as const
const ERC20_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
] as const

interface Props { navigate: (p: Page) => void }

function fmt(n: number, prefix = '$') {
  if (!n || isNaN(n)) return '—'
  if (n >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${prefix}${(n / 1e3).toFixed(1)}K`
  return `${prefix}${n.toFixed(n < 1 ? 6 : 2)}`
}

/** The launchpad's custom errors, in words a creator can act on. */
const LAUNCH_REVERTS: Record<string, string> = {
  InvalidMetadata: 'Enter a token name and symbol.',
  InvalidTax: 'The creator tax can be at most 3%.',
  NoContracts: "Smart-contract wallets can't launch — use a regular wallet or your trading wallet.",
  EnforcedPause: 'Launches are paused right now — try again later.',
}

function CreateTokenForm({ onCreated }: { onCreated: (token?: Address) => void }) {
  const trader = useTrader()
  const me = trader.address
  const [open, setOpen]           = useState(false)
  const [name, setName]           = useState('')
  const [symbol, setSymbol]       = useState('')
  const [description, setDescription] = useState('')
  const [website, setWebsite]     = useState('')
  const [twitter, setTwitter]     = useState('')
  const [telegram, setTelegram]   = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState('')
  const [imageUrl, setImageUrl] = useState('') // fallback when Storage isn't set up — paste a direct link instead
  const [initialBuy, setInitialBuy]   = useState('')
  const [taxPct, setTaxPct]           = useState('3') // 0-3%, fixed forever once launched
  const [step, setStep] = useState<'idle' | 'uploading' | 'fee' | 'approving' | 'creating'>('idle')
  const [error, setError] = useState('')
  const [cash, setCash] = useState<bigint | null>(null)
  const [openedAt, setOpenedAt] = useState(0) // unix seconds: the preview's "launched" time

  const initialBuyWei = initialBuy ? (() => { try { return parseUnits(initialBuy, 6) } catch { return 0n } })() : 0n
  const taxBps = Math.max(0, Math.min(300, Math.round(Number(taxPct || 0) * 100)))

  // USDC of whoever launches (trading wallet or external), for the "not
  // enough USDC" check before anything is signed.
  useEffect(() => {
    if (!open || !me) { setCash(null); return }
    let alive = true
    const load = () => void client.readContract({ address: USDC_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [me] })
      .then(b => { if (alive) setCash(b) }).catch(() => {})
    load()
    const id = setInterval(load, 15_000)
    return () => { alive = false; clearInterval(id) }
  }, [open, me])

  // The coin's card as the launchpad will show it, updated as the form changes.
  const preview = useMemo(() => previewToken({
    name: name.trim() || T('Your coin'), symbol: symbol.trim() || 'TICKER',
    meta: {
      description: description.trim() || undefined, image: imagePreview || (/^https:\/\//i.test(imageUrl) ? imageUrl : undefined),
      website: website.trim() || undefined, twitter: twitter.trim() || undefined, telegram: telegram.trim() || undefined,
    },
    creator: me ?? null, taxBps, buyUsdc: initialBuyWei, launchedAt: openedAt,
  }), [name, symbol, description, imagePreview, imageUrl, website, twitter, telegram, me, taxBps, initialBuyWei, openedAt])

  const credit = me ? feeCredit(me) : null
  const feeDue = credit ? 0n : LAUNCH_FEE_USDC
  const totalDue = feeDue + initialBuyWei
  const short = cash !== null && cash < totalDue

  function resetForm() {
    setOpen(false); setName(''); setSymbol(''); setDescription('')
    setWebsite(''); setTwitter(''); setTelegram('')
    setImageFile(null); setImagePreview(''); setImageUrl(''); setInitialBuy(''); setStep('idle')
  }

  function pickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
    setImageUrl('')
  }

  async function submit() {
    if (!me || !name || !symbol || LAUNCHPAD_ADDRESS.length !== 42) return
    setError('')

    // Build off-chain metadata (image/socials/description) only if the
    // creator actually filled something in — a bare launch with none of
    // that still works exactly as before, no upload step at all.
    const hasExtras = !!(imageFile || imageUrl || description || website || twitter || telegram)
    let metadataURI = ''
    if (hasExtras) {
      setStep('uploading')
      const meta = {
        name, symbol, description: description || undefined,
        website: website || undefined, twitter: twitter || undefined, telegram: telegram || undefined,
      }
      // The logo goes to /api/upload (signing in once with the wallet). The
      // metadata is stored there too, or, if that fails, encoded straight
      // into the URI. A picked file can't be inlined, so a failed image
      // upload is reported rather than silently dropping the logo.
      let image = imageUrl || undefined
      if (imageFile) {
        try {
          image = await uploadTokenImage(trader, imageFile)
        } catch (e) {
          const reason = e instanceof Error ? e.message : ''
          setError(/rejected|denied/i.test(reason)
            ? T("Sign-in cancelled — the logo needs a quick wallet signature to upload.")
            : T("Image upload failed: {reason}. Paste a direct image URL instead, or launch without an image.", { reason: reason.slice(0, 120) }))
          setStep('idle')
          return
        }
      }
      try {
        metadataURI = await uploadTokenMetadata(trader, { ...meta, image })
      } catch {
        metadataURI = buildInlineMetadataURI({ ...meta, image })
      }
    }

    const create = {
      address: LAUNCHPAD_ADDRESS, abi: LAUNCHPAD_ABI, functionName: 'createToken' as const,
      args: [name, symbol, metadataURI, BigInt(taxBps), initialBuyWei] as const,
    }
    try {
      // 1. The $3 launch fee — unless an earlier attempt already paid it.
      if (!feeCredit(me)) {
        setStep('fee')
        const h = await sendArc(trader.kind, { address: USDC_ADDR, abi: ERC20_ABI, functionName: 'transfer', args: [LAUNCH_FEE_WALLET, LAUNCH_FEE_USDC] })
        const rc = await waitForReceipt(h)
        if (rc.status !== 'success') throw new Error(T('The launch fee payment failed — nothing was charged.'))
        saveFeeCredit(me, h)
      }
      // 2. The optional initial buy: approve exactly that amount.
      if (initialBuyWei > 0n) {
        const allowance = await client.readContract({ address: USDC_ADDR, abi: ERC20_ABI, functionName: 'allowance', args: [me, LAUNCHPAD_ADDRESS] })
        if (allowance < initialBuyWei) {
          setStep('approving')
          const h = await sendArc(trader.kind, { address: USDC_ADDR, abi: ERC20_ABI, functionName: 'approve', args: [LAUNCHPAD_ADDRESS, initialBuyWei] })
          const rc = await waitForReceipt(h)
          if (rc.status !== 'success') throw new Error(T('Approval failed'))
          await waitForAllowance(client, USDC_ADDR, me, LAUNCHPAD_ADDRESS, initialBuyWei)
        }
      }
      // 3. Launch: simulated first, so a problem shows before signing.
      setStep('creating')
      await client.simulateContract({ ...create, account: me })
      const h = await sendArc(trader.kind, create as never)
      const rc = await waitForReceipt(h)
      if (rc.status !== 'success') throw new Error(T('The launch transaction failed. Your launch fee is kept for your next try.'))
      spendFeeCredit(me)
      const launched = parseEventLogs({ abi: LAUNCHPAD_ABI, logs: rc.logs, eventName: 'TokenLaunched' })[0]?.args.token as Address | undefined
      if (launched) rememberLaunchpadCoin(launched)
      resetForm()
      onCreated(launched)
    } catch (e) {
      const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)
      const known = Object.keys(LAUNCH_REVERTS).find(k => m.includes(k))
      const paid = !!feeCredit(me)
      setError((known ? T(LAUNCH_REVERTS[known]) : txErrorText(e)) + (paid ? ' ' + T('Your $3 launch fee is paid — it will be used for your next try.') : ''))
      setStep('idle')
    }
  }

  if (!open) {
    return (
      <button onClick={() => { setOpen(true); setOpenedAt(Math.floor(Date.now() / 1000)) }} style={{
        padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: '0.85rem',
        background: 'var(--adx-accent)', color: '#fff', border: 'none', cursor: 'pointer',
      }}>{T("+ Launch a token")}</button>
    )
  }

  const usd = (v: bigint) => `$${Number(formatUnits(v, 6)).toFixed(2)}`
  return (
    <div className="lp-create" style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: 20, marginBottom: 20, width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontWeight: 700 }}>{T("Launch a token")}</span>
        <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
      </div>
      <div className="lp-create-grid">
        <div className="lp-create-fields">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{
              width: 56, height: 56, borderRadius: '50%', flexShrink: 0, cursor: 'pointer',
              background: (imagePreview || imageUrl) ? `url(${imagePreview || imageUrl}) center/cover` : 'var(--bg-2)',
              border: '1px dashed var(--adx-card-border)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.6rem', color: 'var(--text-muted)', textAlign: 'center',
            }}>
              {!imagePreview && !imageUrl && T("Logo")}
              <input type="file" accept="image/*" onChange={pickImage} style={{ display: 'none' }} />
            </label>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{T("Optional token logo — PNG/JPG/GIF/WebP, under 2MB.")}</div>
          </div>
          <input placeholder={T("…or paste a direct image URL instead")} value={imageUrl}
            onChange={e => { setImageUrl(e.target.value); if (e.target.value) { setImageFile(null); setImagePreview('') } }}
            style={inputStyle} />
          <input placeholder={T("Token name")} value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
          <input placeholder={T("Symbol (e.g. MOON)")} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase().slice(0, 12))} style={inputStyle} />
          <textarea placeholder={T("Description (optional)")} value={description} onChange={e => setDescription(e.target.value)} style={{ ...inputStyle, minHeight: 60, resize: 'vertical' as const }} />
          <input placeholder={T("Website (optional)")} value={website} onChange={e => setWebsite(e.target.value)} style={inputStyle} />
          <input placeholder={T("X / Twitter (optional)")} value={twitter} onChange={e => setTwitter(e.target.value)} style={inputStyle} />
          <input placeholder={T("Telegram (optional)")} value={telegram} onChange={e => setTelegram(e.target.value)} style={inputStyle} />
          <input type="number" min="0" placeholder={T("Initial buy in USDC (optional)")} value={initialBuy} onChange={e => setInitialBuy(e.target.value)} style={inputStyle} />
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{T("Your creator tax — fixed forever once launched, max 3%")}</span>
            <input type="number" min="0" max="3" step="0.1" value={taxPct} onChange={e => setTaxPct(e.target.value)} style={inputStyle} />
          </label>
        </div>
        <aside className="lp-create-preview" aria-label={T('Live preview')}>
          <div className="lp-create-preview-label"><span className="pulse-dot" />{T('Live preview')}</div>
          <CoinCard preview token={preview} starred={false} onStar={() => {}} onOpen={() => {}}
            onBuy={() => Promise.reject(new Error(T('Launch it first')))} />
          <small>{T('How your coin will look on the launchpad. It changes as you type.')}</small>
        </aside>
        <div className="lp-create-foot">
          <div className="launch-cost">
            <div><span>{T('Launch fee')}</span><b>{credit ? T('Paid ✓') : usd(LAUNCH_FEE_USDC)}</b></div>
            {initialBuyWei > 0n && <div><span>{T('Initial buy')}</span><b>{usd(initialBuyWei)}</b></div>}
            <div className="launch-cost-total"><span>{T('Total')}</span><b>{usd(totalDue)}</b></div>
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{T('1B fixed supply — 5% to the platform, 95% into the curve, no team pre-mine. Every trade also pays a flat 1% platform fee on top of your {tax}% tax. You keep 60% of your tax ({keep}% of every trade), forever.', { tax: taxPct || 0, keep: ((taxBps * 0.6) / 100).toFixed(2) })}</div>
          {error && <div style={{ fontSize: '0.72rem', color: '#ef4444' }}>{error}</div>}
          {!me ? (
            <button onClick={openConnectModal} style={primaryBtnStyle}>{T("Connect Wallet")}</button>
          ) : (
            <button onClick={() => void submit()} disabled={!name || !symbol || step !== 'idle' || short} style={{ ...primaryBtnStyle, opacity: (!name || !symbol || short) ? 0.5 : 1 }}>
              {step === 'uploading' ? T("Uploading…")
                : step === 'fee' ? T("Paying the launch fee…")
                : step === 'approving' ? T("Approving USDC…")
                : step === 'creating' ? T("Launching…")
                : short ? T('Not enough USDC — you need {usd}', { usd: usd(totalDue) })
                : T('Launch token · {usd}', { usd: usd(totalDue) })}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '10px 12px', borderRadius: 8, fontSize: '0.85rem', background: 'var(--bg-2)',
  border: '1px solid var(--adx-card-border)', color: 'var(--text)', outline: 'none', fontFamily: 'var(--sans)',
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '12px', borderRadius: 8, fontSize: '0.875rem', fontWeight: 700,
  background: 'var(--adx-accent)', color: '#fff', border: 'none', cursor: 'pointer',
}

// ── the coin list ────────────────────────────────────────────────────
// Every launch as a card (components/CoinCard.tsx): its art fills the card,
// and cards move — drift, sheen, tilt, and a flash with the amount on every
// live trade. Tabs, search, sort and quick filters are remembered per
// browser. Trades stream in over Arc's WebSocket and move each card's price
// and progress at once; the full list refreshes every 10s.

type Tab = 'trending' | 'new' | 'live' | 'graduating' | 'graduated' | 'watchlist' | 'mine'
type Sort = 'auto' | 'mcap' | 'volume' | 'change' | 'newest' | 'progress' | 'trades' | 'last'
type Age = 'any' | '1h' | '24h' | '7d'
interface View { tab: Tab; sort: Sort; age: Age; socials: boolean; lowRisk: boolean; compact: boolean }
const VIEW_KEY = 'arcdex:launch-view'
const DEFAULT_VIEW: View = { tab: 'trending', sort: 'auto', age: 'any', socials: false, lowRisk: false, compact: false }
function loadView(): View {
  try { return { ...DEFAULT_VIEW, ...(JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<View>) } } catch { return DEFAULT_VIEW }
}
// As on Argus: Live is still on its curve; Graduating is live and at least
// halfway (GRADUATING_PCT) to graduating.
const TABS: [Tab, string][] = [
  ['trending', N_('🔥 Trending')], ['new', N_('✨ New')], ['live', N_('🟢 Live')], ['graduating', N_('🚀 Graduating')],
  ['graduated', N_('🎓 Graduated')], ['watchlist', N_('★ Watchlist')], ['mine', N_('👤 My coins')],
]
const SORTS: [Sort, string][] = [
  ['auto', N_('Sort: best for this tab')], ['mcap', N_('Sort: market cap')], ['volume', N_('Sort: 24h volume')],
  ['change', N_('Sort: 24h change')], ['newest', N_('Sort: newest')], ['progress', N_('Sort: progress')], ['trades', N_('Sort: 24h trades')], ['last', N_('Sort: last trade')],
]
const AGES: [Age, string][] = [['any', N_('Any age')], ['1h', N_('Under 1h')], ['24h', N_('Under 24h')], ['7d', N_('Under 7d')]]
const AGE_MS: Record<Age, number> = { any: Infinity, '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 }

/** What a live trade changed on a coin since the last full refresh. */
interface LiveBits { priceUsd: number; progress: number; lastTs: number; vol: number; trades: number }

/** Trending: 24h volume and trades, lifted by a trade in the last 15 minutes. */
function trendScore(t: LaunchpadToken, now: number): number {
  const s = t.stats
  const last = s?.lastTradeTs ? s.lastTradeTs * 1000 : 0
  return (s?.vol24 ?? 0) + 25 * (s?.trades24 ?? 0) + (now - last < 15 * 60_000 ? 2_000 : 0) + t.bondingProgress * 5
}

function LiveTape({ trades, tokens, navigate }: { trades: LaunchpadLiveTrade[]; tokens: Map<string, LaunchpadToken>; navigate: (p: Page) => void }) {
  return (
    <div className="lp-tape">
      <span className="lp-tape-label"><span className="pulse-dot" />{T('LIVE')}</span>
      <div className="lp-tape-track">
        {trades.length === 0 && <span className="lp-tape-empty">{T('Every buy and sell appears here the moment it lands on Arc.')}</span>}
        {trades.map(t => {
          const coin = tokens.get(t.token.toLowerCase())
          return (
            <span key={t.txHash + t.token} className={`lp-tape-item ${t.isBuy ? 'buy' : 'sell'}`} onClick={() => navigate({ name: 'token', address: t.token, symbol: coin?.symbol })}>
              {coin?.metadata?.image && <img src={coin.metadata.image} alt="" loading="lazy" />}
              <b>{t.isBuy ? '▲' : '▼'} ${coin?.symbol ?? short(t.token)}</b>
              <span>{fmt(t.usdcAmount)}</span>
              <span style={{ opacity: 0.7 }}>{short(t.trader)}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

export default function Launchpad({ navigate }: Props) {
  const [tokens, setTokens]   = useState<LaunchpadToken[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setViewState] = useState<View>(loadView)
  const setView = (v: Partial<View>) => setViewState(prev => {
    const next = { ...prev, ...v }
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(next)) } catch { /* storage blocked */ }
    return next
  })
  const [search, setSearch] = useState('')
  const prefs = usePrefs()
  const me = useTrader().address?.toLowerCase() ?? null
  const now = useNow()
  // Live trades: flash the card, move its price and progress, feed the tape.
  const [live, setLive] = useState<Map<string, LiveBits>>(new Map())
  const [flash, setFlash] = useState<Map<string, CardFlash>>(new Map())
  const [tape, setTape] = useState<LaunchpadLiveTrade[]>([])
  const gridTop = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    void getAllLaunchpadTokens().then(t => {
      setTokens(t)
      setLive(new Map()) // the refresh has everything the trades moved
      setLoading(false)
    })
  }, [])
  useEffect(() => { load(); const iv = setInterval(() => { if (!document.hidden) load() }, 10_000); return () => clearInterval(iv) }, [load])

  const buf = useRef<LaunchpadLiveTrade[]>([])
  const flushT = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (LAUNCHPAD_ADDRESS.length !== 42) return
    const off = subscribeLaunchpadTrades(LAUNCHPAD_ADDRESS, tr => {
      buf.current.push(tr)
      if (flushT.current) return
      // Batched: a burst of trades is one re-render.
      flushT.current = setTimeout(() => {
        flushT.current = null
        const batch = buf.current
        buf.current = []
        setTape(prev => [...[...batch].reverse(), ...prev].slice(0, 16))
        setLive(prev => {
          const next = new Map(prev)
          for (const x of batch) {
            const k = x.token.toLowerCase(), cur = next.get(k)
            next.set(k, {
              priceUsd: x.priceAfter, progress: Math.min(100, (x.rUsdcAfter / 25_000) * 100), lastTs: x.timestamp,
              vol: (cur?.vol ?? 0) + x.usdcAmount, trades: (cur?.trades ?? 0) + 1,
            })
          }
          return next
        })
        if (document.hidden) return
        setFlash(prev => {
          const next = new Map(prev)
          for (const x of batch) {
            const k = x.token.toLowerCase()
            next.set(k, { side: x.isBuy ? 'buy' : 'sell', usd: x.usdcAmount, n: (next.get(k)?.n ?? 0) + 1 })
          }
          return next
        })
      }, 150)
    })
    return () => { off(); if (flushT.current) clearTimeout(flushT.current) }
  }, [])

  // Each coin with what live trades changed laid over it.
  const coins = useMemo(() => tokens.map(t => {
    const l = live.get(t.address.toLowerCase())
    if (!l) return t
    const s = t.stats
    // The trend's last point is the price now: the live one.
    const spark = s?.spark && s.spark.length > 1 ? [...s.spark.slice(0, -1), l.priceUsd] : undefined
    return {
      ...t, priceUsd: l.priceUsd, bondingProgress: l.progress,
      stats: {
        vol24: (s?.vol24 ?? 0) + l.vol, buys24: s?.buys24 ?? 0, sells24: s?.sells24 ?? 0, trades24: (s?.trades24 ?? 0) + l.trades, trades: (s?.trades ?? 0) + l.trades, traders: s?.traders ?? 0, lastPrice: l.priceUsd, lastTradeTs: Math.floor(l.lastTs / 1000),
        spark, change24: spark ? (l.priceUsd / spark[0] - 1) * 100 : s?.change24,
      },
    }
  }), [tokens, live])
  const byAddress = useMemo(() => new Map(coins.map(t => [t.address.toLowerCase(), t])), [coins])

  // Search and quick filters first; each tab's count is what it would show.
  const base = useMemo(() => {
    const q = normQuery(search)
    return coins.filter(t => {
      if (q && matchScore(t, q) === 0) return false
      if (view.age !== 'any' && now - t.curve.launchedAt * 1000 > AGE_MS[view.age]) return false
      if (view.socials && !(t.metadata?.twitter || t.metadata?.telegram || t.metadata?.website)) return false
      if (view.lowRisk) {
        const r = riskOf({ liquidityUsd: Number(t.curve.rUsdc) / 1e6, marketCapUsd: t.priceUsd * 1e9, launchedAt: t.curve.launchedAt * 1000, holders: t.stats?.traders || null, txns24h: t.stats?.trades24 ?? null, buys24h: t.stats?.buys24, sells24h: t.stats?.sells24, curve: true, bonded: t.curve.graduated })
        if (r.level !== 'low') return false
      }
      return true
    })
  }, [coins, search, view.age, view.socials, view.lowRisk, now])
  const inTab = useCallback((t: LaunchpadToken, tab: Tab) => {
    switch (tab) {
      case 'trending': case 'new': return true
      case 'live': return !t.curve.graduated
      case 'graduating': return !t.curve.graduated && t.bondingProgress >= GRADUATING_PCT
      case 'graduated': return t.curve.graduated
      case 'watchlist': return prefs.watchlist.includes(t.address.toLowerCase())
      case 'mine': return !!me && t.curve.creator.toLowerCase() === me
    }
  }, [prefs.watchlist, me])
  const counts = useMemo(() => Object.fromEntries(TABS.map(([tab]) => [tab, base.filter(t => inTab(t, tab)).length])) as Record<Tab, number>, [base, inTab])
  const shown = useMemo(() => {
    const list = base.filter(t => inTab(t, view.tab))
    const sort = view.sort !== 'auto' ? view.sort : view.tab === 'new' ? 'newest' : view.tab === 'graduating' ? 'progress' : view.tab === 'graduated' ? 'mcap' : 'trend'
    const key = (t: LaunchpadToken): number => {
      switch (sort) {
        case 'mcap': return t.priceUsd
        case 'volume': return t.stats?.vol24 ?? 0
        case 'change': return t.stats?.change24 ?? 0
        case 'newest': return t.curve.launchedAt
        case 'progress': return t.bondingProgress
        case 'trades': return t.stats?.trades24 ?? 0
        case 'last': return t.stats?.lastTradeTs ?? 0
        default: return trendScore(t, now)
      }
    }
    return [...list].sort((a, b) => key(b) - key(a))
  }, [base, inTab, view.tab, view.sort, now])
  const featured = view.tab === 'trending' && view.sort === 'auto' && !search && shown.length > 2 ? shown[0].address : null

  const vol24 = coins.reduce((s, t) => s + (t.stats?.vol24 ?? 0), 0)
  const graduatedCount = coins.filter(t => t.curve.graduated).length

  if (LAUNCHPAD_ADDRESS.length !== 42) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>{T("Launchpad contract not configured yet — set VITE_ARC_LAUNCHPAD_ADDRESS once it's deployed to mainnet.")}</div>
    )
  }

  // Every match in the list: the all-coins tab with the quick filters off,
  // when the current view would hide some of them.
  const viewAllMatches = () => {
    const q = normQuery(search)
    const total = coins.filter(t => matchScore(t, q) > 0).length
    if (shown.length < total) setView({ tab: 'trending', age: 'any', socials: false, lowRisk: false })
    gridTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const showAll = () => setView({ tab: 'trending', age: 'any', socials: false, lowRisk: false })
  const noMatch = !!normQuery(search) && !coins.some(t => matchScore(t, normQuery(search)) > 0)

  const quickBuy = (t: LaunchpadToken) => async () => {
    if (!isUnlocked()) throw new Error(T('Unlock your trading wallet →'))
    await quickBuyLaunchpad(t.address, 5_000_000n) // $5
    load()
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 800, margin: 0 }}>{T("Launchpad")}</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 4 }}>{T("Bonding-curve launches on Arc mainnet · $3 to launch · 1% platform fee + up to 3% creator tax")}</p>
          {!loading && (
            <div className="lp-stats">
              <span className="lp-stat"><b>{coins.length.toLocaleString()}</b>{T('coins launched')}</span>
              <span className="lp-stat"><b>{fmt(vol24)}</b>{T('24h volume')}</span>
              <span className="lp-stat"><b>{graduatedCount}</b>{T('graduated')}</span>
            </div>
          )}
        </div>
        <CreateTokenForm onCreated={token => { load(); if (token) navigate({ name: 'token', address: token }) }} />
      </div>

      <LiveTape trades={tape} tokens={byAddress} navigate={navigate} />

      <div className="lp-bar" ref={gridTop}>
        <div className="lp-tabs" role="tablist">
          {TABS.map(([tab, label]) => (
            <button key={tab} role="tab" aria-selected={view.tab === tab} className={`lp-tab${view.tab === tab ? ' on' : ''}`} onClick={() => setView({ tab })}>
              {T(label)}<small>{counts[tab]}</small>
            </button>
          ))}
        </div>
        <div className="lp-tools">
          <CoinSearch coins={coins} value={search} onChange={setSearch} onViewAll={viewAllMatches}
            onOpen={t => navigate({ name: 'token', address: t.address, symbol: t.symbol })} />
          <select className="lp-select" value={view.sort} onChange={e => setView({ sort: e.target.value as Sort })}>
            {SORTS.map(([v, label]) => <option key={v} value={v}>{T(label)}</option>)}
          </select>
          <select className="lp-select" value={view.age} onChange={e => setView({ age: e.target.value as Age })}>
            {AGES.map(([v, label]) => <option key={v} value={v}>{T(label)}</option>)}
          </select>
          <button className={`lp-chip${view.socials ? ' on' : ''}`} onClick={() => setView({ socials: !view.socials })}>{T('Has socials')}</button>
          <button className={`lp-chip${view.lowRisk ? ' on' : ''}`} onClick={() => setView({ lowRisk: !view.lowRisk })}>{T('Low risk')}</button>
          <span className="lp-view" title={T('Card size')}>
            <button className={!view.compact ? 'on' : ''} onClick={() => setView({ compact: false })} aria-label={T('Big cards')}>▦</button>
            <button className={view.compact ? 'on' : ''} onClick={() => setView({ compact: true })} aria-label={T('Small cards')}>▩</button>
          </span>
        </div>
      </div>

      {loading ? (
        <div className="loading-state">{T("Loading launches…")}</div>
      ) : coins.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>{T("No tokens launched yet — be the first.")}</div>
      ) : shown.length === 0 ? (
        <div className="lp-empty">
          {noMatch
            ? T('No coin matches "{q}". Check the spelling, or paste its full contract address.', { q: search.trim() })
            : <>{T('No coins match these filters.')} <button className="lp-chip on" onClick={showAll}>{T('Show all coins')}</button></>}
        </div>
      ) : (
        <div className={`coin-grid${view.compact ? ' compact' : ''}`}>
          {shown.map(t => (
            <CoinCard key={t.address} token={t} featured={t.address === featured} flash={flash.get(t.address.toLowerCase())}
              starred={prefs.watchlist.includes(t.address.toLowerCase())} onStar={() => toggleWatch(t.address)}
              onOpen={() => navigate({ name: 'token', address: t.address, symbol: t.symbol })} onBuy={quickBuy(t)} />
          ))}
        </div>
      )}
    </div>
  )
}
