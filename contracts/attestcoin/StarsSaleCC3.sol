// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title StarsSaleCC3 (Creditcoin)
/// @notice Two-way nominal tCTC door for Orbit Stars on Creditcoin: an open
/// buy shelf, an instant sell-back window, and FIFO consignment for holders.
/// @dev Inventory-holder only: this contract has NO mint rights over Stars and
/// no mint path exists on Creditcoin outside the ASC. Treasury inventory must
/// come from real bridged Stars (owner locks Sepolia Stars, the ASC mints to
/// treasury, treasury funds this sale), preserving the bridge peg narrative.
/// prices are nominal testnet parameters (buy 10 ether, sell-back 8 ether in
/// tCTC per whole Star), not market prices. The 10/8 spread stays in the
/// contract and funds the sell-back pool automatically.
/// Accounting: amounts in storage are WHOLE Stars (1 = 1e18 token units) to
/// match the lot and escrow bookkeeping. Treasury stock is implicit — any Stars balance above the
/// escrowed consignments is shelf stock: buys draw it first, the owner can
/// rescue it, and sell-back proceeds land in it. Escrow is untouchable by
/// anyone except the lot owner (cancel) or a buyer fill (proceeds credited).
/// Solvency: `totalProceedsOwed` tracks consignor tCTC; owner `withdrawFunds`
/// and `sellStars` can only spend the balance above it, so user proceeds are
/// never drained by the owner or the sell-back window.
/// Buys are uncapped per address: the shelf is bounded by physical inventory
/// (treasury stock plus consignment lots) and every buy pays the exact tCTC
/// price, so there is no faucet to farm — anyone may also sell and consign
/// back into the same shelf.
contract StarsSaleCC3 is Ownable, ReentrancyGuard {
    IERC20 public immutable stars;

    /// @notice Buy price in wei (tCTC) per whole Star (18 decimals), owner-mutable.
    uint256 public pricePerStar;

    /// @notice Sell-back price in wei (tCTC) per whole Star, owner-mutable but
    /// never above pricePerStar (the spread funds the pool and must not invert).
    uint256 public sellPricePerStar;

    /// @notice One FIFO consignment lot. `remaining` is whole Stars.
    struct Lot {
        address seller;
        uint256 remaining;
    }

    /// @notice All consignment lots, oldest first. Consumed lots keep
    /// `remaining == 0` and are skipped via `lotHead` (no array shifts).
    Lot[] public lots;

    /// @notice Index of the oldest possibly-unfilled lot.
    uint256 public lotHead;

    /// @notice Whole Stars each address currently holds in escrow.
    mapping(address => uint256) public consigned;

    /// @notice Whole Stars locked across all lots (exact; bounds rescues).
    uint256 public escrowedStars;

    /// @notice tCTC wei each seller has earned from filled lots, withdrawable.
    mapping(address => uint256) public proceeds;

    /// @notice Total tCTC wei owed to sellers; owner withdrawals stay above it.
    uint256 public totalProceedsOwed;

    event StarsPurchased(address indexed buyer, uint256 starAmount, uint256 paid);
    event PriceUpdated(uint256 oldPrice, uint256 newPrice);
    event StarsSold(address indexed seller, uint256 starAmount, uint256 payout);
    event StarsDeposited(address indexed depositor, uint256 starAmount, uint256 lotId);
    event ConsignmentFilled(uint256 indexed lotId, address indexed seller, uint256 amount);
    event ConsignmentCancelled(address indexed depositor, uint256 indexed lotId, uint256 amount);
    event ProceedsWithdrawn(address indexed to, uint256 amount);
    event FundsWithdrawn(address indexed to, uint256 amount);
    event StarsWithdrawn(address indexed to, uint256 amount);

    constructor(
        address _stars,
        uint256 _buyPrice,
        uint256 _sellPrice
    ) Ownable(msg.sender) {
        require(_stars != address(0), "Stars required");
        require(_buyPrice > 0, "Bad price");
        require(_sellPrice > 0 && _sellPrice <= _buyPrice, "Bad spread");
        stars = IERC20(_stars);
        pricePerStar = _buyPrice;
        sellPricePerStar = _sellPrice;
    }

    /// @notice Buy whole Stars at the current price with exact tCTC payment.
    /// @dev Fills treasury shelf stock first, then the oldest consignment lots
    /// (FIFO), crediting each filled seller at the buy price. The final token
    /// transfer is the stock check: it reverts (via the token) when the shelf
    /// plus lots cannot cover the amount, so no partial fill can persist.
    /// @param starAmount Whole Stars to buy (1 = 1e18 token units).
    function buy(uint256 starAmount) external payable nonReentrant {
        require(starAmount > 0, "Zero amount");
        require(msg.value == starAmount * pricePerStar, "Wrong payment");
        uint256 remaining = starAmount;
        // Treasury shelf stock first: the live balance above escrow is
        // implicitly shelf stock (plain mints/transfers land here, as do
        // sell-back proceeds), so no separate counter can drift from it.
        // Whole-star floor: a rescue leaving wei dust cannot strand a fill.
        uint256 treasuryAvail =
            (stars.balanceOf(address(this)) - escrowedStars * 1e18) / 1e18;
        if (treasuryAvail > remaining) treasuryAvail = remaining;
        remaining -= treasuryAvail;
        uint256 head = lotHead;
        while (remaining > 0 && head < lots.length) {
            Lot storage lot = lots[head];
            if (lot.remaining == 0) {
                unchecked {
                    ++head;
                }
                continue;
            }
            uint256 fill = lot.remaining < remaining ? lot.remaining : remaining;
            lot.remaining -= fill;
            remaining -= fill;
            consigned[lot.seller] -= fill;
            escrowedStars -= fill;
            uint256 credit = fill * pricePerStar;
            proceeds[lot.seller] += credit;
            totalProceedsOwed += credit;
            emit ConsignmentFilled(head, lot.seller, fill);
            if (lot.remaining == 0) {
                unchecked {
                    ++head;
                }
            }
        }
        lotHead = head;
        require(stars.transfer(msg.sender, starAmount * 1e18), "Sale failed");
        emit StarsPurchased(msg.sender, starAmount, msg.value);
    }

    /// @notice Sell whole Stars back to the shelf at the sell-back price.
    /// @dev Sold Stars land in the implicit treasury (resellable, rescuable).
    /// The pool check comes before the token pull so a dry pool reverts
    /// without touching allowances. Only the balance ABOVE owed seller
    /// proceeds is spendable: a sell can never eat into consignor money, so
    /// `withdrawProceeds` stays covered no matter how sells interleave buys.
    /// @param starAmount Whole Stars to sell (1 = 1e18 token units).
    function sellStars(uint256 starAmount) external nonReentrant {
        require(starAmount > 0, "Zero amount");
        uint256 payout = starAmount * sellPricePerStar;
        require(address(this).balance - totalProceedsOwed >= payout, "Empty pool");
        require(stars.transferFrom(msg.sender, address(this), starAmount * 1e18), "Sell failed");
        (bool ok, ) = msg.sender.call{value: payout}("");
        require(ok, "Payout failed");
        emit StarsSold(msg.sender, starAmount, payout);
    }

    /// @notice Escrow whole Stars as a FIFO consignment lot.
    /// @param starAmount Whole Stars to consign (1 = 1e18 token units).
    /// @return lotId Index of the new lot in `lots`.
    function depositStars(uint256 starAmount) external returns (uint256 lotId) {
        require(starAmount > 0, "Zero amount");
        require(
            stars.transferFrom(msg.sender, address(this), starAmount * 1e18),
            "Deposit failed"
        );
        consigned[msg.sender] += starAmount;
        escrowedStars += starAmount;
        lots.push(Lot({seller: msg.sender, remaining: starAmount}));
        lotId = lots.length - 1;
        emit StarsDeposited(msg.sender, starAmount, lotId);
    }

    /// @notice Cancel a consignment lot and reclaim its unfilled escrow.
    /// @param lotId Index into `lots`.
    function cancelConsignment(uint256 lotId) external {
        require(lotId < lots.length, "Bad lot");
        Lot storage lot = lots[lotId];
        require(lot.seller == msg.sender, "Not lot owner");
        require(lot.remaining > 0, "Lot empty");
        uint256 amount = lot.remaining;
        lot.remaining = 0;
        consigned[msg.sender] -= amount;
        escrowedStars -= amount;
        require(stars.transfer(msg.sender, amount * 1e18), "Cancel failed");
        emit ConsignmentCancelled(msg.sender, lotId, amount);
    }

    /// @notice Withdraw earned consignment proceeds (pull pattern, CEI).
    function withdrawProceeds() external nonReentrant {
        uint256 amount = proceeds[msg.sender];
        require(amount > 0, "No proceeds");
        proceeds[msg.sender] = 0;
        totalProceedsOwed -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "Withdraw failed");
        emit ProceedsWithdrawn(msg.sender, amount);
    }

    /// @notice Update the nominal buy price. Owner-only; zero is rejected
    /// because a free sale would drain inventory in one call, and dropping
    /// below the sell-back price would invert the spread and let sellers
    /// drain the pool.
    function setPrice(uint256 _pricePerStar) external onlyOwner {
        require(_pricePerStar > 0, "Bad price");
        require(_pricePerStar >= sellPricePerStar, "Bad spread");
        uint256 oldPrice = pricePerStar;
        pricePerStar = _pricePerStar;
        emit PriceUpdated(oldPrice, _pricePerStar);
    }

    /// @notice Update the nominal sell-back price. Owner-only; zero is
    /// rejected and the price can never exceed the buy price (spread stays
    /// non-negative so the pool cannot be arbitraged dry).
    function setSellPrice(uint256 _sellPrice) external onlyOwner {
        require(_sellPrice > 0, "Bad price");
        require(_sellPrice <= pricePerStar, "Bad spread");
        uint256 oldPrice = sellPricePerStar;
        sellPricePerStar = _sellPrice;
        emit PriceUpdated(oldPrice, _sellPrice);
    }

    /// @notice Withdraw accumulated tCTC proceeds. Owner-only. Only the
    /// balance ABOVE owed seller proceeds is free: consignor money is never
    /// swept into the owner's pocket.
    function withdrawFunds(address to) external onlyOwner nonReentrant {
        require(to != address(0), "Bad recipient");
        uint256 free = address(this).balance - totalProceedsOwed;
        require(free > 0, "No free funds");
        (bool ok, ) = to.call{value: free}("");
        require(ok, "Withdraw failed");
        emit FundsWithdrawn(to, free);
    }

    /// @notice Rescue unsold treasury Stars. Owner-only. Escrowed
    /// consignments are excluded: the bound is the live balance minus escrow,
    /// so no rescue can touch a consignor's Stars.
    /// @dev Takes an explicit `to` (rather than defaulting to msg.sender) so
    /// the owner can sweep inventory to a treasury or multisig in one call.
    /// @param to Recipient of the rescued Stars (token units for `amount`).
    /// @param amount Token units to rescue (1 whole Star = 1e18).
    function withdrawStars(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Bad recipient");
        require(stars.balanceOf(address(this)) - amount >= escrowedStars * 1e18, "Escrow locked");
        require(stars.transfer(to, amount), "Rescue failed");
        emit StarsWithdrawn(to, amount);
    }
}
