import { Game } from '../../core/Game';
import { Ship } from '../../entities/Ship';
import type { ShipBlueprintDefinition } from '../ShipBlueprint';
import {
    FactionId,
    factionPrincipal,
    FREE_INNOMINI,
    groupPrincipal,
    YUTIARINALIA
} from '../FactionManager';

/**
 * TestAllyManager - test-only helper that puts friendly ships into the world.
 *
 * Scope (deliberately narrow):
 *  - Registers one blueprint per ally hull and one dedicated diplomatic group
 *    for testing, then spawns allies through ShipManager so they share the
 *    production lifecycle (pool acquire, faction assignment, stable-ID
 *    registration, shipQueue insertion, optional spawn effect).
 *  - Ships are created in the player's own faction by default, which already
 *    resolves as 'Ally' (same-faction rule). Passing `faction` places them in
 *    an independent test faction instead; that faction is made a formal ally of
 *    the player faction with an Alliance agreement, so relationship-driven code
 *    paths (minimap colors, Ability ally-targeting) can be exercised too.
 *
 * This manager owns no update loop, movement, combat, or AI: allies are inert
 * targets unless a caller gives them waypoints/taskBehavior, exactly like any
 * other ship spawned through ShipManager.createShip().
 */

/** Diplomatic group the independently-factioned ally factions join. */
export const TEST_ALLY_GROUP = 'Test Allies';

/** Default faction used when spawning allies outside the player faction. */
export const TEST_ALLY_FACTION: FactionId = FREE_INNOMINI;

const ALLY_BLUEPRINT_PREFIX = 'ship.test-ally.';

type TestAllyKind = 'frigate' | 'corvette' | 'cruiser';

/**
 * Ally hull definitions. Visuals reuse textures loaded by BootScene; stats are
 * deliberately modest because these ships exist to absorb fire and act as
 * targets for ally-aware systems, not to fight.
 */
const ALLY_DEFINITIONS: Record<TestAllyKind, ShipBlueprintDefinition> = {
    frigate: {
        superType: 'Ship',
        subType: 'Fighter',
        name: 'Test Ally Frigate',
        categoryType: 'Air',
        stats: {
            maxHull: 60,
            maxShell: 40,
            regenShell: 1,
            maxEnergy: 100,
            regenEnergy: 20,
            maxSpeed: 3,
            acceleration: 0.3,
            weight: 12,
            radius: 22,
            value: 50
        },
        gameplay: {
            parts: [{ name: 'central-hull', x: 0, y: 0, rotation: 0, isLoot: false }],
            components: []
        },
        visual: {
            sprites: [
                { textureKey: 'human-frigate', x: 0, y: 0, scale: 0.18 },
                { textureKey: 'ship-wing', x: -18, y: -20 },
                { textureKey: 'ship-wing', x: -18, y: 20 }
            ]
        }
    },
    corvette: {
        superType: 'Ship',
        subType: 'Fighter',
        name: 'Test Ally Corvette',
        categoryType: 'Air',
        stats: {
            maxHull: 35,
            maxShell: 20,
            regenShell: 1,
            maxEnergy: 80,
            regenEnergy: 20,
            maxSpeed: 4.5,
            acceleration: 0.4,
            weight: 7,
            radius: 16,
            value: 30
        },
        gameplay: {
            parts: [{ name: 'central-hull', x: 0, y: 0, rotation: 0, isLoot: false }],
            components: []
        },
        visual: {
            sprites: [
                { textureKey: 'curved-corvette', x: 0, y: 0, scale: 0.16 },
                { textureKey: 'hardpoint', x: 20, y: 0 }
            ]
        }
    },
    cruiser: {
        superType: 'Ship',
        subType: 'Commander',
        name: 'Test Ally Cruiser',
        categoryType: 'Air',
        stats: {
            maxHull: 150,
            maxShell: 90,
            regenShell: 2,
            maxEnergy: 150,
            regenEnergy: 20,
            maxSpeed: 2,
            acceleration: 0.2,
            weight: 30,
            radius: 32,
            value: 120
        },
        gameplay: {
            parts: [
                { name: 'central-hull', x: 0, y: 0, rotation: 0, isLoot: false },
                { name: 'side-hull', x: 10, y: 0, rotation: 0, isLoot: false }
            ],
            components: []
        },
        visual: {
            sprites: [
                { textureKey: 'faceted-cruiser', x: 0, y: 0, scale: 0.2 },
                { textureKey: 'ship-wing', x: -25, y: -30 },
                { textureKey: 'ship-wing', x: -25, y: 30 },
                { textureKey: 'hardpoint', x: 35, y: 0 }
            ]
        }
    }
};

export interface SpawnAlliesOptions {
    /** Hull kind to spawn. Defaults to 'frigate'. */
    kind?: TestAllyKind;
    /** Number of ships to create. Defaults to 1. */
    count?: number;
    /**
     * Faction for the new ships. Omit (or pass the player faction) to spawn
     * them inside the player's own faction. Any other registered faction is
     * added to the test ally diplomatic group and formally allied with the
     * player faction before the first ship is created.
     */
    faction?: FactionId;
    /** World coordinates. Defaults to the player ship position + (80, 0). */
    x?: number;
    y?: number;
    /** Half-width random placement jitter in pixels. Defaults to 40. */
    randomOffset?: number;
    /** Emit the Spawn effect at each ship position. Defaults to true. */
    spawnEffect?: boolean;
    /** Base-relative waypoints, forwarded to ShipManager.createShip(). */
    waypoints?: any[];
    /** AI/behavior key, forwarded to ShipManager.createShip(). */
    taskBehavior?: any;
}

