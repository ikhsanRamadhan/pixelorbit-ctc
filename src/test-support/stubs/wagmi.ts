/**
 * Test double for `wagmi`, redirected by the `node --test` loader. Hook
 * components never render under `node --test`, so these hooks only need to
 * exist for the store module to import.
 */

export function useAccount(): { address: undefined; isConnected: boolean } {
    return { address: undefined, isConnected: false }
}

export function useBalance(): { data: undefined } {
    return { data: undefined }
}

export function useReadContract(): { data: undefined } {
    return { data: undefined }
}
