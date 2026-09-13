'use client'

import { useEffect, useRef } from 'react'

/**
 * Selector for the things a keyboard user can actually land on. Negative
 * tabindex is excluded deliberately: it means "focusable by script, not by Tab".
 */
const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Framework-free core of {@link useModalA11y}: initial focus, the
 * Escape/Tab keydown trap, and focus restoration on cleanup.
 *
 * Split out so the focus-once contract is unit-testable without React or a
 * real DOM: the caller supplies the panel and a getter for the latest
 * `onClose`, and this function touches focus exactly once up front. Later
 * `onClose` swaps (a fresh closure every parent render) never re-run the
 * setup — the keydown handler reads through `getOnClose` instead.
 *
 * Every `.focus()` passes `{ preventScroll: true }` so focusing never yanks
 * the `overflow-y-auto` panel scroll position. Returns the cleanup that
 * removes the listener and hands focus back to the opener.
 */
export function setupModalA11y(
    panel: HTMLElement,
    getOnClose: () => () => void,
): () => void {
    // Captured before we move focus, so it can be handed back on close. The
    // opener is usually the button that set the parent's open flag.
    const previouslyFocused = document.activeElement as HTMLElement | null

    // Focus the first control rather than the panel itself, so a screen
    // reader starts on something actionable. The panel is the fallback for a
    // dialog that is purely informational.
    const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE)
    ;(focusables[0] ?? panel).focus({ preventScroll: true })

    const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            event.preventDefault()
            getOnClose()()
            return
        }

        if (event.key !== 'Tab') return

        // Re-queried on every Tab: stage-based modals swap their contents
        // while open, so a list captured on mount would go stale.
        const current = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
        if (current.length === 0) {
            // Nothing to cycle through — keep focus in the dialog rather
            // than letting Tab escape to the page behind it.
            event.preventDefault()
            return
        }

        const first = current[0]
        const last = current[current.length - 1]

        // Only the two edges need handling; the browser does the rest.
        if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus({ preventScroll: true })
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus({ preventScroll: true })
        }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
        document.removeEventListener('keydown', handleKeyDown)
        // The opener may have unmounted with the modal (an item panel, say),
        // so this is conditional rather than assumed.
        if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true })
    }
}

/**
 * Body scroll lock, ref-counted for nested modals.
 *
 * A fixed overlay alone does not stop the page behind it from scrolling:
 * wheel input over the backdrop scrolls the body directly, and scroll input
 * past a panel edge chains out to the body. Locking `overflow` on mount and
 * restoring it on unmount closes both paths for every modal at once.
 *
 * The count keeps nested modals safe: the second lock is a no-op and the
 * body is only released when the last modal unmounts. The pre-existing
 * inline value is restored verbatim rather than assumed empty.
 */
let bodyScrollLocks = 0
let savedBodyOverflow = ''

export function lockBodyScroll(): void {
    if (typeof document === 'undefined') return
    if (bodyScrollLocks === 0) {
        savedBodyOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
    }
    bodyScrollLocks += 1
}

export function unlockBodyScroll(): void {
    if (typeof document === 'undefined') return
    if (bodyScrollLocks === 0) return
    bodyScrollLocks -= 1
    if (bodyScrollLocks === 0) {
        document.body.style.overflow = savedBodyOverflow
    }
}

/** Test-only reset for the module-level lock count. Never call in product code. */
export function __resetBodyScrollLockForTests(): void {
    bodyScrollLocks = 0
    savedBodyOverflow = ''
}

/**
 * Make a modal usable without a mouse.
 *
 * Every modal in this app closes by clicking its backdrop, which a keyboard or
 * screen-reader user has no way to reach — so without this they enter a dialog
 * they cannot leave, and Tab keeps walking into the page behind it. This adds
 * the three things that fixes: Escape closes, Tab cycles inside the panel, and
 * focus returns to whatever opened the modal.
 *
 * Returns a ref to attach to the panel element (not the backdrop) — the trap
 * needs the bounds of the content, and the backdrop covers the whole viewport.
 *
 * Focus runs exactly once on mount. Parents pass a fresh `onClose` closure on
 * every render (store updates re-render them constantly), so the effect below
 * deliberately has empty deps and reads the latest `onClose` through a ref —
 * re-subscribing per render would re-focus the first input and scroll the
 * panel back to the top on every store tick.
 *
 * Assumes the modal is mounted only while open, which is how all the modals here
 * work: the parent holds a flag and `AnimatePresence` mounts the content. If a
 * modal ever renders while closed this would trap focus in a hidden panel.
 */
export function useModalA11y<T extends HTMLElement>(onClose: () => void) {
    const panelRef = useRef<T | null>(null)

    // Refreshed after each render so the mount-only effect below always
    // reaches the latest close handler without re-running.
    const onCloseRef = useRef(onClose)
    useEffect(() => {
        onCloseRef.current = onClose
    })

    useEffect(() => {
        const panel = panelRef.current
        if (!panel) return

        // Scroll lock rides the same mount-only effect as the focus trap so
        // every modal inherits it with no call-site changes; the ref count
        // inside keeps nested modals from releasing each other's lock.
        lockBodyScroll()
        const cleanupA11y = setupModalA11y(panel, () => onCloseRef.current)
        return () => {
            cleanupA11y()
            unlockBodyScroll()
        }
    }, [])

    return panelRef
}
