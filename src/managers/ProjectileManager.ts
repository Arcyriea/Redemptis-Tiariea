import { Game } from '../core/Game';
// ProjectileAttribution type is defined directly in ProjectileManager to avoid top-level import

/**
 * Configuration for spawning a projectile through the manager.
 */
export interface ProjectileSpawnConfig {
    x: number;
    y: number;
    angle: number;
    muzzleVelocity: number;
    shooterVelocityX: number;
    shooterVelocityY: number;
    damage: number;
    drag?: number;
    lifespanMs?: number;
    texture: string;
    attribution: ProjectileAttribution;
}

export interface ProjectileAttribution {
    sourceEntityId: string | null;
    sourceFactionId: string | null;
}

/**
 * ProjectileManager — owns the lifecycle of pooled projectiles.
 *
 * Scope (deliberately narrow):
 *  - Pool management: acquire, release, reset
 *  - Spawn entry point: captures attribution at fire time
 *  - Per-frame update: ages projectiles, marks expired
 *  - Cleanup: returns removeIt-marked projectiles to pool
 *  - Scene binding: creates the physics group when the scene is ready
 *
 * Does NOT:
 *  - Register projectiles in EntityManager (no stable IDs needed)
 *  - Apply damage (collision callback does that)
 *  - Manage weapon cooldown/energy (stays in Component/Weapon)
 *  - Create a central registry for all transient types
 */
export class ProjectileManager {
    private readonly game: Game;
    private scene: Phaser.Scene | null = null;
    private physicsGroup: any = null;

    private pool: any[] = [];  // type erased to avoid top-level PhysicsProjectile import
    private active: any[] = [];

    constructor(game: Game) {
        this.game = game;
    }

    /** Current number of active projectiles. */
    get activeCount(): number {
        return this.active.length;
    }

    /** Current pool size (inactive, ready for reuse). */
    get poolSize(): number {
        return this.pool.length;
    }

    /**
     * Bind to a Phaser scene once the physics world exists.
     * Called from GameScene.create() after physics setup.
     * Idempotent: safe to call multiple times (no-op if already bound).
     *
     * If the scene already owns a projectiles group (e.g. GameScene.projectiles),
     * reuse it so existing camera/collision code keeps working. Otherwise the
     * manager creates its own group.
     */
    bindScene(scene: Phaser.Scene, existingGroup?: any): void {
        if (this.scene === scene) return;
        if (this.scene && this.scene !== scene) {
            throw new Error('ProjectileManager already bound to a different scene.');
        }
        this.scene = scene;
        this.physicsGroup = existingGroup ?? scene.physics.add.group();
    }

    /**
     * Spawn or reuse a projectile.
     * Attribution is captured at spawn time and survives source destruction.
     */
    async spawn(config: ProjectileSpawnConfig): Promise<any> {
        return this.acquireAsync(config);
    }

    /**
     * Update all active projectiles.
     * Called once per frame from Game.update().
     */
    update(delta: number): void {
        for (let i = this.active.length - 1; i >= 0; i--) {
            const proj = this.active[i];
            proj.ageMs += delta;
            if (proj.ageMs >= proj.lifespanMs && proj.lifespanMs > 0) {
                proj.removeIt = true;
            }
        }
    }

    /**
     * Remove and pool all projectiles marked removeIt.
     * Idempotent: safe to call repeatedly.
     * Returns number cleaned up.
     */
    cleanup(): number {
        let cleaned = 0;
        for (let i = this.active.length - 1; i >= 0; i--) {
            const proj = this.active[i];
            if (proj.removeIt) {
                this.active.splice(i, 1);
                this.returnToPool(proj);
                cleaned++;
            }
        }
        return cleaned;
    }

    /**
     * Return all active projectiles to the pool.
     * Called on sector transition. Pool array is preserved.
     */
    clear(): void {
        for (const proj of this.active) {
            this.returnToPool(proj);
        }
        this.active.length = 0;
    }

    /**
     * Final shutdown: return all to pool, destroy group, clear pool.
     * Called when the Game/scene is permanently destroyed.
     */
    destroy(): void {
        this.clear();

        if (this.physicsGroup) {
            this.physicsGroup.destroy(true);
            this.physicsGroup = null;
        }

        for (const proj of this.pool) {
            if (typeof proj.destroy === 'function') {
                proj.destroy();
            }
        }
        this.pool.length = 0;

        this.scene = null;
        this.game.projectileManager = null;
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    private async acquireAsync(config: ProjectileSpawnConfig): Promise<any> {
        let proj: any;
        let reused: boolean;

        if (this.pool.length > 0) {
            proj = this.pool.pop()!;
            reused = true;
        } else {
            // Dynamic import — works in browser (async) and Node test environment.
            // Falls back to a minimal proxy only if the module truly cannot load.
            try {
                const { PhysicsProjectile } = await import('../physics/PhysicsProjectile');
                proj = PhysicsProjectile.createPooled(this.scene!);
            } catch (e) {
                // Safe fallback for environments without a real scene: a minimal proxy
                // that satisfies the contract. It has no body, so it is never added to
                // a physics group (which would crash on setCollideWorldBounds).
                proj = {
                    setActive: () => {},
                    setVisible: () => {},
                    setPosition: () => {},
                    setRotation: () => {},
                    setVelocity: () => {},
                    setDrag: () => {},
                    body: null,
                    lifespanTimer: null,
                    attribution: { sourceEntityId: null, sourceFactionId: null },
                    ageMs: 0,
                    lifespanMs: 0,
                    wasPooled: false,
                    damage: config.damage,
                    removeIt: false,
                    reset: () => {}
                };
            }
            reused = false;
        }

        // REACTIVATE PHASER BODY
        if (proj.body) {
            proj.body.enable = true;
        }

        proj.setActive(true);
        proj.setVisible(true);
        proj.removeIt = false;
        proj.ageMs = 0;
        proj.lifespanMs = config.lifespanMs ?? 2000;
        proj.wasPooled = reused;

        // Attribution snapshot — captured at fire time, survives source destruction
        proj.attribution = {
            sourceEntityId: config.attribution.sourceEntityId,
            sourceFactionId: config.attribution.sourceFactionId
        };

        // Position (but NOT velocity yet — group add will reset it via defaults)
        proj.setPosition(config.x, config.y);
        proj.setRotation(config.angle);
        proj.damage = config.damage;

        // Add to physics group for collision broadphase FIRST.
        // The group's createCallbackHandler applies defaults (including velocityX=0, velocityY=0),
        // so we must set velocity AFTER adding, just like Weapon.fireArcadeProjectile does.
        if (proj.body && this.physicsGroup && !this.physicsGroup.contains(proj)) {
            this.physicsGroup.add(proj);
        }

        // NOW set velocity and drag — after group add so defaults don't overwrite them
        const muzzleX = Math.cos(config.angle) * config.muzzleVelocity;
        const muzzleY = Math.sin(config.angle) * config.muzzleVelocity;
        proj.setVelocity(
            muzzleX + config.shooterVelocityX,
            muzzleY + config.shooterVelocityY
        );
        proj.setDrag(config.drag ?? 10);

        this.active.push(proj);
        return proj;
    }

    private returnToPool(proj: any): void {
        if (!proj) return;

        if (this.physicsGroup && this.physicsGroup.contains(proj)) {
            this.physicsGroup.remove(proj, false);
        }

        proj.reset();
        this.pool.push(proj);
    }
}