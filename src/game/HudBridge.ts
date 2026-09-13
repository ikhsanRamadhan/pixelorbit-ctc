import type { SetStateAction } from "react";
import type { SalvageCrate } from "@/components/utils/Items";
import type { AlienData, BossData } from "@/components/utils/Enemy";
import type {
    EnergySnapshot,
    GameCallbacks,
    PowerUpSnapshot,
    PowerUpType,
} from "./types";

/* ------------------------------------------------------------------ *
 * HUD bridge — the engine's one way out to React.
 *
 * Replaces the old `window.__gameSetScores` style bridge. Just as
 * importantly it replaces the module-level `activeCallbacks` /
 * `lastScoreSent` / `lastHpSent` globals that the first pass left behind:
 * those were shared by every Game ever constructed, so a remount or a ship
 * change silently redirected the previous instance's HUD updates into the
 * new instance's setters. State lives on the instance now.
 * ------------------------------------------------------------------ */

/** Energy regen runs every sim step; the bar only needs ~12Hz to look live. */
const ENERGY_PUSH_MIN_INTERVAL = 80;

export class HudBridge {
    private callbacks: GameCallbacks;

    /*
     * render() runs 60x/second. Pushing an unchanged value into a setState
     * still costs a scheduler round-trip and a parent re-render, so every
     * channel is gated on the value actually changing.
     */
    private lastScore = NaN;
    private lastHp = NaN;
    private lastWave = NaN;
    private lastEnergy = NaN;
    private lastCooldown: boolean | null = null;
    private lastEnergyPush = 0;
    private lastPowerUpKey = "";
    private lastMuted: boolean | null = null;

    constructor(callbacks: GameCallbacks = {}) {
        this.callbacks = callbacks;
    }

    setScore(score: number): void {
        if (score === this.lastScore) return;
        this.lastScore = score;
        this.callbacks.onScoreChange?.(score);
    }

    setHp(hp: number): void {
        if (hp === this.lastHp) return;
        this.lastHp = hp;
        this.callbacks.onHpChange?.(hp);
    }

    setWave(wave: number): void {
        if (wave === this.lastWave) return;
        this.lastWave = wave;
        this.callbacks.onWaveChange?.(wave);
    }

    /**
     * Called once per render() from Game.render. Pushes immediately on a
     * cooldown edge (the label flips), otherwise throttles the smooth regen
     * to one update per ENERGY_PUSH_MIN_INTERVAL wall-clock ms.
     */
    setEnergy(energy: number, maxEnergy: number, cooldown: boolean): void {
        const now = performance.now();
        const cooldownEdge = cooldown !== this.lastCooldown;
        const settled = energy === this.lastEnergy && energy >= maxEnergy;
        if (!cooldownEdge && (settled || now - this.lastEnergyPush < ENERGY_PUSH_MIN_INTERVAL)) {
            return;
        }
        this.lastEnergyPush = now;
        this.lastEnergy = energy;
        this.lastCooldown = cooldown;
        const snapshot: EnergySnapshot = { energy, maxEnergy, cooldown };
        this.callbacks.onEnergyChange?.(snapshot);
    }

    /**
     * type+remaining+duration identifies a buff set; equality means the DOM
     * already has the right chips and `expiresAt` values, so only structural
     * changes (add, refresh, expiry) cross the bridge.
     */
    setPowerUps(list: Array<{ type: PowerUpType; remaining: number; duration: number }>): void {
        let key = "";
        for (let i = 0; i < list.length; i++) {
            const entry = list[i];
            key += `${entry.type}:${Math.round(entry.remaining)}:${entry.duration};`;
        }
        if (key === this.lastPowerUpKey) return;
        this.lastPowerUpKey = key;

        const now = performance.now();
        const snapshot: PowerUpSnapshot[] = list.map((entry) => ({
            type: entry.type,
            duration: entry.duration,
            expiresAt: now + entry.remaining,
        }));
        this.callbacks.onPowerUpsChange?.(snapshot);
    }

    setMuted(muted: boolean): void {
        if (muted === this.lastMuted) return;
        this.lastMuted = muted;
        this.callbacks.onMuteChange?.(muted);
    }

    /** Lets a fresh run re-push its opening values past the equality gate. */
    resetCache(): void {
        this.lastScore = NaN;
        this.lastHp = NaN;
        this.lastWave = NaN;
        this.lastEnergy = NaN;
        this.lastCooldown = null;
        this.lastEnergyPush = 0;
        this.lastPowerUpKey = "";
    }

    /**
     * Accepts a value or an updater, matching React's Dispatch<SetStateAction>.
     * The previous signature only allowed an updater, which made the engine's
     * own `setCollectedItems([])` reset calls a compile error.
     */
    setCollectedItems(value: SetStateAction<SalvageCrate[]>): void {
        this.callbacks.onCollectedItemsChange?.(value);
    }

    getAliens(): AlienData[] {
        return this.callbacks.getAliens?.() ?? [];
    }

    getBosses(): BossData[] {
        return this.callbacks.getBosses?.() ?? [];
    }

    /** Drops the React references so a torn-down engine cannot hold them alive. */
    dispose(): void {
        this.callbacks = {};
    }
}
