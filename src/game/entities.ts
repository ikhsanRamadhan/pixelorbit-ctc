import type { SalvageCrate } from "@/components/utils/Items";
import type { MySpaceships } from "@/components/utils/Spaceships";
import type { AlienData, BossData } from "@/components/utils/Enemy";

import type { Game } from "./GameEngine";
import type { ActivePowerUp, Collidable, ImageSource, Position, PowerUpType } from "./types";
import { POWER_UP_SPECS } from "./types";
import { clamp, compact, intersects, isDrawable, loadImage } from "./utils";
import {
    BASE_SPEED,
    BOOSTED_SPEED,
    BOSS_HP_GROWTH,
    BOSS_SHOOT_MIN_INTERVAL,
    ELITE_ENEMY_HP_THRESHOLD,
    ELITE_ENEMY_SHOOT_CHANCE,
    ENEMY_SHOOT_CHANCE,
    ENEMY_SIZE,
    FIRE_INTERVAL,
    POWER_UP_FALL_SPEED,
    POWER_UP_SIZE,
    RAPID_FIRE_INTERVAL,
    SHAKE,
} from "./constants";

/* ------------------------------------------------------------------ *
 * Laser
 *
 * update() owns geometry and the energy drain. Damage now happens in
 * Physics.resolveLaser(), which can consult the spatial grid instead of
 * walking every wave and boss on every sprite tick.
 * ------------------------------------------------------------------ */

export class LaserConfig {
    private game: Game;
    x = 0;
    y = 0;
    width: number;
    height: number;
    damage: number;
    colorInside: string;
    colorOutside: string;
    /** Set by update(); draw() and Physics only read it. */
    active = false;

    constructor(
        game: Game,
        width: number,
        damage: number,
        colorInside: string,
        colorOutside: string
    ) {
        this.game = game;
        this.height = game.height - 50;
        this.width = width;
        this.damage = damage;
        this.colorInside = colorInside;
        this.colorOutside = colorOutside;
    }

    update(): void {
        const player = this.game.player;
        const wasActive = this.active;
        this.active = player.energy > 1 && !player.cooldown && this.game.isFiringLaser();

        if (!this.active) return;

        this.x = player.x + player.width / 2 - this.width / 2;
        this.height = this.game.height - 50;
        player.energy -= this.damage;

        // Only on the rising edge, otherwise a held laser retriggers the voice
        // 60 times a second.
        if (!wasActive) this.game.audio.play("laser", 0.5);
    }

    draw(context: CanvasRenderingContext2D): void {
        if (!this.active) return;

        context.fillStyle = this.colorInside;
        context.fillRect(this.x, this.y, this.width, this.height);
        context.fillStyle = this.colorOutside;
        context.fillRect(this.x + this.width * 0.2, this.y, this.width * 0.6, this.height);
    }
}

/* ------------------------------------------------------------------ *
 * Player
 * ------------------------------------------------------------------ */

export class Player {
    private game: Game;
    width: number;
    height: number;
    x: number;
    y: number;
    energy: number;
    maxEnergy: number;
    lives: number;
    maxLives: number;
    laser: LaserConfig;
    cooldown = false;
    collectedItems: SalvageCrate[] = [];
    itemCounter = 1;
    widthPos = 256;
    heightPos = 256;
    frameX = 1;
    maxFrame: number;
    image: HTMLImageElement;

    activePowerUps: ActivePowerUp[] = [];

    /** Simulation ms until the next volley is allowed. */
    private fireCooldown = 0;
    /** Gates auto-repeat: without rapidFire a held key still fires only once. */
    private firedThisPress = false;

    constructor(game: Game, ship: MySpaceships) {
        this.game = game;
        this.width = ship.width;
        this.height = ship.height;
        this.x = game.width / 2 - this.width / 2;
        this.y = game.height - this.height;
        this.lives = ship.hp;
        this.maxLives = ship.hp;
        this.image = loadImage(ship.images as ImageSource);
        this.maxFrame = ship.maxFrame;
        this.energy = 25;
        this.maxEnergy = ship.maxEnergy;
        this.laser = new LaserConfig(
            game,
            ship.laserWidth,
            ship.laserDamage,
            ship.laserColor,
            "white"
        );
    }

    /** speedBoost is read here, so the buff has an actual effect. */
    get speed(): number {
        return this.hasPowerUp("speedBoost") ? BOOSTED_SPEED : BASE_SPEED;
    }

