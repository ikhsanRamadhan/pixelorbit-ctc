// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title Orbit Stars (Creditcoin)
/// @notice Game Stars token on Creditcoin CC3.
/// @dev The ONLY way Stars come into existence on Creditcoin is a mint by the
/// minter (PixelOrbitASC after a verified Sepolia lock). Setting minter to the
/// zero address pauses all minting; the owner can always rotate to a new ASC.
contract OrbitStarsCC is ERC20, Ownable {
    address public minter;

    event MinterUpdated(address minter);

    constructor() ERC20("Orbit Stars", "STARS") Ownable(msg.sender) {}

    /// @notice Point mint authority at the ASC (or zero to pause minting).
    function setMinter(address _minter) external onlyOwner {
        minter = _minter;
        emit MinterUpdated(_minter);
    }

    /// @notice Mint Stars. Only the ASC minter may call.
    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "Only minter");
        _mint(to, amount);
    }
}
