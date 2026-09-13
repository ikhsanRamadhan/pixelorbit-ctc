import { NextResponse } from 'next/server'
import { encodeAbiParameters, isAddress, keccak256, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { creditcoinTestnet } from '@/lib/chains'
import { consumeRun } from '@/app/api/game/run-registry'

/**
 * Signs a crate-claim authorization for `PixelOrbitItem.claimCrates`.
 *
 * The client posts the run it just finished (player, server-issued run
 * nonce, client-reported crate count). The server checks the nonce was
 * issued to this player and never consumed, then signs the exact digest the
 * contract verifies: keccak256(abi.encode(item, chainId, player, nonce,
 * count)) wrapped in the EIP-191 personal-sign envelope (viem `signMessage`
 * with a raw digest, mirroring the run-token route).
 *
 * Trust model matches the score run-token: the signature stops casual
 * forgery (no claim without a run through the server), not a determined
 * cheater — the server never sees gameplay, so the count is client-reported
 * up to MAX_CRATES_PER_CLAIM (25). The contract enforces the cap, the
 * signer, and one-claim-per-nonce on-chain.
 */

const MAX_CRATES_PER_CLAIM = 25

function isRunNonce(value: unknown): value is Hex {
    return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}

export async function POST(request: Request) {
    const rawKey = process.env.SCORE_SIGNER_KEY
    const itemAddress = process.env.NEXT_PUBLIC_ITEM_CONTRACT_ADDRESS
    const chainId = creditcoinTestnet.id

    if (!rawKey || !itemAddress) {
        return NextResponse.json(
            { error: 'Crate claims are not configured on this deployment' },
            { status: 503 },
        )
    }

    let body: { address?: unknown; runNonce?: unknown; crateCount?: unknown }
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const { address, runNonce, crateCount } = body
    if (typeof address !== 'string' || !isAddress(address)) {
        return NextResponse.json({ error: 'Valid wallet address required' }, { status: 400 })
    }
    if (!isRunNonce(runNonce)) {
        return NextResponse.json({ error: 'Valid run nonce required' }, { status: 400 })
    }
    if (typeof crateCount !== 'number' || !Number.isInteger(crateCount) || crateCount < 1) {
        return NextResponse.json({ error: 'Crate count must be a whole number above zero' }, { status: 400 })
    }
    if (crateCount > MAX_CRATES_PER_CLAIM) {
        return NextResponse.json(
            { error: `Crate count exceeds the per-claim maximum of ${MAX_CRATES_PER_CLAIM}` },
            { status: 400 },
        )
    }

    if (!consumeRun(runNonce, address)) {
        return NextResponse.json(
            { error: 'Run nonce unknown, expired, already claimed, or issued to another wallet' },
            { status: 403 },
        )
    }

    const account = privateKeyToAccount(
        (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex,
    )

    // Byte-identical to the contract's abi.encode(address, uint256, address,
    // bytes32, uint8): viem encodeAbiParameters IS abi.encode (not packed).
    const digest = keccak256(
        encodeAbiParameters(
            [
                { type: 'address' },
                { type: 'uint256' },
                { type: 'address' },
                { type: 'bytes32' },
                { type: 'uint8' },
            ],
            [itemAddress as Hex, BigInt(chainId), address as Hex, runNonce, crateCount],
        ),
    )
    const signature = await account.signMessage({ message: { raw: digest } })

    return NextResponse.json({ signature, itemAddress, chainId, runNonce, crateCount })
}