    update(step: number, ship: MySpaceships): void {
        if (this.game.spriteUpdate && this.lives >= 1) {
            this.frameX = 0;
        }

        this.updatePowerUps(step);

        if (this.energy < this.maxEnergy) {
            this.energy += ship.energyRegen * 0.1;
            if (this.energy > this.maxEnergy) this.energy = this.maxEnergy;
        }

        if (this.energy < 1) {
            this.cooldown = true;
        } else if (this.energy > this.maxEnergy * 0.2) {
            this.cooldown = false;
        }

        const keys = this.game.keys;
        const speed = this.speed;
        const touchTargetX = this.game.pointerTargetX;

        if (touchTargetX !== null) {
            // Steer toward the finger instead of snapping to it: snapping makes
            // the ship teleport across the screen on the first touch, and it
            // would also hand touch players a dodge the keyboard cannot match.
            // Capped at the same `speed`, so both inputs move at one rate.
            const centreOffset = touchTargetX - this.width / 2;
            this.x += clamp(centreOffset - this.x, -speed, speed);
        } else {
            if (keys.has("ArrowLeft")) this.x -= speed;
            if (keys.has("ArrowRight")) this.x += speed;
        }

        // Re-clamped every step so a window resize can't leave the ship outside.
        this.x = clamp(this.x, 0, this.game.width - this.width);
        this.y = this.game.height - this.height;

        this.updateFiring(step, ship);
        this.laser.update();
    }

    /**
     * Shooting is driven from the fixed-step simulation rather than the keydown
     * event, so the cadence cannot vary with frame rate and rapidFire can
     * auto-repeat while the key is held.
     */
    private updateFiring(step: number, ship: MySpaceships): void {
        if (this.fireCooldown > 0) {
            this.fireCooldown -= step;
            if (this.fireCooldown < 0) this.fireCooldown = 0;
        }

        if (!this.game.isFiringPrimary()) {
            this.firedThisPress = false;
            return;
        }

        const rapid = this.hasPowerUp("rapidFire");
        if (this.fireCooldown > 0) return;
        if (!rapid && this.firedThisPress) return;

        this.firedThisPress = true;
        this.fireCooldown = rapid ? RAPID_FIRE_INTERVAL : FIRE_INTERVAL;
        this.shoot(ship);
    }

    draw(context: CanvasRenderingContext2D): void {
        this.laser.draw(context);

        if (!isDrawable(this.image)) return;
        context.drawImage(
            this.image,
            this.frameX * this.widthPos, 0,
            this.widthPos, this.heightPos,
            this.x, this.y,
            this.width, this.height
        );
    }

    shoot(ship: MySpaceships): void {
        // Offsets per bullet count, as fractions of ship width.
        const base =
            ship.bullet === 2 ? [0.45, 0.65] :
            ship.bullet === 3 ? [0.30, 0.55, 0.80] :
            [0.55];

        // multiShot widens the volley with two outer lanes.
        const offsets = this.hasPowerUp("multiShot") ? [0.12, ...base, 0.94] : base;

        // All-or-nothing: a partial volley would waste pool slots.
        const claimed: Projectile[] = [];
        for (let i = 0; i < offsets.length; i++) {
            const projectile = this.game.getProjectile();
            if (!projectile) {
                for (let j = 0; j < claimed.length; j++) claimed[j].reset();
                return;
            }
            claimed.push(projectile);
        }

        for (let i = 0; i < claimed.length; i++) {
            claimed[i].start(this.x + this.width * offsets[i], this.y + 30);
        }

        this.game.audio.play("shoot", 0.35);
    }

    /**
     * Applies damage from a single source and reports whether the run ended.
     * An active shield absorbs the hit entirely — this is what gives the
     * shield buff its effect.
     */
    takeDamage(amount: number): boolean {
        if (this.hasPowerUp("shield")) {
            this.game.createParticles(this, POWER_UP_SPECS.shield.color, true);
            this.game.audio.play("shieldBlock", 0.5);
            this.game.triggerShake(SHAKE.shieldBlock.intensity, SHAKE.shieldBlock.duration);
            return false;
        }

        this.lives -= amount;
        this.frameX = 1;
        this.game.createParticles(this, "white", true);
        this.game.audio.play("playerHit", 0.7);
        this.game.triggerShake(SHAKE.playerHit.intensity, SHAKE.playerHit.duration);

        if (this.lives < 1) {
            this.game.endRun();
            return true;
        }
        return false;
    }

