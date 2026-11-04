import { Game } from '../core/Game';
import { Component } from './Component';
import { TractorEffect } from '../effects/TractorEffect';
import { YUTIARINALIA } from '../managers/FactionManager';
import { StatModifierType } from '../types/Shipmaker';
import type {
    ComponentDefinition,
    HullDefinition,
    HullModificationDefinition,
    HullModificationId,
    LegacyShipDefinition,
    ModifiableStatId,
    ShipBlueprintDefinition as CanonicalShipBlueprintDefinition
} from '../types/Shipmaker';
import type { ShipBlueprintDefinition as LegacyStructuredShipBlueprint } from '../managers/ShipBlueprint';

type ShipStats = { [Stat in ModifiableStatId]: number };
type ImmutableShipStats = Readonly<ShipStats>;

const MINIMUM_STAT_VALUES: Record<ModifiableStatId, number> = {
    maxHull: 0,
    maxShell: 0,
    regenShell: 0,
    maxEnergy: 0,
    regenEnergy: 0,
    maxSpeed: 0,
    acceleration: 0,
    weight: 0,
    radius: 0,
    value: 0
};

function isModifiableStatId(value: unknown): value is ModifiableStatId {
    return typeof value === 'string' &&
        Object.prototype.hasOwnProperty.call(MINIMUM_STAT_VALUES, value);
}

function isValidStatValue(stat: ModifiableStatId, value: number): boolean {
    return Number.isFinite(value) && value >= MINIMUM_STAT_VALUES[stat];
}

export class Ship {
    [x: string]: any;
    public game: Game;
    public x: number = 0;
    public y: number = 0;
    public rotation: number = 0;
    public scaleX: number = 1;
    public scaleY: number = 1;

    // Identity & Properties
    public type: string = "";
    public superType: string = "Ship"; // "Ship", "Turret", "Station", "AirDrone", "GroundDrone"
    public subType: string = ""; // "Player", "Commander", "Harvester", "Worker", "Resource", etc.
    public name: string = "";
    public categoryType: string = ""; // "Air" or "Ground"

    // Stats
    public maxHull: number = 100;
    public currentHull: number = 100;
    public maxShell: number = 50; // Shield/Shell points
    public currentShell: number = 50;
    public regenShell: number = 0;
    public maxEnergy: number = 100;
    public currentEnergy: number = 100;
    public regenEnergy: number = 20;
    public maxSpeed: number = 5.0;
    public acceleration: number = 0.5;
    public weight: number = 10;
    public radius: number = 20;
    public value: number = 100;

    // Hull Modification State
    private _hullMods: Set<HullModificationId> = new Set();
    public get hullMods(): ReadonlySet<HullModificationId> {
        return new Set(this._hullMods);
    }
    private baseStats: ImmutableShipStats | null = null;
    private hullDefinition: HullDefinition | null = null;

    // Movement & AI
    public moving: boolean = false;
    public rotating: boolean = false;
    public breaking: boolean = false;
    public immobile: boolean = false;
    public pacified: boolean = false;
    public invulnerable: boolean = false;
    public control: boolean = false;
    public moveX: number = 0;
    public moveY: number = 0;
    public moveToX: number = 0;
    public moveToY: number = 0;
    public targetRotation: number = 0;
    public waypoints: any[] = [];
    public homeBase: Ship | null = null;
    public shipAi: any = null;

    // Modular Components
    public parts: any[] = [];
    public components: Component[] = [];
    public compSkill: Component[] = [];
    public compWeapon: Component[] = [];
    public compSpawn: Component[] = [];
    public compPassive: Component[] = [];

    // Effects & Visuals
    public tractor: TractorEffect | null = null;
    public active: boolean = true;
    public removeIt: boolean = false;
    public exploding: boolean = false;
    public onScreen: boolean = false;
    public loot: number = 0;
    public tasks: any[] = [];

    // Phaser Sprite Reference
    public sprite: any = null;
    public selection: any = null;
    public dot: any = null;

