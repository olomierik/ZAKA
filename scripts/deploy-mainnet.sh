#!/bin/bash
# DO NOT USE — superseded by scripts/deploy-swap-router.sh.
#
# This used to deploy ArcDexRouter.sol to Arc mainnet, but that contract
# cannot work there, for two independent reasons found on 2026-09-24:
#   1. It was pointed at 0x68b3…Fc45 (Ethereum's SwapRouter02 address). On
#      Arc that address holds 2.7KB of unrelated code. Arc's real
#      SwapRouter02 is 0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77.
#   2. ArcDexRouter calls the SwapRouter v1 struct (with a `deadline`
#      field). Arc's SwapRouter02 only exposes the v2 struct (selector
#      0x04e45aaf), so every swap would revert even at the right address.
# ArcDexSwapRouter.sol replaces it (v3 + Uniswap v4/Argus hooks), and has
# been simulated against Arc's real node — see scripts/sim-swap-router.mjs.
echo "deploy-mainnet.sh is retired — use scripts/deploy-swap-router.sh (see the comment in this file for why)." >&2
exit 1
