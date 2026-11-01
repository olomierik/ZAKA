# BTC 5-minute and 15-minute predictions: an autotrader, researched (2026-10-31)

The owner asked for "a better auto trading engine for prediction markets, specifically for BTC 15min and 5min on my
predict page", built on what successful traders and bots do, and "a strategy that can guarantee scalping on Polymarket
for 70% and above", with a recommendation on which approach to take. This is the research, what was measured, and the
recommendation. No code that trades was written: the build plan at the end waits for the owner's choice.

## The short answer

- **Nothing can guarantee a profit or a 70% win rate**, and a bot sold as doing so should be treated as a scam. A win
  rate also isn't profit: buying the favourite at 92¢ wins 90% of the time and still loses money if the true chance is
  90%.
- **Calling the direction at the start of a window is a coin flip.** Over 22 months of 1-minute BTC prices, no simple
  rule called a 5- or 15-minute window better than 51.7%. Polymarket's taker fee needs 51.75% at 50¢ to break even.
- **What does work is pricing the window while it runs.** A fair value built from how far BTC has moved since the
  window's start price, its recent volatility and the time left is accurate to within a few points. When BTC moves,
  Polymarket's book lags. On the one day of recorded order books available (2026-06-15), a bot that bought only when its
  fair value beat the ask by 12¢ won 58–68% of its trades and ended **+9% to +50% on the money staked after fees**, if it
  reacted within 1 second. At 3 seconds the edge was gone. That day predates the 60-second TWAP settlement and the 150 ms
  taker delay Polymarket added in August and September, so it has to be re-measured on today's markets before any money
  goes in.
- **Recommendation:** a fair-value "sniper" on the engine, trading only when its calibrated probability beats the price
  plus fees by a safety margin, with late-window favourites priced on the TWAP rules as a second lane. Paper-trade it
  against the live Polymarket book first, with the measured latency, the 150 ms delay and real fees; go live with the
  owner's own small wallet only if two weeks of paper results hold. Market making comes later, if ever: it is where
  professional firms earn, and naive quoting lost 8–11% in the replay.

## 1. What was measured

| Data | Span | Where |
|---|---|---|
| Bitstamp BTC/USD 1-minute candles | 2025-01-07 → 2026-10-31, 953,446 minutes | github.com/ff137/bitstamp-btcusd-minute-data |
| Windows built from them (any window touching a zero-volume minute left out) | 51,968 of 15 minutes, 158,375 of 5 minutes | `scripts/research-btc-updown.ts` |
| Polymarket's recorded order books: every book update and trade of every BTC 5m and 15m market, with outcomes and Binance's trade tape | 2026-06-15, 288 + 96 markets (384 replayed) | Marketlens free sample, github.com/marketlenstrade/polymarket-historical-data |
| The replay | the same day | `scripts/research-polymarket-books.mjs` |

Both scripts run offline and touch no market. "Up" means the price at the end is at or above the price at the start.
Bitstamp isn't the resolution source (Chainlink is, section 5), so the 22-month numbers describe BTC, not settlement.

## 2. The direction at the start: a coin flip

Hit rate of each rule over every window (50% means no edge; ± is a 95% interval):

| Rule | 15-minute | 5-minute |
|---|---|---|
| Same as the previous window | 48.5% ± 0.4% | 49.6% ± 0.2% |
| Last 60 minutes up → Up | 48.3% ± 0.4% | 48.9% ± 0.2% |
| Last 5 minutes up → Up | 49.1% ± 0.4% | 49.6% ± 0.2% |
| Last minute up → Up | 50.3% ± 0.4% | 49.8% ± 0.2% |

Up won 50.0% of 15-minute and 50.4% of 5-minute windows. The momentum rules lose slightly, so the reverse rule (bet
against the last hour) wins about 51.7% on 15-minute windows, the same in 2025 and 2026. That matches published
research, which finds 50–53% directional accuracy at these horizons, and is below the 51.75% a taker needs at 50¢. **A bot
that tries to predict the window from its start can't reach 70%, or even break even after fees.**

## 3. Inside the window: the fair value is accurate

The fair value is P(Up) = F(ln(S/S0) / (σ · √minutes left)), with σ the last 60 one-minute returns' volatility and F a
fat-tailed distribution (Student-t, 4 degrees of freedom, scaled to unit variance). Brier scores (0.25 is a coin flip;
lower is better):