    constructor() {
        this.game = Game.instance;
    }

    init(type: string): void {
        for (const component of this.components) component.reset();
        this.type = type;

        // 1. Clear stale state for pooled ships
        this._hullMods.clear();
        this.baseStats = null;
        this.hullDefinition = null;

        // 2. Reset runtime stats to clean baseline
        this.maxHull = 100;
        this.maxShell = 50;
        this.regenShell = 0;
        this.maxEnergy = 100;
        this.regenEnergy = 20;
        this.maxSpeed = 5.0;
        this.acceleration = 0.5;
        this.weight = 10;
        this.radius = 20;
        this.value = 100;

        this.removeIt = false;
        this.exploding = false;
        this.immobile = false;
        this.parts.length = 0;
        this.components.length = 0;
        this.compSkill.length = 0;
        this.compWeapon.length = 0;
        this.compSpawn.length = 0;
        this.compPassive.length = 0;
        if (this.tractor) this.tractor.removeIt = true;
        this.tractor = null;

        const blueprint = this.game.shipManager?.getBlueprintForSourceKey(type);
        const blueprintDefinition = blueprint?.shipDefinition;
        if (blueprintDefinition && 'hullId' in blueprintDefinition) {
            this.initCanonicalBlueprint(blueprintDefinition);
        } else if (blueprintDefinition) {
            this.initStructuredLegacyBlueprint(blueprintDefinition);
        } else {
            const legacyDefinition = this.game.shipData[type];
            if (legacyDefinition) this.initLegacyTuple(legacyDefinition);
        }

        if (this.superType === "Station" || this.superType === "Turret") {
            this.immobile = true;
        }

        // 3. Capture base snapshot after blueprint/tuple application
        this.baseStats = Object.freeze({
            maxHull: this.maxHull,
            maxShell: this.maxShell,
            regenShell: this.regenShell,
            maxEnergy: this.maxEnergy,
            regenEnergy: this.regenEnergy,
            maxSpeed: this.maxSpeed,
            acceleration: this.acceleration,
            weight: this.weight,
            radius: this.radius,
            value: this.value
        });

        // 4. Recalculate effective stats (initial run)
        const baselineStats = this.calculateStats(this._hullMods, false);
        if (!baselineStats) {
            this.active = false;
            this.removeIt = true;
            throw new Error(`Failed to calculate baseline stats for ship "${type}".`);
        }
        this.commitStats(baselineStats);

        this.currentShell = this.maxShell;
        this.currentHull = this.maxHull;
        this.currentEnergy = this.maxEnergy;

        if (this.subType === "Player" || this.subType === "Harvester" || this.subType === "Worker") {
            this.tractor = new TractorEffect();
            this.tractor.ship = this;
            this.tractor.init();
        }
    }

