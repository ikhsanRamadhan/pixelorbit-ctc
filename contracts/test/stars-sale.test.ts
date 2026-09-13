import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { OrbitStarsCC, StarsSale, StarsSaleCC3, StarsSepolia } from "../typechain-types";

const ONE_STAR = ethers.parseEther("1");
const SEPOLIA_PRICE = ethers.parseEther("0.0001"); // 1e14 wei per whole Star
const CC3_PRICE = ethers.parseEther("10"); // nominal tCTC starter price
const CC3_SELL = ethers.parseEther("8"); // nominal tCTC sell-back price (spread stays in the pool)
const SALE_INVENTORY = 1000n; // whole Stars used to fund each sale in beforeEach

describe("StarsSale (Sepolia ETH door)", function () {
  let stars: StarsSepolia;
  let sale: StarsSale;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let other: SignerWithAddress;

  beforeEach(async function () {
    [owner, buyer, other] = await ethers.getSigners();

    const StarsFactory = await ethers.getContractFactory("StarsSepolia");
    stars = await StarsFactory.deploy();
    await stars.waitForDeployment();

    const SaleFactory = await ethers.getContractFactory("StarsSale");
    sale = await SaleFactory.deploy(await stars.getAddress(), SEPOLIA_PRICE);
    await sale.waitForDeployment();

    await stars.mint(await sale.getAddress(), SALE_INVENTORY * ONE_STAR);
  });

  it("rejects a zero Stars address in the constructor", async function () {
    const SaleFactory = await ethers.getContractFactory("StarsSale");
    await expect(SaleFactory.deploy(ethers.ZeroAddress, SEPOLIA_PRICE)).to.be.revertedWith(
      "Stars required",
    );
  });

  it("rejects a zero price in the constructor", async function () {
    const SaleFactory = await ethers.getContractFactory("StarsSale");
    await expect(SaleFactory.deploy(await stars.getAddress(), 0)).to.be.revertedWith("Bad price");
  });

  it("sells Stars for exact payment and emits StarsPurchased", async function () {
    const amount = 3n;
    await expect(sale.connect(buyer).buy(amount, { value: amount * SEPOLIA_PRICE }))
      .to.emit(sale, "StarsPurchased")
      .withArgs(buyer.address, amount, amount * SEPOLIA_PRICE);
    expect(await stars.balanceOf(buyer.address)).to.equal(amount * ONE_STAR);
  });

  it("reverts on underpayment", async function () {
    await expect(
      sale.connect(buyer).buy(2, { value: SEPOLIA_PRICE }),
    ).to.be.revertedWith("Wrong payment");
  });

  it("reverts on overpayment (no change logic)", async function () {
    await expect(
      sale.connect(buyer).buy(1, { value: SEPOLIA_PRICE * 2n }),
    ).to.be.revertedWith("Wrong payment");
  });

  it("reverts on zero starAmount", async function () {
    await expect(sale.connect(buyer).buy(0, { value: 0 })).to.be.revertedWith("Zero amount");
  });

  it("reverts above MAX_PER_TX", async function () {
    expect(await sale.MAX_PER_TX()).to.equal(100);
    await expect(
      sale.connect(buyer).buy(101, { value: 101n * SEPOLIA_PRICE }),
    ).to.be.revertedWith("Over max per tx");
  });

  it("reverts when the sale inventory is sold out", async function () {
    const SmallSaleFactory = await ethers.getContractFactory("StarsSale");
    const small = await SmallSaleFactory.deploy(await stars.getAddress(), SEPOLIA_PRICE);
    await small.waitForDeployment();
    await stars.mint(await small.getAddress(), 2n * ONE_STAR);
    await expect(
      small.connect(buyer).buy(3, { value: 3n * SEPOLIA_PRICE }),
    ).to.be.revertedWithCustomError(stars, "ERC20InsufficientBalance");
  });

  it("lets the owner update the price and emits PriceUpdated", async function () {
    const next = SEPOLIA_PRICE * 2n;
    await expect(sale.setPrice(next))
      .to.emit(sale, "PriceUpdated")
      .withArgs(SEPOLIA_PRICE, next);
    expect(await sale.pricePerStar()).to.equal(next);
    // The new price applies to the next buy.
    await expect(sale.connect(buyer).buy(1, { value: SEPOLIA_PRICE })).to.be.revertedWith(
      "Wrong payment",
    );
    await sale.connect(buyer).buy(1, { value: next });
    expect(await stars.balanceOf(buyer.address)).to.equal(ONE_STAR);
  });

  it("reverts setPrice for non-owners and zero prices", async function () {
    await expect(sale.connect(buyer).setPrice(SEPOLIA_PRICE)).to.be.reverted;
    await expect(sale.setPrice(0)).to.be.revertedWith("Bad price");
  });

  it("lets the owner withdraw ETH and emits ETHWithdrawn", async function () {
    await sale.connect(buyer).buy(2, { value: 2n * SEPOLIA_PRICE });
    const proceeds = 2n * SEPOLIA_PRICE;
    await expect(sale.withdrawETH(other.address))
      .to.emit(sale, "ETHWithdrawn")
      .withArgs(other.address, proceeds);
    expect(await other.address).to.not.equal(ethers.ZeroAddress);
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(0);
  });

  it("reverts ETH withdraws for non-owners and zero recipients", async function () {
    await sale.connect(buyer).buy(1, { value: SEPOLIA_PRICE });
    await expect(sale.connect(buyer).withdrawETH(other.address)).to.be.reverted;
    await expect(sale.withdrawETH(ethers.ZeroAddress)).to.be.revertedWith("Bad recipient");
  });

  it("lets the owner rescue unsold Stars to an explicit address", async function () {
    await expect(sale.withdrawStars(other.address, 10n * ONE_STAR))
      .to.emit(sale, "StarsWithdrawn")
      .withArgs(other.address, 10n * ONE_STAR);
    expect(await stars.balanceOf(other.address)).to.equal(10n * ONE_STAR);
  });

  it("reverts Stars rescue for non-owners and zero recipients", async function () {
    await expect(sale.connect(buyer).withdrawStars(other.address, ONE_STAR)).to.be.reverted;
    await expect(sale.withdrawStars(ethers.ZeroAddress, ONE_STAR)).to.be.revertedWith(
      "Bad recipient",
    );
  });
});

