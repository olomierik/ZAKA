#!/usr/bin/env bash
# The checks CI runs (.github/workflows/ci.yml), for a local run before pushing: bun run check
# Secret scanning needs the gitleaks binary on PATH; it's skipped (with a note) when it isn't installed.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== site typecheck";   bunx tsc --noEmit
echo "== engine typecheck"; (cd engine && bunx tsc --noEmit -p .)
echo "== security headers"; bun scripts/check-csp.ts
echo "== trade switch";     bun scripts/test-trade-switch.ts
echo "== fees";             bun scripts/test-fees.ts
echo "== withdraw limits";  bun scripts/test-withdraw-policy.ts
echo "== wallets card";     bun scripts/test-chain-balances.ts
echo "== jupiter";          bun scripts/test-jupiter.ts
echo "== buy risk";         bun scripts/test-buy-risk.tsx
echo "== push alerts";      bun scripts/test-push.ts
echo "== privy sign-in";    bun scripts/test-privy.tsx
echo "== app shell";        bun scripts/test-app-shell.ts
echo "== social";           bun scripts/test-social.tsx
echo "== wallet reconnect"; bun scripts/test-reconnect.tsx
echo "== trade forms";      bun scripts/test-trade-details.tsx
echo "== engine tests";     bun test engine/test
echo "== chart framing";   bun scripts/test-chart-frame.ts
echo "== dexscreener";      bun scripts/test-dex-data.ts
echo "== pay from chains"; bun scripts/test-xevm.ts
echo "== fast buys";      bun scripts/test-fast-buy.ts
echo "== wallet tracker"; bun scripts/test-wallet-tracker.ts
echo "== copy trading";   bun scripts/test-copy-trade.ts
if command -v gitleaks >/dev/null; then
  echo "== secrets"; gitleaks dir . --config .gitleaks.toml --no-banner --redact
else
  echo "== secrets: skipped (install gitleaks to run it locally; CI always runs it)"
fi
echo "all checks passed"
