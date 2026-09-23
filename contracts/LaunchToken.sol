// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @notice Fixed-supply token minted entirely to ArcLaunchpad (95%) and the
/// platform fee wallet (5%) at creation. No owner, no mint function, no way
/// to change supply after deployment. Burnable so the platform can manually
/// buy back its own token with accumulated fees and burn it — the only
/// "buyback" mechanism ArcLaunchpad needs; there is no on-contract treasury.
contract LaunchToken is ERC20, ERC20Burnable {
    constructor(string memory name_, string memory symbol_, uint256 totalSupply_, address launchpad)
        ERC20(name_, symbol_)
    {
        _mint(launchpad, totalSupply_);
    }
}