describe("StarsSaleCC3 (Creditcoin tCTC door)", function () {
  let starsCC: OrbitStarsCC;
  let sale: StarsSaleCC3;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let other: SignerWithAddress;

  beforeEach(async function () {
    [owner, buyer, other] = await ethers.getSigners();

    const StarsCCFactory = await ethers.getContractFactory("OrbitStarsCC");
    starsCC = await StarsCCFactory.deploy();
    await starsCC.waitForDeployment();
    // Tests fund the sale the only way anyone can without the ASC: the test
    // owner acts as minter. Live, inventory comes from bridged Stars only.
    await starsCC.setMinter(owner.address);

    const SaleFactory = await ethers.getContractFactory("StarsSaleCC3");
    sale = await SaleFactory.deploy(await starsCC.getAddress(), CC3_PRICE, CC3_SELL);
    await sale.waitForDeployment();

    await starsCC.mint(await sale.getAddress(), SALE_INVENTORY * ONE_STAR);
  });

  it("rejects a zero Stars address in the constructor", async function () {
    const SaleFactory = await ethers.getContractFactory("StarsSaleCC3");
    await expect(
      SaleFactory.deploy(ethers.ZeroAddress, CC3_PRICE, CC3_SELL),
    ).to.be.revertedWith("Stars required");
  });

  it("rejects a zero price in the constructor", async function () {
    const SaleFactory = await ethers.getContractFactory("StarsSaleCC3");
    await expect(
      SaleFactory.deploy(await starsCC.getAddress(), 0, CC3_SELL),
    ).to.be.revertedWith("Bad price");
  });

  it("sells Stars for exact tCTC payment and emits StarsPurchased", async function () {
    const amount = 2n;
    await expect(sale.connect(buyer).buy(amount, { value: amount * CC3_PRICE }))
      .to.emit(sale, "StarsPurchased")
      .withArgs(buyer.address, amount, amount * CC3_PRICE);
    expect(await starsCC.balanceOf(buyer.address)).to.equal(amount * ONE_STAR);
  });

  it("reverts on underpayment and overpayment", async function () {
    await expect(sale.connect(buyer).buy(2, { value: CC3_PRICE })).to.be.revertedWith(
      "Wrong payment",
    );
    await expect(sale.connect(buyer).buy(1, { value: CC3_PRICE * 2n })).to.be.revertedWith(
      "Wrong payment",
    );
  });

  it("reverts on zero starAmount", async function () {
    await expect(sale.connect(buyer).buy(0, { value: 0 })).to.be.revertedWith("Zero amount");
  });

  it("places no lifetime cap: repeat buys beyond the old 5-Stars bound succeed", async function () {
    await sale.connect(buyer).buy(3, { value: 3n * CC3_PRICE });
    await sale.connect(buyer).buy(3, { value: 3n * CC3_PRICE });
    await sale.connect(buyer).buy(2, { value: 2n * CC3_PRICE });
    expect(await starsCC.balanceOf(buyer.address)).to.equal(8n * ONE_STAR);
  });

  it("lets two addresses buy freely with no per-address bound", async function () {
    await sale.connect(buyer).buy(20, { value: 20n * CC3_PRICE });
    await sale.connect(other).buy(20, { value: 20n * CC3_PRICE });
    expect(await starsCC.balanceOf(other.address)).to.equal(20n * ONE_STAR);
  });

  it("reverts when the sale inventory is sold out", async function () {
    const SmallSaleFactory = await ethers.getContractFactory("StarsSaleCC3");
    const small = await SmallSaleFactory.deploy(
      await starsCC.getAddress(),
      CC3_PRICE,
      CC3_SELL,
    );
    await small.waitForDeployment();
    await starsCC.mint(await small.getAddress(), 2n * ONE_STAR);
    await expect(
      small.connect(buyer).buy(3, { value: 3n * CC3_PRICE }),
    ).to.be.revertedWithCustomError(starsCC, "ERC20InsufficientBalance");
  });

  it("lets the owner update the price and applies it to the next buy", async function () {
    const next = CC3_PRICE * 2n;
    await expect(sale.setPrice(next))
      .to.emit(sale, "PriceUpdated")
      .withArgs(CC3_PRICE, next);
    await expect(sale.connect(buyer).buy(1, { value: CC3_PRICE })).to.be.revertedWith(
      "Wrong payment",
    );
    await sale.connect(buyer).buy(1, { value: next });
    expect(await starsCC.balanceOf(buyer.address)).to.equal(ONE_STAR);
  });

  it("reverts setPrice for non-owners and zero prices", async function () {
    await expect(sale.connect(buyer).setPrice(CC3_PRICE)).to.be.reverted;
    await expect(sale.setPrice(0)).to.be.revertedWith("Bad price");
  });

  it("lets the owner withdraw funds via withdrawFunds and emits FundsWithdrawn", async function () {
    await sale.connect(buyer).buy(2, { value: 2n * CC3_PRICE });
    const proceeds = 2n * CC3_PRICE;
    await expect(sale.withdrawFunds(other.address))
      .to.emit(sale, "FundsWithdrawn")
      .withArgs(other.address, proceeds);
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(0);
  });

  it("reverts fund withdraws for non-owners and zero recipients", async function () {
    await sale.connect(buyer).buy(1, { value: CC3_PRICE });
    await expect(sale.connect(buyer).withdrawFunds(other.address)).to.be.reverted;
    await expect(sale.withdrawFunds(ethers.ZeroAddress)).to.be.revertedWith("Bad recipient");
  });

  it("lets the owner rescue unsold Stars to an explicit address", async function () {
    await expect(sale.withdrawStars(other.address, 10n * ONE_STAR))
      .to.emit(sale, "StarsWithdrawn")
      .withArgs(other.address, 10n * ONE_STAR);
    expect(await starsCC.balanceOf(other.address)).to.equal(10n * ONE_STAR);
  });

  it("reverts Stars rescue for non-owners and zero recipients", async function () {
    await expect(sale.connect(buyer).withdrawStars(other.address, ONE_STAR)).to.be.reverted;
    await expect(sale.withdrawStars(ethers.ZeroAddress, ONE_STAR)).to.be.revertedWith(
      "Bad recipient",
    );
  });
});

