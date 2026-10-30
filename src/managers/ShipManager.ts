import { Game } from '../core/Game';
import { Ship } from '../entities/Ship';
import { ShipBlueprint, ShipBlueprintDefinition } from './ShipBlueprint';
import { FactionId } from './FactionManager';

/**
 * ShipManager - ship catalogue + centralized ship creation/disposal.
 *
 * Scope (deliberately narrow):
 *  - Blueprint catalogue: stable ids map to source keys and may own structured
 *    ship definitions. Legacy Game.shipData definitions remain indexed too.
 *  - createShip(): the single creation path used by every spawn entry point.
 *    It owns pool acquire, position, stable-ID registration, waypoint/task
 *    assignment, managed-queue insertion, and optional spawn effect.
 *  - disposeShip(): safe disposal helper that removes the ship from the
 *    managed queue, unregisters it, and returns it to the ObjectPool.
 *
 * It does NOT own the ship update queue or the per-frame update loop - those
 * remain Game's responsibility, as do movement, weapons,
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
     * Remove every blueprint whose id starts with the given prefix (including
     * any that were indexed by syncFromGame under the same namespace). Returns
     * the number of blueprints removed. Used by test/debug tooling that must be
     * able to undo its catalogue registrations.
     */
    removeBlueprintsByPrefix(prefix: string): number {
        let removed = 0;
        for (const [id, blueprint] of Array.from(this.blueprints.entries())) {
            if (!id.startsWith(prefix)) continue;
            this.blueprints.delete(id);
            if (this.bySourceKey.get(blueprint.sourceKey) === blueprint) {
                this.bySourceKey.delete(blueprint.sourceKey);
            }
            removed++;
        }
        return removed;
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
     *  - faction: registered faction assigned to the ship.
     */
    createShip(
        type: string,
        faction: FactionId,
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
        const factionManager = this.game.factionManager;
        if (!factionManager) {
            throw new Error('FactionManager is not initialized on Game.');
        }

        if (!factionManager.isFactionRegistered(faction)) {
            throw new Error(`Faction "${faction}" is not registered.`);
        }

        const pool = this.game.objectPool;
        if (!pool) return null;

        const ship = pool.getShipObject(type);
        if (!ship) return null;

        let spawnEffect: ReturnType<typeof pool.getEffect> = null;
        try {
            factionManager.setFaction(ship, faction);

            // getShipObject() already initialized the ship. Position it, applying
            // the same per-ship random jitter the spawn queue used to apply inline.
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

            this.game.shipQueue.push(ship);

            if (options.spawnEffect) {
                spawnEffect = pool.getEffect('Spawn');
                if (spawnEffect) {
                    spawnEffect.init('Spawn', ship.x, ship.y);
                    this.game.effectsQueue.push(spawnEffect);
                }
            }
        } catch (error) {
            for (let index = this.game.shipQueue.length - 1; index >= 0; index--) {
                if (this.game.shipQueue[index] === ship) this.game.shipQueue.splice(index, 1);
            }
            if (spawnEffect) {
                const effectIndex = this.game.effectsQueue.indexOf(spawnEffect);
                if (effectIndex !== -1) this.game.effectsQueue.splice(effectIndex, 1);
                pool.disposeEffect(spawnEffect);
            }
            this.game.entityManager?.unregister(ship);
            factionManager.clearFaction(ship);
            pool.disposeShipObject(ship);
            throw error;
        }

        return ship;
    }

    // ------------------------------------------------------------------
    // Disposal support
    // ------------------------------------------------------------------

    /**
     * Remove from the active collection, unregister, and return the ship to
     * the object pool. Also safe when the caller already removed it from the queue.
     */
    disposeShip(ship: Ship): void {
        if (!ship) return;
        for (let index = this.game.shipQueue.length - 1; index >= 0; index--) {
            if (this.game.shipQueue[index] === ship) this.game.shipQueue.splice(index, 1);
        }
        this.game.entityManager?.unregister(ship);
        this.game.factionManager.clearFaction(ship);
        const pool = this.game.objectPool;
        if (pool) pool.disposeShipObject(ship);
    }
}