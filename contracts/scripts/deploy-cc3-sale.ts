import { ethers } from "hardhat";

import { resolveStarsAddress } from "./config";

/**
 * Creditcoin CC3 Stars sale deploy: StarsSaleCC3 against OrbitStarsCC.
 *
 * Run with:
 *   npx hardhat run scripts/deploy-cc3-sale.ts --network creditcoinTestnet
 *
 * Prerequisites in env:
 *   STARS_ADDRESS        — the OrbitStarsCC from deploy-creditcoin.ts, resolved
 *                            via config.ts (fail-fast when unset). Must not be
 *                            the zero address.
 *   PRICE_PER_STAR_WEI   — optional price in wei (tCTC) per whole Star.
 *                            Defaults to 10 ether, a nominal testnet price.
 *   SELL_PRICE_PER_STAR_WEI — optional sell-back price in wei (tCTC) per whole
 *                            Star. Defaults to 8 ether; must stay within
 *                            (0, PRICE_PER_STAR_WEI] so the spread never inverts.
 *
 * Post-deploy funding (the sale has NO mint rights and no mint path exists on
 * Creditcoin outside the ASC). Bridge Stars first, then fund from treasury:
 *   1. Lock Sepolia Stars via PixelOrbitSource.lock (owner/user side).
 *   2. Relay the proof through PixelOrbitASC so Stars mint to treasury.
 *   3. Treasury transfers bridged Stars to the sale:
 *        stars.transfer(<sale>, <wholeStars> * 1e18)
 * Plain transfers land in the implicit treasury shelf (buys draw it first);
 * use depositStars for consigned inventory instead.
 */
const DEFAULT_PRICE_PER_STAR_WEI = ethers.parseEther("10");
const DEFAULT_SELL_PRICE_PER_STAR_WEI = ethers.parseEther("8");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying StarsSaleCC3 to Creditcoin CC3 with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  const starsAddress = resolveStarsAddress();
  if (starsAddress === ethers.ZeroAddress) {
    throw new Error("STARS_ADDRESS must not be the zero address; set it to the deployed OrbitStarsCC");
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
  console.log("OrbitStarsCC:", starsAddress);
  console.log("Price per Star:", `${ethers.formatEther(pricePerStar)} tCTC`);

  const rawSell = process.env.SELL_PRICE_PER_STAR_WEI;
  let sellPricePerStar: bigint;
  try {
    sellPricePerStar = rawSell === undefined ? DEFAULT_SELL_PRICE_PER_STAR_WEI : BigInt(rawSell);
  } catch {
    throw new Error(`SELL_PRICE_PER_STAR_WEI must be an integer in wei, got "${rawSell}"`);
  }
  if (sellPricePerStar <= 0n || sellPricePerStar > pricePerStar) {
    throw new Error(
      `SELL_PRICE_PER_STAR_WEI must stay within (0, PRICE_PER_STAR_WEI], got "${rawSell}"`,
    );
  }
  console.log("Sell-back per Star:", `${ethers.formatEther(sellPricePerStar)} tCTC`);

  const Sale = await ethers.getContractFactory("StarsSaleCC3");
  const sale = await Sale.deploy(starsAddress, pricePerStar, sellPricePerStar);
  await sale.waitForDeployment();
  const saleAddr = await sale.getAddress();
  console.log("StarsSaleCC3 deployed to:", saleAddr);

  console.log("\n=== FUND THE SALE (bridge first — no mint path exists) ===");
  console.log("1. PixelOrbitSource.lock() Sepolia Stars for the treasury recipient");
  console.log("2. Relay the proof via PixelOrbitASC so Stars mint to treasury");
  console.log(`3. stars.transfer(${saleAddr}, <wholeStars> * 1e18) from treasury`);
  console.log("\n=== UPDATE .env.local ===");
  console.log(`NEXT_PUBLIC_CC_SALE_ADDRESS=${saleAddr}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
