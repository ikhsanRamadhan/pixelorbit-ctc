'use client'

import { writeContract, readContract, waitForTransactionReceipt } from 'wagmi/actions'
import { toast } from 'sonner'

import { config } from '@/lib/wagmi'
import { LEADERBOARD_CONTRACT_ADDRESS, LEADERBOARD_ABI } from '@/lib/contracts'
import { getWalletAddress, isCurrentWallet } from '@/services/wallet'
import { refreshWalletBalances } from '@/services/balances'
import { useGameStore } from '@/stores/game-store'
import { getTxErrorMessage } from '@/services/errors'
import type { HighscoreMessage, ShipScoreView, UserStatsView } from '@/services/types'

/**
 * Run token for a score submission.
 *
 * The server issues it at game start and signs `issuedAt` into it, which is
 * what makes the elapsed-time bound mean anything: the submitter cannot forge
 * a start time the server never signed.
 */
interface RunToken {
    runNonce: string
    runToken: string
    runAttestation: string
    issuedAt: number
}

/** In-memory store: one run token per wallet, cleared on submission or page reload. */
const runTokens = new Map<string, RunToken>()

/**
 * Requests a run token from the server before the game starts. The nonce is
 * fresh random bytes signed by the server; the client cannot forge one. When
 * the run ends, `submitHighscore` will submit this token alongside the score,
 * and the server will refuse to attest unless the token was issued by
 * `/game/start`.
 */
export async function startRun(): Promise<boolean> {
    const address = getWalletAddress()
    if (!address) {
        toast.error('Wallet not connected')
        return false
    }

    try {
        const response = await fetch('/api/game/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address }),
        })

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Run start failed' }))
            toast.error(error.error || 'Run start failed')
            return false
        }

        const token: RunToken = await response.json()
        if (
            typeof token.runNonce !== 'string' ||
            typeof token.runAttestation !== 'string' ||
            !Number.isInteger(token.issuedAt)
        ) {
            toast.error('Run start failed — try again')
            return false
        }
        runTokens.set(address.toLowerCase(), token)
        return true
    } catch (error) {
        console.error('startRun error:', error)
        toast.error('Could not start run — try again')
        return false
    }
}

/**
 * This wallet's run nonce from game start, without consuming it. Crate
 * claims bind to the same nonce the score run used, so one run opens once.
 * Null when no run is open (wallet disconnected or page reloaded mid-run).
 */
export function peekRunNonce(): string | null {
    const address = getWalletAddress()
    if (!address) return null
    return runTokens.get(address.toLowerCase())?.runNonce ?? null
}

/**
 * Server attestation for the open run, without consuming it. Sent to
 * `/api/game/open` alongside the nonce so any serverless instance can verify
 * the run was issued by this deployment. Null when no run is open.
 */
export function peekRunAttestation(): { runAttestation: string; issuedAt: number } | null {
    const address = getWalletAddress()
    if (!address) return null
    const token = runTokens.get(address.toLowerCase())
    if (!token || !token.runAttestation || !Number.isInteger(token.issuedAt)) return null
    return { runAttestation: token.runAttestation, issuedAt: token.issuedAt }
}

/**
 * Get the run token issued at game start.
 *
 * Kept for the server-side run session started by `startRun`: the open
 * `submitScore` path needs no attestation, but the token still binds a run to
 * its wallet for the cooldown and elapsed-time checks the route enforces.
 * Task 9 decides whether the token flow stays or goes with the bridge UI.
 */
export async function submitHighscore(score: number, shipName: string): Promise<boolean> {
    const address = getWalletAddress()
    if (!address) {
        toast.error('Wallet not connected')
        return false
    }

    const wallet = address.toLowerCase()
    const token = runTokens.get(wallet)
    if (!token) {
        toast.error('No run token — start a fresh run')
        return false
    }

    try {
        // Open submission: the migrated leaderboard records any positive
        // score, and the ASC marks bridged players on a separate attested
        // tier. No attestation round-trip.
        const tx = await writeContract(config, {
            address: LEADERBOARD_CONTRACT_ADDRESS,
            abi: LEADERBOARD_ABI,
            functionName: 'submitScore',
            args: [BigInt(score), shipName],
        })
        await waitForTransactionReceipt(config, { hash: tx })

        // The submission spent gas: refresh balances fire-and-forget.
        void refreshWalletBalances({ awaitChange: true })

        // Clear the used token so the nonce cannot be replayed.
        runTokens.delete(wallet)
        toast.success('Score submitted onchain!')
        return true
    } catch (error: unknown) {
        console.error('submitHighscore error:', error)
        toast.error(`Score submission failed: ${getTxErrorMessage(error)}`)
        return false
    }
}

export async function getAllScore(): Promise<HighscoreMessage[] | undefined> {    const store = useGameStore.getState()
    const address = getWalletAddress()

    try {
        const allStats = await readContract(config, {
            address: LEADERBOARD_CONTRACT_ADDRESS,
            abi: LEADERBOARD_ABI,
            functionName: 'getAllUserStats',
        }) as readonly UserStatsView[]

        const totalPlayers = await readContract(config, {
            address: LEADERBOARD_CONTRACT_ADDRESS,
            abi: LEADERBOARD_ABI,
            functionName: 'getTotalPlayers',
        }) as bigint

        const scores: HighscoreMessage[] = allStats.map((stat) => ({
            player: stat.addr,
            score: Number(stat.bestScore),
            ship: stat.spaceship,
            action: 'SUBMIT_SCORE' as const,
            consensusTimestamp: '0',
        }))

        scores.sort((a, b) => b.score - a.score)

        store.setLeaderboard(scores)
        store.setTotalUser(Number(totalPlayers))

        if (address && isCurrentWallet(address)) {
            const userScores = scores.filter(
                (s) => s.player.toLowerCase() === address.toLowerCase(),
            )

            if (userScores.length > 0) {
                try {
                    const shipScores = await readContract(config, {
                        address: LEADERBOARD_CONTRACT_ADDRESS,
                        abi: LEADERBOARD_ABI,
                        functionName: 'getPlayerShipScores',
                        args: [address],
                    }) as readonly ShipScoreView[]

                    const userHighscoreList: HighscoreMessage[] = shipScores.map((ss) => ({
                        player: address,
                        score: Number(ss.bestScore),
                        ship: ss.shipName,
                        action: 'SUBMIT_SCORE' as const,
                        consensusTimestamp: '0',
                    }))

                    store.setUserHighscores(userHighscoreList)
                } catch {
                    store.setUserHighscores(userScores)
                }
            } else {
                store.setUserHighscores([])
            }
        }

        return scores
    } catch (error) {
        console.error('getAllScore error:', error)
        return []
    }
}

/**
 * Whether the ASC has marked this player attested — the tier that separates
 * bridged players from open submissions.
 *
 * Set only by `PixelOrbitLeaderboard.markAttested`, which only the ASC can
 * call after verifying a Sepolia lock. Read-only here, so a false answer degrades
 * to "not attested" rather than failing the profile.
 */
export async function fetchAttestedTier(address: `0x${string}`): Promise<boolean> {
    try {
        const attested = await readContract(config, {
            address: LEADERBOARD_CONTRACT_ADDRESS,
            abi: LEADERBOARD_ABI,
            functionName: 'attestedPlayer',
            args: [address],
        }) as boolean
        return attested === true
    } catch (error) {
        console.error('fetchAttestedTier error:', error)
        return false
    }
}
