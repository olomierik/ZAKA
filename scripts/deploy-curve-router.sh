#!/bin/bash
# Deploy ArcDexCurveRouter (2% fee on Mercuri and SolonPad bonding-curve
# trades, 15% of it to referrers) to Arc MAINNET (chain 5042).
# Run this yourself, in a real Git Bash window, with your own deployer key.
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

if [ -z "$PRIVATE_KEY" ]; then
  echo "Error: PRIVATE_KEY env var not set" >&2
  exit 1
fi

OWNER=$(cast wallet address "$PRIVATE_KEY")
echo "Deploying ArcDexCurveRouter to Arc mainnet"
echo "  Owner (deployer):  $OWNER"
echo "  Fee wallet:        $FEE_WALLET   (receives the 2% curve-trade fee in native USDC, minus 15% to referrers)"
echo "  Mercuri factory:   $MERCURI_FACTORY"
echo "  SolonPad factory:  $SOLON_FACTORY"
echo ""

# Every curve trade pays the fee wallet in native USDC: a wallet that can't
# receive it would make every trade revert.
if ! cast call --rpc-url "$RPC_URL" --from "$OWNER" --value 1 "$FEE_WALLET" --data 0x >/dev/null 2>&1; then
  echo "Error: the fee wallet $FEE_WALLET can't receive native USDC — set FEE_WALLET to one that can." >&2
  exit 1
fi

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
echo "Next: send the 'Deployed to:' address above back to Claude to wire into the app"
echo "(it becomes VITE_ARCDEX_CURVE_ROUTER_ADDRESS)."
