#!/bin/bash
# Deploy ArcDexRouter to Arc MAINNET (chain 5042)
# Run this from your local machine with your own private key.
# Never run this inside Arc Studio — it's for your own wallet only.
#
# Prerequisites:
#   brew install foundry  # or curl -L https://foundry.paradigm.xyz | bash
#   export PRIVATE_KEY=0x...   # your mainnet deployer wallet
#
# Usage:
#   chmod +x scripts/deploy-mainnet.sh
#   PRIVATE_KEY=0x... bash scripts/deploy-mainnet.sh

set -e

RPC_URL="https://rpc.mainnet.arc.io"
SWAP_ROUTER="0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"
FEE_WALLET="0x274262A0321A0701b0A46a3576e07aE881c286Bb"

if [ -z "$PRIVATE_KEY" ]; then
  echo "Error: PRIVATE_KEY env var not set"
  exit 1
fi

OWNER=$(cast wallet address "$PRIVATE_KEY")
echo "Deploying ArcDexRouter to Arc mainnet..."
echo "  Deployer / Owner: $OWNER"
echo "  Fee wallet:       $FEE_WALLET"
echo "  SwapRouter02:     $SWAP_ROUTER"
echo ""

forge build

forge create \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --legacy \
  contracts/ArcDexRouter.sol:ArcDexRouter \
  --constructor-args "$SWAP_ROUTER" "$FEE_WALLET" "$OWNER"

echo ""
echo "Done! Copy the 'Deployed to' address above and:"
echo "  1. Add it to .env as VITE_ARCDEX_ROUTER_ADDRESS"
echo "  2. Add it to Vercel environment variables"
echo "  3. Add it to AGENTS.md under Deployed Contracts"
