import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  toFunctionSelector,
  toEventSelector,
  keccak256,
  toHex,
  type Hex,
} from "viem";
import { loadConfig } from "./config.js";
import {
  parseStarsLockedLog,
  groupLocksForBatch,
  fetchPendingLocks,
  starsLockedEventAbi,
  lockKey,
  type PendingLock,
} from "./source.js";
import {
  adaptProof,
  adaptBatchProof,
  waitForAttestation,
  createChainInfoPort,
  CHAIN_INFO_PRECOMPILE_ADDRESS,
  type ProofBuilderPort,
  type AttestationProofInput,
} from "./prover.js";
import {
  ascAbi,
  buildAttestationBatch,
  submitBatchWithFallback,
  decodeBatchSuccesses,
  bridgeBatchExecutedEventAbi,
  MAX_BATCH_LOCKS,
  loadState,
  saveState,
  submitWithRetry,
  isDeterministicRevertError,
  serializeLock,
  deserializeLock,
  enqueuePendingLocks,
  removePendingLock,
  filterUnprocessedLocks,
  tryAdvanceLastBlock,
  acquireInstanceLock,
  releaseInstanceLock,
  redactRpcUrl,
  redactErrorText,
  emptyState,
  calculateFallbackGas,
  resolveGasWithFallback,
  type BridgeState,
  type SerializedPendingLock,
  type AttestationBatchInput,
  type SubmitOutcome,
} from "./submitter.js";
import { singleProofResponse, batchProofResponse } from "./fixtures/proofs.js";

const VALID_ENV: Record<string, string> = {
  CREDITCOIN_RPC_URL: "https://rpc.cc3-testnet.creditcoin.network",
  CREDITCOIN_PROOF_BUILDER_URL: "https://prover.cc3-testnet.creditcoin.network/",
  SOURCE_CHAIN_KEY: "1",
  SOURCE_RPC_URL: "https://sepolia.example/rpc",
  SOURCE_ADDRESS: "0x1111111111111111111111111111111111111111",
  ASC_ADDRESS: "0x2222222222222222222222222222222222222222",
  WORKER_PRIVATE_KEY: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

function makeLock(overrides: Partial<PendingLock> = {}): PendingLock {
  return {
    player: "0x1111111111111111111111111111111111111111",
    amount: 100n,
    nonce: 7n,
    recipient: "0x2222222222222222222222222222222222222222",
    blockHeight: 9000n,
    txHash: "0xhash",
    ...overrides,
  };
}

function makeValidLog(): Record<string, unknown> {
  const player = "0x1111111111111111111111111111111111111111";
  const recipient = "0x2222222222222222222222222222222222222222";
  const data = encodeAbiParameters(parseAbiParameters("uint256 amount, address recipient"), [
    100n,
    recipient as `0x${string}`,
  ]);
  return {
    address: "0x3333333333333333333333333333333333333333",
    topics: [
      keccak256(toHex("StarsLocked(address,uint256,uint256,address)")),
      `0x000000000000000000000000${player.slice(2)}`,
      `0x${7n.toString(16).padStart(64, "0")}`,
    ],
    data,
    blockNumber: 9000n,
    transactionHash: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  };
}

describe("config", () => {
  it("loads a valid config", () => {
    const config = loadConfig({ ...VALID_ENV });
    assert.equal(config.creditcoinRpcUrl, VALID_ENV["CREDITCOIN_RPC_URL"]);
    assert.equal(config.sourceChainKey, 1);
    assert.equal(config.sourceAddress, VALID_ENV["SOURCE_ADDRESS"]);
    assert.equal(config.pollIntervalMs, 5000);
    assert.equal(config.maxRetries, 5);
  });

  it("throws naming each missing required var", () => {
    for (const key of Object.keys(VALID_ENV)) {
      if (key === "POLL_INTERVAL_MS" || key === "MAX_RETRIES") continue;
      const env = { ...VALID_ENV };
      delete env[key];
      assert.throws(() => loadConfig(env), new RegExp(key), `expected throw naming ${key}`);
    }
  });

  it("rejects invalid addresses, keys, and numbers", () => {
    assert.throws(() => loadConfig({ ...VALID_ENV, SOURCE_ADDRESS: "nope" }), /SOURCE_ADDRESS/);
    assert.throws(() => loadConfig({ ...VALID_ENV, ASC_ADDRESS: "0x123" }), /ASC_ADDRESS/);
    assert.throws(() => loadConfig({ ...VALID_ENV, WORKER_PRIVATE_KEY: "0x123" }), /WORKER_PRIVATE_KEY/);
    assert.throws(() => loadConfig({ ...VALID_ENV, SOURCE_CHAIN_KEY: "0" }), /SOURCE_CHAIN_KEY/);
    assert.throws(() => loadConfig({ ...VALID_ENV, SOURCE_CHAIN_KEY: "abc" }), /SOURCE_CHAIN_KEY/);
    assert.throws(() => loadConfig({ ...VALID_ENV, CREDITCOIN_RPC_URL: "notaurl" }), /CREDITCOIN_RPC_URL/);
  });

  it("honors optional overrides", () => {
    const config = loadConfig({ ...VALID_ENV, POLL_INTERVAL_MS: "1000", MAX_RETRIES: "2" });
    assert.equal(config.pollIntervalMs, 1000);
    assert.equal(config.maxRetries, 2);
  });
});

describe("source event parsing", () => {
  const source = "0x3333333333333333333333333333333333333333";

  it("parses a valid StarsLocked log", () => {
    const lock = parseStarsLockedLog(makeValidLog(), source);
    assert.ok(lock !== null);
    assert.equal(lock.player, "0x1111111111111111111111111111111111111111");
    assert.equal(lock.amount, 100n);
    assert.equal(lock.nonce, 7n);
    assert.equal(lock.recipient, "0x2222222222222222222222222222222222222222");
    assert.equal(lock.blockHeight, 9000n);
  });

  it("returns null for malformed logs", () => {
    const valid = makeValidLog();
    assert.equal(parseStarsLockedLog(null, source), null);
    assert.equal(parseStarsLockedLog({}, source), null);
    assert.equal(parseStarsLockedLog({ ...valid, topics: [] }, source), null);
    assert.equal(parseStarsLockedLog({ ...valid, data: "0x1234" }, source), null);
    assert.equal(
      parseStarsLockedLog({ ...valid, address: "0x9999999999999999999999999999999999999999" }, source),
      null,
    );
    // Zero amount is not a bridgeable lock.
    const zeroAmount = {
      ...valid,
      data: encodeAbiParameters(parseAbiParameters("uint256 amount, address recipient"), [
        0n,
        "0x2222222222222222222222222222222222222222" as `0x${string}`,
      ]),
    };
    assert.equal(parseStarsLockedLog(zeroAmount, source), null);
  });

  it("fetches and filters logs through the injected getter", async () => {
    const other: Record<string, unknown> = { bogus: true };
    const locks = await fetchPendingLocks(
      async () => [makeValidLog(), other],
      source,
      8999n,
      9001n,
    );
    assert.equal(locks.length, 1);
    assert.equal(locks[0]?.nonce, 7n);
  });
});

describe("proof shaping", () => {
  it("adapts a proof-builder response to canonical pass-through fields and round-trips execute", () => {
    const proof = adaptProof(singleProofResponse);
    assert.equal(proof.chainKey, singleProofResponse.chainKey);
    assert.equal(proof.height, singleProofResponse.headerNumber);
    assert.equal(proof.txBytes, singleProofResponse.txBytes);
    assert.equal(proof.root, singleProofResponse.merkleProof.root);
    assert.deepEqual(proof.siblings, singleProofResponse.merkleProof.siblings);
    assert.equal(proof.digest, singleProofResponse.continuityProof.lowerEndpointDigest);
    assert.deepEqual(proof.roots, singleProofResponse.continuityProof.roots);

    // Encode check against the COMPILED PixelOrbitASC artifact ABI.
    const artifactPath = resolve(
      __dirname,
      "..",
      "..",
      "..",
      "contracts",
      "artifacts",
      "attestcoin",
      "PixelOrbitASC.sol",
      "PixelOrbitASC.json",
    );
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as unknown as {
      abi: readonly unknown[];
    };
    assert.ok(Array.isArray(artifact.abi), "artifact ABI must be an array");
    const names = (artifact.abi as { name?: string }[]).map((e) => e.name);
    assert.ok(names.includes("execute"), "artifact must expose execute");

    const data = encodeFunctionData({
      abi: ascAbi,
      functionName: "execute",
      args: [
        0,
        BigInt(proof.chainKey),
        BigInt(proof.height),
        proof.txBytes,
        proof.root,
        [...proof.siblings],
        proof.digest,
        [...proof.roots],
      ],
    });
    assert.ok(data.startsWith("0x"));
    // The worker encoding must start with the same 4-byte selector as the artifact.
    const artifactSelector = toFunctionSelector(
      "execute(uint8,uint64,uint64,bytes,bytes32,(bytes32,bool)[],bytes32,bytes32[])",
    );
    assert.equal(data.slice(0, 10), artifactSelector);
    // Round-trip against the compiled artifact ABI itself.
    const artifactData = encodeFunctionData({
      abi: artifact.abi as unknown as typeof ascAbi,
      functionName: "execute",
      args: [
        0,
        BigInt(proof.chainKey),
        BigInt(proof.height),
        proof.txBytes,
        proof.root,
        [...proof.siblings],
        proof.digest,
        [...proof.roots],
      ],
    });
    assert.equal(data, artifactData);
  });

  it("rejects proof responses with malformed hex", () => {
    const bad = {
      ...singleProofResponse,
      merkleProof: { root: "not-hex", siblings: [] },
    };
    assert.throws(() => adaptProof(bad), /root/);
  });

  it("adapts a batch response sharing one continuity proof", () => {
    const proofs = adaptBatchProof(batchProofResponse);
    assert.equal(proofs.length, 2);
    assert.equal(proofs[0]?.digest, proofs[1]?.digest);
    assert.deepEqual(proofs[0]?.roots, proofs[1]?.roots);
    assert.equal(proofs[0]?.height, 9100);
    assert.equal(proofs[1]?.height, 9101);
    assert.notEqual(proofs[0]?.txBytes, proofs[1]?.txBytes);
  });

  it("tolerates JSON-deserialized (plain object) merkleProofs maps", () => {
    const asJson = JSON.parse(
      JSON.stringify(batchProofResponse, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v)),
    ) as unknown;
    const proofs = adaptBatchProof(
      asJson as Parameters<typeof adaptBatchProof>[0],
    );
    assert.equal(proofs.length, 2);
  });
});

