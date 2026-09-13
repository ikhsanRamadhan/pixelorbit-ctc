import { ethers } from "hardhat";

/**
 * Deploy-time configuration read from the environment.
 *
 * These live here rather than inline in each script because both the full
 * `deploy-creditcoin.ts` and the single-contract `deploy-marketplace.ts`
 * construct the same contracts, and a fee that differed between the two would
 * be a silent mismatch — the kind you only discover after the addresses are
 * already live.
 */

/** Mirrors `PixelOrbitMarketplace.MAX_FEE_BIPS`; checked here so a bad value fails before it costs gas. */
const MAX_FEE_BIPS = 500;

/** Chosen when `MARKETPLACE_FEE_BIPS` is unset: 2.5%, comfortably under the cap. */
const DEFAULT_FEE_BIPS = 250;

export interface FeeConfig {
    feeBips: number;
    feeRecipient: string;
}

/**
 * Resolves the marketplace protocol fee.
 *
 * The recipient defaults to the deployer rather than the zero address: a nonzero
 * fee with no recipient is rejected by the constructor, and defaulting the fee
 * to zero instead would quietly ship a marketplace that never collects anything.
 */
export function resolveFeeConfig(deployerAddress: string): FeeConfig {
    const rawBips = process.env.MARKETPLACE_FEE_BIPS;
    const feeBips = rawBips === undefined ? DEFAULT_FEE_BIPS : Number(rawBips);

    if (!Number.isInteger(feeBips) || feeBips < 0) {
        throw new Error(`MARKETPLACE_FEE_BIPS must be a non-negative integer, got "${rawBips}"`);
    }
    if (feeBips > MAX_FEE_BIPS) {
        throw new Error(`MARKETPLACE_FEE_BIPS=${feeBips} exceeds the contract cap of ${MAX_FEE_BIPS}`);
    }

    const feeRecipient = process.env.MARKETPLACE_FEE_RECIPIENT ?? deployerAddress;
    if (!ethers.isAddress(feeRecipient)) {
        throw new Error(`MARKETPLACE_FEE_RECIPIENT is not an address: "${feeRecipient}"`);
    }
    if (feeBips > 0 && feeRecipient === ethers.ZeroAddress) {
        throw new Error("A nonzero fee needs a recipient; set MARKETPLACE_FEE_RECIPIENT");
    }

    return { feeBips, feeRecipient };
}

/**
 * Resolves the Stars token address a game contract constructor needs.
 *
 * Read from `STARS_ADDRESS` so single-contract deploys point at the same
 * StarsCC the full `deploy-creditcoin.ts` wired. Deliberately throws rather
 * than defaulting: deploying a Ship or Marketplace against the wrong Stars
 * token strands its economy, and a silent default is exactly the sort of
 * thing nobody revisits.
 */
export function resolveStarsAddress(): string {
    const stars = process.env.STARS_ADDRESS;
    if (stars && ethers.isAddress(stars)) return stars;

    throw new Error(
        "Set STARS_ADDRESS to the deployed OrbitStarsCC address before deploying",
    );
}
