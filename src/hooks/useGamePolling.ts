'use client'

import { useEffect, useRef, useState } from 'react'
import type { EIP1193Provider } from 'viem'
import { useAccount } from 'wagmi'
import { getConnections } from 'wagmi/actions'
import { useConnectModal } from '@rainbow-me/rainbowkit'

import { creditcoinTestnet } from '@/lib/chains'
import { config } from '@/lib/wagmi'
import { syncAccountIdCookie, walletDisconnect } from '@/services/wallet'
import { getAllScore } from '@/services/leaderboard'
import { fetchUserSpaceships } from '@/services/ships'
import { fetchOwnedItems } from '@/services/items'
import { fetchAllListings } from '@/services/marketplace'
import { useGameStore } from '@/stores/game-store'
import spaceships from '@/components/utils/Spaceships'

function isUnknownChainError(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 4902
}

async function switchToCreditcoinTestnet(provider: EIP1193Provider) {
    const chainId = `0x${creditcoinTestnet.id.toString(16)}`

    try {
        await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId }],
        })
    } catch (error) {
        if (!isUnknownChainError(error)) throw error

        await provider.request({
            method: 'wallet_addEthereumChain',
            params: [{
                chainId,
                chainName: creditcoinTestnet.name,
                nativeCurrency: creditcoinTestnet.nativeCurrency,
                rpcUrls: creditcoinTestnet.rpcUrls.default.http,
                blockExplorerUrls: [creditcoinTestnet.blockExplorers.default.url],
            }],
        })
        await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId }],
        })
    }
}

/**
 * Every chain read the UI depends on, in one place.
 *
 * This is deliberately the *only* schedule in the app. The reading hooks
 * (`useMarketplace`, `usePilotProfile`, `useLeaderboard`) used to each run their
 * own SWR poll over these same functions, so `fetchAllListings` ran on three
 * independent timers and `getAllScore` on three — roughly ten fetch groups per
 * 15s against a public RPC endpoint, which is how a live demo gets rate-limited.
 *
 * Split by whether a wallet is needed rather than fetched as one batch: the
 * leaderboard and the marketplace are public, and a visitor who has not
 * connected still has to see them. `fetchUserSpaceships` and `fetchOwnedItems`
 * both early-return without an address, so calling them disconnected would be
 * wasted round-trips.
 *
 * `allSettled`, not `all`: one failing read must not cancel the others.
 */
async function fetchPublicData() {
    await Promise.allSettled([getAllScore(), fetchAllListings()])
}

// Flatten the wallet-scoped reads into the same allSettled group as public
// data, instead of nesting fetchPublicData() inside it. Previously the
// public reads resolved first and only then did fetchUserSpaceships /
// fetchOwnedItems start — wasting the round-trips they'd otherwise overlap
// with. Now every chain read in the app runs concurrently.
async function fetchAllGameData() {
    await Promise.allSettled([
        getAllScore(),
        fetchAllListings(),
        fetchUserSpaceships(),
        fetchOwnedItems(),
    ])
}

const POLL_INTERVAL_MS = 15000

export function useGamePolling() {
    const { address, isConnected } = useAccount()
    const { openConnectModal, connectModalOpen } = useConnectModal()
    const [connectError, setConnectError] = useState<string>()
    const setIsLoading = useGameStore((s) => s.setIsLoading)
    const previousAddress = useRef<string | undefined>(undefined)

    useEffect(() => {
        const current = isConnected ? address : undefined
        const previous = previousAddress.current

        if ((previous?.toLowerCase() ?? undefined) !== (current?.toLowerCase() ?? undefined)) {
            previousAddress.current = current
            // Reset first: drops isFleetLoading to false via resetUserData, then
            // setIsFleetLoading(true) below re-arms it for the new wallet's read.
            if (previous) useGameStore.getState().resetUserData()
            if (current) {
                // Seed the starter Fighter immediately — it's local data, no chain
                // read needed. fetchUserSpaceships overwrites this with the real
                // fleet once balanceOf resolves, and usePilotProfile hides the
                // skeleton as soon as mySpaceships is non-empty, so the Fighter
                // appears on frame one instead of after the slowest batch read.
                useGameStore.getState().setMySpaceships([spaceships[0]])
                useGameStore.getState().setIsFleetLoading(true)
            }
        }

        syncAccountIdCookie(isConnected, address)

        // Public data is polled either way; the wallet-scoped reads join in only
        // once there is an address for them to read.
        const fetch = isConnected ? fetchAllGameData : fetchPublicData

        setIsLoading(true)
        void fetch().finally(() => setIsLoading(false))

        const intervalId = setInterval(() => {
            void fetch()
        }, POLL_INTERVAL_MS)

        return () => clearInterval(intervalId)
    }, [isConnected, address, setIsLoading])

    const connect = () => {
        setConnectError(undefined)
        openConnectModal?.()
    }

    useEffect(() => {
        if (!isConnected) return

        const connector = getConnections(config)[0]?.connector
        if (!connector) return

        let cancelled = false

        // Both outcomes are reported from inside the async flow rather than
        // clearing the error up-front in the effect body: a synchronous setState
        // there re-renders every consumer before any work has been attempted.
        const ensureCreditcoinTestnet = async () => {
            try {
                const provider = await connector.getProvider() as EIP1193Provider
                await switchToCreditcoinTestnet(provider)
                if (!cancelled) setConnectError(undefined)
            } catch {
                if (!cancelled) {
                    setConnectError('Creditcoin Testnet was not enabled. Retry and approve the network request.')
                }
            }
        }

        void ensureCreditcoinTestnet()

        return () => {
            cancelled = true
        }
    }, [isConnected])

    return {
        connect,
        connectError,
        disconnect: walletDisconnect,
        connectModalOpen: !!connectModalOpen,
    }
}
