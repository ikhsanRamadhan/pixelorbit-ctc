import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getMarketplaceBadge } from "../marketplace-badges.ts";

describe("getMarketplaceBadge", () => {
    test("open auction with bids reads On Bid, not Sold", () => {
        assert.deepEqual(getMarketplaceBadge({ isAuction: true, closed: false, hasBids: true }), {
            text: "On Bid",
            className: "bg-green-600",
        });
    });

    test("closed auction with bids reads Awaiting finalize", () => {
        assert.deepEqual(getMarketplaceBadge({ isAuction: true, closed: true, hasBids: true }), {
            text: "Awaiting",
            className: "bg-purple-600",
        });
    });

    test("closed auction without bids reads Closed", () => {
        assert.deepEqual(getMarketplaceBadge({ isAuction: true, closed: true, hasBids: false }), {
            text: "Closed",
            className: "bg-gray-600",
        });
    });

    test("open auction without bids reads Auction", () => {
        assert.deepEqual(getMarketplaceBadge({ isAuction: true, closed: false, hasBids: false }), {
            text: "Auction",
            className: "bg-blue-600",
        });
    });

    test("fixed-price listings always read Fixed", () => {
        assert.deepEqual(getMarketplaceBadge({ isAuction: false, closed: false, hasBids: false }), {
            text: "Fixed",
            className: "bg-red-600",
        });
    });
});
