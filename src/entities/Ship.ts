import { Game } from '../core/Game';
import { Component } from './Component';
import { TractorEffect } from '../effects/TractorEffect';
import { YUTIARINALIA } from '../managers/FactionManager';
import type {
    ComponentDefinition,
    HullDefinition,
    LegacyShipDefinition,
    ShipBlueprintDefinition as CanonicalShipBlueprintDefinition
} from '../types/Shipmaker';
import type { ShipBlueprintDefinition as LegacyStructuredShipBlueprint } from '../managers/ShipBlueprint';

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
        this.type = type;
        this.regenEnergy = 20;
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

    update() {
        if (this.removeIt) return;

        // Handle movement
        if (this.moving && !this.immobile) {
            this.moveShip();
        }

        // Handle component recharges and cooldowns
        for (const comp of this.components) {
            comp.update();
        }

        // Handle AI or Player control updates
        if (this.shipAi) {
            this.shipAi.update();
        }

        // Check bounds / collisions
        this.checkCollision();
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
    }
}