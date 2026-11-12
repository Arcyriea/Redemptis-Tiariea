import { Game } from '../core/Game';
import type { Component } from '../entities/Component';
import type { ComponentDefinition } from '../types/Shipmaker';
import type { ProjectileConfig } from '../physics/PhysicsProjectile';
import {
    degreesToRadians,
    resolveWeaponMuzzles,
    velocityFromMuzzle,
    type ResolvedWeaponMuzzle
} from './WeaponTransform';

export class Weapon {
    public game: Game;
    public component: Component | null = null;
    public type: string = "";
    public subType: string = "";
    public name: string = "";
    public damage: number = 10;
    public range: number = 300;
    public cooldown: number = 1.0;
    public energyCost: number = 5;
    public projectileSpeed: number = 10;
    public splashRadius: number = 0;
    public removeIt: boolean = false;

    public sprite: any = null;
    public projSprite: any = null;
    public impactHit: any = null;
    public impactMiss: any = null;

    constructor() {
        this.game = Game.instance;
    }

    init(definitionOrName: ComponentDefinition | string, component: Component): void {
        this.component = component;

        if (typeof definitionOrName === 'string') {
            this.name = definitionOrName;
            const weaponDef = this.game.componentData[definitionOrName];
            if (weaponDef?.[0] === 'Weapon') {
                const [, firingMode, damage, range, cooldown, energyCost, speed, splash] = weaponDef;
                this.type = firingMode || "Cannon";
                this.subType = weaponDef[0] || "Weapon";
                this.damage = damage || 10;
                this.range = range || 300;
                this.cooldown = cooldown || 1.0;
                this.energyCost = energyCost || 5;
                this.projectileSpeed = speed || 10;
                this.splashRadius = splash || 0;
            }
            return;
        }

        if (definitionOrName.kind === 'legacy') {
            if (definitionOrName.category !== 'Weapon') return;
            const weapon = definitionOrName.weapon;
            this.name = definitionOrName.id;
            this.type = weapon?.firingMode || "Cannon";
            this.subType = definitionOrName.category;
            this.damage = weapon?.damage || 10;
            this.range = weapon?.range || 300;
            this.cooldown = definitionOrName.cooldown || 1.0;
            this.energyCost = definitionOrName.energyCost || 5;
            this.projectileSpeed = weapon?.projectileSpeed || 10;
            this.splashRadius = weapon?.splashRadius || 0;
            return;
        }

        if (definitionOrName.kind !== 'weapon') return;
        this.name = definitionOrName.id;
        this.type = definitionOrName.operation.firingMode;
        this.subType = "Weapon";
        this.damage = definitionOrName.operation.damage;
        this.range = definitionOrName.operation.range;
        this.cooldown = definitionOrName.operation.cooldown;
        this.energyCost = definitionOrName.operation.energyCost;
        this.projectileSpeed = definitionOrName.operation.projectileSpeed;
        this.splashRadius = definitionOrName.operation.splashRadius;
    }

    async activate(target: any = null): Promise<boolean> {
        if (!this.component || !this.component.ship) return false;

        const ship = this.component.ship;
        const part = this.component.shipPart;

        if (this.type === "Beam") {
            this.fireBeam(ship, target);
        } else if (this.type === "Cannon" || this.type === "Projectile") {
            this.fireProjectile(ship, part, target);
        } else if (this.type === "ProjectileArcade") {
            if (!(await this.fireArcadeProjectile(ship, part, target))) return false;
        } else {
            return false;
        }

        if (ship.onScreen) {
            this.game.playSound(this.type === "Beam" ? "Beam1" : "Cannon");
        }

        return true;
    }

    fireBeam(_ship: any, target: any): void {
        if (target && typeof target.takeDamage === "function") {
            target.takeDamage(this.damage, "energy");
        }
    }

    fireProjectile(_ship: any, _part: any, _target: any): void {
        // Projectile spawning is handled by the scene-specific fire paths.
    }

    protected resolveMuzzles(ship: any, part: any): readonly ResolvedWeaponMuzzle[] {
        const definition = this.component?.spinalWeaponDefinition;
        return resolveWeaponMuzzles({
            ship: { x: ship.x, y: ship.y, rotationDeg: ship.rotation },
            mount: {
                position: { x: part.x, y: part.y },
                // Legacy part rotation has historically not affected firing direction.
                rotationDeg: definition ? part.rotation ?? 0 : 0
            },
            attachment: definition
                ? {
                    position: definition.attachment.position,
                    rotationDeg: definition.attachment.attachmentRotationDeg
                }
                : { position: { x: 0, y: 0 }, rotationDeg: 0 },
            muzzles: definition?.geometry.muzzles ?? []
        });
    }

    protected async loadPhysicsProjectileConstructor(): Promise<
        typeof import('../physics/PhysicsProjectile').PhysicsProjectile
    > {
        const { PhysicsProjectile } = await import('../physics/PhysicsProjectile');
        return PhysicsProjectile;
    }

    async fireArcadeProjectile(ship: any, part: any, _target: any): Promise<boolean> {
        const scene = ship.phaserScene;
        if (!scene) return false;

        const muzzles = this.resolveMuzzles(ship, part);
        const body = ship.phaserBody as any;
        const shooterVelocityX = body?.velocity?.x ?? 0;
        const shooterVelocityY = body?.velocity?.y ?? 0;
        const PhysicsProjectile = await this.loadPhysicsProjectileConstructor();
        if (ship.phaserScene !== scene) return false;

        for (const muzzle of muzzles) {
            const angle = degreesToRadians(muzzle.directionDeg);
            const projectileConfig: ProjectileConfig = {
                scene,
                x: muzzle.x,
                y: muzzle.y,
                texture: 'bullet',
                shooterVelocityX,
                shooterVelocityY,
                angle,
                muzzleVelocity: this.projectileSpeed,
                damage: this.damage,
                drag: 10,
                lifespanMs: 2000
            };
            const projectile = new PhysicsProjectile(projectileConfig);
            scene.playerProjectiles?.add(projectile);
            const velocity = velocityFromMuzzle(angle, this.projectileSpeed, {
                x: shooterVelocityX,
                y: shooterVelocityY
            });
            projectile.setVelocity(velocity.x, velocity.y);
            projectile.setDrag(10);
        }
        return true;
    }
}
