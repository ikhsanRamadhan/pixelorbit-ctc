import { proofProvider } from "@gluwa/usc-sdk";
import { decodeFunctionResult, encodeFunctionData, isHex, type Hex } from "viem";

// Canonical pass-through shape for PixelOrbitASC.execute / executeBatch and
// PixelOrbitPriceOracle.updatePrice. The worker passes prover fields straight
// to the contract, which calls the 0xFD2 precompile verify itself. No tuple
// ABI-encoding happens here: txBytes stays raw hex, merkleProof keeps
// root/siblings, continuityProof keeps lowerEndpointDigest/roots.
//
// Domain choice: chainKey and height stay as numbers (not bigint) because the
// proof-builder SDK takes JS numbers (see createProofBuilder) and JSON
// round-trips numbers cleanly; the submitter/index layer converts number ->
// bigint via BigInt(chainKey)/BigInt(height) at the viem uint64 encode
// boundary. Precision is protected by requireUint64 guards below: only safe
// integers within uint64 range are accepted, so the BigInt() conversion is
// exact and never narrows.
export interface MerkleSibling {
  hash: Hex;
  isLeft: boolean;
}

export interface AttestationProofInput {
  chainKey: number;
  height: number;
  txBytes: Hex;
  root: Hex;
  siblings: MerkleSibling[];
  digest: Hex;
  roots: Hex[];
}

// Structural ports so unit tests can inject fakes. The real SDK classes satisfy
// these: proofProvider.service.ProofBuilder implements ProofBuilderPort, and
// createChainInfoPort builds a ChainInfoPort over the 0xFD3 precompile.
export type AttestationHeight = number | bigint;

export interface ProofBuilderPort {
  waitUntilHeightAttested(
    chainKey: number,
    targetHeight: AttestationHeight,
    pollIntervalMs?: number,
    waitTimeoutMs?: number,
  ): Promise<void>;
  getProof(transactionHash: string): Promise<proofProvider.ProofResult>;
  getBatchProof(transactionHashes: string[]): Promise<proofProvider.BatchProofResult>;
}

export interface ChainInfoPort {
  isHeightAttested(chainKey: number, targetHeight: AttestationHeight): Promise<boolean>;
  getLatestAttestedHeight(chainKey: number): Promise<{ height: bigint; exists: boolean }>;
}

export function createProofBuilder(chainKey: number, builderUrl: string): ProofBuilderPort {
  const inner = new proofProvider.service.ProofBuilder(chainKey, builderUrl);
  // The SDK expects a JS number height; the worker pipeline keeps heights as
  // bigint and only narrows at this SDK boundary.
  return {
    waitUntilHeightAttested: (c: number, h: AttestationHeight, poll?: number, timeout?: number) =>
      inner.waitUntilHeightAttested(c, typeof h === "bigint" ? Number(h) : h, poll, timeout),
    getProof: (tx: string) => inner.getProof(tx),
    getBatchProof: (txs: string[]) => inner.getBatchProof(txs),
  };
}

// The ChainInfo precompile address from the SDK (CHAIN_INFO_PRECOMPILE_ADDRESS).
export const CHAIN_INFO_PRECOMPILE_ADDRESS = "0x0000000000000000000000000000000000000fd3";

