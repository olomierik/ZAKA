# ARCSENSE futures: audit scope

What an auditor needs before ARCSENSE futures go to Arc mainnet. Version 1 runs on Arc testnet with test USDC only.

## In scope

`contracts/SensePerps.sol` (one file, Solidity 0.8.28, via-IR, optimizer 200 runs, EVM paris, OpenZeppelin 5.1.0):

| Contract | Size | Role |
|---|---|---|
| `SensePerps` | 22.8 KB | The USDC pool (an ERC-20 of LP shares, sLP), positions, two-step requests, liquidations, take-profit and stop-loss, fees |
| `SenseOracle` | 4.5 KB | Checks RedStone's signed price packages on-chain: authorised signers, threshold, one timestamp, median |
| `SenseTestUSDC` | 2.3 KB | Testnet only: test USDC with a daily faucet. Never deployed on mainnet |

## How it works

- **Pool as counterparty.** Liquidity providers deposit USDC for sLP. The pool takes every trader's other side: it keeps losses and borrow fees and pays profits.
- **Solvency by reservation.** A position's profit is capped at min(900% of its collateral, its size). That cap is reserved in the pool when the position opens (`totalReserved`). The pool never pays more than a position reserved, and LPs can't withdraw reserved USDC. Invariant: `poolAmount >= totalReserved`.
- **Accounting.** USDC held = `poolAmount + totalCollateral + escrowed`. Internal accounting only, so a donation can't move the share price. 1,000 dead shares are minted on the first deposit.
- **Two-step execution.** A request (open, close, deposit, withdraw) stores `createdAt`. A keeper executes it with signed prices whose timestamp is at or after `createdAt`, at most `maxPriceAge` old, and at most 30 s ahead of the chain clock.
  - Market requests expire after `requestTimeout`; the trader can then cancel for a full refund.
  - Closes and withdrawals the keepers haven't executed after 5 minutes can be executed by anyone, with prices at most 30 s old.
- **Pool valuation.**
  - Deposits are priced at `aumMax`: the pool, minus unrealized trader profits (capped at what each side reserved), plus unrealized trader losses (capped at each side's collateral).
  - Withdrawals are priced at `aumMin`, which leaves out the unrealized losses.
- **Liquidation.** A position is liquidated when collateral + P&L − borrow fee < `liquidationBps` of size + the closing fee. Anyone may liquidate; someone who isn't a keeper must use a price at most 30 s old.
- **Fees.**
  - Opening and closing fees (8 bps each by default, capped at 50) go `platformFeeShareBps` (100% by default) to the fee wallet `0x2742…86Bb`, the rest to the pool.
  - The borrow fee goes to the pool.
  - A flat keeper fee (0.02 USDC) goes to whoever executes a request.
- **Oracle.** RedStone `redstone-primary-prod`: 5 signers, threshold 3. Each package's signed message is keccak256(feedId ‖ value (uint256, 8 decimals) ‖ timestamp (uint48, ms) ‖ uint32(32) ‖ uint24(1)). `v` must be 27/28 and `s` in the low half. The median is taken across the distinct signers. Packages for other feeds are ignored; duplicate or unknown signers revert.

## Trust assumptions (v1)

- **Keepers** are set by the owner. Among valid packages, a keeper picks which one executes a request; the window is bounded as described above. The engine's keeper always uses the first package signed after the request. A malicious keeper could:
  - pick the most adverse valid package within that window;
  - delay executions until requests expire. Traders can then cancel, and exits can be executed by anyone.
- **The owner** can:
  - pause new positions and deposits (never closes, withdrawals or liquidations);
  - set fees, leverage, liquidation margin, borrow rate, open-interest caps and timings, all within hard caps;
  - add markets;
  - change a market's feed only while it has no open interest;
  - change the oracle's signers only through a 2-day timelock (`proposeSigners` / `applySigners`);
  - rescue tokens other than USDC.

  The owner cannot move the pool's, traders' or requests' USDC.
- **Oracle.** RedStone's signers are trusted to sign correct prices. If 3 of the 5 sign a wrong price, positions settle at it.

## Known limitations and questions for the audit

1. **Keeper choice of package.** See above. Consider requiring the first package after `createdAt` (for example, rounding `createdAt` up to RedStone's 10-second grid and requiring that exact timestamp).
2. **No price impact or funding rate.** The only skew controls are open-interest caps and reservation. Large one-sided interest against a small pool is limited only by those caps.
3. **Oracle latency.** Packages arrive at the gateway ~10–20 s after signing. Two-step execution stops trading on prices already seen, but traders may still race CEX moves inside the window between request and execution.
4. **`setMarket` changes apply to open positions.** Closing fee, liquidation margin and borrow rate (from the next accrual) all apply to positions already open. They're capped, but a hostile owner could liquidate marginal positions by raising `liquidationBps` (≤ 5%).
5. **Unbounded loops.** `pendingRequestIds` and `openPositionIds` grow with use. Gas for views and keeper reads grows too; executions are O(1) apart from `_aum`, which loops over markets.
6. **LP share transfers.** Shares are transferable once the sender is 15 minutes past their last deposit (`_update` override).
7. **Licensing.** The oracle check is ARCSENSE's own code for RedStone's public data-package format, not RedStone's BUSL-licensed connector. Confirm RedStone's terms for using its signed data on mainnet.
8. **Mainnet USDC.** Arc's USDC at `0x3600…` is an ERC-20 view of the native balance. The contract assumes 6 decimals (checked in the constructor) and a standard `transferFrom`.

## Tests

- `forge test --match-contract SensePerpsTest`: 45 tests. They cover LP flows and cooldown, every position path (profit, loss, profit cap, borrow fee, liquidation, TP/SL), request expiry and cancellation, limit orders, slippage, pool and open-interest limits, pause, public execution, every oracle rejection (too few, duplicate, unknown, altered, mixed, high-s, none), the median, owner caps, the signer timelock, and real RedStone packages. A 24-step random-sequence fuzz test (run 3,000 times) checks the books after every step. 20 deliberately planted bugs each made at least one test fail.
- `bun test engine/test/perps.test.ts`: the engine's price checks against a real gateway snapshot, the keeper's decisions and the contract's math.
- `bun test engine/test/perpsE2e.test.ts`: on a local anvil chain, the engine deploys the build, seeds the pool, and a trader opens, closes, is liquidated and hits a take-profit, executed by the keeper.
