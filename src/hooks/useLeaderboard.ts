'use client'

import { useGameStore } from '@/stores/game-store'

/**
 * The flat one-row-per-player board, read straight from the store.
 *
 * No fetch here: `useGamePolling` owns the only schedule. This hook previously
 * ran `getAllScore` on its own 15s SWR timer, which was the third caller of it.
 */
export function useLeaderboard() {
    const leaderboard = useGameStore((s) => s.leaderboard)
    const totalUser = useGameStore((s) => s.totalUser)
    const isLoading = useGameStore((s) => s.isLoading)

    return {
        leaderboard,
        totalUser,
        isLoading: isLoading && leaderboard.length === 0,
    }
}
