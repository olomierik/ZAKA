# ZAKA + ARCDEX

> Built with Arc Studio - money-powered apps in minutes

Two apps in this repo:
- **ZAKA** — USDC mobile wallet for African markets (send, receive, withdraw to mobile money)
- **ARCDEX** — DexScreener-style DEX terminal for Arc mainnet (token terminal, swap, portfolio)

---

## Deployed Contracts

### ArcDexSwapRouter — the mainnet swap router
- **v2 — LIVE on Arc mainnet (current)** at `0xD07583f7DB671521AAcFdA2b4612AD187aA2924e` ([explorer](https://explorer.arc.io/address/0xD07583f7DB671521AAcFdA2b4612AD187aA2924e)).
  - **Fees:** `feeBps` 200 (2%, which is also `MAX_FEE_BPS`); `referralShareBps` 1500 (15% of the fee to the trader's referrer, capped at 50%).
  - **Referrer:** bound permanently on a wallet's first referred swap.
  - **Deployment:** deployer nonce 3, from owner `0x414B…c3dA`, with `feeWallet` `0x2742…86Bb`; not paused.
  - **Verified:** after deploy, the runtime bytecode matched the tested build apart from its immutables, and every getter was read back.
  - **Config:** `VITE_ARCDEX_SWAP_ROUTER_ADDRESS` is set on Vercel project `app` and in `.env`.
  - **ABI:** v2 swap functions take a trailing `address referrer`. The frontend reads `VERSION()` and picks the ABI.
- **v1 — superseded:** `0xC519B929981f5375D67Ab3930fFB100f0a606088`, 1%, no referrals. It stays deployed, and the indexer still reads its past trades from block 22548761.
  - Details below describe the shared design; the 1% figures are v1's.
  - v1 was verified the same way when it went live ([explorer](https://explorer.arc.io/address/0xC519B929981f5375D67Ab3930fFB100f0a606088)). Owner `0x414B6Be4CF906739FbF7D49165beCa5F4CeEC3dA` (same deploy-only wallet as ArcLaunchpad), `feeWallet` `0x274262A0321A0701b0A46a3576e07aE881c286Bb`, `feeBps` 100, not paused. After deploy, the on-chain runtime bytecode was verified identical to the tested build, apart from its immutables. Every config getter was read back. `VITE_ARCDEX_SWAP_ROUTER_ADDRESS` is set in `.env` and Vercel production. Vercel stores it as *sensitive*, so `vercel env pull` shows it empty; check the deployed bundle instead.

`contracts/ArcDexSwapRouter.sol`. Buys/sells any Argus coin (and $ARGUS) from the app, taking a 1% fee **in USDC** on every swap: off the input on buys, off the output on sells. Fee goes straight to `feeWallet` (default `0x274262A0321A0701b0A46a3576e07aE881c286Bb`), no accrual; `feeBps` is owner-adjustable but hard-capped on-chain at `MAX_FEE_BPS = 100`.
- `swapExactInV4(PoolKey[] keys, tokenIn, amountIn, minAmountOut, deadline)`: 1–3 hop Uniswap v4 path, run inside `PoolManager.unlock`. USDC-quoted launches are 1 hop; ARGUS-quoted launches are 2 hops through the ARGUS/USDC v4 pool (`USDC, ARGUS, fee 9850, tickSpacing 99, no hook`).
- `swapExactInV3(tokenIn, tokenOut, poolFee, amountIn, minAmountOut, deadline)`: via the real Arc SwapRouter02 at `0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77` (struct **without** `deadline`, selector `0x04e45aaf`).
- Constructor: `(PoolManager 0x8366a39CC670B4001A1121B8F6A443A643e40951, SwapRouter02 0x53BF…6F77, USDC 0x3600…0000, feeWallet, owner)`.
- **Deploy:** `PRIVATE_KEY=… scripts/deploy-swap-router.sh` (owner = the deploying wallet; `FEE_WALLET` / `RPC_URL` optional overrides), then set `VITE_ARCDEX_SWAP_ROUTER_ADDRESS` in `.env` and Vercel production and redeploy. Until it's set, the Argus swap widget renders disabled with "Trading opens once the ARCDEX swap router is deployed."
- **Tests:** `forge test --match-contract ArcDexSwapRouterTest` (16 unit tests, incl. fuzz: fee ≤ 1%, router never retains funds).
- **Real-pool simulation:** `forge build && node scripts/sim-swap-router.mjs`. It injects `contracts/test/sim/ArcDexRouterSimHarness.sol` via `eth_call` state overrides against Arc mainnet: real Argus hooks, real pools, no funds or keys. It checks buy, sell round trips and the 2-hop route, and that the fee wallet gets exactly 1%. A Foundry fork test can't be used: Arc USDC forwards transfers to a precompile at `0x1800…` that Foundry doesn't implement.

### ArcDexRouter — RETIRED, do not deploy to mainnet
The old `ArcDexRouter` (testnet `0xefa4f596da0c2acfcba47b43389be26e96912516`) points at `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, which is **not** a swap router on Arc, and encodes the SwapRouter (v1) struct with `deadline`. Every mainnet swap through it would revert. `scripts/deploy-mainnet.sh` now just explains this and exits. Use ArcDexSwapRouter above.
- The old `SwapWidget.tsx` (Swap page, non-Argus token pages) used to read `VITE_ARCDEX_ROUTER_ADDRESS`. Vercel production had it set to the **testnet** address above, which is an empty account on mainnet. Users were asked for unlimited USDC approval to it, and "swaps" to it succeeded while doing nothing. It was deleted on 2026-09-26.
  - **Replaced by `components/TokenSwap.tsx`** (Swap page and `TokenPage`): launchpad coins trade on their curve (`CurveSwapWidget`); anything with a USDC or ARGUS pool trades through ArcDexSwapRouter (`ArgusSwapWidget`); otherwise it says there's no route.
  - At switch-over, all 30 of the most-traded coins routed (v4 via USDC).
- One mainnet approval to `0xefa4…2516` exists: 2 USDC from `0x2742…86Bb`. It was found by scanning 3 days of USDC `Approval` logs, and the owner should revoke it with `approve(0xefa4…, 0)`.

### ArcLaunchpad
Self-contained bonding-curve launchpad — no separate LaunchToken deploy needed, `createToken()` deploys each token itself. See `contracts/ArcLaunchpad.sol` for full design notes (why graduation doesn't migrate to an external Uniswap pool, why anti-snipe/anti-bundle are USDC-denominated not token-%-based).
- **Status: LIVE on Arc mainnet.** 28/28 tests passing (incl. 10,000-run fuzz on `testFuzz_buySellNeverBreaksInvariants`) via `forge test --match-contract ArcLaunchpadTest`, deployed and verified on-chain (state read back and cross-checked against expected values post-deploy).
  - **Address:** `0xEf6a8fdaF0181E19CC2C7575ada4b9c279809a67`
  - Explorer: https://explorer.arc.io/address/0xEf6a8fdaF0181E19CC2C7575ada4b9c279809a67
  - Owner: the deployer wallet (`0x414B6Be4CF906739FbF7D49165beCa5F4CeEC3dA`) — dedicated deploy-only wallet, not the project's main wallet
  - `platformFeeWallet`: `0x274262A0321A0701b0A46a3576e07aE881c286Bb` (same wallet as `ArcDexRouter`'s fees, per the default)
  - `VITE_ARC_LAUNCHPAD_ADDRESS` is set in Vercel production and `.env`
- **Redeploy / reference:** `scripts/deploy-launchpad.sh` — bytecode is in `contracts/out/ArcLaunchpad.sol/ArcLaunchpad.json`. Defaults `PLATFORM_FEE_WALLET` to `0x274262A0321A0701b0A46a3576e07aE881c286Bb` — override the env var if you ever want fees going elsewhere.
  - Constructor args used: `(0x414B6Be4CF906739FbF7D49165beCa5F4CeEC3dA, 0x274262A0321A0701b0A46a3576e07aE881c286Bb)`
- **$3 launch fee (owner decision, 2026-09-26) — collected by the app, not the contract** (`lib/launchFee.ts`):
  - The launch form first sends a $3 USDC transfer to `platformFeeWallet`, then launches. The contract is immutable and has no creation fee, so a direct `createToken` call skips it; enforcing it on-chain needs a new launchpad contract that the owner deploys.
  - If the fee goes through but the launch doesn't, the payment is kept as a credit for that wallet in that browser (7 days), and the next launch doesn't charge again.
  - The form works with the trading wallet too (it used to need an external wallet). It shows the fee, the initial buy and the total, checks the balance first, and opens the new coin's page after launch.
- **Fees — two additive layers, paid directly out of every trade, no accrual:**
  - 5% of each token's 1B supply → `platformFeeWallet` at creation (95% seeds the curve). No flat USDC creation fee in the contract (the $3 above is the app's).
  - Platform swap fee: fixed 1%, always, 100% to `platformFeeWallet`.
  - Creator tax: 0-3%, the creator's choice, fixed forever once launched — 60% straight to the creator's wallet, 40% to `platformFeeWallet`.
  - Worst case total per trade: 4%.
- **Launch and trade data — `/api/launchpad` (`api/_launchpadCore.ts`):** every `TokenLaunched` (with its metadata: image, description, socials) and `Trade` since the deploy block (22,461,045), kept in `arcdex_kv`, scanned incrementally, CDN-cached. `?token=` adds that coin's trades.
  - The browser's old lookups failed on the public RPC (one getLogs over the whole chain for metadata, 50k blocks for trades): no images, trades or charts. The browser now reads the index, with a direct chain scan as fallback (local dev, outages).
  - Tests: `bun scripts/test-launchpad-index.ts` (decoding, metadata safety, live endpoint).
- **Logo uploads — `/api/upload`:** signed-in wallets only (the `/api/session` token), 30 a day per wallet. PNG/JPEG/GIF/WebP up to 2 MB, sniffed from the bytes (no SVG); metadata sanitized. Stored in Supabase Storage bucket `launchpad-media`, created on first use. If an upload fails, the form falls back to an image link and inline (`data:`) metadata. Tests: `bun scripts/test-upload.ts` (mocked Supabase).
- **Approvals are exact** everywhere: `CurveSwapWidget`, one-tap `quickTrade.ts` (which also has a 5% minimum-out now, it had none), token creation. Trades are simulated before sending, and the launchpad's revert errors are shown in words.
- **Coin links open the right page (`pages/CoinPage.tsx`, `lib/launchpadCoins.ts`):** every `/token/0x…` link (search, discovery panel, feed, profiles, clans, a reload) used to open the Argus coin page, where a launchpad coin has no pool: "No routable pool", nothing to buy. The app now fetches the launchpad's coin list at start and opens launchpad coins on their curve page.
- **Buying was verified end to end on 2026-09-26** (local dev; each transaction simulated on mainnet with state overrides, nothing sent): external wallet left on Base (switched to Arc, approved $5, bought) and trading wallet (approve nonce 0, buy nonce 1). See "Sending transactions" below.
- **Buyback-and-burn is manual and off-contract, by design** — there is no on-chain treasury. To buy back the platform's own token: launch it through the UI like any other token, then from `platformFeeWallet` call `buy()` on ArcLaunchpad, then call `burn(amount)` on the token itself (`LaunchToken` is `ERC20Burnable`).
- **Anti-rug / anti-bot, all enforced on-chain:**
  - Anti-snipe: buys capped at $2,000/tx for the first 10 minutes after launch (`SNIPE_MAX_BUY_USDC`, `SNIPE_WINDOW_SECONDS`).
  - Anti-bundle: total buys capped at $5,000/block across ALL wallets (`MAX_USDC_PER_BLOCK`) — this is what actually stops multi-wallet bundlers, since per-wallet caps alone don't.
  - Anti-bot: `buy`/`sell`/`createToken` require `msg.sender == tx.origin`, blocking any contract-mediated call. This stops contract-based sniper/wash-trading bots specifically — it cannot stop a human wash-trading by hand across several of their own real wallets, and the contract's own doc comment says so rather than overclaiming.
  - No emergency-withdrawal function of any kind — real reserves have no path out except a user's own `sell`.
- $25,000 real-USDC graduation threshold — a status flag only; the same curve prices every trade before and after it, so there's no migration step and no price discontinuity.
- Once the platform's own token is launched through the UI and burns have started, set `VITE_ARC_PLATFORM_TOKEN_ADDRESS` to power the burn ticker.

### Bridge — `src/arcdex/pages/Bridge.tsx`, `src/arcdex/lib/bridgeKit.ts`
Both directions, via Circle CCTP v2 (Bridge Kit), with Circle's Forwarder minting on the destination (Arc is a supported forwarder destination, domain 26):
- **Deposit to Arc (chain X → Arc):** the external wallet signs approve + burn on X. `ensureWalletChain` switches it to X, adding X first if the wallet doesn't know it (4902), and switches back to Arc afterwards. The default recipient is the trading wallet. Deposit → "From another chain" opens `/bridge?dir=in`.
- **Send from Arc (Arc → chain X):** from the connected wallet or, one-tap, the trading wallet (`tradingWalletAdapter`, a `ViemAdapter` over its local account, Arc only). Solana is a destination only and needs a Solana address.
- **Quotes before signing:** `quoteBridge` prices the route with Circle's estimate (a throwaway, never-funded account; it never signs) and shows Circle's fees, our fee, what leaves the wallet and what arrives. Measured 2026-09-26 for $10: Arc → Base, Circle $0.055; Base → Arc $0.016; Arc → Ethereum $100, $1.49. Live progress (approve, burn, attestation, mint) and Retry use the kit's events and `kit.retry`.
- **Fixed 2026-09-26 (why sending from the trading wallet failed):** in a browser the kit's `ViemAdapter` asks the wallet to switch chains before each step (`wallet_switchEthereumChain`). The trading wallet signs locally, so that request went to Arc's RPC ("method not supported") and the approve step failed every time. `localChainSwitch` answers it in-app. Also:
  - The kit gets lag-tolerant clients (see "Sending transactions").
  - Approve and burn are always two plain transactions (`batchTransactions: false`), not an EIP-5792 batch that asks MetaMask to switch to a smart account.
  - A failed step shows why.
  - WalletConnect sessions include the bridge chains (`wagmi.ts`), so a phone wallet can switch to Base to sign a deposit.
- **Checked:** the kit's Arc → Base and Base → Arc transactions, dry-run against mainnet with a throwaway account (every transaction simulated with state overrides), and the trading wallet's Arc → Base in the browser, up to the attestation.

Fees: Circle's Bridge Kit has a native mechanism for this (`kit.setCustomFeePolicy`), used instead of a hand-rolled side-transfer. `computeBridgeFee()`: 0.5% of the transfer, bounded to [$0.05, $50]. Bridge Kit adds this **on top of** the transfer amount (wallet debits `amount + fee`, shown in `Bridge.tsx` before signing) and auto-splits it 10% to Circle / 90% to `PLATFORM_FEE_WALLET` — that 10/90 split is Circle's own mechanic on `CustomFeePolicy`, not something this app controls. Only applies to USDC (Bridge Kit rejects a custom fee policy on non-USDC tokens), which is all this app bridges.

### Sending transactions — `lib/tx.ts`, `lib/rpc.ts` (2026-09-26)
Why buys, swaps and bridges failed for people, and the fixes:
- **Wrong network.** wagmi refuses to send while the wallet is on another chain ("does not match the target chain"). `sendArc()` (used by every trade, launch, cash send and burn) first puts an external wallet on Arc (`ensureArc`, adding Arc if needed). A slim `NetworkGuard` bar offers "Switch to Arc" (hidden on /bridge, which switches on purpose).
- **Lagging RPC nodes.** Arc's public RPC answers from nodes that can trail by a block (6 of 240 requests, measured). Right after an approval, the trade's simulation, gas estimate or `eth_fillTransaction` (viem 2.5x fills local-account transactions with it) could land on a node without the approval → "transfer amount exceeds allowance".
  - `lagTolerant()` retries exactly those failures (4 tries, 600ms apart).
  - It wraps the shared `client`, the wagmi Arc transport, the trading wallet and the Bridge Kit clients.
  - `waitForAllowance()` waits until an approval is visible before the trade.
- **Trading-wallet nonces.** The same lag made the trade reuse the approval's nonce. The trading wallet's nonce is now at least one past the last it broadcast in this tab (`recordBroadcasts` + `walletNonces` in `embeddedWallet.ts`). viem's own nonceManager misses this when that nonce is 0: a new wallet's first approval.
- **Phones.**
  - Connect Wallet opened *behind* the Buy sheet. Layering is now: sheets 1100, modals 1200, wallet prompt 1250, WalletConnect's modal 1300 (`--wcm-z-index`).
  - With WalletConnect on a phone, a pending request shows "Confirm in <wallet> · Open", a button that opens the wallet app (`WalletPromptHost`). Browsers only follow app links on a tap.
- **Local test wallet.** Buys, swaps, launch and bridge were checked in local dev with an in-page EIP-6963 test wallet. It never signs: each transaction is simulated against mainnet with state overrides, funded and approved, and gets a made-up receipt. The external-wallet version started on Base to exercise the switch.

### Charts — `components/PriceChart.tsx` (2026-09-26)
- Trades are text, not avatar circles (owner's request).
  - Buys show "+$500" in green just above the line; sells "-$250" in red just below.
  - **The chart stays clean (owner's request, round 2):** history is never drawn. A swap pops up only when it arrives live (`ChartTrade.live`, set by the page for swaps that came in after it opened, within 60s of happening). The same swap from GeckoTerminal and the chain pops once (keyed by transaction and side).
  - **Pops fly (owner's request, round 4):** each pop lasts 2 seconds (`POP_MS`, CSS `trade-fly`). It is fully readable for the first second, then flies off upward while it fades.
    - Buys and sells both fly upward, each in its own direction: up to 45° either side of straight up, 80–150px, set by `lib/chartMotion.ts` `flightOf`.
    - The direction is fixed per trade, so pops landing together scatter, and every pop shows (none is dropped for overlapping).
    - With reduced motion turned on, pops just fade.
  - Theses are off by default; the Thesis overlay turns them on.
  - Your own trades get a yellow outline.
  - Placement: yours, then theses, then the largest trades; overlapping labels are dropped (28 on phones, 70 on desktop).
- **Fits itself (owner's request, round 4):** every candle of the chosen timeframe fits the window, and changing the timeframe is all anyone needs to do.
  - `fitContent()` runs on load, on each new candle and on each history refresh.
  - The price axis goes back to auto on a new timeframe, coin, Price/MCap view or style.
  - The time scale can't scroll past the first or last candle, and a resize keeps the fit (`fixLeftEdge`, `fixRightEdge`, `lockVisibleTimeRangeOnResize`).
  - Someone who drags, pinches or wheel-zooms keeps their view until they change the timeframe; a double-click fits it again. The old "last 140 bars" window is gone.
  - The GeckoTerminal embed opens on the timeframe that fits the coin's whole life in about 60–120 candles (`fitResolution`: under 2h → 1m … over 60 days → 1d). Its own toolbar still switches timeframe.
- Like fomo's chart:
  - A legend: coin · timeframe, then the value under the crosshair and its change from the bar before.
  - % / log / auto scale buttons and a UTC clock under the chart.
  - Market cap by default (remembered).
  - Caps under $100K in full dollars on the axis.
- Launchpad coins use this chart too (the old `CurveChart` is gone), priced from the curve's reserves after each trade.

### Phone home and desktop nav (2026-09-26)
- **Phone home** (`components/MobileHome.tsx`, top of the Terminal on phones), like fomo's app:
  - Your cash with Deposit; with no wallet yet, "Get started" opens the trading wallet.
  - A side-scrolling strip of the week's top traders: PnL if positive, else volume.
- **Desktop nav** has Swap and Bridge. Below 1180px wide, Feed, Leaderboard, Clans and Rewards drop out of the top bar; they stay in the left panel and the account menu.

### Trading wallet: withdraw, Portfolio, GeckoTerminal chart (2026-09-26)
- **Withdraw from the trading wallet.** The Trading wallet panel has Deposit and Withdraw, and a link to Portfolio. The account menu has Portfolio and Withdraw. The phone home has Withdraw under the cash.
- **Passcode rule (owner decision): money leaving the trading wallet for anywhere but the wallet that funded it needs the passcode** (and the passkey with 2FA on). This covers Withdraw, sending a coin, Send cash to a trader and Bridge → Send from Arc.
  - Rule and funding wallets: `lib/funding.ts`. The UI is `components/WithdrawGuard.tsx`. `verifyPasscode()` is in `embeddedWallet.ts`.
  - A funding wallet is an ordinary account (no contract code; EIP-7702 counts) that sent USDC to the trading wallet. Mints (bridge arrivals) and contracts paying out (sells) don't count.
  - Found in the last ~2 days of USDC Transfer logs: three 100k-block calls to Blockdaemon, never the archive fallback (`lib/recentLogs.ts`).
  - Funding wallets found are kept in localStorage, signed by the trading wallet's own key, so an edited list is rejected. Not found means the passcode is asked.
  - Free destinations: a funding wallet, and the trading wallet's own address (bridging to itself on another chain). An external wallet is never asked, because it confirms every transfer itself.
- **Portfolio (`pages/Portfolio.tsx`, `lib/portfolio.ts`) uses the unlocked trading wallet, else the connected wallet.** It used to only ask to connect a wallet.
  - It shows USDC cash and every coin held, valued live, with Sell to USDC (`TokenSwap` in a sheet, sell mode) and Send on each coin.
  - Coins checked:
    - coins bought from this browser (`lib/held.ts`, recorded by both swap widgets and quick buys);
    - router trades from Supabase;
    - the market list and the launchpad coins;
    - tokens sent to the wallet in the last ~2 days.
  - Balances are read by multicall. Prices come from the market list, the curve, else GeckoTerminal.
- **Coin page chart:** GeckoTerminal's own live chart is embedded by default (`components/GeckoChart.tsx`), as argus.world shows it ("Powered by GeckoTerminal"). "ARCDEX chart" switches to `PriceChart` (trade pops, theses, indicators), and the choice is remembered. `PriceChart` refreshes its GeckoTerminal candles every 30s, down from 90s (it goes through `/api/gecko`, which uses the paid key).
- **Tests:**
  - `bun scripts/test-withdraw-guard.ts`: the rule, funding detection and tamper-proof storage.
  - `bun scripts/test-portfolio.ts`: which coins are checked and how they're priced.

### Risk scores, faster confirmations, a live Terminal (2026-09-26, round 3)
- **Risk score on every coin (`lib/risk.ts`, `components/RiskBadge.tsx`):** 0–100, higher is riskier. Low under 30, Medium 30–59, High 60+. Hovering the badge lists the reasons; the Safety check spells them out for phones.
  - **Terminal rows and phone cards** are scored from the market data they already carry, with no extra requests: liquidity, market cap ÷ liquidity, age, holders, 24h trades, the 24h move, sells vs buys, copycat tickers, and "a bigger coin uses the same ticker".
  - On a launchpad curve, liquidity counts half, because it can't be pulled. Bonded coins get −5.
  - **Coin pages** add their own checks, so their score can be higher than the Terminal row's:
    - GeckoTerminal's honeypot flag (always 100) and trust score;
    - the top-10 share;
    - the dev's holdings and sells (`useDevPct`, lifted out of `SafetyPanel`);
    - creator tax;
    - the launchpad's launch-buyer bundling check.
  - The badge sits in the coin header and the Safety check; launchpad pages also show it in the stats row.
  - The Terminal has a RISK column and "Sort: risk" (safest first).
  - Tests: `bun scripts/test-risk-pulse.ts`.
- **Faster confirmations.**
  - **Why it was slow:** Arc's chain definition had no `blockTime`, so viem assumed Ethereum's 12s blocks and polled every 4s. Each confirmed transaction was noticed up to ~4.3s late, so a buy that needed an approval waited about 8.5s for nothing.
  - **Chain definition:** `arc` now declares `blockTime: 500`, which gives viem and wagmi 500ms polling. It also declares `contracts.multicall3`.
  - **`lib/receipts.ts` `waitForReceipt()`** is used by every trade, approval, transfer, launch and burn.
    - It asks both the public RPC and Blockdaemon for the receipt every 250ms and takes the first answer.
    - It never asks an endpoint again while that endpoint still owes an answer.
    - Simulated with 0.5s blocks: about 0.56s to notice a confirmation, against about 4.26s before.
  - **`lib/balances.ts`:** when a receipt lands, every balance on screen refreshes at once (header cash, the Trading wallet panel, both swap widgets and Portfolio). It fires again 1.2s later in case the first read hit a node one block behind.
  - **The shared read client (`api/launchpad.ts` `client`)** batches concurrent reads into one Multicall3 call (`batch: { multicall: true }`). It uses `arcReadTransport()`, which falls back to Blockdaemon when the public RPC throttles or fails.
    - A revert is never retried on the other endpoint.
    - Writes (the trading wallet and wagmi) still go only to the public RPC.
- **A live Terminal (`api/marketPulse.ts`).**
  - One WebSocket to Arc carries up to three log subscriptions: every v4 swap (through the PoolManager, where Argus coins trade), swaps in the listed v3 pools only (not every stablecoin pair's arbitrage), and ArcLaunchpad trades.
  - Each swap is matched to a listed coin by pool (`ArcToken.quoteAddress`, new) and decoded with `decodeSwapLog`.
  - The coin's row or phone card flashes green on a buy and red on a sell. There are two alternating animations per side, so back-to-back trades each restart the flash.
  - Updates are batched every 150ms.
  - The "● live" badge counts trades per minute.
  - With the market engine connected, a trade the socket missed still flashes: the engine's trade count going up, with the side taken from the price move.
- **Lint:** `SortTh` moved out of the Terminal's render, so headers aren't remounted on every render.

### Compact forms and pages (2026-09-26, round 2)
- Swap and bridge forms are 420px at most (`.form-page`, `.swap-box`, `.swap-input`, `.swap-info`, `.swap-note`), with smaller inputs, presets and buttons.
- Content pages (Rewards, Burn, Clans, Feed, Transfers, Alerts, Leaderboard) share `.content-page` (centered, `--page-w`, 820px by default) and `.page-h` titles. Stat cards, the Portfolio total, the PnL chart and the profile banner are smaller.
- Other trade ages (Feed, discovery, trader pages, Rewards history, launchpad trades) count up live too.
- Not changed: at 1181–1340px wide the coin page's chart column is narrow (both side panels are open). Collapsing the Tokens panel on coin pages would fix it; that's a layout decision for the owner.
- **Tests:**
  - `bun scripts/test-live-trades.ts`: ages, merging GeckoTerminal's swaps with the chain's, and the live holder count.
  - `bun scripts/test-chart-motion.ts`: pop flights and the embed's timeframe by age.

## Argus integration (ARCDEX)

Every Argus coin across all 8 Portals, live, the way argus.world does it: **GeckoTerminal is the primary data source; Arc RPC fills in only what GeckoTerminal doesn't carry.**

- **Market list — `api/argus.ts` (edge).** Server-side aggregator of GeckoTerminal. Sources: $ARGUS's own pools, which also carry the ARGUS-quoted launches; the `argus` dex pools by 24h volume; and new pools. One row per token, its deepest pool. CDN-cached `s-maxage=60`; partial results (some calls throttled) are cached only 15s. It works to a 17s time budget, so a throttled upstream yields a shorter list, never a timeout.
  - **Stored list (v4 `arcdex_kv`):** the last list is kept in Supabase and served at once (~0.2s); a stale one is rebuilt in the background (`waitUntil`). A throttled rebuild keeps coins it missed for 15 minutes. Before the v4 migration, a cold CDN still means a 10–17s build.
  - The browser keeps the last list too (`localStorage` `arcdex:market:v1`, ≤24h), so a returning visitor's Terminal paints instantly.
  - `/api/gecko` saves each good GeckoTerminal answer to `arcdex_kv` and serves that copy (≤6h old, `X-Arcdex-Age` header) when GeckoTerminal throttles, instead of passing the 429 to the browser.
  - GeckoTerminal quirk: on `/tokens/{X}/pools`, `fdv_usd`/`market_cap_usd` describe **X**, not each pool's base. Those caps are dropped and refilled from `/tokens/multi/…`.
  - The Terminal merges refreshes, so a short (throttled) list doesn't remove coins; a coin drops out after 10 minutes unseen.
- **Token page — `src/arcdex/pages/ArgusTokenPage.tsx`**, opened for any Terminal row with `launchpad === 'Argus'`.
  - **Straight from the chain (`src/arcdex/api/poolSwaps.ts`):** every swap in the pool. History comes from `eth_getLogs` on Blockdaemon, newest first and drawn as it arrives. Each new swap is pushed over Arc's WebSocket the moment its block lands, and gaps after a reconnect or a background tab are backfilled.
    - Swaps drive the live price (the pool price after the last swap), the Swaps list, the chart's candles (1s/15s on-chain only; 1m+ merged onto GeckoTerminal's older candles, `lib/candles.ts`) and the chart's trader avatars.
    - Makers are each transaction's sender, batch-fetched. ARGUS-quoted coins are priced through the ARGUS/USDC v3 pool's `slot0`.
    - GeckoTerminal's live trades are polled every 3s while the tab is visible (`getArgusTrades(..., { proxyOnly: true })`: the paid key through `/api/gecko`, whose `/trades` answers are CDN-cached 2s and never served stale). `mergeSwaps` in `poolSwaps.ts` merges them: whichever of GeckoTerminal, the engine and the chain has a swap first shows it, and the chain's or engine's copy replaces GeckoTerminal's (matched by id or transaction). The first page is history; later ones are live.
    - GeckoTerminal's full trade list (with the free direct fallback) is used only if the chain can't be read.
  - **True holders (`/api/holders`, `api/_holdersCore.ts`, hook `api/holders.ts` → `useChainHolders`):** every holder's exact balance, rebuilt from the token's Transfer logs from the block its contract was created in (binary search on `getCode`). Stored in Supabase (v4 migration), so each request only scans new blocks.
    - A token's first count runs in ~14s slices across requests. The page polls while it runs and shows GeckoTerminal's count meanwhile. ARGUS, the busiest (~2 transfers per block), takes a few minutes the first time.
    - **Live count (`useLiveHolderCount`):** the index's count plus the Transfer logs after its `scanned_to` block. A wallet going from 0 to a balance adds one; one selling everything takes one away. Re-checked every 6s and 1.5s after each new trade; if the index moves mid-read the answer is thrown away and re-read. Shown in the header stat, the Holders tab and on launchpad coin pages.
    - The Terminal's Holders column comes from `arcdex_holder_scans` for coins scanned within about a day.
    - The Holders tab lists the top 50 on-chain holders (the liquidity pool and burn address are tagged), with ARCDEX PnL and theses for those who trade here; "On ARCDEX" shows the old ARCDEX-only view. Top-10 % excludes the pool and burn address.
  - From GeckoTerminal via `/api/gecko`: 5m/1h/6h/24h change, MC/FDV (scaled to the live price), liquidity, 24h volume, buys/sells, top-10 % (until the holder index is complete), GT score, honeypot flag, banner, description and socials.
  - From Arc RPC (`getArgusOnchain` in `src/arcdex/api/argusMarket.ts`): creator wallet, Portal #, hook, creator buy/sell tax, bonded. Each Portal is decoded with its own ABI.
  - Portal 8 records have no creator, so its "Creator payout wallet" comes from the creator registry's `payoutOf`.
- **Swap — `src/arcdex/components/ArgusSwapWidget.tsx`.**
  - `buildSwapRoute` gets the v4 PoolKey from `PositionManager.poolKeys(bytes25)` and verifies `keccak(key) == poolId` before using it.
  - Each trade approves the exact amount, runs `simulateContract` with the user's account for the real output, and sets min-out from the chosen slippage.
- **Copycat tickers.** Argus launches are permissionless, and several use the `USDC` ticker. `copycatOf()` flags them in the Terminal ("⚠ Not real USDC") and with a banner on the token page.
- **Upstream key (optional).** Set `COINGECKO_API_KEY` in Vercel to move `/api/argus`, `/api/gecko` and `/api/arcd` to CoinGecko's on-chain API (GeckoTerminal's own data, argus.world's source): same data, dedicated rate limit (`api/_geckoterminal.ts`). Without it, the free GeckoTerminal API is shared by IP and can throttle under load.
  - Pro and Demo keys look alike (`CG-…`): the key is tried on `pro-api.coingecko.com`, then on `api.coingecko.com` (Demo); a key neither accepts falls back to the free API, so a bad key can't break the site.
  - Every response carries `X-Arcdex-Upstream: coingecko-pro | coingecko-demo | geckoterminal`, which shows the key is active without exposing it. Tests: `bun scripts/test-geckoterminal.ts`.
  - The owner sets the key in Vercel project `app` (Production) themselves; it takes effect on the next deployment. Set on 2026-09-25.
- The on-chain Portal reader in `src/arcdex/api/argus.ts` is kept only as a fallback if `/api/argus` fails entirely.


## Social trading layer (fomo.family-style) — ARCDEX

ARCDEX aims to be the social trading app for Arc. fomo.family (Solana, Base, BNB, Monad, Robinhood Chain, Ethereum) has no Arc support, so that's our gap. Owner decisions (2026-09-25): wallet = account; **2% platform fee, 15% of it to referrers**; onboarding via the in-browser trading wallet plus USDC deposits.

**Identity.** `src/arcdex/lib/identity.ts` `useTrader()` returns the unlocked in-browser trading wallet (one-tap, no pop-ups), or else the connected wallet. Profiles, trades and referrals all belong to that address. `embeddedWallet.ts` fires `WALLET_EVENT` on unlock and lock.

**Database** (`supabase/migrations/20260925000000_arcdex_social.sql`, run by the owner in the Supabase SQL editor). `arcdex_*` tables hold profiles, follows, theses (+likes), and the indexed router trades, referrals and payouts, plus SQL functions for the leaderboard (realized PnL), trader positions and referral stats.
- **Security:** public-read RLS; no client write policies.
- **Verified on PGlite:** safe to re-run, PnL math correct, constraints enforced, anonymous writes blocked.

**Server (Vercel `api/`).**
- `/api/session`: wallet signs a sign-in message (EOA + ERC-1271/6492) and gets a 30-day HMAC token. Needs `ARCDEX_SESSION_SECRET`, which is set. Tests: `bun scripts/test-session.ts`.
- `/api/social`: profile, follow, thesis and like writes for the token's own address only; 20 theses/day.
- `/api/index-trades`: idempotent, throttled indexer of router `Swapped`/`ReferrerBound`/`ReferralPaid` events (v1 from block 22548761, plus the current router) into Supabase. Pages call it opportunistically. Tests: `bun scripts/test-index-decode.ts`.
- **Live end-to-end check:** `bun scripts/test-social-live.ts` signs in two throwaway wallets against arcdex.online and exercises follow, thesis, like and permissions, then undoes every write. Passed on 2026-09-25.
- Writes and the indexer need `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) in Vercel. The owner sets it; until then they return 503 and the UI shows empty states.

**Client.**
- `src/arcdex/api/social.ts`: reads via the Supabase anon key; writes via `/api/social`, signing in automatically.
- Pages: `TraderPage` (profile, follow, positions with live PnL, top trades, theses), `LeaderboardPage`, `FeedPage` (everyone/following), `RewardsPage` (invite link, referral earnings).
- On a coin page:
  - chart trader avatars (`PriceChart` `trades` prop, with the overlay above the canvases);
  - `TokenSocialTabs` (Trades / Top traders / Thesis);
  - `SafetyPanel` (dev sold, dev %, top-10, tax, honeypot, thin liquidity);
  - `PositionCard` (PnL and share card).
- `ArgusSwapWidget`:
  - reads `VERSION`/`feeBps`/`referralShareBps` from the chain (`lib/routerInfo.ts`); v1 and v2 ABIs;
  - passes the referrer on v2;
  - $5–$100 quick buys; a price-impact warning at 5% and confirmation required at 15%;
  - one-tap trades via the trading wallet; a Share card after each trade.
- Referrals:
  - `lib/referral.ts` captures `/r/<name>` and `?ref=<username|address>` first-touch, and loads Supabase lazily. `referralLink()` returns `https://arcdex.online/r/<username|address>`.
  - The router binds the referrer on-chain on the first referred swap.

**fomo parity build (2026-09-25).** fomo.family was toured feature by feature (read-only, in Chrome) and rebuilt for Arc.
- **Database v2:** `supabase/migrations/20260925120000_arcdex_social_v2.sql` (tested on PGlite). **The owner must run it in the Supabase SQL editor.** Until then, the Holders tab, clans, most-held, trader stats, PnL chart, closed positions, multi-buys and transfer notes are empty. The rest of the app keeps working.
  - Adds `banner_url` on profiles, `arcdex_clans`, `arcdex_clan_members` (one clan per wallet) and `arcdex_transfer_notes`.
  - Adds the view `arcdex_positions_v`.
  - Adds these functions: `arcdex_token_holders`, `_most_held`, `_trader_stats`, `_pnl_history`, `_closed_positions`, `_multi_buys`, `_clan_leaderboard`, `_clan_members_pnl`, `_clan_holdings`.
  - `ProfileEditor` sends `banner_url` only when it changes, so profile saves keep working before the migration.
- **Server:** `/api/social` adds `clan.create/join/leave/update` and `transfer.note`. A transfer note must match an on-chain USDC `Transfer` from the signed-in wallet in that transaction's receipt. `/api/argus` attaches `bonded` flags (`api/_argusBonded.ts`, two multicalls).
- **Routing:** `lib/router.ts` provides real URLs, rewritten to the SPA by `vercel.json`:
  - `/token/:addr?pool=`, `/profile/:addr|username`
  - `/clans`, `/clans/:slug`
  - `/leaderboard`, `/feed`, `/alerts`, `/rewards`, `/transfers`
  - `/portfolio`, `/launchpad`, `/swap`, `/bridge`
- **Prefs:** `lib/prefs.ts`, stored in localStorage under `arcdex:prefs:v1`. Covers quick-trade buy/sell presets, blur balances, watchlist, recents, alert sound and minimum size, and discovery panel layout.
- **Shell (`App.tsx`):**
  - Left `DiscoveryPanel` with these tabs:
    - Alerts: following/everyone, min size, sound, grouped multi-trader buys.
    - Tokens: Watchlist, Crypto, Trending, Most held, Graduated, Bonding.
    - Leaderboard: clans, traders, your rank.
    - Feed.
    - The panel can be split into 2 columns or collapsed.
  - Right rail: trading wallet, "Follow top traders", "Discover clans".
  - Bottom `TickerBar`: blue chips and Arc status.
  - `SearchBox`: recents, All/Tokens/Users/Clans, inline Follow, "/" to focus.
  - `AccountMenu`: cash, Deposit, profile, Settings (presets, blur, sound), Transfers, Rewards, Clans.
- **Coin page (`ArgusTokenPage`):**
  - Header: watchlist star, copy CA, website, X, and search on X. The tab title reads `$MC | SYMBOL | ARCDEX`. The badge says ARGUS only for real Argus launches.
  - `PriceChart`:
    - Line or Candles (Line by default), Price/MCap switch, screenshot, fullscreen. The line is green while the visible window is up and red while it's down, following pans and zooms. The style lives in `lib/chartStyle.ts`: remembered per browser (`arcdex:chart-style`) and shared with the launchpad's `CurveChart`.
    - Overlays: Trades, My swaps, Thesis marks, Friends only, Min size.
  - `TokenSocialTabs`:
    - Holders: position, PnL, avg entry MC, hold time, thesis.
    - Swaps (the first tab, open by default), like DexScreener's transactions: Date, Type, USD, amount, Price, MC at trade, Maker (the wallet), tx link; min size. The date is each swap's age counting up live (`12s ago` → `5m` → `3h` → `2d` → `4mo` → `1y`, `lib/ago.ts` and `components/Ago.tsx`: one shared 1-second clock for the whole page). New swaps flash in at the top.
    - On a narrow card the Swaps columns make way for Maker, which always shows: MC first, then Price, then amount (container queries on `.swaps-table` in `arcdex.css`, checked from 250px to 990px cards).
    - Thesis: threads, live position.
    - Top traders.
  - `AboutPanel`: 5M/1H/6H/24H, buys vs sells, volume, buyers vs sellers, links, View more.
  - `PositionCard`: Open/Closed.
  - Swap widget: editable presets (✎) and an "Unverified token" note.
- **Profile (`TraderPage` + `PnlChart`):**
  - Identity: banner, mutuals, clan badge, avg hold, trades, joined date.
  - Share, 𝕏, Send cash (`CashModals`), Follow/Edit.
  - Top 5 trades; PnL chart for 24H/7D/30D/All; realized PnL and volume for the chosen period.
  - Own page: cash with Deposit/Withdraw.
  - Positions: Open/Closed, sort, show dust. Pinned most-liked thesis. Swaps: All/Buys/Sells.
- **Other pages:**
  - Rewards: total earned, this week, `/r/` link. Tabs:
    - Referrals: each referred wallet and what they've paid you.
    - Creator rewards: `getCreatorRewards()` rebuilds 60% of the creator tax from ArcLaunchpad `Trade` logs, capped at the last ~3 days.
    - History: payouts.
  - Leaderboard: Traders/Clans, share your rank.
  - Clans: list and create, clan page (profit, top 3 coins, holdings, members/feed/thesis, Follow all).
  - Transfers: USDC in/out with notes.
  - Alerts.
- **Completed afterwards (2026-09-26)** — the items first left out:
  - **Card deposits:** Circle's Onramp Kit (`@circle-fin/onramp-kit`). Supports debit card, Apple Pay, Google Pay, and bank transfer in some regions; USDC is delivered straight to the user's wallet on Arc.
    - `api/onramp.ts` (Node runtime): `GET` returns `{enabled, sandbox}`; `POST` mints a 30-minute widget session for the signed-in wallet only.
    - UI: `components/CardDeposit.tsx`, the "Card" option in the Deposit modal.
    - **Owner setup:** set `CIRCLE_ONRAMP_API_KEY` from the Circle Console in Vercel. Optionally set `ONRAMP_SANDBOX=1`. Card, Apple Pay and Google Pay also need KYB in the Circle Console with arcdex.online as the web URL. Until the key is set, the tab says card deposits are "being switched on".
  - **2FA:** an optional passkey on the trading wallet (`lib/embeddedWallet.ts`, WebAuthn PRF). With it on, the AES key is HKDF(PBKDF2(passcode) ‖ PRF output), stored as a v2 blob.
    - Unlock and export ask for the passkey; turn it on or off in the Trading wallet panel.
    - Tests: `bun scripts/test-wallet-2fa.ts`.
    - "Sign out of all devices" (Settings → Account) revokes session tokens server-side: `arcdex_session_revocations`, checked in `/api/social` and `/api/onramp`.
  - **Languages:** `lib/i18n.ts` with `t()`. Code imports it as `T`, because many files use `t` as a loop variable. Strings are keyed by their English text; `N_()` marks module-level strings.
    - Languages: en, fr, es, pt, sw, de, zh, in `lib/i18n/<lang>.ts`, each loaded on demand. 933 strings each, all complete.
    - Pickers: Settings → Language, the avatar menu, the pre-connect picker, and the landing nav. The app remounts on a language change.
  - **Points** (ARCDEX's rewards program): rolling 30-day seasons from 2026-09-25.
    - Scoring: 1 pt per $1 traded, 20% of referrals' points, 10 pts per active day, and 2 pts per like from traders (capped at 500).
    - SQL: `arcdex_points` / `arcdex_points_of`.
    - UI: Rewards → Points, Leaderboard → Points, and the profile stat.
  - **Chart indicators** (`lib/indicators.ts`, tested by `bun scripts/test-indicators.ts`): Volume, MA 7/25/99, EMA 20, Bollinger (20, 2), VWAP, RSI 14 (in its own pane).
  - **Account menu:** Manage account, Contact support (private `arcdex_support_tickets`, 5/day), and desktop notifications for Alerts.
  - **Database v3:** `supabase/migrations/20260926000000_arcdex_social_v3.sql`, tested on PGlite. **The owner must run it** after v2. It adds points, support tickets, session revocations and `arcdex_fee_stats()`.

## Landing page + $ARCD (official coin) — buyback & burn

- **Routing:** `arcdex.online/` is the landing page (`src/arcdex/landing/`). It's a separate ~16 KB bundle with no wallet libraries: `src/main.tsx` picks it for `/`, and everything else loads the app via `src/appMain.tsx`.
  - The app's Terminal now lives at **`/app`**. `/r/<name>` referral links are captured first, then land on the landing page.
- **$ARCD:** `0x4b93446882d29e094181b2fae14b126577a2676c` — ARCDEX (symbol ARCD), an Argus Portal 8 launch, created 2026-09-24.
  - Supply: 1,000,000,000, 18 decimals. There is no `mint`, `owner` or `burn` function; it does have Argus hook, portal and holder-reward functions.
  - Pool: ARCD/USDC on Uniswap v4, `0x87b65f…9897`. Constants live in `lib/arcd.ts`.
- **Policy shown on the page (owner's decision):** 100% of ARCDEX's own fee revenue buys back $ARCD and burns it.
  - Sources: 85% of swap fees (after the 15% referral share), the launchpad's 1% plus 40% of creator tax, and 90% of bridge fees.
  - Burn = transfer to `0x…dEaD`. The Argus token excludes that address from rewards.
  - Buybacks and burns are **manual**, done from the fee wallet `0x2742…86Bb`.
- **Data:** `GET /api/arcd` (edge, CDN 60s) returns market (GeckoTerminal), burned (`balanceOf(dEaD)`), fee-wallet USDC/ARCD, recent burns (last ~2 days of Transfer-to-dEaD logs) and `arcdex_fee_stats`.
- **`/burn` (in the app):** a public dashboard. When the connected wallet is the fee wallet, it also shows owner controls: "Buy back $ARCD" (opens the coin page) and "Burn $ARCD" (transfer to `0x…dEaD`, with confirmation).
  - The navbar 🔥 ticker shows $ARCD burned and links here.

## Speed + live data (2026-09-25)

- **Database v4:** `supabase/migrations/20260927000000_arcdex_speed.sql`, tested on PGlite. **The owner must run it** after v3. Until then, `/api/holders` answers 503 (pages show GeckoTerminal's count), and `/api/argus` and `/api/gecko` work as before, without their stored copies.
  - `arcdex_kv` (private): last good upstream responses.
  - `arcdex_holder_scans` and `arcdex_holder_balances` (public read): the holder index.
  - `arcdex_apply_holder_deltas()` (service role only): applies one contiguous block range at a time, so two scans can't double-count.
- **Arc RPC for logs — `api/_arcLogs.ts`,** shared by edge functions, the browser and scripts. Measured endpoints:
  - Blockdaemon: 100k-block `getLogs`, bursts OK, CORS, but limited history; older ranges say "pruned". That was ~900k blocks (≈5 days) on 2026-09-25, and ranges ~320k blocks back were already pruned on 2026-09-26. `scanLogs` falls back to the archives on "pruned".
  - Beam (`rpc.beamrpc.com`): full archive, 10k ranges, bursts OK.
  - public and QuickNode: full archive, 9k ranges, about 2 calls/s.
  - drpc: free plan refuses history. The explorer is behind a Cloudflare challenge.
  - `scanLogs` sends recent blocks to Blockdaemon and older ones across the archives, 5 workers in parallel. It splits on "max results" (20k logs per answer) and on timeouts, and returns the contiguous prefix it finished before its deadline.
- **Bundle:** `/app` loads ~0.7 MB of JS (was 2.58 MB).
  - ConnectKit removed (see Tech Stack).
  - The WalletConnect connector's eager `setup()` is skipped (`lazyWalletConnect` in `wagmi.ts`).
  - supabase-js replaced by a 100-line read-only PostgREST client, `lib/postgrest.ts`; `scripts/test-postgrest.ts` checks it matches supabase-js.
- **Scrolling:**
  - `.main-content` scrolls any page without its own scroller (Swap, Bridge, Portfolio and Launchpad were cut off below the fold).
  - `.app-shell` falls back to `100vh` where `dvh` isn't supported.
  - The chart no longer captures the mouse wheel or vertical swipes (zoom with a pinch, the time axis, or the wheel in fullscreen).
- **Tests:** `bun scripts/test-candles.ts`, `bun scripts/test-postgrest.ts`. Live against mainnet, no funds or keys:
  - `bun scripts/test-pool-swaps.ts`: on-chain swap loading and prices vs GeckoTerminal.
  - `bun scripts/test-holders.ts [token] [createdIso]`: a full holder count; it must report 0 negative balances.

## Phones: native-app layout (2026-09-26)

One breakpoint, `max-width: 767px` (`lib/useMobile.ts`, and the last block of `arcdex.css`). Desktop is unchanged.
- **Shell:** a bottom tab bar (`MobileTabBar`: Home, Feed, Swap, Portfolio, More) replaces the hamburger. "More" is a sheet with every other page, the trading wallet, and the lists drawer (watchlist, trending, most held). The top bar respects safe areas (`viewport-fit=cover`).
- **Coin pages** (Argus, launchpad, other tokens) are pushed screens. The top bar has a back arrow (in-app history depth in `App.tsx`), and there is no tab bar.
  - Order: header → chart (edge to edge, 300px) → stats → tabs → position/safety/about.
  - A sticky Buy / Sell bar (`TradeBar`) opens the swap box in a bottom sheet (`Sheet`); widgets take `initialMode`.
- **Sheets (`components/Sheet.tsx`):** portal, backdrop tap / Esc / the phone's Back closes them. Each open sheet adds a history entry. `lib/sheetHistory.ts` keeps the page router from treating those pops as navigation, and `afterSheetClose` navigates only after the sheet's entry is gone. Modals (`.modal-card`) and dropdowns (`.menu-pop`) also open as bottom sheets on phones.
- **Trading wallet anywhere:** `openTradingWallet()` (`lib/tradingWalletSheet.ts`) opens it as a sheet. It's linked from More, Connect Wallet (as a first-class option: most phone users have no wallet app), the swap box, Deposit and Rewards. The right rail that holds it is hidden below 1180px.
- **Terminal:** compact rows (a single volume/liquidity line), view chips scroll with Filters pinned, and "Show more" replaces pages.
- **Fixed on the way:** `.token-detail-grid` used `align-items: flex-start`, so on narrow screens the chart column kept the chart's first width (648px) and the chart, controls and holder tables ran off the screen. Leaderboard tables drop a column on phones.
- **Installable:** `public/manifest.webmanifest` (standalone, start `/app`, icons 192/512) plus Apple web-app meta. Added to the home screen, ARCDEX opens full screen with no browser bar.
- **Checked** at 360px and 390px on every main page: nothing wider than the screen, except rows meant to scroll sideways.

## Real-time market engine — `engine/` (2026-09-25)

A long-running Bun service (not on Vercel) that ingests Arc directly and pushes to the site over WebSocket. See `engine/README.md` for architecture, deployment, protocol and tests.
- **Pipeline:** Arc WebSocket + getLogs (`chain/stream.ts`) → launchpad adapters (Argus Portals 7 & 8, ArcLaunchpad) and the swap parser (v4 PoolManager + v3 factory pools) → `MarketEngine` (hot state, 1s–1d candles) → Redis (hot), Postgres (history) and WebSocket/REST.
- **Argus launches (measured 2026-09-25):**
  - Portal 7 `0xB021…97Da` handles ~3,000 launches/day. Its event `0x1d891723…` carries token, creator, name, symbol and poolId.
  - Portal 8 `0xeed7…5D93` handles ~125/day through `Launched` + `LaunchMetadata`.
  - Portals 1–6 are dormant.
  - Each launch tx also carries the PoolManager `Initialize`, so the pool is registered before its first trade.
- **v4 pools with `currency0 = 0x0`** trade native USDC (18 decimals). The engine prices them. The coin page's swap widget doesn't route them yet ("No routable pool").
- **Database v5:** `supabase/migrations/20260928000000_arcdex_market_engine.sql`, tested on PGlite. Only needed if the engine stores history in Supabase; the Railway deployment below uses its own Postgres instead.
  - It adds `arcdex_mkt_*` tokens, pools, trades, candles, liquidity and cursor tables.
  - Functions: `arcdex_mkt_rebuild_candle` and `arcdex_mkt_cleanup`. Retention: trades 72h, 1s candles 6h, 5s 24h, 15s 3d, 1m 30d.
- **Running on Railway (since 2026-09-25):** project **arcdex**, service **arcdex-engine**, built from GitHub `olomierik/ZAKA` `main` (the only repo the Railway GitHub App can see).
  - Public URL: `https://arcdex-engine-production.up.railway.app` (WebSocket `wss://…/ws`, `/health`, `/v1/…`).
  - History goes to the project's own Postgres (`DATABASE_URL=${{Postgres.DATABASE_URL}}`, `store/postgresHistory.ts`, tables created on start); hot state to its Redis (`REDIS_URL=${{Redis.REDIS_URL}}`). Also set: `TRUST_PROXY=1`, `WS_ALLOWED_ORIGINS=https://arcdex.online,https://www.arcdex.online`, `LOG_LEVEL=info`. Supabase keeps the site's own data.
  - The root `railway.toml` builds `engine/Dockerfile`, health-checks `/health`, and redeploys only on engine file changes. A restart resumes from the cursor saved in Redis/Postgres.
- **The site uses the engine (switched on 2026-09-25):** the owner set `VITE_ARCDEX_WS_URL=wss://arcdex-engine-production.up.railway.app/ws` in Vercel project `app` (Production). The REST base is derived from it. To switch off, remove the variable and redeploy; pages then use their direct-from-chain path (`poolSwaps.ts`), which is also their automatic fallback within 4s whenever the engine is unreachable. A custom `wss://api.arcdex.online/ws` would need that DNS pointed at Railway first.
  - Measured on 2026-09-25 against Railway: trades p50 1.7s block → client (p90 2.4s, including up to ~1s of block-timestamp rounding), new launches ~2s, and 1s candle closes matched 15/15.
- **Frontend (`src/arcdex/api/marketStream.ts`):** one shared, ref-counted WebSocket. What uses it:
  - **Coin page:** engine trades via REST + `token` channel, merged by trade id, with chain fallback after 4s or on REST failure.
  - **PriceChart:** engine candles + `CANDLE_UPDATE`, with a 5s timeframe in engine mode.
  - **Terminal:** `new_tokens` rows with a NEW badge, visible before their first trade; `market` ticks update prices; list polling slows to 60s.
  - **Search:** includes fresh launches.
- **Tests:** `bun run engine:test` — 40 tests (+2 Postgres ones that need `PG_TEST_URL`), including catch-up backpressure, live batching, replays of recorded mainnet data (`engine/test/fixtures/mainnet.json`) and a RESP3 Redis round-trip against Bun's client. Live latency: `bun engine/scripts/latency-check.ts <ws-url> 60`.

## Hosting — arcdex.online only

**Every commit to `main` deploys to arcdex.online, and nowhere else** (owner decision, 2026-09-24).

- **Project:** Vercel project `app` (`prj_cvHmYqjjLNXDMycZfQTbV4JKmkW2`), serving **arcdex.online** and `www.arcdex.online`. It builds automatically from GitHub `olomierik/ZAKA` `main`, so to ship you commit and push, then check the new `app` deployment (`vercel ls app`). Don't use `vercel --prod` for normal releases.
- **Local link:** `.vercel/project.json` is linked to `app`, so any Vercel CLI command run here targets arcdex.online.
- **Env vars:** only `app`'s Vercel settings are used. `.env` isn't committed, so GitHub builds never see it. `app` production has `VITE_ARC_LAUNCHPAD_ADDRESS`, `VITE_ARCDEX_SWAP_ROUTER_ADDRESS`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `VITE_WC_PROJECT_ID`. A new `VITE_*` var must be added there, and it only takes effect on the next build.
  - To verify a var reached the site, fetch the live JS chunks and grep for the value. `vercel env pull` shows sensitive vars as empty.
- **Retired project:** `zaka_app` (`zakaapp-drab.vercel.app`) is disconnected from GitHub. Its production deployment is only a 307 redirect of every path to the same path on arcdex.online. The source for that deployment isn't in this repo; it's just a `vercel.json` with `redirects`.
  - History: until 2026-09-24, every push built **both** projects, and CLI deploys went to `zaka_app` with `.env` baked in. arcdex.online had no env vars, so the Launchpad showed "contract not configured".

## What This App Does

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: wagmi connectors with ARCDEX's own connect modal (`src/arcdex/components/ConnectWallet.tsx`; ConnectKit was removed 2026-09-25, it was ~40% of the app's JS). Browser wallets announce themselves (EIP-6963); WalletConnect (QR / mobile) and Coinbase Wallet load their SDKs only when picked, and only the last-used wallet is reconnected on load (`lib/reconnect.ts`). Connector ids match ConnectKit's, so earlier sessions reconnect.
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Testnet)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## To Run

```bash
bun install
bun run dev
```
