'use client'

import { useGameStore } from '@/stores/game-store'

/**
 * The global listing board, read straight from the store.
 *
 * There is no fetch here on purpose. `useGamePolling` owns the only schedule in
 * the app, and `revalidateMarketData` refreshes the store after a trade — so a
 * second poll on this hook would just repeat those reads against the public RPC
 * endpoint. Rendering from the store also means the newest write always wins,
 * which is what fixed sold and newly listed items sticking on screen until a
 * reload.
 */
export function useMarketplace() {
    // Narrow selector: subscribing to the whole store re-rendered the
    // marketplace on every unrelated game-state change.
    const allListing = useGameStore((s) => s.allListing)
    const isLoading = useGameStore((s) => s.isLoading)

    return {
        allListing,
        // Only a real "nothing to show yet" state. Once listings exist, a
        // background refresh must not blank the board back to skeletons.
        isLoading: isLoading && allListing.length === 0,
    }
}
