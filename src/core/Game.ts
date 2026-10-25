// Core Game Engine - Similar to ActionScript Game.as
import { Ship } from '../entities/Ship';
import { Camera } from '../utils/Camera';
import { ObjectPool } from './ObjectPool';
import { TaskManager } from '../tasks/TaskManager';
import { UIManager, MiniMap } from '../ui/UIManager';
import { SoundManager } from '../audio/SoundManager';
import { EntityManager } from '../managers/EntityManager';
import { ShipManager } from '../managers/ShipManager';
import { FactionId, FactionManager } from '../managers/FactionManager';

export class Game {
    // Core game state
    public static instance: Game;
    public deltaTime: number = 0;
    public renderStartTime: number = 0;
    public renderFinishTime: number = 0;

    // Queues (similar to ActionScript vectors)
    public shipQueue: Ship[] = [];
    public effectsQueue: any[] = []; // Effects (explosions, spawns)
    public queueResource: any[] = []; // Resource objects
    public pupQueue: any[] = []; // Power-ups
    public spawnQueue: any[] = []; // [type, count, faction, x, y, waypoints, shipData, taskBehavior]
    public respawnQueue: Ship[] = [];

    // Game data
    public shipData: any = {}; // Ship definitions
    public partData: any = {}; // Part definitions
    public componentData: any = {}; // Component definitions
    public shipPartsData: any[] = []; // Player ship parts
    public yardPartsData: any[] = []; // Enemy/AI parts
    public knownSectors: string[] = []; // Sector keys
    public tasks: any[] = [];
    public commander: any = null;

    // Game state
    public credits: number = 0;
    public score: number = 0;
    public power: number = 100; // Player power/energy
    public maxPower: number = 100;
    public homeSector: string = "";
    public lowFps: boolean = false;

    // Planets (for minimap display)
    public planets: Array<{x: number, y: number, radius: number}> = [];

    // References to managers/systems
    public ingame: any = null; // Will be Ingame scene
    public map: any = null; // MapBG
    public miniMap: MiniMap | null = null;
    public uiManager: UIManager | null = null;
    public taskManager: TaskManager | null = null;
    public soundManager: SoundManager | null = null;
    public camera: Camera | null = null;
    public objectPool: ObjectPool | null = null;
    public entityManager: EntityManager | null = null;
    public shipManager: ShipManager | null = null;
    public factionManager!: FactionManager;

    // Input state
    public keys: any = {
        up: false, down: false, left: false, right: false,
        shift: false, ctrl: false, space: false
    };

    // Sound channels (simplified)
    public soundOn: boolean = true;

    constructor() {
        Game.instance = this;
        this.initSystems();
    }

    initSystems() {
        this.objectPool = new ObjectPool();
        this.entityManager = new EntityManager();
        this.factionManager = new FactionManager();
        this.camera = new Camera();
        this.taskManager = new TaskManager();
        this.uiManager = new UIManager();
        this.soundManager = new SoundManager();
        this.shipManager = new ShipManager(this);

        // Load game data (ship/part/component definitions)
        this.loadGameData();
    }

