import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ARCD, ARCD_POOL, ARC_EXPLORER, BURN_ADDRESS, FEE_WALLET, short } from '../lib/arcd'
import { LIVE_NOW, PHASES, ROADMAP_START, phaseRange } from './roadmap'
import './landing.css'
import './whitepaper.css'

// arcdex.online/whitepaper — the ARCDEX whitepaper (English). The same page
// prints to the downloadable PDF (public/arcdex-whitepaper.pdf, print styles
// in whitepaper.css), and ?card=cover / ?card=roadmap render the images
// posted on X; scripts/whitepaper-assets.mjs makes all three. The roadmap
// comes from ./roadmap.ts, like the landing page's.

export const VERSION = '1.0'
export const PUBLISHED = 'September 2026'
const PDF = '/arcdex-whitepaper.pdf'
const URL = 'https://arcdex.online/whitepaper'
const X_SHARE = `https://x.com/intent/post?text=${encodeURIComponent('The ARCDEX whitepaper and roadmap: a new phase every week on Arc.')}&url=${encodeURIComponent(URL)}`

export function mountWhitepaper(root: HTMLElement) {
  const card = new URLSearchParams(window.location.search).get('card')
  document.title = 'ARCDEX Whitepaper — the social trading layer for Arc'
  createRoot(root).render(
    <StrictMode>{card === 'cover' ? <CoverCard /> : card === 'roadmap' ? <RoadmapCard /> : <Whitepaper />}</StrictMode>,
  )
}

const startLong = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(`${ROADMAP_START}T00:00:00Z`))

const SOURCES: [string, string][] = [
  ['Cryptopolitan: Arc did $410 million in DEX volume on day one; memecoin launchpads drove 82%', 'https://www.cryptopolitan.com/arc-chain-memecoin-launchpad-volume/'],
  ['BeInCrypto: meme coin launchpads captured 82% of Arc’s first-day volume', 'https://beincrypto.com/arc-mainnet-meme-coin-launchpad-volume/'],
  ['whales.market: Arc memecoins crashed in 24 hours', 'https://whales.market/blog/arc-memecoins-crashed-in-24-hours/'],
  ['Toobit: Arc Chain launchpads show early trading risks', 'https://www.toobit.com/en-US/news/arc-chain-launchpads-show-early-trading-risks'],
  ['QuickNode: top memecoin trading terminals in 2026', 'https://www.quicknode.com/builders-guide/best/top-10-memecoin-terminals'],
  ['Coin Bureau: Axiom Trade review 2026 (fees, cashback tiers, Pulse)', 'https://coinbureau.com/review/axiom-trade-review'],
  ['GMGN: how to track and copy smart-money wallets', 'https://gmgn.ai/blog/how-to-track-copy-solana-smart-money/'],
  ['insights4.vc: fomo, product and strategy', 'https://insights4.vc/blog/fomo-behind-the-75-series-b/'],
  ['crypto.news: pump.fun creator fees and trader cashback coins', 'https://crypto.news/pump-fun-flips-creator-fees-launches-trader-cashback/'],
  ['CryptoPotato: pump.fun trader profitability in 2026 (CoinGecko)', 'https://cryptopotato.com/solana-based-meme-coin-launchpad-pump-fun-traders-see-turnaround-in-2026-coingecko/'],
  ['Transak: Africa’s fintech ecosystem and the rise of stablecoin payments', 'https://transak.com/blog/africa-fintech-stablecoin-report-2026'],
  ['TechCabal: Kenya gazettes crypto licensing rules', 'https://techcabal.com/2026/07/24/kenya-virtual-asset-service-providers-regulations/'],
  ['Crypto Briefing: Tanzania’s central bank prepares a crypto framework', 'https://cryptobriefing.com/tanzania-central-bank-crypto-regulatory-framework/'],
]