    /**
     * Pick up a sealed crate. Nothing about the item inside is known here — the
     * crate is just a token that one claim is owed, and the contents come from
     * the on-chain roll at claim time.
     */
    collectCrate(): void {
        const crate: SalvageCrate = { id: this.itemCounter++ };

        this.game.score += 50;
        this.game.hud.setScore(this.game.score);
        this.collectedItems.push(crate);
        this.game.invalidateHud();
        this.game.audio.play("itemPickup", 0.5);

        this.game.hud.setCollectedItems((prev: SalvageCrate[]) => [...prev, crate]);
    }

    /** Starts, or refreshes, a buff at its configured duration. */
    activatePowerUp(type: PowerUpType): void {
        const spec = POWER_UP_SPECS[type];

        const existing = this.activePowerUps.find((entry) => entry.type === type);
        if (existing) {
            existing.remaining = spec.duration;
            existing.duration = spec.duration;
        } else {
            this.activePowerUps.push({
                type,
                remaining: spec.duration,
                duration: spec.duration,
            });
        }

        this.game.audio.play("powerup", 0.7);
        this.game.invalidateHud();
    }

    /**
     * Counts down in simulation time rather than wall-clock. The first pass
     * used Date.now(), so pausing for ten seconds silently consumed a
     * ten-second buff.
     */
    updatePowerUps(step: number): void {
        const list = this.activePowerUps;
        let write = 0;
        for (let read = 0; read < list.length; read++) {
            const entry = list[read];
            entry.remaining -= step;
            if (entry.remaining > 0) {
                if (write !== read) list[write] = entry;
                write++;
            }
        }
        if (write !== list.length) {
            list.length = write;
            this.game.invalidateHud();
        }
    }

    hasPowerUp(type: PowerUpType): boolean {
        const list = this.activePowerUps;
        for (let i = 0; i < list.length; i++) {
            if (list[i].type === type) return true;
        }
        return false;
    }

    restart(ship: MySpaceships): void {
        this.x = this.game.width / 2 - this.width / 2;
        this.y = this.game.height - this.height;
        this.lives = ship.hp;
        this.energy = 25;
        this.cooldown = false;
        this.frameX = 1;
        this.itemCounter = 1;
        this.collectedItems.length = 0;
        this.laser.active = false;
        // Previously leaked across runs: a buff collected before dying stayed
        // active into the next run.
        this.activePowerUps.length = 0;
        this.fireCooldown = 0;
        this.firedThisPress = false;
        this.game.hud.setCollectedItems([]);
    }
}

/* ------------------------------------------------------------------ *
 * Particles (pooled)
 * ------------------------------------------------------------------ */

export class Particle {
    position: Position = { x: 0, y: 0 };
    velocity: Position = { x: 0, y: 0 };
    radius = 1;
    color = "red";
    fades = true;
    opacity = 1;
    /** Pool flag: false means the instance is parked on the free list. */
    active = false;

    init(x: number, y: number, vx: number, vy: number, radius: number, color: string, fades: boolean): void {
        this.position.x = x;
        this.position.y = y;
        this.velocity.x = vx;
        this.velocity.y = vy;
        this.radius = radius;
        this.color = color;
        this.fades = fades;
        this.opacity = 1;
        this.active = true;
    }

    update(): void {
        this.position.x += this.velocity.x;
        this.position.y += this.velocity.y;
        if (this.fades) this.opacity -= 0.01;
    }
}

/* ------------------------------------------------------------------ *
 * Projectiles
 * ------------------------------------------------------------------ */

export class Projectile implements Collidable {
    /** Center of the drawn circle. */
    cx = 0;
    cy = 0;
    speed = 10;
    free = true;
    radius = 4;

    // Collision box derived from the circle, so the hit test matches the
    // sprite. The old version used the circle centre as the box origin, which
    // put the hitbox down and to the right of the visible bullet.
    get x(): number { return this.cx - this.radius; }
    get y(): number { return this.cy - this.radius; }
    get width(): number { return this.radius * 2; }
    get height(): number { return this.radius * 2; }

    start(x: number, y: number): void {
        this.cx = x;
        this.cy = y;
        this.free = false;
    }

    reset(): void {
        this.free = true;
    }

    update(): void {
        if (this.free) return;
        this.cy -= this.speed;
        if (this.cy < -this.radius) this.reset();
    }
}