    private initCanonicalBlueprint(blueprint: CanonicalShipBlueprintDefinition): void {
        this.applyCanonicalBlueprint(blueprint);
        const hull = this.game.hullDefinitions.get(blueprint.hullId);
        if (!hull) throw new Error(`HullDefinition not found for "${blueprint.hullId}".`);

        const loadout = this.game.shipLoadouts.get(blueprint.loadoutId);
        if (!loadout) throw new Error(`ShipLoadout not found for "${blueprint.loadoutId}".`);

        for (const part of hull.parts) {
            this.parts.push({
                id: part.id,
                name: part.name,
                x: part.position.x,
                y: part.position.y,
                rotation: part.rotationDeg,
                isLoot: part.isLoot,
                maxHull: part.maxHull ?? 100
            });
        }

        const pointById = new Map<string, {
            point: HullDefinition['weaponHardpoints'][number] |
                HullDefinition['thrusterVents'][number] |
                HullDefinition['utilitySockets'][number] |
                HullDefinition['activeModuleMounts'][number];
            pointType: 'weapon' | 'vent' | 'utility' | 'active-module';
        }>();
        for (const point of hull.weaponHardpoints) {
            this.addCanonicalPoint(pointById, point, 'weapon', hull.id);
        }
        for (const point of hull.thrusterVents) {
            this.addCanonicalPoint(pointById, point, 'vent', hull.id);
        }
        for (const point of hull.utilitySockets) {
            this.addCanonicalPoint(pointById, point, 'utility', hull.id);
        }
        for (const point of (hull.activeModuleMounts ?? [])) {
            this.addCanonicalPoint(pointById, point, 'active-module', hull.id);
        }

        const reservedPoints = new Set<string>();
        for (const [pointId, { point, pointType }] of pointById) {
            const builtInComponentId = point.builtInComponentId;
            if (!builtInComponentId) continue;

            const component = this.requireCanonicalComponent(builtInComponentId);
            this.validateCanonicalMount(component, point, pointType);
            reservedPoints.add(pointId);
            this.installCanonicalComponent(component, point, 'built-in', true);
        }

        const loadoutPoints = new Set<string>();
        for (const installation of loadout.installations) {
            const mountId = installation.mountId;
            if (loadoutPoints.has(mountId)) {
                throw new Error(`ShipLoadout "${loadout.id}" installs multiple components at "${mountId}".`);
            }
            loadoutPoints.add(mountId);
            if (reservedPoints.has(mountId)) {
                throw new Error(`ShipLoadout "${loadout.id}" replaces built-in component at "${mountId}".`);
            }

            const entry = pointById.get(mountId);
            if (!entry) {
                throw new Error(`Mount point "${mountId}" not found on hull "${hull.id}".`);
            }
            const component = this.requireCanonicalComponent(installation.componentId);
            this.validateCanonicalMount(component, entry.point, entry.pointType);
            this.installCanonicalComponent(component, entry.point, 'loadout', false);
        }

        this.hullDefinition = hull;
    }

    private initStructuredLegacyBlueprint(blueprint: LegacyStructuredShipBlueprint): void {
        this.applyLegacyBlueprint(blueprint);
        for (const [partIndex, partDefinition] of blueprint.gameplay.parts.entries()) {
            const part = {
                name: partDefinition.name,
                x: partDefinition.x * 5,
                y: partDefinition.y * 5,
                rotation: partDefinition.rotation,
                isLoot: partDefinition.isLoot,
                maxHull: partDefinition.maxHull ?? 100
            };
            this.parts.push(part);

            for (const attachment of blueprint.gameplay.components) {
                if (attachment.partIndex === partIndex) {
                    this.addComponent(attachment.name, part, 'legacy');
                }
            }
        }
    }

    private initLegacyTuple(definition: LegacyShipDefinition): void {
        const [legacyParts, componentReferences, superType, subType, name, categoryType] = definition;
        this.superType = superType;
        this.subType = subType;
        this.name = name;
        this.categoryType = categoryType;
        this.maxHull = 0;
        this.maxShell = 0;
        this.weight = 0;
        this.value = 0;

        for (const partInfo of legacyParts) {
            const part = this.legacyPartRuntimeValues(partInfo);
            this.parts.push(part);
            this.maxShell += (part.maxHull ?? 100) * 0.5;
            this.maxHull += (part.maxHull ?? 100) * 0.25;
            this.weight += 10;
        }

        const compatibilityView = this.game.legacyCompatibilityViews?.get(this.type);
        if (compatibilityView) {
            this.hullDefinition = this.game.hullDefinitions.get(compatibilityView.hullId) ?? null;
            for (const attachment of compatibilityView.legacyAttachments) {
                const part = this.parts[attachment.partIndex];
                if (part) this.addComponent(attachment.componentId, part, 'legacy');
            }
            return;
        }

        for (let partIndex = 0; partIndex < componentReferences.length; partIndex++) {
            const componentId = this.legacyComponentId(componentReferences[partIndex]);
            const part = this.parts[partIndex];
            if (componentId && part) this.addComponent(componentId, part, 'legacy');
        }
    }