// Mirrored read-only fragment of the SDK's own chain_info.json ABI
// (node_modules/@gluwa/usc-sdk/dist/chain-info/chain_info.json). The worker
// does NOT depend on ethers (only @gluwa/usc-sdk + viem), so it cannot
// instantiate the SDK's PrecompileChainInfoProvider (ethers-based). Instead it
// calls the same precompile functions with the same names via viem eth_call.
// Any selector drift versus the SDK ABI is a Task-10 live-verification item.
const chainInfoAbi = [
  {
    type: "function",
    name: "is_height_attested",
    inputs: [
      { name: "chainKey", type: "uint64" },
      { name: "targetHeight", type: "uint64" },
    ],
    outputs: [{ name: "isAttested", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "get_latest_attestation_height_and_hash",
    inputs: [{ name: "chainKey", type: "uint64" }],
    outputs: [
      {
        name: "result",
        type: "tuple",
        components: [
          { name: "height", type: "uint64" },
          { name: "hash", type: "bytes32" },
          { name: "isAttestation", type: "bool" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
] as const;

export function createChainInfoPort(
  call: (to: string, data: Hex) => Promise<Hex>,
): ChainInfoPort {
  return {
    async isHeightAttested(chainKey: number, targetHeight: number): Promise<boolean> {
      const data = encodeFunctionData({
        abi: chainInfoAbi,
        functionName: "is_height_attested",
        args: [BigInt(chainKey), BigInt(targetHeight)],
      });
      const raw = await call(CHAIN_INFO_PRECOMPILE_ADDRESS, data);
      const result = decodeFunctionResult({
        abi: chainInfoAbi,
        functionName: "is_height_attested",
        data: raw,
      });
      return result === true;
    },
    async getLatestAttestedHeight(chainKey: number): Promise<{ height: bigint; exists: boolean }> {
      const data = encodeFunctionData({
        abi: chainInfoAbi,
        functionName: "get_latest_attestation_height_and_hash",
        args: [BigInt(chainKey)],
      });
      const raw = await call(CHAIN_INFO_PRECOMPILE_ADDRESS, data);
      const result = decodeFunctionResult({
        abi: chainInfoAbi,
        functionName: "get_latest_attestation_height_and_hash",
        data: raw,
      }) as unknown as { height: bigint; exists: boolean };
      return { height: result.height, exists: result.exists };
    },
  };
}

function requireBytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length !== 66) {
    throw new Error(`Invalid proof ${label}: expected 32-byte hex`);
  }
  return value;
}

// uint64 ceiling (2^64 - 1) for the contract ABI. In practice the
// Number.isSafeInteger check below (2^53 - 1) binds first for the number
// domain; the explicit uint64 bound documents the onchain range and stays
// correct if the domain ever migrates to bigint.
const UINT64_MAX = 18446744073709551615n;

// Guard the number-domain uint64 fields (chainKey, height): accept only safe
// integers inside uint64 range so the later BigInt() encode conversion is
// exact. Rejects fractional, unsafe (> 2^53-1), negative, and huge values
// with an error naming the field.
function requireUint64Number(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid proof ${field}: expected a safe integer, got ${String(value)}`);
  }
  if (value < min) {
    throw new Error(`Invalid proof ${field}: must be >= ${min}, got ${value}`);
  }
  if (BigInt(value) > UINT64_MAX) {
    throw new Error(`Invalid proof ${field}: exceeds uint64 range, got ${value}`);
  }
  return value;
}

function requireHexBytes(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHex(value)) {
    throw new Error(`Invalid proof ${label}: expected 0x hex bytes`);
  }
  return value;
}

function narrowSiblings(value: unknown): MerkleSibling[] {
  if (!Array.isArray(value)) throw new Error("Invalid proof siblings: expected an array");
  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Invalid proof sibling: expected {hash,isLeft}");
    }
    const record = entry as Record<string, unknown>;
    return { hash: requireBytes32(record["hash"], "sibling.hash"), isLeft: record["isLeft"] === true };
  });
}

// Canonical adapter: pass prover fields straight through to
// PixelOrbitASC.execute / executeBatch and PixelOrbitPriceOracle.updatePrice.
// The contract calls the 0xFD2 precompile verify itself, so the worker must
// NOT ABI-encode tuples. Sibling order (hash, isLeft) mirrors the canonical
// INativeQueryVerifier.MerkleProofEntry layout. DO NOT silently change mapping.
export function adaptProof(response: proofProvider.ContinuityResponse): AttestationProofInput {
  const chainKey = requireUint64Number(response.chainKey, "chainKey", 1);
  const height = requireUint64Number(response.headerNumber, "headerNumber", 0);
  const root = requireBytes32(response.merkleProof?.root, "merkleProof.root");
  const siblings = narrowSiblings(response.merkleProof?.siblings);
  const digest = requireBytes32(
    response.continuityProof?.lowerEndpointDigest,
    "continuityProof.lowerEndpointDigest",
  );
  const roots = Array.isArray(response.continuityProof?.roots)
    ? (response.continuityProof.roots as unknown[]).map((r) => requireBytes32(r, "continuityProof.roots[]"))
    : [];
  const txBytes = requireHexBytes(response.txBytes, "txBytes");
  return {
    chainKey,
    height,
    txBytes,
    root,
    siblings,
    digest,
    roots,
  };
}

type BatchMerkleMaps =
  | Map<number, Map<number, proofProvider.BatchMerkleProofEntry>>
  | Record<string, Record<string, proofProvider.BatchMerkleProofEntry>>;

// BatchContinuityResponse carries ONE shared continuityProof for many txs
// (keyed merkleProofs[height][txIndex]). Over HTTP the nested Maps arrive as
// plain objects, so both forms are accepted. Each adapted proof keeps its
// source txHash so the worker can pair proofs back to locks.
export interface BatchAdaptedProof extends AttestationProofInput {
  txHash: string;
}

export function adaptBatchProof(
  batch: proofProvider.BatchContinuityResponse,
): BatchAdaptedProof[] {
  const chainKey = requireUint64Number(batch.chainKey, "chainKey", 1);
  const continuity = batch.continuityProof as proofProvider.ContinuityProof;
  const digest = requireBytes32(
    continuity?.lowerEndpointDigest,
    "continuityProof.lowerEndpointDigest",
  );
  const roots = Array.isArray(continuity?.roots)
    ? (continuity.roots as unknown[]).map((r) => requireBytes32(r, "continuityProof.roots[]"))
    : [];
  const proofs: BatchAdaptedProof[] = [];
  const maps = batch.merkleProofs as BatchMerkleMaps;
  const heightEntries: [string, unknown][] =
    maps instanceof Map
      ? [...maps.entries()].map(([h, v]) => [String(h), v])
      : Object.entries(maps ?? {});
  for (const [heightKey, perTx] of heightEntries) {
    const height = requireUint64Number(Number(heightKey), "height", 0);
    const txEntries: [string, unknown][] =
      perTx instanceof Map ? [...perTx.entries()].map(([i, v]) => [String(i), v]) : Object.entries(perTx ?? {});
    for (const [, entry] of txEntries) {
      const record = entry as proofProvider.BatchMerkleProofEntry;
      const entryTxHash = requireHexBytes(record?.txHash, "txHash");
      const root = requireBytes32(record?.merkleProof?.root, "merkleProof.root");
      const siblings = narrowSiblings(record?.merkleProof?.siblings);
      const txBytes = requireHexBytes(record?.txBytes, "txBytes");
      proofs.push({
        txHash: entryTxHash,
        chainKey,
        height,
        txBytes,
        root,
        siblings,
        digest,
        roots: [...roots],
      });
    }
  }
  return proofs;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Wait until a source height is provable: first the on-chain ChainInfo
// precompile (when a reader is provided), then the proof-builder service cache
// (required per SDK docs before requesting proofs). Heights stay as bigint
// through the pipeline; only the SDK boundary narrows to number.
export async function waitForAttestation(args: {
  chainKey: number;
  blockHeight: AttestationHeight;
  proofBuilder: ProofBuilderPort;
  chainInfo?: ChainInfoPort;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const pollIntervalMs = args.pollIntervalMs ?? 15000;
  const timeoutMs = args.timeoutMs ?? 1200000;
  const sleep = args.sleep ?? defaultSleep;
  if (args.chainInfo !== undefined) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await args.chainInfo.isHeightAttested(args.chainKey, args.blockHeight)) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `Height ${args.blockHeight.toString()} not attested on chain key ${args.chainKey} within ${timeoutMs}ms`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }
  await args.proofBuilder.waitUntilHeightAttested(
    args.chainKey,
    args.blockHeight,
    pollIntervalMs,
    timeoutMs,
  );
}
