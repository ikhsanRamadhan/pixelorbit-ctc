'use client'

import { toast } from 'sonner'
import {
    createPublicClient,
    createWalletClient,
    custom,
    decodeEventLog,
    formatEther,
    http,
    parseAbi,
    toEventSelector,
    type EIP1193Provider,
    type Hash,
} from 'viem'
import { getAccount, getConnections } from 'wagmi/actions'
import { config } from '@/lib/wagmi'
import { creditcoinTestnet, sepolia } from '@/lib/chains'
import {
    CC_SALE_ADDRESS,
    SALE_ADDRESS,
    SEPOLIA_RPC_URL,
    SEPOLIA_STARS_ADDRESS,
    SOURCE_ADDRESS,
    STARS_ADDRESS,
    STARS_DECIMALS,
} from '@/lib/contracts'
import { getTxErrorMessage } from '@/services/errors'
import { refreshWalletBalances } from '@/services/balances'
import { ensureAllowance } from '@/services/wallet'
import {
    addressToTopic,
    buildSepoliaAddChainParams,
    CREDITCOIN_EXPLORER_API,
    isUnknownChainError,
    isUserRejectionError,
    toChainIdHex,
    SEPOLIA_CHAIN_ID_HEX,
} from './bridge-logic'
import {
    SEPOLIA_SALE_MAX_PER_TX,
    maxSellableStars,
    parseStarAmount,
    parseWholeStars,
    totalSaleCost,
} from './sale-logic'

const SEPOLIA_SALE_ABI = parseAbi([
    'function pricePerStar() view returns (uint256)',
    'function buy(uint256 starAmount) payable',
])

const CC3_SALE_ABI = parseAbi([
    'function pricePerStar() view returns (uint256)',
    'function sellPricePerStar() view returns (uint256)',
    'function consigned(address account) view returns (uint256)',
    'function escrowedStars() view returns (uint256)',
    'function proceeds(address account) view returns (uint256)',
    'function totalProceedsOwed() view returns (uint256)',
    'function lots(uint256 index) view returns (address seller, uint256 remaining)',
    'function buy(uint256 starAmount) payable',
    'function sellStars(uint256 starAmount)',
    'function depositStars(uint256 starAmount) returns (uint256)',
    'function cancelConsignment(uint256 lotId)',
    'function withdrawProceeds()',
])

const CC3_STARS_BALANCE_ABI = parseAbi([
    'function balanceOf(address account) view returns (uint256)',
])

const SEPOLIA_SOURCE_ABI = parseAbi([
    'function stars() view returns (address)',
])

/** Whole Stars (1 = 1e18 token units) to Stars token units. */
function wholeStarsToUnits(starAmount: bigint): bigint {
    return starAmount * BigInt(10) ** BigInt(STARS_DECIMALS)
}

function sepoliaPublicClient() {
    return createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) })
}

function cc3PublicClient() {
    return createPublicClient({
        chain: creditcoinTestnet,
        transport: http(creditcoinTestnet.rpcUrls.default.http[0]),
    })
}

/**
 * EIP-1193 provider for the currently connected wallet, whatever connector
 * owns it. Same connector path as the bridge — never `window.ethereum`
 * directly, so WalletConnect sessions keep working.
 */
async function getSaleProvider(): Promise<EIP1193Provider | null> {
    try {
        const connector = getConnections(config)[0]?.connector
        if (!connector) return null
        const provider = (await connector.getProvider()) as EIP1193Provider | undefined
        return provider ?? null
    } catch {
        return null
    }
}

interface AddChainParams {
    chainId: string
    chainName: string
    nativeCurrency: { name: string; symbol: string; decimals: number }
    rpcUrls: string[]
    blockExplorerUrls: string[]
}

