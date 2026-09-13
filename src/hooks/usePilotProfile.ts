'use client'

import { useGameStore } from '@/stores/game-store'

/**
 * Everything the signed-in pilot owns, read straight from the store.
 *
 * No fetch here for the same reason as `useMarketplace`: `useGamePolling` owns
 * the only schedule, and this hook used to run a fourth copy of the same four
 * reads on its own 15s SWR timer.
 */
export function usePilotProfile() {
    // Narrow selectors rather than `useGameStore()`: subscribing to the whole
    // store re-renders the profile on every unrelated game-state change.
    const mySpaceships = useGameStore((s) => s.mySpaceships)
    const userHighscores = useGameStore((s) => s.userHighscores)
    const ownedItems = useGameStore((s) => s.ownedItems)
    const userListings = useGameStore((s) => s.userListings)
    const isLoading = useGameStore((s) => s.isLoading)
    const isFleetLoading = useGameStore((s) => s.isFleetLoading)

    return {
        mySpaceships,
        userHighscores,
        ownedItems,
        userListings,
        // Balances/listings skeletons key off the shared batch flag.
        isLoading,
        // Fleet Records gets its own flag: it only waits on the ships read, so
        // the starter Fighter appears the moment the wallet connects (it's
        // seeded locally in useGamePolling) instead of after the slowest read
        // in fetchAllGameData resolves.
        isFleetLoading: isFleetLoading && mySpaceships.length === 0,
    }
}
