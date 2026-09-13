/**
 * Test double for `@/app/actions`, redirected by the `node --test` loader.
 * The real module uses `next/headers` cookies, which do not exist outside
 * the Next runtime. Cookie syncing is out of scope for balance tests.
 */

export async function setAccountIdCookie(): Promise<{ success: boolean }> {
    return { success: true }
}

export async function deleteAccountIdCookie(): Promise<{ success: boolean }> {
    return { success: true }
}
