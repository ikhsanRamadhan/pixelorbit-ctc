import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    readSepoliaNativeBalance,
    readSepoliaStarsBalance,
    readSepoliaStarsSupply,
    type SepoliaBalanceReader,
    type SepoliaNativeReader,
    type SepoliaSupplyReader,
} from "../sepolia-balance.ts";

const STARS = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const OWNER = "0x2222222222222222222222222222222222222222" as `0x${string}`;

interface Call {
    stars: `0x${string}`;
    owner: `0x${string}`;
}

function mockReader(balance: bigint): { reader: SepoliaBalanceReader; calls: Call[] } {
    const calls: Call[] = [];
    return {
        calls,
        reader: {
            readBalance: async (stars, owner) => {
                calls.push({ stars, owner });
                return balance;
            },
        },
    };
}

function failingReader(): SepoliaBalanceReader {
    return {
        readBalance: async () => {
            throw new Error("sepolia rpc down");
        },
    };
}

describe("readSepoliaStarsBalance (mocked client, no live network)", () => {
    test("formats a whole-Stars balance like fetchStarsBalance", async () => {
        const { reader } = mockReader(BigInt("1000000000000000000"));
        assert.equal(await readSepoliaStarsBalance(STARS, OWNER, reader), "1");
    });

    test("keeps fractional Stars (no rounding)", async () => {
        const { reader } = mockReader(BigInt("2500000000000000000"));
        assert.equal(await readSepoliaStarsBalance(STARS, OWNER, reader), "2.5");
    });

    test("zero balance reads as '0'", async () => {
        const { reader } = mockReader(BigInt(0));
        assert.equal(await readSepoliaStarsBalance(STARS, OWNER, reader), "0");
    });

    test("passes the token and owner through to the reader verbatim", async () => {
        const { reader, calls } = mockReader(BigInt("3000000000000000000"));
        assert.equal(await readSepoliaStarsBalance(STARS, OWNER, reader), "3");
        assert.deepEqual(calls, [{ stars: STARS, owner: OWNER }]);
    });

    test("unresolved token returns '0' without touching the RPC", async () => {
        let touched = false;
        const reader: SepoliaBalanceReader = {
            readBalance: async () => {
                touched = true;
                return BigInt(0);
            },
        };
        assert.equal(await readSepoliaStarsBalance(null, OWNER, reader), "0");
        assert.equal(touched, false);
    });

    test("RPC failure never throws — it returns '0'", async () => {
        assert.equal(await readSepoliaStarsBalance(STARS, OWNER, failingReader()), "0");
    });

    test("calls are independent: a failure does not poison the next read", async () => {
        assert.equal(await readSepoliaStarsBalance(STARS, OWNER, failingReader()), "0");
        const { reader } = mockReader(BigInt("7000000000000000000"));
        assert.equal(await readSepoliaStarsBalance(STARS, OWNER, reader), "7");
    });
});

describe("readSepoliaStarsSupply (mocked client, no live network)", () => {
    function mockSupplyReader(supply: bigint): SepoliaSupplyReader {
        return { readTotalSupply: async () => supply };
    }

    test("formats minted-so-far supply without rounding", async () => {
        assert.equal(
            await readSepoliaStarsSupply(STARS, mockSupplyReader(BigInt("5000000000000000000"))),
            "5",
        );
    });

    test("unresolved token returns '0' without touching the RPC", async () => {
        let touched = false;
        const reader: SepoliaSupplyReader = {
            readTotalSupply: async () => {
                touched = true;
                return BigInt(0);
            },
        };
        assert.equal(await readSepoliaStarsSupply(null, reader), "0");
        assert.equal(touched, false);
    });

    test("RPC failure never throws — it returns '0'", async () => {
        const failing: SepoliaSupplyReader = {
            readTotalSupply: async () => {
                throw new Error("sepolia rpc down");
            },
        };
        assert.equal(await readSepoliaStarsSupply(STARS, failing), "0");
    });
});

describe("readSepoliaNativeBalance (mocked client, no live network)", () => {
    function mockNativeReader(balance: bigint): SepoliaNativeReader {
        return { readNativeBalance: async () => balance };
    }

    test("formats a native ETH balance without rounding", async () => {
        assert.equal(
            await readSepoliaNativeBalance(OWNER, mockNativeReader(BigInt("2500000000000000000"))),
            "2.5",
        );
    });

    test("zero balance reads as '0'", async () => {
        assert.equal(await readSepoliaNativeBalance(OWNER, mockNativeReader(BigInt(0))), "0");
    });

    test("passes the owner through to the reader verbatim", async () => {
        let seen: `0x${string}` | undefined;
        const reader: SepoliaNativeReader = {
            readNativeBalance: async (owner) => {
                seen = owner;
                return BigInt("1000000000000000000");
            },
        };
        assert.equal(await readSepoliaNativeBalance(OWNER, reader), "1");
        assert.equal(seen, OWNER);
    });

    test("RPC failure never throws — it returns '0'", async () => {
        const failing: SepoliaNativeReader = {
            readNativeBalance: async () => {
                throw new Error("sepolia rpc down");
            },
        };
        assert.equal(await readSepoliaNativeBalance(OWNER, failing), "0");
    });
});
