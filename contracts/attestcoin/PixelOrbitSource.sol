// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./StarsSepolia.sol";

/// @title PixelOrbitSource
/// @notice Sepolia source contract for the PixelOrbit Attestcoin bridge.
/// @dev Players approve Stars then call lock(). Stars are pulled in and BURNED
/// (one-way bridge, no refund path by design). Each lock emits StarsLocked,
/// which the offchain worker proves to PixelOrbitASC on Creditcoin.
/// The event signature is frozen: ASC decoding depends on it.
contract PixelOrbitSource {
    StarsSepolia public immutable stars;

    /// @notice Spent lock nonces per player, guarding lock() against replay.
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    event StarsLocked(
        address indexed player,
        uint256 amount,
        uint256 indexed nonce,
        address creditcoinRecipient
    );

    constructor(address _stars) {
        require(_stars != address(0), "Stars required");
        stars = StarsSepolia(_stars);
    }

    /// @notice Lock Stars for bridging: pull via transferFrom, burn, emit.
    /// @param amount Stars amount (wei, 18 decimals), must be nonzero.
    /// @param nonce Player-chosen fresh nonce for this lock.
    /// @param creditcoinRecipient Address credited on Creditcoin, must be nonzero.
    function lock(uint256 amount, uint256 nonce, address creditcoinRecipient) external {
        require(amount > 0, "Zero amount");
        require(creditcoinRecipient != address(0), "Bad recipient");
        require(!usedNonces[msg.sender][nonce], "Nonce used");
        usedNonces[msg.sender][nonce] = true;
        require(stars.transferFrom(msg.sender, address(this), amount), "Lock failed");
        stars.burn(amount);
        emit StarsLocked(msg.sender, amount, nonce, creditcoinRecipient);
    }
}