function cc3AddChainParams(): AddChainParams {
    const chainId = toChainIdHex(creditcoinTestnet.id)
    return {
        chainId,
        chainName: creditcoinTestnet.name,
        nativeCurrency: { ...creditcoinTestnet.nativeCurrency },
        rpcUrls: [...creditcoinTestnet.rpcUrls.default.http],
        blockExplorerUrls: [creditcoinTestnet.blockExplorers.default.url],
    }
}

/**
 * Switch the connected wallet to the sale's chain, adding the chain first
 * when the wallet reports 4902. A 4001 user rejection propagates so the
 * caller surfaces it as a rejection, not a dead end.
 */
async function ensureWalletChain(
    provider: EIP1193Provider,
    chainIdHex: string,
    addParams: AddChainParams,
): Promise<void> {
    try {
        await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: chainIdHex }],
        })
    } catch (error) {
        if (!isUnknownChainError(error)) throw error
        await provider.request({
            method: 'wallet_addEthereumChain',
            params: [addParams],
        })
        await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: chainIdHex }],
        })
    }
}

/** Onchain nominal price per whole Star on the Sepolia door. Null when the sale is unconfigured or unreachable. */
export async function fetchSepoliaSalePrice(): Promise<bigint | null> {
    if (SALE_ADDRESS === '0x') return null
    try {
        return await sepoliaPublicClient().readContract({
            address: SALE_ADDRESS,
            abi: SEPOLIA_SALE_ABI,
            functionName: 'pricePerStar',
        })
    } catch {
        return null
    }
}

/**
 * Sepolia Stars token the sale draws its shelf from.
 *
 * Mirrors `resolveSepoliaStars` in the bridge service without importing it:
 * the deploy script prints only the source address, so the token is derived
 * from `PixelOrbitSource.stars()` unless the deployer set
 * `NEXT_PUBLIC_SEPOLIA_STARS_ADDRESS` explicitly.
 */
async function resolveSaleSepoliaStars(): Promise<`0x${string}` | null> {
    if (SEPOLIA_STARS_ADDRESS !== '') return SEPOLIA_STARS_ADDRESS
    if (SOURCE_ADDRESS === '0x') return null
    try {
        return await sepoliaPublicClient().readContract({
            address: SOURCE_ADDRESS,
            abi: SEPOLIA_SOURCE_ABI,
            functionName: 'stars',
        })
    } catch {
        return null
    }
}

/**
 * Buyable Stars shelf on the Sepolia door, in token units. Null when the
 * sale or the Stars token is unconfigured, or when the read fails.
 */
export async function fetchSepoliaStock(): Promise<bigint | null> {
    if (SALE_ADDRESS === '0x') return null
    try {
        const stars = await resolveSaleSepoliaStars()
        if (!stars) return null
        return await sepoliaPublicClient().readContract({
            address: stars,
            abi: CC3_STARS_BALANCE_ABI,
            functionName: 'balanceOf',
            args: [SALE_ADDRESS],
        })
    } catch {
        return null
    }
}

/**
 * Native-currency pool funding the Sepolia door (accumulated ETH proceeds).
 * Display-only: buys require exact payment, so the pool never funds payouts.
 * Null when the sale is unconfigured or unreachable.
 */
export async function fetchSepoliaEthPool(): Promise<bigint | null> {
    if (SALE_ADDRESS === '0x') return null
    try {
        return await sepoliaPublicClient().getBalance({ address: SALE_ADDRESS })
    } catch {
        return null
    }
}

/**
 * Native-currency pool funding CC3 sell-backs (accumulated tCTC proceeds).
 * Display-only: `sellCC3Stars` still re-checks it before sending. Null when
 * the sale is unconfigured or unreachable.
 */
export async function fetchCC3Pool(): Promise<bigint | null> {
    if (CC_SALE_ADDRESS === '0x') return null
    try {
        return await cc3PublicClient().getBalance({ address: CC_SALE_ADDRESS })
    } catch {
        return null
    }
}

