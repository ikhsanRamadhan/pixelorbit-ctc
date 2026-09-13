// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title StarsSale (Sepolia)
/// @notice Permissionless Sepolia ETH door for Orbit Stars test tokens.
/// @dev Inventory-holder only: this contract has NO mint rights over Stars.
/// The owner funds it once via StarsSepolia.mint(sale, N) and can rescue
/// unsold inventory via withdrawStars. pricePerStar is a nominal testnet
/// parameter (initial 0.0001 ether per whole Star), not a market price.
/// Payment must be exact; there is no change logic and no refund path.
contract StarsSale is Ownable {
    IERC20 public immutable stars;

    /// @notice Price in wei per whole Star (18 decimals), mutable by the owner.
    uint256 public pricePerStar;

    /// @notice Max whole Stars per buy call; bounds inventory drain per tx.
    uint256 public constant MAX_PER_TX = 100;

    event StarsPurchased(address indexed buyer, uint256 starAmount, uint256 paid);
    event PriceUpdated(uint256 oldPrice, uint256 newPrice);
    event ETHWithdrawn(address indexed to, uint256 amount);
    event StarsWithdrawn(address indexed to, uint256 amount);

    constructor(address _stars, uint256 _pricePerStar) Ownable(msg.sender) {
        require(_stars != address(0), "Stars required");
        require(_pricePerStar > 0, "Bad price");
        stars = IERC20(_stars);
        pricePerStar = _pricePerStar;
    }

    /// @notice Buy whole Stars at the current price with exact ETH payment.
    /// @param starAmount Whole Stars to buy (1 = 1e18 token units).
    function buy(uint256 starAmount) external payable {
        require(starAmount > 0, "Zero amount");
        require(starAmount <= MAX_PER_TX, "Over max per tx");
        require(msg.value == starAmount * pricePerStar, "Wrong payment");
        require(stars.transfer(msg.sender, starAmount * 1e18), "Sale failed");
        emit StarsPurchased(msg.sender, starAmount, msg.value);
    }

    /// @notice Update the nominal price. Owner-only; zero is rejected because
    /// a free sale would drain inventory in one call.
    function setPrice(uint256 _pricePerStar) external onlyOwner {
        require(_pricePerStar > 0, "Bad price");
        uint256 oldPrice = pricePerStar;
        pricePerStar = _pricePerStar;
        emit PriceUpdated(oldPrice, _pricePerStar);
    }

    /// @notice Withdraw accumulated ETH proceeds. Owner-only.
    function withdrawETH(address to) external onlyOwner {
        require(to != address(0), "Bad recipient");
        uint256 balance = address(this).balance;
        (bool ok, ) = to.call{value: balance}("");
        require(ok, "Withdraw failed");
        emit ETHWithdrawn(to, balance);
    }

    /// @notice Rescue unsold Stars inventory. Owner-only.
    /// @dev Takes an explicit `to` (rather than defaulting to msg.sender) so
    /// the owner can sweep inventory to a treasury or multisig in one call.
    function withdrawStars(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Bad recipient");
        require(stars.transfer(to, amount), "Rescue failed");
        emit StarsWithdrawn(to, amount);
    }
}
