'use client'

import { useSyncExternalStore } from 'react'

/** Resolution of the clock. Auction labels only show minutes, so 30s is ample. */
const BUCKET_MS = 30_000

function subscribe(onStoreChange: () => void) {
    const intervalId = setInterval(onStoreChange, BUCKET_MS)
    return () => clearInterval(intervalId)
}

/**
 * Quantised so repeated calls inside one render return the same value. An
 * unrounded `Date.now()` would differ on every call and React would treat the
 * store as perpetually changed.
 */
function getSnapshot() {
    return Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS
}

/**
 * Server snapshot. The server's clock is not the browser's, so returning a real
 * timestamp here would produce markup that never matches hydration. `0` is the
 * agreed "clock not available yet" value; callers render a placeholder for it.
 */
function getServerSnapshot() {
    return 0
}

/**
 * Wall-clock time as a render-safe value, or `0` before hydration.
 *
 * Calling `Date.now()` during render is impure: two renders in the same commit
 * can disagree, and nothing re-renders when the clock moves on. The wall clock
 * is an external mutable source, so `useSyncExternalStore` is the sanctioned
 * way to read it — and it gets the countdown to refresh on its own.
 */
export function useNow(): number {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
