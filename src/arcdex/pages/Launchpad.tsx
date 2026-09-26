import { useEffect, useState, useCallback, useMemo } from 'react'
import { openConnectModal } from '../components/ConnectWallet'
import { formatUnits, parseEventLogs, parseUnits, type Address } from 'viem'
import { getAllLaunchpadTokens, client, LAUNCHPAD_ADDRESS, LAUNCHPAD_ABI, type LaunchpadToken } from '../api/launchpad'
import { sendArc, txErrorText } from '../lib/tx'
import { waitForAllowance } from '../lib/rpc'
import { LAUNCH_FEE_USDC, LAUNCH_FEE_WALLET, feeCredit, saveFeeCredit, spendFeeCredit } from '../lib/launchFee'
import { rememberLaunchpadCoin } from '../lib/launchpadCoins'
import { subscribeLaunchpadTrades, type LaunchpadLiveTrade } from '../api/launchpadRpc'
import { isUnlocked } from '../lib/embeddedWallet'
import { quickBuyLaunchpad } from '../lib/quickTrade'
import { uploadTokenImage, uploadTokenMetadata, buildInlineMetadataURI } from '../lib/mediaUpload'
import { useTrader } from '../lib/identity'
import type { Page } from '../App'
import { t as T } from '../lib/i18n'
import { waitForReceipt } from '../lib/receipts'

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
      <button onClick={() => setOpen(true)} style={{
        padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: '0.85rem',
        background: 'var(--adx-accent)', color: '#fff', border: 'none', cursor: 'pointer',
      }}>{T("+ Launch a token")}</button>
    )
  }

  const usd = (v: bigint) => `$${Number(formatUnits(v, 6)).toFixed(2)}`
  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: 20, marginBottom: 20, maxWidth: 440, width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontWeight: 700 }}>{T("Launch a token")}</span>
        <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem' }}>✕</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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

function LaunchCard({ token: t, navigate, onTraded }: { token: LaunchpadToken; navigate: (p: Page) => void; onTraded: () => void }) {
  const [buying, setBuying] = useState(false)
  const [err, setErr] = useState('')

  async function quickBuy(e: React.MouseEvent) {
    e.stopPropagation()
    if (!isUnlocked()) { setErr(T("Unlock your trading wallet →")); setTimeout(() => setErr(''), 2500); return }
    setBuying(true); setErr('')
    try {
      await quickBuyLaunchpad(t.address, 5_000_000n) // $5
      onTraded()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : T("Buy failed"))
      setTimeout(() => setErr(''), 2500)
    } finally { setBuying(false) }
  }

  const img = t.metadata?.image

  return (
    <div onClick={() => navigate({ name: 'token', address: t.address, symbol: t.symbol })}
      style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, padding: 16, cursor: 'pointer' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {img ? (
            <img src={img} alt="" width={24} height={24} style={{ borderRadius: '50%', objectFit: 'cover' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
          ) : (
            <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--bg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.55rem', fontWeight: 700, flexShrink: 0 }}>
              {t.symbol.slice(0, 2).toUpperCase()}
            </div>
          )}
          <span style={{ fontWeight: 700 }}>${t.symbol}</span>
        </div>
        {t.curve.graduated && (
          <span style={{ fontSize: '0.62rem', background: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e44', borderRadius: 4, padding: '2px 6px', fontWeight: 700 }}>{T("✓ GRADUATED")}</span>
        )}
      </div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 10 }}>{t.name}</div>
      <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: 8 }}>{fmt(t.priceUsd)}</div>
      {!t.curve.graduated && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-2)', overflow: 'hidden', marginBottom: 4 }}>
            <div style={{ width: `${Math.min(100, t.bondingProgress)}%`, height: '100%', background: 'linear-gradient(90deg,#3b82f6,#22c55e)' }} />
          </div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t.bondingProgress.toFixed(1)}{T("% to graduation")}</div>
        </div>
      )}
      <button onClick={quickBuy} disabled={buying} style={{
        width: '100%', padding: '8px', borderRadius: 7, fontSize: '0.75rem', fontWeight: 700,
        background: 'var(--green)', color: '#fff', border: 'none', cursor: 'pointer', opacity: buying ? 0.6 : 1,
      }}>
        {buying ? T("Buying…") : err || T("⚡ Buy $5")}
      </button>
    </div>
  )
}

