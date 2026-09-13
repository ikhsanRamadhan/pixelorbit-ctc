'use client'

import { readContract, readContracts } from 'wagmi/actions'
import type { Abi } from 'viem'

import { config } from '@/lib/wagmi'
import { LEADERBOARD_CONTRACT_ADDRESS, LEADERBOARD_ABI } from '@/lib/contracts'
import { useGameStore } from '@/stores/game-store'
import type {
    HighscoreMessage,
    ShipLeaderboards,
    ShipScoreView,
    UserStatsView,
} from '@/services/types'

// Upper bound on the per-ship fan-out. Multicall3 batches every call into a
// single RPC request, but the calldata still has to fit in one eth_call.
export const MAX_FANOUT_PLAYERS = 500

interface ShipScoreRow {
    player: string
    shipScores: Array<{ shipName: string; bestScore: bigint | number }>
}

/**
 * wagmi's `allowFailure: true` envelope, narrowed to `getPlayerShipScores`.
 * The ABI comes from JSON (not `as const`), so wagmi cannot infer the decoded
 * result and we have to state the contract's shape ourselves.
 */
type ShipScoresResult =
    | { status: 'success'; result: readonly ShipScoreView[]; error?: undefined }
    | { status: 'failure'; result?: undefined; error: Error }

// Pure: no network access, so it stays unit-testable on its own.
export function aggregateShipLeaderboards(rows: ShipScoreRow[]): ShipLeaderboards {
    const boards: ShipLeaderboards = {}

    for (const row of rows) {
        for (const shipScore of row.shipScores) {
            const score = Number(shipScore.bestScore)
            if (!(score > 0)) continue

            const entry: HighscoreMessage = {
                player: row.player,
                score,
                ship: shipScore.shipName,
                action: 'SUBMIT_SCORE' as const,
                consensusTimestamp: '0',
            }

            if (!boards[shipScore.shipName]) {
                boards[shipScore.shipName] = []
            }
            boards[shipScore.shipName].push(entry)
        }
    }

    for (const shipName of Object.keys(boards)) {
        boards[shipName].sort((a, b) => b.score - a.score)
    }

    return boards
}

// The ALL board wants one row per (player, ship) pair, so a pilot with a run on
// Fighter and a run on Nautolan is listed twice. getAllUserStats only carries a
// single overall best per player, so the rows come from the per-ship fan-out and
// fall back to the flat board for players that fan-out has no ship rows for
// (scores from before ship tracking, or players past MAX_FANOUT_PLAYERS).
export function buildAllLeaderboard(
    flatLeaderboard: HighscoreMessage[],
    boards: ShipLeaderboards,
): HighscoreMessage[] {
    const shipRows = Object.values(boards).flat()
    const covered = new Set(shipRows.map((row) => row.player.toLowerCase()))

    const uncoveredRows = flatLeaderboard.filter(
        (row) => !covered.has(row.player.toLowerCase()),
    )

    return [...shipRows, ...uncoveredRows].sort(
        (a, b) =>
            b.score - a.score ||
            a.ship.localeCompare(b.ship) ||
            a.player.localeCompare(b.player),
    )
}

export async function getShipLeaderboards(): Promise<ShipLeaderboards> {
    const store = useGameStore.getState()

    try {
        const allStats = await readContract(config, {
            address: LEADERBOARD_CONTRACT_ADDRESS,
            abi: LEADERBOARD_ABI,
            functionName: 'getAllUserStats',
            // The ABI is imported from JSON, so it is not `as const` and wagmi
            // cannot infer the return type for us.
        }) as readonly UserStatsView[]

        const ranked = [...allStats].sort((a, b) => Number(b.bestScore) - Number(a.bestScore))

        let players = ranked
        if (ranked.length > MAX_FANOUT_PLAYERS) {
            console.warn(
                `getShipLeaderboards: ${ranked.length - MAX_FANOUT_PLAYERS} players truncated from the per-ship fan-out (cap ${MAX_FANOUT_PLAYERS})`,
            )
            players = ranked.slice(0, MAX_FANOUT_PLAYERS)
        }

        const addresses = players.map((stat) => stat.addr)

        // One batched multicall3 request for every player's per-ship bests.
        const results = await readContracts(config, {
            contracts: addresses.map((address) => ({
                address: LEADERBOARD_CONTRACT_ADDRESS,
                abi: LEADERBOARD_ABI as Abi,
                functionName: 'getPlayerShipScores',
                args: [address],
            })),
            allowFailure: true,
        }) as readonly ShipScoresResult[]

        const rows: ShipScoreRow[] = []

        results.forEach((result, index) => {
            // A single failing player must not empty the whole board.
            if (result.status !== 'success') return

            // Defensive: a malformed decode must not throw.
            const shipScores: readonly ShipScoreView[] = result.result
            if (!Array.isArray(shipScores)) return

            rows.push({
                player: addresses[index],
                shipScores: shipScores.map((ss) => ({
                    shipName: ss.shipName,
                    bestScore: ss.bestScore,
                })),
            })
        })

        const boards = aggregateShipLeaderboards(rows)

        store.setShipLeaderboards(boards)

        return boards
    } catch (error) {
        // Re-thrown on purpose: SWR needs the error state so the UI can offer a
        // retry. No toast here, this also runs on a 30s background refresh.
        console.error('getShipLeaderboards error:', error)
        throw error
    }
}
