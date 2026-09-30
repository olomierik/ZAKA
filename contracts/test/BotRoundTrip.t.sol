// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BotRoundTrip} from "./sim/BotRoundTrip.sol";

/// The live bot's pre-flight harness (sim/BotRoundTrip.sol) against stand-in
/// router, Permit2 and coin contracts that decode the same Universal Router
/// calls the engine sends (engine/src/trading/live.ts encodeBuy/encodeSell,
/// native-USDC pool). No cheatcodes, so the same file also runs in any EVM:
///   forge test --match-contract BotRoundTripTest
contract BotRoundTripTest {
    uint256 constant SENTINEL = 0x5e11a11c0115e11a11c0115e11a11c01; // engine/src/trading/preflight.ts
    BotRoundTrip bot;
    MockPermit2 permit2;
    MockRouter router;
    MockCoin coin;

    receive() external payable {}

    function _world(uint8 mode, uint256 botUsdc) private {
        bot = new BotRoundTrip();
        if (botUsdc > 0) payable(address(bot)).transfer(botUsdc);
        permit2 = new MockPermit2();
        router = new MockRouter(permit2);
        coin = new MockCoin(mode, address(router));
    }

    function _steps(uint256 usdcIn, uint256 minOut) private view returns (BotRoundTrip.Step[] memory s) {
        bytes memory sell = _sell(SENTINEL);
        s = new BotRoundTrip.Step[](4);
        s[0] = BotRoundTrip.Step(address(router), usdcIn, _buy(usdcIn, minOut), new uint256[](0));
        s[1] = BotRoundTrip.Step(address(coin), 0, abi.encodeWithSignature("approve(address,uint256)", address(permit2), type(uint256).max), new uint256[](0));
        s[2] = BotRoundTrip.Step(address(permit2), 0, abi.encodeWithSignature("approve(address,address,uint160,uint48)", address(coin), address(router), type(uint160).max, uint48(block.timestamp + 30 days)), new uint256[](0));
        s[3] = BotRoundTrip.Step(address(router), 0, sell, _patches(sell));
    }

    function test_aSellableCoinRoundTrips() public {
        _world(0, 100 ether);
        (uint256 usdc0, uint256 tokens0, BotRoundTrip.Result[] memory r) = bot.run(address(coin), _steps(5 ether, 4500 ether));
        require(usdc0 == 100 ether && tokens0 == 0, "start");
        for (uint256 i; i < 4; ++i) require(r[i].ok && r[i].gasUsed > 0, "every step ran");
        require(r[0].tokens == 5000 ether && r[0].usdc == 95 ether, "the buy: 5 USDC for 5000 coins");
        require(r[3].tokens == 0, "the sale sold the whole balance (both amounts patched)");
        require(r[3].usdc == 95 ether + 4.9 ether, "the sale paid 98% back");
    }

    function test_aHoneypotStopsAtTheSale() public {
        _world(1, 100 ether);
        (,, BotRoundTrip.Result[] memory r) = bot.run(address(coin), _steps(5 ether, 0));
        require(r[0].ok && r[1].ok && r[2].ok && !r[3].ok, "bought, couldn't sell");
        require(keccak256(r[3].ret) == keccak256(abi.encodeWithSignature("Error(string)", "HONEYPOT")), "the reason comes back");
    }

    function test_theFirstFailureStopsTheRest() public {
        _world(2, 100 ether);
        (,, BotRoundTrip.Result[] memory r) = bot.run(address(coin), _steps(5 ether, 0));
        require(r[0].ok && !r[1].ok, "the approval failed");
        require(!r[2].ok && r[2].gasUsed == 0 && !r[3].ok && r[3].gasUsed == 0, "nothing after it ran");
    }

    function test_aMinimumThePoolCantMeetFailsTheBuy() public {
        _world(0, 100 ether);
        (,, BotRoundTrip.Result[] memory r) = bot.run(address(coin), _steps(5 ether, 5001 ether));
        require(!r[0].ok && r[0].tokens == 0, "no buy");
    }

    function test_aWalletThatCantPayFailsTheBuy() public {
        _world(0, 1 ether);
        (,, BotRoundTrip.Result[] memory r) = bot.run(address(coin), _steps(5 ether, 0));
        require(!r[0].ok, "no buy");
    }

    function test_aPatchPastTheEndReverts() public {
        _world(0, 100 ether);
        BotRoundTrip.Step[] memory s = new BotRoundTrip.Step[](1);
        uint256[] memory at = new uint256[](1);
        at[0] = 10;
        s[0] = BotRoundTrip.Step(address(coin), 0, hex"0102", at);
        try bot.run(address(coin), s) { revert("should revert"); } catch Error(string memory why) { require(keccak256(bytes(why)) == keccak256("patch out of range"), why); }
    }

    // ── the engine's calls, as encoded in trading/live.ts (native-USDC pool) ──

    function _key() private view returns (PoolKey memory) { return PoolKey(address(0), address(coin), 10_000, 200, address(0)); }

    function _buy(uint256 amountIn, uint256 minOut) private view returns (bytes memory) {
        bytes[] memory p = new bytes[](3);
        p[0] = abi.encode(ExactIn(_key(), true, uint128(amountIn), uint128(minOut), 0, ""));
        p[1] = abi.encode(address(0), amountIn); // SETTLE_ALL native
        p[2] = abi.encode(address(coin), minOut); // TAKE_ALL
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f)), p);
        inputs[1] = abi.encode(address(0), address(bot), uint256(0)); // SWEEP
        return abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"1004", inputs, block.timestamp + 120);
    }

    function _sell(uint256 amount) private view returns (bytes memory) {
        bytes[] memory p = new bytes[](3);
        p[0] = abi.encode(ExactIn(_key(), false, uint128(amount), 0, 0, ""));
        p[1] = abi.encode(address(coin), amount); // SETTLE_ALL the coin, through Permit2
        p[2] = abi.encode(address(0), uint256(0)); // TAKE_ALL the USDC
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f)), p);
        return abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"10", inputs, block.timestamp + 120);
    }

    /// Where the SENTINEL word sits in `data` (preflight.ts patchesOf).
    function _patches(bytes memory data) private pure returns (uint256[] memory at) {
        uint256 n;
        uint256[] memory found = new uint256[](8);
        for (uint256 i; i + 32 <= data.length; ++i) {
            uint256 w;
            assembly { w := mload(add(add(data, 32), i)) }
            if (w == SENTINEL) found[n++] = i;
        }
        require(n == 2, "the sale's amount appears twice");
        at = new uint256[](n);
        for (uint256 i; i < n; ++i) at[i] = found[i];
    }
}

struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct ExactIn { PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; uint256 minHopPriceX36; bytes hookData; }

/// mode 0: an ordinary coin; 1: a honeypot (it can't be sold to the pool); 2: it refuses approvals.
contract MockCoin {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 immutable mode;
    address immutable pool;
    constructor(uint8 m, address p) { mode = m; pool = p; }
    function mint(address to, uint256 a) external { require(msg.sender == pool, "only the pool"); balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { require(mode != 2, "no approvals"); allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(!(mode == 1 && to == pool), "HONEYPOT");
        if (msg.sender != f) { require(allowance[f][msg.sender] >= a, "allowance"); allowance[f][msg.sender] -= a; }
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract MockPermit2 {
    struct A { uint160 amount; uint48 expiration; }
    mapping(address => mapping(address => mapping(address => A))) allow;
    function approve(address token, address spender, uint160 amount, uint48 expiration) external { allow[msg.sender][token][spender] = A(amount, expiration); }
    function transferFrom(address from, address to, uint160 amount, address token) external {
        A storage a = allow[from][token][msg.sender];
        require(a.amount >= amount && a.expiration >= block.timestamp, "permit2");
        MockCoin(token).transferFrom(from, to, amount);
    }
}

contract MockVault {
    function pay(address to, uint256 amount) external { (bool ok,) = to.call{value: amount}(""); require(ok, "pay"); }
    receive() external payable {}
}

/// Decodes the engine's calls like the Universal Router: 1 USDC buys 1000 coins; a sale pays 98% of that rate.
contract MockRouter {
    MockPermit2 immutable permit2;
    MockVault immutable vault = new MockVault();
    constructor(MockPermit2 p) { permit2 = p; }
    receive() external payable {}
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        require(block.timestamp <= deadline, "DeadlinePassed");
        for (uint256 i; i < commands.length; ++i) {
            if (uint8(commands[i]) == 0x10) _swap(inputs[i]);
            else if (uint8(commands[i]) == 0x04) {
                (, address to,) = abi.decode(inputs[i], (address, address, uint256));
                if (address(this).balance > 0) { (bool ok,) = to.call{value: address(this).balance}(""); require(ok, "sweep"); }
            } else revert("command");
        }
    }
    function _swap(bytes calldata input) private {
        (, bytes[] memory p) = abi.decode(input, (bytes, bytes[]));
        ExactIn memory s = abi.decode(p[0], (ExactIn));
        address coin = s.poolKey.currency1;
        if (s.zeroForOne) {
            (, uint256 max) = abi.decode(p[1], (address, uint256));
            require(max >= s.amountIn && address(this).balance >= s.amountIn, "settle");
            uint256 out = uint256(s.amountIn) * 1000;
            require(out >= s.amountOutMinimum, "V4TooLittleReceived");
            payable(address(vault)).transfer(s.amountIn);
            MockCoin(coin).mint(msg.sender, out);
        } else {
            (, uint256 max) = abi.decode(p[1], (address, uint256));
            require(max >= s.amountIn, "settle");
            permit2.transferFrom(msg.sender, address(this), s.amountIn, coin);
            uint256 out = uint256(s.amountIn) * 98 / 100 / 1000;
            require(out >= s.amountOutMinimum, "V4TooLittleReceived");
            vault.pay(msg.sender, out);
        }
    }
}