    private legacyPartRuntimeValues(
        part: LegacyShipDefinition[0][number]
    ): { name: string; x: number; y: number; rotation: number; isLoot: boolean; maxHull: number } {
        if (Array.isArray(part)) {
            const [name, x, y, rotation, isLoot = false, maxHull = 100] = part;
            return { name, x: x * 5, y: y * 5, rotation, isLoot, maxHull };
        }
        return {
            name: part.name,
            x: part.x * 5,
            y: part.y * 5,
            rotation: part.rotationDeg,
            isLoot: part.isLoot ?? false,
            maxHull: part.maxHull ?? 100
        };
    }

    private legacyComponentId(reference: LegacyShipDefinition[1][number]): string | undefined {
        if (typeof reference === 'string') {
            return reference === 'none' ? undefined : reference;
        }
        if (Array.isArray(reference)) {
            const [componentId] = reference;
            return componentId && componentId !== 'none' ? componentId : undefined;
        }
        return undefined;
    }

    private addCanonicalPoint(
        pointById: Map<string, {
            point: HullDefinition['weaponHardpoints'][number] |
                HullDefinition['thrusterVents'][number] |
                HullDefinition['utilitySockets'][number] |
                HullDefinition['activeModuleMounts'][number];
            pointType: 'weapon' | 'vent' | 'utility' | 'active-module';
        }>,
        point: HullDefinition['weaponHardpoints'][number] |
            HullDefinition['thrusterVents'][number] |
            HullDefinition['utilitySockets'][number] |
            HullDefinition['activeModuleMounts'][number],
        pointType: 'weapon' | 'vent' | 'utility' | 'active-module',
        hullId: string
    ): void {
        if (pointById.has(point.id)) {
            throw new Error(`Hull "${hullId}" has duplicate mounting point ID "${point.id}".`);
        }
        pointById.set(point.id, { point, pointType });
    }

    private requireCanonicalComponent(
        componentId: string
    ): Exclude<ComponentDefinition, { kind: 'legacy' }> {
        const component = this.game.componentDefinitions.get(componentId);
        if (!component) {
            throw new Error(`ComponentDefinition not found for "${componentId}".`);
        }
        if (component.kind === 'legacy') {
            throw new Error(`Legacy component "${componentId}" cannot be installed by a canonical loadout.`);
        }
        return component;
    }

    private validateCanonicalMount(
        component: Exclude<ComponentDefinition, { kind: 'legacy' }>,
        point: HullDefinition['weaponHardpoints'][number] |
            HullDefinition['thrusterVents'][number] |
            HullDefinition['utilitySockets'][number] |
            HullDefinition['activeModuleMounts'][number],
        pointType: 'weapon' | 'vent' | 'utility' | 'active-module'
    ): void {
        if (component.kind === 'weapon') {
            if (pointType !== 'weapon' || !('accepts' in point) || !point.accepts.includes(component.configuration)) {
                throw new Error(`Weapon "${component.id}" is incompatible with mounting point "${point.id}".`);
            }
            return;
        }

        if (component.kind === 'propulsion') {
            if (pointType !== 'vent' || !('acceptsPropulsionCategories' in point) ||
                !point.acceptsPropulsionCategories.includes(component.category)) {
                throw new Error(`Propulsion component "${component.id}" is incompatible with mounting point "${point.id}".`);
            }
            return;
        }

        if (component.kind === 'active-module') {
            if (pointType !== 'active-module' || !('acceptedCategories' in point) ||
                !point.acceptedCategories.includes(component.category)) {
                throw new Error(`Active Module "${component.id}" is incompatible with mounting point "${point.id}".`);
            }
            return;
        }

        if (pointType !== 'utility' || !('acceptedCategories' in point) ||
            !point.acceptedCategories.includes(component.category)) {
            throw new Error(`Utility component "${component.id}" is incompatible with mounting point "${point.id}".`);
        }
    }

