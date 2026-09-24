// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// Uniswap v4 types, declared locally so this contract has no dependency on
/// v4-core. Layouts match v4-core exactly (the PoolKey struct hashes to the
/// on-chain PoolId, and BalanceDelta is amount0 in the high 128 bits,
/// amount1 in the low 128 bits).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // negative = exact input
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

/// SwapRouter02 (IV3SwapRouter) — no deadline in the struct. Arc's deployed
/// router at 0x53BF…6F77 exposes this selector (0x04e45aaf), not SwapRouter
/// v1's deadline variant.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title ArcDexSwapRouter (v2)
/// @notice Routes swaps on Arc through Uniswap v4 (including Argus launch
/// pools and their hooks, multi-hop via flash accounting) and Uniswap v3
/// (legacy Argus pools), charging a platform fee hard-capped at 2%.
///
/// The fee is always taken in USDC when USDC is on either side of the swap:
/// from the input on a buy, from the output on a sell. On a swap with no
/// USDC leg it comes off the output token.
///
/// Referrals: the first swap a wallet makes with a non-zero `referrer`
/// binds that referrer to the wallet permanently. From then on
/// `referralShareBps` of every fee that wallet pays goes straight to the
/// referrer, the rest to `feeWallet` — both in the same transaction, no
/// accrual. Self-referral is ignored. A referral transfer that fails (e.g.
/// the referrer is blacklisted by the token) falls back to `feeWallet`, so
/// a bound referrer can never make a user's swaps revert.
///
/// v2 changes from v1 (0xC519…6088): fee cap 1% -> 2% (default 2%),
/// referrals, a `referrer` parameter on both swap functions, VERSION.
contract ArcDexSwapRouter is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error InvalidFeeBps();
    error DeadlineExpired();
    error InvalidPath();
    error InsufficientOutput(uint256 received, uint256 minimum);
    error NotPoolManager();
    error ZeroAmount();

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
    event ReferralPaid(address indexed referrer, address indexed user, address indexed token, uint256 amount);
    event ReferralShareUpdated(uint256 oldBps, uint256 newBps);

    uint256 public constant VERSION = 2;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_FEE_BPS = 200; // hard cap: 2%
    uint256 public constant MAX_REFERRAL_SHARE_BPS = 5_000; // at most half of the fee
    uint256 public constant MAX_HOPS = 3;

    IPoolManager public immutable poolManager;
    ISwapRouter02 public immutable swapRouter02;
    address public immutable usdc;

    address public feeWallet;
    uint256 public feeBps;
    /// Share of each fee paid to the trader's referrer, in bps of the fee.
    uint256 public referralShareBps;
    /// Permanent per-wallet referrer, set on that wallet's first referred swap.
    mapping(address => address) public referrerOf;

    constructor(address _poolManager, address _swapRouter02, address _usdc, address _feeWallet, address _owner)
        Ownable(_owner)
    {
        if (
            _poolManager == address(0) || _swapRouter02 == address(0) || _usdc == address(0)
                || _feeWallet == address(0) || _owner == address(0)
        ) revert ZeroAddress();
        poolManager = IPoolManager(_poolManager);
        swapRouter02 = ISwapRouter02(_swapRouter02);
        usdc = _usdc;
        feeWallet = _feeWallet;
        feeBps = 200;
        referralShareBps = 1_500;
    }

    // ── v4 ────────────────────────────────────────────────────────────

    /// @notice Exact-input swap across 1-3 Uniswap v4 pools, e.g.
    /// USDC → ARGUS → token for an Argus launch quoted in ARGUS.
    /// @param keys pools in hop order; the direction of each hop is derived
    /// from which side of the key matches the running currency.
    /// @param referrer bound to the caller on their first referred swap;
    /// ignored after that (pass address(0) when there is none).
    function swapExactInV4(
        PoolKey[] calldata keys,
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline,
        address referrer
    ) external whenNotPaused nonReentrant returns (uint256 amountOut) {
        if (deadline < block.timestamp) revert DeadlineExpired();
        if (amountIn == 0) revert ZeroAmount();
        if (keys.length == 0 || keys.length > MAX_HOPS) revert InvalidPath();
        _bindReferrer(referrer);

        bool[] memory zeroForOne = new bool[](keys.length);
        address cur = tokenIn;
        for (uint256 i = 0; i < keys.length; i++) {
            if (cur == keys[i].currency0) {
                zeroForOne[i] = true;
                cur = keys[i].currency1;
            } else if (cur == keys[i].currency1) {
                zeroForOne[i] = false;
                cur = keys[i].currency0;
            } else {
                revert InvalidPath();
            }
            // Native currency (address(0)) isn't supported — every Argus
            // pool quotes the USDC ERC-20, never native gas.
            if (keys[i].currency0 == address(0)) revert InvalidPath();
        }
        address tokenOut = cur;
        if (tokenOut == tokenIn) revert InvalidPath();

        (uint256 swapIn, uint256 inputFee) = _pullAndTakeInputFee(tokenIn, amountIn);

        bytes memory result = poolManager.unlock(abi.encode(keys, zeroForOne, tokenIn, tokenOut, swapIn));
        (uint256 grossOut, uint256 inputUsed) = abi.decode(result, (uint256, uint256));

        // A partial fill (price limit reached) leaves unspent input here —
        // hand it back rather than strand it in the router.
        if (inputUsed < swapIn) IERC20(tokenIn).safeTransfer(msg.sender, swapIn - inputUsed);

        amountOut = _payOut(tokenIn, tokenOut, grossOut, amountIn, inputFee, minAmountOut);
    }

    /// @dev PoolManager calls this back inside our own `unlock`. Only
    /// PoolManager can reach it, and PoolManager only calls back the address
    /// that called `unlock` — i.e. this contract, mid-swapExactInV4.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        (PoolKey[] memory keys, bool[] memory zeroForOne, address tokenIn, address tokenOut, uint256 swapIn) =
            abi.decode(data, (PoolKey[], bool[], address, address, uint256));

        uint256 hopIn = swapIn;
        uint256 inputOwed;
        uint256 finalOut;
        for (uint256 i = 0; i < keys.length; i++) {
            bool z = zeroForOne[i];
            int256 delta = poolManager.swap(
                keys[i],
                SwapParams({
                    zeroForOne: z,
                    amountSpecified: -int256(hopIn),
                    sqrtPriceLimitX96: z ? 4295128740 : 1461446703485210103287273052203988822378723970341
                }),
                ""
            );
            int128 d0 = int128(delta >> 128);
            int128 d1 = int128(delta);
            int128 dIn = z ? d0 : d1;
            int128 dOut = z ? d1 : d0;

            // Exact input: we owe the pool on the input side, it owes us on
            // the output side. Hooks can move these (tax), which is why we
            // read what PoolManager actually returned rather than assume.
            if (i == 0) inputOwed = uint256(uint128(-dIn));
            else if (uint256(uint128(-dIn)) != hopIn) revert InvalidPath(); // intermediate hop must net to zero
            hopIn = uint256(uint128(dOut));
            finalOut = hopIn;
        }

        // Pay the input, collect the output — intermediate currencies net
        // to zero inside PoolManager's flash accounting and never move.
        poolManager.sync(tokenIn);
        IERC20(tokenIn).safeTransfer(address(poolManager), inputOwed);
        poolManager.settle();
        poolManager.take(tokenOut, address(this), finalOut);

        return abi.encode(finalOut, inputOwed);
    }

    // ── v3 ────────────────────────────────────────────────────────────

    /// @notice Exact-input single-pool swap through Uniswap v3 (legacy Argus
    /// pools, Portals 1-2).
    function swapExactInV3(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline,
        address referrer
    ) external whenNotPaused nonReentrant returns (uint256 amountOut) {
        if (deadline < block.timestamp) revert DeadlineExpired();
        if (amountIn == 0) revert ZeroAmount();
        if (tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut) revert InvalidPath();
        _bindReferrer(referrer);

        (uint256 swapIn, uint256 inputFee) = _pullAndTakeInputFee(tokenIn, amountIn);

        IERC20(tokenIn).forceApprove(address(swapRouter02), swapIn);
        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));
        swapRouter02.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: address(this),
                amountIn: swapIn,
                amountOutMinimum: 0, // enforced below on what the user actually receives
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(address(swapRouter02), 0);
        uint256 grossOut = IERC20(tokenOut).balanceOf(address(this)) - balBefore;

        amountOut = _payOut(tokenIn, tokenOut, grossOut, amountIn, inputFee, minAmountOut);
    }

    // ── shared ────────────────────────────────────────────────────────

    /// Pulls `amountIn` and, when the input is USDC, sends the fee to
    /// feeWallet immediately. Measures what actually arrived, so an input
    /// token with a transfer tax can't make us overspend.
    function _pullAndTakeInputFee(address tokenIn, uint256 amountIn)
        internal
        returns (uint256 swapIn, uint256 inputFee)
    {
        uint256 before = IERC20(tokenIn).balanceOf(address(this));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 received = IERC20(tokenIn).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        if (tokenIn == usdc && feeBps > 0) {
            inputFee = (received * feeBps) / BPS;
            if (inputFee > 0) _distributeFee(tokenIn, inputFee);
        }
        swapIn = received - inputFee;
    }

    /// Takes the fee off the output when it wasn't taken off the input,
    /// forwards the rest, and enforces the minimum on what the user's
    /// balance actually gained (not what we sent — a taxed output token
    /// would otherwise let a too-small fill slip past the check).
    function _payOut(
        address tokenIn,
        address tokenOut,
        uint256 grossOut,
        uint256 amountIn,
        uint256 inputFee,
        uint256 minAmountOut
    ) internal returns (uint256 amountOut) {
        uint256 outputFee;
        if (inputFee == 0 && tokenIn != usdc && feeBps > 0) {
            outputFee = (grossOut * feeBps) / BPS;
            if (outputFee > 0) _distributeFee(tokenOut, outputFee);
        }

        uint256 userBefore = IERC20(tokenOut).balanceOf(msg.sender);
        IERC20(tokenOut).safeTransfer(msg.sender, grossOut - outputFee);
        amountOut = IERC20(tokenOut).balanceOf(msg.sender) - userBefore;
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);

        emit Swapped(
            msg.sender,
            tokenIn,
            tokenOut,
            amountIn,
            amountOut,
            inputFee > 0 ? tokenIn : tokenOut,
            inputFee > 0 ? inputFee : outputFee
        );
    }

    function _bindReferrer(address referrer) internal {
        if (referrer == address(0) || referrer == msg.sender || referrerOf[msg.sender] != address(0)) return;
        referrerOf[msg.sender] = referrer;
        emit ReferrerBound(msg.sender, referrer);
    }

    /// Splits a fee between the caller's referrer (if any) and feeWallet.
    function _distributeFee(address token, uint256 fee) internal {
        address ref = referrerOf[msg.sender];
        uint256 cut;
        if (ref != address(0) && referralShareBps > 0) {
            cut = (fee * referralShareBps) / BPS;
            if (cut > 0) {
                if (_tryTransfer(token, ref, cut)) emit ReferralPaid(ref, msg.sender, token, cut);
                else cut = 0; // referrer can't receive — the whole fee goes to feeWallet
            }
        }
        IERC20(token).safeTransfer(feeWallet, fee - cut);
    }

    /// ERC-20 transfer that reports failure instead of reverting.
    function _tryTransfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (ret.length == 0 ? token.code.length > 0 : abi.decode(ret, (bool)));
    }

    // ── admin ─────────────────────────────────────────────────────────

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
    /// holds no balance between transactions, and nonReentrant stops this
    /// from running mid-swap.
    function rescueTokens(address token, uint256 amount) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(owner(), amount);
    }
}
