import { Game } from '../core/Game';
import { Ship } from './Ship';
import { Weapon } from '../weapons/Weapon';
import { ManagedWeapon } from '../weapons/ManagedWeapon';
import { Ability } from '../abilities/Ability';

/**
 * Component class - Represents modular modules equipped to ship parts.
 * Ported from ActionScript Component.as
 */
export class Component {
    public game: Game;
    public ship: Ship | null = null;
    public shipPart: any = null;

    // Identity
    public type: string = "";    // "Weapon", "Skill", "Spawn", "Passive"
    public subType: string = ""; // Specific component name (e.g., "Cannon1")
    public name: string = "";
    public description: string = "";

    // Stats & State
    public value: number = 0;
    public ready: boolean = true;
    public active: boolean = true;
    public removeIt: boolean = false;
    public cooldown: number = 0;    // seconds
    public energyCost: number = 0;
    public counter: number = 0;     // tick counter for cooldown
    private cooldownElapsedMs: number = 0;
    private activationPending: boolean = false;

    // Functionality References
    public effect: Weapon | null = null;
    public ability: Ability | null = null;

    // Visual indicators
    public tint: any = null; // Visual state for skill buttons

    constructor() {
        this.game = Game.instance;
    }

    /**
     * Initializes the component based on game data definitions.
     */
    init(name: string, ship: Ship | null = null, part: any = null) {
        this.subType = name;
        this.ship = ship;
        this.shipPart = part;
        this.ready = true;
        this.counter = 0;
        this.cooldownElapsedMs = 0;
        this.activationPending = false;
        this.effect = null;
        this.ability = null;

        // Load component definition from Game data registry
        const compDef = this.game.componentData[name];
        if (compDef) {
            this.type = compDef[0] || "Passive";
            this.subType = compDef[1] || name;
            this.value = compDef[2] ?? 0;
            this.name = name;

            // Logic instantiation
            if (this.type === "Weapon") {
                // Prefer ManagedWeapon if projectile management is available
                this.effect = this.game.projectileManager
                    ? new ManagedWeapon(this.game.projectileManager)
                    : new Weapon();
                this.effect.init(name, this);
                this.cooldown = this.effect.cooldown;
                this.energyCost = this.effect.energyCost;
                this.description = typeof compDef[5] === "string" ? compDef[5] : "";
            } else if (this.type === "Skill") {
                this.cooldown = compDef[3] || 1.0;
                this.energyCost = compDef[4] || 0;
                this.description = compDef[5] || "";
                this.ability = new Ability();
                this.ability.init(name, this);
                if (this.ship) {
                    this.ability.ship = this.ship;
                    this.ability.shipComp = this;
                }
            } else if (this.type === "Spawn") {
                this.cooldown = compDef[3] || 1.0;
                this.energyCost = compDef[4] || 0;
                this.description = compDef[5] || "";
                // Spawn logic can be handled via Ability or custom Spawn class
                this.ability = new Ability();
                this.ability.init(name, this);
                this.ability.type = "Spawn";
            } else {
                this.cooldown = compDef[3] || 1.0;
                this.energyCost = compDef[4] || 0;
                this.description = compDef[5] || "";
            }
        }
    }

    /**
     * Updates the component state (handling cooldowns).
     */
    update(delta?: number) {
        if (this.ready || this.activationPending) return;

        if (this.type === "Weapon" && delta !== undefined) {
            this.cooldownElapsedMs += delta;
            if (this.cooldownElapsedMs >= this.cooldown * 1000) {
                this.ready = true;
                this.cooldownElapsedMs = 0;
            }
        } else {
            // Legacy non-Phaser updates represent one second as ten ticks.
            this.counter++;
            if (this.counter >= this.cooldown * 10) {
                this.ready = true;
                this.counter = 0;
            }
        }

        // Update nested weapon/ability logic
        if (this.ability) this.ability.update();
    }

    /**
     * Triggers the component's primary action (firing or activating skill).
     */
    async activate(target: any = null): Promise<boolean> {
        const ship = this.ship;
        if (!this.ready || !ship) return false;

        // Energy check
        if (ship.currentEnergy < this.energyCost) {
            if (ship.subType === "Player") {
                this.game.playSound("Info");
            }
            return false;
        }

        this.ready = false;
        this.activationPending = true;

        let success = false;
        try {
            if (this.effect) {
                success = await this.effect.activate(target);
            } else if (this.ability) {
                success = await this.ability.activate(target);
            }
        } catch (error) {
            this.ready = true;
            this.activationPending = false;
            this.counter = 0;
            this.cooldownElapsedMs = 0;
            console.error(`Failed to activate component "${this.name}".`, error);
            return false;
        }

        this.activationPending = false;
        if (success) {
            // Deduct energy and start cooldown
            ship.currentEnergy -= this.energyCost;
            this.counter = 0;
            this.cooldownElapsedMs = 0;

            // If it has a UI tint (button), mark as active
            if (this.tint) {
                this.tint.selected = true;
            }
        } else {
            this.ready = true;
            this.counter = 0;
            this.cooldownElapsedMs = 0;
        }

        return success;
    }

    /**
     * Resets the component state.
     */
    reset() {
        this.ready = true;
        this.counter = 0;
        this.cooldownElapsedMs = 0;
        this.activationPending = false;
        if (this.ability) {
            this.ability.ready = true;
            this.ability.deactivate();
        }
    }
}