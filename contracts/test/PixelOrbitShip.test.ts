import { expect } from "chai";
import { ethers } from "hardhat";
import type { Contract } from "ethers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { MockERC20, PixelOrbitShip } from "../typechain-types";

describe("PixelOrbitShip", function () {
  let ship: PixelOrbitShip;
  let stars: MockERC20;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let asc: SignerWithAddress;

  beforeEach(async function () {
    [owner, buyer, asc] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    stars = await MockERC20Factory.deploy("Orbit Stars", "STARS", 18);
    await stars.mint(buyer.address, ethers.parseEther("1000"));

    const PixelOrbitShipFactory = await ethers.getContractFactory("PixelOrbitShip");
    ship = await PixelOrbitShipFactory.deploy(await stars.getAddress());
  });

  it("should deploy with 4 ship types", async function () {
    expect(await ship.getShipTypeCount()).to.equal(4);
  });

  it("should reject a zero Stars address in the constructor", async function () {
    const PixelOrbitShipFactory = await ethers.getContractFactory("PixelOrbitShip");
    await expect(PixelOrbitShipFactory.deploy(ethers.ZeroAddress)).to.be.revertedWith(
      "Stars required",
    );
  });

  it("should return correct ship type 0 (Fighter, free)", async function () {
    const shipType = await ship.getShipType(0);
    expect(shipType.name).to.equal("Fighter");
    expect(shipType.price).to.equal(0);
  });

  it("should return Stars prices scaled to 18 decimals", async function () {
    expect(await ship.getShipStarsPrice(0)).to.equal(0);
    expect(await ship.getShipStarsPrice(1)).to.equal(ethers.parseEther("2"));
    expect(await ship.getShipStarsPrice(2)).to.equal(ethers.parseEther("5"));
    expect(await ship.getShipStarsPrice(3)).to.equal(ethers.parseEther("10"));
  });

  it("should buy free ship (Fighter) without Stars payment", async function () {
    await ship.connect(buyer).buyShip(0);
    expect(await ship.ownerOf(0)).to.equal(buyer.address);
  });

  it("should buy paid ship (Nautolan) with Stars payment", async function () {
    await stars.connect(buyer).approve(await ship.getAddress(), ethers.parseEther("2"));
    await expect(ship.connect(buyer).buyShip(1))
      .to.emit(ship, "ShipPurchased")
      .withArgs(buyer.address, 0, 1, ethers.parseEther("2"));
    expect(await ship.ownerOf(0)).to.equal(buyer.address);
    expect(await stars.balanceOf(await ship.getAddress())).to.equal(ethers.parseEther("2"));
  });

  it("should revert buyShip for an invalid ship type", async function () {
    await expect(ship.connect(buyer).buyShip(4)).to.be.revertedWith("Invalid ship type");
  });

  it("should mint ship as owner without payment", async function () {
    await ship.mintShip(buyer.address, 2);
    expect(await ship.ownerOf(0)).to.equal(buyer.address);
    expect((await ship.getShipStats(0)).hp).to.equal(5);
  });

  it("should revert if non-owner calls mintShip", async function () {
    await expect(ship.connect(buyer).mintShip(buyer.address, 0)).to.be.reverted;
  });

  it("should return tokenURI metadata", async function () {
    await ship.connect(buyer).buyShip(0);
    const uri = await ship.tokenURI(0);
    expect(uri).to.include("ipfs");
  });

  // The CIDs are opaque, so a transposed pair reads as correct in review and
  // only surfaces in a wallet or explorer. Pinning each one by name is the
  // cheapest way to catch a swap: a Nautolan token resolved to Nairan's JSON
  // on the original deploy for its whole lifetime.
  it("should give every ship type its own metadata URI", async function () {
    const cids = await Promise.all(
      [0, 1, 2, 3].map(async (i) => (await ship.getShipType(i)).metadataURI),
    );
    expect(new Set(cids).size).to.equal(4);
  });

  it("should point each ship type at the CID pinned for that ship", async function () {
    const expected: Record<string, string> = {
      Fighter: "QmYshoECpKXPq2S4XY4NEJWCbnFGzH4oWyGRsQzAZCjWaw",
      Nautolan: "Qmce5XchuEDbFszhxUEnGiSDMMtdXYqjuEg4G4VTv3iVjo",
      Nairan: "QmZ4xFmySfA3yoNX9ah7GWPzrz13jKf9WPdefAHiczaYK5",
      Klaed: "QmcSvBfPKNyJXmEhn2raDJGiivygMbtw7SsF5n32p51V4g",
    };

    for (let i = 0; i < 4; i++) {
      const shipType = await ship.getShipType(i);
      expect(shipType.metadataURI, `${shipType.name} metadataURI`).to.include(
        expected[shipType.name],
      );
    }
  });

  it("should let the owner repoint a ship type's metadata URI", async function () {
    const replacement = "https://example.invalid/ipfs/QmReplacement";
    await expect(ship.setShipMetadataURI(1, replacement))
      .to.emit(ship, "ShipMetadataUpdated")
      .withArgs(1, replacement);

    expect((await ship.getShipType(1)).metadataURI).to.equal(replacement);

    // Repointing metadata must not disturb stats or price.
    expect(await ship.getShipStarsPrice(1)).to.equal(ethers.parseEther("2"));
    expect((await ship.getShipType(1)).stats.hp).to.equal(4);
  });

  it("should reject metadata URI updates from non-owners and bad input", async function () {
    await expect(
      ship.connect(buyer).setShipMetadataURI(1, "https://example.invalid/x"),
    ).to.be.reverted;
    await expect(ship.setShipMetadataURI(4, "https://example.invalid/x")).to.be.revertedWith(
      "Invalid ship type",
    );
    await expect(ship.setShipMetadataURI(1, "")).to.be.revertedWith("Empty metadata URI");
  });

  it("should serve the updated URI to already-minted tokens", async function () {
    await ship.mintShip(buyer.address, 1);
    const replacement = "https://example.invalid/ipfs/QmFixed";
    await ship.setShipMetadataURI(1, replacement);
    expect(await ship.tokenURI(0)).to.equal(replacement);
  });

  it("should allow owner to withdraw Stars", async function () {
    await stars.connect(buyer).approve(await ship.getAddress(), ethers.parseEther("7"));
    await ship.connect(buyer).buyShip(1);
    await ship.connect(buyer).buyShip(2);
    const ownerBalanceBefore = await stars.balanceOf(owner.address);
    await ship.withdrawStars();
    const ownerBalanceAfter = await stars.balanceOf(owner.address);
    expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(ethers.parseEther("7"));
  });

  it("should track token ship type correctly", async function () {
    await stars.connect(buyer).approve(await ship.getAddress(), ethers.parseEther("10"));
    await ship.connect(buyer).buyShip(3);
    expect(await ship.tokenShipType(0)).to.equal(3);
  });

  it("should revert mintBridged when caller is not the ASC", async function () {
    await ship.setAsc(asc.address);
    await expect(ship.connect(buyer).mintBridged(buyer.address, 1)).to.be.revertedWith(
      "Only ASC",
    );
  });

  it("should let the ASC mintBridged and emit ShipMinted", async function () {
    await ship.setAsc(asc.address);
    await expect(ship.connect(asc).mintBridged(buyer.address, 1))
      .to.emit(ship, "ShipMinted")
      .withArgs(buyer.address, 0, 1);
    expect(await ship.ownerOf(0)).to.equal(buyer.address);
    expect(await ship.tokenShipType(0)).to.equal(1);
  });

  it("should revert mintBridged for an invalid ship type", async function () {
    await ship.setAsc(asc.address);
    await expect(ship.connect(asc).mintBridged(buyer.address, 4)).to.be.revertedWith(
      "Invalid ship type",
    );
  });

  it("should set the ASC and emit AscUpdated", async function () {
    await expect(ship.setAsc(asc.address))
      .to.emit(ship, "AscUpdated")
      .withArgs(asc.address);
    expect(await ship.asc()).to.equal(asc.address);
  });

  it("should revert setAsc for the zero address", async function () {
    await expect(ship.setAsc(ethers.ZeroAddress)).to.be.revertedWith("Invalid ASC");
  });

  it("should revert setAsc when called by a non-owner", async function () {
    await expect(ship.connect(buyer).setAsc(asc.address)).to.be.reverted;
  });
});

