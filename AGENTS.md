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
  - A fit runs on load and on a new timeframe, coin, view or style. Since round 7, new candles walk into the room on the right, and the view re-fits only when needed (see below); a history refresh re-fits only if bars fell off the view.
  - The price axis goes back to auto on a new timeframe, coin, Price/MCap view or style.
  - A resize keeps the fit (`lockVisibleTimeRangeOnResize`, then a re-check). The edges are no longer pinned: `fixRightEdge` glued the last point to the price axis, and `fixLeftEdge` made 5.2 slide the chart on every new bar (round 7).
  - Someone who drags, pinches or wheel-zooms keeps their view until they change the timeframe; a double-click fits it again. The old "last 140 bars" window is gone.
- Like fomo's chart:
  - A legend: coin · timeframe, then the value under the crosshair and its change from the bar before.
  - % / log / auto scale buttons and a UTC clock under the chart.
  - Price by default, with a switch to market cap (see "Coin page chart" below).
  - Caps under $100K in full dollars on the axis.
- Launchpad coins use this chart too (the old `CurveChart` is gone), priced from the curve's reserves after each trade.
- **The live end of the line, as on fomo (owner's request, round 7).** Pinning the right edge had glued the last point to the price axis.
  - **Room on the right:** the line stops 64px short of the axis (40px on phones), using `rightOffsetPixels` and `LIVE_GAP` in `lib/chartMotion.ts`. Candles get the same room.
  - **New bars walk right:** `shiftVisibleRangeOnNewBar` is off, so each new bar moves one step into that room while the chart holds still.
  - **Re-fit before the axis:** once the last bar is within `LIVE_GAP_MIN` (14px) of the axis, the view glides back to a fit over `REFIT_MS`. The target range is `fitRange()`, and it lands on `fitContent()`. The decision is `needsRefit()`, which also fires if bars fall off the left or far too much room opens up.
  - **The last point pulses** (`lastPriceAnimation` Continuous), with a dotted price line to the axis label (`chartStyle.ts`).
  - **Prices glide:** each new price reaches the last point over `GLIDE_MS` (ease-out) instead of jumping. A new bar grows out of the previous price.
    - While it glides, `autoscaleInfoProvider` stretches the price axis to the target at once. The dot moves inside a still axis, and a swap's pop is placed at its final height (pops off the axis are held at the edge until the glide lands).
  - **Reduced motion:** no pulse, no glide, and re-fits happen at once.
  - A drag, pinch or wheel-zoom still keeps the user's view; a double-click fits it again.
  - **Tests:**
    - `bun scripts/test-chart-motion.ts`: the fit, walk and re-fit math against the library's own formulas.
    - A browser check reads the chart's canvas pixels. It covers the room, the pulse, walking and re-fitting, the glide (a drop and a new high), drag and double-click, resizes, candles, phones and reduced motion.

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
    - Snipe: 20s–10min old, 6+ buyers (was 8), $200+ bought ($300), buys 1.3× sells (1.5×), no buyer over 25% of buys, not yet 5× from its first trade, within 15% of its peak.
    - **Momentum fast scalp** (2026-09-30, owner's request: "scan many coins per minute and fast scalp for $1–2"): any watched coin 60s+ old (was 90s) whose last 2 minutes (a rolling tape, `RecentTapes`) show 3+ buyers (4), $100+ bought ($150), buys 1.6× sells (2×), the price up 2–35% (3%) and within 8% of the window's high, no buyer over 40% of the buying, and $2,000+ liquidity ($2,500). The same coin again after 30 minutes, not right after its snipe. Signals carry `rule: 'momentum'`.
    - **Dip rebound** (the `second-leg` strategy; it needed a 10× run): ran 2×+, pulled back 25–70% (was 50–85%), held a higher low for 3+ minutes (10), 8%+ off the bottom (20%), buying back (last 15 minutes' buys 1.2× sells, $100+). The same coin again after an hour (6).
    - **Signals within 2 minutes:** each part of the deep scan gets a time budget (honeypot probe 10s, holders 12s, funding trace 15s). Funding not traced in time is a risk flag (the coin can still be a fast scalp), not a hard block, and a scan missing an answer is retried after 15s instead of being held 2 minutes. A honeypot probe that doesn't answer still blocks.
    - **Why coins are passed over (`GET /v1/bot/rejections`):** each scan row carries `keys` (`snipe:buyers`, `scalp:move`, `leg:peak`, `safety:honeypot`, `pending:clusters`, …; the rules' `failed` ids and the scanner's check ids), and the endpoint counts watched coins by their main one, with labels (`REASON_LABELS` in `bot/scanFeed.ts`). The Scanner tab shows the top 8.
    - **Scanning faster:** besides each coin's own trades, `bot.sweep()` evaluates every coin that traded in the last 3 minutes every 3s (up to 600 a sweep); a coin is evaluated at most every 2s. Contract reads start on a coin's first trade, so its scan is quick once a rule is met.
    - A candidate gets a deep scan (probe, holders, funding; at most 6 at once, 8 contract reads at once; cached 2 minutes, 10 for coins over 30 minutes old) and fires only if it passes. Each signal says whether ARCDEX can trade it today (`executable`: not Peach's or Faze's curves yet), and carries the coin's numbers (`features`: age, liquidity, market cap, buyers, buys ÷ sells, run-up, largest buyer, safety score, risk flags, probe round trip).
    - **The rug guard (`bot/rugGuard.ts`)** reads every trade: liquidity 35% under its 15-minute high (pulled or drained), an early insider (a launch-block bundler, or a wallet funded from a cluster or by the creator) selling 4%+ of the pool, anyone selling 12%+ of it, or the price 20% under the minute's high on sells twice the buys. An alarm closes every position in the coin at once (exit reason `rug`, with the reason in `note`): the bot's paper book, the bot wallet's live positions and every visitor's bot. The coin isn't bought again for 30 minutes (the scanner shows it rejected with the alarm). A paper position closes at the price after the trade that tripped it. The liquidity figure is the pool's depth around the current price (from each swap), so in a pool of several concentrated positions a big move can drop it without anyone removing liquidity: the guard then gets out early, the safe side. `/metrics` counts `bot_rug_exits`.
  - **Paper trading (`trading/paper.ts`; `BOT_MODE=paper`, the default, or `off`).** Every signal opens a paper position, in live mode too. $25 a position (`BOT_SIZE_USD`). Costs both ways: half the probe's measured round trip plus impact for the size against liquidity.
    - Snipe exits: −35% stop, half at 2×, the rest trailing 35% under its peak, out after 45 minutes unless up 10%. Second leg: −20% stop, half at 1.8×, 25% trail, 6 hours.
    - **Fast scalp** (a snipe on a risky coin, or a momentum burst): $5 (`BOT_SCALP_SIZE_USD`; `BOT_SIZE_USD` sizes only snipes and second legs), all of it sold at +15% (2026-09-30: "secure the profit and close"; it was 75% at +30% with a trail), −10% stop, out after 3 minutes unless up 3%, never held past 10 minutes (`maxHoldMin`), and closed on the creator's first sell (`exitOnCreatorSell`: the bot closes at that sale's price, after the dump, as a real exit would be). At most 3 scalps open, within the 5; a coin can be scalped again after 30 minutes (`cooldownMinScalp`).
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
        - Arc was out of the build sandbox's reach, so the pre-flight hasn't run against mainnet yet. `bun engine/scripts/check-live-trade.ts` now runs it too, in the busiest pools, from a throwaway address. Run that before the first funded trade.
    - **Limits (Railway variables):**
      - `BOT_LIVE_MAX_TRADE_USD` 25: cap per trade, whatever the strategy's size.
      - `BOT_LIVE_MAX_OPEN` 3 and `BOT_LIVE_MAX_OPEN_SCALP` 2: positions open at once.
      - `BOT_LIVE_DAILY_LOSS_USD` 50: no new position after that realized loss in a UTC day.
      - `BOT_LIVE_RESERVE_USD` 2: USDC never traded, kept for gas.
      - `BOT_LIVE_SLIPPAGE_BPS` 1000: buys at most 10% under the V4Quoter's quote.
      - `BOT_LIVE_MAX_ROUND_TRIP_PCT` 20: no buy whose pre-flight round trip costs more; `BOT_LIVE_PREFLIGHT=off` skips the pre-flight (not recommended).
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
      - `bun engine/scripts/check-live-trade.ts`: the exact buy and sell calls, simulated on mainnet from a throwaway address (balance, token and Permit2 storage overrides), in the busiest ERC-20 USDC and native-USDC pools. Each goes through with its minimum and is refused with a minimum of twice the quote. It passed for both on 2026-09-30. (The pre-flight check was added to the script afterwards and hasn't run on mainnet yet.)
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
      - **Automatic size (`bot/sizing.ts`):** the visitor no longer sets an amount (the `size` action is refused). Each trade is the smallest (from $5, in $0.50 steps, up to $250) that, sold in full at the strategy's take-profit, nets its target after the probe's round trip and price impact both ways: fast scalps $1.5 (range $1–2), snipes and second legs $3 ($1–4). A thinner pool needs a bigger size; a pool where no size reaches the target is skipped. User bots sell everything at the take-profit.
      - **Its own settings per strategy (`StrategyTuning`, `bot/learner.ts`):** take-profit (scalp +15%, snipe +40%, second leg +35% to start), stop (−10%, −20%, −15%), time stops, the profit target, and entry filters on each signal's `features` (minimum liquidity, buyers, buys ÷ sells and safety score; maximum run-up and largest buyer; risk flags to skip). Each position keeps the exits it opened with (`Position.exits`) and the tuning version.
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
      - **Paper first, then live for the same bot (`bot/userLive.ts`):** live opens once its paper record has 20+ closed trades, a 55%+ win rate, a profit factor of 1.2+ and a net profit (`READY`), the owner's email is verified, and the bot's own wallet holds $10+. Each live bot has its own wallet, made on the engine; its key is encrypted with AES-256-GCM under `BOT_WALLET_SECRET` (the bot's id as associated data) and never leaves the engine, so **the engine holds what owners deposit**. It trades through the bot wallet's executor and trader (Uniswap v4 pools against USDC), each buy checked by the pre-flight first ("Every swap goes through on-chain" above): its own size (target-sized, at most $50), its learned exits, the rug guard, at most 3 open (2 scalps), a daily loss limit of 10% of the wallet ($5–$100), $1 kept for gas, and back to paper if the wallet falls 50% below where it went live. Switching back to paper stops new live trades; open ones are still managed; "sell all live" closes them.
      - **The 2% fee:** a winning live trade sends 2% of its profit (after gas) to the fee wallet `0x2742…86Bb` right after it closes (a `fee` transaction on the position; retried each minute until sent); a loss pays nothing. Paper wins pay the same 2% virtually, so paper reads like live. Shown per trade and in totals.
      - **Money out:** the owner asks for a code (amount and address named in the email), then confirms it; at most the balance less $0.20 for gas.
      - Routes: `/v1/auth/signup|login|forgot|verify/send|verify|passcode|logout-all`, `/v1/me`, `/v1/me/bots`, `/v1/me/claim`, `/v1/me/bots/:slug` (GET, POST: deposit, start, stop, strategies, rename, reset, mode, live-wallet, sell-live), `/v1/me/bots/:slug/trades`, `/v1/me/bots/:slug/withdraw/code`, `/v1/me/bots/:slug/withdraw`.
      - Tests: `engine/test/accounts.test.ts` (sign-up, lockouts, resets, verification and codes; unique names, owners and claims; the fee; the marketplace; readiness; a live bot's buy, take-profit and fee, a rug exit and a withdrawal against a stand-in wallet; rejection counts; the routes). Taking the fee out fails two of them.
      - **Owner setup (Railway, service arcdex-engine):**
        1. `RESEND_API_KEY` from resend.com, and `MAIL_FROM` on a domain verified there (default `ARCDEX <bots@arcdex.online>`, which needs arcdex.online verified in Resend).
        2. `BOT_WALLET_SECRET`: 32 random bytes as 64 hex characters (e.g. `openssl rand -hex 32`). Keep a copy somewhere safe: without it no bot wallet can be opened again. Changing it locks every existing bot wallet.
        3. Optional `AUTH_SECRET` (any long random string); without it the engine makes one and keeps it in its database.
        - Until 1 and 2 are set, the page says so, and every bot stays on paper.
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
    - Checked in a browser (2026-09-30) against a stand-in engine running the engine's own account, bot and marketplace code (a memory mailer, a stand-in wallet): sign-up, a bot, a name already taken refused, the paper record, email verification with the code from sign-up, the live wallet and balance, switching to live, a withdrawal by emailed code (the email names the amount and address), the marketplace and a bot page (no owner email), the rejection reasons, sign out, forgot passcode and sign in with the emailed one, and no sideways scroll at 360px. The verification box was hidden until a second code was asked for (and sign-up had just sent one): fixed.
    - Tabs before the accounts: **My autotrade** (create a bot: its name and strategies; then value, cash, P&L, win rate, deposit, strategy cards, each strategy's automatic size, exits and learned filters, Start/Stop, what it learned, its protections, open trades, the full trade log with Load more and a CSV download, its activity and the signals it passed over, reset), **Scanner** (every coin with its status and reasons, filtered by status), **Signals**, and **Bot results** (below).
    - Checked in a browser (2026-09-30) against a stand-in engine running the real `PaperAccounts`: creating a bot (a bad name refused), deposit, start, a simulated session (wins, near misses that taught it a closer take-profit, a rug alarm), the CSV, and no sideways scroll at 1280px and 360px.
  - **Landing (`landing/Landing.tsx`, `#autotrade`):** an Autotrade section (scan, choose strategies, trades around the clock; paper with virtual USDC; results measured, not promised), its live numbers from `/v1/bot/scan`, a feature card, a hero button, a nav link and an FAQ entry.
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
- **The site uses the engine (switched on 2026-09-25):** the owner set `VITE_ARCDEX_WS_URL=wss://arcdex-engine-production.up.railway.app/ws` in Vercel project `app` (Production). The REST base is derived from it. To switch off, remove the variable and redeploy; pages then use their direct-from-chain path (`poolSwaps.ts`), which is also their automatic fallback within 4s whenever the engine is unreachable. A custom `wss://api.arcdex.online/ws` would need that DNS pointed at Railway first.
  - Measured on 2026-09-25 against Railway: trades p50 1.7s block → client (p90 2.4s, including up to ~1s of block-timestamp rounding), new launches ~2s, and 1s candle closes matched 15/15.
- **Frontend (`src/arcdex/api/marketStream.ts`):** one shared, ref-counted WebSocket. What uses it:
  - **Coin page:** engine trades via REST + `token` channel, merged by trade id, with chain fallback after 4s or on REST failure.
  - **PriceChart:** engine candles + `CANDLE_UPDATE`, with a 5s timeframe in engine mode.
  - **Terminal:** `new_tokens` rows with a NEW badge, visible before their first trade; `market` ticks update prices; list polling slows to 60s.
  - **Search:** includes fresh launches.
- **Tests:** `bun run engine:test` — 53 tests (+2 Postgres ones that need `PG_TEST_URL`; `engine/test/curves.test.ts` covers Mercuri and SolonPad), including catch-up backpressure, live batching, replays of recorded mainnet data (`engine/test/fixtures/mainnet.json`) and a RESP3 Redis round-trip against Bun's client. Live latency: `bun engine/scripts/latency-check.ts <ws-url> 60`.

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
