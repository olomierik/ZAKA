// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

contract ArcDexRouter is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error InvalidFeeBps();
    error SlippageTooHigh();
    error DeadlineExpired();
    error TransferFailed();

    event Swap(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );
    event FeeWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event FeeBpsUpdated(uint256 oldBps, uint256 newBps);

    /// @notice Uniswap V3 SwapRouter02 on Arc mainnet (chain 5042), verified live 2026-09
    address public immutable SWAP_ROUTER02;
    address public constant USDC = 0x3600000000000000000000000000000000000000;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Fee is capped at 100 bps (1%) — owner can only lower it, never raise above 1%
    uint256 public constant MAX_FEE_BPS = 100;

    address public feeWallet;
    uint256 public feeBps;

    constructor(address _swapRouter, address _feeWallet, address _owner) Ownable(_owner) {
        if (_swapRouter == address(0) || _feeWallet == address(0) || _owner == address(0)) revert ZeroAddress();

        SWAP_ROUTER02 = _swapRouter;
        feeWallet = _feeWallet;
        feeBps = 100; // 1%
    }

    function swapExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint160 sqrtPriceLimitX96,
        uint256 deadline
    ) external whenNotPaused nonReentrant returns (uint256 amountOut) {
        if (tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (deadline < block.timestamp) revert DeadlineExpired();

        (uint256 feeAmount, uint256 amountToSwap) = _collectFeeAndPrepareSwap(tokenIn, amountIn);

        ISwapRouter02.ExactInputSingleParams memory params = ISwapRouter02.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: msg.sender,
            deadline: deadline,
            amountIn: amountToSwap,
            amountOutMinimum: amountOutMinimum,
            sqrtPriceLimitX96: sqrtPriceLimitX96
        });

        amountOut = ISwapRouter02(SWAP_ROUTER02).exactInputSingle(params);

        if (amountOut < amountOutMinimum) revert SlippageTooHigh();

        IERC20(tokenIn).forceApprove(SWAP_ROUTER02, 0);

        emit Swap(msg.sender, tokenIn, tokenOut, amountIn, amountOut, feeAmount);
    }

    function swapExactInputMultihop(
        bytes calldata path,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external whenNotPaused nonReentrant returns (uint256 amountOut) {
        if (tokenIn == address(0)) revert ZeroAddress();
        if (deadline < block.timestamp) revert DeadlineExpired();

        (uint256 feeAmount, uint256 amountToSwap) = _collectFeeAndPrepareSwap(tokenIn, amountIn);

        ISwapRouter02.ExactInputParams memory params = ISwapRouter02.ExactInputParams({
            path: path,
            recipient: msg.sender,
            deadline: deadline,
            amountIn: amountToSwap,
            amountOutMinimum: amountOutMinimum
        });

        amountOut = ISwapRouter02(SWAP_ROUTER02).exactInput(params);

        if (amountOut < amountOutMinimum) revert SlippageTooHigh();

        IERC20(tokenIn).forceApprove(SWAP_ROUTER02, 0);

        emit Swap(msg.sender, tokenIn, _lastTokenInPath(path), amountIn, amountOut, feeAmount);
    }

    function setFeeWallet(address newFeeWallet) external onlyOwner {
        if (newFeeWallet == address(0)) revert ZeroAddress();

        address oldWallet = feeWallet;
        feeWallet = newFeeWallet;

        emit FeeWalletUpdated(oldWallet, newFeeWallet);
    }

    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFeeBps();

        uint256 oldFeeBps = feeBps;
        feeBps = newFeeBps;

        emit FeeBpsUpdated(oldFeeBps, newFeeBps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(owner(), amount);
    }

    function _collectFeeAndPrepareSwap(address tokenIn, uint256 amountIn)
        internal
        returns (uint256 feeAmount, uint256 amountToSwap)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        feeAmount = (amountIn * feeBps) / BPS_DENOMINATOR;
        amountToSwap = amountIn - feeAmount;

        if (feeAmount > 0) {
            IERC20(tokenIn).safeTransfer(feeWallet, feeAmount);
        }

        IERC20(tokenIn).forceApprove(SWAP_ROUTER02, 0);
        IERC20(tokenIn).forceApprove(SWAP_ROUTER02, amountToSwap);
    }

    function _lastTokenInPath(bytes calldata path) internal pure returns (address tokenOut) {
        if (path.length < 20) revert TransferFailed();

        uint256 start = path.length - 20;
        bytes20 tokenBytes;
        assembly ("memory-safe") {
            tokenBytes := calldataload(add(path.offset, start))
        }
        tokenOut = address(tokenBytes);

        if (tokenOut == address(0)) revert ZeroAddress();
    }
}
