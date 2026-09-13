'use client';
import { useState } from "react";
import { motion } from "motion/react";
import Image from "next/image";
import { Ship } from "@/components/utils/Spaceships";
import ShipDealershipModal from "@/components/ui/ShipDealershipModal";

interface FeatureCardProps {
    title: string;
    data: Ship[];
    delay: number;
};

function FeatureCardSpaceships({ title, data, delay }: FeatureCardProps) {
    const [isMarketOpen, setIsMarketOpen] = useState(false);

    return (
        <>
            {/* MINI PREVIEW CARD */}
            <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay, duration: 0.8 }}
                onClick={() => setIsMarketOpen(true)}
                className="relative p-6 rounded-xl border border-cyan-500/30 bg-black/40 backdrop-blur-md group hover:border-cyan-400 cursor-pointer transition-all duration-300 h-full flex flex-col overflow-hidden"
            >
                <div className="absolute inset-0 bg-linear-to-b from-transparent via-cyan-500/5 to-transparent -translate-y-full group-hover:translate-y-full transition-transform duration-2000 ease-in-out" />

                <div className="absolute top-2 right-3 text-[8px] text-cyan-500/60 font-mono tracking-tighter">
                    SHIPS_DEALERSHIP_V1.0
                </div>

                <h3 className="text-cyan-400 font-bold uppercase tracking-[0.2em] text-center mb-6 mt-4 text-sm">
                    {title}
                </h3>

                <div className="grow flex justify-around items-center gap-2 py-4">
                    {data.slice(0, 4).map((ship, idx) => (
                        <motion.div
                            key={idx}
                            animate={{ y: [0, -10, 0] }}
                            transition={{
                                duration: 4,
                                repeat: Infinity,
                                delay: idx * 0.7,
                                ease: "easeInOut"
                            }}
                            className="relative w-16 h-16 md:w-20 md:h-20"
                        >
                            <Image
                                src={ship.icon}
                                alt={ship.name}
                                fill
                                className="object-contain filter drop-shadow-[0_0_8px_rgba(34,211,238,0.4)] group-hover:drop-shadow-[0_0_15px_rgba(34,211,238,0.7)]"
                                unoptimized
                            />
                        </motion.div>
                    ))}
                </div>

                <div className="text-center mt-2">
                    <span className="text-[9px] text-cyan-500/60 font-mono animate-pulse">
                        [ ACCESS SHIP DEALERSHIP ]
                    </span>
                </div>

                <div className="absolute bottom-0 left-0 w-full h-0.5 bg-linear-to-r from-transparent via-cyan-500 to-transparent opacity-50" />
            </motion.div>

            <ShipDealershipModal
                isOpen={isMarketOpen}
                onClose={() => setIsMarketOpen(false)}
                data={data}
            />
        </>
    );
};

export default FeatureCardSpaceships;
