import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fetchSepoliaEthBalance, fetchSepoliaStarsBalance } from "../wallet.ts";
import type { SepoliaBalanceReader, SepoliaNativeReader } from "../sepolia-balance.ts";
import {
    __resetBridgeStub,
    __setResolveSepoliaStarsThrows,
    __setSepoliaStarsToken,
} from "../../test-support/stubs/bridge.ts";

const STARS = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const OWNER = "0x2222222222222222222222222222222222222222" as `0x${string}`;

function trackingReader(balance: bigint): { reader: SepoliaBalanceReader; calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        reader: {
            readBalance: async () => {
                calls.push("readBalance");
                return balance;
            },
        },
    };
}

describe("fetchSepoliaStarsBalance (real wrapper, stubbed token + reader)", () => {
    beforeEach(() => {
        __resetBridgeStub();
    });

    test("returns '0' without a reader call when the token is unresolved", async () => {
        const { reader, calls } = trackingReader(BigInt(0));
        assert.equal(await fetchSepoliaStarsBalance(OWNER, reader), "0");
        assert.deepEqual(calls, []);
    });

    test("delegates to the reader with the resolved token and owner", async () => {
        __setSepoliaStarsToken(STARS);
        const seen: Array<{ stars: `0x${string}`; owner: `0x${string}` }> = [];
        const reader: SepoliaBalanceReader = {
            readBalance: async (stars, owner) => {
                seen.push({ stars, owner });
                return BigInt("4000000000000000000");
            },
        };
        assert.equal(await fetchSepoliaStarsBalance(OWNER, reader), "4");
        assert.deepEqual(seen, [{ stars: STARS, owner: OWNER }]);
    });

    test("reader failure yields '0' (same posture as fetchStarsBalance)", async () => {
        __setSepoliaStarsToken(STARS);
        const reader: SepoliaBalanceReader = {
            readBalance: async () => {
                throw new Error("sepolia rpc down");
            },
        };
        assert.equal(await fetchSepoliaStarsBalance(OWNER, reader), "0");
    });

    test("token lookup failure yields '0' without a reader call", async () => {
        __setResolveSepoliaStarsThrows(true);
        const { reader, calls } = trackingReader(BigInt("9000000000000000000"));
        assert.equal(await fetchSepoliaStarsBalance(OWNER, reader), "0");
        assert.deepEqual(calls, []);
    });
});

describe("fetchSepoliaEthBalance (real wrapper, stubbed reader)", () => {
    test("delegates to the reader with the owner and formats ETH", async () => {
        let seen: `0x${string}` | undefined;
        const reader: SepoliaNativeReader = {
            readNativeBalance: async (owner) => {
                seen = owner;
                return BigInt("500000000000000000");
            },
        };
        assert.equal(await fetchSepoliaEthBalance(OWNER, reader), "0.5");
        assert.equal(seen, OWNER);
    });

    test("reader failure yields '0' (same posture as fetchSepoliaStarsBalance)", async () => {
        const reader: SepoliaNativeReader = {
            readNativeBalance: async () => {
                throw new Error("sepolia rpc down");
            },
        };
        assert.equal(await fetchSepoliaEthBalance(OWNER, reader), "0");
    });
});
