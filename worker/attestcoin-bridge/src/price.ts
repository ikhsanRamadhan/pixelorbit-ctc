import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decodeEventLog, isAddress, type Hex } from "viem";
import type { AttestationProofInput } from "./prover.js";

// Chainlink Sepolia ETH/USD proxy (8 decimals). The AnswerUpdated event is
// emitted by the AGGREGATOR, not the proxy, and the aggregator rotates — so
// the worker watches the proxy plus every allowlisted aggregator in
// PRICE_FEEDS, and the oracle allowlists the same set onchain.
export const CHAINLINK_SEPOLIA_ETH_USD_PROXY =
  "0x694AA1769357215DE4FAC081bf1f309aDC325306";

export const DEFAULT_PRICE_FEEDS: string[] = [CHAINLINK_SEPOLIA_ETH_USD_PROXY];
export const DEFAULT_PRICE_DEVIATION_BPS = 100;
export const DEFAULT_PRICE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Frozen Chainlink Aggregator event: AnswerUpdated(int256 indexed current,
// uint256 indexed roundId, uint256 updatedAt). current/roundId arrive as
// topics, updatedAt arrives as data.
export const answerUpdatedEventAbi = {
  type: "event",
  name: "AnswerUpdated",
  inputs: [
    { name: "current", type: "int256", indexed: true },
    { name: "roundId", type: "uint256", indexed: true },
    { name: "updatedAt", type: "uint256", indexed: false },
  ],
} as const;

// Canonical ABI for PixelOrbitPriceOracle.updatePrice. Same flattened
// pass-through shape as PixelOrbitASC.execute. Selector parity with the
// compiled artifact is asserted in price.test.ts.
export const priceOracleAbi = [
  {
    type: "function",
    name: "updatePrice",
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
] as const;

function isHexString(value: unknown): value is Hex {
  return typeof value === "string" && value.startsWith("0x");
}

// Parse the PRICE_FEEDS comma list (proxy + allowlisted aggregators).
// Empty/missing returns the proxy default. Throws naming PRICE_FEEDS on bad input.
export function parsePriceFeeds(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_PRICE_FEEDS];
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return [...DEFAULT_PRICE_FEEDS];
  for (const part of parts) {
    if (!isAddress(part)) {
      throw new Error(`Invalid PRICE_FEEDS: expected 0x addresses, got "${part}"`);
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(part);
    }
  }
  return out;
}

export interface PriceDecision {
  lastAnswer: bigint | null;
  lastRoundId: bigint | null;
  lastSubmittedAtMs: number | null;
  currentAnswer: bigint;
  currentRoundId: bigint;
  nowMs: number;
  deviationBps: number;
  maxAgeMs: number;
}

// Submission cadence: first-ever always submits; non-positive answers never
// submit (the oracle would revert Bad answer); stale rounds never submit (the
// oracle would revert Stale round); otherwise submit on deviation >=
// deviationBps from the last submitted answer OR every maxAgeMs heartbeat.
export function shouldSubmitPrice(decision: PriceDecision): boolean {
  if (decision.currentAnswer <= 0n) return false;
  if (
    decision.lastAnswer === null ||
    decision.lastRoundId === null ||
    decision.lastSubmittedAtMs === null
  ) {
    return true;
  }
  if (decision.currentRoundId <= decision.lastRoundId) return false;
  const last = decision.lastAnswer;
  if (last <= 0n) return true;
  const diff = decision.currentAnswer > last ? decision.currentAnswer - last : last - decision.currentAnswer;
  if ((diff * 10000n) / last >= BigInt(decision.deviationBps)) return true;
  if (decision.nowMs - decision.lastSubmittedAtMs >= decision.maxAgeMs) return true;
  return false;
}

export interface ParsedAnswerUpdated {
  emitter: string;
  answer: bigint;
  roundId: bigint;
  updatedAt: bigint;
  txHash: string;
  blockHeight: bigint;
}

function toPriceBlockHeight(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && value.startsWith("0x")) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

// Parse one AnswerUpdated log through the injected allowlist. Returns null for
// malformed logs and foreign emitters so the watcher ignores them.
export function parseAnswerUpdatedLog(
  log: unknown,
  allowedEmitters: readonly string[],
): ParsedAnswerUpdated | null {
  if (typeof log !== "object" || log === null) return null;
  const record = log as Record<string, unknown>;
  if (typeof record["address"] !== "string") return null;
  const emitter = record["address"] as string;
  if (!allowedEmitters.some((a) => a.toLowerCase() === emitter.toLowerCase())) return null;
  if (!Array.isArray(record["topics"]) || !isHexString(record["data"])) return null;
  if (typeof record["transactionHash"] !== "string") return null;
  const blockHeight = toPriceBlockHeight(record["blockNumber"]);
  if (blockHeight === null) return null;
  let decoded: { args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({
      abi: [answerUpdatedEventAbi],
      topics: record["topics"] as [Hex, ...Hex[]],
      data: record["data"] as Hex,
    }) as { args: Record<string, unknown> };
  } catch {
    return null;
  }
  const answer = decoded.args["current"];
  const roundId = decoded.args["roundId"];
  const updatedAt = decoded.args["updatedAt"];
  if (typeof answer !== "bigint") return null;
  if (typeof roundId !== "bigint") return null;
  if (typeof updatedAt !== "bigint") return null;
  return {
    emitter,
    answer,
    roundId,
    updatedAt,
    txHash: record["transactionHash"] as string,
    blockHeight,
  };
}

// Deterministic oracle reverts: the same proof can never succeed, so it must
// not consume backoff. Matched case-insensitively as substrings.
// "Invalid proof" here matches CONTRACT revert reasons surfaced through
// submitPriceWithRetry — not offchain validation errors, which throw in
// adaptProof before submitPriceWithRetry is ever called.
const DETERMINISTIC_PRICE_REVERT_PATTERNS = [
  "stale round",
  "unknown emitter",
  "bad answer",
  "wrong chain",
  "invalid proof",
];

export function isDeterministicPriceRevertError(message: string): boolean {
  const lower = message.toLowerCase();
  return DETERMINISTIC_PRICE_REVERT_PATTERNS.some((p) => lower.includes(p));
}

export type PriceSubmitFn = (proof: AttestationProofInput) => Promise<string>;

export interface PriceSubmitOutcome {
  status: "submitted" | "skipped" | "failed";
  txHash?: string;
  attempts: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Submit one price proof with exponential backoff, reusing the bridge retry
// shape (1s * 2^(attempt-1) capped at 30s). Deterministic oracle reverts skip
// immediately without backoff.
export async function submitPriceWithRetry(args: {
  proof: AttestationProofInput;
  submit: PriceSubmitFn;
  maxRetries: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PriceSubmitOutcome> {
  const sleep = args.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, args.maxRetries);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const txHash = await args.submit(args.proof);
      return { status: "submitted", txHash, attempts: attempt };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDeterministicPriceRevertError(message)) {
        return { status: "skipped", attempts: attempt };
      }
      if (attempt < maxAttempts) {
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 30000));
      } else {
        return { status: "failed", attempts: maxAttempts };
      }
    }
  }
  return { status: "failed", attempts: maxAttempts };
}

