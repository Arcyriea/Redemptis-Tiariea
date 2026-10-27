import { Game } from '../core/Game';
import { Component } from '../entities/Component';
// PhysicsProjectile and Phaser imported dynamically in fireArcadeProjectile (browser only)

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
            const [compCategory, weaponType, damage, range, cooldown, energyCost, speed, splash] = weaponDef;
            // compCategory = "Weapon" (component category), weaponType = "Cannon"/"Beam"/"Projectile"/"ProjectileArcade"
            this.type = weaponType || "Cannon";       // Weapon subtype for firing logic
            this.subType = compCategory || "Weapon";   // Component category
            this.damage = damage || 10;
            this.range = range || 300;
            this.cooldown = cooldown || 1.0;
            this.energyCost = energyCost || 5;
            this.projectileSpeed = speed || 10;
            this.splashRadius = splash || 0;
        }
    }

    async activate(target: any = null) {
        if (!this.component || !this.component.ship) return false;

        const ship = this.component.ship;
        const part = this.component.shipPart;

        // Fire weapon based on type
        if (this.type === "Beam") {
            this.fireBeam(ship, target);
        } else if (this.type === "Cannon" || this.type === "Projectile") {
            this.fireProjectile(ship, part, target);
        } else if (this.type === "ProjectileArcade") {
            if (!(await this.fireArcadeProjectile(ship, part, target))) return false;
        } else {
            return false;
        }

        // Play sound
        if (ship.onScreen) {
            this.game.playSound(this.type === "Beam" ? "Beam1" : "Cannon");
        }

        return true;
    }

    fireBeam(_ship: any, _target: any) {
        // Implement instant hit beam weapon
        if (_target && typeof _target.takeDamage === "function") {
            _target.takeDamage(this.damage, "energy");
        }
    }

    fireProjectile(_ship: any, _part: any, _target: any) {
        // Projectile spawning is handled by the scene-specific fire paths.
    }

    async fireArcadeProjectile(ship: any, part: any, _target: any): Promise<boolean> {
        // Use direct Phaser Scene reference on ship (set by GameScene during player creation)
        const scene = ship.phaserScene;
        if (!scene) return false;

        // Ship.rotation is in degrees; convert to radians
        const rad = ship.rotation * (Math.PI / 180);

        // Calculate spawn position from part offset (same math as fireProjectile)
        const spawnX = ship.x + Math.cos(rad) * part.x - Math.sin(rad) * part.y;
        const spawnY = ship.y + Math.sin(rad) * part.x + Math.cos(rad) * part.y;

        // Get shooter velocity from Phaser body for velocity inheritance
        const body = ship.phaserBody as any; // Phaser.Physics.Arcade.Body (browser only)
        const shooterVelocityX = body?.velocity?.x ?? 0;
        const shooterVelocityY = body?.velocity?.y ?? 0;

        // Dynamic import to avoid pulling Phaser into Node.js test environment
        const { PhysicsProjectile } = await import('../physics/PhysicsProjectile');
        if (ship.phaserScene !== scene) return false;

        // Create projectile via PhysicsProjectile (inherits velocity, applies drag, auto-destructs)
        const projectile = new PhysicsProjectile({
            scene,
            x: spawnX,
            y: spawnY,
            texture: 'bullet',
            shooterVelocityX,
            shooterVelocityY,
            angle: rad,
            muzzleVelocity: this.projectileSpeed,
            damage: this.damage,
            drag: 10,
            lifespanMs: 2000
        });

        // Group insertion reapplies its body defaults, so restore the captured firing physics.
        scene.playerProjectiles?.add(projectile);
        projectile.setVelocity(
            Math.cos(rad) * this.projectileSpeed + shooterVelocityX,
            Math.sin(rad) * this.projectileSpeed + shooterVelocityY
        );
        projectile.setDrag(10);
        return true;
    }
}