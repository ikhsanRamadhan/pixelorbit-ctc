// Must stay first: loads worker .env into process.env before loadConfig() reads it.
import "dotenv/config";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbiItem,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "./config.js";
import {
  fetchPendingLocks,
  groupLocksForBatch,
  lockKey,
  type PendingLock,
} from "./source.js";
import {
  adaptBatchProof,
  adaptProof,
  createChainInfoPort,
  createProofBuilder,
  waitForAttestation,
  type AttestationProofInput,
} from "./prover.js";
import {
  ascAbi,
  acquireInstanceLock,
  decodeBatchSuccesses,
  deserializeLock,
  enqueuePendingLocks,
  filterUnprocessedLocks,
  loadState,
  redactErrorText,
  releaseInstanceLock,
  removePendingLock,
  resolveGasWithFallback,
  saveState,
  submitBatchWithFallback,
  tryAdvanceLastBlock,
  type AttestationBatchInput,
  type BatchReceiptLog,
  type BatchSubmission,
  type SubmitOutcome,
} from "./submitter.js";
import {
  answerUpdatedEventAbi,
  loadPriceState,
  parseAnswerUpdatedLog,
  priceOracleAbi,
  savePriceState,
  shouldSubmitPrice,
  submitPriceWithRetry,
} from "./price.js";

const creditcoinTestnet = defineChain({
  id: 102031,
  name: "Creditcoin Testnet",
  nativeCurrency: { name: "Test CTC", symbol: "tCTC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.cc3-testnet.creditcoin.network"] } },
  testnet: true,
});

const starsLockedEvent = parseAbiItem(
  "event StarsLocked(address indexed player, uint256 amount, uint256 indexed nonce, address creditcoinRecipient)",
);

// Hosted RPCs cap eth_getLogs ranges; poll in small chunks like the reference worker.
const LOG_CHUNK_SIZE = 50n;
// Price-feed lookback per iteration (Sepolia blocks). AnswerUpdated is sparse;
// a short trailing window is enough because the 6h heartbeat resubmits.
const PRICE_LOOKBACK_BLOCKS = 500n;

