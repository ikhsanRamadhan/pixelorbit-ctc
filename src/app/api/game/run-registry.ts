/**
 * In-memory run-nonce registry shared by `/api/game/start` (issues) and
 * `/api/game/open` (consumes for crate claims).
 *
 * Single-instance only: a second server process would not see these maps, so
 * a claim verified on another instance is refused and the player retries on
 * the issuing one. Fine for the testnet deployment this game runs on; a
 * multi-instance production setup would move this to shared storage.
 * Entries older than a day are pruned on write to bound memory.
 */

interface IssuedRun {
    address: string
    issuedAt: number
}

const RUN_TTL_MS = 24 * 3600 * 1000

const issuedRuns = new Map<string, IssuedRun>()
const consumedRuns = new Set<string>()

function prune(now: number): void {
    for (const [nonce, run] of issuedRuns) {
        if (now - run.issuedAt > RUN_TTL_MS) {
            issuedRuns.delete(nonce)
            consumedRuns.delete(nonce)
        }
    }
}

/** Record a freshly issued run nonce for its player. */
export function registerRun(runNonce: string, address: string, issuedAt: number): void {
    prune(Date.now())
    issuedRuns.set(runNonce.toLowerCase(), { address: address.toLowerCase(), issuedAt })
}

/**
 * Consume a run nonce for a crate claim: true only when the nonce was issued
 * to this player, is fresh, and was never consumed. A consumed nonce stays
 * consumed — the contract's `usedRunNonces` is the second lock on the same
 * door, so a server restart between issue and claim fails safe (refused
 * here) rather than double-minting.
 */
export function consumeRun(runNonce: string, address: string): boolean {
    const key = runNonce.toLowerCase()
    const run = issuedRuns.get(key)
    if (!run) return false
    if (run.address !== address.toLowerCase()) return false
    if (Date.now() - run.issuedAt > RUN_TTL_MS) return false
    if (consumedRuns.has(key)) return false
    consumedRuns.add(key)
    return true
}
