'use client'

import { toast } from 'sonner'
import {
    createPublicClient,
    createWalletClient,
    custom,
    http,
    isAddress,
    parseAbi,
    parseUnits,
    type EIP1193Provider,
    type Hash,
} from 'viem'
import { getAccount, getConnections } from 'wagmi/actions'
import { config } from '@/lib/wagmi'
import { creditcoinTestnet, sepolia } from '@/lib/chains'
import {
    ASC_ADDRESS,
    DASHBOARD_URL,
    SEPOLIA_RPC_URL,
    SEPOLIA_STARS_ADDRESS,
    SOURCE_ADDRESS,
    STARS_DECIMALS,
} from '@/lib/contracts'
import { getTxErrorMessage } from '@/services/errors'
import { refreshWalletBalances } from '@/services/balances'
import {
    bridgeKey,
    getBridge,
    getBridgeFailureKind,
    makeBridgeNonce,
    recordBridgePoll,
    setBridgePhase,
} from '@/services/bridge-store'
import {
    buildSepoliaAddChainParams,
    canAdvanceWorkerStage,
    isUnknownChainError,
    isUserRejectionError,
    pollBridgeExecuted,
    releaseBridgeWatcher,
    toChainIdHex,
    tryAcquireBridgeWatcher,
    SEPOLIA_CHAIN_ID_HEX,
} from './bridge-logic'

const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')

const SEPOLIA_STARS_ABI = parseAbi([
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
])

const SOURCE_ABI = parseAbi([
    'function lock(uint256 amount, uint256 nonce, address creditcoinRecipient)',
    'function stars() view returns (address)',
])

/** Poll cadence for the ASC watch. Attestation takes ~8-10 minutes, so
 *  polling faster only burns explorer quota. */
const BRIDGE_POLL_INTERVAL_MS = 30000

/** Give the worker two hours before the watch reports failure. The lock stays
 *  provable on Sepolia afterwards — only this process's patience is spent. */
const BRIDGE_WATCH_TIMEOUT_MS = 2 * 60 * 60 * 1000

function sepoliaPublicClient() {
    return createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) })
}

/**
 * EIP-1193 provider for the currently connected wallet, whatever connector
 * owns it (injected, WalletConnect, ...). Never touches `window.ethereum`
 * directly, so non-injected connectors keep working.
 */
async function getBridgeProvider(): Promise<EIP1193Provider | null> {
    try {
        const connector = getConnections(config)[0]?.connector
        if (!connector) return null
        const provider = (await connector.getProvider()) as EIP1193Provider | undefined
        return provider ?? null
    } catch {
        return null
    }
}

/**
 * Switch the connected wallet to Sepolia, adding the chain first when the
 * wallet reports 4902 (chain not added). A 4001 user rejection propagates
 * so the caller can surface it as a rejection, not a dead end.
 */
async function ensureSepoliaChain(provider: EIP1193Provider): Promise<void> {
    try {
        await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
        })
    } catch (error) {
        if (!isUnknownChainError(error)) throw error
        await provider.request({
            method: 'wallet_addEthereumChain',
            params: [buildSepoliaAddChainParams(SEPOLIA_RPC_URL)],
        })
        await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
        })
    }
}

/**
 * Switch the wallet back to Creditcoin Testnet after the lock, so play
 * resumes on the game chain. Best-effort: a rejection here must not fail an
 * already-mined lock — the caller toasts and moves on.
 */
async function switchBackToCreditcoin(provider: EIP1193Provider): Promise<void> {
    const chainId = toChainIdHex(creditcoinTestnet.id)
    try {
        await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId }],
        })
    } catch (error) {
        if (!isUnknownChainError(error)) throw error
        await provider.request({
            method: 'wallet_addEthereumChain',
            params: [
                {
                    chainId,
                    chainName: creditcoinTestnet.name,
                    nativeCurrency: creditcoinTestnet.nativeCurrency,
                    rpcUrls: [...creditcoinTestnet.rpcUrls.default.http],
                    blockExplorerUrls: [creditcoinTestnet.blockExplorers.default.url],
                },
            ],
        })
        await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId }],
        })
    }
}

/**
 * Sepolia Stars token the source locks.
 *
 * `deploy-sepolia-source.ts` prints only the source address, so the token is
 * derived from `PixelOrbitSource.stars()` unless the deployer set
 * `NEXT_PUBLIC_SEPOLIA_STARS_ADDRESS` explicitly.
 */
export async function resolveSepoliaStars(): Promise<`0x${string}` | null> {
    if (SEPOLIA_STARS_ADDRESS !== '') return SEPOLIA_STARS_ADDRESS
    if (SOURCE_ADDRESS === '0x') return null
    try {
        const address = await sepoliaPublicClient().readContract({
            address: SOURCE_ADDRESS,
            abi: SOURCE_ABI,
            functionName: 'stars',
        })
        return address
    } catch {
        return null
    }
}

