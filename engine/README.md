# ARCDEX Real-Time Market Engine

Detects new Arc token launches and every DEX trade the moment their block lands. It turns them into live prices, 24h stats and OHLCV candles, and pushes them to ARCDEX over a WebSocket. No polling.

```
Arc chain (WebSocket + getLogs)
  → ChainStream        live logs · reconcile · backfill · dedupe · cursor
  → launchpad adapters Argus (Portals 7 & 8), ArcLaunchpad, …
  → trade parser       v4 PoolManager / v3 pool swaps → normalized trades
  → MarketEngine       hot state (price, 24h stats) · candle engine
  → Redis (hot) · Postgres (history, batched) · WebSocket/REST → browsers
```

Everything runs in one Bun process by default. For scale-out, split it into `ENGINE_ROLE=ingest` (one process) and `ENGINE_ROLE=gateway` (any number of processes), with Redis pub/sub between them.

## Files

| | |
|---|---|
| `src/main.ts` | Wiring: roles, parse → apply pipeline, health, timers, graceful shutdown |
| `src/config.ts` | Environment configuration (`.env.example`) |
| `src/chain/wsProvider.ts` | WebSocket JSON-RPC: durable subscriptions, backoff, stale-stream failover |
| `src/chain/http.ts` | HTTP JSON-RPC with provider failover + circuit breaker |
| `src/chain/stream.ts` | Live logs + reconcile (missed-event detection) + catch-up backfill, dedupe, cursor |
| `src/dex/pools.ts` | Pool registry: v4 `Initialize` / PositionManager keys (hash-verified), v3 factory check |
| `src/dex/trades.ts` | Swap → normalized trade, BUY/SELL from token deltas, batched sender lookup, USD pricing |
| `src/launchpads/adapter.ts` | `LaunchpadAdapter` interface + shared ABI/sanitizing helpers |
| `src/launchpads/argus.ts` | Argus Portal 7 & 8 launch detection |
| `src/launchpads/arcLaunchpad.ts` | ARCDEX's own bonding-curve launchpad (launches + curve trades) |
| `src/market/tokenState.ts` | Per-token hot state; rolling 24h stats in 1,440 minute buckets |
| `src/market/candles.ts` | 1s/5s/15s/1m/5m/15m/1h/4h/1d candles, late-trade handling |
| `src/market/engine.ts` | Applies trades/launches; publishes events; ticks; warm restart |
| `src/store/hot.ts` | Redis hot store (pipelined, TTLs) + in-memory store for tests/dev |
| `src/store/history.ts` | Batched history behind a swappable interface; Supabase (REST) backend |
| `src/store/postgresHistory.ts` | Direct Postgres backend (`DATABASE_URL`, e.g. Railway); creates its own tables |
| `src/ws/server.ts` | WebSocket + REST + `/health` + `/metrics` |
| `../api/_marketProtocol.ts` | Wire protocol shared with the frontend |
| `../api/_arcSwaps.ts`, `../api/_arcLogs.ts` | Swap decoding and log scanning, shared with the site |

## Run locally

```bash
cd engine && bun install        # only viem
bun src/main.ts                 # from engine/, or `bun engine/src/main.ts` from the repo root
```

Without `REDIS_URL` it keeps hot state in memory; without Supabase credentials it runs without history. Both are fine for development. Point a local frontend at it with `VITE_ARCDEX_WS_URL=ws://localhost:8080/ws` in `.env.local`, and add `http://localhost:5173` to `WS_ALLOWED_ORIGINS`.

## Deploy on Railway (set up 2026-09-25)

Railway project **arcdex** holds **Postgres** and **Redis**. To add the engine:

