# The signal engine (`engine/src/quant`)

A meme-coin signal engine for Arc, built into the existing market engine. Every coin of the scored launchpads (Argus by
default) gets a 100-point score from twelve kinds of evidence; three strategies decide what kind of setup it is; a trade
is taken only when the score, safety, exhaustion, distribution, expected value after costs and the risk limits all
agree; positions are managed with a profit-taking ladder, dynamic stops and setup-gone exits. Paper trading runs on live
data from the start. **Live trading is off** and stays off until the live gate passes (below).

Nothing here promises a win rate. Every number in this document was measured, and the measurements are small.

## 1. Architecture assessment (what was there, what was added)

| Need | Already in the codebase | Added |
|---|---|---|
| Arc data | `chain/stream.ts`: WebSocket + getLogs reconcile + backfill, deduped by trade id; adapters for Argus, ARCDEX, Mercuri, SolonPad, Peach, Faze, generic v4 launches; `dex/trades.ts` normalizes every swap (wallet = tx sender, side, USD, price, pool depth, block, timestamp) | — (reused through `EngineObserver`) |
| Token state | `market/engine.ts`, `tokenState.ts`: main pool, depth, supply, 24h stats; Redis hot state | — |
| History | Postgres `arcdex_mkt_trades` (72 h, every trade), `arcdex_mkt_tokens` | page-by-page readers for warm-up and validation (`quant/history.ts`) |
| Safety | `intel/scanner.ts`: launchpad template, bytecode powers (mint, freeze, pause, trading switch, fees, limits, upgrade, drain), proxy, self-destruct, swap hook, honeypot probe with buy/transfer tax and round trip, holders from Transfer logs, bundles, funding clusters, wash trading, creator selling, serial launcher, copycat; `bot/rugGuard.ts`: liquidity pulls, insider/whale dumps, crashes | an adapter (`quant/safety.ts`) adding pool depth for the size, holder concentration, the creator's remaining bag, tax limits |
| Rolling windows | `intel/flow.ts` keeps 3 minutes (`RecentTapes`) or a coin's first 2,000 trades | `quant/tape.ts`: 5s, 15s, 30s, 1m, 3m, 5m, 15m, 1h windows + holders since launch |
| Wallet intelligence | — | `quant/wallets.ts` |
| Execution | `trading/live.ts`: Universal Router buys and sales, pre-flight round trip, simulation before signing, nonces, rebroadcast, deadlines, gas from receipts | `quant/execution.ts`: idempotency keys, per-coin lock, timeout, sales retried at rising slippage, paper fills |
| Owner control | `bot/control.ts`: owner-signed messages (EOA and contract wallets), 5-minute, single use | `verifyText` for the engine's own messages |
| Observability | `log.ts` (JSON lines), `metrics.ts` (counters, rates, latency percentiles, `/metrics`) | engine metrics and latencies (below) |
| Existing strategies | `bot/` (snipe, fast scalp, volume spike, dip rebound; the $2 live plan; visitors' bots) | untouched: the new engine runs beside them |

The existing bot keeps trading exactly as before; the signal engine is an independent, additional system that reuses
the stream, the scanner, the rug guard, the bot wallet's executor, the store and the control channel.

```
Arc ──▶ ChainStream ──▶ TradeParser / adapters ──▶ MarketEngine ──▶ observers
                                                       │              ├─▶ Bot (existing strategies)
                                                       │              └─▶ SignalEngine (engine/src/quant)
                                                       │                    tape ▶ wallets ▶ features ▶ safety ▶ score
                                                       │                    ▶ strategies ▶ gates ▶ EV ▶ size ▶ risk
                                                       │                    ▶ paper book (always) / live orders (gate)
                                                       ▼
                                          Postgres: arcdex_mkt_* (history)   arcdex_sig_* (the engine's records)
```

## 2. Files

| File | What |
|---|---|
| `quant/config.ts` | every setting, defaults, validation, merge (`SIG_CONFIG_JSON`, owner patches) |
| `quant/tape.ts` | per-coin event store: dedupe by trade id, late events re-ordered, rolling windows, buckets, holders |
| `quant/flow.ts` | buy/sell volume and counts, unique buyers/sellers, sizes, large trades, buy pressure, growth, acceleration, organic-flow score |
| `quant/momentum.ts` | price change 5s…1h, higher highs/lows, range and breakout, acceleration, rolling over, volatility expansion/collapse, VWAP distance |
| `quant/liquidity.ts` | price-impact model, max size for an impact, round-trip costs (probe, taxes, fees, gas) |
| `quant/exhaustion.ts` | pump exhaustion 0–100 |
| `quant/distribution.ts` | whale distribution and accumulation 0–100 |
| `quant/wallets.ts` | wallet performance, classes, quality, a coin's smart money, clusters, exits |
| `quant/regime.ts` | market regime |
| `quant/safety.ts` | safety score, risk flags, `trade_allowed` |
| `quant/features.ts` | the full feature set at a moment; the model feature vector |
| `quant/score.ts` | the 100-point score and bands |
| `quant/strategies.ts` | the three strategies, stops and plans |
| `quant/quality.ts` | expected value after costs |
| `quant/sizing.ts` | position size |
| `quant/positions.ts` | exits (pure step function), book statistics |
| `quant/risk.ts` | risk governor and live gate |
| `quant/execution.ts` | paper fills and live orders |
| `quant/engine.ts` | the orchestrator (same code live and in backtests) |
| `quant/labels.ts` | outcome labels for every signal |
| `quant/store.ts` | Postgres / memory store (`engine/sql/20261002000000_signal_engine.sql`) |
| `quant/backtest.ts`, `quant/walkforward.ts` | replay engine, walk-forward validation |
| `quant/history.ts`, `quant/validator.ts`, `quant/validator.worker.ts` | recorded trades, scheduled validation on a worker thread |
| `quant/api.ts`, `api/_quantProtocol.ts` | REST API and shared types; owner controls |
| `quant/boot.ts` | start-up wiring (called from `main.ts`) |
| `scripts/quant-backtest.ts` | backtest / walk-forward CLI |
| `src/arcdex/components/SignalEngine.tsx`, `src/arcdex/api/quant.ts` | the dashboard (/autotrade → Signal engine) |

## 3. Market data (Phase 2)

Event-driven: the engine is an observer of the market engine's trades (no polling of the chain). Per coin of a scored
launchpad it keeps the last hour of trades (`KEEP_MS`) and, since launch, every wallet's position. Windows are read by
binary search over the tape and a walk over the window only. Coins are evaluated on their trades, at most once a second
(`evalEveryMs`), off the trade path (a 250 ms timer). Data available per trade: block number, log index, block time,
wallet, side, USD, token amount, the main pool's price and depth. Holder changes come from the trades (balances since
launch); liquidity additions and removals are inferred from the pool depth each swap reports (the engine doesn't ingest
`ModifyLiquidity` logs); taxes come from the scanner's probe.

