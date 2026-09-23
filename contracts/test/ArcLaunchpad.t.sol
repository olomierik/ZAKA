// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArcLaunchpad} from "../ArcLaunchpad.sol";
import {LaunchToken} from "../LaunchToken.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// Simulates a bot/wash-trading contract trading through ArcLaunchpad on
/// someone's behalf — msg.sender at the launchpad is this contract, while
/// tx.origin is whoever actually originated the transaction. That mismatch
/// is exactly what the tx.origin guard exists to catch.
contract BotCaller {
    ArcLaunchpad public immutable lp;
    constructor(ArcLaunchpad _lp) { lp = _lp; }
    function attackBuy(address token, uint256 usdcIn) external {
        lp.buy(token, usdcIn, 0);
    }
    function attackCreate() external {
        lp.createToken("Bot", "BOT", "uri", 0, 0);
    }
}

contract ArcLaunchpadTest is Test {
    ArcLaunchpad lp;
    MockUSDC usdcImpl;
    address constant USDC = 0x3600000000000000000000000000000000000000;

    address owner             = makeAddr("owner");
    address platformFeeWallet = makeAddr("platformFeeWallet");
    address creator           = makeAddr("creator");
    address alice             = makeAddr("alice");
    address bob               = makeAddr("bob");

    function setUp() public {
        // USDC is a fixed predeploy address on Arc — etch a mock ERC20's
        // code onto that exact address so the contract's hardcoded
        // `USDC` constant resolves to something real in tests.
        usdcImpl = new MockUSDC();
        vm.etch(USDC, address(usdcImpl).code);

        lp = new ArcLaunchpad(owner, platformFeeWallet);

        MockUSDC(USDC).mint(creator, 1_000_000_000_000); // $1,000,000
        MockUSDC(USDC).mint(alice, 1_000_000_000_000);
        MockUSDC(USDC).mint(bob, 1_000_000_000_000);

        vm.prank(creator); IERC20(USDC).approve(address(lp), type(uint256).max);
        vm.prank(alice);   IERC20(USDC).approve(address(lp), type(uint256).max);
        vm.prank(bob);     IERC20(USDC).approve(address(lp), type(uint256).max);
    }

    // buy/sell/createToken require msg.sender == tx.origin (anti-bot), so
    // every direct-EOA test call needs the two-arg prank form — the
    // single-arg form only fakes msg.sender and leaves tx.origin at
    // Foundry's default sender, which would itself trip the guard.
    function _launch(uint256 creatorTaxBps) internal returns (address token) {
        vm.prank(creator, creator);
        token = lp.createToken("Test Token", "TEST", "ipfs://meta", creatorTaxBps, 0);
    }

    // past the anti-snipe window, so ordinary-sized test buys aren't capped
    function _skipSnipeWindow() internal { vm.warp(block.timestamp + 601); }

    // ── launch ──────────────────────────────────────────────────────────

    function test_createToken_mints95PctToCurve5PctToPlatform() public {
        address token = _launch(0);
        uint256 platformShare = (lp.TOTAL_SUPPLY() * lp.PLATFORM_CREATION_SHARE_BPS()) / lp.BPS_DENOMINATOR();
        assertEq(IERC20(token).balanceOf(platformFeeWallet), platformShare);
        assertEq(IERC20(token).balanceOf(address(lp)), lp.TOTAL_SUPPLY() - platformShare);
        assertEq(IERC20(token).totalSupply(), lp.TOTAL_SUPPLY());
    }

    function test_createToken_chargesNoUsdcFeeBeyondOptionalInitialBuy() public {
        uint256 before = IERC20(USDC).balanceOf(creator);
        _launch(0);
        assertEq(before, IERC20(USDC).balanceOf(creator), "no USDC fee, only supply-based");
    }

    function test_createToken_withInitialBuy_givesCreatorTokens() public {
        vm.prank(creator, creator);
        address token = lp.createToken("Test", "TST", "uri", 0, 100_000_000); // $100 initial buy
        assertGt(IERC20(token).balanceOf(creator), 0);
    }

    function test_createToken_rejectsEmptyName() public {
        vm.expectRevert(ArcLaunchpad.InvalidMetadata.selector);
        vm.prank(creator, creator);
        lp.createToken("", "TST", "uri", 0, 0);
    }

    function test_createToken_rejectsTaxAboveCap() public {
        vm.expectRevert(ArcLaunchpad.InvalidTax.selector);
        vm.prank(creator, creator);
        lp.createToken("Test", "TST", "uri", 301, 0);
    }

    function test_createToken_taxAtCapIsAllowed() public {
        vm.prank(creator, creator);
        address token = lp.createToken("Test", "TST", "uri", 300, 0);
        (, uint96 taxBps,,,,,,) = lp.curves(token);
        assertEq(taxBps, 300);
    }

    function test_createToken_revertsFromContract() public {
        BotCaller bot = new BotCaller(lp);
        vm.expectRevert(ArcLaunchpad.NoContracts.selector);
        bot.attackCreate();
    }

    // ── fees ────────────────────────────────────────────────────────────

    function test_buy_feesRouteDirectlyNoAccrual() public {
        address token = _launch(300); // max 3% creator tax
        _skipSnipeWindow();
        uint256 usdcIn = 1_000_000_000; // $1,000

        uint256 platformBefore = IERC20(USDC).balanceOf(platformFeeWallet);
        uint256 creatorBefore  = IERC20(USDC).balanceOf(creator);

        vm.prank(alice, alice);
        lp.buy(token, usdcIn, 0);

        uint256 platformSwapFee = (usdcIn * lp.PLATFORM_SWAP_FEE_BPS()) / lp.BPS_DENOMINATOR(); // 1%
        uint256 creatorTax = (usdcIn * 300) / lp.BPS_DENOMINATOR(); // 3%
        uint256 creatorCut = (creatorTax * lp.CREATOR_TAX_CREATOR_SHARE_BPS()) / lp.BPS_DENOMINATOR(); // 60% of tax
        uint256 platformCut = platformSwapFee + (creatorTax - creatorCut);

        assertEq(IERC20(USDC).balanceOf(creator) - creatorBefore, creatorCut);
        assertEq(IERC20(USDC).balanceOf(platformFeeWallet) - platformBefore, platformCut);
    }

    function test_buy_zeroTaxMeansOnlyPlatformSwapFee() public {
        address token = _launch(0);
        _skipSnipeWindow();
        uint256 usdcIn = 1_000_000_000;
        uint256 creatorBefore = IERC20(USDC).balanceOf(creator);

        vm.prank(alice, alice);
        lp.buy(token, usdcIn, 0);

        assertEq(IERC20(USDC).balanceOf(creator), creatorBefore, "zero tax => creator gets nothing from this trade");
    }

    function test_sell_paysFeesToo() public {
        address token = _launch(300);
        _skipSnipeWindow();
        vm.startPrank(alice, alice);
        lp.buy(token, 1_000_000_000, 0);
        uint256 tokensGot = IERC20(token).balanceOf(alice);
        IERC20(token).approve(address(lp), tokensGot);

        uint256 platformBefore = IERC20(USDC).balanceOf(platformFeeWallet);
        lp.sell(token, tokensGot, 0);
        vm.stopPrank();

        assertGt(IERC20(USDC).balanceOf(platformFeeWallet), platformBefore);
    }

    // ── curve math ──────────────────────────────────────────────────────

    function test_buy_increasesPriceAlongCurve() public {
        address token = _launch(0);
        _skipSnipeWindow();
        uint256 priceBefore = lp.currentPrice(token);
        vm.prank(alice, alice);
        lp.buy(token, 1_000_000_000, 0);
        assertGt(lp.currentPrice(token), priceBefore);
    }

    function test_buyThenSell_roundTripLosesOnlyFees() public {
        address token = _launch(0);
        _skipSnipeWindow();

        vm.startPrank(alice, alice);
        uint256 usdcBefore = IERC20(USDC).balanceOf(alice);
        lp.buy(token, 1_000_000_000, 0);
        uint256 tokensGot = IERC20(token).balanceOf(alice);
        IERC20(token).approve(address(lp), tokensGot);
        lp.sell(token, tokensGot, 0);
        vm.stopPrank();

        uint256 usdcAfter = IERC20(USDC).balanceOf(alice);
        assertLt(usdcAfter, usdcBefore, "round trip must cost something (fees)");
        assertGt(usdcAfter, usdcBefore - 1_000_000_000 * 3 / 100, "zero-tax round trip must not lose more than ~3%");
    }

    function test_sell_cannotUnderflowReserves() public {
        address token = _launch(0);
        _skipSnipeWindow();
        vm.startPrank(alice, alice);
        lp.buy(token, 1_000_000_000, 0);
        uint256 tokens = IERC20(token).balanceOf(alice);
        IERC20(token).approve(address(lp), tokens);
        lp.sell(token, tokens, 0);
        vm.stopPrank();
        (, , , , , uint256 rUsdc, ,) = lp.curves(token);
        assertGe(rUsdc, 0);
    }

    function test_buy_revertsOnSlippage() public {
        address token = _launch(0);
        _skipSnipeWindow();
        vm.expectRevert(ArcLaunchpad.SlippageTooHigh.selector);
        vm.prank(alice, alice);
        lp.buy(token, 1_000_000_000, type(uint256).max);
    }

    // ── graduation ──────────────────────────────────────────────────────

    function test_graduation_triggersAtThreshold() public {
        address token = _launch(0);
        _skipSnipeWindow();
        // Spread across many buys, one per block, to stay under the
        // per-block cap. Track the block number in a local var rather than
        // repeatedly reading block.number in the loop — with viaIR, the
        // optimizer can (validly, since block.number is genuinely constant
        // within one real transaction) cache that read across iterations,
        // so `vm.roll(block.number + 1)` would silently roll to the same
        // block every time instead of actually advancing it.
        uint256 blk = block.number;
        for (uint256 i = 0; i < 15; i++) {
            blk += 1;
            vm.roll(blk);
            vm.prank(alice, alice);
            lp.buy(token, 2_000_000_000, 0); // $2,000 x 15 = $30,000 gross — clears the $25k graduation bar, stays under the ~$36-38k full-depletion point
        }
        (, , , , , uint256 rUsdc, , bool graduated) = lp.curves(token);
        assertTrue(graduated);
        assertGe(rUsdc, lp.GRADUATION_THRESHOLD_USDC());
        assertEq(lp.bondingProgressBps(token), lp.BPS_DENOMINATOR());
    }

    function test_curveNeverRunsDryBeforeGraduation() public {
        address token = _launch(0);
        _skipSnipeWindow();
        uint256 blk = block.number;
        for (uint256 i = 0; i < 18; i++) {
            blk += 1;
            vm.roll(blk);
            vm.prank(alice, alice);
            lp.buy(token, 2_000_000_000, 0); // $36,000 gross, under the ~$38k full-depletion point
        }
        (, , , , , , uint256 rToken,) = lp.curves(token);
        assertGt(rToken, 0);
    }

    // ── anti-snipe ──────────────────────────────────────────────────────

    function test_antiSnipe_blocksOversizedBuyInWindow() public {
        address token = _launch(0);
        // a huge buy that would take far more than 2% of remaining supply
        vm.expectRevert(ArcLaunchpad.ExceedsSnipeLimit.selector);
        vm.prank(alice, alice);
        lp.buy(token, 30_000_000_000, 0); // $30,000
    }

    function test_antiSnipe_allowsSmallBuyInWindow() public {
        address token = _launch(0);
        vm.prank(alice, alice);
        lp.buy(token, 10_000_000, 0); // $10 — tiny, well under the 2% cap
        assertGt(IERC20(token).balanceOf(alice), 0);
    }

    function test_antiSnipe_liftsAfterWindow() public {
        address token = _launch(0);
        _skipSnipeWindow();
        vm.prank(alice, alice);
        lp.buy(token, 3_000_000_000, 0); // $3,000 — would have been blocked pre-window ($2,000 snipe cap)
        assertGt(IERC20(token).balanceOf(alice), 0);
    }

    function test_antiSnipe_exemptForCreatorInitialBuy() public {
        // a large initial buy at creation must not be snipe-capped —
        // it's the creator seeding their own launch, not a sniper
        vm.prank(creator, creator);
        address token = lp.createToken("Test", "TST", "uri", 0, 5_000_000_000); // $5,000
        assertGt(IERC20(token).balanceOf(creator), 0);
    }

    // ── anti-bundle (per-block cap) ─────────────────────────────────────

    function test_antiBundle_blocksExceedingBlockCapAcrossWallets() public {
        address token = _launch(0);
        _skipSnipeWindow();

        // alice takes most of the block's capacity
        vm.prank(alice, alice);
        lp.buy(token, 1_500_000_000, 0); // $1,500

        // bob, a DIFFERENT wallet, tries to buy enough in the SAME block to blow past the cap
        vm.expectRevert(ArcLaunchpad.ExceedsBlockLimit.selector);
        vm.prank(bob, bob);
        lp.buy(token, 20_000_000_000, 0); // $20,000 — would exceed remaining block capacity
    }

    function test_antiBundle_resetsNextBlock() public {
        address token = _launch(0);
        _skipSnipeWindow();
        vm.prank(alice, alice);
        lp.buy(token, 1_500_000_000, 0);

        vm.roll(block.number + 1);
        vm.prank(bob, bob);
        lp.buy(token, 1_500_000_000, 0); // fine — new block, fresh capacity
        assertGt(IERC20(token).balanceOf(bob), 0);
    }

    function test_remainingBlockCapacity_decreasesAfterBuy() public {
        address token = _launch(0);
        _skipSnipeWindow();
        uint256 before = lp.remainingBlockCapacityUsdc(token);
        vm.prank(alice, alice);
        lp.buy(token, 500_000_000, 0);
        assertLt(lp.remainingBlockCapacityUsdc(token), before);
    }

    // ── anti-bot (tx.origin) ────────────────────────────────────────────

    function test_buy_revertsFromContract() public {
        address token = _launch(0);
        _skipSnipeWindow();
        BotCaller bot = new BotCaller(lp);
        MockUSDC(USDC).mint(address(bot), 1_000_000_000);
        vm.prank(address(bot));
        IERC20(USDC).approve(address(lp), type(uint256).max);

        // alice really is tx.origin here (two-arg prank) — the mismatch
        // that trips the guard is purely msg.sender (the bot) vs tx.origin
        // (alice), i.e. exactly "a contract traded on a real user's behalf".
        vm.expectRevert(ArcLaunchpad.NoContracts.selector);
        vm.prank(alice, alice);
        bot.attackBuy(token, 100_000_000);
    }

    // ── admin ───────────────────────────────────────────────────────────

    function test_pause_blocksTrading() public {
        address token = _launch(0);
        vm.prank(owner);
        lp.pause();
        vm.expectRevert(); // Pausable's own error — no tx.origin check on admin fns
        vm.prank(alice, alice);
        lp.buy(token, 1_000_000_000, 0);
    }

    function test_setPlatformFeeWallet_onlyOwner() public {
        vm.expectRevert();
        vm.prank(alice);
        lp.setPlatformFeeWallet(bob);
    }

    function test_setPlatformFeeWallet_routesFutureFees() public {
        address token = _launch(0);
        _skipSnipeWindow();
        address newWallet = makeAddr("newPlatformWallet");
        vm.prank(owner);
        lp.setPlatformFeeWallet(newWallet);

        vm.prank(alice, alice);
        lp.buy(token, 1_000_000_000, 0);
        assertGt(IERC20(USDC).balanceOf(newWallet), 0);
    }

    // ── fuzz ────────────────────────────────────────────────────────────

    function testFuzz_buySellNeverBreaksInvariants(uint256 buyAmount, uint256 taxBps) public {
        buyAmount = bound(buyAmount, 1_000_000, 3_000_000_000); // $1 to $3,000 — small enough to dodge anti-snipe/bundle caps reliably
        taxBps = bound(taxBps, 0, 300);
        address token = _launch(taxBps);
        _skipSnipeWindow();

        vm.prank(alice, alice);
        lp.buy(token, buyAmount, 0);

        (, , , uint256 vUsdc, uint256 vToken, uint256 rUsdc, uint256 rToken,) = lp.curves(token);
        assertGt(vUsdc, 0);
        assertGt(vToken, 0);
        assertLe(rToken, lp.TOTAL_SUPPLY());
        assertGe(rUsdc, 0);
        // the contract's real USDC balance must always cover what a token's
        // curve claims to hold in real reserves
        assertGe(IERC20(USDC).balanceOf(address(lp)), rUsdc);
    }
}
