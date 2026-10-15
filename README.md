# ARCDEX

A multichain trading terminal at [arcsense.site](https://arcsense.site), laid out as motion.gift's: the Trenches (New, Almost bonded and Migrated coins, live) on Arc, Robinhood Chain, Solana and BNB Chain; spot on those and Starknet; futures and prediction markets on Hyperliquid; a bridge; paper trading and price alerts. Wallets sign in the browser; ARCDEX never holds a key.

This file is the map. `AGENTS.md` is the detailed record: each feature, why it is the way it is, how it was checked, and what the owner still has to do.

## Architecture

```
Browser: React SPA (Vite). Wallets sign here: EVM (wagmi/viem), Solana, Starknet wallet API
 ├─ static files ────────────► Netlify, arcsense.site
 │                               edge: /geo (country), /across (Across API key), crawler-only page heads, /sitemap.xml
 ├─ live data, site API ─────► Market engine (Bun, Railway): Arc ingest, prices, candles, WebSocket, the read
 │                               functions in api/* (/api/argus, /api/gecko, …), writes for sign-in and social
 ├─ social data ─────────────► Supabase (Postgres with RLS; reads with the anon key, writes through the engine)
 └─ trading, straight from the browser:
      Arc RPC .................. ARCDEX swap and curve routers, Uniswap's Universal Router
      Relay, Across, Circle CCTP  cross-chain trades and the bridge (every quote checked before signing)
      Hyperliquid API + socket .. futures and predictions
      AVNU + Starknet RPC ....... Starknet swaps
```

| Path | What |
|---|---|
| `src/arcdex/` | The app: `pages/`, `components/`, `lib/`, `api/` (client data), `hl/` (Hyperliquid), `starknet/` (Starknet) |
| `src/arcdex/landing/` | The old home page, now at `/about` (`/` opens the Trenches), a separate small bundle |
| `api/` | The site's functions, served by the engine at `/api/*` |
| `engine/` | The market engine (its own `README.md`) |
| `contracts/` | Solidity (Foundry): swap and curve routers, launchpad, testnet futures |
| `netlify/edge-functions/` | The edge functions above |
| `supabase/migrations/` | Database migrations, run by the owner in Supabase's SQL editor |
| `scripts/` | Tests (`test-*`), live checks (`check-*`, `sim-*`) and tools |

## Setup

```bash
bun install
```

```bash
bun run dev
```

For the live engine in local dev, put `VITE_ARCDEX_WS_URL=ws://localhost:5173/__engine/ws` in `.env.development.local` (gitignored); `vite.config.ts` proxies it to Railway. The engine itself runs with `bun run engine` and its own environment (`engine/README.md`).

## Environment

Public values (`VITE_*`) ship inside the page. Secrets live in Netlify or Railway only, never in the page or the repository.

**Netlify build (`netlify.toml` and site settings):**

| Variable | Purpose |
|---|---|
| `VITE_ARCDEX_WS_URL` | The engine's WebSocket; its REST base is derived from it |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Supabase reads (public, RLS) |
| `VITE_ARC_LAUNCHPAD_ADDRESS`, `VITE_ARCDEX_SWAP_ROUTER_ADDRESS`, `VITE_ARCDEX_CURVE_ROUTER_ADDRESS` | ARCDEX's contracts on Arc |
| `VITE_ARC_RPC_URL`, `VITE_ARC_WSS_URL` | Optional dedicated Arc RPC (keep the socket off: billed per event) |
| `VITE_WC_PROJECT_ID` | WalletConnect (phone wallets by QR code) |
| `VITE_ACROSS_INTEGRATOR_ID` | Across integrator id |
| `VITE_HL_NETWORK`, `VITE_HL_BUILDER_PERP`, `VITE_HL_BUILDER_OUTCOME` | Hyperliquid network and ARCDEX's builder fees |

**Switches, off unless the owner turns them on:**

| Variable | Turns on |
|---|---|
| `VITE_HL_TRADING=on` | Orders, deposits and withdrawals on Hyperliquid |
| `VITE_STARKNET_SWAPS=on` | Sending Starknet swaps |
| `VITE_STARKNET_FEE_RECIPIENT`, `VITE_STARKNET_FEE_BPS` | ARCDEX's fee on Starknet swaps (a Starknet address, 1–200 bps) |

**Netlify secrets (edge functions):** `ACROSS_API_KEY`, `ACROSS_INTEGRATOR_ID`.

**Railway, service arcdex-engine:**

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | The engine's Postgres and Redis |
| `SUPABASE_SECRET_KEY` | Social writes, uploads, the holder index |
| `ARCDEX_SESSION_SECRET` | Wallet sign-in tokens (32+ characters) |
| `WS_ALLOWED_ORIGINS`, `TRUST_PROXY`, `LOG_LEVEL` | Origins, proxy headers, logging |
| `COINGECKO_API_KEY` | Optional GeckoTerminal key (dedicated rate limit) |
| `AUTOTRADE_PAUSED` | On by default: bots open no new trades |
| `ADMIN_EVM_ADDRESSES` | Admin wallets (comma-separated) that may sign the trade switch at `/admin`; the owner (`BOT_OWNER_ADDRESS`) if unset |
| `GLOBAL_KILL_SWITCH=true`, `KILL_SWITCH_VENUES` | Turn trading off everywhere, or on listed venues (`arc,solana,…`), without a wallet; only removing them turns it back on |
| `BOT_*`, `BOT_WALLET_SECRET`, `AUTH_SECRET` | Autotrade (paused) |
| `PERPS`, `SITE_API`, `SIGNALS_LAUNCHPAD_ONLY`, `TIERS_*` | Engine features (see `engine/README.md`) |

## Tests and checks

```bash
bun run check
```

`bun run check` runs what CI runs on every pull request (`.github/workflows/ci.yml`): the site and engine typechecks, the security-header check (`scripts/check-csp.ts`), the engine tests and, when `gitleaks` is installed, the secret scan. One at a time:

```bash
bun run typecheck
```

```bash
bun run engine:test
```

```bash
forge test
```

Offline tests run on recorded answers: `bun scripts/test-<name>.ts`. Among them are `test-trenches`, `test-rpc-settings`, `test-paper`, `test-alerts`, `test-starknet`, `test-hyperliquid`, `test-routes`, `test-robinhood`, `test-solana`, `test-bsc`, `test-xsol`, `test-dex-parity`, `test-chunk-reload`, `test-withdraw-guard`, `test-wallet-2fa` and `test-trade-switch`.

Live checks touch real networks and send nothing. They use `eth_call` / `simulateTransactions` with state overrides, or quotes only:
- `check-avnu`, `check-hyperliquid` (needs `VITE_HL_TRADING=on`), `check-rh-swaps`, `check-solana-sale`.
- `sim-robinhood`, `sim-four`, `sim-swap-router.mjs`, `sim-curve-router.mjs`.

## Deployment

- **Site:** every push to `main` is built by Netlify (`bun run build`) and published to arcsense.site; arcdex.online redirects there.
- **Engine:** Railway builds `engine/Dockerfile` from `main` when a watched file changes (`railway.toml`'s `watchPatterns`, copied into the service's Watch Paths). If a push doesn't deploy, use Railway → arcdex-engine → Deployments → Deploy latest commit.
- **Database:** new files in `supabase/migrations/` are run by the owner in Supabase's SQL editor, in order.
- **Contracts:** each deploy script names its steps in `AGENTS.md` ("Deployed Contracts"); contract addresses then go into the variables above.

## Rollback

- **Site:** Netlify → Deploys → an earlier deploy → Publish deploy (instant). Or `git revert <commit>` and push.
- **Engine:** Railway → Deployments → Redeploy the last one that worked (it rebuilds that commit).
- **Trading:** the trade switch at `/admin` (an admin wallet signs) stops new trades everywhere or on one venue within a minute, with no deploy; `GLOBAL_KILL_SWITCH=true` on Railway does it without a wallet.
- **A feature:** turn its switch off (`VITE_HL_TRADING`, `VITE_STARKNET_SWAPS`, `AUTOTRADE_PAUSED`) and redeploy.
- Pages left open across a deploy reload themselves to the new version (`lib/chunkReload.ts`).
- **The terminal layout (2026-10-12):** it replaced the Markets pages and the Binance-style theme in one commit; `git revert` it to bring them back.

## Provider limits

| Provider | Limit |
|---|---|
| Hyperliquid | By the visitor's own IP (request weights); the leaderboard file is read by the engine at most every 10 minutes |
| AVNU | 300 requests / 5 minutes without a key |
| GeckoTerminal (free) | About 5 calls before 429 per IP; the engine meters its own to 25 a minute |
| Across | Strict limits without `ACROSS_API_KEY` |
| Relay, Circle CCTP | Public APIs; quotes are rechecked right before signing |
| Public RPCs | PublicNode, dRPC, ZAN, Blockdaemon, Beam; each chain's reads go through its nodes in order and the next answers when one throttles (`lib/rpcSettings.ts`; visitors can test them and put a faster one first) |
| QuickNode (Arc) | Trial credits; when they run out the public endpoints answer |

## Known risks

- **Leveraged futures, prediction markets and stock tokens:** take legal advice. The location gates (Hyperliquid, Robinhood stock tokens) are a minimum, not clearance, and can be bypassed.
- **Third-party contracts:** ARCDEX checks every quote and transaction against what was asked (exact approvals, recipients, minimums, fees), but trades still run through Relay, Across, Circle, AVNU, Hyperliquid and the DEXes' contracts.
- **In the browser:** the trading wallet's key is encrypted by its passcode (and passkey with 2FA on). Paper trading and price alerts live in that browser only.
- **Infrastructure:** the engine is one Railway service, and pages fall back to reading the chain when it's away. Railway stopped deploying pushes automatically on 2026-10-05 (see Deployment).
- **Testnet futures:** the `SensePerps` contract is unaudited and runs on Arc testnet only (`contracts/AUDIT-SensePerps.md`).
