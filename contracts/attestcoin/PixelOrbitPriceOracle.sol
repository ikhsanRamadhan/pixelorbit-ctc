// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import {INativeQueryVerifier} from "./CanonicalInterfaces.sol";
import {EvmV1Decoder} from "./EvmV1Decoder.sol";

/// @title PixelOrbitPriceOracle
/// @notice Attested Chainlink Sepolia ETH/USD relay with an owner-updatable
/// emitter allowlist. The AnswerUpdated event is emitted by the AGGREGATOR
/// contract, not the proxy, and the aggregator rotates — so proving only the
/// proxy would brick the oracle on rotation. The allowlist starts with the
/// proxy and the owner adds/removes aggregators via setFeedEmitter.
/// @dev Binding matches the canonical SDK/reference ABIs: the single view
/// `verify` shape from `block_prover.json` plus the linked
/// `EvmV1Decoder.decodeTransactionType2` library call (inlined at compile
/// time, no external contract).
/// PRICE DECODE PATH (documented choice): receipt logs. The linked decoder
/// returns the proven receipt alongside the common tx fields, so the oracle
/// scans receiptLogs for the first AnswerUpdated(int256,uint256,uint256) log
/// and reads answer/roundId from its indexed topics and updatedAt from its
/// data. The transmit-calldata path is NOT used: OCR report decoding is
/// outside what the decoder supports directly, while the receipt log carries
/// the finalized answer verbatim. The precompile interface is injected as an
/// ADDRESS (real 0xFD2 on CC3, mock in tests) — never hardcoded.
/// The external-decoder contract path was REMOVED as the live bug: the
/// reference EvmV1Decoder functions are `internal` (inlined), so calling them
/// as an external contract on the 57-byte 0x04B9…D18B artifact reverted every
/// call with empty data. This contract now links the vendored
/// `EvmV1Decoder.sol` library internally, mirroring the reference pattern.
/// Honesty: Stars has no market price. This oracle is a verified
/// third-party data relay plus a liveness-gated flash-sale switch for
/// PixelOrbitShip (sale ends if the feed goes stale) — never a Stars/USD rate.
/// Constructor takes the BlockProver ADDRESS (real 0xFD2 on CC3, mock in
/// tests) — never hardcoded.
contract PixelOrbitPriceOracle is Ownable {
    /// @notice AnswerUpdated(int256,uint256,uint256) event signature.
    bytes32 public constant ANSWER_UPDATED_SIG =
        keccak256("AnswerUpdated(int256,uint256,uint256)");

    INativeQueryVerifier public immutable blockProver;
    uint64 public immutable sourceChainKey;

    /// @notice Allowlisted AnswerUpdated emitters (proxy + current aggregators).
    mapping(address => bool) public feedEmitters;

    /// @notice Latest attested price state (answer: 8-decimal ETH/USD).
    int256 public answer;
    uint256 public updatedAt;
    uint256 public roundId;

    event PriceFeedUpdated(address indexed emitter, bool allowed);
    event PriceUpdated(int256 answer, uint256 roundId, uint256 updatedAt);

    constructor(
        address _blockProver,
        uint64 _sourceChainKey,
        address _initialEmitter
    ) Ownable(msg.sender) {
        require(_blockProver != address(0), "BlockProver required");
        require(_sourceChainKey != 0, "Bad chainkey");
        require(_initialEmitter != address(0), "Emitter required");
        blockProver = INativeQueryVerifier(_blockProver);
        sourceChainKey = _sourceChainKey;
        feedEmitters[_initialEmitter] = true;
        emit PriceFeedUpdated(_initialEmitter, true);
    }

    /// @notice Add or remove an AnswerUpdated emitter (aggregator rotation).
    /// @dev Owner-trust: the owner can allowlist ANY emitter, and allowlisted
    /// emitters gate the PixelOrbitShip flash-sale discount — a malicious or
    /// compromised emitter approval can switch the sale on/off. Use a
    /// multisig/timelock owner and monitor PriceFeedUpdated events.
    function setFeedEmitter(address emitter, bool allowed) external onlyOwner {
        require(emitter != address(0), "Bad emitter");
        feedEmitters[emitter] = allowed;
        emit PriceFeedUpdated(emitter, allowed);
    }

    /// @notice External decode wrapper for linked-library decoding.
    /// @dev Calls the linked EvmV1Decoder library INTERNALLY and exposes the
    /// receipt as an external self-call so the library is inlined only here
    /// (avoids stack-too-deep in updatePrice). No external decoder contract.
    /// @param txBytes Proven transaction bytes to decode.
    function decodeReceipt(bytes calldata txBytes)
        external
        pure
        returns (EvmV1Decoder.ReceiptFields memory receipt)
    {
        EvmV1Decoder.DecodedTransactionType2 memory decoded =
            EvmV1Decoder.decodeTransactionType2(txBytes);
        return decoded.receipt;
    }

    /// @notice Verify a Sepolia AnswerUpdated proof and store the price.
    /// @param action Action discriminator, reserved for future oracle actions (must be 0 in v1).
    /// @param chainKey Source chain key, must equal sourceChainKey (Sepolia).
    /// @param height Proven Sepolia block height.
    /// @param txBytes Proven transaction bytes, passed straight to the
    /// precompile verify and the linked decoder (decoder chunk = proven txBytes).
    /// @param root Merkle root of the proven block's transaction trie.
    /// @param siblings Merkle inclusion siblings for the proven transaction.
    /// @param digest Lower-endpoint digest of the continuity proof.
    /// @param roots Continuity roots shared with the proven block range.
    function updatePrice(
        uint8 action,
        uint64 chainKey,
        uint64 height,
        bytes calldata txBytes,
        bytes32 root,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 digest,
        bytes32[] calldata roots
    ) external {
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
        EvmV1Decoder.ReceiptFields memory receipt = this.decodeReceipt(txBytes);
        uint256 matchIndex = type(uint256).max;
        for (uint256 i = 0; i < receipt.receiptLogs.length; ) {
            EvmV1Decoder.LogEntry memory log = receipt.receiptLogs[i];
            if (log.topics.length > 0 && log.topics[0] == ANSWER_UPDATED_SIG) {
                matchIndex = i;
                break;
            }
            unchecked {
                ++i;
            }
        }
        require(matchIndex != type(uint256).max, "No answer");
        EvmV1Decoder.LogEntry memory matched = receipt.receiptLogs[matchIndex];
        require(feedEmitters[matched.address_], "Unknown emitter");
        require(matched.topics.length == 3, "Bad answer");
        int256 newAnswer = int256(uint256(matched.topics[1]));
        require(newAnswer > 0, "Bad answer");
        uint256 newRoundId = uint256(matched.topics[2]);
        require(matched.data.length == 32, "Bad timestamp");
        uint256 newUpdatedAt = abi.decode(matched.data, (uint256));
        require(newUpdatedAt != 0, "Bad timestamp");
        require(newRoundId > roundId, "Stale round");
        answer = newAnswer;
        updatedAt = newUpdatedAt;
        roundId = newRoundId;
        emit PriceUpdated(newAnswer, newRoundId, newUpdatedAt);
    }
}
