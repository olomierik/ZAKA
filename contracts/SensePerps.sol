// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// One signer's RedStone data package for one feed.
struct SignedPrice {
    bytes32 feedId; // the symbol, left-aligned ("BTC")
    uint256 value; // 8 decimals
    uint64 timestampMs;
    bytes signature; // r ‖ s ‖ v, v = 27 or 28
}

/// @title ARCSENSE price oracle: RedStone's signed prices, checked on-chain
/// @notice RedStone's "redstone-primary-prod" service publishes a data package per feed every 10
/// seconds from each of several independent signers. A price is accepted when `threshold` distinct
/// authorised signers signed it with one timestamp; their median is the price. The signed message
/// is RedStone's data-package format with one data point:
/// keccak256(feedId ‖ value (32 bytes) ‖ timestamp (6 bytes, ms) ‖ 32 (4 bytes) ‖ 1 (3 bytes)).
/// The owner can change the signers only after SIGNER_DELAY, so users have time to leave first.
contract SenseOracle is Ownable2Step {
    uint256 public constant SIGNER_DELAY = 2 days;
    uint256 internal constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address[] internal _signers;
    uint8 public threshold;
    address[] public pendingSignerList;
    uint8 public pendingThreshold;
    uint256 public signersReadyAt; // 0 = no change pending

    event SignersProposed(address[] signers, uint8 threshold, uint256 readyAt);
    event SignersSet(address[] signers, uint8 threshold);

    error BadParams();
    error TooEarly();
    error NoPrices();
    error MixedTimestamps();
    error ZeroPrice();
    error BadSignature();
    error SignerNotAuthorised(address signer);
    error DuplicateSigner(address signer);
    error NotEnoughSigners(bytes32 feedId, uint256 got);

    constructor(address owner_, address[] memory signers_, uint8 threshold_) Ownable(owner_) {
        _setSigners(signers_, threshold_);
    }

    /// Checks the signed packages and returns the median price of each feed in `feeds`, and their
    /// common timestamp (ms). Every package must carry the same timestamp; packages for other
    /// feeds are ignored; each feed needs `threshold` distinct authorised signers.
    function verify(SignedPrice[] calldata pkgs, bytes32[] calldata feeds)
        external
        view
        returns (uint256[] memory values, uint256 ts)
    {
        uint256 nf = feeds.length;
        values = new uint256[](nf);
        if (nf == 0) return (values, 0);
        if (pkgs.length == 0) revert NoPrices();
        ts = pkgs[0].timestampMs;
        if (ts == 0) revert NoPrices();
        uint256 ns = _signers.length;
        uint256[] memory seen = new uint256[](nf);
        uint256[] memory counts = new uint256[](nf);
        uint256[][] memory got = new uint256[][](nf);
        for (uint256 f; f < nf; ++f) {
            got[f] = new uint256[](ns);
        }
        for (uint256 i; i < pkgs.length; ++i) {
            SignedPrice calldata p = pkgs[i];
            if (p.timestampMs != ts) revert MixedTimestamps();
            bool wanted;
            for (uint256 j; j < nf; ++j) {
                if (feeds[j] == p.feedId) {
                    wanted = true;
                    break;
                }
            }
            if (!wanted) continue;
            if (p.value == 0) revert ZeroPrice();
            address signer = _recover(p);
            uint256 bit = 1 << _signerIndex(signer);
            // Two markets may share a feed: the package counts for each of them.
            for (uint256 f; f < nf; ++f) {
                if (feeds[f] != p.feedId) continue;
                if (seen[f] & bit != 0) revert DuplicateSigner(signer);
                seen[f] |= bit;
                got[f][counts[f]++] = p.value;
            }
        }
        for (uint256 f; f < nf; ++f) {
            if (counts[f] < threshold) revert NotEnoughSigners(feeds[f], counts[f]);
            values[f] = _median(got[f], counts[f]);
        }
    }

    function signers() external view returns (address[] memory, uint8) {
        return (_signers, threshold);
    }

    /// Proposes new signers; applySigners() makes them current after SIGNER_DELAY.
    function proposeSigners(address[] calldata signers_, uint8 threshold_) external onlyOwner {
        _checkSigners(signers_, threshold_);
        pendingSignerList = signers_;
        pendingThreshold = threshold_;
        signersReadyAt = block.timestamp + SIGNER_DELAY;
        emit SignersProposed(signers_, threshold_, signersReadyAt);
    }

    function applySigners() external onlyOwner {
        if (signersReadyAt == 0 || block.timestamp < signersReadyAt) revert TooEarly();
        _setSigners(pendingSignerList, pendingThreshold);
        delete pendingSignerList;
        pendingThreshold = 0;
        signersReadyAt = 0;
    }

    function cancelSigners() external onlyOwner {
        delete pendingSignerList;
        pendingThreshold = 0;
        signersReadyAt = 0;
    }

    function _recover(SignedPrice calldata p) internal pure returns (address signer) {
        bytes calldata sig = p.signature;
        if (sig.length != 65 || p.timestampMs > type(uint48).max) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if ((v != 27 && v != 28) || uint256(s) > HALF_ORDER) revert BadSignature();
        bytes32 h = keccak256(abi.encodePacked(p.feedId, p.value, uint48(p.timestampMs), uint32(32), uint24(1)));
        signer = ecrecover(h, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }

    function _signerIndex(address signer) internal view returns (uint256) {
        uint256 n = _signers.length;
        for (uint256 i; i < n; ++i) {
            if (_signers[i] == signer) return i;
        }
        revert SignerNotAuthorised(signer);
    }

    function _median(uint256[] memory a, uint256 n) internal pure returns (uint256) {
        for (uint256 i = 1; i < n; ++i) {
            uint256 x = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > x) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = x;
        }
        return n % 2 == 1 ? a[n / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
    }

    function _setSigners(address[] memory signers_, uint8 threshold_) internal {
        _checkSigners(signers_, threshold_);
        _signers = signers_;
        threshold = threshold_;
        emit SignersSet(signers_, threshold_);
    }

    function _checkSigners(address[] memory signers_, uint8 threshold_) internal pure {
        uint256 n = signers_.length;
        if (n == 0 || n > 16 || threshold_ == 0 || threshold_ > n) revert BadParams();
        for (uint256 i; i < n; ++i) {
            if (signers_[i] == address(0)) revert BadParams();
            for (uint256 j; j < i; ++j) {
                if (signers_[i] == signers_[j]) revert BadParams();
            }
        }
    }
}

/// @title ARCSENSE perpetual futures, version 1 (Arc testnet first; audit before mainnet)
/// @notice Traders open long or short positions on a price (BTC, ETH, SOL…) with USDC as
/// collateral, at up to the market's maximum leverage. One USDC pool is the counterparty to
/// every trader: liquidity providers deposit USDC for pool shares (sLP), the pool pays traders'
/// profits and keeps their losses and borrow fees. ARCSENSE's share of the trading fees goes to
/// the fee wallet.
///
/// Prices come from SenseOracle (RedStone's signed prices, checked on-chain).
///
/// Every trade is two steps. The trader's request is stored with its time, and a keeper executes
/// it with a price observed at or after that time, so nobody trades on a price they have already
/// seen. Market requests the keeper hasn't executed within `requestTimeout` can be cancelled for a
/// full refund; closes and withdrawals the keeper hasn't executed within PUBLIC_EXEC_DELAY can be
/// executed by anyone, so money can always leave.
///
/// Solvency: a position's profit is capped at the smaller of 900% of its collateral and its size,
/// and that cap is reserved in the pool when it opens. The pool never pays more than it reserved,
/// and liquidity providers can't withdraw reserved USDC.
///
/// Trust (v1): keepers are set by the owner and choose which valid signed price executes a request
/// (bounded: observed at or after the request, at most `maxPriceAge` old). The owner can pause new
/// positions and deposits (never closes or withdrawals) and set fees and limits within hard caps.
/// The owner can't take the pool's or traders' USDC.
contract SensePerps is ERC20, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── constants ───────────────────────────────────────────────────────────

    uint256 public constant VERSION = 1;
    uint256 internal constant BPS = 10_000;
    /// A position's profit is capped at 900% of its collateral (and at its size).
    uint256 public constant MAX_PROFIT_BPS = 90_000;
    uint256 public constant MAX_FEE_BPS = 50; // 0.5% to open, 0.5% to close at most
    uint256 public constant MAX_LEVERAGE_CAP = 50;
    uint256 public constant MIN_LIQUIDATION_BPS = 10;
    uint256 public constant MAX_LIQUIDATION_BPS = 500;
    /// Borrow fee at most 0.01% of the position's size an hour (1e18 = 100%).
    uint256 public constant MAX_BORROW_RATE_PER_HOUR = 1e14;
    uint256 public constant MAX_EXEC_FEE = 1e6; // 1 USDC
    uint256 public constant MAX_PRICE_AGE_CAP = 300;
    uint256 public constant MAX_REQUEST_TIMEOUT = 1 hours;
    uint256 public constant MAX_LP_COOLDOWN = 7 days;
    /// A signed price may be at most this far ahead of the chain's clock.
    uint256 public constant MAX_FUTURE_MS = 30_000;
    /// Closes and withdrawals the keepers haven't executed after this long can be executed by anyone.
    uint256 public constant PUBLIC_EXEC_DELAY = 5 minutes;
    /// Anyone may liquidate, but someone who isn't a keeper must use a price at most this old.
    uint256 public constant PUBLIC_PRICE_AGE = 30;
    uint256 internal constant DEAD_SHARES = 1_000;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ─── types ───────────────────────────────────────────────────────────────

    enum Kind {
        None,
        Open,
        Close,
        Deposit,
        Withdraw
    }

    enum CloseReason {
        Close,
        TakeProfit,
        StopLoss,
        Liquidation
    }

    struct MarketParams {
        bytes32 feedId; // the oracle's feed id: the symbol, left-aligned ("BTC")
        bool enabled; // false: no new positions (open ones can still close)
        uint16 maxLeverage; // whole multiples, e.g. 10
        uint16 openFeeBps;
        uint16 closeFeeBps;
        uint16 liquidationBps; // maintenance margin, of the position's size
        uint256 borrowRatePerHour; // fraction of size an hour, 1e18 = 100%
        uint256 maxOiLong; // open interest caps, USDC (6 decimals)
        uint256 maxOiShort;
    }

    /// One side (long or short) of a market, summed over its open positions.
    struct Side {
        uint256 oi; // Σ size
        uint256 sizeOverEntry; // Σ size·1e18/entryPrice: Σ size·price/entry = sizeOverEntry·price/1e18
        uint256 collateral; // Σ collateral
        uint256 reserved; // Σ max profit
    }

    struct Market {
        MarketParams p;
        uint256 borrowIndex; // cumulative borrow fee per unit of size, 1e18
        uint64 lastBorrowUpdate;
        Side long_;
        Side short_;
    }

    struct Position {
        address trader;
        uint32 marketId;
        bool isLong;
        uint64 openedAt;
        uint64 tpSlSetAt;
        uint256 size; // USD, 6 decimals
        uint256 collateral; // USDC, 6 decimals (after the opening fee)
        uint256 entryPrice; // 8 decimals
        uint256 borrowIndex;
        uint256 maxProfit;
        uint256 tp; // take-profit price, 0 = none
        uint256 sl; // stop-loss price, 0 = none
    }

    struct Request {
        Kind kind;
        bool isLong;
        uint32 marketId;
        uint64 createdAt;
        address account;
        uint256 amount; // Open: collateral in; Deposit: USDC; Withdraw: sLP shares (escrowed here)
        uint256 size; // Open: position size
        uint256 acceptablePrice; // Open/Close: worst price (0 on a close = any); Deposit: min shares; Withdraw: min USDC
        uint256 triggerPrice; // Open: 0 = market order, else a limit (long: at or below it; short: at or above)
        uint256 positionId; // Close
        uint256 tp; // Open
        uint256 sl; // Open
        uint256 execFee; // USDC paid to whoever executes it
    }

    struct IdSet {
        uint256[] ids;
        mapping(uint256 => uint256) at; // index + 1
    }

    // ─── state ───────────────────────────────────────────────────────────────

    IERC20 public immutable usdc;
    SenseOracle public immutable oracle;
    address public feeWallet;
    /// ARCSENSE's share of trading fees (to the fee wallet); the rest goes to the pool.
    uint256 public platformFeeShareBps = BPS;
    mapping(address => bool) public isKeeper;
    /// Paused: no new positions or deposits. Closes, withdrawals and liquidations go on.
    bool public paused;

    uint256 public maxPriceAge = 60; // seconds
    uint256 public requestTimeout = 120; // seconds
    uint256 public execFee = 20_000; // 0.02 USDC
    uint256 public minCollateral = 2e6; // 2 USDC
    uint256 public lpCooldown = 15 minutes;

    Market[] internal _markets;

    /// USDC that belongs to liquidity providers.
    uint256 public poolAmount;
    /// Σ max profit of open positions: the part of the pool that can't be withdrawn.
    uint256 public totalReserved;
    uint256 public totalCollateral;
    /// USDC held for requests not yet executed (amounts and execution fees).
    uint256 public escrowed;

    uint256 public nextRequestId = 1;
    uint256 public nextPositionId = 1;
    mapping(uint256 => Request) internal _requests;
    mapping(uint256 => Position) internal _positions;
    /// A position's pending close request (0 = none).
    mapping(uint256 => uint256) public closeRequestOf;
    mapping(address => uint256) public lastDepositAt;

    IdSet internal _pending;
    IdSet internal _open;
    mapping(address => IdSet) internal _accountPositions;
    mapping(address => IdSet) internal _accountRequests;

    // ─── events ──────────────────────────────────────────────────────────────

    event RequestCreated(
        uint256 indexed id,
        address indexed account,
        Kind kind,
        uint32 marketId,
        bool isLong,
        uint256 amount,
        uint256 size,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        uint256 positionId
    );
    event RequestExecuted(uint256 indexed id, address indexed executor, uint256 price, uint256 positionId);
    event RequestCancelled(uint256 indexed id, address indexed account, string reason);
    event PositionOpened(
        uint256 indexed positionId,
        address indexed trader,
        uint32 indexed marketId,
        bool isLong,
        uint256 size,
        uint256 collateral,
        uint256 entryPrice,
        uint256 openFee
    );
    event PositionClosed(
        uint256 indexed positionId,
        address indexed trader,
        uint32 indexed marketId,
        CloseReason reason,
        uint256 price,
        int256 pnl,
        uint256 borrowFee,
        uint256 closeFee,
        uint256 payout
    );
    event TpSlSet(uint256 indexed positionId, uint256 tp, uint256 sl);
    event Deposited(address indexed account, uint256 amount, uint256 shares);
    event Withdrawn(address indexed account, uint256 shares, uint256 amount);
    event FeesPaid(uint256 toFeeWallet, uint256 toPool);
    event MarketSet(uint32 indexed marketId, MarketParams params);
    event KeeperSet(address indexed keeper, bool allowed);
    event FeeWalletSet(address feeWallet);
    event PlatformFeeShareSet(uint256 bps);
    event PausedSet(bool paused);
    event ConfigSet(uint256 maxPriceAge, uint256 requestTimeout, uint256 execFee, uint256 minCollateral, uint256 lpCooldown);

    // ─── errors ──────────────────────────────────────────────────────────────

    error BadParams();
    error BadMarket();
    error BadAmount();
    error IsPaused();
    error NotKeeper();
    error NotAccount();
    error UnknownRequest();
    error UnknownPosition();
    error TooEarly();
    error Expired();
    error ClosePending();
    error TriggerNotReached();
    error NotTriggered();
    error NotLiquidatable();
    error Cooldown();
    error PriceTooOld();
    error PriceStale();
    error PriceInFuture();
    error NotUsdc();

    // ─── setup ───────────────────────────────────────────────────────────────

    constructor(
        IERC20 usdc_,
        SenseOracle oracle_,
        address owner_,
        address feeWallet_,
        address keeper_,
        MarketParams[] memory markets_
    ) ERC20("ARCSENSE Futures LP", "sLP") Ownable(owner_) {
        if (address(usdc_) == address(0) || address(oracle_) == address(0) || feeWallet_ == address(0)) {
            revert BadParams();
        }
        if (IERC20Metadata(address(usdc_)).decimals() != 6) revert BadParams();
        usdc = usdc_;
        oracle = oracle_;
        feeWallet = feeWallet_;
        if (keeper_ != address(0)) {
            isKeeper[keeper_] = true;
            emit KeeperSet(keeper_, true);
        }
        for (uint256 i; i < markets_.length; ++i) {
            _addMarket(markets_[i]);
        }
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ─── traders ─────────────────────────────────────────────────────────────

    /// Asks to open a position. `collateralIn` + the execution fee are taken now; the opening fee
    /// comes off the collateral at execution. `acceptablePrice` is the worst entry (long: highest,
    /// short: lowest). A `triggerPrice` makes it a limit order, kept until it fills or is cancelled.
    function requestOpen(
        uint32 marketId,
        bool isLong,
        uint256 collateralIn,
        uint256 size,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        uint256 tp,
        uint256 sl
    ) external nonReentrant returns (uint256 id) {
        if (paused) revert IsPaused();
        Market storage m = _market(marketId);
        if (!m.p.enabled) revert BadMarket();
        if (collateralIn < minCollateral || size < collateralIn || acceptablePrice == 0) revert BadAmount();
        if (size > collateralIn * m.p.maxLeverage) revert BadAmount();
        uint256 fee = execFee;
        _pull(msg.sender, collateralIn + fee);
        Request memory r;
        r.kind = Kind.Open;
        r.isLong = isLong;
        r.marketId = marketId;
        r.account = msg.sender;
        r.amount = collateralIn;
        r.size = size;
        r.acceptablePrice = acceptablePrice;
        r.triggerPrice = triggerPrice;
        r.tp = tp;
        r.sl = sl;
        r.execFee = fee;
        id = _newRequest(r);
    }

    /// Asks to close a position in full. `acceptablePrice` is the worst exit (long: lowest,
    /// short: highest); 0 accepts any price.
    function requestClose(uint256 positionId, uint256 acceptablePrice) external nonReentrant returns (uint256 id) {
        Position storage pos = _positions[positionId];
        if (pos.trader != msg.sender) revert NotAccount();
        if (closeRequestOf[positionId] != 0) revert ClosePending();
        uint256 fee = execFee;
        _pull(msg.sender, fee);
        Request memory r;
        r.kind = Kind.Close;
        r.isLong = pos.isLong;
        r.marketId = pos.marketId;
        r.account = msg.sender;
        r.acceptablePrice = acceptablePrice;
        r.positionId = positionId;
        r.execFee = fee;
        id = _newRequest(r);
        closeRequestOf[positionId] = id;
    }

    /// Sets (or clears, with 0) a position's take-profit and stop-loss prices. A keeper closes the
    /// position at the first signed price, observed after this call, that reaches either.
    function setTpSl(uint256 positionId, uint256 tp, uint256 sl) external nonReentrant {
        Position storage pos = _positions[positionId];
        if (pos.trader != msg.sender) revert NotAccount();
        pos.tp = tp;
        pos.sl = sl;
        pos.tpSlSetAt = uint64(block.timestamp);
        emit TpSlSet(positionId, tp, sl);
    }

    // ─── liquidity providers ─────────────────────────────────────────────────

    /// Asks to deposit `amount` USDC into the pool for sLP shares (at least `minShares`).
    function requestDeposit(uint256 amount, uint256 minShares) external nonReentrant returns (uint256 id) {
        if (paused) revert IsPaused();
        if (amount == 0) revert BadAmount();
        uint256 fee = execFee;
        _pull(msg.sender, amount + fee);
        Request memory r;
        r.kind = Kind.Deposit;
        r.account = msg.sender;
        r.amount = amount;
        r.acceptablePrice = minShares;
        r.execFee = fee;
        id = _newRequest(r);
    }

    /// Asks to redeem `shares` sLP for USDC (at least `minOut`). The shares are held here until then.
    function requestWithdraw(uint256 shares, uint256 minOut) external nonReentrant returns (uint256 id) {
        if (shares == 0) revert BadAmount();
        if (block.timestamp < lastDepositAt[msg.sender] + lpCooldown) revert Cooldown();
        uint256 fee = execFee;
        _pull(msg.sender, fee);
        _transfer(msg.sender, address(this), shares);
        Request memory r;
        r.kind = Kind.Withdraw;
        r.account = msg.sender;
        r.amount = shares;
        r.acceptablePrice = minOut;
        r.execFee = fee;
        id = _newRequest(r);
    }

    /// Cancels one of your requests and refunds it in full. A limit order can be cancelled at any
    /// time; any other request once `requestTimeout` has passed without it being executed.
    function cancelRequest(uint256 id) external nonReentrant {
        Request memory r = _requests[id];
        if (r.kind == Kind.None) revert UnknownRequest();
        if (r.account != msg.sender) revert NotAccount();
        bool limit = r.kind == Kind.Open && r.triggerPrice != 0;
        if (!limit && block.timestamp < r.createdAt + requestTimeout) revert TooEarly();
        _removeRequest(id, r);
        _refund(id, r, r.execFee, "cancelled");
    }

    // ─── keepers ─────────────────────────────────────────────────────────────

    /// Executes a request with signed prices observed at or after it was made.
    /// Deposits and withdrawals need prices for every market with open positions.
    function executeRequest(uint256 id, SignedPrice[] calldata prices) external nonReentrant {
        Request memory r = _requests[id];
        if (r.kind == Kind.None) revert UnknownRequest();
        bool keeper = isKeeper[msg.sender];
        if (!keeper) {
            bool exit = r.kind == Kind.Close || r.kind == Kind.Withdraw;
            if (!exit || block.timestamp < r.createdAt + PUBLIC_EXEC_DELAY) revert NotKeeper();
        }
        if (
            (r.kind == Kind.Deposit || (r.kind == Kind.Open && r.triggerPrice == 0))
                && block.timestamp > r.createdAt + requestTimeout
        ) revert Expired();
        uint256 maxAge = keeper ? maxPriceAge : PUBLIC_PRICE_AGE;

        _removeRequest(id, r);
        escrowed -= r.execFee;
        if (r.kind == Kind.Open) _execOpen(id, r, prices, maxAge);
        else if (r.kind == Kind.Close) _execClose(id, r, prices, maxAge);
        else if (r.kind == Kind.Deposit) _execDeposit(id, r, prices, maxAge);
        else _execWithdraw(id, r, prices, maxAge);
        if (r.execFee > 0) usdc.safeTransfer(msg.sender, r.execFee);
    }

    /// Liquidates a position whose equity, at a signed price observed since it opened, is below its
    /// maintenance margin (plus the closing fee). Anyone may call it; a caller who isn't a keeper
    /// must use a price at most PUBLIC_PRICE_AGE seconds old.
    function liquidate(uint256 positionId, SignedPrice[] calldata prices) external nonReentrant {
        Position storage pos = _positions[positionId];
        if (pos.trader == address(0)) revert UnknownPosition();
        uint256 maxAge = isKeeper[msg.sender] ? maxPriceAge : PUBLIC_PRICE_AGE;
        uint256 price = _price1(_markets[pos.marketId].p.feedId, prices, pos.openedAt, maxAge);
        _close(positionId, price, CloseReason.Liquidation);
    }

    /// Closes a position whose take-profit or stop-loss was reached, at a signed price observed
    /// since they were set.
    function executeTpSl(uint256 positionId, SignedPrice[] calldata prices) external nonReentrant {
        if (!isKeeper[msg.sender]) revert NotKeeper();
        Position storage pos = _positions[positionId];
        if (pos.trader == address(0)) revert UnknownPosition();
        uint256 price = _price1(_markets[pos.marketId].p.feedId, prices, pos.tpSlSetAt, maxPriceAge);
        bool tpHit = pos.tp != 0 && (pos.isLong ? price >= pos.tp : price <= pos.tp);
        bool slHit = pos.sl != 0 && (pos.isLong ? price <= pos.sl : price >= pos.sl);
        if (!tpHit && !slHit) revert NotTriggered();
        _close(positionId, price, tpHit ? CloseReason.TakeProfit : CloseReason.StopLoss);
    }

    // ─── execution ───────────────────────────────────────────────────────────

    function _execOpen(uint256 id, Request memory r, SignedPrice[] calldata prices, uint256 maxAge) internal {
        Market storage m = _markets[r.marketId];
        uint256 price = _price1(m.p.feedId, prices, r.createdAt, maxAge);
        if (r.triggerPrice != 0) {
            bool hit = r.isLong ? price <= r.triggerPrice : price >= r.triggerPrice;
            if (!hit) revert TriggerNotReached();
        }
        uint256 openFee = r.size * m.p.openFeeBps / BPS;
        uint256 collateral = r.amount > openFee ? r.amount - openFee : 0;
        uint256 maxProfit = Math.min(collateral * MAX_PROFIT_BPS / BPS, r.size);
        Side storage s = r.isLong ? m.long_ : m.short_;
        string memory why;
        if (paused) why = "paused";
        else if (!m.p.enabled) why = "market closed";
        else if (r.isLong ? price > r.acceptablePrice : price < r.acceptablePrice) why = "price moved";
        // Leverage is size over the collateral put in (the opening fee comes out of it): at full
        // leverage a position still opens above its liquidation level (_checkMarket).
        else if (collateral < minCollateral || r.size < r.amount || r.size > r.amount * m.p.maxLeverage) why = "leverage";
        else if (s.oi + r.size > (r.isLong ? m.p.maxOiLong : m.p.maxOiShort)) why = "open interest cap";
        else if (poolAmount < totalReserved + maxProfit) why = "pool liquidity";
        if (bytes(why).length != 0) {
            _refund(id, r, 0, why);
            return;
        }

        _accrue(m);
        escrowed -= r.amount;
        uint256 platformCut = openFee * platformFeeShareBps / BPS;
        poolAmount += openFee - platformCut;
        totalCollateral += collateral;
        totalReserved += maxProfit;
        s.oi += r.size;
        s.sizeOverEntry += r.size * 1e18 / price;
        s.collateral += collateral;
        s.reserved += maxProfit;

        uint256 pid = nextPositionId++;
        Position storage pos = _positions[pid];
        pos.trader = r.account;
        pos.marketId = r.marketId;
        pos.isLong = r.isLong;
        pos.openedAt = uint64(block.timestamp);
        pos.tpSlSetAt = uint64(block.timestamp);
        pos.size = r.size;
        pos.collateral = collateral;
        pos.entryPrice = price;
        pos.borrowIndex = m.borrowIndex;
        pos.maxProfit = maxProfit;
        pos.tp = r.tp;
        pos.sl = r.sl;
        _add(_open, pid);
        _add(_accountPositions[r.account], pid);

        emit PositionOpened(pid, r.account, r.marketId, r.isLong, r.size, collateral, price, openFee);
        emit RequestExecuted(id, msg.sender, price, pid);
        if (r.tp != 0 || r.sl != 0) emit TpSlSet(pid, r.tp, r.sl);
        _payFees(platformCut, openFee - platformCut);
    }

    function _execClose(uint256 id, Request memory r, SignedPrice[] calldata prices, uint256 maxAge) internal {
        delete closeRequestOf[r.positionId];
        Position storage pos = _positions[r.positionId];
        uint256 price = _price1(_markets[pos.marketId].p.feedId, prices, r.createdAt, maxAge);
        if (r.acceptablePrice != 0 && (pos.isLong ? price < r.acceptablePrice : price > r.acceptablePrice)) {
            emit RequestCancelled(id, r.account, "price moved");
            return;
        }
        emit RequestExecuted(id, msg.sender, price, r.positionId);
        _close(r.positionId, price, CloseReason.Close);
    }

    function _execDeposit(uint256 id, Request memory r, SignedPrice[] calldata prices, uint256 maxAge) internal {
        (, uint256 aumMax) = _aum(prices, r.createdAt, maxAge);
        uint256 supply = totalSupply();
        uint256 shares;
        string memory why;
        if (paused) {
            why = "paused";
        } else if (supply == 0) {
            if (r.amount <= DEAD_SHARES) why = "too small";
            else shares = r.amount - DEAD_SHARES;
        } else if (aumMax == 0) {
            why = "pool empty";
        } else {
            shares = r.amount * supply / aumMax;
        }
        if (bytes(why).length == 0 && (shares == 0 || shares < r.acceptablePrice)) why = "price moved";
        if (bytes(why).length != 0) {
            _refund(id, r, 0, why);
            return;
        }
        escrowed -= r.amount;
        poolAmount += r.amount;
        if (supply == 0) _mint(DEAD, DEAD_SHARES);
        _mint(r.account, shares);
        lastDepositAt[r.account] = block.timestamp;
        emit Deposited(r.account, r.amount, shares);
        emit RequestExecuted(id, msg.sender, 0, 0);
    }

    function _execWithdraw(uint256 id, Request memory r, SignedPrice[] calldata prices, uint256 maxAge) internal {
        (uint256 aumMin,) = _aum(prices, r.createdAt, maxAge);
        uint256 out = r.amount * aumMin / totalSupply();
        string memory why;
        if (out == 0 || out < r.acceptablePrice) why = "price moved";
        else if (poolAmount < totalReserved + out) why = "liquidity in use";
        if (bytes(why).length != 0) {
            _refund(id, r, 0, why);
            return;
        }
        _burn(address(this), r.amount);
        poolAmount -= out;
        emit Withdrawn(r.account, r.amount, out);
        emit RequestExecuted(id, msg.sender, 0, 0);
        usdc.safeTransfer(r.account, out);
    }

    /// Closes a position at `price`. A position below its maintenance margin is liquidated instead,
    /// whatever asked to close it: the trader gets nothing, the pool keeps what's left.
    function _close(uint256 pid, uint256 price, CloseReason reason) internal {
        Position memory pos = _positions[pid];
        Market storage m = _markets[pos.marketId];
        _accrue(m);
        (int256 pnl, uint256 borrowFee, uint256 closeFee, int256 equity) = _values(pos, m, price);
        bool liq = equity < int256(pos.size * m.p.liquidationBps / BPS + closeFee);
        if (reason == CloseReason.Liquidation && !liq) revert NotLiquidatable();
        if (liq) reason = CloseReason.Liquidation;

        uint256 feeTaken = equity <= 0 ? 0 : Math.min(closeFee, uint256(equity));
        uint256 traderOut = liq || equity <= int256(closeFee) ? 0 : uint256(equity) - closeFee;
        uint256 platformCut = feeTaken * platformFeeShareBps / BPS;
        int256 poolDelta = int256(pos.collateral) - int256(traderOut) - int256(platformCut);

        Side storage s = pos.isLong ? m.long_ : m.short_;
        s.oi -= pos.size;
        s.sizeOverEntry -= pos.size * 1e18 / pos.entryPrice;
        s.collateral -= pos.collateral;
        s.reserved -= pos.maxProfit;
        totalReserved -= pos.maxProfit;
        totalCollateral -= pos.collateral;
        if (poolDelta >= 0) poolAmount += uint256(poolDelta);
        else poolAmount -= uint256(-poolDelta);

        delete _positions[pid];
        _remove(_open, pid);
        _remove(_accountPositions[pos.trader], pid);

        // A close the trader asked for that hasn't run yet: refunded, since the position is gone.
        uint256 pendingClose = closeRequestOf[pid];
        if (pendingClose != 0) {
            delete closeRequestOf[pid];
            Request memory cr = _requests[pendingClose];
            _removeRequest(pendingClose, cr);
            _refund(pendingClose, cr, cr.execFee, "position closed");
        }

        emit PositionClosed(pid, pos.trader, pos.marketId, reason, price, pnl, borrowFee, closeFee, traderOut);
        if (feeTaken > 0) emit FeesPaid(platformCut, feeTaken - platformCut);
        if (traderOut > 0) usdc.safeTransfer(pos.trader, traderOut);
        if (platformCut > 0) usdc.safeTransfer(feeWallet, platformCut);
    }

    /// The position's P&L (capped at its max profit), borrow fee, closing fee and equity at `price`.
    function _values(Position memory pos, Market storage m, uint256 price)
        internal
        view
        returns (int256 pnl, uint256 borrowFee, uint256 closeFee, int256 equity)
    {
        uint256 entry = pos.entryPrice;
        bool up = price >= entry;
        uint256 move = up ? price - entry : entry - price;
        if (pos.isLong == up) {
            pnl = int256(Math.mulDiv(pos.size, move, entry)); // a profit, rounded down
        } else {
            pnl = -int256(Math.mulDiv(pos.size, move, entry, Math.Rounding.Ceil)); // a loss, rounded up
        }
        if (pnl > int256(pos.maxProfit)) pnl = int256(pos.maxProfit);
        borrowFee = Math.mulDiv(pos.size, m.borrowIndex - pos.borrowIndex, 1e18, Math.Rounding.Ceil);
        closeFee = pos.size * m.p.closeFeeBps / BPS;
        equity = int256(pos.collateral) + pnl - int256(borrowFee);
    }

    /// What the pool is worth at signed prices, for liquidity providers. Open positions' unrealized
    /// profits are owed (up to what each side reserved). Their unrealized losses count only for
    /// deposits (up to each side's collateral): a depositor pays for gains the pool hasn't collected
    /// yet, and someone withdrawing doesn't take them.
    function _aum(SignedPrice[] calldata prices, uint256 notBefore, uint256 maxAge)
        internal
        view
        returns (uint256 aumMin, uint256 aumMax)
    {
        uint256 n = _markets.length;
        uint256 active;
        for (uint256 i; i < n; ++i) {
            if (_markets[i].long_.oi != 0 || _markets[i].short_.oi != 0) ++active;
        }
        bytes32[] memory feeds = new bytes32[](active);
        uint256[] memory ids = new uint256[](active);
        uint256 k;
        for (uint256 i; i < n; ++i) {
            if (_markets[i].long_.oi != 0 || _markets[i].short_.oi != 0) {
                feeds[k] = _markets[i].p.feedId;
                ids[k++] = i;
            }
        }
        uint256 liab;
        uint256 gain;
        if (active != 0) {
            (uint256[] memory px, uint256 ts) = oracle.verify(prices, feeds);
            _checkTime(ts, notBefore, maxAge);
            for (uint256 j; j < active; ++j) {
                Market storage m = _markets[ids[j]];
                (uint256 l1, uint256 g1) = _sidePnl(m.long_, px[j], true);
                (uint256 l2, uint256 g2) = _sidePnl(m.short_, px[j], false);
                liab += l1 + l2;
                gain += g1 + g2;
            }
        }
        aumMin = poolAmount > liab ? poolAmount - liab : 0;
        aumMax = poolAmount + gain > liab ? poolAmount + gain - liab : 0;
    }

    /// One side's unrealized result for the pool: (what it owes traders, what it stands to collect).
    function _sidePnl(Side storage s, uint256 price, bool isLong) internal view returns (uint256 owed, uint256 gain) {
        if (s.oi == 0) return (0, 0);
        uint256 value = Math.mulDiv(s.sizeOverEntry, price, 1e18);
        if (isLong ? value > s.oi : value < s.oi) {
            owed = Math.min(isLong ? value - s.oi : s.oi - value, s.reserved);
        } else {
            gain = Math.min(isLong ? s.oi - value : value - s.oi, s.collateral);
        }
    }

    // ─── prices ──────────────────────────────────────────────────────────────

    function _price1(bytes32 feed, SignedPrice[] calldata prices, uint256 notBefore, uint256 maxAge)
        internal
        view
        returns (uint256)
    {
        bytes32[] memory feeds = new bytes32[](1);
        feeds[0] = feed;
        (uint256[] memory v, uint256 ts) = oracle.verify(prices, feeds);
        _checkTime(ts, notBefore, maxAge);
        return v[0];
    }

    /// The price must have been observed at or after `notBefore` (seconds), not be ahead of the
    /// chain's clock by more than MAX_FUTURE_MS, and be at most `maxAge` seconds old.
    function _checkTime(uint256 tsMs, uint256 notBefore, uint256 maxAge) internal view {
        if (tsMs < notBefore * 1000) revert PriceTooOld();
        if (tsMs > block.timestamp * 1000 + MAX_FUTURE_MS) revert PriceInFuture();
        if (tsMs + maxAge * 1000 < block.timestamp * 1000) revert PriceStale();
    }

    // ─── bookkeeping ─────────────────────────────────────────────────────────

    function _market(uint32 id) internal view returns (Market storage) {
        if (id >= _markets.length) revert BadMarket();
        return _markets[id];
    }

    function _accrue(Market storage m) internal {
        uint256 dt = block.timestamp - m.lastBorrowUpdate;
        if (dt != 0) {
            m.borrowIndex += m.p.borrowRatePerHour * dt / 1 hours;
            m.lastBorrowUpdate = uint64(block.timestamp);
        }
    }

    function _pull(address from, uint256 amount) internal {
        escrowed += amount;
        usdc.safeTransferFrom(from, address(this), amount);
    }

    function _newRequest(Request memory r) internal returns (uint256 id) {
        id = nextRequestId++;
        r.createdAt = uint64(block.timestamp);
        _requests[id] = r;
        _add(_pending, id);
        _add(_accountRequests[r.account], id);
        emit RequestCreated(
            id, r.account, r.kind, r.marketId, r.isLong, r.amount, r.size, r.acceptablePrice, r.triggerPrice, r.positionId
        );
    }

    function _removeRequest(uint256 id, Request memory r) internal {
        delete _requests[id];
        _remove(_pending, id);
        _remove(_accountRequests[r.account], id);
        if (r.kind == Kind.Close && closeRequestOf[r.positionId] == id) delete closeRequestOf[r.positionId];
    }

    /// Gives a removed request back to its account: its amount (or shares) and `feeBack` of its
    /// execution fee (the rest of which, if any, the caller pays out).
    function _refund(uint256 id, Request memory r, uint256 feeBack, string memory why) internal {
        uint256 usdcBack = feeBack;
        if (r.kind == Kind.Open || r.kind == Kind.Deposit) usdcBack += r.amount;
        escrowed -= usdcBack;
        emit RequestCancelled(id, r.account, why);
        if (r.kind == Kind.Withdraw) _transfer(address(this), r.account, r.amount);
        if (usdcBack > 0) usdc.safeTransfer(r.account, usdcBack);
    }

    function _payFees(uint256 toFeeWallet, uint256 toPool) internal {
        if (toFeeWallet + toPool == 0) return;
        emit FeesPaid(toFeeWallet, toPool);
        if (toFeeWallet > 0) usdc.safeTransfer(feeWallet, toFeeWallet);
    }

    function _add(IdSet storage s, uint256 id) internal {
        s.ids.push(id);
        s.at[id] = s.ids.length;
    }

    function _remove(IdSet storage s, uint256 id) internal {
        uint256 i = s.at[id];
        if (i == 0) return;
        uint256 last = s.ids[s.ids.length - 1];
        s.ids[i - 1] = last;
        s.at[last] = i;
        s.ids.pop();
        delete s.at[id];
    }

    /// sLP shares can't move out of an account (transfer or withdrawal) within `lpCooldown` of its
    /// last deposit.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && from != address(this) && to != address(this)) {
            if (block.timestamp < lastDepositAt[from] + lpCooldown) revert Cooldown();
        }
        super._update(from, to, value);
    }

    // ─── owner ───────────────────────────────────────────────────────────────

    function addMarket(MarketParams calldata p) external onlyOwner {
        _addMarket(p);
    }

    /// Updates a market's settings. Its price feed can't change while it has open positions.
    function setMarket(uint32 id, MarketParams calldata p) external onlyOwner {
        Market storage m = _market(id);
        if (p.feedId != m.p.feedId && (m.long_.oi != 0 || m.short_.oi != 0)) revert BadParams();
        _checkMarket(p);
        _accrue(m);
        m.p = p;
        emit MarketSet(id, p);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setFeeWallet(address w) external onlyOwner {
        if (w == address(0)) revert BadParams();
        feeWallet = w;
        emit FeeWalletSet(w);
    }

    function setPlatformFeeShare(uint256 bps) external onlyOwner {
        if (bps > BPS) revert BadParams();
        platformFeeShareBps = bps;
        emit PlatformFeeShareSet(bps);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function setConfig(uint256 maxPriceAge_, uint256 requestTimeout_, uint256 execFee_, uint256 minCollateral_, uint256 lpCooldown_)
        external
        onlyOwner
    {
        if (maxPriceAge_ < 5 || maxPriceAge_ > MAX_PRICE_AGE_CAP) revert BadParams();
        if (requestTimeout_ < 30 || requestTimeout_ > MAX_REQUEST_TIMEOUT) revert BadParams();
        if (execFee_ > MAX_EXEC_FEE || minCollateral_ == 0 || lpCooldown_ > MAX_LP_COOLDOWN) revert BadParams();
        maxPriceAge = maxPriceAge_;
        requestTimeout = requestTimeout_;
        execFee = execFee_;
        minCollateral = minCollateral_;
        lpCooldown = lpCooldown_;
        emit ConfigSet(maxPriceAge_, requestTimeout_, execFee_, minCollateral_, lpCooldown_);
    }

    /// Recovers tokens sent here by mistake. Never USDC: the pool's, traders' and requests' USDC stays.
    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (address(token) == address(usdc)) revert NotUsdc();
        token.safeTransfer(to, amount);
    }

    function _addMarket(MarketParams memory p) internal {
        _checkMarket(p);
        Market storage m = _markets.push();
        m.p = p;
        m.lastBorrowUpdate = uint64(block.timestamp);
        emit MarketSet(uint32(_markets.length - 1), p);
    }

    function _checkMarket(MarketParams memory p) internal pure {
        if (p.feedId == bytes32(0) || p.maxLeverage == 0 || p.maxLeverage > MAX_LEVERAGE_CAP) revert BadParams();
        if (p.openFeeBps > MAX_FEE_BPS || p.closeFeeBps > MAX_FEE_BPS) revert BadParams();
        if (p.liquidationBps < MIN_LIQUIDATION_BPS || p.liquidationBps > MAX_LIQUIDATION_BPS) revert BadParams();
        if (p.borrowRatePerHour > MAX_BORROW_RATE_PER_HOUR) revert BadParams();
        // At full leverage a new position must start above its liquidation level.
        if ((uint256(p.liquidationBps) + p.openFeeBps + p.closeFeeBps) * p.maxLeverage >= BPS) revert BadParams();
    }

    // ─── views ───────────────────────────────────────────────────────────────

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function getMarkets() external view returns (Market[] memory) {
        return _markets;
    }

    function getPositions(uint256[] calldata ids) external view returns (Position[] memory out) {
        out = new Position[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _positions[ids[i]];
        }
    }

    function getRequests(uint256[] calldata ids) external view returns (Request[] memory out) {
        out = new Request[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = _requests[ids[i]];
        }
    }

    function pendingRequestIds() external view returns (uint256[] memory) {
        return _pending.ids;
    }

    function openPositionIds() external view returns (uint256[] memory) {
        return _open.ids;
    }

    function positionIdsOf(address account) external view returns (uint256[] memory) {
        return _accountPositions[account].ids;
    }

    function requestIdsOf(address account) external view returns (uint256[] memory) {
        return _accountRequests[account].ids;
    }
}

/// Test USDC for ARCSENSE futures on Arc testnet: anyone can take 1,000 a day from the faucet.
/// Worthless by design; never deploy it on mainnet.
contract SenseTestUSDC is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;
    uint256 public constant FAUCET_COOLDOWN = 1 days;
    address public immutable minter;
    mapping(address => uint256) public lastFaucetAt;

    error TooSoon(uint256 nextAt);
    error NotMinter();

    constructor(address minter_, uint256 initialSupply) ERC20("ARCSENSE Test USDC", "tUSDC") {
        minter = minter_;
        _mint(minter_, initialSupply);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet() external {
        uint256 last = lastFaucetAt[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) revert TooSoon(last + FAUCET_COOLDOWN);
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }
}
