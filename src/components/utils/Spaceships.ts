export interface Ship extends MySpaceships {
    price: number;
};

export interface ShipData extends Ship {
    metadata?: string
};

export interface MySpaceships {
    name: string;
    icon: string;
    images: string;
    hp: number;
    energyRegen: number;
    maxEnergy: number;
    laserWidth: number;
    laserDamage: number;
    laserColor: string;
    bullet: number;
    width: number;
    height: number;
    maxFrame: number;
};

export interface StatCardProps {
    label: string;
    value: number;
};

export interface ShipStatsProps {
    ship: Ship;
};

export interface SpaceshipVisualProps {
    name: string,
    icon: string,
    images: string,
    laserColor: string
};

export interface SpaceshipStatsProps {
    hp: bigint,
    maxEnergy: bigint,
    energyRegen: bigint,
    laserWidth: bigint,
    laserDamage: bigint,
    bullet: bigint,
    width: bigint,
    height: bigint,
    maxFrame: bigint
};

// Create an array of ships
const spaceships = [
    { 
        name: 'Fighter', 
        images: 'https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmZgPw1EFFUAzBA4JULyVtqMqBex1HSBYRebTf1SzRLqaJ', 
        icon: 'https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmYtCMEojovy6CE1t24XLxFHWyY44eWJfR3HzBkeYXXCUx',
        metadata: 'https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmYshoECpKXPq2S4XY4NEJWCbnFGzH4oWyGRsQzAZCjWaw',
        width: 110,
        height: 110,
        hp: 3,
        maxFrame: 16, 
        maxEnergy: 50, 
        energyRegen: 1, 
        laserColor: '#4d9be6', 
        laserWidth: 5,
        laserDamage: 1, 
        bullet: 1,
        price: 0,
    },
    { 
        name: 'Nautolan', 
        images: 'https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmRJZ3DAnfmNt64EDGN8qtw5kf4ewTzMR9ZYzoQQBwkjKj', 
        icon: 'https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmSfqyphKFaNbQLYEtQAWMA7CmiAWpX6hufnVaVgDaDPSW',
        metadata: 'https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/Qmce5XchuEDbFszhxUEnGiSDMMtdXYqjuEg4G4VTv3iVjo',
        width: 80,
        height: 80,
        hp: 4, 
        maxFrame: 10, 
        maxEnergy: 100, 
        energyRegen: 2, 
        laserColor: '#f9c22b', 
        laserWidth: 14, 
        laserDamage: 2, 
        bullet: 2,
        price: 2,
    },
    { 
        name: 'Nairan', 
        images: 'https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmbYQoBmNNVhDrEcbBtTUDHytivhT5LHHGwujC6M5atxGD', 
        icon: 'https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmcVbBoTAEHZ7sFLPiQHADcGCu5LkCsa5QZcJHcy15Znzj',
        metadata: 'https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmZ4xFmySfA3yoNX9ah7GWPzrz13jKf9WPdefAHiczaYK5',
        width: 80,
        height: 80, 
        hp: 5, 
        maxFrame: 16, 
        maxEnergy: 150, 
        energyRegen: 3, 
        laserColor: '#b2ba90',
        laserWidth: 20, 
        laserDamage: 3, 
        bullet: 3,
        price: 5,
    },
    { 
        name: 'Klaed', 
        images: 'https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmUrUxEhcr4v6uJkeCjxJ9ni6CXsHUE2f5DM8b25SC29qe', 
        icon: 'https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmfAExo4NAtNs2TJ1swMqADM7xPLJ9mboH99Np7d4EsY57',
        metadata: 'https://amethyst-implicit-silkworm-944.mypinata.cloud/ipfs/QmcSvBfPKNyJXmEhn2raDJGiivygMbtw7SsF5n32p51V4g',
        width: 90,
        height: 90, 
        hp: 6, 
        maxFrame: 9, 
        maxEnergy: 200, 
        energyRegen: 4, 
        laserColor: '#8ff8e2', 
        laserWidth: 20, 
        laserDamage: 3, 
        bullet: 3,
        price: 10,
    },
];

export default spaceships;