1. Railway can read `olomierik/ZAKA` (GitHub → Settings → Applications → Railway App).
2. In project **arcdex**: Add → GitHub Repository → `olomierik/ZAKA`. The root `railway.toml` builds `engine/Dockerfile`, health-checks `/health`, and redeploys only when engine files change.
3. Set these variables on the service:
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}` and `REDIS_URL=${{Redis.REDIS_URL}}` (Railway references, private network).
   - `TRUST_PROXY=1`
   - `WS_ALLOWED_ORIGINS=https://arcdex.online,https://www.arcdex.online`
4. Networking → Generate Domain (or add `api.arcdex.online`) → then set `VITE_ARCDEX_WS_URL=wss://<domain>/ws` in Vercel and redeploy the site.

The engine creates its history tables in Railway Postgres on first start. Supabase is untouched.

**Live:** service `arcdex-engine`, at `https://arcdex-engine-production.up.railway.app`, with steps 1–4 done except the Vercel variable.

## Deploy (any other host)

The engine is a long-running process, so it can't run on Vercel. It needs any host that runs a Docker container or a Bun process 24/7 (Fly.io, Railway, Render, a VPS).

1. **Database:** run `supabase/migrations/20260928000000_arcdex_market_engine.sql` in the Supabase SQL editor (after v1–v4).
2. **Redis:** create a Redis 6+ instance (e.g. Upstash or Redis Cloud) and copy its URL.
3. **Build and run:**
   ```bash
   docker build -f engine/Dockerfile -t arcdex-engine .
   docker run -d --restart=always --env-file engine/.env -p 8080:8080 arcdex-engine
   ```
   Set `REDIS_URL`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY`, and set `TRUST_PROXY=1` behind a load balancer. All variables are in `.env.example`; credentials live only there, server-side.
4. **DNS:** point `api.arcdex.online` at the host, with TLS. The WebSocket is then `wss://api.arcdex.online/ws`.
5. **Frontend:** in Vercel project `app`, set `VITE_ARCDEX_WS_URL=wss://api.arcdex.online/ws` (and optionally `VITE_ARCDEX_API_URL=https://api.arcdex.online`), then redeploy. Until these are set the site uses its direct-from-chain path, so nothing breaks while the engine is down.

Each start first indexes every pool `Initialize` of the last ~600k blocks in one bulk scan (~30s, ~15k pools), so older pools are identified by lookup rather than by a slow scan each. The first start with no saved cursor then replays ~24h (`BACKFILL_ON_START_BLOCKS`), at ~360 trades/s measured from cold (about 15–20 minutes). Later restarts resume from the cursor saved in Redis/Postgres.

## WebSocket protocol

```jsonc
{"action":"subscribe","channel":"token","token":"0x…"}                      // TRADE, PRICE_UPDATE, VOLUME_UPDATE, LIQUIDITY_UPDATE (+ SNAPSHOT at once)
{"action":"subscribe","channel":"candles","token":"0x…","interval":"1s"}     // CANDLE_UPDATE (current candle at once)
{"action":"subscribe","channel":"new_tokens"}                                // NEW_TOKEN
{"action":"subscribe","channel":"market"}                                    // TICKS: every token that traded, once a second
{"action":"unsubscribe", …}   {"action":"ping"}
```

Channels `trades`, `price`, `volume` and `liquidity` are single-event subsets of `token`. Subscribe to one or the other, or events arrive twice. Messages look like `{"t":"TRADE","k":"<token>","d":{…}}`, with compact field names. The full schema is `ServerMessage` in `api/_marketProtocol.ts`.

REST: `GET /v1/tokens/new`, `/v1/tokens/:token`, `/v1/tokens/:token/trades?limit&before`, `/v1/tokens/:token/candles?interval&limit&before`, `/v1/market`, `/health`, and `/metrics` (`Authorization: Bearer $METRICS_TOKEN`).

**Initial page load, with no gaps:** the page subscribes first, then fetches REST history, then merges both by trade id (`txHash:logIndex`) or candle bucket. The engine also sends a snapshot on every subscribe.

## Reliability

