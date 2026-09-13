// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PixelOrbitMarketplace is Ownable, ReentrancyGuard {
    IERC20 public immutable stars;

    enum ListingType { FixedPrice, AscendingAuction }

    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 price; // FixedPrice: sale price. AscendingAuction: reserve.
        ListingType listingType;
        bool isActive;
        uint256 auctionEndTime; // 0 for FixedPrice
        address highestBidder; // zero address when no bids yet
        uint256 highestBid; // zero when no bids yet
    }

    uint256 public nextListingId;
    mapping(uint256 => Listing) public listings;

    /// Protocol fee on every settled sale, in basis points of the sale price.
    uint256 public feeBips;

    /// Where the fee goes. Kept separate from `owner` so revenue can be routed
    /// to a treasury without also handing over the ability to change the fee.
    address public feeRecipient;

    /// Hard ceiling on `feeBips`, enforced in the constructor and the setter.
    /// Immutable by design: a seller listing an item is trusting that the cut
    /// cannot later be raised arbitrarily, and an owner-changeable cap would
    /// make that trust worthless.
    uint256 public constant MAX_FEE_BIPS = 500; // 5%

    /// @notice Auction duration bounds. The floor keeps an auction open long
    /// enough to bid on; the ceiling stops an NFT being escrowed indefinitely.
    uint256 public constant MIN_AUCTION_DURATION = 5 minutes;
    uint256 public constant MAX_AUCTION_DURATION = 30 days;

    event ItemListed(
        uint256 indexed listingId,
        address indexed seller,
        address nftContract,
        uint256 tokenId,
        uint256 price,
        ListingType listingType,
        uint256 auctionEndTime
    );
    event ItemBought(uint256 indexed listingId, address indexed buyer, uint256 price);
    event ListingCancelled(uint256 indexed listingId);
    event PriceUpdated(uint256 indexed listingId, uint256 newPrice);
    event FeeConfigUpdated(uint256 feeBips, address feeRecipient);
    event FeeCollected(uint256 indexed listingId, address indexed recipient, uint256 amount);
    event BidPlaced(uint256 indexed listingId, address indexed bidder, uint256 amount);
    event AuctionFinalized(
        uint256 indexed listingId,
        address indexed winner,
        uint256 amount
    );

    constructor(address _stars, uint256 _feeBips, address _feeRecipient) Ownable(msg.sender) {
        require(_stars != address(0), "Stars required");
        stars = IERC20(_stars);

        _setFeeConfig(_feeBips, _feeRecipient);
    }

    /**
     * Change the fee, the recipient, or both.
     *
     * Takes effect on sales settled after this call, including listings created
     * before it — the fee is read at settlement, not captured at listing time.
     * `MAX_FEE_BIPS` is what bounds the seller's exposure.
     */
    function setFeeConfig(uint256 _feeBips, address _feeRecipient) external onlyOwner {
        _setFeeConfig(_feeBips, _feeRecipient);
    }

    function _setFeeConfig(uint256 _feeBips, address _feeRecipient) internal {
        require(_feeBips <= MAX_FEE_BIPS, "Fee above cap");
        // A zero recipient with a nonzero fee would burn the cut rather than
        // route it, so the two are validated together.
        require(_feeBips == 0 || _feeRecipient != address(0), "Fee recipient required");

        feeBips = _feeBips;
        feeRecipient = _feeRecipient;

        emit FeeConfigUpdated(_feeBips, _feeRecipient);
    }

    /// The cut on a given sale price. Rounds down, so dust favours the seller.
    function feeOn(uint256 price) public view returns (uint256) {
        return (price * feeBips) / 10_000;
    }

    /**
     * List an item, either at a fixed price or as a transparent ascending auction.
     *
     * For an auction, `price` is the reserve and `auctionDuration` sets the
     * bidding window. There is no bid bond: every bid escrows its full Stars
     * amount and the previous highest bid is refunded immediately on outbid.
     *
     * The NFT is escrowed for both types. For an auction that also stops a
     * seller selling it elsewhere while bids are locked against it.
     */
    function createListing(
        address nftContract,
        uint256 tokenId,
        uint256 price,
        ListingType listingType,
        uint256 auctionDuration
    ) external nonReentrant {
        IERC721 nft = IERC721(nftContract);
        require(nft.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(
            nft.isApprovedForAll(msg.sender, address(this)) ||
                nft.getApproved(tokenId) == address(this),
            "Marketplace not approved"
        );

        uint256 auctionEndTime = 0;
        if (listingType == ListingType.AscendingAuction) {
            require(price > 0, "Reserve required");
            require(auctionDuration >= MIN_AUCTION_DURATION, "Auction too short");
            require(auctionDuration <= MAX_AUCTION_DURATION, "Auction too long");
            auctionEndTime = block.timestamp + auctionDuration;
        } else {
            require(price > 0, "Price required");
            require(auctionDuration == 0, "Duration only for auctions");
        }

        uint256 listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            price: price,
            listingType: listingType,
            isActive: true,
            auctionEndTime: auctionEndTime,
            highestBidder: address(0),
            highestBid: 0
        });

        nft.transferFrom(msg.sender, address(this), tokenId);

        emit ItemListed(
            listingId,
            msg.sender,
            nftContract,
            tokenId,
            price,
            listingType,
            auctionEndTime
        );
    }

    function buyItem(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.isActive, "Listing not active");
        require(listing.listingType == ListingType.FixedPrice, "Not a fixed-price listing");

        listing.isActive = false;

        // Two pulls from the buyer rather than one pull into escrow and two
        // pushes out: the buyer pays exactly `price` either way, and the
        // marketplace never holds the proceeds even for one call.
        uint256 fee = feeOn(listing.price);
        require(stars.transferFrom(msg.sender, listing.seller, listing.price - fee), "Payment failed");
        if (fee > 0) {
            require(stars.transferFrom(msg.sender, feeRecipient, fee), "Fee failed");
            emit FeeCollected(listingId, feeRecipient, fee);
        }

        IERC721(listing.nftContract).transferFrom(address(this), msg.sender, listing.tokenId);

        emit ItemBought(listingId, msg.sender, listing.price);
    }

    /**
     * Withdraw a listing that has not sold.
     *
     * Fixed-price listings can always be cancelled by the seller. Auctions can
     * only be cancelled while zero bids exist: once a bid escrows Stars
     * against the listing, the seller cannot pull the NFT until `finalizeAuction`
     * settles it.
     */
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.isActive, "Listing not active");
        require(msg.sender == listing.seller, "Only seller");
        if (listing.listingType == ListingType.AscendingAuction) {
            require(listing.highestBidder == address(0), "Auction has bids");
        }

        listing.isActive = false;
        IERC721(listing.nftContract).transferFrom(address(this), msg.sender, listing.tokenId);

        emit ListingCancelled(listingId);
    }

    function updatePrice(uint256 listingId, uint256 newPrice) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.isActive, "Listing not active");
        require(msg.sender == listing.seller, "Only seller");
        require(listing.listingType == ListingType.FixedPrice, "Not a fixed-price listing");
        require(newPrice > 0, "Price must be positive");

        listing.price = newPrice;
        emit PriceUpdated(listingId, newPrice);
    }

    /**
     * Place a transparent ascending bid escrowed in Stars.
     *
     * The first bid must meet the reserve; every later bid must exceed the
     * current highest. The full bid amount is pulled into escrow and the
     * previous highest bid is refunded immediately, so the contract always
     * holds exactly the current highest bid and losers never wait for payout.
     */
    function placeBid(uint256 listingId, uint256 amount) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.isActive, "Listing not active");
        require(listing.listingType == ListingType.AscendingAuction, "Not an auction");
        require(block.timestamp < listing.auctionEndTime, "Auction closed");
        require(msg.sender != listing.seller, "Seller cannot bid");
        if (listing.highestBid == 0) {
            require(amount >= listing.price, "Below reserve");
        } else {
            require(amount > listing.highestBid, "Bid too low");
        }

        require(stars.transferFrom(msg.sender, address(this), amount), "Bid escrow failed");

        address prevBidder = listing.highestBidder;
        uint256 prevBid = listing.highestBid;
        listing.highestBidder = msg.sender;
        listing.highestBid = amount;

        if (prevBidder != address(0)) {
            require(stars.transfer(prevBidder, prevBid), "Refund failed");
        }

        emit BidPlaced(listingId, msg.sender, amount);
    }

    /**
     * Close an ended auction. Callable by anyone: the outcome is fully
     * determined by on-chain bids, so no privileged role is needed.
     *
     * With bids, the NFT goes to the highest bidder and the escrowed Stars
     * (minus the protocol fee) go to the seller. With no bids, the NFT
     * returns to the seller and nothing else moves.
     */
    function finalizeAuction(uint256 listingId) external nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.isActive, "Listing not active");
        require(listing.listingType == ListingType.AscendingAuction, "Not an auction");
        require(block.timestamp >= listing.auctionEndTime, "Auction still open");

        listing.isActive = false;

        if (listing.highestBidder == address(0)) {
            IERC721(listing.nftContract).transferFrom(address(this), listing.seller, listing.tokenId);
            emit AuctionFinalized(listingId, address(0), 0);
        } else {
            address winner = listing.highestBidder;
            uint256 amount = listing.highestBid;
            uint256 fee = feeOn(amount);

            IERC721(listing.nftContract).transferFrom(address(this), winner, listing.tokenId);
            require(stars.transfer(listing.seller, amount - fee), "Seller payout failed");
            if (fee > 0) {
                require(stars.transfer(feeRecipient, fee), "Fee failed");
                emit FeeCollected(listingId, feeRecipient, fee);
            }

            emit AuctionFinalized(listingId, winner, amount);
        }
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    function getListingCount() external view returns (uint256) {
        return nextListingId;
    }

    function getActiveListings() external view returns (Listing[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < nextListingId; i++) {
            if (listings[i].isActive) count++;
        }
        Listing[] memory active = new Listing[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < nextListingId; i++) {
            if (listings[i].isActive) {
                active[idx] = listings[i];
                idx++;
            }
        }
        return active;
    }
}
