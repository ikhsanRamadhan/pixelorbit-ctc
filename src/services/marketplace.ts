'use client'

import { writeContract, readContract, waitForTransactionReceipt } from 'wagmi/actions'
import { toast } from 'sonner'
import { parseUnits, formatUnits, toEventSelector } from 'viem'

import { config } from '@/lib/wagmi'
import { revalidateMarketData } from '@/lib/refresh'
import { refreshWalletBalances } from '@/services/balances'
import {
    ITEM_CONTRACT_ADDRESS,
    ITEM_ABI,
    MARKETPLACE_CONTRACT_ADDRESS,
    MARKETPLACE_ABI,
    SHIP_CONTRACT_ADDRESS,
    SHIP_ABI,
    STARS_DECIMALS,
} from '@/lib/contracts'
import { getWalletAddress, ensureAllowance, isCurrentWallet } from '@/services/wallet'
import { isAuctionEnded } from '@/lib/auction'
import { useGameStore } from '@/stores/game-store'
import { getTxErrorMessage } from '@/services/errors'
import type { IndexedListingView, ListingView, NamedListingView } from '@/services/types'
import items, { Items, ListItem, LISTING_TYPE_AUCTION, LISTING_TYPE_FIXED_PRICE } from '@/components/utils/Items'
import spaceships from '@/components/utils/Spaceships'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** keccak256("BidPlaced(uint256,address,uint256)") */
const BID_PLACED_TOPIC = toEventSelector('BidPlaced(uint256,address,uint256)')

const EXPLORER_API = 'https://creditcoin-testnet.blockscout.com/api'

interface ExplorerLog {
    topics: (string | null)[]
}

interface ExplorerResponse {
    status?: string
    message?: string
    result?: ExplorerLog[] | string
}

/**
 * Bid counts per listing, from `BidPlaced` events.
 *
 * The listing struct carries only the current highest bid, never its history,
 * so the count comes from the explorer in a single unpaginated query. Returns
 * an empty map — not a failure — when the explorer is unreachable, so callers
 * render zero bids rather than blank the board.
 */
export async function fetchBidCounts(): Promise<Map<number, number>> {
    const counts = new Map<number, number>()
    const url =
        `${EXPLORER_API}?module=logs&action=getLogs` +
        `&address=${MARKETPLACE_CONTRACT_ADDRESS}` +
        `&fromBlock=0&toBlock=latest` +
        `&topic0=${BID_PLACED_TOPIC}`

    try {
        const response = await fetch(url, { cache: 'no-store' })
        if (!response.ok) return counts

        const payload = (await response.json()) as ExplorerResponse
        if (!Array.isArray(payload.result)) return counts

        for (const log of payload.result) {
            const topic = log.topics?.[1]
            if (typeof topic !== 'string') continue
            const listingId = Number(BigInt(topic))
            counts.set(listingId, (counts.get(listingId) ?? 0) + 1)
        }
    } catch {
        // Explorer down: the board still renders, with zero counts.
    }
    return counts
}


