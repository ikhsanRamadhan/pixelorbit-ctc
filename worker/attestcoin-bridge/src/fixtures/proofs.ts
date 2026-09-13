import type { proofProvider } from "@gluwa/usc-sdk";

// Recorded fixture shapes mirroring the proof-builder responses documented in
// @gluwa/usc-sdk (ProofBuilder.getProof / getBatchProof docblocks) and consumed
// by attestcoin-protocol-examples/shared/utils (chainKey, headerNumber, txBytes,
// merkleProof.root, merkleProof.siblings[{hash,isLeft}],
// continuityProof.lowerEndpointDigest, continuityProof.roots).
// Values are synthetic but well-formed; unit tests must never hit live networks.

const HEX_32 = (seed: string): string => `0x${seed.repeat(32).slice(0, 64)}`;

export const singleProofResponse: proofProvider.ContinuityResponse = {
  chainKey: 1,
  headerNumber: 9100,
  txIndex: 3,
  txHash: HEX_32("aa"),
  txBytes: `0x${"f8".repeat(64)}`,
  continuityProof: {
    lowerEndpointDigest: HEX_32("11"),
    roots: [HEX_32("22"), HEX_32("33")],
  },
  merkleProof: {
    root: HEX_32("44"),
    siblings: [
      { hash: HEX_32("55"), isLeft: true },
      { hash: HEX_32("66"), isLeft: false },
    ],
  },
  cached: false,
  generatedAt: new Date("2026-09-11T00:00:00.000Z"),
};

export const batchProofResponse: proofProvider.BatchContinuityResponse = {
  chainKey: 1,
  fromHeader: 9100,
  toHeader: 9101,
  continuityProof: {
    lowerEndpointDigest: HEX_32("11"),
    roots: [HEX_32("22"), HEX_32("33"), HEX_32("77")],
  },
  merkleProofs: new Map<number, Map<number, proofProvider.BatchMerkleProofEntry>>([
    [
      9100,
      new Map([
        [
          3,
          {
            txHash: HEX_32("aa"),
            txBytes: `0x${"f8".repeat(64)}`,
            merkleProof: {
              root: HEX_32("44"),
              siblings: [{ hash: HEX_32("55"), isLeft: true }],
            },
          },
        ],
      ]),
    ],
    [
      9101,
      new Map([
        [
          0,
          {
            txHash: HEX_32("bb"),
            txBytes: `0x${"e8".repeat(64)}`,
            merkleProof: {
              root: HEX_32("88"),
              siblings: [{ hash: HEX_32("99"), isLeft: false }],
            },
          },
        ],
      ]),
    ],
  ]),
  cached: false,
  generatedAt: new Date("2026-09-11T00:00:00.000Z"),
};
