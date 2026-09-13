// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title Orbit Stars Sepolia
/// @notice Source-chain Stars token for the PixelOrbit Attestcoin bridge.
/// @dev Owner mints test Stars to players on Sepolia. Locked Stars are burned
/// by PixelOrbitSource, so this is a one-way bridge with no refund path.
contract StarsSepolia is ERC20, ERC20Burnable, Ownable {
    constructor() ERC20("Orbit Stars Sepolia", "STARS") Ownable(msg.sender) {}

    /// @notice Mint Stars to a player. Owner-only (faucet-style issuance).
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
