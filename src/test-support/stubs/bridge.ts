/**
 * Test double for `@/services/bridge`, redirected by the `node --test`
 * loader. Only `resolveSepoliaStars` is stubbed: the wallet wrapper under
 * test derives the token from it, and tests steer the result per case.
 * Nothing here touches the network.
 */

let token: `0x${string}` | null = null
let shouldThrow = false

/** Next `resolveSepoliaStars` call returns this token (or null). */
export function __setSepoliaStarsToken(value: `0x${string}` | null): void {
    token = value
}

/** Next `resolveSepoliaStars` call throws instead of resolving. */
export function __setResolveSepoliaStarsThrows(value: boolean): void {
    shouldThrow = value
}

/** Restore the pristine stub between tests. */
export function __resetBridgeStub(): void {
    token = null
    shouldThrow = false
}

export async function resolveSepoliaStars(): Promise<`0x${string}` | null> {
    if (shouldThrow) throw new Error('sepolia token lookup failed')
    return token
}