export interface LockStarsResult {
    key: string
    sepoliaTxHash: Hash
}

/**
 * Approve Sepolia Stars and lock them for a Creditcoin recipient.
 *
 * Runs on Sepolia through the injected wallet, which prompts a network switch
 * away from Creditcoin — bridging is the one flow that leaves the game chain.
 * Returns the bridge key immediately; the ASC watch runs in the background and
 * the modal may be closed without losing it.
 */
export async function lockStars(
    amountStr: string,
    recipientStr: string,
): Promise<LockStarsResult | null> {
    if (SOURCE_ADDRESS === '0x') {
        toast.error('Bridge is not configured on this deployment (no source address)')
        return null
    }

    let amount: bigint
    try {
        amount = parseUnits(amountStr, STARS_DECIMALS)
    } catch {
        toast.error('Invalid Stars amount')
        return null
    }
    if (amount <= BigInt(0)) {
        toast.error('Amount must be greater than zero')
        return null
    }

    if (!isAddress(recipientStr)) {
        toast.error('Recipient must be a valid address')
        return null
    }
    const recipient = recipientStr as `0x${string}`

    // Connector path, not `window.ethereum`: the address comes from wagmi so
    // WalletConnect sessions work, and the provider below comes from the
    // active connector for the same reason.
    const player = getAccount(config).address
    if (!player) {
        toast.error('Connect your wallet to bridge Stars')
        return null
    }

    const provider = await getBridgeProvider()
    if (!provider) {
        toast.error(
            'Bridging needs an injected wallet — switch to an injected wallet or MetaMask to lock Stars',
        )
        return null
    }
    const wallet = createWalletClient({ chain: sepolia, transport: custom(provider) })

    const nonce = makeBridgeNonce()
    const key = bridgeKey(player, nonce)
    setBridgePhase(key, 'locking', {
        player,
        nonce,
        amount,
        recipient,
        createdAt: Date.now(),
    })

    const failLock = (error: string) => {
        setBridgePhase(key, 'failed', { error, errorKind: 'lock' })
    }

    try {
        try {
            await ensureSepoliaChain(provider)
        } catch (error: unknown) {
            if (isUserRejectionError(error)) {
                toast.error('Sepolia network switch was rejected — approve the switch to bridge', { id: key })
            } else {
                toast.error(`Sepolia network switch failed: ${getTxErrorMessage(error)}`, { id: key })
            }
            failLock('Sepolia network switch rejected')
            return null
        }

        const stars = await resolveSepoliaStars()
        if (!stars) {
            toast.error('Sepolia Stars token is unreachable', { id: key })
            failLock('Sepolia Stars token is unreachable')
            return null
        }

        const publicClient = sepoliaPublicClient()
        const balance = await publicClient.readContract({
            address: stars,
            abi: SEPOLIA_STARS_ABI,
            functionName: 'balanceOf',
            args: [player],
        })
        if (balance < amount) {
            toast.error('Insufficient Sepolia Stars balance', { id: key })
            failLock('Insufficient Sepolia Stars balance')
            return null
        }

        const allowance = await publicClient.readContract({
            address: stars,
            abi: SEPOLIA_STARS_ABI,
            functionName: 'allowance',
            args: [player, SOURCE_ADDRESS],
        })
        if (allowance < amount) {
            toast.loading('Approving Stars on Sepolia...', { id: key })
            const approveHash = await wallet.writeContract({
                address: stars,
                abi: SEPOLIA_STARS_ABI,
                functionName: 'approve',
                args: [SOURCE_ADDRESS, MAX_UINT256],
                chain: sepolia,
                account: player,
            })
            await publicClient.waitForTransactionReceipt({ hash: approveHash })
        }

        toast.loading('Locking Stars on Sepolia...', { id: key })
        const lockHash = await wallet.writeContract({
            address: SOURCE_ADDRESS,
            abi: SOURCE_ABI,
            functionName: 'lock',
            args: [amount, nonce, recipient],
            chain: sepolia,
            account: player,
        })
        await publicClient.waitForTransactionReceipt({ hash: lockHash })

        // The lock moved Sepolia Stars: refresh balances fire-and-forget.
        void refreshWalletBalances({ awaitChange: true })

        toast.success('Stars locked — waiting for attestation', { id: key })
        setBridgePhase(key, 'waiting-attestation', { sepoliaTxHash: lockHash })
        void watchBridgeCompletion(key)
        // The modal promises the wallet comes back to Creditcoin for play.
        // Best-effort: a rejection here leaves the lock intact, just on the
        // wrong chain for playing.
        try {
            await switchBackToCreditcoin(provider)
        } catch {
            toast.info('Stars locked — switch back to Creditcoin Testnet to keep playing')
        }
        return { key, sepoliaTxHash: lockHash }
    } catch (error: unknown) {
        const message = getTxErrorMessage(error)
        toast.error(message, { id: key })
        failLock(message)
        return null
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Worker-status polling hook point.
 *
 * The offchain worker (`worker/attestcoin-bridge`) owns the proving flow; the
 * frontend cannot observe its stages from chain state alone. When a worker
 * status endpoint exists, poll it and forward `proving` / `submitting` here —
 * the timeline renders both stages, and the ASC watch below only ever sets
 * `minted` or `failed`.
 */
export function reportWorkerStage(
    key: string,
    stage: 'proving' | 'submitting',
    extra?: { ascTxHash?: Hash },
): void {
    const current = getBridge(key)
    if (!current) return
    if (current.phase === 'minted' || current.phase === 'failed') return
    // A stale worker poll must never rewind the timeline (e.g. a late
    // `proving` arriving after `submitting`).
    if (!canAdvanceWorkerStage(current.phase, stage)) return
    setBridgePhase(key, stage, extra)
}

/**
 * Watch for `BridgeExecuted(player, recipient)` carrying this lock's nonce,
 * then mark the bridge minted.
 *
 * Fires in the background after `lockStars` returns. The user is free to close
 * the modal — state is held in the bridge store and survives unmounting.
 * On timeout the phase goes to `failed` with a message that says what is
 * still true: the Sepolia lock remains provable and the watch can be retried.
 */
export async function watchBridgeCompletion(key: string): Promise<void> {
    // Single writer: a retry racing a live loop must not start a second poller.
    if (!tryAcquireBridgeWatcher(key)) return
    try {
        const tracked = getBridge(key)
        if (!tracked || tracked.phase === 'minted' || tracked.phase === 'failed') return
        if (ASC_ADDRESS === '0x') {
            setBridgePhase(key, 'failed', {
                error: 'Bridge is not configured (no ASC address)',
                errorKind: 'watch',
            })
            return
        }

        const deadline = Date.now() + BRIDGE_WATCH_TIMEOUT_MS
        while (Date.now() < deadline) {
            const found = await pollBridgeExecuted(tracked.player, tracked.recipient, tracked.nonce, {
                ascAddress: ASC_ADDRESS,
            })
            recordBridgePoll(key)
            if (found) {
                setBridgePhase(key, 'minted', { ascTxHash: found })
                // The mint moved Stars on both chains: refresh balances fire-and-forget.
                void refreshWalletBalances({ awaitChange: true })
                toast.success('Stars minted on Creditcoin')
                return
            }
            // A retry may have failed the bridge while this loop slept.
            const latest = getBridge(key)
            if (!latest || latest.phase === 'minted' || latest.phase === 'failed') return
            await sleep(BRIDGE_POLL_INTERVAL_MS)
        }

        setBridgePhase(key, 'failed', {
            error:
                'Bridge not detected within the watch window — the Sepolia lock stays provable, retry the watch later',
            errorKind: 'watch',
        })
    } finally {
        releaseBridgeWatcher(key)
    }
}

/**
 * One-shot manual ASC check for an in-flight bridge. Safe to run alongside
 * the background watch: it only ever writes `minted` on a real log match
 * (which the loop treats as terminal and exits on), and records the same
 * poll heartbeat. Returns true when the mint was found.
 */
export async function checkBridgeNow(key: string): Promise<boolean> {
    const tracked = getBridge(key)
    if (!tracked || tracked.phase === 'minted' || tracked.phase === 'failed') return false
    if (ASC_ADDRESS === '0x') return false
    const found = await pollBridgeExecuted(tracked.player, tracked.recipient, tracked.nonce, {
        ascAddress: ASC_ADDRESS,
    })
    recordBridgePoll(key)
    if (!found) return false
    setBridgePhase(key, 'minted', { ascTxHash: found })
    void refreshWalletBalances({ awaitChange: true })
    toast.success('Stars minted on Creditcoin')
    return true
}

/**
 * Manual retry for a watch that timed out. Lock-phase failures are rejected
 * here on purpose: they never left Sepolia and need a fresh `lockStars`
 * (new nonce), not a re-poll of the same key.
 */
export async function retryBridgeWatch(key: string): Promise<void> {
    const tracked = getBridge(key)
    if (!tracked || tracked.phase !== 'failed') return
    if (getBridgeFailureKind(tracked) !== 'watch') return
    setBridgePhase(key, 'waiting-attestation', {
        error: undefined,
        errorKind: undefined,
        ascTxHash: undefined,
    })
    await watchBridgeCompletion(key)
}

/** Sepolia explorer link for a lock transaction. */
export function sepoliaTxUrl(hash: Hash): string {
    return `https://sepolia.etherscan.io/tx/${hash}`
}

/** Blockscout link for the ASC transaction that minted the Stars. */
export function ascTxUrl(hash: Hash): string {
    return `https://creditcoin-testnet.blockscout.com/tx/${hash}`
}

/** Creditcoin dashboard for tracking the bridge transaction. */
export function dashboardUrl(): string {
    return DASHBOARD_URL
}
