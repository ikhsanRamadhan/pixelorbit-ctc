import { formatUnits } from 'viem'

import { STARS_DECIMALS } from '@/lib/contracts'
import { fetchSepoliaEthBalance, fetchSepoliaStarsBalance } from '@/services/wallet'
import { useWalletStore, type BalanceRefetchers } from '@/stores/wallet-store'

/**
 * Central post-write balance refresh, covering all four balances the wallet
 * surfaces (tCTC, CC3 Stars, Sepolia Stars, Sepolia ETH).
 *
 * Wagmi's `useBalance` / `useReadContract` have no polling or block watching
 * and the Sepolia balance is otherwise fetched once per address change, so
 * every write refreshes nothing on its own. Callers invoke this fire-and-
 * forget (`void refreshWalletBalances({ awaitChange: true })`) after the
 * receipt lands; it never throws and never toasts, so a failing balance read
 * can neither break the write flow that triggered it nor spam the user.
 *
 * The wagmi `refetch` functions are registered once by `useWalletSync` (see
 * `balanceRefetchers` in the wallet store); the Sepolia side is always a
 * manual re-read via `fetchSepoliaStarsBalance`, mirroring the sync effect.
 */

/** How many read attempts an `awaitChange` refresh makes before giving up. */
export const BALANCE_REFRESH_ATTEMPTS = 3

/** Delay between `awaitChange` attempts — receipts do not guarantee the next load-balanced node has synced. */
export const BALANCE_REFRESH_DELAY_MS = 1000

/** All four wallet balances in their display (formatted) form. */
export interface BalanceSnapshot {
    tctc: string
    stars: string
    sepoliaStars: string
    sepoliaEth: string
}

/** Injectable seam so unit tests can steer reads without touching an RPC. */
export interface BalanceReader {
    readBalances: () => Promise<BalanceSnapshot>
}

export interface RefreshWalletBalancesOptions {
    awaitChange?: boolean
}

export interface RefreshWalletBalancesDeps {
    reader?: BalanceReader
    delay?: (ms: number) => Promise<void>
    fetchSepolia?: (address: `0x${string}`) => Promise<string>
    fetchSepoliaEth?: (address: `0x${string}`) => Promise<string>
}

/**
 * Everything a balance-moving write can change, flattened into a string.
 *
 * Same `awaitChange` pattern as `marketSignature` in `@/lib/refresh`: a
 * receipt proves nothing about which load-balanced node answers the next
 * read, so the refresh retries until the data actually differs from what the
 * store held before the write.
 */
