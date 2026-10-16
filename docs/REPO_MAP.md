# Repo map and Phase 0 findings

Phase 0 of `06_BUILD_PLAN_AND_ACCEPTANCE.md` (2026-10-15): what the repo contains today, where it differs from
`03_ARCHITECTURE_SPEC.md`, security findings against `04_SECURITY_AND_THREAT_MODEL.md`, the state of each integration in
`05_ENV_AND_INTEGRATIONS.md`, and the decisions they raise. Read-only: nothing here changed code.

`README.md` is the short map and `AGENTS.md` the detailed record; this file is the gap analysis against the build pack.
An earlier audit for a different brief is in `docs/UPGRADE-2026-10.md`.

## 1. What exists today

**Product:** ARCDEX, a multichain trading terminal at arcsense.site (arcdex.online redirects there). Spot on Arc,
Robinhood Chain, Solana, BNB Chain and Starknet; futures and prediction markets on Hyperliquid; a bridge; paper trading,
price alerts, a social layer and (paused) Autotrade bots.

**Runtime:**

| Piece | Where | Notes |
|---|---|---|
| Web app | React 18 + Vite SPA, `src/arcdex/`, served by Netlify (`netlify.toml`) | Edge functions in `netlify/edge-functions/`: `geo`, `across` (API key proxy), `rpc`, `coin-meta`, `sitemap` |
| API + workers | Market engine, `engine/` (Bun, Railway) | Arc ingest, candles, WebSocket/REST, the site's `/api/*` read and write functions (`engine/src/site/siteApi.ts`), safety scans, signals, bots, futures keeper |
| Databases | Railway Postgres + Redis (engine); Supabase Postgres (social data, RLS) | Migrations in `supabase/migrations/`, engine tables created on start |
| Contracts | `contracts/` (Foundry) | ArcDexSwapRouter v2, ArcDexCurveRouter, ArcLaunchpad (mainnet); SensePerps (Arc testnet) |

**Routes** (`src/arcdex/lib/router.ts`): `/` (Trenches), `/arc`, `/solana`, `/bnb`, `/robinhood`, `/starknet`, `/swap`,
`/bridge`, `/portfolio`, `/predict`, `/futures/testnet`, `/leaderboard`, `/leaderboard/futures`, `/feed`, `/alerts`,
`/rewards`, `/transfers`, `/clans`, `/burn`, `/routes`, `/launchpad`, `/autotrade`, `/autotrade/manage`, `/bots`,
`/deploy/curve-router`, plus `/token/0x…`, `/futures/<coin>`, `/profile/<address>`, `/clans/<slug>` and `/r/<name>`
(referrals).

**Sign-in and sessions:**
- Site: a wallet signs a sign-in message (EOA, ERC-1271/6492) and gets a 30-day HMAC token (`api/session.ts`,
  `api/_session.ts`); "sign out of all devices" revokes server-side.
- Autotrade accounts: email + 4-character passcode on the engine (`engine/src/bot/users.ts`).
- Owner controls: a signed message from `BOT_OWNER_ADDRESS`, valid 5 minutes and once (`engine/src/bot/control.ts`).

**Wallets** (`src/arcdex/lib/embeddedWallet.ts`, `solanaWallet.ts`, `wagmi.ts`, `starknet/`):
- The in-browser **trading wallet**: an EVM key generated in the browser, AES-encrypted under PBKDF2(passcode),
  optionally combined with a passkey (WebAuthn PRF), kept in localStorage. Its Solana address is derived from the same
  key. The same EVM address serves every EVM chain.
- External EVM wallets through wagmi (browser wallets, WalletConnect, Coinbase); Solana wallets (Phantom, Solflare,
  Backpack) with an EVM account derived from a wallet signature; Starknet wallets.
- Export: `exportPrivateKey(passcode)` returns the raw key to ARCDEX's own UI.
- Circle wallet SDKs are dependencies (`@circle-fin/user-controlled-wallets`, `modular-wallets-core`,
  `developer-controlled-wallets`, `w3s-pw-web-sdk`) but are used only in `scripts/`, not in the app.

**Trading, per chain:**

