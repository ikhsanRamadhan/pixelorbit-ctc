import { isAddress, isHex } from "viem";
import {
  DEFAULT_PRICE_DEVIATION_BPS,
  DEFAULT_PRICE_MAX_AGE_MS,
  parsePriceFeeds,
} from "./price.js";

export interface WorkerConfig {
  creditcoinRpcUrl: string;
  proofBuilderUrl: string;
  sourceChainKey: number;
  sourceRpcUrl: string;
  sourceAddress: string;
  ascAddress: string;
  workerPrivateKey: string;
  pollIntervalMs: number;
  maxRetries: number;
  confirmations: number;
  attestPollMs: number;
  attestTimeoutMs: number;
  priceOracleAddress: string;
  priceFeeds: string[];
  priceDeviationBps: number;
  priceMaxAgeMs: number;
}

const REQUIRED_VARS = [
  "CREDITCOIN_RPC_URL",
  "CREDITCOIN_PROOF_BUILDER_URL",
  "SOURCE_CHAIN_KEY",
  "SOURCE_RPC_URL",
  "SOURCE_ADDRESS",
  "ASC_ADDRESS",
  "WORKER_PRIVATE_KEY",
] as const;

function requireVar(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function requireHttpUrl(env: Record<string, string | undefined>, name: string): string {
  const value = requireVar(env, name);
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    throw new Error(`Invalid ${name}: expected an http(s) URL, got "${value}"`);
  }
  return value;
}

function requireAddress(env: Record<string, string | undefined>, name: string): string {
  const value = requireVar(env, name);
  if (!isAddress(value)) {
    throw new Error(`Invalid ${name}: expected a 0x address, got "${value}"`);
  }
  return value;
}

function requirePositiveInt(env: Record<string, string | undefined>, name: string): number {
  const raw = requireVar(env, name);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got "${raw}"`);
  }
  return parsed;
}

function optionalNonNegativeInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: expected a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

function optionalPositiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: expected a positive integer, got "${raw}"`);
  }
  return parsed;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  // Fail fast: every required var is checked by name before anything connects.
  for (const name of REQUIRED_VARS) {
    requireVar(env, name);
  }
  const workerPrivateKey = requireVar(env, "WORKER_PRIVATE_KEY");
  if (!isHex(workerPrivateKey) || workerPrivateKey.length !== 66) {
    throw new Error('Invalid WORKER_PRIVATE_KEY: expected a 0x-prefixed 32-byte hex key');
  }
  const priceOracleRaw = env["PRICE_ORACLE_ADDRESS"];
  let priceOracleAddress = "";
  if (priceOracleRaw !== undefined && priceOracleRaw.trim() !== "") {
    const trimmed = priceOracleRaw.trim();
    if (!isAddress(trimmed)) {
      throw new Error(`Invalid PRICE_ORACLE_ADDRESS: expected a 0x address, got "${priceOracleRaw}"`);
    }
    priceOracleAddress = trimmed;
  }
  return {
    creditcoinRpcUrl: requireHttpUrl(env, "CREDITCOIN_RPC_URL"),
    proofBuilderUrl: requireHttpUrl(env, "CREDITCOIN_PROOF_BUILDER_URL"),
    sourceChainKey: requirePositiveInt(env, "SOURCE_CHAIN_KEY"),
    sourceRpcUrl: requireHttpUrl(env, "SOURCE_RPC_URL"),
    sourceAddress: requireAddress(env, "SOURCE_ADDRESS"),
    ascAddress: requireAddress(env, "ASC_ADDRESS"),
    workerPrivateKey,
    pollIntervalMs: optionalNonNegativeInt(env, "POLL_INTERVAL_MS", 5000),
    maxRetries: optionalNonNegativeInt(env, "MAX_RETRIES", 5),
    confirmations: optionalPositiveInt(env, "CONFIRMATIONS", 12),
    attestPollMs: optionalPositiveInt(env, "ATTEST_POLL_MS", 15000),
    attestTimeoutMs: optionalPositiveInt(env, "ATTEST_TIMEOUT_MS", 1200000),
    priceOracleAddress,
    priceFeeds: parsePriceFeeds(env["PRICE_FEEDS"]),
    priceDeviationBps: optionalNonNegativeInt(env, "PRICE_DEVIATION_BPS", DEFAULT_PRICE_DEVIATION_BPS),
    priceMaxAgeMs: optionalPositiveInt(env, "PRICE_MAX_AGE_MS", DEFAULT_PRICE_MAX_AGE_MS),
  };
}
