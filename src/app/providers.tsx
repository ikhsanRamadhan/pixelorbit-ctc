'use client'
import '@rainbow-me/rainbowkit/styles.css'
import { WagmiProvider } from 'wagmi'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, useEffect } from 'react'
import { config } from '@/lib/wagmi'
import { useWalletStore, useWalletSync } from '@/stores/wallet-store'
import { useGamePolling } from '@/hooks/useGamePolling'

const queryClient = new QueryClient()

function WalletAndGameState({ children }: { children: ReactNode }) {
    useWalletSync()
    const { connect, connectError, disconnect, connectModalOpen } = useGamePolling()
    const setAll = useWalletStore((s) => s.setAll)

    useEffect(() => {
        setAll({ connect, connectError, disconnect, connectModalOpen })
    }, [connect, connectError, disconnect, connectModalOpen, setAll])

    return <>{children}</>
}

export function Providers({ children }: { children: ReactNode }) {
    return (
        <QueryClientProvider client={queryClient}>
            <WagmiProvider config={config}>
                <RainbowKitProvider
                    theme={darkTheme({
                        accentColor: '#06b6d4',
                        accentColorForeground: 'white',
                    })}
                >
                    <WalletAndGameState>
                        {children}
                    </WalletAndGameState>
                </RainbowKitProvider>
            </WagmiProvider>
        </QueryClientProvider>
    )
}