/** Onchain nominal price per whole Star on the CC3 door. Null when the sale is unconfigured or unreachable. */
export async function fetchCC3SalePrice(): Promise<bigint | null> {
    if (CC_SALE_ADDRESS === '0x') return null
    try {
        return await cc3PublicClient().readContract({
            address: CC_SALE_ADDRESS,
            abi: CC3_SALE_ABI,
            functionName: 'pricePerStar',
        })
    } catch {
        return null
    }
}

/**
 * Buy whole Stars on the Sepolia door with exact ETH payment.
 *
 * Runs on Sepolia through the connected wallet, which prompts a network
 * switch away from Creditcoin — same pattern as the bridge lock. Returns
 * true only when the purchase receipt lands.
 */
export async function buySepoliaStars(amountStr: string): Promise<boolean> {
    if (SALE_ADDRESS === '0x') {
        toast.error('Stars sale is not configured on this deployment (no sale address)')
        return false
    }
    const parsed = parseStarAmount(amountStr, SEPOLIA_SALE_MAX_PER_TX)
    if ('error' in parsed) {
        toast.error(parsed.error)
        return false
    }

    const player = getAccount(config).address
    if (!player) {
        toast.error('Connect your wallet to buy Stars')
        return false
    }

    const provider = await getSaleProvider()
    if (!provider) {
        toast.error(
            'Buying needs an injected wallet — switch to an injected wallet or MetaMask to buy Stars',
        )
        return false
    }
    const wallet = createWalletClient({ chain: sepolia, transport: custom(provider) })
    const toastId = `sale-sepolia-${Date.now()}`

    try {
        try {
            await ensureWalletChain(
                provider,
                SEPOLIA_CHAIN_ID_HEX,
                buildSepoliaAddChainParams(SEPOLIA_RPC_URL),
            )
        } catch (error: unknown) {
            if (isUserRejectionError(error)) {
                toast.error('Sepolia network switch was rejected — approve the switch to buy', { id: toastId })
            } else {
                toast.error(`Sepolia network switch failed: ${getTxErrorMessage(error)}`, { id: toastId })
            }
            return false
        }

        const price = await fetchSepoliaSalePrice()
        if (price === null) {
            toast.error('Sale price is unreachable — the sale may be undeployed or the RPC down', { id: toastId })
            return false
        }

        toast.loading('Buying Stars on Sepolia...', { id: toastId })
        const hash = await wallet.writeContract({
            address: SALE_ADDRESS,
            abi: SEPOLIA_SALE_ABI,
            functionName: 'buy',
            args: [parsed.amount],
            value: totalSaleCost(parsed.amount, price),
            chain: sepolia,
            account: player,
        })
        await sepoliaPublicClient().waitForTransactionReceipt({ hash })

        // The purchase moved ETH and minted Sepolia Stars: refresh balances
        // fire-and-forget, with change detection for slow nodes.
        void refreshWalletBalances({ awaitChange: true })

        toast.success(`Bought ${parsed.amount.toString()} Stars on Sepolia`, { id: toastId })
        // The modal promises the wallet comes back to Creditcoin for play.
        // Best-effort: a rejection here leaves the purchase intact, just on
        // the wrong chain for playing.
        try {
            await ensureWalletChain(provider, toChainIdHex(creditcoinTestnet.id), cc3AddChainParams())
        } catch {
            toast.info('Stars bought — switch back to Creditcoin Testnet to keep playing')
        }
        return true
    } catch (error: unknown) {
        toast.error(getTxErrorMessage(error), { id: toastId })
        return false
    }
}

/**
 * Buy whole Stars on the Creditcoin door with exact tCTC payment.
 *
 * Runs on the game chain, so no switch-away is needed — but the wallet may
 * currently sit on Sepolia (after a bridge lock), in which case it is asked
 * to switch back first. Buys are uncapped per address: shelf stock plus
 * consignment lots bound the fill, and the transfer reverts when they
 * cannot cover the amount.
 */
