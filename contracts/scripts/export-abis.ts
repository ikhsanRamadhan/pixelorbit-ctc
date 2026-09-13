import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const artifactsRoot = join(__dirname, "..", "artifacts");
const outputDir = join(__dirname, "..", "..", "src", "lib", "abis");

const contracts = [
  { name: "PixelOrbitShip", artifact: join("contracts", "PixelOrbitShip.sol", "PixelOrbitShip.json") },
  { name: "PixelOrbitItem", artifact: join("contracts", "PixelOrbitItem.sol", "PixelOrbitItem.json") },
  { name: "PixelOrbitMarketplace", artifact: join("contracts", "PixelOrbitMarketplace.sol", "PixelOrbitMarketplace.json") },
  { name: "PixelOrbitLeaderboard", artifact: join("contracts", "PixelOrbitLeaderboard.sol", "PixelOrbitLeaderboard.json") },
  { name: "OrbitStarsCC", artifact: join("attestcoin", "OrbitStarsCC.sol", "OrbitStarsCC.json") },
  { name: "StarsSepolia", artifact: join("attestcoin", "StarsSepolia.sol", "StarsSepolia.json") },
  { name: "PixelOrbitSource", artifact: join("attestcoin", "PixelOrbitSource.sol", "PixelOrbitSource.json") },
  { name: "PixelOrbitASC", artifact: join("attestcoin", "PixelOrbitASC.sol", "PixelOrbitASC.json") },
  { name: "PixelOrbitPriceOracle", artifact: join("attestcoin", "PixelOrbitPriceOracle.sol", "PixelOrbitPriceOracle.json") },
  { name: "StarsSale", artifact: join("attestcoin", "StarsSale.sol", "StarsSale.json") },
  { name: "StarsSaleCC3", artifact: join("attestcoin", "StarsSaleCC3.sol", "StarsSaleCC3.json") },
];

mkdirSync(outputDir, { recursive: true });

for (const { name, artifact } of contracts) {
  const artifactPath = join(artifactsRoot, artifact);
  const artifactJson = JSON.parse(readFileSync(artifactPath, "utf8"));

  const outputPath = join(outputDir, `${name}.abi.json`);
  writeFileSync(outputPath, JSON.stringify(artifactJson.abi, null, 2));
  console.log(`Exported ABI: ${name} → ${outputPath}`);
}

console.log("\nDone! ABIs exported to src/lib/abis/");
