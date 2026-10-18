import { Game } from '../core/Game';
import { Ship } from './Ship';
import { Weapon } from '../weapons/Weapon';
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

        // Load component definition from Game data registry
        const compDef = this.game.componentData[name];
        if (compDef) {
            // compDef structure: [type, subType, cost, cooldown, energyCost, description, ...]
            this.type = compDef[0] || "Passive";
            this.subType = compDef[1] || name;
            this.value = compDef[2] || 0;
            this.cooldown = compDef[3] || 1.0;
            this.energyCost = compDef[4] || 0;
            this.description = compDef[5] || "";
            this.name = name;

            // Logic instantiation
            if (this.type === "Weapon") {
                this.effect = new Weapon();
                this.effect.init(name, this);
            } else if (this.type === "Skill") {
                this.ability = new Ability();
                this.ability.init(name, this);
                if (this.ship) {
                    this.ability.ship = this.ship;
                    this.ability.shipComp = this;
                }
            } else if (this.type === "Spawn") {
                // Spawn logic can be handled via Ability or custom Spawn class
                this.ability = new Ability();
                this.ability.init(name, this);
                this.ability.type = "Spawn";
            }
        }
    }

    /**
     * Updates the component state (handling cooldowns).
     */
    update() {
        if (this.ready) return;

        // Advance cooldown counter
        this.counter++;

        // In AS3 code, 1 second is often represented as 10 ticks in the update loop
        if (this.counter >= this.cooldown * 10) {
            this.ready = true;
            this.counter = 0;
        }

        // Update nested weapon/ability logic
        if (this.effect) this.effect.update();
        if (this.ability) this.ability.update();
    }

    /**
     * Triggers the component's primary action (firing or activating skill).
     */
    activate(target: any = null): boolean {
        if (!this.ready || !this.ship) return false;

        // Energy check
        if (this.ship.currentEnergy < this.energyCost) {
            if (this.ship.subType === "Player") {
                this.game.playSound("Info");
            }
            return false;
        }

        let success = false;

        // Execute based on type
        if (this.effect) {
            success = this.effect.activate(target);
        } else if (this.ability) {
            success = this.ability.activate(target);
        }

        if (success) {
            // Deduct energy and start cooldown
            this.ship.currentEnergy -= this.energyCost;
            this.ready = false;
            this.counter = 0;

            // If it has a UI tint (button), mark as active
            if (this.tint) {
                this.tint.selected = true;
            }
        }

        return success;
    }

    /**
     * Resets the component state.
     */
    reset() {
        this.ready = true;
        this.counter = 0;
        if (this.effect) this.effect.ready = true;
        if (this.ability) {
            this.ability.ready = true;
            this.ability.deactivate();
        }
    }
}