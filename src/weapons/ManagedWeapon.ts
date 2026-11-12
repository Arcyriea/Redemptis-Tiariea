import { Weapon } from './Weapon';
import { ProjectileManager } from '../managers/ProjectileManager';
import { degreesToRadians } from './WeaponTransform';

/**
 * ManagedWeapon wraps Weapon to delegate projectile spawning to ProjectileManager.
 *
 * Design rationale:
 *  - Preserves all existing Weapon behavior (cooldowns, energy, sound, etc.)
 *  - Only overrides the actual projectile creation path
 *  - No changes to Component or Ship classes needed
 *  - Attribution captured at fire time and survives source destruction
 */
export class ManagedWeapon extends Weapon {
    constructor(private projectileManager: ProjectileManager) {
        super(); // Game.instance set by Weapon constructor
    }

    async fireArcadeProjectile(ship: any, part: any, _target: any): Promise<boolean> {
        const scene = ship.phaserScene;
        if (!scene) return false;

        // Get shooter velocity from Phaser body for velocity inheritance
        const body = ship.phaserBody as Phaser.Physics.Arcade.Body;
        const shooterVelocityX = body?.velocity?.x ?? 0;
        const shooterVelocityY = body?.velocity?.y ?? 0;

        // Attribution captured HERE at fire time
        const sourceEntityId = ship.id ?? null;
        const sourceFactionId = this.game.factionManager.getFaction(ship) ?? null;

        for (const muzzle of this.resolveMuzzles(ship, part)) {
            await this.projectileManager.spawn({
                x: muzzle.x,
                y: muzzle.y,
                angle: degreesToRadians(muzzle.directionDeg),
                muzzleVelocity: this.projectileSpeed,
                shooterVelocityX,
                shooterVelocityY,
                damage: this.damage,
                drag: 10,
                lifespanMs: 2000,
                texture: 'bullet',
                attribution: { sourceEntityId, sourceFactionId }
            });
        }
        return true;
    }
}
