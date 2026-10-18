import { Game } from '../core/Game';
import { Component } from '../entities/Component';

export class Weapon {
    public game: Game;
    public component: Component | null = null;
    public type: string = ""; // "Beam", "Cannon", "Projectile", "ProjectileArcade"
    public subType: string = "";
    public name: string = "";
    public damage: number = 10;
    public range: number = 300;
    public cooldown: number = 1.0;
    public energyCost: number = 5;
    public projectileSpeed: number = 10;
    public splashRadius: number = 0;
    public counter: number = 0;
    public ready: boolean = true;
    public removeIt: boolean = false;

    // Phaser visual references
    public sprite: any = null;
    public projSprite: any = null;
    public impactHit: any = null;
    public impactMiss: any = null;

    constructor() {
        this.game = Game.instance;
    }

    init(name: string, component: Component) {
        this.name = name;
        this.component = component;

        // Load weapon data from game definitions
        const weaponDef = this.game.componentData[name];
        if (weaponDef) {
            const [type, subType, damage, range, cooldown, energyCost, speed, splash] = weaponDef;
            this.type = type || "Cannon";
            this.subType = subType || "";
            this.damage = damage || 10;
            this.range = range || 300;
            this.cooldown = cooldown || 1.0;
            this.energyCost = energyCost || 5;
            this.projectileSpeed = speed || 10;
            this.splashRadius = splash || 0;
        }
    }

    update() {
        if (!this.ready) {
            this.counter++;
            if (this.counter >= this.cooldown * 10) {
                this.ready = true;
                this.counter = 0;
            }
        }
    }

    activate(target: any = null) {
        if (!this.ready || !this.component || !this.component.ship) return false;

        const ship = this.component.ship;
        const part = this.component.shipPart;

        // Fire weapon based on type
        if (this.type === "Beam") {
            this.fireBeam(ship, target);
        } else if (this.type === "Cannon" || this.type === "Projectile") {
            this.fireProjectile(ship, part, target);
        } else if (this.type === "ProjectileArcade") {
            this.fireArcadeProjectile(ship, part, target);
        }

        // Play sound
        if (ship.onScreen) {
            this.game.playSound(this.type === "Beam" ? "Beam1" : "Cannon");
        }

        this.ready = false;
        this.counter = 0;
        return true;
    }

    fireBeam(ship: any, target: any) {
        // Implement instant hit beam weapon
        if (target && typeof target.takeDamage === "function") {
            target.takeDamage(this.damage, "energy");
        }
    }

    fireProjectile(ship: any, part: any, target: any) {
        // Calculate spawn position based on part offset and ship rotation
        const rad = ship.rotation * (Math.PI / 180);
        const spawnX = ship.x + Math.cos(rad) * part.x - Math.sin(rad) * part.y;
        const spawnY = ship.y + Math.sin(rad) * part.x + Math.cos(rad) * part.y;

        // Add project to game queue or spawn bullet
        // In a full implementation, create a Projectile object in Phaser physics or custom pool
    }

    fireArcadeProjectile(ship: any, part: any, target: any) {
        // Similar to standard projectile with arcade physics vector
    }
}