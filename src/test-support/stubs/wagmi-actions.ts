/**
 * Test double for `wagmi/actions`, redirected by the `node --test` loader.
 * Wallet flows never run under `node --test`; every action fails loudly so
 * a test can never mistake a stub for a chain read.
 */

function unreachable(name: string): never {
    throw new Error(`wagmi/actions stub: ${name} has no wallet under node --test`)
}

export async function writeContract(): Promise<never> {
    unreachable('writeContract')
}

export async function readContract(): Promise<never> {
    unreachable('readContract')
}

export async function waitForTransactionReceipt(): Promise<never> {
    unreachable('waitForTransactionReceipt')
}

export function getConnections(): Array<never> {
    return []
}

/**
 * Disconnected wallet under `node --test`: no address, so any flow that
 * requires a connection takes its connect-your-wallet branch.
 */
export function getAccount(): { address: undefined } {
    return { address: undefined }
}

export async function disconnect(): Promise<void> {
    unreachable('disconnect')
}

export async function getBalance(): Promise<never> {
    unreachable('getBalance')
}