| Chain | Venue | Code | Platform fee |
|---|---|---|---|
| Arc | ArcDexSwapRouter (v3/v4), ArcDexCurveRouter (Mercuri, SolonPad curves), Uniswap Universal Router (native-USDC pools) | `components/ArgusSwapWidget.tsx`, `api/argusMarket.ts`, `api/curves.ts`, `api/universalRouter.ts` | 2% on-chain (`feeBps` 200, owner-settable, cap 2%); 0.5% once the owners sign `setFeeBps(50)` at `/admin` |
| Arc | ArcLaunchpad curve | `components/CurveSwapWidget.tsx` | 1% + creator tax (immutable contract) |
| Robinhood Chain | Across, from Arc USDC | `lib/acrossQuote.ts`, `components/RobinhoodTrade.tsx` | 0.5% (Across app fee; 2% until 2026-10-15) |
| Solana | Relay (SOL, Solana USDC or Arc USDC) | `lib/relayQuote.ts`, `components/SolanaTrade.tsx` | 0.5% (Relay app fee; 2% until 2026-10-15) |
| BNB Chain | four.meme curve, Relay | `lib/fourMeme.ts`, `components/BscTrade.tsx` | 0.5% through Relay; none on four.meme's curve |
| Starknet | AVNU | `src/arcdex/starknet/` | 0.5% once `VITE_STARKNET_FEE_RECIPIENT` is set (`VITE_STARKNET_FEE_BPS` overrides) |
| Hyperliquid | Hyperliquid API, signed in the browser | `src/arcdex/hl/` | builder fee (`VITE_HL_BUILDER_*`); trading behind `VITE_HL_TRADING` |
| Bridge | Circle CCTP v2 (Bridge Kit) | `lib/bridgeKit.ts` | 0.5% (90% to the platform) |

