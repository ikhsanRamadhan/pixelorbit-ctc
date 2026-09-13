"use client";
import { motion } from "motion/react";

export default function PixelorbitLogo() {
    const text = "PIXELORBIT";

    return (
        <div className="relative flex flex-col items-center py-20 px-10">
            <motion.div 
                className="relative group"
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 1.8, duration: 0.8 }}
            >
                <motion.div 
                    animate={{ 
                        opacity: [0.3, 0.6, 0.3],
                        scale: [1, 1.05, 1],
                    }}
                    transition={{
                        duration: 4,
                        repeat: Infinity,
                        ease: "easeInOut"
                    }}
                    whileHover={{ opacity: 0.9, filter: "blur(60px)", scale: 1.1 }}
                    className="absolute inset-0 blur-3xl select-none font-orbitron font-black italic text-7xl md:text-9xl tracking-tighter uppercase text-cyan-500 text-center whitespace-nowrap"
                >
                    {text}
                </motion.div>

                <div className="relative font-orbitron font-black italic text-7xl md:text-9xl tracking-tighter uppercase whitespace-nowrap">
                    <span className="absolute inset-0 text-black translate-y-1 translate-x-1 opacity-80 select-none">
                        {text}
                    </span>

                    <motion.span 
                        animate={{ 
                            y: [0, -8, 0],
                        }}
                        transition={{
                            duration: 5,
                            repeat: Infinity,
                            ease: "easeInOut"
                        }}
                        className="relative block bg-clip-text text-transparent bg-linear-to-b from-[#8DEBFF] via-[#BD00FF] to-[#0047FF] pb-4 pr-10"
                    >
                        {text}
                    </motion.span>
                </div>
            </motion.div>

            <motion.div 
                className="relative group"
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 1.8, duration: 0.8 }}
            >
                <motion.p 
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ 
                        opacity: [0.4, 1, 0.4], 
                        y: [0, -5, 0],          
                    }} 
                    transition={{
                        opacity: {
                            duration: 3,
                            repeat: Infinity,
                            ease: "easeInOut"
                        },
                        y: {
                            duration: 4,
                            repeat: Infinity,
                            ease: "easeInOut"
                        }
                    }}
                    className="mt-6 text-center text-cyan-300 font-bold tracking-[0.4em] text-[10px] md:text-sm uppercase drop-shadow-[0_0_12px_rgba(34,211,238,0.8)]"
                >
                    Web3 Space Shooter • Powered by Creditcoin
                </motion.p>
            </motion.div>
        </div>
    );
}