describe("retry, dedupe, and state persistence", () => {
  let dir: string;
  let statePath: string;
  let state: BridgeState;
  const noSleep = async (_ms: number): Promise<void> => {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bridge-test-"));
    statePath = join(dir, "state.json");
    state = emptyState();
  });

  it("submits once and records the processed key", async () => {
    const outcome = await submitWithRetry({
      lock: makeLock(),
      proof: adaptProof(singleProofResponse),
      submit: async () => "0xabc",
      state,
      maxRetries: 3,
      sleep: noSleep,
    });
    assert.equal(outcome.status, "submitted");
    assert.equal(outcome.txHash, "0xabc");
    assert.equal(outcome.attempts, 1);
    assert.ok(state.processed[lockKey(makeLock().player, 7n)]);
  });

  it("retries transient failures with backoff then succeeds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const outcome = await submitWithRetry({
      lock: makeLock(),
      proof: adaptProof(singleProofResponse),
      submit: async () => {
        calls += 1;
        if (calls < 3) throw new Error("flaky rpc");
        return "0xok";
      },
      state,
      maxRetries: 3,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    });
    assert.equal(outcome.status, "submitted");
    assert.equal(outcome.attempts, 3);
    assert.deepEqual(delays, [1000, 2000]);
  });

  it("parks the lock as failed after exhausting retries", async () => {
    const outcome = await submitWithRetry({
      lock: makeLock(),
      proof: adaptProof(singleProofResponse),
      submit: async () => {
        throw new Error("always down");
      },
      state,
      maxRetries: 2,
      sleep: noSleep,
    });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.attempts, 2);
    const key = lockKey(makeLock().player, 7n);
    assert.match(state.failed[key] ?? "", /always down/);
  });

  it("skips duplicate (player, nonce) without calling submit", async () => {
    const key = lockKey(makeLock().player, 7n);
    state.processed[key] = { txHash: "0xfirst", submittedAt: "t" };
    let calls = 0;
    const outcome = await submitWithRetry({
      lock: makeLock(),
      proof: adaptProof(singleProofResponse),
      submit: async () => {
        calls += 1;
        return "0xsecond";
      },
      state,
      maxRetries: 3,
      sleep: noSleep,
    });
    assert.equal(outcome.status, "duplicate");
    assert.equal(calls, 0);
  });

  it("distinguishes same nonce across different players", async () => {
    const alice = lockKey("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 7n);
    const bob = lockKey("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 7n);
    assert.notEqual(alice, bob);
  });

  it("round-trips state through a JSON file", () => {
    const key = lockKey(makeLock().player, 7n);
    state.processed[key] = { txHash: "0xabc", submittedAt: "2026-09-11T00:00:00Z" };
    state.retries["other:1"] = 2;
    saveState(statePath, state);
    const loaded = loadState(statePath);
    assert.deepEqual(loaded, state);
    // Missing file yields empty state.
    assert.deepEqual(loadState(join(dir, "missing.json")), emptyState());
  });
});

