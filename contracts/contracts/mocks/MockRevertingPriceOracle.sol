// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockRevertingPriceOracle
/// @notice TEST-ONLY oracle whose reads always revert. Never deploy outside
/// tests: exercises the PixelOrbitShip fail-closed pricing path where any
/// oracle failure must fall back to the flat catalog price.
contract MockRevertingPriceOracle {
    function answer() external pure returns (int256) {
        revert("Oracle down");
    }

    function updatedAt() external pure returns (uint256) {
        revert("Oracle down");
    }
}
