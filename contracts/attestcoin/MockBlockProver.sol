// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {INativeQueryVerifier} from "./CanonicalInterfaces.sol";

/// @title MockBlockProver
/// @notice TEST-ONLY mock of the canonical BlockProver precompile binding
/// (0xFD2). Never deploy outside tests: it returns operator-set booleans
/// instead of verifying anything.
/// @dev Mirrors the vendored INativeQueryVerifier single AND batch view
/// `verify` shapes (bool out, never reverts on proof content) so tests
/// exercise the real ASC/oracle proof path: per-tx outcomes are keyed by
/// keccak256(txBytes), defaulting to the programmed default. Length mismatch
/// in the batch shape reverts exactly like the precompile would.
contract MockBlockProver is INativeQueryVerifier {
    bool public defaultResult = true;
    mapping(bytes32 => bool) public configured;
    mapping(bytes32 => bool) public results;

    /// @notice Program the default verify outcome (anyone may call: test-only).
    function setResult(bool ok) external {
        defaultResult = ok;
    }

    /// @notice Program the verify outcome for one txBytes value
    /// (anyone may call: test-only). Overrides the default for that tx only.
    function setResultForTx(bytes calldata txBytes, bool ok) external {
        bytes32 key = keccak256(txBytes);
        configured[key] = true;
        results[key] = ok;
    }

    /// @inheritdoc INativeQueryVerifier
    function verify(
        uint64,
        uint64,
        bytes calldata encodedTransaction,
        MerkleProof calldata,
        ContinuityProof calldata
    ) external view returns (bool) {
        return _resultFor(encodedTransaction);
    }

    /// @inheritdoc INativeQueryVerifier
    function verify(
        uint64,
        uint64[] calldata heights,
        bytes[] calldata encodedTransactions,
        MerkleProof[] calldata merkleProofs,
        ContinuityProof calldata
    ) external view returns (bool) {
        require(
            heights.length == encodedTransactions.length
                && encodedTransactions.length == merkleProofs.length,
            "Length mismatch"
        );
        for (uint256 i = 0; i < encodedTransactions.length; ) {
            if (!_resultFor(encodedTransactions[i])) {
                return false;
            }
            unchecked {
                ++i;
            }
        }
        return true;
    }

    function _resultFor(bytes calldata txBytes) private view returns (bool) {
        bytes32 key = keccak256(txBytes);
        if (configured[key]) {
            return results[key];
        }
        return defaultResult;
    }
}


