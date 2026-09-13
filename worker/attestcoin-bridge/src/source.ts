import { decodeEventLog, isAddress, isHex } from "viem";

// Frozen PixelOrbitSource event. The ASC decoder depends on this exact shape:
// StarsLocked(address indexed player, uint256 amount, uint256 indexed nonce, address creditcoinRecipient)
export const starsLockedEventAbi = {
  type: "event",
  name: "StarsLocked",
  inputs: [
    { name: "player", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "nonce", type: "uint256", indexed: true },
    { name: "creditcoinRecipient", type: "address", indexed: false },
  ],
} as const;

export interface PendingLock {
  player: string;
  amount: bigint;
  nonce: bigint;
  recipient: string;
  blockHeight: bigint;
  txHash: string;
}

// Dedupe key shared with the submitter: scoped to (player, nonce) because the
// source contract keys usedNonces per player and distinct players may reuse a nonce.
export function lockKey(player: string, nonce: bigint): string {
  return `${player.toLowerCase()}:${nonce.toString()}`;
}

function isHexString(value: unknown): value is `0x${string}` {
  return typeof value === "string" && isHex(value);
}

function toBlockHeight(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && isHex(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function parseStarsLockedLog(log: unknown, sourceAddress: string): PendingLock | null {
  if (typeof log !== "object" || log === null) return null;
  const record = log as Record<string, unknown>;
  if (typeof record["address"] !== "string") return null;
  if ((record["address"] as string).toLowerCase() !== sourceAddress.toLowerCase()) return null;
  if (!Array.isArray(record["topics"]) || !isHexString(record["data"])) return null;
  const blockHeight = toBlockHeight(record["blockNumber"]);
  if (blockHeight === null) return null;
  if (typeof record["transactionHash"] !== "string") return null;

  let decoded: { args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({
      abi: [starsLockedEventAbi],
      topics: record["topics"] as [`0x${string}`, ...`0x${string}`[]],
      data: record["data"],
    }) as { args: Record<string, unknown> };
  } catch {
    return null;
  }
  const player = decoded.args["player"];
  const amount = decoded.args["amount"];
  const nonce = decoded.args["nonce"];
  const recipient = decoded.args["creditcoinRecipient"];
  if (typeof player !== "string" || !isAddress(player)) return null;
  if (typeof recipient !== "string" || !isAddress(recipient)) return null;
  if (typeof amount !== "bigint" || amount <= 0n) return null;
  if (typeof nonce !== "bigint") return null;
  return {
    player,
    amount,
    nonce,
    recipient,
    blockHeight,
    txHash: record["transactionHash"] as string,
  };
}

// Group locks by source block so each group shares one continuity proof,
// capped at maxBatchSize locks per group (mirrors PixelOrbitASC.MAX_BATCH_LOCKS;
// groups submit via one executeBatch transaction with sequential
// execute fallback — see submitter.submitBatchWithFallback).
export function groupLocksForBatch(locks: PendingLock[], maxBatchSize = 10): PendingLock[][] {
  const byBlock = new Map<string, PendingLock[]>();
  for (const lock of locks) {
    const key = lock.blockHeight.toString();
    const group = byBlock.get(key);
    if (group !== undefined) {
      group.push(lock);
    } else {
      byBlock.set(key, [lock]);
    }
  }
  const groups: PendingLock[][] = [];
  for (const group of byBlock.values()) {
    for (let i = 0; i < group.length; i += maxBatchSize) {
      groups.push(group.slice(i, i + maxBatchSize));
    }
  }
  return groups;
}

export async function fetchPendingLocks(
  getLogs: (fromBlock: bigint, toBlock: bigint) => Promise<readonly unknown[]>,
  sourceAddress: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<PendingLock[]> {
  if (toBlock < fromBlock) return [];
  const logs = await getLogs(fromBlock, toBlock);
  const locks: PendingLock[] = [];
  for (const log of logs) {
    const lock = parseStarsLockedLog(log, sourceAddress);
    if (lock !== null) locks.push(lock);
  }
  return locks;
}
