/**
 * Entity - shared structural contract for game objects that the EntityManager
 * tracks by stable ID.
 *
 * This is deliberately a structural interface, NOT a base class. The existing
 * entity classes (Ship, Effect, PowerUp, Resource, ...) already satisfy it by
 * accident: they expose `active` / `removeIt` and an `update()` method. Forcing
 * them to extend a base class would add an inheritance layer with no benefit,
 * so we only require the fields we actually need to look up and clean up.
 *
 * An entity is any game object that participates in the game loop and may be
 * added/removed at runtime. It is NOT necessarily a Phaser.GameObject - the
 * Ship class, for example, is a plain data class that may or may not carry a
 * Phaser sprite reference.
 */
export interface Entity {
    /** Stable unique ID assigned by EntityManager (e.g. "ship-3"). */
    id?: string;

    /** True while the entity is alive and should be updated. */
    active: boolean;

    /** Set true to mark the entity for removal at the next cleanup pass. */
    removeIt: boolean;

    /** Per-frame update hook. Optional: entities without one are simply skipped. */
    update?(delta?: number): void;
}