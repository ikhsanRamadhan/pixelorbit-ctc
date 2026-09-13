'use client'

import { useWalletStore } from '@/stores/wallet-store'

/**
 * App header / navigation bar.
 * Shows the app name and wallet connection state.
 * Fixed at 48px tall so the rest of the layout can pad for it reliably.
 */
export function AppHeader() {
    const { isConnected } = useWalletStore()

    return (
        <header className="fixed top-0 left-0 right-0 h-12 z-40 bg-black/40 backdrop-blur-md border-b border-white/5">
            <div className="flex items-center justify-between h-full px-3 sm:px-4">
                {/* Brand */}
                <div className="flex items-center gap-2 min-w-0">
                    <span className="font-orbitron font-black italic text-sm tracking-tighter uppercase text-cyan-400">
                        PIXELORBIT
                    </span>
                    <span className="hidden sm:inline text-[10px] text-cyan-500/60 font-mono uppercase tracking-wider border-l border-white/10 pl-2">
                        Creditcoin Testnet
                    </span>
                </div>

                {/* Status cluster */}
                <div className="flex items-center gap-2">

                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/60 border border-white/10 backdrop-blur-sm">
                        <div
                            className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 shadow-emerald-500/50' : 'bg-gray-600'}`}
                        />
                        <span className="hidden sm:inline text-[10px] font-mono text-white/70 uppercase tracking-wider">
                            {isConnected ? 'Wallet' : 'Offline'}
                        </span>
                    </div>
                </div>
            </div>
        </header>
    )
}

export default AppHeader
