import type { Game } from "./GameEngine";
import type { Boss, EnemyProjectile } from "./entities";
import type { Collidable } from "./types";
import { SpatialGrid } from "./SpatialGrid";
import { intersects } from "./utils";
import { SHAKE } from "./constants";

/* ------------------------------------------------------------------ *
 * Physics — the collision pass.
 *
 * This is where the spatial grid finally gets used. The grid class existed
 * after the first pass but nothing ever called insert() or query(), so every
 * check was still a nested loop: each of ~24 pooled bullets tested against
 * every enemy of every live wave, every step.
 *
 *
 * Collision was previously spread across Enemy.update, Boss.update and
 * Game.update. Concentrating it here is also what makes the bullet-consumed-
 * on-first-hit rule enforceable: a bullet overlapping two enemies in the same
 * step used to damage both.
 * ------------------------------------------------------------------ */

/** Cell edge in pixels. Roughly one enemy sprite (80px) plus slack. */
const CELL_SIZE = 96;

/** Gap between laser hit cues, in simulation ms. */
const LASER_SFX_INTERVAL = 90;

/**
 * The shared surface of Enemy and Boss that the collision pass needs. Both
 * classes satisfy it structurally, so Physics never has to branch on type.
 */
interface Damageable extends Collidable {
    lives: number;
    markedForDeletion: boolean;
    hit(damage: number): void;
}

export class Physics {
    private game: Game;
    private grid: SpatialGrid<Damageable>;

    /** Reused query buffer — the whole pass allocates nothing. */
    private candidates: Damageable[] = [];

    /**
     * A held laser overlaps its targets on every one of 60 steps a second.
     * Without a gate that is 60 hit sounds and 60 shake impulses per second,
     * which reads as a buzz and a constant tremor.
     */
    private laserSfxCooldown = 0;

    constructor(game: Game) {
        this.game = game;
        this.grid = new SpatialGrid<Damageable>(game.width, game.height, CELL_SIZE);
    }

    resize(width: number, height: number): void {
        // Without this the grid keeps its original bucket table, and anything
        // in the newly exposed area hashes out of bounds and stops colliding.
        this.grid.resize(width, height);
    }

    reset(): void {
        this.grid.clear();
        this.candidates.length = 0;
        this.laserSfxCooldown = 0;
    }

    update(step: number): void {
        if (this.laserSfxCooldown > 0) this.laserSfxCooldown -= step;

        this.rebuildGrid();
        this.resolvePlayerProjectiles();
        this.resolveLaser();
        this.resolveBodies();
        this.resolveHostileProjectiles();
    }

    /* -------------------------------------------------------------- *
     * Broad phase
     * -------------------------------------------------------------- */

    private rebuildGrid(): void {
        const grid = this.grid;
        grid.clear();

        const bosses = this.game.bosses;
        for (let i = 0; i < bosses.length; i++) {
            const boss = bosses[i];
            // A dying entity is mid death-animation and must not absorb hits.
            if (boss.lives < 1 || boss.markedForDeletion) continue;
            grid.insert(boss);
        }

        const waves = this.game.waves;
        for (let w = 0; w < waves.length; w++) {
            const enemies = waves[w].enemies;
            for (let i = 0; i < enemies.length; i++) {
                const enemy = enemies[i];
                if (enemy.lives < 1 || enemy.markedForDeletion) continue;
                grid.insert(enemy);
            }
        }
    }

    /* -------------------------------------------------------------- *
     * Narrow phase
     * -------------------------------------------------------------- */

    private resolvePlayerProjectiles(): void {
        const projectiles = this.game.projectiles;

        for (let p = 0; p < projectiles.length; p++) {
            const projectile = projectiles[p];
            if (projectile.free) continue;

            const candidates = this.grid.queryInto(projectile, this.candidates);

            for (let c = 0; c < candidates.length; c++) {
                const target = candidates[c];
                if (target.lives < 1) continue;
                if (!intersects(projectile, target)) continue;

                target.hit(1);
                this.onDamaged(target);

                // One bullet, one hit. Stop before the remaining candidates.
                projectile.reset();
                break;
            }
        }
    }

    private resolveLaser(): void {
        const laser = this.game.player.laser;
        if (!laser.active) return;

        // The laser is a full-height column; its own x/width/height already
        // describe the probe box.
        const probe: Collidable = {
            x: laser.x,
            y: laser.y,
            width: laser.width,
            height: laser.height,
        };

        const damage = laser.damage;
        const candidates = this.grid.queryInto(probe, this.candidates);
        let struck = false;

        for (let c = 0; c < candidates.length; c++) {
            const target = candidates[c];
            if (target.lives < 1) continue;
            if (!intersects(probe, target)) continue;

            // Unlike a bullet the beam is continuous, so it damages everything
            // in the column rather than stopping at the first target.
            target.hit(damage);
            struck = true;
        }

        if (struck && this.laserSfxCooldown <= 0) {
            this.laserSfxCooldown = LASER_SFX_INTERVAL;
            this.game.audio.play("hit", 0.3);
        }
    }

    /** Contact damage: an enemy or boss body touching the ship. */
    private resolveBodies(): void {
        const player = this.game.player;
        if (player.lives < 1) return;

        const candidates = this.grid.queryInto(player, this.candidates);

        for (let c = 0; c < candidates.length; c++) {
            const target = candidates[c];
            if (target.lives < 1) continue;
            if (!intersects(player, target)) continue;

            // The body is destroyed on impact regardless of whether the shield
            // absorbed the damage.
            target.hit(target.lives);

            if (player.takeDamage(1)) return;
        }
    }

    private resolveHostileProjectiles(): void {
        const canHit = this.game.player.lives >= 1;
        this.stepHostile(this.game.enemyProjectiles, canHit);
        this.stepHostile(this.game.bossProjectiles, canHit);
    }

    private stepHostile(list: EnemyProjectile[], canHit: boolean): void {
        const player = this.game.player;
        const height = this.game.height;

        for (let i = 0; i < list.length; i++) {
            const projectile = list[i];
            projectile.update();

            if (projectile.position.y > height) {
                projectile.markedForDeletion = true;
                continue;
            }

            if (!canHit) continue;
            if (!intersects(projectile, player)) continue;

            projectile.markedForDeletion = true;
            if (player.takeDamage(1)) return;
        }
    }

    /* -------------------------------------------------------------- *
     * Feedback
     * -------------------------------------------------------------- */

    /** Bosses get their own hit cue; regular enemies share the light one. */
    private onDamaged(target: Damageable): void {
        if (this.isBoss(target)) {
            this.game.audio.play("bossHit", 0.4);
            this.game.triggerShake(SHAKE.bossHit.intensity, SHAKE.bossHit.duration);
        } else {
            this.game.audio.play("hit", 0.3);
        }
    }

    /**
     * `name` is only ever set on Boss, so this identifies the type without
     * importing the class at runtime and reintroducing a module cycle.
     */
    private isBoss(target: Damageable): target is Boss {
        return typeof (target as Partial<Boss>).name === "string";
    }
}
