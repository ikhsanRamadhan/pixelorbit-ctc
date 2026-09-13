"use client";

import { motion } from "motion/react";

interface Star {
    id: number;
    size: number;
    x: number;
    y: number;
    duration: number;
    delay: number;
}

/**
 * Deterministic PRNG (mulberry32). The starfield used to be built from
 * `Math.random()` inside an effect purely to keep the server and client markup
 * identical. A fixed seed gives the same field on both sides, so the layout can
 * be computed once at module scope — no state, no effect, no hydration gap.
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
    const random = createRandom(0x5eed_2a17);
    return Array.from({ length: 250 }, (_, i) => ({
        id: i,
        size: random() < 0.8 ? random() * 1 + 0.5 : random() * 2 + 1,
        x: random() * 100,
        y: random() * 100,
        duration: random() * 4 + 2,
        delay: random() * 5,
    }));
})();

export default function SpaceBackground() {
    return (
        <div className="fixed inset-0 z-[-1] bg-[#02020a] overflow-hidden select-none">
            {STARS.map((star) => (
                <motion.div
                    key={star.id}
                    className="absolute bg-white rounded-full"
                    style={{
                        width: star.size,
                        height: star.size,
                        left: `${star.x}%`,
                        top: `${star.y}%`,
                        boxShadow: star.size > 1.5 ? "0 0 8px 1px white" : "none",
                    }}
                    animate={{
                        opacity: [0.1, 0.7, 0.1],
                        scale: star.size > 1.5 ? [1, 1.2, 1] : [1, 1, 1],
                    }}
                    transition={{
                        duration: star.duration,
                        repeat: Infinity,
                        delay: star.delay,
                        ease: "easeInOut",
                    }}
                />
            ))}

            <div className="absolute top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2 w-160 h-160 bg-purple-900/10 blur-[120px] rounded-full" />
            <div className="absolute bottom-1/4 right-1/4 translate-x-1/2 translate-y-1/2 w-140 h-140 bg-blue-900/10 blur-[100px] rounded-full" />
        </div>
    );
}
