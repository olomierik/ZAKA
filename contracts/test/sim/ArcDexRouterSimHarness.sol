// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArcDexSwapRouter, PoolKey} from "../../ArcDexSwapRouter.sol";

/// Not deployed anywhere. Injected via eth_call state override into a
/// simulated call against Arc's real node (see scripts/sim-swap-router.mjs),
/// because Arc's USDC moves balances through a chain precompile (0x1800…)
/// that Foundry's local fork EVM doesn't implement — so a Foundry fork test
/// can never move USDC. Given a native balance override (= USDC balance at
/// 1e12 scale), each function deploys a fresh router and swaps through the
/// real pools and real Argus hooks within the one simulated transaction.
contract ArcDexRouterSimHarness {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant SWAP_ROUTER02 = 0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77;
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant FEE_WALLET = 0x274262A0321A0701b0A46a3576e07aE881c286Bb;

    struct Result {
        uint256 amountOut;
        uint256 received; // this harness's actual balance gain
        uint256 feeWalletGain; // in USDC
        uint256 referrerGain; // in USDC
        uint256 routerLeftIn;
        uint256 routerLeftOut;
    }

    function _router() internal returns (ArcDexSwapRouter) {
        return new ArcDexSwapRouter(POOL_MANAGER, SWAP_ROUTER02, USDC, FEE_WALLET, address(this));
    }

    function buyV4(PoolKey[] calldata keys, address tokenOut, uint256 usdcIn, address referrer)
        external
        returns (Result memory r)
    {
        ArcDexSwapRouter router = _router();
        r = _swapV4(router, keys, USDC, tokenOut, usdcIn, referrer);
    }

    /// Buy then sell the whole position back — exercises fee-on-output, and
    /// that the referrer bound on the buy keeps earning on the sell even
    /// though the sell passes no referrer.
    function roundTripV4(PoolKey[] calldata keys, address token, uint256 usdcIn, address referrer)
        external
        returns (Result memory buy, Result memory sell)
    {
        ArcDexSwapRouter router = _router();
        buy = _swapV4(router, keys, USDC, token, usdcIn, referrer);
        PoolKey[] memory rev = new PoolKey[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) rev[i] = keys[keys.length - 1 - i];
        sell = _swapV4Mem(router, rev, token, USDC, buy.received, address(0));
    }

    function buyV3(address tokenOut, uint24 fee, uint256 usdcIn, address referrer) external returns (Result memory r) {
        ArcDexSwapRouter router = _router();
        IERC20(USDC).approve(address(router), usdcIn);
        uint256 feeBefore = IERC20(USDC).balanceOf(FEE_WALLET);
        uint256 refBefore = referrer == address(0) ? 0 : IERC20(USDC).balanceOf(referrer);
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        r.amountOut = router.swapExactInV3(USDC, tokenOut, fee, usdcIn, 1, block.timestamp + 60, referrer);
        r.received = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        r.feeWalletGain = IERC20(USDC).balanceOf(FEE_WALLET) - feeBefore;
        if (referrer != address(0)) r.referrerGain = IERC20(USDC).balanceOf(referrer) - refBefore;
        r.routerLeftIn = IERC20(USDC).balanceOf(address(router));
        r.routerLeftOut = IERC20(tokenOut).balanceOf(address(router));
    }

    function _swapV4(
        ArcDexSwapRouter router,
        PoolKey[] calldata keys,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address referrer
    ) internal returns (Result memory r) {
        PoolKey[] memory m = new PoolKey[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) m[i] = keys[i];
        return _swapV4Mem(router, m, tokenIn, tokenOut, amountIn, referrer);
    }

    function _swapV4Mem(
        ArcDexSwapRouter router,
        PoolKey[] memory keys,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address referrer
    ) internal returns (Result memory r) {
        IERC20(tokenIn).approve(address(router), amountIn);
        address boundRef = router.referrerOf(address(this));
        address ref = boundRef != address(0) ? boundRef : referrer;
        uint256 feeBefore = IERC20(USDC).balanceOf(FEE_WALLET);
        uint256 refBefore = ref == address(0) ? 0 : IERC20(USDC).balanceOf(ref);
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        r.amountOut = router.swapExactInV4(keys, tokenIn, amountIn, 1, block.timestamp + 60, referrer);
        r.received = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        r.feeWalletGain = IERC20(USDC).balanceOf(FEE_WALLET) - feeBefore;
        if (ref != address(0)) r.referrerGain = IERC20(USDC).balanceOf(ref) - refBefore;
        r.routerLeftIn = IERC20(tokenIn).balanceOf(address(router));
        r.routerLeftOut = IERC20(tokenOut).balanceOf(address(router));
    }
}
