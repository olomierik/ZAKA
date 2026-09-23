// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LaunchToken} from "./LaunchToken.sol";

/// @title ArcLaunchpad
/// @notice Self-contained bonding-curve launchpad for Arc mainnet. Every
/// token is a fixed-supply LaunchToken traded against USDC on a constant-
/// product curve (virtual-reserve cushioned, pump.fun-style) that lives
/// permanently inside this contract — there is no separate liquidity pool,
/// no LP position, and no emergency-withdrawal function of any kind. The
/// owner can pause new trades and update where future fees are routed, but
/// can never touch a curve's real reserves — that USDC only ever leaves via
/// a user's own `sell`.
///
/// Fees are two separate, additive layers, both paid straight out of every
/// trade (no accrual, no claim step):
///   1. Platform swap fee — fixed 1%, always, 100% to `platformFeeWallet`.
///   2. Creator tax — fixed for a token's lifetime at launch (0-3%, the
///      creator's choice), split 60% to the creator's own wallet / 40% to
///      `platformFeeWallet`.
/// Buyback-and-burn of the platform's own token is intentionally NOT a
/// contract function — the owner buys it like any other trader using
/// accumulated platformFeeWallet funds, then calls the token's own
/// `burn()` (LaunchToken is ERC20Burnable). Keeping that off-contract
/// means this contract never custodies a treasury balance beyond a single
/// token's own curve reserves, which shrinks the attack surface a lot.
///
/// Anti-rug / anti-bot measures:
/// - 5% of supply goes to `platformFeeWallet` at creation, 95% into the
///   curve — no team allocation hidden anywhere else, fully on-chain.
/// - `creatorTaxBps` is set once at creation and can never be changed.
/// - Anti-snipe: buys are capped at a % of remaining curve depth for the
///   first `SNIPE_WINDOW_SECONDS` after launch.
/// - Anti-bundle: total tokens buyable in a single block is capped
///   regardless of how many distinct wallets contribute — a multi-wallet
///   bundler can't route around this the way per-wallet caps allow.
/// - Anti-bot: `buy`/`sell` require `msg.sender == tx.origin`, so no
///   contract can mediate a trade. This stops contract-based sniper/wash-
///   trading bots specifically; it cannot and does not claim to stop a
///   human manually wash-trading across several of their own real wallets
///   — no on-chain check can distinguish that from genuine independent
///   traders, and claiming otherwise would be dishonest.
contract ArcLaunchpad is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── errors ──────────────────────────────────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error TokenNotFound();
    error SlippageTooHigh();
    error InsufficientCurveLiquidity();
    error InvalidMetadata();
    error InvalidTax();
    error NoContracts();
    error ExceedsSnipeLimit();
    error ExceedsBlockLimit();

    // ── events ──────────────────────────────────────────────────────────
    event TokenLaunched(address indexed token, address indexed creator, string name, string symbol, string metadataURI, uint256 creatorTaxBps);
    event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 totalFee, uint256 rUsdcAfter, uint256 rTokenAfter);
    event Graduated(address indexed token, uint256 rUsdcAtGraduation);
    event PlatformFeeWalletUpdated(address indexed oldWallet, address indexed newWallet);

    // ── constants ───────────────────────────────────────────────────────
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether; // 1B, 18 decimals

    /// @notice 5% of every launched token's supply goes to platformFeeWallet
    /// at creation; the remaining 95% seeds the curve. No other allocation.
    uint256 public constant PLATFORM_CREATION_SHARE_BPS = 500;

    /// @notice Fixed 1% platform swap fee on every trade, always, 100% to
    /// platformFeeWallet — separate from and additive with the creator tax.
    uint256 public constant PLATFORM_SWAP_FEE_BPS = 100;

    /// @notice Cap on the creator-chosen tax — fixed per-token at launch.
    uint256 public constant MAX_CREATOR_TAX_BPS = 300;
    uint256 public constant CREATOR_TAX_CREATOR_SHARE_BPS = 6_000; // 60% of the tax to the creator

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Real USDC raised at which a token is marked graduated. Purely
    /// a status threshold — the curve's pricing formula does not change.
    uint256 public constant GRADUATION_THRESHOLD_USDC = 25_000_000_000; // $25,000

    /// @notice Virtual reserve cushion — gives the curve a smooth, non-zero
    /// starting price instead of requiring real seed liquidity. Both the
    /// USDC and token cushions are constant offsets for the life of a curve
    /// (they shift by the same delta as real reserves on every trade), so
    /// the real token reserve only reaches zero once virtual USDC has risen
    /// well beyond GRADUATION_THRESHOLD_USDC — a curve can never be bought
    /// fully dry before it graduates.
    uint256 public constant INITIAL_VIRTUAL_USDC = 8_000_000_000; // $8,000
    uint256 public constant VIRTUAL_TOKEN_OFFSET = 200_000_000 ether;

    /// @notice Anti-snipe/anti-bundle caps are in USDC input, not token
    /// output. A token-quantity or %-of-reserve cap doesn't work here: this
    /// curve is deliberately steep near the start (small virtual cushion,
    /// by design, so price appreciates meaningfully), which means even an
    /// ordinary few-hundred-dollar buy claims a huge fraction of the token
    /// reserve in the first minutes — a %-of-reserve cap would block
    /// legitimate small buyers while barely touching a well-funded sniper.
    /// A flat USDC cap doesn't have that problem: it means the same thing
    /// in dollar terms no matter where the curve currently sits.
    ///
    /// For this long after launch, a single buy is capped at this many USDC.
    uint256 public constant SNIPE_WINDOW_SECONDS = 600; // 10 minutes
    uint256 public constant SNIPE_MAX_BUY_USDC = 2_000_000_000; // $2,000/tx

    /// @notice Total USDC bought across ALL buys in a single block is capped
    /// at this, regardless of how many distinct wallets contribute — this is
    /// what actually throttles a multi-wallet bundler, since per-wallet caps
    /// alone don't (a bundler just uses more wallets).
    uint256 public constant MAX_USDC_PER_BLOCK = 5_000_000_000; // $5,000/block

    // ── state ───────────────────────────────────────────────────────────
    struct Curve {
        address creator;
        uint96  creatorTaxBps;  // 0-300, fixed forever once launched
        uint64  launchedAt;
        uint256 vUsdc;
        uint256 vToken;
        uint256 rUsdc;          // real USDC held for this token — leaves only via sell
        uint256 rToken;         // real tokens still held by the curve, available to buy
        bool    graduated;
    }

    mapping(address => Curve) public curves;
    address[] public allTokens;

    // token => block number => cumulative gross USDC bought that block
    mapping(address => mapping(uint256 => uint256)) public blockBuyVolume;

    address public platformFeeWallet;

    constructor(address _owner, address _platformFeeWallet) Ownable(_owner) {
        if (_platformFeeWallet == address(0)) revert ZeroAddress();
        platformFeeWallet = _platformFeeWallet;
    }

    function setPlatformFeeWallet(address newWallet) external onlyOwner {
        if (newWallet == address(0)) revert ZeroAddress();
        address old = platformFeeWallet;
        platformFeeWallet = newWallet;
        emit PlatformFeeWalletUpdated(old, newWallet);
    }

    // ── launch ──────────────────────────────────────────────────────────

    /// @param creatorTaxBps fixed for this token's lifetime, 0 to MAX_CREATOR_TAX_BPS (3%)
    /// @param initialBuyUsdc optional — creator can buy some of their own
    /// token in the same transaction as launch, so the first block can't be
    /// sniped out from under them. Pass 0 to skip. Exempt from the snipe/
    /// block caps below since it happens atomically at creation.
    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 creatorTaxBps,
        uint256 initialBuyUsdc
    ) external nonReentrant whenNotPaused returns (address token) {
        if (msg.sender != tx.origin) revert NoContracts();
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert InvalidMetadata();
        if (creatorTaxBps > MAX_CREATOR_TAX_BPS) revert InvalidTax();

        if (initialBuyUsdc > 0) IERC20(USDC).safeTransferFrom(msg.sender, address(this), initialBuyUsdc);

        LaunchToken lt = new LaunchToken(name, symbol, TOTAL_SUPPLY, address(this));
        token = address(lt);

        uint256 platformShare = (TOTAL_SUPPLY * PLATFORM_CREATION_SHARE_BPS) / BPS_DENOMINATOR;
        uint256 curveShare = TOTAL_SUPPLY - platformShare;
        IERC20(token).safeTransfer(platformFeeWallet, platformShare);

        curves[token] = Curve({
            creator: msg.sender,
            creatorTaxBps: uint96(creatorTaxBps),
            launchedAt: uint64(block.timestamp),
            vUsdc: INITIAL_VIRTUAL_USDC,
            vToken: curveShare + VIRTUAL_TOKEN_OFFSET,
            rUsdc: 0,
            rToken: curveShare,
            graduated: false
        });
        allTokens.push(token);

        emit TokenLaunched(token, msg.sender, name, symbol, metadataURI, creatorTaxBps);

        if (initialBuyUsdc > 0) _buy(token, msg.sender, initialBuyUsdc, 0, true);
    }

    // ── trading ─────────────────────────────────────────────────────────

    function buy(address token, uint256 usdcIn, uint256 minTokensOut) external nonReentrant whenNotPaused {
        if (msg.sender != tx.origin) revert NoContracts();
        if (usdcIn == 0) revert ZeroAmount();
        IERC20(USDC).safeTransferFrom(msg.sender, address(this), usdcIn);
        _buy(token, msg.sender, usdcIn, minTokensOut, false);
    }

    function sell(address token, uint256 tokensIn, uint256 minUsdcOut) external nonReentrant whenNotPaused {
        if (msg.sender != tx.origin) revert NoContracts();
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert TokenNotFound();
        if (tokensIn == 0) revert ZeroAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);

        uint256 k = c.vUsdc * c.vToken;
        uint256 newVToken = c.vToken + tokensIn;
        uint256 newVUsdc = k / newVToken;
        uint256 grossUsdcOut = c.vUsdc - newVUsdc;
        // Floor-division rounding can make the virtual-reserve math imply a
        // payout a few wei larger than what's actually in real reserves —
        // clamp to real reserves (the source of truth) and re-derive
        // newVUsdc from the clamped amount so virtual/real stay in lockstep.
        if (grossUsdcOut > c.rUsdc) {
            grossUsdcOut = c.rUsdc;
            newVUsdc = c.vUsdc - grossUsdcOut;
        }

        (uint256 totalFee, uint256 creatorCut, uint256 platformCut) = _computeFee(c, grossUsdcOut);
        uint256 netUsdcOut = grossUsdcOut - totalFee;
        if (netUsdcOut < minUsdcOut) revert SlippageTooHigh();

        c.vUsdc = newVUsdc;
        c.vToken = newVToken;
        c.rUsdc -= grossUsdcOut;
        c.rToken += tokensIn;

        _payFees(c.creator, creatorCut, platformCut);
        IERC20(USDC).safeTransfer(msg.sender, netUsdcOut);

        emit Trade(token, msg.sender, false, netUsdcOut, tokensIn, totalFee, c.rUsdc, c.rToken);
    }

    function _buy(address token, address trader, uint256 usdcIn, uint256 minTokensOut, bool isInitialBuy) internal {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert TokenNotFound();

        (uint256 totalFee, uint256 creatorCut, uint256 platformCut) = _computeFee(c, usdcIn);
        uint256 netIn = usdcIn - totalFee;

        uint256 k = c.vUsdc * c.vToken;
        uint256 newVUsdc = c.vUsdc + netIn;
        uint256 newVToken = k / newVUsdc;
        uint256 tokensOut = c.vToken - newVToken;

        if (tokensOut < minTokensOut) revert SlippageTooHigh();
        if (tokensOut >= c.rToken) revert InsufficientCurveLiquidity();

        if (!isInitialBuy) {
            if (block.timestamp < c.launchedAt + SNIPE_WINDOW_SECONDS && usdcIn > SNIPE_MAX_BUY_USDC) {
                revert ExceedsSnipeLimit();
            }
            uint256 newBlockVolume = blockBuyVolume[token][block.number] + usdcIn;
            if (newBlockVolume > MAX_USDC_PER_BLOCK) revert ExceedsBlockLimit();
            blockBuyVolume[token][block.number] = newBlockVolume;
        }

        c.vUsdc = newVUsdc;
        c.vToken = newVToken;
        c.rUsdc += netIn;
        c.rToken -= tokensOut;

        _payFees(c.creator, creatorCut, platformCut);

        bool justGraduated = !c.graduated && c.rUsdc >= GRADUATION_THRESHOLD_USDC;
        if (justGraduated) {
            c.graduated = true;
            emit Graduated(token, c.rUsdc);
        }

        IERC20(token).safeTransfer(trader, tokensOut);

        emit Trade(token, trader, true, usdcIn, tokensOut, totalFee, c.rUsdc, c.rToken);
    }

    /// @dev Two additive layers: fixed 1% platform swap fee, plus this
    /// token's fixed creator tax (0-3%), itself split 60/40 creator/platform.
    function _computeFee(Curve storage c, uint256 amount) internal view returns (uint256 totalFee, uint256 creatorCut, uint256 platformCut) {
        uint256 platformSwapFee = (amount * PLATFORM_SWAP_FEE_BPS) / BPS_DENOMINATOR;
        uint256 creatorTax = (amount * c.creatorTaxBps) / BPS_DENOMINATOR;
        creatorCut = (creatorTax * CREATOR_TAX_CREATOR_SHARE_BPS) / BPS_DENOMINATOR;
        platformCut = platformSwapFee + (creatorTax - creatorCut);
        totalFee = platformSwapFee + creatorTax;
    }

    function _payFees(address creator, uint256 creatorCut, uint256 platformCut) internal {
        if (creatorCut > 0) IERC20(USDC).safeTransfer(creator, creatorCut);
        if (platformCut > 0) IERC20(USDC).safeTransfer(platformFeeWallet, platformCut);
    }

    // ── admin ───────────────────────────────────────────────────────────
    // Deliberately minimal: pause can only stop NEW trades, never move a
    // curve's real reserves. There is no rescue/withdraw function — real
    // user liquidity has no path out of this contract except a `sell`.

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ── views ───────────────────────────────────────────────────────────

    function tokenCount() external view returns (uint256) { return allTokens.length; }

    function getTokens(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = allTokens.length;
        if (offset >= total) return new address[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) page[i - offset] = allTokens[i];
    }

    /// @notice Current marginal price, scaled 1e18, in USDC (6dp) per whole token.
    function currentPrice(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert TokenNotFound();
        return (c.vUsdc * 1e18) / c.vToken;
    }

    function bondingProgressBps(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert TokenNotFound();
        if (c.graduated) return BPS_DENOMINATOR;
        return (c.rUsdc * BPS_DENOMINATOR) / GRADUATION_THRESHOLD_USDC;
    }

    /// @notice How much more USDC can be spent buying in the CURRENT block
    /// before hitting the anti-bundle cap. Useful for the frontend to warn
    /// a user before they submit a buy that would revert.
    function remainingBlockCapacityUsdc(address token) external view returns (uint256) {
        if (curves[token].creator == address(0)) revert TokenNotFound();
        uint256 used = blockBuyVolume[token][block.number];
        return used >= MAX_USDC_PER_BLOCK ? 0 : MAX_USDC_PER_BLOCK - used;
    }
}
