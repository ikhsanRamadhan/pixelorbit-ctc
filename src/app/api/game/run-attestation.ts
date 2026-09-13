import { encodePacked, keccak256, recoverMessageAddress, type Hex } from 'viem'

/**
 * Stateless run attestation shared by `/api/game/start` (issues) and
 * `/api/game/open` (verifies for crate claims).
 *
 * Replaces the old in-memory `run-registry` Map, which only worked on a
 * single server process. Serverless hosts (Vercel Fluid) route `/start` and
 * `/open` to different instances or regions, so a nonce registered in one
 * process was unknown in the other and every crate open failed with 403.
 * A signature needs no shared storage: any instance holding
 * `SCORE_SIGNER_KEY` can verify an attestation issued by any other.
 *
 * The attestation binds (player, run nonce, issuance time) on this chain.
 * The domain separator keeps it distinct from the leaderboard run token
 * and from the `claimCrates` authorization, so signatures cannot be
 * replayed across protocols. Double-claims stay blocked on-chain by
 * `PixelOrbitItem.usedRunNonces`.
 */

export const RUN_ATTESTATION_DOMAIN = 'PIXELORBIT-RUN'

export const RUN_TTL_MS = 24 * 3600 * 1000

export interface RunAttestationInput {
    chainId: number
    address: string
    runNonce: Hex
    issuedAt: number
}

/** Digest the server signs at run start and verifies at crate-open time. */
export function buildRunAttestationDigest(input: RunAttestationInput): Hex {
    return keccak256(
        encodePacked(
            ['string', 'uint256', 'address', 'bytes32', 'uint256'],
            [
                RUN_ATTESTATION_DOMAIN,
                BigInt(input.chainId),
                input.address as Hex,
                input.runNonce,
                BigInt(input.issuedAt),
            ],
        ),
    )
}

export interface VerifyRunAttestationInput extends RunAttestationInput {
    runAttestation: string
    expectedSignerAddress: string
    now?: number
}

/**
 * True only when the attestation is a fresh server signature over this
 * exact (player, nonce, issuance time) tuple. Pure and synchronous apart
 * from the secp256k1 recovery, so unit tests can exercise it directly.
 */
export async function verifyRunAttestation(input: VerifyRunAttestationInput): Promise<boolean> {
    if (!/^0x[0-9a-fA-F]{130}$/.test(input.runAttestation)) return false
    const now = input.now ?? Date.now()
    if (!Number.isInteger(input.issuedAt) || input.issuedAt <= 0) return false
    if (now < input.issuedAt) return false
    if (now - input.issuedAt > RUN_TTL_MS) return false
    try {
        const digest = buildRunAttestationDigest(input)
        const recovered = await recoverMessageAddress({
            message: { raw: digest },
            signature: input.runAttestation as Hex,
        })
        return recovered.toLowerCase() === input.expectedSignerAddress.toLowerCase()
    } catch {
        return false
    }
}