export async function buyCC3Stars(amountStr: string): Promise<boolean> {
    if (CC_SALE_ADDRESS === '0x') {
        toast.error('Stars sale is not configured on this deployment (no CC sale address)')
        return false
    }
    const parsed = parseWholeStars(amountStr)
    if ('error' in parsed) {
        toast.error(parsed.error)
        return false
    }

    const player = getAccount(config).address
    if (!player) {
        toast.error('Connect your wallet to buy Stars')
        return false
    }

    const provider = await getSaleProvider()
    if (!provider) {
        toast.error(
            'Buying needs an injected wallet — switch to an injected wallet or MetaMask to buy Stars',
        )
        return false
    }
    const wallet = createWalletClient({ chain: creditcoinTestnet, transport: custom(provider) })
    const toastId = `sale-cc3-${Date.now()}`

    try {
        try {
            await ensureWalletChain(provider, toChainIdHex(creditcoinTestnet.id), cc3AddChainParams())
        } catch (error: unknown) {
            if (isUserRejectionError(error)) {
                toast.error('Creditcoin network switch was rejected — approve the switch to buy', { id: toastId })
            } else {
                toast.error(`Creditcoin network switch failed: ${getTxErrorMessage(error)}`, { id: toastId })
            }
            return false
        }

        const price = await fetchCC3SalePrice()
        if (price === null) {
            toast.error('Sale price is unreachable — the sale may be undeployed or the RPC down', { id: toastId })
            return false
        }

        toast.loading('Buying Stars on Creditcoin...', { id: toastId })
        const hash = await wallet.writeContract({
            address: CC_SALE_ADDRESS,
            abi: CC3_SALE_ABI,
            functionName: 'buy',
            args: [parsed.amount],
            value: totalSaleCost(parsed.amount, price),
            chain: creditcoinTestnet,
            account: player,
        })
        await cc3PublicClient().waitForTransactionReceipt({ hash })

        // The purchase moved tCTC and minted CC3 Stars: refresh balances fire-and-forget.
        void refreshWalletBalances({ awaitChange: true })

        toast.success(`Bought ${parsed.amount.toString()} Stars on Creditcoin`, { id: toastId })
        return true
    } catch (error: unknown) {
        toast.error(getTxErrorMessage(error), { id: toastId })
        return false
    }
}

/** Onchain nominal sell-back price per whole Star on the CC3 door. Null when unconfigured or unreachable. */
export async function fetchCC3SellPrice(): Promise<bigint | null> {
    if (CC_SALE_ADDRESS === '0x') return null
    try {
        return await cc3PublicClient().readContract({
            address: CC_SALE_ADDRESS,
            abi: CC3_SALE_ABI,
            functionName: 'sellPricePerStar',
        })
    } catch {
        return null
    }
}

/** Whole Stars the player currently holds in consignment escrow. Null when unconfigured or unreachable. */
export async function fetchCC3Consigned(player: `0x${string}`): Promise<bigint | null> {
    if (CC_SALE_ADDRESS === '0x') return null
    try {
        return await cc3PublicClient().readContract({
            address: CC_SALE_ADDRESS,
            abi: CC3_SALE_ABI,
            functionName: 'consigned',
            args: [player],
        })
    } catch {
        return null
    }
}

/** tCTC wei the player has earned from filled consignments. Null when unconfigured or unreachable. */
export async function fetchCC3Proceeds(player: `0x${string}`): Promise<bigint | null> {
    if (CC_SALE_ADDRESS === '0x') return null
    try {
        return await cc3PublicClient().readContract({
            address: CC_SALE_ADDRESS,
            abi: CC3_SALE_ABI,
            functionName: 'proceeds',
            args: [player],
        })
    } catch {
        return null
    }
}

/** Total tCTC wei owed to consignors (reserved, never sellable). Null when unconfigured or unreachable. */
export async function fetchCC3ProceedsOwed(): Promise<bigint | null> {
    if (CC_SALE_ADDRESS === '0x') return null
    try {
        return await cc3PublicClient().readContract({
            address: CC_SALE_ADDRESS,
            abi: CC3_SALE_ABI,
            functionName: 'totalProceedsOwed',
        })
    } catch {
        return null
    }
}