describe("batching", () => {
  it("groups locks by block with max 10 per group", () => {
    const locks: PendingLock[] = [];
    for (let i = 0; i < 12; i += 1) {
      locks.push(makeLock({ nonce: BigInt(i), blockHeight: 100n, txHash: `0xtx${i}` }));
    }
    locks.push(makeLock({ nonce: 99n, blockHeight: 101n, txHash: "0xother" }));
    const groups = groupLocksForBatch(locks, 10);
    assert.equal(groups.length, 3);
    assert.equal(groups[0]?.length, 10);
    assert.equal(groups[1]?.length, 2);
    assert.equal(groups[2]?.length, 1);
    assert.ok((groups[0] ?? []).every((l) => l.blockHeight === 100n));
  });
});

describe("chain-info attestation wait", () => {
  const immediateBuilder: ProofBuilderPort = {
    waitUntilHeightAttested: async () => {},
    getProof: async () => ({ success: false, error: "unused" }),
    getBatchProof: async () => ({ success: false, error: "unused" }),
  };

  it("resolves once the precompile reports attested", async () => {
    let polls = 0;
    await waitForAttestation({
      chainKey: 1,
      blockHeight: 9000,
      proofBuilder: immediateBuilder,
      chainInfo: {
        isHeightAttested: async () => {
          polls += 1;
          return polls >= 2;
        },
        getLatestAttestedHeight: async () => ({ height: 9001n, exists: true }),
      },
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });
    assert.ok(polls >= 2);
  });

  it("times out when the height never attests", async () => {
    await assert.rejects(
      () =>
        waitForAttestation({
          chainKey: 1,
          blockHeight: 9000,
          proofBuilder: immediateBuilder,
          chainInfo: {
            isHeightAttested: async () => false,
            getLatestAttestedHeight: async () => ({ height: 1n, exists: true }),
          },
          pollIntervalMs: 1,
          timeoutMs: 20,
        }),
      /not attested/,
    );
  });

  it("skips on-chain polling when no chain-info reader is provided", async () => {
    let waited = false;
    await waitForAttestation({
      chainKey: 1,
      blockHeight: 9000,
      proofBuilder: {
        ...immediateBuilder,
        waitUntilHeightAttested: async () => {
          waited = true;
        },
      },
    });
    assert.equal(waited, true);
  });

  it("chain-info reader calls the 0xFD3 precompile with the mirrored selector", async () => {
    const seen: { to: string; data: string }[] = [];
    const { encodeFunctionResult } = await import("viem");
    const port = createChainInfoPort(async (to: string, data: `0x${string}`) => {
      seen.push({ to, data });
      return encodeFunctionResult({
        abi: [
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
        ] as const,
        functionName: "is_height_attested",
        result: true,
      });
    });
    assert.equal(await port.isHeightAttested(1, 9000), true);
    assert.equal(seen[0]?.to.toLowerCase(), CHAIN_INFO_PRECOMPILE_ADDRESS.toLowerCase());
    assert.equal(seen[0]?.data.slice(0, 10), toFunctionSelector("is_height_attested(uint64,uint64)"));
  });
});

describe("event ABI", () => {
  it("matches the frozen PixelOrbitSource signature", () => {
    assert.equal(
      keccak256(toHex("StarsLocked(address,uint256,uint256,address)")),
      // Cross-check the ABI entry encodes the same topic0 viem derives.
      toEventSelector(starsLockedEventAbi),
    );
  });
});

describe("deterministic revert handling", () => {
  const noSleep = async (_ms: number): Promise<void> => {};

  function freshState(): BridgeState {
    return emptyState();
  }

  it("classifies nonce/already-executed/already-bridged/invalid-proof reverts (case-insensitive)", () => {
    assert.equal(isDeterministicRevertError("Nonce used"), true);
    assert.equal(isDeterministicRevertError("NONCE USED for player"), true);
    assert.equal(isDeterministicRevertError("Lock already executed"), true);
    assert.equal(isDeterministicRevertError("ALREADY EXECUTED"), true);
    assert.equal(isDeterministicRevertError("already bridged on creditcoin"), true);
    assert.equal(isDeterministicRevertError("Invalid proof"), true);
    assert.equal(isDeterministicRevertError("INVALID PROOF for height 9100"), true);
    assert.equal(isDeterministicRevertError("flaky rpc"), false);
    assert.equal(isDeterministicRevertError("ASC submission reverted: 0xabc"), false);
    assert.equal(isDeterministicRevertError(""), false);
  });

  it("marks deterministic reverts as skipped with 0 retries and no backoff", async () => {
    const state = freshState();
    const delays: number[] = [];
    const outcome = await submitWithRetry({
      lock: makeLock(),
      proof: adaptProof(singleProofResponse),
      submit: async () => {
        throw new Error("Nonce used for 0xabc:7");
      },
      state,
      maxRetries: 5,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    });
    assert.equal(outcome.status, "skipped");
    assert.equal(outcome.attempts, 1);
    assert.deepEqual(delays, []);
    const key = lockKey(makeLock().player, 7n);
    assert.ok(state.skipped?.[key], "skipped record must exist");
    assert.equal(state.retries[key], undefined);
    assert.equal(state.failed[key], undefined);
  });

  it("treats already-executed / already-bridged variants as skipped without retry", async () => {
    for (const msg of ["Lock ALREADY EXECUTED", "tx already bridged"]) {
      const state = freshState();
      let calls = 0;
      const outcome = await submitWithRetry({
        lock: makeLock(),
        proof: adaptProof(singleProofResponse),
        submit: async () => {
          calls += 1;
          throw new Error(msg);
        },
        state,
        maxRetries: 5,
        sleep: noSleep,
      });
      assert.equal(outcome.status, "skipped", `expected skipped for ${msg}`);
      assert.equal(calls, 1, "must not retry deterministic reverts");
    }
  });

  it("does not call submit again once a lock is skipped", async () => {
    const state = freshState();
    const key = lockKey(makeLock().player, 7n);
    await submitWithRetry({
      lock: makeLock(),
      proof: adaptProof(singleProofResponse),
      submit: async () => {
        throw new Error("nonce used");
      },
      state,
      maxRetries: 3,
      sleep: noSleep,
    });
    let calls = 0;
    const second = await submitWithRetry({
      lock: makeLock(),
      proof: adaptProof(singleProofResponse),
      submit: async () => {
        calls += 1;
        return "0xsecond";
      },
      state,
      maxRetries: 3,
      sleep: noSleep,
    });
    assert.equal(second.status, "duplicate");
    assert.equal(calls, 0);
  });

  it("marks Invalid proof as skipped without retry, storing the reason", async () => {
    const state = emptyState();
    let calls = 0;
    const outcome = await submitWithRetry({
      lock: makeLock(),
      proof: adaptProof(singleProofResponse),
      submit: async () => {
        calls += 1;
        throw new Error("Invalid proof for height 9100");
      },
      state,
      maxRetries: 5,
      sleep: noSleep,
    });
    assert.equal(outcome.status, "skipped");
    assert.equal(calls, 1);
    const key = lockKey(makeLock().player, 7n);
    assert.match(state.skipped?.[key]?.reason ?? "", /Invalid proof/);
  });
});