let shuttingDown = false;
process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down after this iteration...");
  shuttingDown = true;
});
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down after this iteration...");
  shuttingDown = true;
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function sortGroupsByHeight(groups: PendingLock[][]): PendingLock[][] {
  return groups.sort((a, b) => {
    const ha = a[0]?.blockHeight ?? 0n;
    const hb = b[0]?.blockHeight ?? 0n;
    if (ha < hb) return -1;
    if (ha > hb) return 1;
    return 0;
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const statePath = process.env["WORKER_STATE_PATH"] ?? join(process.cwd(), "bridge-state.json");
  const lockPath = join(dirname(statePath), "bridge-state.lock");
  const instanceLock = acquireInstanceLock(lockPath);
  if (!instanceLock.acquired) {
    console.error(`Another attestcoin worker holds ${lockPath}; refusing to start.`);
    process.exitCode = 1;
    return;
  }
  const state = loadState(statePath);

  const sourceClient = createPublicClient({ transport: http(config.sourceRpcUrl) });
  const creditcoinClient = createPublicClient({
    chain: creditcoinTestnet,
    transport: http(config.creditcoinRpcUrl),
  });
  const account = privateKeyToAccount(config.workerPrivateKey as Hex);
  const walletClient = createWalletClient({
    account,
    chain: creditcoinTestnet,
    transport: http(config.creditcoinRpcUrl),
  });
  const sourceAddress = config.sourceAddress as Hex;
  const ascAddress = config.ascAddress as Hex;
  const priceEnabled = config.priceOracleAddress !== "";
  const priceOracleAddress = config.priceOracleAddress as Hex;
  const priceStatePath = process.env["PRICE_STATE_PATH"] ?? join(process.cwd(), "price-state.json");
  const priceState = loadPriceState(priceStatePath);

  const proofBuilder = createProofBuilder(config.sourceChainKey, config.proofBuilderUrl);
  const chainInfo = createChainInfoPort(async (to: string, data: Hex) => {
    const result = await creditcoinClient.call({ to: to as Hex, data });
    if (result.data === undefined) throw new Error("Empty eth_call response from ChainInfo precompile");
    return result.data;
  });

  const submit = async (proof: AttestationProofInput): Promise<string> => {
    const siblings = proof.siblings.map((s) => ({ hash: s.hash, isLeft: s.isLeft }));
    // Domain model keeps chainKey/height as safe-integer numbers (guarded in
    // prover.requireUint64Number); viem encodes uint64 as bigint, so convert
    // at this boundary with BigInt().
    const executeArgs = [
      0,
      BigInt(proof.chainKey),
      BigInt(proof.height),
      proof.txBytes,
      proof.root,
      siblings,
      proof.digest,
      [...proof.roots],
    ] as const;
    const { gas, usedFallback } = await resolveGasWithFallback(
      () =>
        creditcoinClient.estimateContractGas({
          address: ascAddress,
          abi: ascAbi,
          functionName: "execute",
          args: [...executeArgs],
          account,
        }),
      { locks: 1, continuityRoots: proof.roots.length },
    );
    if (usedFallback) console.warn(`execute: using fallback gas ${gas.toString()}`);
    const hash = await walletClient.writeContract({
      address: ascAddress,
      abi: ascAbi,
      functionName: "execute",
      args: [...executeArgs],
      account,
      chain: creditcoinTestnet,
      gas,
    });
    const receipt = await creditcoinClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") throw new Error(`ASC submission reverted: ${hash}`);
    return hash;
  };

  // One executeBatch transaction per per-block group. Receipt
  // BridgeBatchExecuted events attribute per-lock results; a batch revert (or
  // send failure) throws so the caller can fall back to sequential singles.
  const submitBatch = async (batch: AttestationBatchInput): Promise<BatchSubmission> => {
    const merkleProofs = batch.merkleProofs.map((m) => ({
      root: m.root,
      siblings: m.siblings.map((s) => ({ hash: s.hash, isLeft: s.isLeft })),
    }));
    // Domain numbers to viem uint64 bigint at the encode boundary.
    const batchArgs = [
      0,
      BigInt(batch.chainKey),
      batch.heights.map((h) => BigInt(h)),
      [...batch.txBytesArray],
      merkleProofs,
      batch.digest,
      [...batch.continuityRoots],
    ] as const;
    const { gas, usedFallback } = await resolveGasWithFallback(
      () =>
        creditcoinClient.estimateContractGas({
          address: ascAddress,
          abi: ascAbi,
          functionName: "executeBatch",
          args: [...batchArgs],
          account,
        }),
      { locks: batch.txBytesArray.length, continuityRoots: batch.continuityRoots.length },
    );
    if (usedFallback) console.warn(`executeBatch: using fallback gas ${gas.toString()}`);
    const hash = await walletClient.writeContract({
      address: ascAddress,
      abi: ascAbi,
      functionName: "executeBatch",
      args: [...batchArgs],
      account,
      chain: creditcoinTestnet,
      gas,
    });
    const receipt = await creditcoinClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") throw new Error(`ASC batch submission reverted: ${hash}`);
    const logs: BatchReceiptLog[] = receipt.logs.map((l) => ({
      address: l.address,
      topics: [...l.topics] as BatchReceiptLog["topics"],
      data: l.data as BatchReceiptLog["data"],
    }));
    return {
      txHash: hash,
      successes: decodeBatchSuccesses(logs, ascAddress, batch.txBytesArray.length),
    };
  };

  // One updatePrice transaction for the attested Chainlink feed. Reuses the
  // same proof-builder + attestation-wait + exponential-retry shape as the
  // bridge path (see price.submitPriceWithRetry). Disabled when
  // PRICE_ORACLE_ADDRESS is empty.
  const submitPrice = async (proof: AttestationProofInput): Promise<string> => {
    const siblings = proof.siblings.map((s) => ({ hash: s.hash, isLeft: s.isLeft }));
    const priceArgs = [
      0,
      BigInt(proof.chainKey),
      BigInt(proof.height),
      proof.txBytes,
      proof.root,
      siblings,
      proof.digest,
      [...proof.roots],
    ] as const;
    const { gas, usedFallback } = await resolveGasWithFallback(
      () =>
        creditcoinClient.estimateContractGas({
          address: priceOracleAddress,
          abi: priceOracleAbi,
          functionName: "updatePrice",
          args: [...priceArgs],
          account,
        }),
      { locks: 1, continuityRoots: proof.roots.length },
    );
    if (usedFallback) console.warn(`updatePrice: using fallback gas ${gas.toString()}`);
    const hash = await walletClient.writeContract({
      address: priceOracleAddress,
      abi: priceOracleAbi,
      functionName: "updatePrice",
      args: [...priceArgs],
      account,
      chain: creditcoinTestnet,
      gas,
    });
    const receipt = await creditcoinClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") throw new Error(`Price oracle submission reverted: ${hash}`);
    return hash;
  };

  console.log(
    `Attestcoin bridge worker started (source key ${config.sourceChainKey}, confirmations ${config.confirmations}).`,
  );
  if (priceEnabled) {
    console.log(
      `Price watcher enabled (oracle ${config.priceOracleAddress}, feeds ${config.priceFeeds.length}, deviation ${config.priceDeviationBps}bps).`,
    );
  }
  let cursor: bigint | null =
    state.lastBlock !== undefined ? BigInt(state.lastBlock) + 1n : null;

  try {
    while (!shuttingDown) {
      try {
        const latest = await sourceClient.getBlockNumber();
        if (cursor === null) cursor = latest; // Start at the tip; history is not replayed.
        const confirmationsBig = BigInt(config.confirmations);
        const safeLatest = latest >= confirmationsBig ? latest - confirmationsBig : null;
        if (safeLatest !== null && cursor <= safeLatest && !shuttingDown) {
          // Chunk the safe range, then merge with the durable pending queue.
          // Pending locks are processed first (they sort lowest by height).
          const fresh: PendingLock[] = [];
          let chunkFrom = cursor;
          while (chunkFrom <= safeLatest) {
            if (shuttingDown) break;
            const chunkEnd = chunkFrom + LOG_CHUNK_SIZE - 1n;
            const chunkTo = chunkEnd > safeLatest ? safeLatest : chunkEnd;
            const found = await fetchPendingLocks(
              (from, to) =>
                sourceClient.getLogs({
                  address: sourceAddress,
                  event: starsLockedEvent,
                  fromBlock: from,
                  toBlock: to,
                }) as unknown as Promise<readonly unknown[]>,
              config.sourceAddress,
              chunkFrom,
              chunkTo,
            );
            fresh.push(...found);
            chunkFrom = chunkTo + 1n;
          }
          // Durability: enqueue everything scanned so far, even if a shutdown
          // arrived mid-scan. Never lose a lock that was already observed.
          if (fresh.length > 0) {
            enqueuePendingLocks(state, fresh);
            saveState(statePath, state);
          }
          if (!shuttingDown) {
            const allPending: PendingLock[] = (state.pending ?? []).map(deserializeLock);
            const groups = sortGroupsByHeight(groupLocksForBatch(allPending, 10));
            if (groups.length === 0) {
              // Nothing unprocessed in the safe range: advance the durable
              // cursor to the safe tip so restarts do not rescan empties.
              state.lastBlock = safeLatest.toString();
              saveState(statePath, state);
              cursor = safeLatest + 1n;
            } else {
              for (const group of groups) {
                if (shuttingDown) break;
                const first = group[0];
                if (first === undefined) continue;
                const groupHeight: bigint = first.blockHeight;
                // Pre-filter before any attestation wait or proof fetch.
                const active = filterUnprocessedLocks(state, group);
                if (active.length === 0) {
                  for (const done of group) {
                    removePendingLock(state, lockKey(done.player, done.nonce));
                  }
                  tryAdvanceLastBlock(state, groupHeight, true);
                  saveState(statePath, state);
                  if (state.lastBlock !== undefined) cursor = BigInt(state.lastBlock) + 1n;
                  continue;
                }
                const attestHeight: bigint = (active[0] as PendingLock).blockHeight;
                try {
                  await waitForAttestation({
                    chainKey: config.sourceChainKey,
                    blockHeight: attestHeight,
                    proofBuilder,
                    chainInfo,
                    pollIntervalMs: config.attestPollMs,
                    timeoutMs: config.attestTimeoutMs,
                  });
                } catch (error: unknown) {
                  console.error(
                    `Attestation wait failed for height ${attestHeight.toString()}:`,
                    redactErrorText(error instanceof Error ? error.message : String(error)),
                  );
                  break;
                }
                let proofs: (AttestationProofInput & { txHash: string })[];
                try {
                  proofs =
                    active.length > 1
                      ? await (async () => {
                          const batch = await proofBuilder.getBatchProof(
                            active.map((l) => l.txHash),
                          );
                          if (!batch.success || batch.data === undefined) {
                            throw new Error(`Batch proof failed: ${batch.error ?? "unknown"}`);
                          }
                          return adaptBatchProof(batch.data);
                        })()
                      : await (async () => {
                          const lock = active[0] as PendingLock;
                          const single = await proofBuilder.getProof(lock.txHash);
                          if (!single.success || single.data === undefined) {
                            throw new Error(`Proof failed for ${lock.txHash}: ${single.error ?? "unknown"}`);
                          }
                          return [{ ...adaptProof(single.data), txHash: lock.txHash }];
                        })();
                } catch (error: unknown) {
                  console.error(
                    "Proof fetch failed:",
                    redactErrorText(error instanceof Error ? error.message : String(error)),
                  );
                  break;
                }
                const byTx = new Map(proofs.map((p) => [p.txHash.toLowerCase(), p]));
                let groupOk = true;
                // Pair proofs back to locks in lock order; locks without a proof
                // stay pending while the rest of the group still submits.
                const readyLocks: PendingLock[] = [];
                const readyProofs: AttestationProofInput[] = [];
                for (const lock of active) {
                  if (shuttingDown) {
                    groupOk = false;
                    break;
                  }
                  const proof = byTx.get(lock.txHash.toLowerCase());
                  if (proof === undefined) {
                    console.error(`No proof returned for ${lock.txHash}; leaving lock pending.`);
                    groupOk = false;
                    continue;
                  }
                  readyLocks.push(lock);
                  readyProofs.push(proof);
                }
                if (readyLocks.length > 0 && !shuttingDown) {
                  // Multi-lock groups submit ONE executeBatch transaction with
                  // sequential execute fallback; single-lock groups
                  // keep using execute directly (see submitter).
                  const batchResult = await submitBatchWithFallback({
                    locks: readyLocks,
                    proofs: readyProofs,
                    submitBatch,
                    submitSingle: submit,
                    state,
                    maxRetries: config.maxRetries,
                  });
                  if (batchResult.batchTxHash !== undefined) {
                    console.log(
                      `Batch ${readyLocks.length} locks -> ${batchResult.status} (${batchResult.batchTxHash})`,
                    );
                  }
                  for (let i = 0; i < readyLocks.length; i += 1) {
                    const lock = readyLocks[i] as PendingLock;
                    const outcome = batchResult.outcomes[i] as SubmitOutcome;
                    console.log(
                      `Lock ${lock.player}:${lock.nonce.toString()} -> ${outcome.status}` +
                        (outcome.txHash !== undefined ? ` (${outcome.txHash})` : ""),
                    );
                    if (
                      outcome.status === "submitted" ||
                      outcome.status === "duplicate" ||
                      outcome.status === "skipped"
                    ) {
                      removePendingLock(state, lockKey(lock.player, lock.nonce));
                    } else {
                      // Failed after retries (or failed inside a batch): stays
                      // in pending for next iteration.
                      groupOk = false;
                    }
                  }
                } else if (readyLocks.length === 0) {
                  groupOk = false;
                }
                if (groupOk) {
                  tryAdvanceLastBlock(state, groupHeight, true);
                  saveState(statePath, state);
                  if (state.lastBlock !== undefined) cursor = BigInt(state.lastBlock) + 1n;
                } else {
                  // Never advance past failed/unprocessed groups. Persist the
                  // pending queue + cursor and stop this iteration; higher
                  // groups are retried only after this one succeeds.
                  saveState(statePath, state);
                  break;
                }
              }
            }
          } else {
            // Shutdown arrived mid-scan: persist without advancing.
            saveState(statePath, state);
          }
        }
      } catch (error: unknown) {
        console.error(
          "Worker iteration failed:",
          redactErrorText(error instanceof Error ? error.message : String(error)),
        );
      }
      if (priceEnabled && !shuttingDown) {
        try {
          const latest = await sourceClient.getBlockNumber();
          const priceFrom = latest > PRICE_LOOKBACK_BLOCKS ? latest - PRICE_LOOKBACK_BLOCKS : 0n;
          const rawLogs = (await sourceClient.getLogs({
            address: config.priceFeeds as Hex[],
            event: answerUpdatedEventAbi,
            fromBlock: priceFrom,
            toBlock: latest,
          })) as unknown as readonly unknown[];
          let best: ReturnType<typeof parseAnswerUpdatedLog> = null;
          for (const raw of rawLogs) {
            const parsed = parseAnswerUpdatedLog(raw, config.priceFeeds);
            if (parsed === null) continue;
            if (best === null || parsed.roundId > best.roundId) best = parsed;
          }
          if (best !== null) {
            const lastAnswer = priceState.lastAnswer !== null ? BigInt(priceState.lastAnswer) : null;
            const lastRoundId =
              priceState.lastRoundId !== null ? BigInt(priceState.lastRoundId) : null;
            const lastSubmittedAtMs =
              priceState.lastSubmittedAt !== null ? Date.parse(priceState.lastSubmittedAt) : null;
            const due = shouldSubmitPrice({
              lastAnswer,
              lastRoundId,
              lastSubmittedAtMs: Number.isNaN(lastSubmittedAtMs) ? null : lastSubmittedAtMs,
              currentAnswer: best.answer,
              currentRoundId: best.roundId,
              nowMs: Date.now(),
              deviationBps: config.priceDeviationBps,
              maxAgeMs: config.priceMaxAgeMs,
            });
            if (due) {
              await waitForAttestation({
                chainKey: config.sourceChainKey,
                blockHeight: best.blockHeight,
                proofBuilder,
                chainInfo,
                pollIntervalMs: config.attestPollMs,
                timeoutMs: config.attestTimeoutMs,
              });
              const single = await proofBuilder.getProof(best.txHash);
              if (!single.success || single.data === undefined) {
                throw new Error(`Price proof failed for ${best.txHash}: ${single.error ?? "unknown"}`);
              }
              const proof = adaptProof(single.data);
              const outcome = await submitPriceWithRetry({
                proof,
                submit: submitPrice,
                maxRetries: config.maxRetries,
              });
              console.log(`Price round ${best.roundId.toString()} -> ${outcome.status}`);
              if (outcome.status === "submitted") {
                priceState.lastAnswer = best.answer.toString();
                priceState.lastRoundId = best.roundId.toString();
                priceState.lastSubmittedAt = new Date().toISOString();
                priceState.lastUpdatedAt = best.updatedAt.toString();
                savePriceState(priceStatePath, priceState);
              }
            }
          }
        } catch (priceError: unknown) {
          console.error(
            "Price watcher iteration failed:",
            redactErrorText(priceError instanceof Error ? priceError.message : String(priceError)),
          );
        }
      }
      if (!shuttingDown) await sleep(config.pollIntervalMs);
    }
  } finally {
    // Shutdown correctness: persist the pending queue + cursor without
    // advancing past unprocessed groups, then release the instance lock.
    try {
      saveState(statePath, state);
    } catch (error: unknown) {
      console.error(
        "Failed to persist state on shutdown:",
        redactErrorText(error instanceof Error ? error.message : String(error)),
      );
    }
    try {
      savePriceState(priceStatePath, priceState);
    } catch (error: unknown) {
      console.error(
        "Failed to persist price state on shutdown:",
        redactErrorText(error instanceof Error ? error.message : String(error)),
      );
    }
    releaseInstanceLock(lockPath);
  }
  console.log("Worker stopped.");
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
