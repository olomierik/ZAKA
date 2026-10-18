# ARCDEX prediction pool: audit scope

What an auditor needs before the prediction pool holds real money. Version 1 runs on Arc testnet only, with test USDC (the futures' `SenseTestUSDC`). It must not be deployed on mainnet without an independent audit and legal advice on offering prediction markets.

## In scope

`contracts/ArcdexPredictPool.sol` (one file, Solidity 0.8.28, via-IR, optimizer 200 runs, EVM paris, OpenZeppelin 5.x):

| Contract | Size | Role |
|---|---|---|
| `ArcdexPredictPool` | 21.5 KB | Trading balances, two-step requests, positions per (outcome, side), the pool, the payout queue, settlement, fees, staking |
| `ArcdexPredictToken` (tPOOL) | 2.4 KB | Minted by the pool from realised losses; moves only to and from the pool (staking) until the owner turns transfers on, one way |

## The design: papertrade.xyz's, for prediction markets

papertrade.xyz runs this "Martingaler" design for perpetuals on HyperEVM, reading Hyperliquid's book through precompiles (docs.papertrade.xyz and its whitepaper, read 2026-10-17). This pool applies it to Hyperliquid's HIP-4 outcome markets, on Arc:

- **Contracts.** Each outcome has two sides. A contract of side 0 pays `settleFraction` USDC when Hyperliquid settles the outcome, a contract of side 1 pays `1 − settleFraction` (1e6 = $1). Buying `usd` at price `px` gives `usd × 1e6 / px` contracts, rounded down.
- **Two-step trades.** `requestBuy` takes USDC from the trader's balance in the pool; `requestSell` holds contracts. Either is filled by `execute` with a price signed for that outcome and side, strictly after the request's second (`ts > createdAt`), at most `maxPriceAge` (20 s) old, at most 10 s ahead of the chain, and before `requestTimeout` (60 s). A trader can cancel after the timeout for a full refund. A price of 0 ("no price") refunds.
- **Refusals refund, never revert:** past the trader's limit; a buy outside 1–99¢; a side at its open-interest cap; a market halted, paused or settling; contracts already paid out.
- **Closing (a sale, or payout after settlement):**
  - The trader's own money comes back at once, up to the position's value.
  - **Loss:** `trackedLp` rises and tPOOL is minted on the loss. With the queue empty, the loss less `lossFeeBps` becomes free cash (`lpCash`). With the queue non-empty, the whole loss goes to `sideBucket`, earmarked for the queue, and harvests it.
  - **Win:** the profit less `winFeeBps` is owed. With the queue empty, `lpCash` pays what it can and the rest is queued; the fee is paid only if the profit is paid in full and cash remains. With the queue non-empty, everything owed is queued.
- **The queue.** A FIFO of `(user, amount)`. `harvest` (permissionless, and run by every loss) pays the front from `sideBucket` first, then `lpCash`, part-paying the head when cash runs out. When the queue clears, `sideBucket` returns to `lpCash`. Free cash is never spent on a new win while anything is queued.
- **Fees.** Only from the pool's side, and only while nothing is queued: `stakerShareBps` (50%) to stakers, the rest to `feeWallet` (`withdrawDevFees`, permissionless).
- **tPOOL.** 100 per $1 of loss while `trackedLp` is under $2M and the tail high-water mark is 0; then `100 · (S/(S+H))²` (S = $120M, H = the high-water mark of `trackedLp − $2M`, which never falls). Staked tPOOL earns fees through an accumulator (`accRewardPerShare`); fees that arrive with nobody staked wait in `stakerFeeAcc` and go to the next stakers. `pushExcess` sends the pool's gain past `stakerRewardCap` ($5M) to stakers.
- **Settlement.** `proposeSettlement` takes a signed `Settlement(outcome, fraction, ts)` from anyone. The outcome stops trading and pays after `settleDelay` (10 minutes by default, 1 minute to 1 day). Until then the owner can `cancelSettlement`. That halts buys on the outcome, and a later settlement must be signed after the cancellation, so the cancelled one can't be replayed. `redeem` / `redeemMany` pay any holder, called by anyone.
- **Accounting.** Every USDC the contract owes is a tally: `liabilities() = totalBalances + totalPending + totalLocked + lpCash + sideBucket + devFees + stakerFeeAcc + rewardsReserve`, equal to its USDC balance (the tests check this after every step). A donation raises the balance above the tallies and is never spent.

## Trust assumptions (v1)

- **The signer (ARCDEX's engine key) is trusted for every price and every settlement.** Hyperliquid's mids and `settledOutcome` aren't readable on Arc, so the engine reads them (`engine/src/practice/predict.ts`) and signs EIP-712 messages (domain "ARCDEX Predict" v1, chain id, pool address). With that key, someone could:
  - fill any open request at any price within its trader's limit (the default limit is 3% from the mid the page showed);
  - refuse to price requests ("no price" refunds, or silence until the timeout);
  - propose any settlement. The settlement delay and the owner's cancel are the only check, so **someone must watch proposed settlements**: the owner's wallet, or a monitor that compares them with Hyperliquid's `settledOutcome`.

  The key lives on the engine, encrypted under `BOT_WALLET_SECRET` (setting `predict-pool-keeper`). The same key sends the keeper's transactions. Changing the signer takes 2 days (`proposeSigner` / `applySigner`).
- **The keeper's timing.** The engine signs the mid it reads when it prices a request, at the latest block's time. A request can be priced in any second from `createdAt + 1` until near its timeout, and the signer chooses that second. The engine always prices at the first pass after the request.
- **The owner** can:
  - pause buys (sales, settlement, withdrawals and the queue keep working);
  - halt an outcome;
  - set fees (each at most 5%), the stakers' share, open-interest caps, timings (bounded), the fee wallet and the stakers' cap;
  - cancel a pending settlement;
  - turn tPOOL transfers on.

  The owner can't move balances, positions, the pool's cash or the queue.

## Known limitations and questions for the audit

1. **The engine as oracle.** papertrade reads Hyperliquid's book on-chain; Arc can't. A stolen signer key can fill requests at off-market prices within each trader's limit, and propose wrong settlements that the owner must cancel within `settleDelay`. Options: a second, independent signer (m-of-n, as SenseOracle does for RedStone); a bound on the move between consecutive signed prices; a longer settlement delay on mainnet.
2. **Free option inside the request window.** A trader requests at second T; the price is the mid at the engine's next pass, about 1–2 s later. Hyperliquid's own book can be moved, as papertrade's docs warn ("BBO jitter"), and nothing here bounds the profit from moving it. papertrade adds a deadband and a haircut on small wins; this version charges a flat 2% of a win. Open-interest caps (10,000 contracts a side by default) limit the exposure.
3. **No haircut on wins.** papertrade's asymmetric impact curve was left out: prediction prices move in large steps and small wins are rare. Revisit it with data.
4. **Equivalent guard.** `lpCash` is always 0 while the queue is non-empty, because harvest drains it first. So the queue-empty check before paying a win is defense in depth: planting "pay a win ahead of the queue" changed no test, because no reachable state has cash and a queue at once.
5. **Unbounded growth.** The queue array only grows (the head index moves). Each trader's `_keysOf` keeps every side ever held. Views over them grow, but executions are O(1) apart from `harvest` (bounded by `maxEntries`, 32 per trade).
6. **Rounding.** Contracts and proportional costs round down, in the pool's favour. Staking rewards round down; the dust stays in `rewardsReserve`.
7. **Settlement while held for sale.** `redeem` clears a pending sale's hold; the sale then refunds "paid out first" (reason 6) or is cancelled.
8. **Mainnet USDC.** On mainnet the pool would take Arc's USDC (`0x3600…`, an ERC-20 view of native USDC, 6 decimals) with a standard `transferFrom`.
9. **Legal.** Prediction markets and a pool that can owe more than it holds (the queue) need legal advice before real money.

## Tests

- `forge test --match-contract ArcdexPredictPoolTest`: 41 tests, including a 30-step random-sequence fuzz test (256 runs) that checks the books after every step. They cover:
  - fills at the signed mid, limits, decided sides, caps, partial sales;
  - the empty pool queuing the first win, part-paid wins, FIFO payment from later losses, the earmark released when the queue clears, no fees while queued;
  - every signature check (wrong signer, wrong side, altered price, another pool's domain), prices from the request's own second, stale and expired prices, double fills, batches, cancellation;
  - settlement on both sides, split results, the delay, the owner's cancel and replay protection, payouts by anyone;
  - pause and halt, the token lock, staking shares, the mint curve, the excess push, the signer timelock and owner bounds.

  19 of 20 deliberately planted bugs failed at least one test; the 20th is the equivalent guard in item 4.
- `bun test engine/test/predictPool.test.ts`: the keeper's rules (which requests are due, prices, revert names, the typed data against the contract's type strings), the practice book's reads (mids only for listed, open markets; settlement asked only after a market ends, at most once a minute), the service's routes.
- `bun test engine/test/predictPoolE2e.test.ts`: on a local anvil chain, the engine deploys the build with its keeper as signer. Then a buy fills at the mid (not in its own second), the empty pool queues a win and a later loss pays it, a market with no price is refunded, and a settled market is proposed, waits its delay and pays every holder.
