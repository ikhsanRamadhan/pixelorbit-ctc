"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import type { SalvageCrate } from "@/components/utils/Items";
import { POWER_UP_SPECS } from "@/game/types";
import type { EnergySnapshot, PowerUpSnapshot } from "@/game/types";

/* ------------------------------------------------------------------ *
 * DOM HUD — every player-facing readout, in one layout system.
 *
 * Replaces the old split where HudRenderer painted score/energy/crates to
 * canvas at fixed pixel anchors while React floated the Neural-Link panel
 * and Pause button over it at Tailwind breakpoints. Two coordinate systems
 * meant Firefox and Chrome agreed on neither font metrics nor overlay
 * position, so the pieces drifted into each other. Everything below is
 * absolute-positioned inside the same container as the <canvas>, from the
 * same Tailwind scale — every browser lays it out identically.
 *
 * Canvas keeps only the world and the F3 perf overlay.
 * ------------------------------------------------------------------ */

interface GameHudProps {
    pilotName: string;
    score: number;
    wave: number;
    lives: number;
    maxLives: number;
    energy: EnergySnapshot;
    powerUps: PowerUpSnapshot[];
    muted: boolean;
    collectedItems: SalvageCrate[];
    showHints: boolean;
    onPause: () => void;
}

export default function GameHUD({
    pilotName,
    score,
    wave,
    lives,
    maxLives,
    energy,
    powerUps,
    muted,
    collectedItems,
    showHints,
    onPause,
}: GameHudProps) {
    return (
        <div className="pointer-events-none absolute inset-0 z-30 font-mono">
            {/* ---- top-left: pilot link + score/wave/energy ---- */}
            <div className="absolute top-3 left-3 md:top-5 md:left-5 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-cyan-500 animate-ping" />
                    <span className="text-cyan-400 text-[9px] md:text-[10px] uppercase tracking-widest">
                        Neural Link: Active
                    </span>
                </div>
                <span className="text-cyan-400 text-[9px] md:text-[10px] uppercase">
                    Pilot: {pilotName}
                </span>

                <div className="mt-1 rounded-md border border-cyan-400/30 bg-black/50 backdrop-blur-sm px-3 py-2 w-44 md:w-52">
                    <div className="text-white text-xs md:text-sm">
                        SCORE: <span>{score.toLocaleString()}</span>
                    </div>
                    <div className="text-cyan-400 text-xs md:text-sm">
                        WAVE : <span>{wave}</span>
                    </div>

                    <div className="mt-2 text-[8px] md:text-[9px] uppercase text-white/70">
                        {energy.cooldown ? "Recharging..." : "Laser Energy"}
                    </div>
                    <div className="mt-0.5 h-2.5 w-full rounded bg-white/10 overflow-hidden">
                        <div
                            className={`h-full rounded transition-[width] duration-100 ease-linear ${energy.cooldown
                                    ? "bg-linear-to-r from-red-900 to-red-500"
                                    : "bg-linear-to-r from-yellow-700 to-yellow-400"
                                }`}
                            style={{
                                width: `${Math.max(
                                    0,
                                    Math.min(1, energy.energy / Math.max(1, energy.maxEnergy))
                                ) * 100}%`,
                            }}
                        />
                    </div>
                </div>

                {showHints && (
                    <>
                        <div className="md:hidden text-cyan-500/70 text-[8px] uppercase tracking-widest">
                            Drag to steer · hold to fire
                        </div>
                        <div className="hidden md:block text-cyan-500/70 text-[8px] uppercase tracking-widest">
                            ← → move · space fire · ctrl laser · m mute
                        </div>
                    </>
                )}

                {/* power-up chips live under the pilot block so they can never
                    land on top of it — the old canvas anchor at y=210 did. */}
                <div className="mt-1 flex flex-col gap-1">
                    <AnimatePresence>
                        {powerUps.map((p) => (
                            <PowerUpChip key={p.type} snapshot={p} />
                        ))}
                    </AnimatePresence>
                </div>
            </div>

            {/* ---- top-right: integrity + mute + pause ---- */}
            <div className="absolute top-3 right-3 md:top-5 md:right-5 flex flex-col items-end gap-2">
                <div className="hidden md:block text-white/90 text-[10px] md:text-xs uppercase">
                    Ship Integrity
                </div>
                <div className="flex gap-1 md:gap-1.5">
                    {Array.from({ length: maxLives }, (_, i) => {
                        const lost = i >= lives;
                        return (
                            <span
                                key={i}
                                className={
                                    "inline-block w-2 h-2 md:w-3.5 md:h-3.5 rotate-45 border " +
                                    (lost
                                        ? "border-white/15 bg-transparent"
                                        : "border-cyan-300 bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]")
                                }
                            />
                        );
                    })}
                </div>
                {muted && (
                    <div className="text-white/50 text-[9px] md:text-[10px] uppercase">
                        Muted (M)
                    </div>
                )}
                <button
                    onClick={onPause}
                    aria-label="Pause mission"
                    className="pointer-events-auto mt-1 px-2 md:px-4 py-2 min-h-[44px] min-w-[44px] flex items-center justify-center border border-yellow-500/30 text-yellow-500 text-xs uppercase tracking-[0.1em] md:tracking-[0.3em] hover:bg-yellow-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 transition-all cursor-pointer bg-black/40 backdrop-blur-sm"
                >
                    <span className="inline md:hidden" aria-hidden="true">❚❚</span>
                    <span className="hidden md:inline">[ Pause Mission ]</span>
                </button>
            </div>

            {/* ---- bottom-left: salvage crates ---- */}
            {collectedItems.length > 0 && (
                <div className="absolute bottom-3 left-3 md:bottom-5 md:left-5 flex flex-wrap gap-1.5 max-w-[55vw]">
                    {collectedItems.map((crate) => (
                        <div
                            key={crate.id}
                            className="w-8 h-8 md:w-9 md:h-9 border border-cyan-400/70 bg-black/40 flex items-center justify-center text-cyan-400 text-xs font-bold"
                        >
                            ?
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ */

function PowerUpChip({ snapshot }: { snapshot: PowerUpSnapshot }) {
    const spec = POWER_UP_SPECS[snapshot.type];

    /* Animate the drain bar with a pure CSS transition from 100%→0 over the
        buff's remaining lifetime. One state push when the chip mounts, zero
        re-renders while it drains. `performance.now()` is impure, so it lives
        in the mount effect rather than in render. */
    const [draining, setDraining] = useState(false);
    const [remainingMs, setRemainingMs] = useState(0);
    useEffect(() => {
        setRemainingMs(Math.max(0, snapshot.expiresAt - performance.now()));
        const raf = requestAnimationFrame(() => setDraining(true));
        return () => cancelAnimationFrame(raf);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot is a mount-time contract
    }, []);

    const expiringSoon = snapshot.duration > 0 && remainingMs > 0 && remainingMs < 2000;

    return (
        <motion.div
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            className="relative w-24 md:w-26 rounded border bg-black/60 px-2 py-1 overflow-hidden"
            style={{ borderColor: spec.color }}
        >
            <span
                className={`text-[9px] md:text-[10px] uppercase ${expiringSoon ? "animate-pulse" : ""}`}
                style={{ color: spec.color }}
            >
                {spec.glyph} {spec.label}
            </span>
            <div className="absolute left-1 right-1 bottom-0.5 h-0.5 bg-white/10">
                <div
                    className="h-full ease-linear"
                    style={{
                        backgroundColor: spec.color,
                        width: draining ? "0%" : "100%",
                        transition: draining
                            ? `width ${remainingMs}ms linear`
                            : "none",
                    }}
                />
            </div>
        </motion.div>
    );
}
