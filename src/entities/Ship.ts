import { Game } from '../core/Game';
import { Component } from './Component';
import { TractorEffect } from '../effects/TractorEffect';
import { ShipBlueprintDefinition, ShipBlueprintPart } from '../managers/ShipBlueprint';
import { YUTIARINALIA } from '../managers/FactionManager';

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

    init(type: string) {
        this.type = type;
        this.regenEnergy = 20;
        this.removeIt = false;
        this.exploding = false;

        const blueprint = this.game.shipManager?.getBlueprintForSourceKey(this.type)?.shipDefinition;
        const legacyShipDef = blueprint ? undefined : this.game.shipData[this.type];
        if (blueprint || legacyShipDef) {
            let partsData: ShipBlueprintPart[];
            const componentsByPart = new Map<number, string[]>();

            if (blueprint) {
                this.applyBlueprint(blueprint);
                partsData = blueprint.gameplay.parts;
                for (const attachment of blueprint.gameplay.components) {
                    const components = componentsByPart.get(attachment.partIndex) ?? [];
                    components.push(attachment.name);
                    componentsByPart.set(attachment.partIndex, components);
                }
            } else {
                const [legacyParts, compData, superType, subType, name, categoryType] = legacyShipDef;
                this.superType = superType;
                this.subType = subType;
                this.name = name;
                this.categoryType = categoryType;
                partsData = legacyParts.map((partInfo: any[]) => ({
                    name: partInfo[0],
                    x: partInfo[1],
                    y: partInfo[2],
                    rotation: partInfo[3],
                    isLoot: partInfo[4]
                }));
                this.maxHull = 0;
                this.maxShell = 0;
                this.weight = 0;
                this.value = 0;

                for (let partIndex = 0; partIndex < partsData.length; partIndex++) {
                    if (compData && compData[partIndex] && compData[partIndex] !== 'none') {
                        componentsByPart.set(partIndex, [compData[partIndex][0]]);
                    }
                }
            }

            if (this.superType === "Station" || this.superType === "Turret") {
                this.immobile = true;
            }

            for (let i = 0; i < partsData.length; i++) {
                const partInfo = partsData[i];
                const part = {
                    name: partInfo.name,
                    x: partInfo.x * 5,
                    y: partInfo.y * 5,
                    rotation: partInfo.rotation,
                    maxHull: partInfo.maxHull ?? 100
                };

                if (!blueprint) {
                    this.maxShell += part.maxHull * 0.5;
                    this.maxHull += part.maxHull * 0.25;
                    this.weight += 10;
                }
                this.parts.push(part);

                for (const compName of componentsByPart.get(i) ?? []) {
                    const comp = new Component();
                    comp.init(compName, this, part);
                    this.components.push(comp);

                    if (comp.type === "Weapon") this.compWeapon.push(comp);
                    else if (comp.type === "Skill") this.compSkill.push(comp);
                    else if (comp.type === "Spawn") this.compSpawn.push(comp);
                    else if (comp.type === "Passive") this.compPassive.push(comp);
                }
            }

            this.currentShell = this.maxShell;
            this.currentHull = this.maxHull;
            this.currentEnergy = this.maxEnergy;
        }

        // Setup Tractor for utility ships
        if (this.subType === "Player" || this.subType === "Harvester" || this.subType === "Worker") {
            this.tractor = new TractorEffect();
            this.tractor.ship = this;
            this.tractor.init();
        }
    }

    private applyBlueprint(blueprint: ShipBlueprintDefinition): void {
        this.superType = blueprint.superType;
        this.subType = blueprint.subType;
        this.name = blueprint.name;
        this.categoryType = blueprint.categoryType;
        this.maxHull = blueprint.stats.maxHull;
        this.maxShell = blueprint.stats.maxShell;
        this.regenShell = blueprint.stats.regenShell;
        this.maxEnergy = blueprint.stats.maxEnergy;
        this.regenEnergy = blueprint.stats.regenEnergy ?? 20;
        this.maxSpeed = blueprint.stats.maxSpeed;
        this.acceleration = blueprint.stats.acceleration;
        this.weight = blueprint.stats.weight;
        this.radius = blueprint.stats.radius;
        this.value = blueprint.stats.value;
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