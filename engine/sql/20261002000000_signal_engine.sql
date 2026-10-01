-- The signal engine's tables (engine/src/quant/store.ts creates them on start; this file is for review and for
-- creating them by hand). Safe to re-run. Trades, swaps and tokens are the market engine's arcdex_mkt_trades and
-- arcdex_mkt_tokens (engine/src/store/postgresHistory.ts), not copied.
create table if not exists arcdex_sig_signals (
  id text primary key, at timestamptz not null, token text not null, symbol text, launchpad text, strategy text not null,
  score double precision not null, band text not null, decision text not null, mode text not null, data jsonb not null
);
create index if not exists arcdex_sig_signals_at on arcdex_sig_signals (at desc);
create index if not exists arcdex_sig_signals_token on arcdex_sig_signals (token, at desc);
create table if not exists arcdex_sig_signal_features (
  signal_id text primary key, at timestamptz not null, token text not null, strategy text not null, vector jsonb not null, features jsonb not null
);
create index if not exists arcdex_sig_signal_features_at on arcdex_sig_signal_features (at);
create table if not exists arcdex_sig_signal_outcomes (signal_id text primary key, at timestamptz not null, token text not null, strategy text not null, data jsonb not null);
create table if not exists arcdex_sig_snapshots (token text not null, at timestamptz not null, data jsonb not null, primary key (token, at));
create index if not exists arcdex_sig_snapshots_at on arcdex_sig_snapshots (at);
create table if not exists arcdex_sig_positions (
  id text primary key, token text not null, strategy text not null, mode text not null, status text not null,
  opened_at timestamptz not null, closed_at timestamptz, pnl_usd double precision, data jsonb not null
);
create index if not exists arcdex_sig_positions_open on arcdex_sig_positions (mode, status, closed_at desc);
create table if not exists arcdex_sig_orders (
  key text primary key, position_id text not null, token text not null, side text not null, mode text not null, status text not null, at timestamptz not null, data jsonb not null
);
create table if not exists arcdex_sig_execution_events (
  id bigserial primary key, at timestamptz not null, key text not null, position_id text not null, token text not null, mode text not null, kind text not null, data jsonb not null
);
create index if not exists arcdex_sig_execution_events_at on arcdex_sig_execution_events (at desc);
create table if not exists arcdex_sig_risk_events (
  id bigserial primary key, at timestamptz not null, mode text not null, kind text not null, token text, detail text not null
);
create index if not exists arcdex_sig_risk_events_at on arcdex_sig_risk_events (at desc);
create table if not exists arcdex_sig_wallets (
  wallet text primary key, class text not null, quality double precision not null, trades int not null, win_rate double precision not null,
  profit_factor double precision, realized_profit double precision not null, realized_loss double precision not null, updated_at timestamptz not null, data jsonb not null
);
create index if not exists arcdex_sig_wallets_class on arcdex_sig_wallets (class, quality desc);
create table if not exists arcdex_sig_wallet_positions (wallet text not null, token text not null, updated_at timestamptz not null, data jsonb not null, primary key (wallet, token));
create table if not exists arcdex_sig_strategy_results (strategy text not null, mode text not null, day date not null, data jsonb not null, updated_at timestamptz not null default now(), primary key (strategy, mode, day));
create table if not exists arcdex_sig_strategy_parameters (version serial primary key, at timestamptz not null, changed_by text not null, note text not null, config jsonb not null);
create table if not exists arcdex_sig_backtest_runs (id text primary key, at timestamptz not null, kind text not null, data jsonb not null);
create table if not exists arcdex_sig_market_regimes (at timestamptz primary key, regime text not null, data jsonb not null);
