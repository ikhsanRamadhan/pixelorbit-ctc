/**
 * Badge mapping for the marketplace board.
 *
 * The board only ever shows active listings (`fetchAllListings` filters out
 * finalized ones), so a non-empty `winner` means "this open auction already
 * has bids" — never "sold". Labelling that state `Sold` blocked bidding by
 * implying the item was gone, so open auctions with bids read `On Bid` and
 * closed ones with bids read `Awaiting` (they still owe a finalize).
 */

export interface MarketplaceBadgeInput {
    /** True for ascending auctions, false for fixed-price listings. */
    isAuction: boolean;
    /** True once the auction end time has passed. */
    closed: boolean;
    /** True once at least one bid has landed (`winner !== ''`). */
    hasBids: boolean;
}

export interface MarketplaceBadge {
    text: string;
    className: string;
}

export function getMarketplaceBadge({ isAuction, closed, hasBids }: MarketplaceBadgeInput): MarketplaceBadge {
    if (!isAuction) return { text: 'Fixed', className: 'bg-red-600' };
    if (closed && hasBids) return { text: 'Awaiting', className: 'bg-purple-600' };
    if (closed) return { text: 'Closed', className: 'bg-gray-600' };
    if (hasBids) return { text: 'On Bid', className: 'bg-green-600' };
    return { text: 'Auction', className: 'bg-blue-600' };
}
