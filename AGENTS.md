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

### ArcDexCurveRouter — 2% on Mercuri and SolonPad curve trades (deployed 2026-09-27)
- **Mainnet:** `0xF8e8C8E2159e5Bb8af91fD342BfE5b9DB7a06441` ([explorer](https://explorer.arc.io/address/0xF8e8C8E2159e5Bb8af91fD342BfE5b9DB7a06441)). The owner deployed it from `/deploy/curve-router` with MetaMask, so the owner is the deploying wallet.
  - It's the default, `CURVE_ROUTER` in `api/_curves.ts`: curve trades go through it with no env var. `VITE_ARCDEX_CURVE_ROUTER_ADDRESS` can name another router, or `off` to send curve trades straight to the curve with no ARCDEX fee.
  - `curveRouterFrom` (same file) applies that rule for the app, the deploy page and `/api/index-trades`. The indexer always includes the deployed router, even when routing is off.
  - Arc is out of the build sandbox's reach, so the sandbox can't check the router on-chain. Use **Check it** in the banner on `/deploy/curve-router`, which checks the router in force against mainnet.
- **What:** `contracts/ArcDexCurveRouter.sol` (VERSION 1). It trades a Mercuri or SolonPad coin on its own bonding curve, before it graduates, and takes ARCDEX's fee in native USDC in the same transaction.
  - **Fees:** `feeBps` 200 (hard cap 2%). `referralShareBps` 1500 (15% of the fee, capped at 50%) goes to the trader's referrer, bound on a wallet's first referred trade (its own `referrerOf`, same rules as ArcDexSwapRouter).
  - **Functions:** `buyMercuri(token, minTokensOut, deadline, referrer)` and `buySolon(…)`, payable. `sellMercuri(token, tokensIn, minUsdcOut, deadline, referrer)` and `sellSolon(…)`, after an approval to the router.
  - **Only the launchpads' own curves:** callers name a token, and the curve is the one its factory records. For Mercuri that's `curveOf`, and the curve must name the token back. For SolonPad it's `getLaunchedToken`, native-USDC curves only. Anything else reverts `UnknownToken`.
  - **Buy:** the fee comes off `msg.value` and the rest goes to the curve. A buy that sells a curve out is partly refunded, and the fee is charged only on the part used (the rest of it goes back with the refund). Anything a buy pays back beyond what it sent goes to the trader too, fee-free.
  - **Sell:** the proceeds come to the router, the fee comes off them, and the trader's minimum applies after the fee.
  - **Who gets what:** Mercuri pays tokens, refunds and proceeds to its caller, and the router forwards them. A SolonPad buy pays the trader directly, so its snipe tax is the trader's (a creator stays exempt).
  - **Mercuri's referral share:** Mercuri's FeeManager binds a referrer to the router on its first trade. The router always names `feeWallet`, so Mercuri's 0.20% referral share of every trade through the router accrues to the fee wallet. The fee wallet claims it from FeeManager `0x31D1…2580` with `claim(to)`.
  - **Safety:** the router holds nothing between transactions (every amount is a balance change) and accepts native USDC only mid-trade. A referrer that can't take native USDC within 30k gas has its share sent to `feeWallet`. `feeWallet` itself must accept native USDC; the deploy script checks this.
  - **Events:** ArcDexSwapRouter's `Swapped`, `ReferrerBound` and `ReferralPaid`, naming USDC as `0x3600…` in its 6-decimal units. `/api/index-trades` indexes it with the swap routers once the variable below is set, so leaderboards, PnL, fee totals and referral earnings include curve trades.
  - **Owner:** pause, fee (at most 2%), referral share (at most 50%), fee wallet, and rescue of tokens and native USDC.
- **Deploy (owner), from the browser (no Foundry, no key in a terminal):** open `arcdex.online/deploy/curve-router`. It isn't linked anywhere; the page is `pages/DeployCurveRouter.tsx` and the work is in `lib/curveRouterDeploy.ts`. Connect the wallet that will own the router: an external wallet, not the in-browser trading wallet.
  1. **Simulate.** A fresh router, built from exactly the code the page deploys, trades each launchpad's latest live coin inside one `eth_call`: a 5 USDC buy, then a referred buy and sell-back. `ArcDexCurveRouterSimHarness` is injected with a state override, as in the script below, and every fee, referral share and leftover is checked. Nothing is sent. If the RPC won't take state overrides, the page says so and still offers the deploy.
  2. **Deploy.** One transaction from the wallet: owner = that wallet, fee wallet `0x2742…86Bb`. After a failed simulation the button reads "Deploy anyway" and asks first.
  3. **Check.** This runs by itself after deploying, and works for any address (a router deployed by the script below included). The on-chain code must equal the build byte for byte, apart from its immutables. The settings are read back: owner, fee wallet, 2%, 15%, not paused, both factories. Then the same simulated trades run through the deployed router (`buyVia` / `roundTripVia`).
  4. **Switch on.** Once every check passes, the page shows the address. Make it `CURVE_ROUTER` in `api/_curves.ts`, or set it as `VITE_ARCDEX_CURVE_ROUTER_ADDRESS` (step 3 of the terminal route below).
  - **The code it deploys** is `src/arcdex/lib/curveRouterBuild.ts`, generated from `forge build` by `scripts/gen-curve-router-build.mjs`. After changing the router or the harness, run `forge build && node scripts/gen-curve-router-build.mjs` and commit the result. Add `--check` to fail on a stale build. Foundry 1.5.1 and 1.7.1 compile identical bytes.
  - **Checked in a real browser (2026-09-27)** against anvil (chain 5042, the Mercuri and SolonPad stand-ins at their real addresses) with an injected wallet:
    - simulate, a cancelled signature, deploy, and the automatic checks, all passing;
    - a router deployed by the script (passes), a token and an empty address (both refused);
    - an RPC without state overrides, and a fee wallet that refuses USDC (the simulation names `NativeTransferFailed()`, and "Deploy anyway" asks first);
    - no sideways scroll at 390px.
- **Deploy (owner), from a terminal:**
  1. Simulate first: `forge build && node scripts/sim-curve-router.mjs`. It trades real Mercuri and SolonPad curves through a fresh router via `eth_call` state overrides; nothing is sent.
     - It picks each launchpad's latest coin still on its curve, searching back to the launchpad's first block. Name coins with `MERCURI_TOKEN=0x…` / `SOLON_TOKEN=0x…`.
     - A launchpad with no coin on its curve is skipped; at least one must be tested. A revert is named (e.g. `UnknownToken(0x…)`, `Error(Slippage)`), not shown as raw data.
  2. `PRIVATE_KEY=… bash scripts/deploy-curve-router.sh` (owner = the deploying wallet; `FEE_WALLET` and `RPC_URL` are optional overrides).
     - It checks first, and names what's missing: Foundry on PATH, the ZAKA folder on the latest main, `node_modules`, the key, the RPC answering as chain 5042, a fee wallet that takes native USDC (a contract wallet is tried with a simulated 1-wei transfer), and enough USDC for gas.
  3. Make the address `CURVE_ROUTER` in `api/_curves.ts`, or set `VITE_ARCDEX_CURVE_ROUTER_ADDRESS` in Vercel project `app` (Production) and redeploy.
  - `VITE_ARCDEX_CURVE_ROUTER_ADDRESS=off` sends curve trades straight to the curve with no ARCDEX fee, as before the router.
  - **Lint warnings:** `foundry.toml` sets `lint_on_build = false` (checked with Foundry v1.7.1, the version `.foundry-version` pins). Without it, every `forge build` printed 26 `warning[…]` lint blocks (style hints on existing contracts) that read like errors in the deploy output. Run `forge lint` to see them.
  - **Line endings:** `.gitattributes` keeps `*.sh` LF, so bash in Git Bash doesn't trip over the carriage returns a Windows checkout would otherwise add.
- **Tests:** `forge test --match-contract ArcDexCurveRouterTest` runs 43 tests against mocks of both curves as published. They cover the fee split, partial-fill refunds, referrals (including a referrer that refuses native USDC or burns gas), unknown, foreign and ERC-20-quoted tokens, deadline, pause, reentrancy and the admin caps, plus fuzzed value conservation. Each of 15 deliberately planted bugs failed a test.
- **Checked end to end on a local chain (2026-09-27):** anvil ran with Mercuri and SolonPad stand-ins at their real addresses, the router deployed by the deploy script, and the site built with the variable set.
  - The coin page bought and sold both launchpads' coins through the router: exactly 2% to the fee wallet, approvals to the router, nothing left behind, and the wallet (not the router) listed as the trader.
  - `sim-curve-router.mjs` passed there, and failed on a deliberately broken router.
  - Arc's RPC was out of the build sandbox's reach, so run the simulation against mainnet before deploying.

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

### Dedicated Arc RPC — QuickNode (2026-09-29)
- **Endpoint:** QuickNode account "ARCDEX", endpoint `prettiest-cosmological-seed` (Arc Mainnet), on the **free trial**: 10M API credits for one month, 15 requests/s, no overage. Arc costs 20 credits a call, so that's ~500k calls a month for every visitor together.
- **Keep `VITE_ARC_WSS_URL` off.** Measured 2026-09-29: every WebSocket event is billed 20 credits, like a call (931 requests = 18,620 credits). The Terminal's live feed is ~10 events/s per open tab, ~200 credits/s: one open tab would use the trial's 10M credits in about 13 hours. The feeds stay on the public socket. The dedicated socket was only ~30 ms earlier per block.
- **Measured from the owner's machine** (`bun scripts/bench-arc-rpc.ts`): requests ~291 ms median against the public RPC's ~326 ms and Blockdaemon's ~297 ms. The slowest 10% took ~305 ms against the public RPC's 365–463 ms. It had the newest block 9 times in 10, the public RPC 6. Most of the ~300 ms is distance to the servers. On the Terminal, most load-time requests are log scans through the archive endpoints (`api/_arcLogs.ts`), where the public RPC answered 429s. The dedicated endpoint isn't in that path.
- **Referrer whitelist (on):** `arcdex.online`, `www.arcdex.online`, `localhost`. The URL carries its token and ships in the page, so this is what keeps other sites from using it. Vercel preview URLs aren't on it: previews fall back to the public RPC. A non-browser client can fake a referrer, so the whitelist stops casual reuse, not abuse.
- **Wiring (`VITE_ARC_RPC_URL`, `VITE_ARC_WSS_URL`; both optional, unset = public endpoints only):**
  - Reads (`arcReadTransport`, the shared `client`): the endpoint first, then Blockdaemon, then the public RPC. Blockdaemon moved ahead of the public RPC on 2026-09-29: it measured as fast and as fresh as the endpoint, so reads stay fast after the trial.
  - Receipts (`lib/receipts.ts`): polled from all three at once.
  - Live feeds (Terminal pulse, coin-page swaps, launchpad trades, `openArcSocket` in `api/arcRpc.ts`): its socket first.
  - Transactions are still sent through the public RPC: a fallback could send one twice.
- **It never makes things slower:** throttled (429 or "limit exceeded"), out of credits or refused (401/402/403), or down, it's benched for 1 / 10 minutes / 30s and the public RPC answers the same request. A revert is an answer and doesn't bench it. A socket that's refused or answers a subscription with an error sends every feed to the public socket for 5 minutes.
- **When the trial ends** the endpoint refuses and the app runs on the public endpoints. Watch usage under the endpoint's Metrics tab.
- **Tests:** `bun scripts/test-fast-rpc.ts` (fetch and WebSocket stubbed): first choice, throttling, refusal, reverts, sockets.

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
  - A fit runs on load and on a new timeframe, coin, view or style. Since round 8, new bars slide the chart a bar left, as on fomo (see below); a history refresh keeps the bar spacing unless many bars were added.
  - The price axis goes back to auto on a new timeframe, coin, Price/MCap view or style.
  - A resize keeps the fit (`lockVisibleTimeRangeOnResize`, then a re-check). The edges are no longer pinned: `fixRightEdge` glued the last point to the price axis, and `fixLeftEdge` made 5.2 slide the chart on every new bar (round 7).
  - Someone who drags, pinches or wheel-zooms keeps their view until they change the timeframe; a double-click fits it again. The old "last 140 bars" window is gone.
- Like fomo's chart:
  - A legend: coin · timeframe, then the value under the crosshair and its change from the bar before.
  - % / log / auto scale buttons and a UTC clock under the chart.
  - Price by default, with a switch to market cap (see "Coin page chart" below).
  - Caps under $100K in full dollars on the axis.
- Launchpad coins use this chart too (the old `CurveChart` is gone), priced from the curve's reserves after each trade.
- **The line moves as fomo's does (owner's request, round 8, 2026-10-04: "the line moves going right, the entire chart shakes when it moves, and it shows the bends when buys and sells occur").** fomo's chart was read in Chrome: a TradingView Line chart on 15S bars, right offset 10 bars, the price axis on auto, and its visible range moving 15s with every new bar (sampled every 2s while trades came in).
  - **Each trade at once:** a trade moves the line's last point straight to its price (`series.update`), so every buy and sell shows as a bend, and each finished bar keeps its bend. The price glide (`GLIDE_MS`) and the axis stretching ahead of it are gone.
  - **The chart slides with each new bar:** `shiftVisibleRangeOnNewBar` is on, with `rightOffset` `RIGHT_OFFSET_BARS` (10, fomo's) in `lib/chartMotion.ts`.
    - The latest bar stays 10 bars short of the price axis, and every new bar slides the whole chart one bar left: the oldest scroll off.
    - The price axis re-fits to what's on screen as it goes. Together, that's the movement fomo's chart has.
    - Round 7's room on the right, bars walking into it and the glide back to a fit (`LIVE_GAP`, `needsRefit`, `REFIT_MS`) are gone.
  - **Fit:** every bar fits the window on load and for a new timeframe, coin, view or style (fomo fits too).
    - After a history refresh the chart keeps its bar spacing and the latest bar (`scrollToRealTime`). It re-fits only when the bar count jumped by more than 2, a backfill or a reload (`followAfterRedraw`).
    - Someone who drags, pinches or zooms keeps their view; a double-click fits again.
  - **The last point still pulses,** with its dotted price line (`chartStyle.ts`), and swaps still pop.
  - **Coins open on 15s, as fomo's do (owner, 2026-10-04: "on the Arc chart you did nothing").** The Arc chart had the new motion, but Arc coin pages opened on 15m, where a bar comes every 15 minutes and nothing seems to move.
    - Every coin page now opens on 15s (`OPEN_RES`) wherever its swaps come in live: Arc coins, curve coins, and Robinhood coins once their chain feed is running. Charts without live swaps (Futures, other tokens) open on 15m.
    - A timeframe someone picks holds while the coin is open (`picked`).
  - **Fits keep bars at least 3px wide (`MIN_FIT_SPACING`, `fitWindow`):** with more bars than fit at 3px (an hour or more of 15s bars), a fit shows the latest ones that do, about an hour in 742px. Fitting every bar would draw hours of 15s bars under a pixel each, hiding both the bends and the steps left. Older history is a drag away. The owner's round-4 "every candle fits" still holds up to that width.
  - **15s on Robinhood coins:** their pages now offer 15s whenever the pool's swaps come from the chain (`rhChartSource(…, fromChain)`), drawn from those swaps alone (GeckoTerminal has nothing under a minute), as Arc coins already did.
  - **Checked:**
    - lightweight-charts with these options, in the browser: a fit of 160 bars plus 10 of room; trades in the last bar moving its point at once; each new bar moving the visible range one bar while the latest point stays at the same x.
    - A live Robinhood coin on 15s.
    - `bun scripts/test-chart-motion.ts` (the offset and when a refresh re-fits).
- **The live end of the line, round 7 (replaced by round 8 above):** the line stopped 64px short of the axis, new bars walked into that room with the chart holding still, the view glided back to a fit, and prices glided between trades. The owner wanted fomo's motion instead.

### Phone home and desktop nav (2026-09-26)
- **Phone home** (`components/MobileHome.tsx`, top of the Terminal on phones): only what matters (owner's request, 2026-09-30).
  - Your cash with Deposit and Withdraw; with no wallet yet, "Get started" opens the trading wallet.
  - The AUTOTRADE button (redesigned 2026-09-30): your paper account's value while it runs, else how many coins the scanner is checking; a LIVE badge in live mode.
  - The week's top-traders strip was removed (owner's request); the leaderboard stays under More.
- **Desktop nav** has Swap and Bridge. Below 1180px wide, Feed, Leaderboard, Clans and Rewards drop out of the top bar; they stay in the left panel and the account menu.

### Trading wallet: withdraw, Portfolio, GeckoTerminal chart (2026-09-26)
- **Withdraw from the trading wallet.** The Trading wallet panel has Deposit and Withdraw, and a link to Portfolio. The account menu has Portfolio and Withdraw. The phone home has Withdraw under the cash.
- **Passcode rule (owner decision): money leaving the trading wallet for anywhere but the wallet that funded it needs the passcode** (and the passkey with 2FA on). This covers Withdraw, sending a coin, Send cash to a trader and Bridge → Send from Arc.
  - Rule and funding wallets: `lib/funding.ts`. The UI is `components/WithdrawGuard.tsx`. `verifyPasscode()` is in `embeddedWallet.ts`.
  - A funding wallet is an ordinary account (no contract code; EIP-7702 counts) that sent the trading wallet **at least $1 and at least 5% of everything that funded it** (2026-09-29). The share stops a dust attack: someone sends $0.01 from their own wallet, then uses the unlocked phone to "send it back" with everything else. It raises the attack's price rather than ruling it out: a wallet that sent 5% still qualifies.
    - Contracts paying out (sells, refunds) aren't funding and don't count toward the total.
    - Mints (bridge arrivals) count toward the total but aren't a funder. A deposit through the Bridge page records the wallet that burned the USDC (`addBridgeDeposit`, keyed by the burn, with the mint's transaction so it counts once); that wallet is then a funder under the same rule.
  - Deposits are read from both USDC log sources: the USDC contract (6 decimals) and `0xff…fe`, which logs native sends (18 decimals). Most wallets send natively, so only reading the contract missed them. An ERC-20 transfer is logged by both, so each (transaction, sender) counts once. The Transfers page reads both the same way.
  - Scans cover what Blockdaemon serves (`RECENT_DEPTH`, ~3.5 days), never the archive fallback (`recentLogsSince` in `lib/recentLogs.ts`), then only the blocks since the last scan. `useFundingScan` in `App.tsx` scans when the trading wallet is unlocked and every 5 minutes after, so a deposit is recorded while it's in range. A deposit that aged out before the wallet was ever unlocked isn't seen (passcode asked).
  - Deposits found are kept in localStorage as a ledger (amounts, last block scanned, contracts seen), signed by the trading wallet's own key, so an edited ledger is dropped and rescanned. Not found means the passcode is asked. Ledgers from before 2026-09-29 (`funding:v1`, addresses without amounts) are replaced by a rescan.
  - Free destinations: a funding wallet, and the trading wallet's own address (bridging to itself on another chain). An external wallet is never asked, because it confirms every transfer itself.
- **Portfolio (`pages/Portfolio.tsx`, `lib/portfolio.ts`) uses the unlocked trading wallet, else the connected wallet.** It used to only ask to connect a wallet.
  - It shows USDC cash and every coin held, valued live, with Sell to USDC (`TokenSwap` in a sheet, sell mode) and Send on each coin.
  - Coins checked:
    - coins bought from this browser (`lib/held.ts`, recorded by both swap widgets and quick buys);
    - router trades from Supabase;
    - the market list and the launchpad coins;
    - tokens sent to the wallet in the last ~2 days.
  - Balances are read by multicall. Prices come from the market list, the curve, else GeckoTerminal.
- **Coin page chart (owner's request, 2026-09-27):** only ARCDEX's own `PriceChart`. The embedded GeckoTerminal chart and its "Live · GeckoTerminal / ARCDEX chart" tabs are gone.
  - Every coin opens on 15m, Line and Price. A switch holds while that coin is open and isn't remembered, so choices an older build saved in the browser are ignored.
  - `PriceChart` still draws GeckoTerminal's candles, refreshed every 30s through `/api/gecko` (the paid key), or the engine's. Every swap is live on top.
- **Tests:**
  - `bun scripts/test-withdraw-guard.ts`: the rule, the share rule, native and ERC-20 logs (one real mainnet pair), bridge deposits counted once, resuming scans, and tamper-proof storage. 14 of 15 deliberately planted bugs failed it; the 15th (a locked wallet writing its ledger) is blocked by the signer anyway.
  - `bun scripts/test-recent-logs.ts`: Blockdaemon ranges and where a scan that lost a slice resumes.
  - `bun scripts/test-portfolio.ts`: which coins are checked and how they're priced.

### Launchpad coin cards and filters (2026-09-26, round 5)
- **Owner's request:** Argus-style launch cards, with the coin's image covering the whole card and cards that are never still, plus coin filtering. argus.world itself was out of reach from the build sandbox (blocked by its network policy); compare once it's allowed.
- **`components/CoinCard.tsx`:** the coin's image fills the card. A coin without an image gets gradient art in its own colors, with its ticker.
  - Overlaid:
    - ticker and market cap;
    - name and creator;
    - the description (on hover; always on the featured card);
    - a striped progress bar;
    - 24h volume and trades;
    - the risk badge (`riskOf` with the curve's data);
    - socials;
    - ⚡ Buy $5 (the trading wallet's quick buy);
    - a watchlist star, age, NEW (under 1h), GRADUATING (50%+ since round 6; was 70%) and GRADUATED.
  - **Motion:**
    - the art drifts (slow zoom and pan, varied per card from its address);
    - a sheen sweeps across;
    - the card tilts toward the mouse with a glare;
    - graduating coins get a spinning conic glow border, graduated ones a gold glow.
  - **Live trades:** each one flashes its card green or red and floats the amount up ("+$250").
  - **Motion pauses** while a card is off screen (IntersectionObserver, `data-live`) and stops with reduced motion.
- **`pages/Launchpad.tsx`:**
  - Tabs, each with a count: 🔥 Trending, ✨ New, 🟢 Live (round 6), 🚀 Graduating (50%+ since round 6), 🎓 Graduated, ★ Watchlist, 👤 My coins.
  - Search by name, ticker or address.
  - Sort: best for the tab, market cap, 24h volume, newest, progress, 24h trades or last trade.
  - Age filter (1h, 24h, 7d), "Has socials", "Low risk", and big/small cards. The choice is remembered per browser (`arcdex:launch-view`).
  - The hottest coin is a landscape hero card on Trending.
  - A live tape of every launchpad trade replaces the old activity list. Each trade moves its card's price and progress at once (`LaunchpadLiveTrade.rUsdcAfter`, new). The list still refreshes every 10s.
  - `LaunchpadToken.stats` (new) carries the index's 24h numbers.

### Launchpad: what Argus's Tokens page does (2026-09-26, round 6)
- **Source:** argus.world is still blocked from the build sandbox, but Argus publishes its app docs in its official repo, github.com/arguspad/argus-world (`docs/02-discover-tokens.md`, `03-create-token.md`, `06-glossary.md`). Round 6 adds what those docs describe and the launchpad lacked.
- **24h change and a trend line on every card** ("24h change" and "Trend" in Argus's glossary).
  - `api/_launchpadCore.ts` `trendOf()`, added to `statsOf()` as `change24` and `spark`: the price 24h ago (the opening price for a younger coin), then 24 closes to now, from the index's trades. That's 25 points, ~300 bytes a coin.
  - Both fields are optional on `LaunchStats`, because CDN-cached responses from before this change lack them.
  - `statsOf()` takes the launch time (`l.ts`) at both call sites.
  - `OPENING_PRICE` is the curve's price before any trade: $8,000 over 1.15B virtual tokens.
  - On the card, `components/Sparkline.tsx` (paths from `lib/spark.ts`) runs across the art just above the text. It is green when the coin is up and red when down, draws in from the left the first time it's on screen, and has a pulsing dot on the latest price. A change pill sits on the name row.
  - Live trades replace the last point and recompute the change.
  - New sort: "24h change". Terminal rows for ARCDEX coins now show the real 24h change (it was always 0).
  - **Holders are deliberately not on the cards.** The only cheap count (net buys from curve trades) would disagree with the coin page's exact count from Transfer logs.
- **Search as on Argus** (`components/CoinSearch.tsx`, matching in `lib/coinSearch.ts`):
  - Press ⌘K / Ctrl K anywhere on the page, or click the box. It matches a name, a ticker with or without `$`, or an address (from its start, or 6+ hex characters from anywhere).
  - Order: exact ticker or address, then ticker prefix, then name or word prefix, then contains; ties go to the bigger market cap.
  - Up to 8 matches drop down. The arrow keys move (wrapping) and Enter opens one. Enter with nothing picked opens the coin if there's exactly one match (a pasted address); otherwise it's "View all N matches". That switches to all coins with the quick filters off if the current view hid some, then scrolls to the grid. Escape closes it.
  - The grid still filters as you type, with the same matcher.
  - Empty states: "No coin matches …" with a hint to paste the full address, or "No coins match these filters" with Show all coins.
- **Scopes as on Argus:** a 🟢 Live tab (still on its curve). Graduating means live and at least 50% of the way (`GRADUATING_PCT` in `lib/launchpadCoins.ts`, used by the tab, the badge and the glow).
- **Launch form live preview** (Argus: "the preview updates as you enter your details"). The real `CoinCard` is shown in `preview` mode: NEW with no age or star, the description always shown, and "by you" before a wallet is connected.
  - It is built by `lib/launchPreview.ts` with the contract's own launch and first-buy math: the fees come off first, then the constant product, so the preview shows the market cap and progress the coin will open at.
  - Desktop: beside the form, sticky. Phones: under the fields, above the cost and the launch button.
- **Tests:**
  - `bun scripts/test-launch-cards.ts`: trend and change math, search ranking, sparkline geometry, and preview math checked against the index's own price function.
  - The launchpad browser suite covers every item above, plus the phone layout.

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
  - **The shared read client (`api/launchpad.ts` `client`)** batches concurrent reads into one Multicall3 call (`batch: { multicall: true }`). It uses `arcReadTransport()`: the dedicated endpoint if set, then Blockdaemon, then the public RPC, each taking over when the one before throttles or fails ("Dedicated Arc RPC").
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
  - `bun scripts/test-chart-motion.ts`: pop flights and the live end of the line.

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
  - **Out of credits (found 2026-10-01):** the Pro key's plan had used its monthly credits, and every call answered 429 "monthly credit limit reached" (code 10006). That isn't a rejected key, so nothing fell back: `/api/arcd` returned no market (the landing's $ARCD market cap and 24h change showed "…") and took 18s. Now a key out of credits is left alone for 30 minutes at a time and the free GeckoTerminal API answers (`OUT_OF_CREDITS_BENCH_MS`, tested in `scripts/test-geckoterminal.ts`). The free API is shared by IP and throttles under load: the owner should turn on overage or renew the plan in the CoinGecko dashboard. `/api/arcd` also falls back to the market engine's own $ARCD numbers, and every part of it has a time budget (it answers in about 2s).
- The on-chain Portal reader in `src/arcdex/api/argus.ts` is kept only as a fallback if `/api/argus` fails entirely.

## Every other Arc launchpad (2026-09-26)

The Argus integration above, extended to every launchpad GeckoTerminal lists on Arc: their coins are in the Terminal, open the full coin page, and trade through ArcDexSwapRouter wherever they sit in a Uniswap pool.

- **Registry — `api/_launchpads.ts`** (shared by the server list and the app):
  - Each launchpad has a name, a badge color, a site, and a regex matched against GeckoTerminal dex ids and names (`_` counts as a separator).
  - Sites are only listed where the address is confirmed (docs, DefiLlama's adapters, the awesome-arc list). ArcPad, Arc.fun, Flipt, Onmi and NebulaPad are recognized but not linked.
  - `isLaunchpadDex` keeps plain DEXes out (Uniswap, Curve, PEGD, …). A new venue named like a launchpad (`.fun`, `pad`, `launch`, `pump`, `meme`) is picked up without a code change.
- **Where each launchpad's coins trade** (from its docs and DefiLlama's Arc adapters, github.com/DefiLlama/dimension-adapters `fees/<name>`):

  | Venue | Launchpads | Routable by ARCDEX |
  |---|---|---|
  | Uniswap v4 | Argus, Minara (fee hook), o1, SolonPad instant mode (no hook), UBI.fun (Flaunch-style hook), graduated Mercuri | yes, if its hook allows it: ERC-20 USDC pools through ArcDexSwapRouter, native-USDC pools through Uniswap's Universal Router (next section) |
  | Uniswap v3 | Tolly (locked 1% pools), RadarDEX (reflection tokens), Archemist, graduated Sashimi | yes, if the pool came from SwapRouter02's factory |
  | Own curve | Mercuri, SolonPad (curve mode) | yes: on the curve itself, until the coin graduates ("Mercuri and SolonPad bonding curves" below) |
  | Own curve or DEX | Sashimi, Warp/CircleWarp (native USDC; graduates to WarpDex, a Uniswap V2 fork) | no: the coin page links to the launchpad |

- **Market list** (`api/_argusCore.ts` `buildMarket`, served by `/api/argus`):
  - Order: Argus first, as before. Then each other launchpad's top 20 by 24h volume, new pools on any listed launchpad, and missing caps filled in.
  - Each row carries `launchpad` (the badge).
  - The launchpads come from GeckoTerminal's `/networks/arc/dexes`, kept 6h in `arcdex_kv` (`arc:launchpads`). If that can't be read, the known ids in `KNOWN_LAUNCHPAD_DEXES` are used.
  - The server fetches 4 launchpads at a time with a Pro key, 2 with a Demo key, and 1 on the free API.
  - The response includes `launchpads`, so the browser's own rebuild (only when the server's copy is partial) asks for just the top 4 on the visitor's quota.
- **App:**
  - Terminal badges and source pills use each launchpad's color (`getLaunchpadColor`). Every non-ARCDEX coin with a pool opens `/token/<address>?pool=…`.
  - The coin page's badge, the About panel's Launchpad row and its link (argus.world only for Argus coins), and the copycat banner all name the coin's launchpad.
- **Trading** (`src/arcdex/api/argusMarket.ts`):
  - `buildSwapRoute(token, pool, createdAt)` routes a v3 pool only when its `factory()` is SwapRouter02's. The router finds v3 pools by (pair, fee), so a fork's pool would be swapped somewhere else.
  - v4 keys come from `PositionManager.poolKeys`. Launchpads that add liquidity through their own hook never register there; for those, the key is read from PoolManager's `Initialize` log within ±60k blocks of the pool's GeckoTerminal creation time. Either way, the key must hash to the pool id before it's used.
  - `bestSwapRoute` tries the page's pool, then the coin's other pools (deepest first), so a graduated coin's Uniswap pool is found.
  - The coin page re-checks the route in the background when the pool list refreshes (every 15s); it only starts over ("Finding route…") for a new coin or pool, so a trade clicked during a refresh isn't lost.
  - With no route, the swap widget says the coin trades on its launchpad's own contracts and links there (`venue`). Its fee note names the launchpad's pool fee instead of Argus's creator tax.
- **Known limits:**
  - ArcDexSwapRouter doesn't take native-USDC (address 0) pools; those trade through Uniswap's Universal Router (next section).
  - A hook that only allows its own router shows up at simulation. That's after the exact-amount approval to ARCDEX's router, which can't move funds by itself.
  - Mercuri's and SolonPad's curves trade on ARCDEX (below). Sashimi's and Warp's would need their contract ABIs, which aren't published.
- **Tests:**
  - `bun scripts/test-launchpads.ts`: recognition, discovery, the multi-launchpad build (order, concurrency, dedupe, caps, streaming) and Initialize-log key decoding.
  - Browser checks cover the Terminal pills and badges, a Tolly v3 route, a Minara v4 route via the Initialize fallback, the Warp link, and a fork-factory pool being refused.


## Native-USDC v4 pools, through Uniswap's Universal Router (2026-09-26)

Minara, SolonPad's instant launches and other launchpads open their Uniswap v4 pools against Arc's native USDC (`currency0 = 0x0`, 18 decimals). ArcDexSwapRouter only takes ERC-20 USDC pools, so these trade through Uniswap's own Universal Router, with ARCDEX's fee taken in the same transaction. Nothing new to deploy.

- **Code:** `src/arcdex/api/universalRouter.ts` (encoders, router and quoter lookup, Permit2). `buildSwapRoute` returns `{ kind: 'v4native', key }` for them; `ArgusSwapWidget` trades them in `submitNative`.
- **Contracts** (Uniswap's deploy lists for Arc): Universal Router 2.1.2 `0x8702…2650`, else 2.1.1 `0x4fca…9fb1`; V4Quoter `0x8Dc1…8F94`; Permit2 `0x0000…8BA3`. The router and quoter are used only after their `poolManager()` answers Arc's PoolManager `0x8366…0951`.
- **Buy**, one transaction, `msg.value` = the USDC (the 6-decimal amount × 10¹²):
  - `TRANSFER` each fee share (referrer, then fee wallet).
  - `V4_SWAP`: `SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL` native, `TAKE_ALL` the token ≥ min out.
  - `SWEEP` native back to the trader: a partial fill's unswapped USDC, so nothing stays in the router.
- **Sell**: the token approves Permit2 (exact amount), Permit2 approves the router (exact amount, 30 minutes), then one `execute`:
  - `V4_SWAP`: `SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL` the token through Permit2, `TAKE` the native USDC to the router.
  - `PAY_PORTION_FULL_PRECISION` each fee share. Each is a share of what's left, so each gets its exact share of the whole.
  - `SWEEP` the rest to the trader, ≥ min out.
- **Fee:** as ArcDexSwapRouter charges it. `feeBps` (2%) is read from that router and paid to its `feeWallet()`, `referralShareBps` (15%) of it to the referrer: the one bound there (`referrerOf`), else the visitor's stored invite (`referrerFor`), never the trader. The Universal Router doesn't bind referrers on-chain.
- **Safety:** quoted on the V4Quoter through the pool's hook; min out (slippage) enforced on-chain; over 15% price impact needs the tick box; the exact `execute` is simulated before signing, so a hook that refuses the router stops there.
- **Encoding:** both Arc deployments are built against v4-periphery whose `ExactInputSingleParams` has `minHopPriceX36` (sent as 0). `ADDRESS_THIS` is address(2), `OPEN_DELTA` is 0.
- **Cash (max) on any buy** leaves 0.15 USDC. Arc takes gas from the same USDC balance, up front, so a buy of all of it passes the simulation and then reverts on-chain; it also leaves gas to sell.
- **Tests:** `bun scripts/test-native-pools.ts`: selectors, commands and actions, the swap struct byte for byte against an independent encoding, fee shares, and the router's own arithmetic for sells (portions) and buys (partial fills). Browser checks cover a Minara coin's buy and sell (the signed transactions decoded), a bound referrer's share, a self-referral ignored and Cash (max).

## Mercuri and SolonPad bonding curves (2026-09-26)

Before graduating, a Mercuri coin, or a SolonPad coin launched in curve mode, trades only on its own bonding curve. ARCDEX now trades it there, from the trader's wallet, as those launchpads' own sites do. The coin is found from its address alone, so it works whether GeckoTerminal lists it or not (search → paste the address → Open token).

- **Code:** `src/arcdex/api/curves.ts`: factory lookups, curve state, quotes, the buy and sell calls, and trade-event decoding. `SwapRoute` has `{ kind: 'curve', curve }`, traded in `ArgusSwapWidget.submitCurve`.
- **Contracts:**
  - **Mercuri** (github.com/mercuri-finance/mercuri-launch-contracts, v1.0.0 as deployed): LaunchFactory `0x8f5D…59EB` `curveOf(token)`.
    - Each curve: `buy(minTokensOut, referrer, deadline)` payable; `sell(tokensIn, minUsdcOut, referrer, deadline)` after an approval.
    - Views `quoteBuy`, `quoteSell`, `phase()` (0 trading, 1 sold out and graduating: sells only, 2 graduated), `price()`, `progressBps()`.
  - **SolonPad** (github.com/solonlend/solonpad-skill): Pons V2 factory `0xd6b8…5A3b` `getLaunchedToken(token)`.
    - Each curve: `buy(quoteIn, minTokensOut, recipient)` payable, with `msg.value == quoteIn`; `sell(tokensIn, minQuoteOut, recipient)` after an approval.
    - No quote view: buys and sells are quoted by simulating them from the trader, with `minOut` 1 (a zero minimum can revert, `MinimumOutputRequired`).
    - Curves quoted in another ERC-20 (`isNativeQuote() == false`) aren't traded here.
  - Both take native USDC (18 decimals) as `msg.value`. Mercuri's refund on a buy that sells the curve out, and SolonPad's partial-fill refund near graduation, go to the caller: the trader.
- **Fee:** ARCDEX's 2% comes from ArcDexCurveRouter (`0xF8e8…6441`, "Deployed Contracts" above), the default in `api/_curves.ts`.
  - **With it:** trades go through the router, and the fee is taken in the same transaction. Sells are approved to the router. The widget shows Platform fee 2% (read from the router) and the curve's own fee.
    - Quotes: a buy is the curve's quote for what's left after the fee. A Mercuri sell is the curve's `quoteSell` minus the fee. A SolonPad sell is the router's own `sellSolon`, simulated after the approval.
    - `api/curves.ts`: `loadCurveRouter`, `quoteRouterBuy`/`quoteRouterSell`, `routerBuyCall`/`routerSellCall`, `curveSpender`. A configured router that can't be read stops the trade; it's never skipped.
  - **Without it (`VITE_ARCDEX_CURVE_ROUTER_ADDRESS=off`, as before the router was deployed):** ARCDEX adds no fee. ArcDexSwapRouter can't call a curve, and a fee sent in a second transaction wouldn't be atomic. The widget shows Platform fee 0% and the curve's own fee (1%), plus SolonPad's creator tax.
  - Mercuri pays 0.20% of each trade (out of its 1% fee) to the referrer a trader names on its first Mercuri trade, for all of that trader's later Mercuri trades, on the curve and in the graduated pool. ARCDEX names its fee wallet: from the widget for a wallet trading directly (`ArcDexSwapRouter.feeWallet()`), and from the router for the router itself (Mercuri's trader for everything routed).
  - Those shares accrue in Mercuri's FeeManager `0x31D1…2580`: the fee wallet claims them with `claim(to)`.
  - After graduation the coins trade in their Uniswap v4 pools with ARCDEX's 2%: Mercuri's pools pair with ERC-20 USDC (ArcDexSwapRouter), SolonPad's with native USDC (the Universal Router).
- **Snipe tax:** buys right after launch pay a launch snipe tax (Mercuri: from 99%, to 0 over 120 blocks; SolonPad: `currentSnipeTaxBps(recipient)`). The quote shows it; buying needs its own tick box ("I accept the X% snipe tax"), and the price-impact check sets it aside.
- **Coin page:** with a live curve, the curve is the market.
  - Its Buy/Sell events are the chart and the trades list (`poolSwaps.curveMeta`), read from the chain: they're the curve's complete list. The market engine indexes these curves too, for the Terminal.
  - A trade through the curve router names the router in the curve's event, so the page lists the transaction's sender as its maker (`resolveMakers`, as for pool swaps).
  - Its price leads (Mercuri's events carry it exactly; SolonPad's reserves are re-read after each trade). Supply, name and symbol come from the token when GeckoTerminal has none.
  - A banner shows the way to graduation, and the curve is re-read every 15s while live.
  - Portfolio values held curve coins on their curve, and its Sell sheet (`TokenSwap`) trades them there.
- **Tests:** `bun scripts/test-curves.ts`: every selector and event topic against the published sources, the calls byte for byte (straight to the curve and through the router), and trades decoded from both launchpads' events. Browser checks cover a Mercuri coin opened by address (curve route, fees, price, its trades from its events) and its buy (value, min out, the fee wallet as referrer) and sell (exact approval to the curve). They also cover the snipe-tax confirmation, a graduating curve taking sells only, a SolonPad coin's buy and sell, and the Portfolio's value and Sell sheet.

## Social trading layer (fomo.family-style) — ARCDEX

ARCDEX aims to be the social trading app for Arc. fomo.family (Solana, Base, BNB, Monad, Robinhood Chain, Ethereum) has no Arc support, so that's our gap. Owner decisions (2026-09-25): wallet = account; **2% platform fee, 15% of it to referrers**; onboarding via the in-browser trading wallet plus USDC deposits.

**Identity.** `src/arcdex/lib/identity.ts` `useTrader()` returns the unlocked in-browser trading wallet (one-tap, no pop-ups), or else the connected wallet. Profiles, trades and referrals all belong to that address. `embeddedWallet.ts` fires `WALLET_EVENT` on unlock and lock.

**Database** (`supabase/migrations/20260925000000_arcdex_social.sql`, run by the owner in the Supabase SQL editor). `arcdex_*` tables hold profiles, follows, theses (+likes), and the indexed router trades, referrals and payouts, plus SQL functions for the leaderboard (realized PnL), trader positions and referral stats.
- **Security:** public-read RLS; no client write policies.
- **Verified on PGlite:** safe to re-run, PnL math correct, constraints enforced, anonymous writes blocked.

**Server (Vercel `api/`).**
- `/api/session`: wallet signs a sign-in message (EOA + ERC-1271/6492) and gets a 30-day HMAC token. Needs `ARCDEX_SESSION_SECRET`, which is set. Tests: `bun scripts/test-session.ts`.
- `/api/social`: profile, follow, thesis and like writes for the token's own address only; 20 theses/day.
- `/api/index-trades`: idempotent, throttled indexer of router `Swapped`/`ReferrerBound`/`ReferralPaid` events (v1 from block 22548761, the current router, the deployed ArcDexCurveRouter, and any other curve router `VITE_ARCDEX_CURVE_ROUTER_ADDRESS` names) into Supabase. Pages call it opportunistically. Tests: `bun scripts/test-index-decode.ts`.
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
    - Line or Candles, Price/MCap switch, screenshot, fullscreen. The line is green while the visible window is up and red while it's down, following pans and zooms.
    - Every coin opens on 15m, Line and Price (owner's request, 2026-09-27). A switch holds while the coin is open and isn't remembered. `lib/chartStyle.ts` keeps every chart on the page on one style.
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

## Whitepaper + roadmap (2026-09-26)

- **Roadmap data:** `src/arcdex/landing/roadmap.ts` is the one source for the landing page's `#roadmap` section (translated), the whitepaper and the X images.
  - `ROADMAP_START` (Phase 1's Monday, UTC) and `PHASE_DAYS` set every date. To move the plan, change `ROADMAP_START`. Each card's status (Planned, In progress, Done) follows the clock.
  - Items with `dep: true` get a †: they're built in the phase but go live only once a partner, an audit or a regulator allows it.
  - Strings are marked with `N_()`; new ones go into all six dictionaries.
- **Landing:** a `#roadmap` section (Phase 0 "Live now" + 7 phases) and a `#whitepaper` card (read, download the PDF, share on X), with links in the nav and footer.
- **Whitepaper:** `/whitepaper` (`landing/Whitepaper.tsx` + `whitepaper.css`, English only; `VERSION` and `PUBLISHED` at the top).
  - `whitepaper.html` is its own Vite entry, so X link previews read its OG/Twitter tags. `vercel.json` rewrites `/whitepaper` to it, and `src/main.tsx` routes it in dev.
  - The print styles make the PDF: a full-bleed dark cover, then A4 pages numbered by `@page` margin boxes.
  - `?card=cover` (1600×900) and `?card=roadmap` (1080×1350) render the images for X.
- **Files in `public/`:** `arcdex-whitepaper.pdf`, `arcdex-whitepaper-x.png` (also the link-preview image) and `arcdex-roadmap-x.png`. They're committed, not built, so regenerate them after editing the whitepaper or the roadmap:
  - build, run `vite preview --port 4173`, then `node scripts/whitepaper-assets.mjs` (options in its header);
  - check the PDF has no near-empty page (v1.0 is 8 pages).
- **Phase 1 needs the owner:** the 2% → 1% swap fee is `setFeeBps(100)` on the swap router (owner key), and cashback is paid from the fee wallet. The site doesn't do either by itself.

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

## Every screen size: nothing off-screen (2026-09-30, owner's request)

"All features and buttons reachable, no button out of screen, on tablets and every size."
- **Measured first.** The top bar overflowed by 151px at 1280px, 88px at 1100px and 164px at 1024px, cutting off Connect Wallet and the language picker. On a 320px phone, opening search pushed Connect Wallet off the screen, and the results sheet (like every top-bar menu) sat partly under the tab bar.
- **The top bar** (`arcdex.css`, the "top bar is never wider than the screen" block): less important things drop out as the screen narrows, and each is still reachable elsewhere. The right side (language, account, Connect Wallet) never shrinks, and the links scroll sideways only as a last resort.

  | Width | What changes |
  |---|---|
  | ≤1480px | the secondary links (Feed, Leaderboard, Clans, Rewards; also in the left panel and the account menu) and the "Arc Mainnet" label drop out |
  | ≤1320px | the burn ticker is just its 🔥, still the way to /burn |
  | ≤1180px | the MAINNET badge goes and the links get tighter |
  | 901–1024px | the logo icon alone |
  | ≤900px | the links move into the ☰ drawer |
  | ≤767px | the phone layout, with the tab bar |

  - AUTOTRADE is a highlighted link right after Terminal.
- **The drawer (≤900px)** lists every page: Terminal, Feed, Leaderboard, Clans, Rewards, Launchpad, Swap, Bridge, Portfolio, Autotrade, Alerts, Transfers and $ARCD burn (`MOBILE_NAV` in `App.tsx`).
- **Phones (≤600px):** search opens as a full-width row under the top bar (its position is in the stylesheet, not inline, so the phone rule wins). Any menu open in the top bar lifts it above the tab bar (`.top-navbar:has(.menu-pop)`).
- **Checked (2026-09-30)** with an in-page audit: interactive elements off-screen and not in a scrollable box, and sideways page scroll.
  - Pages: /app, /autotrade, /swap, /bridge, /launchpad, /portfolio, /leaderboard, /feed, /clans, /rewards, /transfers, /burn, /alerts, a coin page, and the landing.
  - Widths: 1920, 1440, 1366, 1280, 1180, 1100, 1024, 1000, 960, 901, 820, 768, 390, 360 and 320px. Nothing off-screen.

## Search: any coin, by name or contract address (2026-09-30, owner's request)

- **`lib/coinFinder.ts` `useCoinFinder(query, local)`:** the coins the page already has, at once. Then, from two characters, each source capped at 5s so none holds the others back:
  - the engine's `GET /v1/search?q=`: every launch in its memory and its Postgres (`HistoryStore.searchTokens`), on every launchpad;
  - GeckoTerminal's `/search/pools`: names or token addresses, through `/api/gecko`;
  - for a full address no one lists, the token's own `symbol()`/`name()` on-chain.
- Merged by address and ranked with the Launchpad's matcher, `searchScore` in `api/_marketProtocol.ts` (shared with the engine): exact ticker or address, then prefixes, then contains; bigger coins first among equals.
- **Top bar (`SearchBox.tsx`):** coins with name, launchpad and MC. Enter opens the best match. A wallet address says "No token at this address", and View trader still works.
- **Terminal:** while its search box has text, "More on Arc" under the list shows coins the list isn't showing (`components/FoundOnArc.tsx`). The list itself still follows its tab and filters.
- **Checked:** a coin launched minutes earlier on an unlisted launchpad (NATFLEX), found by address and by name; a wallet address (no token, view as trader); and a 320px phone.

## Phones: native-app layout (2026-09-26)

One breakpoint, `max-width: 767px` (`lib/useMobile.ts`, and the last block of `arcdex.css`). Desktop is unchanged.
- **Shell:** a bottom tab bar (`MobileTabBar`: Home, Signals, Swap, Portfolio, More; Feed moved to More on 2026-09-30) replaces the hamburger. "More" is a sheet with every other page, the trading wallet, and the lists drawer (watchlist, trending, most held). The top bar respects safe areas (`viewport-fit=cover`).
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
- **Pipeline:** Arc WebSocket + getLogs (`chain/stream.ts`) → launchpad adapters (Argus Portals 7 & 8, ArcLaunchpad, Mercuri, SolonPad) and the swap parser (v4 PoolManager + v3 factory pools) → `MarketEngine` (hot state, 1s–1d candles) → Redis (hot), Postgres (history) and WebSocket/REST.
- **Mercuri and SolonPad (2026-09-27, `launchpads/mercuri.ts`, `solonpad.ts`, `curveBook.ts`):** their launches (`TokenCreated`, `TokenLaunched`) reach the Terminal as new tokens, and their curve trades stream live, until the coin graduates to its pool, which the swap parser reads like any other.
  - Each launch has its own curve contract, so the stream takes every Buy/Sell-shaped event on the chain (address-less topic filters, as for v3 swaps). A curve counts once its factory names it back.
  - Curves come from launch events, or are checked on their first trade: one launched before the engine's window. Each is checked once, however many trades ask at the same time. Definite "not a curve" answers are remembered; a check the chain couldn't answer is retried at the next trade (`curve_check_errors`).
  - SolonPad curves quoted in another ERC-20 (tokenized stocks) are left out.
  - The trade's wallet is the transaction's sender (a router in between names itself in the event). Prices are in native USDC: Mercuri's from the reserves each event carries, SolonPad's from what the trade paid on the curve.
  - Events and addresses are shared with the site: `api/_curves.ts`.
- **Every Arc launchpad (2026-09-30).** GeckoTerminal's Arc venues were traced to their launch contracts from real coins (`engine/scripts/discover-launchpads.ts`). 24h volume then: Argus $4.36M, Peach $840k, Faze $147k, o1 $91k, Minara $20k. Tolly, RadarDEX, Warp and Archemist list no pools any more.
  - **Any launchpad that opens a Uniswap v4 pool at launch** (`launchpads/v4Launches.ts`): a coin whose pool is initialized in the block that created it is a launch. It's named from the contract the transaction went to (`LAUNCH_ENTRY`: Aka.fun, o1, Minara, Long.supply), else "Other" with `entry` set, so new launchpads show up without a code change. Launchpads with their own adapter are skipped (`ADAPTER_ENTRY`), and an adapter's report replaces a generic one.
  - **Peach** (`launchpads/peach.ts`): no published ABI; its events were decoded against each transaction's transfers. Every coin has its own curve contract, priced in the USDC ERC-20, until it graduates to a v4 pool. A curve counts if a launch named it, or if its code matches Peach's curve template and was deployed with USDC as its quote. Curves quoted in other tokens (cirBTC, …) are left out.
  - **Faze** (`launchpads/faze.ts`): one contract launches and trades every coin. `getCoin(token)` gives each coin's quote; only native-USDC coins are indexed (some are quoted in Faze's own FAZE token). Its contract has a sniper tax and buy/sell-window fees, which the safety scanner should read.
  - **Code templates** (`intel/templates.ts`): a launchpad deploys the same contract for every coin, differing only where each deployment fills in its own values. `engine/scripts/learn-templates.ts` learns those byte ranges from real instances and writes `intel/templateData.ts`. Run it with `--check` to see whether today's contracts still match.
  - **Not yet:** Virtuals (Uniswap v2 pairs priced in its VIRTUAL token; the engine reads no v2 swaps yet).
  - Tests: `engine/test/v4Launches.test.ts`, `peach.test.ts`, `faze.test.ts`, on recorded mainnet data (`engine/scripts/capture-*.ts`).
- **Signals and paper trading (2026-09-30, `engine/src/bot`, owner decisions: the owner's own bot wallet on the engine, paper trading first).** Nothing here promises a win rate: the rules and thresholds are starting points, and paper results decide what changes.
  - **Safety scanner (`intel/`)**, one report per coin (`scanner.ts`). Any failed hard check means no signal; a check that can't be answered yet keeps it pending, never passed.
    - **Risk checks don't block (owner's decision, 2026-09-30):** holders (top 10 over 50%, the creator over 15%), `serial` (the creator launched 3+ other coins that day) and `copycat`. A coin that passes every hard check but not a risk check is `risky` (holders not known counts as risky), and a snipe on it becomes a **scalp** (below). A creator who already sold over half their buy is still a hard fail.
    - Why: in the first local runs, 5 of 6 snipe candidates had a creator who bought 49.9% of the supply for $2,500 at launch (one sold it all 110 seconds later). The owner chose to trade them small and fast rather than skip them.
    - Contract: the launchpad's own code (`templates.ts`, learned by `scripts/learn-templates.ts`: Argus P8, Peach, Faze, Mercuri, SolonPad, Aka.fun, o1, Minara coins; Argus P7 coins are clones of `0x1b74…e500`), else what it can do (`bytecode.ts`): mint, freeze, pause, trading switch, fees, limits, upgrade, drain, with a live owner. Also proxies and self-destruct. Every launchpad's standard coin was checked: none can mint, blacklist or pause.
    - Hook: none, a launchpad's own (template: Argus P7/P8), a known shared one, or a custom hook that can change or block swaps (fail).
    - Honeypot (`honeypot.ts`): a probe contract (`contracts/test/sim/HoneypotProbe.sol`) buys $1 through the real pool and hook, passes it to a fresh address and sells it from there, in one `eth_call` with state overrides. A sale that reverts is a honeypot; a round trip over 25% in a pool worth $2k+ is a tax. `engine/scripts/check-honeypot-probe.ts` checks it on mainnet, including a coin swapped for a deliberate honeypot (`contracts/test/sim/HoneypotToken.sol`).
    - Holders (`holders.ts`: top 10 over 50%, creator over 15%, contracts among the largest left out), bundling (3+ wallets taking over 25% of supply in the first 3 blocks), clusters (`clusters.ts`: 3+ early buyers funded from one source, or by the creator; hubs that paid 25+ wallets don't count), wash trading, the creator selling over half their buy or launching 3+ other coins that day, and copycat tickers.
      - Cluster funding traces a payment from a contract to the transaction's sender: a sell paid by the v4 PoolManager or a curve is the wallet's own transaction and says nothing, and a disperse names whoever sent it. A source whose payouts get no answer over the 100k-block window is counted over the same window in 9k-block slices (every endpoint takes those); a slice without an answer makes it a hub. (Counting only the last 10k blocks, as first built, missed a hub that paid 482 wallets hours earlier and blocked a clean coin.) (Before 2026-09-30, buyers who had sold something showed as a cluster "funded by" the PoolManager.)
    - Templates mask whole values (a fee baked into the code), so a launch with different settings still matches. Relearn with `bun engine/scripts/learn-templates.ts`; a source that can't be relearned keeps its last template.
  - **Signals (`signals/rules.ts`, `bot/bot.ts`):** watches every coin launched in the last 48h from the engine's own trades.
    - **Loosened 2026-09-30** (owner: "trades within 2 minutes, not waiting for 10×; we only need $1–5 a trade"). The rug guard and the safety scan stay as strict. Production's rejection counts weren't reachable from the build sandbox, so the thresholds came from the rules themselves; `GET /v1/bot/rejections` (below) now counts them for the next round.
    - Snipe: 20s–10min old, 6+ buyers (was 8), $200+ bought ($300), buys 1.3× sells (1.5×), no buyer over 25% of buys, not yet 5× from its first trade, within 15% of its peak. Since 2026-09-30 the buyers, the buying and the prices are the market's own (`Flow.organic`): the creator's buys and the launch blocks' are left out, every sale counts.
    - **Momentum fast scalp** (2026-09-30, owner's request: "scan many coins per minute and fast scalp for $1–2"): any watched coin 60s+ old (was 90s) whose last 2 minutes (a rolling tape, `RecentTapes`) show 6+ buyers (3 until 2026-10-01), $100+ bought ($150), buys 1.6× sells (2×), the price up 2–20% (35% until 2026-10-01) and within 8% of the window's high, no buyer over 40% of the buying, and $2,000+ liquidity ($2,500). The same coin again after 30 minutes, not right after its snipe. Signals carry `rule: 'momentum'`.
    - **Cleaner signals (2026-10-01, owner: "refine the trading signals so we have the cleanest signals").** Read from production's first 22 closed trades in the engine's paper book (a small sample; `GET /v1/bot/stats` now has `byRule`, and the Bot results tab shows it, so the next round can check it):
      - The momentum scalp's two winners had 17 and 19 buyers in the window; the three with 3–5 buyers all timed out without moving. It now needs 6.
      - The two that were already up 26% and 29% in the window both lost: the move is capped at +20%.
      - The coins costing 5.9% and 7.8% to buy and sell back lost to their costs. No fast scalp on a coin whose probe round trip is over 5%, no snipe or dip rebound over 12% (`tooCostly`, `MAX_ROUND_TRIP_PCT` in `signals/rules.ts`; the scanner shows it as "costs too much to buy and sell back").
      - Snipes on a risky coin (the creator holding about half the supply) stay fast scalps, as the owner decided on 2026-09-30: 8 took their profit, 1 was closed by the rug guard.
      - Tests: `engine/test/balanceAndSignals.test.ts`.
    - **Signals the bots trade, and bots that learn (the next round, owner: "the signal engine produces signals but the bots are not trading; refine the signal engine to produce quality signals; some bots don't learn and improve").** What production showed:
      - **Why bots skipped signals:** each bot learned one set of entry filters per strategy. A fast scalp comes from two rules that count buyers differently: a snipe on a risky coin counts them since launch (30–450), a momentum burst over two minutes (6–30). A buyer minimum learned on the winning snipe-scalps blocked every momentum signal.
      - **The record by rule** (the engine's paper book): momentum bursts won 4 of 14 (−$7.79), 8 of their 10 losses stopped out within 90 seconds; snipe-scalps won 12 of 16 (+$11.79).
      - **Filters per kind of signal (`bot/learner.ts`):** `StrategyTuning.rules` holds learned filters for `momentum`, `snipe` and `second-leg` separately, and `admits(t, features, rule)` checks a signal against its own kind's (`filtersFor`). The strategy-wide `filters` stay open. Older bots' filters move to the kind they were learned on when they load (`migrateTuning`: a fast scalp's and a snipe's to `snipe`, a dip rebound's to `second-leg`). Each learn note names its kind (`LearnNote.rule`), and the dashboard shows them per kind.
      - **Shared learning:** a bot with fewer than 20 trades of a kind also reads other bots' closed trades of that kind (one per signal, the last 300 per strategy, including the engine's own paper book: `PaperAccounts.observe`), so a new or quiet bot learns before its own 20th trade. Its notes say how many were its own ("read from its 3 trades and 11 of other bots'"). Exits are still learned from its own trades only.
      - **A losing kind is skipped:** a fast scalp's kind that won a quarter or less of its last 4–6 trades for the bot, at a loss, is skipped (`skip`), and tried again after 12 hours (`LEARN.retryRuleAfterMs`, in `relax`).
      - **Probation (`bot/probation.ts`):** a rule whose last 20 closed trades in the engine's paper book (at least 10, within 7 days) lost money and won under half is on probation. Its signals still fire and the paper book still trades them, so it keeps being measured, but visitors' bots and the owner's live bot sit them out ("probation" in the skip counts; a badge on the Signals tab; `probation` on the signal and in `GET /v1/bot/stats`). A rule whose thresholds changed (`RULE_REVISED`) is judged on its own trades once it has 10. Momentum starts on probation.
      - **A stricter momentum rule (`signals/rules.ts`):** 8 buyers in two minutes (was 6), and still being bought in its last 30 seconds (buys at least match sells, from 2+ wallets; `scalp:now` in the scanner). Snipes are unchanged: they win.
      - Tests: `engine/test/botLearning.test.ts` (per-kind filters, shared learning, skipping and retrying, the migration), `engine/test/probation.test.ts`, `balanceAndSignals.test.ts`.
    - **The bots as a team (2026-09-30, owner: "I opened a LIVE bot but the signals don't fire; improve the signal quality and the time a new bot takes to start trading; learn from other bots, paper or live; work together as a team").**
      - **What production showed** (every bot's trades, one outcome per signal):
        - clean-coin snipes: 6 signals, all 6 won (about +$3.84 a bot);
        - snipes on risky coins (fast scalps): 12 of 14 won;
        - momentum bursts: 5 of 15 won, at a loss (so still on probation).
        - The live bot (`kimi-one`) had done nothing wrong: its last 5 paper snipes all took profit, and no signal fired between it going live and the check. Signals ran at under 2 an hour. The candidates in the counters failed real safety checks (a sale-blocking hook, clustered funding, wash trading), and most launches never draw 6 real buyers. So the rules weren't loosened.
        - New bots followed Fast scalp only, so they never saw the clean snipes (a scalp-only bot like `dino` still doesn't).
      - **The team pool (`PaperAccounts.observe`, `teamTrades`):** every bot's closed trades, paper and live, and the engine's paper book, one per signal, the last 300 per strategy.
      - **Every bot reads it, always:** its own last 20 trades of a kind and the team's last 20, for entry filters ("read from its N trades and M of the team's"); exits from its own only. And every 10 minutes a running bot reads the team's trades closed since its settings last changed, once 5 have (`teamSync`, `TEAM`, `learn(…, force)`): it learns from signals it didn't take, before its own trades close.
      - **A new bot starts from the team's best (`teamPlaybook`):** for each strategy, the settings (exits and learned filters) of the teammate with the most made per trade there (10+ closed trades, in profit), as its version 1, with a `team` note ("Started from the team's best fast scalp settings: Veteran's (17 trades, 76% won)").
      - **A new bot trades at once:** `POST /v1/me/bots` gives it $1,000 of virtual USDC and starts it, and the site preselects Snipe and Fast scalp. Each strategy card shows the team's week ("Team, 7 days: 9 trades, 78% won, $27.48").
      - **Live on the team's record (`readinessWithTeam`, `TEAM_READY`):** a bot may go live on its own 20 trades as before, or with 5 of its own without a net loss while the team's trades on its strategies over the last 7 days meet the same bar (20+ trades, 55%+ won, a profit factor of 1.2+, a net profit). The checklist says which ("Proven by the team").
      - **Probation on everyone's trades:** the engine's paper book first, then the team's signals it didn't take, one per signal, paper or live.
      - **Site:** a Team card on each bot's Overview (bots trading, the team's week per strategy, how often this bot learned from the team, and a nudge to add a strategy the team is winning with that it doesn't follow). `GET /v1/me` and the bot view carry `team` (`TeamView`).
      - **The marketplace, live and paper apart:** `GET /v1/bots?mode=live|paper`, with `counts` of both. The Marketplace tab has Live bots (real USDC, their own wallets) and Paper bots (virtual USDC); it opens on Live, or on Paper while there are no live bots.
      - Checked in a browser against a stand-in engine (the engine's own account code, a seeded veteran and a live bot): the marketplace's two lists, the create screen with both strategies and the team's records, a new bot running at once with the veteran's settings, "Proven by the team", and the Team card.
      - Tests: `engine/test/team.test.ts` (live on the team's record, the playbook, the team sync, live trades in the pool, probation on everyone's trades, the marketplace's modes).
    - **Signal quality, 80% to live bots, sizes from capital (2026-09-30, owner: "the live bots make losses; 80% of the signals to live bots, 20% to paper; improve the signal quality; size trades by the bot's initial capital, not a default; let even $10 bots trade").**
      - **What the live bots lost:** both live bots (`carel`, `arcdex-agent`) bought BAGEY, a snipe with a safety score of 100 and 31 buyers, which dumped 32% six seconds after the buy. The engine's own paper trade lost too (−$9.91). What set it apart: buys only 1.6× sells, with 10 wallets already selling 22 seconds after launch. Every clean snipe that won had no sells yet, or buys 5× sells or more.
      - **The quality score (`signals/quality.ts`, 0–100):** the rule's win rate over its last 20 team trades (35; 0.5 while under 5), buys over sells (20; no sells or 5× is full), the safety score (20), buyers (10; 15+ is full), the largest buyer's share (10; none over 40%), and the round trip (5; none at 8%+). BAGEY scores about 15 points under a winning clean snipe. The weights are a starting point.
      - **80/20 (`QualityRank`):** each signal is ranked against the last 50 (probation signals left out). The top 80% are live-grade: every bot may take them. The bottom 20% are paper only: live bots, the owner's included, pass them over ("paper-grade" in the skip counts), and paper bots still trade and measure them. Of all signals, the top 40% are tier A. The first 8 after a restart rank by score alone (tier A from 80), and the rank is seeded from the stored signals. Each signal carries `quality` (score, grade, tier, rank, parts); the Signals tab shows a badge and says how the split works.
      - **Sizes from the bot's capital (`sizeFromCapital`, `CAPITAL_SIZING`), for paper and live bots (not the owner's bot):** 20% of what the bot is worth on a tier-A signal, 10% otherwise (paper-only signals are B; since 2026-09-30 the share follows the coin's risk instead: 20% on a safe coin, 10% on one with a risk flag), at least $1, so a $10 bot trades $2 or $1. Never over 1.5% of the pool's liquidity or the live cap ($50), and never a trade whose round trip eats the take-profit ("costly"). What it's worth: paper, cash plus open trades; live, the wallet's USDC plus open trades at cost, which at the start is its initial capital. It replaces the profit-target sizing (`sizeForTrade` stays for reference). The live trader still reads the wallet before each buy and caps at 20%, now in $0.10 steps with a $1 minimum (was $2).
      - **Small live bots:** the gas reserve is $0.30 (was $1: a swap on Arc costs about $0.005), and the day's loss limit is 10% of the wallet from $1 (was from $5).
      - Tests: `engine/test/quality.test.ts` (the score, the split, the tiers, sizes); `autotrade.test.ts` (tier shares, a $10 bot, a live bot passing over a paper-only signal); `live.test.ts` (a $10 wallet buys $2).
    - **Why live bots lost, and live speed (2026-09-30, owner: "the live bots are making losses: read the logs, refine the signals to guarantee profits, find out the reason").** No strategy can guarantee a profit; this is what the logs showed and what changed.
      - **The logs:** 5 live trades, all losses, on two signals, BAGEY (−32% in 6s) and ASTONKA (−25% in 32s), −$6.81 in all. Neither rose after the buy. Paper lost on both too.
      - **The reason:** a live buy landed about 2.5s after its signal, and a sale about 2s after its trigger. Paper filled both at once, at the signal's price and the trigger's. BAGEY was already 15% down when the live buys landed; ASTONKA 5% up.
        - Snipes make their move in those seconds. LUMOIN made +40% on paper within 5s; bought and sold at live speed it loses 67%. DAYSHIFT went from +40% to −40%.
        - Every signal of the last day was replayed on its coin's real trades (the engine's `/v1/tokens/:token/trades`). The last 40 averaged −5.6% a trade at instant fills and −3.7% at live speed; clean snipes went from +16% (6 of 8 won) to −1.3% (3 of 8).
        - Nothing tried made them reliably profitable at live speed: waiting 5–60s to confirm, a drift guard, tighter or wider exits, run-up, buyer and sell filters, even 1-second fills. Everything averaged −5% to 0%. Wins are common (50–80%), but a few gap-downs of −25% to −90% through the stop wipe out many small wins. The paper records that let bots go live were measured at fills a live bot can't get.
      - **Paper at live speed (`trading/paper.ts` `LIVE_SPEED`):** paper bots and the engine's paper book now fill as live does.
        - A buy fills at the first price 2.5s after its signal (cash set aside meanwhile; `PaperAccounts` `pending`, `Bot` `pendingHouse`), and is skipped if the price moved more than 5% by then ("drift").
        - A triggered exit (take-profit, stop, time, rug guard, the creator selling, a failed safety re-check) fills at the first price 2s later (`Position.pendingExit`, `onPrice(…, lagMs)`, `closeNow(…, lagMs)`), or at the last price on the next tick.
        - Paper records, probation, the team's records, readiness for live and learning now all reflect what live gets. `speed: null` keeps instant fills (older tests).
      - **Drift guard for live buys (`LiveTrader.open`, `priceNow`):** no buy once the price moved more than 5% since the signal, for visitors' live bots and the owner's.
      - **The live gate (`signals/liveSpeed.ts`):** the engine replays every signal on its coin's stored trades at live speed, with the exits a new bot trades with (`replayAtLiveSpeed`, `Bot.replayDue` every 30s, 8 signals at a time, the stored signals first after a restart). Each kind (`rule/strategy`) keeps its last 20 replays over 7 days (`LiveSpeedBook`).
        - Live bots trade a kind only once it has 10+ replays averaging at least +0.5% a trade after costs (`LIVE_GATE`). Otherwise its signals are paper only, with the reason.
        - The quality score's rule record is the live-speed one once it has 5 replays.
        - When the gate was built, no kind qualified: live bots wait, their USDC untouched, and trade by themselves when one does.
        - `GET /v1/bot/stats` has `liveSpeed`, and signals carry `quality.liveSpeed`.
      - **Site:** an "At live speed" card on the Signals tab (each kind: replays, won, average a trade, live or paper only). A live bot's Overview says which kinds it may trade now, or that it's waiting for proof.
      - Tests: `engine/test/liveSpeed.test.ts` (exits and buys at live speed, drift, replays of a LUMOIN-style spike, the gate, the engine replaying stored signals); `live.test.ts` (the drift guard).
    - **Where signals go: live bots only, every signal (2026-09-30, owner: "the signal engine produces signals but the trading engine doesn't trade; all the signals to live trades only for now; the settings from when paper trading was making profits, on live trades").**
      - **Why live bots stopped:** the live-speed gate (no kind of signal qualified) and the 80/20 routing sent every signal to paper only.
      - **The settings, as when paper was booming (before the gate and the 80/20):** live bots take every signal not on probation. Probation stays (momentum was on it then too).
        - The quality rank still sets the tier, so the size (20% or 10% of the bot's capital).
        - The drift guard stays: a live buy is skipped once the price moved over 5% since the signal (BAGEY was 15% down).
      - **Told plainly:** the paper profits then came from instant fills, which a live bot can't get. The same signals replayed at live speed averaged −3.7% a trade, so these settings don't bring back those profits by themselves. The "At live speed" card keeps showing what each kind makes at live speed.
      - **Visitors' paper bots get no signals for now:** "not traded: signals go to live bots only for now" (`live-only` in the skip counts), and a note on their dashboard. The engine's own paper book still trades and measures every signal at live speed, feeding probation, the replays and the team. While paper bots get no signals, a bot can go live on the team's record alone (no trades of its own needed).
      - **Settings (Railway, arcdex-engine):**
        - `BOT_LIVE_SIGNALS`: `all` (the default now) or `proven` (only the kinds that make money at live speed, and not the lowest 20% by quality).
        - `BOT_PAPER_SIGNALS`: `off` (the default now) or `on` (paper bots trade signals again).
        - `GET /v1/bot/stats` has `routing`; `GET /v1/me` has `paperSignals`.
      - **Fees on bot swaps:** bot swaps pay no per-swap fee (they go through Uniswap's Universal Router, not ArcDexSwapRouter). The platform's fee on a bot is a share of each winning live trade's profit, sent to the fee wallet `0x2742…86Bb` when the trade closes; losing trades pay nothing. All five live trades up to then lost, so the fee wallet had received nothing from bots.
      - **The profit fee is 15% (2026-09-30, owner: "no bot swap fee as usual, and 15% on profit realized for each winning trade"; it was 2%).** `PROFIT_FEE.bps` 1500 in `bot/userLive.ts` (`PROFIT_FEE_PCT` for words). Paper wins pay the same 15% virtually. The Tier 3 perk (not enforced) reads "half the profit fee: 7.5% instead of 15%". Tests: `accounts.test.ts`.
    - **Profit secured while it rises, smaller trades on risky coins (2026-09-30, owner: "make sure live bots secure a bit of profit; for coins we're sure are safe, hold longer or take a share while it's still rising?", then "do it").** Nothing here guarantees a profit.
      - **The evidence:** the 23 signals live bots took over 16 hours, replayed at live speed on the coins' real trades (buy 2.5s after, each sale 2s after its trigger, the drift guard, measured costs), each plan judged on both halves of the period.
        - Selling all at +15% (scalps) or +40% (snipes), as before: −7.4% a trade (−10.1% and −3.3% in the halves).
        - Half at +10%, then the stop to break-even and the rest trailing 25%, an hour at most: −1.1% (−1.7% and −0.2%). The trailing half caught runners of +108%.
        - Holding longer (half at +20%, a 30% trail, 2 hours) and trailing from the start both did worse.
        - Still not a profit on that sample: sudden crashes of 27–80%, which no stop catches at live speed, sink the average. They came on coins with a risk flag; coins that passed every check had only 2 trades there, too few to judge.
      - **Exit plan 2 (`trading/paper.ts` `STRATEGIES`, `breakevenAfterTp1`; `bot/learner.ts` `EXITS`, `EXIT_PLAN`, `toParams`):** snipes and fast scalps sell half at +10%. Then the stop moves to break-even after costs (`(1 + cost) / (1 − cost)` × the entry: a live position's cost is 0, its entry what it really paid) and the rest trails 25% under its peak. The −10% stop stays until then, out after 3 minutes unless up 3%, an hour at most, and out when the creator sells (snipes too, now). Dip rebounds keep their own take-profit (+35%) and sell half there, with the same break-even stop and trail.
        - The same for every book: the engine's paper book and the owner's bot (`STRATEGIES`), and visitors' paper and live bots (`toParams`). Snipe take-profits are learned between +6% and +60% (`TP_BOUNDS`).
        - **Bots from before move to it when they load (`upgradeExits`):** their exits become the plan's (the learned filters stay), as a new version with a learn note ("New exits: half sold at +10%, …"). `StrategyTuning.plan` is 2 once moved.
        - A trade closed after its first half says so: "Took half the profit at +11%, then sold the rest at its break-even stop (…)" (`closeNote`), and the site's trade rows read "half taken, the rest at break-even".
        - The live-speed replays (the "At live speed" card) run with the plan too: they're kept in memory, so after the deploy every stored signal is replayed with it.
      - **Size by the coin's risk (`paperAccounts.ts` `onSignal`, `bot/sizing.ts`):** 20% of what the bot is worth on a coin that passed every check with no risk flag, 10% on one with a risk flag (holders, serial, copycat, funding not traced), whatever its quality tier. Before, the tier set the share.
      - **Costs at +10% (`sizeFromCapital`):** a trade's price impact grows with its size, and at +10% a $30 trade in a $2,000 pool at a 4% round trip costs more than the take-profit makes. Such a size now comes down, $0.10 at a time, to the most that still nets something; only a coin whose round trip alone eats +10% (about 9.5%+) is skipped as "costly". Every signal live bots took in the sample had a round trip of 7.8% or less.
      - Tests: `trading.test.ts` (half at +10%, the break-even stop, the trail, an hour at most), `botLearning.test.ts` (a bot's trade end to end, `upgradeExits`), `autotrade.test.ts` (sizes; since the grades below, by grade), `live.test.ts` (a live bot sells half, then the rest at break-even), `accounts.test.ts` (the 15% fee on the whole trade, once it's closed), `signalOutcomes.test.ts` (a size that comes down to one that nets something).
    - **Signal grades, tiers by signal quality, and bots sharing a signal (2026-09-30, owner: "tiers based on signal quality: the highest tier gets the highest-quality signals, even at a small % gain, with its strategy made for them; all free by default, but ready for the day we charge, so users have already seen the potential; and all bots receiving the same signal make a huge buy on one coin, which the coin's issuer sells into"). Nothing here guarantees a profit; the grades are measured and shown, not promised.**
      - **What the signals showed** (every stored signal, 52 over 17 hours, replayed at live speed on the coins' real trades; 43 bought): the largest single buyer's share of the buying separated winners best. At 10% or less: 11 signals, 72% won with the default exits; over 20%: 26%. A risk flag didn't mark the losers: coins that passed every check won 17% (mostly momentum bursts), coins with a flag 53%.
        - **The cleanest (Prime):** 30+ buyers, the largest ≤ 10% of the buying, buys ≥ 5× sells (or none yet), run-up ≤ +10%, round trip ≤ 3%, liquidity $5,000+. All 11 were snipe-rule signals fired 32–54s after launch. Sold in full at +4% to +10%, 10 of 11 won; at +6%: +3.1% a trade, the one loss −0.5%. The default exits on them averaged +13% but lost 30% twice.
        - **Everything else**, sold in full at +6%: 8 of 12 won, −3.6% a trade; with the default exits, 3 of 12, −13%.
        - **Why a fast exit:** on the Prime coins the price reached +5% to +10% 10–48s after the signal; the creator's first sale came 33–503s after it (about two minutes typically). The creator sold within 10 minutes in 28 of 52 signals.
        - **Caution:** one day of signals, and most Prime coins followed one serial launcher's pattern. The grades keep their own records (below) and correct themselves.
      - **Grades (`signals/grades.ts`):** every signal is graded when it fires (`gradeOf`, `SignalQuality.level` and `levelWhy`): Prime (above); Core (largest buyer ≤ 20%, 15+ buyers, buys ≥ 3×, run-up ≤ +20%, round trip ≤ 5%, liquidity $3,000+); Standard, every other signal not on probation.
        - **Each grade's record (`GradeBook`, `Bot.gradeRecords`):** every stored signal replayed at live speed with the exits its grade trades with (Prime with Precision's), the last 20 over 7 days. After a restart the stored signals are replayed again, so the records fill at once.
        - **Review:** a grade whose last 10+ replays average under 0 or win under 60% is under review, and its signals are handed out one grade lower until it recovers (`effective`, `SignalQuality.review`).
      - **Precision, the top tier's strategy (`STRATEGIES.precision`, a bot's `tuning.precision`):** Prime signals only, all of it sold at +6%, −7% stop, out after 3 minutes unless up 2%, 10 minutes at most, out when the creator sells. A bot following Precision trades a Prime signal with it (before its other strategies); a Precision-only bot passes over other grades and says so. Learned take-profits stay between +3% and +10%.
      - **Size by grade (`GRADE_SHARE` in `bot/sizing.ts`):** 20% of the bot's worth on Prime, 15% on Core, 10% on Standard (replacing the risk-flag sizing of earlier that day: the data didn't support it). A signal without a grade (older engines, tests) counts as Standard.
      - **Tiers (`bot/tiers.ts`, the one table; `GET /v1/tiers`; the site's copy in `lib/tiers.ts`):**

        | Tier | $ARCD | Gets (once enforced) |
        |---|---|---|
        | Free | 0 | paper, 1 bot, Standard signals |
        | Tier 1 | 5M | live, 3 bots, Standard |
        | Tier 2 | 20M | live, 5 bots, Core and Standard, ahead of Tier 1 in a crowd |
        | Tier 3 | 50M | live, 5 bots, Prime and Precision, first in line, half the profit fee (7.5%) |

        - **What earns a tier:** $ARCD across the wallets an account links (`POST /v1/me/wallets` with the wallet's signature of `tierLinkMessage`; a wallet counts for one account; 5 at most; balances read every 10 minutes and when stale), or the owner's grant (a subscription paid another way: `POST /v1/bot/control` `grant-tier` {email, tier, days}, signed by `BOT_OWNER_ADDRESS`; 0 days takes it back; the Bot results tab has the form), whichever is higher.
        - **Free for now:** `TIERS_ENFORCED` (Railway, default off). Until it's `true`, every account gets every grade and strategy, 5 bots and live trading, at the standard 15% fee, and no one is ahead in a crowd. The account's own tier is shown everywhere, so users see what each tier's signals do before anything is charged. Setting `TIERS_ENFORCED=true` starts enforcing with no other change: grades a tier doesn't get are passed over ("Core signals are for Tier 2 and up"), live trading, bot count and Precision follow the tier, and Tier 3 pays 7.5%.
        - **Site:** a tier card under My bots (your tier, $ARCD linked, link or unlink a wallet with the trading wallet or a connected one, the four tiers), a Signal grades card on the Signals tab (each grade's record at live speed, what it takes, its exits, any review), grade badges on signals and trades ("◆ Prime · Tier 3"), "By signal grade" on each bot's Overview, and Precision in the strategy picker ("Tier 3 · free for now"). The landing's tiers section reads the same table.
      - **Many bots, one signal (`bot/crowd.ts`):**
        - **A cap per signal:** live bots together buy no more than moves the price a quarter of the take-profit (a +6% Precision trade: 0.75% of the pool; +10%: 1.25%), never over 2% of the pool, at most 25 bots; half when the creator still holds a big share (the `holders` flag).
        - **A fair order (`CrowdBook.allocate`):** higher tiers first (once enforced), then the bot that has waited longest since its last seat, then a rotation that changes with every signal. A bot left out is told why ("you're ahead next time"), and is.
        - **A ladder:** each later seat's take-profit is 0.25% higher (1.5% at most), so they don't all sell on the same tick; the first in, who paid least, sells first. Orders go out in seat order.
        - The platform's own bot takes only what visitors' bots leave under the cap.
        - Paper bots aren't capped (they don't move the market), but a paper fill pays the live crowd's price impact on top of its own.
        - **Measured then:** the most crowded signal had 9 bots, 3 live, buying $12.80 together, 0.19% of its pool. The creators' sales ($2,000–3,800) went into every buyer, not ours in particular. The cap is for when there are many more bots.
        - Positions carry `grade` and `crowd` (rank, bots, total bought, cap); live rows show "#3 of 5 bots".
      - Tests: `engine/test/tiers.test.ts` (grades, the review, Precision, the tier table and access, grants and linked wallets, the crowd's cap, order, ladder and leftover, paper crowd impact, enforcement), `accounts.test.ts` (six live bots on one signal: five seated at $50 under a $250 cap with laddered take-profits, the sixth told why and first on the next signal).
    - **Free live trading until 3 October, then tiers; live bots on Prime (2026-09-30, owner: "allow all live accounts to trade live without $ARCD for 3 days; on 3 October at 00:00 the system resets to tiers; let them enjoy now, and give them a performance they'll market on its P&L").**
      - **Off until further notice (2026-10-03, owner: "remove the tiers limit and let bots trade until further notice"):** tiers had started at 00:00 UTC that day, and live bots without $ARCD were passing over every signal. `TIERS_ENFORCE_AT` now defaults to `never` (`engine/src/config.ts`), so every account trades live and gets every grade and strategy, as before the deadline. To start tiers again, set `TIERS_ENFORCE_AT` to an ISO time or `TIERS_ENFORCED=true` on Railway. The site's fallback (`TIERS_START` in `lib/tiers.ts`) is null too, so no countdown or start date shows. Test: `tiers.test.ts`.
      - **The deadline (until 2026-10-03):** `TIERS_ENFORCE_AT` (Railway; default `2026-10-03T00:00:00Z`, 03:00 in East Africa; `never` turns it off). Until then every account, with or without $ARCD, trades live and gets every grade. At that moment tiers start by themselves (`Tiers.enforcedAt`); `TIERS_ENFORCED=true` still starts them at once. `GET /v1/tiers` and `/v1/me` carry `enforceAt`.
        - **After it, without $ARCD:** a live bot stays live but passes over signals ("live trading is for Tier 1 and up") until its owner links a wallet holding 5M $ARCD or gets a grant. Its open live trades are still managed and sold.
      - **Live bots trade Prime signals, with Precision (`liveGrade` in `signals/grades.ts`; `BOT_LIVE_GRADES`, default `proven`):**
        - A signal's `quality.liveOk` says whether live bots trade it: Prime (unless under review), or another grade once it's proven at live speed (the review's bar: 10+ replays, 60%+ won, a profit). Others are passed over with the grade's record in words ("Standard signals won 1 of their last 12 at live speed").
        - A live bot trades a Prime signal with Precision (all of it at +6%) whenever it follows the signal's strategy, not only when it follows Precision. The platform's own live bot does the same.
        - Why: on that day's replays, Prime sold in full at +6% won 10 of 11 (+3.1% a trade) and the live engine's own replays showed 7 of 8; Standard won 1 of 12 (−15.4%). Paper bots and the engine's paper book still trade every grade, so every grade keeps being measured. `BOT_LIVE_GRADES=all` sends every grade to live bots again.
        - Prime signals fired about 11 times in 17 hours then: live bots trade less often, and win more often.
      - **Site:** a banner on every Autotrade tab ("Free live trading … {time} left", counting down), the same on the landing's tiers section, "LIVE" on signals live bots trade, "Live bots trade it now / not yet" on each grade, and a note on live bots' Overview.
      - **Sharing:** a live bot's P&L card shows its P&L as a % of what its wallet held when it went live (`BotLiveView.startBalanceUsd`), and the post adds "🔥 N wins in a row" from 3 on.
      - Tests: `tiers.test.ts` (the deadline, which grades live bots trade), `accounts.test.ts` (a live bot trades a Prime scalp with Precision at 20% of its wallet, and passes over a Standard signal).
    - **Two strategies found by search, now Prime (2026-10-01, owner: "monitor the engine until it's profitable; refine it with more strategies until you find two or three correct ones with a good win rate"; and "live trades don't take positions at all").**
      - **Why live bots took nothing:** they trade Prime only, and no signal had graded Prime since the grades went live. The 8 signals since were Core or Standard (Core 4 of 7 won, −2.6% a trade; Standard 4 of 20, −7.5%).
      - **The search** (research scripts outside the repo): every coin of the engine's 72 hours with 15+ trades (139), walked trade by trade as the engine sees it. A buy fills 2.5s after the rule, each sale 2s after its trigger, with 1.2% costs a side. Rules were chosen on the first half of the coins by launch time and judged on the second half, which the choice never saw.
        - **Early crowd** (the snipe rule): 20–75s after launch, 10+ of the market's own buyers, none over 20% of the buying, buys at least 2× sells, up no more than 20%. All of it at +10%: 21 of 21, then 8 of 8 on the unseen half (+7% a trade). With the signal 15s late (the scan's time), still 28 of 29.
        - **Late crowd** (the snipe rule too): the same numbers 75s to 10 minutes after launch. 3 of 3, then 7 of 7 (+8.4%); few trades, so the grade's record is the check.
        - **Crowd momentum** (the momentum rule): a minute or more old and not an early-crowd coin; 12+ buyers in two minutes, buying 2× selling, up 2–15% in the window, no wallet over 20% of all its buying since launch, $5,000+ liquidity. At +10%: 14 of 16, then 21 of 23 (+6.8%).
        - **Losing variants:** on early-crowd coins momentum loses (they dump after the pump). A 10% crowd limit brings back −90% trades. Dip rebounds fell apart with small changes. Momentum without the crowd limit made +16%, then −0.5% on the unseen half.
        - **Signal timing:** the same coins entered when the engine actually signaled (31–43s, after its scan) won 27 of 41 (−2.8%). Entered at the first trade with 10+ buyers (about 20s), they won 36 of 42 (+4.7%).
      - **In the engine:**
        - `PRIME_RULES`, `isEarlyCrowd` and `gradeOf(features, rule)` in `signals/grades.ts`.
        - Momentum signals carry `launchTopBuyerPct` and `earlyCrowd` (`SignalFeatures`).
        - The bot marks early crowds as it watches a coin (`Bot.earlyCrowd`).
        - A young coin with 5+ market buyers gets its safety scan started at once, so the signal isn't held for it.
        - A Prime signal is past rule probation; its grade's own live-speed record decides.
        - The rules now fire where the strategies start (a snipe fires once per coin; firing at 4 buyers used up a coin's one signal on a losing grade):
          - snipe: 10+ buyers, buys 2×, largest buyer 20% or less;
          - momentum: 12+ buyers, buys 2×, up 15% at most, $5,000+ liquidity.
        - Precision sells all at +10% (was +6%), −10% stop, out after 3 minutes unless up 3.3%, 10 minutes at most. Paper bots still on the old +6% Precision tuning start over on it.
      - **What to expect:** both strategies fired about 10 times a day each in the data, mostly on a few serial launchers' coins, so a launcher changing its pattern changes the results. The Prime grade's live-speed record (the Signals tab) and its review are the check: a failing record hands Prime signals out as Core, and live bots stop taking them.
      - Tests: `tiers.test.ts` (both Prime strategies, the early-crowd mark, Precision at +10%), `balanceAndSignals.test.ts`, `botLearning.test.ts`, `signalMix.test.ts`, `botFlow.test.ts` (the rules at their new thresholds).
      - Tests: `liveSpeed.test.ts` (live bots only; readiness on the team's record), `botFlow.test.ts` (every signal to live bots).
    - **Live trades at $2, growing with profit; Core signals with quick exits (2026-10-01, owner: "make live trades take place at $2 each; let signals fire and live bots take positions with small gains but regular trades per day; as the capital increases, the trade size increases based on the PnL gained").** Nothing here promises a profit.
      - **Why live bots were quiet:** they took Prime signals only, and Prime fired seldom (none graded Prime in the hours after the grades went live). Core signals, a wide crowd that misses one of Prime's lines (age, liquidity, round trip), were passed over until "proven", and most were also held back by their rule's probation, which is measured with other exits.
      - **Size (`bot/sizing.ts` `liveTradeSize`, `sizeForLive`):** every live trade starts at $2 (`USER_LIVE.baseTradeUsd`; the platform's bot `BOT_LIVE_TRADE_USD`). As the bot's realized live profit (after gas and the 15% fee) grows the capital it went live with, the trade grows in step: $10 that made $5 trades $3, $10 that made $10 trades $4, $1,000 that made $50 trades $2.10.
        - It never goes under $2: losses don't shrink it, and deposits and withdrawals don't count.
        - Above $2, no trade is more than 20% of what the wallet holds now, so a bot that withdrew its profit trades less.
        - Caps: $50 for visitors' bots (`USER_LIVE.maxTradeUsd`), and `BOT_LIVE_MAX_TRADE_USD` for the platform's bot. The crowd cap and the pool and cost checks still apply.
        - The $2 is bought even when 20% of the wallet is less (`LiveLimits.minTradeUsd`), as long as the wallet keeps its reserve.
        - The profit is a running total: `BotWallet.pnlUsd` for visitors' bots, and the setting `live-growth` (`{at, startUsd, pnlUsd}`) for the platform's, so a restart keeps it. Going live again starts over from the balance then.
        - The day's loss limit for visitors' bots starts at $2 (was $1), so one stop-out doesn't end a small bot's day.
      - **Signals (`signals/grades.ts` `LIVE_GRADES`, `liveGrade`):** live bots take Prime and Core signals while each grade's record holds; Standard still needs proof. (Later the same day the strategy board became the default; this grade routing is `BOT_LIVE_GRADES=proven`. See the next section.)
        - A Core signal is past its rule's probation, as Prime is. Its grade's record at live speed decides: under review (10+ replays averaging under 0, or under 60% won), its signals are handed out as Standard and live bots pass them over until it recovers.
        - `BOT_LIVE_GRADES=all` sends every grade to live bots; `off` pauses every new live buy.
      - **Exits (`trading/paper.ts` `QUICK_EXITS`):** Prime is still traded with Precision (all of it at +10%). Every other live trade, Core included, uses the quick exits: all of it at +6%, −7% stop, out after 3 minutes unless up 2%, 10 minutes at most, and out when the creator sells.
        - These are Precision's first settings. On that day's replays the non-Prime signals sold in full at +6% won 8 of 12 (−3.6% a trade), against 3 of 12 (−13%) with their strategy's half-and-trail exits.
        - Each grade's record (`replayDue`) is now replayed with the exits live bots trade it with: Prime with Precision, the others with the quick exits.
      - **What to expect:** more live trades, each small ($2 until it has made something). Core's record at live speed is the check, shown on the Signals tab's grade cards. Core is still unproven with these exits, and a failing record takes it back out by itself.
      - **Site:** the live note on a bot's Overview, the live trade size on its Strategy tab (with the size now and the growth), the Live wallet section, and the platform bot's limits line. Every new string is in all six dictionaries.
      - Tests: `engine/test/liveGrowth.test.ts` (the size rule; the platform's bot keeping its growth across a restart and starting over when it goes live again), `accounts.test.ts` (a visitor's live bot: $2, a win at +6%, the running total, $3 once it has made 50%, the 20% cap above $2, never under $2), `signalMix.test.ts` (a Core signal fires without its rule's probation and goes to live bots; a Standard one keeps it), `tiers.test.ts` (Core live with no record, out under review), `live.test.ts` (the $2 base past the 20% share, but never into the reserve).
    - **Three strategies, a strategy board, and live bots that switch by themselves (2026-10-01, owner: "give only 3 strategies that have proven to be working and produced profits on paper and make them trade LIVE; let bots self-improve and auto-switch strategies based on the opportunity shown on the signals; let bots learn from paper trading bots; yesterday afternoon the bots were making good gains, restore that").** Nothing here promises a profit.
      - **What "yesterday afternoon" was:** until 19:33 EAT on 30 September, paper filled every trade at once, which a live bot can't. That is why paper looked good while the 5 live trades lost. At 20:28 paper bots stopped getting signals ("live bots only"); at 00:02 live bots stopped using learned settings. So the learning loop had been off since the evening.
        - Restored: paper bots get signals again (`BOT_PAPER_SIGNALS` on by default; `off` stops them) and learn as before (`bot/learner.ts`, the team sync); live bots trade with learned settings again.
        - Not restored: instant fills. Paper stays at live speed, so what paper learns is what a live bot can get.
      - **The three strategies (`bot/strategyBoard.ts` `BOT_STRATEGIES`):** Precision (Prime signals: an early crowd or a crowd momentum burst; 21/21 then 8/8 and 21/23 in the search), Snipe (clean coins: 6 of 6 on the team's paper record), Fast scalp (snipes on coins with a risk flag: 12 of 14; the engine's book 12/16, +$11.79).
        - Dip rebounds and plain momentum bursts are measured on paper only: the engine's book still trades dip rebounds, and momentum stays on probation.
        - Bots pick among the three (`strategiesOf`). A dip-rebound pick is dropped on load, and new bots follow all three their tier gets.
      - **The board (`pickStrategy`, `PaperAccounts.board`, every 10 seconds):** for each strategy, every paper book's last 20 trades over 48 hours. The books are each paper bot with 8+ trades on it, and the engine's own book (`setHouse`). Only trades opened at live speed count (from 30 September, 17:00 UTC).
        - **live:** the best book is in profit (8+ trades, average return above 0, a net profit, half or more won). Live bots trade the strategy with that book's settings: a paper bot's learned exits and filters (`boardParams`, `boardAdmits`), or the platform's for the engine's book.
        - **paused:** books have 8+ trades and none is in profit. Or live bots' own last trades on it lost, whatever paper shows: 6+ of the last 10 within 24 hours, under half won, a negative average. Its signals are passed over live ("not traded live: …").
        - **trial:** no book has 8 trades yet. Live bots trade it at the $2 base with the platform's settings while paper builds its record, so trading starts at once.
      - **Live bots switch by themselves (`liveRouting: 'board'`):** a live bot trades whichever of the three the signal calls for (Prime with Precision), whatever its picks, while the board has it on. Its picks are what it trades on paper. Sizes are the $2 base growing with profit, as above.
      - **The engine's own paper book on the board:** it trades a Prime signal with Precision and snipes and fast scalps with the quick exits (`platformParams`, which live bots fall back to). Its positions now keep their exits (`Position.exits`).
        - **Bug found by the new tests:** before, the book managed every position with its strategy's default exits whatever it opened with.
      - **The platform's bot wallet** follows the board too: the strategy's standing, the source's exits and filters.
      - **Settings (Railway, arcdex-engine):** `BOT_LIVE_GRADES` was `board` by default until the dollar plan (below) became the default the same day; `board` brings the board back. `proven` brings back the grade routing (Prime and Core), and `off` stops new live buys. `all` (every signal, each live bot on its own picks) was retired the same day and now means the default. `BOT_PAPER_SIGNALS=off` stops paper bots.
      - **API:** `GET /v1/bot/board` (`StrategyBoardResponse`). The grade cards no longer say whether live bots trade a grade on the board.
      - **Site:** a "Strategy board" card on the Signals tab and on a live bot's Overview (each strategy's status, whose settings, its record, its exits, live bots' own last 24 hours, and why). The live note says live bots switch by themselves; the strategy picker has three strategies and says picks are for paper. Every new string is in all six dictionaries.
      - **Checked:** the real engine run locally with no chain (it stays up and serves `/v1/bot/board`), and the page in Chromium at 1280px and 360px: the board renders, no sideways scroll, no page errors.
      - **What to expect:** right after a deploy the board reads the stored paper book from 30 September at live speed onward. A strategy with no paper bot ahead of the engine's book trades with the platform's settings. It takes hours of paper trading before a paper bot's learned settings lead. Watch the board: a paused strategy means paper isn't making money on it, and live bots rightly sit it out.
      - Tests: `engine/test/strategyBoard.test.ts`. It covers the three strategies; the live-speed cutoff and the 48-hour window; trial, live with the engine's book, and live with a paper bot's learned exits and filters; paused on paper and paused on live bots' own losses (and back once those are a day old); a live bot trading a snipe it didn't pick with that bot's settings; a paused strategy and a dip rebound passed over; paper bots getting signals; and the engine's book trading a Core snipe with the quick exits and a Prime early crowd with Precision.
    - **Launchpad coins only (2026-10-01, owner: "making sure all coins come from Arc launchpads, to avoid smart-contract coins").**
      - **Why:** production's own pages (owner, 04:17 UTC) showed the feed healthy: live, 4 blocks behind, a trade on the site ~1s after its block, all HTTP providers up. QuickNode wasn't needed. But coins from contracts no launchpad made were scanned like the rest: the example in the scan was a USDC-named "Other" coin. Those get only the bytecode heuristics and a one-time sell probe, which a custom contract can get past (a sell that fails later).
      - **The rule (`intel/launchpadGate.ts`; `SIGNALS_LAUNCHPAD_ONLY`, `strict` by default):** a coin can become a signal only if both hold.
        - **Origin:** a known Arc launchpad launched it. The adapters' Argus, ARCDEX, Mercuri, SolonPad, Peach and Faze, and the generic detector's Aka.fun, o1, Minara and Long.supply (`LAUNCHPAD_TEMPLATES`). "Other" never qualifies.
        - **Code:** where that launchpad's standard coin code is learned (`intel/templateData.ts`; Argus P7/P8, Mercuri, SolonPad, Peach, Faze, Aka.fun, o1, Minara), its code matches it. ARCDEX's and Long.supply's coins are trusted by origin until their templates are learned (`bun engine/scripts/learn-templates.ts`): both launchpads deploy every coin themselves.
        - `origin` drops the code half, for a launchpad that changed its token until it's relearned (a stale template shows as many `safety:launchpad` rejections from one launchpad). `off` is any coin, as before.
      - **Where (`bot/bot.ts`):**
        - A coin from an unknown origin is rejected as soon as it's evaluated, with no rules and no safety scan (scanner key `safety:launchpad`).
        - The code is checked from the cached contract read before the deep scan, so a custom contract costs no probe.
        - The scanner's report has it as a hard check (`launchpad`).
        - A coin already held from before the rule isn't sold for it: the open-position re-check ignores that check, while a real failure (a honeypot) still closes it.
      - **Site:** a note on the Scanner tab when it's on, and the reason's label, in all six languages. `GET /v1/bot/stats` `routing.launchpadOnly`.
      - **Checked:** the real engine run locally (`routing.launchpadOnly: strict`), and the Scanner tab at 360px (no sideways scroll, no page errors).
      - Tests: `engine/test/launchpadGate.test.ts`: the gate in each mode; an "Other" crowd rejected without a scan while the same crowd on an Argus coin fires; and a held coin not sold for the rule but closed on a honeypot. With that last exclusion removed, the test fails. `scanner.test.ts` covers the hard check.
    - **The dollar plan: live bots on snipes and fast scalps at $2, sold at +$1, learning from mistakes (2026-10-01, owner: "bring back LIVE trading using the snipe and fast scalp strategies that paper bots used yesterday afternoon and were self improving; live bots use those signals, trades at only $2, take $1 profit and close; let the agent also self improve by learning from mistakes").** Version 1 of the $2 plan: from 12:45 UTC the same day, version 2 (quick take-profits, below) replaced its exits and its learned filters. The default (`BOT_LIVE_GRADES=dollar`); `board` brings the strategy board back. Nothing here promises a profit.
      - **The signals (`signals/rules.ts`):** the snipe and momentum rules are back at their thresholds of the afternoon of 30 September (commit d381135). Snipes: 6 buyers, $200 bought, buys 1.3× sells, no buyer over 25%. Momentum: 6 buyers in 2 minutes, buys 1.6× sells, up 2–20%, $2,000 of liquidity, and no "still bought in the last 30 seconds" check (`minRecentBuyers` 0). `RULE_REVISED` moved to 2026-10-01 06:00 UTC for both rules.
      - **Routing (`PaperAccounts.dollarClaim`, `liveRouting: 'dollar'`):** a live bot takes every snipe and fast-scalp signal, whatever it picked. There's no grade, quality or board gate. It sits out a rule on probation, a kind its own learned filters skip, and dip rebounds. Tiers still apply once enforced.
      - **The trade (`bot/dollarPlan.ts`):** $2 flat (no growth with profit). All of it is sold once selling would make $1 (`dollarTakeProfit`: about +52% over what it paid, after the sale's estimated cost); this is the trade's profit before the 15% platform fee. Otherwise it's out at −10% (fast scalps −7%), when the creator sells, or after 10 minutes (fast scalps 20), with no earlier time stop. Positions carry `plan: 'dollar'`. The platform's bot wallet trades the same way.
      - **The day's loss counts from the plan's start (`RiskRules.since`, `LiveLimits.lossSince`).** The morning's DEGEN loss (−$9.96, under the old exits) would otherwise have kept both live bots out until midnight UTC.
      - **`BOT_LIVE_GRADES=all` is retired (07:45 UTC that day).** Railway had it set when the plan shipped, so the plan never ran. With `all`, each live bot traded only the strategy it picked: all 8 signals since 06:00 fired as fast scalps, 二锅头 follows snipes only, and arcdex-agent (fast scalps) was past its daily loss limit ($8.08 on DEGEN against $3.52, 10% of its $35 wallet). The CLI on the owner's machine is logged in to a Railway account without the arcdex project, so `all` now falls back to the default (the plan) instead. Unset the variable, or set it to `dollar`, to keep the dashboard in step.
      - **Learning from mistakes:**
        - **The engine** replays every snipe and fast-scalp signal on its coin's stored trades at live speed with the plan (`Bot.replayDue`, `Bot.dollar`). Replays now also close on the creator's sales (`Tick.creatorSold`). A rule whose last 20 trades on the plan lost money and won under half is on probation, and live bots sit it out (`dollarProbation`). Those are live bots' real trades and the replays, one per signal. Under 10, the paper book's record decides, as before.
        - **Each live bot** learns its own entry filters per kind of signal (`PaperAccount.dollarTuning`, learner `DOLLAR_LEARN`). It learns from its own live trades and from the team's: every other live bot's and the replays (`observeDollar`, `dollarSync` every 10 minutes once 5 new team trades are in). Rugs raise the liquidity and safety score it needs; fast stop-outs raise buys ÷ sells and cap the run-up; time-outs raise the buyers. A kind that lost 3 of its last 4 or worse is skipped for 12 hours (on paper only fast scalps' kinds are). Filters that block everything for 2 hours loosen partway.
        - The $1 take-profit never moves (`pinTakeProfit`). The notes read "Live ($2, sold at +$1): …" in the Learning tab. Its paper settings are separate and unchanged.
      - **Measured first** (research scripts outside the repo): 72 hours of real trades, 149 coins, buys 2.5s after the rule and sales 2s after their trigger, 1.2% a side.
        - **That afternoon's snipe rule:** 54 trades. 20 made the full $1 and 39 closed in profit, +$0.13 a trade ($6.85 in all). Both halves of the period were in profit (+7.7% and +4.5% a trade). The average loser lost 32% and the worst 90%: a rug that no stop catches at live speed.
        - **Momentum:** about break-even (+$0.02 to +$0.04 a trade on 112).
        - **Production's own signals** (after the safety scanner) with the plan: snipes on risky coins +3.4% a trade (25), clean snipes −13% (6, two rugs at −89%), momentum bursts −20% (22). That's why probation decides on the plan's replays. Expect about a third of trades to make the full $1 and the rest to close small or at a loss, with an occasional rug costing most of its $2.
      - **API and site:** `GET /v1/bot/board` carries `dollar` (`DollarPlanView`: the exits; each kind's replays, hits, wins and P&L; live bots' trades; probation). The Signals tab and a live bot's Overview show a "Live plan" card instead of the strategy board. The Strategy tab shows the $2 / $1 plan and what the bot learned for live (`BotLiveView.plan`). Every new string is in all six dictionaries.
      - Tests: `engine/test/dollarPlan.test.ts`. It covers the take-profit math (a $2 paper trade sold there makes $1.00) and the exits; a live bot taking a snipe it didn't pick and a momentum scalp at $2, holding at +40% and selling at +$1, and passing over a dip rebound and a probation signal; the day's loss counting from the plan's start; learning from 4 losing live snipes (skipped, the take-profit unchanged, the paper settings untouched); learning from the team's replays before its first trade (rugs in thin pools raise its liquidity minimum, and a thin-pool snipe is then skipped); and the engine replaying stored signals on the plan (the creator's sale closing one) into its record, the team pool and probation. The rule tests (`balanceAndSignals`, `botLearning`, `signalMix`) moved to the afternoon thresholds.
    - **Why trades lose, bots that learn it, and the comeback watch (2026-10-01, owner: "read the trade logs and let each bot learn from its mistakes and improve its profitability; find the reasons and patterns that make certain kinds of coins unprofitable; the bot should monitor certain coins to see whether the opportunity comes back").** Nothing here promises a profit.
      - **The first live trades on the plan:** both live bots bought $NOAH at 07:53 UTC and the rug guard sold both 9s later at −$1.53. NOAH was the 4th coin of the day from one launcher (0x32c959b0): it buys $2,500 at launch, ~40 small wallets lift the price ~10%, and it dumps its bag about 45s after launch. Its next coin (NOAH #2, 07:55) made +$0.90 for 二锅头 in under 3 minutes.
      - **The trade logs** (every bot's public log, the engine's paper book, the stored signals and every coin's tape; research scripts outside the repo): 230 snipes and fast scalps over two days, each replayed at live speed on the $2 plan. It made $1.11 in all.
        - **Dumps decide it:** 71 trades fell to half their entry within 5 minutes and cost $40.32; the rest made $41.43. The creator sold $100+ in 44 of them, a median of 71s after the entry.
        - **Crowded coins lose:** with 80 or fewer buyers already in, the plan made +7.3% a trade ($23.54 on 162), in both halves of the period; with more, 29% won and almost none reached $1 (−$21.47 on 51 with 120+). Organic coins with 76 or fewer buyers: 68% won, +15.4% a trade.
        - **Momentum bursts on a launcher's own wallets lose** (half or more of the buyers also bought the creator's other coins): −$2.86 on 30. With 80 or fewer buyers, momentum on other coins made +8.9% a trade.
        - **Old coins and selling lose:** 15+ minutes old, −15% a trade; $30+ sold before the entry, −9%.
        - **Comebacks after a dump lose:** re-entering once fresh buyers came back (never held it before the dump), buying outweighed selling, the price was off its low, with or without the creator gone: of the 20 best versions on the first half, none made money on the second.
        - **Not separating:** a creator holding a big launch bag, or 3+ launches that day, on their own.
      - **Each signal now carries its coin's crowd and creator (`SignalFeatures`, `intel/flow.ts` `crowdFeatures`, `Bot.crowdOf`):** `totalBuyers` (since launch, the creator and the launch blocks left out), `sellUsd` (sold by everyone but the creator), `overhang` (the creator's unsold coins as a share of the pool), `farmShare` (share of its buyers who also bought the creator's other coins in the last day) and `creatorLaunches`. A tape that misses the coin's start is filled from the stored trades once (`Tapes.prepend`), and every tape seeded after a restart (its last 100 trades) counts as missing it: NOAH's seeded tape began 39s after launch, past the launch block, and its first replay read 28 buyers and no creator's bag where there were 40 and a bag worth 52% of the pool. Replays of signals stored before this read them from the stored trades.
      - **Losing patterns (`bot/patterns.ts`):** every minute, candidate kinds of coin (crowded, selling, the creator's bag, a launcher's wallets, momentum on them, old, serial, run-up, one big buyer, at a few thresholds each) are checked against the last 7 days of the plan's outcomes, one per signal (live bots' trades, then the replays). A kind with 12+ trades that loses money, 3%+ a trade and 8+ points worse than the rest is a losing pattern. Live bots sit out a signal that matches one (`quality.pattern`, "not traded live: …", skip key `pattern`); paper bots and the replays keep trading it, so a pattern that stops losing is lifted by itself.
        - Checked the way it runs, each signal judged only on trades closed before it: every signal $1.11 (+$9.64, then −$8.53); the ones it let through $15.59 (+$6.62, then +$8.96), 66% won; the ones it sat out −$14.48. It held: 100+ buyers already in (−20% a trade), older than 15 minutes (−15%), $30+ sold before the entry (−9%).
      - **Each bot learns the same numbers (`bot/learner.ts`):** five new filters (`maxTotalBuyers`, `maxSellUsd`, `maxOverhang`, `maxFarmShare`, `maxAgeSec`; missing means open, so older tunings are unchanged), learned like the others from its own trades and the team's (live bots: the plan's replays and every other live bot's trades). A note says why ("snipes: 9 of 10 losses had buyers already in over 79, only 0 of 10 wins did: it now needs buyers already in of at most 79"). Filters that block everything for 2 hours loosen by half again.
      - **The comeback watch (`Bot.watchView`, `DollarPlanView.watch`):** coins a live trade lost on and coins live bots sat out for a pattern, the last 6 hours, with their price since and where the scanner has them. Every coin is re-checked by the rules every few seconds for 48 hours; a comeback is the dip-rebound rule (`second-leg`: ran, pulled back, being bought again) firing on one. Comebacks are replayed on the plan (stop −10%, 20 minutes) and traded live only once their last 10+ replays won half or more and made money (`COMEBACK`); the account side takes one only when the engine says so.
      - **Site:** the Live plan card adds "Why trades lose" (each pattern: trades, won, average, P&L, the other coins' average) and "Comeback watch"; comebacks have their own row; a bot's Strategy tab shows the new learned filters in words. Every new string is in all six dictionaries.
      - Tests: `engine/test/patterns.test.ts` (the crowd numbers; patterns found, lifted by themselves, not from too few trades, winning kinds, unknown numbers or stale trades; a launcher's momentum; a bot learning to skip crowded coins and saying why, and older tunings unchanged; the engine firing a crowded snipe with live bots told why, a small-crowd snipe going to them, a paper bot still taking a pattern signal, the comeback watch, and a tape seeded after a restart filled before its crowd is counted; without the fix that test fails).
    - **Quick take-profits: the $2 plan, version 2 (2026-10-01, owner: "Nothing happened, no trades, I hate waiting for hours in meme coin trading, I prefer quick take profits and leave").** The default (`BOT_LIVE_GRADES=dollar`). Nothing here promises a profit.
      - **Why nothing traded:** after the two live trades on $NOAH (07:53 and 07:55 UTC), live bots bought nothing for five hours.
        - First, each bot's learned filters passed over every signal. They were learned from the replays on the +$1 exits: no run-up over +8%, no "copycat" flag, buys at least 1.25× sells.
        - From about 10:00 UTC the snipe rule itself was on probation ("Snipes won 5 of their last 13"), judged with the +$1 exits (−10% stop, 10 minutes).
        - From 08:00 to 12:10, 16 signals fired; 7 were snipes on coins with 80 or fewer buyers.
      - **The plan (`bot/dollarPlan.ts`, `DOLLAR_PLAN.version` 2, from `since`):**
        - $2 a trade. All of it is sold once selling nets +7.5% after costs (`netGain`, `dollarTakeProfit`): about +10% on the price, $0.15 before the 15% fee. Otherwise it's out at −7%, when the creator sells, or after 3 minutes.
        - **$8 a trade from 14:30 UTC the same day** (owner: "increase the trading size to 8 usd so as to make profits increase"; `DOLLAR_PLAN.sizeUsd`, nothing else changed). A win at the take-profit makes about $0.60 before the fee, and a rug can cost most of the $8. The live trader still caps each trade at 20% of what the wallet is worth, never under $2 (`liveTrader.ts`), so a wallet under $40 trades less than $8. Replays, patterns and their dollar figures follow the size.
        - **20% of the wallet, and never stopped, from 15:00 UTC the same day** (owner: "Do not allow the bot to be stopped even if there is a rug, and change the cap according to increase on capital"):
          - **Size (`DOLLAR_PLAN.wallet`, `dollarTradeSize`):** each live bot's trade is 20% of what its wallet is worth (its USDC plus open trades at cost), in $0.10 steps, at least $2 and at most $50. It grows and shrinks with the capital: $34.40 trades $6.80, $200 trades $40. The live trader reads the balance again right before the buy and applies the same 20%. `DOLLAR_PLAN.sizeUsd` ($8) is now only the reference size for the replays, patterns and the platform's own bot.
          - **No stops (`DOLLAR_PLAN.neverStops`):** live bots on the plan have no daily loss limit (`LiveLimits.noDailyLoss`), no 30-minute pause after 4 losses in a row, and no switch back to paper when the wallet falls 50% below where it went live. They trade as long as the wallet can pay $2 and keep its $0.30 gas reserve. Paper bots keep all three protections.
          - Nothing to set on Railway: the engine redeploys from `main`.
          - **Paper bots too (from 15:15 UTC the same day, owner: "make it happen for paper bots also"; `PROTECT.neverStops` in `bot/paperAccounts.ts`, every visitor's bot on any routing):** no 30-minute pause after 4 losses in a row, no daily loss limit, and no stop when a paper account falls 50% below its deposits. A paper bot the drain guard had stopped (its last event was that stop) runs again when the engine loads; one its owner stopped stays stopped. The numbers stay in `PROTECT`, and the site hides them while the switch is on. The engine's own paper book (`RISK`) is unchanged.
          - Tests (`botLearning.test.ts`): four losses and the next signal still traded; a loss past the old $10 daily limit and the next signal traded; an account down 60% still running; drain-stopped bots restarted on load, owner-stopped ones not; and with `PROTECT.neverStops` off, the old pause, daily limit and stop.
          - Tests (`dollarPlan.test.ts`): sizes at $34.40, $200, $1,000, a wallet read down to $20 and $9; four dumps in a row (−$30 on $100, three times the old daily limit) and the next snipe still bought; a wallet 70% down staying live. Both stop tests fail with `neverStops` off.
        - Live bots take snipes (clean coins, and risky coins as fast scalps) on coins with 80 or fewer buyers already in (`maxBuyers`, `planBlocks`; skip key `crowded`) and no wallet over 15% of the market's own buying (`maxTopBuyerPct`, the signal's `topBuyerPct`; skip key `top-buyer`).
        - Momentum bursts and comebacks are replayed and measured first. They're traded live once their last 10+ replays on the plan won half or more and made money (`PROVE_FIRST`, `Bot.provenRecord`; skip key `prove-first`).
        - Probation and the proofs count only the signals live bots would buy (both limits above), and only this version's live trades (`Bot.dollarTrades`, `PaperAccounts.dollarLive`).
        - The day's loss counts from `since`.
      - **Measured first** (research scripts outside the repo). Every snipe and momentum signal of two days: 166 fired by the rules on 72 hours of tapes, and 64 that production fired after its scanner. Buys filled 2.5s after the signal and sales 2s after their trigger, at 1.2% a side. Gains over +20% were counted as +20%, so one spike can't carry a result.
        - Snipes with 80 or fewer buyers, at +10% / −7% / 3 minutes:
          - research: 48 trades, 85% won, +3.1% a trade;
          - production: 30 trades, 80% won, +0.7% a trade (+5.3% and −1.6% in its two halves);
          - the median trade was over in about 40 seconds.
        - +8% within 2 minutes and +12% / −8% did about as well; +5% did worse, because costs eat more of it.
        - **The largest buyer** (the best separator of winners already on 30 September, `signals/grades.ts`): with no wallet over 15% of the buying, both sources together made 55 trades (about 30 a day), 87% won, +3.8% a trade, in profit in both halves (+5.7% and +1.3%), with no rug. Over 15%: 23 trades, −1.8% a trade, and both of the sample's rugs.
        - **Then checked on the day's own signals** (06:00–12:48 UTC, after that sample), replayed the same way: with no wallet over 15%, 6 trades, 5 won, +$0.50; over 15%, 7 trades and −$4.71, among them all three of the day's rugs (NOAH 24.9%, UBI 17.2%, 四 20.9%: −76% to −86% each). Without the 15% limit the plan would have lost $4.21 on that morning's 13 trades.
        - Momentum bursts lost with every exit tried: production's 24 trades won 46%, −7.9% a trade.
        - About break-even overall. Most trades are small wins, and one rug (−76% to −90%, which no stop catches at live speed) costs as much as 8–10 of them.
      - **Learning can't stop a bot from trading (`bot/learner.ts` `LearnOptions.minAdmitShare`; `QUICK_LEARN` is 0.5):**
        - Each lesson is tried on its own. A lesson that would turn away more than half of the kind's recent signals isn't taken; those signals are the trades it learns from, its own and the team's.
        - Skipping a whole kind of signal is therefore never taken on the plan. A losing streak pauses a bot through the 4-loss pause (30 minutes) and the day's loss limit instead.
      - **Patterns only from coins the plan buys (`Bot.planOutcomes`):** right after the deploy, the losing-pattern finder ran on every replay and found "the creator holds coins worth 10%+ of the pool" (38 trades, −11% a trade). That came from the rugs the 15% limit already stops. Among the coins the plan buys, the same bag marked the winners: 51 of the 55 trades, 92% won, +5.6% a trade. Patterns, the card's replay record, probation and the proofs now all count only the signals live bots would buy. A signal kept out by a limit carries it (`SignalQuality.limit`), and the comeback watch lists it ("sat out: 140 buyers already in").
      - **Fresh settings:** a live bot's settings learned on the +$1 plan start over when it loads (`StrategyTuning.livePlan`, `onThisPlan`), with a note in its log. Its learn notes read "Live ($2, quick take-profits): …".
      - **Site:** the Live plan card (title, how it works, each kind's "took profit" counts), the live note on a bot's Overview, and its Strategy tab. Every changed string is in all six dictionaries.
      - **Tests:**
        - `engine/test/dollarPlan.test.ts` covers:
          - the take-profit math ($0.15 on $2), the exits, the 80-buyer limit and the 15% largest-buyer limit;
          - a live bot buying a snipe it didn't pick and selling it at +12%;
          - a crowded coin, a coin with one wallet at 25% of the buying, a momentum burst and a comeback passed over, and a momentum burst bought once the engine says it's proven;
          - four losses pausing a bot without any lesson that stops it;
          - learning from the team's replays, and the guard refusing a lesson that turns away 6 of 10;
          - settings from the +$1 plan starting over on load;
          - the engine's replays, probation and proofs.
        - `patterns.test.ts` now runs with the guard.
    - **Volume spikes, a fast-scalp signal (2026-10-01, owner: "no signal for newly launched coins with fewer than 30 holders; provide a signal after detecting a spike in trading volume; market cap above $6,000; take 25% of profit; the rug guard is eating most of users' capital: buy coins with liquidity above $5,000 USDC; apply this as one of your strategies for the fast scalper").** A new kind of signal, `rule: 'volume'`, traded as a fast scalp (`strategy: 'scalp'`). Nothing here promises a profit.
      - **The rule (`signals/rules.ts` `RULES.volume`, `volumeReady`):** a coin 10+ minutes old whose last minute traded at least 3× its usual rate and $200+. The usual rate is `baselinePerMin`: the 10 complete minutes before the last two, from the coin's `PricePath`. 70%+ of the minute must be buying, with the price not lower than at its start. The owner's floors: 30+ holders (`tapeHolders`: wallets still holding what they bought, from the coin's tape), a market cap over $6,000, and liquidity over $5,000. The same coin again after 30 minutes, not right after another signal on it. It's checked before the momentum rule, and the usual safety scan applies (launchpad coins only, honeypot, hooks…).
      - **Exits (`bot/dollarPlan.ts` `VOLUME_EXITS`, `volumeParams`):** all of it at +25% on the price (+22.5% after costs), out at −10%, when the creator sells, or after 20 minutes. The same for live bots (20% of the wallet a trade), paper bots and the engine's paper book (`dollarParams(…, rule)`).
      - **Live bots trade it at once.** Not the snipes' limits (80 buyers, 15% top buyer): `planBlocks(…, rule)` skips them for volume spikes, which are mostly on coins with a big crowd. Not the losing patterns either, which are drawn from snipes and momentum bursts; "older than 5 minutes" would keep out every spike. It has its own probation from its replays and live trades.
      - **Measured first** (research scripts outside the repo; 3.5 days of real trades, 183 coins, live speed, 1.2% a side):
        - **Chosen settings:** 28 trades (about 8 a day), 61% won, +7.0% a trade (+7.0% and +6.9% in the two halves), the worst −26%, no rug.
        - **The 10-minute floor:** without it most "spikes" were launch waves. A coin 2–3 minutes old with exactly ~30 holders, ~$40k cap and $7,500 bought in a minute, its launcher's own wallets. Those took +23% four times in five and rugged −75% to −91% the fifth: +7.6% a trade on the first days, then slightly negative on the day's 47 fresh coins (two rugs, HOOKED and 四).
        - **The take-profit:** +25% made more than +10% or +15% on the same signals.
        - Small samples: the volume kind's own record on the Live plan card is the check.
      - **Holders after a restart:** a coin's tape is then its last 100 trades, which can undercount its holders. A spike short only of holders is counted again with the coin's stored trades (`fullTape`) before it's turned away.
      - **"No trades fired" (the first hour after it went live):**
        - **Volume spikes:** none, because the market was quiet; 11 coins over 10 minutes old traded in 3 hours. The research rule found three spikes on the same trades, and the engine was right to skip them: JEANUSDC isn't a launchpad coin (launchpad-only rule), and USDCMUSE had tripped the rug guard 27 minutes before.
        - **Snipes:** the four signals in the hour failed the plan's limits (one wallet over 15%, 80+ buyers, a losing pattern).
        - **Looser spikes lose:** 2× instead of 3× is about break-even with −90% rugs, and 1.5× is −10% a trade. The 3×, $200, 70%-buying setting stays.
      - **Site:** the Live plan card lists volume spikes with their own exits and a line on what they are; the kinds and the paper results by rule name them. Every new string is in all six dictionaries. The scanner names why a coin isn't one (`volume:*` keys).
      - Tests: `engine/test/volumeSpike.test.ts` covers the rule and each floor, the baseline, the holder count, the exits, the limits not applying, and the engine firing it on a 20-minute-old coin, but not under 30 holders, under $5,000 of liquidity or in a coin's first 10 minutes. With the holder floor raised to 60, three of its tests fail. Also `dollarPlan.test.ts` (the plan's exits and kinds).
    - **Out before the launcher dumps: the $2 plan, version 3 (2026-10-02, owner: "improve the engine trade size and profitability and also signal firing rate").** Nothing here promises a profit.
      - **What the live record showed:** snipe-scalps on version 2 won 34 of 44 and lost $48.38. Every win was +$0.12 to +$1.09; every loss was a serial launcher (it buys $2,500 at launch, 20-odd small wallets lift the price about 0.2% a second) selling its whole bag 50–150s after launch, about one coin in four, a −75% gap the rug guard sells after. Version 2 bought ~44s after launch and held for +10%, which took ~45s more: into the dump.
      - **The snipe rule (`signals/rules.ts`):** 10 market buyers (was 6), $60 bought (was $200), no wallet over 15% of the buying (was 25%), still from 20s. It fires ~9s earlier (median 32s) and on about 1.8× as many coins live bots buy. `RULE_REVISED.snipe` is 2026-10-02 13:00 UTC.
      - **Exits (`bot/dollarPlan.ts` `SNIPE_EXITS`, version 3):** a snipe, clean or risky, is sold in full once selling nets +3% after costs (about +4% on the price), or after 30 seconds, at −7%, or when the creator sells. Momentum bursts, comebacks and volume spikes keep their exits. Live bots' plan settings start over on version 3.
      - **Size (`dollarTradeSize`):** 20% of what the wallet is worth, at least $2, as before; the cap is now 0.5% of the coin's liquidity and $500 (was a flat $50), so trades keep growing with the capital until the pool, not a fixed number, limits them. The platform's own bot sizes the same way from its wallet (was a fixed $8). `USER_LIVE.maxTradeUsd` is $500. The crowd cap (`bot/crowd.ts`) still limits all live bots together on one signal.
      - **Measured first** (research scripts outside the repo): 11 hours of production's own trades (652 coins, every snipe signal's tape), at production's delay (the signal 2.4s after the rule is met, the buy 2.5s later, sales 2s after their trigger, 1% a side). Version 2's rule and exits: 95 trades, −2.7% a trade, 10 rugs. Version 3: 170 trades, 90% won, +1.8% a trade (+0.9% and +2.7% in the two halves), 3 rugs. +5% within 30s and +4% within 20s did about as well. Skipping launchers whose earlier coins dumped early helped at one threshold and hurt at another, so it isn't used.
      - Tests: `dollarPlan.test.ts` (the snipe exits, the sizes and the pool's cap, the view), `signalMix.test.ts` (the new thresholds).
      - **Launcher memory (`bot/creatorMemory.ts`, same day, from the monitoring):** an hour after version 3 went live, launcher `0x70fc3d32` launched an "SI" coin every ~2 minutes and dumped 5 of 7 within 27–32s; v3 fired at 20–22s and 6 of 9 live trades were rugs (−$15.41). Now every coin is judged once: an early dump when its creator's first sale is 80%+ of its first buy within 5 minutes of the launch, clean when 5 minutes pass without one (40+ trades, launch buy seen). Live bots skip a snipe whose launcher's rate over its last 10 coins, (dumps + 1) / (coins + 4), is over 25% (`planBlocks` key `dumper`): a new launcher passes, one that just dumped doesn't, until three clean coins. Signals carry `launcherCoins` and `launcherDumps`; the memory is saved in the settings (`creator-memory`) every 5 minutes. On the 11-hour replay (learning only from coins finished before each signal): 170 trades, +1.46% a trade (+0.99% / +1.94%) without it; 126 trades, +1.75% (+1.72% / +1.77%) with it. Tests: `creatorMemory.test.ts`, `signalMix.test.ts`.
      - **Snipes from 25s (same day, 16:30 UTC, `RULES.snipe.minAgeSec`, was 20s):** launchers that dump do it from ~27s, and a signal at 20–22s bought just before. Replayed with the launcher memory at production's delay: the 11 hours before, +1.75% a trade (+1.72% / +1.77%) from 20s, +2.5% (+1.91% / +3.09%) from 25s; the new rule's first four hours (53 coins, 16 trades), −4.2% (1 rug) from 20s, +0.4% (+0.6% / +0.2%, no rug) from 25s. From 30s did worse on the 11 hours. `RULE_REVISED.snipe` is 16:30 UTC.
      - **Learning that can't idle a live bot (same day, 17:10 UTC):** arcdex-agent bought nothing for over an hour while three good snipes fired: stacked lessons learned from the team's replays ("at most 46 buyers in", "buys 4× sells", "under 2 minutes old"), each keeping half the replays, shut out the live flow, and none of the three separated winners on the 11-hour replay. On the plan, a bot's filters together must now keep 80% of the kind's recent signals (`QUICK_LEARN.minAdmitShare`, was 0.5), and filters that skipped 3+ signals for 45 minutes since its last buy loosen partway (`QUICK_RELAX`; `relax` counted from the last lesson too, and a bot learning from the team every 10 minutes never reached its 2 hours). The engine's losing patterns (`bot/patterns.ts`) and the plan's limits remain the hard gates.
      - **Plan version 4 (17:50 UTC): learned filters start over.** The filters live bots learned that afternoon came from replays full of the launchers' early dumps (now kept out by the launcher memory); arcdex-agent still skipped NLYRA (buys 2.1× sells) after loosening. Replayed with the current rule (25s, launcher memory: 11 hours, 119 trades, +2.72% a trade, +1.89% / +3.54%), none of those filters separated winners, not even run-up (+2.62% up to +16%, +2.83% above it), so none is a plan limit either. They relearn under the 80% guard.
    - **Dip rebound** (the `second-leg` strategy; it needed a 10× run): ran 2×+, pulled back 25–70% (was 50–85%), held a higher low for 3+ minutes (10), 8%+ off the bottom (20%), buying back (last 15 minutes' buys 1.2× sells, $100+). The same coin again after an hour (6).
    - **Signals within 2 minutes:** each part of the deep scan gets a time budget (honeypot probe 10s, holders 12s, funding trace 15s). Funding not traced in time is a risk flag (the coin can still be a fast scalp), not a hard block, and a scan missing an answer is retried after 15s instead of being held 2 minutes. A honeypot probe that doesn't answer still blocks.
    - **Why fast scalps outnumbered snipes and dip rebounds (2026-09-30, owner: "improve the other signals; leave the fast scalper, it works"):**
      1. **The snipe rule counted the creator's launch buy.** On a dev-sniped coin (the creator bought ~50% for $2,500 at launch, as in 5 of 6 early candidates), that one buyer was most of the buy volume, so "no buyer over 25%" failed for the whole snipe window. The same buy made "$200 bought" and "buys over sells" true on their own. The rule now reads the market's own buying: the creator's buys and the launch blocks' are left out (their stake and any bundle are the scanner's checks), every sale counts, and "not late" runs from the first price after launch.
      2. **The momentum rule pre-empted the dip rebound.** A rebound is a burst of buying too. With momentum checked first, it fired a scalp and held the coin for 30 minutes, so the rebound was never looked at. The rebound is now checked first (after the snipe window). One that isn't a signal (a risky coin, a scan still running) leaves the coin to the momentum rule as before, and after a rebound fires, momentum waits its usual 30 minutes on that coin.
      3. **Unknown risks.** A risk check that hadn't answered in the scan's time (holders not read, funding not traced) counted as a risk, so a snipe became a scalp and a rebound was rejected on missing data. Both now wait for the scan (retried every 15s) for up to 45s (`UNKNOWN_RISK_WAIT_MS`), a snipe no later than the end of its window; after that, as before. A known risk still makes a snipe a scalp and rejects a rebound (the owner's rule).
      4. **By design:** momentum can fire on any coin under 48 hours old, every 30 minutes, while a snipe fires once per coin in its first 10 minutes and a rebound needs a run, a pullback and a recovery. Scalps will stay the most common. The Signals tab now marks a snipe on a risky coin that was fired as a scalp ("from a snipe on a risky coin").
      - The fast-scalp rule (`scalpReady`, `RULES.scalp`) and its exits are unchanged.
      - Tests: `engine/test/signalMix.test.ts`. Against the rules before this change, 6 of its 7 fail; the 7th (a known risk: the scalp fires as before) is meant to pass either way.
    - **Signals produced, no trades (2026-09-30, owner: "identify why the engine's signals are produced but the bot doesn't initiate trades").** Production's logs weren't reachable from the build sandbox (the engine's host is blocked there), so the causes were found in the code and measured with the engine's own functions:
      1. **Fast scalps skipped as "too thin".** At +15% a $1.50 target needs about $2,500 of liquidity at a 4% round trip, $5,000 at 6% and $10,000 at 8%, and none at 12%+. The momentum rule fires from $2,000, and a risky snipe becomes a scalp at any liquidity the scanner passes ($1,000). Now such a trade is sized for $1 (above).
      2. **The engine's own paper book stopped trading.** Snipes and second legs had no longest hold, so positions up 10–99% in coins that stopped trading stayed open for good. Once five were open, every new signal was dropped with only a log line ("bot: not opening: 5 positions open"). Every strategy now has a longest hold, and time exits use the last price the bot saw when the engine has forgotten a coin (`Bot.priceOf`).
      3. **Silent drops.** A bot that was funded but not started, or that doesn't follow the signal's strategy (new bots follow Fast scalp and Snipe, not Second leg), passed over signals without a word. Now each shows in the bot's list of signals passed over ("not traded: the bot is stopped (press Start)", "…this bot follows snipe"). A stopped bot that was never funded is left out.
      - Also: cash (scalps size to $13–46), learned filters, the 4-loss pause, the daily loss limit, the 5-open cap, and a coin traded recently. Every skip now has a key (`canOpen` returns one too).
      - **Counted:** `GET /v1/bot/rejections` has `signals.bots` (visitors' bots: signals in 24h, how many at least one bot traded, and why not, once per bot and signal; a live order counts as traded) and `signals.owner` (the engine's paper book). The Scanner tab shows both above "Why coins are passed over". `bot/scanFeed.ts` keeps them as `OutcomeTally`: hourly counts, so it stays small with many bots.
      - Tests: `engine/test/signalOutcomes.test.ts`.
    - **Why coins are passed over (`GET /v1/bot/rejections`):** each scan row carries `keys` (`snipe:buyers`, `scalp:move`, `leg:peak`, `safety:honeypot`, `pending:clusters`, …; the rules' `failed` ids and the scanner's check ids), and the endpoint counts watched coins by their main one, with labels (`REASON_LABELS` in `bot/scanFeed.ts`). The Scanner tab shows the top 8.
    - **After a restart (2026-10-01):** `bot.seed()` puts every launch of the last 48h back on the scanner at once, with the engine's last 100 trades of each in the tapes, price paths and rug guard. Before, every deploy emptied it until each coin traded again (4 coins watched right after one, 68 an hour later).
    - **Scanning faster:** besides each coin's own trades, `bot.sweep()` evaluates every coin that traded in the last 3 minutes every 3s (up to 600 a sweep); a coin is evaluated at most every 2s. Contract reads start on a coin's first trade, so its scan is quick once a rule is met.
    - A candidate gets a deep scan (probe, holders, funding; at most 6 at once, 8 contract reads at once; cached 2 minutes, 10 for coins over 30 minutes old) and fires only if it passes. Each signal says whether ARCDEX can trade it today (`executable`: not Peach's or Faze's curves yet), and carries the coin's numbers (`features`: age, liquidity, market cap, buyers, buys ÷ sells, run-up, largest buyer, safety score, risk flags, probe round trip).
    - **The rug guard (`bot/rugGuard.ts`)** reads every trade: liquidity 35% under its 15-minute high (pulled or drained), an early insider (a launch-block bundler, or a wallet funded from a cluster or by the creator) selling 4%+ of the pool, anyone selling 12%+ of it, or the price 20% under the minute's high on sells twice the buys. An alarm closes every position in the coin at once (exit reason `rug`, with the reason in `note`): the bot's paper book, the bot wallet's live positions and every visitor's bot. The coin isn't bought again for 30 minutes (the scanner shows it rejected with the alarm). A paper position closes at the price after the trade that tripped it. The liquidity figure is the pool's depth around the current price (from each swap), so in a pool of several concentrated positions a big move can drop it without anyone removing liquidity: the guard then gets out early, the safe side. `/metrics` counts `bot_rug_exits`.
  - **Paper trading (`trading/paper.ts`; `BOT_MODE=paper`, the default, or `off`).** Every signal opens a paper position, in live mode too. $25 a position (`BOT_SIZE_USD`). Costs both ways: half the probe's measured round trip plus impact for the size against liquidity.
    - Snipe exits (exit plan 2 since 2026-09-30, "Profit secured while it rises" above; before: −35% stop, half at 2×, a 35% trail, 45 minutes, 3 hours): half at +10%, then a break-even stop and a 25% trail, −10% stop, out after 3 minutes unless up 3%, an hour at most, out when the creator sells. Second leg: −20% stop, half at 1.8×, 25% trail, 6 hours, never held past 12. (The longest holds came 2026-09-30: without them a position up 10–99% in a coin that stopped trading never closed, and five of them filled every slot.)
    - **Fast scalp** (a snipe on a risky coin, or a momentum burst): $5 (`BOT_SCALP_SIZE_USD`; `BOT_SIZE_USD` sizes only snipes and second legs), half sold at +10%, then a break-even stop and a 25% trail (exit plan 2, 2026-09-30; before that, all of it at +15%, and before that 75% at +30% with a trail), −10% stop, out after 3 minutes unless up 3%, never held past an hour (`maxHoldMin`; it was 10 minutes), and closed on the creator's first sell (`exitOnCreatorSell`: the bot closes at that sale's price, after the dump, as a real exit would be). At most 3 scalps open, within the 5; a coin can be scalped again after 30 minutes (`cooldownMinScalp`).
    - Risk: 5 open at most, one coin not traded again for 6 hours (scalps: 30 minutes), no new positions after a $100 loss in a UTC day. Open coins (the bot's or any visitor's bot's) are re-scanned each minute and closed everywhere if they fail (turned honeypot, creator dumping).
    - Results: `GET /v1/bot/stats` (win rate, average win and loss, profit factor, expectancy, drawdown, per strategy), `/v1/bot/positions`, `/v1/signals`, `/v1/safety/:token`, and the `signals` WebSocket channel (`SIGNAL`, `BOT_POSITION`). Kept in the engine's Postgres (`arcdex_bot_signals`, `arcdex_bot_positions`), else memory.
    - `/metrics` counts which checks block candidates (`bot_block_fail_<check>`, `bot_block_pending_<check>`), and each blocked candidate is logged once with its failing checks.
  - **Live trading (2026-09-30; owner's request: "a toggle to switch paper or live").** In live mode the bot wallet also trades each signal it can reach with real USDC. Paper keeps running beside it, and the two sets of results are kept apart (`stats().live`, `Position.mode`).
    - **Executor (`trading/live.ts`):** Uniswap's own Universal Router (2.1.2, else 2.1.1, whichever answers for the PoolManager), not ArcDexSwapRouter. That keeps the bot's trades out of ARCDEX's fee totals, leaderboards and feeds.
      - Buy: one transaction. The USDC goes in as `msg.value`, and the router pays the pool from it (SETTLE, payer: router; SETTLE_ALL for native pools, as the site does). TAKE_ALL sends the coins, at least the minimum, and SWEEP returns what the pool didn't take. On Arc the native balance is the USDC ERC-20 balance, so this works for ERC-20 USDC and native-USDC pools alike, and **no USDC approval is ever given**.
      - Sell: the coin comes in through Permit2, approved right after the buy (once per coin), so an exit never waits on an approval. TAKE_ALL sends the USDC to the bot.
      - Every transaction is simulated first (retried briefly for a lagging node), sent one at a time with its own nonce through the public RPC (`ARC_SEND_URL`), and read back from its receipt. Money in and out comes from the native-USDC logger `0xff…fe` (an ERC-20 USDC transfer is logged there and by `0x3600…`, so only one is read), plus the gas.
      - Only v4 pools against USDC. Launchpad curves, v3 and pools quoted in other coins stay paper ("paper only" in the live activity).
    - **Trader (`bot/liveTrader.ts`):** the same exits as paper (`exitsAt`), filled at what each sale really paid. The creator selling (in any pool) closes a live scalp at once. A failing sale is retried at 15%, 35% and 60% slippage, then marked stuck and tried again at each tick.
    - **Every swap goes through on-chain (2026-09-30, owner's request: "make LIVE trading functional; by default all swaps of the BOT successful on-chain").** For the owner's bot and every visitor's live bot:
      - **The pre-flight, before every buy (`trading/preflight.ts`, on by default):** one eth_call runs the exact buy, the two approvals and the sale of everything the buy delivered, as the bot's own wallet.
        - How: the harness `contracts/test/sim/BotRoundTrip.sol` is put at the wallet's address by a state override, so the router and the pool's hook see the real wallet with its real USDC. A node that refuses a call from an address with code is asked from another caller.
        - The sale is encoded with a placeholder amount, and the harness writes the balance over it once the buy has run.
        - Not bought: a coin it couldn't sell (a honeypot, a hook that blocks the wallet or router, a tax that eats the sale), a round trip over `BOT_LIVE_MAX_ROUND_TRIP_PCT` (20%), one that leaves nothing at the take-profit (under half the target, for a visitor's bot), or a pre-flight that can't run.
        - These are logged as "not bought (pre-flight: …)", with the revert in words. The buy's gas limit is what the simulation used, plus 40%. `BOT_LIVE_PREFLIGHT=off` turns the pre-flight off (the owner's bot only).
      - **Sending (`trading/live.ts`):**
        - Each transaction is simulated right before it's signed; one that would fail is never sent.
        - Fees leave room for the base fee to double. Only what's used is paid.
        - Transactions are signed in the engine, so the hash is known before the node answers (a dropped connection still finds the receipt). They are sent again every 10s while no receipt comes.
        - A nonce the node says is used, or a fee it says is too low, is corrected and the transaction signed again. One that never confirmed hands its nonce, at twice the fee, to the next transaction.
        - A buy whose price moved past its slippage is quoted again, once.
        - Swaps carry a 2-minute deadline and are waited for until it passes, so none can land later at a stale price.
      - **After:**
        - A buy sent but never confirmed whose coins arrived anyway becomes a position.
        - A sale sent but not confirmed is looked up before another is sent, so coins are never sold twice.
        - A forced close (a rug alarm, a failed safety check, "sell all") is retried every tick until it goes through, whatever the price does.
        - A withdrawal leaves the reserve in the wallet while trades are open, plus any fee not sent yet.
      - **The site:** the live panels say that every buy is checked first.
      - **Checked:**
        - `engine/test/preflight.test.ts` (34 tests, stand-in node): the encoding, the verdicts, revert reasons through the router's, v4's and the quoter's wrappers, sending (nonces, fee bumps, rebroadcasts, lost connections, reverts, stale nonces) and every trader outcome.
        - `contracts/test/BotRoundTrip.t.sol`: the harness against stand-in router, Permit2 and coin contracts that decode the engine's calls. It has no cheatcodes, and was run in ethereumjs (solc 0.8.28, via-IR, the repo's settings) because Foundry couldn't be installed in the build sandbox. All six passed; with patching switched off, two fail.
        - The engine's own encoders, run against the harness in the same local EVM: a coin that sells back passes with its round trip measured; a honeypot, a coin that blocks approvals, a wallet that can't pay and a minimum the pool can't meet are each refused.
        - `roundTripBuild.ts` was built with solc-js. The owner's `forge build && bun engine/scripts/gen-roundtrip-build.ts --check` compares the code without its metadata.
        - **On mainnet (2026-10-01, from the owner's machine):** `bun engine/scripts/check-live-trade.ts` passed every check in both pool kinds: an ERC-20 USDC pool ($1 bought and sold straight back for $0.98, a 2% round trip) and a native-USDC pool (0.5%), and each buy was refused with a minimum of twice the quote. `forge test --match-path contracts/test/BotRoundTrip.t.sol`: 6 of 6. `gen-roundtrip-build.ts --check` found the runtime code byte-for-byte the same as Foundry's; only the ABI's JSON differed (solc-js orders keys differently), so the file was regenerated from `forge build`.
    - **Limits (Railway variables):**
      - `BOT_LIVE_TRADE_USD` 2 and `BOT_LIVE_MAX_TRADE_USD` 25 (2026-10-01): every trade starts at $2 and grows with what the bot wallet's live trades made, up to the cap ("Live trades at $2, growing with profit" above).
      - `BOT_LIVE_MAX_OPEN` 3 and `BOT_LIVE_MAX_OPEN_SCALP` 2: positions open at once.
      - `BOT_LIVE_DAILY_LOSS_USD` 50: no new position after that realized loss in a UTC day.
      - `BOT_LIVE_RESERVE_USD` 2: USDC never traded, kept for gas.
      - `BOT_LIVE_SLIPPAGE_BPS` 1000: buys at most 10% under the V4Quoter's quote.
      - `BOT_LIVE_MAX_ROUND_TRIP_PCT` 20: no buy whose pre-flight round trip costs more; `BOT_LIVE_PREFLIGHT=off` skips the pre-flight (not recommended).
      - `BOT_LIVE_MAX_SHARE_PCT` 20: above the $2 base, no buy over this share of what the bot wallet is worth (its USDC, read right before the buy, plus open trades at cost). The $2 itself is bought whenever the wallet can pay it and keep its reserve. Visitors' live bots use 20% too (`USER_LIVE.maxShareOfBalance`).
      - The same coin isn't bought again for 6 hours.
    - **The switch (`bot/control.ts`, `POST /v1/bot/control`):** the owner's wallet (`BOT_OWNER_ADDRESS`) signs the exact text from `botControlMessage` in `api/_marketProtocol.ts`. The engine checks it for EOAs and contract wallets (`verifyMessage`); a signature is good for 5 minutes and once.
      - Actions: paper, live, or "sell every live position".
      - The mode is kept in Postgres (`arcdex_bot_settings`), so it survives a restart. Live is refused without a bot wallet. Switching to paper stops new live trades; open ones are still managed.
      - `GET /v1/bot/status` publishes the mode, the owner, the bot wallet, its balance, the limits, today's live P&L and the last 40 live events. The send URL is never published or logged (a private RPC URL can carry a token).
    - **Owner setup:**
      1. Make a **new** wallet that holds only what the bot may trade, and put its key in Railway as `BOT_PRIVATE_KEY` (0x + 64 hex). The engine reads it in `main.ts` only; it's never in the config object or the logs.
      2. Set `BOT_OWNER_ADDRESS` to the wallet you open arcdex.online with (the trading wallet or a connected one).
      3. Fund the bot wallet with USDC on Arc, then switch to Live on `/signals`.
      - Without `BOT_PRIVATE_KEY` the page says live trading isn't set up, and nothing can switch it on.
    - **Checked:**
      - `engine/test/live.test.ts`: encodings byte for byte against a real Arc buy (`fixtures/ur-swaps.json`, `scripts/capture-ur-swaps.ts`) and the site's encoder; receipt reading; the signed switch; the trader's limits, exits and retries against a stand-in wallet.
      - `bun engine/scripts/check-live-trade.ts`: the exact buy and sell calls, simulated on mainnet from a throwaway address (balance, token and Permit2 storage overrides), in the busiest ERC-20 USDC and native-USDC pools. Each goes through with its minimum and is refused with a minimum of twice the quote. It passed for both on 2026-09-30, and again with the pre-flight on 2026-10-01.
      - A local engine with throwaway, unfunded keys: status, a stranger's, stale, replayed and altered signatures refused, and the owner's live, sell-all and paper accepted.
      - Not checked yet: a real funded trade (that's the owner's first live trade), and the owner switching from the page with their own wallet (the page signs the same message the script did).
  - **Autotrade for everyone (2026-09-30, owner's request).**
    - **Paper accounts (`bot/paperAccounts.ts`):** any visitor gets one (no wallet): deposit virtual USDC, choose one or more strategies (Snipe, Fast scalp, Second leg), press Start.
      - Every signal of a followed strategy opens a position in each running account that has the cash, with modelled costs and its risk rules (open positions, a coin once per 6 hours, the daily loss stop). Accounts run on the engine, so they keep trading with the browser closed.
      - Reached with a random key kept in the browser (`localStorage` `arcdex:paper-key`); the engine stores only its SHA-256, in Postgres (`arcdex_paper_accounts`).
      - Caps: 20,000 accounts, 5 new accounts an hour per IP, $100,000 per deposit, $1,000,000 per account, the last 200 closed trades in the account (all of them in the trade log).
      - `POST /v1/paper/accounts` with `{name, strategies}` (the key, once); `GET|POST /v1/paper/account` with `X-Paper-Key` (deposit, start, stop, strategies, rename, reset); `GET /v1/paper/trades?limit=&before=` (the trade log).
    - **Named, self-tuning bots (2026-09-30, owner's request: "each account names its bot and picks its strategies; all of a user's bot trades available so the bot reads its loss trades and improves each user's strategies; prevent rug pulls and close fast so the account isn't drained; the amount per trade not set by the user, the minimum that secures $1–4 and closes").**
      - **A name:** 2–24 letters, digits, spaces or `. _ ' -` (`cleanName`), set at creation with the strategies, and renamable. Rows from before get `Bot XXXX` and default settings on load (`normalize`).
      - **Automatic size (`bot/sizing.ts`):** the visitor no longer sets an amount (the `size` action is refused). Each trade is the smallest (from $5, in $0.50 steps, up to $250) that, sold in full at the strategy's take-profit, nets its target after the probe's round trip and price impact both ways: fast scalps $1.5 (range $1–2), snipes and second legs $3 ($1–4). A thinner pool needs a bigger size. Where no size reaches the target, the trade is sized for $1, the low end of the range (`sizeForTrade`); only a coin where not even $1 can be netted is skipped. User bots sell everything at the take-profit.
        - **The balance comes first (2026-10-01, owner: "auto check the balance and don't use a high amount per trade on a small-capital bot"):** no trade over 20% of what the bot is worth (`SIZE_LIMITS.maxShareOfBalance`, `maxTradeFor`). Paper: cash plus open trades. Live: the wallet's USDC (the last read, at most 15s old) plus open trades at cost, and the live trader reads the balance again right before the buy and applies the same 20%, shrinking the trade (and its target) if it has to. A bot too small for its target inside that 20% takes the smallest size that nets $1, else the whole 20% if that nets at least $0.25 (`small`: "a small bot: at most 20% of its $30 a trade, so aiming for $0.63"), else it waits ("small-balance", counted in `GET /v1/bot/rejections`). The smallest trade is $2 (was $5). A pool too thin for the target never gets a bigger trade because the bot is rich: that stays "too thin". The Protection list shows the cap and today's most per trade.
      - **Its own settings per strategy (`StrategyTuning`, `bot/learner.ts`):** take-profit (scalp and snipe +10%, second leg +35% to start; half sold there since exit plan 2), stop (−10%, −10%, −15%), time stops, the profit target, and entry filters on each signal's `features` (minimum liquidity, buyers, buys ÷ sells and safety score; maximum run-up and largest buyer; risk flags to skip). Each position keeps the exits it opened with (`Position.exits`) and the tuning version.
      - **Learning from losses:** after each close, the learner reads the strategy's last 20 closed trades (once the current version has 5 of its own). Rugs and dumps → more liquidity and safety score needed, and the risk flags the rugged coins shared are skipped. Losers that rose most of the way to the take-profit → the take-profit comes closer (the size grows to keep the dollar target). Fast stop-outs → buys must outweigh sells more, and coins already up as far as those entries are skipped. Time-outs → more buyers. And the one threshold on one feature that would have kept out most losses for few wins. Bounded (take-profit ranges, filter caps); every change is a new version with its reason in the learn log.
      - **Rollback and loosening:** a version that wins 10 points less often than the one before it over 8+ trades is rolled back; filters that skipped 15+ signals with no trade for 2 hours come 40% back toward open.
      - **Drain protection:** the rug guard and the creator selling close its positions at once; 4 losses in a row pause new trades for 30 minutes; the daily loss limit is 10% of the deposits (between $10 and $100); an account down 50% from its deposits stops (open trades still managed). At most 5 open, 4 of them scalps.
      - **The trade log:** every closed trade, with the coin's numbers at entry, the tuning version, the profit target and why it closed (`note`), in Postgres (`arcdex_paper_trades`, kept for good; closed trades from older rows are backfilled once) or memory. A reset keeps it.
      - The account view adds the name, each strategy's tuning with its current size for a typical pool and its record, the learn log, activity and the signals it passed over (with why), and its protections.
      - Tests: `engine/test/botLearning.test.ts` (sizing, the rug guard, the momentum rule, the learner, a bot end to end), `engine/test/botFlow.test.ts` (the real `Bot` with a stand-in engine: a momentum burst to a visitor's buy, then a liquidity pull closing everything).
    - **Accounts, the marketplace and live bots (2026-09-30, owner's request: "a unique identifier per bot; a bot marketplace with positions and P&L; sign up with email and a 4-letter passcode, reset by email; bots running with devices off; paper first, then live for the same bot; a 2% fee on each trade's profit, none on losses; enable live trading").**
      - **Accounts (`bot/users.ts`, `bot/mailer.ts`, routes in `ws/botApi.ts`):** email + a 4-character passcode (letters or digits, case counts: 14.8M possibilities), stored as scrypt with a salt. 5 wrong tries lock the account 15 minutes (then 30, 60…, at most a day); an IP gets 30 wrong tries, 5 sign-ups and 5 resets an hour; an unknown email costs the same hashing as a known one. Sessions are signed tokens (30 days; `AUTH_SECRET`, else a random secret kept in `arcdex_bot_settings`); a reset, a passcode change or "sign out everywhere" voids older ones. Kept in Postgres `arcdex_bot_users`.
      - **Email (Resend):** sign-up emails a 6-digit verification code; "forgot passcode" emails a new passcode (sent first, then it takes over; every device signed out; at most every 5 minutes per email; the answer is the same whether or not the email has an account); withdrawals need an emailed code bound to that amount and address. Codes: 5 tries, one a minute. Without `RESEND_API_KEY` sign-up still works, but verification, resets, withdrawals and live mode don't.
      - **Bots belong to accounts:** up to 5 per account. Every bot's name is unique on the platform by its slug ("Night Owl" → `night-owl`), its public id in the marketplace. Older names that clash get a number on load. A browser-key bot joins the account on sign-up or sign-in (the key is sent once, then dropped); after that its key no longer reaches it (403).
      - **Marketplace:** `GET /v1/bots?sort=pnl|winrate|new|live` (bots with a deposit, a wallet or a trade; computed at most every 5s) and `GET /v1/bots/:slug` (open positions valued now, the last 50 trades, what it learned, its paper record). Never the owner's email. Site: the Marketplace tab, `/bots` and `/bots/<name>`.
      - **Paper first, then live for the same bot (`bot/userLive.ts`):** live opens once its paper record has 20+ closed trades, a 55%+ win rate, a profit factor of 1.2+ and a net profit (`READY`), the owner is signed in, and the bot's own wallet holds $10+. A verified email isn't needed (owner's request, 2026-09-30). Each live bot has its own wallet, made on the engine; its key is encrypted with AES-256-GCM under `BOT_WALLET_SECRET` (the bot's id as associated data) and never leaves the engine, so **the engine holds what owners deposit**. It trades through the bot wallet's executor and trader (Uniswap v4 pools against USDC), each buy checked by the pre-flight first ("Every swap goes through on-chain" above): its own size (target-sized, at most $50), its learned exits, the rug guard, at most 3 open (2 scalps), a daily loss limit of 10% of the wallet ($5–$100), $1 kept for gas, and back to paper if the wallet falls 50% below where it went live. Switching back to paper stops new live trades; open ones are still managed; "sell all live" closes them.
      - **The 2% fee:** a winning live trade sends 2% of its profit (after gas) to the fee wallet `0x2742…86Bb` right after it closes (a `fee` transaction on the position; retried each minute until sent); a loss pays nothing. Paper wins pay the same 2% virtually, so paper reads like live. Shown per trade and in totals.
        - Checked 2026-10-01 (`engine/test/accounts.test.ts`): a fee whose transfer fails stays owed (`feeDue`), is held back from withdrawals, and goes out at the next try a minute later. The transfer is native USDC, which on Arc is the same balance as the USDC token.
      - **Money out:** at most the balance less $0.20 for gas (less $1 while trades are open, and less any fee still owed). Two ways:
        - **Without email (the default since 2026-09-30, when the owner dropped email verification for live):** the account passcode (wrong tries count toward the sign-in lockout, `Users.checkPasscode`), and only back to a wallet that funded the bot. `bot/funders.ts` reads the bot wallet's USDC deposits from the chain (both log sources, each transaction and sender once; 9k-block slices from before the wallet was made, then only new blocks; kept on the wallet as `funding`). A funder is an ordinary wallet (no contract code; EIP-7702 counts) that sent at least $1 and at least 5% of everything ordinary wallets sent it, the site's trading-wallet rule: a $0.01 "deposit" from someone's own wallet doesn't make it a funder. Sales paid out by a contract aren't funding. So a stolen session plus the passcode can only send money back where it came from. Routes: `GET /v1/me/bots/:slug/funders`, `POST /v1/me/bots/:slug/withdraw {to, amountUsd, passcode}`.
        - **With a verified email:** a code for exactly that amount and address, then any Arc address (as before).
        - Tests: `engine/test/funders.test.ts` (deposits, the share rule, contracts, scanning); `accounts.test.ts` (live with no verified email; a withdrawal to a funder, refused to a stranger and to a dust sender, a wrong passcode, the lockout).
      - Routes: `/v1/auth/signup|login|forgot|verify/send|verify|passcode|logout-all`, `/v1/me`, `/v1/me/bots`, `/v1/me/claim`, `/v1/me/bots/:slug` (GET, POST: deposit, start, stop, strategies, rename, reset, mode, live-wallet, sell-live), `/v1/me/bots/:slug/trades`, `/v1/me/bots/:slug/withdraw/code`, `/v1/me/bots/:slug/withdraw`.
      - Tests: `engine/test/accounts.test.ts` (sign-up, lockouts, resets, verification and codes; unique names, owners and claims; the fee; the marketplace; readiness; a live bot's buy, take-profit and fee, a rug exit and a withdrawal against a stand-in wallet; rejection counts; the routes). Taking the fee out fails two of them.
      - **Owner setup (Railway, service arcdex-engine):**
        1. `RESEND_API_KEY` from resend.com, and `MAIL_FROM` on a domain verified there (default `ARCDEX <bots@arcdex.online>`, which needs arcdex.online verified in Resend).
        2. `BOT_WALLET_SECRET`: 32 random bytes as 64 hex characters (e.g. `openssl rand -hex 32`). Keep a copy somewhere safe: without it no bot wallet can be opened again. Changing it locks every existing bot wallet.
        3. Optional `AUTH_SECRET` (any long random string); without it the engine makes one and keeps it in its database.
        - Until 1 and 2 are set, the page says so, and every bot stays on paper.
        - **Is it on?** `GET /health` has `bots` (since 2026-10-01): `email` (1 is set), `userLive` (2 is set and usable), `ownerWallet` (BOT_PRIVATE_KEY), the owner's bot `mode`, and how many bots exist and run. Yes/no only, never a secret.
    - **The scanner (`bot/scanFeed.ts`):** every coin launched in the last 48h, with its status and why:
      - `new` (no trade yet);
      - `watching` (which market rules aren't met, and the snipe window left, or why it's waiting for a second leg);
      - `checking` (safety checks still running);
      - `rejected` (the failed hard checks);
      - `signal`.
      - A signal or rejection stays the coin's verdict.
      - `GET /v1/bot/scan?status=` and the `scan` WebSocket channel: the rows that changed, and the numbers (coins, checks a minute, signals and rejections in 24h), every 2s, so the site shows the engine working.
    - Tests: `engine/test/autotrade.test.ts`.
  - **Site: `/autotrade` (`/signals` still works; `pages/SignalsPage.tsx`).** Named AUTOTRADE in the app (owner's request): "⚡ AUTOTRADE", highlighted, in the top bar; Autotrade in the phone tab bar; and the AUTOTRADE button on the phone home (your paper account's value while it runs, else the coins being scanned).
    - A live scanner strip on every tab (a pulsing dot, coins scanned, checks a minute, the last check counting up, signals and rejections today).
    - **Since the accounts (2026-09-30):** My bots asks to sign up or sign in first (email + 4-character passcode, "Forgot your passcode?"), then shows the account bar (email, verify, change passcode, sign out, sign out everywhere), a chip per bot and "+ New bot", and each bot's dashboard with a live panel: the paper record against what live needs, email verification, the bot's wallet (address, balance, deposit note), the Paper/Live switch (live asks to confirm, naming the 2% fee), live P&L and fees, "Sell all live positions", withdrawals by emailed code, and the live activity. Tabs: My bots, Marketplace, Scanner (with the top rejection reasons), Signals, Bot results. The phone home's AUTOTRADE button reads the signed-in account's bot.
    - **The bot dashboard, redesigned (2026-09-30, owner: "PAPER to LIVE on one toggle button, fund the live and paper wallets, re-arrange the bot trading interface to be more professional and easy to navigate"):**
      - **Header:** the bot's name and Running/Stopped, its strategies, public page and P&L card, then **one Paper/Live switch** (`ModeSwitch`, a single button) and Start/Stop.
        - To live: the switch opens a checklist (`GoLive`): proven on paper (a progress bar and the numbers against what's needed), and the live wallet funded ($10+; make it or fund it from there). "Switch to LIVE" is enabled once both are done, and asks to confirm, naming the 2% fee.
        - Back to paper: one confirmation; open live trades are still managed.
        - The card turns red while live.
      - **Two wallets side by side:** Paper (virtual USDC, + Fund with $100 / $1,000 / $10,000 or any amount) and Live (its own wallet: balance, address that copies, + Fund, Withdraw; or Create live wallet). The one in use is marked.
        - **Fund live (`FundLive`):** from the ARCDEX wallet in one tap (the unlocked trading wallet or a connected wallet; $10 / $25 / $50 / $100 or any amount; a plain USDC transfer through `useSendUsdc`, with the trading wallet's passcode rule, `useWithdrawGuard`), or from anywhere to its address (QR code, copy).
        - **Withdraw (`WithdrawLive`):** to a funding wallet with the account passcode; with a verified email, "Send to another address (emailed code)".
      - **Four numbers** for the book in use (paper: value, P&L, win rate, open; live: wallet, live P&L, win rate, open and fees paid).
      - **Tabs:** Overview (open trades, the last 5 closed, the latest activity), Trades (the full log and CSV), Strategy (strategies, automatic sizing, each strategy's learned settings), Learning, Activity (what it did, signals passed over, the live wallet's log) and Settings (rename, profit notifications, protection, the live wallet's limits and "no approvals to click", sell all live, reset paper).
      - The page title no longer shows the engine's own bot mode (it read as the visitor's bot's); the Bot results tab still has it. The $ARCD tiers note moved under the dashboard.
      - Checked in a browser against a stand-in engine (the engine's own account and bot code, a stand-in wallet and chain): sign-up, a bot, funding paper, making the live wallet, the checklist with both steps done, switching to live and back, the fund panel (both ways), a withdrawal to the funding wallet with the passcode, the Settings tab, and a 390px phone with no sideways scroll.
    - Checked in a browser (2026-09-30) against a stand-in engine running the engine's own account, bot and marketplace code (a memory mailer, a stand-in wallet): sign-up, a bot, a name already taken refused, the paper record, email verification with the code from sign-up, the live wallet and balance, switching to live, a withdrawal by emailed code (the email names the amount and address), the marketplace and a bot page (no owner email), the rejection reasons, sign out, forgot passcode and sign in with the emailed one, and no sideways scroll at 360px. The verification box was hidden until a second code was asked for (and sign-up had just sent one): fixed.
    - Tabs before the accounts: **My autotrade** (create a bot: its name and strategies; then value, cash, P&L, win rate, deposit, strategy cards, each strategy's automatic size, exits and learned filters, Start/Stop, what it learned, its protections, open trades, the full trade log with Load more and a CSV download, its activity and the signals it passed over, reset), **Scanner** (every coin with its status and reasons, filtered by status), **Signals**, and **Bot results** (below).
    - Checked in a browser (2026-09-30) against a stand-in engine running the real `PaperAccounts`: creating a bot (a bad name refused), deposit, start, a simulated session (wins, near misses that taught it a closer take-profit, a rug alarm), the CSV, and no sideways scroll at 1280px and 360px.
  - **Landing (`landing/Landing.tsx`, redesigned 2026-10-01, owner's request: "Autotrade is the main feature now: more professional, less detail, a new slogan, smaller type, the contents rearranged"):**
    - Slogan: "Self-improving trading bots for Arc." (owner's pick). The hero is the slogan, one line and "Create your bot", beside the live bot board (`landing/LiveBots.tsx`: the marketplace's own list, `GET /v1/bots?sort=pnl`, polled every 5s; each P&L counts to its new value, its row flashes, a bot that changes rank slides; the top 5 that have traded, each linking to its /bots page, and the combined P&L).
    - Then: a metrics strip (coins scanned, signals in 24h, $ARCD market cap, $ARCD burned), How it works (3 short steps), Autotrade access with $ARCD (the tiers, below), $ARCD (price, 24h change, market cap, liquidity, burned, CA, links to the burn dashboard, explorer and GeckoTerminal), the rest of the app in six tiles, the roadmap in one line (phase dots, the current phase, the whitepaper), five questions, a closing call and the footer.
    - Gone: the long feature cards, the buyback flow and fee table, the recent burns list, the full roadmap cards and most of the FAQ (the whitepaper and the burn dashboard keep the detail). Type is smaller throughout (body 15px, the headline up to ~50px).
    - $ARCD's market cap and 24h change had stopped showing (see "Upstream key" below); the landing now also asks the market engine (`/v1/tokens/<ARCD>`) when `/api/arcd` has no market.
  - Before 2026-10-01:
  - Before 2026-10-01: an Autotrade section (scan, choose strategies, trades around the clock; paper with virtual USDC; results measured, not promised), its live numbers from `/v1/bot/scan`, a feature card, a hero button, a nav link and an FAQ entry.
  - **$ARCD access tiers (2026-10-01, owner's decision: Tier 1 at 5M, Tier 2 at 20M, Tier 3 at 50M $ARCD).** Since 2026-09-30 the tiers are by signal quality and the engine holds the table (`engine/src/bot/tiers.ts`; "Signal grades, tiers by signal quality" above); `src/arcdex/lib/tiers.ts` is the site's copy for when the engine can't be reached. Accounts link wallets to count their $ARCD; nothing is locked until `TIERS_ENFORCED=true`.
  - **Profit pop-ups on the landing page (2026-10-01, owner: "the pop up notification of PNL for any bot that makes a profit on the landing page, small, that won't disturb users and fades away in seconds"):** `landing/ProfitToasts.tsx` reads the engine's public feed of winning trades, `GET /v1/bots/profits?since=` (`PaperAccounts.recentProfits`: any bot, paper or live, the last hour, newest first). The feed carries the bot's name and page, never its owner, and is worked out at most every 5s.
    - The landing reads it every 8s while the tab is visible. One pop-up at a time, bottom left (bottom centre on phones), 4 seconds on screen, then at least 6 seconds before the next. When many bots profit on one coin, the biggest stands for them. At most 2 wait their turn; older ones are dropped. On arrival only the latest recent profit shows.
    - Each pop-up shows the bot's name, PAPER or LIVE, the profit and its % and the coin, and opens the bot's page on a click. It uses `role="status"` with no sound and no focus change, and just fades under reduced motion. It's rendered into `<body>`, because `.ld > *` forces `position: relative`.
    - Checked in a browser against a stand-in engine: on screen 4.0s, the next 6.0s later (a poll during a pop-up no longer extends it); 360px phone centred with no sideways scroll. Route test: `accounts.test.ts`.
  - **Traffic counter (2026-10-01, owner: "a small card that shows the live count of online users, people who have visited and those who are online, like a traffic counter"):** a small card under the hero's call to action (`landing/TrafficCard.tsx`): ● online now · visitors today · visitors in all, each number counting to its new value.
    - **Heartbeats (`lib/traffic.ts`):** every open page of the site, the landing and the app (`App.tsx`), sends `POST /v1/traffic/beat {id}` every 30s while visible. The body is text/plain, a simple request with no preflight. The id is random, kept in this browser's localStorage (`arcdex:visitor`); there is no cookie, and nothing else about the visitor is sent or stored.
    - **Engine (`engine/src/traffic.ts`, `Traffic`):** online is ids heard from in the last 75s (memory); today and in all are distinct ids since midnight UTC and since counting began on 2026-10-01 (Postgres `arcdex_visitors`: id, first and last seen). An id is written at most every 30 minutes, the stored counts are read at most every 15s, and one IP can bring at most 20 new ids an hour. Beats from other sites' pages (Origin not in `WS_ALLOWED_ORIGINS`) aren't counted. `GET /v1/traffic` gives the counts.
    - Checked in a browser against a stand-in engine running `Traffic`: a reload and the app counted as the same visitor; visitors who left dropped from online within ~80s while today and in all kept them; 360px phone on one line. Tests: `engine/test/traffic.test.ts`.
  - **P&L cards (2026-10-01, owner: "let each bot produce a P&L card shareable to social media").** `renderBotCard` in `lib/shareCard.ts` draws a 1200×630 PNG: the bot's name, strategies, PAPER/LIVE, P&L in dollars and percent, win rate, trades, since when, and the curve of its closed trades; `components/BotShare.tsx` (`ShareBotButton`, `BotShareModal`, `cardFromAccount`, `cardFromMarket`) opens it in `ShareCardModal` (now any card image): Share… (the phone's share sheet, with the image), Post on X, Download image, Copy link. On the owner's dashboard, on every bot's public page, and from a profit notification. Paper cards say "Paper trading · virtual USDC".
  - **Profit notifications (2026-10-01, owner: "notifications for each profit realized on each trade").** `GET /v1/me/profits?since=` (signed in; at most a day back) lists the winning trades an owner's bots closed. `components/ProfitAlerts.tsx`, mounted in `App.tsx`, asks every 15s (a minute in a background tab) while ARCDEX is open on any page: a toast per profit (bot, amount, coin, %, strategy, paper/live, after the 2% fee) with Share P&L card and View, and a system notification once the owner turns on "Notify me of every profit" on their bot's dashboard (the browser asks first). First run on a device starts from now; seen trades are remembered (`arcdex:profit-seen`). With every ARCDEX tab closed there is no notification yet: that needs web push (a service worker, VAPID keys and sending from the engine).
  - **Bot results tab (was the whole `/signals` page).**
    - A PAPER/LIVE badge, and the bot panel: the mode switch (only the owner's wallet, signed; live asks to confirm, with the limits shown), the bot wallet, its balance, today's live P&L, the limits, "Sell all live positions", and the live activity log.
    - Results per strategy (Snipe, Fast scalp, Second leg), for Paper or Live.
    - Live signals with their checks (a scalp's risk flags in amber). Open and closed positions of the chosen book; live ones carry their transactions (explorer links), the gas, and a sale that keeps failing.
    - Read from the engine (`getBotStats`, `getSignals`, `getBotPositions`, `getBotStatus`, `sendBotControl` and the `signals` channel in `api/marketStream.ts`); an engine without `/v1/bot/status` still shows the rest.
    - It says the results are measured, not promised. Without an engine running the bot it says the signal engine isn't reachable.
    - The engine answers the site only from `WS_ALLOWED_ORIGINS` (CORS). To try it locally, run the engine with `WS_ALLOWED_ORIGINS=http://localhost:5173` and set `VITE_ARCDEX_WS_URL=ws://localhost:8099/ws` in `.env.development.local` (gitignored).
  - Tests: `engine/test/intel.test.ts`, `scanner.test.ts`, `trading.test.ts`, `live.test.ts`.
- **Argus launches (measured 2026-09-25):**
  - Portal 7 `0xB021…97Da` handles ~3,000 launches/day. Its event `0x1d891723…` carries token, creator, name, symbol and poolId.
  - Portal 8 `0xeed7…5D93` handles ~125/day through `Launched` + `LaunchMetadata`.
  - Portals 1–6 are dormant.
  - Each launch tx also carries the PoolManager `Initialize`, so the pool is registered before its first trade.
- **v4 pools with `currency0 = 0x0`** trade native USDC (18 decimals). The engine prices them. The coin page trades them through Uniswap's Universal Router ("Native-USDC v4 pools").
- **Database v5:** `supabase/migrations/20260928000000_arcdex_market_engine.sql`, tested on PGlite. Only needed if the engine stores history in Supabase; the Railway deployment below uses its own Postgres instead.
  - It adds `arcdex_mkt_*` tokens, pools, trades, candles, liquidity and cursor tables.
  - Functions: `arcdex_mkt_rebuild_candle` and `arcdex_mkt_cleanup`. Retention: trades 72h, 1s candles 6h, 5s 24h, 15s 3d, 1m 30d.
- **Running on Railway (since 2026-09-25):** project **arcdex**, service **arcdex-engine**, built from GitHub `olomierik/ZAKA` `main` (the only repo the Railway GitHub App can see).
  - Public URL: `https://arcdex-engine-production.up.railway.app` (WebSocket `wss://…/ws`, `/health`, `/v1/…`).
  - History goes to the project's own Postgres (`DATABASE_URL=${{Postgres.DATABASE_URL}}`, `store/postgresHistory.ts`, tables created on start); hot state to its Redis (`REDIS_URL=${{Redis.REDIS_URL}}`). Also set: `TRUST_PROXY=1`, `WS_ALLOWED_ORIGINS=https://arcdex.online,https://www.arcdex.online`, `LOG_LEVEL=info`. Supabase keeps the site's own data.
  - The root `railway.toml` builds `engine/Dockerfile`, health-checks `/health`, and redeploys only on engine file changes. A restart resumes from the cursor saved in Redis/Postgres.
  - **Railway doesn't read `railway.toml` any more (2026-09-30):** the service's Config-as-code file path is empty, and Railway has deprecated config files (they work until 2026-12-01). The settings live in the service itself (arcdex-engine → Settings), set by the owner to match the file: Builder **Dockerfile**, path `engine/Dockerfile`; Watch Paths as in `watchPatterns`; healthcheck `/health`, 120s; restart on failure, 10 retries. Change them there, and keep `railway.toml` in step as their record.
    - With Railway's default builder (Railpack) the service runs the website's `bun run build` (`vite build`) and fails ("Failed to resolve /src/main.tsx"). That, plus Railway's GitHub App losing its view of the repo ("Could not load branches"), kept the engine down from 2026-09-27 to 2026-09-30.
    - **Redeploy** on an old deployment rebuilds that deployment's commit. To ship `main`, push to it (with the GitHub access working, Railway builds each push that touches a watched file) or use "Deploy latest commit".
    - After a long outage the engine catches up at ~800 blocks/s (measured 2026-09-30: 322k blocks in ~7 minutes); `/health` says `degraded` / `catching_up` meanwhile, and the bot doesn't trade replayed trades.
  - **A failed start no longer takes the engine down (2026-09-30, after "the signal engine just went unreachable" right after PR #18 was merged and deployed).** The chain stream's first call (`eth_blockNumber`) failing, e.g. an RPC answering with an error page, used to end the process ("engine failed to start"). Railway then restarted it into the same failure, and after 10 retries left the service down. Railway's logs weren't reachable from the build sandbox, so this was found in the code and reproduced locally: the engine exited within 2 seconds when the chain didn't answer.
    - Now (`engine/src/lifecycle.ts`): the stream is started in the background and retried (5s, 10s, … up to a minute apart) while the API and the bots keep serving. `/health` says `down` (503) until it starts, so a redeploy that can't reach the chain fails its health check and the running deployment stays.
    - A timer that throws (market tick, bot tick, sweep, scan push, …) is logged and counted (`timer_errors`), not fatal, and an unhandled promise rejection is logged (`unhandled_rejections`) instead of ending the process.
    - Checked against a stand-in RPC that answers its first calls with a 502 page: the engine stayed up, served every endpoint the Autotrade page reads, and started the stream on the second try. Tests: `engine/test/lifecycle.test.ts`.
    - **If it's down again:** Railway → arcdex-engine → Deployments. The latest deployment's logs name the error (`chain stream did not start`, `… failed`, `unhandled rejection`). To restore service at once, **Redeploy** the last deployment that worked; that rebuilds its commit.
- **The site uses the engine (switched on 2026-09-25):** the owner set `VITE_ARCDEX_WS_URL=wss://arcdex-engine-production.up.railway.app/ws` in Vercel project `app` (Production). The REST base is derived from it. To switch off, remove the variable and redeploy; pages then use their direct-from-chain path (`poolSwaps.ts`), which is also their automatic fallback within 4s whenever the engine is unreachable. A custom `wss://api.arcdex.online/ws` would need that DNS pointed at Railway first.
  - Measured on 2026-09-25 against Railway: trades p50 1.7s block → client (p90 2.4s, including up to ~1s of block-timestamp rounding), new launches ~2s, and 1s candle closes matched 15/15.
- **Frontend (`src/arcdex/api/marketStream.ts`):** one shared, ref-counted WebSocket. What uses it:
  - **Coin page:** engine trades via REST + `token` channel, merged by trade id, with chain fallback after 4s or on REST failure.
  - **PriceChart:** engine candles + `CANDLE_UPDATE`, with a 5s timeframe in engine mode.
  - **Terminal:** `new_tokens` rows with a NEW badge, visible before their first trade; `market` ticks update prices; list polling slows to 60s.
  - **Search:** includes fresh launches.
- **Tests:** `bun run engine:test` — 53 tests (+2 Postgres ones that need `PG_TEST_URL`; `engine/test/curves.test.ts` covers Mercuri and SolonPad), including catch-up backpressure, live batching, replays of recorded mainnet data (`engine/test/fixtures/mainnet.json`) and a RESP3 Redis round-trip against Bun's client. Live latency: `bun engine/scripts/latency-check.ts <ws-url> 60`.

## The site's read functions run on the engine (2026-10-02, shipped 2026-10-03)

Vercel paused arcdex.online (402) for the CPU its functions used. The read functions (`/api/argus`, `/api/gecko`, `/api/holders`, `/api/launchpad`, `/api/radar`, `/api/dex`) are served by the market engine (`engine/src/site/siteApi.ts`, `/api/*` in `ws/server.ts`), with their stored copies and the holder index in the engine's own Postgres (`setKvStore`, `HolderStore`), GeckoTerminal calls metered from its one IP (`setGtFetch`), a response cache, the trade indexer once a minute, and the launchpad indexes warmed at start. The site calls the engine first (`src/arcdex/api/siteFetch.ts`) and its own `/api/…` only when the engine can't be reached. `SITE_API=off` stops them on the engine. The Dockerfile copies the `api/` files they import (`engine/test/image.test.ts` checks it), and Railway's Watch Paths need them too. Tests: `engine/test/siteApi.test.ts`.

## ARCSENSE: the rebrand (2026-10-03)

Owner: ARCDEX becomes **ARCSENSE**, spot and futures trading on Arc, at www.arcsense.site; $ARCD is left out entirely ("don't even mention it"); platform fees keep going to the same fee wallet, unchanged.
- **Name:** every user-visible "ARCDEX" is "ARCSENSE" and every "arcdex.online" is "arcsense.site" (app, landing, page titles and link previews, the app manifest, share cards, referral and profile links, all seven dictionaries). Not renamed on purpose: the `arcdex:` browser storage keys (trading wallets live there), `VITE_ARCDEX_*` variable names, `X-Arcdex-*` headers, file and folder names. The wallet sign-in message reads "Sign in to ARCSENSE (arcsense.site)" on both sides (`api/_session.ts`, `src/arcdex/api/social.ts`).
- **$ARCD removed:** the burn page and its menu entries, the navbar burn ticker, the landing's $ARCD and tiers sections, the Autotrade tier card and free-trading countdown, `/api/arcd` (site and engine), `lib/arcd.ts` (its fee wallet and explorer constants moved to `lib/platform.ts`), the roadmap's buyback line and every dictionary entry about it. The engine's tier code still reads $ARCD internally; tiers are off and nothing shows it.
- **Logo (owner's, 2026-10-03):** the "A" with a rising arrow, cut from the owner's image: `public/arcsense-mark.png` (transparent, header and landing), `favicon-64.png`, app icons on white (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, maskable-safe) and the full logo for link previews (`arcsense-logo.png`). The name shows as in the logo: "Arc" in the text colour, "sense" in the mark's blue-to-violet (`.brand-word`, `.ld-word`).
- **Supabase on the engine:** `api/_supabaseAdmin.ts` falls back to the project's public address, so Railway needs only `SUPABASE_SECRET_KEY`; wallet sign-in needs `ARCDEX_SESSION_SECRET` of at least 32 characters.
- **The whitepaper is offline** (the page, `whitepaper.html`, its PDF and X images): it described $ARCD's fee model. An ARCSENSE whitepaper is still to be written.
- **The landing page** (`landing/Landing.tsx`): "Spot and futures trading on Arc.", a perpetual-futures card (BTC, ETH, SOL; up to 10×; testnet first, then mainnet after an independent audit), the app's features, where the fees go (since 2026-10-03: 30% buy back and burn $SENSE, 70% to liquidity pools; see "$SENSE buyback and liquidity" below), the roadmap and four questions. The bots' board and profit pop-ups are off while Autotrade is paused (`LiveBots.tsx`, `ProfitToasts.tsx` are kept).

## ARCSENSE looks like Binance, in blue (2026-10-04)

Owner: "the app should behave like Binance where we're in common, spot and futures included; layout and UX like Binance but blue; not everything; a site that makes people want to buy $SENSE; the landing page can go, but $SENSE must be visible". Binance's spot, futures and home pages were studied in Chrome (read-only).
- **Theme (`arcdex.css` `:root`, `landing.css`):**
  - Binance's dark palette: page `#0b0e11`, panels `#181a20`, raised `#1e2329`, lines `#2b3139`, text `#eaecef`, muted `#848e9c`, green `#0ecb81`, red `#f6465d`.
  - ARCSENSE blue where Binance has yellow: buttons `--accent-btn` `#2a6df4`, links `--accent-text`.
  - IBM Plex Sans for text and numbers, with tabular figures (`index.html` loads it).
  - The chart uses the same colours (`PriceChart`, `lib/chartStyle.ts`).
  - The redesign's rules sit at the end of `arcdex.css`, after the older ones they override.
- **Top bar (`components/NavBar.tsx`):**
  - Markets (the coin list), Spot ($SENSE/USDC), Futures (Testnet), Swap, Portfolio, Bridge, $SENSE, then More (the social pages). Links that don't fit move into More as the screen narrows.
  - On the right: search, $SENSE's live price and 24h change, a blue **Buy $SENSE** button and the account.
  - Desktop has no side panels any more (no discovery panel, no right rail). The ☰ drawer keeps them on narrow screens.
  - The bottom bar (`Rails.tsx` `TickerBar`): Arc's status, $SENSE/USDC first, then the blue chips.
- **$SENSE's numbers (`lib/sense.ts`):**
  - One shared poller of the engine's `/v1/tokens/<SENSE>`, every 15s (`useSense`), used by the top bar, Markets, the spot screen and the home page.
  - Also the constants: address, pool, `SENSE_PATH`.
  - Its logo is the site's own `arcsense-mark.png`; the IPFS image loads slowly.
- **Markets (`pages/Terminal.tsx`, `/app`, also `/markets`):**
  - Binance's overview cards: $SENSE (price, market cap, liquidity, Buy), Hot coins, Top gainers (with $500+ volume and $1,000+ liquidity) and Top volume.
  - Binance's table: Name (SYMBOL/QUOTE), Price, 24h change, Market cap, Liquidity, 24h volume, 24h trades, Holders, Risk, Trade.
  - $SENSE is pinned above the first page, marked Official.
- **Spot (`pages/ArgusTokenPage.tsx` on desktop, `/spot` opens $SENSE/USDC, as Binance opens on its own pair):**
  - The pair bar.
  - Market trades where Binance has its order book (`components/SpotPanels.tsx` `MarketTrades`): Arc coins trade against pools, so the trades are the book, with the 24h buy/sell balance underneath.
  - The chart (420px), then a buy form and a sell form side by side (`ArgusSwapWidget` `side`, `compact`): market orders only, which fill at once against the pool.
  - The pair list on the right (`PairList`: what's trading now on the engine, $SENSE first, ★ favourites).
  - Position, safety and about under the pair list; trades, holders and theses underneath.
  - Every other coin's page has a one-line $SENSE strip.
  - Phones keep the app layout (chart, stats, tabs, Buy / Sell bar).
- **Futures (`pages/FuturesPage.tsx`):**
  - Binance's ticker strip and pair bar, with a pair picker.
  - The chart (430px), a trades column (everyone's opens and closes, this pair first), and Binance's order panel:
    - Isolated, and a leverage button that opens Adjust leverage;
    - Limit / Market; Avbl, price and margin inputs; a share-of-balance slider; TP/SL;
    - **Buy / Long** and **Sell / Short** side by side, each with its liquidation price and cost.
  - Below the order panel, an account box (test balance, gas, both faucets). Positions, open orders, trade history and the pool are underneath.
  - The contract calls are unchanged.
- **Home (`landing/Landing.tsx`, `/`):** Binance's home.
  - Headline "TRADE ARC. / OWN $SENSE." with the fee line, two laurel badges (First: spot + futures on Arc; 30% of fees burn $SENSE), and $SENSE's contract address with Copy and Buy $SENSE.
  - Beside it, a markets card (Popular with $SENSE first, New listing, Futures) and $SENSE's card (price, market cap, liquidity, bought back, burned, Buy).
  - Then futures, where the fees go, the app, the roadmap, questions (now including how to buy $SENSE) and the footer.
- **Phones:** the tab bar is Markets · Futures · **Trade** ($SENSE's screen) · Portfolio · More (Swap moved to More).
- **Round 2 (same day, owner: "the main page takes so much space the coins can't be seen, on phones and PCs; remove 'the first', just an exchange; style Swap and Bridge to attract multichain users"):**
  - **Markets, as Binance proportions it:**
    - Desktop: no title line; four compact cards; then one toolbar (tabs, live count, search, sort, Filters).
    - Launchpad pills and min/max ranges sit behind Filters; page numbers are under the table.
    - The first coin row is about 270px from the top on desktop (8+ rows on a 900px screen).
    - Phones: the cards are hidden, and the cash strip is one line (`MobileHome`: cash, Withdraw, Deposit; the futures banner is gone, Futures has its own tab).
    - Phone rows are like Binance's app: name and volume, price, and the 24h change in a green or red box. $SENSE is pinned first. The first coin is about 144px down, with 11 on a 812px screen.
  - **Wording:** "exchange" everywhere "first" was. The home badge reads "10× · Futures on BTC, ETH and SOL", and the stale dictionary entries are gone.
  - **Networks (`components/Chains.tsx`, `lib/bridgeChains.ts`):**
    - Each chain's mark in its colour (no third-party logos bundled), a strip of all of them, and `ChainPicker`, a button that opens a searchable grid.
    - `lib/bridgeChains.ts` holds the 11 networks; `lib/bridgeKit.ts` builds `BRIDGE_CHAINS` from it, so pages that only show networks don't load Circle's library.
    - Don't name a class `fixed`: Tailwind's `.fixed` makes it `position: fixed`.
  - **Swap (`pages/Swap.tsx`), as Binance's Convert:**
    - A From box (USDC on Arc), then a To box with search, quick picks ($SENSE first, copycat tickers left out) and the most traded list.
    - The picked coin's header has Change and View chart, and the swap widget sits below it.
    - Beside it: "USDC on another chain?" with the 11 networks and Deposit USDC to Arc, how it works in three steps, and $SENSE's card.
  - **Bridge (`pages/Bridge.tsx`):**
    - Deposit to Arc / Send from Arc tabs.
    - From and To boxes, each with its network picker (Arc's side fixed), a large amount and "You receive ≈ …", and a flip button.
    - The quote, the route (Circle CCTP v2), and a stepper for approve → burn → attestation → mint with explorer links. Retry works as before.
    - Beside it: why bridge here, all supported networks (Solana greyed out for deposits), and "On Arc? Start trading". The bridge logic is unchanged.
  - **Checked** in the browser pane: the Markets positions on desktop and at 375px; the Swap and Bridge layouts at 1280px and 375px; the network picker (Ethereum picked, the route and note follow; Solana left out of deposits). No sideways scroll.
- **Every new string is in all six dictionaries.**
- **Checked (local dev against the live engine):**
  - Markets, spot, futures and home at 1440 and 1280px: the top bar fits, More opens, no script errors.
  - Home, Markets, spot and futures at 375px: no sideways scroll.
- **Local dev against the live engine:** set `VITE_ARCDEX_WS_URL=ws://localhost:5173/__engine/ws` in `.env.development.local`. `vite.config.ts` proxies `/__engine` to Railway with ARCSENSE's origin (the engine answers only its own origins).

## Robinhood Chain: its coins and stock tokens, traded from Arc (2026-10-04)

Owner: "let users see Robinhood coins and buy and sell them just like Arc coins". Scope chosen: view and trade Robinhood Chain's coins, funded from Arc, with the fee in each trade and Arc untouched. Robinhood's stock tokens can be traded too, blocked by the visitor's location (owner's choice; **the owner's legal check comes first**, and location blocking isn't watertight).

- **Robinhood Chain:** chain 4663, an Arbitrum Orbit L2 with ETH gas and ~100ms blocks (viem's `robinhood`). Its dollar is Paxos's USDG.
  - Coins mostly trade against WETH or native ETH; stock tokens trade against USDG.
  - Circle's Bridge Kit doesn't support the chain. Across does.
  - Constants and reads are in `lib/robinhood.ts`.
- **Where:**
  - `/robinhood` (`pages/RobinhoodMarkets.tsx`): the Markets layout. Cards: how it works, stock tokens, hot coins, top gainers (a day old at least). Tabs: All / Memecoins / Stocks / New, plus search and sort.
  - `/robinhood/token/0x…?pool=` (`pages/RobinhoodTokenPage.tsx`): the spot screen's layout. Market trades, the chart (`PriceChart` with a GeckoTerminal source), buy and sell forms side by side, the coin's pools, and every trade. Phones get chart, stats, trades and a Buy / Sell bar.
  - Reached from an Arc | Robinhood Chain switch in the Markets toolbar (phones: a tab at the end of the tab row), More (top bar and phones) and the drawer.
- **Data (`api/robinhoodMarket.ts`):** GeckoTerminal's network `robinhood`, called straight from the visitor's browser (`gtDirect` in `gtClient.ts`, the same 2s pacing). It never goes through the app's proxy or the engine: their shared quota stays Arc's.
  - **The list:** the 60 busiest pools, the newest pools, and two pages of the search "Robinhood Token". It's one row per coin: the main pool is the deepest one quoted in USDG, WETH or ETH, and volume is summed over the coin's pools.
  - **Caching:** the list is kept in the browser for 30 minutes (`arcdex:rh-market:v1`) and rebuilt at most every 90s.
  - **Wash filter:** a pool doing over $10k in a day from fewer than 4 wallets is hidden; it seemed common, e.g. ZYNOREK's "$68M" from 1 buyer and 1 seller. Quiet pools and pools under 2 hours old are kept.
  - **Trap pools (2026-10-04):** some coins have pools with a 20–90% fee priced hundreds of times off the market, with large "liquidity" and almost no trades (SHRINU / USDG 20% and 55%: $818K "liquidity", $629 of volume, priced ~300× under SHRINU's busy WETH pool).
    - A coin's main pool (price, chart, trades, liquidity) used to be its deepest, which picked the trap: SHRINU showed −99% and the trap's chart. Now pools are ranked (`rankPools`): no trap fee (≥10%, `TRAP_FEE_PCT`, read from the pool's name by `poolFeePct`), then traders, then volume, then a USDG/WETH/ETH quote, then depth.
    - `markPools` marks a pool off the market when it has a trap fee or a price more than 1.5× from the best pool's. Off-market pools are left out of the coin's volume, tagged "⚠ Off-market pool" and can't be opened on the coin page; a link naming one opens the best pool. The coin's price is always its best pool's.
    - The browser's market list moved to `arcdex:rh-market:v2`, so lists built the old way are dropped.
  - GeckoTerminal escapes some names ("S&amp;P"); they're unescaped.
- **The list on the engine (2026-10-04, owner: "Only BANKR coins are shown, PONS and other launchpads' coins are not there").**
  - **Why:** the browser built the list itself, 17 GeckoTerminal calls in a row:
    - the busiest pools and the stock tokens;
    - each launchpad's pools (Bankr, Clanker, Clank.trade, Virtuals, Pons ×3, EasyA, Mint Club, o1, Frontier.fun, Hoodit);
    - then more pages.

    GeckoTerminal's free API lets one IP make about five calls before it answers 429 (measured 2026-10-04: at one call every 4s, 6 went through, then about one in three). A throttled call was skipped after one retry. So Bankr's, Clanker's and Clank.trade's pools came in, and every launchpad after them was dropped, every time.
  - **`api/rhmarket.ts` (the engine's `/api/rhmarket`):** the list is read a little at a time on the engine's own GeckoTerminal budget (the metered 25 calls a minute).
    - Whenever the stored copy (`arcdex_kv` `rh:market`) is over 40s old, the next 2 calls of the round (`rhListPaths` in `api/_rhCore.ts`) refresh their pools. That's about 3 calls a minute while anyone looks, and the whole list is re-read every ~6 minutes.
    - A throttled call is tried again next time; one answered with an error is left for that round.
    - A pool not read again for an hour drops out.
    - Stock-named coins are checked once on Robinhood Chain (the beacon slot, by plain RPC).
    - With no stored copy, the first request reads as many calls as fit in 12s.
  - **`api/_rhCore.ts`:** the list logic, shared by the browser and the engine with no browser or chain libraries: the launchpads, `poolToCoin`, trap pools, `mergeCoins`, `listed`. `robinhoodMarket.ts` and `lib/robinhood.ts` re-export it, so their imports didn't change.
  - **The site (`loadRhMarket`):** the engine's list first (through `siteFetch`).
  - **Without the engine, the browser builds the list itself:**
    - The busiest pools come first.
    - Then the rest of the round, from where its last build stopped (`arcdex:rh-cursor`), stopping at the first refusal.
    - Coins the last list had that this build didn't reach stay for an hour after they were last read.
    - So over a few builds every launchpad comes in.
  - **Coin pages** still call GeckoTerminal from the browser, first in its queue.
  - **Railway:** the Dockerfile copies `api/_rhCore.ts` and `api/rhmarket.ts`, and `railway.toml` watches them. Add both to the service's own Watch Paths, or an edit to them alone won't redeploy the engine.
  - **Tests (`scripts/test-robinhood.ts`, offline):**
    - a round is one call per launchpad venue, and a whole round lists all ten launchpads;
    - the stock check (a vouched stock listed, an impostor and a coin from no launchpad not);
    - a throttled call held, an error skipped, an hour-old pool dropped;
    - the route: a first list, the stored copy after, and two calls in the background when it's stale.
- **Live trades from the chain (2026-10-04, owner: "the Robinhood trading activity and loading is very slow, it doesn't respond like Arc coins; the buy and sell pop-ups on the chart don't show at all").**
  - **Why:**
    - The coin page's trades were GeckoTerminal's, polled every 12s, and GeckoTerminal's indexer lags. A trade reached the page well after the chart's 60s pop window (`LIVE_WINDOW_MS`), so nothing ever popped.
    - Every GeckoTerminal call shares one 2s pace per visitor, and the market list's ~18 calls queued ahead of the coin page's.
  - **Now (`api/rhSwaps.ts`), as `poolSwaps.ts` does for Arc:** the pool's swaps come from Robinhood Chain's public RPC.
    - **On open:** the last 30k blocks (~50 minutes; ~1.5s for the busiest pool), or 300k (~8.5h) when that found under 50 swaps.
    - **Live:** a filtered `getLogs` plus the latest block every 0.8s, start to start, while the tab is visible. Each new swap shows ~0.4–0.5s after its block, is marked live, pops on the chart, moves the chart's last candle (`ticks`) and sets the price.
    - **Which logs:** v4 pools (Uniswap's and Pons's) by pool id on the PoolManager, `0x8366…0951` as on Arc. v2/v3 pools by address, with the v3 and v2 `Swap` topics. Decoded with the shared `decodeSwapLog`; the coin's side comes from address order.
    - **Dollars:** USDG is $1. ETH and WETH are priced from Uniswap v3's WETH/USDG pool `0x52e6…71ca` (`slot0`). Any other quote is priced off the coin's GeckoTerminal price, once.
    - **Makers:** the transaction's sender, 3 reads at a time (the RPC refuses batches), for the newest 40 rows. Older ones come from GeckoTerminal's trades.
  - **The RPC (measured 2026-10-04):**
    - No WebSocket, and batches are refused (429). 20 calls at once and 10 a second are fine.
    - A call takes ~0.3s, and logs are readable 0–9 blocks behind the head.
    - Logs carry no block time (`blockTimestamp` is `0x0`), and blocks come every 0.102s. So a swap's time is counted back from the latest block, timed by the browser's clock.
    - One `getLogs` may span 10M blocks and return 10k logs.
    - QuickNode serves Robinhood Chain over WebSocket too. It would need an endpoint of the owner's and bills each event, so it isn't used.
  - **GeckoTerminal now:** older trades and makers (every 60s while the chain feeds the page; every 12s, as before, for a pool the chain can't read), candles, stats and pools.
  - **GeckoTerminal's queue:** `gtClient.ts` releases the highest priority first (`gtDirect(…, { priority })`). The coin page's calls go before any market list's: the coin itself (3), its candles (2), then its trades (1). The first release waits a tick, so a page's calls are all in line before one goes (a chart's effect runs before its page's).
  - **Opens at once:** the page starts from the coin's row in the market list already in the browser (`rhSeed`).
    - A link with a pool reads the pool's two tokens from the chain (`rhPoolTokens`): `token0()`/`token1()`, or a v4 pool's `Initialize` event, newest 10M-block slice first. So trades start without GeckoTerminal: 100 rows 2.5s after a cold load while GeckoTerminal was throttled.
  - **Safety:** the chain's live price feeds the trade form's price guard only for a pool GeckoTerminal has listed for the coin and not marked off-market. A link to a trap pool can't set the market price before GeckoTerminal answers.
- **Stock tokens:**
  - **What they are:** named "<Company> • Robinhood Token". On-chain, each is a beacon proxy on Robinhood's beacon `0xe10b…1b00` (`isStockToken` reads the EIP-1967 beacon slot).
  - **Impostors:** the chain decides. A token with a stock name that isn't on the beacon gets a warning and no stock tag.
  - Counted on 2026-10-04: 17 listed, among them NVDA, SPY, TSLA, AAPL, GOOGL, META, AMC, GLD, MSTR and QQQ.
- **Trading (`lib/acrossQuote.ts` quotes and checks, `lib/across.ts` sends, `components/RobinhoodTrade.tsx`):** Across's Swap API.
  - **Buy:** USDC on Arc, signed on Arc, where gas is USDC, so the trading wallet trades at once. It goes to `SpokePool.deposit`, and the coin arrives at the same address on Robinhood Chain in ~2s. Refunds come back as USDC on Arc (`refundOnOrigin`).
  - **Sell:** signed on Robinhood Chain with ETH gas (`SpokePoolPeriphery.swapAndBridge`); USDC arrives on Arc.
  - **Gas:** "Add $0.50 of gas" swaps Arc USDC for ETH on Robinhood Chain (~0.00017 ETH, 10–20 sales, no fee). A first buy offers it as a tick box, approved together with the buy.
  - **Fee:** the swap router's `feeBps` (2%), as Across's `appFee`, to the fee wallet `0x2742…86Bb`. A buy's fee arrives as the coin on Robinhood Chain (the fee wallet is an ordinary account there too); a sale's fee arrives as USDC on Arc.
  - **Quote checks:** a quote is refused unless its transaction is exactly the trade asked for:
    - the contract Across publishes for that chain (SpokePool `0x9b4a…4a84` on Arc, periphery `0x97cc…5fd4` on Robinhood Chain);
    - no native value;
    - the trader as depositor, and the token and amount asked for;
    - the right destination chain;
    - the approval asked for on that contract;
    - a recipient that is the trader or Across's handler (`0xa8ad…b6bd` / `0xa074…547b`), whose instructions name the trader and, with a fee, the fee wallet;
    - a minimum received.
  - **Sending:** the approval is always for the exact amount (Across's own approval transactions ask for unlimited and are ignored). Then a fresh quote, which stops if it delivers 3% less than the one shown. The exact transaction is simulated from the trader, then sent, and the fill is followed through Across's `/deposit/status` until it lands or is refunded.
  - **Safety rails:** a contract wallet (not EIP-7702) can't buy, because it may not exist at the same address there.
  - **The price guard (2026-10-04, owner: "fix the price impact"):** Across picks its own route on Robinhood Chain, and it took SHRINU's trap pool both ways. A $25 buy quoted "771M SHRINU ≈ $5.4K" while the form said "Total cost 0.0%"; a ~$7 sale quoted $0.01 (99.8%) behind only a tick box.
    - Every quote is valued at the coin's market price (`quoteValue` in `lib/acrossQuote.ts`). Price impact is what the swap delivered (before the 2% fee, after the bridge's fee) against the market value. Total cost includes the fees.
    - `quoteVerdict`, with `QUOTE_LIMITS`:
      - over 25% better than the market: refused, a route through an off-market pool ("This quote pays 222× SHRINU's market price…");
      - 50%+ price impact: refused;
      - 15%+ price impact or total cost: a tick box;
      - no market price: a tick box.
    - Refused quotes show why, and the button reads "No fair route".
    - `runAcross` also stops when the fresh quote before signing delivers over 25% more than the one shown: the route changed.
    - The form shows Price impact on its own row, next to the total cost.
    - Checked: NVDA $25 under 0.1% impact (2.3% / 1.9% total), MOW $25 2.4% / under 0.1%, SHRINU both ways refused.
  - **LI.FI was looked at instead (2026-10-04):** it supports both chains, but bridges through Across too (AcrossV4) and its DEX step (Kyberswap) routed the same SHRINU buy into the trap (783M SHRINU ≈ $5,500). It had no quote for selling SHRINU or buying MOW. It priced NVDA a little better.
    - Its integrator fee builds up in LI.FI's fee collector and must be claimed to the fee wallet, a different way of collecting fees. Its transactions go to LI.FI's own contracts, which would need their own quote checks.
    - Not used; the price guard applies to whatever route is quoted.
- **Stock gate (buys only; selling is never blocked):**
  - The country comes from `netlify/edge-functions/geo.ts` at `/geo` (Netlify's edge, never cached), read by `lib/geo.ts`.
  - Unknown means not allowed: local dev, an outage, a blocked request.
  - Blocked countries (`STOCK_RESTRICTED`): the US, Canada, the UK, Switzerland, the UAE, and sanctioned countries (Cuba, Iran, North Korea, Syria, Russia, Belarus). Elsewhere the buyer ticks that they're not a US person and don't live there; the tick is remembered in this browser.
  - In local dev, `?geo=XX` (or localStorage `arcdex:dev-geo`) sets a country.
- **Portfolio:** "On Robinhood Chain" (`components/RobinhoodHoldings.tsx`, `lib/rhPortfolio.ts`): the coins held there, valued and counted in the total, each with Sell to USDC, plus the ETH for gas.
  - Coins checked: those bought from this browser (`arcdex:held-rh:v1:<owner>`) and the cached market list, in one multicall. The section makes no GeckoTerminal calls of its own, and is hidden when nothing is held there.
  - Blockscout's token API answers 403 (a challenge page), so it isn't used.
- **Wallets:** `robinhood` is in `wagmi.ts`, so a connected wallet is switched (or the chain added) for a sale. The trading wallet signs there through `getEmbeddedWalletClientOn`. The "Switch to Arc" bar is hidden on Robinhood pages.
- **Across API key (2026-10-04):** Across requires an API key and an integrator ID in production; without the key, requests get strict rate limits (429). The form to get both is docs.across.to/tools/integrator-id.
  - **Where the key lives:** it's a secret, so it's never in the page. `netlify/edge-functions/across.ts` serves `/across/swap/approval` and `/across/deposit/status`, adding `Authorization: Bearer <key>` from the Netlify environment variable `ACROSS_API_KEY`. It also adds `ACROSS_INTEGRATOR_ID` (or `VITE_ACROSS_INTEGRATOR_ID` in `netlify.toml`, which the page sends itself).
  - **What it forwards:** only requests from the site's own pages (`Sec-Fetch-Site: same-origin`): quotes between Arc and Robinhood Chain with any fee at most 2% and paid to the fee wallet, and a deposit's status. Everything else is refused.
  - **Without a key:** it answers 503 and `acrossFetch` (`lib/acrossQuote.ts`) asks Across directly for the rest of the visit, as before. Local dev, which has no edge, does the same.
  - Answers sent with the key carry `x-arcsense-across: key`, which is how to check it's on.
- **Owner steps:**
  1. Put the Across API key in Netlify (project `arcsense-app` → environment variables, `ACROSS_API_KEY`, marked secret) and the integrator ID as `ACROSS_INTEGRATOR_ID`, then redeploy.
  2. The legal check on offering stock tokens.
  3. Buy fees collect as coins on Robinhood Chain at the fee wallet: selling them needs ETH gas there.
- **Not in the $SENSE ledger yet:** `engine/src/sense/program.ts` counts fees paid by ARCSENSE's own contracts. A Robinhood sale's fee comes from Across's handler on Arc, and a buy's fee is a coin on Robinhood Chain.
- **Tests:**
  - `bun scripts/test-robinhood.ts [--live]`, offline on recorded quotes (`scripts/fixtures/across-*.json`, `rh-pools.json`, `rh-shrinu.json`). It also covers trap pools (SHRINU's recorded pools: the WETH pool first, both traps off the market) and the price guard (MOW's quotes pass; SHRINU's trap-routed buy and sale, `across-trap-*.json`, are refused; the 15%, 50% and +25% limits). Without the off-market check, or with pools ranked by depth again, it fails. It covers the quote URL, real quotes passing, and 20 tampered quotes refused. It also covers market rows, wash and quiet pools, stock names, restricted countries and routes. It also covers the `/across` proxy: what it forwards and refuses, and that the key goes only in the `Authorization` header to Across (with a fake key). `--live` adds fresh Across quotes and on-chain stock checks. Removing the recipient check or the native-value check fails it.
  - `bun scripts/check-rh-swaps.ts` (live, nothing sent): the busiest v4 and v3 pools read the way the page reads them, against GeckoTerminal's trades. 300 of 300 matched on side, coin amount, dollars (within 5%) and time (within 20s), and new swaps arrived ~0.4–0.5s after their block.
  - `bun scripts/sim-robinhood.ts` simulates on mainnet, from a throwaway address with state overrides (nothing sent), the exact transactions for a $5 MOW buy, a $5 NVDA buy, a $0.50 gas top-up and a 10 MOW sale. Each goes through with exactly the amount approved, and is refused with less.
- **Checked in the browser (local dev):**
  - `/robinhood` and its Stocks tab, at 1024px and 375px with no sideways scroll.
  - NVDA's page: chart, trades, pools, and the gate (no country → closed, Kenya/Tanzania → the tick, US → blocked, selling open).
  - A $5 quote of 0.0207 NVDA ≈ $4.86 (2.8% all in).
  - An address with no token.
  - A read-only test wallet (the fee wallet's public address, every signature refused): Buy $0.21 asked for exactly `approve(SpokePool, 210000)` on Arc USDC.
  - The Arc Markets page unchanged on phones (first coin 144px down).

## ARCDEX again: the platform and its coin, launchpad coins only (2026-10-04)

Owner: "Change the CA on our landing page to 0x4b93…676c, the ticker is ARCDEX, I have given you the logo; remove SENSE and make ARCDEX our platform coin; bring back the coin info, the burn rate, its MC and each buy and burn in real time; this is a multichain DEX where spot and futures trade, now Arc and Robinhood are tradable; make it appealing; only list coins launched on launchpads, on both Arc and Robinhood, to avoid malicious contracts". Asked, the owner chose:
- **ARCDEX everywhere:** app, landing page, page titles, link previews, share cards, sign-in text and the header wordmark. The domain stays arcsense.site.
- **The 30% / 70% fee split, now for $ARCDEX:** 30% of fees buy back $ARCDEX and burn it, 70% go to liquidity. Fee collection is unchanged (fee wallet `0x2742…86Bb`).
- **Robinhood's stock tokens stay listed** beside launchpad coins, with buying still blocked by country.

- **The coin (`lib/coin.ts`, was `lib/sense.ts`):** `0x4b93446882d29e094181b2fae14b126577a2676c`, an Argus Portal 8 launch. On-chain its name is ARCDEX and its symbol ARCD (wallets show ARCD; the site shows $ARCDEX). 1B supply; pool `0x87b65f…9897`, recovered from git history.
  - The engine's ledger is `engine/src/coin/program.ts` (was `sense/`), served at `GET /v1/coin/program` (`/v1/sense/program` still answers). The old `sense-program` setting is left alone; the ARCDEX ledger starts fresh.
  - **Burn history:** besides the program's own burns, it reads every $ARCDEX anyone sent to `0x…dEaD` since the coin was created (block 22,522,612), through the archive-aware `scanLogs`. That gives the burned total, the share of supply, the count, and the 24-hour and 7-day amounts. Checked against mainnet on 2026-10-04: 403 burns, ~32.76M burned (3.28%). `bun engine/scripts/check-coin-program.ts` runs the ledger against mainnet in memory.
- **Logo:** the owner's image cut into `public/arcdex-mark.png` (header, transparent), `arcdex-logo.png` and `arcdex-og.png` (link previews, on the logo's own background). The wordmark is lower-case "arcdex", as in the logo.
- **Landing (`landing/Landing.tsx`, `landing/CoinLive.tsx`):** "Trade Arc & Robinhood. Own $ARCDEX."
  - The coin card shows price, market cap, liquidity, 24h volume and trades.
  - The burn meter shows the burned total, the share of supply, and the last 24 hours and 7 days.
    - **Burned is read from the dead wallet (owner, 2026-10-04):** `useCoinBurned` (`lib/coin.ts`) reads `balanceOf(0x…dEaD)` on $ARCDEX from Arc (Blockdaemon and the public RPC, first answer wins; ~0.45s) every 15s. It feeds the meter, the hero's share burned and `/burn`'s total, so the number shows before the engine answers and doesn't depend on it. The engine's ledger still gives the 24h, 7d, count and history (it matched: 32,761,511.04).
  - A live feed lists buys, sells and burns.
  - The burn chart shows a bar per day on a square-root scale, so the launch week's big burns don't flatten every later day, with dates under it.
  - Then the CA with Copy, a "Two chains. One exchange." section listing each chain's launchpads, and the fee split (`CoinProgram.tsx`, was `SenseProgram.tsx`).
- **App:** $ARCDEX takes $SENSE's places: the top-bar price and Buy button, the pinned Markets row, Spot, the bottom ticker and the pair list.
  - The burn page is `pages/ArcdexPage.tsx` at `/burn`; `/sense` still opens it. It isn't at `/arcdex`, which an old standalone page (`arcdex.html`) already serves.
  - That page's owner controls now burn $ARCDEX: before, they still pointed at SENSE.
- **Sign-in (`api/_session.ts`):** the message reads "Sign in to ARCDEX (arcsense.site)". The engine accepts both names (`SIGN_IN_BRANDS`), so a page loaded before the switch still signs in.
- **Launchpad coins only:**
  - **On Arc:** `isLaunchpadCoin` (`api/_launchpads.ts`) passes ARCDEX's own launchpad, a known launchpad, or a venue named like one. "Other" and plain DEX pools don't pass. It's applied to Markets, search, the spot pair list, the Swap list and the landing's lists. Blue chips (WETH, EURC…) carry no launchpad.
  - **On Robinhood Chain:** `RH_LAUNCHPADS` (`api/robinhoodMarket.ts`) holds the launchpads by GeckoTerminal dex id: Bankr, Clanker, Clank.trade, Virtuals, Pons (curve and DEX), EasyA Kickstart, Mint Club, o1, Frontier.fun and Hoodit. A coin is listed once one of its pools is a launchpad's (`isListedRh`); Robinhood's stock tokens are listed once the chain vouches for them.
    - The list build also reads each launchpad's busiest pools, so it makes about 18 GeckoTerminal calls. The browser's list key is `arcdex:rh-market:v3`.
    - Rows tagged with their launchpad.
    - A coin page for an unlisted coin blocks buying (selling stays open, so nobody is stuck holding it).
  - **Fixed afterwards (2026-10-04):** a page that asked for the Robinhood list while a build was running got only the finished list. React's development mode runs effects twice, so `/robinhood` sat empty for up to a minute when GeckoTerminal throttled. Now every caller gets rows as each call lands (`listeners` in `loadRhMarket`): measured from a cold start, 22 coins by 14s and 42 by 26s while throttled.
- **Tests:** `scripts/test-robinhood.ts` (which Robinhood coins are listed), `engine/test/coinProgram.test.ts` (burns by anyone show in the history without counting as the program's), and `test-session`, `test-curve-index` and `test-launchpads`. Every new string is in all six dictionaries.

## The coin board, safety ratings and a listing standard, on Arc and Robinhood Chain (2026-10-04)

Owner: "what feature should I add to attract more users and avoid buying rugs; should we set a standard for which coins appear, classifying coins as near bond, graduated, new?", then "do it for all chains". The owner didn't pick the two numbers offered, so the suggested ones are used: **Near bond at 70%**, and **$2K of liquidity and 20 holders** for the default lists. Each is one constant to change.

- **Stages (`lib/coinStage.ts`):**

  | Stage | When |
  |---|---|
  | **New** | under an hour old |
  | **Bonding** | still on a launchpad's curve |
  | **Near bond** | 70%+ along that curve (`STAGE.nearPct`) |
  | **Graduated** | off the curve, or launched straight into a pool |
  | **Established** | a day old, $10K+ of liquidity and 100+ holders (on Robinhood Chain, 50+ wallets trading in 24h stand in for holders) |

  - **Arc:** curve coins are ArcLaunchpad, Mercuri and SolonPad (their curve's progress), and Argus launches not yet bonded.
    - **Argus progress (`api/_argusBonded.ts` `launchStatus`):** each launch's start and bond ticks, from its Portal record, plus the launch pool's current tick (a v3 pool's `slot0`, or v4's StateView `getSlot0` by the hook's `poolId`, cached). That's one more multicall a build; the market list carries it as `ArgusPool.progress`. Since the next round it's by market cap, and the engine reads every Argus coin on its curve (below).
    - Measured: 28 Argus coins in 2.5s, 20 bonded and 8 bonding (the top one 45%). Every bonded flag matched the stored copy.
    - Before, the site's Argus rows said `graduated: false` and no progress.
  - **Robinhood Chain:** Pons's curve pools (`pons-v2`, `pons-dot-family`) are Bonding; since the next round, with Pons's own progress (below). Every other launchpad launches straight into a pool. Robinhood's stock tokens are Established.
- **Safety rating (`lib/safety.ts`):** ✅ Safe, ⚠ Risky, ⛔ Danger or ◌ Checking, with the reasons in words.
  - **On Arc, from the engine's safety scan:** the sell test, contract, hook, creator and buyers (below), plus the launcher's record and the market data.
    - **Danger:** a failed sell test (a honeypot, or a heavy tax), hook, contract, proxy, self-destruct, creator (already sold most) or launchpad check. Also a fake ticker, or a launcher that dumped 2+ coins at a rate (dumps + 1) / (coins + 4) over 40%.
    - **Risky:** a failed bundle, clusters, wash, liquidity, holders, serial or copycat check; a launcher rate over 25%; or a high market risk.
    - **Safe:** the sell test passed (on a curve there's none to wait for) and nothing above.
    - **Checking:** not scanned yet.
  - **A coin the engine doesn't track, and every Robinhood Chain coin,** is rated from its market data (`lib/risk.ts`), and its badge says so. Only a low market risk reads as Safe; wash trading is Danger, and a Robinhood stock token is Safe.
- **Engine (`bot/boardSafety.ts`, `Bot.boardSafety`, `GET /v1/safety?tokens=…`, up to 120 a request):**
  - Answers at once from each coin's last report, as the site reads it (`CoinSafety` in `api/_marketProtocol.ts`), with the launcher's record (`bot/creatorMemory.ts`).
  - A coin with no report, or one over 10 minutes old, is queued: two scans at a time, a request's first coins (the top of the page) first, newer requests ahead of older asks, 400 waiting at most.
  - Coins under 6 hours old get the full scan. Older ones get the sell test alone (`report(…, { probe: true })`, cached 30 minutes), since reading days of transfers for holders takes too long.
  - The site (`api/coinSafety.ts`) asks every 20s for the coins worth asking about: the young and on-curve ones, the busiest 150, the youngest 40 graduates and $ARCDEX.
- **The listing standard (`meetsStandard`):** the default lists leave out Danger, and pool coins under $2K of liquidity or 20 holders (holders unknown doesn't count against a coin). New coins and coins on a curve are thin by nature, so only Danger keeps those out. A search, or **Show risky coins** (remembered in the browser, `arcdex:show-risky`), shows everything with its badge; a note says how many are hidden. The overview cards (Hot coins, Top gainers, Top volume) only pick coins that meet it.
- **The board (`components/CoinBoard.tsx`), on Arc's Markets and on Robinhood Chain's:** a ☰ List / ▦ Board switch (`arcdex:mk-view`).
  - **Columns:** New (newest first); Near bond (70%+ first, then the rest still bonding, closest first, with progress bars); Graduated (youngest first).
  - **Cards:** launchpad, age, 🔥 trades in 15 minutes, market cap, liquidity, holders (or wallets trading), 24h change and the badge.
  - **Phones:** one column at a time behind tabs.
- **The lists:**
  - **Arc's tabs:** All · New · Near bond · Graduated · Established · Trending · Top volume (New pair and New <15m are gone).
  - **Robinhood Chain's tabs:** All · Memecoins · Stocks · New · Bonding · Graduated · Established.
  - The Risk column is now Safety, sorted safest first. Curve coins show 🚀 and their progress.
- **Checked:**
  - In the browser (dev server against the live engine, which then had no `/v1/safety`, so market ratings): Arc's board (New 6, Near bond 29, Graduated 85), Robinhood's board, the tabs and the hidden-coins note. At 375px: column tabs and no sideways scroll.
  - `bun scripts/test-coin-board.ts`: stages, every rating rule, the standard.
  - `engine/test/boardSafety.test.ts`: what the site reads of a report; full scan vs sell test; two at a time, top of the page first; fresh reports not rescanned; untracked coins null.
  - The engine suite: 588 pass.
- **Every new string is in all six dictionaries** (44).
- **Not done yet:**
  - On-chain checks on Robinhood Chain (a sell test there needs the engine to read that chain).
  - Rug alerts to holders, and creator pages (suggested next).
  - The safety rating on coin pages, which still show their own risk score and Safety check panel.

## Fewer, truer coins: $15K and not rugged, OGs and duplicates, near bond by market cap (2026-10-04)

Owner: "stock coins don't show up; the platform shows our native coin as risky, remove it, only for our coin; if a coin has duplicates launched by the same creator, flag the duplicates and label the real one OG; near-bonding coins on Arc show only one, provide the correct data, you know the MC for bonding; coins that have rugged or are below $15K market cap on all chains, don't show them, except our native coin; no Robinhood button on the landing page, and the landing page shouldn't mention the chains: just the word ARCDEX", plus a list of sentences to remove.

- **Listed at all (`lib/safety.ts` `isListable`, `isRugged`, `LISTING.minMarketCapUsd` 15,000):** a coin is shown only with $15K or more of market cap and not rugged; $ARCDEX always.
  - **Rugged:** the scan's creator check failed (the creator sold most of their coins), down 90%+ in a day, or a pool (not a curve) drained under $500 of liquidity.
  - **Where:** Arc's Markets (list, board, overview cards), Robinhood Chain's Markets, the Swap page's picker and quick picks, the spot screen's pair list, and the landing's live markets. A search still finds every coin, so a coin can always be looked up by name or address.
  - This comes before the listing standard (Danger hidden, $2K liquidity and 20 holders for pool coins), which still applies on top.
  - **What it means for curves:** Argus coins open at about $2,500 (5.5% of their curve), so they appear once they reach $15K (about a third of the way).
- **$ARCDEX has no safety rating:** "Official" instead of a badge in the Markets list, cards, board and risk sort. Its coin page has no risk badge, Safety check panel or copycat banner (`ArgusTokenPage` `isCoin`).
- **OG and duplicates (`lib/dupes.ts` `markDupes`):** among listed coins with the same ticker (compared without `$`, case or punctuation), the earliest launched is the **OG**, and leads its group. The rest are **⚠ DUPLICATE**, or **⚠ DUPLICATE · SAME CREATOR** when the OG's creator launched it too. An unknown launch time can't make a coin the OG.
  - Creators come from the market list, or the engine's scan (`CoinSafety.creator`, new, from `boardView`).
  - Shown in Arc's and Robinhood's lists, cards and board. A group's toggle reads "+N duplicates".
  - On Robinhood Chain the creator isn't known, so duplicates there are never "same creator".
- **Near bond on Arc, by market cap (`engine/src/market/bonding.ts` `BondingBook`, `GET /v1/bonding?limit=`):**
  - **Why only one showed:** GeckoTerminal's list carries a few dozen Argus coins, and progress counted ticks. A coin at half its graduation cap read 90%+, a fresh one 0%.
  - **Now:** every 30s the engine reads every Argus launch it tracks (Portal 7 and 8, under 48h old, traded in the last 6h, 400 at most): its Portal record once, then its hook's `bonded()` and the pool's tick from v4's StateView, in batches of 25.
    - Progress is the share of the graduation market cap: 1.0001^-(ticks to go), since the price moves 0.01% a tick (`mcProgress`).
    - A coin past its bond tick, or whose hook says bonded, is graduated and dropped for good.
    - Each coin carries its market cap and the cap it graduates at (`BondingCoin` in `api/_marketProtocol.ts`).
  - **Measured on mainnet (2026-10-04):** every Argus coin graduates at about **$45,080** of market cap, the same across 177 coins on their curve (24 more had graduated). The busiest was ONEIRA at $14.7K, 32.6%.
  - **Near bond (70%) is about $31.5K.** Coins between $15K and that are listed as Bonding.
  - **The site:**
    - Terminal polls `/v1/bonding` every 30s. Its progress replaces the list's for coins the list has, and coins it lacks are added as rows (`bondingToArcToken`), subject to the same $15K rule.
    - `api/_argusBonded.ts` `progressOf` and the browser's fallback reader (`api/argus.ts` `mcProgress`) use the same formula.
- **Pons on Robinhood Chain (`api/rhmarket.ts` `ponsCurves`):** each Pons coin's own progress, Pons's measure: ETH raised over its graduation threshold (4.2 ETH for ETH-quoted launches).
  - **`pons-dot-family`:** Pons's active factory `0xa5aa…1feb` answers `graduationStatus(token)` with (current, threshold, graduated).
  - **`pons-v2`:** the pool GeckoTerminal lists is the curve itself (`realQuoteReserve()`, `graduationThreshold()`, `graduated()`, as SolonPad's on Arc).
  - **Reading:** batches of at most 24 calls, 2 a refresh (the public RPC answers 77 with 429). A curve is read again after 60s; a graduated one never.
  - **Rows:** they carry `curveProgress` and `graduated` (`RhCoin`). `rhStageInput` follows them: GeckoTerminal still lists graduated coins on the curve venues (DELTA, HMM and eight more did), and they were shown as Bonding.
  - **Checked on mainnet:** 39 Pons coins read; HOODNIGHT at 3.28 of 4.2 ETH (78%) was near bond.
- **Robinhood's stock tokens were missing** because the engine refreshed its Robinhood list only while someone was looking, and dropped pools not seen for an hour. After a quiet spell, stocks and whole launchpads aged out.
  - The engine now reads the list itself every 40s (`siteApi.ts`, two GeckoTerminal calls a step, a round of 17 in about 6 minutes), and keeps pools for 6 hours (`RH_KEEP_MS`).
  - The stock checks are one JSON-RPC batch (`stockChecks`), not 20 requests at once.
  - **Checked locally:** NVDA, AVGO, SPY, META, INTC, CRCL and four more are listed, beside Bankr, Clanker, Clank.trade, Virtuals and Pons.
- **The landing page names no chain:**
  - **Headline and hero:** the headline is just "ARCDEX" (`.ld-h1-name`). The hero pill reads "Multichain DEX · spot & futures".
  - **Removed:** the Robinhood links and button, the "Two chains. One exchange." section with its chain cards and the "Launchpad coins only" card, the "$ARCDEX contract on Arc · wallets show the symbol as ARCD" note, the burn section's subtitle and "Wallets show its symbol as ARCD."
  - **Kept:** live markets stand on their own (`.ld-mkts-solo`).
  - **$ARCDEX's contract (owner):** the hero shows the Arc CA (`COIN`), labelled, with Copy (`.ld-cas`). That label is the only place the landing names a chain.
    - From 2026-10-04 the Robinhood CA `0xdf12A26048Be60079b5486Ae63Cbde713DbEc265` (ARCDEX / ARCD on Robinhood Chain) sat under it.
    - The owner had it removed on 2026-10-05, along with `COIN_RH`.
  - **Reworded:** the tiles, futures text, FAQ, page title and link previews (`index.html`) without chain names. The live feed says "Connecting…".
- **Bridge:** the "Why bridge with ARCDEX" panel is gone. **Swap:** the "Trades go through ARCDEX's swap router…" line is gone.
- **Tests:**
  - `engine/test/bonding.test.ts`: the formula both ways; which coins it follows; a graduated coin dropped and its record read once; a dropped read asked again.
  - `scripts/test-coin-board.ts`: the $15K and rugged rules, OG and duplicates, Pons stages and reads.
  - `scripts/test-robinhood.ts`: its stand-in RPC now answers batches.
  - The engine suite: 592 pass.
- **Every new string is in all six dictionaries** (24).

## Solana: every launchpad's coins, bought with SOL, Solana USDC or USDC on Arc (2026-10-04)

Owner: "time to bring Solana to the platform". Asked, the owner chose: the trading wallet gets its own Solana address, and Phantom (or Solflare, Backpack) can be connected too; every Solana launchpad is listed; the 2% fee goes to a Solana address the owner would give. Then Relay turned out to pay app fees in USDC to an EVM address, so the fee goes to the existing fee wallet `0x2742…86Bb` and no Solana address is needed (the owner can still give one if wanted).

- **How a trade works (`lib/relayQuote.ts` checks, `lib/relay.ts` sends, `components/SolanaTrade.tsx`): Relay** (api.relay.link). Across bridges USDC to Solana but can't swap there ("Destination swaps are not supported yet for routes involving Solana"). LI.FI routes every Arc → Solana coin through a second signature on Solana.
  - **Buy:** one signature on Arc. An approval of exactly the amount to Relay's depository `0x4cd0…bc31`, then its `depositErc20(depositor, token, amount, id)`. Relay's solver delivers the coin to the buyer's Solana address in about a second and pays Solana's fees, the new token account included: **no SOL needed to buy**. Refunds come back as USDC on Arc.
  - **Sell:** one signature on Solana, by the wallet holding the coin. Relay returns instructions and lookup tables; the page builds a v0 transaction (`@solana/web3.js`, loaded only for a sale) with a fresh blockhash, Solana's node simulates it (it must succeed and cost the seller at most 0.01 SOL), then the trading wallet's Solana key or the wallet app signs it. About 0.000005 SOL in fees; USDC lands on Arc.
  - **SOL for selling:** "Add $0.50 of SOL" (Arc USDC → native SOL through Relay, no fee, about 0.004 SOL: hundreds of sales); offered as a tick box on a first buy.
  - **Fee:** Relay's app fee, 2% (the swap router's `feeBps`) of what goes in, for `0x2742…86Bb`. **Relay doesn't pay app fees out in the trade**: they accrue at Relay as a USDC balance, claimed with a signature from the fee wallet (relay.link, or its `/app-fees/{address}/claim` API). The owner claims them.
  - **The checks (a quote is refused unless it's exactly the trade asked for):**
    - buys: the buyer and Solana address, the coin, the amount, the approval exactly the amount to Relay's depository, the deposit's depositor/token/amount word by word, no native value, only an approval and a deposit, and a 2% fee in Arc USDC;
    - sales: the seller and the Arc address paid, the coin and amount, paid in Arc USDC, only programs a sale uses (`SOL_PROGRAMS`: token accounts, DFlow, Jupiter, Relay's depository `DPArt…`, memo, compute budget, system, token programs), the seller as the only signer, a deposit with Relay, and Relay's memo naming the quote;
    - both: the price guard as on Robinhood Chain (`relayValue`, `quoteVerdict`: over 25% better than the market refused, 50%+ price impact refused, 15%+ a tick box), a fresh quote before signing that mustn't deliver 3% less or 25% more, and a minimum received.
  - Some coins have no Relay route (seen: one with a transfer hook, one thin coin): the form says so.
- **Wallets (`lib/solanaWallet.ts`):**
  - **The trading wallet's Solana key** is derived from its own private key in `embeddedWallet.ts` (`solanaSeed`: HKDF-SHA256, salt "arcdex", info "arcdex:solana:ed25519:v1"). Nothing new is stored, the one backup restores both, and it exists only while the wallet is unlocked. Its address shows in the trading wallet panel.
  - **Wallet apps:** Phantom, Solflare or Backpack's injected providers; the one picked is reconnected silently if it already trusts the site.
  - The trade forms and the wallet bar share which Solana wallet trades (`pickSolSigner`).
  - **The passcode rule holds:** a buy or SOL top-up the trading wallet pays for but delivers to a Solana wallet app (not its own Solana address) asks for the passcode (`useWithdrawGuard` in `SolanaTrade`), so someone with the unlocked browser can't connect their own wallet app and buy into it. Delivered to the trading wallet's own Solana address, it's one tap. Sales always pay the trader's own Arc address (the quote check).
- **The list (`api/_solCore.ts`, engine route `api/solmarket.ts` at `/api/solmarket`, as Robinhood Chain's):**
  - **Launchpads (`SOL_LAUNCHPADS`, GeckoTerminal's Solana venues):** pump.fun and PumpSwap, Raydium LaunchLab, LetsBonk, Meteora DBC, Moonshot, Moonit, Boop, daos.fun, Bags, Heaven, Wavebreak, Token Mill, Virtuals, Clanker, Printr, Stonk.fun, EasyA Kickstart. Launchpad coins only.
  - Read two GeckoTerminal calls at a time whenever the stored copy (`arcdex_kv` `sol:market`) is over 40s old; the engine asks every 40s itself (`siteApi.ts`). A pool not seen for 6 hours drops out.
  - **From the chain:**
    - **curves**, read from each coin's launchpad pool account and decoded by the program that owns it (GeckoTerminal's pool address is that account): pump.fun's bonding curve (tokens sold of the 793.1M for sale; `complete`), LaunchLab's pool (SOL raised over its 85 SOL target; LetsBonk uses it too), Meteora DBC's pool and its config's migration threshold (Moonshot and Bags use it). Re-read after a minute while on the curve, never once graduated. GeckoTerminal lists graduated pump.fun coins on pump.fun's venue for good, so this decides Bonding vs Graduated. Boop's and other curves aren't read: Bonding, no percentage.
    - **mints** (`decodeMint`), read once: mint and freeze authorities, and Token-2022 extensions (permanent delegate, pausable, non-transferable, frozen by default: danger; transfer hook, transfer fee, close authority: risky).
  - **RPCs:** Solana's own (`api.mainnet-beta.solana.com`, 100 accounts a call) for the engine; publicnode for browsers (Solana's own refuses browser origins; publicnode takes at most 10 accounts a call, `batchFor`).
  - Without the engine, the browser reads the first five launchpad calls itself, then the curves and mints.
- **Ratings and stages:** `solSafety` (`lib/safety.ts`): freeze or mint authority and the danger extensions are Danger (and can't be bought), the risky ones Risky, wash trading Danger (also millions of volume through a pool with no liquidity, `isWashSol`), else the market data. `solStage` (`lib/coinStage.ts`) follows the chain's curve read. The $15K / not-rugged rule and the listing standard apply as on the other chains.
- **Pages:** `/solana` (`pages/SolanaMarkets.tsx`: Near bond, Hot coins and Top gainers cards; All · New · Near bond · Bonding · Graduated · Established; a launchpad filter; sort by bonding progress; list or board; OG and duplicates), `/solana/token/<mint>?pool=` (`pages/SolanaTokenPage.tsx`: the curve's progress bar, the mint's rating, trades from GeckoTerminal every 4s so new ones pop, the chart, buy and sell side by side, pools), Portfolio's "On Solana" (`components/SolanaHoldings.tsx`: both Solana wallets' coins, valued, with Sell to USDC, and their SOL). Reached from the chain switch (Arc · Robinhood · Solana), More, the drawer and the phone's Markets tabs.
- **Checked:**
  - On mainnet, nothing sent (`bun scripts/check-solana-sale.ts`): a Relay sale quote for a wallet holding BONK passed the checks, built (858 bytes) and simulated on Solana (0.000005 SOL in fees); a $5 buy quote passed with a $0.10 fee.
  - Curves and mints decoded on mainnet: a graduated pump.fun coin, LaunchLab 5.47%, Meteora DBC 8.3%, PYUSD's permanent delegate and transfer fee, USDC's authorities. A local build of the list: 100 coins in six GeckoTerminal calls, 66 on their curve, SWARM 91.5% and ALON 75.7% near bond.
  - In the browser (local dev, the browser's own build): the markets, the near-bond card, a coin page with its curve bar and Safe rating, a $5 quote (127K SWARM ≈ $4.65, Relay $0.29, total cost 7.1%), and a throwaway trading wallet's Solana address matching web3.js's from the same seed (deleted after).
  - `bun scripts/test-solana.ts`: parsing and launchpads, curves and mints from real accounts, real Relay quotes passing and 18 tampered ones refused, the price guard, stages, ratings and routes. Engine suite 592 pass.
- **Every new string is in all six dictionaries** (64).
- **Pay with SOL or Solana USDC (2026-10-05, owner: "users with Solana wallets can not buy the coins, make Solana trades work").** Buying needed USDC on Arc, so a Phantom-only visitor couldn't buy. The form now has **Pay with** / **Receive**: USDC on Arc, SOL, or USDC (Solana).
  - **SOL and Solana USDC are a swap on Solana alone** (Relay's same-chain swap, `side: 'swap'`, `chain: 'solana'`): one transaction signed by the Solana wallet (Phantom/Solflare/Backpack, or the trading wallet's own Solana key). No Arc wallet and no bridge. The coin, or the SOL/USDC from a sale, lands in the same wallet in seconds. ARCDEX's 2% is Relay's app fee, taken in the currency going in or out (SOL or USDC); it accrues at Relay for the fee wallet `0x2742…86Bb` as before.
  - A Solana wallet app opens on SOL; the trading wallet (or no wallet) on USDC on Arc. Without a wallet, a buy is quoted for a placeholder address (never sent to) so the price shows before connecting.
  - **Checks for a swap (`checkSolSteps`):** one `swap` step; only known programs; the trader as the only signer; system transfers only to the trader or Relay's solvers (`RELAY_SOL_SOLVERS`), at most 5% of the SOL going in (or 0.01 SOL); the memo naming the quote; from and to the trader's own wallet, the coin and amount asked for, a minimum received. Before signing, the transaction is simulated and may cost the trader no more SOL than it puts in plus 0.01.
  - **Price guard in dollars (`relayValueUsd`):** SOL at GeckoTerminal's wSOL price (asked again every 30s until it answers), else Relay's own dollar value for the SOL side. The coin is always valued at its market price, so a trap route is still caught.
  - Tests: `scripts/test-solana.ts` adds a real swap quote (`fixtures/relay-solswap.json`) and 9 tampered ones refused.
  - **Checked in the browser:** with no wallet connected, 0.05 SOL quoted 2.3K PEXRA at under 0.1% impact, 2% in all. One coin (Human) has no Relay route at any address: the form says so.
- **Interrupted builds:** when GeckoTerminal throttles the browser's own list build, the coins the last list had that it didn't reach are kept (as Robinhood Chain's builder does), instead of the list shrinking to the first call's coins.
- **Not done yet:** a real funded trade (the owner's first), holders. Live trades from the chain and search came on 2026-10-05 ("Live trades, search and fees on every chain").

## BNB Chain: four.meme's coins, curve and graduated (2026-10-05)

Owner: "go for BNB Chain". four.meme is BNB Chain's launchpad; its coins are listed, rated and traded like Solana's, at the trader's same EVM address (the trading wallet signs there with its own key; gas is BNB).

- **four.meme (checked on mainnet 2026-10-05):** TokenManager2 `0x5c95…762b` trades every coin on its curve; TokenManagerHelper3 `0xf251…e034` answers `getTokenInfo(token)` (version 0 for a coin four.meme didn't launch, else its quote, BNB or USDT, tokens left for sale, and whether liquidity was added: graduated) and quotes trades (`tryBuy`, `trySell`).
  - Coin addresses end in `4444` (standard coins) or `ffff` (seen on its curve venue); `isFourAddress` takes both, and the contract must still vouch.
  - Progress is tokens sold of the 800M for sale (`fourProgress`). At the end of the curve the coin graduates to PancakeSwap (XCS went from 84.7% to graduated in minutes while this was being checked).
  - **four.meme refuses a sale in the block the tokens were bought in** (revert "GW"): a buy can't be flipped at once.
- **The list (`api/_bscCore.ts`, engine route `api/bscmarket.ts` at `/api/bscmarket`, as Solana's):** GeckoTerminal's `four-meme` venue (the curves) and PancakeSwap's v2, v3 and Infinity pools (the graduates: only four.meme addresses are kept), and new pools, two calls at a time whenever the stored copy (`arcdex_kv` `bsc:market`) is over 40s old; the engine asks every 40s itself. four.meme's `getTokenInfo` is read for every coin (150 a multicall, BNB Chain's own RPC then publicnode): coins it disowns are dropped, curve coins are re-read after a minute, graduates never. Without the engine, the browser reads five calls and asks four.meme itself.
  - **WBNB is `0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c`.** A first draft had two characters wrong, which GeckoTerminal answered with no price; checked against PancakeSwap's WBNB/USDT pair's `token1`.
- **Trading (`components/BscTrade.tsx`):**
  - **Graduated coins, through Relay** (`lib/relayQuote.ts` `chain: 'bsc'`, `lib/relay.ts` `runRelayEvm`). Pay with or receive **USDC on Arc** (one signature on Arc, the coin lands on BNB Chain in ~2s; a sale is signed on BNB Chain and the USDC lands on Arc), **BNB** or **USDT** (a swap on BNB Chain). ARCDEX's 2% is Relay's app fee.
    - Checks: the trader as sender and recipient, the coin, currencies and amount; on Arc, the depository deposit word by word; on BNB Chain, native BNB only to Relay's router `0xb92f…ff4f` with exactly the amount, an ERC-20 only through its approval proxy `0xccc8…15be` after an approval of exactly the amount to it, the calldata naming the trader, no native value otherwise; a fee on every trade but the BNB top-up.
    - The price guard in dollars: BNB from PancakeSwap's WBNB/USDT pair `0x16b9…0dae` read on-chain (GeckoTerminal as fallback), else Relay's own value for the BNB side; the coin at its market price.
    - A contract wallet can't buy with Arc USDC (it may not exist at the same address on BNB Chain).
  - **Coins on their curve, on four.meme's own contract** (`lib/fourMeme.ts`), with the coin's quote (BNB, or USDT for a USDT coin). **ARCDEX takes no fee there** (no router; a fee in a second transaction wouldn't be atomic); four.meme's own ~1% is shown.
    - Buy: `tryBuy` quotes it; a USDT coin's USDT is approved exactly (`amountApproval`); `buyTokenAMAP(token, funds, minAmount)` with `amountMsgValue` as value. Sale: the tokens approved exactly to TokenManager2, then `sellToken(token, amount, minFunds)`. 5% slippage; the minimum comes from the quote shown, and a fresh quote that's worse refuses the trade. Each call is simulated from the trader before it's signed. A coin the helper names another manager for (four.meme's V1) isn't traded.
  - **Gas:** "+$0.50 BNB" (Arc USDC → BNB at the same address through Relay, no fee) when a trade signed on BNB Chain needs gas; $5–$25 options to fund a BNB buy from Arc USDC.
  - No passcode is asked: everything lands at the trading wallet's own address (bridging to itself), as the rule allows.
- **Ratings and stages:** `bscSafety` (wash trading Danger; vouched for by four.meme with a low market risk Safe; else the market data), `bscStage` (four.meme's word; before it answers, its curve venue means Bonding). The $15K / not-rugged rule and the listing standard apply.
- **Pages:** `/bnb` (also `/bsc`; `pages/BscMarkets.tsx`), `/bnb/token/<address>?pool=` (`pages/BscTokenPage.tsx`: the curve bar, trades every 4s, chart, buy and sell side by side, pools), Portfolio's "On BNB Chain" (`components/BscHoldings.tsx`: coins bought from this browser and the market list, one multicall, with Sell, and the BNB). Reached from the chain switch (Arc · Robinhood · Solana · BNB), More, the drawer and the phone's Markets tabs. The "Switch to Arc" bar is hidden there.
- **Engine:** `engine/Dockerfile` copies `api/_bscCore.ts` and `api/bscmarket.ts`, and `railway.toml` watches them. Add both to the service's own Watch Paths on Railway, or an edit to them alone won't redeploy the engine.
- **Tests:**
  - `bun scripts/test-bsc.ts` (offline): rows and four.meme's vouching, progress, the engine's rows, stages and ratings. Also real Relay quotes for every route (`fixtures/relay-bsc.json`, recorded by `bun scripts/capture-relay-bsc.ts`, quotes only) passing and 21 tampered ones refused, four.meme's calls byte for byte, and routes.
  - `bun scripts/sim-four.ts` (mainnet, nothing sent): a 0.01 BNB buy of a live curve coin from a throwaway address with the exact call; the same-block sale refused; a real holder's sale of half its tokens after an exact approval; each refused with a minimum of twice the quote.
- **Checked in the browser (local dev, the browser's own list build):** the markets with real curve progress (78–90% near bond); 龙虾 (graduated) quoted $5 of Arc USDC → 113.4 (0.4% impact, 4.4% all in) and 0.01 BNB → 184.7 (under 0.1%, 2.0%); a curve coin quoted 0.01 BNB → 996.4K with four.meme's fee and 0% ARCDEX; 375px with no sideways scroll.
- **Every new string is in all six dictionaries** (63 with the Solana ones).
- **Not done yet:** a real funded trade (the owner's first), holders. Live trades from the chain and search came the same day ("Live trades, search and fees on every chain").

## Live trades, search and fees on every chain (2026-10-05)

Owner: "what else is missing", then "do it" to the top three: Solana and BNB Chain coin pages as live as Arc's, search across every chain, and the 30/70 fee ledger counting every chain's fees.

- **Live trades from the chain (`lib/useChainTrades.ts`):** one hook for the Solana and BNB Chain coin pages, after Robinhood Chain's page.
  - The chain's swaps come first. They set the price, the chart's live end (`ticks`) and the pops, and add a 15s timeframe (`solChartSource` / `bscChartSource` with `fromChain`).
  - GeckoTerminal fills in older trades and makers: every 60s while the chain feeds the page, every 4s (as before) when it can't.
  - A quote with no dollar price is priced once from GeckoTerminal's coin price.
- **BNB Chain (`api/bscSwaps.ts`):**
  - **What's read:**
    - A coin on four.meme's curve: TokenManager2's `TokenPurchase` / `TokenSale` events. These aren't indexed by coin, so every four.meme trade is read (a few a block) and the coin's own are kept. Each names its trader.
    - PancakeSwap v2: `Swap` on the pair.
    - PancakeSwap v3: its `Swap`, Uniswap v3's plus two protocol-fee words.
    - Infinity pools stay on GeckoTerminal.
  - **How:** history in 4,000-block slices, newest first; then a `getLogs` every second while the tab is visible. Makers of PancakeSwap swaps are the transaction's sender, 20 to a batch request.
  - **RPC (publicnode, measured):**
    - Blocks every 0.45s; logs carry `blockTimestamp`; batches accepted.
    - A `getLogs` may span 5,000 blocks; only the last ~2 hours are served without a key.
  - **Measured:** a live PancakeSwap pair over 25s gave 21 swaps, a median 1.6s after their block (block times are whole seconds). The chain read two swaps GeckoTerminal didn't have yet.
- **Solana (`api/solSwaps.ts`):**
  - **What's read:** the pool account's newest transactions (`getSignaturesForAddress`, "confirmed"), each read once (`getTransaction`, jsonParsed). The trader is the signer.
  - **A transaction becomes a trade** from the pool's side: the coin and quote held by accounts the pool owns (pump.fun's curve and PumpSwap pools), plus the curve's own lamports. That's exact whoever routed it.
    - Otherwise (LaunchLab, Meteora, Raydium keep vaults under an authority), from the signer's side, with the transaction fee and token-account rent set aside.
    - A transaction moving no coin for either (bots' arbitrage legs, liquidity) isn't a trade.
  - **RPC (publicnode):**
    - A batch request may hold only one `getTransaction`, so they go four at a time in parallel, the newest six a poll (every 1.5s).
    - A busy pool's oldest unread ones are left to GeckoTerminal.
  - **Measured:** 8 trades in 25s on HIGGS, a median 2.7s after they landed.
  - Pools quoted in SOL or USDC only.
- **Search across every chain:**
  - **The engine route (`api/chainsearch.ts`, `/api/chainsearch?q=`):** searches the lists the engine keeps for Robinhood Chain, Solana and BNB Chain (`rh:market`, `sol:market`, `bsc:market`, read at most every 20s), with no GeckoTerminal call.
    - Listed coins only, ranked as the Launchpad ranks: exact ticker or address, then prefixes, then contains; bigger coins first.
  - **The finder (`lib/coinFinder.ts`):** adds those hits, tagged with their chain and kept apart by chain and address.
  - **The top bar (`SearchBox.tsx`):**
    - Shows each chain's mark and opens the right coin page.
    - A pasted Solana address offers "Open on Solana".
  - Engine: `engine/Dockerfile` copies `api/chainsearch.ts`, and `railway.toml` watches it. **Add it to the service's own Watch Paths on Railway too.**
- **The fee ledger (`engine/src/coin/program.ts`) counts every chain's fees:**
  - **Robinhood Chain sales:** their 2% arrives as USDC on Arc from Across's handler `0xa074…547b` in the relayer's fill. It's now a fee source.
  - **Solana and BNB Chain trades (Relay):**
    - Relay keeps the 2% for the fee wallet until it's claimed. Every two minutes the ledger reads Relay's balance for the fee wallet (`api.relay.link/app-fees/{wallet}/balances`).
    - What each currency's balance grew by is a fee, at Relay's dollar value; a drop is a claim. Price moves alone add nothing.
    - These fee entries carry `via: 'relay'` and no transaction.
    - `GET /v1/coin/program` adds `relay` (accrued, still to claim). The claim's arrival on Arc isn't counted again, since it comes from Relay's solver.
  - `/burn` shows what's held at Relay. With the fee wallet connected, it shows a "Claim at relay.link" step.
  - **Not counted yet:** a Robinhood Chain buy's fee, which arrives as the coin on Robinhood Chain.
- **Tests:**
  - `scripts/test-bsc.ts`: real four.meme and PancakeSwap logs (`fixtures/bsc-swaps.json`, recorded by `scripts/capture-bsc-swaps.ts`).
  - `scripts/test-solana.ts`: real PumpSwap and pump.fun transactions (`fixtures/sol-swaps.json`, recorded by `scripts/capture-sol-swaps.ts`).
  - `scripts/test-search.ts`: ranking, Solana addresses in any case, and how often the lists are read.
  - `engine/test/coinProgram.test.ts`: the Across handler, Relay accruals, claims and price moves, and the two-minute read.
- **Checked in the browser:**
  - A BNB Chain page on the chain feed: trades seconds old, real traders and the 15s timeframe.
  - A Solana page on the chain feed with GeckoTerminal's older trades underneath.
- **Every new string is in all six dictionaries** (10).

## Solana wallets trade every chain: SOL or Solana USDC in, any chain's coin out (2026-10-05)

Owner: "make it also a Solana [exchange]: people buy other chains' coins using SOL and USDC on Solana, to attract Solana meme users; Solana wallets connect, transact, swap and bridge". Asked where a Phantom user's coins on Arc, BNB Chain and Robinhood Chain are held, the owner chose **an account from the Solana wallet** (no passcode, the same account on every device).

- **The account (`lib/solAccount.ts`):** a Solana wallet can't sign on an EVM chain, so its coins there are held by an EVM account of its own.
  - **The key:** the wallet signs one fixed message (`solAccountMessage`: it names the site, the wallet and says the signature is the key). The signature is checked against the wallet's own key (ed25519), then HKDF-SHA256 (salt "arcdex", info "arcdex:solana-account:secp256k1:v1") turns it into the account's key.
  - Ed25519 signatures are deterministic, so the same wallet always opens the same account, on any device. Nothing is stored but the open account in this tab (sessionStorage `arcdex:sol-account`, cleared with the tab).
  - **In the app:** it takes the trading wallet's unlocked slot (`openAccountKey`, `accountOwner` in `embeddedWallet.ts`), so every EVM trade form, Portfolio and the trading-wallet signers work with it. It has no Solana address of its own (the wallet itself trades there), and no export, passcode or passkey.
  - **It closes** on Sign out, when the Solana wallet disconnects, or when that wallet switches to another account (`solanaWallet.ts`). Connecting another wallet closes one opened for a different wallet.
  - **Sending money out:** to the Solana wallet it comes from, straight through. Anywhere else, the wallet signs a confirmation, checked against its key (`WithdrawGuard` `viaSolana`), where a trading wallet asks for its passcode.
- **The trades (`lib/relayQuote.ts` `xin` / `xout`, `lib/relay.ts`, `components/SolanaCross.tsx`):** Relay, as for Solana coins.
  - **Buy (`xin`):** SOL or USDC on Solana → the coin on Arc, BNB Chain or Robinhood Chain, delivered to the account in ~2s. One signature in the Solana wallet; Relay's v2 depository `99vQ…JSrN2`.
  - **Gas on a first buy:** when the account has none on that chain (under 0.2 USDC on Arc, 0.0003 BNB, 0.00005 ETH), $0.50 of the chain's gas is added (`topupGas`), so the coin can be sold. Relay puts it inside its fee; the form and the price guard count it as delivered, not lost.
  - **Sell (`xout`):** the coin → SOL or USDC in the Solana wallet. Signed by the account on its chain (one tap), through Relay's approval proxy after an approval of exactly the amount.
  - **Deposit and withdraw:** SOL or Solana USDC → USDC on Arc, and back. Arc's USDC goes through Relay's depository on Arc.
  - **Fees:** ARCDEX's fee is Relay's app fee for `0x2742…86Bb`: 2% on trades, 0.5% on deposits and withdrawals (the bridge's). It accrues at Relay with the other Relay fees; the owner claims it (`/burn` shows it).
  - **Routes (checked 2026-10-05):** SOL to $ARCDEX, to BNB Chain coins and to Robinhood Chain's memecoins. Robinhood's stock tokens have no route, so their pages don't offer it.
- **The checks (a quote is refused unless it's exactly the trade asked for):**
  - **Both ways:** only SOL or Solana USDC on the Solana side; only Arc, BNB Chain or Robinhood Chain on the other; ARCDEX's fee present; no gas top-up that wasn't asked for, and none over 1.5× what was.
  - **Solana side (`xin`):**
    - a single v2 deposit whose amount is the amount asked for, and whose order id is Relay's order;
    - the order pays only the account, in the coin asked for, with no calls, and refunds only to the buyer;
    - only known programs, the buyer as the only signer, simulated before signing.
  - **EVM side (`xout`):** the trader as sender, an approval of exactly the amount to Relay's approval proxy (or depository, for Arc USDC), no native value, and Relay's order paying only the Solana wallet.
  - **The price guard:** in dollars, as for Solana coins (`relayValueUsd`): SOL at GeckoTerminal's price, the coin at its market price. Over 25% better than the market or 50%+ price impact is refused; 15%+ takes a tick box.
- **Where:**
  - **Connect Wallet:** an EVM group, a **Solana** group (Phantom, Solflare, Backpack; on a phone without one, "Open in Phantom" opens the page in Phantom's browser) and the trading wallet. With no EVM wallet in use, connecting signs once and opens the account.
  - **Coin pages:** "◎ Pay with SOL or USDC on Solana" under the buy and sell forms (`SolanaPayCard`), on desktop and in the phone's trade sheet, on Arc, BNB Chain and Robinhood Chain coin pages and the Swap page. It opens by itself when a Solana wallet is in use.
  - **Deposit:** "From your Solana wallet" (the default for a Solana account). **Withdraw:** "To an Arc address" or "◎ To a Solana wallet".
  - **Bridge:** Solana is a source too (SOL or USDC in, through Relay). Arc → Solana offers "USDC · Circle CCTP" or "SOL or USDC · Relay".
  - **Account:** the menu reads "◎ Solana account" with Sign out. The trading-wallet panel shows the account card: its Solana wallet, its EVM address, its USDC on Arc, Deposit, Withdraw and Portfolio.
- **Tests:** `bun scripts/test-xsol.ts` (offline, on real quotes recorded by `scripts/capture-relay-xsol.ts`, nothing sent):
  - requests built as recorded, and 11 real quotes passing;
  - 22 tampered ones refused, plus a wrong chain and a wrong currency;
  - the gas top-up inside Relay's fee, and the price guard;
  - the account key: the same signature always gives the same key.
- **Checked in the browser** (local dev, a throwaway in-page Solana wallet; nothing signed on any chain):
  - Connect → account opened. The menu, the account card, Deposit (from Solana, $10 of Solana USDC → $9.93 on Arc, 0.7% in all), Withdraw (to a Solana wallet) and the Bridge both ways.
  - Quotes: 0.1 SOL → 2.02M $ARCDEX (4.3% impact on its thin pool, 7.1% in all), 0.05 SOL → 123 龙虾 on BNB Chain (4.8%), 0.05 SOL → 47 AI on Robinhood Chain (4.0%), and 40 AI → 0.0365 SOL (2.5%).
  - At 375px the card fits the trade sheet with no sideways scroll.
- **Every new string is in all six dictionaries** (45).
- **Not done yet:** a real funded trade from a real Phantom (the owner's first).

## DexScreener comparison: why there are no users, and what was fixed (2026-10-05)

Owner: "we have no users; compare us with DexScreener on platform quality and how a user would feel switching; fix the shortcomings; top notch". Both sites were toured side by side in Chrome as a first-time visitor: DexScreener's screener, its Arc page, a coin page, New Pairs, Gainers and Multicharts, then ours.

- **What a visitor from DexScreener found:**
  - **Coverage.** DexScreener already lists Arc and Robinhood Chain, so our data alone isn't unique.
    - Arc's most-traded coins weren't listed or searchable here: TOLLY (#1 there, $2.1M), ARCMAN ($19.9M), COOL, LONG, KAIRO, FAZE, AF, ASTOCK.
    - They trade on plain Uniswap pools. The market list read only launchpad venues, and the launchpad-only rule dropped them.
    - Searching "tolly" offered only $2.5K copycats.
  - **Wrong numbers.** ARGUS showed −31.5% over 24h where DexScreener showed −4.4%.
  - **Speed.**
    - Markets took 5.6s to first show anything; a coin page took ~9s against DexScreener's ~2s.
    - Coin logos from IPFS took 35–50s, so most never appeared.
  - **First impression.**
    - The home page opened on a $5.25K coin down 65% with $176 of volume.
    - "Live markets" held one coin: the engine's activity feed carries no details for most coins, so every other row was dropped.
    - "Fees collected $0".
  - **No reach.** Every coin page had the same title and link preview, so Google and shared links showed nothing about the coin.
- **Fixed:**
  - **Arc coverage (`api/_argusCore.ts`, `api/_launchpads.ts`).** The market list also reads Arc's top pools on every DEX (`/networks/arc/pools`, `/trending_pools`).
    - **Established coins** (`isEstablishedCoin`, `ESTABLISHED`) are listed beside launchpad coins: $25K+ liquidity, 3+ days old, $100K+ market cap, 25+ trades in 24h. Stablecoins never count.
    - This relaxes the owner's launchpad-only rule of 2026-10-04 for proven coins only. The safety rating still keeps Danger out of the default lists.
    - Applied in the Terminal, search (a search hit needs the depth and cap; its age isn't known), Swap, the spot pair list and the home page.
    - A launchpad coin keeps its badge when its deepest pool is a plain DEX's (`dedupe`).
  - **24h change (`engine/src/market/tokenState.ts`).** Each minute's close now remembers its pool, and changes compare the main pool with itself.
    - The bug: when a coin's main pool changed, closes from the old one stayed in the ring.
    - Slots saved before the change aren't compared (null for up to 24h after the deploy, rather than wrong).
  - **Speed.**
    - **Logos** go through wsrv.nl (`lib/logo.ts` `logoSrc` / `useLogo`), a free Cloudflare image cache, resized to twice their drawn size. IPFS goes through dweb.link first; the original link is the fallback.
    - **Fonts** no longer block scripts (`index.html`: preload + `media="print"` swap). They had held every script back ~1.7s.
    - **Page code** loads alongside the app shell (`src/main.tsx` route prefetch) instead of six files in a row.
    - **Duplicate requests:** same-path GETs through `siteFetch` share one request (in flight and for 1.5s).
  - **Home page (`landing/Landing.tsx`), market first.**
    - Hero: "Find any coin, see whether it's safe, and buy it in one tap", with live counts (coins live, 24h volume, trades).
    - The Arc CA and Buy $ARCDEX stay in the hero, beside a **Trending now** card: the busiest coins on every chain, with a small chain mark.
    - Then Top gainers / New listing / Futures, then **More than a screener** (one-tap buys, safety ratings, pay from any wallet, rugs filtered).
    - $ARCDEX's live card sits in the burn section. The traffic counter moved to the footer.
    - Data: the engine's `/api/trending` (`api/trending.ts`): the markets' rules on all four chains' stored lists, the busiest first, and each chain's totals.
  - **Coin pages in search and link previews.**
    - `netlify/edge-functions/coin-meta.ts` writes each coin page's title ("ARGUS $13.02M | Argus · ARGUS / USDC on Arc | ARCDEX"), description, logo, canonical link and Twitter card into the page before it leaves Netlify.
    - Paths: `/token`, `/solana/token`, `/bnb/token`, `/robinhood/token` and `/spot`.
    - The data comes from the engine's `/api/coinmeta` (`api/coinmeta.ts`, 1.5s at most). Without an answer, the page goes out unchanged.
    - Also `/sitemap.xml` (`sitemap.ts`, every listed coin, cached an hour) and `public/robots.txt`.
  - **Markets** shows its 24h totals beside the live badge (desktop).
- **Engine:** `engine/Dockerfile` copies `api/trending.ts` and `api/coinmeta.ts`, and `railway.toml` watches them. **Add both to the service's own Watch Paths on Railway.**
- **Not changed, for the owner (switching costs a screener user feels):**
  - **The 2% fee** is about twice what trading terminals charge (around 1%); Uniswap direct is only the pool's fee. The roadmap's Phase 1 already plans `setFeeBps(100)` on the swap router (owner key).
  - **The name:** the domain is arcsense.site and the brand ARCDEX. arcdex.online now points at Netlify, so making it the primary domain (Netlify → Domain management) would match.
  - **Phone wallets:** no WalletConnect project id (cloud.reown.com), so phone wallets can't connect by QR code.
  - **Card deposits** aren't live (Circle key).
  - **Distribution:** listing in Arc's ecosystem directories, DefiLlama and on X/Telegram, where DexScreener's traffic comes from.
- **DexScreener features still missing here:**
  - multicharts;
  - community sentiment votes (🚀🔥💩🚩);
  - liquidity providers and bubble maps;
  - paid boosts and ads (DexScreener's revenue);
  - a public API;
  - a native mobile app (ARCDEX installs as a web app).
- **Tests:**
  - `bun scripts/test-dex-parity.ts`: established coins, badges kept through the pool merge, trending rules and totals, each coin page's head (escaping included), sitemap paths and logo links.
  - `engine/test/market.test.ts`: the ARGUS case, across a restart and with slots saved the old way.

## ARCSENSE: spot and futures first (2026-10-03)

Owner: "hide the autotrade marketplace and let the users see only COMING SOON; hide the launchpad; put futures and spot trading as our main features; rebrand the app to be the first on Arc".
- **Navigation:** the top bar is Spot (the terminal) · Futures (SOON) · Swap · Bridge · Portfolio, then Feed, Leaderboard, Clans, Rewards; phones have Spot · Futures · Swap · Portfolio · More. Autotrade is in the drawer and More, marked by its own page.
- **Futures (`pages/FuturesPage.tsx`, `/futures`):** live on Arc testnet since 2026-10-03; see "ARCSENSE futures on Arc testnet" below. Before that (same day), a preview screen priced from Binance's public data, replaced because Binance's data terms (CC BY-NC-SA) don't allow commercial use.
  - **List your coin:** a form (project, token address, website or X, contact, notes) sent from the signed-in wallet as a support ticket (`arcdex_support_tickets`, category `other`, message starting "Coin listing request").
- **Autotrade (`pages/AutotradeSoon.tsx`, `/autotrade`, `/bots`):** "coming soon" only. A signed-in owner with bots gets "Manage and withdraw" to `/autotrade/manage`: the Autotrade page in an owners-only mode (`SignalsPage` `manage`: My bots, no marketplace, scanner or signals), so money in bot wallets is never out of reach.
- **Launchpad hidden:** out of every menu and the landing page; `/launchpad` shows the spot terminal; Rewards' "Creator rewards" tab is hidden (creators' share is still paid on-chain on every trade).
- **$SENSE on the landing (owner, 2026-10-03):** the contract address `0x91402b32C4Ab7915132b8B24e0d084E0428667ED` (on-chain: ARCSENSE / SENSE, 1B supply, an Argus launch; pool `0x8793…e047`) in the hero with a Copy button (full address on wide screens, shortened under 560px) and "Buy $SENSE" to its coin page.
- **Positioning:** "Spot and futures exchange on Arc" (landing, page titles, link previews, the app manifest, the wallet-connect description). Until 2026-10-04 it said "the first spot and futures trading platform on Arc"; the owner dropped "first" ("just an exchange").

## $SENSE buyback and liquidity (2026-10-03)

Owner: of ARCSENSE's fees, 30% buy back $SENSE and burn it, 70% go to liquidity pools, and people can see it on the landing page. All platform fees count (my recommendation; fees from $SENSE trades alone are near zero). Fee collection is unchanged: every fee still goes to the fee wallet `0x2742…86Bb`.

- **The ledger (`engine/src/sense/program.ts`, `GET /v1/sense/program`, `SENSE_PROGRAM=off` stops it):** the fee wallet's activity on Arc, read every 30 s (9k-block slices, both USDC log sources, $SENSE), kept in the settings (`sense-program`).
  - **Fees:** USDC paid to the fee wallet by ARCSENSE's trading contracts, in someone else's transaction (`FEE_SOURCES`):
    - swap routers v1 and v2;
    - the curve router;
    - ArcLaunchpad;
    - Universal Router 2.1.2 and 2.1.1.

    `SENSE_FEE_SOURCES` adds more (the futures contract on mainnet). A person's transfer isn't a fee: on 2026-10-03, $11.95 arrived as a plain transfer from `0x90a9…7799`. Nor are fees on the fee wallet's own trades through the router (the router pays them back to itself).
  - **Buyback:** a transaction the fee wallet sent that brought $SENSE in; its value is what went out, other tokens at the engine's price.
  - **Burn:** $SENSE the fee wallet sent to `0x…dEaD`.
  - **Liquidity:** a transaction the fee wallet sent that added liquidity (v4 `ModifyLiquidity` or v3 `Mint`) and brought no token back, so a swap through a hook isn't counted; or USDC sent to a `SENSE_LIQUIDITY_TARGETS` address. Liquidity taken back out counts against it.
  - **Owed:** 30% and 70% of fees; pending = owed − done.
  - **Start:** 2026-10-04 00:00 UTC, the first block at or after it, found once the chain gets there. The fee wallet launched $SENSE on Argus with a $20 buy, then bought $3 and $1.34 more. Those are creator buys, not buybacks of fees, and the start leaves them out.
- **Checked against the real fee wallet (2026-10-03):**
  - Fees since 1 October: $0. The router "fees" in `arcdex_trades` over those days were the fee wallet's own trades.
  - The three creator buys were read as buys, and nothing was misread as liquidity.
  - Tests: `engine/test/senseProgram.test.ts`.
- **Site:**
  - **Landing (`landing/SenseProgram.tsx`):** "Where the fees go": 30% buyback & burn (bought back, burned, still to buy), 70% liquidity (added, still to add, fees collected), the latest actions with explorer links, and the full ledger.
  - **`/sense` (`pages/SensePage.tsx`, also `/burn`; "$SENSE" in the nav, "$SENSE burn" in the drawer and More):** the full ledger.
  - **Fee wallet connected:** steps to buy $SENSE (its coin page), burn everything the wallet holds (with a confirmation), and add liquidity.
  - The FAQ and the futures notes say the same 30/70.
- **Buybacks, burns and liquidity are done by the owner from the fee wallet.** The ledger counts them by itself and shows anything still owed.

## ARCSENSE futures on Arc testnet (2026-10-03)

Owner: "yes do it all" to the plan: a USDC pool as every trader's counterparty, BTC/ETH/SOL at up to 10×, Arc testnet first, an independent audit before mainnet. Audit scope, trust assumptions and open questions: **`contracts/AUDIT-SensePerps.md`**.

- **Oracle: RedStone's signed prices (`redstone-primary-prod`), checked on-chain by our own `SenseOracle`.**
  - Each price is signed by 5 nodes every 10 seconds; the contract takes 3 distinct authorised signers with one timestamp and their median.
  - Why not the others (checked 2026-10-03):
    - Chainlink Data Streams is on Arc mainnet, but needs paid credentials.
    - Arc's Chainlink push feeds move only on 0.5% or daily.
    - Pyth's Hermes now answers 401 without a key, and Pyth lists Arc testnet only.
  - RedStone's own on-chain connector is BUSL-1.1 (production use needs their licence), so ARCSENSE checks RedStone's public data-package format with its own code. Verified against real gateway packages: `testRealRedstonePackages`, and `engine/test/fixtures/redstone-snapshot.json`.
- **Contracts (`contracts/SensePerps.sol`, Foundry, 45 tests; 20 of 20 planted bugs caught):**
  - `SensePerps` (the pool as sLP shares, positions, requests, liquidations, TP/SL, fees).
  - `SenseOracle` (signers behind a 2-day timelock).
  - `SenseTestUSDC` (testnet only: 1,000 a day from `faucet()`).
  - Markets 0–2: BTC, ETH, SOL at 10×. Fees: 0.08% to open and to close, liquidation below 1% of size, 0.0025% an hour to borrow, 250,000 open interest per side.
  - Trading fees go 100% to the fee wallet `0x2742…86Bb` (`platformFeeShareBps`; the owner can give the pool a share). LPs earn borrow fees and traders' losses.
  - The owner is the deploy wallet `0x414B…c3dA`.
  - Every order is two steps: the request goes on-chain, then the keeper fills it with the first price signed after it, usually 15–30 s later.
  - After `forge build`, regenerate the ABI and bytecode the engine and site use: `node scripts/gen-perps-build.mjs` (`--check` to verify) writes `engine/src/perps/abi.ts` and `build.ts`.
- **The engine (`engine/src/perps`, `PERPS=off` stops it):**
  - **Prices (`redstone.ts`):** RedStone's gateway polled every 4 s; every signature checked as the contract checks it.
  - **Chart (`candles.ts`, `store.ts`):** candles from those prices, kept in Postgres (`arcsense_perps_candles`: 1m for 30 days, 1h for good). RedStone keeps no history, so the chart starts when the engine first recorded a pair.
  - **Keeper (`keeper.ts`):**
    - Executes each request with the first fresh package signed after it.
    - Liquidates with the contract's own math (`positionAt` in `shared.ts`, which the site uses too).
    - Executes take-profits and stop-losses.
    - Backs off 20 s after a failure.
  - **Trades (`events.ts`):** the contract's events.
  - **Routes:** `GET /v1/perps/status|prices|candles|state|trades`.
- **Deployment, by the engine itself (`deploy.ts`):**
  - **The keeper wallet:** made on the engine, its key encrypted under `BOT_WALLET_SECRET` (setting `perps-keeper`).
  - **Gas:** once that wallet holds 0.3+ testnet USDC (from Circle's faucet), the engine deploys:
    - tUSDC;
    - the oracle with RedStone's 5 signers;
    - the futures contract (owner `0x414B…c3dA`, fee wallet `0x2742…86Bb`, keeper itself);
    - and it deposits 1,000,000 tUSDC as the pool's first liquidity.
  - **Records:** each step is saved (setting `perps-testnet`). `/v1/perps/status` shows the addresses, or what's missing (`waiting`).
  - **Testnet only:** it refuses any other chain.
  - **Overrides:**
    - `PERPS_AUTODEPLOY=off`;
    - `PERPS_ADDRESS` (+ `PERPS_ORACLE`, `PERPS_USDC`, `PERPS_BLOCK`) to use contracts deployed elsewhere;
    - `PERPS_OWNER`;
    - `PERPS_RPC`.
- **The site (`pages/FuturesPage.tsx`, `lib/perps.ts`):**
  - **Prices and chart:** the oracle's prices and the chart for all 8 pairs, with BTC/ETH/SOL tradable.
    - **Same chart as spot (owner's request, 2026-10-03):** `PriceChart` with a candle source (`ChartSource`: the engine's oracle candles, reloaded every 10 s; timeframes 1m–1D; no volume, so no volume bars or VWAP). Each new signed price is a live tick, so the line's end glides and pulses as on coin pages. Line/Candles, the legend, indicators, %/log/auto, screenshot and fullscreen all work as on spot.
  - **Orders:** market and limit orders, 1–10×, optional TP/SL, max price move 0.5/1/2%.
  - **Tabs:** positions (live P&L, liquidation price, TP/SL editing, close), orders (cancel), history, the liquidity pool (deposit, withdraw; 15-minute cooldown).
  - **Live feed:** the latest trades by everyone.
  - **Wallets:** the trading wallet signs on testnet with no pop-ups. A connected wallet is switched to Arc testnet (`arcTestnet` in `wagmi.ts`).
  - **Order button:** walks the trader through what's missing: connect, gas from Circle's faucet, then "Get 1,000 test USDC".
  - **Approvals are exact:** an open approves its margin and two keeper fees (its own and its close's).
- **Owner step:** send testnet USDC from faucet.circle.com (Arc Testnet) to the keeper address in `GET /v1/perps/status`. Everything else is automatic. Top it up when `waiting` says it's low.
- **Checked:**
  - `forge test --match-contract SensePerpsTest`.
  - `bun test engine/test/perps.test.ts`.
  - `bun test engine/test/perpsE2e.test.ts` (anvil).
  - In a browser, against a local chain standing in for Arc testnet, with the real keeper and real RedStone prices (`engine/scripts/perps-standin.ts` explains the setup): the engine deployed and seeded by itself; then faucet, a market long filled in ~15 s, a take-profit, a short closed by hand, a pool deposit, and a limit order cancelled. Also a 375px phone with no sideways scroll.
- **Before mainnet:** the audit (`contracts/AUDIT-SensePerps.md`), RedStone's terms for production use, and real USDC (deploy without `SenseTestUSDC`).

## The Terminal: most active first, live holders (2026-10-03)

Owner: "the coins on the spot market seem not active, holder numbers aren't correct, the terminal doesn't blink; rank tokens to the top by their activity".
- **Why it looked dead:** the Terminal sorted by 24h volume, so yesterday's pump-and-dumps (down ~50%, $2.5K caps) held the top rows while the coins trading now sat below the fold. Trades were arriving (the badge counted 200+ a minute) and flashing rows, but rarely the visible ones.
- **Most active first:** `GET /v1/tokens/active?limit=` (`MarketEngine.active`, `TokenState.activity` over the one-minute ring) ranks coins with a trade in the last hour by 2 × trades in 15 minutes + trades in the hour + one point per $100 of the hour's volume (`ActiveToken`). The Terminal polls it every 15s, its default sort is "Sort: most active", each live trade adds 2 until the next poll, and the order is re-taken every 5 seconds (not on every flash, which made rows unreadable). Coins trading now that the list lacks are added from their launch. Rows and phone cards show 🔥 with the count when a coin has 5+ trades in 15 minutes.
- **Holders:** the browser reads the holder index from Supabase (`arcdex_holder_scans`, `arcdex_holder_balances`), but the engine had been writing it to its own Postgres since the site's functions moved there: counts froze on 2026-10-02 and newer coins showed "—". With `SUPABASE_SECRET_KEY` set, the engine writes the index to Supabase again (`siteApi.ts`: `supabaseHolders` when `adminReady`), and every minute brings the 30 most active coins' counts up to date (`hotTokens`), so they're right in the Terminal before anyone opens a coin.
- Tests: `engine/test/activeTokens.test.ts`.

## ARCSENSE on Netlify (2026-10-03)

The owner's new site, www.arcsense.site, is hosted on Netlify and serves only the app's files (`netlify.toml`): no function runs there.
- **Data and writes come from the engine:** besides the read functions above, `/api/session`, `/api/social`, `/api/upload` and `/api/index-trades` run on the engine too (`siteApi.ts` `WRITES`: the request passes through with its headers and body, never cached). They need on Railway what they needed on Vercel: `ARCDEX_SESSION_SECRET` (sign-in), and Supabase's secret key for social writes and uploads. Without them they answer 503 and the site shows its empty states. Card deposits (`/api/onramp`) aren't served there yet: the Deposit modal says they're being switched on.
- **The engine allows ARCSENSE's domains in code** (`ARCSENSE_ORIGINS` in `engine/src/config.ts`: arcsense.site, www.arcsense.site, arcsense-app.netlify.app), whatever `WS_ALLOWED_ORIGINS` lists on Railway.
- **Build settings** live in `netlify.toml` (Bun, `dist`, the public `VITE_*` values). `VITE_WC_PROJECT_ID` (WalletConnect) is still missing, from cloud.reown.com; without it, phone wallets by QR code aren't offered. `/api/*` is a plain 404 on Netlify, so the site's fallback fails fast.
- **arcdex.online → www.arcsense.site (owner, 2026-10-04; until then "no redirect"):** `netlify.toml` sends `arcdex.online/*` and `www.arcdex.online/*` (http and https) to the same path on arcsense.site with a 301 (the primary domain: www.arcsense.site itself redirects there, so this saves a hop).
  - **Why Netlify:** arcdex.online's DNS is at Namecheap and points at Vercel, which answers `402 DEPLOYMENT_DISABLED` (the account is blocked), so a redirect can't be deployed there. Vercel also sent HSTS for two years, so browsers that visited will only use HTTPS: the redirect needs a real certificate.
  - **Owner steps:**
    1. In Netlify, `arcsense-app` → Domain management → add `arcdex.online` and `www.arcdex.online` as domain aliases.
    2. At Namecheap (arcdex.online → Advanced DNS), replace Vercel's records:
       - `A` `@` → `75.2.60.5`;
       - `CNAME` `www` → `arcsense-app.netlify.app`.
    3. Netlify then issues the certificate by itself, and the rules take effect.
  - **Done by the owner on 2026-10-04:** both names resolve to Netlify (checked through Google's and Namecheap's DNS). Until Netlify issued the arcdex.online certificate, https answered with Netlify's generic `*.netlify.app` certificate, and http went to https on the same host first.

## Autotrade paused (2026-10-03)

Owner: the platform becomes ARCSENSE (spot and futures trading), and "the auto trade functionality will have to be paused for now".
- **The switch:** `AUTOTRADE_PAUSED` (`engine/src/config.ts` `autotradePaused`), on by default; `AUTOTRADE_PAUSED=off` on Railway resumes Autotrade.
- **Paused:** no bot opens a new trade, paper or live: visitors' bots (`PaperAccounts.onSignal`, skip key `autotrade-paused`, "not traded: Autotrade is paused for now") and the owner's bot wallet (`Bot` `forLive`).
- **Still running:** trades already open are managed and sold as before, withdrawals work, and signals, the scanner and the engine's own paper book keep running.
- **Site:** `GET /v1/bot/stats` `routing.autotradePaused`; the Autotrade page shows "⏸ Autotrade is paused" (all seven languages).
- Tests: `engine/test/autotradePause.test.ts`.

## The signal engine — `engine/src/quant` (2026-10-02)

A 100-point meme-coin signal engine built into the market engine, beside the existing bot (which it doesn't change). Full design, formulas, strategies, risk controls, measurements, environment and the steps before live: **`engine/SIGNAL_ENGINE.md`**.
- **What it does:** every coin of the scored launchpads (`SIG_LAUNCHPADS`, Argus by default) is scored on flow 20, momentum 15, volume 15, liquidity 15, smart money 10, holders 10, safety 10 and regime 5 (`quant/score.ts`). Three strategies (`early_momentum`, `breakout`, `smart_money`) say what kind of setup it is. A trade needs the score, safety (`quant/safety.ts` over the existing scanner and rug guard), exhaustion, distribution, the expected value after costs and the risk limits to agree.
- **Positions:** sell 20% at +12%, 25% at +25% and 25% at +50%, then trail the rest. Volatility stops, break-even after the first target, and exits when liquidity, distribution, momentum or time say so.
- **Reused, not duplicated:** the trade stream (an `EngineObserver`), the scanner (`Bot.reportCached` / `report`), the rug guard, the bot wallet's executor (shared, one nonce sequence), the Postgres store (new `arcdex_sig_*` tables, created on start; `engine/sql/20261002000000_signal_engine.sql`) and the owner's signed controls (`ControlVerifier.verifyText`, `api/_quantProtocol.ts`).
- **Paper only by default.** Live orders need all of these (`quant/risk.ts liveGate`):
  - `SIG_LIVE_ALLOWED=1` on Railway;
  - the owner's signed `{"risk":{"liveEnabled":true}}`;
  - a walk-forward run with 30+ out-of-sample trades and a profit factor of 1.2+;
  - the paper book over 2+ days and 30+ trades passing the same bars.

  None of that was done on 2026-10-02.
- **Validation:** `quant/backtest.ts` replays recorded trades through the same engine (a test checks for no look-ahead). `quant/walkforward.ts` chooses on training windows, checks on validation and reports untouched test windows. The engine re-runs it on the last 48h every 12h on a worker thread (`quant/validator.ts`). CLI: `bun engine/scripts/quant-backtest.ts --tapes <dir> [--walkforward]`, or `--api <engine url> --hours 48`.
- **Measured on 3.6 days of Argus trades (190 coins):**
  - Scores clustered at 55–68. The bar to trade is 60 (`gates.minSignalScore`), not the 75 of the "trade candidate" band.
  - Walk-forward out of sample: 23 trades, 39% won, profit factor 1.26, +7.4% a trade. That average rests on one +85% trade, and two of three folds lost. Inconclusive.
- **API:** `GET /v1/quant/status|signals|radar|positions|wallets|events|validations|dataset`, `POST /v1/quant/control` (signed settings patch, kill switch, validate now). Site: /autotrade → **Signal engine** tab (`components/SignalEngine.tsx`), every string in all six dictionaries.
- **Tests:** `engine/test/quantCore.test.ts`, `quantTrading.test.ts`, `quantEngine.test.ts` (55 tests). The store's SQL was run against PGlite (schema, batched upserts, the dataset join).
- **Railway:** the Dockerfile copies `api/_quantProtocol.ts`, and `railway.toml` watches it. Railway's own service settings (Watch Paths) should get it too, or a change to that file alone won't redeploy the engine.

## Hosting — arcdex.online only

**Every commit to `main` deploys to arcdex.online, and nowhere else** (owner decision, 2026-09-24).

- **Project:** Vercel project `app` (`prj_cvHmYqjjLNXDMycZfQTbV4JKmkW2`), serving **arcdex.online** and `www.arcdex.online`. It builds automatically from GitHub `olomierik/ZAKA` `main`, so to ship you commit and push, then check the new `app` deployment (`vercel ls app`). Don't use `vercel --prod` for normal releases.
- **Local link:** `.vercel/project.json` is linked to `app`, so any Vercel CLI command run here targets arcdex.online.
- **Env vars:** only `app`'s Vercel settings are used. `.env` isn't committed, so GitHub builds never see it. `app` production has `VITE_ARC_LAUNCHPAD_ADDRESS`, `VITE_ARCDEX_SWAP_ROUTER_ADDRESS`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `VITE_WC_PROJECT_ID`. `VITE_ARCDEX_CURVE_ROUTER_ADDRESS` isn't needed: the deployed curve router is the default (`api/_curves.ts`). Set it only to name another router, or to `off`. `VITE_ARC_RPC_URL` / `VITE_ARC_WSS_URL` switch on the dedicated Arc endpoint ("Dedicated Arc RPC"). A new `VITE_*` var must be added there, and it only takes effect on the next build.
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
