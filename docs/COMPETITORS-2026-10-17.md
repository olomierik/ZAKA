# GMGN and fomo against ARCDEX (2026-10-17)

Toured read-only in Chrome from the owner's machine in Dar es Salaam: GMGN's Trenches, a coin page and its Robinhood
Chain lanes; fomo's Discover list and a coin page. ARCDEX (arcsense.site) was timed from the same connection.

## GMGN

**Strengths**
- **Speed.** Regional edge servers (`fra1-`, `tky1-`, `va1-`, `or1-edge.gmgn.ai`): each visitor talks to the nearest.
  New coins show up in the lanes seconds after launch (Robinhood Chain: 46 s and 52 s old when checked).
- **The Trenches.** New / Almost bond / Migrated lanes, P1–P3 buy presets per lane, filters, keyword search, a pause on
  hover, and a Buy button on every row that buys in one click.
- **Coin page.** 1s/30s/1m… candles, multicharts, "first candle", price/MC and USD/SOL switches; a Buy/Sell/**Auto**
  panel with Market, Limit, DCA and advanced orders; a safety grid (Top 10, dev, holders, snipers, insiders, phishing,
  bundlers, Dex paid, mint, blacklist, burnt, rug %); trades with filters, positions, orders, holders, top traders,
  the dev's other coins; "Instant trade".
- **Everywhere:** smart money, KOLs, callouts, wallet tracker, copy trade, a status line with RPC speed and FPS.

**Weaknesses**
- Dense to the point of noise: promo pop-ups, dozens of icons per row, three columns of side panels.
- Chinese-first wording; a new trader doesn't know where to start.
- Sign-in is wallet or Telegram-led; funding is crypto-native.

## fomo

**Strengths**
- **Simplicity.** One Discover table (Trending, Blue chips, Most held, Graduated, Bonding, Watchlist), quick buy in
  dollars ($10 / $100 / $500 / $1,000), your cash and positions always on screen.
- **Onboarding.** Privy sign-in (email or social), a wallet made for you, deposits with a card; nothing to install.
- **Social proof.** The latest thesis on each coin, holders from fomo split from total holders, follow, feed.
- **Fast sends:** its own Solana RPC edge (`solana-provider-1.prod-edge.fomo.family`), Jito's block engine and Helius
  Sender to land Solana trades; Mobula for market data; Hyperliquid for perps.

**Weaknesses**
- No Trenches: new launches and bonding coins are a filtered list, not a live lane.
- Few tools for serious traders (no limit orders, no safety grid, simple chart).
- First load is slow (8.3 s to DOM ready from Dar es Salaam).

## ARCDEX, measured

- **Every visit downloaded the app again.** Netlify served the hashed JS files with `max-age=0, must-revalidate`, so a
  return visit asked for every file (~0.4–1.4 s each from Dar es Salaam).
- **The engine is far away.** Each request goes through Railway's Singapore edge (`x-railway-edge: sin1`): 0.25 s to
  connect, ~1.2 s for `/health`, 1.5–2.3 s for the Trenches' first requests. GMGN and fomo answer from nearer servers.
- **Robinhood Chain launches came late.** The engine had no launch detection there: new coins came from GeckoTerminal's
  list, read about every 6 minutes. Our New lane showed coins 5–16 minutes old while GMGN's showed 46 s.
- **Sign-in:** "Log in" opened a wallet chooser; `/` opened the terminal for everyone, with no landing page.
- **Navigation repeated itself:** Swap, Bridge, Copy and Tracker were both links and More items; the status bar
  repeated Portfolio, Alerts, Watchlist, Wallets, Feed, Clans and Routes; the account menu repeated Portfolio, Feed,
  Clans and the language; on phones the ☰ drawer and the More sheet were two lists of the same pages.
- **No analytics:** nothing counted who signed in, who traded, or how much, across chains.

## What ARCDEX takes from each (this round)

| From | Change |
|---|---|
| fomo | `/` is a landing page; **Log in opens Privy** (email or social), the wallets are made, then a funding step and the Trenches |
| fomo | One place for each page: top links, one More menu, account menu for your own things only |
| GMGN | Robinhood Chain launches read from the chain by the engine, in seconds |
| GMGN | Long-lived caching of the app's files, so a return visit starts at once |
| both | An analytics view for the owner: sign-ins, traders, trades, volume and fees, by day and by chain |

## Owner steps that would cut latency further

1. **Move the engine nearer the users.** Railway → arcdex-engine → Settings → Region: Europe West (Amsterdam) is
   ~110–150 ms from Dar es Salaam against the current route through Singapore. It also sits nearer Arc's and
   Robinhood Chain's RPCs (measure `maker_lookup` in `/health` after the move).
2. **A dedicated RPC per chain, server-side.** QuickNode or Alchemy endpoints for Robinhood Chain, BNB Chain and Solana,
   set on Railway (engine) rather than in the page, so the engine reads launches and trades fast and pushes them over its
   WebSocket. A Helius (or Triton) Solana endpoint with Sender for landing trades, as fomo does.
3. **Card deposits** (Circle's Onramp key): fomo's onboarding is "sign in, pay with a card, trade".
