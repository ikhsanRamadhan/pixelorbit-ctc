import { ethers } from "hardhat";

/**
 * Sepolia Stars sale deploy: StarsSale against an existing StarsSepolia.
 *
 * Run with:
 *   npx hardhat run scripts/deploy-stars-sale.ts --network sepolia
 *
 * Prerequisites in env:
 *   STARS_SEPOLIA_ADDRESS — the StarsSepolia from deploy-sepolia-source.ts.
 *                            Fail-fast: deploying a sale against the wrong
 *                            Stars token strands its inventory, so there is
 *                            no silent default.
 *   PRICE_PER_STAR_WEI   — optional price in wei per whole Star. Defaults to
 *                            0.0001 ether (1e14), a nominal testnet price.
 *
 * Post-deploy funding (the sale has NO mint rights; it only sells what it
 * holds). From the StarsSepolia owner account:
 *   stars.mint(<sale>, <wholeStars> * 1e18)
 */
const DEFAULT_PRICE_PER_STAR_WEI = ethers.parseEther("0.0001");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying StarsSale to Sepolia with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  const starsAddress = process.env.STARS_SEPOLIA_ADDRESS;
  if (!starsAddress || !ethers.isAddress(starsAddress)) {
    throw new Error(
      "Set STARS_SEPOLIA_ADDRESS to the deployed StarsSepolia address before deploying the sale",
    );
  }
  if (starsAddress === ethers.ZeroAddress) {
    throw new Error("STARS_SEPOLIA_ADDRESS must not be the zero address");
  }

  const rawPrice = process.env.PRICE_PER_STAR_WEI;
  let pricePerStar: bigint;
  try {
    pricePerStar = rawPrice === undefined ? DEFAULT_PRICE_PER_STAR_WEI : BigInt(rawPrice);
  } catch {
    throw new Error(`PRICE_PER_STAR_WEI must be an integer in wei, got "${rawPrice}"`);
  }
  if (pricePerStar <= 0n) {
    throw new Error(`PRICE_PER_STAR_WEI must be positive, got "${rawPrice}"`);
  }
  console.log("StarsSepolia:", starsAddress);
  console.log("Price per Star:", `${ethers.formatEther(pricePerStar)} ETH`);

  const Sale = await ethers.getContractFactory("StarsSale");
  const sale = await Sale.deploy(starsAddress, pricePerStar);
  await sale.waitForDeployment();
  const saleAddr = await sale.getAddress();
  console.log("StarsSale deployed to:", saleAddr);

  console.log("\n=== FUND THE SALE (StarsSepolia owner only) ===");
  console.log(`stars.mint(${saleAddr}, <wholeStars> * 1e18)`);
  console.log("\n=== UPDATE .env.local ===");
  console.log(`NEXT_PUBLIC_SALE_ADDRESS=${saleAddr}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
