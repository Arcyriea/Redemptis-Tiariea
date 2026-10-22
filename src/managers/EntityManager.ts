import { Entity } from '../entities/Entity';

/**
 * EntityManager - shared registry + lifecycle bookkeeping for game entities.
 *
 * Scope (deliberately narrow): register/unregister, stable ID lookup, membership
 * checks, and safe cleanup. It does NOT own movement, rendering, weapons, combat,
 * faction logic, collision rules, AI, or navigation - those belong to the
 * specialized managers (ShipManager, FighterManager, ...) and to the entity
 * classes themselves.
 *
 * Design notes:
 *  - This is a registry, not a container. It tracks references; it never creates
 *    entities and never destroys them. The Game loop and ObjectPool own creation
 *    and disposal. EntityManager only adds/removes the bookkeeping entries.
 *  - It is intentionally orthogonal to the existing queue arrays
 *    (queueAlly, queueEnemy, ...). Those arrays are the iteration backbone for
 *    the update loop; this manager is the lookup backbone for code that needs to
 *    find a specific entity by ID. Both are kept in sync by Game.
 *  - IDs are stable for the lifetime of an entity and are never reused, so a
 *    stale ID can never resolve to a different entity after a respawn.
 */
export class EntityManager {
    private entities: Map<string, Entity> = new Map();
    private registered: WeakSet<Entity> = new WeakSet();
    private counters: Map<string, number> = new Map();

    /** Total number of entities currently tracked. */
    get size(): number {
        return this.entities.size;
    }

    /**
     * Register an entity and assign it a stable unique ID if it does not already
     * have one. Re-registering an already-registered entity is a no-op.
     *
     * Handles three cases:
     * 1. Already registered (same object) -> idempotent return
     * 2. Dirty/conflicting ID (pooled reuse or collision) -> generate fresh ID
     * 3. No ID -> generate new ID
     * Never overwrites a different entity already mapped to the same ID.
     */
    register(entity: Entity, prefix: string = 'ent'): Entity {
        if (!entity) return entity;

        // Case 1: Already registered under this id -> idempotent
        if (entity.id && this.entities.get(entity.id) === entity) {
            return entity;
        }

        // Case 2 & 3: Dirty ID (pooled reuse) or ID collision with different entity
        // If entity has an id but it's not in our registry, or it points to a different
        // entity, treat it as a fresh registration and generate a new unique id.
        if (entity.id && (!this.entities.has(entity.id) || this.entities.get(entity.id) !== entity)) {
            entity.id = undefined;
        }

        // Case 4: No id (first time or just cleared) -> generate new unique id
        if (!entity.id) {
            entity.id = this.generateId(prefix);
        }

        this.entities.set(entity.id, entity);
        this.registered.add(entity);
        return entity;
    }

    /**
     * Unregister an entity by reference. Safe to call on an unregistered entity.
     */
    unregister(entity: Entity): void {
        if (!entity || !entity.id) return;
        this.entities.delete(entity.id);
        this.registered.delete(entity);
    }

    /** Unregister an entity by its stable ID. */
    unregisterById(id: string): void {
        if (!id) return;
        const entity = this.entities.get(id);
        this.entities.delete(id);
        if (entity) this.registered.delete(entity);
    }

    /** Look up a registered entity by its stable ID. */
    get(id: string): Entity | undefined {
        return this.entities.get(id);
    }

    /** Check membership by reference. */
    has(entity: Entity): boolean {
        return !!entity && this.registered.has(entity);
    }

    /** Check membership by stable ID. */
    hasId(id: string): boolean {
        return this.entities.has(id);
    }

    /** Number of tracked entities. */
    count(): number {
        return this.entities.size;
    }

    /** Iterate over every tracked entity. */
    forEach(callback: (entity: Entity) => void): void {
        for (const entity of this.entities.values()) {
            callback(entity);
        }
    }

    /** Snapshot of all currently tracked entities. */
    getAll(): Entity[] {
        return Array.from(this.entities.values());
    }

    /**
     * Drop every entity that has been marked `removeIt` from the registry.
     *
     * Actual destruction/disposal of the underlying object (Phaser sprite cleanup,
     * return-to-pool, etc.) is the Game loop's responsibility; this method only
     * removes the registry bookkeeping so the entity can no longer be looked up.
     */
    cleanup(): number {
        let removed = 0;
        for (const [id, entity] of this.entities) {
            if (entity && entity.removeIt) {
                this.entities.delete(id);
                this.registered.delete(entity);
                removed++;
            }
        }
        return removed;
    }

    /** Remove all tracked entities. Called on sector transitions. */
    clear(): void {
        this.entities.clear();
        this.registered = new WeakSet();
        this.counters.clear();
    }

    private generateId(prefix: string): string {
        let next = (this.counters.get(prefix) || 0) + 1;
        while (this.entities.has(`${prefix}-${next}`)) {
            next++;
        }
        this.counters.set(prefix, next);
        return `${prefix}-${next}`;
    }
}