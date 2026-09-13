import type { Dispatch, SetStateAction } from "react";
import type { SalvageCrate } from "@/components/utils/Items";
import type { AlienData, BossData, NextImageObject } from "@/components/utils/Enemy";

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

export interface Position {
    x: number;
    y: number;
}

/** Anything that can go into an AABB test or the spatial grid. */
export interface Collidable {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ParticleOptions {
    position: Position;
    velocity: Position;
    radius: number;
    color: string;
    fades: boolean;
}

/** Accepted shapes for an image source: raw URL, or a Next static import. */
export type ImageSource = string | NextImageObject | { src: string };

/* ------------------------------------------------------------------ *
 * Power-ups
 * ------------------------------------------------------------------ */

export type PowerUpType = "rapidFire" | "shield" | "multiShot" | "speedBoost";

export interface ActivePowerUp {
    type: PowerUpType;
    /** Remaining lifetime in simulation milliseconds. Counts down in update(). */
    remaining: number;
    /** Original duration, kept so the HUD can draw a 0..1 progress bar. */
    duration: number;
}

/** Presentation + tuning for each buff. No image assets required. */
export interface PowerUpSpec {
    type: PowerUpType;
    label: string;
    glyph: string;
    color: string;
    /** Simulation milliseconds the buff lasts once collected. */
    duration: number;
}

export const POWER_UP_SPECS: Record<PowerUpType, PowerUpSpec> = {
    rapidFire: { type: "rapidFire", label: "RAPID", glyph: "»", color: "#facc15", duration: 10000 },
    shield: { type: "shield", label: "SHIELD", glyph: "◇", color: "#22d3ee", duration: 8000 },
    multiShot: { type: "multiShot", label: "MULTI", glyph: "∴", color: "#e879f9", duration: 12000 },
    speedBoost: { type: "speedBoost", label: "SPEED", glyph: "⇉", color: "#4ade80", duration: 10000 },
};

export const POWER_UP_TYPES: PowerUpType[] = ["rapidFire", "shield", "multiShot", "speedBoost"];

/* ------------------------------------------------------------------ *
 * Engine callbacks — replaces the old window bridge.
 *
 * Canvas.tsx hands the engine its setters and config through this typed
 * object instead of polluting `window`. Type-safe, testable, and free of
 * the memory leaks that global references caused.
 * ------------------------------------------------------------------ */

export interface GameCallbacks {
    onScoreChange?: (score: number) => void;
    onHpChange?: (hp: number) => void;
    onWaveChange?: (wave: number) => void;
    /**
     * Energy and cooldown ride together so the bar never shows a stale
     * "RECHARGING" label over a refilled bar. Throttled by HudBridge.
     */
    onEnergyChange?: (snapshot: EnergySnapshot) => void;
    /**
     * Fired only on add/remove/expiry of a buff — never per tick. Drain bars
     * are animated in the DOM from `expiresAt`, so a 60Hz callback would just
     * burn scheduler time for pixels already moving.
     */
    onPowerUpsChange?: (list: PowerUpSnapshot[]) => void;
    onMuteChange?: (muted: boolean) => void;
    /**
     * Mirrors React's Dispatch<SetStateAction<T>> so `props.setCollectedItems`
     * can be passed straight through. The previous signature only accepted an
     * updater function, which made the engine's own `setCollectedItems([])`
     * calls a type error.
     */
    onCollectedItemsChange?: Dispatch<SetStateAction<SalvageCrate[]>>;
    getAliens?: () => AlienData[];
    getBosses?: () => BossData[];
}

export interface EnergySnapshot {
    energy: number;
    maxEnergy: number;
    cooldown: boolean;
}

export interface PowerUpSnapshot {
    type: PowerUpType;
    duration: number;
    /** performance.now() ms at which the buff lapses. */
    expiresAt: number;
}