## 4. Safety (Phase 3)

`assessSafety` returns `safety_score` (0–100), `risk_flags[]`, `trade_allowed`. **Critical** (no buy, whatever the
score): any hard scanner check failed or not yet answered (honeypot, owner powers, proxy, self-destruct, dangerous hook,
bundle, funding clusters, wash trading, launchpad template), no scan yet, a rug-guard alarm in the last 30 minutes, a
round trip over `gates.maxRoundTripPct` (12%), pool depth under `gates.minLiquidityUsd`, the planned size moving the
price over `gates.maxPriceImpactPct`, a creator who sold part of their buy and still holds the rest, a score under
`gates.minSafetyScore`. **Flags**: risk checks (holders, serial launcher, copycat), high costs, concentrated holders,
the creator's bag, `creator-exited`. On Argus the creator usually sells out in the first minute (58 of 181 coins
measured); a creator with nothing left to dump is a flag, not a rejection (the scanner's 30-point penalty is given back).

## 5. Signal formula (Phases 4–11)

Each component is a 0–1 reading × its weight (`weights`; they must add up to 100). `ramp(x, a, b)` is 0 at a, 1 at b.

| Component (weight) | Formula |
|---|---|
| Flow (20) | [7·ramp(bp₁ₘ, .5, .75) + 3·ramp(bp₅ₘ, .5, .7) + 6·organic + 2·ramp(buyerGrowth, 1, 2) + 2·ramp(largeImbalance, 0, .6)] / 20 |
| Momentum (15) | [#up of 15s/30s/1m/3m/5m (0–5) + min(5, higherHighs + .67·higherLows + 2·breakout) + 2·ramp(accel, 1, 2) + 3·ramp(pc₁ₘ, 1%, 8%) − 4·rollingOver] / 15 |
| Volume (15) | [6·ramp(vol₁ₘ / (vol₅ₘ/5), 1, 3) + 3·ramp(vol₅ₘ / (vol₁₅ₘ/3), 1, 2) + 2·ramp(txAccel, 1, 2.5) + 4·ramp(vol₅ₘ/liquidity, .05, .5)] / 15 |
| Liquidity (15) | [6·ramp(log₁₀ liq, log₁₀ minLiq, log₁₀ 50k) + 4·(1 − ramp(impact%, .5, maxImpact)) + 2·ramp(liq/mcap, .05, .3) + 3·ramp(Δliq₁₅ₘ, −20%, 0)] / 15 |
| Smart money (10) | [6·ramp(smartCount, 0, 3) + 3·avgQuality + 1·cluster − 5·ramp(smartExits, 0, 2)] / 10 |
| Holders (10) | [3·ramp(holders, 20, 300) + 3·(1 − ramp(top10%, 20, 60)) + 2·(1 − ramp(creator%, 2, 15)) + 2·ramp(holderGrowth₅ₘ, 0, 20%)] / 10 |
| Safety (10) | safety_score / 100 |
| Regime (5) | BULLISH 1, NEUTRAL .6, HIGH_VOLATILITY .4, BEARISH .2, LIQUIDITY_STRESSED 0 |

**Distribution** takes 10·ramp(distribution, 40, 70) points off and **invalidates** at 70. **Exhaustion** over
`gates.maxExhaustion` (65) blocks an entry whatever the score. Bands (`bands`): under 50 no trade, 50 watch, 65 weak,
75 trade candidate, 85 high conviction. The bar to trade is `max(strategy.minScore, gates.minSignalScore) +
regimeAdjust[regime]`: **60 by default**, because on 3.6 days of Argus trades scores clustered at 55–68 and the
walk-forward chose 55–60 (§ 9); the owner can raise it.

* buy_pressure = buy volume / (buy + sell volume); organic = .4·ramp(buyers₅ₘ, 3, 40) + .3·(1 − ramp(top5 share, .4, .9)) + .3·(1 − ramp(HHI, .1, .5)) (so $100k from 5 wallets ≈ 0.1, from 300 ≈ 1).
* exhaustion = 25 extension + 15 parabolic + 15 buying fading + 15 buyers flat + 10 large sellers + 10 volatility expansion + 10 one-way tape.
* distribution = 25 top holders selling + 20 coordinated large sellers + 15 large-wallet exits + 15 rising sell share + 15 depth falling + 10 repeated large sells; accumulation = 30 large-trade imbalance + 25 top holders adding + 25 new buyers + 20 rising buy pressure.
* Smart money: a wallet's closed positions across coins (no look-ahead: only trades closed before the moment). SMART_MONEY needs ≥ 5 closed trades over ≥ 3 coins, win rate ≥ 55%, profit factor ≥ 1.5, a positive median return, ≥ $20 realized, and ≤ 40 coins a day (else it's a bot: SCALPER). Size is never a criterion.
* Regime from every active coin over 15 minutes: stressed when ≥ 35% have a liquidity-pull alarm or lost half their depth; high volatility over 12%/min median; bullish when ≥ 55% of the volume is in rising coins and the median is ≥ +2%; bearish mirrored.

## 6. Strategies (Phase 12)

Each can be switched off and tuned on its own (`strategies.<id>`), with its own exits (`strategies.<id>.exits`).

* **early_momentum**: ≤ 30 min old, ≥ $5k liquidity, buy pressure ≥ 60% (1m), volume ≥ 1.5× its 5-minute pace, ≥ 5 buyers in the last minute and not fewer than the minute before, organic flow ≥ 0.5, top 10 ≤ 50%, exhaustion ≤ 60. Smart money optional (`noSmartMoneyPenalty` to require it).
* **breakout**: ≥ 30 min old, a 15-minute range ≤ 25% wide, price ≥ 0.5% over its high, volume ≥ 2×, buy pressure ≥ 58%, up on 1m and 5m and not rolling over, ≥ $8k liquidity, distribution ≤ 40, exhaustion ≤ 55.
* **smart_money**: ≥ 2 smart wallets bought within 5 minutes, none selling, ≤ +30% since the first one's entry, ≥ $5k liquidity, buy pressure ≥ 55%, exhaustion ≤ 60.

Every signal has `strategy_name`, `signal_score`, `confidence`, `entry_reason[]`, `risk_flags[]`,
`recommended_entry` (price, max slippage), `recommended_stop` (price, %), `recommended_targets[]`, `position_size`,
plus `why_signal_triggered`, `why_trade_allowed`, `why_trade_rejected`, the score components, the trade-quality
numbers and the feature values. Confidence = .55·ramp(score, candidate − 10, 100) + .25·data completeness + .2·the
strategy's recent profit factor.

## 7. Trade quality, execution, exits, sizing (Phases 13–15)

**Expected value** (`quality.ts`): costs = the probe's round trip (fees + hook and token taxes; else 2 × 1% fee) +
price impact in and out for the size + 2 × gas. EV% = (n·record + k·(prior − costs)) / (n + k): the strategy's last
50 net returns blended with a prior (50% win, +18% average win, the loss at most min(8%, stop)) weighted as 20 trades.
No order under 1.5% and $0.05 expected. Paper explores: until a strategy has 20 trades in the book, any non-negative EV
is taken there (never live).

**Execution**: paper and backtests fill at the first price ≥ 2.5 s after the order (sales 2 s after their trigger),
skip a buy that drifted > 5%, pay impact, fee, taxes and gas. Live: the bot wallet's executor (shared with the existing
bot, so one nonce sequence), max slippage from `execution.buySlippageBps` capped by `risk.maxSlippagePct`, a pre-flight
round trip under `gates.maxRoundTripPct`, a timeout (`orderTimeoutMs`), sales retried at 8 / 15 / 30 / 60%,
idempotency keys (a repeated order returns the first one's result), one order per coin at a time, a timed-out buy
reconciled from the wallet's balance, every step an execution event. Kill switch: no new buys, every open position sold.

**Exits** (`exits`, per strategy overridable; a pure step function): emergency (rug alarm, kill switch) → liquidity down
25% from entry or its 15-minute high → distribution ≥ 75 → the stop (2.5 × volatility per minute, 6–20%) → targets
**+12% sell 20%, +25% sell 25%, +50% sell 25%**, the rest trailing → break-even after the first target → trailing
3 × volatility (10–30%) once two targets are hit or +35% → momentum gone (buying faded, under the 1-minute VWAP, falling
on 30s and 1m; after 2 minutes) → 60 minutes at most, out at 10 minutes if never up 3%.

**Size**: risk 1% of equity over (stop + round trip), × (0.5 + 0.5·confidence), × 0.5–1 by the strategy's recent
profit factor, capped by the pool (2% impact), $50 a position, and 30% portfolio exposure; under $2 it isn't traded.

## 8. Risk controls (Phase 22) and the live gate

All in `risk` / `gates` / `sizing`, changeable by the owner's signed patch: global trading on/off, paper on/off, live
on/off (**off**), kill switch, max daily loss (paper $100, live $20), max position ($50), max exposure (30%), max
concurrent positions (5), max slippage (8%), min liquidity ($5k), min score (60), min safety (60), max exhaustion (65),
one position per coin.

**Live orders need all of** (`/v1/quant/status` → `liveGate`): `SIG_LIVE_ALLOWED=1` on the engine; `risk.liveEnabled`
switched on by the owner's signature; a bot wallet; a walk-forward run under 48 h old with ≥ 30 out-of-sample trades,
profit factor ≥ 1.2, expectancy ≥ 0.5% a trade and drawdown ≤ 25%; and the paper book over ≥ 2 days and ≥ 30 trades
passing the same bars.

## 9. Backtesting and walk-forward (Phases 17–18)

The backtester replays trades in chain order through the same `SignalEngine` (no look-ahead: features, wallet records
and the regime only see the past; a test checks that signals up to a moment don't change when later data is added).
A replay can't run the scanner's on-chain checks: Argus coins are taken as standard code with no probe tax and
independent funding; bundles, wash trading, the creator, holders and the rug guard come from the trades.

```bash
bun engine/scripts/quant-backtest.ts --api https://arcdex-engine-production.up.railway.app --hours 48 --save-tapes ./tapes
bun engine/scripts/quant-backtest.ts --tapes ./tapes --why
bun engine/scripts/quant-backtest.ts --tapes ./tapes --walkforward --folds 3 --out wf.json
bun engine/scripts/quant-backtest.ts --tapes ./tapes --config '{"gates":{"minSignalScore":65}}'
```

The report: trades, win rate, profit factor, gross profit and loss, net, average trade, winner and loser, max
drawdown, expectancy, average hold, target hit rates, stop-loss rate, and the same by strategy, score range, token
age, liquidity and regime. In the engine, the validator runs the walk-forward on the last 48 h of recorded trades
every 12 h on a worker thread (and when the owner asks), stores it, and the live gate reads its out-of-sample result.

**Measured (2026-10-01, 190 Argus coins, 199,854 trades, 3.6 days):**
* bar 50 (exploration): 55 trades, 47% won, PF 1.25, +3.8% a trade, max DD 5%; smart money +12.2% (16 trades), breakout +0.9% (17), early momentum −0.1% (22).
* walk-forward (3 folds, grid: bar 55–75 × momentum exit on/off): out of sample 23 trades, 39% won, PF 1.26, +7.4% a trade, net +$22 on $1,000, max DD 2.6%. Fold by fold: −2.3%, +84.6% (3 trades, one large winner), −8.8%. **Inconclusive**: too few trades, and the average rests on one trade. The live gate would refuse live on this (fewer than 30 out-of-sample trades).

## 10. Paper trading (Phase 19)

On by default, from the engine's start: live data, simulated fills as above, never a transaction. Results:
`/v1/quant/status` (stats by strategy), `/v1/quant/positions?mode=paper`, the dashboard (arcdex.online/autotrade →
Signal engine). Starting equity $1,000 virtual (`sizing.paperEquityUsd`).

## 11. Model preparation (Phase 20)

Every signal stores its feature vector (`VECTOR_FIELDS` + tax, slippage, signal score, regime) and all feature values
(`arcdex_sig_signal_features`); 60 minutes later its outcome labels (`arcdex_sig_signal_outcomes`): +10% before −5%,
+20% before −10%, max return, max drawdown, return at 5/15/60 min. `GET /v1/quant/dataset?since=&limit=` (Bearer
`METRICS_TOKEN` when set) returns both, joined. No model is in the loop; when one is, it adds to the deterministic rules
and risk controls, never replaces them.

## 12. APIs

`GET /v1/quant/status | signals | signals/:id | radar | positions | wallets | events | validations | dataset`,
`POST /v1/quant/control` (`settings` patch + note, `kill` on/off, `validate`), signed by `BOT_OWNER_ADDRESS`
(`api/_quantProtocol.ts quantControlMessage`). Details in `quant/api.ts`.

## 13. Observability (Phase 23)

Structured logs (`quant signal`, refusals, validation, warm-up). Metrics (`/metrics`): `quant_trades`,
`quant_duplicate_events`, `quant_evals`, `quant_evals_skipped`, `quant_signals`, `quant_signals_traded`,
`quant_signals_rejected`, `quant_reject_<reason>`, `quant_duplicate_signals`, `quant_duplicate_orders`,
`quant_closed_<book>`, `quant_eval_errors`, `quant_control_refused`; gauges `quant_regime`, `quant_stale_sec` (seconds
since the last trade), `quant_tapes`, `quant_wallets`, `quant_open`; latencies `quant_data_latency` (block → engine),
`quant_eval_ms`, `quant_signal_ms`, `quant_validation_ms` (plus the market engine's `block_to_publish`). RPC failures
and failed swaps are the executor's and the stream's existing logs and counters; risk and execution events are stored.

## 14. Environment (Railway, arcdex-engine)

| Variable | Default | |
|---|---|---|
| `SIG_ENGINE` | on | `off` doesn't start it |
| `SIG_LAUNCHPADS` | `ARGUS` | launchpads whose coins are scored |
| `SIG_CONFIG_JSON` | — | settings over the defaults at start (the owner's saved version wins unless `SIG_CONFIG_RESET=1`) |
| `SIG_LIVE_ALLOWED` | off | `1` lets live orders happen at all (still needs the owner's switch and the gate) |
| `SIG_WARM_HOURS` | 48 | warm-up from recorded trades |
| `SIG_VALIDATE_HOURS` / `SIG_VALIDATE_EVERY_HOURS` | 48 / 12 | validation span and interval (0: only on request) |
| `BOT_OWNER_ADDRESS`, `BOT_PRIVATE_KEY`, `DATABASE_URL`, `METRICS_TOKEN` | existing | owner controls, bot wallet, store, dataset auth |

No new external dependency (Bun's SQL client and viem, as before).

## 15. Limitations

* Small samples: 3.6 days of trades; the defaults are starting points. The validator and the paper book are the check.
* Backtests can't replay the scanner's on-chain checks (code, hook, probe, funding); live they run for real.
* Pool depth is the swap-reported depth around the price, treated as a constant-product pool; concentrated liquidity can differ.
* Liquidity adds/removals are inferred from depth, not read from `ModifyLiquidity` logs.
* Holders are rebuilt from swaps (transfers between wallets aren't seen); the scanner's Transfer-log holders are used for safety.
* A live partial sale that fails isn't retried as that target (the stop and trail still manage the rest).
* Signals are deduplicated per coin and strategy for 10 minutes; a signal that becomes tradeable within that time is still recorded.
* The live wallet is the existing bot wallet: the existing bot and this engine share its USDC.

## 16. Before enabling live

1. Let paper trade for at least 2 days and 30 trades; read the results by strategy on the dashboard.
2. Check the latest walk-forward run (Validation & live gate): ≥ 30 out-of-sample trades, PF ≥ 1.2, expectancy ≥ 0.5%, drawdown ≤ 25%. Adjust the settings (bar, strategies, exits) with a signed patch if the folds agree on a change; never on one run.
3. Decide the live limits: `risk.maxDailyLossUsd.live`, `sizing.maxPositionUsd`, `risk.maxConcurrent`; fund the bot wallet only with what may be lost.
4. Set `SIG_LIVE_ALLOWED=1` on Railway (arcdex-engine) and redeploy.
5. Switch live on with the owner's signed patch `{"risk":{"liveEnabled":true}}`; watch the first trades and the execution events; the kill switch sells everything at once.
