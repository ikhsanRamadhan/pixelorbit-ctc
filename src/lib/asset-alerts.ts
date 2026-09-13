/**
 * What the pilot's assets currently need from them, reduced to one label.
 *
 * The inventory badge has room for a single line, so this ranks every open state
 * across their listings and their bids and returns the most pressing one. The
 * ranking is data (`PRIORITY`) rather than nested conditionals, so adding a
 * state cannot quietly bury one that was already there.
 */

import { ListItem, isAuctionListing } from '@/components/utils/Items'
import { isAuctionEnded } from '@/lib/auction'
import type { BidOutcome } from '@/services/user-bids'

export type AssetAlertKind =
    /** Closed auction awaiting finalize. Anyone may run it. */
    | 'needs-settle'
    /** Closed with no bids; the NFT can come home. */
    | 'seller-reclaim'
    /** An open auction has picked up bids. */
    | 'seller-new-bids'

export interface AssetAlert {
    kind: AssetAlertKind
    /** Badge text. Kept short — the chip renders at 7px. */
    label: string
    /** Chip colours, matching the tone of the state. */
    className: string
    /** True when there is a transaction to send, not just news to read. */
    actionable: boolean
}

const ALERTS: Record<AssetAlertKind, Omit<AssetAlert, 'kind'>> = {
    'needs-settle': {
        label: 'Finalize Now',
        className: 'bg-purple-500/20 text-purple-300',
        actionable: true,
    },
    'seller-reclaim': {
        label: 'Reclaim Asset',
        className: 'bg-orange-500/20 text-orange-300',
        actionable: true,
    },
    'seller-new-bids': {
        label: 'New Bids',
        className: 'bg-cyan-500/20 text-cyan-400',
        actionable: false,
    },
}

/**
 * Most pressing first. A close that unblocks everyone else outranks news.
 */
const PRIORITY: AssetAlertKind[] = [
    'needs-settle',
    'seller-reclaim',
    'seller-new-bids',
]

/**
 * The seller's view of one of their own listings.
 *
 * Fixed-price listings never report anything: the only event is the sale, and a
 * sold one leaves `userListings` the moment it is paid for, so there is no state
 * here to describe. Auctions are where a seller acquires obligations.
 */
export function sellerAlertKind(listing: ListItem, nowMs: number): AssetAlertKind | null {
    if (!isAuctionListing(listing)) return null
    if (!listing.isActive) return null

    if (!isAuctionEnded(listing.endTime, nowMs)) {
        return listing.bidCount > 0 ? 'seller-new-bids' : null
    }

    // Closed. With bids the auction still owes a finalize, which anyone —
    // seller included — can run. With none the NFT can come home straight
    // away via reclaim. `winner` carries the current highest bidder, so an
    // empty one means no bids ever landed.
    if (listing.winner !== '') return 'needs-settle'
    return 'seller-reclaim'
}

/** The bidder's view, mapped from the outcome the bid service already derives. */
export function buyerAlertKind(outcome: BidOutcome): AssetAlertKind | null {
    switch (outcome) {
        case 'awaiting-settlement':
            return 'needs-settle'
        // An open position — leading or not — needs nothing, and a finalized
        // one settled itself: payout and refunds are automatic at finalize.
        case 'pending':
        case 'leading':
        case 'won-paid':
        case 'lost-settled':
            return null
    }
}

/**
 * The single alert worth showing, plus how many states are open behind it.
 *
 * `count` is every alerting listing and bid, so the badge can admit there is
 * more than one thing waiting instead of showing the top one as if it were all.
 */
export function topAssetAlert(
    listings: ListItem[],
    bids: readonly { outcome: BidOutcome }[],
    nowMs: number,
): { alert: AssetAlert; count: number } | null {
    const kinds = [
        ...listings.map((listing) => sellerAlertKind(listing, nowMs)),
        ...bids.map((bid) => buyerAlertKind(bid.outcome)),
    ].filter((kind): kind is AssetAlertKind => kind !== null)

    if (kinds.length === 0) return null

    const top = PRIORITY.find((kind) => kinds.includes(kind))
    if (!top) return null

    return { alert: { kind: top, ...ALERTS[top] }, count: kinds.length }
}
