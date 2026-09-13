import { ethers } from "hardhat";

/**
 * Lists every minted ship on a deployed PixelOrbitShip: owner, type, tokenURI.
 *
 * Read-only. Used before a redeploy to know exactly what has to be re-minted on
 * the new address, and after one to confirm the re-mint landed.
 *
 * Type names are read from the contract rather than hardcoded — a local list
 * drifts from the constructor and mislabels every row when it does.
 */
async function main() {
    const shipAddr = process.env.SHIP_ADDR ?? "0x95D2BC51d4Af8a9B4B3f4940077010B01e492B79";
    const ship = await ethers.getContractAt("PixelOrbitShip", shipAddr);
    console.log("Ship contract:", shipAddr);

    const typeCount = Number(await ship.getShipTypeCount());
    const names: string[] = [];
    for (let i = 0; i < typeCount; i++) {
        names.push((await ship.getShipType(i)).name);
    }
    console.log("Ship types:", names.join(", "));

    const supply = Number(await ship.totalSupply());
    console.log("Total ships minted:", supply);

    for (let i = 0; i < supply; i++) {
        const tokenId = await ship.tokenByIndex(i);
        const owner = await ship.ownerOf(tokenId);
        const typeIndex = Number(await ship.tokenShipType(tokenId));
        const uri = await ship.tokenURI(tokenId);
        console.log(`  #${tokenId}: owner=${owner} type=${typeIndex} (${names[typeIndex] ?? "?"})`);
        console.log(`      tokenURI=${uri}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