export interface CC3ShelfStock {
    /** All Stars sitting in the sale (treasury shelf + escrow), in token units. */
    total: bigint
    /** Consigned Stars locked in FIFO lots, in token units. */
    escrowed: bigint
    /** Freely buyable/rescuable treasury shelf, in token units. Never negative. */
    treasury: bigint
}

/** keccak256("StarsDeposited(address,uint256,uint256)") */
export const STARS_DEPOSITED_TOPIC = toEventSelector(
    'StarsDeposited(address,uint256,uint256)',
)

const STARS_DEPOSITED_ABI = parseAbi([
    'event StarsDeposited(address indexed depositor, uint256 starAmount, uint256 lotId)',
])

/** One consignment lot with its live unfilled balance, in whole Stars. */
export interface CC3Lot {
    lotId: bigint
    remaining: bigint
}

interface SaleExplorerLog {
    topics: (string | null)[]
    data?: string
}

/**
 * Pure matcher over one Blockscout `getLogs` page: lot ids deposited by
 * `depositor`, oldest first, deduplicated. A deposit emits exactly one
 * `StarsDeposited`, so one log is one lot; the explorer may still repeat a
 * log across pages, hence the dedupe. Never throws: a non-matching log is
 * skipped, never fatal.
 */
export function findDepositorLotIds(
    logs: SaleExplorerLog[] | undefined,
    depositor: string,
): bigint[] {
    if (!Array.isArray(logs)) return []
    const want = depositor.toLowerCase()
    const seen = new Set<string>()
    const out: bigint[] = []
    for (const log of logs) {
        try {
            const decoded = decodeEventLog({
                abi: STARS_DEPOSITED_ABI,
                data: (log.data ?? '0x') as Hash,
                topics: (log.topics ?? []) as [signature: Hash, ...args: Hash[]],
            })
            if (decoded.eventName !== 'StarsDeposited') continue
            const args = decoded.args as unknown as { depositor: string; lotId: bigint }
            if (args.depositor.toLowerCase() !== want) continue
            const key = args.lotId.toString()
            if (seen.has(key)) continue
            seen.add(key)
            out.push(args.lotId)
        } catch {
            // Not our event; the ABI mismatch is the signal, not a fault.
        }
    }
    return out
}

export interface FetchMyLotsDeps {
    fetchImpl?: typeof fetch
    apiBase?: string
    /**
     * Explorer request timeout per call. A hung request must never freeze
     * the panel: it fails like any other miss and the caller falls back to
     * manual lot-id entry.
     */
    timeoutMs?: number
    /** Injectable `lots(lotId)` read so unit tests stay off the live RPC. */
    readLot?: (lotId: bigint) => Promise<{ seller: `0x${string}`; remaining: bigint }>
    /** Injectable sale address so unit tests bypass the env-gated constant. */
    saleAddress?: `0x${string}`
}

/** Default per-call explorer timeout, comfortably under panel patience. */
export const SALE_LOGS_FETCH_TIMEOUT_MS = 20000

/**
 * Open consignment lots for `player`: lot ids from the `StarsDeposited`
 * explorer logs, each resolved to its live unfilled balance. Only lots with
 * `remaining > 0` are returned — filled or cancelled lots need no action.
 *
 * Null when the sale is unconfigured, the explorer is unreachable, or the
 * lot reads fail: the panel then falls back to manual lot-id entry instead
 * of blocking the cancel flow.
 */
