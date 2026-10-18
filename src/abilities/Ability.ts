import { Game } from '../core/Game';
import { Ship } from '../entities/Ship';

export class Ability {
    public game: Game;
    public ability: any = null;
    public component: any = null;
    public type: string = ""; // e.g., "Boost", "Shield", "Stealth"
    public subType: string = "";
    public name: string = "";
    public value: number = 0;
    public ready: boolean = true;
    public active: boolean = false;
    public removeIt: boolean = false;
    public cooldown: number = 0;
    public energyCost: number = 0;
    public counter: number = 0;
    public duration: number = 0; // seconds
    public charge: number = 0; // seconds to charge
    public areaRadius: number = 0;
    public canTarget: string = ""; // "Self", "Ally", "Enemy", "All"
    public canTargetSelf: boolean = false;
    public canTargetAlly: boolean = false;
    public canTargetEnemy: boolean = false;
    public isActive: boolean = false;
    public isCharging: boolean = false;
    public impactHit: any = null;
    public impactMiss: any = null;
    public targetedShips: Ship[] = [];
    public targeted: Ship | null = null;
    public bufferBmp: any = null;
    public sprite: any = null;
    public shipComp: any = null;
    public ship: Ship | null = null; // reference to ship

    // Stats
    public shield: number = 0;
    public hull: number = 0;
    public energy: number = 0;
    public damage: number = 0;
    public damagePercent: number = 0;
    public damageAbsorb: number = 0;

    constructor() {
        this.game = Game.instance;
    }

    init(name: string, component: any) {
        this.name = name;
        this.component = component;

        // Load ability definition from game data
        const abilityDef = this.game.shipData?.[name] || this.game.componentData?.[name];
        if (abilityDef) {
            // Expecting array: [type, subType, shield, hull, energy, areaRadius, charge, cooldown, duration, canTarget, ...]
            const [type, subType, shield, hull, energy, areaRadius, charge, cooldown, duration, canTarget, damage, damagePercent, damageAbsorb] = abilityDef;
            this.type = type;
            this.subType = subType;
            this.shield = shield || 0;
            this.hull = hull || 0;
            this.energy = energy || 0;
            this.areaRadius = areaRadius || 0;
            this.charge = charge || 0;
            this.cooldown = cooldown || 0;
            this.duration = duration || 0;
            this.canTarget = canTarget || "";
            this.canTargetSelf = this.canTarget.includes("Self") || this.canTarget === "Self";
            this.canTargetAlly = this.canTarget.includes("Ally") || this.canTarget === "Ally";
            this.canTargetEnemy = this.canTarget.includes("Enemy") || this.canTarget === "Enemy";
            this.damage = damage || 0;
            this.damagePercent = damagePercent || 0;
            this.damageAbsorb = damageAbsorb || 0;
            this.name = name;
            this.value = 0; // not used
        }

        // Setup visual effect (placeholder)
        // this.sprite = new Phaser.GameObjects.Sprite(...); // would be set by ship
    }

    update() {
        if (this.isCharging) {
            this.counter++;
            if (this.counter >= this.charge * 10) {
                this.isCharging = false;
                this.trigger(); // Activate after charge
            }
        } else if (this.active) {
            this.counter++;
            if (this.counter >= this.duration * 10) {
                this.deactivate();
            }
        } else if (!this.ready) {
            this.counter++;
            if (this.counter >= this.cooldown * 10) {
                this.ready = true;
                this.counter = 0;
            }
        }
    }

    activate(param1: Ship = null): boolean {
        if (!this.ready) return false;

        // Determine targets
        this.targetedShips = [];
        if (this.areaRadius > 0) {
            if (this.ship) {
                this.targetedShips = this.game.getShipsInArea(this.ship.x, this.ship.y, this.areaRadius, this.ship.alignment);
            }
        } else if (this.canTargetAlly && param1 && param1.alignment === this.ship.alignment) {
            this.targetedShips = [param1];
        } else if (this.canTargetEnemy && param1 && param1.alignment !== this.ship.alignment) {
            this.targetedShips = [param1];
        } else if (this.canTargetSelf && this.ship) {
            this.targetedShips = [this.ship];
        }

        if (this.targetedShips.length === 0) {
            // No valid targets
            return false;
        }

        this.removeIt = false;
        this.counter = 0;
        this.isCharging = true;
        return true;
    }

    trigger() {
        this.isCharging = false;
        this.active = true;
        this.isActive = true;
        this.ready = false;
        this.counter = 0;

        // Apply effects to targets
        for (const target of this.targetedShips) {
            if (this.type === "Boost") {
                target.currentShell = Math.min(target.maxShell, target.currentShell + this.shield);
                target.currentHull = Math.min(target.maxHull, target.currentHull + this.hull);
                target.currentEnergy = Math.min(target.maxEnergy, target.currentEnergy + this.energy);
                if (target.onScreen) this.game.playSound("Skill2");
            } else if (this.type === "Shield") {
                target.immobile = true;
                target.pacified = true;
                target.invulnerable = true;
                if (target.onScreen) this.game.playSound("Skill1");
            } else if (this.type === "Stealth") {
                // Stealth effect: change blend mode and alpha
                if (target.sprite) {
                    target.sprite.setBlendMode(Phaser.BlendModes.ADD);
                    target.sprite.setAlpha(0.5);
                }
                if (target.onScreen) this.game.playSound("Skill1");
            } else if (this.type === "DamageBuff") {
                // Increase weapon damage
                for (const comp of target.compWeapon) {
                    if (comp.effect) {
                        comp.effect.damage += this.damage;
                    }
                }
                if (target.onScreen) this.game.playSound("Skill3");
            } else if (this.type === "Teleport") {
                // Teleport to target location or random
                // Implementation omitted for brevity
            } else if (this.type === "Thrust") {
                // Apply thrust
                // Implementation omitted
            } else if (this.type === "TractorEffect") {
                // Already handled by TractorEffect component
            }
        }

        // Play sound if ship is on screen
        if (this.ship && this.ship.onScreen) {
            // Sound already played in specific cases above
        }
    }

    deactivate() {
        if (!this.active) return;

        this.active = false;
        this.isActive = false;
        this.removeIt = true;

        // Revert effects
        for (const target of this.targetedShips) {
            if (this.type === "Boost") {
                // Boost effects are temporary and already worn off by duration
            } else if (this.type === "Shield") {
                target.immobile = false;
                target.pacified = false;
                target.invulnerable = false;
                if (target.comp.tint) {
                    target.comp.tint.selected = false;
                }
            } else if (this.type === "Stealth") {
                if (target.sprite) {
                    target.sprite.setBlendMode(Phaser.BlendModes.NORMAL);
                    target.sprite.setAlpha(1);
                }
            } else if (this.type === "DamageBuff") {
                for (const comp of target.compWeapon) {
                    if (comp.effect) {
                        comp.effect.damage -= this.damage;
                    }
                }
            }
            // Other deactivations...
        }

        // Reset visual
        if (this.component && this.component.tint) {
            this.component.tint.selected = false;
        }

        this.targetedShips = [];
        this.targeted = null;
    }
}