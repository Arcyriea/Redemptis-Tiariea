import type { Game } from '../core/Game';
import { Ship } from '../entities/Ship';
import type { FactionId } from './FactionManager';
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
 *  - Collision and damage against eligible logical ships
 *  - Cleanup: returns removeIt-marked projectiles to pool
 *  - Scene binding: creates the physics group when the scene is ready
 *
 * Does NOT:
 *  - Register projectiles in EntityManager (no stable IDs needed)
 *  - Manage weapon cooldown/energy (stays in Component/Weapon)
 *  - Create a central registry for all transient types
 */
export class ProjectileManager {
    private readonly game: Game;
    private scene: Phaser.Scene | null = null;
    private physicsGroup: any = null;
    private ownsPhysicsGroup = false;

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
        if (this.scene === scene && (!existingGroup || existingGroup === this.physicsGroup)) return;
        if (this.scene) this.unbindScene(this.scene);

        this.scene = scene;
        this.ownsPhysicsGroup = !existingGroup;
        this.physicsGroup = existingGroup ?? scene.physics.add.group();
        scene.events.once('shutdown', () => this.unbindScene(scene));
    }

    /**
     * Drop all projectiles tied to a scene before its physics world is discarded.
     * The manager remains attached to its Game and can bind to a restarted scene.
     */
    unbindScene(scene: Phaser.Scene): void {
        if (this.scene !== scene) return;

        const physicsGroup = this.physicsGroup;
        const ownsPhysicsGroup = this.ownsPhysicsGroup;
        const projectiles = new Set([...this.active, ...this.pool]);
        this.active.length = 0;
        this.pool.length = 0;
        this.scene = null;
        this.physicsGroup = null;
        this.ownsPhysicsGroup = false;

        for (const proj of projectiles) {
            if (!proj.isDestroyed && typeof proj.destroy === 'function') {
                proj.destroy();
            }
        }

        if (ownsPhysicsGroup && physicsGroup?.scene && typeof physicsGroup.destroy === 'function') {
            physicsGroup.destroy(true);
        }
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

            const center = this.getProjectileCenter(proj);
            if (!center) continue;

            if (!proj.removeIt) {
                this.handleCollisions(proj, center.x, center.y);
            }
            proj.previousX = center.x;
            proj.previousY = center.y;
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
            if (proj.isDestroyed || proj.removeIt) {
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
     * Destroy scene-bound projectiles and release manager-owned scene resources.
     * The manager remains attached to its Game and may be rebound to another scene.
     */
    destroy(): void {
        if (this.scene) {
            this.unbindScene(this.scene);
        } else {
            const projectiles = new Set([...this.active, ...this.pool]);
            this.active.length = 0;
            this.pool.length = 0;
            for (const proj of projectiles) {
                if (!proj.isDestroyed && typeof proj.destroy === 'function') {
                    proj.destroy();
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    private async acquireAsync(config: ProjectileSpawnConfig): Promise<any> {
        const scene = this.scene;
        const physicsGroup = this.physicsGroup;
        if (!scene || !physicsGroup) {
            throw new Error('ProjectileManager must be bound to a scene before spawning projectiles.');
        }

        let proj: any;
        let reused = false;

        while (this.pool.length > 0 && !proj) {
            const candidate = this.pool.pop();
            if (!candidate.isDestroyed && (!candidate.scene || candidate.scene === scene)) {
                proj = candidate;
                reused = true;
            } else if (!candidate.isDestroyed && typeof candidate.destroy === 'function') {
                candidate.destroy();
            }
        }

        if (!proj) {
            // Dynamic import — works in browser (async) and Node test environment.
            // Falls back to a minimal proxy only if the module truly cannot load.
            try {
                const { PhysicsProjectile } = await import('../physics/PhysicsProjectile');
                proj = PhysicsProjectile.createPooled(scene);
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
                    previousX: 0,
                    previousY: 0,
                    wasPooled: false,
                    damage: config.damage,
                    removeIt: false,
                    reset() {
                        this.previousX = 0;
                        this.previousY = 0;
                    }
                };
            }

            if (this.scene !== scene || this.physicsGroup !== physicsGroup) {
                if (!proj.isDestroyed && typeof proj.destroy === 'function') {
                    proj.destroy();
                }
                throw new Error('Projectile scene was shut down before the projectile could be created.');
            }
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

        // A pooled dynamic body is removed from the Arcade world when its group
        // member is removed. Re-add the existing body; World.add uses a Set.
        if (proj.body) {
            scene.physics.world.enableBody(proj);
        }

        if (proj.body && !physicsGroup.contains(proj)) {
            physicsGroup.add(proj);
        }
        proj.body?.reset(config.x, config.y);
        const center = this.getProjectileCenter(proj);
        proj.previousX = center?.x ?? config.x;
        proj.previousY = center?.y ?? config.y;

        // Reset and group defaults both clear velocity; restore it only afterward.
        const muzzleX = Math.cos(config.angle) * config.muzzleVelocity;
        const muzzleY = Math.sin(config.angle) * config.muzzleVelocity;
        proj.setVelocity(
            muzzleX + config.shooterVelocityX,
            muzzleY + config.shooterVelocityY
        );
        proj.setDrag(config.drag ?? 10);

        if (!this.active.includes(proj)) this.active.push(proj);
        return proj;
    }

    private returnToPool(proj: any): void {
        if (!proj || this.pool.includes(proj)) return;
        if (proj.isDestroyed || (proj.scene && this.scene && proj.scene !== this.scene)) return;
        if (!this.scene || !this.physicsGroup) {
            if (typeof proj.destroy === 'function') proj.destroy();
            return;
        }

        if (this.physicsGroup.scene && this.physicsGroup.contains(proj)) {
            this.physicsGroup.remove(proj, false);
        }

        if (proj.isDestroyed) return;
        if (proj.body) {
            this.scene.physics.world.disableBody(proj.body);
        }
        proj.reset();
        this.pool.push(proj);
    }

    private handleCollisions(proj: any, currentX: number, currentY: number): void {
        const entityManager = this.game.entityManager;
        const factionManager = this.game.factionManager;
        const sourceEntityId = proj.attribution?.sourceEntityId;
        const sourceFactionId = proj.attribution?.sourceFactionId as FactionId | null;
        if (!entityManager || !factionManager || !sourceEntityId || !sourceFactionId) return;
        if (!factionManager.isFactionRegistered(sourceFactionId)) return;

        const previousX = Number.isFinite(proj.previousX) ? proj.previousX : currentX;
        const previousY = Number.isFinite(proj.previousY) ? proj.previousY : currentY;
        const body = proj.body;
        const projectileRadius = Math.hypot(
            body.halfWidth ?? body.width / 2,
            body.halfHeight ?? body.height / 2
        );
        if (!Number.isFinite(projectileRadius)) return;

        let earliestTarget: Ship | null = null;
        let earliestContact = Number.POSITIVE_INFINITY;

        for (const entity of entityManager.getAll()) {
            if (!(entity instanceof Ship) || entity.id === sourceEntityId) continue;
            if (!entity.active || entity.removeIt || entity.exploding || entity.isDestroyed) continue;
            if (!Number.isFinite(entity.x) || !Number.isFinite(entity.y)) continue;
            if (!Number.isFinite(entity.radius) || entity.radius < 0) continue;

            const targetFactionId = factionManager.getFaction(entity);
            if (!targetFactionId || !factionManager.isFactionRegistered(targetFactionId)) continue;
            if (factionManager.getFactionRelationship(sourceFactionId, targetFactionId) !== 'Enemy') continue;

            const contact = this.segmentCircleContact(
                previousX,
                previousY,
                currentX,
                currentY,
                entity.x,
                entity.y,
                projectileRadius + entity.radius
            );
            if (contact !== null && contact < earliestContact) {
                earliestContact = contact;
                earliestTarget = entity;
            }
        }

        if (!earliestTarget) return;

        proj.removeIt = true;
        earliestTarget.takeDamage(proj.damage);
    }

    private getProjectileCenter(proj: any): { x: number; y: number } | null {
        const center = proj.body?.center;
        if (center && Number.isFinite(center.x) && Number.isFinite(center.y)) {
            return { x: center.x, y: center.y };
        }
        return null;
    }

    private segmentCircleContact(
        startX: number,
        startY: number,
        endX: number,
        endY: number,
        centerX: number,
        centerY: number,
        radius: number
    ): number | null {
        const offsetX = startX - centerX;
        const offsetY = startY - centerY;
        const radiusSquared = radius * radius;
        const startDistanceSquared = offsetX * offsetX + offsetY * offsetY;
        if (startDistanceSquared <= radiusSquared) return 0;

        const deltaX = endX - startX;
        const deltaY = endY - startY;
        const segmentLengthSquared = deltaX * deltaX + deltaY * deltaY;
        if (segmentLengthSquared === 0) return null;

        const projection = offsetX * deltaX + offsetY * deltaY;
        const discriminant = projection * projection -
            segmentLengthSquared * (startDistanceSquared - radiusSquared);
        if (discriminant < 0) return null;

        const contact = (-projection - Math.sqrt(discriminant)) / segmentLengthSquared;
        return contact >= 0 && contact <= 1 ? contact : null;
    }
}