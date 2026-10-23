import { Game } from '../core/Game';
import { Ship } from '../entities/Ship';
import { ShipBlueprint, ShipBlueprintDefinition } from './ShipBlueprint';

/**
 * ShipManager - ship catalogue + centralized ship creation/disposal.
 *
 * Scope (deliberately narrow):
 *  - Blueprint catalogue: stable ids map to source keys and may own structured
 *    ship definitions. Legacy Game.shipData definitions remain indexed too.
 *  - createShip(): the single creation path used by every spawn entry point.
 *    It owns pool acquire, position, stable-ID registration, waypoint/task
 *    assignment, queue selection, and optional spawn effect.
 *  - disposeShip(): safe disposal helper that unregisters from EntityManager
 *    and returns the ship to the ObjectPool. It must only be called after the
 *    ship has already been removed from its update queue.
 *
 * It does NOT own the update queues (queueAlly, queueEnemy, ...) or the per-frame
 * update loop - those remain Game's responsibility, as do movement, weapons,
 * combat, and AI.
 */
export class ShipManager {
    private readonly game: Game;
    private readonly blueprints: Map<string, ShipBlueprint> = new Map();
    private readonly bySourceKey: Map<string, ShipBlueprint> = new Map();

    constructor(game: Game) {
        this.game = game;
    }

    // ------------------------------------------------------------------
    // Blueprint catalogue
    // ------------------------------------------------------------------

    /**
     * Register a blueprint. Accepts either an id + sourceKey pair or an
     * existing ShipBlueprint instance. Returns the registered blueprint.
     */
    registerBlueprint(id: string, sourceKey: string, definition?: ShipBlueprintDefinition): ShipBlueprint;
    registerBlueprint(blueprint: ShipBlueprint): ShipBlueprint;
    registerBlueprint(
        blueprintOrId: string | ShipBlueprint,
        sourceKey?: string,
        definition?: ShipBlueprintDefinition
    ): ShipBlueprint {
        let blueprint: ShipBlueprint;
        if (typeof blueprintOrId === 'string') {
            if (sourceKey === undefined) {
                throw new Error('A source key is required to register a ship blueprint.');
            }
            blueprint = new ShipBlueprint(blueprintOrId, sourceKey, definition);
        } else {
            blueprint = blueprintOrId;
        }
        this.blueprints.set(blueprint.id, blueprint);
        this.bySourceKey.set(blueprint.sourceKey, blueprint);
        return blueprint;
    }

    getBlueprint(id: string): ShipBlueprint | undefined {
        return this.blueprints.get(id);
    }

    hasBlueprint(id: string): boolean {
        return this.blueprints.has(id);
    }

    /** Look up the blueprint whose sourceKey matches a Game.shipData key. */
    getBlueprintForSourceKey(sourceKey: string): ShipBlueprint | undefined {
        return this.bySourceKey.get(sourceKey);
    }

    /**
     * Rebuild the catalogue from every key currently present in Game.shipData.
     * Safe to call repeatedly: keys already indexed are left untouched, so any
     * manually registered blueprints are preserved. Returns the number of new
     * blueprints added. Called after ship data has loaded so the catalogue is
     * never populated with invented definitions.
     */
    syncFromGame(): number {
        const shipData = this.game.shipData;
        if (!shipData) return 0;

        let added = 0;
        for (const key of Object.keys(shipData)) {
            if (this.bySourceKey.has(key)) continue;
            const blueprint = new ShipBlueprint(`ship.${key}`, key);
            this.blueprints.set(blueprint.id, blueprint);
            this.bySourceKey.set(key, blueprint);
            added++;
        }
        return added;
    }

    // ------------------------------------------------------------------
    // Ship creation (centralized)
    // ------------------------------------------------------------------

    /**
     * Acquire, position, register, and enqueue a ship in one call.
     *
     * ObjectPool.getShipObject() already calls Ship.init() internally, so this
     * method deliberately does NOT init a second time. The ship is registered
     * exactly once per logical lifetime; EntityManager handles the pooled-reuse
     * case by issuing a fresh id.
     *
     * Options:
     *  - waypoints: base-relative waypoint list (each wp offset by x,y).
     *  - taskBehavior: AI/behavior key attached to the ship.
     *  - spawnEffect: when true, emit a Spawn effect at the ship's position.
     */
    createShip(
        type: string,
        alignment: string,
        x: number,
        y: number,
        options: {
            waypoints?: any[];
            taskBehavior?: any;
            spawnEffect?: boolean;
            /**
             * Half-width of the random spawn jitter, in pixels. When > 0 each
             * ship is offset by (rand-0.5)*randomOffset on both axes, matching
             * the existing per-ship spawn jitter. Set to 0 for exact placement.
             */
            randomOffset?: number;
        } = {}
    ): Ship | null {
        const pool = this.game.objectPool;
        if (!pool) return null;

        const ship = pool.getShipObject(type, alignment);
        if (!ship) return null;

        // getShipObject() already initialized the ship. Position it, applying the
        // same per-ship random jitter the spawn queue used to apply inline.
        const jitter = options.randomOffset ?? 20;
        ship.x = x + (Math.random() - 0.5) * jitter;
        ship.y = y + (Math.random() - 0.5) * jitter;

        // Stable-ID registration exactly once per logical lifetime.
        // EntityManager detects pooled reuse and issues a fresh id.
        this.game.entityManager?.register(ship, 'ship');

        if (options.waypoints) {
            ship.waypoints = options.waypoints.map((wp: any) => [wp[0] + x, wp[1] + y]);
        }
        if (options.taskBehavior) {
            ship.taskBehavior = options.taskBehavior;
        }

        // Preserve existing queue-selection behavior: Ally/Enemy only.
        if (alignment === 'Ally') {
            this.game.queueAlly.push(ship);
        } else if (alignment === 'Enemy') {
            this.game.queueEnemy.push(ship);
        }

        if (options.spawnEffect) {
            const spawnEffect = pool.getEffect('Spawn');
            if (spawnEffect) {
                spawnEffect.init('Spawn', ship.x, ship.y);
                this.game.effectsQueue.push(spawnEffect);
            }
        }

        return ship;
    }

    // ------------------------------------------------------------------
    // Disposal support
    // ------------------------------------------------------------------

    /**
     * Safe disposal: unregister from the entity registry and return the ship
     * to the object pool. Callers must have already removed the ship from its
     * update queue; this method does not touch queues.
     */
    disposeShip(ship: Ship): void {
        if (!ship) return;
        this.game.entityManager?.unregister(ship);
        const pool = this.game.objectPool;
        if (pool) pool.disposeShipObject(ship);
    }
}