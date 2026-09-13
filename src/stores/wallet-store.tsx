import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { useAccount, useBalance, useReadContract } from 'wagmi'
import { formatUnits } from 'viem'

import { STARS_ADDRESS, STARS_ABI, STARS_DECIMALS } from '@/lib/contracts'
import { fetchSepoliaEthBalance, fetchSepoliaStarsBalance } from '@/services/wallet'

export interface WalletState {
    accountId: string | undefined
    isConnected: boolean
    tctcBalance: string
    starsBalance: string
    sepoliaStarsBalance: string
    sepoliaEthBalance: string
    connect: (() => void) | undefined
    connectError: string | undefined
    disconnect: (() => Promise<void>) | undefined
    connectModalOpen: boolean
    /**
     * Wagmi refetch functions registered once by `useWalletSync`, so the
     * central `refreshWalletBalances` action in `@/services/balances` can
     * re-read the Creditcoin side on demand. Stored via `setAll` like every
     * other field; undefined until the sync hook mounts (or after unmount).
     */
    balanceRefetchers: BalanceRefetchers | undefined
    setAll: (payload: Partial<WalletState>) => void
}

/**
 * Narrow view over the wagmi `refetch` results the balance refresh needs:
 * the native balance with its decimals, and the Stars ERC-20 bigint.
 * `useWalletSync` adapts the hook results into this shape so the refresh
 * action never depends on wagmi's query types.
 */
export interface BalanceRefetchers {
    refetchTctc: () => Promise<{ value: bigint; decimals: number } | undefined>
    refetchStars: () => Promise<bigint | undefined>
}

export const useWalletStore = create<WalletState>((set) => ({
    accountId: undefined,
    isConnected: false,
    tctcBalance: '0',
    starsBalance: '0',
    sepoliaStarsBalance: '0',
    sepoliaEthBalance: '0',
    connect: undefined,
    connectError: undefined,
    disconnect: undefined,
    connectModalOpen: false,
    balanceRefetchers: undefined,
    setAll: (payload) => set(payload),
}))

/** Dedicated backstop cadence for balances only — separate from the 15s game-data poll. */
const BALANCE_BACKSTOP_MS = 60000

export function useWalletSync() {
    const { address, isConnected } = useAccount()
    const { data: balanceData, refetch: refetchTctcBalance } = useBalance({ address })

    const { data: starsData, refetch: refetchStarsBalance } = useReadContract({
        address: STARS_ADDRESS,
        abi: STARS_ABI,
        functionName: 'balanceOf',
        args: address ? [address] : undefined,
        query: { enabled: !!address },
    })

    const setAll = useWalletStore((s) => s.setAll)

    // Mirror of the latest wagmi refetch functions. The registration below
    // runs once, but the stable wrappers always call through this ref so they
    // track address changes and hook re-renders.
    const refetchersRef = useRef({
        refetchTctcBalance,
        refetchStarsBalance,
    })

    // Keep the ref fresh outside render: assigning refs during render is a
    // React anti-pattern (concurrent renders may tear), so the update lives
    // in an effect keyed on the hook results it mirrors.
    useEffect(() => {
        refetchersRef.current = { refetchTctcBalance, refetchStarsBalance }
    }, [refetchTctcBalance, refetchStarsBalance])

    // Register the Creditcoin-side refetchers once for the central balance
    // refresh action. The wrappers adapt wagmi's query results into the
    // narrow `BalanceRefetchers` shape (missing data resolves to undefined
    // and the refresh keeps the store's current value).
    useEffect(() => {
        setAll({
            balanceRefetchers: {
                refetchTctc: async () => {
                    const result = await refetchersRef.current.refetchTctcBalance()
                    const data = result.data
                    return data ? { value: data.value, decimals: data.decimals } : undefined
                },
                refetchStars: async () => {
                    const result = await refetchersRef.current.refetchStarsBalance()
                    return typeof result.data === 'bigint' ? result.data : undefined
                },
            },
        })
        return () => {
            setAll({ balanceRefetchers: undefined })
        }
    }, [setAll])

    useEffect(() => {
        setAll({
            accountId: address,
            isConnected: !!isConnected,
            tctcBalance: balanceData
                ? formatUnits(balanceData.value, balanceData.decimals)
                : '0',
            starsBalance: starsData
                ? formatUnits(starsData as bigint, STARS_DECIMALS)
                : '0',
        })
    }, [address, isConnected, balanceData, starsData, setAll])

    // Sepolia Stars ride a separate effect on purpose: the Sepolia RPC is
    // slower than the Creditcoin one, and a slow or failing Sepolia read
    // must never block or clear the Creditcoin balances above. This effect
    // only ever writes sepoliaStarsBalance (zustand merges the partial),
    // and a Sepolia failure falls back to '0' without touching starsBalance.
    useEffect(() => {
        if (!address) {
            setAll({ sepoliaStarsBalance: '0' })
            return
        }
        let cancelled = false
        void (async () => {
            const value = await fetchSepoliaStarsBalance(address)
            if (!cancelled) setAll({ sepoliaStarsBalance: value })
        })()
        return () => { cancelled = true }
    }, [address, setAll])

    // Sepolia ETH rides its own effect for the same isolation reason as
    // Sepolia Stars above: one slow chain must never block or clear the
    // others. Only ever writes sepoliaEthBalance.
    useEffect(() => {
        if (!address) {
            setAll({ sepoliaEthBalance: '0' })
            return
        }
        let cancelled = false
        void (async () => {
            const value = await fetchSepoliaEthBalance(address)
            if (!cancelled) setAll({ sepoliaEthBalance: value })
        })()
        return () => { cancelled = true }
    }, [address, setAll])

    // Balances backstop, deliberately separate from the 15s game-data poll in
    // `useGamePolling`: external changes such as inbound transfers move no
    // game state, so the game poll would never notice them. Balances only,
    // every 60s, and a no-op while disconnected (no address, no interval).
    // Dynamic import keeps this store free of a static cycle —
    // `@/services/balances` reads this store — same precedent as the dynamic
    // imports in `@/lib/refresh`.
    useEffect(() => {
        if (!address) return
        const intervalId = setInterval(() => {
            // Fresh dynamic import per tick (module-cached after the first
            // load): a chunk/network import failure rejects into the
            // trailing .catch instead of surfacing as an unhandled rejection.
            // The refresh itself never throws, so the catch is purely for the
            // import leg; the next tick retries either way.
            void import('@/services/balances')
                .then((m) => m.refreshWalletBalances())
                .catch(() => {})
        }, BALANCE_BACKSTOP_MS)
        return () => clearInterval(intervalId)
    }, [address])
}
