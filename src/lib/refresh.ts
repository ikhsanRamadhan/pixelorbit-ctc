'use client'

import { useGameStore } from '@/stores/game-store'

const REFETCH_ATTEMPTS = 6
const REFETCH_DELAY_MS = 900

/**
 * Everything a marketplace or mint write can change, flattened into a string.
 *
 * Used to tell "the refetch saw the transaction" apart from "the refetch was
 * answered from pre-transaction state", which is the only reliable signal we
    * have: the public RPC endpoint is load balanced with no session affinity,
 * so a receipt — or even a fresh block height — proves nothing about which
 * node answers the next `eth_call`.
 *
 * Every write moves at least one field here: listing/cancel/buy add or remove a
 * listing, a bid changes `bidCount` and `winner`, a finalize sets `isActive`,
 * a price edit changes `price`, and a mint changes the owned-item set.
 *
 * `bidCount` is what a bid moves, not the amount — the board reads the current
 * highest bid off the listing itself, while the count comes from BidPlaced
 * events.
 */
function marketSignature(): string {
    const { allListing, ownedItems } = useGameStore.getState()

    const listings = allListing
        .map((l) =>
            [l.listingId, l.price, l.bidCount, l.winner, l.endTime].join(':'),
        )
        .sort()
        .join('|')

    const owned = ownedItems.map((i) => i.serialNumber).sort().join(',')

    return `${listings}//${owned}`
}

async function fetchChainData(): Promise<void> {
    const { fetchAllListings } = await import('@/services/marketplace')
    const { fetchOwnedItems } = await import('@/services/items')

    await Promise.allSettled([fetchAllListings(), fetchOwnedItems()])
}

/**
 * Pull the post-write state into the store, ahead of the next poll.
 *
 * A single trade moves data across two views — the global listing board and the
 * signed-in pilot's own inventory — and both read from the store, so one refresh
 * updates both. The 15s poll in `useGamePolling` would get there eventually;
 * this is what makes the change appear at the moment the transaction lands.
 *
 * `awaitChange` retries the read until the data actually differs from what we
 * held before the write. Without it a single read can be served by a node that
 * has not applied the block yet, and the stale answer gets written into the
 * store as if it were fresh — which is what made a new listing invisible until
 * a reload while a cancel on the same listing appeared immediately.
 *
 * Awaited by callers, so returning means the UI already reflects the on-chain
 * state.
 */
export async function revalidateMarketData(
    { awaitChange = false }: { awaitChange?: boolean } = {},
): Promise<void> {
    const before = awaitChange ? marketSignature() : null

    for (let attempt = 0; attempt < REFETCH_ATTEMPTS; attempt++) {
        await fetchChainData()

        if (before === null || marketSignature() !== before) break

        // Last attempt already ran; publish what we have rather than sleeping
        // for nothing. The 15s poll stays as the backstop.
        if (attempt < REFETCH_ATTEMPTS - 1) {
            await new Promise((resolve) => setTimeout(resolve, REFETCH_DELAY_MS))
        }
    }
}
