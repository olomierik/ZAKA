// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ArcDexCurveRouter, ISolonFactory} from "../ArcDexCurveRouter.sol";

/// A launch token: fixed supply minted to its curve, no transfer rules.
contract MockLaunchToken is ERC20 {
    constructor() ERC20("Launch", "LAUNCH") {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

/// Mercuri's BondingCurve as a caller sees it (mercuri-launch-contracts
/// v1.0.0): a 1% fee and a snipe tax on buys, tokens and any refund paid to
/// the caller, sells pulled from and paid to the caller, fees forwarded to
/// the FeeManager. A flat price stands in for the curve math, which the
/// router never depends on; `maxIn` models the final buy that sells the
/// curve out and refunds the rest.
contract MockMercuriCurve {
    error Expired();
    error NotTrading();
    error ZeroAmount();
    error Slippage();
    error TransferFailed();

    MockLaunchToken public immutable token;
    address public immutable feeManager;
    uint256 public constant RATE = 1_000; // tokens per USDC
    uint256 public tradeFeeBps = 100;
    uint256 public taxBps;
    uint256 public maxIn = type(uint256).max;
    uint8 public phase;
    address public lastTrader;
    address public lastReferrer;
    address public reenterTarget;
    bytes public reenterData;
    // Misbehaviour switches, for the router's own safeguards.
    bool public ignoreMin;
    bool public pullShort;

    constructor(address feeManager_) {
        feeManager = feeManager_;
        token = new MockLaunchToken();
    }

    function setMaxIn(uint256 v) external { maxIn = v; }
    function setTaxBps(uint256 v) external { taxBps = v; }
    function setPhase(uint8 v) external { phase = v; }
    function setReenter(address target, bytes calldata data) external { reenterTarget = target; reenterData = data; }
    function setIgnoreMin(bool v) external { ignoreMin = v; }
    function setPullShort(bool v) external { pullShort = v; }

    function buy(uint256 minTokensOut, address referrer, uint256 deadline) external payable returns (uint256 tokensOut) {
        if (block.timestamp > deadline) revert Expired();
        if (phase != 0) revert NotTrading();
        if (msg.value == 0) revert ZeroAmount();
        if (reenterTarget != address(0)) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            if (!ok) {
                assembly { revert(add(ret, 32), mload(ret)) }
            }
        }
        uint256 used = msg.value > maxIn ? maxIn : msg.value;
        uint256 fee = used * tradeFeeBps / 10_000;
        uint256 tax = (used - fee) * taxBps / 10_000;
        tokensOut = (used - fee - tax) * RATE;
        if (tokensOut == 0) revert ZeroAmount();
        if (!ignoreMin && tokensOut < minTokensOut) revert Slippage();
        lastTrader = msg.sender;
        lastReferrer = referrer;
        token.transfer(msg.sender, tokensOut);
        _send(feeManager, fee + tax);
        if (msg.value > used) _send(msg.sender, msg.value - used);
    }

    function sell(uint256 tokensIn, uint256 minUsdcOut, address referrer, uint256 deadline) external returns (uint256 usdcOut) {
        if (block.timestamp > deadline) revert Expired();
        if (phase == 2) revert NotTrading();
        if (tokensIn == 0) revert ZeroAmount();
        uint256 gross = tokensIn / RATE;
        uint256 fee = gross * tradeFeeBps / 10_000;
        usdcOut = gross - fee;
        if (usdcOut + fee == 0) revert ZeroAmount();
        if (usdcOut < minUsdcOut) revert Slippage();
        lastTrader = msg.sender;
        lastReferrer = referrer;
        token.transferFrom(msg.sender, address(this), pullShort ? tokensIn - 1 : tokensIn);
        _send(feeManager, fee);
        _send(msg.sender, usdcOut);
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    receive() external payable {}
}

contract MockMercuriFactory {
    mapping(address => address) public curveOf;
    function set(address token, address curve) external { curveOf[token] = curve; }
}

/// SolonPad's Pons V2 curve as a caller sees it (solonpad-skill abis/ and
/// AGENT-GUIDE.md): quoteIn must equal msg.value, a zero minimum is
/// rejected, tokens go to `recipient` and the unspent part of an oversized
/// buy is refunded to the caller; sells pull from the caller and pay
/// `recipient`. The snipe tax is the recipient's (creators are exempt).
contract MockSolonCurve {
    error CurveGraduated();
    error NativeValueMismatch(uint256 supplied, uint256 expected);
    error MinimumOutputRequired();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error TransferFailed();

    MockLaunchToken public immutable token;
    address public immutable feeEscrow;
    uint256 public constant RATE = 500; // tokens per USDC
    uint256 public feeBps = 100;
    uint256 public creatorTaxBps = 100;
    uint256 public snipeBps;
    uint256 public maxIn = type(uint256).max;
    bool public graduated;
    mapping(address => bool) public snipeTaxExempt;
    address public lastBuyer;
    address public lastRecipient;
    bool public ignoreMin;
    bool public pullShort;
    uint256 public bonus;

    constructor(address feeEscrow_) {
        feeEscrow = feeEscrow_;
        token = new MockLaunchToken();
    }

    function setMaxIn(uint256 v) external { maxIn = v; }
    function setSnipe(uint256 bps, address exempt) external { snipeBps = bps; snipeTaxExempt[exempt] = true; }
    function setGraduated(bool v) external { graduated = v; }
    function setIgnoreMin(bool v) external { ignoreMin = v; }
    function setPullShort(bool v) external { pullShort = v; }
    function setBonus(uint256 v) external { bonus = v; }

    function currentSnipeTaxBps(address recipient) public view returns (uint256) {
        return snipeTaxExempt[recipient] ? 0 : snipeBps;
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut) {
        if (graduated) revert CurveGraduated();
        if (msg.value != quoteIn) revert NativeValueMismatch(msg.value, quoteIn);
        if (minTokensOut == 0) revert MinimumOutputRequired();
        uint256 used = quoteIn > maxIn ? maxIn : quoteIn;
        uint256 fee = used * feeBps / 10_000;
        uint256 tax = used * (creatorTaxBps + currentSnipeTaxBps(recipient)) / 10_000;
        tokensOut = (used - fee - tax) * RATE;
        if (!ignoreMin && tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);
        lastBuyer = msg.sender;
        lastRecipient = recipient;
        token.transfer(recipient, tokensOut);
        _send(feeEscrow, fee + tax);
        if (quoteIn > used) _send(msg.sender, quoteIn - used);
        if (bonus > 0) _send(msg.sender, bonus);
    }

    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256 quoteOut) {
        if (graduated) revert CurveGraduated();
        if (minQuoteOut == 0) revert MinimumOutputRequired();
        uint256 gross = tokensIn / RATE;
        uint256 fee = gross * feeBps / 10_000;
        uint256 tax = gross * creatorTaxBps / 10_000;
        quoteOut = gross - fee - tax;
        if (quoteOut < minQuoteOut) revert SlippageExceeded(quoteOut, minQuoteOut);
        lastBuyer = msg.sender;
        lastRecipient = recipient;
        token.transferFrom(msg.sender, address(this), pullShort ? tokensIn - 1 : tokensIn);
        _send(feeEscrow, fee + tax);
        _send(recipient, quoteOut);
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    receive() external payable {}
}

contract MockSolonFactory {
    error TokenNotFound();
    mapping(address => ISolonFactory.LaunchedToken) internal launched;

    function launch(address token, address curve, address pairToken) external {
        ISolonFactory.LaunchedToken storage t = launched[token];
        t.token = token;
        t.curve = curve;
        t.pairToken = pairToken;
        t.exists = true;
    }

    function getLaunchedToken(address token) external view returns (ISolonFactory.LaunchedToken memory t) {
        t = launched[token];
        if (!t.exists) revert TokenNotFound();
    }
}

/// Has no receive(): native transfers to it fail.
contract NoReceive {}

/// Burns every bit of gas it's sent native USDC with.
contract GasBurner {
    uint256 public sink;
    receive() external payable {
        while (true) sink++;
    }
}

contract StrayToken is ERC20 {
    constructor() ERC20("Stray", "STRAY") { _mint(msg.sender, 1e24); }
}

contract ArcDexCurveRouterTest is Test {
    event Swapped(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address feeToken,
        uint256 fee
    );
    event ReferrerBound(address indexed user, address indexed referrer);
    event ReferralPaid(address indexed referrer, address indexed user, address indexed token, uint256 amount);

    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant NO_REF = address(0);

    ArcDexCurveRouter router;
    MockMercuriFactory mFactory;
    MockSolonFactory sFactory;
    MockMercuriCurve mCurve;
    MockSolonCurve sCurve;
    address mToken;
    address sToken;

    address owner = makeAddr("owner");
    address feeWallet = makeAddr("feeWallet");
    address user = makeAddr("user");
    address friend = makeAddr("friend");
    address other = makeAddr("other");
    address mercuriFees = makeAddr("mercuriFeeManager");
    address solonFees = makeAddr("solonFeeEscrow");

    function setUp() public {
        mFactory = new MockMercuriFactory();
        sFactory = new MockSolonFactory();
        mCurve = new MockMercuriCurve(mercuriFees);
        sCurve = new MockSolonCurve(solonFees);
        mToken = address(mCurve.token());
        sToken = address(sCurve.token());
        mFactory.set(mToken, address(mCurve));
        sFactory.launch(sToken, address(sCurve), address(0));
        router = new ArcDexCurveRouter(address(mFactory), address(sFactory), USDC, feeWallet, owner);
        // Curves hold what earlier buyers paid in; sells pay out of it.
        vm.deal(address(mCurve), 1_000_000e18);
        vm.deal(address(sCurve), 1_000_000e18);
        vm.deal(user, 1_000_000e18);
        vm.startPrank(user);
        ERC20(mToken).approve(address(router), type(uint256).max);
        ERC20(sToken).approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    // ── helpers ───────────────────────────────────────────────────────

    function _buyM(uint256 value, address ref) internal returns (uint256) {
        vm.prank(user);
        return router.buyMercuri{value: value}(mToken, 0, block.timestamp, ref);
    }

    function _buyS(uint256 value, address ref) internal returns (uint256) {
        vm.prank(user);
        return router.buySolon{value: value}(sToken, 0, block.timestamp, ref);
    }

    function _assertRouterEmpty() internal view {
        assertEq(address(router).balance, 0, "router holds native");
        assertEq(ERC20(mToken).balanceOf(address(router)), 0, "router holds Mercuri tokens");
        assertEq(ERC20(sToken).balanceOf(address(router)), 0, "router holds SolonPad tokens");
    }

    // ── setup ─────────────────────────────────────────────────────────

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(ArcDexCurveRouter.ZeroAddress.selector);
        new ArcDexCurveRouter(address(0), address(sFactory), USDC, feeWallet, owner);
        vm.expectRevert(ArcDexCurveRouter.ZeroAddress.selector);
        new ArcDexCurveRouter(address(mFactory), address(0), USDC, feeWallet, owner);
        vm.expectRevert(ArcDexCurveRouter.ZeroAddress.selector);
        new ArcDexCurveRouter(address(mFactory), address(sFactory), address(0), feeWallet, owner);
        vm.expectRevert(ArcDexCurveRouter.ZeroAddress.selector);
        new ArcDexCurveRouter(address(mFactory), address(sFactory), USDC, address(0), owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ArcDexCurveRouter(address(mFactory), address(sFactory), USDC, feeWallet, address(0));
    }

    function test_defaults_twoPercentFee_fifteenPercentReferralShare() public view {
        assertEq(router.VERSION(), 1);
        assertEq(router.feeBps(), 200);
        assertEq(router.MAX_FEE_BPS(), 200);
        assertEq(router.referralShareBps(), 1_500);
        assertEq(router.MAX_REFERRAL_SHARE_BPS(), 5_000);
        assertEq(router.usdc(), USDC);
        assertEq(address(router.mercuriFactory()), address(mFactory));
        assertEq(address(router.solonFactory()), address(sFactory));
        assertEq(router.owner(), owner);
    }

    // ── Mercuri ───────────────────────────────────────────────────────

    function test_buyMercuri_feeOffTheInput_tokensForwarded() public {
        uint256 userBefore = user.balance;
        uint256 got = _buyM(100e18, NO_REF);

        // 2% to ARCDEX; the curve gets 98 and takes its own 1% of that.
        assertEq(feeWallet.balance, 2e18);
        assertEq(mercuriFees.balance, 0.98e18);
        uint256 expected = (98e18 - 0.98e18) * mCurve.RATE();
        assertEq(got, expected);
        assertEq(ERC20(mToken).balanceOf(user), expected);
        assertEq(userBefore - user.balance, 100e18);
        // The curve credited the router, which named ARCDEX's fee wallet to Mercuri.
        assertEq(mCurve.lastTrader(), address(router));
        assertEq(mCurve.lastReferrer(), feeWallet);
        _assertRouterEmpty();
    }

    function test_buyMercuri_emitsSwappedInUsdcUnits() public {
        uint256 expected = (98e18 - 0.98e18) * mCurve.RATE();
        vm.expectEmit(true, true, true, true, address(router));
        emit Swapped(user, USDC, mToken, 100e6, expected, USDC, 2e6);
        _buyM(100e18, NO_REF);
    }

    function test_buyMercuri_finalBuy_refundsUnusedInputAndItsFee() public {
        // The curve takes 49 of the 98 sent and refunds 49 (it sold out).
        mCurve.setMaxIn(49e18);
        uint256 userBefore = user.balance;
        uint256 expected = (49e18 - 0.49e18) * mCurve.RATE();
        vm.expectEmit(true, true, true, true, address(router));
        emit Swapped(user, USDC, mToken, 50e6, expected, USDC, 1e6);
        _buyM(100e18, NO_REF);

        // Fee only on the half that was used: 1, not 2; the user paid 50 in all.
        assertEq(feeWallet.balance, 1e18);
        assertEq(userBefore - user.balance, 50e18);
        assertEq(ERC20(mToken).balanceOf(user), expected);
        _assertRouterEmpty();
    }

    function test_buyMercuri_minTokensOut_enforced() public {
        uint256 expected = (98e18 - 0.98e18) * mCurve.RATE();
        vm.prank(user);
        vm.expectRevert(MockMercuriCurve.Slippage.selector);
        router.buyMercuri{value: 100e18}(mToken, expected + 1, block.timestamp, NO_REF);
        // Exactly the minimum goes through.
        vm.prank(user);
        router.buyMercuri{value: 100e18}(mToken, expected, block.timestamp, NO_REF);
    }

    function test_buyMercuri_curveClosed_reverts() public {
        mCurve.setPhase(1); // graduation pending: sells only
        vm.prank(user);
        vm.expectRevert(MockMercuriCurve.NotTrading.selector);
        router.buyMercuri{value: 1e18}(mToken, 0, block.timestamp, NO_REF);
    }

    function test_sellMercuri_feeOffTheProceeds() public {
        uint256 got = _buyM(100e18, NO_REF);
        uint256 feeBefore = feeWallet.balance;
        uint256 userBefore = user.balance;
        uint256 sellAmt = got / 2;

        vm.prank(user);
        uint256 out = router.sellMercuri(mToken, sellAmt, 0, block.timestamp, NO_REF);

        uint256 gross = sellAmt / mCurve.RATE();
        uint256 proceeds = gross - gross / 100; // after Mercuri's 1%
        uint256 fee = proceeds * 200 / 10_000;
        assertEq(out, proceeds - fee);
        assertEq(user.balance - userBefore, proceeds - fee);
        assertEq(feeWallet.balance - feeBefore, fee);
        assertEq(ERC20(mToken).balanceOf(user), got - sellAmt);
        assertEq(mCurve.lastTrader(), address(router));
        assertEq(mCurve.lastReferrer(), feeWallet);
        // The exact approval is used up; nothing is left approved.
        assertEq(ERC20(mToken).allowance(address(router), address(mCurve)), 0);
        _assertRouterEmpty();
    }

    function test_sellMercuri_minimumIsAfterTheFee() public {
        uint256 got = _buyM(100e18, NO_REF);
        uint256 gross = got / mCurve.RATE();
        uint256 proceeds = gross - gross / 100;
        uint256 afterFee = proceeds - proceeds * 200 / 10_000;
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ArcDexCurveRouter.InsufficientOutput.selector, afterFee, proceeds));
        router.sellMercuri(mToken, got, proceeds, block.timestamp, NO_REF);
        vm.prank(user);
        assertEq(router.sellMercuri(mToken, got, afterFee, block.timestamp, NO_REF), afterFee);
    }

    function test_sellMercuri_emitsSwappedInUsdcUnits() public {
        uint256 got = _buyM(100e18, NO_REF);
        uint256 gross = got / mCurve.RATE();
        uint256 proceeds = gross - gross / 100;
        uint256 fee = proceeds * 200 / 10_000;
        vm.expectEmit(true, true, true, true, address(router));
        emit Swapped(user, mToken, USDC, got, (proceeds - fee) / 1e12, USDC, fee / 1e12);
        vm.prank(user);
        router.sellMercuri(mToken, got, 0, block.timestamp, NO_REF);
    }

    // ── SolonPad ──────────────────────────────────────────────────────

    function test_buySolon_tokensStraightToTheTrader() public {
        uint256 userBefore = user.balance;
        uint256 got = _buyS(100e18, NO_REF);

        assertEq(feeWallet.balance, 2e18);
        // 1% fee + 1% creator tax on the 98 that reached the curve.
        uint256 expected = (98e18 - 0.98e18 - 0.98e18) * sCurve.RATE();
        assertEq(got, expected);
        assertEq(ERC20(sToken).balanceOf(user), expected);
        assertEq(userBefore - user.balance, 100e18);
        assertEq(sCurve.lastBuyer(), address(router));
        assertEq(sCurve.lastRecipient(), user);
        _assertRouterEmpty();
    }

    function test_buySolon_zeroMinimumStillAccepted() public {
        // SolonPad rejects a zero minimum; the router sends 1 in its place.
        vm.prank(user);
        assertGt(router.buySolon{value: 1e18}(sToken, 0, block.timestamp, NO_REF), 0);
    }

    function test_buySolon_snipeTaxIsTheRecipients() public {
        // 50% snipe tax, but the trader is exempt (a creator buying their own launch).
        sCurve.setSnipe(5_000, user);
        uint256 got = _buyS(100e18, NO_REF);
        assertEq(got, (98e18 - 0.98e18 - 0.98e18) * sCurve.RATE());
        assertEq(sCurve.currentSnipeTaxBps(address(router)), 5_000);
    }

    function test_buySolon_finalBuy_refundsUnusedInputAndItsFee() public {
        sCurve.setMaxIn(49e18);
        uint256 userBefore = user.balance;
        _buyS(100e18, NO_REF);
        assertEq(feeWallet.balance, 1e18);
        assertEq(userBefore - user.balance, 50e18);
        _assertRouterEmpty();
    }

    function test_buy_paidBackMoreThanItSent_allToTheTrader() public {
        // Should a curve ever pay its caller more than the buy sent (say, from a
        // graduation step), the trade still goes through: it all goes to the trader, fee-free.
        sCurve.setMaxIn(49e18);
        sCurve.setBonus(60e18);
        uint256 userBefore = user.balance;
        _buyS(100e18, NO_REF);
        assertEq(feeWallet.balance, 0);
        // Paid 100, got back the unused 49 of the 98 sent, the 60 and the whole 2 of the fee.
        assertEq(user.balance, userBefore - 100e18 + 49e18 + 60e18 + 2e18);
        _assertRouterEmpty();
    }

    function test_buySolon_minTokensOut_enforced() public {
        uint256 expected = (98e18 - 0.98e18 - 0.98e18) * sCurve.RATE();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MockSolonCurve.SlippageExceeded.selector, expected, expected + 1));
        router.buySolon{value: 100e18}(sToken, expected + 1, block.timestamp, NO_REF);
    }

    function test_buySolon_graduated_reverts() public {
        sCurve.setGraduated(true);
        vm.prank(user);
        vm.expectRevert(MockSolonCurve.CurveGraduated.selector);
        router.buySolon{value: 1e18}(sToken, 0, block.timestamp, NO_REF);
    }

    function test_sellSolon_feeOffTheProceeds() public {
        uint256 got = _buyS(100e18, NO_REF);
        uint256 feeBefore = feeWallet.balance;
        uint256 userBefore = user.balance;

        vm.prank(user);
        uint256 out = router.sellSolon(sToken, got, 0, block.timestamp, NO_REF);

        uint256 gross = got / sCurve.RATE();
        uint256 proceeds = gross - gross / 100 - gross / 100; // fee + creator tax
        uint256 fee = proceeds * 200 / 10_000;
        assertEq(out, proceeds - fee);
        assertEq(user.balance - userBefore, proceeds - fee);
        assertEq(feeWallet.balance - feeBefore, fee);
        // Proceeds came to the router (for the fee), from the router's own sale.
        assertEq(sCurve.lastBuyer(), address(router));
        assertEq(sCurve.lastRecipient(), address(router));
        assertEq(ERC20(sToken).allowance(address(router), address(sCurve)), 0);
        _assertRouterEmpty();
    }

    function test_sellSolon_minimumIsAfterTheFee() public {
        uint256 got = _buyS(100e18, NO_REF);
        uint256 gross = got / sCurve.RATE();
        uint256 proceeds = gross - gross / 100 - gross / 100;
        uint256 afterFee = proceeds - proceeds * 200 / 10_000;
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ArcDexCurveRouter.InsufficientOutput.selector, afterFee, afterFee + 1));
        router.sellSolon(sToken, got, afterFee + 1, block.timestamp, NO_REF);
    }

    // ── only the launchpads' own curves ──────────────────────────────

    function test_unknownToken_rejectedEverywhere() public {
        address stray = address(new StrayToken());
        bytes memory err = abi.encodeWithSelector(ArcDexCurveRouter.UnknownToken.selector, stray);
        vm.startPrank(user);
        vm.expectRevert(err);
        router.buyMercuri{value: 1e18}(stray, 0, block.timestamp, NO_REF);
        vm.expectRevert(err);
        router.sellMercuri(stray, 1e18, 0, block.timestamp, NO_REF);
        vm.expectRevert(err);
        router.buySolon{value: 1e18}(stray, 0, block.timestamp, NO_REF);
        vm.expectRevert(err);
        router.sellSolon(stray, 1e18, 0, block.timestamp, NO_REF);
        vm.stopPrank();
    }

    function test_tokenOfTheOtherLaunchpad_rejected() public {
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(ArcDexCurveRouter.UnknownToken.selector, sToken));
        router.buyMercuri{value: 1e18}(sToken, 0, block.timestamp, NO_REF);
        vm.expectRevert(abi.encodeWithSelector(ArcDexCurveRouter.UnknownToken.selector, mToken));
        router.buySolon{value: 1e18}(mToken, 0, block.timestamp, NO_REF);
        vm.stopPrank();
    }

    function test_mercuri_curveMustNameTheTokenBack() public {
        // The factory maps a token to a curve that trades a different token.
        address stray = address(new StrayToken());
        mFactory.set(stray, address(mCurve));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ArcDexCurveRouter.UnknownToken.selector, stray));
        router.buyMercuri{value: 1e18}(stray, 0, block.timestamp, NO_REF);
    }

    function test_solon_erc20QuotedCurve_rejected() public {
        MockSolonCurve stockCurve = new MockSolonCurve(solonFees);
        address stock = address(stockCurve.token());
        sFactory.launch(stock, address(stockCurve), makeAddr("tokenizedStock"));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ArcDexCurveRouter.UnknownToken.selector, stock));
        router.buySolon{value: 1e18}(stock, 0, block.timestamp, NO_REF);
    }

    // ── guards ────────────────────────────────────────────────────────

    function test_deadline_and_zeroAmounts() public {
        vm.warp(1_000);
        vm.startPrank(user);
        vm.expectRevert(ArcDexCurveRouter.DeadlineExpired.selector);
        router.buyMercuri{value: 1e18}(mToken, 0, 999, NO_REF);
        vm.expectRevert(ArcDexCurveRouter.DeadlineExpired.selector);
        router.sellSolon(sToken, 1e18, 0, 999, NO_REF);
        vm.expectRevert(ArcDexCurveRouter.ZeroAmount.selector);
        router.buySolon{value: 0}(sToken, 0, 1_000, NO_REF);
        vm.expectRevert(ArcDexCurveRouter.ZeroAmount.selector);
        router.sellMercuri(mToken, 0, 0, 1_000, NO_REF);
        vm.stopPrank();
    }

    function test_pause_blocksEveryTrade() public {
        uint256 m = _buyM(10e18, NO_REF);
        uint256 s = _buyS(10e18, NO_REF);
        vm.prank(owner);
        router.pause();
        vm.startPrank(user);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.buyMercuri{value: 1e18}(mToken, 0, block.timestamp, NO_REF);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.sellMercuri(mToken, m, 0, block.timestamp, NO_REF);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.buySolon{value: 1e18}(sToken, 0, block.timestamp, NO_REF);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.sellSolon(sToken, s, 0, block.timestamp, NO_REF);
        vm.stopPrank();
        vm.prank(owner);
        router.unpause();
        vm.prank(user);
        router.sellMercuri(mToken, m, 0, block.timestamp, NO_REF);
    }

    function test_receive_refusesPlainTransfers() public {
        vm.prank(user);
        (bool ok, bytes memory ret) = address(router).call{value: 1e18}("");
        assertFalse(ok);
        assertEq(bytes4(ret), ArcDexCurveRouter.UnexpectedNative.selector);
    }

    function test_reentrancy_blocked() public {
        // A curve that calls back into the router mid-trade.
        mCurve.setReenter(
            address(router), abi.encodeCall(ArcDexCurveRouter.sellSolon, (sToken, 1, 0, block.timestamp, NO_REF))
        );
        vm.prank(user);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        router.buyMercuri{value: 1e18}(mToken, 0, block.timestamp, NO_REF);
    }

    function test_buy_minTokensOut_checkedByTheRouterToo() public {
        // Even a curve that ignored the minimum couldn't short the trader.
        mCurve.setIgnoreMin(true);
        sCurve.setIgnoreMin(true);
        uint256 m = (98e18 - 0.98e18) * mCurve.RATE();
        uint256 s = (98e18 - 0.98e18 - 0.98e18) * sCurve.RATE();
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(ArcDexCurveRouter.InsufficientOutput.selector, m, m + 1));
        router.buyMercuri{value: 100e18}(mToken, m + 1, block.timestamp, NO_REF);
        vm.expectRevert(abi.encodeWithSelector(ArcDexCurveRouter.InsufficientOutput.selector, s, s + 1));
        router.buySolon{value: 100e18}(sToken, s + 1, block.timestamp, NO_REF);
        vm.stopPrank();
    }

    function test_sell_neverLeavesAnApproval() public {
        // A curve that takes less than it was approved for still ends with no allowance.
        uint256 m = _buyM(100e18, NO_REF);
        uint256 s = _buyS(100e18, NO_REF);
        mCurve.setPullShort(true);
        sCurve.setPullShort(true);
        vm.startPrank(user);
        router.sellMercuri(mToken, m, 0, block.timestamp, NO_REF);
        router.sellSolon(sToken, s, 0, block.timestamp, NO_REF);
        vm.stopPrank();
        assertEq(ERC20(mToken).allowance(address(router), address(mCurve)), 0);
        assertEq(ERC20(sToken).allowance(address(router), address(sCurve)), 0);
    }

    // ── referrals ─────────────────────────────────────────────────────

    function test_referral_boundOnFirstTrade_paidFifteenPercent() public {
        vm.expectEmit(true, true, false, false, address(router));
        emit ReferrerBound(user, friend);
        vm.expectEmit(true, true, true, true, address(router));
        emit ReferralPaid(friend, user, USDC, 0.3e6);
        _buyM(100e18, friend);

        assertEq(router.referrerOf(user), friend);
        assertEq(friend.balance, 0.3e18); // 15% of the 2 fee
        assertEq(feeWallet.balance, 1.7e18);

        // A later referrer is ignored: the first one keeps earning, on both launchpads.
        _buyS(100e18, other);
        assertEq(router.referrerOf(user), friend);
        assertEq(other.balance, 0);
        assertEq(friend.balance, 0.6e18);
        _assertRouterEmpty();
    }

    function test_referral_paidOnSellsToo() public {
        uint256 got = _buyS(100e18, friend);
        uint256 friendBefore = friend.balance;
        vm.prank(user);
        router.sellSolon(sToken, got, 0, block.timestamp, NO_REF);
        uint256 gross = got / sCurve.RATE();
        uint256 proceeds = gross - gross / 100 - gross / 100;
        assertEq(friend.balance - friendBefore, (proceeds * 200 / 10_000) * 1_500 / 10_000);
    }

    function test_referral_selfReferralIgnored() public {
        _buyM(100e18, user);
        assertEq(router.referrerOf(user), address(0));
        assertEq(feeWallet.balance, 2e18);
    }

    function test_referral_referrerThatRefusesNative_feeWalletGetsItAll() public {
        address refuser = address(new NoReceive());
        _buyM(100e18, refuser);
        assertEq(router.referrerOf(user), refuser);
        assertEq(feeWallet.balance, 2e18);
        _assertRouterEmpty();
    }

    function test_referral_gasBurningReferrer_cannotBlockTrades() public {
        address burner = address(new GasBurner());
        uint256 gasBefore = gasleft();
        _buyS(100e18, burner);
        // It got at most REFERRAL_GAS to burn, then its share went to feeWallet.
        assertLt(gasBefore - gasleft(), 400_000);
        assertEq(feeWallet.balance, 2e18);
        assertEq(burner.balance, 0);
        _assertRouterEmpty();
    }

    // ── admin ─────────────────────────────────────────────────────────

    function test_admin_onlyOwner() public {
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user);
        vm.startPrank(user);
        vm.expectRevert(notOwner);
        router.setFeeBps(100);
        vm.expectRevert(notOwner);
        router.setFeeWallet(user);
        vm.expectRevert(notOwner);
        router.setReferralShareBps(0);
        vm.expectRevert(notOwner);
        router.pause();
        vm.expectRevert(notOwner);
        router.rescueNative(1);
        vm.expectRevert(notOwner);
        router.rescueTokens(mToken, 1);
        vm.stopPrank();
    }

    function test_admin_capsHold() public {
        vm.startPrank(owner);
        vm.expectRevert(ArcDexCurveRouter.InvalidFeeBps.selector);
        router.setFeeBps(201);
        vm.expectRevert(ArcDexCurveRouter.InvalidFeeBps.selector);
        router.setReferralShareBps(5_001);
        vm.expectRevert(ArcDexCurveRouter.ZeroAddress.selector);
        router.setFeeWallet(address(0));
        router.setFeeBps(100);
        router.setReferralShareBps(5_000);
        vm.stopPrank();
        assertEq(router.feeBps(), 100);
        assertEq(router.referralShareBps(), 5_000);
    }

    function test_zeroFee_tradesWithoutPayingAnyone() public {
        vm.prank(owner);
        router.setFeeBps(0);
        uint256 got = _buyM(100e18, friend);
        assertEq(got, (100e18 - 1e18) * mCurve.RATE());
        vm.prank(user);
        router.sellMercuri(mToken, got, 0, block.timestamp, NO_REF);
        assertEq(feeWallet.balance, 0);
        assertEq(friend.balance, 0);
        _assertRouterEmpty();
    }

    function test_newFeeWallet_getsTheFees() public {
        address next = makeAddr("nextFeeWallet");
        vm.prank(owner);
        router.setFeeWallet(next);
        _buyS(100e18, NO_REF);
        assertEq(next.balance, 2e18);
        assertEq(feeWallet.balance, 0);
    }

    function test_feeWalletThatRefusesNative_tradesRevert() public {
        address refuser = address(new NoReceive());
        vm.prank(owner);
        router.setFeeWallet(refuser);
        vm.prank(user);
        vm.expectRevert(ArcDexCurveRouter.NativeTransferFailed.selector);
        router.buyMercuri{value: 1e18}(mToken, 0, block.timestamp, NO_REF);
    }

    function test_rescue_tokensAndForcedNative() public {
        address stray = address(new StrayToken());
        ERC20(stray).transfer(address(router), 5e18);
        vm.deal(address(router), 3e18); // forced in (e.g. selfdestruct)
        vm.startPrank(owner);
        router.rescueTokens(stray, 5e18);
        router.rescueNative(3e18);
        vm.stopPrank();
        assertEq(ERC20(stray).balanceOf(owner), 5e18);
        assertEq(owner.balance, 3e18);
    }

    function test_strayBalance_neverPaidToTraders() public {
        vm.deal(address(router), 7e18);
        uint256 userBefore = user.balance;
        uint256 got = _buyM(100e18, NO_REF);
        vm.prank(user);
        router.sellMercuri(mToken, got, 0, block.timestamp, NO_REF);
        assertEq(address(router).balance, 7e18);
        assertLt(user.balance, userBefore);
    }

    // ── invariants ────────────────────────────────────────────────────

    /// Every wei of a buy ends up with the curve, ARCDEX, the referrer, or
    /// back with the trader; the router keeps nothing.
    function testFuzz_buy_conservesValue(uint96 value, uint96 maxIn, uint16 feeBps, uint16 shareBps, bool mercuri) public {
        // Up to 100k USDC: the mock curves hold a billion tokens at a flat price.
        value = uint96(bound(value, 1e12, 1e23));
        feeBps = uint16(bound(feeBps, 0, 200));
        shareBps = uint16(bound(shareBps, 0, 5_000));
        vm.startPrank(owner);
        router.setFeeBps(feeBps);
        router.setReferralShareBps(shareBps);
        vm.stopPrank();
        vm.deal(user, value);
        uint256 curveBefore = mercuri ? address(mCurve).balance : address(sCurve).balance;
        uint256 feesBefore = mercuri ? mercuriFees.balance : solonFees.balance;

        if (mercuri) mCurve.setMaxIn(bound(maxIn, 1e10, type(uint96).max));
        else sCurve.setMaxIn(bound(maxIn, 1e10, type(uint96).max));
        vm.prank(user);
        if (mercuri) router.buyMercuri{value: value}(mToken, 0, block.timestamp, friend);
        else router.buySolon{value: value}(sToken, 0, block.timestamp, friend);

        uint256 toCurve = mercuri
            ? address(mCurve).balance - curveBefore + mercuriFees.balance - feesBefore
            : address(sCurve).balance - curveBefore + solonFees.balance - feesBefore;
        assertEq(toCurve + feeWallet.balance + friend.balance + user.balance, value);
        // The fee is feeBps of what the trader actually paid, never more.
        uint256 paid = value - user.balance;
        assertLe(feeWallet.balance + friend.balance, paid * feeBps / 10_000);
        _assertRouterEmpty();
    }

    /// A sell pays the trader everything the curve paid out, less the fee.
    function testFuzz_sell_conservesValue(uint96 value, uint16 feeBps, bool mercuri) public {
        value = uint96(bound(value, 1e15, 1e23));
        feeBps = uint16(bound(feeBps, 0, 200));
        uint256 got = mercuri ? _buyM(value, friend) : _buyS(value, friend);
        vm.prank(owner);
        router.setFeeBps(feeBps);
        uint256 userBefore = user.balance;
        uint256 platform = feeWallet.balance + friend.balance;
        uint256 curveBefore = mercuri ? address(mCurve).balance : address(sCurve).balance;
        uint256 feesBefore = mercuri ? mercuriFees.balance : solonFees.balance;

        vm.prank(user);
        uint256 out = mercuri
            ? router.sellMercuri(mToken, got, 0, block.timestamp, NO_REF)
            : router.sellSolon(sToken, got, 0, block.timestamp, NO_REF);

        uint256 fromCurve = mercuri
            ? curveBefore - address(mCurve).balance - (mercuriFees.balance - feesBefore)
            : curveBefore - address(sCurve).balance - (solonFees.balance - feesBefore);
        uint256 fee = feeWallet.balance + friend.balance - platform;
        assertEq(user.balance - userBefore, out);
        assertEq(out + fee, fromCurve);
        assertEq(fee, fromCurve * feeBps / 10_000);
        _assertRouterEmpty();
    }
}