Every fee goes to the EOA `0x2742…86Bb` (since 2026-10-15 from `VITE_FEE_RECIPIENT_EVM` / `FEE_RECIPIENT_EVM`, with that as the default). Quotes from Relay and Across are checked before signing (recipient, amounts,
that the fee is ARCDEX's: `relayQuote.ts`, `acrossQuote.ts`). Trades are simulated before sending; approvals are exact;
min-out is enforced on-chain; price impact over 15% needs a tick box.

**Fee records:** no per-trade append-only ledger. `engine/src/coin/program.ts` reads the fee wallet's on-chain activity
(router, curve, launchpad, Universal Router, Across handler, Relay's app-fee balance) for the buyback program, and
`arcdex_fee_stats()` sums indexed router events.

**Switches:** `AUTOTRADE_PAUSED` (bots, on), `VITE_HL_TRADING` (Hyperliquid orders, build time), `TIERS_ENFORCE_AT`,
and the routers' own `pause()` (owner key, on-chain). There is no runtime switch that stops site trades on every chain.

**Environment:** `VITE_*` values ship in the page (`netlify.toml`, README "Environment"); secrets live in Railway
(engine) and Netlify (edge functions). `.env.example` and `engine/.env.example` hold placeholders.

**Tests and CI:** 55 engine test files (`bun run engine:test`), 41 `scripts/test-*.ts` suites, 5 Foundry test files for
the contracts. `.github/workflows/` has one workflow (Supabase edge-function deploy): no tests, typecheck or secret scan in
CI. `bunx tsc --noEmit` fails on `scripts/compass-deploy.ts` (missing `@circlefin/compass-chains`), before any change.

## 2. Differences from the architecture spec (03)

| Spec | Repo today | Gap |
|---|---|---|
| Privy (or Turnkey) login provisioning EVM + Solana wallets | Own in-browser trading wallet; external wallets; site sign-in by wallet signature | No email/social login; no provider; export is ARCDEX's own UI |
| Chains: Solana, BNB, Ethereum, Arbitrum, Arc | Arc, Robinhood Chain, Solana, BNB, Starknet, Hyperliquid | No spot trading on Ethereum or Arbitrum (they appear only as bridge chains) |
| Solana via Jupiter Swap API V2 + Jito | Solana via Relay, paid from Arc USDC, SOL or Solana USDC | No Jupiter, no Jito; trades go through Relay's solver |
| EVM via Uniswap API / aggregator | Arc: own routers and Uniswap contracts; BNB: four.meme and Relay; Robinhood: Across | No aggregator for Ethereum/Arbitrum |
| 0.5% flat fee, in the trade | 0.5% spot off Arc; 2% on the Arc routers until their owners sign; 1% launchpad, 0.5% bridge | *Partly closed 2026-10-15:* the Arc routers wait for `setFeeBps(50)`; the launchpad's 1% is immutable |
| Fee recipient: treasury multisig from env | EOA `0x2742…86Bb`, from env since 2026-10-15 (site and engine) | No multisig yet (D4: a setting when it comes); the Arc routers' and launchpad's fee wallet is on-chain |
| `fee_ledger` append-only + nightly reconciliation | Fee wallet activity read on-chain for the buyback program | No per-trade ledger, no reconciliation job |
| `ExecutionProvider` interface | One module per venue; a route registry (`/routes`) | No common quote/prepare/submit interface |
| Admin panel: nonce login, live sessions, fees, trades, audit, flags, kill switch | Signed owner controls for bots and the signal engine; Railway variables | No admin panel, audit log or feature-flag store |
| Sweeper with dry run, alerts, `sweep_runs` | Fees already land in the fee wallet; Relay's balance claimed by hand | No sweeper (fees in-trade make most of it unnecessary) |
| Global and per-chain kill switch | Per-router `pause()`, `AUTOTRADE_PAUSED`, `VITE_HL_TRADING` | No single switch for site trades |
| Withdraw: cooldown/allowlist, limits, notifications | Passcode unless to a wallet that funded it (`lib/funding.ts`) | No new-address delay, limits or notifications |
| Copy trading (P3) | Follows, feed, leaderboard, theses; no copy engine | Copy trading not built |
| Retail UI: single field, no Pro toggle or order book | Binance/motion-style terminal with Trenches, books, futures | Kept by owner instruction (2026-10-15: "maintain my UI and just improve it"); the one-field flow can live inside it |

What already matches: React/Tailwind PWA with a manifest; Node/TS API with Postgres and Redis (the engine); WebSocket
price ticks; Arc USDC decimals (native 18 / ERC-20 6) handled; same EVM address across EVM chains; quote-tamper checks;
simulation before signing; min-out on-chain; token safety scans; referrals; alerts; social layer; leaderboards.

## 3. Security findings (against 04)

Ordered by severity. None is known to be exploited; each is a gap against the build pack's rules.

1. **High: key export through ARCDEX's own UI.** `exportPrivateKey` hands the raw key to the page (04 §1: provider-hosted
   export only). The key also lives in localStorage, encrypted: an XSS on any page of the origin could capture a
   passcode as it is typed. Fix: a provider-hosted wallet (D1), or at least step-up re-auth plus a strict CSP.
2. **High: no Content-Security-Policy or security headers.** `netlify.toml` set none (no CSP, HSTS, frame-ancestors,
   Referrer-Policy). With an in-page wallet key, a CSP is the main defence against injected scripts.
   **Fixed 2026-10-15:** `netlify.toml` `[[headers]]`: scripts from the site only (two inline pieces allowed by hash),
   no framing, HSTS, nosniff, Referrer-Policy, Permissions-Policy. Checked in Chromium on 17 pages with no violations;
   injected inline scripts, foreign scripts and inline handlers are refused. `bun scripts/check-csp.ts` keeps the hashes
   in step with the HTML. `connect-src` still allows any https/wss host (the app's many RPCs): narrowing it is next.
3. **High: fees go to a single EOA.** `0x2742…86Bb` receives every fee and is the routers' `feeWallet` (04 §4:
   multisig). 05 also lists it as the admin address; it should not be both.
4. **Medium: no global kill switch.** Pausing needs an owner transaction per router, and Relay/Across/Hyperliquid paths
   have no runtime off switch.
   **Fixed 2026-10-15:** the trade switch (`engine/src/site/tradeSwitch.ts`, `src/arcdex/lib/tradeSwitch.ts`, `/admin`):
   off everywhere or per venue, signed by an admin wallet (`ADMIN_EVM_ADDRESSES`), or `GLOBAL_KILL_SWITCH` /
   `KILL_SWITCH_VENUES` on Railway. Every trade path checks it before signing; an open page picked up "off" in 28s in the
   browser check. Changes go to an append-only audit table (`arcdex_admin_audit`, updates, deletes and truncates refused
   by triggers, checked on Postgres 16).
5. **Medium: withdrawals have no limits, new-address delay or notification** (04 §1). The passcode rule stops a stolen
   phone from sending anywhere but the funding wallet, but nothing alerts the user.
6. **Medium: no CI checks.** No tests, typecheck, dependency audit or secret scanning on pull requests (04 §3).
   **Fixed 2026-10-15:** `.github/workflows/ci.yml` on every pull request and push to main: site typecheck and build,
   the security-header check, engine typecheck and tests, and gitleaks (`.gitleaks.toml`) over the files and the new
   commits. `bun run check` runs the same locally. gitleaks found no secrets in the files or the 201 commits this
   checkout holds. Dependency audit: not yet.
7. **Medium: no append-only audit or fee ledger** (04 §3). Owner actions (bot controls, signal settings) are verified but
   not recorded in an audit table. **Partly fixed 2026-10-15:** `arcdex_admin_audit` exists and records trade-switch
   changes; bot and signal controls and the fee ledger are still to do.
8. **Low: dependency surface.** Four Circle wallet SDKs ship as runtime dependencies but are used only by scripts; they
   could move to devDependencies or out (04 threat 9).
9. **Low: public keys in `netlify.toml`.** The Supabase anon key and contract addresses are public by design (RLS
   protects writes); noted so nobody mistakes them for leaked secrets. No private keys or secrets were found in tracked
   files (pattern scan of the repo, 2026-10-15).

Already in place: quote and fee-recipient checks before signing (threat 4), simulation and on-chain min-out, exact
approvals, safety scans and honeypot probes (threat 2), passkey 2FA option, session revocation, signed owner controls
with expiry and replay protection, rate limits on the engine's REST and WebSocket.

## 4. Integrations (05): status

External documentation sites (Jupiter, Privy, Arc) are not reachable from the build sandbox, so these were checked from
the repo and the npm registry only. Each one marked "unverified" needs a check against the provider's current docs
before it is built.

| Integration | Status |
|---|---|
| Privy | Not integrated. `@privy-io/react-auth` 3.49.1 is current on npm. EVM + Solana support, the hosted export flow and support for Arc as a custom EVM chain: unverified |
| Turnkey | Not integrated. `@turnkey/sdk-browser` 8.6.0 on npm. Unverified |
| Circle wallets | SDKs installed, used in scripts only. Circle runs Arc, so its wallets are a natural fit; Solana support of the chosen product: unverified |
| Jupiter Swap API V2 | **Integrated 2026-10-15** (`lib/jupiter.ts`, `/jup` edge proxy), checked against Jupiter's OpenAPI spec and referral docs in `jup-ag/docs`. Off until `JUPITER_API_KEY` and `VITE_JUP_REFERRAL_ACCOUNT` are set; Relay meanwhile |
| Jito | Not integrated: Jupiter's `/execute` sends the transaction itself |
| Uniswap on Arc | In use. `@uniswap/sdk-core` 7.19.4 lists Arc (chain 5042); ARCDEX calls the contracts directly. Uniswap's hosted API on Arc: unverified |
| EVM aggregator (Ethereum, Arbitrum, BNB) | None. Relay already quotes BNB; an aggregator for Ethereum/Arbitrum: to choose |
| RPC | Arc: public + Blockdaemon + QuickNode (trial) + Alchemy through the site; BNB: publicnode; Solana: via Relay and engine. No paid redundant RPC for Ethereum/Arbitrum |
| Market data, safety | GeckoTerminal / CoinGecko (key out of credits on 2026-10-01), the engine's own data, honeypot probe |
| DB / cache | Railway Postgres + Redis, Supabase |
| Notifications | Resend email (engine); no web push, no Telegram bot |
| Monitoring | Engine `/metrics` and `/health`; no Sentry or uptime checks |
| Treasury | No multisig. Safe on Arc: unverified |

## 5. Decisions needed

Phase 0 closes when these are approved. Each changes what Phase 1 builds.

- **D1. Wallet provider.** Privy (the pack's default: email/social login, EVM + Solana, hosted export), Circle user
  wallets (Arc's own issuer), Turnkey, or keep the current trading wallet and harden it. Existing trading-wallet users
  need a migration path whichever is chosen: they keep withdraw and export.
- **D2. Platform fee.** The pack says 0.5% flat; ARCDEX charges 2% on spot. The Arc routers change with
  `setFeeBps(50)` from the owner key; Relay and Across fees are app settings.
- **D3. Chains.** The pack's five (adds Ethereum and Arbitrum spot, Solana through Jupiter) versus today's six (with
  Robinhood Chain, Starknet and Hyperliquid). Keeping what works and adding Ethereum and Arbitrum is the least
  disruptive.
- **D4. Treasury and admin.** A Safe multisig as the fee recipient (needs Safe on Arc confirmed, else a temporary
  arrangement), and a separate hardware-wallet address for admin login.
- **D5. Hosting and data.** Proposed: keep Netlify (site), Railway (engine: API, workers, Postgres, Redis) and Supabase
  (social). They match the spec's API + Postgres + Redis + worker shape; moving would cost time and buy nothing yet.

## 6. Decisions (approved by the owner, 2026-10-15)

| | Decision |
|---|---|
| D1 | **Privy** for sign-in and embedded EVM + Solana wallets, export hosted by Privy. Current trading-wallet users keep withdraw and export so they can move over. Arc support to be confirmed with Privy before it ships. |
| D2 | **0.5% everywhere** on spot. The Arc routers change by an owner transaction (`setFeeBps(50)`); Relay and Across fees in code. *Done in code 2026-10-15 (`SPOT_FEE_BPS`); the routers wait for their owners, at `/admin` → Fees.* |
| D3 | **Keep every current chain and add Ethereum and Arbitrum spot.** |
| D4 | **Keep `0x2742…86Bb` for now**, but the fee recipient and the admin allowlist move to environment variables, so a later move to a multisig is a configuration change. *Done 2026-10-15: `VITE_FEE_RECIPIENT_EVM` (site), `FEE_RECIPIENT_EVM` and `ADMIN_EVM_ADDRESSES` (engine).* |
| D5 | Hosting and data as proposed: Netlify, Railway, Supabase. |

## 7. Order of work

1. **Security baseline** (small, no product change): CSP and security headers, CI with typecheck, tests and secret
   scanning, a global and per-chain kill switch on the engine read by every trade path.
2. **Phase 1** per D1: provider login and wallets, the portfolio across chains, hosted export behind step-up,
   withdraw limits, new-address delay and notifications.
3. **Phase 2**: an `ExecutionProvider` interface over the existing venues, the fee level per D2 with the recipient from
   env, an append-only `fee_ledger` with nightly reconciliation, then new chains per D3.
4. **Phase 4** (admin) before Phase 3 polish, since the kill switch and fees need a control surface: nonce login,
   live sessions, fees, trades, audit, flags.

## 8. Phase 1 status (2026-10-15)

| Task (06) | Status |
|---|---|
| Sign-in that provisions EVM + Solana wallets (D1: Privy) | **Done 2026-10-16** behind `privy` (on, offered once `VITE_PRIVY_APP_ID` is set): `src/arcdex/privy/`. Email or social sign-in; Privy makes an EVM and a Solana wallet; the EVM one is the app's connected wallet (wagmi connector `privy`), the Solana one signs as a wallet app would. Arc is passed to Privy as a custom chain (`defaultChain`). Privy's SDK loads only for people who use it. |
| Portfolio card across chains, Arc USDC decimals handled | **Done** behind `walletsCard` (on): `components/WalletsCard.tsx`, `lib/chainBalances.ts`. |
| Hosted key export behind step-up | **Done 2026-10-16:** Privy's own export window (`useExportWallet`, both keys) after a step-up: Privy's two-step code when the account has it, else a sign-in on this tab within 5 minutes. Sends to another address get the same step-up (15 minutes). The trading wallet's export still asks for its passcode (and passkey with 2FA). |
| Withdraw/transfer: validation, confirmation, cooldown/limits, notification | **Done** behind `withdrawLimits` (on): `lib/withdrawPolicy.ts`, `components/WithdrawGuard.tsx`, the review step in `components/CashModals.tsx`. |

Acceptance (06), where it stands:
- "Same EVM address for BNB, Ethereum, Arbitrum and Arc": the card shows one address and marks it as the same on Arc,
  Ethereum, Arbitrum, BNB Chain and Robinhood Chain, with each chain's balance.
- "A new address is delayed or confirmed per policy, limits enforced": a new address takes at most $250 until 24 hours
  after it's saved; at most $2,500 a day leaves for addresses that didn't fund the wallet. Both are checked before
  signing. They are client-side: they slow down someone holding an unlocked browser, and can't stop the key's owner
  (who can export the key). Enforcing them against the key's owner needs the provider's policies (Privy) or a contract
  wallet.
- "Both addresses visible within 5 seconds of sign-in": against a stand-in for Privy's SDK (its servers are out of the
  sandbox's reach), the wallet connected about 0.4 s after the sign-in and both addresses showed on Portfolio within a
  second. With Privy's real servers, wallet creation adds its own time: to check on arcsense.site.
- "Export leaks nothing to our API, logs or analytics": the key is shown only in Privy's window, on Privy's origin;
  ARCDEX's code calls `exportWallet` and never receives a key, and nothing in `src/arcdex/privy` logs.
  `scripts/test-privy.tsx` checks that Privy's SDK is imported by PrivyRoot alone.
- Withdraw limits apply to the trading wallet only; a Privy wallet's sends to other addresses get the step-up instead,
  and Privy's two-step verification is the server-enforced check.

## 9. Phase 2 status (2026-10-15)

| Task (06) | Status |
|---|---|
| `ExecutionProvider` over the venues | **Done:** `lib/execution.ts` (the interface, every provider and its fee listed); Solana swaps choose Jupiter, else Relay. The Arc, Across, four.meme, AVNU and Hyperliquid paths keep their own modules, listed there. |
| Jupiter Swap API V2 with the fee in the transaction | **Done, off until the owner sets the key** (`JUPITER_API_KEY`, `VITE_JUP_REFERRAL_ACCOUNT`). |
| Jito | Not built: Jupiter's `/execute` sends the transaction itself. |
| Guardrails | **Done:** `lib/guardrails.ts`, on every spot path. |
| 0.5% fee (D2) | Done in code; the Arc routers wait for their owners (`setFeeBps(50)`, `/admin` → Fees). |
| `fee_ledger` + nightly reconciliation | **Done:** `engine/src/fees`, `arcdex_fee_ledger` and `arcdex_fee_reconciliations` (append-only), `/v1/fees/summary`, `/admin` → Fee ledger. |
| Ethereum and Arbitrum spot (D3) | **Not built:** Relay's contracts there couldn't be checked from the sandbox. Balances already show on the wallets card. |

Acceptance (06), where it stands:
- "A buy and a sell succeed on each chain": not run with funds. Solana through Jupiter needs the key first; the other
  chains' routes are unchanged since their own checks (AGENTS.md).
- "The fee recipient and amount in the signed transaction match the quote; a tampering test fails safely": Jupiter's
  order and transaction checks require ARCDEX's referral account and fee; Relay, Across and AVNU check theirs.
  `scripts/test-jupiter.ts` and the other chains' tests refuse tampered quotes.
- "Ledger totals equal on-chain receipts": the nightly reconciliation compares them to the unit and alerts on a
  difference.
- "Trades revert below min-out": every route carries a minimum enforced on-chain (Jupiter's `otherAmountThreshold`,
  the routers' minimum out, Relay's and Across's minimum received), and the guardrails refuse a minimum more than
  15% under the quote.
- "The kill switch stops new trades within 1 minute": pages read the switch every 30 seconds and before signing.

## 10. Phase 4 status (2026-10-16)

| Task (06) | Status |
|---|---|
| Signature login (nonce, expiry, replay protection) | **Done:** `engine/src/admin/auth.ts`: EIP-4361 message built by the engine, single-use nonce, 5-minute expiry, the site's origin bound, allowlist from env, 30-minute sessions, audited and alerted. |
| Live Sessions | **Done:** online now, today, in all, by section of the site; WebSocket connections; admins; bots. |
| Fees | **Done:** the routers' fee (on-chain), the fee ledger and its reconciliation, the sweeper's plan and runs. |
| Trades | **Done:** `arcdex_trades` from Supabase (the fee ledger without its key). |
| Audit | **Done:** the append-only `arcdex_admin_audit`. |
| Flags | **Done:** runtime flags; a build-time flag wins; protections only tightened at runtime. |
| Kill switch | Done before (security baseline), now a tab. |
| Claim Platform Fees | **Done as far as the engine can go:** it sends fees bots owe; Relay's and Jupiter's balances are listed for the owner to claim with those keys (the engine holds neither, by design: 04). |
| Daily cron with alerts | **Done:** `SWEEPER_CRON`, dry-run mode, threshold, `arcdex_sweep_runs`, alerts on every real run, failure and pause. |

Acceptance (06):
- "Replayed or expired signatures rejected; non-allowlisted address rejected": tested (`engine/test/admin.test.ts`).
- "Live Sessions matches an independent count within 5%": online is the count of pages that beat in the last 75 seconds.
  Not yet compared with an independent count (Netlify Analytics or a second counter): to do once there's traffic.
- "Sweeper: dry-run output equals real-run totals; second run is a no-op; failure triggers an alert": tested.
- "Every admin action appears in the audit log": sign-ins, sign-outs, the trade switch, flags and real sweeps are
  audited; the routers' fee is changed on-chain by its owner, where the transaction is its own record.

## 11. Phase 5 status (2026-10-16)

| Task (06) | Status |
|---|---|
| Trending and new pairs, including Arc launchpad tokens | Done before: the Trenches (New, Almost bonded, Migrated) on Arc, Robinhood Chain, Solana and BNB Chain, with Arc's launchpads. |
| Token safety card | Done before (`lib/safety.ts`, the Trenches and coin pages); now also **right above Buy on every trade form** (`lib/buyRisk.tsx`), with a tick a Danger coin needs. GeckoTerminal's honeypot flag rates Danger. |
| Referral links and rebates | Links done before (`/r/<name>`, the routers bind the referrer on-chain). **Rebates now in the fee ledger** (`engine/src/fees/referrals.ts`), reconciled nightly. Off Arc there's nothing to split (Relay, Across, Jupiter). |
| Price and activity alerts | Price alerts on Hyperliquid in the browser done before. **Now by web push from the engine** (`engine/src/alerts`): Hyperliquid and Arc price levels, Arc whale trades, delivered with ARCDEX closed. |

Acceptance (06):
- "Risk label shown on every buy path": every trade form (Arc swap and curve, Solana, BNB Chain, Robinhood Chain, paying
  from a Solana wallet) shows the coin's rating above Buy, given by its page; Starknet labels AVNU's verified tokens;
  Portfolio's Sell sheets have no Buy. Checked statically and rendered (`scripts/test-buy-risk.tsx`, in CI), and in
  Chromium.
- "Referral attribution and rebates verified in the ledger": each rebate is a ledger row with its trader, checked each
  night against the routers' events, the payment to the referrer, the share of the fee, the referrer the router holds
  for that trader (`referrerOf`) and the fee wallet's receipt (`engine/test/referrals.test.ts`). Not yet run against
  mainnet: Arc is out of the sandbox's reach; the first nightly run on Railway does it.
- "Alerts delivered within 10 seconds of trigger": the engine keeps each delivery's time from the trigger (the trade's
  block, or the mid's read) to the push service accepting it (`GET /v1/push/stats`). In Chromium against a stand-in
  engine: 1.8 s from a trade's block (most of it the block's own lag, simulated), 0.8–2.3 s from a Hyperliquid move.
  What the push service takes to reach the device isn't measurable from the engine.

