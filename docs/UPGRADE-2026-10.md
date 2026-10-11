# ARCDEX upgrade, October 2026: audit and plan

Owner's brief (2026-10-11): read the ArcSense Upgrade Build Pack (`ArcSense_Upgrade_Build_Pack.pdf`/`.docx`,
`ArcSense_Claude_Code_Master_Prompt.md`, all three the same text) and liquid.trade, and "improve everything … we want
to compete with them … DO IT". This document is the pack's Phase 0: the audit, the architecture, the risks and the
phased plan. The owner's "DO IT" is taken as approval to build it, phase by phase, keeping the pack's rules.

## 1. Audit: what ARCDEX is today

- **Frontend:** React 18 + Vite + TypeScript, served by Netlify at arcsense.site (`netlify.toml`), Binance-style dark
  theme in blue. Routes in `src/arcdex/lib/router.ts`; pages in `src/arcdex/pages/`.
- **Backend:** the market engine (`engine/`, Bun, Railway): Arc chain ingestion, candles, WebSocket/REST, the site's
  read functions (`/api/*`), safety scans, signals, the paused Autotrade bots, the testnet futures keeper. Its own
  Postgres and Redis; Supabase holds the social data.
- **Wallets:** the in-browser trading wallet (a local EVM key, passcode-encrypted, optional passkey), external EVM
  wallets through wagmi (MetaMask, WalletConnect, Coinbase), Solana wallets (Phantom, Solflare, Backpack) with an EVM
  account derived from the wallet's signature. No seed phrase is ever asked for.
- **Chains and venues:**

  | Chain | Markets | Trades through |
  |---|---|---|
  | Arc | launchpad coins and established coins | ArcDexSwapRouter (v3/v4), the curve router, Uniswap's Universal Router |
  | Robinhood Chain | launchpad coins, stock tokens | Across (from Arc USDC) |
  | Solana | launchpad coins | Relay (SOL, Solana USDC or Arc USDC) |
  | BNB Chain | four.meme coins | four.meme's curve, Relay |
  | Arc testnet | BTC/ETH/SOL perps, 10× | ARCSENSE's own SensePerps pool (testnet only) |

- **Fees:** 2% on spot trades (router, Across `appFee`, Relay app fee), 0.5% on bridges, all to `0x2742…86Bb`.
- **Tests:** `bun run engine:test` (609 pass on 2026-10-06), `forge test`, and the `scripts/test-*.ts` suites.

## 2. Liquid: what it is, and what it has that ARCDEX lacks

liquid.trade was toured in the browser (read-only) on 2026-10-11. It is a front-end on **Hyperliquid**: every market,
order book, fill and position is Hyperliquid's (`api.hyperliquid.xyz`, plus Liquid's own socket proxy). Login is Privy
(email or social, with an embedded wallet), the chart is TradingView's licensed library.