function Roadmap() {
  return (
    <div className="wp-roadmap">
      <div className="wp-phase wp-phase-live">
        <div className="wp-phase-top"><b>Phase 0</b><span className="wp-chip live">Live now</span></div>
        <h4>Live on arcdex.online</h4>
        <ul>{LIVE_NOW.map(x => <li key={x}>{x}</li>)}</ul>
      </div>
      {PHASES.map(p => (
        <div key={p.n} className="wp-phase">
          <div className="wp-phase-top"><b>Phase {p.n}</b><span className="wp-chip">{phaseRange(p.n)} · 5–7 days</span></div>
          <h4>{p.title}</h4>
          <ul>{p.items.map(i => <li key={i.text}>{i.text}{i.dep ? '\u00a0†' : ''}</li>)}</ul>
        </div>
      ))}
    </div>
  )
}

export default function Whitepaper() {
  return (
    <div className="ld wp">
      <div className="ld-glow ld-glow-a" /><div className="ld-glow ld-glow-b" />
      <header className="ld-nav wp-nav">
        <a href="/" className="ld-brand"><img src="/arcdex-logo.svg" alt="" width={30} height={30} />ARCDEX</a>
        <nav className="ld-links">
          <a href="#roadmap">Roadmap</a>
          <a href="#arcd">$ARCD</a>
          <a href="#security">Security</a>
        </nav>
        <div className="ld-nav-right">
          <a className="ld-btn ld-btn-ghost ld-btn-sm" href={PDF} download>⬇ PDF</a>
          <a className="ld-btn ld-btn-primary ld-btn-sm" href="/app">Launch app</a>
        </div>
      </header>

      <article className="wp-doc">
        {/* ── cover ── */}
        <section className="wp-cover">
          <img className="wp-cover-logo" src="/arcdex-logo.svg" alt="" width={72} height={72} />
          <span className="ld-pill">Whitepaper v{VERSION} · {PUBLISHED}</span>
          <h1>ARCDEX: the social trading layer for Arc</h1>
          <p className="wp-lead">One fast, safe and social place to find, trade and launch every meme coin on Arc — with self-custody, USDC for everything, and fees that buy back and burn $ARCD.</p>
          <div className="ld-cta wp-noprint">
            <a className="ld-btn ld-btn-primary" href={PDF} download>⬇ Download PDF</a>
            <a className="ld-btn ld-btn-ghost" href={X_SHARE} target="_blank" rel="noopener noreferrer">𝕏 Share on X</a>
            <a className="ld-btn ld-btn-ghost" href="/app">Launch app →</a>
          </div>
          <div className="wp-cover-foot">arcdex.online · Arc mainnet · {PUBLISHED}</div>
        </section>

        <nav className="wp-toc" aria-label="Contents">
          <h2>Contents</h2>
          <ol>
            <li><a href="#abstract">Abstract</a></li>
            <li><a href="#opportunity">The opportunity: Arc’s meme market</a></li>
            <li><a href="#problem">The problem</a></li>
            <li><a href="#traders">What meme traders want</a></li>
            <li><a href="#today">ARCDEX today</a></li>
            <li><a href="#strategy">Strategy: four pillars</a></li>
            <li><a href="#roadmap">Roadmap: a new phase every week</a></li>
            <li><a href="#arcd">$ARCD and the fee model</a></li>
            <li><a href="#security">Security and trust</a></li>
            <li><a href="#regulation">Regulation and responsible trading</a></li>
            <li><a href="#metrics">What we will report</a></li>
            <li><a href="#disclaimer">Disclaimer</a></li>
          </ol>
        </nav>

        <section id="abstract" className="wp-sec">
          <h2><span>1</span>Abstract</h2>
          <p>ARCDEX is the social trading app for Arc, Circle’s stablecoin-native Layer 1. It brings the meme coins launching on Arc into one place: a live terminal across launchpads, one-tap trading from a wallet the user controls, real-time trader activity, a fair-launch launchpad and rewards paid in USDC.</p>
          <p>Its official coin, $ARCD, has a fixed supply of 1,000,000,000 and no mint function. The fees ARCDEX keeps are used to buy $ARCD back on the open market and burn it.</p>
          <p>This paper covers four things: the market ARCDEX is built for, what meme traders need, what ARCDEX already does, and a roadmap that ships a new phase every 5–7 days, starting {startLong}.</p>
        </section>

        <section id="opportunity" className="wp-sec">
          <h2><span>2</span>The opportunity: Arc’s meme market</h2>
          <p>Arc opened its public mainnet on 16 September 2026. Gas is paid in USDC, blocks land about every half second, and USDC arrives from other chains through Circle’s CCTP. Meme traders came on day one:</p>
          <div className="wp-stats">
            <div><b>$410.8M</b><span>DEX volume on day one</span></div>
            <div><b>82%</b><span>of it on meme-coin launchpads</span></div>
            <div><b>97,025</b><span>new tokens in 24 hours</span></div>
            <div><b>19</b><span>launchpads competing</span></div>
          </div>
          <p>The largest launchpad, Argus, handled $202 million and 86% of new tokens.</p>
          <p>The other side showed just as fast. Among early buyers with enough data, 58.7% sold within 15 minutes, and the median holding time was 79 seconds. Many early coins rose 5–10× and then gave back 75–90%.</p>
          <p className="wp-callout">Arc has real demand for meme trading. But it is spread across launchpads, it is fast, and it is unforgiving. Traders will choose the platform that helps them find good coins faster, trade them more safely and earn more by staying — whichever launchpad a coin comes from.</p>
        </section>

        <section id="problem" className="wp-sec">
          <h2><span>3</span>The problem</h2>
          <ul className="wp-list">
            <li><b>Scattered.</b> Coins launch on 19 launchpads. Traders juggle tabs, wallets and bots.</li>
            <li><b>Fast, but not safe.</b> Bundled launches, snipers and developers selling are hard to spot when positions last 79 seconds.</li>
            <li><b>Costly.</b> Every extra fee adds up when positions turn over in minutes.</li>
            <li><b>Lonely.</b> Most tools show charts, not people. Traders want to see who is buying and follow those who win.</li>
            <li><b>Hard to start.</b> A first trade usually needs an exchange account, a gas token and a bridge.</li>
          </ul>
        </section>

        <section id="traders" className="wp-sec">
          <h2><span>4</span>What meme traders want</h2>
          <p>We studied the leading meme-trading apps and launchpads on Solana, Base and BNB Chain, and those on Arc. The platforms traders stay with share eight traits:</p>
          <div className="wp-grid">
            {([
              ['Low fees, paid back', 'Terminals charge about 1% and return part of it as cashback by volume tier.'],
              ['New coins first, with red flags', 'Live boards of new, graduating and graduated coins, filtered by dev holdings, snipers and bundles.'],
              ['Follow the winners', 'Wallet tracking, public profit and win rates, alerts, and one-tap copying.'],
              ['Trade without watching charts', 'Limit orders, take-profit, stop-loss and auto-sell.'],
              ['Get paid to create and hold', 'Creator fee shares, cashback coins that pay traders, holder rewards, referral income.'],
              ['Mobile first, easy money in', 'One balance, no gas token, card and local payment methods. The fastest-growing social app funded 68,000 first-time buyers through Apple Pay.'],
              ['Culture', 'Chat, launches from social media and shareable wins.'],
              ['Everything in one app', 'Spot trading today; perpetual futures are joining the same apps.'],
            ] as [string, string][]).map(([h, b], i) => (
              <div key={h} className="wp-box"><b>{i + 1}. {h}</b><p>{b}</p></div>
            ))}
          </div>
        </section>

        <section id="today" className="wp-sec">
          <h2><span>5</span>ARCDEX today</h2>
          <p>ARCDEX is live on Arc mainnet at arcdex.online.</p>
          <ul className="wp-list">
            <li><b>Terminal.</b> Every Arc coin in one live list, with a 0–100 risk score and a green or red flash on every buy and sell as it lands on-chain.</li>
            <li><b>Charts.</b> Live ARCDEX charts where each trade pops onto the chart, plus GeckoTerminal charts.</li>
            <li><b>Launchpad.</b> Fair bonding-curve launches:
              <ul className="wp-list">
                <li>1,000,000,000 fixed supply: 95% into the curve, 5% to the platform.</li>
                <li>A $3 launch fee, and graduation at $25,000 raised.</li>
                <li>Anti-snipe limits: $2,000 per buy for the first 10 minutes, and $5,000 per block.</li>
                <li>Creators earn 60% of their creator tax (up to 3%) in USDC, on every trade.</li>
              </ul>
            </li>
            <li><b>Trading wallet.</b> A wallet in the browser that only the user controls. It is protected by a passcode and an optional passkey, and buys and sells in one tap. Sending funds to a new address needs the passcode.</li>
            <li><b>Social.</b> A live feed, follows, trader profiles with profit and loss, leaderboards, clans and trade theses.</li>
            <li><b>Rewards.</b> Referrers earn 15% of the fees their friends pay, on-chain, in the same transaction. ARCDEX Points too.</li>
            <li><b>Money in and out.</b> USDC on Arc, Circle CCTP bridging from other chains, and card, Apple Pay or Google Pay through Circle.</li>
            <li><b>Safety.</b> Coin pages show developer holdings, top-holder share, creator tax, honeypot flags and a launch-bundle check.</li>
            <li><b>Languages.</b> English, Français, Español, Português, Kiswahili, Deutsch and 中文.</li>
          </ul>
        </section>

        <section id="strategy" className="wp-sec">
          <h2><span>6</span>Strategy: four pillars</h2>
          <p className="wp-callout">ARCDEX is not another launchpad. It is the trading layer for all of them.</p>
          <div className="wp-grid wp-grid-4">
            <div className="wp-box"><b>1. Price</b><p>The lowest total cost to trade Arc memes: a 1% swap fee with cashback in USDC.</p></div>
            <div className="wp-box"><b>2. Discovery and safety</b><p>Every new coin on Arc first, with its red flags on screen before the first buy.</p></div>
            <div className="wp-box"><b>3. Social</b><p>Follow, copy and compete with the best traders. Every win is shareable.</p></div>
            <div className="wp-box"><b>4. Access</b><p>Mobile first, local money and local languages. We start with East Africa, where mobile money and stablecoins already meet.</p></div>
          </div>
          <p>East Africa is a natural first market. Stablecoins make up about 43% of crypto transactions in Sub-Saharan Africa. Kenya ranks among the world’s leaders in everyday stablecoin use, and mobile money wallets can already link to crypto accounts.</p>
        </section>

        <section id="roadmap" className="wp-sec wp-break">
          <h2><span>7</span>Roadmap: a new phase every week</h2>
          <p>Seven phases, each shipped in 5–7 days, starting {startLong}.</p>
          <Roadmap />
          <p className="wp-note">† Built in the phase; goes live once a partner, an independent audit or a regulator allows it. Dates are targets and may move; progress is reported every week.</p>
        </section>

        <section id="arcd" className="wp-sec wp-break">
          <h2><span>8</span>$ARCD and the fee model</h2>
          <div className="wp-split">
            <table className="wp-table">
              <tbody>
                <tr><th>Name / symbol</th><td>ARCDEX · ARCD</td></tr>
                <tr><th>Network</th><td>Arc mainnet</td></tr>
                <tr><th>Contract</th><td><code>{ARCD}</code></td></tr>
                <tr><th>Total supply</th><td>1,000,000,000 — no mint function</td></tr>
                <tr><th>Launched on</th><td>Argus (Portal 8)</td></tr>
                <tr><th>Pool</th><td>ARCD / USDC · Uniswap v4 · <code>{short(ARCD_POOL)}</code></td></tr>
                <tr><th>Fee wallet</th><td><code>{FEE_WALLET}</code></td></tr>
                <tr><th>Burn address</th><td><code>{BURN_ADDRESS}</code></td></tr>
              </tbody>
            </table>
            <div className="wp-flow">
              {([
                ['You trade', 'Swaps, launchpad trades and bridges pay a small fee in USDC.'],
                ['Fees reach one public wallet', 'Anyone can watch the fee wallet on-chain.'],
                ['Buyback', 'The fee wallet buys $ARCD on the open market.'],
                ['Burn', 'Bought $ARCD goes to the burn address. No one can ever move it, so the supply only goes down.'],
              ] as [string, string][]).map(([h, b], i) => (
                <div key={h} className="wp-step"><span>{i + 1}</span><div><b>{h}</b><p>{b}</p></div></div>
              ))}
            </div>
          </div>
          <h3>Fees today</h3>
          <table className="wp-table wp-fees">
            <thead><tr><th>Source</th><th>Fee</th><th>Where it goes</th></tr></thead>
            <tbody>
              <tr><td>Swaps on ARCDEX</td><td>2% of each trade, in USDC</td><td>85% to buyback and burn; 15% to the trader’s referrer</td></tr>
              <tr><td>Launchpad trades</td><td>1% platform fee + the coin’s creator tax (0–3%)</td><td>The 1% and 40% of the tax to buyback and burn; 60% of the tax to the creator</td></tr>
              <tr><td>Bridge (Circle CCTP)</td><td>0.5% (min $0.05, max $50)</td><td>90% to buyback and burn; Circle keeps 10%</td></tr>
            </tbody>
          </table>
          <h3>From Phase 1</h3>
          <p>The swap fee drops from 2% to 1%. Traders get 5–25% of the fee back as USDC cashback, depending on their 30-day volume. Referrers keep earning 15%.</p>
          <p>Cashback and referral rewards are paid first, and everything the platform keeps still buys back and burns $ARCD. The on-chain router caps the swap fee at 2%, so it can never be raised above that.</p>
          <p className="wp-note">$ARCD is a community coin. Burning reduces supply but does not promise any price, value or profit.</p>
        </section>

        <section id="security" className="wp-sec">
          <h2><span>9</span>Security and trust</h2>
          <ul className="wp-list">
            <li><b>Self-custody.</b> Keys stay in the user’s browser, protected by a passcode and an optional passkey. ARCDEX never holds user funds.</li>
            <li><b>Rules in the contracts.</b> The swap router caps its fee at 2% and pays referral rewards inside the same transaction. It holds no funds after a swap. The launchpad enforces its anti-snipe limits on-chain.</li>
            <li><b>Automation with limits.</b> Phase 4 orders run from the user’s own wallet. The always-on orders and auto-copy of Phase 7 use session keys that can only trade through the ARCDEX router. Each key has per-trade and daily caps and an expiry, can be revoked in one tap, and can never withdraw.</li>
            <li><b>Reviewed before launch.</b> New contracts, such as session keys and Launchpad v2, go live only after an independent security review.</li>
            <li><b>Open books.</b> The fee wallet, buybacks and burns are public on-chain, and the burn dashboard shows them live.</li>
          </ul>
        </section>

        <section id="regulation" className="wp-sec">
          <h2><span>10</span>Regulation and responsible trading</h2>
          <ul className="wp-list">
            <li><b>Licensed partners for money in and out.</b> Card and mobile-money on-ramps run through licensed partners that handle identity checks (KYC) and anti-money-laundering (AML) controls.</li>
            <li><b>Market by market.</b> Features launch where they are permitted. That includes Kenya’s Virtual Asset Service Providers Act (2025) and its 2026 regulations, and the framework the Bank of Tanzania is preparing.</li>
            <li><b>Responsible-trading tools.</b> Daily loss limits and cool-downs arrive in Phase 7. ARCDEX shows risk scores on every coin before anyone trades it.</li>
          </ul>
        </section>

        <section id="metrics" className="wp-sec">
          <h2><span>11</span>What we will report</h2>
          <p>Every week we will publish, on the site and on X:</p>
          <ul className="wp-list">
            <li>trading volume and fees;</li>
            <li>cashback and referral rewards paid;</li>
            <li>$ARCD bought back and burned;</li>
            <li>active traders;</li>
            <li>progress on the current roadmap phase.</li>
          </ul>
        </section>

        <section id="disclaimer" className="wp-sec">
          <h2><span>12</span>Disclaimer</h2>
          <p className="wp-small">This document describes ARCDEX and its plans. It is not an offer to sell or a solicitation to buy any asset, and it is not financial, legal or tax advice. Meme coins are highly volatile and most lose value: only trade what you can afford to lose. $ARCD has no promise of value or profit. Roadmap items, dates and fees may change. Items marked † depend on partners, audits or regulators. ARCDEX is non-custodial software; users control their wallets and funds, and are responsible for complying with the laws where they live.</p>
          <h3>Sources</h3>
          <ol className="wp-sources">{SOURCES.map(([t, u]) => <li key={u}><a href={u} target="_blank" rel="noopener noreferrer">{t}</a><span className="wp-url"> — {u}</span></li>)}</ol>
          <p className="wp-small">Verify on-chain: <a href={`${ARC_EXPLORER}/token/${ARCD}`} target="_blank" rel="noopener noreferrer">$ARCD on the Arc explorer</a> · <a href={`${ARC_EXPLORER}/address/${FEE_WALLET}`} target="_blank" rel="noopener noreferrer">fee wallet</a> · <a href={`${ARC_EXPLORER}/address/${BURN_ADDRESS}`} target="_blank" rel="noopener noreferrer">burn address</a></p>
        </section>
      </article>

      <footer className="ld-footer wp-noprint">
        <div className="ld-foot-top">
          <a href="/" className="ld-brand"><img src="/arcdex-logo.svg" alt="" width={24} height={24} />ARCDEX</a>
          <nav>
            <a href="/">Home</a>
            <a href="/app">App</a>
            <a href="/launchpad">Launchpad</a>
            <a href="/burn">Burn dashboard</a>
            <a href={PDF} download>Whitepaper (PDF)</a>
          </nav>
        </div>
        <p className="ld-muted">© 2026 ARCDEX · Whitepaper v{VERSION}</p>
      </footer>
    </div>
  )
}

