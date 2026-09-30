// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// The live bot's pre-flight check (engine/src/trading/preflight.ts), run
/// before every live buy. Never deployed: for one eth_call this code is put
/// at the bot wallet's own address with a state override, so each step below
/// runs as the bot itself, with its real USDC: the exact buy it is about to
/// send, the approvals its sale needs, and the sale of everything the buy
/// delivered, through the same router, pool and hook. Nothing is sent.
///
/// The engine buys only when every step goes through and the sale brings
/// USDC back: a coin the bot could buy but not sell (a honeypot, a hook that
/// blocks this wallet or router, a tax that eats the sale) is never bought.
///
/// A step's `patches` are byte offsets into its calldata where the wallet's
/// balance of `token` at that moment is written first (a 32-byte word): the
/// sale's amount isn't known until the buy has run. Each step reports its
/// gas, so the real transactions get limits measured on the real pool.

contract BotRoundTrip {
    struct Step {
        address to;
        uint256 value;
        bytes data;
        uint256[] patches;
    }

    struct Result {
        bool ok;
        uint256 gasUsed;
        /// The wallet's USDC after the step (native, 18 decimals; on Arc it is also the ERC-20's balance).
        uint256 usdc;
        /// The wallet's balance of `token` after the step.
        uint256 tokens;
        bytes ret;
    }

    /// Runs `steps` in order, stopping at the first that reverts.
    function run(address token, Step[] calldata steps) external returns (uint256 usdc0, uint256 tokens0, Result[] memory out) {
        usdc0 = address(this).balance;
        tokens0 = _balance(token);
        out = new Result[](steps.length);
        for (uint256 i; i < steps.length; ++i) {
            bytes memory data = steps[i].data;
            uint256[] calldata patches = steps[i].patches;
            if (patches.length != 0) {
                uint256 bal = _balance(token);
                for (uint256 j; j < patches.length; ++j) {
                    uint256 at = patches[j];
                    require(at + 32 <= data.length, "patch out of range");
                    assembly {
                        mstore(add(add(data, 32), at), bal)
                    }
                }
            }
            uint256 g = gasleft();
            (bool ok, bytes memory ret) = steps[i].to.call{value: steps[i].value}(data);
            uint256 used = g - gasleft();
            out[i] = Result(ok, used, address(this).balance, _balance(token), ret);
            if (!ok) break;
        }
    }

    /// A coin's balanceOf, or 0 if it won't answer.
    function _balance(address token) private view returns (uint256) {
        (bool ok, bytes memory r) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        return ok && r.length >= 32 ? abi.decode(r, (uint256)) : 0;
    }

    /// The router sweeps unspent USDC back, and native-USDC sales pay here.
    receive() external payable {}
}