export class EnemyProjectile implements Collidable {
    position: Position;
    velocity: Position;
    width = 3;
    height = 10;
    /** Marked rather than spliced, so a collision pass can't shift the array
     *  it is iterating. */
    markedForDeletion = false;

    constructor({ position, velocity }: { position: Position; velocity: Position }) {
        this.position = position;
        this.velocity = velocity;
    }

    update(): void {
        this.position.x += this.velocity.x;
        this.position.y += this.velocity.y;
    }

    // Adapters so a projectile can go straight into an AABB test.
    get x(): number { return this.position.x; }
    get y(): number { return this.position.y; }
}

export class BossProjectile extends EnemyProjectile {
    constructor(args: { position: Position; velocity: Position }) {
        super(args);
        this.width = 8;
        this.height = 10;
    }
}

/* ------------------------------------------------------------------ *
 * Enemies
 *
 * Collision against player bullets and against the player body used to live
 * in update(). Physics owns both now.
 * ------------------------------------------------------------------ */

export class Enemy implements Collidable {
    private game: Game;
    width = ENEMY_SIZE;
    height = ENEMY_SIZE;
    x = 0;
    y = 0;
    positionX: number;
    positionY: number;
    frameX = 1;
    widthPos = 256;
    heightPos = 256;
    markedForDeletion = false;
    lives: number;
    maxLives: number;
    image: HTMLImageElement;
    color: string;
    maxFrame: number;
    /**
     * Per-step fire chance, fixed at spawn from the alien's tier. Keyed off
     * maxLives rather than lives so a wounded elite stays as aggressive as a
     * fresh one — chipping it down must not also defang it.
     */
    readonly shootChance: number;

    constructor(game: Game, positionX: number, positionY: number, config?: AlienData) {
        this.game = game;
        this.positionX = positionX;
        this.positionY = positionY;

        this.lives = config?.hp ?? 1;
        this.maxLives = this.lives;
        this.shootChance =
            this.maxLives > ELITE_ENEMY_HP_THRESHOLD
                ? ELITE_ENEMY_SHOOT_CHANCE
                : ENEMY_SHOOT_CHANCE;
        this.color = config?.color ?? "white";
        this.maxFrame = config?.maxFrame ?? 5;
        this.image = config ? loadImage(config.image as ImageSource) : new Image();
    }

    update(waveX: number, waveY: number): void {
        if (this.game.spriteUpdate && this.lives >= 1) {
            this.frameX = 0;
        }

        this.x = waveX + this.positionX;
        this.y = waveY + this.positionY;

        // Death animation, then award score exactly once.
        if (this.lives < 1 && this.game.spriteUpdate) {
            this.frameX++;
            if (this.frameX > this.maxFrame) {
                this.markedForDeletion = true;
                this.game.score += this.maxLives * 10;
                this.game.hud.setScore(this.game.score);
                this.game.audio.play("enemyDeath", 0.45);
                this.game.triggerShake(SHAKE.enemyDeath.intensity, SHAKE.enemyDeath.duration);
                this.game.maybeSpawnPowerUp(
                    this.x + this.width / 2,
                    this.y + this.height / 2
                );
            }
        }
    }

    shoot(enemyProjectiles: EnemyProjectile[]): void {
        enemyProjectiles.push(new EnemyProjectile({
            position: { x: this.x + this.width / 2, y: this.y + this.height },
            velocity: { x: 0, y: 5 },
        }));
    }

    hit(damage: number): void {
        this.lives -= damage;
        if (this.lives >= 1) this.frameX = 1;
    }

    draw(context: CanvasRenderingContext2D): void {
        if (!isDrawable(this.image)) return;
        context.drawImage(
            this.image,
            this.frameX * this.widthPos, 0,
            this.widthPos, this.heightPos,
            this.x, this.y,
            this.width, this.height
        );
    }
}

/* ------------------------------------------------------------------ *
 * Boss
 * ------------------------------------------------------------------ */

/** 30-degree spread, precomputed rather than recalculated per projectile. */
const SPREAD_SIN = Math.sin(30 * (Math.PI / 180));
const SPREAD_COS = Math.cos(30 * (Math.PI / 180));

