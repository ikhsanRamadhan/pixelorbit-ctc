'use client'

import { useSyncExternalStore } from 'react'
import type { Hash } from 'viem'

/**
 * Where a Sepolia → Creditcoin bridge is in its life, from the lock on
 * Sepolia through to the ASC mint on Creditcoin.
 *
 * The middle three phases are the offchain worker's round-trip, which runs
 * unattended: the user is free to close the modal, and the flow keeps going.
 */
export type BridgePhase =
    /** No bridge in flight. */
    | 'idle'
    /** Approve + `lock` submitted on Sepolia; Stars are being escrowed. */
    | 'locking'
    /** Locked and emitted. The worker has not been observed yet. */
    | 'waiting-attestation'
    /** Worker-status hook reports the Sepolia block is being proven. */
    | 'proving'
    /** Proofs built; the ASC submission is being sent on Creditcoin. */
    | 'submitting'
    /** `BridgeExecuted` seen on Creditcoin. Stars minted to the recipient. */
    | 'minted'
    /** The lock failed, or the watch gave up. Funds stay locked on Sepolia
     *  and remain provable later — nothing is lost, only unwatched. */
    | 'failed'

export interface BridgeState {
    phase: BridgePhase
    /** `player:nonce`, the same scoping the ASC uses for its replay guard. */
    key: string
    /** Sepolia locker; doubles as the ASC `player` the nonce is bound to. */
    player: `0x${string}`
    /** Unique per player. Reusing one reverts on the source contract. */
    nonce: bigint
    /** Locked amount in Stars base units (18 decimals). */
    amount: bigint
    /** Creditcoin recipient the ASC mints to. */
    recipient: `0x${string}`
    /** Sepolia `lock` transaction, once it lands. */
    sepoliaTxHash?: Hash
    /** Creditcoin ASC transaction, once `BridgeExecuted` is seen. */
    ascTxHash?: Hash
    /** Why it failed. Set only in the `failed` phase. */
    error?: string
    /**
     * Which half of the flow failed. `lock` covers everything up to and
     * including the Sepolia `lock` (network switch, balance, approve, lock
     * revert) and re-runs via a fresh `lockStars` call. `watch` covers only
     * the post-lock ASC watch timing out, which is safe to re-poll on the
     * same key because the Sepolia lock stays provable.
     */
    errorKind?: 'lock' | 'watch'
    /** `Date.now()` when the lock started, for the watch timeout. */
    createdAt: number
    /**
     * `Date.now()` of the last ASC-watch poll (hit or miss). Pure heartbeat:
     * proves the loop is alive while a bridge sits in `waiting-attestation`.
     */
    lastCheckedAt: number | null
    /** Explorer polls run for this bridge since the watch started. */
    pollCount: number
}

/**
 * Bridges in flight, keyed by `player:nonce`.
 *
 * Module-level rather than component state because the attestation outlives
 * the modal that started it: closing `BridgeModal` unmounts the component
 * while the worker is still minutes from finishing, and the progress has to
 * survive that. Reopening reads the same map and picks the timeline back up.
 */
const bridges = new Map<string, BridgeState>()

const listeners = new Set<() => void>()

/**
 * Snapshot identity matters: `useSyncExternalStore` bails out of re-rendering
 * by `Object.is`, so handing back a fresh array every call would loop forever.
 * The cache is replaced only when the data actually changes.
 */
let snapshot: BridgeState[] = []

function emit() {
    snapshot = Array.from(bridges.values())
    for (const listener of listeners) listener()
}

function subscribe(onStoreChange: () => void) {
    listeners.add(onStoreChange)
    return () => {
        listeners.delete(onStoreChange)
    }
}

function getSnapshot(): BridgeState[] {
    return snapshot
}

/** Nothing is in flight during SSR, and the array must be referentially stable. */
const EMPTY: BridgeState[] = []

function getServerSnapshot(): BridgeState[] {
    return EMPTY
}

/** Store key for a lock. Lower-cased so the same lock always maps together. */
export function bridgeKey(player: string, nonce: bigint): string {
    return `${player.toLowerCase()}:${nonce.toString()}`
}

/**
 * Fresh lock nonce. 256 bits from the platform RNG: uniqueness per player is
 * what the source contract enforces, and guessing a used nonce only reverts
 * the lock — it cannot steal anything.
 */
