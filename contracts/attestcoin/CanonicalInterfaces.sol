// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title INativeQueryVerifier
/// @notice Minimal binding of the canonical Native Query Verifier precompile at
/// 0x0000000000000000000000000000000000000FD2 (4050).
/// @dev Struct layouts and the two view `verify` signatures are copied
/// VERBATIM from the canonical ABI (gluwa usc-sdk
/// `dist/block-prover/block_prover.json`, `INativeQueryVerifier.MerkleProof`
/// / `ContinuityProof`). Only the members this bridge uses are vendored:
/// `calculateTxIndex`, `verifyAndEmit`, and the `TransactionVerified` event
/// are intentionally omitted. Live CC3 retry remains to prove the binding
/// end to end.
interface INativeQueryVerifier {
    struct MerkleProofEntry {
        bytes32 hash;
        bool isLeft;
    }

    struct MerkleProof {
        bytes32 root;
        MerkleProofEntry[] siblings;
    }

    struct ContinuityProof {
        bytes32 lowerEndpointDigest;
        bytes32[] roots;
    }

    /// @notice Verify a single transaction inclusion plus continuity (read-only).
    function verify(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external view returns (bool);

    /// @notice Verify a batch sharing one continuity proof (read-only).
    function verify(
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata encodedTransactions,
        MerkleProof[] calldata merkleProofs,
        ContinuityProof calldata sharedContinuityProof
    ) external view returns (bool);
}


