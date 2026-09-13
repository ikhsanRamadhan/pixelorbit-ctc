// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {INativeQueryVerifier} from "./CanonicalInterfaces.sol";
import {EvmV1Decoder} from "./EvmV1Decoder.sol";
import "./OrbitStarsCC.sol";
import "../contracts/PixelOrbitLeaderboard.sol";

/// @title PixelOrbitASC
/// @notice Attestcoin Smart Contract on Creditcoin: verifies Sepolia lock
/// proofs via the canonical BlockProver precompile (0xFD2), decodes the proven
/// transaction via the linked EvmV1Decoder library, then mints Stars
/// and attests players.
/// @dev Binding matches the canonical SDK/reference ABIs: the single view
/// `verify` shape from `block_prover.json` plus the linked
/// `EvmV1Decoder.decodeTransactionType2` library call (inlined at compile
/// time, no external contract). The precompile interface is injected as an
/// ADDRESS (real 0xFD2 on CC3, mock in tests) — never hardcoded.
/// The external-decoder contract path was REMOVED as the live bug: the
/// reference EvmV1Decoder functions are `internal` (inlined), so calling them
/// as an external contract on the 57-byte 0x04B9…D18B artifact reverted every
/// call with empty data. This contract now links the vendored
/// `EvmV1Decoder.sol` library internally, mirroring the reference ASCMinter.
/// Permissionless like the reference ASCMinter (anyone may submit a valid
/// proof; the worker is UX-only). The execution key
/// keccak256(abi.encode(source, player, nonce)) is marked BEFORE external
/// calls (CEI) so no replay or reentrant path can double-mint. Scoped to
/// player because Source keys locks per-player and allows different players
/// to reuse the same nonce value; a global nonce key would strand the second
/// player's burned funds. Only ONE replay mechanism exists (this key); no
/// canonical queryId is recorded, to avoid two competing dedup keys.
/// Ship/Item addresses are staged via owner setters for future direct-bridge
/// mints; v1 only mints Stars and marks attested.
contract PixelOrbitASC is Ownable, ReentrancyGuard {
    /// @notice Selector of PixelOrbitSource.lock(uint256,uint256,address).
    bytes4 public constant LOCK_SELECTOR = bytes4(keccak256("lock(uint256,uint256,address)"));

    /// @notice Exact length of lock calldata: selector plus three 32-byte words.
    uint256 public constant LOCK_CALLDATA_LENGTH = 100;

    INativeQueryVerifier public immutable blockProver;
    address public immutable source;
    uint64 public immutable sourceChainKey;
    OrbitStarsCC public immutable starsCC;
    PixelOrbitLeaderboard public immutable leaderboard;

    /// @notice Staged game contracts for future direct-bridge mints (unused in v1).
    address public ship;
    address public item;

    /// @notice Executed bridge locks keyed by keccak256(abi.encode(source, player, nonce)),
    /// guarding against replay. Scoped to player because Source permits distinct
    /// players to lock with the same nonce value.
    mapping(bytes32 => bool) public executedLocks;

    /// @notice Maximum locks per executeBatch call. Bounds per-TX proving and
    /// event cost; the worker groups by source block capped at the same value.
    uint256 public constant MAX_BATCH_LOCKS = 10;

    event BridgeExecuted(
        address indexed player,
        address indexed recipient,
        uint256 amount,
        uint256 nonce
    );
    event BridgeBatchExecuted(uint256 index, bool success, bytes reason);
    event ShipUpdated(address ship);
    event ItemUpdated(address item);

    constructor(
        address _blockProver,
        address _source,
        uint64 _sourceChainKey,
        address _starsCC,
        address _leaderboard
    ) Ownable(msg.sender) {
        require(_blockProver != address(0), "BlockProver required");
        require(_source != address(0), "Source required");
        require(_sourceChainKey != 0, "Bad chainkey");
        require(_starsCC != address(0), "StarsCC required");
        require(_leaderboard != address(0), "Leaderboard required");
        blockProver = INativeQueryVerifier(_blockProver);
        source = _source;
        sourceChainKey = _sourceChainKey;
        starsCC = OrbitStarsCC(_starsCC);
        leaderboard = PixelOrbitLeaderboard(_leaderboard);
    }

    /// @notice Stage the Ship contract for future direct-bridge mints. No calls in v1.
    function setShip(address _ship) external onlyOwner {
        require(_ship != address(0), "Bad ship");
        ship = _ship;
        emit ShipUpdated(_ship);
    }

    /// @notice Stage the Item contract for future direct-bridge mints. No calls in v1.
    function setItem(address _item) external onlyOwner {
        require(_item != address(0), "Bad item");
        item = _item;
        emit ItemUpdated(_item);
    }

    /// @notice Verify a Sepolia lock proof and execute the bridge exactly once.
    /// @param action Action discriminator, reserved for future bridge actions (must be 0 in v1).
    /// @param chainKey Source chain key, must equal sourceChainKey (Sepolia).
    /// @param height Proven Sepolia block height.
    /// @param txBytes Proven transaction bytes, passed straight to the
    /// precompile verify and the linked decoder (decoder chunk = proven txBytes).
    /// @param root Merkle root of the proven block's transaction trie.
    /// @param siblings Merkle inclusion siblings for the proven transaction.
    /// @param digest Lower-endpoint digest of the continuity proof.
    /// @param roots Continuity roots shared with the proven block range.
    function execute(
        uint8 action,
        uint64 chainKey,
        uint64 height,
        bytes calldata txBytes,
        bytes32 root,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 digest,
        bytes32[] calldata roots
    ) external nonReentrant {
        require(action == 0, "Bad action");
        require(chainKey == sourceChainKey, "Wrong chain");
        {
            INativeQueryVerifier.MerkleProof memory merkleProof =
                INativeQueryVerifier.MerkleProof({root: root, siblings: siblings});
            INativeQueryVerifier.ContinuityProof memory continuityProof =
                INativeQueryVerifier.ContinuityProof({lowerEndpointDigest: digest, roots: roots});
            bool verified =
                blockProver.verify(chainKey, height, txBytes, merkleProof, continuityProof);
            require(verified, "Invalid proof");
        }
        // Linked-library decode via the external self-call below: the library
        // is inlined only into decodeForBatch, keeping this frame shallow.
        // A decode revert bubbles (single path must revert, unlike the batch).
        (EvmV1Decoder.CommonTxFields memory common,) = this.decodeForBatch(txBytes);
        (bytes memory reason, address player, uint256 amount, uint256 nonce, address recipient) =
            _validateLock(common);
        require(reason.length == 0, string(reason));
        bytes32 key = keccak256(abi.encode(source, player, nonce));
        require(!executedLocks[key], "Nonce used");
        executedLocks[key] = true;
        starsCC.mint(recipient, amount);
        leaderboard.markAttested(recipient);
        emit BridgeExecuted(player, recipient, amount, nonce);
    }

    /// @notice Verify up to MAX_BATCH_LOCKS Sepolia locks sharing one
    /// continuity proof, executing each successful lock exactly like execute.
    /// @dev Entry shape mirrors the precompile batch verify (parallel heights
    /// / txBytes / Merkle proofs plus one shared continuity proof, prefixed
    /// with the v1 action discriminator), but verification fans out to one
    /// single-verify per lock so each lock keeps per-index isolation: every
    /// failure mode of execute (prover false, decoder revert, wrong source,
    /// bad value/calldata/selector, zero player/amount, bad recipient,
    /// replayed nonce) becomes a success=false event and NEVER reverts the
    /// batch. Only the linked-library decode (via the external self-call
    /// below) is try/catch-isolated; the remaining checks run through the
    /// same _validateLock helper as execute, so single-revert strings and
    /// batch-event reasons are identical by construction. StarsCC.mint /
    /// Leaderboard.markAttested are deliberately NOT try/catch-wrapped:
    /// executedLocks is marked BEFORE those externals (CEI, exactly like
    /// execute), so catching their revert would strand the lock as
    /// marked-but-unminted with no retry path. Those externals have no
    /// per-lock failure mode — they revert only on systemic misconfiguration
    /// (wrong minter/ASC wiring), which fails every index equally. Such a
    /// revert rolls back the WHOLE batch INCLUDING prior executedLocks marks,
    /// so retry after fixing the misconfiguration is safe.
    function executeBatch(
        uint8 action,
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata txBytesArray,
        INativeQueryVerifier.MerkleProof[] calldata merkleProofs,
        bytes32 digest,
        bytes32[] calldata continuityRoots
    ) external nonReentrant {
        require(action == 0, "Bad action");
        uint256 count = txBytesArray.length;
        require(count == heights.length && count == merkleProofs.length, "Length mismatch");
        require(count > 0, "No locks");
        require(count <= MAX_BATCH_LOCKS, "Too many locks");
        require(chainKey == sourceChainKey, "Wrong chain");
        for (uint256 i = 0; i < count; ) {
            _executeBatchLock(
                heights[i],
                txBytesArray[i],
                merkleProofs[i].root,
                merkleProofs[i].siblings,
                digest,
                continuityRoots,
                i
            );
            unchecked {
                ++i;
            }
        }
    }

    /// @notice External decode wrapper for linked-library decoding.
    /// @dev Calls the linked EvmV1Decoder library INTERNALLY and exposes the
    /// result as an external self-call so the library is inlined only here
    /// (avoids stack-too-deep in execute) and so executeBatch can try/catch
    /// per-lock decode failures without reverting the whole batch. The single
    /// execute path calls this wrapper directly (revert bubbles). No external
    /// decoder contract exists.
    function decodeForBatch(bytes calldata txBytes)
        external
        pure
        returns (
            EvmV1Decoder.CommonTxFields memory common,
            EvmV1Decoder.ReceiptFields memory receipt
        )
    {
        EvmV1Decoder.DecodedTransactionType2 memory decoded =
            EvmV1Decoder.decodeTransactionType2(txBytes);
        return (decoded.commonTx, decoded.receipt);
    }

    /// @dev Execute one batch lock without reverting: every failure mode of
    /// execute becomes a success=false event carrying the same reason string
    /// the single path would revert with.
    function _executeBatchLock(
        uint64 height,
        bytes calldata txBytes,
        bytes32 root,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 digest,
        bytes32[] calldata continuityRoots,
        uint256 index
    ) private {
        INativeQueryVerifier.MerkleProof memory merkleProof =
            INativeQueryVerifier.MerkleProof({root: root, siblings: siblings});
        INativeQueryVerifier.ContinuityProof memory continuityProof =
            INativeQueryVerifier.ContinuityProof({
                lowerEndpointDigest: digest,
                roots: continuityRoots
            });
        // The precompile is queried with the ambient chainKey: executeBatch
        // already enforced chainKey == sourceChainKey above.
        bool verified =
            blockProver.verify(sourceChainKey, height, txBytes, merkleProof, continuityProof);
        if (!verified) {
            emit BridgeBatchExecuted(index, false, bytes("Invalid proof"));
            return;
        }
        EvmV1Decoder.CommonTxFields memory common;
        try this.decodeForBatch(txBytes) returns (
            EvmV1Decoder.CommonTxFields memory decoded,
            EvmV1Decoder.ReceiptFields memory
        ) {
            common = decoded;
        } catch (bytes memory decodeReason) {
            emit BridgeBatchExecuted(index, false, decodeReason);
            return;
        }
        (bytes memory reason, address player, uint256 amount, uint256 nonce, address recipient) =
            _validateLock(common);
        if (reason.length != 0) {
            emit BridgeBatchExecuted(index, false, reason);
            return;
        }
        bytes32 key = keccak256(abi.encode(source, player, nonce));
        if (executedLocks[key]) {
            emit BridgeBatchExecuted(index, false, bytes("Nonce used"));
            return;
        }
        executedLocks[key] = true;
        starsCC.mint(recipient, amount);
        leaderboard.markAttested(recipient);
        emit BridgeBatchExecuted(index, true, "");
    }

    /// @notice Validate decoded lock fields shared by execute and executeBatch.
    /// @dev Returns an empty reason on success; otherwise the exact revert
    /// string the single path reports. Checks run in field-availability order:
    /// proven-target binding, then calldata shape, then decoded economics.
    /// @return reason Empty on success, else the failure string.
    /// @return player Proven sender (commonTx.from), the Sepolia locker.
    /// @return amount Decoded lock amount in wei.
    /// @return nonce Decoded player-chosen lock nonce.
    /// @return recipient Decoded Creditcoin recipient.
    function _validateLock(EvmV1Decoder.CommonTxFields memory common)
        private
        view
        returns (
            bytes memory reason,
            address player,
            uint256 amount,
            uint256 nonce,
            address recipient
        )
    {
        if (common.to != source) {
            return (bytes("Wrong source"), address(0), 0, 0, address(0));
        }
        if (common.value != 0) {
            return (bytes("Bad value"), address(0), 0, 0, address(0));
        }
        bytes memory data = common.data;
        if (data.length != LOCK_CALLDATA_LENGTH) {
            return (bytes("Bad calldata"), address(0), 0, 0, address(0));
        }
        bytes4 selector;
        assembly {
            selector := mload(add(data, 32))
        }
        if (selector != LOCK_SELECTOR) {
            return (bytes("Bad selector"), address(0), 0, 0, address(0));
        }
        bytes memory args = new bytes(96);
        assembly {
            mstore(add(args, 32), mload(add(data, 36)))
            mstore(add(args, 64), mload(add(data, 68)))
            mstore(add(args, 96), mload(add(data, 100)))
        }
        (uint256 decodedAmount, uint256 decodedNonce, address decodedRecipient) =
            abi.decode(args, (uint256, uint256, address));
        if (common.from == address(0)) {
            return (bytes("Invalid player"), address(0), 0, 0, address(0));
        }
        if (decodedAmount == 0) {
            return (bytes("Zero amount"), address(0), 0, 0, address(0));
        }
        if (decodedRecipient == address(0)) {
            return (bytes("Bad recipient"), address(0), 0, 0, address(0));
        }
        return (bytes(""), common.from, decodedAmount, decodedNonce, decodedRecipient);
    }
}
