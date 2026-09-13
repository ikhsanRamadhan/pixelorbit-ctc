import type { Game } from "./GameEngine";
import type { Particle } from "./entities";

/* ------------------------------------------------------------------ *
 * Renderer — world composition and screen shake.
 *
 * Owns the per-frame draw order and the shake transform that used to live in
 * Game.draw(). Entity classes keep their own draw() for sprite detail; this
 * decides what is painted, in what order, and under which transform.
 *
 * Three things the first pass got wrong, fixed here:
 *
 *   1. Shake was decremented inside draw() with `this.shakeDuration--`, so its
 *      length was measured in frames. At 144Hz every shake lasted 2.4x less
 *      time than at 60Hz. It advances in simulation ms now, from the fixed
 *      step, exactly like every other timer.
 *   2. `progress = shakeDuration / 60` treated the duration as if it were
 *      always 60 units, so a longer shake started above 1 and sat at full
 *      intensity for its first second. Progress is remaining/total now, a true
 *      0..1 decay.
 *   3. The shake translate wrapped drawHud(), so the score panel juddered with
 *      the world. The HUD is drawn outside the transform.
 * ------------------------------------------------------------------ */

export class Renderer {
    private game: Game;

    private shakeIntensity = 0;
    private shakeRemaining = 0;
    private shakeTotal = 0;

    constructor(game: Game) {
        this.game = game;
    }

    /**
     * Starts a shake, or replaces the current one if the new impulse is
     * stronger. Comparing against the decayed intensity rather than
     * overwriting blindly means a stream of small enemy-death shakes cannot
     * cancel the boss-death slam that triggered them.
     */
    trigger(intensity: number, duration: number): void {
        if (this.shakeRemaining > 0 && intensity <= this.currentIntensity()) return;
        this.shakeIntensity = intensity;
        this.shakeRemaining = duration;
        this.shakeTotal = duration;
    }

    updateShake(step: number): void {
        if (this.shakeRemaining <= 0) return;
        this.shakeRemaining -= step;
        if (this.shakeRemaining < 0) this.shakeRemaining = 0;
    }

    reset(): void {
        // Previously leaked across runs: dying mid-shake left the next run
        // trembling for its first second.
        this.shakeIntensity = 0;
        this.shakeRemaining = 0;
        this.shakeTotal = 0;
    }

    /** Linear decay from full intensity to zero over the shake's lifetime. */
    private currentIntensity(): number {
        if (this.shakeRemaining <= 0 || this.shakeTotal <= 0) return 0;
        return this.shakeIntensity * (this.shakeRemaining / this.shakeTotal);
    }

    /* -------------------------------------------------------------- *
     * Frame
     * -------------------------------------------------------------- */

    draw(context: CanvasRenderingContext2D): void {
        const game = this.game;

        if (game.gameOver || game.player.lives < 1) {
            game.player.draw(context);
            game.hudRenderer.draw(context);
            return;
        }

        const intensity = this.currentIntensity();

        context.save();
        if (intensity > 0) {
            context.translate(
                (Math.random() - 0.5) * intensity,
                (Math.random() - 0.5) * intensity
            );
        }

        this.drawPlayerProjectiles(context);
        this.drawEnemyProjectiles(context);
        this.drawBossProjectiles(context);

        for (let i = 0; i < game.items.length; i++) game.items[i].draw(context);
        for (let i = 0; i < game.powerUps.length; i++) game.powerUps[i].draw(context);

        game.player.draw(context);
        this.drawShieldAura(context);

        for (let i = 0; i < game.bosses.length; i++) game.bosses[i].draw(context);
        for (let i = 0; i < game.waves.length; i++) game.waves[i].draw(context);

        this.drawParticles(context, game.particles);

        context.restore();

        // Outside the transform: a juddering score panel is nausea, not impact.
        game.hudRenderer.draw(context);
    }

    /* -------------------------------------------------------------- *
     * Passes
     * -------------------------------------------------------------- */

    /** One fillStyle and one path for the whole volley. */
    private drawPlayerProjectiles(context: CanvasRenderingContext2D): void {
        const projectiles = this.game.projectiles;

        context.fillStyle = this.game.ship.laserColor;
        context.beginPath();
        for (let i = 0; i < projectiles.length; i++) {
            const projectile = projectiles[i];
            if (projectile.free) continue;
            context.moveTo(projectile.cx + projectile.radius, projectile.cy);
            context.arc(projectile.cx, projectile.cy, projectile.radius, 0, Math.PI * 2);
        }
        context.fill();
    }

    private drawEnemyProjectiles(context: CanvasRenderingContext2D): void {
        const list = this.game.enemyProjectiles;
        if (list.length === 0) return;

        context.fillStyle = "red";
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            context.fillRect(p.position.x, p.position.y, p.width, p.height);
        }
    }

    private drawBossProjectiles(context: CanvasRenderingContext2D): void {
        const list = this.game.bossProjectiles;
        if (list.length === 0) return;

        context.fillStyle = "red";
        context.beginPath();
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            const r = Math.min(p.width, p.height) / 2;
            const cx = p.position.x + p.width / 2;
            const cy = p.position.y + p.height / 2;
            context.moveTo(cx + r, cy);
            context.arc(cx, cy, r, 0, Math.PI * 2);
        }
        context.fill();
    }

    /** Visible proof the shield buff is up — otherwise it has no tell. */
    private drawShieldAura(context: CanvasRenderingContext2D): void {
        const player = this.game.player;
        if (!player.hasPowerUp("shield")) return;

        const cx = player.x + player.width / 2;
        const cy = player.y + player.height / 2;
        const radius = Math.max(player.width, player.height) * 0.62;

        context.save();
        context.strokeStyle = "rgba(34, 211, 238, 0.75)";
        context.lineWidth = 2;
        context.shadowColor = "#22d3ee";
        context.shadowBlur = 14;
        context.beginPath();
        context.arc(cx, cy, radius, 0, Math.PI * 2);
        context.stroke();
        context.restore();
    }

    private drawParticles(context: CanvasRenderingContext2D, particles: Particle[]): void {
        if (particles.length === 0) return;

        const originalAlpha = context.globalAlpha;

        for (let i = 0; i < particles.length; i++) {
            const particle = particles[i];
            context.globalAlpha = particle.opacity;
            context.fillStyle = particle.color;
            context.beginPath();
            context.arc(particle.position.x, particle.position.y, particle.radius, 0, Math.PI * 2);
            context.fill();
        }

        context.globalAlpha = originalAlpha;
    }
}