describe("StarsSaleCC3 — consignment + two-way market", function () {
  const BUY_PRICE = ethers.parseEther("10");
  const SELL_PRICE = ethers.parseEther("8");
  let starsCC: OrbitStarsCC;
  let sale: StarsSaleCC3;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;
  let depositorA: SignerWithAddress;
  let depositorB: SignerWithAddress;
  let outsider: SignerWithAddress;

  beforeEach(async function () {
    [owner, buyer, depositorA, depositorB, outsider] = await ethers.getSigners();

    const StarsCCFactory = await ethers.getContractFactory("OrbitStarsCC");
    starsCC = await StarsCCFactory.deploy();
    await starsCC.waitForDeployment();
    await starsCC.setMinter(owner.address);

    // GREEN: 3-arg deploy (buy=10, sell=8) matching the v2 constructor.
    const SaleFactory = await ethers.getContractFactory("StarsSaleCC3");
    sale = await SaleFactory.deploy(await starsCC.getAddress(), BUY_PRICE, SELL_PRICE);
    await sale.waitForDeployment();

    await starsCC.mint(await sale.getAddress(), SALE_INVENTORY * ONE_STAR);
  });

  it("constructor reverts Bad spread when sell price is zero", async function () {
    const F = await ethers.getContractFactory("StarsSaleCC3");
    await expect((F as any).deploy(await starsCC.getAddress(), BUY_PRICE, 0)).to.be.revertedWith(
      "Bad spread",
    );
  });

  it("constructor reverts Bad spread when sell price exceeds buy price", async function () {
    const F = await ethers.getContractFactory("StarsSaleCC3");
    await expect(
      (F as any).deploy(
        await starsCC.getAddress(),
        BUY_PRICE,
        BUY_PRICE + ethers.parseEther("1"),
      ),
    ).to.be.revertedWith("Bad spread");
  });

  it("exposes sellPricePerStar set at deployment", async function () {
    const F = await ethers.getContractFactory("StarsSaleCC3");
    const fresh = await (F as any).deploy(await starsCC.getAddress(), BUY_PRICE, SELL_PRICE);
    await fresh.waitForDeployment();
    expect(await (fresh as any).sellPricePerStar()).to.equal(SELL_PRICE);
  });

  it("lets the owner update the sell price and emits PriceUpdated", async function () {
    const old = await (sale as any).sellPricePerStar();
    const next = ethers.parseEther("9");
    await expect((sale as any).setSellPrice(next))
      .to.emit(sale, "PriceUpdated")
      .withArgs(old, next);
    expect(await (sale as any).sellPricePerStar()).to.equal(next);
  });

  it("reverts setSellPrice on zero (Bad price)", async function () {
    await expect((sale as any).setSellPrice(0)).to.be.revertedWith("Bad price");
  });

  it("reverts setSellPrice above the buy price (Bad spread)", async function () {
    await expect((sale as any).setSellPrice(BUY_PRICE + 1n)).to.be.revertedWith("Bad spread");
  });

  it("reverts setSellPrice for non-owners", async function () {
    await expect((sale as any).connect(buyer).setSellPrice(SELL_PRICE)).to.be.reverted;
  });

  it("reverts setPrice below the sell price (Bad spread)", async function () {
    const sell = await (sale as any).sellPricePerStar();
    await expect(sale.setPrice(sell - 1n)).to.be.revertedWith("Bad spread");
  });

  it("sellStars happy path pays seller, moves Stars, emits StarsSold, leaves cap untouched", async function () {
    const seller = depositorA;
    const starAmount = 2n;
    const payout = starAmount * SELL_PRICE;
    await starsCC.mint(seller.address, starAmount * ONE_STAR);
    await starsCC.connect(seller).approve(await sale.getAddress(), starAmount * ONE_STAR);
    await sale.connect(buyer).buy(2, { value: 2n * BUY_PRICE });
    const saleStarsBefore = await starsCC.balanceOf(await sale.getAddress());
    const poolBefore = await ethers.provider.getBalance(await sale.getAddress());
    await expect((sale as any).connect(seller).sellStars(starAmount))
      .to.emit(sale, "StarsSold")
      .withArgs(seller.address, starAmount, payout);
    expect(await starsCC.balanceOf(await sale.getAddress())).to.equal(
      saleStarsBefore + starAmount * ONE_STAR,
    );
    expect(await starsCC.balanceOf(seller.address)).to.equal(0);
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(poolBefore - payout);
  });

  it("sellStars reverts Zero amount on 0", async function () {
    await expect((sale as any).connect(depositorA).sellStars(0)).to.be.revertedWith(
      "Zero amount",
    );
  });

  it("sellStars reverts Empty pool when contract tCTC cannot cover payout", async function () {
    const seller = depositorA;
    await starsCC.mint(seller.address, ONE_STAR);
    await starsCC.connect(seller).approve(await sale.getAddress(), ONE_STAR);
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(0);
    await expect((sale as any).connect(seller).sellStars(1)).to.be.revertedWith("Empty pool");
  });

  it("sellStars reverts without prior Stars allowance", async function () {
    const seller = depositorA;
    await starsCC.mint(seller.address, ONE_STAR);
    await sale.connect(buyer).buy(1, { value: BUY_PRICE });
    await expect((sale as any).connect(seller).sellStars(1)).to.be.reverted;
  });

  it("sellStars reverts Empty pool when the payout would eat into owed proceeds", async function () {
    // Depositor A consigns 2 Stars; the owner clears the treasury shelf so the
    // next buy fills the lot and every tCTC in the contract is owed.
    await starsCC.mint(depositorA.address, 2n * ONE_STAR);
    await starsCC.connect(depositorA).approve(await sale.getAddress(), 2n * ONE_STAR);
    await (sale as any).connect(depositorA).depositStars(2);
    await (sale as any).withdrawStars(owner.address, SALE_INVENTORY * ONE_STAR);
    await sale.connect(buyer).buy(2, { value: 2n * BUY_PRICE });
    expect(await (sale as any).totalProceedsOwed()).to.equal(2n * BUY_PRICE);
    // Gross balance covers a 1-Star payout, but the free pool is zero.
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(2n * BUY_PRICE);
    await starsCC.mint(outsider.address, ONE_STAR);
    await starsCC.connect(outsider).approve(await sale.getAddress(), ONE_STAR);
    await expect((sale as any).connect(outsider).sellStars(1)).to.be.revertedWith("Empty pool");
    // Owed money is untouched and still withdrawable.
    await expect((sale as any).connect(depositorA).withdrawProceeds()).to.emit(
      sale,
      "ProceedsWithdrawn",
    );
  });

  it("sellStars spends only free spread while owed proceeds stay withdrawable", async function () {
    // One treasury buy seeds 10 tCTC of free pool; then the shelf is cleared
    // so a 2-Star lot fill accrues 20 tCTC owed on top of it.
    await sale.connect(buyer).buy(1, { value: BUY_PRICE });
    await starsCC.mint(depositorA.address, 2n * ONE_STAR);
    await starsCC.connect(depositorA).approve(await sale.getAddress(), 2n * ONE_STAR);
    await (sale as any).connect(depositorA).depositStars(2);
    await (sale as any).withdrawStars(owner.address, (SALE_INVENTORY - 1n) * ONE_STAR);
    await sale.connect(buyer).buy(2, { value: 2n * BUY_PRICE });
    expect(await (sale as any).totalProceedsOwed()).to.equal(2n * BUY_PRICE);
    // Free pool is 10 tCTC: a 1-Star sell (8 tCTC) lands, a 2-Star sell (16) reverts.
    await starsCC.mint(outsider.address, ONE_STAR);
    await starsCC.connect(outsider).approve(await sale.getAddress(), ONE_STAR);
    await expect((sale as any).connect(outsider).sellStars(1))
      .to.emit(sale, "StarsSold")
      .withArgs(outsider.address, 1, SELL_PRICE);
    expect(await (sale as any).totalProceedsOwed()).to.equal(2n * BUY_PRICE);
    await (sale as any).connect(depositorA).withdrawProceeds();
    expect(await (sale as any).totalProceedsOwed()).to.equal(0);
  });

  it("depositStars pulls escrow, tracks consigned, emits StarsDeposited lotId 0", async function () {
    const depositor = depositorA;
    const starAmount = 3n;
    await starsCC.mint(depositor.address, starAmount * ONE_STAR);
    await starsCC.connect(depositor).approve(await sale.getAddress(), starAmount * ONE_STAR);
    await expect((sale as any).connect(depositor).depositStars(starAmount))
      .to.emit(sale, "StarsDeposited")
      .withArgs(depositor.address, starAmount, 0);
    expect(await (sale as any).consigned(depositor.address)).to.equal(starAmount);
    expect(await starsCC.balanceOf(depositor.address)).to.equal(0);
  });

  it("depositStars reverts Zero amount on 0", async function () {
    await expect((sale as any).connect(depositorA).depositStars(0)).to.be.revertedWith(
      "Zero amount",
    );
  });

  it("cancelConsignment refunds escrow and emits ConsignmentCancelled", async function () {
    const depositor = depositorA;
    const starAmount = 2n;
    await starsCC.mint(depositor.address, starAmount * ONE_STAR);
    await starsCC.connect(depositor).approve(await sale.getAddress(), starAmount * ONE_STAR);
    await (sale as any).connect(depositor).depositStars(starAmount);
    await expect((sale as any).connect(depositor).cancelConsignment(0))
      .to.emit(sale, "ConsignmentCancelled")
      .withArgs(depositor.address, 0, starAmount);
    expect(await (sale as any).consigned(depositor.address)).to.equal(0);
    expect(await starsCC.balanceOf(depositor.address)).to.equal(starAmount * ONE_STAR);
  });

  it("cancelConsignment reverts Not lot owner for non-owner", async function () {
    await starsCC.mint(depositorA.address, ONE_STAR);
    await starsCC.connect(depositorA).approve(await sale.getAddress(), ONE_STAR);
    await (sale as any).connect(depositorA).depositStars(1);
    await expect((sale as any).connect(depositorB).cancelConsignment(0)).to.be.revertedWith(
      "Not lot owner",
    );
  });

  it("cancelConsignment reverts Lot empty on double-cancel", async function () {
    await starsCC.mint(depositorA.address, ONE_STAR);
    await starsCC.connect(depositorA).approve(await sale.getAddress(), ONE_STAR);
    await (sale as any).connect(depositorA).depositStars(1);
    await (sale as any).connect(depositorA).cancelConsignment(0);
    await expect((sale as any).connect(depositorA).cancelConsignment(0)).to.be.revertedWith(
      "Lot empty",
    );
  });

  it("buy fills treasury stock first before touching consignments", async function () {
    await starsCC.mint(depositorA.address, 3n * ONE_STAR);
    await starsCC.connect(depositorA).approve(await sale.getAddress(), 3n * ONE_STAR);
    await (sale as any).connect(depositorA).depositStars(3);
    await sale.connect(buyer).buy(2, { value: 2n * BUY_PRICE });
    expect(await (sale as any).consigned(depositorA.address)).to.equal(3);
    expect(await (sale as any).proceeds(depositorA.address)).to.equal(0);
    expect(await (sale as any).totalProceedsOwed()).to.equal(0);
  });

  it("buy fills oldest lots FIFO across two depositors with partial-lot fill", async function () {
    const amountA = 2n;
    const amountB = 3n;
    await starsCC.mint(depositorA.address, amountA * ONE_STAR);
    await starsCC.connect(depositorA).approve(await sale.getAddress(), amountA * ONE_STAR);
    await starsCC.mint(depositorB.address, amountB * ONE_STAR);
    await starsCC.connect(depositorB).approve(await sale.getAddress(), amountB * ONE_STAR);
    await (sale as any).connect(depositorA).depositStars(amountA);
    await (sale as any).connect(depositorB).depositStars(amountB);
    await sale.withdrawStars(outsider.address, SALE_INVENTORY * ONE_STAR);
    const buyAmount = 4n;
    await expect(sale.connect(buyer).buy(buyAmount, { value: buyAmount * BUY_PRICE }))
      .to.emit(sale, "ConsignmentFilled")
      .withArgs(0, depositorA.address, amountA)
      .and.to.emit(sale, "ConsignmentFilled")
      .withArgs(1, depositorB.address, 2n);
    expect(await starsCC.balanceOf(buyer.address)).to.equal(buyAmount * ONE_STAR);
    expect(await (sale as any).consigned(depositorA.address)).to.equal(0);
    expect(await (sale as any).consigned(depositorB.address)).to.equal(1);
    expect(await (sale as any).proceeds(depositorA.address)).to.equal(amountA * BUY_PRICE);
    expect(await (sale as any).proceeds(depositorB.address)).to.equal(2n * BUY_PRICE);
    expect(await (sale as any).totalProceedsOwed()).to.equal(buyAmount * BUY_PRICE);
  });

  it("proceeds accounting feeds withdrawProceeds happy path with ProceedsWithdrawn", async function () {
    await starsCC.mint(depositorA.address, 2n * ONE_STAR);
    await starsCC.connect(depositorA).approve(await sale.getAddress(), 2n * ONE_STAR);
    await (sale as any).connect(depositorA).depositStars(2);
    await sale.withdrawStars(outsider.address, SALE_INVENTORY * ONE_STAR);
    await sale.connect(buyer).buy(2, { value: 2n * BUY_PRICE });
    const expected = 2n * BUY_PRICE;
    expect(await (sale as any).proceeds(depositorA.address)).to.equal(expected);
    expect(await (sale as any).totalProceedsOwed()).to.equal(expected);
    await expect((sale as any).connect(depositorA).withdrawProceeds())
      .to.emit(sale, "ProceedsWithdrawn")
      .withArgs(depositorA.address, expected);
    expect(await (sale as any).proceeds(depositorA.address)).to.equal(0);
    expect(await (sale as any).totalProceedsOwed()).to.equal(0);
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(0);
  });

  it("withdrawProceeds reverts No proceeds with nothing owed", async function () {
    await expect((sale as any).connect(depositorA).withdrawProceeds()).to.be.revertedWith(
      "No proceeds",
    );
  });

  it("withdrawFunds leaves owed proceeds and reverts No free funds when none free", async function () {
    await starsCC.mint(depositorA.address, 2n * ONE_STAR);
    await starsCC.connect(depositorA).approve(await sale.getAddress(), 2n * ONE_STAR);
    await (sale as any).connect(depositorA).depositStars(2);
    await sale.connect(buyer).buy(1, { value: BUY_PRICE });
    await sale.withdrawStars(outsider.address, (SALE_INVENTORY - 1n) * ONE_STAR);
    await sale.connect(buyer).buy(2, { value: 2n * BUY_PRICE });
    expect(await (sale as any).totalProceedsOwed()).to.equal(2n * BUY_PRICE);
    await expect(sale.withdrawFunds(outsider.address))
      .to.emit(sale, "FundsWithdrawn")
      .withArgs(outsider.address, BUY_PRICE);
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(2n * BUY_PRICE);
    await expect(sale.withdrawFunds(outsider.address)).to.be.revertedWith("No free funds");
  });

  it("withdrawStars cannot touch consignor escrow", async function () {
    await starsCC.mint(depositorA.address, 2n * ONE_STAR);
    await starsCC.connect(depositorA).approve(await sale.getAddress(), 2n * ONE_STAR);
    await (sale as any).connect(depositorA).depositStars(2);
    const saleAddr = await sale.getAddress();
    const total = await starsCC.balanceOf(saleAddr);
    await expect(sale.withdrawStars(outsider.address, total)).to.be.reverted;
    await expect(sale.withdrawStars(outsider.address, SALE_INVENTORY * ONE_STAR))
      .to.emit(sale, "StarsWithdrawn")
      .withArgs(outsider.address, SALE_INVENTORY * ONE_STAR);
    expect(await starsCC.balanceOf(saleAddr)).to.equal(2n * ONE_STAR);
  });

  it("fills large buys from consignment liquidity with no per-address bound", async function () {
    await starsCC.mint(depositorA.address, 10n * ONE_STAR);
    await starsCC.connect(depositorA).approve(await sale.getAddress(), 10n * ONE_STAR);
    await (sale as any).connect(depositorA).depositStars(10);
    await sale.connect(buyer).buy(8, { value: 8n * BUY_PRICE });
    expect(await starsCC.balanceOf(buyer.address)).to.equal(8n * ONE_STAR);
  });
});
