# Why people don't trade on ARCDEX (2026-10-17)

The owner asked: "find out why users don't use our platform for trading". These are the numbers read live on
2026-10-17, what they say, and what to do, most important first.

## What the numbers say

| Measure | Value | Where it was read |
|---|---|---|
| Visitors since counting began (2026-10-01) | 685 | engine `GET /v1/traffic` |
| Visitors today | 52 | same |
| Online at the time | 1 | same |
| Wallets that ever traded through ARCDEX's Arc routers | 13 (2 with enough trades to rank, 11 "thin") | `GET /v1/social/board?period=all` |
| Fees in the ledger from those routers | 5 rows, under $0.01 in all | `GET /v1/fees/summary` |
| Arc swap router fee | 2% (`feeBps` 200 on both routers, read on-chain) | `0xD075…924e`, `0xF8e8…6441` |

So the problem has two parts. **Few people arrive** (about 40–50 a day). **Almost none of them trade**: a dozen wallets
in two weeks. The trades sent from the site on Solana, BNB Chain and Robinhood Chain are in the admin analytics. Once
this change deploys they're public at `/analytics` too, so the funnel (visitors → signed in → traded) can be read
there daily.

## Why, most likely

1. **There is no audience yet.** 685 visitors in 17 days is far too few to get trades. DexScreener, GMGN and Axiom get
   their traffic from X/Telegram call channels, KOLs and listings, and ARCDEX isn't in those places. This is the largest
   cause, and code doesn't fix it.
2. **The coins people came for were missing.** Solana, BNB Chain and Robinhood Chain listed only launchpad venues.
   Established coins trading on plain DEXes never showed, and Migrated sorted youngest first with a 60-row cap. A trader
   coming from DexScreener searched for a coin they know, didn't find it in the lanes, and left. **Fixed in this change**
   (below).
3. **The fee is high where the volume is.** Arc spot charges 2%. Terminals charge about 1%, and Uniswap direct only the
   pool fee. The 0.5% decision (D2, 2026-10-15) is live off Arc, but the Arc routers are still at 2% until their owners
   call `setFeeBps(50)` (`/admin` → Fees).
4. **Getting money in takes work.** A new user must sign in, then fund a wallet on the right chain before the first
   trade. Card deposits aren't live (no `CIRCLE_ONRAMP_API_KEY`), and phone wallets can't connect by QR (no
   `VITE_WC_PROJECT_ID`). Every extra step loses most of the people who reach it.
5. **Trust.** The site is new, under two names (ARCDEX at arcsense.site), with no audit badge and no visible track
   record. The public analytics page now gives some proof.

## What to do, in order

1. **Distribution (owner):** post the Trenches and coin pages on X and Telegram daily, ask Arc's ecosystem pages and
   DefiLlama to list ARCDEX, and pay one or two Arc and Solana call channels for a week to measure the funnel. Coin
   pages already have link previews for X and Telegram.
2. **Cut the Arc fee to 0.5% (owner):** `/admin` → Fees → "Set to 0.5%" on both routers, signed by each router's owner.
3. **One-step funding (owner):** set `CIRCLE_ONRAMP_API_KEY` (cards, Apple Pay) and `VITE_WC_PROJECT_ID` (phone wallets
   by QR).
4. **Watch `/analytics` every day:** if visitors grow and "signed in → traded" stays near zero, the next problem is the
   trade flow itself, and a session recording or a few user interviews would show where people stop.

## Fixed in this change

- **Every chain lists established coins.** A coin proven by its own trading on any DEX ($25K liquidity, $100K market
  cap, 3+ days old, 25+ trades a day) is listed beside launchpad coins on Solana, BNB Chain and Robinhood Chain, as Arc
  already did. The lists also read each chain's busiest and trending pools on every DEX.
- **No row cap:** each lane draws 60 rows and loads the next 60 as it scrolls.
- **A sort on every lane:** default, newest, 24h volume, market cap, trending, top gainers. Migrated opens by volume.
- **Trending** is the first lane, on the left, and always shows every chain (up to 240 coins).
- **`/analytics` is public**, in the More menu, with wallets shortened.