    private installCanonicalComponent(
        definition: Exclude<ComponentDefinition, { kind: 'legacy' }>,
        point: HullDefinition['weaponHardpoints'][number] |
            HullDefinition['thrusterVents'][number] |
            HullDefinition['utilitySockets'][number] |
            HullDefinition['activeModuleMounts'][number],
        source: 'loadout' | 'built-in',
        fixed: boolean
    ): void {
        const part = {
            name: point.id,
            x: point.position.x,
            y: point.position.y,
            rotation: point.rotationDeg
        };
        this.addComponent(definition, part, source, fixed);
    }

    private addComponent(
        definitionOrId: ComponentDefinition | string,
        part: any,
        source: 'loadout' | 'built-in' | 'legacy',
        fixed = false
    ): void {
        const component = new Component();
        component.init(definitionOrId, this, part);
        component.installationSource = source;
        component.fixed = fixed;
        this.components.push(component);

        if (component.type === "Weapon") this.compWeapon.push(component);
        else if (component.type === "Skill") this.compSkill.push(component);
        else if (component.type === "Spawn") this.compSpawn.push(component);
        else if (component.type === "Passive") this.compPassive.push(component);
    }

    private applyCanonicalBlueprint(blueprint: CanonicalShipBlueprintDefinition): void {
        this.superType = blueprint.superType;
        this.subType = blueprint.subType;
        this.name = blueprint.name;
        this.categoryType = blueprint.categoryType;
        this.applyStats(blueprint.stats);
    }

    private applyLegacyBlueprint(blueprint: LegacyStructuredShipBlueprint): void {
        this.superType = blueprint.superType;
        this.subType = blueprint.subType;
        this.name = blueprint.name;
        this.categoryType = blueprint.categoryType;
        this.applyStats(blueprint.stats);
    }

    private applyStats(stats: CanonicalShipBlueprintDefinition['stats']): void {
        this.maxHull = stats.maxHull;
        this.maxShell = stats.maxShell;
        this.regenShell = stats.regenShell;
        this.maxEnergy = stats.maxEnergy;
        this.regenEnergy = stats.regenEnergy ?? 20;
        this.maxSpeed = stats.maxSpeed;
        this.acceleration = stats.acceleration;
        this.weight = stats.weight;
        this.radius = stats.radius;
        this.value = stats.value;
    }

    public addHullMod(id: HullModificationId): boolean {
        if (this._hullMods.has(id)) return false;

        const candidateMods = new Set(this._hullMods);
        candidateMods.add(id);
        const candidateStats = this.calculateStats(candidateMods);
        if (!candidateStats) return false;

        this.commitHullModState(candidateMods, candidateStats);
        return true;
    }

    public removeHullMod(id: HullModificationId): boolean {
        if (!this._hullMods.has(id)) return false;

        const candidateMods = new Set(this._hullMods);
        candidateMods.delete(id);
        const candidateStats = this.calculateStats(candidateMods);
        if (!candidateStats) return false;

        this.commitHullModState(candidateMods, candidateStats);
        return true;
    }

