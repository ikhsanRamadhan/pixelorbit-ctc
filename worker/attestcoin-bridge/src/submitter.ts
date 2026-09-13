import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decodeEventLog, type Hex } from "viem";
import { lockKey } from "./source.js";
import type { PendingLock } from "./source.js";
import type { AttestationProofInput } from "./prover.js";

// Batch cap shared with PixelOrbitASC.MAX_BATCH_LOCKS (worker groups by source
// block are already capped at this size in source.groupLocksForBatch).
export const MAX_BATCH_LOCKS = 10;

// Canonical ABI for PixelOrbitASC.execute and executeBatch. Shapes mirror the
// compiled artifact exactly (flattened pass-through fields, not tuples).
// Selector parity with the compiled artifact is asserted in bridge.test.ts.
export const ascAbi = [
  {
    type: "function",
    name: "execute",
    inputs: [
      { name: "action", type: "uint8" },
      { name: "chainKey", type: "uint64" },
      { name: "height", type: "uint64" },
      { name: "txBytes", type: "bytes" },
      { name: "root", type: "bytes32" },
      {
        name: "siblings",
        type: "tuple[]",
        components: [
          { name: "hash", type: "bytes32" },
          { name: "isLeft", type: "bool" },
        ],
      },
      { name: "digest", type: "bytes32" },
      { name: "roots", type: "bytes32[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "executeBatch",
    inputs: [
      { name: "action", type: "uint8" },
      { name: "chainKey", type: "uint64" },
      { name: "heights", type: "uint64[]" },
      { name: "txBytesArray", type: "bytes[]" },
      {
        name: "merkleProofs",
        type: "tuple[]",
        components: [
          { name: "root", type: "bytes32" },
          {
            name: "siblings",
            type: "tuple[]",
            components: [
              { name: "hash", type: "bytes32" },
              { name: "isLeft", type: "bool" },
            ],
          },
        ],
      },
      { name: "digest", type: "bytes32" },
      { name: "continuityRoots", type: "bytes32[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// PixelOrbitASC.BridgeBatchExecuted(uint256 index, bool success, bytes reason):
// no indexed params, so topics carry only the selector. Event-shape parity
// with the compiled artifact is asserted in bridge.test.ts.
export const bridgeBatchExecutedEventAbi = {
  type: "event",
  name: "BridgeBatchExecuted",
  inputs: [
    { name: "index", type: "uint256", indexed: false },
    { name: "success", type: "bool", indexed: false },
    { name: "reason", type: "bytes", indexed: false },
  ],
} as const;

// Batch input mirroring PixelOrbitASC.executeBatch: parallel heights / txBytes /
// Merkle proofs plus one shared continuity proof (digest + roots), in lock
// order so result index i always refers to locks[i].
export interface BatchMerkleProof {
  root: Hex;
  siblings: { hash: Hex; isLeft: boolean }[];
}

export interface AttestationBatchInput {
  chainKey: number;
  heights: number[];
  txBytesArray: Hex[];
  merkleProofs: BatchMerkleProof[];
  digest: Hex;
  continuityRoots: Hex[];
}

// One executeBatch transaction. successes carries the decoded
// BridgeBatchExecuted outcomes (index order) when the submitter decoded the
// receipt; when omitted (or length-mismatched) attribution is UNKNOWN — the
// caller must NOT mark locks submitted but fall back to per-lock singles.
export interface BatchSubmission {
  txHash: string;
  successes?: boolean[];
}

export type BatchSubmitFn = (batch: AttestationBatchInput) => Promise<BatchSubmission>;

// Pack per-lock proofs into one executeBatch input. All proofs in a group must
// share chainKey and the shared continuity proof (digest + roots, see
// prover.adaptBatchProof); heights may differ because executeBatch takes
// heights[] per lock. The first proof supplies the shared fields and every
// proof contributes its own height/txBytes/Merkle proof in order.
// Heterogeneous chains or continuity proofs are rejected: mixing them in one
// batch would misattribute results, so every proof is compared to proofs[0].
export function buildAttestationBatch(proofs: AttestationProofInput[]): AttestationBatchInput {
  if (proofs.length === 0) throw new Error("No locks");
  if (proofs.length > MAX_BATCH_LOCKS) throw new Error("Too many locks");
  const first = proofs[0] as AttestationProofInput;
  for (let i = 1; i < proofs.length; i += 1) {
    const proof = proofs[i] as AttestationProofInput;
    if (proof.chainKey !== first.chainKey) throw new Error("Heterogeneous chainKey");
    if (proof.digest.toLowerCase() !== first.digest.toLowerCase()) {
      throw new Error("Heterogeneous continuityProof");
    }
    if (
      proof.roots.length !== first.roots.length ||
      proof.roots.some((r, j) => r.toLowerCase() !== (first.roots[j] as Hex).toLowerCase())
    ) {
      throw new Error("Heterogeneous continuityProof");
    }
  }
  return {
    chainKey: first.chainKey,
    heights: proofs.map((p) => p.height),
    txBytesArray: proofs.map((p) => p.txBytes),
    merkleProofs: proofs.map((p) => ({ root: p.root, siblings: [...p.siblings] })),
    digest: first.digest,
    continuityRoots: [...first.roots],
  };
}

// Scaled gas fallback for canonical execute / executeBatch / updatePrice.
// When estimateGas fails (e.g. node rejects the precompile-heavy simulation),
// submit with a computed gas limit instead of failing outright:
//   (BASE + PER_LOCK * locks + PER_CONTINUITY_ROOT * roots) * 135/100.
//
// BASE / PER_LOCK / PER_CONTINUITY_ROOT are CONSERVATIVE STARTING VALUES that
// REQUIRE testnet calibration — see runbook step (g) "Batch gas headroom"
// (docs/DEPLOY-RUNBOOK.md): measure a worst-case 10-lock batch gasUsed live
// and tune these before trusting the batch path. Decoder + mint work per lock
// is heavy, so BASE 100k / PER_LOCK 500k start deliberately generous:
// too-high is safe (this only sets the tx `limit`; unused gas is refunded),
// while too-low reverts onchain and burns fees.
export const FALLBACK_GAS_BASE = 100000n;
export const FALLBACK_GAS_PER_LOCK = 500000n;
export const FALLBACK_GAS_PER_CONTINUITY_ROOT = 5000n;

export interface FallbackGasInput {
  locks: number;
  continuityRoots: number;
}

export function calculateFallbackGas(input: FallbackGasInput): bigint {
  const locks = BigInt(Math.max(0, Math.floor(input.locks)));
  const roots = BigInt(Math.max(0, Math.floor(input.continuityRoots)));
  const base = FALLBACK_GAS_BASE + FALLBACK_GAS_PER_LOCK * locks + FALLBACK_GAS_PER_CONTINUITY_ROOT * roots;
  return (base * 135n) / 100n;
}

export type GasFallbackLogger = Pick<typeof console, "warn">;

export async function resolveGasWithFallback(
  estimate: () => Promise<bigint>,
  input: FallbackGasInput,
  logger: GasFallbackLogger = console,
): Promise<{ gas: bigint; usedFallback: boolean }> {
  try {
    const gas = await estimate();
    return { gas, usedFallback: false };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Gas estimate failed, using fallback gas: ${redactErrorText(message)}`);
    return { gas: calculateFallbackGas(input), usedFallback: true };
  }
}

export interface ProcessedEntry {
  txHash: string;
  submittedAt: string;
}

export interface SkippedEntry {
  reason: string;
  skippedAt: string;
}

// JSON-safe form of PendingLock: bigint fields are decimal strings so the
// pending queue survives a save/load round-trip without Number() narrowing.
export interface SerializedPendingLock {
  player: string;
  amount: string;
  nonce: string;
  recipient: string;
  blockHeight: string;
  txHash: string;
}

export interface BridgeState {
  processed: Record<string, ProcessedEntry>;
  skipped: Record<string, SkippedEntry>;
  retries: Record<string, number>;
  failed: Record<string, string>;
  pending: SerializedPendingLock[];
  lastBlock?: string;
}

export function emptyState(): BridgeState {
  return { processed: {}, skipped: {}, retries: {}, failed: {}, pending: [] };
}

const LAST_BLOCK_RE = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringRecord(value: unknown): Record<string, { txHash: string; submittedAt: string }> {
  if (!isRecord(value)) return {};
  return value as Record<string, { txHash: string; submittedAt: string }>;
}

function asSkippedRecord(value: unknown): Record<string, SkippedEntry> {
  if (!isRecord(value)) return {};
  return value as Record<string, SkippedEntry>;
}

function asNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return value as Record<string, number>;
}

function asStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return value as Record<string, string>;
}

function isValidSerializedLock(value: unknown): value is SerializedPendingLock {
  if (!isRecord(value)) return false;
  return (
    typeof value["player"] === "string" &&
    typeof value["amount"] === "string" &&
    typeof value["nonce"] === "string" &&
    typeof value["recipient"] === "string" &&
    typeof value["blockHeight"] === "string" &&
    typeof value["txHash"] === "string"
  );
}

export function loadState(path: string): BridgeState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") return emptyState();
    throw error;
  }
  let parsed: Partial<BridgeState> & Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Partial<BridgeState> & Record<string, unknown>;
  } catch {
    const backupPath = `${path}.corrupt.${Date.now()}`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(backupPath, raw, "utf8");
    } catch {
      // Best effort: a failed backup must not hide the recovery.
    }
    console.warn(`Corrupt state file at ${path}; backed up to ${backupPath} and starting fresh.`);
    return emptyState();
  }
  if (parsed === null || typeof parsed !== "object") {
    console.warn(`Corrupt state file at ${path}; starting fresh.`);
    return emptyState();
  }
  let lastBlock: string | undefined;
  if (parsed.lastBlock !== undefined) {
    if (typeof parsed.lastBlock === "string" && LAST_BLOCK_RE.test(parsed.lastBlock)) {
      lastBlock = parsed.lastBlock;
    } else {
      console.warn(`Invalid lastBlock in ${path}; resetting cursor.`);
    }
  }
  const pendingRaw = (parsed as Record<string, unknown>)["pending"];
  const pending: SerializedPendingLock[] = Array.isArray(pendingRaw)
    ? pendingRaw.filter(isValidSerializedLock)
    : [];
  if (pendingRaw !== undefined && !Array.isArray(pendingRaw)) {
    console.warn(`Invalid pending queue in ${path}; resetting to empty.`);
  }
  const state: BridgeState = {
    processed: asStringRecord(parsed.processed),
    skipped: asSkippedRecord((parsed as Record<string, unknown>)["skipped"] ?? {}),
    retries: asNumberRecord(parsed.retries),
    failed: asStringMap(parsed.failed),
    pending,
  };
  if (lastBlock !== undefined) state.lastBlock = lastBlock;
  return state;
}

export function saveState(path: string, state: BridgeState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmpPath, path);
}

export type SubmitFn = (proof: AttestationProofInput) => Promise<string>;

export interface SubmitOutcome {
  status: "submitted" | "duplicate" | "failed" | "skipped";
  txHash?: string;
  attempts: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Deterministic on-chain reverts: the lock can never succeed, so it must be
// marked skipped (not retried). Matched case-insensitively as substrings.
// "Invalid proof" here matches CONTRACT revert reasons surfaced through
// submitWithRetry (a genuinely invalid proof never becomes valid on retry,
// and retrying only wastes gas) — not offchain validation errors, which throw
// in adaptProof/adaptBatchProof before submitWithRetry is ever called.
// The reason is stored as before.
const DETERMINISTIC_REVERT_PATTERNS = [
  "nonce used",
  "already executed",
  "already bridged",
  "invalid proof",
];

export function isDeterministicRevertError(message: string): boolean {
  const lower = message.toLowerCase();
  return DETERMINISTIC_REVERT_PATTERNS.some((p) => lower.includes(p));
}

export function serializeLock(lock: PendingLock): SerializedPendingLock {
  return {
    player: lock.player,
    amount: lock.amount.toString(),
    nonce: lock.nonce.toString(),
    recipient: lock.recipient,
    blockHeight: lock.blockHeight.toString(),
    txHash: lock.txHash,
  };
}

export function deserializeLock(stored: SerializedPendingLock): PendingLock {
  return {
    player: stored.player,
    amount: BigInt(stored.amount),
    nonce: BigInt(stored.nonce),
    recipient: stored.recipient,
    blockHeight: BigInt(stored.blockHeight),
    txHash: stored.txHash,
  };
}

export function isLockComplete(state: BridgeState, key: string): boolean {
  return state.processed[key] !== undefined || (state.skipped ?? {})[key] !== undefined;
}

// Queue locks for durable retry. Skips locks already processed/skipped or
// already queued. Returns the number of newly queued locks.
export function enqueuePendingLocks(state: BridgeState, locks: PendingLock[]): number {
  if (state.pending === undefined) state.pending = [];
  if (state.skipped === undefined) state.skipped = {};
  const queued = new Set(
    state.pending.map((p) => `${p.player.toLowerCase()}:${BigInt(p.nonce).toString()}`),
  );
  let added = 0;
  for (const lock of locks) {
    const key = lockKey(lock.player, lock.nonce);
    if (isLockComplete(state, key)) continue;
    if (queued.has(key)) continue;
    queued.add(key);
    state.pending.push(serializeLock(lock));
    added += 1;
  }
  return added;
}

export function removePendingLock(state: BridgeState, key: string): void {
  if (state.pending === undefined) return;
  state.pending = state.pending.filter(
    (p) => `${p.player.toLowerCase()}:${BigInt(p.nonce).toString()}` !== key,
  );
}

// Pre-filter before any attestation wait or proof fetch: drop locks that are
// already processed or skipped so no RPC work is wasted on them.
export function filterUnprocessedLocks(state: BridgeState, locks: PendingLock[]): PendingLock[] {
  return locks.filter((lock) => !isLockComplete(state, lockKey(lock.player, lock.nonce)));
}

// Advance the durable cursor only on full group success. Returns true when the
// cursor moved. Never moves backwards or past unprocessed groups: callers must
// stop at the first failed group in height order.
export function tryAdvanceLastBlock(state: BridgeState, height: bigint, succeeded: boolean): boolean {
  if (!succeeded) return false;
  const next = height.toString();
  if (state.lastBlock !== undefined && LAST_BLOCK_RE.test(state.lastBlock)) {
    if (BigInt(state.lastBlock) >= height) return false;
  }
  state.lastBlock = next;
  return true;
}

// Submit one proof with exponential backoff. Dedupe key is (player, nonce) —
// matching the ASC's keccak256(source, player, nonce) execution key scoping.
// Deterministic reverts (already executed/bridged) are marked skipped with 0
// retries instead of consuming backoff.
export async function submitWithRetry(args: {
  lock: PendingLock;
  proof: AttestationProofInput;
  submit: SubmitFn;
  state: BridgeState;
  maxRetries: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SubmitOutcome> {
  const sleep = args.sleep ?? defaultSleep;
  if (args.state.skipped === undefined) args.state.skipped = {};
  const key = lockKey(args.lock.player, args.lock.nonce);
  if (args.state.processed[key] !== undefined || args.state.skipped[key] !== undefined) {
    return { status: "duplicate", attempts: 0 };
  }
  const maxAttempts = Math.max(1, args.maxRetries);
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const txHash = await args.submit(args.proof);
      delete args.state.retries[key];
      delete args.state.failed[key];
      args.state.processed[key] = { txHash, submittedAt: new Date().toISOString() };
      return { status: "submitted", txHash, attempts: attempt };
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
      if (isDeterministicRevertError(lastError)) {
        delete args.state.retries[key];
        delete args.state.failed[key];
        args.state.skipped[key] = { reason: lastError.slice(0, 500), skippedAt: new Date().toISOString() };
        return { status: "skipped", attempts: attempt };
      }
      args.state.retries[key] = attempt;
      if (attempt < maxAttempts) {
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 30000));
      }
    }
  }
  args.state.failed[key] = lastError;
  return { status: "failed", attempts: maxAttempts };
}

export interface BatchSubmitOutcome {
  status: "batched" | "single" | "fallback";
  batchTxHash?: string;
  outcomes: SubmitOutcome[];
}

// Submit one per-block group: multi-lock groups go out as a single executeBatch
// transaction; a batch revert (or send failure) falls back to sequential
// execute submits, each with full retry + deterministic-skip handling
// (a sent-but-unconfirmed batch surfaces on retry as per-lock "Nonce used" →
// skipped, so the fallback is self-healing). Unattributable batch receipts
// (successes omitted or length-mismatched — decodeBatchSuccesses returned
// undefined) are treated as UNKNOWN: no lock is marked submitted or failed,
// and the same sequential-singles fallback runs immediately in this call.
// Single-lock groups keep using execute directly. Callers must pass
// locks and proofs in the same order; outcomes[i] always refers to locks[i].
// Already-completed locks are reported as duplicate and excluded from the
// batch. Failed-after-batch locks (successes[i] === false) are recorded in
// state.failed and left for the caller to keep pending — the next iteration
// retries them as singles, where deterministic cases become skipped.
export async function submitBatchWithFallback(args: {
  locks: PendingLock[];
  proofs: AttestationProofInput[];
  submitBatch: BatchSubmitFn;
  submitSingle: SubmitFn;
  state: BridgeState;
  maxRetries: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BatchSubmitOutcome> {
  const sleep = args.sleep ?? defaultSleep;
  if (args.locks.length !== args.proofs.length) throw new Error("Length mismatch");
  const outcomes: SubmitOutcome[] = new Array(args.locks.length);
  const fresh: { lock: PendingLock; proof: AttestationProofInput; at: number }[] = [];
  for (let i = 0; i < args.locks.length; i += 1) {
    const lock = args.locks[i] as PendingLock;
    if (isLockComplete(args.state, lockKey(lock.player, lock.nonce))) {
      outcomes[i] = { status: "duplicate", attempts: 0 };
    } else {
      fresh.push({ lock, proof: args.proofs[i] as AttestationProofInput, at: i });
    }
  }
  if (fresh.length === 0) {
    return { status: "batched", outcomes };
  }
  if (fresh.length === 1) {
    const only = fresh[0] as { lock: PendingLock; proof: AttestationProofInput; at: number };
    outcomes[only.at] = await submitWithRetry({
      lock: only.lock,
      proof: only.proof,
      submit: args.submitSingle,
      state: args.state,
      maxRetries: args.maxRetries,
      sleep,
    });
    return { status: "single", outcomes };
  }
  const batch = buildAttestationBatch(fresh.map((f) => f.proof));
  let submission: BatchSubmission;
  try {
    submission = await args.submitBatch(batch);
  } catch {
    for (const item of fresh) {
      outcomes[item.at] = await submitWithRetry({
        lock: item.lock,
        proof: item.proof,
        submit: args.submitSingle,
        state: args.state,
        maxRetries: args.maxRetries,
        sleep,
      });
    }
    return { status: "fallback", outcomes };
  }
  const successes = submission.successes;
  if (
    successes === undefined ||
    !Array.isArray(successes) ||
    successes.length !== fresh.length ||
    !successes.every((s) => typeof s === "boolean")
  ) {
    // Unknown attribution (malformed/missing batch events): mark NOTHING as
    // submitted — locks stay pending — and immediately fall back to per-lock
    // singles in this same run via the sequential-fallback path.
    for (const item of fresh) {
      outcomes[item.at] = await submitWithRetry({
        lock: item.lock,
        proof: item.proof,
        submit: args.submitSingle,
        state: args.state,
        maxRetries: args.maxRetries,
        sleep,
      });
    }
    return { status: "fallback", outcomes };
  }
  for (let k = 0; k < fresh.length; k += 1) {
    const item = fresh[k] as { lock: PendingLock; proof: AttestationProofInput; at: number };
    const key = lockKey(item.lock.player, item.lock.nonce);
    if ((successes as boolean[])[k] === false) {
      const reason = `Batch index ${k} failed in ${submission.txHash}`;
      args.state.failed[key] = reason;
      outcomes[item.at] = { status: "failed", attempts: 1 };
    } else {
      delete args.state.retries[key];
      delete args.state.failed[key];
      args.state.processed[key] = { txHash: submission.txHash, submittedAt: new Date().toISOString() };
      outcomes[item.at] = { status: "submitted", txHash: submission.txHash, attempts: 1 };
    }
  }
  return { status: "batched", batchTxHash: submission.txHash, outcomes };
}

// Minimal receipt-log shape for BridgeBatchExecuted decoding.
export interface BatchReceiptLog {
  address: string;
  topics: readonly Hex[];
  data: Hex;
}

// Decode per-index executeBatch results from transaction receipt logs, in index
// order. BridgeBatchExecuted is unchanged by the canonical rewrite (verified
// against the compiled PixelOrbitASC artifact: still
// BridgeBatchExecuted(uint256,bool,bytes) non-indexed), so this decoder is
// kept as is. Returns undefined when the logs do not carry exactly `expected`
// well-formed BridgeBatchExecuted events for this ASC (foreign events and
// undecodable logs are ignored) so the caller treats attribution as UNKNOWN:
// it must leave locks pending (NOT mark them submitted) and immediately fall
// back to per-lock singles in the same run.
export function decodeBatchSuccesses(
  logs: readonly BatchReceiptLog[],
  ascAddress: string,
  expected: number,
): boolean[] | undefined {
  const asc = ascAddress.toLowerCase();
  const found: { index: bigint; success: boolean }[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== asc) continue;
    if (log.topics.length === 0) continue;
    let decoded: { args: { index: unknown; success: unknown } };
    try {
      decoded = decodeEventLog({
        abi: [bridgeBatchExecutedEventAbi],
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      }) as unknown as { args: { index: unknown; success: unknown } };
    } catch {
      continue;
    }
    if (typeof decoded.args.index !== "bigint" || typeof decoded.args.success !== "boolean") {
      continue;
    }
    found.push({ index: decoded.args.index, success: decoded.args.success });
  }
  if (found.length !== expected) return undefined;
  found.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  for (let i = 0; i < found.length; i += 1) {
    if ((found[i] as { index: bigint }).index !== BigInt(i)) return undefined;
  }
  return found.map((f) => f.success);
}

// Single-instance guard: a lockfile holding the owner PID. Fresh locks refuse
// startup; stale locks (>5 min) are taken over with a warning.
export const STALE_LOCK_MS = 5 * 60 * 1000;

export function acquireInstanceLock(lockPath: string): { acquired: boolean; stale: boolean } {
  try {
    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > STALE_LOCK_MS) {
      console.warn(`Taking over stale worker lock at ${lockPath} (age ${Math.round(ageMs / 1000)}s).`);
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, String(process.pid), "utf8");
      return { acquired: true, stale: true };
    }
    return { acquired: false, stale: false };
  } catch (error: unknown) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, String(process.pid), "utf8");
    return { acquired: true, stale: false };
  }
}

export function releaseInstanceLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (error: unknown) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
}

// Strip credentials and query strings from RPC URLs before logging so secrets
// embedded in hosted endpoints never land in error output.
export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.replace(/:\/\/[^/]*@/, "://").split("?")[0]?.split("#")[0] ?? url;
  }
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s"'`]+/g;

export function redactErrorText(text: string): string {
  return text.replace(URL_IN_TEXT_RE, (match) => {
    const trailing = match.match(/[),.;!]+$/)?.[0] ?? "";
    const core = trailing.length > 0 ? match.slice(0, -trailing.length) : match;
    return `${redactRpcUrl(core)}${trailing}`;
  });
}
