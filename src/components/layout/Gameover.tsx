"use client";
import { motion } from 'motion/react';
import { Dispatch, SetStateAction, useMemo, useState } from 'react';

import { MySpaceships } from '@/components/utils/Spaceships';
import { useGameStore } from '@/stores/game-store';
import { submitHighscore } from '@/services/leaderboard';
import { openCrates } from '@/services/items';
import itemsData, { rarityColors, SalvageCrate } from '@/components/utils/Items';
import Image from 'next/image';

interface gameoverProps {
    score: number;
    ship: MySpaceships;
    collectedItems: SalvageCrate[];
    onRestart: () => void;
    onBack: () => void;
    setCollectedItems: Dispatch<SetStateAction<SalvageCrate[]>>;
};

const GameOver = ({ score, ship, collectedItems, onRestart, onBack, setCollectedItems }: gameoverProps) => {
    const userHighscores = useGameStore((s) => s.userHighscores);
    const [isSubmitted, setIsSubmitted] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isOpened, setIsOpened] = useState(false);
    const [isOpening, setIsOpening] = useState(false);
    const [revealed, setRevealed] = useState<number[] | null>(null);

    const currentShipRecord = useMemo(() => {
        const record = userHighscores.find((h) => h.ship === ship.name);
        return record ? record.score : 0;
    }, [userHighscores, ship.name]);

    // Crates are recovered as an opaque count. What each crate turns out to be
    // is decided on-chain when the run's crates are opened: the server signs
    // (player, run nonce, count) and `PixelOrbitItem.claimCrates` rolls rarity
    // from a prevrandao-mixed seed — one claim per run nonce.
    const crateCount = collectedItems.length;

    const handlePressSubmit = async () => {
        if (isSubmitted) return;
        setIsSubmitting(true);
        const submitted = await submitHighscore(score, ship.name);
        setIsSubmitted(!!submitted);
        setIsSubmitting(false);
    };

    const handleOpenCrates = async () => {
        if (isOpened || isOpening) return;
        setIsOpening(true);
        const revealedTypes = await openCrates(crateCount);
        setIsOpening(false);
        if (!revealedTypes) return;
        setIsOpened(true);
        setRevealed(revealedTypes);
        // The run's crates are spent on-chain; clear the tiles so a second
        // press cannot happen. The minted items live in the inventory now.
        setCollectedItems([]);
    };

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="relative z-50 flex flex-col items-center justify-center p-4 sm:p-6 md:p-8 rounded-3xl border-2 border-red-500/50 bg-black/80 backdrop-blur-xl max-w-xl w-full text-center"
        >
            <div className="absolute -inset-1 bg-red-500/20 blur-2xl rounded-3xl -z-10" />

            <h1 className="text-3xl sm:text-4xl md:text-5xl font-black text-red-500 italic tracking-tighter uppercase mb-2">
                Mission Failed
            </h1>
            <p className="text-cyan-400 font-mono text-xs md:text-sm mb-6 sm:mb-8 tracking-widest">
                SIGNAL LOST // SHIP DESTROYED
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 w-full mb-6 sm:mb-8">
                <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <p className="text-[10px] text-gray-400 uppercase mb-1">Final Score</p>
                    <p className="text-2xl font-bold text-yellow-400">{score.toLocaleString()}</p>
                </div>
                <div className="p-4 rounded-xl bg-white/5 border border-white/10">
                    <p className="text-[10px] text-gray-400 uppercase mb-1">Active Ship</p>
                    <p className="text-lg font-bold text-white">{ship.name}</p>
                    {currentShipRecord > 0 && (
                        <p className="text-[9px] text-cyan-500 mt-1 uppercase">
                            Best: {currentShipRecord.toLocaleString()}
                        </p>
                    )}
                </div>
            </div>

            <div className="w-full mb-8 text-left space-y-3">
                {revealed !== null ? (
                    <RevealedPanel itemTypes={revealed} />
                ) : (
                    <CratePanel count={isOpened ? 0 : crateCount} />
                )}
                {!isOpened && crateCount > 0 && (
                    <motion.button
                        disabled={isOpening}
                        onClick={handleOpenCrates}
                        whileHover={!isOpening ? { scale: 1.02 } : {}}
                        whileTap={!isOpening ? { scale: 0.98 } : {}}
                        className={`w-full py-4 px-2 font-black rounded-xl uppercase tracking-tighter text-xs transition-all
                            ${isOpening
                                ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                                : 'bg-cyan-200 text-black shadow-[0_0_15px_rgba(34,211,238,0.3)] cursor-pointer hover:bg-cyan-100'}
                        `}
                    >
                        {isOpening ? 'Opening...' : `Open ${crateCount} ${crateCount === 1 ? 'crate' : 'crates'}`}
                    </motion.button>
                )}
                <BridgeNote crateCount={crateCount} />
            </div>

            <div className="flex flex-col gap-3 w-full">
                <div className="flex flex-col sm:flex-row gap-3 w-full">
                    {score > 0 && score > currentShipRecord && (
                        <motion.button
                            disabled={isSubmitted || isSubmitting}
                            onClick={handlePressSubmit}
                            whileHover={!isSubmitted && !isSubmitting ? { scale: 1.02 } : {}}
                            whileTap={!isSubmitted && !isSubmitting ? { scale: 0.98 } : {}}
                            className={`flex-1 py-4 px-2 font-black rounded-xl uppercase tracking-tighter text-xs transition-all
                                ${(isSubmitted || isSubmitting)
                                    ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                                    : 'bg-yellow-200 text-black shadow-[0_0_15px_rgba(255,255,0,0.3)] cursor-pointer hover:bg-yellow-100'}
                            `}
                        >
                            {isSubmitting ? 'Transmitting...' : isSubmitted ? 'Recorded' : 'New Record!'}
                        </motion.button>
                    )}
                </div>

                <div className="flex flex-col sm:flex-row gap-3 w-full">
                    <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={onRestart}
                        className="flex-1 py-4 px-2 bg-cyan-500 text-black font-black rounded-xl uppercase tracking-tighter text-xs shadow-[0_0_15px_rgba(6,182,212,0.3)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Re-Deploy
                    </motion.button>

                    <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={onBack}
                        className="flex-1 py-4 px-2 bg-red-500 text-black font-black rounded-xl uppercase tracking-tighter text-xs shadow-[0_0_15px_rgba(239,68,68,0.3)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        Exit
                    </motion.button>
                </div>
            </div>
        </motion.div>
    );
};

