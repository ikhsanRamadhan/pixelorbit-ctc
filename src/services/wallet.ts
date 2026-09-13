'use client'

import { writeContract, readContract, waitForTransactionReceipt, getConnections, disconnect as wagmiDisconnect, getBalance } from 'wagmi/actions'
import { toast } from 'sonner'
import { formatUnits } from 'viem'

import { config } from '@/lib/wagmi'
import { setAccountIdCookie, deleteAccountIdCookie } from '@/app/actions'
import { SEPOLIA_RPC_URL, STARS_ABI, STARS_DECIMALS, STARS_ADDRESS } from '@/lib/contracts'
import { resolveSepoliaStars } from '@/services/bridge'
import { useGameStore } from '@/stores/game-store'
import {
    createSepoliaBalanceReader,
    createSepoliaNativeReader,
    readSepoliaNativeBalance,
    readSepoliaStarsBalance,
    type SepoliaBalanceReader,
    type SepoliaNativeReader,
} from './sepolia-balance'

const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')

export function resolveStarsAddress(): `0x${string}` {
    return STARS_ADDRESS
}

export function getWalletAddress(): `0x${string}` | undefined {
    return getConnections(config)[0]?.accounts[0]
}

export function isCurrentWallet(address?: `0x${string}`): boolean {
    const current = getWalletAddress()
    return !!address && !!current && current.toLowerCase() === address.toLowerCase()
}

export async function fetchStarsBalance(address: `0x${string}`): Promise<string> {
    try {
        const starsAddr = await resolveStarsAddress()
        const balance = await readContract(config, {
            address: starsAddr,
            abi: STARS_ABI,
            functionName: 'balanceOf',
            args: [address],
        })
        return formatUnits(balance as bigint, STARS_DECIMALS)
    } catch {
        return '0'
    }
}

export async function fetchNativeBalance(address: `0x${string}`): Promise<string> {
    try {
        const balance = await getBalance(config, { address })
        return formatUnits(balance.value, balance.decimals)
    } catch {
        return '0'
    }
}

/**
 * Sepolia Stars balance for an address. Mirrors `fetchStarsBalance` but
 * reads the Sepolia Stars token over the Sepolia RPC instead of the
 * Creditcoin one.
 *
 * Token-address derivation is canonical in `bridge.ts`
 * (`resolveSepoliaStars`); the read itself delegates to
 * `sepolia-balance.ts` so unit tests can inject a mocked reader. Never
 * throws: RPC failure yields '0', the same failure posture as
 * `fetchStarsBalance`. The optional reader override exists for tests only.
 */
export async function fetchSepoliaStarsBalance(
    address: `0x${string}`,
    reader?: SepoliaBalanceReader,
): Promise<string> {
    try {
        const stars = await resolveSepoliaStars()
        if (!stars) return '0'
        return await readSepoliaStarsBalance(
            stars,
            address,
            reader ?? createSepoliaBalanceReader(SEPOLIA_RPC_URL),
        )
    } catch {
        return '0'
    }
}

/**
 * Sepolia native ETH balance for an address. Unlike the Stars read there is
 * no token to resolve — the balance comes straight from the Sepolia RPC.
 *
 * Never throws: RPC failure yields '0', the same failure posture as
 * `fetchSepoliaStarsBalance`. The optional reader override exists for tests
 * only.
 */
export async function fetchSepoliaEthBalance(
    address: `0x${string}`,
    reader?: SepoliaNativeReader,
): Promise<string> {
    try {
        return await readSepoliaNativeBalance(
            address,
            reader ?? createSepoliaNativeReader(SEPOLIA_RPC_URL),
        )
    } catch {
        return '0'
    }
}

export async function ensureAllowance(
    spender: `0x${string}`,
    amount: bigint,
): Promise<boolean> {
    const address = getWalletAddress()
    if (!address) return false

    const starsAddr = await resolveStarsAddress()
    const allowance = await readContract(config, {
        address: starsAddr,
        abi: STARS_ABI,
        functionName: 'allowance',
        args: [address, spender],
    }) as bigint

    if (allowance >= amount) return true

    toast.info('Approving Stars...', { id: 'approve' })
    const tx = await writeContract(config, {
        address: starsAddr,
        abi: STARS_ABI,
        functionName: 'approve',
        args: [spender, MAX_UINT256],
    })
    await waitForTransactionReceipt(config, { hash: tx })
    toast.success('Stars approved', { id: 'approve' })
    return true
}

export async function walletDisconnect(): Promise<void> {
    await wagmiDisconnect(config)
    await deleteAccountIdCookie()
    useGameStore.getState().reset()
    toast.success('Disconnected')
}

export async function syncAccountIdCookie(isConnected: boolean, address?: string): Promise<void> {
    if (isConnected && address) {
        await setAccountIdCookie(address)
    } else {
        await deleteAccountIdCookie()
        useGameStore.getState().reset()
    }
}
