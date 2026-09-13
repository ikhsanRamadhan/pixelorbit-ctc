/**
 * Test double for `@/lib/wagmi`, redirected by the `node --test` loader.
 * The real module builds a RainbowKit config for browsers; tests never
 * connect a wallet, so an inert placeholder is enough.
 */

export const config = {}