    private calculateStats(
        candidateMods: ReadonlySet<HullModificationId>,
        enforceCapacity = true
    ): ShipStats | null {
        if (!this.baseStats) return null;

        const mods = Array.from(candidateMods).sort();
        const definitions = new Map<HullModificationId, HullModificationDefinition>();

        if (enforceCapacity) {
            const capacity = this.hullDefinition?.hullModCapacity;
            if (
                capacity === undefined ||
                !Number.isFinite(capacity) ||
                !Number.isInteger(capacity) ||
                capacity < 0 ||
                candidateMods.size > capacity
            ) {
                return null;
            }
        }

        for (const modId of mods) {
            const definition = this.game.hullModificationDefinitions.get(modId);
            if (
                !definition ||
                definition.id !== modId ||
                typeof definition.name !== 'string' ||
                definition.name.length === 0 ||
                typeof definition.description !== 'string' ||
                !Array.isArray(definition.modifiers) ||
                (definition.conflicts !== undefined &&
                    (!Array.isArray(definition.conflicts) ||
                        definition.conflicts.some(
                            conflictId => typeof conflictId !== 'string' || conflictId.length === 0
                        )))
            ) {
                return null;
            }

            for (const modifier of definition.modifiers) {
                if (
                    !modifier ||
                    typeof modifier !== 'object' ||
                    !isModifiableStatId(modifier.stat) ||
                    (modifier.type !== StatModifierType.Additive &&
                        modifier.type !== StatModifierType.Multiplicative) ||
                    !Number.isFinite(modifier.value) ||
                    (modifier.type === StatModifierType.Multiplicative &&
                        modifier.value < 0)
                ) {
                    return null;
                }
            }

            definitions.set(modId, definition);
        }

        for (let index = 0; index < mods.length; index++) {
            const modId = mods[index];
            const definition = definitions.get(modId);
            if (!definition) return null;

            for (let otherIndex = index + 1; otherIndex < mods.length; otherIndex++) {
                const otherId = mods[otherIndex];
                const otherDefinition = definitions.get(otherId);
                if (!otherDefinition) return null;

                if (
                    definition.conflicts?.includes(otherId) ||
                    otherDefinition.conflicts?.includes(modId)
                ) {
                    return null;
                }
            }
        }

        // Every supported stat is present once through the mapped stats type.
        const candidate: ShipStats = { ...this.baseStats };

        // Additive Phase
        for (const modId of mods) {
            const definition = definitions.get(modId);
            if (!definition) return null;
            for (const modifier of definition.modifiers) {
                switch (modifier.type) {
                    case StatModifierType.Additive:
                        candidate[modifier.stat] += modifier.value;
                        break;
                    case StatModifierType.Multiplicative:
                        break;
                    default:
                        return null;
                }
            }
        }

        // Multiplicative Phase
        for (const modId of mods) {
            const definition = definitions.get(modId);
            if (!definition) return null;
            for (const modifier of definition.modifiers) {
                switch (modifier.type) {
                    case StatModifierType.Additive:
                        break;
                    case StatModifierType.Multiplicative:
                        candidate[modifier.stat] *= modifier.value;
                        break;
                    default:
                        return null;
                }
            }
        }

        for (const stat of Object.keys(candidate)) {
            if (
                !isModifiableStatId(stat) ||
                !isValidStatValue(stat, candidate[stat])
            ) {
                return null;
            }
        }

        return candidate;
    }

    private commitHullModState(
        candidateMods: ReadonlySet<HullModificationId>,
        candidateStats: ShipStats
    ): void {
        this._hullMods.clear();
        for (const modId of candidateMods) this._hullMods.add(modId);
        this.commitStats(candidateStats);
    }

    private commitStats(candidateStats: ShipStats): void {
        this.maxHull = candidateStats.maxHull;
        this.maxShell = candidateStats.maxShell;
        this.regenShell = candidateStats.regenShell;
        this.maxEnergy = candidateStats.maxEnergy;
        this.regenEnergy = candidateStats.regenEnergy;
        this.maxSpeed = candidateStats.maxSpeed;
        this.acceleration = candidateStats.acceleration;
        this.weight = candidateStats.weight;
        this.radius = candidateStats.radius;
        this.value = candidateStats.value;

        this.currentHull = Math.min(this.currentHull, this.maxHull);
        this.currentShell = Math.min(this.currentShell, this.maxShell);
        this.currentEnergy = Math.min(this.currentEnergy, this.maxEnergy);
    }

    update(delta?: number) {
        if (this.removeIt) return;

        // Handle movement
        if (this.moving && !this.immobile) {
            this.moveShip();
        }

        // Handle component recharges and cooldowns
        this.updateComponents(delta);

        // Handle AI or Player control updates
        if (this.shipAi) {
            this.shipAi.update();
        }

        // Check bounds / collisions
        this.checkCollision();
    }

    updateComponents(delta?: number): void {
        for (const component of this.components) component.update(delta);
    }

    regenerateEnergy(delta: number): void {
        this.currentEnergy = Math.min(
            this.maxEnergy,
            this.currentEnergy + this.regenEnergy * delta / 1000
        );
    }

