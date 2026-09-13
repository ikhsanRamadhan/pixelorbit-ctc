'use client'

import spaceships from '@/components/utils/Spaceships'
import { fetchShipStarsPrices } from '@/services/ships'
import type { Items, ListItem } from '@/components/utils/Items'
import type { MySpaceships } from '@/components/utils/Spaceships'

/**
 * Portfolio valuation for the round-trip dashboard.
 *
 * Everything here is derived from data the app already holds — the game store's
 * fleet, items and listings — priced through the same on-chain Stars prices the
 * dealership uses. Nothing new is fetched from the marketplace or the NFT
 * contracts, so this stays a presentation layer over existing state rather
 * than a second source of truth that can disagree with the rest of the UI.
 */

/** What the pilot's on-chain assets are worth right now. */
export interface PortfolioValuation {
    /** Catalog value of owned ships, in Stars. */
    fleetStars: number
    /** Ships counted — excludes the free starter, which has no market value. */
    fleetPricedCount: number
    /** Asking price of the pilot's own active listings, in Stars. */
    listedStars: number
    /** Active listings counted. */
    listedCount: number
    /** Items held outside the marketplace escrow. */
    unlistedItemCount: number
}

/**
 * Price the pilot's holdings.
 *
 * Ship values come from `fetchShipStarsPrices`, which reads the on-chain Stars
 * price — the same call the dealership makes, so the dashboard cannot quote a
 * different number than the shop. Its result is positional against the ship
 * catalog, hence the index lookup by name.
 *
 * The free starter ship is deliberately excluded: it has a catalog price of 0,
 * and counting it would inflate the fleet count without adding value.
 */
export async function valuePortfolio(args: {
    fleet: MySpaceships[]
    items: Items[]
    listings: ListItem[]
}): Promise<PortfolioValuation> {
    const shipPrices = await fetchShipStarsPrices()

    let fleetStars = 0
    let fleetPricedCount = 0
    for (const owned of args.fleet) {
        const idx = spaceships.findIndex((ship) => ship.name === owned.name)
        if (idx === -1) continue
        const price = shipPrices[idx]?.starsPrice ?? 0
        if (price <= 0) continue
        fleetStars += price
        fleetPricedCount += 1
    }

    // Listings are the pilot's own, already filtered upstream by seller. An
    // auction's asking price is the floor, not the highest bid, so `price` is
    // the honest figure to carry here.
    const active = args.listings.filter((listing) => listing.isActive)
    const listedStars = active.reduce((sum, listing) => sum + listing.price, 0)

    // The marketplace escrows a listed NFT, so a listed item is not in `items`.
    // The filter guards against a snapshot taken mid-transaction.
    const listedIds = new Set(active.map((listing) => listing.serialNumber))
    const unlistedItemCount = args.items.filter((item) => !listedIds.has(item.serialNumber)).length

    return {
        fleetStars,
        fleetPricedCount,
        listedStars,
        listedCount: active.length,
        unlistedItemCount,
    }
}
