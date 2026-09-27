// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArcDexCurveRouter} from "../../ArcDexCurveRouter.sol";

interface IMercuriFeeManager {
    function referrerOf(address trader) external view returns (address);
}

/// Not deployed anywhere. Injected via eth_call state override into a
/// simulated call against Arc's real node (see scripts/sim-curve-router.mjs
/// and the deploy page, src/arcdex/lib/curveRouterDeploy.ts), like
/// ArcDexRouterSimHarness: given a native balance override (native USDC,
/// 18 decimals), each function trades through the real Mercuri and SolonPad
/// curves within the one simulated transaction, through a fresh
/// ArcDexCurveRouter (`buy`, `roundTrip`) or one already deployed
/// (`buyVia`, `roundTripVia`).
contract ArcDexCurveRouterSimHarness {
    address constant MERCURI_FACTORY = 0x8f5DfA0c48E14cCD03AE01795B8a95759BA859EB;
    address constant MERCURI_FEE_MANAGER = 0x31D1bfe59B783f4c077F853f962D1355AfB52580;
    address constant SOLON_FACTORY = 0xd6b86b9B1bB64b941b21AaA6a0e3A673e8405A3b;
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant FEE_WALLET = 0x274262A0321A0701b0A46a3576e07aE881c286Bb;

    struct Result {
        uint256 amountOut; // what the router returned
        uint256 received; // this harness's actual gain: tokens on a buy, native USDC on a sell
        uint256 spent; // native USDC this harness paid on a buy, after any refund
        uint256 feeWalletGain; // native USDC, to the router's feeWallet
        uint256 referrerGain; // native USDC
        uint256 routerLeftNative; // what the trade left in the router
        uint256 routerLeftTokens;
        address mercuriReferrerOfRouter; // the referrer Mercuri's FeeManager holds for the router
    }

    /// Balances before a trade, to measure what it changed.
    struct Before {
        uint256 feeWallet;
        uint256 referrer;
        uint256 routerNative;
        uint256 routerTokens;
    }

    receive() external payable {}

    function _router() internal returns (ArcDexCurveRouter) {
        return new ArcDexCurveRouter(MERCURI_FACTORY, SOLON_FACTORY, USDC, FEE_WALLET, address(this));
    }

    function buy(bool mercuri, address token, uint256 value, address referrer) external returns (Result memory r) {
        r = _buy(_router(), mercuri, token, value, referrer);
    }

    /// Buys, then sells everything bought back without naming a referrer: a
    /// referrer bound on the buy keeps earning on the sell.
    function roundTrip(bool mercuri, address token, uint256 value, address referrer)
        external
        returns (Result memory bought, Result memory sold)
    {
        ArcDexCurveRouter router = _router();
        bought = _buy(router, mercuri, token, value, referrer);
        sold = _sell(router, mercuri, token, bought.received, referrer);
    }

    /// `buy`, through the router deployed at `router`.
    function buyVia(ArcDexCurveRouter router, bool mercuri, address token, uint256 value, address referrer)
        external
        returns (Result memory r)
    {
        r = _buy(router, mercuri, token, value, referrer);
    }

    /// `roundTrip`, through the router deployed at `router`.
    function roundTripVia(ArcDexCurveRouter router, bool mercuri, address token, uint256 value, address referrer)
        external
        returns (Result memory bought, Result memory sold)
    {
        bought = _buy(router, mercuri, token, value, referrer);
        sold = _sell(router, mercuri, token, bought.received, referrer);
    }

    function _buy(ArcDexCurveRouter router, bool mercuri, address token, uint256 value, address referrer)
        internal
        returns (Result memory r)
    {
        Before memory b = _before(router, token, referrer);
        uint256 tokensBefore = IERC20(token).balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;
        uint256 deadline = block.timestamp + 60;
        r.amountOut = mercuri
            ? router.buyMercuri{value: value}(token, 1, deadline, referrer)
            : router.buySolon{value: value}(token, 1, deadline, referrer);
        r.received = IERC20(token).balanceOf(address(this)) - tokensBefore;
        r.spent = nativeBefore - address(this).balance;
        _finish(r, router, token, b, referrer);
    }

    function _sell(ArcDexCurveRouter router, bool mercuri, address token, uint256 amount, address referrer)
        internal
        returns (Result memory r)
    {
        Before memory b = _before(router, token, referrer);
        uint256 nativeBefore = address(this).balance;
        uint256 deadline = block.timestamp + 60;
        IERC20(token).approve(address(router), amount);
        r.amountOut = mercuri
            ? router.sellMercuri(token, amount, 1, deadline, address(0))
            : router.sellSolon(token, amount, 1, deadline, address(0));
        r.received = address(this).balance - nativeBefore;
        _finish(r, router, token, b, referrer);
    }

    function _before(ArcDexCurveRouter router, address token, address referrer)
        internal
        view
        returns (Before memory b)
    {
        b.feeWallet = router.feeWallet().balance;
        b.referrer = referrer.balance;
        b.routerNative = address(router).balance;
        b.routerTokens = IERC20(token).balanceOf(address(router));
    }

    function _finish(Result memory r, ArcDexCurveRouter router, address token, Before memory b, address referrer)
        internal
        view
    {
        r.feeWalletGain = router.feeWallet().balance - b.feeWallet;
        if (referrer != address(0)) r.referrerGain = referrer.balance - b.referrer;
        r.routerLeftNative = address(router).balance - b.routerNative;
        r.routerLeftTokens = IERC20(token).balanceOf(address(router)) - b.routerTokens;
        r.mercuriReferrerOfRouter = IMercuriFeeManager(MERCURI_FEE_MANAGER).referrerOf(address(router));
    }
}
