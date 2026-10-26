import Phaser from 'phaser';

export interface ProjectileConfig {
    scene: Phaser.Scene;
    x: number;
    y: number;
    texture: string;
    shooterVelocityX: number;
    shooterVelocityY: number;
    angle: number; // in radians
    muzzleVelocity: number;
    damage: number;
    drag?: number;
    lifespanMs?: number;
}

/**
 * PhysicsProjectile — pooled Arcade physics sprite.
 *
 * Pooling contract:
 *  - Constructor creates the sprite + body and the lifespan timer.
 *  - reset() clears attribution, timer, velocity, and marks inactive — safe to call
 *    before returning to the pool. Does NOT destroy the sprite.
 *  - createPooled() returns a sprite with body but NO timer, so a reused projectile
 *    is not double-counted by the scene's timer queue.
 *  - onHitTarget() cancels the timer and destroys the sprite (used by collision callbacks).
 */
export class PhysicsProjectile extends Phaser.Physics.Arcade.Sprite {
    public damage: number = 0;
    public lifespanTimer: Phaser.Time.TimerEvent | null = null;

    // Attribution snapshot — captured at fire time, survives source destruction
    public attribution: { sourceEntityId: string | null; sourceFactionId: string | null } = {
        sourceEntityId: null,
        sourceFactionId: null
    };

    // Manager-side aging (independent of the constructor timer for backward compat)
    public ageMs: number = 0;
    public lifespanMs: number = 0;
    public wasPooled: boolean = false;
    public removeIt: boolean = false;

    constructor(config: ProjectileConfig) {
        super(config.scene, config.x, config.y, config.texture);

        config.scene.add.existing(this);
        config.scene.physics.add.existing(this);

        this.damage = config.damage;
        this.setRotation(config.angle);

        // Real-World Relative Physics Velocity:
        // Projectile Vector = Muzzle Direction * Muzzle Speed + Shooter Initial Velocity
        const muzzleX = Math.cos(config.angle) * config.muzzleVelocity;
        const muzzleY = Math.sin(config.angle) * config.muzzleVelocity;

        const totalVx = muzzleX + config.shooterVelocityX;
        const totalVy = muzzleY + config.shooterVelocityY;

        this.setVelocity(totalVx, totalVy);

        if (config.drag) {
            this.setDrag(config.drag);
        }

        const lifespan = config.lifespanMs || 2500;
        this.lifespanMs = lifespan;
        this.lifespanTimer = config.scene.time.delayedCall(lifespan, () => {
            if (this.active) {
                this.destroy();
            }
        });
    }

    /**
     * Create a pooled projectile WITHOUT a lifespan timer.
     * The sprite + body are created so they can be re-enabled on acquire().
     * The constructor registers a timer; we immediately cancel it so a pooled
     * projectile is not double-counted by the scene's timer queue.
     */
    static createPooled(scene: Phaser.Scene): PhysicsProjectile {
        const proj = new PhysicsProjectile({
            scene,
            x: 0,
            y: 0,
            texture: 'bullet',
            shooterVelocityX: 0,
            shooterVelocityY: 0,
            angle: 0,
            muzzleVelocity: 0,
            damage: 0,
            lifespanMs: 2500
        });
        // Cancel the constructor timer — the manager owns lifespan now.
        if (proj.lifespanTimer) {
            proj.lifespanTimer.remove();
            proj.lifespanTimer = null;
        }
        proj.setActive(false);
        proj.setVisible(false);
        proj.setVelocity(0, 0);
        return proj;
    }

    /**
     * Reset for pool reuse. Clears attribution, timer, velocity, and marks inactive.
     * Does NOT destroy the sprite — it goes back into the pool.
     */
    reset(): void {
        if (this.lifespanTimer) {
            this.lifespanTimer.remove();
            this.lifespanTimer = null;
        }
        this.attribution = { sourceEntityId: null, sourceFactionId: null };
        this.ageMs = 0;
        this.lifespanMs = 0;
        this.wasPooled = false;
        this.removeIt = false;
        this.setActive(false);
        this.setVisible(false);
        this.body?.enable && (this.body.enable = false);
    }

    public onHitTarget() {
        if (this.lifespanTimer) this.lifespanTimer.remove();
        this.destroy();
    }
}