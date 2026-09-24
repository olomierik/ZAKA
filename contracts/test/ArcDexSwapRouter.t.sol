// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ArcDexSwapRouter, PoolKey, ISwapRouter02} from "../ArcDexSwapRouter.sol";

contract MockToken is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory n, uint8 d) ERC20(n, n) { _dec = d; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// Stands in for SwapRouter02: pulls tokenIn, pays out `rate` tokenOut per
/// tokenIn unit. Real-pool behaviour is covered by scripts/sim-swap-router.mjs
/// against Arc's actual node; these tests cover the router's own rules.
contract MockSwapRouter02 {
    uint256 public rate = 2;
    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        ERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        out = p.amountIn * rate;
        MockToken(p.tokenOut).mint(p.recipient, out);
    }
}

contract ArcDexSwapRouterTest is Test {
    ArcDexSwapRouter router;
    MockSwapRouter02 v3;
    MockToken usdc;
    MockToken meme;
    address owner = makeAddr("owner");
    address feeWallet = makeAddr("feeWallet");
    address user = makeAddr("user");
    address poolManager = makeAddr("poolManager");

    function setUp() public {
        usdc = new MockToken("USDC", 6);
        meme = new MockToken("MEME", 18);
        v3 = new MockSwapRouter02();
        router = new ArcDexSwapRouter(poolManager, address(v3), address(usdc), feeWallet, owner);
        usdc.mint(user, 1_000e6);
        meme.mint(user, 1_000e18);
        vm.startPrank(user);
        usdc.approve(address(router), type(uint256).max);
        meme.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(ArcDexSwapRouter.ZeroAddress.selector);
        new ArcDexSwapRouter(address(0), address(v3), address(usdc), feeWallet, owner);
        vm.expectRevert(ArcDexSwapRouter.ZeroAddress.selector);
        new ArcDexSwapRouter(poolManager, address(v3), address(usdc), address(0), owner);
    }

    function test_defaultFeeIsOnePercent() public view {
        assertEq(router.feeBps(), 100);
        assertEq(router.MAX_FEE_BPS(), 100);
    }

    function test_buy_feeTakenInUsdcFromInput() public {
        vm.prank(user);
        uint256 out = router.swapExactInV3(address(usdc), address(meme), 10000, 100e6, 0, block.timestamp);
        assertEq(usdc.balanceOf(feeWallet), 1e6, "1% of 100 USDC");
        assertEq(out, 99e6 * 2);
        assertEq(meme.balanceOf(feeWallet), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(meme.balanceOf(address(router)), 0);
    }

    function test_sell_feeTakenInUsdcFromOutput() public {
        vm.prank(user);
        uint256 out = router.swapExactInV3(address(meme), address(usdc), 10000, 50e6, 0, block.timestamp);
        // gross out = 100e6 USDC, fee 1% of that from the output side
        assertEq(usdc.balanceOf(feeWallet), 1e6);
        assertEq(out, 99e6);
        assertEq(meme.balanceOf(feeWallet), 0, "no fee in the meme token");
    }

    function test_feeCannotExceedOnePercent() public {
        vm.prank(owner);
        vm.expectRevert(ArcDexSwapRouter.InvalidFeeBps.selector);
        router.setFeeBps(101);
    }

    function test_ownerCanLowerFee_andZeroFeeTakesNothing() public {
        vm.prank(owner);
        router.setFeeBps(0);
        vm.prank(user);
        router.swapExactInV3(address(usdc), address(meme), 10000, 100e6, 0, block.timestamp);
        assertEq(usdc.balanceOf(feeWallet), 0);
    }

    function test_onlyOwnerAdmin() public {
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        router.setFeeBps(50);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        router.setFeeWallet(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        router.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        router.rescueTokens(address(usdc), 1);
        vm.stopPrank();
    }

    function test_setFeeWallet_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(ArcDexSwapRouter.ZeroAddress.selector);
        router.setFeeWallet(address(0));
    }

    function test_pauseBlocksSwaps() public {
        vm.prank(owner);
        router.pause();
        vm.prank(user);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.swapExactInV3(address(usdc), address(meme), 10000, 1e6, 0, block.timestamp);

        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = PoolKey(address(usdc), address(meme), 10000, 200, address(0));
        vm.prank(user);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.swapExactInV4(keys, address(usdc), 1e6, 0, block.timestamp);
    }

    function test_expiredDeadlineReverts() public {
        vm.warp(1000);
        vm.prank(user);
        vm.expectRevert(ArcDexSwapRouter.DeadlineExpired.selector);
        router.swapExactInV3(address(usdc), address(meme), 10000, 1e6, 0, 999);
    }

    function test_slippageGuard() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ArcDexSwapRouter.InsufficientOutput.selector, 99e6 * 2, 1e30));
        router.swapExactInV3(address(usdc), address(meme), 10000, 100e6, 1e30, block.timestamp);
    }

    function test_v4_rejectsBadPaths() public {
        PoolKey[] memory none = new PoolKey[](0);
        vm.startPrank(user);
        vm.expectRevert(ArcDexSwapRouter.InvalidPath.selector);
        router.swapExactInV4(none, address(usdc), 1e6, 0, block.timestamp);

        PoolKey[] memory unrelated = new PoolKey[](1);
        unrelated[0] = PoolKey(address(meme), address(0xBEEF), 10000, 200, address(0));
        vm.expectRevert(ArcDexSwapRouter.InvalidPath.selector);
        router.swapExactInV4(unrelated, address(usdc), 1e6, 0, block.timestamp);

        PoolKey[] memory tooMany = new PoolKey[](4);
        vm.expectRevert(ArcDexSwapRouter.InvalidPath.selector);
        router.swapExactInV4(tooMany, address(usdc), 1e6, 0, block.timestamp);
        vm.stopPrank();
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(ArcDexSwapRouter.NotPoolManager.selector);
        router.unlockCallback("");
    }

    function test_zeroAmountReverts() public {
        vm.prank(user);
        vm.expectRevert(ArcDexSwapRouter.ZeroAmount.selector);
        router.swapExactInV3(address(usdc), address(meme), 10000, 0, 0, block.timestamp);
    }

    function test_rescueTokens_ownerOnly_sendsToOwner() public {
        usdc.mint(address(router), 5e6);
        vm.prank(owner);
        router.rescueTokens(address(usdc), 5e6);
        assertEq(usdc.balanceOf(owner), 5e6);
    }

    function testFuzz_feeNeverExceedsOnePercent(uint96 amountIn) public {
        amountIn = uint96(bound(amountIn, 1, 500e6));
        vm.prank(user);
        router.swapExactInV3(address(usdc), address(meme), 10000, amountIn, 0, block.timestamp);
        assertLe(usdc.balanceOf(feeWallet) * 100, uint256(amountIn));
        assertEq(usdc.balanceOf(address(router)), 0);
    }
}
