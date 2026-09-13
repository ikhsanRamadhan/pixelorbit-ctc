import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    BRIDGE_PHASE_LABELS,
    BRIDGE_TIMELINE,
    bridgeKey,
    clearBridge,
    getActiveBridgeKey,
    getBridge,
    getBridgeFailureKind,
    makeBridgeNonce,
    setBridgePhase,
} from "../bridge-store.ts";

const PLAYER = "0xAbCDEF000000000000000000000000000000000001" as `0x${string}`;
const RECIPIENT = "0xAbCDEF000000000000000000000000000000000002" as `0x${string}`;

describe("bridge store (Sepolia lock timeline)", () => {
    beforeEach(() => {
        // Each test uses its own nonce so keys never collide across runs.
        for (const key of [bridgeKey(PLAYER, BigInt(1)), bridgeKey(PLAYER, BigInt(2)), bridgeKey(PLAYER, BigInt(3))]) {
            clearBridge(key);
        }
    });

    test("bridgeKey scopes the replay key to the player", () => {
        const mine = bridgeKey(PLAYER, BigInt(7));
        const other = bridgeKey(RECIPIENT, BigInt(7));
        assert.notEqual(mine, other);
        // Case-insensitive: the same lock always maps together.
        assert.equal(mine, bridgeKey(PLAYER.toLowerCase(), BigInt(7)));
    });

    test("makeBridgeNonce returns unique non-zero bigints", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 25; i++) {
            const nonce = makeBridgeNonce();
            assert.equal(typeof nonce, "bigint");
            assert.ok(nonce > BigInt(0));
            assert.ok(!seen.has(nonce.toString()));
            seen.add(nonce.toString());
        }
    });

    test("locking -> waiting-attestation -> minted advances one bridge", () => {
        const key = bridgeKey(PLAYER, BigInt(1));
        setBridgePhase(key, "locking", { player: PLAYER, nonce: BigInt(1), amount: BigInt(100), recipient: RECIPIENT });

        const locking = getBridge(key);
        assert.ok(locking);
        assert.equal(locking.phase, "locking");
        assert.equal(locking.player, PLAYER);

        setBridgePhase(key, "waiting-attestation", { sepoliaTxHash: "0x1234" });
        assert.equal(getBridge(key)?.phase, "waiting-attestation");
        // Untouched fields survive a partial update.
        assert.equal(getBridge(key)?.amount, BigInt(100));

        setBridgePhase(key, "minted", { ascTxHash: "0xabcd" });
        assert.equal(getBridge(key)?.phase, "minted");
        assert.equal(getBridge(key)?.ascTxHash, "0xabcd");

        clearBridge(key);
        assert.equal(getBridge(key), null);
    });

    test("getActiveBridgeKey skips terminal phases", () => {
        const live = bridgeKey(PLAYER, BigInt(2));
        const done = bridgeKey(PLAYER, BigInt(3));
        setBridgePhase(live, "waiting-attestation", { player: PLAYER, nonce: BigInt(2), amount: BigInt(1), recipient: RECIPIENT });
        setBridgePhase(done, "minted", { player: PLAYER, nonce: BigInt(3), amount: BigInt(1), recipient: RECIPIENT });

        assert.equal(getActiveBridgeKey(), live);

        setBridgePhase(live, "failed", { error: "boom" });
        assert.equal(getActiveBridgeKey(), null);

        clearBridge(live);
        clearBridge(done);
    });

    test("timeline covers the five visible stages in order", () => {
        assert.deepEqual(BRIDGE_TIMELINE, [
            "locking",
            "waiting-attestation",
            "proving",
            "submitting",
            "minted",
        ]);
        for (const phase of BRIDGE_TIMELINE) {
            assert.ok(BRIDGE_PHASE_LABELS[phase].length > 0);
        }
    });
});

describe("bridge failure-kind scoping (lock vs watch retry)", () => {
    const NONCES = [BigInt(11), BigInt(12), BigInt(13), BigInt(14), BigInt(15)];

    beforeEach(() => {
        for (const nonce of NONCES) clearBridge(bridgeKey(PLAYER, nonce));
    });

    test("lock-phase failure records errorKind lock", () => {
        const key = bridgeKey(PLAYER, NONCES[0]);
        setBridgePhase(key, "locking", { player: PLAYER, nonce: NONCES[0], amount: BigInt(10), recipient: RECIPIENT });
        setBridgePhase(key, "failed", { error: "Sepolia network switch rejected", errorKind: "lock" });
        assert.equal(getBridge(key)?.errorKind, "lock");
        assert.equal(getBridgeFailureKind(getBridge(key)), "lock");
        clearBridge(key);
    });

    test("watch-phase timeout records errorKind watch", () => {
        const key = bridgeKey(PLAYER, NONCES[1]);
        setBridgePhase(key, "waiting-attestation", {
            player: PLAYER,
            nonce: NONCES[1],
            amount: BigInt(10),
            recipient: RECIPIENT,
            sepoliaTxHash: "0x1234",
        });
        setBridgePhase(key, "failed", {
            error: "Bridge not detected within the watch window",
            errorKind: "watch",
        });
        assert.equal(getBridge(key)?.errorKind, "watch");
        assert.equal(getBridgeFailureKind(getBridge(key)), "watch");
        clearBridge(key);
    });

    test("legacy failed without errorKind infers watch when a lock tx exists", () => {
        const key = bridgeKey(PLAYER, NONCES[2]);
        setBridgePhase(key, "waiting-attestation", {
            player: PLAYER,
            nonce: NONCES[2],
            amount: BigInt(10),
            recipient: RECIPIENT,
            sepoliaTxHash: "0x1234",
        });
        setBridgePhase(key, "failed", { error: "old watch timeout" });
        // No errorKind stored, but the lock landed so only the watch can be retried.
        assert.equal(getBridge(key)?.errorKind, undefined);
        assert.equal(getBridgeFailureKind(getBridge(key)), "watch");
        clearBridge(key);
    });

    test("legacy failed without errorKind or lock tx infers lock", () => {
        const key = bridgeKey(PLAYER, NONCES[3]);
        setBridgePhase(key, "locking", { player: PLAYER, nonce: NONCES[3], amount: BigInt(10), recipient: RECIPIENT });
        setBridgePhase(key, "failed", { error: "Insufficient Sepolia Stars balance" });
        assert.equal(getBridgeFailureKind(getBridge(key)), "lock");
        clearBridge(key);
    });

    test("non-failed bridges have no failure kind", () => {
        const key = bridgeKey(PLAYER, NONCES[4]);
        setBridgePhase(key, "waiting-attestation", { player: PLAYER, nonce: NONCES[4], amount: BigInt(1), recipient: RECIPIENT });
        assert.equal(getBridgeFailureKind(getBridge(key)), null);
        assert.equal(getBridgeFailureKind(null), null);
        clearBridge(key);
    });
});
