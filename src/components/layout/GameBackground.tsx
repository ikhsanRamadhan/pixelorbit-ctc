"use client";
import { motion } from "motion/react";

interface Star {
    id: number;
    size: number;
    x: number;
    fallDuration: number;
    blinkDuration: number;
    delay: number;
};

/**
 * Deterministic PRNG (mulberry32). Seeded so the server and client produce the
 * same starfield, which is what the old `Math.random()`-inside-an-effect
 * arrangement was really working around. See SpaceBackground for the twin.
 */
function createRandom(seed: number) {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const STARS: Star[] = (() => {
    const random = createRandom(0x9a1c_04d3);
    return Array.from({ length: 150 }, (_, i) => ({
        id: i,
        size: random() * 2 + 0.5,
        x: random() * 100,
        fallDuration: random() * 10 + 5,
        blinkDuration: random() * 3 + 1,
        delay: random() * -20,
    }));
})();

export default function GameBackground() {
    return (
        <div className="fixed inset-0 z-[-1] bg-[#02020a] overflow-hidden">
            {STARS.map((star: Star) => (
                <motion.div
                    key={star.id}
                    className="absolute bg-white rounded-full"
                    style={{
                        width: star.size,
                        height: star.size,
                        left: `${star.x}%`,
                        boxShadow: star.size > 1.5 ? "0 0 5px white" : "none",
                    }}
                    animate={{
                        top: ["-5%", "105%"],
                        opacity: [0.2, 0.8, 0.2],
                    }}
                    transition={{
                        top: {
                            duration: star.fallDuration,
                            repeat: Infinity,
                            ease: "linear",
                            delay: star.delay
                        },
                        opacity: {
                            duration: star.blinkDuration,
                            repeat: Infinity,
                            ease: "easeInOut"
                        }
                    }}
                />
            ))}
            <div className="absolute inset-0 bg-linear-to-b from-transparent via-purple-900/5 to-black/20" />
        </div>
    );
}
