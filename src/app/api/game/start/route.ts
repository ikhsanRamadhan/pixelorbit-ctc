import { NextResponse } from 'next/server'
import { keccak256, encodePacked, isAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { creditcoinTestnet } from '@/lib/chains'
import { buildRunAttestationDigest } from '@/app/api/game/run-attestation'

/**
 * Issues a run token for a game session — server attestation that this nonce
 * was legitimately issued, not fabricated by the client.
 *
 * The nonce itself is fresh random bytes, but the *token* is what proves the
 * server minted it. The on-chain `submitScore` is open (the leaderboard takes
 * any positive score); the client requires a token before submitting so a
 * score cannot be posted without starting a run through this route first.
 *
 * The token binds to (player, nonce, timestamp). Nothing verifies the signature
 * on the open submission path — the token is a speed bump proving the run went
 * through this route, not a proof the score is legitimate.
 */

export async function POST(request: Request) {
    const rawKey = process.env.SCORE_SIGNER_KEY
    const leaderboardAddress = process.env.NEXT_PUBLIC_LEADERBOARD_CONTRACT_ADDRESS
    const chainId = creditcoinTestnet.id

    if (!rawKey || !leaderboardAddress) {
        return NextResponse.json(
            { error: 'Score attestation is not configured on this deployment' },
            { status: 503 },
        )
    }

    let body: { address?: string }
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const { address } = body
    if (!address || !isAddress(address)) {
        return NextResponse.json({ error: 'Valid wallet address required' }, { status: 400 })
    }

    const account = privateKeyToAccount(
        (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex,
    )

    const issuedAt = Date.now()
    const runNonce = keccak256(
        encodePacked(
            ['address', 'uint256', 'bytes32'],
            [
                address as Hex,
                BigInt(issuedAt),
                keccak256(crypto.getRandomValues(new Uint8Array(32))),
            ],
        ),
    )

    // The token proves this exact (player, nonce, timestamp) tuple came from
    // the server, not a client forgery. Bound to the contract and chain so a
    // token from another deployment is worthless here.
    const tokenDigest = keccak256(
        encodePacked(
            ['address', 'uint256', 'address', 'bytes32', 'uint256'],
            [leaderboardAddress as Hex, BigInt(chainId), address as Hex, runNonce, BigInt(issuedAt)],
        ),
    )
    const runToken = await account.signMessage({ message: { raw: tokenDigest } })

    // Stateless attestation for `/api/game/open`: any serverless instance
    // holding SCORE_SIGNER_KEY can verify this without shared storage.
    // Double-claims stay blocked on-chain by `usedRunNonces`.
    const runAttestation = await account.signMessage({
        message: { raw: buildRunAttestationDigest({ chainId, address, runNonce, issuedAt }) },
    })

    return NextResponse.json({ runNonce, runToken, runAttestation, issuedAt })
}
