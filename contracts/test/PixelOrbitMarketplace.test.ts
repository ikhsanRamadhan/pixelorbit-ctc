import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  MockERC20,
  PixelOrbitItem,
  PixelOrbitMarketplace,
  PixelOrbitShip,
} from "../typechain-types";

describe("PixelOrbitMarketplace", function () {
  let owner: SignerWithAddress;
  let seller: SignerWithAddress;
  let buyer: SignerWithAddress;
  let bidder1: SignerWithAddress;
  let bidder2: SignerWithAddress;
  let treasury: SignerWithAddress;
  let stars: MockERC20;
  let ship: PixelOrbitShip;
  let item: PixelOrbitItem;
  let marketplace: PixelOrbitMarketplace;

  const FIXED = 0; // ListingType.FixedPrice
  const AUCTION = 1; // ListingType.AscendingAuction
  const DAY = 24 * 3600;

  async function closeAuction(): Promise<void> {
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async function () {
    [owner, seller, buyer, bidder1, bidder2, treasury] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    stars = await MockERC20Factory.deploy("Orbit Stars", "STARS", 18);

    for (const who of [seller, buyer, bidder1, bidder2]) {
      await stars.mint(who.address, ethers.parseEther("1000"));
    }

    const PixelOrbitShipFactory = await ethers.getContractFactory("PixelOrbitShip");
    ship = await PixelOrbitShipFactory.deploy(await stars.getAddress());

    const PixelOrbitItemFactory = await ethers.getContractFactory("PixelOrbitItem");
    item = await PixelOrbitItemFactory.deploy();

    // Fee starts at zero so the sale-mechanics tests read as plain transfers;
    // the fee tests below turn it on explicitly.
    const PixelOrbitMarketplaceFactory = await ethers.getContractFactory(
      "PixelOrbitMarketplace",
    );
    marketplace = await PixelOrbitMarketplaceFactory.deploy(
      await stars.getAddress(),
      0,
      treasury.address,
    );

    // Owner seeds seller inventory via owner-only mint paths.
    await ship.mintShip(seller.address, 3); // Klaed -> tokenId 0
    await item.mintItem(seller.address, 11); // Zapper -> tokenId 0

    // Seller approves marketplace for ship and item NFTs.
    await ship.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);
    await item.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);

    // Buyer and bidders approve Stars to marketplace.
    for (const who of [buyer, bidder1, bidder2]) {
      await stars.connect(who).approve(await marketplace.getAddress(), ethers.parseEther("1000"));
    }
  });

  it("should reject a zero Stars address in the constructor", async function () {
    const Factory = await ethers.getContractFactory("PixelOrbitMarketplace");
    await expect(Factory.deploy(ethers.ZeroAddress, 0, treasury.address)).to.be.revertedWith(
      "Stars required",
    );
  });

  it("should list an NFT (fixed price)", async function () {
    await marketplace
      .connect(seller)
      .createListing(await ship.getAddress(), 0, ethers.parseEther("5"), FIXED, 0);
    const listing = await marketplace.getListing(0);
    expect(listing.seller).to.equal(seller.address);
    expect(listing.price).to.equal(ethers.parseEther("5"));
    expect(listing.isActive).to.equal(true);
    expect(await ship.ownerOf(0)).to.equal(await marketplace.getAddress());
  });

  it("should escrow the NFT for an ascending auction", async function () {
    await marketplace
      .connect(seller)
      .createListing(await ship.getAddress(), 0, ethers.parseEther("1"), AUCTION, 3600);
    const listing = await marketplace.getListing(0);
    expect(listing.listingType).to.equal(1n);
    expect(listing.auctionEndTime).to.be.greaterThan(0);
    expect(await ship.ownerOf(0)).to.equal(await marketplace.getAddress());
  });

  it("refuses a fixed-price purchase of an auction listing", async function () {
    await marketplace
      .connect(seller)
      .createListing(await ship.getAddress(), 0, ethers.parseEther("1"), AUCTION, 3600);
    await expect(marketplace.connect(buyer).buyItem(0)).to.be.revertedWith(
      "Not a fixed-price listing",
    );
  });

  it("bounds the auction duration at both ends", async function () {
    await expect(
      marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, ethers.parseEther("1"), AUCTION, 60),
    ).to.be.revertedWith("Auction too short");
    await expect(
      marketplace
        .connect(seller)
        .createListing(
          await ship.getAddress(),
          0,
          ethers.parseEther("1"),
          AUCTION,
          31 * DAY,
        ),
    ).to.be.revertedWith("Auction too long");
  });

  it("requires a reserve on an auction and forbids a duration on a fixed price", async function () {
    await expect(
      marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, 0, AUCTION, 3600),
    ).to.be.revertedWith("Reserve required");
    await expect(
      marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, ethers.parseEther("1"), FIXED, 3600),
    ).to.be.revertedWith("Duration only for auctions");
  });

  it("should revert if not owner", async function () {
    await expect(
      marketplace
        .connect(buyer)
        .createListing(await ship.getAddress(), 0, ethers.parseEther("5"), FIXED, 0),
    ).to.be.revertedWith("Not token owner");
  });

  it("should buy a listed item at fixed price", async function () {
    await marketplace
      .connect(seller)
      .createListing(await ship.getAddress(), 0, ethers.parseEther("5"), FIXED, 0);
    const sellerBalBefore = await stars.balanceOf(seller.address);
    await marketplace.connect(buyer).buyItem(0);
    expect(await ship.ownerOf(0)).to.equal(buyer.address);
    const sellerBalAfter = await stars.balanceOf(seller.address);
    expect(sellerBalAfter - sellerBalBefore).to.equal(ethers.parseEther("5"));
  });

  it("should cancel listing", async function () {
    await marketplace
      .connect(seller)
      .createListing(await ship.getAddress(), 0, ethers.parseEther("5"), FIXED, 0);
    await marketplace.connect(seller).cancelListing(0);
    expect(await ship.ownerOf(0)).to.equal(seller.address);
    const listing = await marketplace.getListing(0);
    expect(listing.isActive).to.equal(false);
  });

  it("should update price", async function () {
    await marketplace
      .connect(seller)
      .createListing(await ship.getAddress(), 0, ethers.parseEther("5"), FIXED, 0);
    await marketplace.connect(seller).updatePrice(0, ethers.parseEther("10"));
    const listing = await marketplace.getListing(0);
    expect(listing.price).to.equal(ethers.parseEther("10"));
  });

  it("should refuse a price update on an auction", async function () {
    await marketplace
      .connect(seller)
      .createListing(await ship.getAddress(), 0, ethers.parseEther("1"), AUCTION, 3600);
    await expect(
      marketplace.connect(seller).updatePrice(0, ethers.parseEther("10")),
    ).to.be.revertedWith("Not a fixed-price listing");
  });

  describe("ascending auction bidding", function () {
    const RESERVE = ethers.parseEther("10");

    async function openAuction(): Promise<bigint> {
      const id = await marketplace.nextListingId();
      await marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, RESERVE, AUCTION, 3600);
      return id;
    }

    it("accepts a first bid at the reserve and escrows Stars", async function () {
      const id = await openAuction();
      const bidderBefore = await stars.balanceOf(bidder1.address);
      await expect(marketplace.connect(bidder1).placeBid(id, RESERVE))
        .to.emit(marketplace, "BidPlaced")
        .withArgs(id, bidder1.address, RESERVE);
      const listing = await marketplace.getListing(id);
      expect(listing.highestBidder).to.equal(bidder1.address);
      expect(listing.highestBid).to.equal(RESERVE);
      expect(bidderBefore - (await stars.balanceOf(bidder1.address))).to.equal(RESERVE);
      expect(await stars.balanceOf(await marketplace.getAddress())).to.equal(RESERVE);
    });

    it("rejects a first bid below the reserve", async function () {
      const id = await openAuction();
      await expect(
        marketplace.connect(bidder1).placeBid(id, RESERVE - 1n),
      ).to.be.revertedWith("Below reserve");
    });

    it("requires each new bid to exceed the current highest", async function () {
      const id = await openAuction();
      await marketplace.connect(bidder1).placeBid(id, RESERVE);
      await expect(
        marketplace.connect(bidder2).placeBid(id, RESERVE),
      ).to.be.revertedWith("Bid too low");
      await expect(
        marketplace.connect(bidder2).placeBid(id, RESERVE - 1n),
      ).to.be.revertedWith("Bid too low");
      await marketplace.connect(bidder2).placeBid(id, RESERVE + 1n);
      const listing = await marketplace.getListing(id);
      expect(listing.highestBidder).to.equal(bidder2.address);
    });

    it("refunds the previous highest bidder immediately on outbid", async function () {
      const id = await openAuction();
      await marketplace.connect(bidder1).placeBid(id, RESERVE);
      const bidder1AfterFirst = await stars.balanceOf(bidder1.address);
      const higher = RESERVE + ethers.parseEther("5");
      await marketplace.connect(bidder2).placeBid(id, higher);
      // Previous bidder made whole again in the same flow.
      expect(await stars.balanceOf(bidder1.address)).to.equal(bidder1AfterFirst + RESERVE);
      // Marketplace holds only the current highest.
      expect(await stars.balanceOf(await marketplace.getAddress())).to.equal(higher);
    });

    it("refuses to let the seller bid on their own auction", async function () {
      const id = await openAuction();
      await stars.mint(seller.address, RESERVE);
      await stars.connect(seller).approve(await marketplace.getAddress(), RESERVE);
      await expect(marketplace.connect(seller).placeBid(id, RESERVE)).to.be.revertedWith(
        "Seller cannot bid",
      );
    });

    it("rejects a bid on a fixed-price listing", async function () {
      await marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, ethers.parseEther("5"), FIXED, 0);
      await expect(
        marketplace.connect(bidder1).placeBid(0, ethers.parseEther("5")),
      ).to.be.revertedWith("Not an auction");
    });

    it("rejects a bid after the auction closes", async function () {
      const id = await openAuction();
      await closeAuction();
      await expect(
        marketplace.connect(bidder1).placeBid(id, RESERVE),
      ).to.be.revertedWith("Auction closed");
    });
  });

  describe("ascending auction finalization", function () {
    const RESERVE = ethers.parseEther("10");

    async function openAuction(): Promise<bigint> {
      const id = await marketplace.nextListingId();
      await marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, RESERVE, AUCTION, 3600);
      return id;
    }

    it("finalizes with bids: NFT to winner, Stars minus fee to seller", async function () {
      await marketplace.setFeeConfig(200, treasury.address); // 2%
      const id = await openAuction();
      const first = RESERVE;
      const second = RESERVE + ethers.parseEther("5");
      await marketplace.connect(bidder1).placeBid(id, first);
      await marketplace.connect(bidder2).placeBid(id, second);
      await closeAuction();

      const sellerBefore = await stars.balanceOf(seller.address);
      const fee = (second * 200n) / 10_000n;
      await expect(marketplace.connect(buyer).finalizeAuction(id))
        .to.emit(marketplace, "AuctionFinalized")
        .withArgs(id, bidder2.address, second);
      expect(await ship.ownerOf(0)).to.equal(bidder2.address);
      expect(await stars.balanceOf(seller.address)).to.equal(sellerBefore + second - fee);
      expect(await stars.balanceOf(treasury.address)).to.equal(fee);
    });

    it("emits FeeCollected on an auction sale when the fee is nonzero", async function () {
      await marketplace.setFeeConfig(200, treasury.address);
      const id = await openAuction();
      await marketplace.connect(bidder1).placeBid(id, RESERVE);
      await closeAuction();
      const fee = (RESERVE * 200n) / 10_000n;
      await expect(marketplace.connect(buyer).finalizeAuction(id))
        .to.emit(marketplace, "FeeCollected")
        .withArgs(id, treasury.address, fee);
    });

    it("finalizes with no bids by returning the NFT to the seller", async function () {
      const id = await openAuction();
      await closeAuction();
      await expect(marketplace.connect(buyer).finalizeAuction(id))
        .to.emit(marketplace, "AuctionFinalized")
        .withArgs(id, ethers.ZeroAddress, 0);
      expect(await ship.ownerOf(0)).to.equal(seller.address);
      const listing = await marketplace.getListing(id);
      expect(listing.isActive).to.equal(false);
    });

    it("refuses to finalize before the auction ends", async function () {
      const id = await openAuction();
      await marketplace.connect(bidder1).placeBid(id, RESERVE);
      await expect(marketplace.connect(buyer).finalizeAuction(id)).to.be.revertedWith(
        "Auction still open",
      );
    });

    it("refuses to finalize twice", async function () {
      const id = await openAuction();
      await marketplace.connect(bidder1).placeBid(id, RESERVE);
      await closeAuction();
      await marketplace.connect(buyer).finalizeAuction(id);
      await expect(marketplace.connect(buyer).finalizeAuction(id)).to.be.revertedWith(
        "Listing not active",
      );
    });

    it("refuses to finalize a fixed-price listing", async function () {
      await marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, ethers.parseEther("5"), FIXED, 0);
      await expect(marketplace.connect(buyer).finalizeAuction(0)).to.be.revertedWith(
        "Not an auction",
      );
    });
  });

  describe("ascending auction cancellation", function () {
    const RESERVE = ethers.parseEther("10");

    it("lets the seller cancel an auction with zero bids", async function () {
      const id = await marketplace.nextListingId();
      await marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, RESERVE, AUCTION, 3600);
      await expect(marketplace.connect(seller).cancelListing(id))
        .to.emit(marketplace, "ListingCancelled")
        .withArgs(id);
      expect(await ship.ownerOf(0)).to.equal(seller.address);
    });

    it("refuses to cancel an auction once bids exist", async function () {
      const id = await marketplace.nextListingId();
      await marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, RESERVE, AUCTION, 3600);
      await marketplace.connect(bidder1).placeBid(id, RESERVE);
      await expect(marketplace.connect(seller).cancelListing(id)).to.be.revertedWith(
        "Auction has bids",
      );
    });

    it("refuses cancellation from anyone but the seller", async function () {
      await marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, ethers.parseEther("5"), FIXED, 0);
      await expect(marketplace.connect(buyer).cancelListing(0)).to.be.revertedWith("Only seller");
    });
  });

  describe("protocol fee", function () {
    const TWO_PERCENT = 200;

    beforeEach(async function () {
      await marketplace.setFeeConfig(TWO_PERCENT, treasury.address);
    });

    it("should split a fixed-price sale between seller and treasury", async function () {
      await marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, ethers.parseEther("5"), FIXED, 0);

      const sellerBefore = await stars.balanceOf(seller.address);
      const buyerBefore = await stars.balanceOf(buyer.address);
      await marketplace.connect(buyer).buyItem(0);

      const fee = ethers.parseEther("0.1"); // 2% of 5
      expect(await stars.balanceOf(seller.address)).to.equal(
        sellerBefore + ethers.parseEther("5") - fee,
      );
      expect(await stars.balanceOf(treasury.address)).to.equal(fee);
      // The buyer still pays exactly the listed price.
      expect(buyerBefore - (await stars.balanceOf(buyer.address))).to.equal(
        ethers.parseEther("5"),
      );
    });

    it("should emit FeeCollected on a sale", async function () {
      await marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, ethers.parseEther("5"), FIXED, 0);
      await expect(marketplace.connect(buyer).buyItem(0))
        .to.emit(marketplace, "FeeCollected")
        .withArgs(0, treasury.address, ethers.parseEther("0.1"));
    });

    it("should pay the seller in full when the fee is zero", async function () {
      await marketplace.setFeeConfig(0, treasury.address);
      await marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, ethers.parseEther("5"), FIXED, 0);

      const sellerBefore = await stars.balanceOf(seller.address);
      await expect(marketplace.connect(buyer).buyItem(0)).to.not.emit(
        marketplace,
        "FeeCollected",
      );

      expect(await stars.balanceOf(seller.address)).to.equal(
        sellerBefore + ethers.parseEther("5"),
      );
      expect(await stars.balanceOf(treasury.address)).to.equal(0);
    });

    it("should round the fee down so dust favours the seller", async function () {
      // 3 wei at 2% truncates to zero.
      await marketplace.connect(seller).createListing(await ship.getAddress(), 0, 3, FIXED, 0);
      expect(await marketplace.feeOn(3)).to.equal(0);

      const sellerBefore = await stars.balanceOf(seller.address);
      await marketplace.connect(buyer).buyItem(0);
      expect(await stars.balanceOf(seller.address)).to.equal(sellerBefore + 3n);
    });

    it("should reject a fee above the cap", async function () {
      const cap = await marketplace.MAX_FEE_BIPS();
      await expect(marketplace.setFeeConfig(cap + 1n, treasury.address)).to.be.revertedWith(
        "Fee above cap",
      );
      // The cap itself is allowed.
      await marketplace.setFeeConfig(cap, treasury.address);
      expect(await marketplace.feeBips()).to.equal(cap);
    });

    it("should reject a nonzero fee with no recipient", async function () {
      await expect(marketplace.setFeeConfig(TWO_PERCENT, ethers.ZeroAddress)).to.be.revertedWith(
        "Fee recipient required",
      );
    });

    it("should revert if a non-owner changes the fee", async function () {
      await expect(
        marketplace.connect(seller).setFeeConfig(0, seller.address),
      ).to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");
    });

    it("should apply the fee in force at settlement, not at listing", async function () {
      await marketplace
        .connect(seller)
        .createListing(await ship.getAddress(), 0, ethers.parseEther("5"), FIXED, 0);
      await marketplace.setFeeConfig(500, treasury.address); // raise to the 5% cap

      const sellerBefore = await stars.balanceOf(seller.address);
      await marketplace.connect(buyer).buyItem(0);

      const fee = ethers.parseEther("0.25");
      expect(await stars.balanceOf(seller.address)).to.equal(
        sellerBefore + ethers.parseEther("5") - fee,
      );
    });

    it("should reject a constructor fee above the cap", async function () {
      const Factory = await ethers.getContractFactory("PixelOrbitMarketplace");
      await expect(
        Factory.deploy(await stars.getAddress(), 501, treasury.address),
      ).to.be.revertedWith("Fee above cap");
    });
  });
});