export function balanceSignature(snapshot: BalanceSnapshot): string {
    return `${snapshot.tctc}:${snapshot.stars}:${snapshot.sepoliaStars}:${snapshot.sepoliaEth}`
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function currentSnapshot(): BalanceSnapshot {
    const { tctcBalance, starsBalance, sepoliaStarsBalance, sepoliaEthBalance } =
        useWalletStore.getState()
    return {
        tctc: tctcBalance,
        stars: starsBalance,
        sepoliaStars: sepoliaStarsBalance,
        sepoliaEth: sepoliaEthBalance,
    }
}

function publishSnapshot(snapshot: BalanceSnapshot): void {
    useWalletStore.getState().setAll({
        tctcBalance: snapshot.tctc,
        starsBalance: snapshot.stars,
        sepoliaStarsBalance: snapshot.sepoliaStars,
        sepoliaEthBalance: snapshot.sepoliaEth,
    })
}

async function readChainBalances(
    refetchers: BalanceRefetchers,
    fallback: BalanceSnapshot,
): Promise<Pick<BalanceSnapshot, 'tctc' | 'stars'>> {
    const [tctc, stars] = await Promise.all([
        (async () => {
            try {
                const fresh = await refetchers.refetchTctc()
                return fresh ? formatUnits(fresh.value, fresh.decimals) : fallback.tctc
            } catch {
                return fallback.tctc
            }
        })(),
        (async () => {
            try {
                const fresh = await refetchers.refetchStars()
                return fresh !== undefined ? formatUnits(fresh, STARS_DECIMALS) : fallback.stars
            } catch {
                return fallback.stars
            }
        })(),
    ])
    return { tctc, stars }
}

/**
 * Live production refresh: registered wagmi refetchers for the Creditcoin
 * side plus manual Sepolia re-reads for the connected address.
 *
 * Sepolia is published in a second phase on purpose — the Creditcoin
 * balances publish first, then the Sepolia patch lands when its RPC
 * answers. Chosen over racing Sepolia against a timeout because a timeout
 * still blocks Creditcoin for the full timeout window, needs arbitrary
 * tuning, and leaves a fallback-value ambiguity; two-phase publish is fully
 * non-blocking, needs no tuning, and mirrors the separate Sepolia effects in
 * `useWalletSync` (wallet-store), which already isolate Sepolia latency
 * from the Creditcoin fields for the same documented reason: Sepolia must
 * never block Creditcoin balances.
 *
 * A failed Creditcoin sub-read keeps the store's current value rather than
 * clobbering a good balance with a failure zero. A Sepolia read returning
 * '0' patches to '0', matching the sync effects' posture (the production
 * Sepolia fetches already return '0' on failure); only a throwing Sepolia
 * fetch (injected-test-only — production never throws) preserves the
 * current Sepolia value. Disconnected (no address or no registered
 * refetchers) returns without touching the store.
 */
async function refreshLiveBalances(
    { awaitChange = false }: RefreshWalletBalancesOptions,
    deps: RefreshWalletBalancesDeps,
): Promise<void> {
    const delay = deps.delay ?? sleep
    const readSepolia = deps.fetchSepolia ?? fetchSepoliaStarsBalance
    const readSepoliaEth = deps.fetchSepoliaEth ?? fetchSepoliaEthBalance
    try {
        const before = awaitChange ? balanceSignature(currentSnapshot()) : null

        for (let attempt = 0; attempt < BALANCE_REFRESH_ATTEMPTS; attempt++) {
            const fallback = currentSnapshot()
            const { accountId, balanceRefetchers } = useWalletStore.getState()
            if (!accountId || !balanceRefetchers) return
            const address = accountId as `0x${string}`

            let creditcoin: Pick<BalanceSnapshot, 'tctc' | 'stars'>
            try {
                creditcoin = await readChainBalances(balanceRefetchers, fallback)
            } catch {
                return
            }
            // Phase 1: Creditcoin publishes immediately, preserving Sepolia.
            // Zustand merges the partial, so a concurrent Sepolia sync write
            // is never clobbered.
            useWalletStore.getState().setAll({
                tctcBalance: creditcoin.tctc,
                starsBalance: creditcoin.stars,
            })

            // Phase 2: Sepolia patches when it lands, however slow.
            let sepoliaStars: string
            try {
                sepoliaStars = await readSepolia(address)
            } catch {
                sepoliaStars = useWalletStore.getState().sepoliaStarsBalance
            }
            let sepoliaEth: string
            try {
                sepoliaEth = await readSepoliaEth(address)
            } catch {
                sepoliaEth = useWalletStore.getState().sepoliaEthBalance
            }
            useWalletStore.getState().setAll({
                sepoliaStarsBalance: sepoliaStars,
                sepoliaEthBalance: sepoliaEth,
            })

            if (before === null || balanceSignature(currentSnapshot()) !== before) break

            // Last attempt already ran; keep what we have rather than
            // sleeping for nothing. The 60s backstop stays as the fallback.
            if (attempt < BALANCE_REFRESH_ATTEMPTS - 1) {
                await delay(BALANCE_REFRESH_DELAY_MS)
            }
        }
    } catch {
        // Best-effort by contract: never throw, never toast.
    }
}

/**
 * Injected-reader refresh: atomic read-and-publish test seam. Kept separate
 * from the live two-phase path so unit tests can steer the full snapshot
 * without touching an RPC.
 */
async function refreshViaReader(
    { awaitChange = false }: RefreshWalletBalancesOptions,
    deps: RefreshWalletBalancesDeps,
): Promise<void> {
    const reader = deps.reader
    const delay = deps.delay ?? sleep
    if (!reader) return
    try {
        const before = awaitChange ? balanceSignature(currentSnapshot()) : null

        for (let attempt = 0; attempt < BALANCE_REFRESH_ATTEMPTS; attempt++) {
            let snapshot: BalanceSnapshot
            try {
                snapshot = await reader.readBalances()
            } catch {
                return
            }
            publishSnapshot(snapshot)

            if (before === null || balanceSignature(snapshot) !== before) break

            if (attempt < BALANCE_REFRESH_ATTEMPTS - 1) {
                await delay(BALANCE_REFRESH_DELAY_MS)
            }
        }
    } catch {
        // Best-effort by contract: never throw, never toast.
    }
}

/**
 * Pull the post-write balances into the wallet store, ahead of any poll.
 *
 * With `awaitChange`, retries the read until the signature actually differs
 * from the pre-write store state (2-3 attempts ~1s apart), because a receipt
 * does not guarantee the next node has synced. Without it, a single
 * read-and-publish (used by the 60s backstop, where there is no known change
 * to wait for). Resolves in every failure case — including a throwing reader
 * — leaving the store untouched rather than publishing a partial snapshot.
 *
 * Live path publishes in two phases (Creditcoin first, Sepolia Stars + ETH
 * patch when they land) so a slow Sepolia RPC never delays the Creditcoin
 * UI; the injected `reader` path stays atomic as a test seam.
 */
export async function refreshWalletBalances(
    { awaitChange = false }: RefreshWalletBalancesOptions = {},
    deps: RefreshWalletBalancesDeps = {},
): Promise<void> {
    if (deps.reader) {
        await refreshViaReader({ awaitChange }, deps)
        return
    }
    await refreshLiveBalances({ awaitChange }, deps)
}
