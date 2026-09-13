import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import {
    RUN_TTL_MS,
    buildRunAttestationDigest,
    verifyRunAttestation,
} from "../run-attestation.ts";

// Throwaway deterministic keys, used only to sign test attestations.
const SIGNER_KEY = `0x${"11".repeat(32)}` as Hex;
const OTHER_KEY = `0x${"22".repeat(32)}` as Hex;
const CHAIN_ID = 102031;
const PLAYER = "0x1111111111111111111111111111111111111111" as Hex;
const NONCE =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

const signer = privateKeyToAccount(SIGNER_KEY);

async function issueAttestation(overrides: {
    chainId?: number;
    address?: string;
    runNonce?: Hex;
    issuedAt?: number;
    key?: Hex;
}): Promise<{ runAttestation: Hex; issuedAt: number }> {
    const issuedAt = overrides.issuedAt ?? Date.now();
    const account = privateKeyToAccount(overrides.key ?? SIGNER_KEY);
    const runAttestation = await account.signMessage({
        message: {
            raw: buildRunAttestationDigest({
                chainId: overrides.chainId ?? CHAIN_ID,
                address: overrides.address ?? PLAYER,
                runNonce: overrides.runNonce ?? NONCE,
                issuedAt,
            }),
        },
    });
    return { runAttestation, issuedAt };
}

describe("run attestation (stateless Vercel-safe run proof)", () => {
    test("a fresh server signature verifies for the same tuple", async () => {
        const { runAttestation, issuedAt } = await issueAttestation({});
        assert.equal(
            await verifyRunAttestation({
                chainId: CHAIN_ID,
                address: PLAYER,
                runNonce: NONCE,
                runAttestation,
                issuedAt,
                expectedSignerAddress: signer.address,
            }),
            true,
        );
    });

    test("the digest binds the player: another wallet fails", async () => {
        const { runAttestation, issuedAt } = await issueAttestation({});
        assert.equal(
            await verifyRunAttestation({
                chainId: CHAIN_ID,
                address: "0x2222222222222222222222222222222222222222",
                runNonce: NONCE,
                runAttestation,
                issuedAt,
                expectedSignerAddress: signer.address,
            }),
            false,
        );
    });

    test("the digest binds the nonce: a tampered nonce fails", async () => {
        const { runAttestation, issuedAt } = await issueAttestation({});
        assert.equal(
            await verifyRunAttestation({
                chainId: CHAIN_ID,
                address: PLAYER,
                runNonce:
                    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
                runAttestation,
                issuedAt,
                expectedSignerAddress: signer.address,
            }),
            false,
        );
    });

    test("an attestation from another signer fails", async () => {
        const { runAttestation, issuedAt } = await issueAttestation({ key: OTHER_KEY });
        assert.equal(
            await verifyRunAttestation({
                chainId: CHAIN_ID,
                address: PLAYER,
                runNonce: NONCE,
                runAttestation,
                issuedAt,
                expectedSignerAddress: signer.address,
            }),
            false,
        );
    });

    test("an attestation older than the TTL fails", async () => {
        const { runAttestation, issuedAt } = await issueAttestation({
            issuedAt: Date.now() - RUN_TTL_MS - 1000,
        });
        assert.equal(
            await verifyRunAttestation({
                chainId: CHAIN_ID,
                address: PLAYER,
                runNonce: NONCE,
                runAttestation,
                issuedAt,
                expectedSignerAddress: signer.address,
            }),
            false,
        );
    });

    test("an attestation issued in the future fails", async () => {
        const { runAttestation, issuedAt } = await issueAttestation({
            issuedAt: Date.now() + 60_000,
        });
        assert.equal(
            await verifyRunAttestation({
                chainId: CHAIN_ID,
                address: PLAYER,
                runNonce: NONCE,
                runAttestation,
                issuedAt,
                expectedSignerAddress: signer.address,
            }),
            false,
        );
    });

    test("a malformed signature fails without throwing", async () => {
        assert.equal(
            await verifyRunAttestation({
                chainId: CHAIN_ID,
                address: PLAYER,
                runNonce: NONCE,
                runAttestation: "0xdeadbeef",
                issuedAt: Date.now(),
                expectedSignerAddress: signer.address,
            }),
            false,
        );
    });
});