describe("PixelOrbitShip flash sale", function () {
  const PROXY = "0x694AA1769357215DE4FAC081bf1f309aDC325306";
  const SOURCE_CHAIN_KEY = 1n;
  const DAY = 24 * 3600;

  let ship: PixelOrbitShip;
  let stars: MockERC20;
  let oracle: string;
  let prover: Contract;
  let oracleContract: Contract;
  let buyer: SignerWithAddress;

  const ANSWER_UPDATED_SIG = ethers.id("AnswerUpdated(int256,uint256,uint256)");
  const ZERO_HASH = ethers.ZeroHash;
  const PROVEN_HEIGHT = 11686603n;

  function topic32(value: bigint): string {
    if (value >= 0n) {
      return ethers.zeroPadValue(ethers.toBeHex(value), 32);
    }
    return ethers.toBeHex((1n << 256n) + value, 32);
  }

  async function latestTimestamp(): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    if (block === null) throw new Error("missing latest block");
    return BigInt(block.timestamp);
  }

  function buildPriceTxBytes(answer: bigint, roundId: bigint, updatedAt: bigint): string {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const chunk0 = coder.encode(
      ["uint64", "uint64", "address", "bool", "address", "uint256", "bytes"],
      [0, 0, buyer.address, false, PROXY, 0, "0x"],
    );
    const chunk1 = coder.encode(
      ["uint64", "uint128", "uint128", "tuple(address account,bytes32[] storageKeys)[]", "uint8", "bytes32", "bytes32"],
      [11155111, 0, 0, [], 0, ethers.ZeroHash, ethers.ZeroHash],
    );
    const logData = coder.encode(["uint256"], [updatedAt]);
    const chunk2 = coder.encode(
      ["uint8", "uint64", "tuple(address addr,bytes32[] topics,bytes data)[]", "bytes"],
      [1, 0, [[PROXY, [ANSWER_UPDATED_SIG, topic32(answer), topic32(roundId)], logData]], "0x"],
    );
    return coder.encode(["uint8", "bytes[]"], [2, [chunk0, chunk1, chunk2]]);
  }

  async function setOraclePrice(answer: bigint, roundId: bigint, updatedAt: bigint) {
    const txBytes = buildPriceTxBytes(answer, roundId, updatedAt);
    await oracleContract.getFunction("updatePrice")(
      0,
      SOURCE_CHAIN_KEY,
      PROVEN_HEIGHT,
      txBytes,
      ZERO_HASH,
      [],
      ZERO_HASH,
      [],
    );
  }

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    const buyerSigner = signers[1];
    if (buyerSigner === undefined) throw new Error("missing signer");
    buyer = buyerSigner;
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const starsContract = await MockERC20Factory.deploy("Orbit Stars", "STARS", 18);
    stars = starsContract as unknown as MockERC20;
    await stars.mint(buyer.address, ethers.parseEther("1000"));

    const ShipFactory = await ethers.getContractFactory("PixelOrbitShip");
    const shipContract = await ShipFactory.deploy(await stars.getAddress());
    ship = shipContract as unknown as PixelOrbitShip;

    const ProverFactory = await ethers.getContractFactory("MockBlockProver");
    const proverContract = await ProverFactory.deploy();
    prover = proverContract as unknown as Contract;
    const OracleFactory = await ethers.getContractFactory("PixelOrbitPriceOracle");
    const deployedOracle = await OracleFactory.deploy(
      await prover.getAddress(),
      SOURCE_CHAIN_KEY,
      PROXY,
    );
    oracleContract = deployedOracle as unknown as Contract;
    oracle = await oracleContract.getAddress();
  });

  it("returns flat catalog prices while the oracle is unset", async function () {
    expect(await ship.getFunction("priceOracle")()).to.equal(ethers.ZeroAddress);
    expect(await ship.getShipStarsPrice(1)).to.equal(ethers.parseEther("2"));
    expect(await ship.getShipStarsPrice(2)).to.equal(ethers.parseEther("5"));
  });

  it("discounts 20 percent while the feed is fresh", async function () {
    await ship.getFunction("setPriceOracle")(oracle);
    await setOraclePrice(3000_00000000n, 1n, await latestTimestamp());
    expect(await ship.getShipStarsPrice(1)).to.equal(ethers.parseEther("1.6"));
    expect(await ship.getShipStarsPrice(2)).to.equal(ethers.parseEther("4"));
    expect(await ship.getShipStarsPrice(3)).to.equal(ethers.parseEther("8"));
  });

  it("keeps the free Fighter at 0 in both branches", async function () {
    expect(await ship.getShipStarsPrice(0)).to.equal(0);
    await ship.getFunction("setPriceOracle")(oracle);
    await setOraclePrice(3000_00000000n, 1n, await latestTimestamp());
    expect(await ship.getShipStarsPrice(0)).to.equal(0);
  });

  it("returns flat prices when the feed is stale beyond 24h", async function () {
    await ship.getFunction("setPriceOracle")(oracle);
    const now = await latestTimestamp();
    await setOraclePrice(3000_00000000n, 1n, now - BigInt(25 * 3600));
    expect(await ship.getShipStarsPrice(1)).to.equal(ethers.parseEther("2"));
  });

  it("holds the discount at exactly 24h and drops it 1s later", async function () {
    await ship.getFunction("setPriceOracle")(oracle);
    const now = await latestTimestamp();
    await setOraclePrice(3000_00000000n, 1n, now);
    // Just inside the freshness window the sale is still active (60s margin
    // absorbs the 1-2s mining delay between latestTimestamp and updatePrice).
    await ethers.provider.send("evm_increaseTime", [DAY - 60]);
    await ethers.provider.send("evm_mine", []);
    expect(await ship.getShipStarsPrice(1)).to.equal(ethers.parseEther("1.6"));
    // Just past the window the sale ends.
    await ethers.provider.send("evm_increaseTime", [121]);
    await ethers.provider.send("evm_mine", []);
    expect(await ship.getShipStarsPrice(1)).to.equal(ethers.parseEther("2"));
  });

  it("returns flat prices when the oracle is set but never updated", async function () {
    await ship.getFunction("setPriceOracle")(oracle);
    expect(await ship.getShipStarsPrice(1)).to.equal(ethers.parseEther("2"));
  });

  it("lets buyShip pay the discounted amount while the sale is active", async function () {
    await ship.getFunction("setPriceOracle")(oracle);
    await setOraclePrice(3000_00000000n, 1n, await latestTimestamp());
    await stars.connect(buyer).approve(await ship.getAddress(), ethers.parseEther("1.6"));
    await expect(ship.connect(buyer).buyShip(1))
      .to.emit(ship, "ShipPurchased")
      .withArgs(buyer.address, 0, 1, ethers.parseEther("1.6"));
    expect(await stars.balanceOf(await ship.getAddress())).to.equal(ethers.parseEther("1.6"));
  });

  it("charges the flat price when the sale has ended stale", async function () {
    await ship.getFunction("setPriceOracle")(oracle);
    const now = await latestTimestamp();
    await setOraclePrice(3000_00000000n, 1n, now - BigInt(25 * 3600));
    await stars.connect(buyer).approve(await ship.getAddress(), ethers.parseEther("2"));
    await expect(ship.connect(buyer).buyShip(1))
      .to.emit(ship, "ShipPurchased")
      .withArgs(buyer.address, 0, 1, ethers.parseEther("2"));
  });

  it("exposes the 20 percent / 24h sale constants", async function () {
    expect(await ship.getFunction("FLASH_SALE_DISCOUNT_BPS")()).to.equal(2000);
    expect(await ship.getFunction("PRICE_FRESHNESS_WINDOW")()).to.equal(DAY);
  });

  it("lets the owner set (and clear) the oracle, emitting PriceOracleUpdated", async function () {
    await expect(ship.getFunction("setPriceOracle")(oracle))
      .to.emit(ship, "PriceOracleUpdated")
      .withArgs(oracle);
    expect(await ship.getFunction("priceOracle")()).to.equal(oracle);
    await expect(ship.getFunction("setPriceOracle")(ethers.ZeroAddress))
      .to.emit(ship, "PriceOracleUpdated")
      .withArgs(ethers.ZeroAddress);
    expect(await ship.getFunction("priceOracle")()).to.equal(ethers.ZeroAddress);
  });

  it("reverts setPriceOracle for non-owners", async function () {
    await expect(ship.connect(buyer).getFunction("setPriceOracle")(oracle)).to.be.reverted;
  });

  it("returns flat price when the oracle is an EOA (no code)", async function () {
    await ship.getFunction("setPriceOracle")(buyer.address);
    expect(await ship.getShipStarsPrice(1)).to.equal(ethers.parseEther("2"));
    await stars.connect(buyer).approve(await ship.getAddress(), ethers.parseEther("2"));
    await expect(ship.connect(buyer).buyShip(1))
      .to.emit(ship, "ShipPurchased")
      .withArgs(buyer.address, 0, 1, ethers.parseEther("2"));
  });

  it("returns flat price when the oracle has no matching functions", async function () {
    await ship.getFunction("setPriceOracle")(await stars.getAddress());
    expect(await ship.getShipStarsPrice(1)).to.equal(ethers.parseEther("2"));
    await stars.connect(buyer).approve(await ship.getAddress(), ethers.parseEther("2"));
    await expect(ship.connect(buyer).buyShip(1))
      .to.emit(ship, "ShipPurchased")
      .withArgs(buyer.address, 0, 1, ethers.parseEther("2"));
  });

  it("returns flat price when the oracle reverts", async function () {
    const RevertingFactory = await ethers.getContractFactory("MockRevertingPriceOracle");
    const reverting = await RevertingFactory.deploy();
    await ship.getFunction("setPriceOracle")(await reverting.getAddress());
    expect(await ship.getShipStarsPrice(1)).to.equal(ethers.parseEther("2"));
    await stars.connect(buyer).approve(await ship.getAddress(), ethers.parseEther("2"));
    await expect(ship.connect(buyer).buyShip(1))
      .to.emit(ship, "ShipPurchased")
      .withArgs(buyer.address, 0, 1, ethers.parseEther("2"));
  });
});
