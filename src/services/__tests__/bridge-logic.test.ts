import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters } from "viem";
import {
    BRIDGE_EXECUTED_TOPIC,
    SEPOLIA_CHAIN_ID_HEX,
    SEPOLIA_EXPLORER_URL,
    ZERO_HASH,
    addressToTopic,
    buildSepoliaAddChainParams,
    canAdvanceWorkerStage,
    isBridgeWatcherActive,
    isUnknownChainError,
    isUserRejectionError,
    pollBridgeExecuted,
    releaseBridgeWatcher,
    toChainIdHex,
    tryAcquireBridgeWatcher,
    __clearBridgeWatchersForTests,
} from "../bridge-logic.ts";

const PLAYER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const OTHER = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const NONCE = BigInt(777);
const AMOUNT = BigInt(1_000_000_000_000_000_000);
const MINT_TX = ("0x" + "ab".repeat(32)) as `0x${string}`;
const ASC_ADDRESS = "0x1111111111111111111111111111111111111111";

function encodeBridgeData(amount: bigint, nonce: bigint): string {
    return encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }],
        [amount, nonce],
    );
}

function bridgeLog(overrides: {
    player?: string;
    recipient?: string;
    amount?: bigint;
    nonce?: bigint;
    transactionHash?: string | null;
} = {}) {
    const player = overrides.player ?? PLAYER;
    const recipient = overrides.recipient ?? RECIPIENT;
    const log: {
        topics: (string | null)[];
        data: string;
        transactionHash?: string;
    } = {
        topics: [
            BRIDGE_EXECUTED_TOPIC,
            addressToTopic(player),
            addressToTopic(recipient),
        ],
        data: encodeBridgeData(overrides.amount ?? AMOUNT, overrides.nonce ?? NONCE),
    };
    if (overrides.transactionHash === null) {
        // Intentionally absent: explorer dropped the hash field.
    } else {
        log.transactionHash = overrides.transactionHash ?? MINT_TX;
    }
    return log;
}

function mockFetch(result: unknown, ok = true) {
    return (async () => ({
        ok,
        json: async () => ({ status: "1", result }),
    })) as unknown as typeof fetch;
}

describe("addressToTopic", () => {
    test("left-pads a checksummed address to 32 bytes lowercase", () => {
        assert.equal(
            addressToTopic(PLAYER),
            `0x${"0".repeat(24)}1111111111111111111111111111111111111111`,
        );
    });

    test("lowercases mixed-case input", () => {
        assert.equal(
            addressToTopic("0xABcDEF1234567890abcDEF1234567890ABCDEF12"),
            `0x${"0".repeat(24)}abcdef1234567890abcdef1234567890abcdef12`,
        );
    });
});

describe("chain id helpers (4902 fallback + switch-back)", () => {
    test("Sepolia hex matches 0xaa36a7", () => {
        assert.equal(SEPOLIA_CHAIN_ID_HEX, "0xaa36a7");
        assert.equal(toChainIdHex(11155111), "0xaa36a7");
    });

    test("Creditcoin Testnet hex matches chain id 102031", () => {
        assert.equal(toChainIdHex(102031), "0x18e8f");
    });

    test("isUnknownChainError detects 4902 only", () => {
        assert.equal(isUnknownChainError({ code: 4902 }), true);
        assert.equal(isUnknownChainError({ code: 4001 }), false);
        assert.equal(isUnknownChainError(new Error("boom")), false);
        assert.equal(isUnknownChainError(null), false);
    });

    test("isUserRejectionError detects 4001 only", () => {
        assert.equal(isUserRejectionError({ code: 4001 }), true);
        assert.equal(isUserRejectionError({ code: 4902 }), false);
        assert.equal(isUserRejectionError(new Error("boom")), false);
        assert.equal(isUserRejectionError(null), false);
    });

    test("buildSepoliaAddChainParams carries env rpc + sepolia explorer", () => {
        const params = buildSepoliaAddChainParams("https://sepolia.example/rpc");
        assert.equal(params.chainId, "0xaa36a7");
        assert.deepEqual(params.rpcUrls, ["https://sepolia.example/rpc"]);
        assert.deepEqual(params.blockExplorerUrls, [SEPOLIA_EXPLORER_URL]);
        assert.equal(params.chainName, "Sepolia");
    });
});