export class Boss implements Collidable {
    private game: Game;
    width = 140;
    height = 140;
    x: number;
    y: number;
    speedX: number;
    speedY = 0;
    markedForDeletion = false;
    frameX = 1;
    lives: number;
    maxLives: number;
    maxFrame = 13;
    color = "#000";
    image: HTMLImageElement;
    widthPos = 140;
    heightPos = 140;
    name = "";
    /** Remaining lockout in simulation ms; see BOSS_SHOOT_MIN_INTERVAL. */
    private shootCooldown = 0;

    constructor(game: Game, bossLives: number, config?: BossData) {
        this.game = game;
        this.lives = bossLives;
        this.maxLives = bossLives;
        this.speedX = Math.random() < 0.5 ? -1 : 1;

        if (config) {
            this.name = config.name;
            this.width = config.width;
            this.height = config.height;
            this.widthPos = config.widthPos;
            this.heightPos = config.heightPos;
            this.color = config.color;
            this.maxFrame = config.maxFrame;
            this.image = loadImage(config.image as ImageSource);
        } else {
            this.image = new Image();
        }

        this.x = game.width / 2 - this.width / 2;
        this.y = -this.height;
    }

    update(): void {
        this.speedY = 0;

        if (this.game.spriteUpdate && this.lives >= 1) {
            this.frameX = 0;
        }

        if (this.y < 0) this.y += 4;

        if ((this.x < 0 || this.x > this.game.width - this.width) && this.lives >= 1) {
            this.speedX *= -1;
            this.speedY = this.height / 4;
        }

        this.x += this.speedX;
        this.y += this.speedY;

        // Death: score, heal, drops, next wave.
        if (this.lives < 1 && this.game.spriteUpdate) {
            this.frameX++;
            if (this.frameX > this.maxFrame) {
                this.markedForDeletion = true;
                this.game.score += this.maxLives * 10;
                this.game.bossLives += BOSS_HP_GROWTH;
                this.game.hud.setScore(this.game.score);

                if (this.game.player.lives < this.game.player.maxLives) {
                    this.game.player.lives++;
                }

                this.game.audio.play("bossDeath", 0.9);
                this.game.triggerShake(SHAKE.bossDeath.intensity, SHAKE.bossDeath.duration);

                const cx = this.x + this.width / 2;
                const cy = this.y + this.height / 2;
                this.game.spawnDrop(cx, cy);
                // A boss always yields a buff, unlike a regular enemy.
                this.game.spawnPowerUp(cx, cy);

                if (!this.game.gameOver) this.game.newWave();
            }
        }
    }

    /**
     * Ticks the volley lockout and reports whether a shot is allowed. Called
     * every step regardless of the other fire conditions, so the cooldown keeps
     * draining while the boss is still descending or playing its death frames.
     */
    tickShootCooldown(step: number): boolean {
        if (this.shootCooldown > 0) {
            this.shootCooldown -= step;
            if (this.shootCooldown < 0) this.shootCooldown = 0;
            return false;
        }
        return true;
    }

    shoot(bossProjectiles: BossProjectile[]): void {
        this.shootCooldown = BOSS_SHOOT_MIN_INTERVAL;
        const roll = Math.random();

        if (this.name === "Boss3") {
            if (roll < 0.7) this.createProjectiles(bossProjectiles, this.width / 4, 45, 4);
            else this.createProjectiles(bossProjectiles, this.width / 6, 35, 6);
        } else if (this.name === "Boss2") {
            if (roll < 0.7) this.createProjectiles(bossProjectiles, this.width / 3, 50, 3);
            else this.createProjectiles(bossProjectiles, this.width / 5, 40, 5);
        } else {
            if (roll < 0.7) this.createProjectiles(bossProjectiles, this.width / 2, 55, 2);
            else this.createProjectiles(bossProjectiles, this.width / 4, 45, 4);
        }
    }

    createProjectiles(
        bossProjectiles: BossProjectile[],
        positionFactor: number,
        offset: number,
        count: number
    ): void {
        for (let i = 0; i < count; i++) {
            let vx = 0;
            let vy = 5;

            if (count >= 3) {
                const isLeftEdge = i === 0 || (count === 5 && i === 1) || (count === 6 && i <= 1);
                const isRightEdge =
                    i === count - 1 ||
                    (count === 5 && i === count - 2) ||
                    (count === 6 && i >= count - 2);

                if (isLeftEdge) {
                    vx = -5 * SPREAD_SIN;
                    vy = 5 * SPREAD_COS;
                } else if (isRightEdge) {
                    vx = 5 * SPREAD_SIN;
                    vy = 5 * SPREAD_COS;
                }
            }

            bossProjectiles.push(new BossProjectile({
                position: {
                    x: this.x + positionFactor - offset + i * offset,
                    y: this.y + this.height,
                },
                velocity: { x: vx, y: vy },
            }));
        }
    }

