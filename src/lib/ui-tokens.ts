/**
 * Shared Tailwind class tokens for the application's modal/dialog surface.
 *
 * Every fullscreen overlay + panel combination in the app used to declare its
 * own padding, max-width, backdrop, and shadow values inline. That drifted
 * over time — MarketplaceModal used p-6 while InventoryModal used p-8, Redeem
 * was missing w-full, etc. — which made the same UI feel different across
 * screens and breakpoints.
 *
 * Centralising the class strings here means one edit propagates to every
 * modal, and component files read as "this is a cyan modal at md size"
 * rather than a 200-character className soup.
 */

export type ModalAccent = 'cyan' | 'amber' | 'red';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

const SIZE_CLASS: Record<ModalSize, string> = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-4xl',
    '2xl': 'max-w-5xl',
};

const ACCENT_RING: Record<ModalAccent, string> = {
    cyan: 'border-cyan-500/50 shadow-[0_0_50px_rgba(6,182,212,0.2)]',
    amber: 'border-amber-500/50 shadow-[0_0_50px_rgba(245,158,11,0.15)]',
    red: 'border-red-500/50 shadow-[0_0_50px_rgba(239,68,68,0.2)]',
};

const ACCENT_TEXT: Record<ModalAccent, string> = {
    cyan: 'text-cyan-400',
    amber: 'text-amber-400',
    red: 'text-red-400',
};

const ACCENT_CLOSE: Record<ModalAccent, string> = {
    cyan: 'text-cyan-500 hover:text-white focus-visible:ring-cyan-400',
    amber: 'text-amber-500 hover:text-white focus-visible:ring-amber-400',
    red: 'text-red-500 hover:text-white focus-visible:ring-red-400',
};

const ACCENT_HEADER_BORDER: Record<ModalAccent, string> = {
    cyan: 'border-cyan-950',
    amber: 'border-amber-950',
    red: 'border-red-950',
};

/** Dark backdrop that swallows clicks outside the panel. */
export const MODAL_OVERLAY =
    'fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/95 backdrop-blur-md';

/**
 * Panel container. Pairs a size cap with a height cap + scroll margin so
 * modals never overflow the viewport on small phones.
 *
 * `svh` (small viewport height) is the worst-case viewport on mobile — when
 * the browser chrome (address bar, toolbar) is fully visible. Using it as
 * the base unit guarantees the modal fits even before the user scrolls,
 * unlike `vh` which assumes a collapsed chrome and overshoots on first paint.
 * Desktop and tablets (md+) stay on `vh` since they don't have collapsing
 * chrome anyway.
 *
 * The 2rem / 3rem subtraction mirrors the overlay's p-4 / sm:p-6 padding so
 * the panel's outer edge never crosses the overlay's inner edge.
 */
export const modalPanel = (accent: ModalAccent, size: ModalSize): string =>
    `bg-[#050505] border rounded-2xl w-full ${SIZE_CLASS[size]} max-h-[calc(100svh-2rem)] sm:max-h-[calc(100svh-3rem)] md:max-h-[calc(100vh-3rem)] overflow-hidden ${ACCENT_RING[accent]} outline-hidden`;

/** Standard interior padding that grows with viewport. */
export const MODAL_PADDING = 'p-4 sm:p-6 md:p-8';

/** Section header inside a modal — title + close button row. Wraps on small screens unless `nowrap` is set. */
export const modalHeaderRow = (accent: ModalAccent, opts?: { nowrap?: boolean }): string =>
    `flex ${opts?.nowrap ? 'flex-nowrap' : 'flex-wrap'} items-center justify-between gap-3 mb-4 sm:mb-6 border-b ${ACCENT_HEADER_BORDER[accent]} pb-3 sm:pb-4 shrink-0`;

/** Modal title sizes scale with viewport. */
export const modalTitle = (accent: ModalAccent): string =>
    `text-lg sm:text-xl md:text-2xl font-black ${ACCENT_TEXT[accent]} tracking-tighter uppercase italic`;

/** Caption line under the title — small mono caption. */
export const modalCaption = (accent: ModalAccent): string =>
    `text-[10px] ${ACCENT_TEXT[accent]}/60 font-mono uppercase tracking-widest`;

/** Close ("[X]") button — large enough tap target + visible focus ring. */
export const modalCloseBtn = (accent: ModalAccent): string =>
    `${ACCENT_CLOSE[accent]} shrink-0 transition-colors font-mono text-lg sm:text-xl cursor-pointer px-2 py-1 -mr-2 rounded focus-visible:outline-none focus-visible:ring-2`;

/** Generic focus ring for interactive chips/selects inside modals. */
export const FOCUS_RING_CYAN =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-1 focus-visible:ring-offset-black';

export const FOCUS_RING_AMBER =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-1 focus-visible:ring-offset-black';

/** Page-level card padding consistent with modal padding. */
export const CARD_PADDING = 'p-4 sm:p-6 md:p-8';

/** Responsive select dropdown that matches the modal shell. */
export const modalSelect = (accent: ModalAccent): string => {
    const base =
        'bg-transparent border text-xs font-mono rounded px-2 py-1.5 cursor-pointer transition-colors [&>option]:bg-black focus-visible:outline-none focus-visible:ring-2';
    const styles: Record<ModalAccent, string> = {
        cyan: 'border-cyan-500/40 text-cyan-300 hover:border-cyan-400 focus-visible:ring-cyan-400',
        amber: 'border-amber-500/40 text-amber-300 hover:border-amber-400 focus-visible:ring-amber-400',
        red: 'border-red-500/40 text-red-300 hover:border-red-400 focus-visible:ring-red-400',
    };
    return `${base} ${styles[accent]}`;
};
