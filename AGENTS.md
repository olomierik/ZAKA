# ZAKA + ARCDEX

> Built with Arc Studio - money-powered apps in minutes

Two apps in this repo:
- **ZAKA** — USDC mobile wallet for African markets (send, receive, withdraw to mobile money)
- **ARCDEX** — DexScreener-style DEX terminal for Arc mainnet (token terminal, swap, portfolio)

---

## Deployed Contracts

### ArcDexRouter
- **Arc Testnet:** `0xefa4f596da0c2acfcba47b43389be26e96912516`
  - Explorer: https://explorer.testnet.arc.io/address/0xefa4f596da0c2acfcba47b43389be26e96912516
  - TX: `0x0e8f992af5eb26fd5a0e6ca49480381c78f24aac38435bd51f9041b5045c7198`
- **Arc Mainnet:** deploy using `scripts/deploy-mainnet.sh` with your own wallet — bytecode is in `contracts/out/ArcDexRouter.sol/ArcDexRouter.json`
  - Constructor args: `(0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45, 0x274262A0321A0701b0A46a3576e07aE881c286Bb, YOUR_OWNER_WALLET)`

## What This App Does

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
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
