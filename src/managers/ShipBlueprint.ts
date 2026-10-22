import { Game } from '../core/Game';

/**
 * ShipBlueprint - a stable, named reference to a ship definition.
 *
 * v1 scope (deliberately narrow): this is a thin wrapper around the existing
 * `Game.shipData` table. It does NOT copy or approximate ship statistics - it
 * holds a stable blueprint id plus a source key and resolves the actual
 * definition lazily from Game at build time. That keeps the catalogue safe to
 * populate before or after shipData loads, and it can never go stale because it
 * always reads the live table that Ship.init() already reads.
 *
 * It is intentionally not a data class: it carries no part/component lists of
 * its own. Ship.init() continues to read `Game.shipData[type]` directly, which
 * preserves the existing construction pipeline (Component, Weapon, Ability,
 * ObjectPool) untouched.
 */
export class ShipBlueprint {
    /** Stable, human-readable blueprint id (e.g. "ship.player-freighter"). */
    public readonly id: string;

    /** Key into Game.shipData that this blueprint maps to. */
    public readonly sourceKey: string;

    constructor(id: string, sourceKey: string) {
        this.id = id;
        this.sourceKey = sourceKey;
    }

    /**
     * Resolve the underlying ship definition from the live Game.shipData table.
     * Returns undefined when the source key has not been loaded yet.
     */
    get definition(): any {
        const data = Game.instance?.shipData;
        return data ? data[this.sourceKey] : undefined;
    }

    /** True when Game.shipData currently contains this blueprint's source key. */
    get isLoaded(): boolean {
        return !!this.definition;
    }
}