    loadGameData() {
        // This would load JSON definitions for ships, parts, components
        // For now, placeholder - would be loaded from assets/data/
        console.log("Loading game data...");

        this.shipData = {};

        // Player weapon component definition
        // Format per Weapon.init(): [type, subType, damage, range, cooldown, energyCost, projectileSpeed, splashRadius]
        this.componentData = {
            "PlayerCannon": ["Weapon", "ProjectileArcade", 10, 400, 0.15, 5, 600, 0] // cooldown 0.15s = 150ms
        };

        this.shipManager?.registerBlueprint('ship.player', 'player', {
            superType: 'Ship',
            subType: 'Player',
            name: 'Player Ship',
            categoryType: 'Air',
            stats: {
                maxHull: 25,
                maxShell: 50,
                regenShell: 0,
                maxEnergy: 100,
                regenEnergy: 0,
                maxSpeed: 5,
                acceleration: 0.5,
                weight: 10,
                radius: 20,
                value: 0
            },
            gameplay: {
                parts: [
                    { name: 'central-hull', x: 0, y: 0, rotation: 0, isLoot: false }
                ],
                components: [
                    { partIndex: 0, name: 'PlayerCannon' }
                ]
            },
            visual: {
                sprites: [
                    { textureKey: 'human-dreadnought', x: 0, y: 0, scale: 0.18 },
                    { textureKey: 'ship-wing', x: -20, y: -25 },
                    { textureKey: 'ship-wing', x: -20, y: 25 },
                    { textureKey: 'hardpoint', x: 30, y: 0 },
                    { textureKey: 'hardpoint', x: -10, y: -20 },
                    { textureKey: 'hardpoint', x: -10, y: 20 }
                ]
            }
        });

        // Keep the catalogue populated for any remaining legacy ship definitions.
        this.shipManager?.syncFromGame();
    }

    // Main game update - called each frame
    update(time: number, delta: number) {
        this.renderStartTime = time || this.renderStartTime;
        this.deltaTime = Math.min(delta / (1000 / 33), 1); // Cap at 1 (like AS3)
        if (this.deltaTime > 1) {
            this.deltaTime = 1;
            this.lowFps = true;
        } else {
            this.lowFps = false;
        }
        this.renderFinishTime = time;

        // Update systems
        this.updateQueues();
        this.updateEffects();
        this.updateTasks();
        if (this.camera) this.camera.update();
        if (this.uiManager) this.uiManager.update();
        if (this.miniMap) this.miniMap.update();
        if (this.soundManager) this.soundManager.update();

        // Process spawn queue
        this.processSpawnQueue();

        // Process respawn queue
        this.processRespawnQueue();
    }

    updateQueues() {
        for (let i = this.shipQueue.length - 1; i >= 0; i--) {
            const ship = this.shipQueue[i];
            if (ship.removeIt) {
                this.shipManager?.disposeShip(ship);
            } else if (ship.active) {
                ship.update();
            }
        }
    }

    updateEffects() {
        for (let i = this.effectsQueue.length - 1; i >= 0; i--) {
            const effect = this.effectsQueue[i];
            if (effect.removeIt) {
                this.effectsQueue.splice(i, 1);
                if (this.objectPool) this.objectPool.disposeEffect(effect);
            } else if (effect.active) {
                effect.update();
            }
        }
    }

    updateTasks() {
        if (this.taskManager) this.taskManager.update();
    }

    processSpawnQueue() {
        // Spawn tuple: [type, count, faction, x, y, waypoints, shipData, taskBehavior].
        while (this.spawnQueue.length > 0) {
            const spawnData = this.spawnQueue[0];
            if (!spawnData) {
                this.spawnQueue.shift();
                continue;
            }

            const [type, count, faction, x, y, waypoints, , taskBehavior] = spawnData;
            if (!this.factionManager.isFactionRegistered(faction)) {
                throw new Error(`Faction "${faction}" is not registered.`);
            }
            this.spawnQueue.shift();

            for (let i = 0; i < count; i++) {
                this.shipManager?.createShip(type, faction, x, y, {
                    waypoints,
                    taskBehavior,
                    spawnEffect: true
                });
            }
        }
    }

    processRespawnQueue() {
        while (this.respawnQueue.length > 0) {
            const ship = this.respawnQueue.shift();
            if (ship) {
                this.shipManager?.disposeShip(ship);
            }
        }
    }

    // Sound playback (simplified)
    playSound(name: string) {
        if (!this.soundOn) return;
        if (this.soundManager) this.soundManager.playSound(name);
    }

    // Ship creation helpers
    spawnShip(
        type: string,
        faction: FactionId,
        x: number,
        y: number,
        waypoints: any[] = null
    ): Ship {
        return this.shipManager?.createShip(type, faction, x, y, {
            waypoints: waypoints ?? undefined,
            randomOffset: 0 // exact placement for direct spawnShip calls
        }) ?? null;
    }

