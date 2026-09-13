import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    BALANCE_REFRESH_ATTEMPTS,
    BALANCE_REFRESH_DELAY_MS,
    balanceSignature,
    refreshWalletBalances,
} from "../balances.ts";
import { useWalletStore, type BalanceRefetchers } from "../../stores/wallet-store.tsx";
import { __resetBridgeStub } from "../../test-support/stubs/bridge.ts";

const OWNER = "0x2222222222222222222222222222222222222222" as `0x${string}`;

const ONE_ETH_WEI = BigInt("1000000000000000000");

interface RefetchCalls {
    tctc: number;
    stars: number;
}

/**
 * Mock wagmi refetchers standing in for `useBalance` / `useReadContract`.
 * Sequences resolve in order per call; a `"throw"` entry rejects instead,
 * modelling an RPC failure for that chain only.
 */
function mockRefetchers(
    tctcSeq: Array<{ value: bigint; decimals: number } | "throw">,
    starsSeq: Array<bigint | "throw">,
): { refetchers: BalanceRefetchers; calls: RefetchCalls } {
    const calls: RefetchCalls = { tctc: 0, stars: 0 };
    let tctcAt = 0;
    let starsAt = 0;
    return {
        calls,
        refetchers: {
            refetchTctc: async () => {
                calls.tctc += 1;
                const next = tctcSeq[Math.min(tctcAt, tctcSeq.length - 1)];
                tctcAt += 1;
                if (next === "throw") throw new Error("tctc rpc down");
                return next;
            },
            refetchStars: async () => {
                calls.stars += 1;
                const next = starsSeq[Math.min(starsAt, starsSeq.length - 1)];
                starsAt += 1;
                if (next === "throw") throw new Error("stars rpc down");
                return next;
            },
        },
    };
}

function seedStore(overrides: {
    accountId?: `0x${string}`;
    tctc?: string;
    stars?: string;
    sepolia?: string;
    eth?: string;
    refetchers?: BalanceRefetchers;
} = {}): void {
    useWalletStore.getState().setAll({
        accountId: overrides.accountId ?? OWNER,
        isConnected: true,
        tctcBalance: overrides.tctc ?? "0",
        starsBalance: overrides.stars ?? "0",
        sepoliaStarsBalance: overrides.sepolia ?? "0",
        sepoliaEthBalance: overrides.eth ?? "0",
        balanceRefetchers: overrides.refetchers,
    });
}

function readStore(): { tctc: string; stars: string; sepolia: string; eth: string } {
    const s = useWalletStore.getState();
    return {
        tctc: s.tctcBalance,
        stars: s.starsBalance,
        sepolia: s.sepoliaStarsBalance,
        eth: s.sepoliaEthBalance,
    };
}

describe("balanceSignature (real change-detection logic)", () => {
    test("flattens all four balances into a tctc:stars:sepoliaStars:sepoliaEth string", () => {
        assert.equal(
            balanceSignature({ tctc: "1.5", stars: "2.5", sepoliaStars: "0", sepoliaEth: "0.5" }),
            "1.5:2.5:0:0.5",
        );
    });

    test("any single balance moves the signature", () => {
        const base = { tctc: "1", stars: "2", sepoliaStars: "3", sepoliaEth: "4" };
        const sig = balanceSignature(base);
        assert.notEqual(balanceSignature({ ...base, tctc: "9" }), sig);
        assert.notEqual(balanceSignature({ ...base, stars: "9" }), sig);
        assert.notEqual(balanceSignature({ ...base, sepoliaStars: "9" }), sig);
        assert.notEqual(balanceSignature({ ...base, sepoliaEth: "9" }), sig);
    });
});

