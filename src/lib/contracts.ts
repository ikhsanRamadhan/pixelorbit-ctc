import shipAbi from './abis/PixelOrbitShip.abi.json'
import itemAbi from './abis/PixelOrbitItem.abi.json'
import marketplaceAbi from './abis/PixelOrbitMarketplace.abi.json'
import leaderboardAbi from './abis/PixelOrbitLeaderboard.abi.json'
import starsCCAbi from './abis/OrbitStarsCC.abi.json'
import starsSepoliaAbi from './abis/StarsSepolia.abi.json'
import sourceAbi from './abis/PixelOrbitSource.abi.json'
import ascAbi from './abis/PixelOrbitASC.abi.json'
import priceOracleAbi from './abis/PixelOrbitPriceOracle.abi.json'
import starsSaleAbi from './abis/StarsSale.abi.json'
import starsSaleCC3Abi from './abis/StarsSaleCC3.abi.json'

export const SHIP_CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_SHIP_CONTRACT_ADDRESS || '0x') as `0x${string}`
export const ITEM_CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_ITEM_CONTRACT_ADDRESS || '0x') as `0x${string}`
export const MARKETPLACE_CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_MARKETPLACE_CONTRACT_ADDRESS || '0x') as `0x${string}`
export const LEADERBOARD_CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_LEADERBOARD_CONTRACT_ADDRESS || '0x') as `0x${string}`

// Attestcoin bridge addresses. The ASC lives on Creditcoin CC3; the source
// lock lives on Sepolia. STARS_ADDRESS is the Creditcoin Stars token the game
// prices in. PRICE_ORACLE_ADDRESS is the attested Chainlink ETH/USD relay on
// Creditcoin CC3 (empty when not deployed): it gates the 20 percent flash
// sale and is NOT a Stars valuation — Stars has no market price.
export const ASC_ADDRESS = (process.env.NEXT_PUBLIC_ASC_ADDRESS || '0x') as `0x${string}`
export const SOURCE_ADDRESS = (process.env.NEXT_PUBLIC_SOURCE_ADDRESS || '0x') as `0x${string}`
export const STARS_ADDRESS = (process.env.NEXT_PUBLIC_STARS_ADDRESS || '0x') as `0x${string}`
export const PRICE_ORACLE_ADDRESS = (process.env.NEXT_PUBLIC_PRICE_ORACLE_ADDRESS || '') as `0x${string}` | ''

export const SHIP_ABI = shipAbi
export const ITEM_ABI = itemAbi
export const MARKETPLACE_ABI = marketplaceAbi
export const LEADERBOARD_ABI = leaderboardAbi
export const STARS_CC_ABI = starsCCAbi
export const STARS_SEPOLIA_ABI = starsSepoliaAbi
export const SOURCE_ABI = sourceAbi
export const ASC_ABI = ascAbi
export const PRICE_ORACLE_ABI = priceOracleAbi
export const STARS_SALE_ABI = starsSaleAbi
export const STARS_SALE_CC3_ABI = starsSaleCC3Abi

// Permissionless Stars purchase doors (dual sale). Printed by
// `deploy-stars-sale.ts` (Sepolia, ETH door) and `deploy-cc3-sale.ts`
// (Creditcoin CC3, tCTC door). Empty when not deployed: the Buy
// Stars panels disable with a reason instead of sending transactions.
export const SALE_ADDRESS = (process.env.NEXT_PUBLIC_SALE_ADDRESS || '0x') as `0x${string}`
export const CC_SALE_ADDRESS = (process.env.NEXT_PUBLIC_CC_SALE_ADDRESS || '0x') as `0x${string}`

// Attested ETH/USD feed details: 8 decimals on the Chainlink Sepolia proxy.
// Display-only: the dealership shows this relay to explain the sale switch
// and never converts Stars to USD.
export const PRICE_FEED_DECIMALS = 8
export const PRICE_FRESHNESS_WINDOW_S = 24 * 3600

// Stars is a plain 18-decimal ERC-20 on both chains. No transfer buffer is
// needed: unlike the old FAssets token there is no delegatecall checkpoint
// underneath, so the gas estimate is honest.
export const STARS_DECIMALS = 18

export const STARS_ABI = [
    {
        name: 'balanceOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'approve',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bool' }],
    },
    {
        name: 'allowance',
        type: 'function',
        stateMutability: 'view',
        inputs: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
        ],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'decimals',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint8' }],
    },
    {
        name: 'transfer',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bool' }],
    },
    {
        name: 'transferFrom',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bool' }],
    },
] as const

// Creditcoin attestcoin precompiles. BlockProver verifies Sepolia Merkle plus
// continuity proofs synchronously; ChainInfo reports attestation status for
// the worker's wait loop.
export const BLOCK_PROVER_PRECOMPILE = '0x0000000000000000000000000000000000000FD2' as `0x${string}`
export const CHAIN_INFO_PRECOMPILE = '0x0000000000000000000000000000000000000FD3' as `0x${string}`

// Source chainkey the ASC expects: Sepolia.
export const SEPOLIA_CHAIN_KEY = 1

// Offchain readability endpoints. The prover builds Merkle plus continuity
// proofs for Sepolia locks; the dashboard tracks the bridge transactions.
export const PROVER_URL =
    process.env.NEXT_PUBLIC_PROVER_URL || 'https://prover.cc3-testnet.creditcoin.network/'
export const DASHBOARD_URL =
    process.env.NEXT_PUBLIC_DASHBOARD_URL || 'https://dashboard.cc3-testnet.creditcoin.network/'

// Sepolia Stars token the source contract locks.
//
// `deploy-sepolia-source.ts` prints only the source address, not the token
// address, so this defaults to empty and the bridge service derives it at
// runtime from `PixelOrbitSource.stars()`. Set it only to skip that read.
export const SEPOLIA_STARS_ADDRESS = (process.env.NEXT_PUBLIC_SEPOLIA_STARS_ADDRESS || '') as `0x${string}` | ''

// Browser-reachable Sepolia RPC for lock receipts and `stars()` reads.
// `SEPOLIA_RPC_URL` (contracts env) is server-only, so the frontend needs its
// own variable. Defaults to the same public endpoint.
export const SEPOLIA_RPC_URL =
    process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
