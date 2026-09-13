'use client'

import { writeContract, readContract, waitForTransactionReceipt } from 'wagmi/actions'
import { toast } from 'sonner'

import { config } from '@/lib/wagmi'
import { SHIP_CONTRACT_ADDRESS, SHIP_ABI, STARS_DECIMALS } from '@/lib/contracts'
import { getWalletAddress, ensureAllowance, isCurrentWallet } from '@/services/wallet'
import { refreshWalletBalances } from '@/services/balances'
import { useGameStore } from '@/stores/game-store'
import spaceships, { MySpaceships, ShipData } from '@/components/utils/Spaceships'
import { getTxErrorMessage } from '@/services/errors'
import { formatUnits } from 'viem'

export async function fetchUserSpaceships(): Promise<void> {
    const address = getWalletAddress()
    if (!address) return

    const store = useGameStore.getState()
    // First-ever fleet read is blocking; later polls are background refreshes.
    if (store.mySpaceships.length === 0) store.setIsFleetLoading(true)

    try {
        const balance = await readContract(config, {
            address: SHIP_CONTRACT_ADDRESS,
            abi: SHIP_ABI,
            functionName: 'balanceOf',
            args: [address],
        }) as bigint

        if (balance === BigInt(0)) {
            if (!isCurrentWallet(address)) return
            store.setMySpaceships([spaceships[0]])
            return
        }

        // Same index race as items: the balance was a snapshot, but each index is
        // its own call. A ship sale or mint between reads can shift indices out of
        // bounds. Settle them individually so one stale index doesn't blank the fleet.
        const indexReads = await Promise.allSettled(
            Array.from({ length: Number(balance) }, (_, i) =>
                readContract(config, {
                    address: SHIP_CONTRACT_ADDRESS,
                    abi: SHIP_ABI,
                    functionName: 'tokenOfOwnerByIndex',
                    args: [address, BigInt(i)],
                }) as Promise<bigint>,
            ),
        )

        const tokenIds = indexReads
            .filter((r): r is PromiseFulfilledResult<bigint> => r.status === 'fulfilled')
            .map((r) => r.value)

        const shipTypeIndices = await Promise.all(
            tokenIds.map((tokenId) =>
                readContract(config, {
                    address: SHIP_CONTRACT_ADDRESS,
                    abi: SHIP_ABI,
                    functionName: 'tokenShipType',
                    args: [tokenId],
                }) as Promise<bigint>,
            ),
        )

        const ownedShips: MySpaceships[] = shipTypeIndices.map((idx) => {
            const shipIndex = Number(idx)
            return spaceships[shipIndex] || spaceships[0]
        })

        const uniqueShips = ownedShips.filter(
            (ship, idx, arr) => arr.findIndex(s => s.name === ship.name) === idx
        )
        const hasFighter = uniqueShips.some(s => s.name === spaceships[0].name)
        const finalShips = hasFighter ? uniqueShips : [spaceships[0], ...uniqueShips]

        if (!isCurrentWallet(address)) return

        store.setMySpaceships(finalShips.length > 0 ? finalShips : [spaceships[0]])
    } catch (error) {
        console.error('fetchUserSpaceships error:', error)
        if (!isCurrentWallet(address)) return
        store.setMySpaceships([spaceships[0]])
    } finally {
        store.setIsFleetLoading(false)
    }
}

export async function mintSpaceship(shipData: ShipData, toastId: string): Promise<boolean> {
    const address = getWalletAddress()
    if (!address) {
        toast.error('Wallet not connected', { id: toastId })
        return false
    }

    const shipIndex = spaceships.findIndex(
        (s) => s.name === shipData.name,
    )
    if (shipIndex === -1) {
        toast.error('Invalid ship type', { id: toastId })
        return false
    }

    try {
        const starsPrice = await readContract(config, {
            address: SHIP_CONTRACT_ADDRESS,
            abi: SHIP_ABI,
            functionName: 'getShipStarsPrice',
            args: [BigInt(shipIndex)],
        }) as bigint

        if (starsPrice > BigInt(0)) {
            toast.loading('Checking Stars allowance...', { id: toastId })
            const approved = await ensureAllowance(SHIP_CONTRACT_ADDRESS, starsPrice)
            if (!approved) {
                toast.error('Stars approval failed', { id: toastId })
                return false
            }
        }

        toast.loading('Purchasing ship...', { id: toastId })
        const tx = await writeContract(config, {
            address: SHIP_CONTRACT_ADDRESS,
            abi: SHIP_ABI,
            functionName: 'buyShip',
            args: [BigInt(shipIndex)],
        })
        await waitForTransactionReceipt(config, { hash: tx })
        // The purchase spent Stars: refresh balances (fire-and-forget, with
        // change detection in case the node has not synced the block yet).
        void refreshWalletBalances({ awaitChange: true })
        toast.success(`Ship purchased: ${shipData.name}!`, { id: toastId })
        return true
    } catch (error: unknown) {
        console.error('mintSpaceship error:', error)
        toast.error(`Purchase failed: ${getTxErrorMessage(error)}`, { id: toastId })
        return false
    }
}

export interface ShipPriceInfo {
    starsPrice: number
}

/**
 * Catalog prices in Stars, read straight off the contract.
 *
 * There is no USD feed on Creditcoin: the dealership quotes the on-chain
 * Stars price and nothing else. A fiat display can return in Task 9 once a
 * price source exists.
 */
export async function fetchShipStarsPrices(): Promise<ShipPriceInfo[]> {
    const priceInfos: ShipPriceInfo[] = await Promise.all(
        spaceships.map(async (ship, idx) => {
            if (ship.price === 0) {
                return { starsPrice: 0 }
            }

            try {
                const starsPriceWei = await readContract(config, {
                    address: SHIP_CONTRACT_ADDRESS,
                    abi: SHIP_ABI,
                    functionName: 'getShipStarsPrice',
                    args: [BigInt(idx)],
                }) as bigint

                const starsPrice = Number(formatUnits(starsPriceWei, STARS_DECIMALS))

                return { starsPrice }
            } catch (error) {
                console.error(`fetchShipStarsPrices error for ship ${ship.name}:`, error)
                return { starsPrice: 0 }
            }
        }),
    )

    return priceInfos
}
