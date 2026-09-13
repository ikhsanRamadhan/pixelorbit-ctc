import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useWalletStore } from "../wallet-store.tsx";

describe("wallet store Sepolia balance field", () => {
    beforeEach(() => {
        useWalletStore.setState({
            accountId: undefined,
            isConnected: false,
            tctcBalance: "0",
            starsBalance: "0",
            sepoliaStarsBalance: "0",
            sepoliaEthBalance: "0",
        });
    });

    test("defaults sepoliaStarsBalance to '0'", () => {
        assert.equal(useWalletStore.getState().sepoliaStarsBalance, "0");
    });

    test("defaults sepoliaEthBalance to '0'", () => {
        assert.equal(useWalletStore.getState().sepoliaEthBalance, "0");
    });

    test("Creditcoin updates never clear the Sepolia balance", () => {
        useWalletStore.getState().setAll({ sepoliaStarsBalance: "7.5" });
        // Mirrors the Creditcoin effect payload: it writes every field it
        // owns, and must leave the Sepolia field alone.
        useWalletStore.getState().setAll({
            accountId: "0xabc",
            isConnected: true,
            tctcBalance: "1",
            starsBalance: "3",
        });
        assert.equal(useWalletStore.getState().sepoliaStarsBalance, "7.5");
    });

    test("Sepolia updates never clear the Creditcoin balance", () => {
        useWalletStore.getState().setAll({ tctcBalance: "1", starsBalance: "3" });
        // Mirrors the Sepolia effect payload: a slow Sepolia RPC resolving
        // late must not touch the Creditcoin fields.
        useWalletStore.getState().setAll({ sepoliaStarsBalance: "7.5" });
        assert.equal(useWalletStore.getState().starsBalance, "3");
        assert.equal(useWalletStore.getState().tctcBalance, "1");
        assert.equal(useWalletStore.getState().sepoliaStarsBalance, "7.5");
    });

    test("Sepolia ETH updates never clear the other balances", () => {
        useWalletStore.getState().setAll({
            tctcBalance: "1",
            starsBalance: "3",
            sepoliaStarsBalance: "7.5",
        });
        // Mirrors the Sepolia ETH effect payload: it writes only its own
        // field, leaving Stars (both chains) and tCTC alone.
        useWalletStore.getState().setAll({ sepoliaEthBalance: "0.5" });
        assert.equal(useWalletStore.getState().tctcBalance, "1");
        assert.equal(useWalletStore.getState().starsBalance, "3");
        assert.equal(useWalletStore.getState().sepoliaStarsBalance, "7.5");
        assert.equal(useWalletStore.getState().sepoliaEthBalance, "0.5");
    });

    test("Creditcoin updates never clear the Sepolia ETH balance", () => {
        useWalletStore.getState().setAll({ sepoliaEthBalance: "0.5" });
        useWalletStore.getState().setAll({
            accountId: "0xabc",
            isConnected: true,
            tctcBalance: "1",
            starsBalance: "3",
        });
        assert.equal(useWalletStore.getState().sepoliaEthBalance, "0.5");
    });
});
