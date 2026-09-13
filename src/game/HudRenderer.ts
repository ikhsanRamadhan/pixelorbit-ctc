import type { Game } from "./GameEngine";

/* ------------------------------------------------------------------ *
 * HUD renderer — debugging paint only.
 *
 * The player-facing HUD (score, wave, energy, integrity, crates, buff chips,
 * mute state) moved to DOM overlays in game/GameHUD.tsx: canvas
 * text used fixed pixel anchors while React overlays used breakpoints, so
 * Firefox and Chrome laid the same HUD out differently and overlapped.
 *
 * What remains here is the F3 perf overlay, which stays on canvas because it
 * samples engine internals every frame and is a diagnostic tool, not UI.
 *
 * invalidate()/reset() are kept as no-op-compatible entry points: the engine
 * still calls them on resize and restart, and leaving the surface in place
 * avoids touching call sites that predate the DOM migration.
 * ------------------------------------------------------------------ */
export class HudRenderer {
    private game: Game;

    constructor(game: Game) {
        this.game = game;
    }

    invalidate(): void {
        // Kept for existing call sites; the DOM HUD manages its own updates.
    }

    reset(): void {
        // See invalidate().
    }

    draw(context: CanvasRenderingContext2D): void {
        this.game.perf.draw(context, this.game.width);
    }
}
