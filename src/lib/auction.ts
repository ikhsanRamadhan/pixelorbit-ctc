/**
 * Auction deadline helpers, shared by the marketplace UI and the write path.
 *
 * `endTimeInSeconds` is the contract's `auctionEndTime` in unix *seconds*, where
 * `0` means the listing has no deadline. React callers pass `useNow()` so the
 * value is render-safe; there `0` stands for "clock not available yet".
 */

const toMs = (endTimeInSeconds: number) => endTimeInSeconds * 1000

/** Contract's PAYMENT_WINDOW (24 hours) in seconds. */
export const PAYMENT_WINDOW_SECONDS = 86400

/**
 * Whether bidding has closed.
 *
 * Advisory only — the browser clock is not the chain clock, so the contract's
 * own `require` stays authoritative. This exists to keep the UI honest and to
 * avoid spending an approval on a transaction that would certainly revert.
 *
 * An unknown clock (`nowMs === 0`, pre-hydration) reports `false`: a listing
 * must never render as ended on a guess.
 */
export function isAuctionEnded(endTimeInSeconds: number, nowMs: number = Date.now()): boolean {
    if (!endTimeInSeconds || nowMs === 0) return false
    return nowMs >= toMs(endTimeInSeconds)
}

export interface AuctionLabels {
    dateStr: string
    timeLeftStr: string
}

/** Absolute end date plus a coarse countdown, both ready to render. */
export function formatAuctionEnd(endTimeInSeconds: number, nowMs: number): AuctionLabels {
    if (!endTimeInSeconds) return { dateStr: '-', timeLeftStr: '-' }

    const endMs = toMs(endTimeInSeconds)
    const dateStr = new Date(endMs).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })

    // The end date is absolute and safe to show before hydration; only the
    // countdown has to wait for a real client timestamp.
    if (nowMs === 0) return { dateStr, timeLeftStr: '…' }

    const diffMs = endMs - nowMs
    if (diffMs <= 0) return { dateStr, timeLeftStr: 'Ended' }

    const hours = Math.floor(diffMs / (1000 * 60 * 60))
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))

    return {
        dateStr,
        timeLeftStr: hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`,
    }
}