describe("calculated gas fallback", () => {
  it("scales with batch fan-out and decoder cost (single, batch-10, price)", () => {
    // Scaled formula: (BASE + PER_LOCK * locks + PER_ROOT * roots) * 135/100.
    // Constants are conservative starting values for testnet calibration
    // (runbook step (g) Batch gas headroom); too-high is safe (only a limit,
    // unused gas is refunded) while too-low reverts and burns fees.
    const single = calculateFallbackGas({ locks: 1, continuityRoots: 2 });
    assert.equal(single, ((100000n + 500000n * 1n + 5000n * 2n) * 135n) / 100n);
    const batch10 = calculateFallbackGas({ locks: 10, continuityRoots: 3 });
    assert.equal(batch10, ((100000n + 500000n * 10n + 5000n * 3n) * 135n) / 100n);
    // Price path is a single-proof submit: same shape as a single lock.
    const price = calculateFallbackGas({ locks: 1, continuityRoots: 2 });
    assert.equal(price, single);
    // Batch fan-out must dominate: 10 locks cost far more than 1.
    assert.ok(batch10 > single * 5n);
  });

  it("returns the estimate when estimation succeeds without warning", async () => {
    const warnings: string[] = [];
    const logger = { warn: (message: string): void => void warnings.push(message) };
    const resolved = await resolveGasWithFallback(async () => 123456n, { locks: 1, continuityRoots: 2 }, logger);
    assert.equal(resolved.gas, 123456n);
    assert.equal(resolved.usedFallback, false);
    assert.equal(warnings.length, 0);
  });

  it("falls back to calculated gas with a redacted warn when estimation fails", async () => {
    const warnings: string[] = [];
    const logger = { warn: (message: string): void => void warnings.push(message) };
    const input = { locks: 2, continuityRoots: 2 };
    const resolved = await resolveGasWithFallback(
      async () => {
        throw new Error("estimateGas failed https://user:secret@example.com/rpc?key=abc");
      },
      input,
      logger,
    );
    assert.equal(resolved.gas, calculateFallbackGas(input));
    assert.equal(resolved.usedFallback, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /fallback/i);
    assert.ok(!(warnings[0] ?? "").includes("secret"), "warn must not leak credentials");
    assert.ok(!(warnings[0] ?? "").includes("key=abc"), "warn must not leak query strings");
  });
});

describe("proof uint64 precision guards", () => {
  it("rejects unsafe, negative, and huge chainKey values in adaptProof", () => {
    assert.throws(
      () => adaptProof({ ...singleProofResponse, chainKey: 1.5 }),
      /chainKey/,
    );
    assert.throws(() => adaptProof({ ...singleProofResponse, chainKey: 0 }), /chainKey/);
    assert.throws(() => adaptProof({ ...singleProofResponse, chainKey: -1 }), /chainKey/);
    assert.throws(
      () => adaptProof({ ...singleProofResponse, chainKey: Number.MAX_SAFE_INTEGER + 1 }),
      /chainKey/,
    );
  });

  it("rejects unsafe, negative, and huge height values in adaptProof", () => {
    assert.throws(
      () => adaptProof({ ...singleProofResponse, headerNumber: 1.5 }),
      /headerNumber|height/,
    );
    assert.throws(
      () => adaptProof({ ...singleProofResponse, headerNumber: -1 }),
      /headerNumber|height/,
    );
    assert.throws(
      () => adaptProof({ ...singleProofResponse, headerNumber: Number.MAX_SAFE_INTEGER + 1 }),
      /headerNumber|height/,
    );
  });

  it("rejects unsafe batch chainKey and height keys in adaptBatchProof", () => {
    assert.throws(
      () => adaptBatchProof({ ...batchProofResponse, chainKey: 0 }),
      /chainKey/,
    );
    assert.throws(
      () =>
        adaptBatchProof({
          ...batchProofResponse,
          merkleProofs: new Map([[Number.MAX_SAFE_INTEGER + 1, new Map()]]),
        } as unknown as Parameters<typeof adaptBatchProof>[0]),
      /height/,
    );
  });
});