export default GameOver;

/**
 * What the run's crates turned into: one uniform card per minted item, in
 * mint order — art, name, and the marketplace rarity color on both the ring
 * and the label. An index outside the client table (contract extended
 * without a client update) renders as an honest unknown rather than crashing
 * or mislabeling.
 */
const RARITY_RING: Record<string, string> = {
    Legendary: 'border-orange-500/70',
    Epic: 'border-purple-500/70',
    Rare: 'border-blue-400/70',
    Uncommon: 'border-green-400/70',
    Common: 'border-gray-500/50',
};

const RevealedPanel = ({ itemTypes }: { itemTypes: number[] }) => (
    <>
        <p className="text-[10px] text-cyan-500/50 uppercase font-mono mb-3 tracking-widest">
            Salvage recovered ({itemTypes.length})
        </p>
        <div className="flex flex-wrap gap-2 justify-center p-6 bg-black/40 rounded-lg min-h-24 items-stretch">
            {itemTypes.length === 0 ? (
                <p className="text-xs text-gray-500 italic self-center">Claim landed — inventory holds the items</p>
            ) : (
                itemTypes.map((typeIndex, i) => {
                    const known = itemsData[typeIndex];
                    const name = known?.name ?? `Item #${typeIndex}`;
                    const rarity = known?.rarity ?? 'Common';
                    const image = known?.image;
                    return (
                        <div
                            key={i}
                            title={`${name} · ${rarity}`}
                            className={`w-24 shrink-0 px-2 py-2 rounded border bg-cyan-500/5 flex flex-col items-center gap-1 ${RARITY_RING[rarity] ?? 'border-gray-500/50'}`}
                        >
                            <div className="relative w-16 h-16 shrink-0">
                                {image ? (
                                    <Image src={image} alt={name} fill className="object-contain" unoptimized />
                                ) : (
                                    <span className="w-full h-full rounded border border-cyan-500/50 bg-cyan-500/5 flex items-center justify-center text-cyan-300 font-black text-lg">
                                        {name.charAt(0).toUpperCase()}
                                    </span>
                                )}
                            </div>
                            <span className="text-white font-mono text-[9px] leading-tight text-center truncate w-full">
                                {name}
                            </span>
                            <span className={`font-mono text-[8px] uppercase ${rarityColors[rarity] ?? 'text-gray-400'}`}>
                                {rarity}
                            </span>
                        </div>
                    );
                })
            )}
        </div>
    </>
);

/**
 * The run's salvage: a count and a row of unopened tiles. There is nothing
 * else honest to show, since the contents do not exist until the claim mints
 * them — the Open button above spends the run's crates on-chain exactly once.
 */
const CratePanel = ({ count }: { count: number }) => (
    <>
        <p className="text-[10px] text-cyan-500/50 uppercase font-mono mb-3 tracking-widest">
            Salvage Crates ({count})
        </p>
        <div className="flex flex-wrap gap-2 justify-center p-6 bg-black/40 rounded-lg min-h-24 items-center">
            {count === 0 ? (
                <p className="text-xs text-gray-500 italic">No crates recovered</p>
            ) : (
                Array.from({ length: Math.min(count, 24) }, (_, i) => (
                    <div
                        key={i}
                        aria-hidden
                        className="w-10 h-10 rounded border border-cyan-500/50 bg-cyan-500/5 flex items-center justify-center text-cyan-400 font-black text-xs"
                    >
                        ?
                    </div>
                ))
            )}
            {count > 24 && (
                <span className="text-[10px] text-cyan-500/60 font-mono self-center">
                    +{count - 24} more
                </span>
            )}
        </div>
        {count > 0 && (
            <p className="text-[9px] text-gray-500 font-mono mt-2">
                Rarity rolls on-chain from a prevrandao-mixed seed when you open them.
            </p>
        )}
    </>
);

/**
 * Where the run's value actually goes on the Creditcoin economy.
 *
 * Score submission above is one working on-chain write; opening the run's
 * crates is the other. Stars (for ships and market bids) still move through
 * the Sepolia bridge instead, so this says where and what that unlocks —
 * including the attested leaderboard tier.
 */
const BridgeNote = ({ crateCount }: { crateCount: number }) => (
    <div className="p-4 rounded-lg bg-cyan-500/5 border border-cyan-500/20 space-y-1.5">
        <p className="text-[10px] text-cyan-300 uppercase font-mono tracking-widest">
            Bridge economy
        </p>
        {crateCount > 0 && (
            <p className="text-[9px] text-gray-300 font-mono leading-relaxed">
                {crateCount} {crateCount === 1 ? 'crate' : 'crates'} logged this run. Open
                them above to mint the loot into your inventory.
            </p>
        )}
        <p className="text-[9px] text-gray-400 font-mono leading-relaxed">
            Lock Sepolia Stars in the Bridge (pilot profile) to mint Stars on
            Creditcoin. Bridged players join the attested leaderboard tier.
        </p>
    </div>
);
