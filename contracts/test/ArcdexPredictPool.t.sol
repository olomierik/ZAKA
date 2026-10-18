// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SenseTestUSDC} from "../SensePerps.sol";
import {ArcdexPredictPool, ArcdexPredictToken} from "../ArcdexPredictPool.sol";

/// The prediction pool: fills at the signed mid, the payout queue, fees, settlement, the loss token,
/// staking, and the books balancing after every step (`_books`). Prices and settlements are signed
/// here with a test key, as the engine signs them (EIP-712).
contract ArcdexPredictPoolTest is Test {
    SenseTestUSDC usdc;
    ArcdexPredictPool pool;
    ArcdexPredictToken tok;

    uint256 signerPk = 0x5160E2;
    address signerAddr;
    address owner = makeAddr("owner");
    address feeWallet = makeAddr("feeWallet");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address keeper = makeAddr("keeper");

    uint32 constant O = 7; // an outcome
    uint32 constant O2 = 8;
    uint64 constant FIVE = 500_000; // 50c

    function setUp() public {
        vm.warp(1_800_000_000);
        signerAddr = vm.addr(signerPk);
        usdc = new SenseTestUSDC(address(this), 0);
        pool = new ArcdexPredictPool(IERC20(address(usdc)), owner, feeWallet, signerAddr);
        tok = pool.token();
        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < users.length; ++i) {
            usdc.mint(users[i], 1_000_000e6);
            vm.startPrank(users[i]);
            usdc.approve(address(pool), type(uint256).max);
            pool.deposit(100_000e6);
            vm.stopPrank();
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────

    function _sig(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", pool.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _priceSig(uint32 outcome, uint8 side, uint64 px, uint64 ts) internal view returns (bytes memory) {
        return _sig(signerPk, keccak256(abi.encode(pool.PRICE_TYPEHASH(), outcome, side, px, ts)));
    }

    function _fill(uint256 id, uint64 px) internal {
        ArcdexPredictPool.Request memory r = pool.getRequest(id);
        uint64 ts = uint64(vm.getBlockTimestamp());
        ArcdexPredictPool.Fill[] memory fs = new ArcdexPredictPool.Fill[](1);
        fs[0] = ArcdexPredictPool.Fill(id, px, ts, _priceSig(r.outcome, r.side, px, ts));
        vm.prank(keeper);
        pool.execute(fs);
    }

    /// A request, then a second later its fill at `px`.
    function _buy(address who, uint32 outcome, uint8 side, uint256 usd, uint64 px) internal returns (uint256 id) {
        vm.prank(who);
        id = pool.requestBuy(outcome, side, usd, 990_000);
        vm.warp(vm.getBlockTimestamp() + 1);
        _fill(id, px);
    }

    function _sell(address who, uint32 outcome, uint8 side, uint256 contracts, uint64 px) internal returns (uint256 id) {
        vm.prank(who);
        id = pool.requestSell(outcome, side, contracts, 0);
        vm.warp(vm.getBlockTimestamp() + 1);
        _fill(id, px);
    }

    function _settle(uint32 outcome, uint64 fraction) internal {
        uint64 ts = uint64(vm.getBlockTimestamp());
        bytes memory sig = _sig(signerPk, keccak256(abi.encode(pool.SETTLEMENT_TYPEHASH(), outcome, fraction, ts)));
        pool.proposeSettlement(outcome, fraction, ts, sig);
        vm.warp(vm.getBlockTimestamp() + pool.settleDelay());
    }

    function _held(address who, uint32 outcome, uint8 side) internal view returns (uint256 contracts, uint256 cost) {
        ArcdexPredictPool.Position memory p = pool.positionOf(who, outcome, side);
        return (p.contracts, p.cost);
    }

    /// The contract holds at least what it owes, and owes exactly its tallies.
    function _books() internal view {
        assertGe(usdc.balanceOf(address(pool)), pool.liabilities(), "insolvent books");
        assertEq(usdc.balanceOf(address(pool)), pool.liabilities(), "unaccounted USDC");
    }

    // ── buying and selling at the mid ────────────────────────────────────

    function testBuyFillsAtTheSignedMid() public {
        _buy(alice, O, 0, 100e6, 400_000); // 40c
        (uint256 n, uint256 cost) = _held(alice, O, 0);
        assertEq(n, 250e6, "contracts = usd / price");
        assertEq(cost, 100e6);
        assertEq(pool.balances(alice), 99_900e6);
        (uint128 oi0,,,,,,,) = pool.markets(O);
        assertEq(oi0, 250e6);
        _books();
    }

    function testSaleAtALossGoesToThePoolAndMintsTokens() public {
        _buy(alice, O, 0, 100e6, 500_000);
        _sell(alice, O, 0, 200e6, 400_000); // all 200 contracts at 40c = $80
        assertEq(pool.balances(alice), 99_900e6 + 80e6, "the value back at once");
        // $20 loss: 2% fee carved from the pool's gain while nothing is queued.
        assertEq(pool.lpCash(), 19.6e6);
        assertEq(pool.devFees() + pool.stakerFeeAcc(), 0.4e6);
        assertEq(tok.balanceOf(alice), 20 * 100e18, "100 tPOOL per $1 lost");
        assertEq(pool.trackedLp(), int256(20e6));
        _books();
    }

    function testProfitPaidFromFreeCashLessTheWinFee() public {
        // Bob loses $50, which fills the pool.
        _buy(bob, O2, 0, 100e6, 500_000);
        _sell(bob, O2, 0, 200e6, 250_000);
        uint256 cash = pool.lpCash(); // 49
        _buy(alice, O, 0, 100e6, 500_000);
        _sell(alice, O, 0, 200e6, 600_000); // $120: $20 profit
        assertEq(pool.balances(alice), 100_000e6 + 19.6e6, "profit less 2%");
        assertEq(pool.lpCash(), cash - 20e6, "the pool pays the profit and the fee");
        assertEq(pool.queueLength(), 0);
        assertEq(tok.balanceOf(alice), 0, "no token for a win");
        _books();
    }

    function testPoolStartsEmptySoTheFirstWinWaitsInTheQueue() public {
        _buy(alice, O, 0, 100e6, 500_000);
        _sell(alice, O, 0, 200e6, 600_000);
        assertEq(pool.balances(alice), 100_000e6, "her own $100 back at once");
        assertEq(pool.queueLength(), 1);
        assertEq(pool.queuedOf(alice), 19.6e6, "the profit, less the fee, waits");
        assertEq(pool.devFees() + pool.stakerFeeAcc(), 0, "no fee ahead of a queued winner");
        _books();
    }

    function testPartlyPaidWinQueuesTheRest() public {
        _buy(bob, O2, 0, 10e6, 500_000);
        _sell(bob, O2, 0, 20e6, 0.25e6); // bob loses $5 -> 4.9 cash
        _buy(alice, O, 0, 100e6, 500_000);
        _sell(alice, O, 0, 200e6, 600_000); // owed 19.6
        assertEq(pool.balances(alice), 100_000e6 + 4.9e6);
        assertEq(pool.queuedOf(alice), 14.7e6);
        assertEq(pool.lpCash(), 0);
        _books();
    }

    function testQueuePaysFirstInFirstOutFromLaterLosses() public {
        _buy(alice, O, 0, 100e6, 500_000);
        _sell(alice, O, 0, 200e6, 600_000); // alice owed 19.6
        _buy(bob, O, 1, 100e6, 500_000);
        _sell(bob, O, 1, 200e6, 600_000); // bob owed 19.6, behind alice
        assertEq(pool.queueLength(), 2);
        // Carol loses $25: earmarked for the queue, no fee, paid at once in order.
        _buy(carol, O2, 0, 50e6, 500_000);
        _sell(carol, O2, 0, 100e6, 250_000);
        assertEq(pool.queuedOf(alice), 0, "alice first");
        assertEq(pool.queuedOf(bob), 19.6e6 - 5.4e6, "bob partly");
        assertEq(pool.sideBucket(), 0);
        assertEq(pool.lpCash(), 0);
        assertEq(pool.devFees() + pool.stakerFeeAcc(), 0, "loss fee waived while queued");
        assertEq(tok.balanceOf(carol), 25 * 100e18, "the loss still mints");
        _books();
    }

    function testNoNewWinIsPaidAheadOfTheQueue() public {
        _buy(alice, O, 0, 100e6, 500_000);
        _sell(alice, O, 0, 200e6, 600_000); // queued 19.6
        // Bob had bought before and now wins too: he joins the back, though cash may arrive later.
        _buy(bob, O, 1, 100e6, 500_000);
        _sell(bob, O, 1, 200e6, 550_000); // owed 9.8
        assertEq(pool.queuedOf(bob), 9.8e6);
        assertEq(pool.balances(bob), 100_000e6);
        _books();
    }

    function testHarvestReleasesTheEarmarkOnceTheQueueClears() public {
        _buy(alice, O, 0, 10e6, 500_000);
        _sell(alice, O, 0, 20e6, 600_000); // queued 1.96
        _buy(carol, O2, 0, 50e6, 500_000);
        _sell(carol, O2, 0, 100e6, 250_000); // $25 loss
        assertEq(pool.queuedOf(alice), 0);
        assertEq(pool.queueLength(), 0);
        assertEq(pool.sideBucket(), 0, "the rest is free cash again");
        assertEq(pool.lpCash(), 25e6 - 1.96e6);
        _books();
    }

    function testLimitPriceRefundsTheBuy() public {
        vm.prank(alice);
        uint256 id = pool.requestBuy(O, 0, 100e6, 450_000);
        vm.warp(vm.getBlockTimestamp() + 1);
        _fill(id, 460_000);
        (uint256 n,) = _held(alice, O, 0);
        assertEq(n, 0);
        assertEq(pool.balances(alice), 100_000e6, "refunded");
        assertEq(pool.totalPending(), 0);
        _books();
    }

    function testSaleBelowItsMinimumIsRefused() public {
        _buy(alice, O, 0, 100e6, 500_000);
        vm.prank(alice);
        uint256 id = pool.requestSell(O, 0, 200e6, 450_000);
        vm.warp(vm.getBlockTimestamp() + 1);
        _fill(id, 440_000);
        (uint256 n,) = _held(alice, O, 0);
        assertEq(n, 200e6, "still held");
        assertEq(pool.positionOf(alice, O, 0).selling, 0, "and free to sell again");
    }

    function testNoPriceRefunds() public {
        vm.prank(alice);
        uint256 id = pool.requestBuy(O, 0, 100e6, 900_000);
        vm.warp(vm.getBlockTimestamp() + 1);
        _fill(id, 0);
        assertEq(pool.balances(alice), 100_000e6);
    }

    function testDecidedSidesCantBeBought() public {
        vm.prank(alice);
        uint256 id = pool.requestBuy(O, 0, 100e6, 980_000);
        vm.warp(vm.getBlockTimestamp() + 1);
        _fill(id, 995_000);
        assertEq(pool.balances(alice), 100_000e6, "over 99c: refunded");
        vm.prank(alice);
        id = pool.requestBuy(O, 0, 100e6, 900_000);
        vm.warp(vm.getBlockTimestamp() + 1);
        _fill(id, 5_000);
        assertEq(pool.balances(alice), 100_000e6, "under 1c: refunded");
    }

    function testOpenInterestCap() public {
        uint32[] memory os = new uint32[](0);
        uint128[] memory cs = new uint128[](0);
        vm.prank(owner);
        pool.setCaps(500e6, os, cs);
        _buy(alice, O, 0, 200e6, 500_000); // 400 contracts
        vm.prank(bob);
        uint256 id = pool.requestBuy(O, 0, 100e6, 900_000);
        vm.warp(vm.getBlockTimestamp() + 1);
        _fill(id, 500_000); // 200 more would pass 500
        assertEq(pool.balances(bob), 100_000e6, "refused at the cap");
        _buy(bob, O, 1, 200e6, 500_000); // the other side has its own cap
        (uint256 n,) = _held(bob, O, 1);
        assertEq(n, 400e6);
        _books();
    }

    function testCannotSellMoreThanHeldOrSellTwice() public {
        _buy(alice, O, 0, 100e6, 500_000);
        vm.startPrank(alice);
        vm.expectRevert(ArcdexPredictPool.BadAmount.selector);
        pool.requestSell(O, 0, 201e6, 0);
        pool.requestSell(O, 0, 150e6, 0);
        vm.expectRevert(ArcdexPredictPool.BadAmount.selector);
        pool.requestSell(O, 0, 100e6, 0);
        vm.stopPrank();
    }

    function testPartialSaleKeepsTheRestAtItsCost() public {
        _buy(alice, O, 0, 100e6, 500_000);
        _sell(alice, O, 0, 50e6, 500_000);
        (uint256 n, uint256 cost) = _held(alice, O, 0);
        assertEq(n, 150e6);
        assertEq(cost, 75e6);
        _books();
    }

    // ── requests and signatures ──────────────────────────────────────────

    function testPriceMustBeSignedAfterTheRequest() public {
        vm.prank(alice);
        uint256 id = pool.requestBuy(O, 0, 100e6, 900_000);
        uint64 ts = uint64(vm.getBlockTimestamp()); // the same second
        ArcdexPredictPool.Fill[] memory fs = new ArcdexPredictPool.Fill[](1);
        fs[0] = ArcdexPredictPool.Fill(id, 400_000, ts, _priceSig(O, 0, 400_000, ts));
        vm.expectRevert(ArcdexPredictPool.PriceTooEarly.selector);
        pool.execute(fs);
    }

    function testStalePriceRefused() public {
        vm.prank(alice);
        uint256 id = pool.requestBuy(O, 0, 100e6, 900_000);
        vm.warp(vm.getBlockTimestamp() + 1);
        uint64 ts = uint64(vm.getBlockTimestamp());
        vm.warp(vm.getBlockTimestamp() + pool.maxPriceAge() + 1);
        ArcdexPredictPool.Fill[] memory fs = new ArcdexPredictPool.Fill[](1);
        fs[0] = ArcdexPredictPool.Fill(id, 400_000, ts, _priceSig(O, 0, 400_000, ts));
        vm.expectRevert(ArcdexPredictPool.StalePrice.selector);
        pool.execute(fs);
    }

    function testWrongSignerOrWrongSideRefused() public {
        vm.prank(alice);
        uint256 id = pool.requestBuy(O, 0, 100e6, 900_000);
        vm.warp(vm.getBlockTimestamp() + 1);
        uint64 ts = uint64(vm.getBlockTimestamp());
        ArcdexPredictPool.Fill[] memory fs = new ArcdexPredictPool.Fill[](1);
        fs[0] = ArcdexPredictPool.Fill(id, 400_000, ts, _sig(0xBAD, keccak256(abi.encode(pool.PRICE_TYPEHASH(), O, uint8(0), uint64(400_000), ts))));
        vm.expectRevert(ArcdexPredictPool.BadSignature.selector);
        pool.execute(fs);
        fs[0] = ArcdexPredictPool.Fill(id, 400_000, ts, _priceSig(O, 1, 400_000, ts)); // the other side's price
        vm.expectRevert(ArcdexPredictPool.BadSignature.selector);
        pool.execute(fs);
        fs[0] = ArcdexPredictPool.Fill(id, 300_000, ts, _priceSig(O, 0, 400_000, ts)); // a price changed after signing
        vm.expectRevert(ArcdexPredictPool.BadSignature.selector);
        pool.execute(fs);
    }

    function testSignatureForAnotherPoolRefused() public {
        ArcdexPredictPool other = new ArcdexPredictPool(IERC20(address(usdc)), owner, feeWallet, signerAddr);
        vm.prank(alice);
        uint256 id = pool.requestBuy(O, 0, 100e6, 900_000);
        vm.warp(vm.getBlockTimestamp() + 1);
        uint64 ts = uint64(vm.getBlockTimestamp());
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", other.domainSeparator(), keccak256(abi.encode(pool.PRICE_TYPEHASH(), O, uint8(0), uint64(400_000), ts))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        ArcdexPredictPool.Fill[] memory fs = new ArcdexPredictPool.Fill[](1);
        fs[0] = ArcdexPredictPool.Fill(id, 400_000, ts, abi.encodePacked(r, s, v));
        vm.expectRevert(ArcdexPredictPool.BadSignature.selector);
        pool.execute(fs);
    }

    function testCancelOnlyAfterTimeoutAndOnlyByTheTrader() public {
        vm.prank(alice);
        uint256 id = pool.requestBuy(O, 0, 100e6, 900_000);
        vm.prank(alice);
        vm.expectRevert(ArcdexPredictPool.TooEarly.selector);
        pool.cancel(id);
        vm.warp(vm.getBlockTimestamp() + pool.requestTimeout() + 1);
        vm.prank(bob);
        vm.expectRevert(ArcdexPredictPool.NotYours.selector);
        pool.cancel(id);
        vm.prank(alice);
        pool.cancel(id);
        assertEq(pool.balances(alice), 100_000e6);
        (uint256[] memory ids,) = pool.requestsOf(alice);
        assertEq(ids.length, 0);
        _books();
    }

    function testExpiredRequestCantBeFilled() public {
        vm.prank(alice);
        uint256 id = pool.requestBuy(O, 0, 100e6, 900_000);
        vm.warp(vm.getBlockTimestamp() + pool.requestTimeout() + 1);
        uint64 ts = uint64(vm.getBlockTimestamp());
        ArcdexPredictPool.Fill[] memory fs = new ArcdexPredictPool.Fill[](1);
        fs[0] = ArcdexPredictPool.Fill(id, 400_000, ts, _priceSig(O, 0, 400_000, ts));
        vm.expectRevert(ArcdexPredictPool.Expired.selector);
        pool.execute(fs);
    }

    function testFilledRequestCantFillAgain() public {
        uint256 id = _buy(alice, O, 0, 100e6, 500_000);
        uint64 ts = uint64(vm.getBlockTimestamp());
        ArcdexPredictPool.Fill[] memory fs = new ArcdexPredictPool.Fill[](1);
        fs[0] = ArcdexPredictPool.Fill(id, 500_000, ts, _priceSig(O, 0, 500_000, ts));
        vm.expectRevert(ArcdexPredictPool.NoRequest.selector);
        pool.execute(fs);
    }

    function testBatchFillsSeveral() public {
        vm.prank(alice);
        uint256 a = pool.requestBuy(O, 0, 10e6, 900_000);
        vm.prank(bob);
        uint256 b = pool.requestBuy(O, 1, 20e6, 900_000);
        vm.warp(vm.getBlockTimestamp() + 1);
        uint64 ts = uint64(vm.getBlockTimestamp());
        ArcdexPredictPool.Fill[] memory fs = new ArcdexPredictPool.Fill[](2);
        fs[0] = ArcdexPredictPool.Fill(a, 300_000, ts, _priceSig(O, 0, 300_000, ts));
        fs[1] = ArcdexPredictPool.Fill(b, 700_000, ts, _priceSig(O, 1, 700_000, ts));
        pool.execute(fs);
        (uint256 na,) = _held(alice, O, 0);
        (uint256 nb,) = _held(bob, O, 1);
        assertEq(na, uint256(10e6) * 1e6 / 300_000);
        assertEq(nb, uint256(20e6) * 1e6 / 700_000);
    }

    // ── settlement ───────────────────────────────────────────────────────

    function testSettlementPaysBothSidesAfterTheDelay() public {
        _buy(alice, O, 0, 60e6, 600_000); // 100 yes
        _buy(bob, O, 1, 40e6, 400_000); // 100 no
        uint64 ts = uint64(vm.getBlockTimestamp());
        pool.proposeSettlement(O, 1e6, ts, _sig(signerPk, keccak256(abi.encode(pool.SETTLEMENT_TYPEHASH(), O, uint64(1e6), ts))));
        vm.expectRevert(ArcdexPredictPool.NotSettled.selector);
        pool.redeem(alice, O, 0);
        vm.warp(vm.getBlockTimestamp() + pool.settleDelay());
        pool.redeem(bob, O, 1); // bob loses his $40 first: the pool can pay alice
        pool.redeem(alice, O, 0);
        assertEq(pool.balances(bob), 100_000e6 - 40e6);
        assertEq(pool.balances(alice), 100_000e6 - 60e6 + 60e6 + 39.2e6, "$100 for 100 yes, 2% off the $40 profit");
        assertEq(tok.balanceOf(bob), 40 * 100e18);
        _books();
    }

    function testSplitSettlement() public {
        _buy(alice, O, 0, 50e6, 500_000);
        _buy(bob, O, 1, 50e6, 500_000);
        _settle(O, 300_000); // yes pays 30c, no 70c
        pool.redeem(alice, O, 0); // 100 x 0.3 = $30, a $20 loss
        pool.redeem(bob, O, 1); // $70: $20 profit
        assertEq(pool.balances(alice), 100_000e6 - 20e6);
        assertEq(pool.balances(bob), 100_000e6 + 19.6e6);
        _books();
    }

    function testSettlingStopsTradingAndRefundsPendingRequests() public {
        _buy(alice, O, 0, 50e6, 500_000);
        vm.prank(bob);
        uint256 id = pool.requestBuy(O, 0, 50e6, 900_000);
        vm.warp(vm.getBlockTimestamp() + 1);
        uint64 ts = uint64(vm.getBlockTimestamp());
        pool.proposeSettlement(O, 0, ts, _sig(signerPk, keccak256(abi.encode(pool.SETTLEMENT_TYPEHASH(), O, uint64(0), ts))));
        vm.warp(vm.getBlockTimestamp() + 1);
        _fill(id, 400_000);
        assertEq(pool.balances(bob), 100_000e6, "refunded: the market is settling");
        vm.prank(carol);
        vm.expectRevert(ArcdexPredictPool.MarketClosed.selector);
        pool.requestBuy(O, 0, 10e6, 900_000);
        vm.prank(alice);
        vm.expectRevert(ArcdexPredictPool.MarketClosed.selector);
        pool.requestSell(O, 0, 10e6, 0);
    }

    function testOwnerCancelsAWrongSettlementAndItCantBeReplayed() public {
        _buy(alice, O, 0, 50e6, 500_000);
        uint64 ts = uint64(vm.getBlockTimestamp());
        bytes memory sig = _sig(signerPk, keccak256(abi.encode(pool.SETTLEMENT_TYPEHASH(), O, uint64(0), ts)));
        pool.proposeSettlement(O, 0, ts, sig);
        vm.prank(alice);
        vm.expectRevert();
        pool.cancelSettlement(O);
        vm.prank(owner);
        pool.cancelSettlement(O);
        vm.expectRevert(ArcdexPredictPool.PriceTooEarly.selector);
        pool.proposeSettlement(O, 0, ts, sig);
        vm.warp(vm.getBlockTimestamp() + 30);
        _settle(O, 1e6);
        pool.redeem(alice, O, 0);
        assertEq(pool.balances(alice), 100_000e6, "her $50 back; the profit waits in the queue");
        assertEq(pool.queuedOf(alice), 49e6);
    }

    function testSettlementNeedsTheSigner() public {
        uint64 ts = uint64(vm.getBlockTimestamp());
        bytes memory sig = _sig(0xBAD, keccak256(abi.encode(pool.SETTLEMENT_TYPEHASH(), O, uint64(1e6), ts)));
        vm.expectRevert(ArcdexPredictPool.BadSignature.selector);
        pool.proposeSettlement(O, 1e6, ts, sig);
    }

    function testRedeemClearsAPendingSaleAndTheSaleIsVoid() public {
        _buy(alice, O, 0, 50e6, 500_000);
        vm.prank(alice);
        uint256 id = pool.requestSell(O, 0, 100e6, 0);
        _settle(O, 1e6);
        pool.redeem(alice, O, 0);
        vm.warp(vm.getBlockTimestamp() + pool.requestTimeout() + 1);
        vm.prank(alice);
        pool.cancel(id);
        assertEq(pool.positionOf(alice, O, 0).selling, 0);
        _books();
    }

    function testRedeemManySkipsEmptyPositions() public {
        _buy(alice, O, 0, 50e6, 500_000);
        _buy(bob, O, 1, 50e6, 500_000);
        _settle(O, 1e6);
        address[] memory us = new address[](3);
        uint32[] memory os = new uint32[](3);
        uint8[] memory ss = new uint8[](3);
        (us[0], us[1], us[2]) = (bob, alice, carol);
        (os[0], os[1], os[2]) = (O, O, O);
        (ss[0], ss[1], ss[2]) = (1, 0, 0);
        pool.redeemMany(us, os, ss);
        (uint256 n,) = _held(alice, O, 0);
        assertEq(n, 0);
        assertEq(pool.balances(alice), 100_000e6 + 49e6);
        _books();
    }

    // ── pausing ──────────────────────────────────────────────────────────

    function testPauseStopsBuysOnlyAndWithdrawalsStayOpen() public {
        _buy(alice, O, 0, 50e6, 500_000);
        vm.prank(owner);
        pool.setPaused(true);
        vm.prank(bob);
        vm.expectRevert(ArcdexPredictPool.IsPaused.selector);
        pool.requestBuy(O, 0, 10e6, 900_000);
        _sell(alice, O, 0, 100e6, 400_000);
        uint256 bal = pool.balances(alice);
        vm.prank(alice);
        pool.withdraw(bal);
        assertEq(pool.balances(alice), 0);
        _books();
    }

    function testHaltedMarketTakesNoBuys() public {
        vm.prank(owner);
        pool.setHalted(O, true);
        vm.prank(alice);
        vm.expectRevert(ArcdexPredictPool.MarketClosed.selector);
        pool.requestBuy(O, 0, 10e6, 900_000);
    }

    // ── the token and staking ────────────────────────────────────────────

    function testTokenCantBeTransferredUntilTurnedOn() public {
        _buy(alice, O, 0, 100e6, 500_000);
        _sell(alice, O, 0, 200e6, 250_000);
        vm.prank(alice);
        vm.expectRevert(ArcdexPredictToken.Untransferable.selector);
        tok.transfer(bob, 1e18);
        vm.expectRevert(ArcdexPredictToken.NotPool.selector);
        tok.mint(bob, 1e18);
        vm.prank(owner);
        pool.enableTokenTransfers();
        vm.prank(alice);
        tok.transfer(bob, 1e18);
        assertEq(tok.balanceOf(bob), 1e18);
    }

    function testStakersEarnTheirShareOfFees() public {
        _buy(alice, O, 0, 100e6, 500_000);
        _sell(alice, O, 0, 200e6, 250_000); // $50 loss: fee $1, $0.50 to stakers (no stakers yet)
        uint256 got = tok.balanceOf(alice);
        vm.prank(alice);
        pool.stake(got);
        assertEq(pool.pendingReward(alice), 0.5e6, "the backlog goes to the first staker");
        _buy(bob, O2, 0, 100e6, 500_000);
        _sell(bob, O2, 0, 200e6, 250_000); // another $1 fee
        assertEq(pool.pendingReward(alice), 1e6);
        uint256 before = pool.balances(alice);
        vm.prank(alice);
        pool.claim();
        assertEq(pool.balances(alice), before + 1e6);
        assertEq(pool.devFees(), 1e6, "the fee wallet's half");
        pool.withdrawDevFees();
        assertEq(usdc.balanceOf(feeWallet), 1e6);
        vm.prank(alice);
        pool.unstake(got);
        assertEq(tok.balanceOf(alice), got);
        _books();
    }

    function testRewardsSplitByStake() public {
        _buy(alice, O, 0, 100e6, 500_000);
        _sell(alice, O, 0, 200e6, 250_000);
        _buy(bob, O2, 0, 100e6, 500_000);
        _sell(bob, O2, 0, 200e6, 250_000);
        uint256 aHalf = tok.balanceOf(alice) / 2;
        uint256 bAll = tok.balanceOf(bob);
        vm.prank(alice);
        pool.stake(aHalf);
        vm.prank(bob);
        pool.stake(bAll);
        uint256 a0 = pool.pendingReward(alice);
        uint256 b0 = pool.pendingReward(bob);
        _buy(carol, O, 1, 300e6, 500_000);
        _sell(carol, O, 1, 600e6, 250_000); // $150 loss: $1.50 to stakers
        assertApproxEqAbs(pool.pendingReward(bob) - b0, 1e6, 1);
        assertApproxEqAbs(pool.pendingReward(alice) - a0, 0.5e6, 1);
    }

    function testMintRateDecaysPastTheThreshold() public {
        assertEq(pool.mintRate(), 100e18);
        usdc.mint(carol, 10_000_000e6);
        vm.startPrank(carol);
        pool.deposit(5_000_000e6);
        vm.stopPrank();
        uint32[] memory os = new uint32[](0);
        uint128[] memory cs = new uint128[](0);
        vm.prank(owner);
        pool.setCaps(type(uint128).max, os, cs);
        _buy(carol, O, 0, 3_000_000e6, 500_000);
        _sell(carol, O, 0, 6_000_000e6, 0.25e6); // a $1.5M loss: still flat
        assertEq(pool.mintRate(), 100e18);
        _buy(carol, O, 0, 2_000_000e6, 500_000);
        _sell(carol, O, 0, 4_000_000e6, 0.25e6); // $1M more: tracked LP $2.5M, $0.5M past
        assertEq(pool.tailHighWater(), 500_000e6);
        uint256 s = 120_000_000e6;
        assertEq(pool.mintRate(), uint256(100e18) * s / (s + 500_000e6) * s / (s + 500_000e6));
        _books();
    }

    function testExcessPastTheCapGoesToStakers() public {
        vm.prank(owner);
        pool.setStakerRewardCap(10e6);
        _buy(alice, O, 0, 100e6, 500_000);
        _sell(alice, O, 0, 200e6, 250_000); // tracked $50, cash 49
        vm.prank(alice);
        pool.stake(1e18);
        uint256 before = pool.pendingReward(alice);
        pool.pushExcess();
        assertEq(pool.trackedLp(), int256(10e6));
        assertEq(pool.lpCash(), 49e6 - 40e6);
        assertEq(pool.pendingReward(alice) - before, 40e6);
        _books();
    }

    // ── the owner ────────────────────────────────────────────────────────

    function testSignerChangeWaitsTwoDays() public {
        address next = makeAddr("next");
        vm.prank(alice);
        vm.expectRevert();
        pool.proposeSigner(next);
        vm.startPrank(owner);
        pool.proposeSigner(next);
        vm.expectRevert(ArcdexPredictPool.TooEarly.selector);
        pool.applySigner();
        vm.warp(vm.getBlockTimestamp() + 2 days);
        pool.applySigner();
        vm.stopPrank();
        assertEq(pool.signer(), next);
    }

    function testParamBounds() public {
        vm.startPrank(owner);
        vm.expectRevert(ArcdexPredictPool.BadParams.selector);
        pool.setFees(501, 0, 0);
        vm.expectRevert(ArcdexPredictPool.BadParams.selector);
        pool.setTimes(5, 20, 600);
        vm.expectRevert(ArcdexPredictPool.BadParams.selector);
        pool.setTimes(60, 20, 30);
        vm.stopPrank();
    }

    function testWithdrawCantTakeMoreThanTheBalance() public {
        _buy(alice, O, 0, 100e6, 500_000);
        vm.prank(alice);
        vm.expectRevert(ArcdexPredictPool.BadAmount.selector);
        pool.withdraw(99_901e6);
    }

    // ── fuzz: the books always balance, nobody is paid twice ─────────────

    function testFuzzBooksBalance(uint256 seed) public {
        address[3] memory us = [alice, bob, carol];
        for (uint256 i; i < 30; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            address who = us[r % 3];
            uint32 o = uint32(1 + (r >> 8) % 3);
            uint8 side = uint8((r >> 16) % 2);
            uint64 px = uint64(20_000 + (r >> 24) % 960_000);
            (uint256 n,) = _held(who, o, side);
            (,,, , uint8 state,,,) = pool.markets(o);
            if (state != 0) {
                if (n != 0) pool.redeem(who, o, side);
            } else if ((r >> 40) % 5 == 0 && n == 0) {
                _settle(o, uint64((r >> 48) % 1_000_001));
            } else if (n != 0 && (r >> 64) % 2 == 0) {
                _sell(who, o, side, n / (1 + (r >> 72) % 2), px);
            } else {
                _buy(who, o, side, 1e6 + (r >> 80) % 5_000e6, px);
            }
            _books();
            assertGe(int256(usdc.balanceOf(address(pool))), 0);
        }
        pool.harvest(100);
        _books();
    }
}
