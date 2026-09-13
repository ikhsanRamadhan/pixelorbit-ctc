import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const Leaderboard = await ethers.getContractFactory("PixelOrbitLeaderboard");
  const leaderboard = await Leaderboard.deploy();
  await leaderboard.waitForDeployment();
  const addr = await leaderboard.getAddress();
  console.log("PixelOrbitLeaderboard deployed to:", addr);
  console.log(`NEXT_PUBLIC_LEADERBOARD_CONTRACT_ADDRESS=${addr}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