describe("pending queue and cursor durability", () => {
  it("round-trips bigint fields through serialize/deserialize without Number()", () => {
    const lock = makeLock({ amount: 12345678901234567890n, nonce: 2n ** 200n, blockHeight: 2n ** 63n });
    const ser = serializeLock(lock);
    assert.equal(typeof ser.amount, "string");
    assert.equal(typeof ser.nonce, "string");
    assert.equal(typeof ser.blockHeight, "string");
    const back = deserializeLock(ser);
    assert.equal(back.amount, lock.amount);
    assert.equal(back.nonce, lock.nonce);
    assert.equal(back.blockHeight, lock.blockHeight);
    assert.equal(typeof back.blockHeight, "bigint");
  });

  it("enqueues fresh locks deduped against processed/skipped/pending", () => {
    const state = emptyState();
    const a = makeLock({ nonce: 1n, txHash: "0xa" });
    const b = makeLock({ nonce: 2n, txHash: "0xb" });
    assert.equal(enqueuePendingLocks(state, [a, b]), 2);
    assert.equal(enqueuePendingLocks(state, [a, b]), 0);
    assert.equal(state.pending?.length, 2);
    // Already-processed locks are not enqueued.
    const keyA = lockKey(a.player, a.nonce);
    state.processed[keyA] = { txHash: "0xfirst", submittedAt: "t" };
    removePendingLock(state, keyA);
    assert.equal(enqueuePendingLocks(state, [a]), 0);
    // Already-skipped locks are not enqueued.
    const keyB = lockKey(b.player, b.nonce);
    state.skipped = { [keyB]: { reason: "nonce used", skippedAt: "t" } };
    removePendingLock(state, keyB);
    assert.equal(enqueuePendingLocks(state, [b]), 0);
  });

  it("filters already-processed/skipped locks before attestation work", () => {
    const state = emptyState();
    const done = makeLock({ nonce: 1n, txHash: "0xa" });
    const skip = makeLock({ nonce: 2n, txHash: "0xb" });
    const fresh = makeLock({ nonce: 3n, txHash: "0xc" });
    state.processed[lockKey(done.player, done.nonce)] = { txHash: "0x1", submittedAt: "t" };
    state.skipped = { [lockKey(skip.player, skip.nonce)]: { reason: "x", skippedAt: "t" } };
    const out = filterUnprocessedLocks(state, [done, skip, fresh]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.nonce, 3n);
  });

  it("advances lastBlock only on full group success, never past failures", () => {
    const state = emptyState();
    assert.equal(tryAdvanceLastBlock(state, 100n, true), true);
    assert.equal(state.lastBlock, "100");
    assert.equal(tryAdvanceLastBlock(state, 99n, true), false);
    assert.equal(state.lastBlock, "100");
    assert.equal(tryAdvanceLastBlock(state, 101n, false), false);
    assert.equal(state.lastBlock, "100");
    assert.equal(tryAdvanceLastBlock(state, 102n, true), true);
    // Higher success after a failure is allowed by the helper itself;
    // the worker loop must break on first failure so it never calls this
    // past a failed group in the same iteration.
    assert.equal(state.lastBlock, "102");
  });

  it("keeps failed-after-retries locks in pending for the next iteration", async () => {
    const state = emptyState();
    const lock = makeLock();
    enqueuePendingLocks(state, [lock]);
    const noSleep = async (_ms: number): Promise<void> => {};
    const outcome = await submitWithRetry({
      lock,
      proof: adaptProof(singleProofResponse),
      submit: async () => {
        throw new Error("always down");
      },
      state,
      maxRetries: 2,
      sleep: noSleep,
    });
    assert.equal(outcome.status, "failed");
    // Caller contract: failed locks stay in pending (not parked forever).
    const key = lockKey(lock.player, lock.nonce);
    assert.ok(
      (state.pending ?? []).some(
        (p: SerializedPendingLock) => `${p.player.toLowerCase()}:${BigInt(p.nonce).toString()}` === key,
      ),
    );
    assert.match(state.failed[key] ?? "", /always down/);
  });
});

describe("reorg protection config", () => {
  it("defaults CONFIRMATIONS to 12", () => {
    const config = loadConfig({ ...VALID_ENV });
    assert.equal(config.confirmations, 12);
  });

  it("accepts explicit CONFIRMATIONS and rejects non-positive values", () => {
    assert.equal(loadConfig({ ...VALID_ENV, CONFIRMATIONS: "3" }).confirmations, 3);
    assert.throws(() => loadConfig({ ...VALID_ENV, CONFIRMATIONS: "0" }), /CONFIRMATIONS/);
    assert.throws(() => loadConfig({ ...VALID_ENV, CONFIRMATIONS: "-1" }), /CONFIRMATIONS/);
    assert.throws(() => loadConfig({ ...VALID_ENV, CONFIRMATIONS: "abc" }), /CONFIRMATIONS/);
  });
});

describe("configurable attestation wait", () => {
  it("defaults ATTEST_POLL_MS/ATTEST_TIMEOUT_MS and honors overrides", () => {
    const defaults = loadConfig({ ...VALID_ENV });
    assert.equal(defaults.attestPollMs, 15000);
    assert.equal(defaults.attestTimeoutMs, 1200000);
    const custom = loadConfig({ ...VALID_ENV, ATTEST_POLL_MS: "1000", ATTEST_TIMEOUT_MS: "60000" });
    assert.equal(custom.attestPollMs, 1000);
    assert.equal(custom.attestTimeoutMs, 60000);
    assert.throws(() => loadConfig({ ...VALID_ENV, ATTEST_POLL_MS: "0" }), /ATTEST_POLL_MS/);
    assert.throws(() => loadConfig({ ...VALID_ENV, ATTEST_TIMEOUT_MS: "-5" }), /ATTEST_TIMEOUT_MS/);
  });

  it("forwards custom poll/timeout to the proof builder", async () => {
    let seenPoll: number | undefined;
    let seenTimeout: number | undefined;
    await waitForAttestation({
      chainKey: 1,
      blockHeight: 9000n,
      proofBuilder: {
        waitUntilHeightAttested: async (_c: number, _h: number | bigint, poll?: number, timeout?: number) => {
          seenPoll = poll;
          seenTimeout = timeout;
        },
        getProof: async () => ({ success: false, error: "unused" }),
        getBatchProof: async () => ({ success: false, error: "unused" }),
      },
      pollIntervalMs: 111,
      timeoutMs: 222,
    });
    assert.equal(seenPoll, 111);
    assert.equal(seenTimeout, 222);
  });

  it("accepts bigint block heights without Number() conversion", async () => {
    let seenHeight: unknown;
    await waitForAttestation({
      chainKey: 1,
      blockHeight: 9000n,
      proofBuilder: {
        waitUntilHeightAttested: async (_c: number, h: number | bigint) => {
          seenHeight = h;
        },
        getProof: async () => ({ success: false, error: "unused" }),
        getBatchProof: async () => ({ success: false, error: "unused" }),
      },
    });
    assert.equal(seenHeight, 9000n);
  });
});