describe("refreshWalletBalances (mocked refetchers, real store, no live network)", () => {
    beforeEach(() => {
        __resetBridgeStub();
        useWalletStore.getState().setAll({
            accountId: undefined,
            isConnected: false,
            tctcBalance: "0",
            starsBalance: "0",
            sepoliaStarsBalance: "0",
            sepoliaEthBalance: "0",
            balanceRefetchers: undefined,
        });
    });

    test("publishes all four balances in one cycle without awaitChange", async () => {
        const { refetchers, calls } = mockRefetchers(
            [{ value: ONE_ETH_WEI + ONE_ETH_WEI / BigInt(2), decimals: 18 }],
            [BigInt("2500000000000000000")],
        );
        seedStore({ refetchers, tctc: "1", stars: "1", sepolia: "0" });

        // The bridge token stub resolves null, so the Sepolia Stars side
        // reads '0' without ever touching an RPC. Sepolia ETH has no such
        // stub gate, so it is injected here (and in every live-path test
        // below) to keep the suite off the live network.
        await refreshWalletBalances({}, { fetchSepoliaEth: async () => "0" });

        assert.deepEqual(readStore(), { tctc: "1.5", stars: "2.5", sepolia: "0", eth: "0" });
        assert.deepEqual(calls, { tctc: 1, stars: 1 });
    });

    test("awaitChange stops after the first cycle when the change lands immediately", async () => {
        const { refetchers, calls } = mockRefetchers(
            [{ value: BigInt("2000000000000000000"), decimals: 18 }],
            [BigInt("5000000000000000000")],
        );
        seedStore({ refetchers, tctc: "1", stars: "1" });
        const delays: number[] = [];

        await refreshWalletBalances(
            { awaitChange: true },
            { delay: async (ms) => { delays.push(ms); }, fetchSepoliaEth: async () => "0" },
        );

        assert.deepEqual(readStore(), { tctc: "2", stars: "5", sepolia: "0", eth: "0" });
        assert.deepEqual(calls, { tctc: 1, stars: 1 });
        assert.deepEqual(delays, []);
    });

    test("awaitChange detects the change on retry after a stale first read", async () => {
        const { refetchers, calls } = mockRefetchers(
            [
                { value: ONE_ETH_WEI, decimals: 18 },
                { value: BigInt("3000000000000000000"), decimals: 18 },
            ],
            [BigInt("1000000000000000000"), BigInt("1000000000000000000")],
        );
        seedStore({ refetchers, tctc: "1", stars: "1" });
        const delays: number[] = [];

        await refreshWalletBalances(
            { awaitChange: true },
            { delay: async (ms) => { delays.push(ms); }, fetchSepoliaEth: async () => "0" },
        );

        assert.deepEqual(readStore(), { tctc: "3", stars: "1", sepolia: "0", eth: "0" });
        assert.deepEqual(calls, { tctc: 2, stars: 2 });
        assert.deepEqual(delays, [BALANCE_REFRESH_DELAY_MS]);
    });

    test("awaitChange with no change exhausts retries, then keeps the last read", async () => {
        const { refetchers, calls } = mockRefetchers(
            [{ value: ONE_ETH_WEI, decimals: 18 }],
            [BigInt("1000000000000000000")],
        );
        seedStore({ refetchers, tctc: "1", stars: "1" });
        const delays: number[] = [];

        await refreshWalletBalances(
            { awaitChange: true },
            { delay: async (ms) => { delays.push(ms); }, fetchSepoliaEth: async () => "0" },
        );

        assert.deepEqual(readStore(), { tctc: "1", stars: "1", sepolia: "0", eth: "0" });
        assert.deepEqual(calls, { tctc: BALANCE_REFRESH_ATTEMPTS, stars: BALANCE_REFRESH_ATTEMPTS });
        assert.equal(delays.length, BALANCE_REFRESH_ATTEMPTS - 1);
    });

    test("all-fail-safe: throwing refetchers resolve without touching the store", async () => {
        const { refetchers } = mockRefetchers(["throw"], ["throw"]);
        seedStore({ refetchers, tctc: "1", stars: "2", sepolia: "0" });

        await refreshWalletBalances(
            { awaitChange: true },
            { delay: async () => {}, fetchSepoliaEth: async () => "0" },
        );

        assert.deepEqual(readStore(), { tctc: "1", stars: "2", sepolia: "0", eth: "0" });
    });

    test("all-fail-safe: a throwing injected reader resolves without touching the store", async () => {
        seedStore({ tctc: "1", stars: "2", sepolia: "3" });

        await refreshWalletBalances(
            { awaitChange: true },
            {
                reader: {
                    readBalances: async () => {
                        throw new Error("node unsynced");
                    },
                },
            },
        );

        assert.deepEqual(readStore(), { tctc: "1", stars: "2", sepolia: "3", eth: "0" });
    });

    test("partial failure keeps the good chain and falls back for the failing one", async () => {
        const { refetchers } = mockRefetchers(
            ["throw"],
            [BigInt("7000000000000000000")],
        );
        seedStore({ refetchers, tctc: "1", stars: "1" });

        await refreshWalletBalances({}, { fetchSepoliaEth: async () => "0" });

        assert.deepEqual(readStore(), { tctc: "1", stars: "7", sepolia: "0", eth: "0" });
    });

    test("disconnected (no address) is a no-op that never calls refetch", async () => {
        const { refetchers, calls } = mockRefetchers(
            [{ value: BigInt("9000000000000000000"), decimals: 18 }],
            [BigInt("9000000000000000000")],
        );
        seedStore({ accountId: undefined, refetchers, tctc: "1", stars: "2", sepolia: "3" });
        useWalletStore.getState().setAll({ accountId: undefined, isConnected: false });

        await refreshWalletBalances({ awaitChange: true }, { delay: async () => {} });

        assert.deepEqual(readStore(), { tctc: "1", stars: "2", sepolia: "3", eth: "0" });
        assert.deepEqual(calls, { tctc: 0, stars: 0 });
    });

    test("missing refetchers resolve without touching the store", async () => {
        seedStore({ tctc: "4", stars: "5", sepolia: "6" });
        useWalletStore.getState().setAll({ balanceRefetchers: undefined });

        await refreshWalletBalances({ awaitChange: true }, { delay: async () => {} });

        assert.deepEqual(readStore(), { tctc: "4", stars: "5", sepolia: "6", eth: "0" });
    });

    test("retry budget follows the spec: 3 attempts ~1s apart", () => {
        assert.equal(BALANCE_REFRESH_ATTEMPTS, 3);
        assert.equal(BALANCE_REFRESH_DELAY_MS, 1000);
    });

    test("slow Sepolia never blocks the Creditcoin publish", async () => {
        const { refetchers } = mockRefetchers(
            [{ value: BigInt("2000000000000000000"), decimals: 18 }],
            [BigInt("5000000000000000000")],
        );
        seedStore({ refetchers, tctc: "1", stars: "1", sepolia: "0" });

        let resolveSepolia!: (value: string) => void;
        const sepoliaGate = new Promise<string>((resolve) => {
            resolveSepolia = resolve;
        });

        const refreshPromise = refreshWalletBalances(
            {},
            {
                fetchSepolia: () => sepoliaGate,
                fetchSepoliaEth: async () => "0",
                delay: async () => {},
            },
        );

        // Give the Creditcoin publish a chance to land while Sepolia is
        // still pending. Timing-tolerant: any prompt CC3 publish passes;
        // only a Sepolia-blocked publish fails.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const mid = readStore();
        assert.equal(mid.tctc, "2");
        assert.equal(mid.stars, "5");
        assert.equal(mid.sepolia, "0");
        assert.equal(mid.eth, "0");

        resolveSepolia("9");
        await refreshPromise;
        assert.deepEqual(readStore(), { tctc: "2", stars: "5", sepolia: "9", eth: "0" });
    });

    test("throwing Sepolia still publishes the Creditcoin side", async () => {
        const { refetchers } = mockRefetchers(
            [{ value: BigInt("2000000000000000000"), decimals: 18 }],
            [BigInt("5000000000000000000")],
        );
        seedStore({ refetchers, tctc: "1", stars: "1", sepolia: "3" });

        await refreshWalletBalances(
            {},
            {
                fetchSepolia: async () => {
                    throw new Error("sepolia down");
                },
                fetchSepoliaEth: async () => "0",
                delay: async () => {},
            },
        );

        assert.deepEqual(readStore(), { tctc: "2", stars: "5", sepolia: "3", eth: "0" });
    });

    test("Sepolia ETH publishes alongside Stars in the second phase", async () => {
        const { refetchers } = mockRefetchers(
            [{ value: BigInt("2000000000000000000"), decimals: 18 }],
            [BigInt("5000000000000000000")],
        );
        seedStore({ refetchers, tctc: "1", stars: "1", sepolia: "0", eth: "0" });

        await refreshWalletBalances(
            {},
            {
                fetchSepolia: async () => "9",
                fetchSepoliaEth: async () => "0.5",
                delay: async () => {},
            },
        );

        assert.deepEqual(readStore(), { tctc: "2", stars: "5", sepolia: "9", eth: "0.5" });
    });

    test("throwing Sepolia ETH preserves the current ETH value", async () => {
        const { refetchers } = mockRefetchers(
            [{ value: BigInt("2000000000000000000"), decimals: 18 }],
            [BigInt("5000000000000000000")],
        );
        seedStore({ refetchers, tctc: "1", stars: "1", sepolia: "0", eth: "0.7" });

        await refreshWalletBalances(
            {},
            {
                fetchSepolia: async () => "9",
                fetchSepoliaEth: async () => {
                    throw new Error("sepolia down");
                },
                delay: async () => {},
            },
        );

        assert.deepEqual(readStore(), { tctc: "2", stars: "5", sepolia: "9", eth: "0.7" });
    });

    test("awaitChange notices a Sepolia ETH move on retry", async () => {
        const { refetchers } = mockRefetchers(
            [{ value: ONE_ETH_WEI, decimals: 18 }],
            [BigInt("1000000000000000000")],
        );
        seedStore({ refetchers, tctc: "1", stars: "1", sepolia: "0", eth: "0" });
        const delays: number[] = [];
        let ethReads = 0;

        await refreshWalletBalances(
            { awaitChange: true },
            {
                fetchSepolia: async () => "0",
                fetchSepoliaEth: async () => {
                    ethReads += 1;
                    return ethReads === 1 ? "0" : "0.25";
                },
                delay: async (ms) => { delays.push(ms); },
            },
        );

        assert.deepEqual(readStore(), { tctc: "1", stars: "1", sepolia: "0", eth: "0.25" });
        assert.deepEqual(delays, [BALANCE_REFRESH_DELAY_MS]);
    });
});