function LiveActivityFeed({ symbolByAddress }: { symbolByAddress: Map<string, string> }) {
  const [trades, setTrades] = useState<LaunchpadLiveTrade[]>([])

  useEffect(() => {
    if (LAUNCHPAD_ADDRESS.length !== 42) return
    const unsub = subscribeLaunchpadTrades(LAUNCHPAD_ADDRESS, t => setTrades(prev => [t, ...prev].slice(0, 30)))
    return unsub
  }, [])

  return (
    <div style={{ background: 'var(--adx-card-bg)', border: '1px solid var(--adx-card-border)', borderRadius: 12, marginBottom: 20, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--adx-card-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="pulse-dot" />
        <span style={{ fontWeight: 700, fontSize: '0.82rem' }}>{T("Live activity")}</span>
        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{T("real-time buys & sells across every launch, straight from Arc RPC")}</span>
      </div>
      {trades.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.78rem' }}>{T("Waiting for trades…")}</div>
      ) : (
        <div style={{ maxHeight: 220, overflowY: 'auto' }}>
          {trades.map((t, i) => (
            <div key={t.txHash + i} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '7px 16px', fontSize: '0.78rem',
              borderBottom: '1px solid var(--adx-border)', background: i === 0 ? (t.isBuy ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.05)') : 'transparent',
            }}>
              <span style={{ background: t.isBuy ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)', color: t.isBuy ? 'var(--green)' : 'var(--red)', fontWeight: 700, padding: '2px 7px', borderRadius: 4, fontSize: '0.68rem', width: 40, textAlign: 'center' }}>
                {t.isBuy ? T("BUY") : T("SELL")}
              </span>
              <span style={{ fontWeight: 700, width: 70 }}>${symbolByAddress.get(t.token.toLowerCase()) ?? short(t.token)}</span>
              <span style={{ color: 'var(--text-muted)', flex: 1 }}>{fmt(t.tokenAmount)}{' '}{T("tokens")}</span>
              <span style={{ fontWeight: 600 }}>${fmt(t.usdcAmount)}</span>
              <a href={`${'https://explorer.arc.io'}/address/${t.trader}`} target="_blank" rel="noopener noreferrer"
                style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)', textDecoration: 'none', width: 90, textAlign: 'right' }}>
                {short(t.trader)}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Launchpad({ navigate }: Props) {
  const [tokens, setTokens]   = useState<LaunchpadToken[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    void getAllLaunchpadTokens().then(t => {
      setTokens(t.sort((a, b) => b.bondingProgress - a.bondingProgress))
      setLoading(false)
    })
  }, [])

  useEffect(() => { load(); const iv = setInterval(load, 10_000); return () => clearInterval(iv) }, [load])

  const symbolByAddress = useMemo(() => new Map(tokens.map(t => [t.address.toLowerCase(), t.symbol])), [tokens])

  if (LAUNCHPAD_ADDRESS.length !== 42) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>{T("Launchpad contract not configured yet — set VITE_ARC_LAUNCHPAD_ADDRESS once it's deployed to mainnet.")}</div>
    )
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 800, margin: 0 }}>{T("Launchpad")}</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 4 }}>{T("Bonding-curve launches on Arc mainnet · $3 to launch · 1% platform fee + up to 3% creator tax")}</p>
        </div>
        <CreateTokenForm onCreated={token => { load(); if (token) navigate({ name: 'token', address: token }) }} />
      </div>

      <LiveActivityFeed symbolByAddress={symbolByAddress} />

      {loading ? (
        <div className="loading-state">{T("Loading launches…")}</div>
      ) : tokens.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>{T("No tokens launched yet — be the first.")}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
          {tokens.map(t => <LaunchCard key={t.address} token={t} navigate={navigate} onTraded={load} />)}
        </div>
      )}
    </div>
  )
}