describe("state robustness", () => {
  it("backs up corrupt JSON and starts from empty state", async () => {
    const { mkdtempSync, writeFileSync, existsSync, readdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "bridge-corrupt-"));
    const path = join(dir, "bridge-state.json");
    writeFileSync(path, "{ not valid json", "utf8");
    const loaded = loadState(path);
    assert.deepEqual(loaded.processed, {});
    const files = readdirSync(dir);
    assert.ok(files.some((f) => f.startsWith("bridge-state.json.corrupt.")), `expected corrupt backup, got ${files}`);
    assert.ok(existsSync(path) === false || true);
  });

  it("resets malformed lastBlock with a warning instead of throwing", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "bridge-lastblock-"));
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({ processed: {}, retries: {}, failed: {}, lastBlock: "abc" }), "utf8");
    const loaded = loadState(path);
    assert.equal(loaded.lastBlock, undefined);
  });

  it("writes state atomically without leaving temp files", async () => {
    const { readdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "bridge-atomic-"));
    const path = join(dir, "state.json");
    const state = emptyState();
    state.lastBlock = "123";
    saveState(path, state);
    const loaded = loadState(path);
    assert.equal(loaded.lastBlock, "123");
    const files = readdirSync(dir);
    assert.ok(!files.some((f) => f.includes(".tmp")), `no tmp files expected, got ${files}`);
  });
});

describe("single-instance guard", () => {
  it("writes PID, refuses a fresh lock, and releases cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-lock-"));
    const lockPath = join(dir, "bridge-state.lock");
    const first = acquireInstanceLock(lockPath);
    assert.equal(first.acquired, true);
    const second = acquireInstanceLock(lockPath);
    assert.equal(second.acquired, false);
    releaseInstanceLock(lockPath);
    const third = acquireInstanceLock(lockPath);
    assert.equal(third.acquired, true);
    releaseInstanceLock(lockPath);
  });

  it("takes over a stale lock older than 5 minutes", async () => {
    const { utimesSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "bridge-stale-"));
    const lockPath = join(dir, "bridge-state.lock");
    assert.equal(acquireInstanceLock(lockPath).acquired, true);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockPath, tenMinutesAgo, tenMinutesAgo);
    const retake = acquireInstanceLock(lockPath);
    assert.equal(retake.acquired, true);
    assert.equal(retake.stale, true);
    releaseInstanceLock(lockPath);
  });
});

describe("rpc redaction", () => {
  it("strips userinfo and query from RPC URLs", () => {
    assert.equal(
      redactRpcUrl("https://user:pass@sepolia.example/rpc?key=SECRET"),
      "https://sepolia.example/rpc",
    );
    assert.equal(redactRpcUrl("https://sepolia.example/rpc"), "https://sepolia.example/rpc");
  });

  it("redacts embedded URLs in error text", () => {
    const out = redactErrorText("fetch failed for https://user:pw@host.example/v3/rpc?key=SECRET boom");
    assert.ok(!out.includes("SECRET"));
    assert.ok(!out.includes("user:pw@"));
    assert.ok(out.includes("host.example"));
  });
});

describe("batch building", () => {
  function makeProofs(count: number): AttestationProofInput[] {
    const base = adaptProof(singleProofResponse);
    return Array.from({ length: count }, (_, i) => ({
      ...base,
      txBytes: `0x${"d8".repeat(63)}${(i + 1).toString(16).padStart(2, "0")}` as Hex,
      root: `0x${"c8".repeat(31)}${(i + 1).toString(16).padStart(2, "0")}` as Hex,
    }));
  }

  it("builds one shared-continuity batch preserving lock order", () => {
    const proofs = makeProofs(3);
    const batch = buildAttestationBatch(proofs);
    assert.equal(batch.chainKey, proofs[0]?.chainKey);
    assert.deepEqual(batch.heights, proofs.map((p) => p.height));
    assert.equal(batch.digest, proofs[0]?.digest);
    assert.deepEqual(batch.continuityRoots, proofs[0]?.roots);
    assert.deepEqual(
      batch.txBytesArray,
      proofs.map((p) => p.txBytes),
    );
    assert.deepEqual(
      batch.merkleProofs.map((m) => m.root),
      proofs.map((p) => p.root),
    );
    assert.equal(MAX_BATCH_LOCKS, 10);
  });

  it("rejects empty and over-10 proof lists", () => {
    assert.throws(() => buildAttestationBatch([]), /No locks/);
    assert.throws(() => buildAttestationBatch(makeProofs(11)), /Too many locks/);
  });

  it("rejects heterogeneous chainKey across proofs", () => {
    const proofs = makeProofs(2);
    const bad = [...proofs];
    bad[1] = { ...(bad[1] as AttestationProofInput), chainKey: 999 } as AttestationProofInput;
    assert.throws(() => buildAttestationBatch(bad), /Heterogeneous chainKey/);
  });

  it("allows heterogeneous heights sharing one continuity proof", () => {
    const proofs = makeProofs(2);
    const varied = [...proofs];
    varied[1] = { ...(varied[1] as AttestationProofInput), height: 9101 } as AttestationProofInput;
    const batch = buildAttestationBatch(varied);
    assert.deepEqual(batch.heights, [9100, 9101]);
  });

  it("rejects heterogeneous continuity roots across proofs", () => {
    const proofs = makeProofs(2);
    const bad = [...proofs];
    bad[1] = { ...(bad[1] as AttestationProofInput), digest: "0xdead" as Hex } as AttestationProofInput;
    assert.throws(() => buildAttestationBatch(bad as AttestationProofInput[]), /Heterogeneous continuity/);
  });

  it("encodes executeBatch with the compiled artifact selector", () => {
    const artifactPath = resolve(
      __dirname,
      "..",
      "..",
      "..",
      "contracts",
      "artifacts",
      "attestcoin",
      "PixelOrbitASC.sol",
      "PixelOrbitASC.json",
    );
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as unknown as {
      abi: readonly unknown[];
    };
    assert.ok(Array.isArray(artifact.abi), "artifact ABI must be an array");
    const names = (artifact.abi as { name?: string }[]).map((e) => e.name);
    assert.ok(names.includes("executeBatch"), "artifact must expose executeBatch");

    const batch = buildAttestationBatch(makeProofs(2));
    const data = encodeFunctionData({
      abi: ascAbi,
      functionName: "executeBatch",
      args: [
        0,
        BigInt(batch.chainKey),
        batch.heights.map((h) => BigInt(h)),
        [...batch.txBytesArray],
        batch.merkleProofs.map((m) => ({ root: m.root, siblings: [...m.siblings] })),
        batch.digest,
        [...batch.continuityRoots],
      ],
    });
    assert.ok(data.startsWith("0x"));
    const artifactSelector = toFunctionSelector(
      "executeBatch(uint8,uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],bytes32,bytes32[])",
    );
    assert.equal(data.slice(0, 10), artifactSelector);
    const artifactData = encodeFunctionData({
      abi: artifact.abi as unknown as typeof ascAbi,
      functionName: "executeBatch",
      args: [
        0,
        BigInt(batch.chainKey),
        batch.heights.map((h) => BigInt(h)),
        [...batch.txBytesArray],
        batch.merkleProofs.map((m) => ({ root: m.root, siblings: [...m.siblings] })),
        batch.digest,
        [...batch.continuityRoots],
      ],
    });
    assert.equal(data, artifactData);
  });
});

