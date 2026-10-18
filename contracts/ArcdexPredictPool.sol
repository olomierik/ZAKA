// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title ARCDEX prediction pool token (testnet): minted to traders from their realised losses
/// @notice papertrade.xyz's PAPER, for prediction markets. Supply starts at zero; only the pool mints,
/// and only for a loss. Until the pool's owner turns transfers on (one way), the token moves only
/// between a holder and the pool, which is how it is staked and unstaked.
contract ArcdexPredictToken is ERC20 {
    address public immutable pool;
    bool public transfersEnabled;

    error NotPool();
    error Untransferable();

    constructor() ERC20("ARCDEX Pool (testnet)", "tPOOL") {
        pool = msg.sender;
    }

    modifier onlyPool() {
        if (msg.sender != pool) revert NotPool();
        _;
    }

    function mint(address to, uint256 amount) external onlyPool {
        _mint(to, amount);
    }

    /// Staking: the pool moves a holder's tokens to itself, and back on unstaking.
    function poolMove(address from, address to, uint256 amount) external onlyPool {
        _transfer(from, to, amount);
    }

    function enableTransfers() external onlyPool {
        transfersEnabled = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && !transfersEnabled && from != pool && to != pool) revert Untransferable();
        super._update(from, to, value);
    }
}

/// @title ARCDEX prediction pool, version 1 (Arc testnet only; independent audit before any mainnet use)
/// @notice papertrade.xyz's design, for Hyperliquid's prediction markets (HIP-4). A trader buys or sells
/// a side of an outcome at its mid on Hyperliquid, against this pool, with no slippage. Each contract of
/// side 0 pays `settleFraction` when Hyperliquid settles the outcome, each contract of side 1 pays
/// 1 − settleFraction (both in USDC, 1e6 = $1 a contract).
///
/// Prices and settlements come from one signer, the ARCDEX engine's key, as EIP-712 messages: the
/// engine reads Hyperliquid's mids and `settledOutcome` and signs them. That key is trusted for prices:
/// see contracts/AUDIT-ArcdexPredictPool.md. A settlement waits `settleDelay` before it pays, and the
/// owner can cancel a wrong one in that time, so a stolen signer key alone can't settle a market.
///
/// Every trade is two steps, as in SensePerps: the trader's request is stored with its time, and is
/// filled with a price signed strictly after that second, so nobody trades on a price they have
/// already seen. A request not filled within `requestTimeout` can be cancelled for a full refund.
///
/// The pool (papertrade's "Martingaler" design):
/// - It starts at $0 and nobody can deposit into it: it fills only from traders' losses.
/// - A trader's own money is never queued: on any close, what they paid comes back at once, up to
///   the position's value. Only a profit can wait.
/// - A profit the pool's free cash can't pay waits in a first-in, first-out queue. While anything is
///   queued, no new profit is paid ahead of it, and new losses are earmarked (`sideBucket`) for the
///   queue; `harvest` pays the queue in order.
/// - Fees come only out of the pool's side: `winFeeBps` of a profit, `lossFeeBps` carved from the
///   pool's gain on a loss, paid only while nothing is queued and the pool can cover them. Half
///   (`stakerShareBps`) goes to stakers, the rest to the fee wallet.
/// - Every realised loss mints tPOOL to the trader: 100 per $1 while the pool's tracked P&L is under
///   $2M, then decaying as 100 · (S / (S + H))², H the high-water mark past $2M, S = $120M.
/// - Staked tPOOL earns the stakers' share of fees, plus the pool's gain past `stakerRewardCap`.
/// - Each side of each outcome has an open-interest cap, in contracts.
contract ArcdexPredictPool is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ── constants ────────────────────────────────────────────────────────

    uint256 public constant ONE = 1e6; // a price of $1; a contract; $1 of USDC
    uint256 public constant MIN_BUY_PX = 10_000; // 1¢
    uint256 public constant MAX_BUY_PX = 990_000; // 99¢
    uint256 public constant MIN_ORDER = 1e6; // $1
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 public constant SIGNER_DELAY = 2 days;
    uint256 public constant MAX_CLOCK_SKEW = 10; // seconds a signed time may run ahead of the chain
    uint256 public constant PUBLIC_HARVEST = 32; // queue entries a trade harvests by itself

    // The mint curve (papertrade's live defaults), in USDC units.
    uint256 public constant FLAT_RATE = 100e18; // tPOOL per $1 of loss
    uint256 public constant FLAT_THRESHOLD = 2_000_000e6;
    uint256 public constant TAIL_SCALE = 120_000_000e6;

    bytes32 public constant PRICE_TYPEHASH = keccak256("Price(uint32 outcome,uint8 side,uint64 px,uint64 ts)");
    bytes32 public constant SETTLEMENT_TYPEHASH = keccak256("Settlement(uint32 outcome,uint64 fraction,uint64 ts)");

    // ── types ────────────────────────────────────────────────────────────

    struct Position {
        uint128 contracts;
        uint128 cost; // USDC paid for the contracts still held
        uint128 selling; // contracts under a pending sale
    }

    struct Request {
        address trader;
        uint32 outcome;
        uint8 side;
        bool buy;
        uint64 createdAt;
        uint128 amount; // USDC for a buy, contracts for a sale
        uint64 limitPx; // the most a buy pays, the least a sale takes
    }

    struct Market {
        uint128 oi0; // contracts held of each side
        uint128 oi1;
        uint128 cap; // per side; 0 = defaultCap
        bool halted; // no buys
        uint8 state; // 0 trading, 1 settlement pending, 2 settled
        uint64 fraction; // side 0's payout per contract, once proposed
        uint64 readyAt;
        uint64 minSettleTs; // a settlement must be signed after this (the last one the owner cancelled)
    }

    struct Claim {
        address user;
        uint128 amount;
    }

    struct Fill {
        uint256 id;
        uint64 px; // 0: no price for this request (refunded)
        uint64 ts;
        bytes sig;
    }

    struct PoolState {
        uint256 lpCash;
        uint256 sideBucket;
        uint256 totalQueued;
        uint256 queueLength;
        int256 trackedLp;
        uint256 tailHighWater;
        uint256 totalBalances;
        uint256 totalPending;
        uint256 totalLocked;
        uint256 devFees;
        uint256 stakerFeeAcc;
        uint256 rewardsReserve;
        uint256 totalStaked;
        uint256 mintRate; // tPOOL (18 decimals) per $1 of loss, now
        bool paused;
    }

    // ── state ────────────────────────────────────────────────────────────

    IERC20 public immutable usdc;
    ArcdexPredictToken public immutable token;

    address public signer;
    address public pendingSigner;
    uint256 public signerReadyAt;
    address public feeWallet;

    uint16 public winFeeBps = 200;
    uint16 public lossFeeBps = 200;
    uint16 public stakerShareBps = 5_000;
    uint32 public requestTimeout = 60;
    uint32 public maxPriceAge = 20;
    uint32 public settleDelay = 10 minutes;
    uint128 public defaultCap = 10_000e6; // contracts per side
    uint256 public stakerRewardCap = 5_000_000e6;
    bool public paused;

    mapping(address => uint256) public balances;
    mapping(address => mapping(uint256 => Position)) internal _positions; // key = outcome * 2 + side
    mapping(address => uint256[]) internal _keysOf;
    mapping(address => mapping(uint256 => bool)) internal _hasKey;
    mapping(uint256 => Request) internal _requests;
    mapping(address => uint256[]) internal _requestIdsOf;
    mapping(uint256 => uint256) internal _requestSlot; // index + 1 in the trader's list
    uint256 public nextRequestId = 1;
    mapping(uint32 => Market) public markets;

    uint256 public totalBalances;
    uint256 public totalPending;
    uint256 public totalLocked;
    uint256 public lpCash;
    uint256 public sideBucket;
    int256 public trackedLp;
    uint256 public tailHighWater;

    Claim[] internal _queue;
    uint256 public queueHead;
    uint256 public totalQueued;
    mapping(address => uint256) public queuedOf;

    uint256 public devFees;
    uint256 public stakerFeeAcc;
    uint256 public rewardsReserve;
    uint256 public totalStaked;
    uint256 public accRewardPerShare; // 1e18-scaled USDC units per token unit
    mapping(address => uint256) public stakeOf;
    mapping(address => uint256) internal _rewardDebt;
    mapping(address => uint256) internal _rewardOwed;

    // ── events ───────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RequestCreated(uint256 indexed id, address indexed trader, uint32 indexed outcome, uint8 side, bool buy, uint256 amount, uint256 limitPx);
    event RequestCancelled(uint256 indexed id, address indexed trader);
    event RequestRejected(uint256 indexed id, address indexed trader, uint8 reason);
    event Filled(uint256 indexed id, address indexed trader, uint32 indexed outcome, uint8 side, bool buy, uint256 contracts, uint256 usd, uint256 px);
    event Closed(address indexed trader, uint32 indexed outcome, uint8 side, uint256 contracts, uint256 cost, uint256 value, int256 pnl, bool settled);
    event Queued(address indexed user, uint256 amount, uint256 index);
    event QueuePaid(address indexed user, uint256 amount, uint256 index);
    event LossMinted(address indexed user, uint256 loss, uint256 tokens);
    event FeeTaken(uint256 stakers, uint256 dev);
    event SettlementProposed(uint32 indexed outcome, uint256 fraction, uint256 readyAt);
    event SettlementCancelled(uint32 indexed outcome);
    event Settled(uint32 indexed outcome, uint256 fraction);
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardsClaimed(address indexed user, uint256 amount);
    event RewardsDistributed(uint256 amount);
    event ExcessPushed(uint256 amount);
    event SignerProposed(address signer, uint256 readyAt);
    event SignerSet(address signer);
    event ParamsSet();

    // Reasons a request was refunded.
    uint8 internal constant R_NO_PRICE = 1;
    uint8 internal constant R_LIMIT = 2;
    uint8 internal constant R_DECIDED = 3; // a buy outside 1–99¢
    uint8 internal constant R_CAP = 4;
    uint8 internal constant R_CLOSED = 5; // halted, paused, or settling
    uint8 internal constant R_GONE = 6; // the contracts under sale were redeemed

    error BadParams();
    error BadAmount();
    error MarketClosed();
    error IsPaused();
    error NotYours();
    error NoRequest();
    error TooEarly();
    error Expired();
    error BadSignature();
    error StalePrice();
    error PriceTooEarly();
    error WrongMarket();
    error NotSettled();
    error AlreadySettling();
    error NothingHeld();

    constructor(IERC20 usdc_, address owner_, address feeWallet_, address signer_) Ownable(owner_) EIP712("ARCDEX Predict", "1") {
        if (address(usdc_) == address(0) || feeWallet_ == address(0) || signer_ == address(0)) revert BadParams();
        usdc = usdc_;
        feeWallet = feeWallet_;
        signer = signer_;
        token = new ArcdexPredictToken();
        emit SignerSet(signer_);
    }

    // ── money in and out ─────────────────────────────────────────────────

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert BadAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        balances[msg.sender] += amount;
        totalBalances += amount;
        emit Deposited(msg.sender, amount);
    }

    /// Always open: a balance is the trader's.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > balances[msg.sender]) revert BadAmount();
        balances[msg.sender] -= amount;
        totalBalances -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ── requests ─────────────────────────────────────────────────────────

    /// Buys `usd` of a side from the balance, at the mid the next signed price gives, paying at most `maxPx`.
    function requestBuy(uint32 outcome, uint8 side, uint256 usd, uint256 maxPx) external nonReentrant returns (uint256 id) {
        if (paused) revert IsPaused();
        if (side > 1 || usd < MIN_ORDER || usd > type(uint128).max || maxPx < MIN_BUY_PX || maxPx >= ONE) revert BadAmount();
        Market storage m = markets[outcome];
        if (m.state != 0 || m.halted) revert MarketClosed();
        if (usd > balances[msg.sender]) revert BadAmount();
        balances[msg.sender] -= usd;
        totalBalances -= usd;
        totalPending += usd;
        id = _newRequest(outcome, side, true, uint128(usd), uint64(maxPx));
    }

    /// Sells `contracts` of a held side at the next signed mid, taking at least `minPx`.
    function requestSell(uint32 outcome, uint8 side, uint256 contracts, uint256 minPx) external nonReentrant returns (uint256 id) {
        if (side > 1 || contracts == 0 || minPx >= ONE) revert BadAmount();
        if (markets[outcome].state != 0) revert MarketClosed();
        Position storage p = _positions[msg.sender][_key(outcome, side)];
        if (contracts > uint256(p.contracts) - p.selling) revert BadAmount();
        p.selling += uint128(contracts);
        id = _newRequest(outcome, side, false, uint128(contracts), uint64(minPx));
    }

    function _newRequest(uint32 outcome, uint8 side, bool buy, uint128 amount, uint64 limitPx) internal returns (uint256 id) {
        id = nextRequestId++;
        _requests[id] = Request(msg.sender, outcome, side, buy, uint64(block.timestamp), amount, limitPx);
        _requestIdsOf[msg.sender].push(id);
        _requestSlot[id] = _requestIdsOf[msg.sender].length;
        emit RequestCreated(id, msg.sender, outcome, side, buy, amount, limitPx);
    }

    /// A request the keeper hasn't filled within `requestTimeout`: refunded in full, by its trader.
    function cancel(uint256 id) external nonReentrant {
        Request memory r = _requests[id];
        if (r.trader == address(0)) revert NoRequest();
        if (r.trader != msg.sender) revert NotYours();
        if (block.timestamp <= uint256(r.createdAt) + requestTimeout) revert TooEarly();
        _refund(id, r);
        emit RequestCancelled(id, r.trader);
    }

    /// Fills requests with signed prices. Anyone may call it; a price counts only if the signer signed it
    /// for that side, strictly after the request's second, and it's at most `maxPriceAge` old.
    function execute(Fill[] calldata fills) external nonReentrant {
        for (uint256 i; i < fills.length; ++i) {
            _execute(fills[i]);
        }
    }

    function _execute(Fill calldata f) internal {
        Request memory r = _requests[f.id];
        if (r.trader == address(0)) revert NoRequest();
        if (block.timestamp > uint256(r.createdAt) + requestTimeout) revert Expired();
        if (uint256(f.ts) <= r.createdAt) revert PriceTooEarly();
        if (uint256(f.ts) > block.timestamp + MAX_CLOCK_SKEW || block.timestamp > uint256(f.ts) + maxPriceAge) revert StalePrice();
        if (f.px >= ONE) revert BadAmount();
        _checkSig(keccak256(abi.encode(PRICE_TYPEHASH, r.outcome, r.side, f.px, f.ts)), f.sig);

        Market storage m = markets[r.outcome];
        uint8 reason;
        if (f.px == 0) reason = R_NO_PRICE;
        else if (m.state != 0 || (r.buy && (m.halted || paused))) reason = R_CLOSED;
        else if (r.buy ? f.px > r.limitPx : f.px < r.limitPx) reason = R_LIMIT;
        else if (r.buy && (f.px < MIN_BUY_PX || f.px > MAX_BUY_PX)) reason = R_DECIDED;
        if (reason == 0 && r.buy) {
            uint256 n = uint256(r.amount) * ONE / f.px;
            uint256 cap = m.cap == 0 ? defaultCap : m.cap;
            if ((r.side == 0 ? m.oi0 : m.oi1) + n > cap) reason = R_CAP;
        }
        if (reason == 0 && !r.buy && _positions[r.trader][_key(r.outcome, r.side)].selling < r.amount) reason = R_GONE;
        if (reason != 0) {
            _refund(f.id, r);
            emit RequestRejected(f.id, r.trader, reason);
            return;
        }
        _dropRequest(f.id, r.trader);
        if (r.buy) _fillBuy(f.id, r, f.px);
        else _fillSell(f.id, r, f.px);
    }

    function _fillBuy(uint256 id, Request memory r, uint256 px) internal {
        uint256 n = uint256(r.amount) * ONE / px;
        Position storage p = _positions[r.trader][_key(r.outcome, r.side)];
        p.contracts += uint128(n);
        p.cost += r.amount;
        uint256 k = _key(r.outcome, r.side);
        if (!_hasKey[r.trader][k]) {
            _hasKey[r.trader][k] = true;
            _keysOf[r.trader].push(k);
        }
        Market storage m = markets[r.outcome];
        if (r.side == 0) m.oi0 += uint128(n);
        else m.oi1 += uint128(n);
        totalPending -= r.amount;
        totalLocked += r.amount;
        emit Filled(id, r.trader, r.outcome, r.side, true, n, r.amount, px);
    }

    function _fillSell(uint256 id, Request memory r, uint256 px) internal {
        Position storage p = _positions[r.trader][_key(r.outcome, r.side)];
        uint256 n = r.amount;
        uint256 cost = n == p.contracts ? p.cost : uint256(p.cost) * n / p.contracts;
        uint256 value = n * px / ONE;
        p.selling -= uint128(n);
        _takeOut(r.trader, r.outcome, r.side, p, n, cost);
        emit Filled(id, r.trader, r.outcome, r.side, false, n, value, px);
        _close(r.trader, r.outcome, r.side, n, cost, value, false);
    }

    function _refund(uint256 id, Request memory r) internal {
        _dropRequest(id, r.trader);
        if (r.buy) {
            totalPending -= r.amount;
            balances[r.trader] += r.amount;
            totalBalances += r.amount;
        } else {
            Position storage p = _positions[r.trader][_key(r.outcome, r.side)];
            // The contracts may have been redeemed meanwhile, which cleared the hold.
            p.selling = p.selling >= r.amount ? p.selling - r.amount : 0;
        }
    }

    function _dropRequest(uint256 id, address trader) internal {
        delete _requests[id];
        uint256[] storage list = _requestIdsOf[trader];
        uint256 slot = _requestSlot[id];
        uint256 last = list[list.length - 1];
        list[slot - 1] = last;
        _requestSlot[last] = slot;
        list.pop();
        delete _requestSlot[id];
    }

    // ── settlement ───────────────────────────────────────────────────────

    /// The signer's settlement of an outcome (Hyperliquid's settleFraction, 0–1e6). It takes effect after
    /// `settleDelay`; until then trading in the outcome stops, and the owner can cancel it. Anyone may submit it.
    function proposeSettlement(uint32 outcome, uint64 fraction, uint64 ts, bytes calldata sig) external {
        if (fraction > ONE) revert BadAmount();
        if (uint256(ts) > block.timestamp + MAX_CLOCK_SKEW) revert StalePrice();
        _checkSig(keccak256(abi.encode(SETTLEMENT_TYPEHASH, outcome, fraction, ts)), sig);
        Market storage m = markets[outcome];
        if (m.state != 0) revert AlreadySettling();
        if (ts <= m.minSettleTs) revert PriceTooEarly();
        m.state = 1;
        m.fraction = fraction;
        m.readyAt = uint64(block.timestamp + settleDelay);
        emit SettlementProposed(outcome, fraction, m.readyAt);
    }

    /// A wrong settlement, stopped before it pays. The outcome is halted for buys until the owner reopens it.
    function cancelSettlement(uint32 outcome) external onlyOwner {
        Market storage m = markets[outcome];
        if (m.state != 1) revert NotSettled();
        m.state = 0;
        m.fraction = 0;
        m.readyAt = 0;
        m.halted = true;
        m.minSettleTs = uint64(block.timestamp + MAX_CLOCK_SKEW);
        emit SettlementCancelled(outcome);
    }

    function finalizeSettlement(uint32 outcome) public {
        Market storage m = markets[outcome];
        if (m.state == 2) return;
        if (m.state != 1 || block.timestamp < m.readyAt) revert NotSettled();
        m.state = 2;
        emit Settled(outcome, m.fraction);
    }

    /// Pays out a holder's whole position in a settled outcome. Anyone may call it for anyone.
    function redeem(address user, uint32 outcome, uint8 side) public nonReentrant {
        _redeem(user, outcome, side);
    }

    function redeemMany(address[] calldata users, uint32[] calldata outcomes, uint8[] calldata sides) external nonReentrant {
        if (users.length != outcomes.length || users.length != sides.length) revert BadParams();
        for (uint256 i; i < users.length; ++i) {
            if (_positions[users[i]][_key(outcomes[i], sides[i])].contracts != 0) _redeem(users[i], outcomes[i], sides[i]);
        }
    }

    function _redeem(address user, uint32 outcome, uint8 side) internal {
        if (side > 1) revert BadAmount();
        finalizeSettlement(outcome);
        Position storage p = _positions[user][_key(outcome, side)];
        uint256 n = p.contracts;
        if (n == 0) revert NothingHeld();
        uint256 cost = p.cost;
        uint256 f = markets[outcome].fraction;
        uint256 value = n * (side == 0 ? f : ONE - f) / ONE;
        p.selling = 0;
        _takeOut(user, outcome, side, p, n, cost);
        _close(user, outcome, side, n, cost, value, true);
    }

    function _takeOut(address, uint32 outcome, uint8 side, Position storage p, uint256 n, uint256 cost) internal {
        p.contracts -= uint128(n);
        p.cost -= uint128(cost);
        Market storage m = markets[outcome];
        if (side == 0) m.oi0 -= uint128(n);
        else m.oi1 -= uint128(n);
        totalLocked -= cost;
    }

    // ── the pool ─────────────────────────────────────────────────────────

    /// Settles a closed position's value against the pool: the trader's own money back at once, up to
    /// the value; a loss to the pool (or to the queue's earmark); a profit from free cash, or queued.
    function _close(address user, uint32 outcome, uint8 side, uint256 n, uint256 cost, uint256 value, bool settled) internal {
        if (value <= cost) {
            _credit(user, value);
            uint256 loss = cost - value;
            if (loss != 0) {
                _mintFor(user, loss);
                trackedLp += int256(loss);
                _bumpHighWater();
                if (_queueEmpty()) {
                    uint256 lossFee = loss * lossFeeBps / 10_000;
                    lpCash += loss - lossFee;
                    _takeFee(lossFee);
                } else {
                    sideBucket += loss;
                    _harvest(PUBLIC_HARVEST);
                }
            }
            emit Closed(user, outcome, side, n, cost, value, -int256(loss), settled);
            return;
        }
        _credit(user, cost);
        uint256 profit = value - cost;
        uint256 fee = profit * winFeeBps / 10_000;
        uint256 owed = profit - fee;
        if (_queueEmpty()) {
            uint256 pay = Math.min(lpCash, owed);
            lpCash -= pay;
            _credit(user, pay);
            uint256 left = owed - pay;
            uint256 feePaid;
            if (left != 0) {
                _enqueue(user, left);
            } else if (lpCash >= fee) {
                lpCash -= fee;
                feePaid = fee;
                _takeFee(fee);
            }
            trackedLp -= int256(owed + feePaid);
        } else {
            _enqueue(user, owed);
            trackedLp -= int256(owed);
        }
        emit Closed(user, outcome, side, n, cost, value, int256(owed), settled);
    }

    function _credit(address user, uint256 amount) internal {
        if (amount == 0) return;
        balances[user] += amount;
        totalBalances += amount;
    }

    function _queueEmpty() internal view returns (bool) {
        return queueHead == _queue.length;
    }

    function _enqueue(address user, uint256 amount) internal {
        _queue.push(Claim(user, uint128(amount)));
        totalQueued += amount;
        queuedOf[user] += amount;
        emit Queued(user, amount, _queue.length - 1);
    }

    /// Pays the queue from its front: the earmarked losses first, then free cash. Anyone may call it.
    function harvest(uint256 maxEntries) external nonReentrant {
        _harvest(maxEntries);
    }

    function _harvest(uint256 maxEntries) internal {
        uint256 len = _queue.length;
        uint256 head = queueHead;
        for (uint256 done; head < len && done < maxEntries; ++done) {
            uint256 avail = sideBucket + lpCash;
            if (avail == 0) break;
            Claim storage c = _queue[head];
            uint256 pay = Math.min(c.amount, avail);
            uint256 fromSide = Math.min(pay, sideBucket);
            sideBucket -= fromSide;
            lpCash -= pay - fromSide;
            c.amount -= uint128(pay);
            totalQueued -= pay;
            queuedOf[c.user] -= pay;
            _credit(c.user, pay);
            emit QueuePaid(c.user, pay, head);
            if (c.amount != 0) break;
            ++head;
        }
        queueHead = head;
        if (head == len && sideBucket != 0) {
            // The queue is clear: what was earmarked for it is free cash again.
            lpCash += sideBucket;
            sideBucket = 0;
        }
    }

    function _takeFee(uint256 fee) internal {
        if (fee == 0) return;
        uint256 toStakers = fee * stakerShareBps / 10_000;
        devFees += fee - toStakers;
        stakerFeeAcc += toStakers;
        emit FeeTaken(toStakers, fee - toStakers);
        _distribute();
    }

    function _distribute() internal {
        uint256 amount = stakerFeeAcc;
        if (amount == 0 || totalStaked == 0) return;
        stakerFeeAcc = 0;
        accRewardPerShare += amount * 1e18 / totalStaked;
        rewardsReserve += amount;
        emit RewardsDistributed(amount);
    }

    /// The pool's gain past `stakerRewardCap` goes to stakers (while nothing is queued). Anyone may call it.
    function pushExcess() external nonReentrant {
        if (!_queueEmpty() || totalStaked == 0 || trackedLp <= int256(stakerRewardCap)) return;
        uint256 x = Math.min(lpCash, uint256(trackedLp) - stakerRewardCap);
        if (x == 0) return;
        lpCash -= x;
        trackedLp -= int256(x);
        stakerFeeAcc += x;
        emit ExcessPushed(x);
        _distribute();
    }

    /// The fee wallet's share of fees, sent to it. Anyone may call it.
    function withdrawDevFees() external nonReentrant {
        uint256 x = devFees;
        if (x == 0) return;
        devFees = 0;
        usdc.safeTransfer(feeWallet, x);
    }

    // ── the token ────────────────────────────────────────────────────────

    /// tPOOL per $1 of loss, now (18 decimals).
    function mintRate() public view returns (uint256) {
        if (trackedLp < int256(FLAT_THRESHOLD) && tailHighWater == 0) return FLAT_RATE;
        uint256 s = TAIL_SCALE;
        uint256 d = s + tailHighWater;
        return Math.mulDiv(Math.mulDiv(FLAT_RATE, s, d), s, d);
    }

    function _mintFor(address user, uint256 loss) internal {
        uint256 amount = Math.mulDiv(loss, mintRate(), ONE);
        if (amount == 0) return;
        token.mint(user, amount);
        emit LossMinted(user, loss, amount);
    }

    function _bumpHighWater() internal {
        if (trackedLp > int256(FLAT_THRESHOLD)) {
            uint256 tail = uint256(trackedLp) - FLAT_THRESHOLD;
            if (tail > tailHighWater) tailHighWater = tail;
        }
    }

    // ── staking ──────────────────────────────────────────────────────────

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert BadAmount();
        _settleRewards(msg.sender);
        token.poolMove(msg.sender, address(this), amount);
        stakeOf[msg.sender] += amount;
        totalStaked += amount;
        _rewardDebt[msg.sender] = stakeOf[msg.sender] * accRewardPerShare / 1e18;
        emit Staked(msg.sender, amount);
        _distribute();
    }

    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > stakeOf[msg.sender]) revert BadAmount();
        _settleRewards(msg.sender);
        stakeOf[msg.sender] -= amount;
        totalStaked -= amount;
        _rewardDebt[msg.sender] = stakeOf[msg.sender] * accRewardPerShare / 1e18;
        token.poolMove(address(this), msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// Rewards to the trading balance (from there, withdraw).
    function claim() external nonReentrant {
        _settleRewards(msg.sender);
        uint256 x = _rewardOwed[msg.sender];
        if (x == 0) return;
        _rewardOwed[msg.sender] = 0;
        rewardsReserve -= x;
        _credit(msg.sender, x);
        emit RewardsClaimed(msg.sender, x);
    }

    function _settleRewards(address user) internal {
        uint256 acc = stakeOf[user] * accRewardPerShare / 1e18;
        _rewardOwed[user] += acc - _rewardDebt[user];
        _rewardDebt[user] = acc;
    }

    function pendingReward(address user) external view returns (uint256) {
        return _rewardOwed[user] + stakeOf[user] * accRewardPerShare / 1e18 - _rewardDebt[user];
    }

    // ── the owner ────────────────────────────────────────────────────────

    function setFees(uint16 winFeeBps_, uint16 lossFeeBps_, uint16 stakerShareBps_) external onlyOwner {
        if (winFeeBps_ > MAX_FEE_BPS || lossFeeBps_ > MAX_FEE_BPS || stakerShareBps_ > 10_000) revert BadParams();
        winFeeBps = winFeeBps_;
        lossFeeBps = lossFeeBps_;
        stakerShareBps = stakerShareBps_;
        emit ParamsSet();
    }

    function setTimes(uint32 requestTimeout_, uint32 maxPriceAge_, uint32 settleDelay_) external onlyOwner {
        if (requestTimeout_ < 10 || requestTimeout_ > 10 minutes || maxPriceAge_ < 2 || maxPriceAge_ > 2 minutes) revert BadParams();
        if (settleDelay_ < 1 minutes || settleDelay_ > 1 days) revert BadParams();
        requestTimeout = requestTimeout_;
        maxPriceAge = maxPriceAge_;
        settleDelay = settleDelay_;
        emit ParamsSet();
    }

    function setCaps(uint128 defaultCap_, uint32[] calldata outcomes, uint128[] calldata caps) external onlyOwner {
        if (outcomes.length != caps.length) revert BadParams();
        defaultCap = defaultCap_;
        for (uint256 i; i < outcomes.length; ++i) {
            markets[outcomes[i]].cap = caps[i];
        }
        emit ParamsSet();
    }

    function setHalted(uint32 outcome, bool halted) external onlyOwner {
        markets[outcome].halted = halted;
        emit ParamsSet();
    }

    /// No new buys anywhere. Sales, settlement, the queue and withdrawals keep working.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit ParamsSet();
    }

    function setFeeWallet(address feeWallet_) external onlyOwner {
        if (feeWallet_ == address(0)) revert BadParams();
        feeWallet = feeWallet_;
        emit ParamsSet();
    }

    function setStakerRewardCap(uint256 cap) external onlyOwner {
        stakerRewardCap = cap;
        emit ParamsSet();
    }

    function enableTokenTransfers() external onlyOwner {
        token.enableTransfers();
    }

    /// A new signer takes over only after SIGNER_DELAY, so traders can leave first.
    function proposeSigner(address signer_) external onlyOwner {
        if (signer_ == address(0)) revert BadParams();
        pendingSigner = signer_;
        signerReadyAt = block.timestamp + SIGNER_DELAY;
        emit SignerProposed(signer_, signerReadyAt);
    }

    function applySigner() external onlyOwner {
        if (pendingSigner == address(0) || block.timestamp < signerReadyAt) revert TooEarly();
        signer = pendingSigner;
        pendingSigner = address(0);
        signerReadyAt = 0;
        emit SignerSet(signer);
    }

    function cancelSigner() external onlyOwner {
        pendingSigner = address(0);
        signerReadyAt = 0;
    }

    // ── views ────────────────────────────────────────────────────────────

    function positionOf(address user, uint32 outcome, uint8 side) external view returns (Position memory) {
        return _positions[user][_key(outcome, side)];
    }

    /// Every side the user has held, with what's held now (keys: outcome * 2 + side).
    function positionsOf(address user) external view returns (uint256[] memory keys, Position[] memory list) {
        keys = _keysOf[user];
        list = new Position[](keys.length);
        for (uint256 i; i < keys.length; ++i) {
            list[i] = _positions[user][keys[i]];
        }
    }

    function getRequest(uint256 id) external view returns (Request memory) {
        return _requests[id];
    }

    function requestsOf(address user) external view returns (uint256[] memory ids, Request[] memory list) {
        ids = _requestIdsOf[user];
        list = new Request[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            list[i] = _requests[ids[i]];
        }
    }

    function queueLength() external view returns (uint256) {
        return _queue.length - queueHead;
    }

    function queueAt(uint256 index) external view returns (Claim memory) {
        return _queue[index];
    }

    function poolState() external view returns (PoolState memory s) {
        s = PoolState({
            lpCash: lpCash, sideBucket: sideBucket, totalQueued: totalQueued, queueLength: _queue.length - queueHead,
            trackedLp: trackedLp, tailHighWater: tailHighWater, totalBalances: totalBalances, totalPending: totalPending,
            totalLocked: totalLocked, devFees: devFees, stakerFeeAcc: stakerFeeAcc, rewardsReserve: rewardsReserve,
            totalStaked: totalStaked, mintRate: mintRate(), paused: paused
        });
    }

    /// What the contract must hold: every balance, request, position's cost, fee and reward, and the pool's cash.
    function liabilities() public view returns (uint256) {
        return totalBalances + totalPending + totalLocked + lpCash + sideBucket + devFees + stakerFeeAcc + rewardsReserve;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ── internals ────────────────────────────────────────────────────────

    function _key(uint32 outcome, uint8 side) internal pure returns (uint256) {
        return uint256(outcome) * 2 + side;
    }

    function _checkSig(bytes32 structHash, bytes calldata sig) internal view {
        (address got, ECDSA.RecoverError err,) = ECDSA.tryRecover(_hashTypedDataV4(structHash), sig);
        if (err != ECDSA.RecoverError.NoError || got != signer) revert BadSignature();
    }
}