| Minute of 15 | 3 | 6 | 9 | 12 | 13 | 14 |
|---|---|---|---|---|---|---|
| Normal | 0.2152 | 0.1807 | 0.1396 | 0.0924 | 0.0735 | 0.0489 |
| Student-t(4) | 0.2161 | 0.1810 | 0.1390 | 0.0913 | 0.0723 | 0.0477 |

The side that's ahead wins far more often late in the window, and about as often as the fair value says:

| 15-minute window, 1 minute left (t(4) fair value of the side ahead) | Windows | Mean fair value | Won |
|---|---|---|---|
| 0.60–0.70 | 2,303 | 0.652 | 69.2% |
| 0.80–0.90 | 4,747 | 0.856 | 88.6% |
| 0.90–0.95 | 4,675 | 0.928 | 94.4% |
| 0.95–0.98 | 6,350 | 0.968 | 97.4% |
| 0.98–1.00 | 28,839 | 0.995 | 99.6% |

Overall the side ahead with 1 minute left won 93.9% of 15-minute and 86.9% of 5-minute windows. The fair value moves fast
late in a window: from minute 12 to 13 of a 15-minute window it changes by 2.7¢ at the median and 20.7¢ at the 90th
percentile; in a 5-minute window by 9.9¢ and 33.9¢. **A quote a few seconds old can be far from the price**, which is the
opening a fast bot uses, and the risk a slow one takes.

## 4. Against Polymarket's real order books (2026-06-15)

**The market is about as accurate as the model.** Brier scores of the market mid against the fair value, sampled every 10
seconds:

| Seconds left | 5m market | 5m fair value | 15m market | 15m fair value |
|---|---|---|---|---|
| 0–60 | 0.0922 | 0.1066 | 0.0913 | 0.0791 |
| 60–180 | 0.1422 | 0.1407 | 0.0855 | 0.0778 |
| 180+ | 0.2099 | 0.2101 | 0.1691 | 0.1684 |

So the edge isn't a better model; it's **moments when the book hasn't caught up**.

