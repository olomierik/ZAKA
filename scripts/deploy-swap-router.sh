#!/bin/bash
# Deploy ArcDexSwapRouter to Arc MAINNET (chain 5042).
# Run this yourself, in a real Git Bash window, with your own deployer key.
# The key never needs to leave your machine — don't paste it anywhere else.
#
#   export PATH="$PATH:/d/foundry-home/bin"
#   export PRIVATE_KEY=0x...        # deployer wallet, holds a little USDC for gas
#   bash scripts/deploy-swap-router.sh
#
# Before deploying, you can re-run the real-node simulation any time:
#   forge build && node scripts/sim-swap-router.mjs

set -e

RPC_URL="${RPC_URL:-https://rpc.mainnet.arc.io}"
POOL_MANAGER="0x8366a39CC670B4001A1121B8F6A443A643e40951"   # Uniswap v4 PoolManager on Arc
SWAP_ROUTER02="0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77"  # Uniswap v3 SwapRouter02 on Arc (NOT Ethereum's 0x68b3…)
USDC="0x3600000000000000000000000000000000000000"
FEE_WALLET="${FEE_WALLET:-0x274262A0321A0701b0A46a3576e07aE881c286Bb}"

if [ -z "$PRIVATE_KEY" ]; then
  echo "Error: PRIVATE_KEY env var not set" >&2
  exit 1
fi

OWNER=$(cast wallet address "$PRIVATE_KEY")
echo "Deploying ArcDexSwapRouter to Arc mainnet"
echo "  Owner (deployer): $OWNER"
echo "  Fee wallet:       $FEE_WALLET   (receives 1% of every swap, in USDC)"
echo "  PoolManager:      $POOL_MANAGER"
echo "  SwapRouter02:     $SWAP_ROUTER02"
echo ""

forge build

forge create \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --legacy \
  contracts/ArcDexSwapRouter.sol:ArcDexSwapRouter \
  --constructor-args "$POOL_MANAGER" "$SWAP_ROUTER02" "$USDC" "$FEE_WALLET" "$OWNER"

echo ""
echo "Next: send the 'Deployed to:' address above back to Claude to wire into the app"
echo "(it becomes VITE_ARCDEX_SWAP_ROUTER_ADDRESS)."