    // Resource spawning
    spawnResource(type: string, x: number, y: number) {
        const resource = this.objectPool ? this.objectPool.getResource(type) : null;
        if (resource) {
            resource.x = x;
            resource.y = y;
            resource.init(type);
            this.queueResource.push(resource);
            return resource;
        }
        return null;
    }

    // Power-up spawning
    spawnPowerUp(type: string, x: number, y: number) {
        const powerUp = this.objectPool ? this.objectPool.getPowerUp(type) : null;
        if (powerUp) {
            powerUp.x = x;
            powerUp.y = y;
            powerUp.init(type);
            this.pupQueue.push(powerUp);
            return powerUp;
        }
        return null;
    }

    // Explosion effect
    createExplosion(x: number, y: number, type: string = "Explosion") {
        const effect = this.objectPool ? this.objectPool.getEffect(type) : null;
        if (effect) {
            effect.init(type, x, y);
            this.effectsQueue.push(effect);
            return effect;
        }
        return null;
    }

    // Sector jumping (level change)
    jumpToSector(sectorData: any) {
        // Clear current state
        this.clearCurrentSector();

        // Load new sector
        this.ingame.sector = sectorData;
        this.loadSector(sectorData);
    }

    clearCurrentSector() {
        // Clear all queues and objects
        this.shipQueue = [];
        this.effectsQueue = [];
        this.queueResource = [];
        this.pupQueue = [];
        this.spawnQueue = [];
        this.respawnQueue = [];

        // Clear entity registry
        if (this.entityManager) this.entityManager.clear();
        this.factionManager.clear();

        // Dispose all pooled objects
        if (this.objectPool) this.objectPool.clearAll();
    }

    loadSector(sectorData: any) {
        // Initialize sector based on data
        this.ingame.sector = sectorData;
        this.ingame.init(); // Similar to AS3 Ingame.init()

        // Set up camera bounds
        if (this.camera) this.camera.setBounds(
            sectorData.coordinates[0],
            sectorData.coordinates[1],
            sectorData.size[0],
            sectorData.size[1]
        );

        // Load background based on sector data
        if (this.map) {
            this.map.loadMapBg(sectorData.mapBg || "none");
            this.map.changeBgTint(sectorData.tint || 0x000000);
        }

        // Spawn initial ships from sector data
        this.processSectorShips(sectorData);
    }

    processSectorShips(sectorData: any) {
        // Process ships defined in sector
        if (sectorData.ships) {
            for (const shipDef of sectorData.ships) {
                const [type, count, faction, x, y, waypoints, task] = shipDef;
                this.spawnQueue.push([type, count, faction, x + sectorData.coordinates[0],
                                    y + sectorData.coordinates[1], waypoints, null, task]);
            }
        }
    }

    // Utility: check if point is in sector
    pointInSector(x: number, y: number): boolean {
        if (!this.ingame || !this.ingame.sector) return false;
        const sector = this.ingame.sector;
        return x >= sector.coordinates[0] &&
               x <= sector.coordinates[0] + sector.size[0] &&
               y >= sector.coordinates[1] &&
               y <= sector.coordinates[1] + sector.size[1];
    }

    // Find active managed ships in an area, optionally restricted to one faction.
    getShipsInArea(x: number, y: number, radius: number, faction?: FactionId): Ship[] {
        const ships: Ship[] = [];
        for (const ship of this.shipQueue) {
            if (!ship || ship.removeIt) continue;
            if (faction && this.factionManager.getFaction(ship) !== faction) continue;

            const dx = ship.x - x;
            const dy = ship.y - y;
            const distSq = dx * dx + dy * dy;

            if (distSq <= radius * radius) {
                ships.push(ship);
            }
        }

        return ships;
    }
}