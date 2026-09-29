// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Honeypot probe for the market engine's safety scanner
/// (engine/src/intel/honeypot.ts). Never deployed: injected with an eth_call
/// state override, like the other harnesses here, because Arc's USDC moves
/// through a chain precompile that a Foundry fork can't run. Everything
/// below happens inside one simulated call against Arc's real pools and
/// hooks; nothing is sent.
///
/// One probe: buy a little of the coin, pass it to a fresh address (a new
/// ProbeSeller), and sell it from there. Each step reports on its own, so
/// the scanner can tell:
///   buy reverted         the pool won't trade with us (a hook that allows
///                        only its own router): unknown, not a honeypot
///   transfer reverted    the coin blocks transfers between wallets
///   sell reverted        a holder can't sell: honeypot
///   received < swapped   a fee or tax taken in the token itself
///   sold for little      the round trip's cost: pool fees, hook taxes, tax
/// A second holder selling is what catches coins that let only the first
/// buyer (or a whitelist) sell.

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// SwapRouter02 (Arc's 0x53BF…6F77): exactInputSingle without a deadline.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

/// Exact-input swaps along 1-3 v4 pools, or one v3 pool. Native USDC
/// (currency 0x0) is paid with value and received as balance.
abstract contract ProbeSwapper {
    IPoolManager internal constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    ISwapRouter02 internal constant ROUTER02 = ISwapRouter02(0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77);

    error NotPoolManager();
    error BadPath();

    receive() external payable {}

    function _balance(address currency) internal view returns (uint256) {
        return currency == address(0) ? address(this).balance : IERC20Min(currency).balanceOf(address(this));
    }

    /// Returns what the pools paid out (before any tax the token takes on the way to us).
    function _swapV4(PoolKey[] memory path, address tokenIn, uint256 amountIn) internal returns (uint256 out) {
        if (path.length == 0 || path.length > 3) revert BadPath();
        out = abi.decode(PM.unlock(abi.encode(path, tokenIn, amountIn)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(PM)) revert NotPoolManager();
        (PoolKey[] memory path, address tokenIn, uint256 amountIn) = abi.decode(data, (PoolKey[], address, uint256));
        address cur = tokenIn;
        uint256 hopIn = amountIn;
        uint256 owed;
        for (uint256 i = 0; i < path.length; i++) {
            bool z;
            if (cur == path[i].currency0) z = true;
            else if (cur != path[i].currency1) revert BadPath();
            int256 delta = PM.swap(
                path[i],
                SwapParams({zeroForOne: z, amountSpecified: -int256(hopIn), sqrtPriceLimitX96: z ? 4295128740 : 1461446703485210103287273052203988822378723970341}),
                ""
            );
            int128 dIn = z ? int128(delta >> 128) : int128(delta);
            int128 dOut = z ? int128(delta) : int128(delta >> 128);
            if (i == 0) owed = uint256(uint128(-dIn));
            hopIn = uint256(uint128(dOut));
            cur = z ? path[i].currency1 : path[i].currency0;
        }
        PM.sync(tokenIn);
        if (tokenIn == address(0)) {
            PM.settle{value: owed}();
        } else {
            IERC20Min(tokenIn).transfer(address(PM), owed);
            PM.settle();
        }
        PM.take(cur, address(this), hopIn);
        return abi.encode(hopIn);
    }

    function _swapV3(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) internal returns (uint256) {
        IERC20Min(tokenIn).approve(address(ROUTER02), amountIn);
        return ROUTER02.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams(tokenIn, tokenOut, fee, address(this), amountIn, 0, 0)
        );
    }
}

/// The second holder: sells what it was sent.
contract ProbeSeller is ProbeSwapper {
    function sellV4(PoolKey[] calldata path, address token, address quote, uint256 amount) external returns (uint256 got) {
        uint256 before = _balance(quote);
        _swapV4(path, token, amount);
        got = _balance(quote) - before;
    }

    function sellV3(address token, address quote, uint24 fee, uint256 amount) external returns (uint256 got) {
        uint256 before = _balance(quote);
        _swapV3(token, quote, fee, amount);
        got = _balance(quote) - before;
    }
}

contract HoneypotProbe is ProbeSwapper {
    struct Result {
        bool bought; // the buy went through
        uint256 swapOut; // tokens the pool paid out
        uint256 received; // tokens that reached the probe
        bool transferred; // passing them to a fresh address worked
        uint256 sellerReceived; // tokens that reached it
        bool sold; // the fresh address could sell
        uint256 soldFor; // quote currency the sale brought
        bytes error; // the first revert's data
    }

    /// `path` goes from `quote` (USDC, native 0x0, or ARGUS via its USDC pool)
    /// to `token`; the sale goes back the same way.
    function probeV4(PoolKey[] calldata path, address token, address quote, uint256 amountIn) external returns (Result memory r) {
        PoolKey[] memory fwd = path;
        uint256 before = IERC20Min(token).balanceOf(address(this));
        try this.buyV4(fwd, quote, amountIn) returns (uint256 out) {
            r.bought = true;
            r.swapOut = out;
        } catch (bytes memory e) {
            r.error = e;
            return r;
        }
        r.received = IERC20Min(token).balanceOf(address(this)) - before;
        ProbeSeller seller = new ProbeSeller();
        if (!_pass(token, address(seller), r)) return r;
        PoolKey[] memory back = new PoolKey[](fwd.length);
        for (uint256 i = 0; i < fwd.length; i++) back[i] = fwd[fwd.length - 1 - i];
        try seller.sellV4(back, token, quote, r.sellerReceived) returns (uint256 got) {
            r.sold = true;
            r.soldFor = got;
        } catch (bytes memory e) {
            r.error = e;
        }
    }

    function probeV3(address token, address quote, uint24 fee, uint256 amountIn) external returns (Result memory r) {
        uint256 before = IERC20Min(token).balanceOf(address(this));
        try this.buyV3(token, quote, fee, amountIn) returns (uint256 out) {
            r.bought = true;
            r.swapOut = out;
        } catch (bytes memory e) {
            r.error = e;
            return r;
        }
        r.received = IERC20Min(token).balanceOf(address(this)) - before;
        ProbeSeller seller = new ProbeSeller();
        if (!_pass(token, address(seller), r)) return r;
        try seller.sellV3(token, quote, fee, r.sellerReceived) returns (uint256 got) {
            r.sold = true;
            r.soldFor = got;
        } catch (bytes memory e) {
            r.error = e;
        }
    }

    /// External so a revert inside can be caught (only the probe may call it).
    function buyV4(PoolKey[] calldata path, address quote, uint256 amountIn) external returns (uint256) {
        if (msg.sender != address(this)) revert BadPath();
        return _swapV4(path, quote, amountIn);
    }

    function buyV3(address token, address quote, uint24 fee, uint256 amountIn) external returns (uint256) {
        if (msg.sender != address(this)) revert BadPath();
        return _swapV3(quote, token, fee, amountIn);
    }

    function _pass(address token, address to, Result memory r) internal returns (bool) {
        try IERC20Min(token).transfer(to, r.received) returns (bool ok) {
            r.transferred = ok;
        } catch (bytes memory e) {
            r.error = e;
            return false;
        }
        if (!r.transferred) return false;
        r.sellerReceived = IERC20Min(token).balanceOf(to);
        return r.sellerReceived > 0;
    }
}
