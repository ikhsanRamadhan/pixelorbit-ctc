'use client'

import { readContract } from 'wagmi/actions'
import { formatUnits, toEventSelector } from 'viem'

import { config } from '@/lib/wagmi'
import {
    MARKETPLACE_CONTRACT_ADDRESS,
    MARKETPLACE_ABI,
    SHIP_CONTRACT_ADDRESS,
    SHIP_ABI,
    ITEM_ABI,
    STARS_DECIMALS,
} from '@/lib/contracts'
import type { ListingView, NamedListingView } from '@/services/types'
import { fetchBidCounts } from '@/services/marketplace'
import items, { ListItem, LISTING_TYPE_AUCTION } from '@/components/utils/Items'
import spaceships from '@/components/utils/Spaceships'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Blockscout serves the same logs unpaginated in one request, which is what
 * makes a full bid history affordable at all. A local node would need the
 * range walked in small windows.
 */
const EXPLORER_API = 'https://creditcoin-testnet.blockscout.com/api'

/** keccak256("BidPlaced(uint256,address,uint256)") */
const BID_PLACED_TOPIC = toEventSelector('BidPlaced(uint256,address,uint256)')

/** What the user can do about a listing they bid on, once the dust has settled. */
export type BidOutcome =
    /** Bidding still open and this address is not the highest bidder. */
    | 'pending'
    /** Bidding still open and this address leads. */
    | 'leading'
    /** Auction closed, no finalize yet. */
    | 'awaiting-settlement'
    /** Finalized with this address on top. Payout was automatic. */
    | 'won-paid'
    /** Finalized with someone else on top. Refund was automatic. */
    | 'lost-settled'

export interface UserBid extends ListItem {
    outcome: BidOutcome
}

interface ExplorerLog {
    topics: (string | null)[]
}

interface ExplorerResponse {
    status?: string
    message?: string
    result?: ExplorerLog[]
}