export async function fetchAllListings(): Promise<void> {
    const address = getWalletAddress()
    const store = useGameStore.getState()

    try {
        const count = await readContract(config, {
            address: MARKETPLACE_CONTRACT_ADDRESS,
            abi: MARKETPLACE_ABI,
            functionName: 'getListingCount',
        }) as bigint

        if (count === BigInt(0)) {
            store.setAllListing([])
            if (isCurrentWallet(address)) store.setUserListings([])
            return
        }

        const listingIds: bigint[] = []
        for (let i = 0; i < Number(count); i++) {
            listingIds.push(BigInt(i))
        }

        // `getListing` returns the `Listing` struct, so viem decodes it into an
        // object. The public `listings` mapping getter exposes the same fields as
        // positional outputs, which decode into an array instead.
        const rawListings = await Promise.all(
            listingIds.map((id) =>
                readContract(config, {
                    address: MARKETPLACE_CONTRACT_ADDRESS,
                    abi: MARKETPLACE_ABI,
                    functionName: 'getListing',
                    args: [id],
                }) as Promise<ListingView>,
            ),
        )

        const indexed: IndexedListingView[] = rawListings
            .map((raw, i) => {
                // Viem may return the struct as a tuple (array) or as a named
                // object depending on the consumer/ABI cache. Normalize to the
                // named form so downstream code never has to special-case.
                // The tuple arm is positional — keep it in struct order.
                const named: NamedListingView = Array.isArray(raw)
                    ?   {
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
                    : (raw as NamedListingView)
                return { ...named, listingId: i } as IndexedListingView
            })

        // A finalized auction leaves the marketplace with isActive false. The
        // winner is whoever held the highest bid: with no bids the NFT returns
        // to the seller and there is nothing left to show.
        const activeListings: IndexedListingView[] = indexed.filter((l) => l.isActive)

        if (activeListings.length === 0) {
            store.setAllListing([])
            if (isCurrentWallet(address)) store.setUserListings([])
            return
        }

        // One explorer query for the whole board; failures degrade to zero
        // counts rather than failing the listing fetch.
        const bidCounts = await fetchBidCounts()

        const mapped: ListItem[] = await Promise.all(
            activeListings.map(async (listing) => {
                // The listing struct carries only the current highest bid, so
                // the count comes from BidPlaced events (one explorer query for
                // the whole board, shared above).
                const bidCount = bidCounts.get(listing.listingId) ?? 0

                const isShipContract = listing.nftContract?.toLowerCase() === SHIP_CONTRACT_ADDRESS.toLowerCase()
                let itemName = 'Unknown'
                let itemImage = ''
                let itemRarity = 'Common'
                let itemMetadata = ''

                try {
                    const tokenType = await readContract(config, {
                        address: listing.nftContract,
                        abi: isShipContract ? SHIP_ABI : ITEM_ABI,
                        functionName: isShipContract ? 'tokenShipType' : 'tokenItemType',
                        args: [listing.tokenId],
                    }) as bigint

                    if (isShipContract) {
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
                    // fallback
                }

                return {
                    name: itemName,
                    image: itemImage,
                    rarity: itemRarity,
                    metadata: itemMetadata,
                    serialNumber: Number(listing.tokenId),
                    listingId: listing.listingId,
                    seller: listing.seller,
                    price: Number(formatUnits(listing.price, STARS_DECIMALS)),
                    isActive: listing.isActive,
                    endTime: Number(listing.auctionEndTime),
                    listingType: Number(listing.listingType),
                    bidCount,
                    winner: listing.highestBidder === ZERO_ADDRESS ? '' : listing.highestBidder,
                    clearingPrice: Number(formatUnits(listing.highestBid, STARS_DECIMALS)),
                } as ListItem
            }),
        )

        // The Marketplace shows what can still be bought or bid on.
        store.setAllListing(mapped.filter((l) => l.isActive))

        if (address && isCurrentWallet(address)) {
            store.setUserListings(mapped.filter(l => l.seller.toLowerCase() === address.toLowerCase()))
        }
    } catch (error) {
        console.error('fetchAllListings error:', error)
        store.setAllListing([])
    }
}

export async function listItem(
    itemData: Items,
    price: number,
    isAuction: boolean,
    auctionDuration: number,
    toastId: string,
): Promise<boolean> {
    const address = getWalletAddress()
    if (!address) {
        toast.error('Wallet not connected', { id: toastId })
        return false
    }

    try {
        toast.loading('Approving NFT for marketplace...', { id: toastId })
        const approveTx = await writeContract(config, {
            address: ITEM_CONTRACT_ADDRESS,
            abi: ITEM_ABI,
            functionName: 'setApprovalForAll',
            args: [MARKETPLACE_CONTRACT_ADDRESS, true],
        })
        await waitForTransactionReceipt(config, { hash: approveTx })

        toast.loading('Creating listing...', { id: toastId })
        const priceWei = parseUnits(price.toString(), STARS_DECIMALS)
        const tx = await writeContract(config, {
            address: MARKETPLACE_CONTRACT_ADDRESS,
            abi: MARKETPLACE_ABI,
            functionName: 'createListing',
            args: [
                ITEM_CONTRACT_ADDRESS,
                BigInt(itemData.serialNumber),
                priceWei,
                isAuction ? LISTING_TYPE_AUCTION : LISTING_TYPE_FIXED_PRICE,
                isAuction ? BigInt(auctionDuration) : BigInt(0),
            ],
        })
        await waitForTransactionReceipt(config, { hash: tx })
        toast.success('Item listed!', { id: toastId })
        // Refresh both the marketplace board and the pilot's own inventory
        // before reporting success, so the caller's UI is already consistent.
        await revalidateMarketData({ awaitChange: true })
        // Every marketplace write moves Stars or gas: refresh balances
        // fire-and-forget alongside the market revalidation above.
        void refreshWalletBalances({ awaitChange: true })
        return true
    } catch (error: unknown) {
        console.error('listItem error:', error)
        toast.error(`Listing failed: ${getTxErrorMessage(error)}`, { id: toastId })
        return false
    }
}

export async function buyItemListing(item: ListItem, toastId: string): Promise<boolean> {
    const address = getWalletAddress()
    if (!address) {
        toast.error('Wallet not connected', { id: toastId })
        return false
    }

    if (item.listingType !== 0) {
        toast.error('This item is an auction listing and cannot be bought instantly', { id: toastId })
        return false
    }

    try {
        const priceWei = parseUnits(item.price.toString(), STARS_DECIMALS)
        toast.loading('Checking Stars allowance...', { id: toastId })
        const approved = await ensureAllowance(MARKETPLACE_CONTRACT_ADDRESS, priceWei)
        if (!approved) {
            toast.error('Stars approval failed', { id: toastId })
            return false
        }

        toast.loading('Buying item...', { id: toastId })
        const tx = await writeContract(config, {
            address: MARKETPLACE_CONTRACT_ADDRESS,
            abi: MARKETPLACE_ABI,
            functionName: 'buyItem',
            args: [BigInt(item.listingId)],
        })
        await waitForTransactionReceipt(config, { hash: tx })
        toast.success('Item purchased!', { id: toastId })
        await revalidateMarketData({ awaitChange: true })
        // Every marketplace write moves Stars or gas: refresh balances
        // fire-and-forget alongside the market revalidation above.
        void refreshWalletBalances({ awaitChange: true })
        return true
    } catch (error: unknown) {
        console.error('buyItemListing error:', error)
        toast.error(`Purchase failed: ${getTxErrorMessage(error)}`, { id: toastId })
        return false
    }
}

/**
 * Place a transparent ascending bid.
 *
 * The full bid amount is escrowed in Stars and the previous highest bid is
 * refunded immediately on-chain, so losers never wait for payout. Bidding
 * again simply outbids — including your own bid.
 */
export async function placeBid(
    item: ListItem,
    bidAmount: number,
    toastId: string,
): Promise<boolean> {
    const address = getWalletAddress()
    if (!address) {
        toast.error('Wallet not connected', { id: toastId })
        return false
    }

    // Checked before the allowance prompt so a closed auction costs the bidder
    // nothing. The contract re-checks against chain time and has the last word.
    if (isAuctionEnded(item.endTime)) {
        toast.error('Bidding has closed on this auction', { id: toastId })
        return false
    }

    // The first bid must meet the reserve; later bids must exceed the highest.
    // The contract enforces both; checked here so the failure stays off-wallet.
    if (bidAmount < item.price) {
        toast.error(`Bid must be at least the ${item.price} Stars reserve`, { id: toastId })
        return false
    }

    try {
        const bidWei = parseUnits(bidAmount.toString(), STARS_DECIMALS)
        toast.loading('Checking Stars allowance...', { id: toastId })
        const approved = await ensureAllowance(MARKETPLACE_CONTRACT_ADDRESS, bidWei)
        if (!approved) {
            toast.error('Stars approval failed', { id: toastId })
            return false
        }

        toast.loading('Placing bid...', { id: toastId })
        const tx = await writeContract(config, {
            address: MARKETPLACE_CONTRACT_ADDRESS,
            abi: MARKETPLACE_ABI,
            functionName: 'placeBid',
            args: [BigInt(item.listingId), bidWei],
        })
        await waitForTransactionReceipt(config, { hash: tx })
        toast.success('Bid placed', { id: toastId })
        await revalidateMarketData({ awaitChange: true })
        // Every marketplace write moves Stars or gas: refresh balances
        // fire-and-forget alongside the market revalidation above.
        void refreshWalletBalances({ awaitChange: true })
        return true
    } catch (error: unknown) {
        console.error('placeBid error:', error)
        toast.error(`Bid failed: ${getTxErrorMessage(error)}`, { id: toastId })
        return false
    }
}

/**
 * Close an ended auction.
 *
 * Anyone may call: the outcome is fully determined by on-chain bids, so no
 * privileged role is needed. With bids the NFT goes to the highest bidder;
 * with none it returns to the seller.
 */
export async function finalizeAuction(item: ListItem, toastId: string): Promise<boolean> {
    const address = getWalletAddress()
    if (!address) {
        toast.error('Wallet not connected', { id: toastId })
        return false
    }

    try {
        toast.loading('Finalizing auction...', { id: toastId })
        const tx = await writeContract(config, {
            address: MARKETPLACE_CONTRACT_ADDRESS,
            abi: MARKETPLACE_ABI,
            functionName: 'finalizeAuction',
            args: [BigInt(item.listingId)],
        })
        await waitForTransactionReceipt(config, { hash: tx })

        toast.success('Auction finalized', { id: toastId })
        await revalidateMarketData({ awaitChange: true })
        // Every marketplace write moves Stars or gas: refresh balances
        // fire-and-forget alongside the market revalidation above.
        void refreshWalletBalances({ awaitChange: true })
        return true
    } catch (error: unknown) {
        console.error('finalizeAuction error:', error)
        toast.error(`Settlement failed: ${getTxErrorMessage(error)}`, { id: toastId })
        return false
    }
}

export async function cancelListing(
    listingId: number,
    toastId: string,
): Promise<boolean> {
    const address = getWalletAddress()
    if (!address) {
        toast.error('Wallet not connected', { id: toastId })
        return false
    }

    try {
        toast.loading('Cancelling listing...', { id: toastId })
        const tx = await writeContract(config, {
            address: MARKETPLACE_CONTRACT_ADDRESS,
            abi: MARKETPLACE_ABI,
            functionName: 'cancelListing',
            args: [BigInt(listingId)],
        })
        await waitForTransactionReceipt(config, { hash: tx })
        toast.success('Listing cancelled', { id: toastId })
        await revalidateMarketData({ awaitChange: true })
        // Every marketplace write moves Stars or gas: refresh balances
        // fire-and-forget alongside the market revalidation above.
        void refreshWalletBalances({ awaitChange: true })
        return true
    } catch (error: unknown) {
        console.error('cancelListing error:', error)
        toast.error(`Cancel failed: ${getTxErrorMessage(error)}`, { id: toastId })
        return false
    }
}

export async function updatePrice(
    listingId: number,
    newPrice: number,
    toastId: string,
): Promise<boolean> {
    const address = getWalletAddress()
    if (!address) {
        toast.error('Wallet not connected', { id: toastId })
        return false
    }

    try {
        toast.loading('Updating price...', { id: toastId })
        const priceWei = parseUnits(newPrice.toString(), STARS_DECIMALS)
        const tx = await writeContract(config, {
            address: MARKETPLACE_CONTRACT_ADDRESS,
            abi: MARKETPLACE_ABI,
            functionName: 'updatePrice',
            args: [BigInt(listingId), priceWei],
        })
        await waitForTransactionReceipt(config, { hash: tx })
        toast.success('Price updated!', { id: toastId })
        await revalidateMarketData({ awaitChange: true })
        // Every marketplace write moves Stars or gas: refresh balances
        // fire-and-forget alongside the market revalidation above.
        void refreshWalletBalances({ awaitChange: true })
        return true
    } catch (error: unknown) {
        console.error('updatePrice error:', error)
        toast.error(`Update failed: ${getTxErrorMessage(error)}`, { id: toastId })
        return false
    }
}
