// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SensePerps, SenseOracle, SenseTestUSDC, SignedPrice} from "../SensePerps.sol";

/// ARCSENSE futures: the pool, positions, requests, liquidations, the oracle's checks, and the
/// books balancing after every step. Prices are signed here by five test signers (threshold 3),
/// exactly as RedStone's nodes sign them; testRealRedstonePackages checks real ones.
contract SensePerpsTest is Test {
    SenseTestUSDC usdc;
    SenseOracle oracle;
    SensePerps perps;

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address feeWallet = makeAddr("feeWallet");
    address lp = makeAddr("lp");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    uint256[5] pks;
    address[] signerAddrs;

    bytes32 constant BTC = bytes32("BTC");
    bytes32 constant ETH = bytes32("ETH");
    uint32 constant M_BTC = 0;
    uint32 constant M_ETH = 1;
    uint256 constant P0 = 100_000e8; // BTC
    uint256 constant E0 = 4_000e8; // ETH
    uint256 constant EXEC = 20_000;

    function setUp() public {
        vm.warp(1_800_000_000);
        for (uint256 i; i < 5; ++i) {
            pks[i] = 0xA11CE + i;
            signerAddrs.push(vm.addr(pks[i]));
        }
        usdc = new SenseTestUSDC(address(this), 0);
        oracle = new SenseOracle(owner, signerAddrs, 3);
        SensePerps.MarketParams[] memory ms = new SensePerps.MarketParams[](2);
        ms[0] = _params(BTC);
        ms[1] = _params(ETH);
        perps = new SensePerps(IERC20(address(usdc)), oracle, owner, feeWallet, keeper, ms);
        address[4] memory users = [lp, alice, bob, stranger];
        for (uint256 i; i < users.length; ++i) {
            usdc.mint(users[i], 10_000_000e6);
            vm.prank(users[i]);
            usdc.approve(address(perps), type(uint256).max);
        }
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _params(bytes32 feed) internal pure returns (SensePerps.MarketParams memory p) {
        p.feedId = feed;
        p.enabled = true;
        p.maxLeverage = 10;
        p.openFeeBps = 8;
        p.closeFeeBps = 8;
        p.liquidationBps = 100;
        p.borrowRatePerHour = 2.5e13; // 0.0025% an hour
        p.maxOiLong = 5_000_000e6;
        p.maxOiShort = 5_000_000e6;
    }

    function _feed(uint32 m) internal pure returns (bytes32) {
        return m == M_BTC ? BTC : ETH;
    }

    function _sig(uint256 pk, bytes32 feed, uint256 value, uint64 ts) internal pure returns (bytes memory) {
        bytes32 h = keccak256(abi.encodePacked(feed, value, uint48(ts), uint32(32), uint24(1)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(r, s, v);
    }

    function _nowMs() internal view returns (uint64) {
        return uint64(block.timestamp * 1000);
    }

    function _pxAt(bytes32 feed, uint256 value, uint64 ts) internal view returns (SignedPrice[] memory p) {
        p = new SignedPrice[](3);
        for (uint256 i; i < 3; ++i) {
            p[i] = SignedPrice(feed, value, ts, _sig(pks[i], feed, value, ts));
        }
    }

    function _px(bytes32 feed, uint256 value) internal view returns (SignedPrice[] memory) {
        return _pxAt(feed, value, _nowMs());
    }

    function _px2(uint256 btc, uint256 eth) internal view returns (SignedPrice[] memory p) {
        SignedPrice[] memory a = _px(BTC, btc);
        SignedPrice[] memory b = _px(ETH, eth);
        p = new SignedPrice[](6);
        for (uint256 i; i < 3; ++i) {
            p[i] = a[i];
            p[i + 3] = b[i];
        }
    }

    function _seed(uint256 amount) internal {
        vm.prank(lp);
        uint256 id = perps.requestDeposit(amount, 0);
        vm.prank(keeper);
        perps.executeRequest(id, new SignedPrice[](0));
    }

    function _request(address who, uint32 m, bool isLong, uint256 coll, uint256 size) internal returns (uint256 id) {
        vm.prank(who);
        id = perps.requestOpen(m, isLong, coll, size, isLong ? type(uint128).max : 1, 0, 0, 0);
    }

    function _open(address who, uint32 m, bool isLong, uint256 coll, uint256 size, uint256 price)
        internal
        returns (uint256 pid)
    {
        uint256 id = _request(who, m, isLong, coll, size);
        vm.warp(block.timestamp + 3);
        vm.prank(keeper);
        perps.executeRequest(id, _px(_feed(m), price));
        pid = perps.nextPositionId() - 1;
        _books();
    }

    function _close(address who, uint256 pid, uint32 m, uint256 price) internal {
        vm.prank(who);
        uint256 id = perps.requestClose(pid, 0);
        vm.warp(block.timestamp + 3);
        vm.prank(keeper);
        perps.executeRequest(id, _px(_feed(m), price));
        _books();
    }

    /// With no position open, every market's sides are empty: nothing left in the sums that price the pool.
    function _sidesEmpty() internal view {
        SensePerps.Market[] memory ms = perps.getMarkets();
        for (uint256 i; i < ms.length; ++i) {
            assertEq(ms[i].long_.oi + ms[i].short_.oi, 0, "open interest");
            assertEq(ms[i].long_.sizeOverEntry + ms[i].short_.sizeOverEntry, 0, "size over entry");
            assertEq(ms[i].long_.collateral + ms[i].short_.collateral, 0, "side collateral");
            assertEq(ms[i].long_.reserved + ms[i].short_.reserved, 0, "side reserved");
        }
    }

    function _pos(uint256 pid) internal view returns (SensePerps.Position memory) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = pid;
        return perps.getPositions(ids)[0];
    }

    function _req(uint256 id) internal view returns (SensePerps.Request memory) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        return perps.getRequests(ids)[0];
    }

    /// The contract holds exactly what it owes: the pool, traders' collateral and pending requests.
    function _books() internal view {
        assertEq(
            usdc.balanceOf(address(perps)), perps.poolAmount() + perps.totalCollateral() + perps.escrowed(), "books"
        );
        assertGe(perps.poolAmount(), perps.totalReserved(), "pool covers every reserved profit");
    }

    // ─── liquidity ───────────────────────────────────────────────────────────

    function testFirstDepositMintsShares() public {
        _seed(1_000_000e6);
        assertEq(perps.balanceOf(lp), 1_000_000e6 - 1_000);
        assertEq(perps.balanceOf(address(0xdEaD)), 1_000);
        assertEq(perps.poolAmount(), 1_000_000e6);
        assertEq(usdc.balanceOf(keeper), EXEC, "the keeper is paid its execution fee");
        _books();
    }

    function testWithdrawAfterCooldownReturnsUsdc() public {
        _seed(1_000_000e6);
        uint256 shares = perps.balanceOf(lp);
        vm.prank(lp);
        vm.expectRevert(SensePerps.Cooldown.selector);
        perps.requestWithdraw(shares, 0);
        vm.warp(block.timestamp + 15 minutes);
        uint256 before = usdc.balanceOf(lp);
        vm.prank(lp);
        uint256 id = perps.requestWithdraw(shares, 0);
        vm.prank(keeper);
        perps.executeRequest(id, new SignedPrice[](0));
        assertEq(usdc.balanceOf(lp) - before + EXEC, 1_000_000e6 - 1_000 + 0, "shares redeemed at par, less the fee");
        _books();
    }

    function testSharesCantMoveDuringCooldown() public {
        _seed(1_000_000e6);
        vm.prank(lp);
        vm.expectRevert(SensePerps.Cooldown.selector);
        perps.transfer(bob, 1e6);
        vm.warp(block.timestamp + 15 minutes);
        vm.prank(lp);
        perps.transfer(bob, 1e6);
        assertEq(perps.balanceOf(bob), 1e6);
    }

    function testReservedLiquidityCantBeWithdrawn() public {
        _seed(100_000e6);
        // 10x long, $10,000 collateral: reserves min(9 x collateral, size) = $89,280 of $100,000.
        _open(alice, M_BTC, true, 10_000e6, 100_000e6, P0);
        assertApproxEqAbs(perps.totalReserved(), 89_280e6, 1);
        vm.warp(block.timestamp + 15 minutes);
        uint256 shares = perps.balanceOf(lp);
        vm.prank(lp);
        uint256 id = perps.requestWithdraw(shares, 0);
        vm.warp(block.timestamp + 1);
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit SensePerps.RequestCancelled(id, lp, "liquidity in use");
        perps.executeRequest(id, _px(BTC, P0));
        assertEq(perps.balanceOf(lp), shares, "shares returned");
        _books();
    }

    function testDepositorPaysForUncollectedGains() public {
        _seed(1_000_000e6);
        _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        // BTC -5%: alice is down $500; the pool stands to collect it.
        vm.prank(bob);
        uint256 id = perps.requestDeposit(100_000e6, 0);
        vm.warp(block.timestamp + 2);
        vm.prank(keeper);
        perps.executeRequest(id, _px(BTC, 95_000e8));
        uint256 supply = perps.totalSupply() - perps.balanceOf(bob);
        uint256 expected = 100_000e6 * supply / (perps.poolAmount() - 100_000e6 + 500e6);
        assertApproxEqAbs(perps.balanceOf(bob), expected, 2, "priced with the unrealized gain");
        assertLt(perps.balanceOf(bob), 100_000e6 * supply / (perps.poolAmount() - 100_000e6));
        _books();
    }

    function testWithdrawerDoesNotTakeUncollectedGains() public {
        _seed(1_000_000e6);
        _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        vm.warp(block.timestamp + 15 minutes);
        uint256 shares = perps.balanceOf(lp) / 10;
        uint256 pool = perps.poolAmount();
        uint256 supply = perps.totalSupply();
        uint256 before = usdc.balanceOf(lp);
        vm.prank(lp);
        uint256 id = perps.requestWithdraw(shares, 0);
        vm.warp(block.timestamp + 2);
        vm.prank(keeper);
        perps.executeRequest(id, _px(BTC, 95_000e8)); // alice down $500: not counted
        assertEq(usdc.balanceOf(lp) + EXEC - before, shares * pool / supply);
        _books();
    }

    function testLiquidityProvidersEarnTraderLosses() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        _close(alice, pid, M_BTC, 96_000e8); // alice loses $400 + fees
        assertGt(perps.poolAmount(), 1_000_000e6 + 400e6);
        vm.warp(block.timestamp + 15 minutes);
        uint256 shares = perps.balanceOf(lp);
        vm.prank(lp);
        uint256 id = perps.requestWithdraw(shares, 0);
        vm.prank(keeper);
        perps.executeRequest(id, new SignedPrice[](0));
        assertGt(usdc.balanceOf(lp), 10_000_000e6 + 399.9e6, "the LP keeps alice's $400 loss");
        _books();
    }

    // ─── positions ───────────────────────────────────────────────────────────

    function testOpenLong() public {
        _seed(1_000_000e6);
        uint256 feeBefore = usdc.balanceOf(feeWallet);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        SensePerps.Position memory p = _pos(pid);
        assertEq(p.trader, alice);
        assertTrue(p.isLong);
        assertEq(p.size, 10_000e6);
        assertEq(p.collateral, 992e6, "8 bps of size off the collateral");
        assertEq(p.entryPrice, P0);
        assertEq(p.maxProfit, 8_928e6, "9 x collateral");
        assertEq(usdc.balanceOf(feeWallet) - feeBefore, 8e6, "the opening fee goes to the fee wallet");
        assertEq(perps.positionIdsOf(alice).length, 1);
        assertEq(perps.openPositionIds().length, 1);
    }

    function testCloseLongInProfit() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        vm.warp(block.timestamp + 1 hours);
        uint256 before = usdc.balanceOf(alice);
        uint256 feeBefore = usdc.balanceOf(feeWallet);
        _close(alice, pid, M_BTC, 105_000e8);
        // +5% on $10,000 = $500; less ~1h of borrow ($0.25) and the $8 closing fee.
        uint256 got = usdc.balanceOf(alice) + EXEC - before;
        assertApproxEqAbs(got, 992e6 + 500e6 - 250_000 - 8e6, 2_000);
        assertEq(usdc.balanceOf(feeWallet) - feeBefore, 8e6);
        assertEq(perps.openPositionIds().length, 0);
        assertEq(perps.totalReserved(), 0);
        assertEq(perps.totalCollateral(), 0);
        _sidesEmpty();
    }

    function testCloseShortInProfit() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_ETH, false, 1_000e6, 5_000e6, E0);
        uint256 before = usdc.balanceOf(alice);
        _close(alice, pid, M_ETH, 3_600e8); // -10%: the short makes $500
        uint256 got = usdc.balanceOf(alice) + EXEC - before;
        assertApproxEqAbs(got, 996e6 + 500e6 - 4e6, 1_000);
    }

    function testCloseInLossPaysThePool() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        uint256 pool = perps.poolAmount();
        _close(alice, pid, M_BTC, 97_000e8); // -3% = -$300
        assertApproxEqAbs(perps.poolAmount() - pool, 300e6, 1_000, "the loss stays in the pool");
    }

    function testProfitIsCappedAtWhatWasReserved() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        uint256 before = usdc.balanceOf(alice);
        uint256 pool = perps.poolAmount();
        _close(alice, pid, M_BTC, 300_000e8); // +200% would be $20,000
        uint256 got = usdc.balanceOf(alice) + EXEC - before;
        assertApproxEqAbs(got, 992e6 + 8_928e6 - 8e6, 1_000);
        assertApproxEqAbs(pool - perps.poolAmount(), 8_928e6, 1_000);
    }

    function testLowLeverageProfitCappedAtSize() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 2_000e6, P0); // 2x
        assertEq(_pos(pid).maxProfit, 2_000e6, "a 2x position can make at most its size");
    }

    function testBorrowFeeAccrues() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        vm.warp(block.timestamp + 100 hours);
        uint256 before = usdc.balanceOf(alice);
        _close(alice, pid, M_BTC, P0);
        uint256 got = usdc.balanceOf(alice) + EXEC - before;
        // 100h x 0.0025% x $10,000 = $25 of borrow fee, plus the $8 closing fee.
        assertApproxEqAbs(got, 992e6 - 25e6 - 8e6, 2_000);
    }

    function testLiquidation() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        vm.warp(block.timestamp + 5);
        vm.prank(keeper);
        vm.expectRevert(SensePerps.NotLiquidatable.selector);
        perps.liquidate(pid, _px(BTC, 92_000e8)); // equity $192 > $100 + $8

        uint256 before = usdc.balanceOf(alice);
        uint256 pool = perps.poolAmount();
        uint256 feeBefore = usdc.balanceOf(feeWallet);
        vm.prank(keeper);
        perps.liquidate(pid, _px(BTC, 91_000e8)); // equity $92 < $108
        assertEq(usdc.balanceOf(alice), before, "nothing back");
        assertEq(usdc.balanceOf(feeWallet) - feeBefore, 8e6, "the closing fee");
        assertApproxEqAbs(perps.poolAmount() - pool, 984e6, 1, "the rest to the pool");
        _books();
    }

    function testCloseBelowMaintenanceBecomesLiquidation() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 id = perps.requestClose(pid, 0);
        vm.warp(block.timestamp + 3);
        vm.expectEmit(true, true, true, false);
        emit SensePerps.PositionClosed(pid, alice, M_BTC, SensePerps.CloseReason.Liquidation, 0, 0, 0, 0, 0);
        vm.prank(keeper);
        perps.executeRequest(id, _px(BTC, 91_000e8));
        assertEq(usdc.balanceOf(alice), before - EXEC, "nothing back but the close request's fee is spent");
    }

    function testDeepLossNeverTakesMoreThanCollateral() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        uint256 pool = perps.poolAmount();
        vm.warp(block.timestamp + 5);
        vm.prank(keeper);
        perps.liquidate(pid, _px(BTC, 50_000e8)); // -50%: -$5,000 on $992
        assertEq(perps.poolAmount() - pool, 992e6 - 0, "the pool gets the collateral, nothing more");
        _books();
    }

    function testAnyoneCanLiquidateWithAFreshPrice() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        vm.warp(block.timestamp + 100);
        SignedPrice[] memory old = _pxAt(BTC, 91_000e8, _nowMs() - 40_000);
        vm.prank(stranger);
        vm.expectRevert(SensePerps.PriceStale.selector);
        perps.liquidate(pid, old);
        vm.prank(stranger);
        perps.liquidate(pid, _px(BTC, 91_000e8));
        assertEq(perps.openPositionIds().length, 0);
    }

    function testTakeProfitAndStopLoss() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        vm.prank(bob);
        vm.expectRevert(SensePerps.NotAccount.selector);
        perps.setTpSl(pid, 110_000e8, 95_000e8);
        vm.prank(alice);
        perps.setTpSl(pid, 110_000e8, 95_000e8);
        vm.warp(block.timestamp + 2);
        vm.prank(keeper);
        vm.expectRevert(SensePerps.NotTriggered.selector);
        perps.executeTpSl(pid, _px(BTC, 105_000e8));
        vm.prank(stranger);
        vm.expectRevert(SensePerps.NotKeeper.selector);
        perps.executeTpSl(pid, _px(BTC, 111_000e8));
        uint256 before = usdc.balanceOf(alice);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, false);
        emit SensePerps.PositionClosed(pid, alice, M_BTC, SensePerps.CloseReason.TakeProfit, 0, 0, 0, 0, 0);
        perps.executeTpSl(pid, _px(BTC, 111_000e8));
        assertGt(usdc.balanceOf(alice) - before, 2_000e6);

        uint256 pid2 = _open(bob, M_BTC, false, 1_000e6, 10_000e6, P0);
        vm.prank(bob);
        perps.setTpSl(pid2, 0, 102_000e8);
        vm.warp(block.timestamp + 2);
        vm.expectEmit(true, true, true, false);
        emit SensePerps.PositionClosed(pid2, bob, M_BTC, SensePerps.CloseReason.StopLoss, 0, 0, 0, 0, 0);
        vm.prank(keeper);
        perps.executeTpSl(pid2, _px(BTC, 102_500e8));
        _books();
    }

    function testTpSlNeedsAPriceSeenAfterSetting() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        vm.warp(block.timestamp + 20);
        SignedPrice[] memory before = _pxAt(BTC, 111_000e8, _nowMs() - 10_000);
        vm.prank(alice);
        perps.setTpSl(pid, 110_000e8, 0);
        vm.prank(keeper);
        vm.expectRevert(SensePerps.PriceTooOld.selector);
        perps.executeTpSl(pid, before);
    }

    function testOpenRequestCarriesTpSl() public {
        _seed(1_000_000e6);
        vm.prank(alice);
        uint256 id = perps.requestOpen(M_BTC, true, 1_000e6, 10_000e6, 101_000e8, 0, 120_000e8, 90_000e8);
        vm.warp(block.timestamp + 2);
        vm.prank(keeper);
        perps.executeRequest(id, _px(BTC, P0));
        SensePerps.Position memory p = _pos(1);
        assertEq(p.tp, 120_000e8);
        assertEq(p.sl, 90_000e8);
    }

    // ─── requests ────────────────────────────────────────────────────────────

    function testSlippageRefundsTheTrader() public {
        _seed(1_000_000e6);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 id = perps.requestOpen(M_BTC, true, 1_000e6, 10_000e6, 100_500e8, 0, 0, 0);
        vm.warp(block.timestamp + 2);
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit SensePerps.RequestCancelled(id, alice, "price moved");
        perps.executeRequest(id, _px(BTC, 101_000e8));
        assertEq(before - usdc.balanceOf(alice), EXEC, "only the execution fee is spent");
        assertEq(perps.openPositionIds().length, 0);
        _books();
    }

    function testCloseSlippageKeepsThePosition() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        vm.prank(alice);
        uint256 id = perps.requestClose(pid, 99_000e8);
        vm.warp(block.timestamp + 2);
        vm.prank(keeper);
        perps.executeRequest(id, _px(BTC, 98_000e8));
        assertEq(_pos(pid).trader, alice, "still open");
        assertEq(perps.closeRequestOf(pid), 0);
        vm.prank(alice);
        perps.requestClose(pid, 0); // and can be asked again
    }

    function testOnlyOneCloseRequestAtATime() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        vm.prank(alice);
        perps.requestClose(pid, 0);
        vm.prank(alice);
        vm.expectRevert(SensePerps.ClosePending.selector);
        perps.requestClose(pid, 0);
        vm.prank(bob);
        vm.expectRevert(SensePerps.NotAccount.selector);
        perps.requestClose(pid, 0);
    }

    function testPendingCloseRefundedWhenLiquidated() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        vm.prank(alice);
        uint256 id = perps.requestClose(pid, 95_000e8);
        uint256 before = usdc.balanceOf(alice);
        vm.warp(block.timestamp + 2);
        vm.prank(keeper);
        perps.liquidate(pid, _px(BTC, 90_000e8));
        assertEq(usdc.balanceOf(alice) - before, EXEC, "the close request's fee comes back");
        assertEq(_req(id).account, address(0));
        assertEq(perps.pendingRequestIds().length, 0);
        _books();
    }

    function testMarketRequestExpiresAndRefunds() public {
        _seed(1_000_000e6);
        uint256 before = usdc.balanceOf(alice);
        uint256 id = _request(alice, M_BTC, true, 1_000e6, 10_000e6);
        vm.prank(alice);
        vm.expectRevert(SensePerps.TooEarly.selector);
        perps.cancelRequest(id);
        vm.warp(block.timestamp + 121);
        vm.prank(keeper);
        vm.expectRevert(SensePerps.Expired.selector);
        perps.executeRequest(id, _px(BTC, P0));
        vm.prank(bob);
        vm.expectRevert(SensePerps.NotAccount.selector);
        perps.cancelRequest(id);
        vm.prank(alice);
        perps.cancelRequest(id);
        assertEq(usdc.balanceOf(alice), before, "refunded in full");
        _books();
    }

    function testLimitOrder() public {
        _seed(1_000_000e6);
        vm.prank(alice);
        uint256 id = perps.requestOpen(M_BTC, true, 1_000e6, 10_000e6, 98_100e8, 98_000e8, 0, 0);
        vm.warp(block.timestamp + 600); // limit orders don't expire
        vm.prank(keeper);
        vm.expectRevert(SensePerps.TriggerNotReached.selector);
        perps.executeRequest(id, _px(BTC, 99_000e8));
        vm.prank(keeper);
        perps.executeRequest(id, _px(BTC, 97_900e8));
        assertEq(_pos(1).entryPrice, 97_900e8);

        vm.prank(bob);
        uint256 id2 = perps.requestOpen(M_BTC, false, 1_000e6, 10_000e6, 109_000e8, 110_000e8, 0, 0);
        vm.prank(bob);
        perps.cancelRequest(id2); // any time
        _books();
    }

    function testOnlyKeepersExecuteOpensAndDeposits() public {
        _seed(1_000_000e6);
        uint256 id = _request(alice, M_BTC, true, 1_000e6, 10_000e6);
        vm.warp(block.timestamp + 10 minutes);
        vm.prank(stranger);
        vm.expectRevert(SensePerps.NotKeeper.selector);
        perps.executeRequest(id, _px(BTC, P0));
    }

    function testAnyoneExecutesAStuckClose() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        vm.prank(alice);
        uint256 id = perps.requestClose(pid, 0);
        vm.warp(block.timestamp + 60);
        vm.prank(alice);
        vm.expectRevert(SensePerps.NotKeeper.selector);
        perps.executeRequest(id, _px(BTC, P0));
        vm.warp(block.timestamp + 5 minutes);
        vm.prank(alice);
        perps.executeRequest(id, _px(BTC, P0));
        assertEq(perps.openPositionIds().length, 0);
        _books();
    }

    function testCantOpenBeyondFreeLiquidity() public {
        _seed(10_000e6);
        uint256 id = _request(alice, M_BTC, true, 2_000e6, 20_000e6); // reserves $17,856
        vm.warp(block.timestamp + 2);
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit SensePerps.RequestCancelled(id, alice, "pool liquidity");
        perps.executeRequest(id, _px(BTC, P0));
        _books();
    }

    function testOpenInterestCap() public {
        _seed(1_000_000e6);
        SensePerps.MarketParams memory p = _params(BTC);
        p.maxOiLong = 15_000e6;
        vm.prank(owner);
        perps.setMarket(M_BTC, p);
        _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        uint256 id = _request(bob, M_BTC, true, 1_000e6, 10_000e6);
        vm.warp(block.timestamp + 2);
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit SensePerps.RequestCancelled(id, bob, "open interest cap");
        perps.executeRequest(id, _px(BTC, P0));
    }

    function testLeverageLimits() public {
        _seed(1_000_000e6);
        vm.startPrank(alice);
        vm.expectRevert(SensePerps.BadAmount.selector);
        perps.requestOpen(M_BTC, true, 1_000e6, 10_001e6, P0, 0, 0, 0); // over 10x
        vm.expectRevert(SensePerps.BadAmount.selector);
        perps.requestOpen(M_BTC, true, 1_000e6, 999e6, P0, 0, 0, 0); // under 1x
        vm.expectRevert(SensePerps.BadAmount.selector);
        perps.requestOpen(M_BTC, true, 1e6, 5e6, P0, 0, 0, 0); // under the minimum collateral
        vm.expectRevert(SensePerps.BadMarket.selector);
        perps.requestOpen(7, true, 1_000e6, 5_000e6, P0, 0, 0, 0);
        vm.stopPrank();
    }

    function testPauseStopsOpensButNotExits() public {
        _seed(1_000_000e6);
        uint256 pid = _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        uint256 pending = _request(bob, M_BTC, true, 1_000e6, 10_000e6);
        vm.prank(owner);
        perps.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(SensePerps.IsPaused.selector);
        perps.requestOpen(M_BTC, true, 1_000e6, 10_000e6, P0, 0, 0, 0);
        vm.prank(lp);
        vm.expectRevert(SensePerps.IsPaused.selector);
        perps.requestDeposit(1e6, 0);
        vm.warp(block.timestamp + 2);
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit SensePerps.RequestCancelled(pending, bob, "paused");
        perps.executeRequest(pending, _px(BTC, P0));
        _close(alice, pid, M_BTC, P0);
        vm.warp(block.timestamp + 15 minutes);
        uint256 shares = perps.balanceOf(lp);
        vm.prank(lp);
        uint256 id = perps.requestWithdraw(shares, 0);
        vm.prank(keeper);
        perps.executeRequest(id, new SignedPrice[](0));
        assertEq(perps.balanceOf(lp), 0);
        _books();
    }

    // ─── prices ──────────────────────────────────────────────────────────────

    function testPriceMustBeSeenAfterTheRequest() public {
        _seed(1_000_000e6);
        uint256 id = _request(alice, M_BTC, true, 1_000e6, 10_000e6);
        SignedPrice[] memory early = _pxAt(BTC, P0, _nowMs() - 10_000);
        vm.warp(block.timestamp + 5);
        vm.prank(keeper);
        vm.expectRevert(SensePerps.PriceTooOld.selector);
        perps.executeRequest(id, early);
    }

    function testStaleAndFuturePrices() public {
        _seed(1_000_000e6);
        uint256 id = _request(alice, M_BTC, true, 1_000e6, 10_000e6);
        SignedPrice[] memory atRequest = _px(BTC, P0);
        vm.warp(block.timestamp + 61);
        vm.prank(keeper);
        vm.expectRevert(SensePerps.PriceStale.selector);
        perps.executeRequest(id, atRequest);
        vm.prank(keeper);
        vm.expectRevert(SensePerps.PriceInFuture.selector);
        perps.executeRequest(id, _pxAt(BTC, P0, _nowMs() + 31_000));
    }

    function testOracleRejectsBadPackages() public {
        bytes32[] memory feeds = new bytes32[](1);
        feeds[0] = BTC;
        uint64 ts = _nowMs();
        SignedPrice[] memory p = _pxAt(BTC, P0, ts);

        // Two signers aren't enough.
        SignedPrice[] memory two = new SignedPrice[](2);
        two[0] = p[0];
        two[1] = p[1];
        vm.expectRevert(abi.encodeWithSelector(SenseOracle.NotEnoughSigners.selector, BTC, 2));
        oracle.verify(two, feeds);

        // The same signer twice.
        SignedPrice[] memory dup = new SignedPrice[](3);
        dup[0] = p[0];
        dup[1] = p[1];
        dup[2] = p[0];
        vm.expectRevert(abi.encodeWithSelector(SenseOracle.DuplicateSigner.selector, signerAddrs[0]));
        oracle.verify(dup, feeds);

        // A signer the oracle doesn't know.
        SignedPrice[] memory rogue = _pxAt(BTC, P0, ts);
        rogue[2].signature = _sig(0xBAD, BTC, P0, ts);
        vm.expectRevert(abi.encodeWithSelector(SenseOracle.SignerNotAuthorised.selector, vm.addr(0xBAD)));
        oracle.verify(rogue, feeds);

        // A value changed after signing recovers a different signer.
        SignedPrice[] memory forged = _pxAt(BTC, P0, ts);
        forged[0].value = P0 * 2;
        vm.expectRevert();
        oracle.verify(forged, feeds);

        // Mixed timestamps.
        SignedPrice[] memory mixed = _pxAt(BTC, P0, ts);
        mixed[2] = _pxAt(BTC, P0, ts - 10_000)[2];
        vm.expectRevert(SenseOracle.MixedTimestamps.selector);
        oracle.verify(mixed, feeds);

        // The malleable (high-s) twin of a valid signature.
        SignedPrice[] memory high = _pxAt(BTC, P0, ts);
        bytes memory sig = high[0].signature;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        high[0].signature = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(SenseOracle.BadSignature.selector);
        oracle.verify(high, feeds);

        // Nothing at all.
        vm.expectRevert(SenseOracle.NoPrices.selector);
        oracle.verify(new SignedPrice[](0), feeds);
    }

    function testOracleTakesTheMedian() public view {
        bytes32[] memory feeds = new bytes32[](2);
        feeds[0] = BTC;
        feeds[1] = ETH;
        uint64 ts = _nowMs();
        uint256[5] memory btc = [uint256(100e8), 103e8, 101e8, 99e8, 250e8];
        SignedPrice[] memory p = new SignedPrice[](9);
        for (uint256 i; i < 5; ++i) {
            p[i] = SignedPrice(BTC, btc[i], ts, _sig(pks[i], BTC, btc[i], ts));
        }
        for (uint256 i; i < 4; ++i) {
            uint256 e = 4_000e8 + i * 1e8;
            p[5 + i] = SignedPrice(ETH, e, ts, _sig(pks[i], ETH, e, ts));
        }
        (uint256[] memory v, uint256 t) = oracle.verify(p, feeds);
        assertEq(v[0], 101e8, "median of five: one wild signer can't move it");
        assertEq(v[1], 4_001.5e8, "median of four");
        assertEq(t, ts);
    }

    function testOracleIgnoresOtherFeeds() public view {
        bytes32[] memory feeds = new bytes32[](1);
        feeds[0] = ETH;
        SignedPrice[] memory p = _px2(P0, E0);
        (uint256[] memory v,) = oracle.verify(p, feeds);
        assertEq(v[0], E0);
    }

    /// Real packages from RedStone's primary-prod gateway (2026-10-03, BTC and ETH, all five
    /// signers), checked with RedStone's real signer addresses.
    function testRealRedstonePackages() public {
        address[] memory real = new address[](5);
        real[0] = 0x8BB8F32Df04c8b654987DAaeD53D6B6091e3B774;
        real[1] = 0xdEB22f54738d54976C4c0fe5ce6d408E40d88499;
        real[2] = 0x51Ce04Be4b3E32572C4Ec9135221d0691Ba7d202;
        real[3] = 0xDD682daEC5A90dD295d14DA4b0bec9281017b5bE;
        real[4] = 0x9c5AE89C4Af6aA32cE58588DBaF90d18a855B6de;
        SenseOracle live = new SenseOracle(owner, real, 3);
        uint64 ts = 1791029540000;
        SignedPrice[] memory p = new SignedPrice[](10);
        p[0] = SignedPrice(BTC, 8467990298849, ts, hex"af5e4f2e1a505cf8345e68b2acd5df533cc2f0b5e56229e77fdd4159c5741c681a15c296f1cef54757cdafda04328b593551e9c72c30ff7cd05df91ee17243ac1c");
        p[1] = SignedPrice(BTC, 8467960701255, ts, hex"c2d4a4baa404b4bc29164cac1abd047d8bd5268a0f7a19b8183428b8847cc3182a1a45318d52b1b2a0b1fe4d8b613d81e04e9896504f01a82b43b70dbf6150621b");
        p[2] = SignedPrice(BTC, 8467960701255, ts, hex"ddbb02c2cd7a0664b92605603587bd70cd9fe3dec8646abba68aa1babdfbc2911aa43d0bb04ff3a7600702c72ea545b77fa4229ef970f3c3258d7f567af4b7f81c");
        p[3] = SignedPrice(BTC, 8467960701255, ts, hex"024e3950a64a96ad86c2394622d651112fc9ebfb31cf70f5e92e50a45f2e726a0ebc485242968801967fbad9a2c2fb5b789228734a3c42c617671d0b9d8c2b121b");
        p[4] = SignedPrice(BTC, 8467959701325, ts, hex"28e91cda4cb9915e984fb89245c11008b1545b0b4e408b2037680206b7a1832e6f257e8c8eebed3ffec0dc3fc9cb62c2e54c58129501d1833ca15ec4dbbc46811b");
        p[5] = SignedPrice(ETH, 268345320200, ts, hex"979d82cddabf7f121ce7cbd25c0f12f98aa4b5a91b19a608cb2da5b347bd11743fd6e2f81ab27b231c85dcebd9f7491473f32fcb086193886a8b2371d5d20e481c");
        p[6] = SignedPrice(ETH, 268345320200, ts, hex"9074f296c8de568fd43d42d07bc1079ee984a958e820fbd219c101599f2366d25f21e185d543b18299f556fbd2fe768466e478b1051fbca0e324a960d84485141c");
        p[7] = SignedPrice(ETH, 268345320200, ts, hex"9a3afc394f92f835834439a9945645f7ce6dad1704c1498a7959d135cc308d6b5b1321b13d64177122648c10fa4d2988ed275b5e474eee21d8b817d4d8c950d11c");
        p[8] = SignedPrice(ETH, 268345320200, ts, hex"bc7692be42471841b0179cce61c6985e491b01a7b986011e315cb0660fd6acff24366e6ab3fccce6209f87f5171c7f81bef4d9ed796fd3e37a4ea50a6ef715a71c");
        p[9] = SignedPrice(ETH, 268345320200, ts, hex"b948faf69b006cb4b8ea0d65ad0153fd35504a2dee8b0c6bfd35ff59176296296969eda01f41bdd74302293fed220aefd0d02b147c10c2f137c4df0f5fa381331b");
        bytes32[] memory feeds = new bytes32[](2);
        feeds[0] = BTC;
        feeds[1] = ETH;
        (uint256[] memory v, uint256 t) = live.verify(p, feeds);
        assertEq(v[0], 8467960701255, "BTC $84,679.60701255, the median of five");
        assertEq(v[1], 268345320200, "ETH $2,683.453202");
        assertEq(t, ts);

        // And through the futures contract: a market order executed with them.
        vm.warp(ts / 1000 + 5);
        SensePerps.MarketParams[] memory ms = new SensePerps.MarketParams[](1);
        ms[0] = _params(BTC);
        SensePerps real_ = new SensePerps(IERC20(address(usdc)), live, owner, feeWallet, keeper, ms);
        usdc.mint(lp, 0);
        vm.startPrank(lp);
        usdc.approve(address(real_), type(uint256).max);
        uint256 dep = real_.requestDeposit(100_000e6, 0);
        vm.stopPrank();
        vm.prank(keeper);
        real_.executeRequest(dep, new SignedPrice[](0));
        vm.warp(ts / 1000 - 3); // the request was made just before the packages were signed
        vm.startPrank(alice);
        usdc.approve(address(real_), type(uint256).max);
        uint256 id = real_.requestOpen(0, true, 100e6, 1_000e6, 85_000e8, 0, 0, 0);
        vm.stopPrank();
        vm.warp(ts / 1000 + 5);
        SignedPrice[] memory btcOnly = new SignedPrice[](3);
        btcOnly[0] = p[1];
        btcOnly[1] = p[3];
        btcOnly[2] = p[4];
        vm.prank(keeper);
        real_.executeRequest(id, btcOnly);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        assertEq(real_.getPositions(ids)[0].entryPrice, 8467960701255);
    }

    // ─── owner ───────────────────────────────────────────────────────────────

    function testOwnerLimits() public {
        SensePerps.MarketParams memory p = _params(BTC);
        vm.expectRevert();
        perps.setMarket(M_BTC, p); // not the owner

        vm.startPrank(owner);
        p.openFeeBps = 51;
        vm.expectRevert(SensePerps.BadParams.selector);
        perps.setMarket(M_BTC, p);
        p = _params(BTC);
        p.maxLeverage = 51;
        vm.expectRevert(SensePerps.BadParams.selector);
        perps.setMarket(M_BTC, p);
        p = _params(BTC);
        p.liquidationBps = 501;
        vm.expectRevert(SensePerps.BadParams.selector);
        perps.setMarket(M_BTC, p);
        p = _params(BTC);
        p.borrowRatePerHour = 1e14 + 1;
        vm.expectRevert(SensePerps.BadParams.selector);
        perps.setMarket(M_BTC, p);
        p = _params(BTC);
        p.maxLeverage = 50;
        p.liquidationBps = 200; // (200 + 16) x 50 >= 100%: born liquidatable
        vm.expectRevert(SensePerps.BadParams.selector);
        perps.setMarket(M_BTC, p);
        vm.expectRevert(SensePerps.BadParams.selector);
        perps.setConfig(4, 120, EXEC, 2e6, 0);
        vm.expectRevert(SensePerps.BadParams.selector);
        perps.setConfig(60, 120, 1e6 + 1, 2e6, 0);
        vm.expectRevert(SensePerps.NotUsdc.selector);
        perps.rescue(IERC20(address(usdc)), owner, 1);
        vm.expectRevert(SensePerps.BadParams.selector);
        perps.setPlatformFeeShare(10_001);
        vm.stopPrank();
    }

    function testFeedCantChangeUnderOpenPositions() public {
        _seed(1_000_000e6);
        _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        SensePerps.MarketParams memory p = _params(ETH);
        vm.prank(owner);
        vm.expectRevert(SensePerps.BadParams.selector);
        perps.setMarket(M_BTC, p);
    }

    function testFeeShareWithThePool() public {
        _seed(1_000_000e6);
        vm.prank(owner);
        perps.setPlatformFeeShare(5_000);
        uint256 feeBefore = usdc.balanceOf(feeWallet);
        uint256 pool = perps.poolAmount();
        _open(alice, M_BTC, true, 1_000e6, 10_000e6, P0);
        assertEq(usdc.balanceOf(feeWallet) - feeBefore, 4e6);
        assertEq(perps.poolAmount() - pool, 4e6);
    }

    function testSignerChangeWaitsTwoDays() public {
        address[] memory next = new address[](1);
        next[0] = makeAddr("newSigner");
        vm.prank(stranger);
        vm.expectRevert();
        oracle.proposeSigners(next, 1);
        vm.startPrank(owner);
        oracle.proposeSigners(next, 1);
        vm.expectRevert(SenseOracle.TooEarly.selector);
        oracle.applySigners();
        vm.warp(block.timestamp + 2 days);
        oracle.applySigners();
        vm.stopPrank();
        (address[] memory s, uint8 t) = oracle.signers();
        assertEq(s.length, 1);
        assertEq(s[0], next[0]);
        assertEq(t, 1);
    }

    function testKeeperManagement() public {
        vm.prank(owner);
        perps.setKeeper(keeper, false);
        _seed2Revert();
    }

    function _seed2Revert() internal {
        vm.prank(lp);
        uint256 id = perps.requestDeposit(1_000e6, 0);
        vm.prank(keeper);
        vm.expectRevert(SensePerps.NotKeeper.selector);
        perps.executeRequest(id, new SignedPrice[](0));
    }

    // ─── conservation ────────────────────────────────────────────────────────

    /// Random traders, sizes, sides and prices: the books always balance, the pool always covers
    /// every reserved profit, and when everything is closed and withdrawn nothing is left behind.
    function testFuzz_booksAlwaysBalance(uint256 seed) public {
        _seed(500_000e6);
        address[3] memory traders = [alice, bob, stranger];
        uint256 btc = P0;
        uint256 eth = E0;
        for (uint256 step; step < 24; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            btc = btc * (9_000 + (r % 2_000)) / 10_000; // -10% .. +10%
            eth = eth * (9_000 + ((r >> 16) % 2_000)) / 10_000;
            uint256 action = (r >> 32) % 4;
            uint256[] memory open = perps.openPositionIds();
            if (action <= 1 || open.length == 0) {
                address who = traders[(r >> 40) % 3];
                uint32 m = uint32((r >> 48) % 2);
                uint256 coll = 2e6 + (r >> 56) % 5_000e6;
                uint256 size = coll + ((r >> 96) % (coll * 9));
                _open(who, m, ((r >> 88) & 1) == 1, coll, size, m == M_BTC ? btc : eth);
            } else if (action == 2) {
                uint256 pid = open[(r >> 40) % open.length];
                SensePerps.Position memory p = _pos(pid);
                _close(p.trader, pid, p.marketId, p.marketId == M_BTC ? btc : eth);
            } else {
                uint256 pid = open[(r >> 40) % open.length];
                SensePerps.Position memory p = _pos(pid);
                vm.warp(block.timestamp + 1);
                vm.prank(keeper);
                try perps.liquidate(pid, _px(_feed(p.marketId), p.marketId == M_BTC ? btc : eth)) {} catch {}
                _books();
            }
            vm.warp(block.timestamp + (r >> 200) % 2 hours);
        }
        // Close everything, then the LP leaves with whatever the pool holds.
        uint256[] memory left = perps.openPositionIds();
        for (uint256 i; i < left.length; ++i) {
            SensePerps.Position memory p = _pos(left[i]);
            _close(p.trader, left[i], p.marketId, p.marketId == M_BTC ? btc : eth);
        }
        assertEq(perps.totalReserved(), 0);
        assertEq(perps.totalCollateral(), 0);
        _sidesEmpty();
        vm.warp(block.timestamp + 15 minutes);
        uint256 shares = perps.balanceOf(lp);
        vm.prank(lp);
        uint256 id = perps.requestWithdraw(shares, 0);
        vm.prank(keeper);
        perps.executeRequest(id, new SignedPrice[](0));
        _books();
        // Only the dead shares' part of the pool stays.
        assertLe(perps.poolAmount(), perps.poolAmount() * 1_000 / perps.totalSupply() + 1);
        assertEq(perps.escrowed(), 0);
    }
}
