/**
 * Pure dual-sale helpers, kept free of `@/` imports, `window`, and wagmi so
 * `node --test` can import this module directly. `sale.ts` wires these into
 * the wallet flow; the unit tests cover them here.
 */

/** Max whole Stars per buy call on the Sepolia door (StarsSale.MAX_PER_TX). */
export const SEPOLIA_SALE_MAX_PER_TX = 100

export type StarAmountParse = { amount: bigint } | { error: string }

/**
 * Parse a whole-Stars amount string. Both sale doors take whole Stars only
 * (1 = 1e18 token units); fractional input is rejected rather than rounded,
 * because rounding up would overcharge and rounding down would underpay the
 * exact-value check onchain.
 */
export function parseStarAmount(raw: string, max: number): StarAmountParse {
    const trimmed = raw.trim()
    if (trimmed === '') return { error: 'Enter a Stars amount' }
    if (!/^\d+$/.test(trimmed)) return { error: 'Amount must be a whole number of Stars' }
    let amount: bigint
    try {
        amount = BigInt(trimmed)
    } catch {
        return { error: 'Invalid Stars amount' }
    }
    if (amount <= BigInt(0)) return { error: 'Amount must be greater than zero' }
    if (amount > BigInt(max)) return { error: `Amount exceeds the maximum of ${max} Stars per buy` }
    return { amount }
}

/**
 * Parse a whole-Stars amount string with no upper bound. The two-way CC3
 * door (sell-back, consignment) has no per-call cap — the contract enforces
 * pool stock and lot ownership — so only wholeness and positivity apply.
 */
export function parseWholeStars(raw: string): StarAmountParse {
    const trimmed = raw.trim()
    if (trimmed === '') return { error: 'Enter a Stars amount' }
    if (!/^\d+$/.test(trimmed)) return { error: 'Amount must be a whole number of Stars' }
    let amount: bigint
    try {
        amount = BigInt(trimmed)
    } catch {
        return { error: 'Invalid Stars amount' }
    }
    if (amount <= BigInt(0)) return { error: 'Amount must be greater than zero' }
    return { amount }
}

/**
 * Exact native-currency cost for a buy: whole Stars times the onchain
 * pricePerStar (wei). Sent as `msg.value` verbatim — both doors require
 * exact payment and keep no change logic.
 */
export function totalSaleCost(starAmount: bigint, pricePerStar: bigint): bigint {
    return starAmount * pricePerStar
}

/**
 * Whole Stars the sell-back pool can currently pay for: floor of the free
 * pool (live tCTC balance minus owed consignor proceeds) over the onchain
 * sell-back price. Mirrors the `sellStars` solvency guard — a pool of 10
 * tCTC at a sell price of 8 covers exactly 1 Star, so a 2-Star sell must
 * wait for another buy to refill the shared pool. Zero when either input is
 * non-positive (unreachable price or dry pool).
 */
export function maxSellableStars(freePoolWei: bigint, sellPricePerStar: bigint): bigint {
    if (sellPricePerStar <= BigInt(0)) return BigInt(0)
    if (freePoolWei <= BigInt(0)) return BigInt(0)
    return freePoolWei / sellPricePerStar
}
