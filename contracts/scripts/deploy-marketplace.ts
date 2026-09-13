import { ethers } from "hardhat";

import { resolveFeeConfig, resolveStarsAddress } from "./config";

/**
 * Deploys only PixelOrbitMarketplace. Ship, Item, and Leaderboard are unchanged,
 * so redeploying them would orphan every player-owned NFT and reset the
 * leaderboard for no gain.
 *
 * STARS_ADDRESS must point at the deployed OrbitStarsCC: the constructor takes
 * (stars, feeBips, feeRecipient), and the deployer becomes the owner.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "tCTC");

  const stars = resolveStarsAddress();
  const { feeBips, feeRecipient } = resolveFeeConfig(deployer.address);
  console.log(`Stars: ${stars}`);
  console.log(`Fee: ${feeBips} bips -> ${feeRecipient}`);

  const Marketplace = await ethers.getContractFactory("PixelOrbitMarketplace");
  const marketplace = await Marketplace.deploy(stars, feeBips, feeRecipient);
  await marketplace.waitForDeployment();
  const addr = await marketplace.getAddress();

  console.log("\nPixelOrbitMarketplace deployed to:", addr);

  // Confirm the new bytecode carries the fee config and the Stars token.
  console.log("stars resolved to:", await marketplace.stars());
  console.log("owner:", await marketplace.owner());
  console.log("feeBips:", (await marketplace.feeBips()).toString());
  console.log("feeRecipient:", await marketplace.feeRecipient());
  console.log("listingCount:", (await marketplace.getListingCount()).toString());

  console.log("\n=== UPDATE .env.local ===");
  console.log(`NEXT_PUBLIC_MARKETPLACE_CONTRACT_ADDRESS=${addr}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