- **Trade:** perpetuals on crypto (Hyperliquid's core dex) and on stocks, pre-IPO companies, indices, commodities and FX
  (Hyperliquid's builder-deployed "HIP-3" dexes: `xyz:TSLA`, `xyz:GOLD`, `xyz:SP500`, `io:OAI`, `io:ANTH`…), up to 50×.
  Terminal: a social trade feed with Copy Trade on the left; chart; positions, balances, predictions, open orders and
  history under it; order book and trades; an order panel (Market/Limit/Advanced, Long/Short, size, leverage slider,
  reduce-only, TP/SL, isolated/cross).
- **Predict:** Hyperliquid's "HIP-4" outcome markets (`proxy.liquidmax.xyz/api/prediction_markets?provider=hip4`):
  15-minute and 1-day up/down markets on crypto and stocks, "touches $X" markets, sports, economics, IPOs. Same USDC
  account as the perps.
- **Also:** a leaderboard (PnL, volume, directional bias, top asset), Earn (a Gauntlet USDC vault), an economic
  calendar, Co-Invest, Agents (trade from ChatGPT or Claude), a bottom bar (Feed, Chat, Watchlist, PnL, Hours, Layout),
  an affiliate program, iOS and Android apps.
- **How it earns:** Hyperliquid's builder codes: a front-end adds its own fee to every order it sends (up to 0.1% on
  perps, 1% on the sell side of spot and outcome trades), paid out on-chain.

**The gap:** ARCDEX's futures are testnet-only and cover 3 coins; it has no stocks, commodities, FX or pre-IPO
markets, and no prediction markets. Liquid's whole offering is one integration away: Hyperliquid's public API, signed
in the browser by the user's own wallet.

## 3. Build pack items, against what exists

| Pack item | Status before | Plan |
|---|---|---|
| Provider adapters, chain/route registry | spread across `lib/` per venue | a typed route registry and a public "Supported routes" page |
| Prediction markets with real orders | none | Hyperliquid HIP-4 (official API, signed by the user's wallet); Polymarket later as a second adapter |
| Starknet-native swaps (AVNU) | none; ARCDEX has no Starknet presence | a later phase: a Starknet wallet and AVNU quotes and swaps on their own page |
| Cross-chain routes with lifecycle tracking | Relay, Across, CCTP, with quote checks | the same checks extended to Arc ↔ Hyperliquid |
| Speed (streaming, caching, measurable) | engine sockets, route prefetch, image cache | Hyperliquid's own WebSocket for books, trades, candles and fills |
| Strategy Lab (paper first, server-side risk) | the engine's bots, paused | price alerts and paper strategies first, after the venue work |
| Portfolio, alerts, retention | per-chain sections | a Hyperliquid section (positions, orders, outcome holdings), last sync time |
| Security and compliance | quote checks, exact approvals, geo gate for stocks | a geo gate for Hyperliquid, server-free signing, no secrets in the page |

## 4. Architecture

```
  Browser (arcsense.site)                                        Hyperliquid
  ┌──────────────────────────────────────────────┐   /info  ┌─────────────────────────┐
  │ pages: Perps · Predict · Markets · Swap · …   │─────────▶│ markets, books, candles, │
  │ src/arcdex/hl/                                 │   /ws    │ user state, fills        │
  │   client.ts   info + WebSocket (shared subs)  │◀────────▶│                         │
  │   markets.ts  perps (core + HIP-3), outcomes  │ /exchange│ orders, cancels,         │
  │   signing.ts  EIP-712 (L1 + user-signed)      │─────────▶│ leverage, approvals      │
  │   trade.ts    order wires, rounding, builder  │          └─────────────────────────┘
  │   account.ts  balances, positions, orders     │
  │   access.ts   agent key, builder approval,    │   Relay (quotes checked like every
  │               the geo gate                    │   other route): Arc USDC ⇄ Hyperliquid
  │   funding.ts  deposit / withdraw via Relay    │──────────────────────────────────▶
  └──────────────────────────────────────────────┘
       signs with: the trading wallet's own key (no pop-ups), or an external wallet once
       (approve an in-browser agent key that can trade but never withdraw).
```

Nothing new runs on the engine for Hyperliquid: its API allows browser calls (CORS `*`) and rate-limits by the
visitor's own IP, so no shared server quota can be exhausted (the problem GeckoTerminal had).

## 5. Risks and the rules kept

- **Real money, real venue.** Orders go to Hyperliquid mainnet, signed by the user. Nothing is simulated or invented:
  prices, books, fills and positions are Hyperliquid's. Market orders are IOC limit orders with a slippage cap.
- **Signing correctness.** Hyperliquid's signing is easy to get wrong. The implementation follows the official Python
  SDK and is checked against the SDK's own test vectors; a live check signs with a throwaway key and confirms the
  venue recovers that key's address.
- **Keys.** The trading wallet signs locally, as it already does on Arc. For external wallets, an agent key is made in
  the browser and approved once by the wallet; Hyperliquid agents can trade but can't withdraw. Withdrawals are always
  signed by the main wallet.
- **Eligibility.** Hyperliquid's terms exclude US persons, Ontario and sanctioned territories. Opening positions and
  depositing are blocked there (by the edge's country, as the stock-token gate does); closing positions, cancelling
  and withdrawing are never blocked, so nobody is trapped.
- **Builder fee.** Hyperliquid pays builder fees only to a builder address with 100+ USDC in its perps account and in
  standard mode. The fee wallet holds nothing there today, so orders go out without a builder fee until the owner funds
  it; the page checks this live.
- **Leverage.** Shown as leverage, with the liquidation price before every order; the default is low (3×), or an open
  position's own.
- **Automation stays off.** No strategy trades by itself. The Strategy Lab starts with alerts and paper trading.

## 6. Phases

1. **Hyperliquid core** (`src/arcdex/hl/`): info client and shared WebSocket, signing with the SDK's vectors, markets
   (core perps, the USDC-settled HIP-3 dexes, HIP-4 outcomes with readable titles), order wires and rounding, account
   state, agent and builder approval, the geo gate. Tests: `scripts/test-hyperliquid.ts`; live:
   `scripts/check-hyperliquid.ts` (no funds). **Done.**
2. **Perps terminal** (`/futures`, also `/perps`; Liquid's layout in ARCDEX's colours): market list by category
   (Crypto, Stocks, Pre-IPO, Indices, Commodities, FX), chart with live candles, order book and trades, the order panel,
   positions, orders and history. The testnet futures moved to `/futures/testnet`. **Done.**
3. **Predict** (`/predict`): outcome markets by category, Yes/No with live prices and countdowns, real orders,
   holdings and fills; settlement is automatic. **Done.**
4. **Funding:** deposit Arc USDC into the Hyperliquid account and withdraw back to Arc through Relay, with checked
   quotes, both shown with their fees and time. **Done.**
5. **Portfolio and navigation:** Hyperliquid in Portfolio; Futures and Predict in the top bar, the phone tabs and the
   home page. **Done.** The "Supported routes" page is still to come.

Trading ships switched off (`VITE_HL_TRADING`, the pack's "no mainnet execution by default"): the pages show every
market, price and account, and send nothing until the owner turns it on. Details: AGENTS.md, "Hyperliquid: futures on
every market, and predictions".
6. **Strategy Lab:** price alerts and paper trading, server-side limits, off by default.
7. **Starknet:** a Starknet wallet and AVNU swaps, once their current docs and SDKs are verified.

Each phase lands as its own commit with its tests run, and is recorded in AGENTS.md.

## 7. Owner actions

- **Switch trading on** when ready: `VITE_HL_TRADING=on` in Netlify, then redeploy. Until then nothing is sent to
  Hyperliquid.

- **Builder fee:** send 100+ USDC to the fee wallet `0x2742…86Bb`'s Hyperliquid perps account (keep it in standard
  mode). Until then trades carry no ARCDEX fee.
- **Legal:** offering leveraged perpetuals and prediction markets has legal and licensing implications that depend on
  where ARCDEX and its users are. Take advice before promoting them; the geo gate is a minimum, not legal clearance.
