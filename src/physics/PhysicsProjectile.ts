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

export class PhysicsProjectile extends Phaser.Physics.Arcade.Sprite {
    public damage: number;
    private lifespanTimer: Phaser.Time.TimerEvent;

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
        this.lifespanTimer = config.scene.time.delayedCall(lifespan, () => {
            if (this.active) {
                this.destroy();
            }
        });
    }

    public onHitTarget() {
        if (this.lifespanTimer) this.lifespanTimer.remove();
        this.destroy();
    }
}