- **Dedupe:** every log is processed once, by `txHash:logIndex`. Postgres upserts are idempotent.
- **Backpressure:** catch-up fetches the next chunk while the previous one is handled, never more. `/health` reports `lastProcessedBlock` (handled), `lastFetchedBlock` and `queuedEvents`.
- **Missed-event detection:** every `RECONCILE_MS` the stream re-reads `(cursor, head−2]` with `getLogs` and recovers anything the socket dropped (metric `missed_events_recovered`).
- **Disconnect / restart:** the cursor falls behind. New live logs are buffered while the gap is backfilled in block order, then the stream is live again.
- **Stale stream:** no new block for `STALE_HEAD_MS` means the socket is dropped and the next `ARC_WS_URLS` provider is used. HTTP calls fail over across `ARC_HTTP_URLS`.
- **Replays** (backfill) update state and history but aren't broadcast one by one.
- **Late trades** land in the correct in-memory candle. Older ones are repaired in Postgres from the stored trades.

## Security

- **Credentials:** stay in the engine's environment and are never sent to the browser. Logs print provider hosts, never URLs.
- **Browser access:** WebSocket origins are allowlisted, REST uses CORS.
- **Limits:** connections per IP, messages per second, subscriptions per connection, REST calls per second, and a 2 KB message cap.
- **Message validation:** every client message is validated (channel, `0x` address, interval).
- **Chain data validation:**
  - v4 events are accepted only from the PoolManager, with keys verified against the PoolId.
  - v3 pools must be the factory's.
  - Adapters only read their own portal contracts.
- **Untrusted metadata:** launch names, symbols and images are sanitized (control and bidi characters stripped, lengths capped; images must be `https://` or `ipfs://`).

## Tests

```bash
bun test engine/test                       # 39 tests: candles, 24h state, protocol, real-mainnet replays (Argus launches, v3/v4 swaps), stream/provider reliability (incl. catch-up backpressure), Redis (RESP3), WebSocket/REST end-to-end
PG_TEST_URL=postgres://… bun test engine/test/postgres.test.ts   # +2: the Postgres history backend, against a scratch database
bun engine/scripts/capture-fixtures.ts     # refresh the recorded mainnet fixtures
```

Tests use recorded real chain data and in-memory doubles. Nothing fake reaches a production path.

### Test a new Argus launch

1. With the engine running, subscribe to `new_tokens`: `bun engine/scripts/latency-check.ts ws://localhost:8080/ws 120`. It prints each `NEW_TOKEN` and how long after its block it arrived.
2. Or launch a token on argus.world and watch for it in the ARCDEX Terminal's "New <15m" view (NEW badge) or in `GET /v1/tokens/new`.

### Verify trade-to-chart latency

- `bun engine/scripts/latency-check.ts wss://api.arcdex.online/ws 60` follows the busiest token. It reports p50/p90 from block to client for TRADE events, and checks that each 1s CANDLE_UPDATE close equals the trade's price.
- Block timestamps are whole seconds, so each figure includes up to ~1s of rounding.
- `/metrics` shows the engine's own `trade_processing` (log received → published), `maker_lookup` and `launch_detection` percentiles.

**Measured locally against mainnet on 2026-09-25:**
- `NEW_TOKEN`: 0.4–1.0s after the launch block.
- Trades: p50 0.94s block → client.
- Candle closes: 40/40 matched their trades.
- 20,000-block catch-up: 133s.

## Known limits

- **Liquidity:** estimated from the pool's in-range liquidity (`2 × quote reserve`). It's exact for full-range pools (Argus launches) and shows active-range depth for concentrated pools.
- **Volume:** Arc's DEXes carry ~2 swaps per block, mostly bots. Postgres keeps raw trades for 72h by default. For long raw-trade retention at this volume, implement `HistoryStore` for ClickHouse.
- **Argus Portals 1–6:** emitted no launches in the last ~1M blocks. Their tokens are still tracked through their swaps.
- **Trade wallet:** the transaction's sender. For smart-account / relayed transactions that's the bundler.
