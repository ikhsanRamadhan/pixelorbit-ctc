import { createPublicClient, formatUnits, http, parseAbi } from 'viem'
import { sepolia } from 'viem/chains'

/**
 * Sepolia Stars balance reads, kept free of `@/` imports, `window`, and
 * wagmi so `node --test` can import this module directly. `wallet.ts` wires
 * these into the wallet flow via `fetchSepoliaStarsBalance`; the unit tests
 * cover them here with a mocked reader (no live-network calls).
 */

// Stars is a plain 18-decimal ERC-20 on both chains. Must match
// STARS_DECIMALS in `@/lib/contracts`.
const STARS_DECIMALS = 18

// Minimal balanceOf ABI for the read path. `bridge.ts` is canonical for the
// full Sepolia Stars interface (allowance/approve/lock); this module only
// ever reads balances.
const SEPOLIA_STARS_BALANCE_ABI = parseAbi([
    'function balanceOf(address account) view returns (uint256)',
])

/**
 * Injectable Sepolia read seam. Production passes a viem public client;
 * tests pass a mock, so no test ever touches the Sepolia RPC.
 */
export interface SepoliaBalanceReader {
    readBalance(stars: `0x${string}`, owner: `0x${string}`): Promise<bigint>
}

/** Live Sepolia reader over the given browser-reachable RPC URL. */
export function createSepoliaBalanceReader(rpcUrl: string): SepoliaBalanceReader {
    const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
    return {
        readBalance: (stars, owner) =>
            client.readContract({
                address: stars,
                abi: SEPOLIA_STARS_BALANCE_ABI,
                functionName: 'balanceOf',
                args: [owner],
            }),
    }
}

/**
 * Readable Sepolia Stars balance, formatted like `fetchStarsBalance`.
 * Never throws: an unreachable token or a failing RPC yields '0', the same
 * failure posture as the Creditcoin balance fetch.
 */
export async function readSepoliaStarsBalance(
    stars: `0x${string}` | null,
    owner: `0x${string}`,
    reader: SepoliaBalanceReader,
): Promise<string> {
    try {
        if (!stars) return '0'
        const balance = await reader.readBalance(stars, owner)
        return formatUnits(balance, STARS_DECIMALS)
    } catch {
        return '0'
    }
}

// Minimal totalSupply ABI for the "minted so far" display. StarsSepolia has
// no max-supply cap (owner faucet mints), so totalSupply is the honest
// supply figure — never presented as a cap.
const SEPOLIA_STARS_SUPPLY_ABI = parseAbi(['function totalSupply() view returns (uint256)'])

/**
 * Injectable Sepolia supply seam, mirroring SepoliaBalanceReader. Kept
 * separate so existing balance mocks and callers stay untouched.
 */
export interface SepoliaSupplyReader {
    readTotalSupply(stars: `0x${string}`): Promise<bigint>
}

/** Live Sepolia reader for the supply display. */
export function createSepoliaSupplyReader(rpcUrl: string): SepoliaSupplyReader {
    const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
    return {
        readTotalSupply: (stars) =>
            client.readContract({
                address: stars,
                abi: SEPOLIA_STARS_SUPPLY_ABI,
                functionName: 'totalSupply',
            }),
    }
}

/**
 * Total Sepolia Stars minted so far, formatted for display. Never throws:
 * an unreachable token or a failing RPC yields '0'.
 */
export async function readSepoliaStarsSupply(
    stars: `0x${string}` | null,
    reader: SepoliaSupplyReader,
): Promise<string> {
    try {
        if (!stars) return '0'
        return formatUnits(await reader.readTotalSupply(stars), STARS_DECIMALS)
    } catch {
        return '0'
    }
}

/**
 * Injectable Sepolia native-balance seam, mirroring SepoliaBalanceReader.
 * Native ETH needs no token address, so the seam takes only the owner.
 * Production passes a viem public client; tests pass a mock, so no test
 * ever touches the Sepolia RPC.
 */
export interface SepoliaNativeReader {
    readNativeBalance(owner: `0x${string}`): Promise<bigint>
}

/** Live Sepolia reader for the native ETH balance. */
export function createSepoliaNativeReader(rpcUrl: string): SepoliaNativeReader {
    const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
    return {
        readNativeBalance: (owner) => client.getBalance({ address: owner }),
    }
}

/**
 * Readable Sepolia ETH balance, formatted for display. Never throws: a
 * failing RPC yields '0', the same failure posture as the Stars reads.
 * Native ETH is 18 decimals, matching STARS_DECIMALS.
 */
export async function readSepoliaNativeBalance(
    owner: `0x${string}`,
    reader: SepoliaNativeReader,
): Promise<string> {
    try {
        return formatUnits(await reader.readNativeBalance(owner), STARS_DECIMALS)
    } catch {
        return '0'
    }
}
