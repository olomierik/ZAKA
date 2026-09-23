#!/bin/bash
# Deploy ArcLaunchpad to Arc MAINNET (chain 5042)
# Run this from your local machine with your own private key.
# Never run this inside Arc Studio — it's for your own wallet only.
#
# Fees route directly to PLATFORM_FEE_WALLET on every trade — 1% platform
# swap fee (always) plus 40% of each token's creator tax (0-3%, creator's
# choice). There is no on-contract treasury: to buy back and burn the
# platform's own token later, just trade it like any other user (buy() with
# funds from PLATFORM_FEE_WALLET) then call that token's burn().
#
# Prerequisites:
#   brew install foundry  # or curl -L https://foundry.paradigm.xyz | bash
#   export PRIVATE_KEY=0x...   # your mainnet deployer wallet
#
# Usage:
#   chmod +x scripts/deploy-launchpad.sh
#   PRIVATE_KEY=0x... bash scripts/deploy-launchpad.sh
#
# Defaults to the same platform fee wallet as ArcDexRouter. Override with
# PLATFORM_FEE_WALLET=0x... if you want fees going somewhere else.
#
# Run the test suite first — this contract holds real user USDC:
#   forge test --match-contract ArcLaunchpadTest -vvv

set -e

RPC_URL="https://rpc.mainnet.arc.io"
PLATFORM_FEE_WALLET="${PLATFORM_FEE_WALLET:-0x274262A0321A0701b0A46a3576e07aE881c286Bb}"

if [ -z "$PRIVATE_KEY" ]; then
  echo "Error: PRIVATE_KEY env var not set"
  exit 1
fi

OWNER=$(cast wallet address "$PRIVATE_KEY")
echo "Deploying ArcLaunchpad to Arc mainnet..."
echo "  Deployer / Owner:    $OWNER"
echo "  Platform fee wallet: $PLATFORM_FEE_WALLET"
echo ""

forge build

forge create \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --legacy \
  contracts/ArcLaunchpad.sol:ArcLaunchpad \
  --constructor-args "$OWNER" "$PLATFORM_FEE_WALLET"

echo ""
echo "Done! Copy the 'Deployed to' address above and:"
echo "  1. Add it to .env as VITE_ARC_LAUNCHPAD_ADDRESS"
echo "  2. Add it to Vercel environment variables"
echo "  3. Add it to AGENTS.md under Deployed Contracts"
echo ""
echo "To buy back and burn the platform's own token later (manual, your call):"
echo "  1. Launch it through the launchpad UI like any other token"
echo "  2. From PLATFORM_FEE_WALLET, call buy() on ArcLaunchpad with however much you want to spend"
echo "  3. Call burn(amount) on the token itself (it's ERC20Burnable) to permanently destroy what you bought"
