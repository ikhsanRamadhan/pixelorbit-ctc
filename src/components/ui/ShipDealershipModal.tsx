'use client';
import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import Image from "next/image";
import { toast } from 'sonner';
import { Ship, ShipData } from "@/components/utils/Spaceships";
import { useGameStore } from "@/stores/game-store";
import { useWalletStore } from "@/stores/wallet-store";
import { fetchUserSpaceships, mintSpaceship, fetchShipStarsPrices, ShipPriceInfo } from "@/services/ships";
import { fetchPriceOracleStatus, formatPriceAge, PriceOracleStatus } from "@/services/price-oracle";
import { useModalA11y } from "@/hooks/useModalA11y";
import { MODAL_OVERLAY, MODAL_PADDING, modalPanel, modalHeaderRow, modalTitle, modalCloseBtn } from "@/lib/ui-tokens";

interface ShipDealershipModalProps {
    isOpen: boolean;
    onClose: () => void;
    data: Ship[];
};

const ShipDealershipModal = ({ isOpen, onClose, data }: ShipDealershipModalProps) => (
    <AnimatePresence>
        {isOpen && <ShipDealershipModalContent onClose={onClose} data={data} />}
    </AnimatePresence>
);

const ShipDealershipModalContent = ({ onClose, data }: Omit<ShipDealershipModalProps, 'isOpen'>) => {
    const mySpaceships = useGameStore((s) => s.mySpaceships);
    const isConnected = useWalletStore((s) => s.isConnected);
    const [shipPrices, setShipPrices] = useState<ShipPriceInfo[]>([]);
    const [purchasingShip, setPurchasingShip] = useState<string | null>(null);
    const [priceStatus, setPriceStatus] = useState<PriceOracleStatus | null>(null);

    // Prices are quoted per open so a stale Stars price is never shown.
    useEffect(() => {
        fetchShipStarsPrices().then(setShipPrices).catch(() => setShipPrices([]));
        // Attested ETH/USD relay for the flash-sale banner. Display-only:
        // Stars has no market price, so this feed never converts Stars to USD.
        fetchPriceOracleStatus().then(setPriceStatus).catch(() => setPriceStatus(null));
    }, []);

    const dismiss = useCallback(() => {
        onClose();
        toast.dismiss();
    }, [onClose]);

    const panelRef = useModalA11y<HTMLDivElement>(dismiss);

    const handlePurchase = async (ship: ShipData) => {
        if (!isConnected) {
            toast.error("Connect your wallet to purchase a spaceship.");
            return;
        }
        const toastId = toast.loading("Minting Spaceship...");
        setPurchasingShip(ship.name);
        try {
            await mintSpaceship(ship, toastId as string);
            fetchUserSpaceships();
        } finally {
            setPurchasingShip(null);
        }
    };

    const isOwned = (ship: Ship) =>
        mySpaceships.some(mine => mine.name === ship.name) || ship.price === 0;

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={MODAL_OVERLAY}
            onClick={dismiss}
        >
            <motion.div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="dealership-title"
                tabIndex={-1}
                initial={{ scale: 0.9, y: 20 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.9, y: 20 }}
                className={`${modalPanel('cyan', 'xl')} ${MODAL_PADDING} overflow-y-auto`}
                onClick={(e) => e.stopPropagation()}
            >
                <div className={modalHeaderRow('cyan')}>
                    <h2 id="dealership-title" className={modalTitle('cyan')}>
                        Available Fleet <span className="text-white text-sm ml-2">({data.length} Units)</span>
                    </h2>
                    <button
                        onClick={dismiss}
                        className={modalCloseBtn('cyan')}
                    >
                        [X]
                    </button>
                </div>

                <PriceSaleBanner status={priceStatus} />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
                    {data.map((ship, idx) => (
                        <div key={idx} className="bg-white/5 rounded-lg p-4 border border-white/10 hover:border-cyan-500/40 transition-all group">
                            <div className="flex gap-4">
                                <div className="w-24 h-24 relative shrink-0 bg-black/40 rounded border border-cyan-900">
                                    <motion.div
                                        animate={{ y: [0, -10, 0] }}
                                        transition={{
                                            duration: 4,
                                            repeat: Infinity,
                                            delay: idx * 0.7,
                                            ease: "easeInOut"
                                        }}
                                        className="w-24 h-24 relative"
                                    >
                                        <Image src={ship.icon} alt={ship.name} fill className="object-contain p-2" unoptimized />
                                    </motion.div>
                                </div>
                                <div className="grow">
                                    <div className="flex justify-between items-start">
                                        <div>
                                            <h4 className="text-lg font-bold text-white uppercase tracking-tight leading-none">{ship.name}</h4>
                                            {/* Visual Bullet Capacity */}
                                            <div className="flex gap-1 mt-1">
                                                {Array.from({ length: 5 }).map((_, i) => (
                                                    <div
                                                        key={i}
                                                        className={`w-1.5 h-3 rounded-sm transform -skew-x-12 transition-colors duration-500 ${
                                                            i < ship.bullet
                                                            ? 'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]'
                                                            : 'bg-white/10'
                                                        }`}
                                                    />
                                                ))}
                                                <span className="text-[8px] text-cyan-500/50 font-mono ml-1 self-end uppercase">
                                                    Ammo Cap.
                                                </span>
                                            </div>
                                        </div>

                                        {isOwned(ship) ?
                                            <span className="text-cyan-400 font-mono font-bold text-sm bg-cyan-400/10 px-2 py-1 rounded border border-cyan-400/20">Owned</span> :
                                            <span className="text-yellow-400 font-mono font-bold text-sm">
                                                {shipPrices[idx]?.starsPrice > 0
                                                    ? `${shipPrices[idx].starsPrice.toFixed(2)} Stars`
                                                    : `${ship.price} Stars`
                                                }
                                            </span>
                                        }
                                    </div>

                                    {/* STATS BAR */}
                                    <div className="mt-4 space-y-1.5 bg-black/20 p-2 rounded-lg border border-white/5">
                                        <StatBar label="Health" value={ship.hp} max={10} color="bg-red-500" />
                                        <StatBar label="Energy" value={ship.maxEnergy} max={300} color="bg-cyan-500" />
                                        <StatBar label="Damage" value={ship.laserDamage} max={5} color="bg-yellow-400" />
                                    </div>

                                    {!isOwned(ship) && (
                                        <button
                                            onClick={() => handlePurchase(ship)}
                                            disabled={purchasingShip === ship.name}
                                            className="w-full mt-4 py-2 bg-cyan-600 hover:bg-cyan-400 text-black font-black uppercase text-[10px] rounded transition-all tracking-widest cursor-pointer active:scale-95 shadow-lg shadow-cyan-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {purchasingShip === ship.name ? (
                                                <span className="flex items-center justify-center gap-2">
                                                    <span className="animate-spin h-3 w-3 border border-black border-t-transparent rounded-full"></span>
                                                    Purchasing...
                                                </span>
                                            ) : 'Purchase NFT'}
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </motion.div>
        </motion.div>
    );
};

/** Attested feed banner: ETH/USD answer, its age, and the sale switch state. */
function PriceSaleBanner({ status }: { status: PriceOracleStatus | null }) {
    if (status === null) return null
    if (!status.configured) return null
    if (status.answer === null || status.formattedAnswer === null) {
        return (
            <div className="mb-4 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-mono text-white/60">
                Price relay unreachable — showing flat Stars prices.
            </div>
        )
    }
    const age = formatPriceAge(status.ageSeconds)
    if (status.isFresh) {
        return (
            <div className="mb-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-[11px] font-mono text-emerald-200">
                ACTIVE SALE −20% · attested ETH/USD {status.formattedAnswer} (round {status.roundId?.toString() ?? '?'}, {age}).
                Stars has no market price — the feed is a verified relay that gates the sale only.
            </div>
        )
    }
    return (
        <div className="mb-4 rounded-lg border border-yellow-400/30 bg-yellow-400/10 px-3 py-2 text-[11px] font-mono text-yellow-200">
            Sale ended — feed stale · attested ETH/USD {status.formattedAnswer} ({age}, stale &gt;24h).
            Showing flat Stars prices. Stars has no market price.
        </div>
    )
}

/** Single labelled stat meter inside a ship card. */
function StatBar({ label, value, max, color }: { label: string, value: number, max: number, color: string }) {
    const percentage = (value / max) * 100;
    return (
        <div className="flex items-center gap-4">
            <span className="text-[10px] text-white/60 font-mono w-10 uppercase">{label}</span>
            <div className="grow h-1 bg-white/5 rounded-full overflow-hidden">
                <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${percentage}%` }}
                    className={`h-full ${color}`}
                />
            </div>
        </div>
    );
}

export default ShipDealershipModal;
