#!/bin/bash
# Deploy ArcDexCurveRouter (2% fee on Mercuri and SolonPad bonding-curve
# trades, 15% of it to referrers) to Arc MAINNET (chain 5042).
#
# Easier: deploy it from your browser wallet at
# https://arcdex.online/deploy/curve-router (no Foundry, no key in a
# terminal). It simulates, deploys and checks the router in one page.
#
# Or run this yourself, in a real Git Bash window, with your own deployer key.
# The key never needs to leave your machine — don't paste it anywhere else.
#
#   export PATH="$PATH:/d/foundry-home/bin"
#   export PRIVATE_KEY=0x...        # deployer wallet, holds a little USDC for gas
#   bash scripts/deploy-curve-router.sh
#
# Before deploying, simulate the router against the real curves (nothing is sent):
#   forge build && node scripts/sim-curve-router.mjs

set -e

RPC_URL="${RPC_URL:-https://rpc.mainnet.arc.io}"
MERCURI_FACTORY="0x8f5DfA0c48E14cCD03AE01795B8a95759BA859EB"  # Mercuri LaunchFactory (mercuri-launch-contracts v1.0.0)
SOLON_FACTORY="0xd6b86b9B1bB64b941b21AaA6a0e3A673e8405A3b"    # SolonPad's Pons V2 launch factory
USDC="0x3600000000000000000000000000000000000000"              # named in the router's events only
FEE_WALLET="${FEE_WALLET:-0x274262A0321A0701b0A46a3576e07aE881c286Bb}"

# Everything the deploy needs, checked first so a missing piece is named
# plainly instead of failing halfway.
if ! command -v forge >/dev/null 2>&1 || ! command -v cast >/dev/null 2>&1; then
  echo "Error: Foundry (forge and cast) isn't on PATH. In Git Bash: export PATH=\"\$PATH:/d/foundry-home/bin\"" >&2
  exit 1
fi
if [ ! -f contracts/ArcDexCurveRouter.sol ]; then
  echo "Error: run this from the ZAKA folder, on the latest main: git checkout main && git pull origin main" >&2
  exit 1
fi
if [ ! -d node_modules/@openzeppelin/contracts ]; then
  echo "Error: node_modules is missing (the contracts import OpenZeppelin from it). Run: bun install   (or: npm install)" >&2
  exit 1
fi
if [ -z "$PRIVATE_KEY" ]; then
  echo "Error: PRIVATE_KEY env var not set" >&2
  exit 1
fi
if ! CHAIN=$(cast chain-id --rpc-url "$RPC_URL"); then
  echo "Error: can't reach $RPC_URL (the error is above)." >&2
  exit 1
fi
CHAIN=$(echo "$CHAIN" | tr -d '[:space:]')
if [ "$CHAIN" != "5042" ]; then
  echo "Error: $RPC_URL is chain $CHAIN, not Arc mainnet (5042)." >&2
  exit 1
fi

OWNER=$(cast wallet address "$PRIVATE_KEY")
echo "Deploying ArcDexCurveRouter to Arc mainnet"
echo "  Owner (deployer):  $OWNER"
echo "  Fee wallet:        $FEE_WALLET   (receives the 2% curve-trade fee in native USDC, minus 15% to referrers)"
echo "  Mercuri factory:   $MERCURI_FACTORY"
echo "  SolonPad factory:  $SOLON_FACTORY"
echo "  Foundry:           $(forge --version | head -1)"
echo ""

# Every curve trade pays the fee wallet in native USDC, so it must be able to
# take it. A plain wallet (no code) always can; a contract wallet is checked
# with a simulated 1-wei transfer from the deployer (nothing is sent).
FEE_WALLET_CODE=$(cast code "$FEE_WALLET" --rpc-url "$RPC_URL" | tr -d '[:space:]')
if [ "$FEE_WALLET_CODE" != "0x" ]; then
  if ! cast rpc --rpc-url "$RPC_URL" eth_call "{\"from\":\"$OWNER\",\"to\":\"$FEE_WALLET\",\"value\":\"0x1\"}" latest >/dev/null; then
    echo "Error: the fee wallet $FEE_WALLET is a contract that won't take native USDC (the error is above), so every curve trade would fail. Set FEE_WALLET to a wallet that can." >&2
    exit 1
  fi
fi

echo "Compiling (a minute or two). Notes and warnings the compiler prints are fine; only a line starting with Error stops the deploy."
forge build

# Gas on Arc is paid in USDC (native balance, 18 decimals). Check the wallet
# can cover the deploy (with 2x headroom) before sending anything.
BYTECODE=$(forge inspect contracts/ArcDexCurveRouter.sol:ArcDexCurveRouter bytecode)
CTOR=$(cast abi-encode "c(address,address,address,address,address)" "$MERCURI_FACTORY" "$SOLON_FACTORY" "$USDC" "$FEE_WALLET" "$OWNER")
GAS=$(cast estimate --rpc-url "$RPC_URL" --from "$OWNER" --create "${BYTECODE}${CTOR#0x}")
GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL")
BALANCE=$(cast balance "$OWNER" --rpc-url "$RPC_URL")
NEED=$(( GAS * GAS_PRICE * 2 ))
echo "  Est. cost:         $(cast to-unit $(( GAS * GAS_PRICE )) ether) USDC   (wallet has $(cast to-unit "$BALANCE" ether) USDC)"
# (A balance of 19+ digits is >= 1 USDC, far above NEED — skip the integer
# compare there so bash's 64-bit arithmetic can't overflow.)
if [ ${#BALANCE} -le 18 ] && [ "$BALANCE" -lt "$NEED" ]; then
  echo "Error: $OWNER needs at least $(cast to-unit "$NEED" ether) USDC on Arc for gas — send some and re-run." >&2
  exit 1
fi

if [ -t 0 ]; then
  read -r -p "Deploy from $OWNER? [y/N] " ok
  [ "$ok" = "y" ] || [ "$ok" = "Y" ] || { echo "Aborted."; exit 1; }
fi

forge create \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --legacy \
  contracts/ArcDexCurveRouter.sol:ArcDexCurveRouter \
  --constructor-args "$MERCURI_FACTORY" "$SOLON_FACTORY" "$USDC" "$FEE_WALLET" "$OWNER"

echo ""
echo "Next: check the address forge printed above at https://arcdex.online/deploy/curve-router"
echo "(step 3), then send it back to Claude to wire into the app (it becomes"
echo "VITE_ARCDEX_CURVE_ROUTER_ADDRESS)."
