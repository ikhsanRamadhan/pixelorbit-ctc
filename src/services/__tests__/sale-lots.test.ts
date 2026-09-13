import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters } from "viem";
import { addressToTopic } from "../bridge-logic.ts";
import {
    STARS_DEPOSITED_TOPIC,
    fetchMyCC3Lots,
    findDepositorLotIds,
} from "../sale.ts";

const PLAYER = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const OTHER = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const SALE = "0x4444444444444444444444444444444444444444" as `0x${string}`;

/** One `StarsDeposited(depositor, starAmount, lotId)` log, depositor indexed. */
function depositLog(depositor: string, lotId: bigint, starAmount = BigInt(3)) {
    return {
        topics: [STARS_DEPOSITED_TOPIC, addressToTopic(depositor)],
        data: encodeAbiParameters(
            [{ type: "uint256" }, { type: "uint256" }],
            [starAmount, lotId],
        ),
    };
}

function mockFetch(result: unknown, ok = true) {
    return (async () => ({
        ok,
        json: async () => ({ status: "1", result }),
    })) as unknown as typeof fetch;
}

/** Live `lots(lotId)` double: lot 1 is fully sold, the rest stay open. */
function mockReadLot(lotId: bigint) {
    return Promise.resolve({
        seller: PLAYER,
        remaining: lotId === BigInt(1) ? BigInt(0) : BigInt(3),
    });
}

const DEPS = { saleAddress: SALE, readLot: mockReadLot };

describe("findDepositorLotIds (pure log matcher)", () => {
    test("collects the depositor's lot ids oldest-first", () => {
        assert.deepEqual(
            findDepositorLotIds([depositLog(PLAYER, BigInt(0)), depositLog(PLAYER, BigInt(2))], PLAYER),
            [BigInt(0), BigInt(2)],
        );
    });

    test("ignores other depositors' logs", () => {
        assert.deepEqual(
            findDepositorLotIds([depositLog(OTHER, BigInt(0)), depositLog(PLAYER, BigInt(1))], PLAYER),
            [BigInt(1)],
        );
    });

    test("dedupes a log repeated across explorer pages", () => {
        const log = depositLog(PLAYER, BigInt(4));
        assert.deepEqual(findDepositorLotIds([log, log], PLAYER), [BigInt(4)]);
    });

    test("skips foreign events and malformed logs without throwing", () => {
        assert.deepEqual(
            findDepositorLotIds(
                [
                    { topics: ["0xdead"], data: "0x" },
                    { topics: [STARS_DEPOSITED_TOPIC, addressToTopic(PLAYER)], data: "0x" },
                    depositLog(PLAYER, BigInt(7)),
                ],
                PLAYER,
            ),
            [BigInt(7)],
        );
    });

    test("non-array explorer result yields no lots", () => {
        assert.deepEqual(findDepositorLotIds(undefined, PLAYER), []);
    });
});

describe("fetchMyCC3Lots (mocked explorer + lot reads, no live network)", () => {
    test("returns open lots with live remaining, filtering sold-out lots", async () => {
        const lots = await fetchMyCC3Lots(PLAYER, {
            ...DEPS,
            fetchImpl: mockFetch([depositLog(PLAYER, BigInt(0)), depositLog(PLAYER, BigInt(1))]),
        });
        assert.deepEqual(lots, [{ lotId: BigInt(0), remaining: BigInt(3) }]);
    });

    test("no deposits yields an empty list, not null", async () => {
        assert.deepEqual(
            await fetchMyCC3Lots(PLAYER, { ...DEPS, fetchImpl: mockFetch([]) }),
            [],
        );
    });

    test("explorer error status yields null (panel falls back to manual entry)", async () => {
        assert.equal(
            await fetchMyCC3Lots(PLAYER, { ...DEPS, fetchImpl: mockFetch([], false) }),
            null,
        );
    });

    test('"No records found" string result yields null, not a throw', async () => {
        assert.equal(
            await fetchMyCC3Lots(PLAYER, { ...DEPS, fetchImpl: mockFetch("No records found") }),
            null,
        );
    });

    test("dropped explorer request yields null", async () => {
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
            await fetchMyCC3Lots(PLAYER, { ...DEPS, fetchImpl: hanging, timeoutMs: 50 }),
            null,
        );
        assert.ok(Date.now() - startedAt < 5000);
    });

    test("failing lot reads yield null", async () => {
        assert.equal(
            await fetchMyCC3Lots(PLAYER, {
                saleAddress: SALE,
                fetchImpl: mockFetch([depositLog(PLAYER, BigInt(0))]),
                readLot: async () => {
                    throw new Error("cc3 rpc down");
                },
            }),
            null,
        );
    });

    test("unconfigured sale short-circuits to null without any fetch", async () => {
        let touched = false;
        const spy = (async () => {
            touched = true;
            return { ok: true, json: async () => ({ result: [] }) };
        }) as unknown as typeof fetch;
        // No saleAddress injected and NEXT_PUBLIC_CC_SALE_ADDRESS is empty
        // under node --test, so the env-gated constant is '0x'.
        assert.equal(await fetchMyCC3Lots(PLAYER, { fetchImpl: spy }), null);
        assert.equal(touched, false);
    });
});
