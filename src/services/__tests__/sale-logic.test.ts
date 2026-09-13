import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    SEPOLIA_SALE_MAX_PER_TX,
    maxSellableStars,
    parseStarAmount,
    parseWholeStars,
    totalSaleCost,
} from "../sale-logic.ts";

describe("parseStarAmount", () => {
    test("accepts a plain whole-Stars amount", () => {
        assert.deepEqual(parseStarAmount("3", SEPOLIA_SALE_MAX_PER_TX), { amount: BigInt(3) });
    });

    test("trims surrounding whitespace", () => {
        assert.deepEqual(parseStarAmount("  2  ", SEPOLIA_SALE_MAX_PER_TX), { amount: BigInt(2) });
    });

    test("rejects an empty amount", () => {
        assert.deepEqual(parseStarAmount("", SEPOLIA_SALE_MAX_PER_TX), {
            error: "Enter a Stars amount",
        });
        assert.deepEqual(parseStarAmount("   ", SEPOLIA_SALE_MAX_PER_TX), {
            error: "Enter a Stars amount",
        });
    });

    test("rejects fractional and non-numeric input (no rounding)", () => {
        assert.deepEqual(parseStarAmount("1.5", SEPOLIA_SALE_MAX_PER_TX), {
            error: "Amount must be a whole number of Stars",
        });
        assert.deepEqual(parseStarAmount("abc", SEPOLIA_SALE_MAX_PER_TX), {
            error: "Amount must be a whole number of Stars",
        });
        assert.deepEqual(parseStarAmount("-2", SEPOLIA_SALE_MAX_PER_TX), {
            error: "Amount must be a whole number of Stars",
        });
    });

    test("rejects zero", () => {
        assert.deepEqual(parseStarAmount("0", SEPOLIA_SALE_MAX_PER_TX), {
            error: "Amount must be greater than zero",
        });
    });

    test("rejects amounts above the per-buy maximum", () => {
        assert.deepEqual(parseStarAmount("101", SEPOLIA_SALE_MAX_PER_TX), {
            error: "Amount exceeds the maximum of 100 Stars per buy",
        });
    });

    test("accepts exactly the per-buy maximum", () => {
        assert.deepEqual(parseStarAmount("100", SEPOLIA_SALE_MAX_PER_TX), { amount: BigInt(100) });
    });
});

describe("parseWholeStars (uncapped two-way door amounts)", () => {
    test("accepts a plain whole-Stars amount of any size", () => {
        assert.deepEqual(parseWholeStars("3"), { amount: BigInt(3) });
        assert.deepEqual(parseWholeStars("1000000"), { amount: BigInt(1000000) });
    });

    test("trims surrounding whitespace", () => {
        assert.deepEqual(parseWholeStars("  2  "), { amount: BigInt(2) });
    });

    test("rejects empty, fractional, non-numeric, and zero input", () => {
        assert.deepEqual(parseWholeStars(""), { error: "Enter a Stars amount" });
        assert.deepEqual(parseWholeStars("1.5"), { error: "Amount must be a whole number of Stars" });
        assert.deepEqual(parseWholeStars("abc"), { error: "Amount must be a whole number of Stars" });
        assert.deepEqual(parseWholeStars("0"), { error: "Amount must be greater than zero" });
    });
});

describe("totalSaleCost", () => {
    test("multiplies whole Stars by the onchain price (exact msg.value)", () => {
        const price = BigInt(100_000_000_000_000); // 0.0001 ether
        assert.equal(totalSaleCost(BigInt(3), price), BigInt(300_000_000_000_000));
    });

    test("zero amount costs zero", () => {
        assert.equal(totalSaleCost(BigInt(0), BigInt(10) ** BigInt(19)), BigInt(0));
    });
});

describe("maxSellableStars", () => {
    const sellPrice = BigInt(8) * BigInt(10) ** BigInt(18); // 8 tCTC

    test("floors the free pool over the sell price (10 covers exactly 1)", () => {
        const free = BigInt(10) * BigInt(10) ** BigInt(18); // 10 tCTC
        assert.equal(maxSellableStars(free, sellPrice), BigInt(1));
    });

    test("needs 16 tCTC before 2 Stars become sellable", () => {
        const fifteen = BigInt(15) * BigInt(10) ** BigInt(18);
        const sixteen = BigInt(16) * BigInt(10) ** BigInt(18);
        assert.equal(maxSellableStars(fifteen, sellPrice), BigInt(1));
        assert.equal(maxSellableStars(sixteen, sellPrice), BigInt(2));
    });

    test("returns zero for a dry pool or a non-positive sell price", () => {
        assert.equal(maxSellableStars(BigInt(0), sellPrice), BigInt(0));
        assert.equal(maxSellableStars(BigInt(-1), sellPrice), BigInt(0));
        assert.equal(maxSellableStars(sellPrice, BigInt(0)), BigInt(0));
    });
});
