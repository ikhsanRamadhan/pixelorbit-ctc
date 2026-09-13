'use client';
import { useState } from "react";
import { motion } from "motion/react";
import Image from "next/image";
import { useMarketplace } from "@/hooks/useMarketplace";
import SkeletonBar from "@/components/ui/SkeletonBar";
import MarketplaceModal from "@/components/ui/MarketplaceModal";

interface MarketplaceProps {
    title: string;
    delay: number;
}

function FeatureCardMarketplace({ title, delay }: MarketplaceProps) {
    const { allListing, isLoading } = useMarketplace();
    const [isMarketOpen, setIsMarketOpen] = useState(false);

    return (
        <>
            {/* MINI PREVIEW CARD */}
            <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay, duration: 0.8 }}
                onClick={() => setIsMarketOpen(true)}
                className="relative p-6 rounded-xl border border-amber-500/30 bg-black/40 backdrop-blur-md group hover:border-amber-400 cursor-pointer transition-all duration-300 h-full flex flex-col overflow-hidden"
            >
                <div className="absolute top-2 right-3 text-[8px] text-amber-500/60 font-mono italic">MARKET_LIVE_V1</div>
                <h3 className="text-amber-400 font-bold uppercase tracking-[0.2em] text-center mb-6 mt-4 text-sm">{title}</h3>
                <div className="grow flex justify-around items-center gap-2 py-4">
                    {isLoading ? (
                        Array.from({ length: 4 }).map((_, idx) => (
                            <SkeletonBar key={idx} className="w-12 h-12 rounded-xl" />
                        ))
                    ) : (
                        allListing.slice(0, 4).map((item, idx) => (
                            <div key={idx} className="relative w-12 h-12">
                                <Image src={item.image} alt={item.name} fill className="object-contain" unoptimized />
                            </div>
                        ))
                    )}
                    {!isLoading && allListing.length === 0 && <span className="text-gray-600 text-[10px] font-mono uppercase">No Active Listings</span>}
                </div>
                <div className="text-center mt-2 animate-pulse">
                    <span className="text-[9px] text-amber-500/60 font-mono">[ ENTER MARKETPLACE ]</span>
                </div>
            </motion.div>

            <MarketplaceModal
                isOpen={isMarketOpen}
                onClose={() => setIsMarketOpen(false)}
                allListing={allListing}
                isLoading={isLoading}
            />
        </>
    );
}

export default FeatureCardMarketplace;