describe("batch submission with sequential fallback", () => {
  const noSleep = async (_ms: number): Promise<void> => {};
  const ASC = "0x2222222222222222222222222222222222222222";

  function makeGroup(count: number, blockHeight = 9100n): PendingLock[] {
    return Array.from({ length: count }, (_, i) =>
      makeLock({
        nonce: BigInt(100 + i),
        blockHeight,
        txHash: `0x${"e0".repeat(31)}${(i + 1).toString(16).padStart(2, "0")}`,
      }),
    );
  }

  function proofsFor(count: number): AttestationProofInput[] {
    const base = adaptProof(singleProofResponse);
    return Array.from({ length: count }, (_, i) => ({
      ...base,
      txBytes: `0x${"d8".repeat(63)}${(i + 1).toString(16).padStart(2, "0")}` as Hex,
    }));
  }

  it("submits a 3-lock group with ONE batch TX and marks all processed", async () => {
    const state = emptyState();
    const locks = makeGroup(3);
    const proofs = proofsFor(3);
    let batchCalls = 0;
    let singleCalls = 0;
    const result = await submitBatchWithFallback({
      locks,
      proofs,
      submitBatch: async (batch: AttestationBatchInput) => {
        batchCalls += 1;
        assert.equal(batch.txBytesArray.length, 3);
        assert.equal(batch.merkleProofs.length, 3);
        return { txHash: "0xbatch", successes: [true, true, true] };
      },
      submitSingle: async () => {
        singleCalls += 1;
        return "0xsingle";
      },
      state,
      maxRetries: 3,
      sleep: noSleep,
    });
    assert.equal(result.status, "batched");
    assert.equal(result.batchTxHash, "0xbatch");
    assert.equal(batchCalls, 1);
    assert.equal(singleCalls, 0);
    assert.deepEqual(
      result.outcomes.map((o: SubmitOutcome) => o.status),
      ["submitted", "submitted", "submitted"],
    );
    for (const lock of locks) {
      assert.ok(state.processed[lockKey(lock.player, lock.nonce)]);
    }
  });

  it("falls back to sequential singles when the batch reverts", async () => {
    const state = emptyState();
    const locks = makeGroup(3);
    const proofs = proofsFor(3);
    let batchCalls = 0;
    let singleCalls = 0;
    const result = await submitBatchWithFallback({
      locks,
      proofs,
      submitBatch: async () => {
        batchCalls += 1;
        throw new Error("ASC batch submission reverted: 0xbatch");
      },
      submitSingle: async () => {
        singleCalls += 1;
        return `0xsingle${singleCalls}`;
      },
      state,
      maxRetries: 3,
      sleep: noSleep,
    });
    assert.equal(result.status, "fallback");
    assert.equal(batchCalls, 1);
    assert.equal(singleCalls, 3);
    assert.deepEqual(
      result.outcomes.map((o: SubmitOutcome) => o.status),
      ["submitted", "submitted", "submitted"],
    );
    for (const lock of locks) {
      assert.ok(state.processed[lockKey(lock.player, lock.nonce)]);
    }
  });

  it("applies per-lock deterministic skip inside the fallback", async () => {
    const state = emptyState();
    const locks = makeGroup(3);
    const proofs = proofsFor(3);
    const badTxBytes = proofs[1]?.txBytes;
    const result = await submitBatchWithFallback({
      locks,
      proofs,
      submitBatch: async () => {
        throw new Error("ASC batch submission reverted: 0xbatch");
      },
      submitSingle: async (proof: AttestationProofInput) => {
        if (proof.txBytes === badTxBytes) throw new Error("Nonce used for player:101");
        return "0xok";
      },
      state,
      maxRetries: 3,
      sleep: noSleep,
    });
    assert.equal(result.status, "fallback");
    assert.deepEqual(
      result.outcomes.map((o: SubmitOutcome) => o.status),
      ["submitted", "skipped", "submitted"],
    );
    const mid = locks[1] as PendingLock;
    assert.ok(state.skipped?.[lockKey(mid.player, mid.nonce)], "middle lock must be skipped");
    for (const lock of [locks[0] as PendingLock, locks[2] as PendingLock]) {
      assert.ok(state.processed[lockKey(lock.player, lock.nonce)]);
    }
  });

  it("keeps single-lock groups on execute without a batch call", async () => {
    const state = emptyState();
    const locks = makeGroup(1);
    const proofs = proofsFor(1);
    let batchCalls = 0;
    const result = await submitBatchWithFallback({
      locks,
      proofs,
      submitBatch: async () => {
        batchCalls += 1;
        return { txHash: "0xbatch" };
      },
      submitSingle: async () => "0xsingle",
      state,
      maxRetries: 3,
      sleep: noSleep,
    });
    assert.equal(result.status, "single");
    assert.equal(batchCalls, 0);
    assert.deepEqual(
      result.outcomes.map((o: SubmitOutcome) => o.status),
      ["submitted"],
    );
  });

  it("marks partial batch failures as failed without touching sibling locks", async () => {
    const state = emptyState();
    const locks = makeGroup(3);
    const proofs = proofsFor(3);
    const result = await submitBatchWithFallback({
      locks,
      proofs,
      submitBatch: async () => ({ txHash: "0xbatch", successes: [true, false, true] }),
      submitSingle: async () => "0xsingle",
      state,
      maxRetries: 3,
      sleep: noSleep,
    });
    assert.equal(result.status, "batched");
    assert.deepEqual(
      result.outcomes.map((o: SubmitOutcome) => o.status),
      ["submitted", "failed", "submitted"],
    );
    const mid = locks[1] as PendingLock;
    assert.match(state.failed[lockKey(mid.player, mid.nonce)] ?? "", /0xbatch/);
    for (const lock of [locks[0] as PendingLock, locks[2] as PendingLock]) {
      assert.ok(state.processed[lockKey(lock.player, lock.nonce)]);
    }
  });

  it("skips already-completed locks without including them in the batch", async () => {
    const state = emptyState();
    const locks = makeGroup(3);
    const proofs = proofsFor(3);
    const first = locks[0] as PendingLock;
    state.processed[lockKey(first.player, first.nonce)] = { txHash: "0xfirst", submittedAt: "t" };
    let seenProofs = 0;
    const result = await submitBatchWithFallback({
      locks,
      proofs,
      submitBatch: async (batch: AttestationBatchInput) => {
        seenProofs = batch.txBytesArray.length;
        return { txHash: "0xbatch", successes: [true, true] };
      },
      submitSingle: async () => "0xsingle",
      state,
      maxRetries: 3,
      sleep: noSleep,
    });
    assert.equal(result.status, "batched");
    assert.equal(seenProofs, 2);
    assert.deepEqual(
      result.outcomes.map((o: SubmitOutcome) => o.status),
      ["duplicate", "submitted", "submitted"],
    );
  });

  it("falls back to singles when batch events are unattributable (undefined successes)", async () => {
    const state = emptyState();
    const locks = makeGroup(3);
    const proofs = proofsFor(3);
    let singleCalls = 0;
    const result = await submitBatchWithFallback({
      locks,
      proofs,
      // Simulates index.submitBatch when decodeBatchSuccesses returned
      // undefined (count/shape mismatch): successes omitted.
      submitBatch: async () => ({ txHash: "0xbatch-malformed" }),
      submitSingle: async () => {
        singleCalls += 1;
        return `0xsingle${singleCalls}`;
      },
      state,
      maxRetries: 3,
      sleep: noSleep,
    });
    assert.equal(result.status, "fallback");
    assert.equal(singleCalls, 3);
    assert.deepEqual(
      result.outcomes.map((o: SubmitOutcome) => o.status),
      ["submitted", "submitted", "submitted"],
    );
    for (const lock of locks) {
      const entry = state.processed[lockKey(lock.player, lock.nonce)];
      assert.ok(entry, "each lock must be marked via its single, not the batch");
      assert.notEqual(entry.txHash, "0xbatch-malformed");
    }
  });

  it("falls back to singles when successes length mismatches the batch", async () => {
    const state = emptyState();
    const locks = makeGroup(3);
    const proofs = proofsFor(3);
    let singleCalls = 0;
    const result = await submitBatchWithFallback({
      locks,
      proofs,
      submitBatch: async () => ({ txHash: "0xbatch-short", successes: [true, true] }),
      submitSingle: async () => {
        singleCalls += 1;
        return `0xsingle${singleCalls}`;
      },
      state,
      maxRetries: 3,
      sleep: noSleep,
    });
    assert.equal(result.status, "fallback");
    assert.equal(singleCalls, 3);
    assert.deepEqual(
      result.outcomes.map((o: SubmitOutcome) => o.status),
      ["submitted", "submitted", "submitted"],
    );
  });

  it("leaves all locks pending when unattributable batch AND singles fail", async () => {
    const state = emptyState();
    const locks = makeGroup(2);
    const proofs = proofsFor(2);
    const result = await submitBatchWithFallback({
      locks,
      proofs,
      submitBatch: async () => ({ txHash: "0xbatch-malformed" }),
      submitSingle: async () => {
        throw new Error("RPC down");
      },
      state,
      maxRetries: 2,
      sleep: noSleep,
    });
    assert.equal(result.status, "fallback");
    assert.deepEqual(
      result.outcomes.map((o: SubmitOutcome) => o.status),
      ["failed", "failed"],
    );
    assert.equal(Object.keys(state.processed).length, 0);
    for (const lock of locks) {
      assert.ok(state.failed[lockKey(lock.player, lock.nonce)], "failed locks stay pending via state.failed");
    }
  });

  function makeBatchLogs(successes: boolean[]): {
    address: string;
    topics: Hex[];
    data: Hex;
  }[] {
    // BridgeBatchExecuted has no indexed params: topics carry only the
    // selector, data carries the ABI-encoded (index, success, reason) tuple.
    const selector = toEventSelector("BridgeBatchExecuted(uint256,bool,bytes)");
    return successes.map((success, i) => ({
      address: ASC,
      topics: [selector],
      data: encodeAbiParameters(parseAbiParameters("uint256 index, bool success, bytes reason"), [
        BigInt(i),
        success,
        "0x" as Hex,
      ]),
    }));
  }

  it("decodes per-index batch results in index order", () => {
    assert.deepEqual(decodeBatchSuccesses(makeBatchLogs([true, false, true]), ASC, 3), [
      true,
      false,
      true,
    ]);
  });

  it("returns undefined when batch events are missing or foreign", () => {
    assert.equal(decodeBatchSuccesses(makeBatchLogs([true, false]), ASC, 3), undefined);
    const foreign = makeBatchLogs([true, true, true]).map((l) => ({
      ...l,
      address: "0x9999999999999999999999999999999999999999",
    }));
    assert.equal(decodeBatchSuccesses(foreign, ASC, 3), undefined);
  });

  it("matches the compiled BridgeBatchExecuted event signature", () => {
    const artifactPath = resolve(
      __dirname,
      "..",
      "..",
      "..",
      "contracts",
      "artifacts",
      "attestcoin",
      "PixelOrbitASC.sol",
      "PixelOrbitASC.json",
    );
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as unknown as {
      abi: readonly unknown[];
    };
    const entry = (artifact.abi as { name?: string; inputs?: { type: string }[] }[]).find(
      (e) => e.name === "BridgeBatchExecuted",
    );
    assert.ok(entry, "artifact must expose BridgeBatchExecuted");
    const signature = `BridgeBatchExecuted(${(entry.inputs ?? []).map((i) => i.type).join(",")})`;
    assert.equal(signature, "BridgeBatchExecuted(uint256,bool,bytes)");
    assert.equal(
      toEventSelector(signature),
      toEventSelector("BridgeBatchExecuted(uint256,bool,bytes)"),
    );
    // The worker fragment must describe the same non-indexed shape.
    assert.deepEqual(
      (bridgeBatchExecutedEventAbi.inputs as readonly { type: string }[]).map((i) => i.type),
      ["uint256", "bool", "bytes"],
    );
  });
});