/** Left-pad an address to the 32 bytes an indexed topic is stored as. */
function addressToTopic(address: string): string {
    return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`
}

/**
 * Listing ids this address has placed a bid on, newest first.
 *
 * Returns null — not an empty array — when the explorer is unreachable, so the
 * caller can tell "you have never bid" apart from "history is unavailable" and
 * fall back rather than render an empty tab as if it were the truth.
 */
async function fetchBidListingIdsFromExplorer(
    accountId: `0x${string}`,
): Promise<number[] | null> {
    const url =
        `${EXPLORER_API}?module=logs&action=getLogs` +
        `&address=${MARKETPLACE_CONTRACT_ADDRESS}` +
        `&fromBlock=0&toBlock=latest` +
        `&topic0=${BID_PLACED_TOPIC}` +
        `&topic2=${addressToTopic(accountId)}` +
        `&topic0_2_opr=and`

    try {
        const response = await fetch(url, { cache: 'no-store' })
        if (!response.ok) return null

        const payload = (await response.json()) as ExplorerResponse
        // The explorer answers "no matches" with status "0" and a string result,
        // which is a legitimate empty history rather than a failure.
        if (!Array.isArray(payload.result)) return []

        const ids = payload.result
            .map((log) => log.topics?.[1])
            .filter((topic): topic is string => typeof topic === 'string')
            .map((topic) => Number(BigInt(topic)))

        return Array.from(new Set(ids))
    } catch {
        return null
    }
}

/**
 * Every listing id where this address holds the current highest bid.
 *
 * The fallback when the explorer is down. It sees only the live lead —
 * outbid history is invisible without events — so the tab degrades to live
 * positions instead of going blank.
 */
async function fetchBidListingIdsFromChain(
    accountId: `0x${string}`,
): Promise<number[]> {
    const count = (await readContract(config, {
        address: MARKETPLACE_CONTRACT_ADDRESS,
        abi: MARKETPLACE_ABI,
        functionName: 'getListingCount',
    })) as bigint

    const ids: number[] = []
    for (let i = 0; i < Number(count); i++) ids.push(i)

    const held = await Promise.all(
        ids.map(async (id) => {
            try {
                const raw = (await readContract(config, {
                    address: MARKETPLACE_CONTRACT_ADDRESS,
                    abi: MARKETPLACE_ABI,
                    functionName: 'getListing',
                    args: [BigInt(id)],
                })) as ListingView
                const listing = toNamedListing(raw)
                return listing.highestBidder.toLowerCase() === accountId.toLowerCase() ? id : null
            } catch {
                return null
            }
        }),
    )

    return held.filter((id): id is number => id !== null)
}

/** Normalize viem's struct decoding, which may be a tuple or a named object. */
function toNamedListing(raw: ListingView): NamedListingView {
    if (!Array.isArray(raw)) return raw as NamedListingView
    return {
        seller: raw[0],
        nftContract: raw[1],
        tokenId: raw[2],
        price: raw[3],
        listingType: Number(raw[4]),
        isActive: raw[5],
        auctionEndTime: raw[6],
        highestBidder: raw[7],
        highestBid: raw[8],
    }
}

/**
 * Classify where this bidder stands.
 *
 * Finalize pays the seller and delivers the NFT in one call, so a closed
 * auction needs no further action from anyone — the only live question is
 * whether an open auction still wants a higher bid.
 */
function classify(
    listing: NamedListingView,
    accountId: string,
    nowSeconds: number,
): BidOutcome {
    const isHighest =
        listing.highestBidder.toLowerCase() === accountId.toLowerCase()

    if (!listing.isActive) {
        return isHighest ? 'won-paid' : 'lost-settled'
    }

    if (nowSeconds >= Number(listing.auctionEndTime)) {
        return 'awaiting-settlement'
    }

    return isHighest ? 'leading' : 'pending'
}

/**
 * Every auction this address has bid on, with the position still open to them.
 *
 * History comes from the explorer; if that is unreachable the chain answers a
 * narrower question — which auctions this address currently leads — so the tab
 * degrades to live positions instead of going blank.
 */
export async function fetchUserBids(accountId: `0x${string}`): Promise<UserBid[]> {
    const fromExplorer = await fetchBidListingIdsFromExplorer(accountId)
    const listingIds =
        fromExplorer ?? (await fetchBidListingIdsFromChain(accountId))

    if (listingIds.length === 0) return []

    const nowSeconds = Math.floor(Date.now() / 1000)
    // Counts come from the same explorer query the marketplace board uses;
    // a failure degrades to zero counts rather than failing the tab.
    const bidCounts = await fetchBidCounts()

    const bids = await Promise.all(
        listingIds.map(async (listingId): Promise<UserBid | null> => {
            try {
                const raw = (await readContract(config, {
                    address: MARKETPLACE_CONTRACT_ADDRESS,
                    abi: MARKETPLACE_ABI,
                    functionName: 'getListing',
                    args: [BigInt(listingId)],
                })) as ListingView

                const listing = toNamedListing(raw)

                // A fixed-price listing cannot have been bid on. If one shows up
                // here the id is not ours to render.
                if (Number(listing.listingType) !== LISTING_TYPE_AUCTION) return null

                const isShip =
                    listing.nftContract?.toLowerCase() ===
                    SHIP_CONTRACT_ADDRESS.toLowerCase()

                let itemName = 'Unknown'
                let itemImage = ''
                let itemRarity = 'Common'
                let itemMetadata = ''

                try {
                    const tokenType = (await readContract(config, {
                        address: listing.nftContract,
                        abi: isShip ? SHIP_ABI : ITEM_ABI,
                        functionName: isShip ? 'tokenShipType' : 'tokenItemType',
                        args: [listing.tokenId],
                    })) as bigint

                    if (isShip) {
                        const ship = spaceships[Number(tokenType)]
                        if (ship) {
                            itemName = ship.name
                            itemImage = ship.images
                            itemRarity = 'Rare'
                            itemMetadata = ship.metadata || ''
                        }
                    } else {
                        const item = items[Number(tokenType)]
                        if (item) {
                            itemName = item.name
                            itemImage = item.image
                            itemRarity = item.rarity
                            itemMetadata = item.metadata
                        }
                    }
                } catch {
                    // Metadata is cosmetic; the claim still needs to be shown.
                }

                return {
                    name: itemName,
                    image: itemImage,
                    rarity: itemRarity,
                    metadata: itemMetadata,
                    serialNumber: Number(listing.tokenId),
                    listingId,
                    seller: listing.seller,
                    price: Number(formatUnits(listing.price, STARS_DECIMALS)),
                    isActive: listing.isActive,
                    endTime: Number(listing.auctionEndTime),
                    listingType: Number(listing.listingType),
                    bidCount: bidCounts.get(listingId) ?? 0,
                    winner: listing.highestBidder === ZERO_ADDRESS ? '' : listing.highestBidder,
                    clearingPrice: Number(
                        formatUnits(listing.highestBid, STARS_DECIMALS),
                    ),
                    outcome: classify(listing, accountId, nowSeconds),
                } as UserBid
            } catch {
                return null
            }
        }),
    )

    // Live positions first, then the closed ones as history, newest first.
    const live: BidOutcome[] = ['leading', 'pending', 'awaiting-settlement']
    return bids
        .filter((bid): bid is UserBid => bid !== null)
        .sort((a, b) => {
            const aLive = live.includes(a.outcome) ? 0 : 1
            const bLive = live.includes(b.outcome) ? 0 : 1
            if (aLive !== bLive) return aLive - bLive
            return b.listingId - a.listingId
        })
}
