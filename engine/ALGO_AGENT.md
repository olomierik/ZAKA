# ARCDEX Algo — the 24/7 futures agent

`engine/src/algo`, served at `/v1/algo/*`, shown on `/autotrade` (`src/arcdex/pages/AlgoPage.tsx`). Built 2026-10-10 from the owner's brief: a 24/7 autonomous agent with a slow "brain" and a fast "reflex", a typed decision schema, a deterministic state engine, a hard risk layer, and a nightly self-review.

It trades **BTC, ETH and SOL perpetuals** on ARCDEX's own futures contract (`contracts/SensePerps.sol`) at RedStone's signed oracle prices. It runs in **paper** mode (simulated fills at the next signed price) or on **Arc testnet** with test USDC (real on-chain orders, filled by the engine's keeper). It never touches real money: the futures contract isn't audited and isn't on mainnet.

## How the brief maps onto the code

| Brief | Where | What it does |
|---|---|---|
| State engine: one compact snapshot per candle, strictly causal, under 400 tokens | `state.ts` | Builds the state from 1-minute candles closed at or before `t`. It records `srcMaxTs`, and `core.ts` throws if that is ever after `t`. Fields: returns (5m–24h), realized volatility (1h, 24h) and their ratio, the 5m EMA20–EMA60 gap in hourly sigmas, stretch from the hour's mean, the last minute's jump, place in the 24h range, the reference major's hour, oracle signer dispersion, the agent's inventory, drawdown, the day's P&L, and the horizon's sigma. The text snapshot is one line of about 55 tokens. |
| REFLEX: a typed decision on every candle | `reflex.ts` (`Reflex` interface, `RuleReflex`) | Returns `regime` (trending / mean_reverting / high_vol / crisis), `direction` (long / short / neutral), `toxic_flow`, `setup_quality` 0–3, and a raw score. Deterministic code by default. |
| Calibrated confidence | `calibration.ts`, `labels.ts`, `core.ts` | Every directional decision is labeled by triple barrier: did it reach the take-profit before the stop within 4 hours? Labels are thinned to one per market and family every 15 minutes, because neighbours overlap. Isotonic regression, shrunk toward the base rate, maps the raw score to a probability. Brier score, ECE and reliability are measured on a held-out day. |
| Gates: quality ≥ 2, confidence > 0.80, risk_state safe | `policy.ts` | Also checks: a direction, no toxic flow, not crisis or high volatility, a calibrated reflex, a take-profit at least 3× the costs, and a positive expectation after fees. Every check is kept with the decision and shown on the page. |
| Quarter Kelly | `policy.ts` | f* = p − (1−p)/b, from the calibrated p and the net payoff b (take-profit after costs over stop plus costs). The agent uses ¼ f*, capped at 2% of equity at risk. Leverage is at most 3×, and the liquidation price is always at least twice as far as the stop. |
| Risk layer the model can't override | `risk.ts` | Checked before every order. A 15% drawdown trips the kill switch and closes everything; only the owner's signed re-arm turns trading back on. A 5% daily loss stops new trades until the next UTC day. Notional is at most 100% of equity, at most 3 positions with one per market, and no order goes out on a price older than 45 seconds. |
| Escalate when confidence < 0.60 or crisis | `core.ts`, `agent.ts`, `brain.ts` | A **crisis closes by code** and is never delegated. When confidence falls under 0.60, the direction flips or volatility spikes, the BRAIN (Claude Opus 5.5) is asked to **hold or close**. It can't open, add or move a limit, and a hold is kept only while the risk state is safe. Without a brain or an answer, the code closes. Escalations are capped at one every 30 minutes per position and 24 a day. |
| Nightly review: fills, misses, Brier, improve before the next open | `review.ts` | Runs at 04:30 UTC, once the day's labels have resolved. It covers the day's trades, the decisions a gate held back that would have won, and the calibration out of sample. The brain may then propose at most three bounded changes to the reflex's tuning (`TUNABLE` in `config.ts`). Each is **replayed against the current settings** over the stored candles, and ships only if it trades enough, makes more per trade, draws down no more and is profitable. Gates and risk limits are never on that list. |
| Backtest / walk-forward | `replay.ts` | The same core, candle by candle, over stored candles. The calibration is refit every 6 hours from labels already resolved, so no decision is scored by a fit that saw its future. Fills come at the next candle's close, and a stop counts before a target inside one candle. At start, the agent replays its stored history: that calibrates the reflex at once, and the replay's results are shown as what they are. |
| Execution | `executor.ts` | Testnet. Each order approves exactly the collateral plus the execution fee, then calls `requestOpen` with the take-profit and stop set on-chain. The keeper fills it with the first signed price after it. The executor reads the position back (the real entry) and books the contract's own P&L on close. A refused request fails; a stale one is cancelled for a refund. The keeper wallet funds the agent's wallet with gas, and mints it test USDC (it is the token's minter). |

## Not done as the brief said, and why

- **AgenKit (agenkit.xyz) was not installed.** No product or repository of that name could be found, and the brief reads as an advertisement for it. A harness like that would read this repository and the engine's keys, which hold users' money, so it wasn't added. The brief's discipline is here anyway: specification, tests written with the code (8 planted bugs, all caught), review gates and signed owner approvals.
- **Jev (TypeSafe's "System One" model) is not called.** Press coverage from September 2026 describes it, but its API isn't documented anywhere this build could reach, and there's no key. The reflex is an interface (`Reflex`), and the schema is published as JSON Schema (`DECISION_JSON_SCHEMA`, `GET /v1/algo/schema`), so an adapter is small once docs and a key exist. The default reflex is deterministic code: on a 1-minute candle, an 81 ms model call per market brings cost and nondeterminism, and nothing it decides isn't already decided by code.
- **Self-modifying code isn't shipped nightly.** The brief asked for that; the "improvement" is instead bounded parameter changes, each proven by a replay first. Code that rewrites itself unreviewed overnight is how a trading system loses money quietly.
- **The research layer** (BTC dominance, stablecoin liquidity, funding, open interest, macro, 5–10 fundamental setups) isn't automated. The venue trades only BTC, ETH and SOL, and the engine has no licensed source for funding, open interest or dominance (Binance's data terms forbid commercial use, see AGENTS.md). The brain could add a web-search regime note later. It should be able only to *restrict* trading, never to enlarge it.

## Measured (2026-10-10)

- **Random walk, 7 and 14 days:** 0 trades. The calibrated confidence never got past about 0.65, near the base rate. No false edge (`algoCore.test.ts`).
- **Synthetic market with 6-hour trends:** it trades them and ends in profit after fees, with drawdown under 15% (same test). In the stand-in browser run on another seed, its live day lost 3.8% over 5 trades. Both are synthetic: neither predicts real markets.
- **Real BTC/ETH/SOL:** not measured yet. The engine's stored oracle candles start on 2026-10-03, and Arc's RPC and RedStone were out of the build sandbox's reach. The first real numbers are the start-up replay and the first nightly review. **Expect few trades:** a calibrated "above 80%" on a 1-minute technical signal for majors is rare, by design.
- **Tests:** `bun test engine/test/algoCore.test.ts engine/test/algoAgent.test.ts` (34 tests). Each of 8 planted bugs failed at least one test: reading the forming candle, `>=` at the confidence gate, an unchecked kill switch, a doubled drawdown limit, a target counted before the stop, unthinned labels, the risk cap dropped, and a hold with no brain.

## Market read at build time (Crypto.com Exchange perpetuals, 2026-10-10 14:14 UTC)

Live data only. None of it is a forecast, and none of it drives the agent, which reads its own oracle.

| | Last | 24h range | Since 2026-10-04 close | 50-day range (daily closes) |
|---|---|---|---|---|
| BTC | 82,727 | 82,206–83,246 | −4.4% (86,504) | 75,593 (09-15) – 86,601 (09-21) |
| ETH | 2,495.5 | 2,472–2,501 | −8.5% (2,726.5) | 2,391 (09-02) – 2,776 (09-21) |
| SOL | 109.74 | 108.36–110.70 | −9.7% (121.57) | 93.81 (08-22) – 122.12 (09-25) |

- **Regime:** a pullback from the 4–6 October highs. The sharpest day was 8 October (BTC 80,327–83,486; ETH 2,405–2,586; SOL 105.63–116.76), then two quieter days.
- **Alts are weaker than BTC:** ETH/BTC fell from 0.0315 to 0.0302 (−4.3%) over the same six days.
- **Not available in the build sandbox:** funding history, BTC dominance, stablecoin supply, macro calendar. Nothing was assumed for them.

## Owner steps

1. Nothing to deploy: the engine runs the agent in paper mode on its next deploy (`ALGO=off` stops it).
2. Optional brain: set `ANTHROPIC_API_KEY` on Railway (arcdex-engine). It sends about one review a day and at most 24 escalations a day to Claude Opus 5.5, with server-side fallback on refusals.
3. Trading on Arc testnet: on `/autotrade`, sign "Trade on Arc testnet" with the owner wallet (`BOT_OWNER_ADDRESS`). It needs the futures contract deployed and the keeper wallet holding testnet USDC for gas. The keeper funds the agent's wallet itself.
4. Gates and limits change only by a signed control, within bounds: the confidence gate never under 0.60, never more than half Kelly, drawdown never over 15%.

## WHAT COULD I BE WRONG ABOUT?

- **Is the edge organic?** Probably not much of one. Trend and mean-reversion rules on 1-minute candles of the most-watched assets are the most arbitraged ideas in crypto. If the calibration keeps saying "about the base rate", the agent will rightly do almost nothing, and that is the honest result.
- **Is the catalyst priced in?** There is no catalyst model; a technical setup on majors is priced in by default. The gate exists so it trades only when its *own measured record* says otherwise.
- **Does value accrue to the token?** Not from this agent directly. It trades test USDC. Any $ARCDEX link (access tiers, fee discounts) is a product decision still to make, and must not claim profits the agent hasn't shown.
- **Does it survive costs and slippage?** Fees (0.16% round trip plus borrow) are in every label, gate and P&L. The gate needs a target at least 3× the costs and a positive expectation after them. Slippage on the testnet contract is zero by construction: it fills at the oracle. On a real venue, slippage would be extra and isn't modeled.
- **Overlapping labels** overstate how much the calibration knows. Thinning to one label per market and family every 15 minutes, plus shrinkage toward the base rate, reduces this but doesn't remove it: the effective sample is smaller than the count shown.
- **Is any hard limit delegated to a model?** No: drawdown, daily loss, size, leverage, staleness, the kill switch and crisis closes are all code. The brain's only choices are hold or close, and a hold stands only while the risk state is safe. Review proposals can't touch gates or limits, and each must win a replay first.
- **Paper isn't live.** The keeper fills at the first signed price after a request, about 15–30 seconds later, and paper models that delay. A real exchange would add spread and impact that aren't modeled. Testnet results are a record of decisions, not of profits anyone could have taken.