export interface PriceState {
  lastAnswer: string | null;
  lastRoundId: string | null;
  lastSubmittedAt: string | null;
  lastUpdatedAt: string | null;
}

export function emptyPriceState(): PriceState {
  return { lastAnswer: null, lastRoundId: null, lastSubmittedAt: null, lastUpdatedAt: null };
}

function isPriceStateValue(value: unknown): value is PriceState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  for (const key of ["lastAnswer", "lastRoundId", "lastSubmittedAt", "lastUpdatedAt"]) {
    const entry = record[key];
    if (entry !== null && entry !== undefined && typeof entry !== "string") return false;
  }
  return true;
}

export function loadPriceState(path: string): PriceState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") return emptyPriceState();
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPriceStateValue(parsed)) {
      console.warn(`Invalid price state file at ${path}; starting fresh.`);
      return emptyPriceState();
    }
    return {
      lastAnswer: (parsed.lastAnswer as string | null | undefined) ?? null,
      lastRoundId: (parsed.lastRoundId as string | null | undefined) ?? null,
      lastSubmittedAt: (parsed.lastSubmittedAt as string | null | undefined) ?? null,
      lastUpdatedAt: (parsed.lastUpdatedAt as string | null | undefined) ?? null,
    };
  } catch {
    const backupPath = `${path}.corrupt.${Date.now()}`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(backupPath, raw, "utf8");
    } catch {
      // Best effort: a failed backup must not hide the recovery.
    }
    console.warn(`Corrupt price state file at ${path}; backed up to ${backupPath} and starting fresh.`);
    return emptyPriceState();
  }
}

export function savePriceState(path: string, state: PriceState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmpPath, path);
}
