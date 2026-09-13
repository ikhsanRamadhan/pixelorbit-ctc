/**
 * Test double for `sonner`, redirected by the `node --test` loader.
 * Toasts are fire-and-forget UI; tests drop them on the floor.
 */

function dropToast(): void {}

export const toast = {
    info: dropToast,
    success: dropToast,
    error: dropToast,
    loading: dropToast,
}
