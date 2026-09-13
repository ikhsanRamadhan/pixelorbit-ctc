import { BaseError } from 'viem'

/**
 * Extracts a user-facing message from an error thrown by wagmi/viem contract
 * calls. viem wraps chain errors in `BaseError`, which carries a concise
 * `shortMessage` alongside the verbose `message`.
 */
export function getTxErrorMessage(error: unknown): string {
    if (error instanceof BaseError) return error.shortMessage || error.message
    if (error instanceof Error) return error.message
    return String(error)
}
