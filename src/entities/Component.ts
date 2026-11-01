import { Game } from '../core/Game';
import { Ship } from './Ship';
import { Weapon } from '../weapons/Weapon';
import { ManagedWeapon } from '../weapons/ManagedWeapon';
import { Ability } from '../abilities/Ability';
import type { ComponentDefinition, LegacyComponentDef, LegacyComponentTuple } from '../types/Shipmaker';

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
    public turretAngleDeg: number = 0;
    public installationSource: 'loadout' | 'built-in' | 'legacy' = 'legacy';
    public fixed: boolean = false;
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
     * Now supports typed ComponentDefinition and legacy compatibility.
     */
    init(
        definitionOrName: ComponentDefinition | LegacyComponentDef | string,
        ship: Ship | null = null,
        part: any = null
    ) {
        this.ship = ship;
        this.shipPart = part;
        this.type = '';
        this.subType = '';
        this.name = '';
        this.description = '';
        this.value = 0;
        this.ready = true;
        this.counter = 0;
        this.cooldownElapsedMs = 0;
        this.activationPending = false;
        this.turretAngleDeg = 0;
        this.installationSource = 'legacy';
        this.fixed = false;
        this.effect = null;
        this.ability = null;

        if (typeof definitionOrName === 'string') {
            // Legacy fallback: lookup in registries
            const def = this.game.componentDefinitions?.get(definitionOrName);
            if (def) {
                if (def.kind === 'legacy') {
                    this.applyLegacyDef(def);
                } else {
                    this.applyDefinition(def);
                }
            } else {
                // Absolute legacy fallback: raw tuple from Game.componentData
                const tuple = this.game.componentData[definitionOrName];
                if (tuple) {
                    this.applyLegacyTuple(definitionOrName, tuple);
                }
            }
        } else if (definitionOrName.kind === 'legacy') {
            this.applyLegacyDef(definitionOrName);
        } else {
            this.applyDefinition(definitionOrName);
        }
    }

    private applyDefinition(def: Exclude<ComponentDefinition, LegacyComponentDef>) {
        this.name = def.id;
        this.cooldown = def.operation.cooldown;
        this.energyCost = def.operation.energyCost;

        switch (def.kind) {
            case 'weapon':
                this.subType = def.id;
                this.type = "Weapon";
                this.effect = this.game.projectileManager
                    ? new ManagedWeapon(this.game.projectileManager)
                    : new Weapon();
                this.effect.init(def, this);
                break;
            case 'propulsion':
                this.subType = def.category;
                this.type = "Passive";
                break;
            case 'utility':
                this.subType = def.category;
                this.type = "Passive";
                break;
        }
    }

    private applyLegacyDef(def: LegacyComponentDef) {
        this.type = def.category || "Passive";
        this.subType = def.subType || def.id;
        this.name = def.id;
        this.value = def.value ?? 0;
        this.cooldown = def.cooldown || 1.0;
        this.energyCost = def.category === 'Weapon'
            ? def.energyCost || 5
            : def.energyCost || 0;
        this.description = def.description || "";

        switch (def.category) {
            case 'Weapon':
                this.type = "Weapon";
                this.effect = this.game.projectileManager
                    ? new ManagedWeapon(this.game.projectileManager)
                    : new Weapon();
                this.effect.init(def, this);
                break;
            case 'Skill':
                this.type = "Skill";
                this.ability = new Ability();
                this.ability.init(def.id, this);
                if (this.ship) {
                    this.ability.ship = this.ship;
                    this.ability.shipComp = this;
                }
                break;
            case 'Spawn':
                this.type = "Spawn";
                this.ability = new Ability();
                this.ability.init(def.id, this);
                this.ability.type = "Spawn";
                break;
            case 'Passive':
                this.type = "Passive";
                break;
        }
    }

    private applyLegacyTuple(name: string, tuple: LegacyComponentTuple) {
        const category = tuple[0] || "Passive";
        const subType = tuple[1] || name;
        this.name = name;
        this.type = category;
        this.subType = subType;

        if (tuple[0] === "Weapon") {
            this.value = tuple[2] ?? 0;
            this.effect = this.game.projectileManager
                ? new ManagedWeapon(this.game.projectileManager)
                : new Weapon();
            this.effect.init(name, this);
            this.cooldown = this.effect.cooldown;
            this.energyCost = this.effect.energyCost;
            this.description = typeof tuple[5] === "string" ? tuple[5] : "";
            return;
        }

        this.value = tuple[2] ?? 0;
        this.cooldown = tuple[3] || 1.0;
        this.energyCost = tuple[4] || 0;
        this.description = typeof tuple[5] === "string" ? tuple[5] : "";
        if (category === "Skill") {
            this.type = "Skill";
            this.ability = new Ability();
            this.ability.init(name, this);
            if (this.ship) {
                this.ability.ship = this.ship;
                this.ability.shipComp = this;
            }
        } else if (category === "Spawn") {
            this.type = "Spawn";
            this.ability = new Ability();
            this.ability.init(name, this);
            this.ability.type = "Spawn";
        } else {
            this.type = "Passive";
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