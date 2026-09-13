'use client'

import { readContract, waitForTransactionReceipt, writeContract } from 'wagmi/actions'
import { toast } from 'sonner'
import { decodeEventLog, parseAbi } from 'viem'

import { config } from '@/lib/wagmi'
import { ITEM_CONTRACT_ADDRESS, ITEM_ABI } from '@/lib/contracts'
import { getWalletAddress, isCurrentWallet } from '@/services/wallet'
import { peekRunNonce } from '@/services/leaderboard'
import { refreshWalletBalances } from '@/services/balances'
import { getTxErrorMessage } from '@/services/errors'
import { useGameStore } from '@/stores/game-store'
import items, { Items } from '@/components/utils/Items'

/** Mirrors `PixelOrbitItem.MAX_CRATES_PER_CLAIM` — the contract is the source of truth. */
export const MAX_CRATES_PER_CLAIM = 25

/**
 * Explicit gas cap for `claimCrates`, scaled by crate count.
 *
 * Measured live on CC3: 2 crates cost 469,075 gas, while wallet estimation
 * simulated with only 424,750 and reverted out-of-gas with a reason-less
 * ModuleError. The formula covers the measured cost with headroom (2 crates
 * -> 800k) and stays far under the ~75M block limit at the 25-crate cap
 * (5.4M). Only used gas is paid — the cap is never spent in full.
 */
export function claimGasLimit(crateCount: number): bigint {
    return BigInt(400_000) + BigInt(200_000) * BigInt(crateCount)
}

export async function fetchOwnedItems(): Promise<void> {
    const address = getWalletAddress()
    if (!address) return

    const store = useGameStore.getState()

    try {
        const balance = await readContract(config, {
            address: ITEM_CONTRACT_ADDRESS,
            abi: ITEM_ABI,
            functionName: 'balanceOf',
            args: [address],
        }) as bigint

        if (balance === BigInt(0)) {
            if (!isCurrentWallet(address)) return
            store.setOwnedItems([])
            return
        }

        // Every index is its own eth_call, so the balance can shrink underneath
        // the enumeration: listing an item escrows the NFT to the marketplace,
        // and that write is exactly what triggers this refetch. Against a shrunk
        // balance the highest indices revert ERC721OutOfBoundsIndex — settle them
        // individually and drop the losers, because letting one stale index throw
        // sends the whole inventory to the catch below and blanks it.
        const indexReads = await Promise.allSettled(
            Array.from({ length: Number(balance) }, (_, i) =>
                readContract(config, {
                    address: ITEM_CONTRACT_ADDRESS,
                    abi: ITEM_ABI,
                    functionName: 'tokenOfOwnerByIndex',
                    args: [address, BigInt(i)],
                }) as Promise<bigint>,
            ),
        )

        const tokenIds = indexReads
            .filter((r): r is PromiseFulfilledResult<bigint> => r.status === 'fulfilled')
            .map((r) => r.value)

        const itemTypeIndices = await Promise.all(
            tokenIds.map((tokenId) =>
                readContract(config, {
                    address: ITEM_CONTRACT_ADDRESS,
                    abi: ITEM_ABI,
                    functionName: 'tokenItemType',
                    args: [tokenId],
                }) as Promise<bigint>,
            ),
        )

        const owned: Items[] = itemTypeIndices.map((idx, i) => {
            const itemIndex = Number(idx)
            const itemData = items[itemIndex] || items[0]
            return {
                serialNumber: Number(tokenIds[i]),
                owner: address,
                name: itemData.name,
                rarity: itemData.rarity,
                image: itemData.image,
                metadata: itemData.metadata,
            }
        })

        if (!isCurrentWallet(address)) return

        store.setOwnedItems(owned)
    } catch (error) {
        console.error('fetchOwnedItems error:', error)
        if (!isCurrentWallet(address)) return
        store.setOwnedItems([])
    }
}

