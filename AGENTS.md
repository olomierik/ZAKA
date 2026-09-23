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

### ArcLaunchpad
Self-contained bonding-curve launchpad — no separate LaunchToken deploy needed, `createToken()` deploys each token itself. See `contracts/ArcLaunchpad.sol` for full design notes (why graduation doesn't migrate to an external Uniswap pool, why anti-snipe/anti-bundle are USDC-denominated not token-%-based).
- **Status:** written, 28/28 tests passing (incl. 10,000-run fuzz on `testFuzz_buySellNeverBreaksInvariants`) via `forge test --match-contract ArcLaunchpadTest`. **Not yet deployed anywhere** — no testnet or mainnet address yet.
- **Deploy:** `scripts/deploy-launchpad.sh` with your own wallet — bytecode is in `contracts/out/ArcLaunchpad.sol/ArcLaunchpad.json`. Defaults `PLATFORM_FEE_WALLET` to `0x274262A0321A0701b0A46a3576e07aE881c286Bb` (same wallet as `ArcDexRouter`'s fees) — override the env var if you ever want fees going elsewhere.
  - Constructor args: `(YOUR_OWNER_WALLET, 0x274262A0321A0701b0A46a3576e07aE881c286Bb)`
- **Fees — two additive layers, paid directly out of every trade, no accrual:**
  - 5% of each token's 1B supply → `platformFeeWallet` at creation (95% seeds the curve). No flat USDC creation fee.
  - Platform swap fee: fixed 1%, always, 100% to `platformFeeWallet`.
  - Creator tax: 0-3%, the creator's choice, fixed forever once launched — 60% straight to the creator's wallet, 40% to `platformFeeWallet`.
  - Worst case total per trade: 4%.
- **Buyback-and-burn is manual and off-contract, by design** — there is no on-chain treasury. To buy back the platform's own token: launch it through the UI like any other token, then from `platformFeeWallet` call `buy()` on ArcLaunchpad, then call `burn(amount)` on the token itself (`LaunchToken` is `ERC20Burnable`).
- **Anti-rug / anti-bot, all enforced on-chain:**
  - Anti-snipe: buys capped at $2,000/tx for the first 10 minutes after launch (`SNIPE_MAX_BUY_USDC`, `SNIPE_WINDOW_SECONDS`).
  - Anti-bundle: total buys capped at $5,000/block across ALL wallets (`MAX_USDC_PER_BLOCK`) — this is what actually stops multi-wallet bundlers, since per-wallet caps alone don't.
  - Anti-bot: `buy`/`sell`/`createToken` require `msg.sender == tx.origin`, blocking any contract-mediated call. This stops contract-based sniper/wash-trading bots specifically — it cannot stop a human wash-trading by hand across several of their own real wallets, and the contract's own doc comment says so rather than overclaiming.
  - No emergency-withdrawal function of any kind — real reserves have no path out except a user's own `sell`.
- $25,000 real-USDC graduation threshold — a status flag only; the same curve prices every trade before and after it, so there's no migration step and no price discontinuity.
- After deploying: set `VITE_ARC_LAUNCHPAD_ADDRESS`. Once the platform's own token is launched and burns have started, set `VITE_ARC_PLATFORM_TOKEN_ADDRESS` to power the burn ticker.

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