    hit(damage: number): void {
        this.lives -= damage;
        if (this.lives >= 1) this.frameX = 1;
    }

    draw(context: CanvasRenderingContext2D): void {
        if (isDrawable(this.image)) {
            context.drawImage(
                this.image,
                this.frameX * this.widthPos, 0,
                this.widthPos, this.heightPos,
                this.x, this.y,
                this.width, this.height
            );
        }

        if (this.lives >= 1) {
            context.save();
            context.textAlign = "center";
            context.font = "20px Arial";
            context.shadowOffsetX = 3;
            context.shadowOffsetY = 3;
            context.shadowColor = "black";
            context.fillStyle = "white";
            context.fillText(
                Math.floor(this.lives).toString(),
                this.x + this.width / 2,
                this.y + 40
            );
            context.restore();
        }
    }
}

/* ------------------------------------------------------------------ *
 * Salvage crate (sealed NFT loot)
 *
 * Was `Item`, which carried the name, rarity and sprite of a specific item —
 * meaning the client decided what a drop was and the chain only recorded it.
    * The crate is deliberately anonymous: it says a claim is owed, and a
    * prevrandao-mixed seed decides the contents when the player claims it.
 *
 * Drawn procedurally, like PowerUpDrop — no sprite asset, and nothing to
 * accidentally leak the outcome.
 * ------------------------------------------------------------------ */

export class SalvageCrateDrop implements Collidable {
    private game: Game;
    width = 30;
    height = 30;
    x: number;
    y: number;
    speed = 2;
    markedForDeletion = false;

    /** Drives the seam shimmer; advanced in simulation ms. */
    private age = 0;

    constructor(game: Game, x: number, y: number) {
        this.game = game;
        this.x = x;
        this.y = y;
    }

    update(step: number): void {
        this.age += step;
        this.y += this.speed;

        if (this.y > this.game.height) {
            this.markedForDeletion = true;
            return;
        }

        if (intersects(this, this.game.player)) {
            this.markedForDeletion = true;
            this.game.player.collectCrate();
            this.game.createParticles(this, "#22d3ee", true);
        }
    }

    draw(context: CanvasRenderingContext2D): void {
        const pulse = 0.6 + 0.4 * Math.sin(this.age / 150);

        context.save();

        context.shadowColor = "#22d3ee";
        context.shadowBlur = 8 + 6 * pulse;

        context.beginPath();
        context.roundRect(this.x, this.y, this.width, this.height, 5);
        context.fillStyle = "rgba(8, 20, 24, 0.85)";
        context.fill();
        context.strokeStyle = "#22d3ee";
        context.lineWidth = 2;
        context.stroke();

        // Lid seam plus corner rivets: reads as sealed, so the player expects to
        // open it later rather than to already own what is inside.
        context.shadowBlur = 0;
        context.strokeStyle = `rgba(34, 211, 238, ${0.35 + 0.4 * pulse})`;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(this.x + 3, this.y + this.height / 2);
        context.lineTo(this.x + this.width - 3, this.y + this.height / 2);
        context.stroke();

        context.fillStyle = "#22d3ee";
        for (const [ox, oy] of [[6, 6], [this.width - 6, 6], [6, this.height - 6], [this.width - 6, this.height - 6]]) {
            context.beginPath();
            context.arc(this.x + ox, this.y + oy, 1.4, 0, Math.PI * 2);
            context.fill();
        }

        context.restore();
    }
}


/* ------------------------------------------------------------------ *
 * Power-up drop
 *
 * Deliberately separate from Item. The first pass tried to detect buffs with
 * `item.metadata.startsWith("powerup:")`, but every configured item's metadata
 * is an IPFS URL, so that branch could never run. Keeping buffs out of the NFT
 * loot table also stops them diluting the rarity weighting.
 *
 * Drawn procedurally — no sprite asset required.
 * ------------------------------------------------------------------ */

export class PowerUpDrop implements Collidable {
    private game: Game;
    type: PowerUpType;
    width = POWER_UP_SIZE;
    height = POWER_UP_SIZE;
    x: number;
    y: number;
    speed = POWER_UP_FALL_SPEED;
    markedForDeletion = false;