/**
 * Open run-earned salvage crates into items.
 *
 * The server signs (player, run nonce, count) via `/api/game/open` and the
 * wallet calls `PixelOrbitItem.claimCrates`: rarity rolls on-chain from a
 * prevrandao-mixed seed, one claim per run nonce. Only gas is spent — no
 * Stars change hands. Returns the revealed item type indices on success
 * (decoded from the claim receipt's `ItemMinted` logs, in mint order), or
 * null when anything fails. A receipt that decodes to nothing still counts
 * as opened — the claim landed, only the display list is empty.
 */
export async function openCrates(crateCount: number): Promise<number[] | null> {
    const address = getWalletAddress()
    if (!address) {
        toast.error('Wallet not connected')
        return null
    }
    if (!Number.isInteger(crateCount) || crateCount < 1) {
        toast.error('No crates to open this run')
        return null
    }
    if (crateCount > MAX_CRATES_PER_CLAIM) {
        toast.error(`At most ${MAX_CRATES_PER_CLAIM} crates per claim`)
        return null
    }
    const runNonce = peekRunNonce()
    if (!runNonce) {
        toast.error('No open run — start a fresh run to earn crates')
        return null
    }
    if (ITEM_CONTRACT_ADDRESS === '0x') {
        toast.error('Item contract is not configured on this deployment')
        return null
    }

    const toastId = `open-crates-${Date.now()}`
    try {
        toast.loading('Requesting crate-opening signature...', { id: toastId })
        const response = await fetch('/api/game/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, runNonce, crateCount }),
        })
        if (!response.ok) {
            const failure = await response.json().catch(() => ({ error: 'Crate claim refused' }))
            toast.error(failure.error || 'Crate claim refused', { id: toastId })
            return null
        }
        const { signature } = (await response.json()) as { signature: `0x${string}` }

        toast.loading(`Opening ${crateCount} ${crateCount === 1 ? 'crate' : 'crates'} onchain...`, {
            id: toastId,
        })
        const hash = await writeContract(config, {
            address: ITEM_CONTRACT_ADDRESS,
            abi: ITEM_ABI,
            functionName: 'claimCrates',
            args: [runNonce as `0x${string}`, crateCount, signature],
            // Explicit cap, not wallet estimation: heavy mints (~469k for 2
            // crates measured live) outrun the estimator and revert reason-less.
            gas: claimGasLimit(crateCount),
        })
        const receipt = await waitForTransactionReceipt(config, { hash })

        // The claim minted items: refresh the inventory (awaited — the user
        // opened the game-over screen expecting to see them) plus balances.
        await fetchOwnedItems()
        void refreshWalletBalances({ awaitChange: true })

        const revealed = decodeClaimedItems(receipt.logs)
        toast.success(`Opened ${crateCount} ${crateCount === 1 ? 'crate' : 'crates'} — salvage recovered!`, {
            id: toastId,
        })
        return revealed
    } catch (error: unknown) {
        console.error('openCrates error:', error)
        toast.error(`Crate opening failed: ${getTxErrorMessage(error)}`, { id: toastId })
        return null
    }
}

/**
 * Item type indices minted by a claim, in mint order, decoded from the
 * receipt's `ItemMinted` logs. Unknown logs are skipped; an undecodable
 * receipt yields an empty list rather than failing the open.
 */
const CLAIMED_EVENT_ABI = parseAbi([
    'event ItemMinted(address indexed to, uint256 indexed tokenId, uint256 itemTypeIndex, uint8 rarity)',
])

export function decodeClaimedItems(logs: ReadonlyArray<{ topics: readonly string[]; data: string }>): number[] {
    const revealed: number[] = []
    for (const log of logs) {
        try {
            const decoded = decodeEventLog({
                abi: CLAIMED_EVENT_ABI,
                data: log.data as `0x${string}`,
                topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
            })
            if (decoded.eventName !== 'ItemMinted') continue
            revealed.push(Number(decoded.args.itemTypeIndex))
        } catch {
            // Not our event; the ABI mismatch is the signal, not a fault.
        }
    }
    return revealed
}
