// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ArcDexSwapRouter, PoolKey, ISwapRouter02} from "../ArcDexSwapRouter.sol";

contract MockToken is ERC20 {
    uint8 private immutable _dec;
    mapping(address => bool) public blocked; // like USDC's blacklist
    constructor(string memory n, uint8 d) ERC20(n, n) { _dec = d; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
    function setBlocked(address a, bool b) external { blocked[a] = b; }
    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "blocked");
        super._update(from, to, value);
    }
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
    address friend = makeAddr("friend");
    address other = makeAddr("other");
    address poolManager = makeAddr("poolManager");
    address constant NO_REF = address(0);

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

    function _buy(uint256 amt, address ref) internal returns (uint256) {
        vm.prank(user);
        return router.swapExactInV3(address(usdc), address(meme), 10000, amt, 0, block.timestamp, ref);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(ArcDexSwapRouter.ZeroAddress.selector);
        new ArcDexSwapRouter(address(0), address(v3), address(usdc), feeWallet, owner);
        vm.expectRevert(ArcDexSwapRouter.ZeroAddress.selector);
        new ArcDexSwapRouter(poolManager, address(v3), address(usdc), address(0), owner);
    }

    function test_defaults_twoPercentFee_fifteenPercentReferralShare() public view {
        assertEq(router.VERSION(), 2);
        assertEq(router.feeBps(), 200);
        assertEq(router.MAX_FEE_BPS(), 200);
        assertEq(router.referralShareBps(), 1_500);
    }

    function test_buy_feeTakenInUsdcFromInput() public {
        uint256 out = _buy(100e6, NO_REF);
        assertEq(usdc.balanceOf(feeWallet), 2e6, "2% of 100 USDC");
        assertEq(out, 98e6 * 2);
        assertEq(meme.balanceOf(feeWallet), 0);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(meme.balanceOf(address(router)), 0);
    }

    function test_sell_feeTakenInUsdcFromOutput() public {
        vm.prank(user);
        uint256 out = router.swapExactInV3(address(meme), address(usdc), 10000, 50e6, 0, block.timestamp, NO_REF);
        // gross out = 100e6 USDC, fee 2% of that from the output side
        assertEq(usdc.balanceOf(feeWallet), 2e6);
        assertEq(out, 98e6);
        assertEq(meme.balanceOf(feeWallet), 0, "no fee in the meme token");
    }

    function test_feeCannotExceedTwoPercent() public {
        vm.prank(owner);
        vm.expectRevert(ArcDexSwapRouter.InvalidFeeBps.selector);
        router.setFeeBps(201);
    }

    function test_ownerCanLowerFee_andZeroFeeTakesNothing() public {
        vm.prank(owner);
        router.setFeeBps(0);
        _buy(100e6, friend);
        assertEq(usdc.balanceOf(feeWallet), 0);
        assertEq(usdc.balanceOf(friend), 0);
    }

    // ── referrals ─────────────────────────────────────────────────────

    function test_referral_splitsFee_85_15() public {
        _buy(100e6, friend);
        // fee = 2 USDC → 0.30 to the referrer, 1.70 to the platform
        assertEq(usdc.balanceOf(friend), 0.3e6);
        assertEq(usdc.balanceOf(feeWallet), 1.7e6);
        assertEq(router.referrerOf(user), friend);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_referral_isStickyAndPaysOnLaterTradesWithoutReferrer() public {
        _buy(100e6, friend);
        _buy(100e6, NO_REF); // no referrer passed — still paid to friend
        _buy(100e6, other); // a different referrer can't take over
        assertEq(router.referrerOf(user), friend);
        assertEq(usdc.balanceOf(friend), 0.9e6);
        assertEq(usdc.balanceOf(other), 0);
        assertEq(usdc.balanceOf(feeWallet), 5.1e6);
    }

    function test_referral_paidOnSellsToo() public {
        _buy(10e6, friend);
        uint256 before = usdc.balanceOf(friend);
        vm.prank(user);
        router.swapExactInV3(address(meme), address(usdc), 10000, 50e6, 0, block.timestamp, NO_REF);
        // sell gross = 100 USDC, fee 2 USDC, referrer 15% of it
        assertEq(usdc.balanceOf(friend) - before, 0.3e6);
    }

    function test_referral_selfReferralIgnored() public {
        _buy(100e6, user);
        assertEq(router.referrerOf(user), address(0));
        assertEq(usdc.balanceOf(feeWallet), 2e6);
    }

    function test_referral_blockedReferrerFallsBackToFeeWallet_neverReverts() public {
        _buy(10e6, friend);
        usdc.setBlocked(friend, true);
        uint256 walletBefore = usdc.balanceOf(feeWallet);
        _buy(100e6, NO_REF); // must not revert
        assertEq(usdc.balanceOf(feeWallet) - walletBefore, 2e6, "whole fee to the platform");
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_referralShare_ownerOnly_cappedAtHalf() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        router.setReferralShareBps(1000);
        vm.startPrank(owner);
        vm.expectRevert(ArcDexSwapRouter.InvalidFeeBps.selector);
        router.setReferralShareBps(5_001);
        router.setReferralShareBps(5_000);
        vm.stopPrank();
        _buy(100e6, friend);
        assertEq(usdc.balanceOf(friend), 1e6);
        assertEq(usdc.balanceOf(feeWallet), 1e6);
    }

    function test_referral_emitsEvents() public {
        vm.expectEmit(true, true, false, false, address(router));
        emit ArcDexSwapRouter.ReferrerBound(user, friend);
        vm.expectEmit(true, true, true, true, address(router));
        emit ArcDexSwapRouter.ReferralPaid(friend, user, address(usdc), 0.3e6);
        _buy(100e6, friend);
    }

    // ── guards ────────────────────────────────────────────────────────

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
        router.swapExactInV3(address(usdc), address(meme), 10000, 1e6, 0, block.timestamp, NO_REF);

        PoolKey[] memory keys = new PoolKey[](1);
        keys[0] = PoolKey(address(usdc), address(meme), 10000, 200, address(0));
        vm.prank(user);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.swapExactInV4(keys, address(usdc), 1e6, 0, block.timestamp, NO_REF);
    }

    function test_expiredDeadlineReverts() public {
        vm.warp(1000);
        vm.prank(user);
        vm.expectRevert(ArcDexSwapRouter.DeadlineExpired.selector);
        router.swapExactInV3(address(usdc), address(meme), 10000, 1e6, 0, 999, NO_REF);
    }

    function test_slippageGuard() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ArcDexSwapRouter.InsufficientOutput.selector, 98e6 * 2, 1e30));
        router.swapExactInV3(address(usdc), address(meme), 10000, 100e6, 1e30, block.timestamp, NO_REF);
    }

    function test_v4_rejectsBadPaths() public {
        PoolKey[] memory none = new PoolKey[](0);
        vm.startPrank(user);
        vm.expectRevert(ArcDexSwapRouter.InvalidPath.selector);
        router.swapExactInV4(none, address(usdc), 1e6, 0, block.timestamp, NO_REF);

        PoolKey[] memory unrelated = new PoolKey[](1);
        unrelated[0] = PoolKey(address(meme), address(0xBEEF), 10000, 200, address(0));
        vm.expectRevert(ArcDexSwapRouter.InvalidPath.selector);
        router.swapExactInV4(unrelated, address(usdc), 1e6, 0, block.timestamp, NO_REF);

        PoolKey[] memory tooMany = new PoolKey[](4);
        vm.expectRevert(ArcDexSwapRouter.InvalidPath.selector);
        router.swapExactInV4(tooMany, address(usdc), 1e6, 0, block.timestamp, NO_REF);
        vm.stopPrank();
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(ArcDexSwapRouter.NotPoolManager.selector);
        router.unlockCallback("");
    }

    function test_zeroAmountReverts() public {
        vm.prank(user);
        vm.expectRevert(ArcDexSwapRouter.ZeroAmount.selector);
        router.swapExactInV3(address(usdc), address(meme), 10000, 0, 0, block.timestamp, NO_REF);
    }

    function test_rescueTokens_ownerOnly_sendsToOwner() public {
        usdc.mint(address(router), 5e6);
        vm.prank(owner);
        router.rescueTokens(address(usdc), 5e6);
        assertEq(usdc.balanceOf(owner), 5e6);
    }

    function testFuzz_feeNeverExceedsTwoPercent_andSplitsExactly(uint96 amountIn, bool referred) public {
        amountIn = uint96(bound(amountIn, 1, 500e6));
        _buy(amountIn, referred ? friend : NO_REF);
        uint256 totalFee = usdc.balanceOf(feeWallet) + usdc.balanceOf(friend);
        assertLe(totalFee * 50, uint256(amountIn), "total fee <= 2%");
        assertEq(totalFee, (uint256(amountIn) * 200) / 10_000, "platform + referrer = the whole fee, nothing lost");
        assertEq(usdc.balanceOf(address(router)), 0);
    }
}
