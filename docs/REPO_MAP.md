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
| Arc | ArcDexSwapRouter (v3/v4), ArcDexCurveRouter (Mercuri, SolonPad curves), Uniswap Universal Router (native-USDC pools) | `components/ArgusSwapWidget.tsx`, `api/argusMarket.ts`, `api/curves.ts`, `api/universalRouter.ts` | 2% on-chain (`feeBps` 200, owner-settable, cap 2%) |
| Arc | ArcLaunchpad curve | `components/CurveSwapWidget.tsx` | 1% + creator tax (immutable contract) |
| Robinhood Chain | Across, from Arc USDC | `lib/acrossQuote.ts`, `components/RobinhoodTrade.tsx` | 2% (Across app fee) |
| Solana | Relay (SOL, Solana USDC or Arc USDC) | `lib/relayQuote.ts`, `components/SolanaTrade.tsx` | 2% (Relay app fee) |
| BNB Chain | four.meme curve, Relay | `lib/fourMeme.ts`, `components/BscTrade.tsx` | 2% |
| Starknet | AVNU | `src/arcdex/starknet/` | `VITE_STARKNET_FEE_BPS` (default 0) |
| Hyperliquid | Hyperliquid API, signed in the browser | `src/arcdex/hl/` | builder fee (`VITE_HL_BUILDER_*`); trading behind `VITE_HL_TRADING` |
| Bridge | Circle CCTP v2 (Bridge Kit) | `lib/bridgeKit.ts` | 0.5% (90% to the platform) |

Every fee goes to the EOA `0x2742…86Bb`. Quotes from Relay and Across are checked before signing (recipient, amounts,
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
| 0.5% flat fee, in the trade | 2% spot, 1% launchpad, 0.5% bridge | Fee level differs; in-trade capture exists on every venue |
| Fee recipient: treasury multisig from env | EOA `0x2742…86Bb`, hard-coded in several places | No multisig; recipient not from env everywhere |
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
2. **High: no Content-Security-Policy or security headers.** `netlify.toml` sets none (no CSP, HSTS, frame-ancestors,
   Referrer-Policy). With an in-page wallet key, a CSP is the main defence against injected scripts.
3. **High: fees go to a single EOA.** `0x2742…86Bb` receives every fee and is the routers' `feeWallet` (04 §4:
   multisig). 05 also lists it as the admin address; it should not be both.
4. **Medium: no global kill switch.** Pausing needs an owner transaction per router, and Relay/Across/Hyperliquid paths
   have no runtime off switch.
5. **Medium: withdrawals have no limits, new-address delay or notification** (04 §1). The passcode rule stops a stolen
   phone from sending anywhere but the funding wallet, but nothing alerts the user.
6. **Medium: no CI checks.** No tests, typecheck, dependency audit or secret scanning on pull requests (04 §3).
7. **Medium: no append-only audit or fee ledger** (04 §3). Owner actions (bot controls, signal settings) are verified but
   not recorded in an audit table.
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
| Jupiter Swap API V2 | Not integrated (Solana goes through Relay). The npm client `@jup-ag/api` is still 6.0.48 (the legacy Quote V6 era); V2 endpoints and the API-key plan: unverified |
| Jito | Not integrated. Unverified |
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

## 6. Proposed order after approval

1. **Security baseline** (small, no product change): CSP and security headers, CI with typecheck, tests and secret
   scanning, a global and per-chain kill switch on the engine read by every trade path.
2. **Phase 1** per D1: provider login and wallets, the portfolio across chains, hosted export behind step-up,
   withdraw limits, new-address delay and notifications.
3. **Phase 2**: an `ExecutionProvider` interface over the existing venues, the fee level per D2 with the recipient from
   env, an append-only `fee_ledger` with nightly reconciliation, then new chains per D3.
4. **Phase 4** (admin) before Phase 3 polish, since the kill switch and fees need a control surface: nonce login,
   live sessions, fees, trades, audit, flags.
