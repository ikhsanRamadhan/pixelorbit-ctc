'use client'

import { readContract } from 'wagmi/actions'
import { config } from '@/lib/wagmi'
import {
    PRICE_FEED_DECIMALS,
    PRICE_FRESHNESS_WINDOW_S,
    PRICE_ORACLE_ABI,
    PRICE_ORACLE_ADDRESS,
} from '@/lib/contracts'

export interface PriceOracleStatus {
    configured: boolean
    answer: bigint | null
    roundId: bigint | null
    updatedAt: bigint | null
    ageSeconds: number | null
    isFresh: boolean
    formattedAnswer: string | null
}

function formatAge(ageSeconds: number): string {
    if (ageSeconds < 60) return `${Math.max(0, Math.floor(ageSeconds))}s ago`
    if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`
    if (ageSeconds < 86400) {
        const hours = Math.floor(ageSeconds / 3600)
        const minutes = Math.floor((ageSeconds % 3600) / 60)
        return minutes > 0 ? `${hours}h ${minutes}m ago` : `${hours}h ago`
    }
    const days = Math.floor(ageSeconds / 86400)
    const hours = Math.floor((ageSeconds % 86400) / 3600)
    return hours > 0 ? `${days}d ${hours}h ago` : `${days}d ago`
}

export function formatPriceAge(ageSeconds: number | null): string {
    if (ageSeconds === null) return 'unknown age'
    return formatAge(ageSeconds)
}

function formatAnswer(answer: bigint): string {
    const decimals = PRICE_FEED_DECIMALS
    const zero = BigInt(0)
    const negative = answer < zero
    const abs = negative ? -answer : answer
    const base = BigInt(10) ** BigInt(decimals)
    const whole = abs / base
    const frac = (abs % base).toString().padStart(decimals, '0').slice(0, 2)
    return `${negative ? '-' : ''}$${whole.toLocaleString('en-US')}.${frac}`
}

/**
 * Attested Chainlink ETH/USD relay status for the dealership sale banner.
 *
 * Honesty: Stars has no market price. This is a verified third-party ETH/USD
 * data relay plus a liveness-gated 20 percent Stars sale switch — never a
 * Stars/USD conversion. The UI must never multiply Stars prices by this feed.
 */
export async function fetchPriceOracleStatus(nowMs: number = Date.now()): Promise<PriceOracleStatus> {
    if (PRICE_ORACLE_ADDRESS === '') {
        return {
            configured: false,
            answer: null,
            roundId: null,
            updatedAt: null,
            ageSeconds: null,
            isFresh: false,
            formattedAnswer: null,
        }
    }
    try {
        const [answer, roundId, updatedAt] = await Promise.all([
            readContract(config, {
                address: PRICE_ORACLE_ADDRESS,
                abi: PRICE_ORACLE_ABI,
                functionName: 'answer',
            }) as Promise<bigint>,
            readContract(config, {
                address: PRICE_ORACLE_ADDRESS,
                abi: PRICE_ORACLE_ABI,
                functionName: 'roundId',
            }) as Promise<bigint>,
            readContract(config, {
                address: PRICE_ORACLE_ADDRESS,
                abi: PRICE_ORACLE_ABI,
                functionName: 'updatedAt',
            }) as Promise<bigint>,
        ])
        if (answer <= BigInt(0)) {
            return {
                configured: true,
                answer,
                roundId,
                updatedAt,
                ageSeconds: null,
                isFresh: false,
                formattedAnswer: null,
            }
        }
        const updatedAtMs = Number(updatedAt) * 1000
        const ageSeconds = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000))
        return {
            configured: true,
            answer,
            roundId,
            updatedAt,
            ageSeconds,
            isFresh: ageSeconds <= PRICE_FRESHNESS_WINDOW_S,
            formattedAnswer: formatAnswer(answer),
        }
    } catch (error) {
        console.error('fetchPriceOracleStatus error:', error)
        return {
            configured: true,
            answer: null,
            roundId: null,
            updatedAt: null,
            ageSeconds: null,
            isFresh: false,
            formattedAnswer: null,
        }
    }
}