**Taker on fair value** (buy the side whose ask is below the fair value by the margin; $25 or whatever the best level
holds, at most every 15 s, up to $250 a market; "latency" is the time from Binance's price to the book the order meets):

| Window | Latency | Margin | Fills | Staked | Won | Gross | After fees |
|---|---|---|---|---|---|---|---|
| 5m | 250 ms | 8¢ | 1,555 | $28,302 | 60.5% | +9.4% | +6.3% |
| 5m | 250 ms | 12¢ | 835 | $13,893 | 62.4% | +18.2% | +14.9% |
| 5m | 1 s | 8¢ | 1,775 | $33,705 | 56.3% | +2.6% | −0.7% |
| 5m | 1 s | 12¢ | 974 | $17,181 | 58.3% | +12.5% | +9.2% |
| 15m | 250 ms | 8¢ | 699 | $10,676 | 61.7% | +21.5% | +18.3% |
| 15m | 250 ms | 12¢ | 255 | $3,447 | 67.5% | +53.7% | +50.3% |
| 15m | 1 s | 8¢ | 777 | $12,657 | 58.4% | +16.3% | +12.9% |
| 15m | 1 s | 12¢ | 314 | $4,656 | 64.6% | +45.2% | +41.9% |

- With one entry per market, 3 seconds of latency left almost nothing (5m: −0.8% to +2.5% gross; 15m: −0.5% to +15.8%).
- Every 6-hour block of the day was positive for the 12¢ versions, from +1% to +106%: real, but uneven.
- **Small amounts:** at the first signal the best level held $13 (5m) and $5 (15m) at the median; the repeated version
  put about $35 into a typical market. On this day the 12¢ versions turned over $14k (5m) and $3–5k (15m), for about
  $1.6–2.1k after fees each, before any competition for the same levels. This is a small, fast business, not a way to
  deploy large money.

**Late favourite** (buy the side ahead at its ask, whatever the price):

| Window | When | Trades | Won | Paid | After fees |
|---|---|---|---|---|---|
| 5m | 120 s before the close | 281 | 80.1% | 0.766 | +3.5% |
| 5m | 30 s | 188 | 87.8% | 0.833 | +7.0% |
| 15m | 120 s | 65 | 92.3% | 0.860 | +8.5% |
| 15m | 30 s | 39 | 89.7% | 0.866 | +3.6% |

This is the "70%+ win rate" strategy people sell. On that day it made a few percent. One loss costs as much as 5–9 wins,
and **Binance's price pointed the wrong way at the close in 8 of 384 markets (2.1%)**, because Polymarket settles on
Chainlink, not Binance (section 5).

**Naive market making** (rest bids on both sides at the fair value ± 2–7¢, filled when a trade printed through the
quote, held to the end): −8% to −11% on $17k–$101k traded. Fills come exactly when the price moves against the quote.
Makers who earn on Polymarket cancel in milliseconds and collect the 20% rebate (section 5); a bot on the engine can't
match that at first.

## 5. Polymarket's rules for these markets (as of October 2026)

From Polymarket's documentation (changelog, fees page, real-time data docs), read on 2026-10-31:

- **Settlement:** Chainlink Data Streams BTC/USD. Since 2026-08-07 the start price ("price to beat") and the end price
  are both **60-second TWAPs** of that feed (5-minute markets used 30 s until 2026-08-14). A tie resolves Up.
- **Fees:** takers pay `C · 0.07 · p · (1 − p)` per share for crypto: 1.75¢ at 50¢ (3.5% of the stake), 0.63¢ at 90¢.
  Makers pay nothing and get a 20% rebate. The rate has changed before, so read each market's `feeSchedule` at run time.
- **Taker delay:** 150 ms on crypto markets since 2026-09-04 (it was 250 ms, then 50 ms from 2026-08-17).
- **Taker break-even:** to buy at p you need a true probability of at least p · (1 + 0.07 · (1 − p)): 51.75% at 50¢,
  81.1% at 80¢, 90.6% at 90¢, 95.3% at 95¢.

What the TWAP changes for the model:

- **The start price is the average of the minute before the window opens**, not the price at the open, so the fair price
  at the open isn't 50¢: it typically sits between about 40¢ and 60¢.
- **Inside the last minute, the uncertainty shrinks with τ^1.5**, not √τ, because part of the average is already
  observed. With 10 seconds left it is about a tenth of what a spot-price model says. A spot-only model underprices
  favourites in the last minute: that is a real edge for a bot that does the TWAP maths, and a trap for one that
  doesn't.
- **Manipulation:** before the TWAP, pushes on exchanges in the final seconds flipped near-even 5-minute windows 65% of
  the time, and 821 wallets made $8.2M, 93% of it from retail (Dai, Jia & Yu, "Settlement Manipulation in Prediction
  Markets", 2026). The TWAP was the response: a push now moves the settlement only in proportion to how long it is held.

Mechanics the bot needs (Polymarket's docs unless marked "reported"):

- **Markets:** a 15-minute BTC market every 15 minutes (live since 2025-10-20) and a 5-minute one every 5 minutes
  (since 2026-02-12), back to back. Slugs are `btc-updown-15m-<unix start>` and `btc-updown-5m-<unix start>`; 15m
  markets are listed about a day ahead. The token ids come from `GET gamma-api.polymarket.com/events?slug=<slug>`
  (`clobTokenIds`, reported by developers), and `getClobMarketInfo(conditionId)` gives the tick, the minimum order
  and the fee parameters. One recent 15m window traded $22,887.
- **Orders (CLOB V2, since 2026-04-28):** `@polymarket/clob-client-v2` (1.2.0 on npm, 2026-09-25). GTC and GTD rest;
  FOK and FAK take; post-only rests or is refused. A heartbeat every 5 s is required, or all the key's orders are
  cancelled after 10 s. Collateral is pUSD on Polygon, wrapped from USDC.e. Accounts made since 2026-05-04 default to
  the deposit-wallet signature type (3).
- **Streams:** the market WebSocket (`wss://ws-subscriptions-clob.polymarket.com/ws/market`: book, price changes, last
  trade with its fee, new and resolved markets). Reference prices moved to PolyBolt (`wss://ws-live-v2.polymarket.com/ws`,
  needs CLOB API credentials): `price.crypto` (Chainlink) and **`price.crypto.twap`, the 60-second Chainlink TWAP the
  markets settle on**. It has no Binance feed, so Binance comes straight from Binance.
- **Servers:** AWS eu-west-2 (London). Co-location there is offered to market makers and own-account traders after
  KYC, not to builder apps.
- **Eligibility:** orders are checked by the IP that sends them (`GET polymarket.com/api/geoblock`). **The US and the
  UK are close-only**, so a bot running from a US cloud region or from London can't open positions. Ireland and the
  Netherlands are restricted on the website only, not the API. **Tanzania, Kenya, Uganda, Rwanda, Zambia, Nigeria and
  South Africa aren't restricted**; Burundi, the CAR, DR Congo, Ethiopia, Libya, Somalia, South Sudan, Sudan and
  Zimbabwe are. A VPN to get around this breaks the terms. No rule against bots was found; manipulation, wash trading
  and spoofing are banned.
- **Builder code:** a builder fee of up to 1% (taker) can be added to orders placed through ARCDEX, but Polymarket can
  revoke builder fees earned on "automated, self-referred" trading, so the bot's own orders shouldn't carry it.
- **Alternatives:** Kalshi has a 15-minute BTC market (KXBTC15M) on the same fee curve but no 5-minute one (reported).
  Hyperliquid's HIP-4 is reported to have added recurring short BTC outcomes (15m and shorter); the markets ARCDEX
  recorded on 2026-10-11 ran a day, so this is worth re-checking in phase 1.

## 6. What the successful traders and bots did

From on-chain studies, Polymarket profiles (through third-party trackers), papers and press, with the evidence
level for each. Polymarket profile "Total PnL" is before taker fees.

| Who | Result | What it did | Evidence |
|---|---|---|---|
| 0x8dxd, the "$313 → $400k" bot | $313 in Dec 2025 → ~$438k by 2026-01-06, ~$2.2–2.4M later; then **stopped** after the rule changes | Called latency arbitrage by most outlets; one chain teardown says 94% of its trades bought both sides (a market maker). Its "98% win rate" is marketing: a wallet that buys both sides has no meaningful win rate | Profile snapshots on-chain; strategy disputed |
| gabagool22 | $813–858k on ~$144M volume: **0.6% of volume**, 50–60% win rate | Builds Up and Down legs at different moments until their average costs add to under $1 (e.g. $0.966 a pair); a leg that never fills leaves a bet | Aggregators, on-chain; strategy inferred |
| Every 15m wallet, one week (Feb 2026, Telonex) | 46,945 wallets; **36.8% profitable**, median −$3. Makers as a group +$728k while winning only 47% of fills; takers won 53% and lost the same $728k | — | On-chain, reproducible notebook |
| Every BTC 5m/15m wallet, 28 days (Sep–Oct 2026, polymtradebot, a bot vendor) | 2,500 always-on bots (4.7% of wallets, 69.7% of volume): +$1.13M before fees, −$2.48M taker fees, +$1.55M rebates = **+$190k on $328M** (0.06%). 32% of bots profitable. The top bot made $104k, **$84k of it rebates**. 786 bots won 70%+ of their windows and **69% of those lost money**. One market maker lost $561k | — | On-chain with a disclosed method; conflict of interest |
| @a4385 (XRP 15m, Jan 2026) | ~$233k net on $6.2k of cost | Bought Up cheaply from market-making bots, then pushed the spot price before the close: manipulation, now blunted by the TWAP | CoinDesk |

By strategy:

- **Latency arbitrage (taking stale quotes):** worked in the fee-free weeks (Dec 2025 – early Jan 2026). Polymarket
  added taker fees (2026-01-05, then 0.07 · p(1−p) from 2026-03-30) and taker delays to stop it. Measured since:
  Polymarket's quotes move a median 347 ms after a 5 bp Binance move, the top of book is usually one tick wide, and a
  43-feature model fed Binance order flow **did not beat Polymarket's own mid** out of sample (OpenMarket preprint,
  arXiv 2607.26245). In September 2026 taker buys lost money after fees in every price bucket (polymtradebot).
- **Complete sets (both sides for under $1):** simultaneous mispricings are rare and raced. What survives is legged pair
  building, at 0.2–0.6% of volume, with leg risk (one developer netted $2 on 176 trades after two half-filled windows
  cost $41.50).
- **Market making with rebates:** the strongest evidence of a lasting positive return: bots that take under 10% of their
  fills were profitable 49% of the time against 26% for pure takers. But maker buys were at break-even before rebates,
  so **the rebates are the profit**, the losses are fat-tailed (−$561k, −$140k), and Polymarket sets the rebate share.
- **Late favourites (90–99¢):** zero to negative after fees. With 2 minutes left and a 10–15 bp lead the leader won
  97.8%, below the 98.14% a taker needs at 98¢; a live test buying 80–99¢ in the last minute lost 37.8%.
- **Momentum and reversal:** after two same-direction 15m windows the next reversed 53.1% of the time, worth 0.35¢ a
  share to a taker (nothing) and up to 3.1¢ to a maker.
- **Scams:** fake "Polymarket bots" on GitHub and npm have stolen wallet keys (a hijacked GitHub organisation from
  2026-02, 30+ malicious npm packages such as `clob-client-math`, a DPRK-attributed package). Bots for sale at $29–$899
  show only self-reported records. Only Polymarket's own `@polymarket/*` packages should be installed, pinned exactly.

**What this means for the 70% target:** a 70% win rate is easy (buy favourites) and says nothing about profit. The
profitable operators win about 47% of fills (makers, Telonex) to 50–60% of windows (gabagool22). Judge the bot on profit
per dollar after fees and rebates, its calibration, and a hard daily loss stop.

**How this squares with section 4:** the June replay found stale quotes worth taking at a 12¢ margin within a second.
The wallet studies say takers lose on average and the best-known latency bot stopped. Both can be true: the replay only
takes the largest gaps, but it is one day, before the TWAP and the 150 ms delay, and it can't see other bots racing for
the same quote. **The edge has to be measured on today's book before money goes in.**

## 7. The recommended approach

| Approach | Win rate to expect | Return to expect | Verdict |
|---|---|---|---|
| Predict the window from its start (momentum, reversal, indicators) | 50–53% | below the fee | **No** |
| Late favourites, bought at the ask | 80–95% | zero to negative; rare losses cost 5–20 wins | **No**, except the TWAP lock-in below |
| Fair-value sniper: take only quotes the calibrated model beats by fee + margin | 55–68% (June replay) | June: +9% to +50% of the stake after fees at ≤1 s; today unknown | **Yes, measured first** |
| TWAP lock-in: in the last 60 s, buy the side the observed average already decides, only below the TWAP fair value minus fees | 95%+ | thin, small size | **Yes, second lane** |
| Maker: post-only quotes around fair value, cancelled fast, plus rebates | ~47% of fills | 0.1–0.6% of volume for the best; fat-tailed losses | **Later**, once latency is measured |

**Recommended: one engine, fair value first, two taker lanes, paper before money.**

1. **The model is the product.** Price every BTC 5m and 15m window continuously with the TWAP-correct fair value:
   Chainlink nowcast from fast exchange feeds plus a rolling basis, volatility from a short EWMA of 1-second returns
   scaled by time of day, a fat-tailed distribution, then calibrated on Polymarket's own resolutions (isotonic, per
   time-left bucket; the Algo engine's `engine/src/algo/calibration.ts` already does this). Show it on `/predict` for
   everyone: model probability against the market, and the edge after fees. That alone is a feature no other front end
   has.
2. **Lane A, the sniper:** take an ask only when model probability − (ask + fee) ≥ a margin of at least twice the
   model's out-of-sample calibration error (start at 8–12¢), with the top level's size as the cap. Stay out between 40¢
   and 60¢ unless the margin is large (the fee is highest there), outside the last 60 s unless lane B applies, and around
   scheduled US data releases.
3. **Lane B, the TWAP lock-in:** inside the last 60 s, buy only when the observed part of the average makes the outcome
   near-certain and the price is still below the TWAP fair value minus the fee.
4. **Size** at 0.1–0.25 of Kelly on the all-in cost, capped per window and across overlapping 5m and 15m windows.
5. **Paper first, against the live book:** every decision executed in simulation after the measured latency plus the
   150 ms taker delay, at the book as it then was, with the real fee. Two weeks and at least 300 independent windows.
   Go live only if both weeks are positive after fees and the model's Brier score is at or below the market's.
6. **Live with the owner's own wallet first**, small ($5–$25 an order, a $50 daily loss stop), then raise limits only
   on the live record. Users' money comes last and only after the legal and custody questions in section 10.

Why not market making first: it is where the documented money is, but only with millisecond cancels, size for rebate
tiers, and tolerance for −$100k-class days. The June replay's naive version lost 8–11%. It becomes lane C once the
sniper's paper record shows the engine's real latency to Polymarket.

## 8. Build plan

`/predict` today shows Hyperliquid's prediction markets (HIP-4), with Practice and a testnet pool. Hyperliquid's BTC
outcomes recorded on 2026-10-11 ran a day (shorter ones are reported since; phase 1 checks), so these windows come
from Polymarket. Everything new runs on
the engine (Railway), beside the Algo agent, and reuses its pieces: calibration, the risk layer's pattern, signed owner
controls, the keeper-wallet vault.

| Phase | What | Files | Done when |
|---|---|---|---|
| 1. See it | Discover the current and next BTC 5m and 15m markets; stream their books and trades, Chainlink BTC/USD and Binance; the TWAP-correct fair value, calibrated on resolutions; a "BTC 5m · 15m" tab on `/predict` with the price to beat, live BTC, model vs market and the edge after fees | `engine/src/updown/{markets,feeds,fair,store,api}.ts`, `api/_updownProtocol.ts`, `src/arcdex/components/UpDownPanel.tsx`, `pages/PredictPage.tsx`, dictionaries | The tab shows every live window with its model price; the model's Brier score is tracked against the market's; the engine's latency to Polymarket and its geoblock status are shown |
| 2. Paper | Lanes A and B traded in simulation against the live book: measured latency + the 150 ms delay, real fees, size capped by the top level; the risk layer; results on the tab and `/autotrade` | `engine/src/updown/{strategy,paper,risk}.ts`, tests in `engine/test/updown*.test.ts` | Two weeks, 300+ windows, positive after fees in both weeks |
| 3. Live, owner only | Orders through Polymarket's official client (`@polymarket/clob-client-v2`, pinned exactly) from a wallet the engine holds (encrypted under `BOT_WALLET_SECRET`, like the keepers), funded with pUSD on Polygon; post-only and fill-and-kill orders with client ids; fills reconciled from the user channel; the kill switch cancels everything | `engine/src/updown/live.ts`, signed controls in `api.ts` | Live results match paper within the latency the engine measures |
| 4. Lane C (maker) | Post-only quotes around fair value with inventory skew and fast cancels; rebates tracked | `engine/src/updown/maker.ts` | Paper-positive including adverse selection |
| 5. Users | Practice for everyone (virtual USDC, as the HIP-4 practice book); real money only after the decisions in section 10 | — | Owner's decision |

Rules the engine keeps whatever the strategy says (server-side, deterministic, as the build pack requires):

- Off by default (`UPDOWN=paper` the default; `live` only by the owner's signed control), with a kill switch.
- Per-order cap, per-window and per-day caps, a daily loss stop, and exposure counted across overlapping windows.
- No order when the Polymarket book is over 500 ms old, Binance over 1 s, Chainlink over 2 s, or when Binance and
  Chainlink disagree by more than 10 bp; pause after repeated rejects or an unexplained balance change.
- Each market's fee schedule, tick, minimum size and settlement rules read at run time; anything unrecognised pauses
  that market.
- No model, the Algo agent's brain included, can place an order: it can only restrict.

## 8b. Exits: selling before the result (2026-11-01)

Lane A's entries replayed on every BTC 5m and 15m book of 2026-06-15 (`scripts/research-polymarket-scalp.mjs`), each
position closed by one exit rule; taker fee on sales too. Return on the stake:

| Exit | 5m, 250 ms | 5m, 1 s | 15m, 250 ms | 15m, 1 s |
|---|---|---|---|---|
| Hold to the result | 25.7% | 22.2% | 11.8% | 18.5% |
| Sell when the bid nets the model's value | 14.2% | 14.7% | 34.7% | 37.7% |
| … only when it nets 5¢ more, plus a 15¢ stop | 24.2% | 22.7% | 34.9% | 41.1% |
| … the model's value, plus a 15¢ stop | 15.4% | 15.9% | 35.1% | 37.8% |
| Fixed target +3¢ at the bid | 8.4% | 9.0% | 20.2% | 24.4% |
| Maker ask at cost + 3¢ | 8.9% | 7.6% | 17.5% | 19.1% |

Built: 15m sells at the model's value, 5m only into a 5¢ overpayment, both with the 15¢ stop. On 15m the sale won about
80% of trades with half the swing per trade, and was positive in both halves of the day (holding lost 21% in one).

## 9. What could be wrong

- **One day of order books.** The replay's 15m results rest on about 70 markets (fills within a market share one
  outcome), so "64.6% won" is roughly ±11 points. The 5m results rest on about 240 markets. A second recorded day, or the
  paper phase, is needed before trusting either.
- **The rules have changed since June:** the TWAP settlement (Aug), the 150 ms taker delay (Sep), and rebate tiers
  (May). Each was aimed at exactly this kind of bot. The edge today may be much smaller or gone.
- **Competition isn't in the replay.** A quote still in the recorded book a second later was there for everyone; a
  faster bot may take it first.
- **The price feed isn't the settlement feed.** Binance disagreed with Polymarket's result in 2.1% of the June markets;
  the Chainlink price sits about −2.45 bp from Binance's mid and drifts ±1.4–2.2 bp within a window.
- **Win rate misleads.** A rule that wins 90% can lose money, and one that wins 55% can make it. The dashboard shows
  expectancy, calibration and P&L after fees first.
- **Platform risk.** Polymarket changes fees, delays, rebates and settlement often; the bot must read each market's
  rules at run time and pause on anything it doesn't recognise.
- **Security.** The bot holds a key that can spend. Malicious "Polymarket bot" packages have stolen keys; only
  Polymarket's own packages, pinned, and a wallet holding only what the bot may lose.

## 10. Decisions for the owner

1. **Approach:** fair value first with the sniper and TWAP lanes in paper (recommended); or one lane only; or market
   making from the start (not recommended).
2. **Whose money:** the owner's own small wallet first (recommended). Trading users' funds from the engine means ARCDEX
   holds their keys (custody), and Polymarket's terms, its eligibility rules and the law where ARCDEX and its users are
   all apply: take legal advice first.
3. **Where it runs:** live orders must leave from an allowed country, and latency to London decides lane A. Railway's
   US regions are close-only, and London is too. Railway's EU West region (Amsterdam, a few milliseconds from London)
   or a small server in AWS eu-west-1 (Ireland, about $20–50 a month) are allowed for the API. Phase 1 measures the
   engine's own latency and checks its IP with Polymarket's geoblock endpoint.
4. **Budget for the live trial:** suggested $200–500 in pUSD, $5–25 an order, $50 daily loss stop.

## Sources

- Polymarket docs: [changelog](https://docs.polymarket.com/changelog/predictions), [fees](https://docs.polymarket.com/trading/fees),
  [maker rebates](https://docs.polymarket.com/programs/maker-rebates), [real-time data](https://docs.polymarket.com/market-data/realtime-data),
  [CLOB V2 migration](https://docs.polymarket.com/v2-migration), [geoblock](https://docs.polymarket.com/api-reference/geoblock),
  [rate limits](https://docs.polymarket.com/api-reference/rate-limits), [a resolved 15m market](https://polymarket.com/event/btc-updown-15m-1793361600).
- Wallet studies: [Telonex, top 15m traders](https://telonex.io/research/top-crypto-traders-polymarket-15m),
  [polymtradebot, do Polymarket bots work](https://polymtradebot.com/blog/do-polymarket-bots-work) (a vendor),
  [Finbold on 0x8dxd](https://finbold.com/trading-bot-turns-313-into-438000-on-polymarket-in-a-month/),
  [part-timequant Bot X-Ray](https://part-timequant.com/polymarket), [CoinDesk on @a4385](https://www.coindesk.com/markets/2026/01/19/polymarket-trader-nets-usd233-000-in-a-daring-weekend-move-in-xrp-markets-outsmarting-bots).
- Papers: [Dai, Jia & Yu, settlement manipulation](https://arxiv.org/abs/2606.31675),
  [OpenMarket](https://arxiv.org/html/2607.26245v1), [Saguillo et al., arbitrage on Polymarket](https://arxiv.org/abs/2508.03474),
  [favourite-longshot bias on Polymarket](https://arxiv.org/abs/2609.12878), [Cont, Kukanov & Stoikov, order flow imbalance](https://arxiv.org/abs/1011.6402).
- Scams: [StepSecurity, hijacked GitHub org](https://www.stepsecurity.io/blog/malicious-polymarket-bot-hides-in-hijacked-dev-protocol-github-org-and-steals-wallet-keys),
  [malicious npm packages](https://www.cryptopolitan.com/defi-polymarket-users-targeted-npm-package/).
- Data: [Bitstamp 1-minute BTC/USD](https://github.com/ff137/bitstamp-btcusd-minute-data),
  [Marketlens Polymarket sample](https://github.com/marketlenstrade/polymarket-historical-data).