export async function fetchMyCC3Lots(
    player: `0x${string}`,
    deps: FetchMyLotsDeps = {},
): Promise<CC3Lot[] | null> {
    const sale = deps.saleAddress ?? CC_SALE_ADDRESS
    if (sale === '0x') return null
    const apiBase = deps.apiBase ?? CREDITCOIN_EXPLORER_API
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch
    const timeoutMs = deps.timeoutMs ?? SALE_LOGS_FETCH_TIMEOUT_MS
    const readLot =
        deps.readLot ??
        (async (lotId: bigint) => {
            const [seller, remaining] = (await cc3PublicClient().readContract({
                address: sale,
                abi: CC3_SALE_ABI,
                functionName: 'lots',
                args: [lotId],
            })) as unknown as [`0x${string}`, bigint]
            return { seller, remaining }
        })
    const url =
        `${apiBase}?module=logs&action=getLogs` +
        `&address=${sale}` +
        `&fromBlock=0&toBlock=latest` +
        `&topic0=${STARS_DEPOSITED_TOPIC}` +
        `&topic1=${addressToTopic(player)}` +
        `&topic0_1_opr=and`

    let lotIds: bigint[]
    try {
        const response = await fetchImpl(url, {
            cache: 'no-store',
            signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) return null
        const payload = (await response.json()) as { result?: SaleExplorerLog[] | string }
        if (!Array.isArray(payload.result)) return null
        lotIds = findDepositorLotIds(payload.result, player)
    } catch {
        // A dropped explorer request is not a missing lot list. Fall back
        // to manual entry.
        return null
    }
    if (lotIds.length === 0) return []

    try {
        const lots = await Promise.all(
            lotIds.map(async (lotId) => ({ lotId, ...(await readLot(lotId)) })),
        )
        return lots
            .filter((lot) => lot.remaining > BigInt(0))
            .map(({ lotId, remaining }) => ({ lotId, remaining }))
    } catch {
        return null
    }
}

/**
 * Buy-side stock on the CC3 door: the sale's live Stars balance split into
 * consignor escrow (`escrowedStars`) and the free treasury shelf. Null when
 * the sale or the Stars token is unconfigured, or when either read fails.
 */
export async function fetchCC3Stock(): Promise<CC3ShelfStock | null> {
    if (CC_SALE_ADDRESS === '0x' || STARS_ADDRESS === '0x') return null
    try {
        const client = cc3PublicClient()
        const [total, escrowedWhole] = await Promise.all([
            client.readContract({
                address: STARS_ADDRESS,
                abi: CC3_STARS_BALANCE_ABI,
                functionName: 'balanceOf',
                args: [CC_SALE_ADDRESS],
            }),
            client.readContract({
                address: CC_SALE_ADDRESS,
                abi: CC3_SALE_ABI,
                functionName: 'escrowedStars',
            }),
        ])
        const escrowed = escrowedWhole * BigInt(10) ** BigInt(STARS_DECIMALS)
        return { total, escrowed, treasury: total >= escrowed ? total - escrowed : BigInt(0) }
    } catch {
        return null
    }
}

interface CC3WriteContext {
    provider: EIP1193Provider
    wallet: ReturnType<typeof createWalletClient>
    player: `0x${string}`
}

/**
 * Shared setup for CC3-door writes: configured sale, connected wallet,
 * injected provider, and a switch back to Creditcoin when the wallet sits
 * elsewhere (e.g. Sepolia after a bridge lock). Null after toasting the
 * reason, so callers return false directly.
 */
async function prepareCC3Write(toastId: string): Promise<CC3WriteContext | null> {
    if (CC_SALE_ADDRESS === '0x') {
        toast.error('Stars sale is not configured on this deployment (no CC sale address)')
        return null
    }
    const player = getAccount(config).address
    if (!player) {
        toast.error('Connect your wallet first')
        return null
    }
    const provider = await getSaleProvider()
    if (!provider) {
        toast.error(
            'This needs an injected wallet — switch to an injected wallet or MetaMask to continue',
        )
        return null
    }
    try {
        await ensureWalletChain(provider, toChainIdHex(creditcoinTestnet.id), cc3AddChainParams())
    } catch (error: unknown) {
        if (isUserRejectionError(error)) {
            toast.error('Creditcoin network switch was rejected — approve the switch to continue', {
                id: toastId,
            })
        } else {
            toast.error(`Creditcoin network switch failed: ${getTxErrorMessage(error)}`, { id: toastId })
        }
        return null
    }
    return { provider, wallet: createWalletClient({ chain: creditcoinTestnet, transport: custom(provider) }), player }
}

/**
 * Pull a Stars approval for the CC3 sale when the current allowance is short.
 * Returns false after toasting, so callers return false directly.
 */
async function ensureSaleStarsApproval(units: bigint, toastId: string): Promise<boolean> {
    if (STARS_ADDRESS === '0x') {
        toast.error('Stars token is not configured on this deployment', { id: toastId })
        return false
    }
    toast.loading('Checking Stars allowance...', { id: toastId })
    const approved = await ensureAllowance(CC_SALE_ADDRESS, units)
    if (!approved) {
        toast.error('Stars approval failed', { id: toastId })
        return false
    }
    return true
}

/**
 * Sell whole Stars back to the CC3 door at the onchain sell-back price.
 *
 * The pool check reads the sale's live tCTC balance minus owed consignor
 * proceeds first — mirroring the onchain solvency guard — so a dry pool
 * fails with a plain sentence instead of an onchain revert. Returns true
 * only when the payout receipt lands.
 */
export async function sellCC3Stars(amountStr: string): Promise<boolean> {
    const toastId = `sale-cc3-sell-${Date.now()}`
    const ctx = await prepareCC3Write(toastId)
    if (!ctx) return false
    const parsed = parseWholeStars(amountStr)
    if ('error' in parsed) {
        toast.error(parsed.error)
        return false
    }

    try {
        const sellPrice = await fetchCC3SellPrice()
        if (sellPrice === null) {
            toast.error('Sell-back price is unreachable — the sale may be undeployed or the RPC down', {
                id: toastId,
            })
            return false
        }
        const payout = totalSaleCost(parsed.amount, sellPrice)
        const pool = await cc3PublicClient().getBalance({ address: CC_SALE_ADDRESS })
        const owed = (await fetchCC3ProceedsOwed()) ?? BigInt(0)
        const free = pool >= owed ? pool - owed : BigInt(0)
        if (free < payout) {
            const max = maxSellableStars(free, sellPrice)
            toast.error(
                `Sell-back pool holds only ${formatEther(free)} tCTC (covers up to ${max.toString()} Star${max === BigInt(1) ? '' : 's'}) — buy first to refill it before selling ${parsed.amount.toString()}`,
                { id: toastId },
            )
            return false
        }
        if (!(await ensureSaleStarsApproval(wholeStarsToUnits(parsed.amount), toastId))) return false

        toast.loading('Selling Stars back for tCTC...', { id: toastId })
        const hash = await ctx.wallet.writeContract({
            address: CC_SALE_ADDRESS,
            abi: CC3_SALE_ABI,
            functionName: 'sellStars',
            args: [parsed.amount],
            chain: creditcoinTestnet,
            account: ctx.player,
        })
        await cc3PublicClient().waitForTransactionReceipt({ hash })

        void refreshWalletBalances({ awaitChange: true })

        toast.success(
            `Sold ${parsed.amount.toString()} Stars for ${formatEther(payout)} tCTC`,
            { id: toastId },
        )
        return true
    } catch (error: unknown) {
        toast.error(getTxErrorMessage(error), { id: toastId })
        return false
    }
}

/**
 * Escrow whole Stars as a FIFO consignment lot. When later buyers fill the
 * lot, proceeds accrue under the depositor and are pulled via
 * withdrawCC3Proceeds. Unfilled escrow is reclaimable via
 * cancelCC3Consignment. Returns true only when the deposit receipt lands.
 */
export async function depositCC3Stars(amountStr: string): Promise<boolean> {
    const toastId = `sale-cc3-deposit-${Date.now()}`
    const ctx = await prepareCC3Write(toastId)
    if (!ctx) return false
    const parsed = parseWholeStars(amountStr)
    if ('error' in parsed) {
        toast.error(parsed.error)
        return false
    }

    try {
        if (!(await ensureSaleStarsApproval(wholeStarsToUnits(parsed.amount), toastId))) return false

        toast.loading('Depositing Stars as a consignment lot...', { id: toastId })
        const hash = await ctx.wallet.writeContract({
            address: CC_SALE_ADDRESS,
            abi: CC3_SALE_ABI,
            functionName: 'depositStars',
            args: [parsed.amount],
            chain: creditcoinTestnet,
            account: ctx.player,
        })
        await cc3PublicClient().waitForTransactionReceipt({ hash })

        void refreshWalletBalances({ awaitChange: true })

        toast.success(
            `Deposited ${parsed.amount.toString()} Stars — proceeds accrue here when buyers fill the lot`,
            { id: toastId },
        )
        return true
    } catch (error: unknown) {
        toast.error(getTxErrorMessage(error), { id: toastId })
        return false
    }
}

/**
 * Cancel a consignment lot and reclaim its unfilled escrow. The lot id is
 * the index shown next to the depositor's open lots. Returns true only when
 * the cancel receipt lands.
 */
export async function cancelCC3Consignment(lotIdStr: string): Promise<boolean> {
    const toastId = `sale-cc3-cancel-${Date.now()}`
    const ctx = await prepareCC3Write(toastId)
    if (!ctx) return false
    const trimmed = lotIdStr.trim()
    if (!/^\d+$/.test(trimmed)) {
        toast.error('Lot id must be a whole number')
        return false
    }

    try {
        toast.loading('Cancelling the consignment lot...', { id: toastId })
        const hash = await ctx.wallet.writeContract({
            address: CC_SALE_ADDRESS,
            abi: CC3_SALE_ABI,
            functionName: 'cancelConsignment',
            args: [BigInt(trimmed)],
            chain: creditcoinTestnet,
            account: ctx.player,
        })
        await cc3PublicClient().waitForTransactionReceipt({ hash })

        void refreshWalletBalances({ awaitChange: true })

        toast.success(`Consignment lot ${trimmed} cancelled — escrow returned`, { id: toastId })
        return true
    } catch (error: unknown) {
        toast.error(getTxErrorMessage(error), { id: toastId })
        return false
    }
}

/**
 * Pull earned consignment proceeds in tCTC. Fails with a plain sentence
 * when nothing is owed instead of an onchain revert. Returns true only when
 * the withdraw receipt lands.
 */
export async function withdrawCC3Proceeds(): Promise<boolean> {
    const toastId = `sale-cc3-redeem-${Date.now()}`
    const ctx = await prepareCC3Write(toastId)
    if (!ctx) return false

    try {
        const owed = await fetchCC3Proceeds(ctx.player)
        if (owed === null) {
            toast.error('Proceeds are unreachable — the sale may be undeployed or the RPC down', {
                id: toastId,
            })
            return false
        }
        if (owed === BigInt(0)) {
            toast.error('No proceeds to withdraw — none of your lots have sold yet', { id: toastId })
            return false
        }

        toast.loading('Withdrawing consignment proceeds...', { id: toastId })
        const hash = await ctx.wallet.writeContract({
            address: CC_SALE_ADDRESS,
            abi: CC3_SALE_ABI,
            functionName: 'withdrawProceeds',
            chain: creditcoinTestnet,
            account: ctx.player,
        })
        await cc3PublicClient().waitForTransactionReceipt({ hash })

        void refreshWalletBalances({ awaitChange: true })

        toast.success(`Withdrew ${formatEther(owed)} tCTC in proceeds`, { id: toastId })
        return true
    } catch (error: unknown) {
        toast.error(getTxErrorMessage(error), { id: toastId })
        return false
    }
}