describe("pollBridgeExecuted player+nonce matching (mocked Blockscout)", () => {
    test("match returns the ASC transaction hash", async () => {
        const found = await pollBridgeExecuted(PLAYER, RECIPIENT, NONCE, {
            ascAddress: ASC_ADDRESS,
            fetchImpl: mockFetch([bridgeLog()]),
        });
        assert.equal(found, MINT_TX);
    });

    test("wrong nonce keeps polling (null)", async () => {
        const found = await pollBridgeExecuted(PLAYER, RECIPIENT, NONCE, {
            ascAddress: ASC_ADDRESS,
            fetchImpl: mockFetch([bridgeLog({ nonce: NONCE + BigInt(1) })]),
        });
        assert.equal(found, null);
    });

    test("wrong player keeps polling (null)", async () => {
        const found = await pollBridgeExecuted(PLAYER, RECIPIENT, NONCE, {
            ascAddress: ASC_ADDRESS,
            fetchImpl: mockFetch([bridgeLog({ player: OTHER })]),
        });
        assert.equal(found, null);
    });

    test("log without transactionHash returns null (never the zero sentinel)", async () => {
        const found = await pollBridgeExecuted(PLAYER, RECIPIENT, NONCE, {
            ascAddress: ASC_ADDRESS,
            fetchImpl: mockFetch([bridgeLog({ transactionHash: null })]),
        });
        assert.equal(found, null);
        assert.notEqual(found, ZERO_HASH);
    });

    test("explicit zero hash is treated as missing (null)", async () => {
        const found = await pollBridgeExecuted(PLAYER, RECIPIENT, NONCE, {
            ascAddress: ASC_ADDRESS,
            fetchImpl: mockFetch([bridgeLog({ transactionHash: ZERO_HASH })]),
        });
        assert.equal(found, null);
    });

    test("unreachable explorer is not a failed bridge (null)", async () => {
        const failing = (async () => {
            throw new Error("network down");
        }) as unknown as typeof fetch;
        assert.equal(
            await pollBridgeExecuted(PLAYER, RECIPIENT, NONCE, { ascAddress: ASC_ADDRESS, fetchImpl: failing }),
            null,
        );
        assert.equal(
            await pollBridgeExecuted(PLAYER, RECIPIENT, NONCE, {
                ascAddress: ASC_ADDRESS,
                fetchImpl: mockFetch([], false),
            }),
            null,
        );
        assert.equal(
            await pollBridgeExecuted(PLAYER, RECIPIENT, NONCE, {
                ascAddress: ASC_ADDRESS,
                fetchImpl: mockFetch("No records found"),
            }),
            null,
        );
    });

    test("hung explorer request aborts into a miss, never a frozen poll (null)", async () => {
        // Hangs until aborted, like a stalled Blockscout connection: rejects
        // on the abort signal instead of settling on its own.
        const hanging = ((url: string, init?: { signal?: AbortSignal }) =>
            new Promise((_, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    reject(new DOMException("aborted", "AbortError"));
                });
            })) as unknown as typeof fetch;
        const startedAt = Date.now();
        assert.equal(
            await pollBridgeExecuted(PLAYER, RECIPIENT, NONCE, {
                ascAddress: ASC_ADDRESS,
                fetchImpl: hanging,
                timeoutMs: 50,
            }),
            null,
        );
        assert.ok(Date.now() - startedAt < 5000);
    });

    test("slow-but-answering explorer still matches inside the timeout", async () => {
        const slow = (async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { ok: true, json: async () => ({ status: "1", result: [bridgeLog()] }) };
        }) as unknown as typeof fetch;
        assert.equal(
            await pollBridgeExecuted(PLAYER, RECIPIENT, NONCE, {
                ascAddress: ASC_ADDRESS,
                fetchImpl: slow,
                timeoutMs: 1000,
            }),
            MINT_TX,
        );
    });
});

describe("reportWorkerStage ordering guards", () => {
    test("forward progress is allowed", () => {
        assert.equal(canAdvanceWorkerStage("waiting-attestation", "proving"), true);
        assert.equal(canAdvanceWorkerStage("proving", "submitting"), true);
        assert.equal(canAdvanceWorkerStage("locking", "proving"), true);
    });

    test("backward jump submitting -> proving is rejected", () => {
        assert.equal(canAdvanceWorkerStage("submitting", "proving"), false);
    });

    test("same-stage re-report is idempotent (allowed)", () => {
        assert.equal(canAdvanceWorkerStage("proving", "proving"), true);
        assert.equal(canAdvanceWorkerStage("submitting", "submitting"), true);
    });

    test("terminal or unknown phases never advance via the worker hook", () => {
        assert.equal(canAdvanceWorkerStage("minted", "proving"), false);
        assert.equal(canAdvanceWorkerStage("failed", "submitting"), false);
        assert.equal(canAdvanceWorkerStage("idle", "proving"), false);
    });
});

describe("retry single-writer (concurrent watchers -> one poller)", () => {
    beforeEach(() => {
        __clearBridgeWatchersForTests();
    });

    test("second acquire fails while the first watcher holds the key", () => {
        assert.equal(tryAcquireBridgeWatcher("k1"), true);
        assert.equal(isBridgeWatcherActive("k1"), true);
        assert.equal(tryAcquireBridgeWatcher("k1"), false);
        releaseBridgeWatcher("k1");
        assert.equal(isBridgeWatcherActive("k1"), false);
        assert.equal(tryAcquireBridgeWatcher("k1"), true);
        releaseBridgeWatcher("k1");
    });

    test("concurrent watchers elect exactly one poller", async () => {
        let polls = 0;
        async function watcher(): Promise<boolean> {
            if (!tryAcquireBridgeWatcher("shared")) return false;
            try {
                polls += 1;
                await new Promise((resolve) => setTimeout(resolve, 5));
                return true;
            } finally {
                releaseBridgeWatcher("shared");
            }
        }
        const results = await Promise.all([watcher(), watcher(), watcher()]);
        assert.equal(polls, 1);
        assert.deepEqual(results.filter(Boolean).length, 1);
    });
});