    /** Drives the sway and the glow pulse; advanced in simulation ms. */
    private age = 0;
    private spawnX: number;

    constructor(game: Game, x: number, y: number, type: PowerUpType) {
        this.game = game;
        this.type = type;
        this.spawnX = x - this.width / 2;
        this.x = this.spawnX;
        this.y = y - this.height / 2;
    }

    update(step: number): void {
        this.age += step;
        this.y += this.speed;
        // Sway so buffs read differently from straight-falling loot.
        this.x = this.spawnX + Math.sin(this.age / 260) * 12;

        if (this.y > this.game.height) {
            this.markedForDeletion = true;
            return;
        }

        if (intersects(this, this.game.player)) {
            this.markedForDeletion = true;
            this.game.player.activatePowerUp(this.type);
            this.game.createParticles(this, POWER_UP_SPECS[this.type].color, true);
        }
    }

    draw(context: CanvasRenderingContext2D): void {
        const spec = POWER_UP_SPECS[this.type];
        const pulse = 0.65 + 0.35 * Math.sin(this.age / 130);

        context.save();

        context.shadowColor = spec.color;
        context.shadowBlur = 10 + 8 * pulse;

        context.beginPath();
        context.roundRect(this.x, this.y, this.width, this.height, 7);
        context.fillStyle = "rgba(0, 0, 0, 0.65)";
        context.fill();
        context.strokeStyle = spec.color;
        context.lineWidth = 2;
        context.stroke();

        context.shadowBlur = 0;
        context.fillStyle = spec.color;
        context.font = "bold 16px 'Courier New', monospace";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(spec.glyph, this.x + this.width / 2, this.y + this.height / 2 + 1);

        context.restore();
    }
}

/* ------------------------------------------------------------------ *
 * Wave
 * ------------------------------------------------------------------ */

export class Wave {
    private game: Game;
    width: number;
    height: number;
    x: number;
    y: number;
    speedX: number;
    speedY = 0;
    enemies: Enemy[] = [];
    nextWaveTrigger = false;
    markedForDeletion = false;

    constructor(game: Game) {
        this.game = game;
        this.width = game.columns * ENEMY_SIZE;
        this.height = game.rows * ENEMY_SIZE;
        this.x = game.width / 2 - this.width / 2;
        this.y = -this.height;
        // Single increment per step. The original added speedX twice per
        // update, so this uses the full 1px to keep the old drift speed.
        this.speedX = Math.random() < 0.5 ? -1 : 1;
        this.create();
    }

    update(): void {
        if (this.y < 0) this.y += 5;

        this.speedY = 0;

        if (this.x < 0 || this.x > this.game.width - this.width) {
            this.speedX *= -1;
            this.speedY = ENEMY_SIZE / 4;
        }

        this.x += this.speedX;
        this.y += this.speedY;

        const enemies = this.enemies;
        for (let i = 0; i < enemies.length; i++) {
            const enemy = enemies[i];
            enemy.update(this.x, this.y);

            if (enemy.lives >= 1 && enemy.y > 0 && Math.random() < enemy.shootChance) {
                enemy.shoot(this.game.enemyProjectiles);
            }
        }

        // Retires enemies that finished their death animation. Without this the
        // list never empties, so markedForDeletion below could never fire and a
        // cleared wave stayed alive forever.
        compact(enemies, (enemy) => enemy.markedForDeletion);

        if (enemies.length === 0) this.markedForDeletion = true;
    }

    draw(context: CanvasRenderingContext2D): void {
        const enemies = this.enemies;
        for (let i = 0; i < enemies.length; i++) enemies[i].draw(context);
    }

    private create(): void {
        const aliens = this.game.alienConfig;
        // Rarest first; the first threshold above the roll wins.
        const thresholds = [0.1, 0.2, 0.3, 0.4, 0.6, 1.0];
        const indices = [5, 4, 3, 2, 1, 0];

        for (let y = 0; y < this.game.rows; y++) {
            for (let x = 0; x < this.game.columns; x++) {
                const roll = Math.random();
                for (let t = 0; t < thresholds.length; t++) {
                    if (roll < thresholds[t]) {
                        this.enemies.push(
                            new Enemy(this.game, x * ENEMY_SIZE, y * ENEMY_SIZE, aliens[indices[t]])
                        );
                        break;
                    }
                }
            }
        }
    }
}
