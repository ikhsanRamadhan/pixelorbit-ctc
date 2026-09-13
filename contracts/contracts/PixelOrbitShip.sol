// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal price-oracle read surface for the flash-sale gate.
/// @dev Only answer/updatedAt are consumed; roundId is observable offchain.
interface IPriceOracle {
    function answer() external view returns (int256);
    function updatedAt() external view returns (uint256);
}

contract PixelOrbitShip is ERC721Enumerable, Ownable, ReentrancyGuard {
    IERC20 public immutable stars;
    address public asc;

    /// @notice Attested Chainlink ETH/USD relay gating the flash sale. Zero
    /// address allowed (sale disabled, flat catalog prices).
    /// @dev Honesty: Stars has no market price. The oracle is a verified
    /// third-party ETH/USD data relay plus a liveness-gated sale switch, not
    /// a Stars valuation. Never convert Stars to USD anywhere.
    address public priceOracle;

    /// @notice Flash-sale discount in basis points (20 percent off).
    uint256 public constant FLASH_SALE_DISCOUNT_BPS = 2000;
    /// @notice Sale stays active only while the oracle feed is this fresh.
    uint256 public constant PRICE_FRESHNESS_WINDOW = 24 hours;

    struct ShipStats {
        uint256 hp;
        uint256 maxEnergy;
        uint256 energyRegen;
        uint256 laserWidth;
        uint256 laserDamage;
        uint256 bullet;
        uint256 width;
        uint256 height;
        uint256 maxFrame;
    }

    struct ShipType {
        string name;
        uint256 price;
        string metadataURI;
        ShipStats stats;
    }

    ShipType[] public shipTypes;
    mapping(uint256 => uint256) public tokenShipType;
    uint256 private nextTokenId;

    event ShipPurchased(address indexed buyer, uint256 indexed tokenId, uint256 shipTypeIndex, uint256 starsPrice);
    event ShipMinted(address indexed to, uint256 indexed tokenId, uint256 shipTypeIndex);
    event ShipMetadataUpdated(uint256 indexed shipTypeIndex, string metadataURI);
    event AscUpdated(address asc);
    event PriceOracleUpdated(address priceOracle);

    constructor(address _stars) ERC721("PixelOrbit Ship", "POSHIP") Ownable(msg.sender) {
        require(_stars != address(0), "Stars required");
        stars = IERC20(_stars);

        shipTypes.push(ShipType({
            name: "Fighter",
            price: 0,
            metadataURI: "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmYshoECpKXPq2S4XY4NEJWCbnFGzH4oWyGRsQzAZCjWaw",
            stats: ShipStats({ hp: 3, maxEnergy: 50, energyRegen: 1, laserWidth: 5, laserDamage: 1, bullet: 1, width: 110, height: 110, maxFrame: 16 })
        }));

        shipTypes.push(ShipType({
            name: "Nautolan",
            price: 2,
            metadataURI: "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/Qmce5XchuEDbFszhxUEnGiSDMMtdXYqjuEg4G4VTv3iVjo",
            stats: ShipStats({ hp: 4, maxEnergy: 100, energyRegen: 2, laserWidth: 14, laserDamage: 2, bullet: 2, width: 80, height: 80, maxFrame: 10 })
        }));

        shipTypes.push(ShipType({
            name: "Nairan",
            price: 5,
            metadataURI: "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmZ4xFmySfA3yoNX9ah7GWPzrz13jKf9WPdefAHiczaYK5",
            stats: ShipStats({ hp: 5, maxEnergy: 150, energyRegen: 3, laserWidth: 20, laserDamage: 3, bullet: 3, width: 80, height: 80, maxFrame: 16 })
        }));

        shipTypes.push(ShipType({
            name: "Klaed",
            price: 10,
            metadataURI: "https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmcSvBfPKNyJXmEhn2raDJGiivygMbtw7SsF5n32p51V4g",
            stats: ShipStats({ hp: 6, maxEnergy: 200, energyRegen: 4, laserWidth: 20, laserDamage: 3, bullet: 4, width: 80, height: 80, maxFrame: 16 })
        }));
    }

    function getShipStarsPrice(uint256 shipTypeIndex) public view returns (uint256) {
        uint256 flat = shipTypes[shipTypeIndex].price * 1e18;
        if (flat == 0) return 0;
        if (priceOracle == address(0)) return flat;
        // Fail closed on ANY oracle fault: low-level staticcall plus an
        // exact-length check. A high-level try/catch is not enough here — a
        // call to an EOA (no code) succeeds with empty returndata and the
        // caller's ABI decode of that empty buffer is NOT caught by
        // try/catch, so getShipStarsPrice would revert and brick buyShip.
        // Expected readers return exactly one 32-byte word; anything else
        // (EOA, unknown selector, revert, short/long data) falls back to flat.
        (bool okAnswer, bytes memory retAnswer) =
            priceOracle.staticcall(abi.encodeWithSelector(IPriceOracle.answer.selector));
        if (!okAnswer || retAnswer.length != 32) return flat;
        int256 feedAnswer = abi.decode(retAnswer, (int256));
        if (feedAnswer <= 0) return flat;
        (bool okStamp, bytes memory retStamp) =
            priceOracle.staticcall(abi.encodeWithSelector(IPriceOracle.updatedAt.selector));
        if (!okStamp || retStamp.length != 32) return flat;
        uint256 feedUpdatedAt = abi.decode(retStamp, (uint256));
        if (feedUpdatedAt > block.timestamp) return flat;
        if (block.timestamp - feedUpdatedAt > PRICE_FRESHNESS_WINDOW) return flat;
        return (flat * (10_000 - FLASH_SALE_DISCOUNT_BPS)) / 10_000;
    }

    function buyShip(uint256 shipTypeIndex) external nonReentrant {
        require(shipTypeIndex < shipTypes.length, "Invalid ship type");

        uint256 starsPrice = getShipStarsPrice(shipTypeIndex);
        if (starsPrice > 0) {
            require(stars.transferFrom(msg.sender, address(this), starsPrice), "Stars payment failed");
        }

        uint256 tokenId = nextTokenId++;
        tokenShipType[tokenId] = shipTypeIndex;
        _safeMint(msg.sender, tokenId);

        emit ShipPurchased(msg.sender, tokenId, shipTypeIndex, starsPrice);
    }

    function mintShip(address to, uint256 shipTypeIndex) external onlyOwner {
        require(shipTypeIndex < shipTypes.length, "Invalid ship type");
        uint256 tokenId = nextTokenId++;
        tokenShipType[tokenId] = shipTypeIndex;
        _safeMint(to, tokenId);
        emit ShipMinted(to, tokenId, shipTypeIndex);
    }

    function mintBridged(address to, uint256 shipTypeIndex) external {
        require(msg.sender == asc, "Only ASC");
        require(shipTypeIndex < shipTypes.length, "Invalid ship type");
        uint256 tokenId = nextTokenId++;
        tokenShipType[tokenId] = shipTypeIndex;
        _safeMint(to, tokenId);
        emit ShipMinted(to, tokenId, shipTypeIndex);
    }

    function setAsc(address _asc) external onlyOwner {
        require(_asc != address(0), "Invalid ASC");
        asc = _asc;
        emit AscUpdated(_asc);
    }

    /// @notice Point the flash sale at an attested price oracle. Zero allowed
    /// to disable the sale (flat catalog prices).
    function setPriceOracle(address _priceOracle) external onlyOwner {
        priceOracle = _priceOracle;
        emit PriceOracleUpdated(_priceOracle);
    }

    function withdrawStars() external onlyOwner {
        uint256 balance = stars.balanceOf(address(this));
        require(balance > 0, "No Stars to withdraw");
        require(stars.transfer(msg.sender, balance), "Withdrawal failed");
    }

    function setShipMetadataURI(uint256 shipTypeIndex, string calldata metadataURI) external onlyOwner {
        require(shipTypeIndex < shipTypes.length, "Invalid ship type");
        require(bytes(metadataURI).length > 0, "Empty metadata URI");
        shipTypes[shipTypeIndex].metadataURI = metadataURI;
        emit ShipMetadataUpdated(shipTypeIndex, metadataURI);
    }

    function getShipType(uint256 index) external view returns (ShipType memory) {
        return shipTypes[index];
    }

    function getShipStats(uint256 tokenId) external view returns (ShipStats memory) {
        return shipTypes[tokenShipType[tokenId]].stats;
    }

    function getShipTypeCount() external view returns (uint256) {
        return shipTypes.length;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return shipTypes[tokenShipType[tokenId]].metadataURI;
    }
}
