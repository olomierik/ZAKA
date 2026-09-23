# ARCDEX — Implementation Plan

## Summary
ARCDEX is a DexScreener-style trading terminal for Arc mainnet (chain 5042). It aggregates every token launched on Arc launchpads (Argus, ArcPad, Archemist, RadarDex, ArcToolsPad), lets users trade any listed token via a 1%-fee router contract, and shows live price charts, trade history, and portfolio view — all settled in USDC.

## Architecture

- **Blockchain:** Arc mainnet (chain ID 5042) — USDC is native gas, 6-decimal ERC-20 at `0x3600...0000`. Sub-second finality means the trade feed updates live.
- **Contract:** `ArcDexRouter.sol` — fee-taking swap router that wraps Uniswap V3 on Arc mainnet. Takes 1% of every trade, sends it to a configurable fee wallet. Ownable, pausable, fee wallet changeable by owner.
- **Data:** RadarDex public API (`api.radardex.pro`) for token list, prices, volumes, market caps. Arc mainnet RPC via `wss://rpc.mainnet.arc.io` for live trade event streaming.
- **Frontend:** React + Vite + Tailwind + wagmi + ConnectKit configured for Arc mainnet. Dark terminal aesthetic (like ArcTools / DexScreener).
- **Wallet:** MetaMask / any injected wallet via wagmi + ConnectKit on Arc mainnet chain.

## Files to Create/Modify

### Smart Contract
1. `contracts/ArcDexRouter.sol` — Uniswap V3 SwapRouter02 wrapper; takes 1% fee before routing, emits `Trade` event, owner can update fee wallet and fee bps

### Frontend — New
2. `src/arcdex/main.tsx` — separate entry point for ARCDEX (independent from ZAKA)
3. `src/arcdex/wagmi.ts` — wagmi config for Arc mainnet chain 5042
4. `src/arcdex/api/radardex.ts` — RadarDex API client (token list, OHLCV, trades)
5. `src/arcdex/api/rpc.ts` — WebSocket RPC client for live swap event streaming
6. `src/arcdex/pages/Terminal.tsx` — main token table (price, 24h change, volume, mcap, age, launchpad badge)
7. `src/arcdex/pages/TokenPage.tsx` — token detail: chart (lightweight-charts), live trades, holders, swap widget
8. `src/arcdex/pages/Portfolio.tsx` — wallet holdings valued in USDC
9. `src/arcdex/components/SwapWidget.tsx` — buy/sell with 1% fee via ArcDexRouter, shows fee breakdown
10. `src/arcdex/components/NavBar.tsx` — top nav with Connect Wallet, ARCDEX logo, links
11. `src/arcdex/components/TokenTable.tsx` — sortable/filterable table with launchpad source chips
12. `src/arcdex/components/PriceChart.tsx` — TradingView-style chart using `lightweight-charts`
13. `src/arcdex/index.html` — standalone HTML entry for ARCDEX

### Config
14. `vite.config.ts` — add second build entry for `arcdex` alongside existing ZAKA build
15. `.env` — add `VITE_WALLETCONNECT_PROJECT_ID`, `VITE_ARCDEX_FEE_WALLET`, `VITE_ARCDEX_ROUTER_ADDRESS`

## Build Sequence

1. Write and deploy `ArcDexRouter.sol` — Uniswap V3 wrapper with 1% fee, balanced security review, deploy to Arc mainnet, verify on explorer
2. Set up wagmi + ConnectKit for Arc mainnet — chain 5042
3. RadarDex API client — fetch token list, prices, OHLCV candles
4. WebSocket live feed — subscribe to Uniswap V3 `Swap` events on Arc mainnet RPC
5. Terminal page — sortable token table with launchpad source chips
6. Token page — price chart + live trade feed + swap widget
7. Portfolio page — wallet token balances via multicall, valued in USDC
8. SwapWidget — approve USDC → call router → show tx hash + fee breakdown
9. Polish + Vercel deploy

## Done When
- [ ] `ArcDexRouter` deployed and verified on Arc mainnet explorer
- [ ] Terminal table loads tokens from all Arc launchpads (Argus, ArcPad, Archemist, RadarDex)
- [ ] Prices, 24h change, volume update live from RadarDex API
- [ ] Clicking a token opens its page with price chart and live trade feed
- [ ] Swap executes a real trade on Arc mainnet via the router
- [ ] 1% fee deducted and sent to fee wallet on every trade (verifiable onchain)
- [ ] Portfolio shows connected wallet token balances valued in USDC
- [ ] WalletConnect + MetaMask work with Arc mainnet chain switching
- [ ] Deployed to Vercel at a separate URL from ZAKA

## Blockers (need from user before building)
- [ ] WalletConnect Project ID (free at cloud.walletconnect.com)
- [ ] Fee wallet address (0x mainnet wallet for 1% fee collection)
- [ ] "confirmed mainnet" acknowledgement
