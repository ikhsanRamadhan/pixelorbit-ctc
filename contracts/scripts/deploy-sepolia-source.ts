import { ethers } from "hardhat";

/**
 * Sepolia source deploy: StarsSepolia plus PixelOrbitSource.
 *
 * Run with:
 *   npx hardhat run scripts/deploy-sepolia-source.ts --network sepolia
 *
 * The deployer becomes the StarsSepolia owner (faucet-style test issuance via
 * mint). Prints both addresses: the source address feeds SOURCE_ADDRESS for
 * deploy-creditcoin.ts, and both feed the frontend env.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying to Sepolia with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  const Stars = await ethers.getContractFactory("StarsSepolia");
  const stars = await Stars.deploy();
  await stars.waitForDeployment();
  const starsAddr = await stars.getAddress();
  console.log("StarsSepolia deployed to:", starsAddr);

  const Source = await ethers.getContractFactory("PixelOrbitSource");
  const source = await Source.deploy(starsAddr);
  await source.waitForDeployment();
  const sourceAddr = await source.getAddress();
  console.log("PixelOrbitSource deployed to:", sourceAddr);

  console.log("\n=== UPDATE .env.local ===");
  console.log(`NEXT_PUBLIC_SOURCE_ADDRESS=${sourceAddr}`);
  console.log("\n=== FOR deploy-creditcoin.ts ===");
  console.log(`SOURCE_ADDRESS=${sourceAddr}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
