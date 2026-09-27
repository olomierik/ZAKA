// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// Mercuri (github.com/mercuri-finance/mercuri-launch-contracts, v1.0.0 as
/// deployed on Arc). One BondingCurve per launch; the LaunchFactory maps each
/// token to its curve. A curve pays tokens, refunds and sale proceeds to its
/// caller, and takes its 1% fee (plus a launch snipe tax on buys) itself.
interface IMercuriFactory {
    function curveOf(address token) external view returns (address);
}

interface IMercuriCurve {
    function token() external view returns (address);
    function buy(uint256 minTokensOut, address referrer, uint256 deadline) external payable returns (uint256 tokensOut);
    function sell(uint256 tokensIn, uint256 minUsdcOut, address referrer, uint256 deadline)
        external
        returns (uint256 usdcOut);
}

/// SolonPad's curve mode, Pons V2 (github.com/solonlend/solonpad-skill, abis/).
/// The factory's record names each launch's curve and what it is quoted in
/// (pairToken 0 = native USDC). A curve buy pays tokens to `recipient` and
/// refunds its caller; a sell pulls tokens from its caller and pays `recipient`.
interface ISolonFactory {
    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
}

interface ISolonCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256 quoteOut);
}

/// @title ArcDexCurveRouter
/// @notice Trades coins launched on Mercuri and SolonPad on their own bonding
/// curves, before they graduate to Uniswap, charging ARCDEX's platform fee
/// (hard-capped at 2%). The curves are priced in native USDC (18 decimals,
/// sent as msg.value), so the fee is too: off the input on a buy, off the
/// proceeds on a sell. The curve's own fee and taxes are charged as usual.
///
/// Callers name a token, never a curve: the curve is the one its
/// launchpad's factory records for the token (Mercuri `curveOf`, SolonPad
/// `getLaunchedToken`, native-USDC curves only), so the router only ever
/// sends funds or approvals to a curve that launchpad deployed.
///
/// A buy that sells a curve out is filled only in part, and the curve
/// refunds the rest: the fee is charged on the part the curve used and the
/// remainder of it returned with the refund.
///
/// Mercuri credits the trade to its caller, this router, and the router
/// forwards the tokens (or the refund, or the proceeds) in the same
/// transaction. Mercuri's FeeManager binds a referrer to each trader on its
/// first trade, and the router always names `feeWallet`, so Mercuri's
/// referral share of its own fee on every trade through the router accrues
/// to that fee wallet (claimable there with `FeeManager.claim`). A SolonPad
/// buy pays the tokens straight to the trader, so its snipe tax is the
/// trader's (a creator's exemption still applies).
///
/// Referrals work as in ArcDexSwapRouter: a wallet's first trade with a
/// non-zero `referrer` binds that referrer permanently, and
/// `referralShareBps` of each fee it pays goes to them in the same
/// transaction. Self-referral is ignored. A referrer that can't take native
/// USDC within REFERRAL_GAS has its share sent to `feeWallet` instead, so a
/// bound referrer can never make a trade revert.
///
/// The router holds nothing between transactions: every amount is measured
/// as a balance change during the call, and it only accepts native USDC
/// mid-trade. Events use ArcDexSwapRouter's signatures, with USDC as the
/// USDC ERC-20 (the same balance as native USDC on Arc) in its 6-decimal
/// units, so one indexer reads both routers.
contract ArcDexCurveRouter is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error InvalidFeeBps();
    error DeadlineExpired();
    error ZeroAmount();
    error UnknownToken(address token);
    error InsufficientOutput(uint256 received, uint256 minimum);
    error NativeTransferFailed();
    error UnexpectedNative();

    /// Same signature as ArcDexSwapRouter's. USDC amounts (and `fee`) are in
    /// the USDC ERC-20's 6-decimal units, rounded down.
    event Swapped(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address feeToken,
        uint256 fee
    );
    event FeeWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event FeeBpsUpdated(uint256 oldBps, uint256 newBps);
    event ReferrerBound(address indexed user, address indexed referrer);
    /// `amount` in the USDC ERC-20's 6-decimal units, rounded down.
    event ReferralPaid(address indexed referrer, address indexed user, address indexed token, uint256 amount);
    event ReferralShareUpdated(uint256 oldBps, uint256 newBps);

    uint256 public constant VERSION = 1;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 200; // hard cap: 2%
    uint256 public constant MAX_REFERRAL_SHARE_BPS = 5_000; // at most half of the fee
    /// Gas a referrer's payout may use (an account or a smart wallet takes far less).
    uint256 public constant REFERRAL_GAS = 30_000;
    /// Native USDC (18 decimals) per unit of the USDC ERC-20 (6 decimals).
    uint256 private constant NATIVE_PER_USDC_UNIT = 1e12;

    IMercuriFactory public immutable mercuriFactory;
    ISolonFactory public immutable solonFactory;
    /// The USDC ERC-20, named in events only; trades move native USDC.
    address public immutable usdc;

    address public feeWallet;
    uint256 public feeBps;
    /// Share of each fee paid to the trader's referrer, in bps of the fee.
    uint256 public referralShareBps;
    /// Permanent per-wallet referrer, set on that wallet's first referred trade.
    mapping(address => address) public referrerOf;

    constructor(address _mercuriFactory, address _solonFactory, address _usdc, address _feeWallet, address _owner)
        Ownable(_owner)
    {
        if (
            _mercuriFactory == address(0) || _solonFactory == address(0) || _usdc == address(0)
                || _feeWallet == address(0) || _owner == address(0)
        ) revert ZeroAddress();
        mercuriFactory = IMercuriFactory(_mercuriFactory);
        solonFactory = ISolonFactory(_solonFactory);
        usdc = _usdc;
        feeWallet = _feeWallet;
        feeBps = 200;
        referralShareBps = 1_500;
    }

    /// Only a curve pays the router, and only mid-trade: a buy's refund or a sale's proceeds.
    receive() external payable {
        if (!_reentrancyGuardEntered()) revert UnexpectedNative();
    }

    // ── Mercuri ───────────────────────────────────────────────────────

    /// @notice Buys `token` on its Mercuri curve with msg.value native USDC.
    /// @param minTokensOut minimum tokens the caller must receive.
    /// @param referrer bound to the caller on their first referred trade;
    /// ignored after that (pass address(0) when there is none).
    function buyMercuri(address token, uint256 minTokensOut, uint256 deadline, address referrer)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 tokensOut)
    {
        _checkTrade(deadline, msg.value);
        address curve = _mercuriCurve(token);
        _bindReferrer(referrer);

        (uint256 spend, uint256 maxFee) = _splitInput(msg.value);
        uint256 nativeBefore = address(this).balance;
        uint256 tokensBefore = IERC20(token).balanceOf(address(this));
        // Tokens and any refund come back to this router, its caller.
        IMercuriCurve(curve).buy{value: spend}(minTokensOut, feeWallet, deadline);
        uint256 bought = IERC20(token).balanceOf(address(this)) - tokensBefore;
        uint256 refund = address(this).balance + spend - nativeBefore;

        uint256 userBefore = IERC20(token).balanceOf(msg.sender);
        IERC20(token).safeTransfer(msg.sender, bought);
        tokensOut = IERC20(token).balanceOf(msg.sender) - userBefore;
        if (tokensOut < minTokensOut) revert InsufficientOutput(tokensOut, minTokensOut);

        _settleBuy(token, spend, maxFee, refund, tokensOut);
    }

    /// @notice Sells `tokensIn` of `token` (approved to this router) on its
    /// Mercuri curve; at least `minUsdcOut` native USDC, after every fee, to the caller.
    function sellMercuri(address token, uint256 tokensIn, uint256 minUsdcOut, uint256 deadline, address referrer)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 usdcOut)
    {
        _checkTrade(deadline, tokensIn);
        address curve = _mercuriCurve(token);
        _bindReferrer(referrer);

        uint256 amount = _pullTokens(token, tokensIn);
        uint256 nativeBefore = address(this).balance;
        IERC20(token).forceApprove(curve, amount);
        // The minimum is enforced below, on what the caller receives after ARCDEX's fee.
        IMercuriCurve(curve).sell(amount, 0, feeWallet, deadline);
        IERC20(token).forceApprove(curve, 0);

        usdcOut = _settleSell(token, amount, address(this).balance - nativeBefore, minUsdcOut);
    }

    // ── SolonPad ──────────────────────────────────────────────────────

    /// @notice Buys `token` on its SolonPad curve with msg.value native USDC.
    /// The tokens go straight to the caller. SolonPad has no deadline of its
    /// own; the router enforces `deadline`.
    function buySolon(address token, uint256 minTokensOut, uint256 deadline, address referrer)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 tokensOut)
    {
        _checkTrade(deadline, msg.value);
        address curve = _solonCurve(token);
        _bindReferrer(referrer);

        (uint256 spend, uint256 maxFee) = _splitInput(msg.value);
        uint256 nativeBefore = address(this).balance;
        uint256 userBefore = IERC20(token).balanceOf(msg.sender);
        // quoteIn must equal msg.value; a zero minimum is rejected by the curve.
        ISolonCurve(curve).buy{value: spend}(spend, minTokensOut == 0 ? 1 : minTokensOut, msg.sender);
        uint256 refund = address(this).balance + spend - nativeBefore;
        tokensOut = IERC20(token).balanceOf(msg.sender) - userBefore;
        if (tokensOut < minTokensOut) revert InsufficientOutput(tokensOut, minTokensOut);

        _settleBuy(token, spend, maxFee, refund, tokensOut);
    }

    /// @notice Sells `tokensIn` of `token` (approved to this router) on its
    /// SolonPad curve; at least `minUsdcOut` native USDC, after every fee, to the caller.
    function sellSolon(address token, uint256 tokensIn, uint256 minUsdcOut, uint256 deadline, address referrer)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 usdcOut)
    {
        _checkTrade(deadline, tokensIn);
        address curve = _solonCurve(token);
        _bindReferrer(referrer);

        uint256 amount = _pullTokens(token, tokensIn);
        uint256 nativeBefore = address(this).balance;
        IERC20(token).forceApprove(curve, amount);
        // Proceeds come here for the fee. A zero minimum is rejected by the
        // curve; the caller's is enforced below, after ARCDEX's fee.
        ISolonCurve(curve).sell(amount, 1, address(this));
        IERC20(token).forceApprove(curve, 0);

        usdcOut = _settleSell(token, amount, address(this).balance - nativeBefore, minUsdcOut);
    }

    // ── curves ────────────────────────────────────────────────────────

    /// The curve Mercuri's factory records for `token`, which must name `token` back.
    function _mercuriCurve(address token) internal view returns (address curve) {
        curve = mercuriFactory.curveOf(token);
        if (curve == address(0) || IMercuriCurve(curve).token() != token) revert UnknownToken(token);
    }

    /// The curve SolonPad's factory records for `token`, if it's quoted in native USDC.
    function _solonCurve(address token) internal view returns (address) {
        // The factory reverts for a token it didn't launch.
        try solonFactory.getLaunchedToken(token) returns (ISolonFactory.LaunchedToken memory t) {
            if (t.exists && t.token == token && t.curve != address(0) && t.pairToken == address(0)) return t.curve;
        } catch {}
        revert UnknownToken(token);
    }

    // ── shared ────────────────────────────────────────────────────────

    function _checkTrade(uint256 deadline, uint256 amount) internal view {
        if (deadline < block.timestamp) revert DeadlineExpired();
        if (amount == 0) revert ZeroAmount();
    }

    /// What goes to the curve, and the most the fee can be.
    function _splitInput(uint256 value) internal view returns (uint256 spend, uint256 maxFee) {
        maxFee = (value * feeBps) / BPS;
        spend = value - maxFee;
    }

    /// Pulls the tokens being sold, measuring what actually arrived.
    function _pullTokens(address token, uint256 amount) internal returns (uint256 received) {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
    }

    /// Charges the fee on the part of `spend` the curve used, and returns the
    /// curve's refund with the part of the fee it didn't cover. Anything the
    /// buy paid back beyond `spend` goes to the trader too, fee-free.
    function _settleBuy(address token, uint256 spend, uint256 maxFee, uint256 refund, uint256 tokensOut) internal {
        uint256 used = refund < spend ? spend - refund : 0;
        uint256 fee = (maxFee * used) / spend;
        if (fee > 0) _distributeFee(fee);
        uint256 back = refund + (maxFee - fee);
        if (back > 0) _sendNative(msg.sender, back);
        emit Swapped(msg.sender, usdc, token, _usdcUnits(used + fee), tokensOut, usdc, _usdcUnits(fee));
    }

    /// Takes the fee off a sale's proceeds and pays the rest to the caller.
    function _settleSell(address token, uint256 tokensIn, uint256 proceeds, uint256 minUsdcOut)
        internal
        returns (uint256 usdcOut)
    {
        uint256 fee = (proceeds * feeBps) / BPS;
        usdcOut = proceeds - fee;
        if (usdcOut < minUsdcOut) revert InsufficientOutput(usdcOut, minUsdcOut);
        if (fee > 0) _distributeFee(fee);
        _sendNative(msg.sender, usdcOut);
        emit Swapped(msg.sender, token, usdc, tokensIn, _usdcUnits(usdcOut), usdc, _usdcUnits(fee));
    }

    function _bindReferrer(address referrer) internal {
        if (referrer == address(0) || referrer == msg.sender || referrerOf[msg.sender] != address(0)) return;
        referrerOf[msg.sender] = referrer;
        emit ReferrerBound(msg.sender, referrer);
    }

    /// Splits a fee (native USDC) between the caller's referrer (if any) and feeWallet.
    function _distributeFee(uint256 fee) internal {
        address ref = referrerOf[msg.sender];
        uint256 cut;
        if (ref != address(0) && referralShareBps > 0) {
            cut = (fee * referralShareBps) / BPS;
            if (cut > 0) {
                if (_trySendNative(ref, cut, REFERRAL_GAS)) emit ReferralPaid(ref, msg.sender, usdc, _usdcUnits(cut));
                else cut = 0; // the referrer can't take it: the whole fee goes to feeWallet
            }
        }
        _sendNative(feeWallet, fee - cut);
    }

    function _sendNative(address to, uint256 amount) internal {
        if (!_trySendNative(to, amount, gasleft())) revert NativeTransferFailed();
    }

    /// A native transfer that reports failure instead of reverting, and
    /// never copies return data (a recipient can't make the caller pay for it).
    function _trySendNative(address to, uint256 amount, uint256 gasLimit) internal returns (bool ok) {
        assembly ("memory-safe") {
            ok := call(gasLimit, to, amount, 0, 0, 0, 0)
        }
    }

    function _usdcUnits(uint256 native) internal pure returns (uint256) {
        return native / NATIVE_PER_USDC_UNIT;
    }

    // ── admin ─────────────────────────────────────────────────────────

    /// @notice Must be able to receive native USDC: every trade pays it.
    function setFeeWallet(address newFeeWallet) external onlyOwner {
        if (newFeeWallet == address(0)) revert ZeroAddress();
        emit FeeWalletUpdated(feeWallet, newFeeWallet);
        feeWallet = newFeeWallet;
    }

    /// @notice Can only lower or restore the fee — never above 2%.
    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFeeBps();
        emit FeeBpsUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    /// @notice Referrers' share of the fee, at most half of it.
    function setReferralShareBps(uint256 newShareBps) external onlyOwner {
        if (newShareBps > MAX_REFERRAL_SHARE_BPS) revert InvalidFeeBps();
        emit ReferralShareUpdated(referralShareBps, newShareBps);
        referralShareBps = newShareBps;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recovers tokens sent to the router by mistake. The router
    /// holds nothing between transactions, and nonReentrant stops this from
    /// running mid-trade.
    function rescueTokens(address token, uint256 amount) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(owner(), amount);
    }

    /// @notice Recovers native USDC forced into the router (it refuses plain transfers).
    function rescueNative(uint256 amount) external onlyOwner nonReentrant {
        _sendNative(owner(), amount);
    }
}
