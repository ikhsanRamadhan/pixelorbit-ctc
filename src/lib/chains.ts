import { defineChain } from 'viem'

export const creditcoinTestnet = defineChain({
    id: 102031,
    name: 'Creditcoin Testnet',
    nativeCurrency: { name: 'Test CTC', symbol: 'tCTC', decimals: 18 },
    rpcUrls: {
        default: {
            http: ['https://rpc.cc3-testnet.creditcoin.network'],
        },
    },
    blockExplorers: {
        default: {
            name: 'Blockscout',
            url: 'https://creditcoin-testnet.blockscout.com',
        },
    },
    testnet: true,
})

// Sepolia hosts the Stars source lock contract. Reads go through the
// browser-reachable RPC (NEXT_PUBLIC_SEPOLIA_RPC_URL); writes go through the
// wallet, which prompts the network switch. The app never asks the wallet to
// stay on Sepolia — bridging is driven from Creditcoin.
export const sepolia = defineChain({
    id: 11155111,
    name: 'Sepolia',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
        default: {
            http: [
                process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ||
                'https://ethereum-sepolia-rpc.publicnode.com',
            ],
        },
    },
    blockExplorers: {
        default: {
            name: 'Etherscan',
            url: 'https://sepolia.etherscan.io',
        },
    },
    testnet: true,
})