export class TestAllyManager {
    private readonly game: Game;
    private readonly spawnedShips: Ship[] = [];
    private blueprintsRegistered = false;
    private diplomacyReady = false;
    /** Factions explicitly turned into allies via an Alliance agreement. */
    private readonly alliedFactions = new Set<FactionId>();

    constructor(game: Game) {
        this.game = game;
    }

    /**
     * Spawn friendly ships for testing. Returns the ships actually created
     * (empty when the object pool or ship manager is unavailable).
     */
    spawnAllies(options: SpawnAlliesOptions = {}): Ship[] {
        const kind = options.kind ?? 'frigate';
        const count = Math.max(0, Math.floor(options.count ?? 1));
        if (count === 0) return [];

        this.ensureBlueprints();

        const factionManager = this.game.factionManager;
        const faction = options.faction ?? YUTIARINALIA;
        if (!factionManager.isFactionRegistered(faction)) {
            throw new Error(`Faction "${faction}" is not registered.`);
        }
        if (faction !== YUTIARINALIA) {
            this.ensureAlliedWithPlayer(faction);
        }

        const origin = this.getDefaultOrigin();
        const x = options.x ?? origin.x;
        const y = options.y ?? origin.y;

        const created: Ship[] = [];
        for (let i = 0; i < count; i++) {
            const ship = this.game.shipManager?.createShip(this.getSourceKey(kind), faction, x, y, {
                spawnEffect: options.spawnEffect ?? true,
                randomOffset: options.randomOffset ?? 40,
                waypoints: options.waypoints,
                taskBehavior: options.taskBehavior
            });
            if (ship) {
                created.push(ship);
                this.spawnedShips.push(ship);
            }
        }
        return created;
    }

    /** Convenience: spawn `count` allies of the given kind around the player. */
    spawnAllySquad(kind: TestAllyKind, count = 1, options: SpawnAlliesOptions = {}): Ship[] {
        return this.spawnAllies({ ...options, kind, count });
    }

    /** Ships created by this manager that are still active in the world. */
    getActiveAllies(): Ship[] {
        return this.spawnedShips.filter((ship) => ship.active && !ship.removeIt);
    }

    /** Remove every ship this manager spawned (and forget them). */
    despawnAllies(): void {
        for (const ship of this.spawnedShips) {
            if (ship.active && !ship.removeIt) {
                ship.removeIt = true;
                this.game.shipManager?.disposeShip(ship);
            }
        }
        this.spawnedShips.length = 0;
    }

    /**
     * Undo everything this manager added to the global state: despawns its
     * ships, revokes the Alliance agreements it created, removes its factions
     * from the test ally group, and drops its blueprints from the catalogue.
     * The player faction itself is never touched.
     */
    reset(): void {
        this.despawnAllies();

        const factionManager = this.game.factionManager;
        for (const faction of this.alliedFactions) {
            factionManager.revokeAgreement(this.agreementId(faction));
            if (factionManager.getFactionGroup(faction) === TEST_ALLY_GROUP) {
                factionManager.setFactionGroup(faction, null);
            }
        }
        this.alliedFactions.clear();

        if (factionManager.isGroupRegistered(TEST_ALLY_GROUP)) {
            factionManager.removeGroup(TEST_ALLY_GROUP);
        }

        this.game.shipManager?.removeBlueprintsByPrefix(ALLY_BLUEPRINT_PREFIX);
        this.blueprintsRegistered = false;
        this.diplomacyReady = false;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private getSourceKey(kind: TestAllyKind): string {
        return `test-ally-${kind}`;
    }

    private ensureBlueprints(): void {
        if (this.blueprintsRegistered) return;
        const shipManager = this.game.shipManager;
        if (!shipManager) return;
        for (const kind of Object.keys(ALLY_DEFINITIONS) as TestAllyKind[]) {
            const sourceKey = this.getSourceKey(kind);
            if (!shipManager.hasBlueprint(`${ALLY_BLUEPRINT_PREFIX}${kind}`)) {
                shipManager.registerBlueprint(
                    `${ALLY_BLUEPRINT_PREFIX}${kind}`,
                    sourceKey,
                    ALLY_DEFINITIONS[kind]
                );
            }
        }
        this.blueprintsRegistered = true;
    }

    /** Register the test ally group + alliance once; later calls only extend it. */
    private ensureAlliedWithPlayer(faction: FactionId): void {
        const factionManager = this.game.factionManager;
        if (faction === YUTIARINALIA || factionManager.isFactionAlly(faction, YUTIARINALIA)) {
            return;
        }

        if (!this.diplomacyReady) {
            factionManager.registerGroup(TEST_ALLY_GROUP);
            this.diplomacyReady = true;
        }

        if (factionManager.getFactionGroup(faction) === undefined) {
            factionManager.setFactionGroup(faction, TEST_ALLY_GROUP);
        }

        const id = this.agreementId(faction);
        if (!factionManager.hasAgreement(id)) {
            factionManager.registerAgreement({
                id,
                type: 'Alliance',
                participants: [groupPrincipal(TEST_ALLY_GROUP), factionPrincipal(YUTIARINALIA)]
            });
        }
        this.alliedFactions.add(faction);
    }

    private agreementId(faction: FactionId): string {
        return `test-ally-alliance-${faction}`;
    }

    /** Default spawn point: just off the player ship, else screen center-ish. */
    private getDefaultOrigin(): { x: number; y: number } {
        const ingame = this.game.ingame;
        const playerShip = ingame?.playerShip;
        if (playerShip && !playerShip.removeIt) {
            return { x: playerShip.x + 80, y: playerShip.y };
        }
        return { x: 520, y: 300 };
    }
}
