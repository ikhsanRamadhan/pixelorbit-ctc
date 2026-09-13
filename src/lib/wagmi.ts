import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { http } from 'wagmi'
import { creditcoinTestnet } from './chains'
import { metaMaskWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'pixelorbit-demo'

export const config = getDefaultConfig({
    appName: 'PixelOrbit',
    projectId,
    chains: [creditcoinTestnet],
    transports: {
        [creditcoinTestnet.id]: http('https://rpc.cc3-testnet.creditcoin.network'),
    },
    ssr: true,
    wallets: [
        {
            groupName: 'Popular',
            wallets: [
                metaMaskWallet,
                walletConnectWallet,
            ],
        },
    ],
})
