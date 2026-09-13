import {
    decodeEventLog,
    parseAbi,
    toEventSelector,
    type Hash,
} from 'viem'

/**
 * Chain-agnostic bridge helpers, kept free of `@/` imports, `window`, and
 * wagmi so `node --test` can import this module directly. `bridge.ts` wires
 * these into the wallet/store flow; the unit tests cover them here.
 */

/** keccak256("BridgeExecuted(address,address,uint256,uint256)") */
export const BRIDGE_EXECUTED_TOPIC = toEventSelector(
    'BridgeExecuted(address,address,uint256,uint256)',
)

const BRIDGE_EXECUTED_ABI = parseAbi([
    'event BridgeExecuted(address indexed player, address indexed recipient, uint256 amount, uint256 nonce)',
])

/** Sepolia chain id 11155111 as the hex wallet RPCs expect. */
export const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7'

export const SEPOLIA_EXPLORER_URL = 'https://sepolia.etherscan.io'

export const CREDITCOIN_EXPLORER_API = 'https://creditcoin-testnet.blockscout.com/api'

/** Never recorded as a mint link: a missing hash polls on, it does not mint. */
export const ZERO_HASH =
    '0x0000000000000000000000000000000000000000000000000000000000000000' as Hash

/** Left-pad an address to the 32 bytes an indexed topic is stored as. */
export function addressToTopic(address: string): string {
    return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`
}

/** `0x`-prefixed lowercase hex for `wallet_switchEthereumChain`. */
export function toChainIdHex(chainId: number): string {
    return `0x${chainId.toString(16)}`
}

/** EIP-1193 "chain not added" — caller should add then retry the switch once. */
export function isUnknownChainError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 4902
    )
}

/** EIP-1193 user rejection — surface it, never silently swallow or retry. */
export function isUserRejectionError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 4001
    )
}

export interface SepoliaAddChainParams {
    chainId: string
    chainName: string
    nativeCurrency: { name: string; symbol: string; decimals: number }
    rpcUrls: string[]
    blockExplorerUrls: string[]
}

/** `wallet_addEthereumChain` params for Sepolia. RPC comes from env. */
export function buildSepoliaAddChainParams(rpcUrl: string): SepoliaAddChainParams {
    return {
        chainId: SEPOLIA_CHAIN_ID_HEX,
        chainName: 'Sepolia',
        nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [rpcUrl],
        blockExplorerUrls: [SEPOLIA_EXPLORER_URL],
    }
}

export interface BridgeExplorerLog {
    topics: (string | null)[]
    data?: string
    transactionHash?: string
}

export interface BridgeExplorerResponse {
    status?: string
    message?: string
    result?: BridgeExplorerLog[] | string
}

function isUsableTxHash(value: unknown): value is Hash {
    return (
        typeof value === 'string' &&
        value.startsWith('0x') &&
        value.length === 66 &&
        !/^0x0+$/.test(value)
    )
}

/**
 * Pure matcher over one Blockscout `getLogs` page. Returns the ASC tx hash on
 * the first log whose decoded `player`, `recipient`, and `nonce` all match,
 * null otherwise — including when the matching log carries no usable
 * `transactionHash`, which must keep polling rather than mint with a zero
 * sentinel link.
 */
export function findBridgeExecutedTx(
    logs: BridgeExplorerLog[] | undefined,
    player: string,
    recipient: string,
    nonce: bigint,
): Hash | null {
    if (!Array.isArray(logs)) return null
    const wantPlayer = player.toLowerCase()
    const wantRecipient = recipient.toLowerCase()

    for (const log of logs) {
        try {
            const decoded = decodeEventLog({
                abi: BRIDGE_EXECUTED_ABI,
                data: (log.data ?? '0x') as Hash,
                topics: (log.topics ?? []) as [signature: Hash, ...args: Hash[]],
            })
            if (decoded.eventName !== 'BridgeExecuted') continue
            const args = decoded.args as unknown as {
                player: string
                recipient: string
                amount: bigint
                nonce: bigint
            }
            if (args.nonce !== nonce) continue
            if (args.player.toLowerCase() !== wantPlayer) continue
            if (args.recipient.toLowerCase() !== wantRecipient) continue
            if (isUsableTxHash(log.transactionHash)) return log.transactionHash
            // Matching event but no linkable tx yet — keep polling.
            continue
        } catch {
            // Not our event; the ABI mismatch is the signal, not a fault.
        }
    }
    return null
}

export interface PollBridgeDeps {
    ascAddress: string
    fetchImpl?: typeof fetch
    apiBase?: string
    /**
     * Explorer request timeout per poll. A hung request must never freeze the
     * watch loop (the deadline is only checked between iterations), so a
     * stalled poll fails like any other miss and the loop continues.
     */
    timeoutMs?: number
}

/** Default per-poll explorer timeout, comfortably under the 30s poll cadence. */
export const BRIDGE_POLL_FETCH_TIMEOUT_MS = 20000

/**
 * One Blockscout pass for this lock's `BridgeExecuted`. Returns the ASC
 * transaction hash on a player+recipient+nonce match, null otherwise —
 * including when the explorer is unreachable, which is not a failed bridge.
 */
export async function pollBridgeExecuted(
    player: `0x${string}`,
    recipient: `0x${string}`,
    nonce: bigint,
    deps: PollBridgeDeps,
): Promise<Hash | null> {
    const apiBase = deps.apiBase ?? CREDITCOIN_EXPLORER_API
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch
    const timeoutMs = deps.timeoutMs ?? BRIDGE_POLL_FETCH_TIMEOUT_MS
    const url =
        `${apiBase}?module=logs&action=getLogs` +
        `&address=${deps.ascAddress}` +
        `&fromBlock=0&toBlock=latest` +
        `&topic0=${BRIDGE_EXECUTED_TOPIC}` +
        `&topic1=${addressToTopic(player)}` +
        `&topic2=${addressToTopic(recipient)}` +
        `&topic0_1_opr=and&topic0_2_opr=and&topic1_2_opr=and`

    try {
        const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
        if (!response.ok) return null

        const payload = (await response.json()) as BridgeExplorerResponse
        if (!Array.isArray(payload.result)) return null
        return findBridgeExecutedTx(payload.result, player, recipient, nonce)
    } catch {
        // A dropped explorer request is not a failed bridge. Keep polling.
        return null
    }
}

export type WorkerStage = 'proving' | 'submitting'

const WORKER_STAGE_RANK: Record<string, number> = {
    locking: 0,
    'waiting-attestation': 1,
    proving: 2,
    submitting: 3,
}

/**
 * Ordering guard for the worker-status hook. Forward moves and idempotent
 * re-reports are allowed; backward jumps (e.g. `submitting` → `proving`)
 * are rejected so a stale worker poll cannot rewind the timeline. Terminal
 * and unknown phases never advance through this hook.
 */
export function canAdvanceWorkerStage(
    currentPhase: string,
    nextStage: WorkerStage,
): boolean {
    const currentRank = WORKER_STAGE_RANK[currentPhase]
    const nextRank = WORKER_STAGE_RANK[nextStage]
    if (currentRank === undefined || nextRank === undefined) return false
    return nextRank >= currentRank
}

/**
 * Keys with a live poll loop, so a retry never starts a second writer.
 * Module-level for the same reason as the bridge map: the watch outlives
 * the modal that started it.
 */
const activeBridgeWatchers = new Set<string>()

/** Acquire the single-writer slot. False means a poller already owns `key`. */
export function tryAcquireBridgeWatcher(key: string): boolean {
    if (activeBridgeWatchers.has(key)) return false
    activeBridgeWatchers.add(key)
    return true
}

export function releaseBridgeWatcher(key: string): void {
    activeBridgeWatchers.delete(key)
}

export function isBridgeWatcherActive(key: string): boolean {
    return activeBridgeWatchers.has(key)
}

/** Test hook: reset watcher slots between unit tests. */
export function __clearBridgeWatchersForTests(): void {
    activeBridgeWatchers.clear()
}