export function makeBridgeNonce(): bigint {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    let nonce = BigInt(0)
    for (const byte of bytes) {
        nonce = (nonce << BigInt(8)) | BigInt(byte)
    }
    // Zero is a valid nonce on-chain, but some indexers treat `0x0...0` as
    // "no value" when filtering topics — sidestep the whole class.
    return nonce === BigInt(0) ? BigInt(1) : nonce
}

/**
 * Record or advance a bridge's phase. Called by the lock flow and the ASC
 * watcher as the bridge progresses; read by the UI through `useBridges`.
 */
export function setBridgePhase(
    key: string,
    phase: BridgePhase,
    extra?: Omit<Partial<BridgeState>, 'phase' | 'key'>,
): void {
    const previous = bridges.get(key)

    bridges.set(key, {
        player: '0x0000000000000000000000000000000000000000',
        nonce: BigInt(0),
        amount: BigInt(0),
        recipient: '0x0000000000000000000000000000000000000000',
        createdAt: Date.now(),
        lastCheckedAt: null,
        pollCount: 0,
        ...previous,
        key,
        phase,
        ...extra,
    })

    emit()
}

/**
 * Record one ASC-watch poll heartbeat for a tracked bridge. Called on every
 * iteration — hit or miss — so the UI can show the loop is alive while the
 * phase itself has nothing new to report. Never changes the phase.
 */
export function recordBridgePoll(key: string): void {
    const current = bridges.get(key)
    if (!current) return
    bridges.set(key, {
        ...current,
        lastCheckedAt: Date.now(),
        pollCount: current.pollCount + 1,
    })
    emit()
}

/**
 * Read one bridge's state synchronously, or null if it is not tracked.
 *
 * Used by the watcher, which makes decisions off the render path and so
 * cannot subscribe the way `useBridge` does.
 */
export function getBridge(key: string): BridgeState | null {
    return bridges.get(key) ?? null
}

/**
 * Which retry a failed bridge offers. `watch` means the Sepolia lock landed
 * and only the ASC watch may be re-polled on the same key; `lock` means the
 * flow never left Sepolia and needs a fresh `lockStars` (new nonce). Legacy
 * failures without `errorKind` infer it: a stored `sepoliaTxHash` proves the
 * lock landed, so the failure must be watch-phase.
 */
export function getBridgeFailureKind(bridge: BridgeState | null): 'lock' | 'watch' | null {
    if (!bridge || bridge.phase !== 'failed') return null
    if (bridge.errorKind === 'lock' || bridge.errorKind === 'watch') return bridge.errorKind
    return bridge.sepoliaTxHash ? 'watch' : 'lock'
}

/**
 * Forget a bridge, once the user has acknowledged the outcome.
 *
 * Terminal phases are kept until dismissed rather than cleared automatically:
 * a `minted` badge the user never saw is the same as no mint at all.
 */
export function clearBridge(key: string): void {
    if (bridges.delete(key)) emit()
}

/**
 * The key of a bridge still working, or null if none is.
 *
 * Non-reactive on purpose: this seeds `useState` in a component that remounts
 * on every open, where a subscription would be both unnecessary and a
 * render-order hazard. Terminal phases are skipped — a finished bridge belongs
 * to the persistent list, not to a freshly opened form.
 */
export function getActiveBridgeKey(): string | null {
    for (const entry of bridges.values()) {
        if (entry.phase !== 'minted' && entry.phase !== 'failed') return entry.key
    }
    return null
}

/**
 * Every bridge currently being tracked, oldest first.
 *
 * Returns an array rather than the map so React can compare it by identity,
 * and so a component can render several in-flight bridges without knowing
 * their keys in advance.
 */
export function useBridges(): BridgeState[] {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** The single bridge a modal cares about, or null. Re-renders on change. */
export function useBridge(key: string | null): BridgeState | null {
    const all = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
    if (key === null) return null
    return all.find((entry) => entry.key === key) ?? null
}

/** Human-readable label for each phase, for the progress timeline. */
export const BRIDGE_PHASE_LABELS: Record<BridgePhase, string> = {
    idle: 'Ready',
    locking: 'Locking Stars on Sepolia',
    'waiting-attestation': 'Waiting for attestation',
    proving: 'Worker is proving the lock',
    submitting: 'Submitting to the ASC',
    minted: 'Stars minted on Creditcoin',
    failed: 'Bridge unavailable',
}

/** Stages shown on the timeline, in order. `idle` and `failed` are not steps. */
export const BRIDGE_TIMELINE: Exclude<BridgePhase, 'idle' | 'failed'>[] = [
    'locking',
    'waiting-attestation',
    'proving',
    'submitting',
    'minted',
]