    moveShip() {
        // Apply velocity vector based on moveX, moveY
        this.x += this.moveX * this.game.deltaTime;
        this.y += this.moveY * this.game.deltaTime;

        // Check waypoint completion
        if (this.waypoints.length > 0) {
            const target = this.waypoints[0];
            const dx = target[0] - this.x;
            const dy = target[1] - this.y;
            const distSq = dx * dx + dy * dy;

            if (distSq < 400) { // Within 20 pixels
                this.waypoints.shift();
                if (this.waypoints.length === 0) {
                    this.moving = false;
                } else {
                    this.initMove(this.waypoints[0][0], this.waypoints[0][1]);
                }
            }
        }
    }

    initMove(targetX: number, targetY: number) {
        this.moveToX = targetX;
        this.moveToY = targetY;
        this.moving = true;

        const dx = targetX - this.x;
        const dy = targetY - this.y;
        const angle = Math.atan2(dy, dx);

        const speed = this.maxSpeed;
        this.moveX = Math.cos(angle) * speed;
        this.moveY = Math.sin(angle) * speed;
        this.targetRotation = angle * (180 / Math.PI);
    }

    checkCollision() {
        if (this.pacified || !this.moving) return;

        // Ground drones retain their collision behavior in the shared ship queue.
        for (const tank of this.game.shipQueue) {
            if (tank.superType !== "GroundDrone" || tank === this || tank.removeIt || tank.pacified) continue;

            const dx = tank.x - this.x;
            const dy = tank.y - this.y;
            const distSq = dx * dx + dy * dy;
            const minDist = this.radius + tank.radius;

            if (distSq < minDist * minDist) {
                this.immobile = true;
                return;
            }
        }
        this.immobile = false;
    }

    activateSkills(skillType: string | null = null) {
        if (!skillType) {
            for (const comp of this.compSkill) {
                if (comp.ready) comp.activate();
            }
            for (const comp of this.compSpawn) {
                if (comp.ready) comp.activate();
            }
        } else {
            for (const comp of this.compSkill) {
                if (comp.ready && (comp.subType === skillType || comp.type === skillType)) {
                    comp.activate();
                }
            }
        }
    }

    takeDamage(damage: number, _damageType: string = "normal") {
        if (this.invulnerable) return;

        if (this.currentShell > 0) {
            this.currentShell -= damage;
            if (this.currentShell < 0) {
                const overflow = -this.currentShell;
                this.currentShell = 0;
                this.currentHull -= overflow;
            }
        } else {
            this.currentHull -= damage;
        }

        if (this.currentHull <= 0 && !this.exploding) {
            this.explode();
        }
    }

    explode() {
        this.exploding = true;
        this.removeIt = true;

        // Create explosion effect
        this.game.createExplosion(this.x, this.y);
        this.game.playSound("Explosion");

        // Award credits & drop loot if enemy destroyed by player
        if (this.game.factionManager.isEnemyOfFaction(this, YUTIARINALIA)) {
            this.game.credits += Math.round(this.value * 0.001);
            this.game.uiManager?.updateCredits();

            // Drop power-up chance
            if (Math.random() < 0.25) {
                this.game.spawnPowerUp("Multi", this.x, this.y);
            }
        }

        // Drop parts / cleanup
        if (this.tractor) {
            this.tractor.removeIt = true;
        }
    }

    resetIt() {
        for (const component of this.components) component.reset();
        this.removeIt = false;
        this.exploding = false;
        this.currentHull = this.maxHull;
        this.currentShell = this.maxShell;
        this.currentEnergy = this.maxEnergy;
        this.moving = false;
        this.immobile = false;
        this.parts.length = 0;
        this.components.length = 0;
        this.compWeapon.length = 0;
        this.compSkill.length = 0;
        this.compSpawn.length = 0;
        this.compPassive.length = 0;
        this.waypoints.length = 0;
        this._hullMods.clear();
        this.baseStats = null;
        this.hullDefinition = null;
    }
}