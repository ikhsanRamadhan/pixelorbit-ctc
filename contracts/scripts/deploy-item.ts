import { ethers } from "hardhat";

/**
 * Deploys only PixelOrbitItem (zero-arg constructor). Ship, Marketplace, and
 * Leaderboard are unchanged, so redeploying them would orphan player-owned
 * assets for no gain.
 *
 * The deployer becomes the owner: wire the ASC with setAsc(ascAddress) and
 * the run signer with setRunSigner(signerAddress) afterwards. Existing items
 * live on the old contract — re-mint any player-owned items with
 * mintItem(owner, typeIndex) like the ship remint flow.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "tCTC");

  const Item = await ethers.getContractFactory("PixelOrbitItem");
  const item = await Item.deploy();
  await item.waitForDeployment();
  const addr = await item.getAddress();

  console.log("\nPixelOrbitItem deployed to:", addr);

  console.log("owner:", await item.owner());
  console.log("item type count:", (await item.getItemTypeCount()).toString());
  console.log("asc:", await item.asc());
  console.log("runSigner:", await item.runSigner());
  console.log("max crates per claim:", (await item.MAX_CRATES_PER_CLAIM()).toString());

  console.log("\n=== UPDATE .env.local ===");
  console.log(`NEXT_PUBLIC_ITEM_CONTRACT_ADDRESS=${addr}`);
  console.log("\nThen wire with setAsc(ascAddress) + setRunSigner(signerAddress),");
  console.log("and re-mint any items owned on the old contract with mintItem(owner, typeIndex).");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
