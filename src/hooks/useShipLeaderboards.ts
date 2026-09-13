'use client'

import { useEffect } from 'react'
import useSWR from 'swr'
import { useGameStore } from '@/stores/game-store'
import type { ShipLeaderboards } from '@/services/types'

// Fetcher function that calls getShipLeaderboards
const shipLeaderboardsFetcher = async () => {
    const { getShipLeaderboards } = await import('@/services/shipScores')
    return await getShipLeaderboards()
}

export function useShipLeaderboards(enabled: boolean) {
    const store = useGameStore()

    const hasCached = Object.keys(store.shipLeaderboards).length > 0

    const {
        data: shipLeaderboardsData,
        error,
        isValidating,
        isLoading: swrLoading,
        mutate,
    } = useSWR<ShipLeaderboards>(
        enabled ? '/api/leaderboard/ships' : null,
        shipLeaderboardsFetcher,
        {
            refreshInterval: 30000,          // Revalidate every 30 seconds
            revalidateOnFocus: false,        // Ship boards are a heavier fan-out, skip focus refetch
            revalidateOnReconnect: true,     // Revalidate on network reconnect
            dedupingInterval: 15000,         // Dedupe requests within 15 seconds
            fallbackData: hasCached ? store.shipLeaderboards : undefined, // Use cached data as fallback
        }
    )

    // Sync SWR data back to zustand store (in useEffect to avoid setState-in-render)
    useEffect(() => {
        if (shipLeaderboardsData && shipLeaderboardsData !== store.shipLeaderboards) {
            store.setShipLeaderboards(shipLeaderboardsData)
        }
    }, [shipLeaderboardsData, store])

    // Determine loading state:
    // - swrLoading: initial load (no data at all)
    // - isValidating: background revalidation
    const isLoading = swrLoading && shipLeaderboardsData === undefined

    return {
        shipLeaderboards: shipLeaderboardsData ?? store.shipLeaderboards,
        isLoading,
        isValidating,
        error,
        mutate,
    }
}
