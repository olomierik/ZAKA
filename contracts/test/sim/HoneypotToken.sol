// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// A deliberate honeypot, for checking the honeypot probe end to end
/// (engine/scripts/check-honeypot-probe.ts). Never deployed: its code
/// replaces a real coin's code inside one eth_call (state override), over
/// the coin's own storage. Storage layout is OpenZeppelin ERC20's (balances
/// at slot 0, allowances at 1, total supply at 2), so the real coin's
/// balances and its pool's reserves stay as they are.
///
/// MODE (set at compile time by the constructor-less constant):
///   the pool can pay buyers, but no one but the pool may send coins on:
///   a buyer can't pass them to another wallet, and can't sell them back.
contract HoneypotToken {
    mapping(address => uint256) private _balances; // slot 0
    mapping(address => mapping(address => uint256)) private _allowances; // slot 1
    uint256 private _totalSupply; // slot 2

    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error Blocked();

    function balanceOf(address a) external view returns (uint256) { return _balances[a]; }
    function totalSupply() external view returns (uint256) { return _totalSupply; }
    function decimals() external pure returns (uint8) { return 18; }
    function allowance(address o, address s) external view returns (uint256) { return _allowances[o][s]; }

    function approve(address s, uint256 v) external returns (bool) {
        _allowances[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        uint256 a = _allowances[from][msg.sender];
        if (a != type(uint256).max) _allowances[from][msg.sender] = a - v;
        _move(from, to, v);
        return true;
    }

    function _move(address from, address to, uint256 v) internal {
        // The trap: only the pool may send. Buying works; nothing else does.
        if (from != POOL_MANAGER) revert Blocked();
        _balances[from] -= v;
        _balances[to] += v;
        emit Transfer(from, to, v);
    }
}
