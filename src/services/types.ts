export interface HighscoreMessage {
    player: string
    score: number
    ship: string
    action: 'SUBMIT_SCORE'
    consensusTimestamp: string
    date?: string
}

/** Mirrors `PixelOrbitLeaderboard.UserStatsView` returned by `getAllUserStats`. */
export interface UserStatsView {
    addr: `0x${string}`
    gamesPlayed: bigint
    bestScore: bigint
    spaceship: string
}

/** Mirrors `PixelOrbitLeaderboard.ShipScoreView` returned by `getPlayerShipScores`. */
export interface ShipScoreView {
    shipName: string
    bestScore: bigint
}

/** Named-field form of the on-chain `Listing` struct (post-normalization). */
export interface NamedListingView {
    seller: `0x${string}`
    nftContract: `0x${string}`
    tokenId: bigint
    /** FixedPrice: the sale price. AscendingAuction: the reserve. */
    price: bigint
    listingType: number
    isActive: boolean
    /** 0 for FixedPrice. */
    auctionEndTime: bigint
    /** Zero address until the first bid lands. */
    highestBidder: `0x${string}`
    /** Zero until the first bid lands. */
    highestBid: bigint
}

/** Mirrors `PixelOrbitMarketplace.Listing` returned by `getListing`.
 * Viem can decode structs as either objects (when named) or tuples (when
 * returned as a raw ABI tuple), so we model both shapes here. The tuple arm is
 * decoded positionally, so its order must match the struct exactly — a
 * reordered field shifts every value after it without any error.
 */
export type ListingView =
    | NamedListingView
    | [
          `0x${string}`,
          `0x${string}`,
          bigint,
          bigint,
          number,
          boolean,
          bigint,
          `0x${string}`,
          bigint,
      ]

/** A `ListingView` paired with the marketplace id it was fetched under. */
export type IndexedListingView = NamedListingView & { listingId: number }

export type BestScoresMap = Record<string, HighscoreMessage>

export type ShipLeaderboards = Record<string, HighscoreMessage[]>