// ── images for X (screenshotted by scripts/whitepaper-assets.mjs) ──────

/** 1600×900: the announcement card. */
function CoverCard() {
  return (
    <div className="xcard xcard-cover">
      <div className="ld-glow ld-glow-a" /><div className="ld-glow ld-glow-b" />
      <div className="xcard-top"><img src="/arcdex-logo.svg" alt="" width={64} height={64} /><span>ARCDEX</span><em>Whitepaper v{VERSION}</em></div>
      <h1>The social trading layer for Arc</h1>
      <p>One fast, safe and social place to find, trade and launch every meme coin on Arc.</p>
      <div className="xcard-pillars">
        {([['💸', 'Price', '1% fee + USDC cashback'], ['🔎', 'Discovery & safety', 'Every new coin, red flags first'], ['👥', 'Social', 'Follow & copy the winners'], ['🌍', 'Access', 'Mobile money · 7 languages']] as [string, string, string][]).map(([i, h, b]) => (
          <div key={h}><span>{i}</span><b>{h}</b><small>{b}</small></div>
        ))}
      </div>
      <div className="xcard-foot"><span>🔥 Fees buy back &amp; burn $ARCD</span><span>7 phases · a new one every week</span><b>arcdex.online/whitepaper</b></div>
    </div>
  )
}

/** 1080×1350: the roadmap, one phase a week. */
function RoadmapCard() {
  return (
    <div className="xcard xcard-roadmap">
      <div className="ld-glow ld-glow-a" /><div className="ld-glow ld-glow-b" />
      <div className="xcard-top"><img src="/arcdex-logo.svg" alt="" width={52} height={52} /><span>ARCDEX Roadmap</span><em>a new phase every week</em></div>
      <div className="xcard-phases">
        <div className="xcard-phase live"><i>0</i><div><b>Live now</b><small>Terminal · launchpad · trading wallet · social · rewards · $ARCD burn</small></div></div>
        {PHASES.map(p => (
          <div key={p.n} className="xcard-phase"><i>{p.n}</i><div><b>{p.title}<em>{phaseRange(p.n)}</em></b><small>{p.items.map(x => x.text + (x.dep ? '\u00a0†' : '')).join(' · ')}</small></div></div>
        ))}
      </div>
      <div className="xcard-foot"><span>Each phase ships in 5–7 days · † needs a partner, audit or regulator</span><b>arcdex.online/whitepaper</b></div>
    </div>
  )
}
