# Shipmaker Architecture Handoff

## Purpose and Status

This document is a self-contained architectural handoff for a future developer-only Shipmaker editor at `/shipmaker`. It records the current repository state, separates verified behavior from proposed architecture, and defines the compatibility work that must be reviewed before implementation.

**This is a proposal, not an implementation authorization.** The HullDefinition, ComponentDefinition, ShipLoadout design is specified in `src/types/Shipmaker.ts`, but prerequisite refactoring has not been fully implemented. Shipmaker editor UI, player loadout UI, and the Lua parser/serializer have not been implemented. Any agent must receive explicit approval for prerequisite code changes and separate approval at each implementation phase.

## Inspected Repository Snapshot

| Item | Inspected value |
|---|---|
| Repository | `Arcyriea/Redemptis-Tiariea` |
| Date inspected | 2026-11-13 |
| Branch | `main` |
| Main HEAD inspected before this documentation update | `1c8dd23` |
| Audit baseline | `74c6821` (Documenting future development direction about involving lua files for weapons and modules stat definitions....) |
| Commits between baseline and inspected HEAD | Documentation-only changes (`c20165a`, `d3325d2`, `99ce468`, `1c8dd23`) |
| Snapshot relationship | The implementation code at the audit baseline and inspected HEAD is identical; all intervening commits changed documentation only. This update is another documentation-only follow-up to the inspected snapshot. |

> **Note:** The implementation code at audit baseline `74c6821` and inspected HEAD `1c8dd23` is identical; all commits between them changed documentation files only. The present document update is a further documentation-only change.

## Project Instructions and Architecture

- [ARCHITECTURE.md](../ARCHITECTURE.md) describes the Phaser 4.2.1 project structure, `Game` loop, entities, `EntityManager`, the shared `Game.shipQueue`, and the entity contract. It requires preserving manager boundaries and the shared queue.
- [QWEN.md](../QWEN.md) requires Phaser 4 APIs, repository architecture compliance, and scope control. It points to the global Qwen conventions file.
- [CLAUDE.md](../CLAUDE.md) requires following architecture and conventions, preserving manager responsibilities, and not treating `QWEN.md` as Claude-specific instructions.
- The global Claude and Qwen `CONVENTIONS.md` files were inspected. No repository-local `CONVENTIONS.md` was found. The conventions require narrow changes, tests for behavior, no dependency additions without approval, and respecting approval boundaries.
- [MANAGER-PLAN.md](../MANAGER-PLAN.md) is a future architecture proposal. It mentions a possible `WeaponManager`, but no such manager exists in the implementation inspected here. Do not create it merely because it appears in the plan.

## Current Architecture

### Data Ownership and Blueprints

The runtime data is presently authored inline in `Game.loadGameData()` rather than loaded from external files. `Game` exposes canonical typed registries for Shipmaker definitions:

- `hullDefinitions: Map<string, HullDefinition>`
- `componentDefinitions: Map<string, ComponentDefinition>`
- `shipLoadouts: Map<string, ShipLoadout>`
- `legacyCompatibilityViews: Map<string, LegacyCompatibilityView>`
- `hullModificationDefinitions: Map<HullModificationId, HullModificationDefinition>`

These registries are populated during `Game.loadGameData()` via `ShipDataAdapter.ingestLegacyData(this)` and direct assignment of the player hull, PlayerCannon component, and player loadout.

`ShipBlueprintDefinition` (canonical) combines ship identity/classification, ship statistics, and references to a `hullId` and `loadoutId`. It does not own hull geometry, component visuals, or whole-ship visual sprites.

`ShipBlueprint` is a stable catalogue entry with `id` and `sourceKey`; it may own a structured definition (canonical or legacy) or resolve a legacy tuple from `Game.shipData`.

`ShipManager` owns blueprint registration and source-key lookup, indexes legacy keys, and provides centralized creation and disposal for ordinary managed ships. Its `createShip()` acquires from `ObjectPool`, assigns faction and position, registers with `EntityManager`, applies options, and inserts into `Game.shipQueue`; `disposeShip()` removes from the queue, unregisters, clears faction, and returns the ship to the pool.

`ShipBlueprintStats` is applied directly to a `Ship` and combines physical-looking values (`weight`, `radius`, `maxHull`) with ship-specific gameplay values (speed, acceleration, energy, shell, credits/value). The repository does not establish that these values are inherent to a physical hull. The proposed design therefore keeps all existing stats on `ShipBlueprintDefinition`; it does not migrate them wholesale into `HullDefinition`.

### Ship Initialization and Lifecycle

`ObjectPool.getShipObject(type)` calls `Ship.init(type)` on new and reused ships. `Ship.init()` resolves the ship's blueprint through three distinct paths:

1. **Canonical path (`initCanonicalBlueprint`)**: Resolves a structured `ShipBlueprintDefinition` via `ShipManager` source-key catalogue using `hullId`/`loadoutId`. Builds parts from `HullDefinition`, materializes built-ins (`installationSource: 'built-in'`), installs loadout components by `mountId`. This is the canonical path for all new ships.
2. **Structured legacy path (`initStructuredLegacyBlueprint`)**: Legacy blueprint with structured data but using `partIndex` to attach components. It **does not** internally convert to the canonical hull/loadout path; it constructs parts with `×5` coordinate scaling and attaches components by `partIndex` directly.
3. **Legacy tuple path (`initLegacyTuple`)**: Reads a legacy tuple from `Game.shipData`. Parts constructed with `x`/`y` multiplied by five; components initialized against resulting part objects.

The ordinary NPC path is `Game` spawn queue → `ShipManager.createShip()` → `ObjectPool.getShipObject()` → `Ship.init()` → `EntityManager` registration and `Game.shipQueue` insertion. `Game.update()` updates managed ships through `shipQueue`, processes projectile lifecycle, then processes spawn and respawn queues. `processSectorShips()` converts sector ship rows to spawn queue entries; `clearCurrentSector()` clears queues, registries, pools, and managed projectiles.

The player deliberately follows a different path in `GameScene`: it creates a Phaser container/body, acquires its logical `Ship` directly from the object pool, sets its faction and Phaser references, and registers it with `EntityManager` without inserting it into `Game.shipQueue`. Each frame, Phaser container state is synchronized to the logical ship; player weapon cooldowns and activation are driven by the scene. Shutdown returns the player to the pool and unbinds the projectile manager.

Debug NPC ships are another distinct path. `main.ts` temporarily registers test blueprints through `ShipManager`, creates ships through `ShipManager.createShip()`, then creates scene-owned visual containers and synchronizes them to logical ships. These are debug/test visuals, not a general NPC rendering pipeline. `TestAllyManager` similarly registers temporary definitions and uses `ShipManager` for ordinary managed lifecycle.

### Components, Weapons, and Projectiles

`Component.init()` accepts a typed `ComponentDefinition`, a `LegacyComponentDef`, or a string key (looking up in `Game.componentDefinitions` then `Game.componentData`). It constructs either `ManagedWeapon` when `ProjectileManager` is available or `Weapon` otherwise. A component retains a ship and a `shipPart`, but has **no dedicated `mountId` field or sprite collection** in the canonical path either.

In the **canonical path** (`applyDefinition()` on typed `ComponentDefinition`), `Component` stores:
- `installationSource`: `'loadout'` | `'built-in'` | `'legacy'`
- `fixed`: `boolean` (true for built-ins)
- `turretAngleDeg`: `number` (per-instance turret angle, currently initializes to `0`)

`Ship.addComponent()` assigns `installationSource` and `fixed` **after** component initialization.

`Weapon.init()` reads the tuple/definition to set firing mode and weapon values. `Weapon.activate()` dispatches by firing mode. Its Arcade path converts `Ship.rotation` from degrees to radians, computes projectile origin, and uses ship angle for direction.

**Both the fallback `PhysicsProjectile` path (`Weapon.fireArcadeProjectile`) and the managed path (`ManagedWeapon.fireArcadeProjectile`) use the shared `WeaponTransform.resolveWeaponMuzzles()` implementation.** `ManagedWeapon` does **not** duplicate the part-offset transform; it delegates muzzle resolution to the shared transform.

When a `ProjectileManager` exists, `Component` prefers `ManagedWeapon`. `ManagedWeapon` snapshots source entity ID and faction at firing time and calls `ProjectileManager.spawn()`. The manager owns scene binding, pooling, velocity initialization, attribution retention, lifespan, swept collision/damage, cleanup, and scene shutdown handling. It does not own weapon energy/cooldown or register projectiles in `EntityManager`.

`PlayerCannon` currently has damage `10`, firing mode `ProjectileArcade`, range `400`, cooldown `0.15` seconds, energy cost `5`, projectile speed `600`, and splash radius `0`. `Component.activate()` spends energy and starts cooldown only after successful activation. The `ProjectileSpawnConfig` does not carry weapon range or splash radius, and collision applies direct damage; those tuple values are not currently used to provide range/splash gameplay. The refactor must retain the data values without claiming new behavior for them.

**Compatibility validation happens in `Ship.validateCanonicalMount()` before canonical component installation.** The `shipPart` passed to `Component.init()` carries the mount pose (position and rotation) in **ship-local (hull-local)** coordinates. The current `WeaponTransform.resolveWeaponMuzzles()` interprets `ComponentAttachment.position`/`attachmentRotationDeg` in **mount-local** coordinates; `Component` does not receive mount identity or validate compatibility.

### Entity, Pool, and Modular Hull Boundaries

`EntityManager` is a reference registry and stable-ID allocator. It does not create, render, move, or dispose ships. `ObjectPool` owns ship/component/effect/resource/power-up reuse; it calls ship initialization on acquisition and resets/disposes pooled objects.

`ModularHull.ts` defines `HullSection`, `HullSectionDef`, and a separate `Hardpoint` model. Its hardpoints are already assigned `weapon` or `ability` types and carry combat stats/cooldown. Repository search found no constructor/use sites for these classes; they are not consumed by `Ship`, `Component`, `Weapon`, or projectile spawning. Keep this isolated implementation unchanged during prerequisite refactoring unless later usage evidence supports a safe migration.

`MANAGER-PLAN.md` describes a possible future `WeaponManager`; this is not an implemented manager. Do not add a parallel manager or move projectile ownership out of `ProjectileManager` as part of this design.

## Current Versus Proposed Compatibility

| Concern | Current implementation | Compatibility | Remaining work |
|---|---|---|---|
| Ship catalogue | `ShipBlueprint` indexes canonical definitions (`hullId`/`loadoutId`) and legacy `Game.shipData` tuples via `syncFromGame()`. | COMPATIBLE | Legacy migration completion (see Migration Order). |
| Hull identity/geometry | `Game.hullDefinitions` registry populated; `HullDefinition` typed contracts exist; player hull registered. | IMPLEMENTED (foundations) | Complete migration for all structured/legacy blueprints. |
| Generic weapon hardpoints | `WeaponHardpoint` with `accepts: readonly ('spinal' \| 'turret')[]` implemented; validation in `Ship.initCanonicalBlueprint()`. | IMPLEMENTED (foundations) | Full migration across all hull definitions. |
| Empty/loadout assignment | `ShipLoadout` with explicit `installations`; player loadout registered; empty loadout valid. | IMPLEMENTED (foundations) | Complete migration across all blueprints. |
| Component definitions | `Game.componentDefinitions` registry populated; `ComponentDefinition` typed contracts exist; `PlayerCannon` registered. | IMPLEMENTED (foundations) | Complete migration for all component categories. |
| Spinal/turret models | Discriminated `SpinalWeaponDefinition` / `TurretWeaponDefinition` types; geometry, visuals, operation all typed. | IMPLEMENTED (data contracts) | **Data contracts:** complete. **Mounting checks:** hardpoint `accepts` validation in `Ship.initCanonicalBlueprint()`. **Proposed physical validation:** turret pivot/limits/barrels dimension checks not yet implemented. **Proposed visual/gameplay integration:** turret pivot/barrel/muzzle transformation, aiming, and visual rotation not yet implemented. |
| Built-in components | `builtInComponentId` on all mount types; materialized as fixed `installationSource: 'built-in'` instances in `Ship.initCanonicalBlueprint()`; reserves point; rejects loadout replacement. | IMPLEMENTED (foundations) | Full migration across all hulls. |
| Thruster vents | `ThrusterVent` typed with position, exhaust direction, `acceptsPropulsionCategories`, restrictions, `builtInComponentId`; validation in `Ship.initCanonicalBlueprint()` checks propulsion category. | IMPLEMENTED (data contracts, mounting checks) | **Data contracts & mounting checks:** complete (category only). **Proposed physical validation:** vent opening dimension checks, `maxComponentDimensions` envelope checks, `maxPropulsionOutput` cap, and dimension validation are not yet implemented. **Proposed visual/gameplay integration:** propulsion movement behavior remains separate work; exhaust visual rotation with ship/vent is metadata only. |
| Component/hull visuals | `SpriteLayer` typed; `HullDefinition.sprites`, `ComponentDefinition.visuals.fixed/rotating` defined; deterministic 5-key sort order specified. | IMPLEMENTED (data model) | Deterministic sprite composition helper and Ship-owned Phaser display-object lifecycle remain proposed. |
| Coordinate handling | `WeaponTransform.ts` shared resolution used by both `Weapon.resolveMuzzles()` (fallback `PhysicsProjectile` path) and `ManagedWeapon.fireArcadeProjectile()` (managed projectile path); legacy `×5` scaling occurs once in `Ship.initLegacyTuple()`, `initStructuredLegacyBlueprint()`, and `ShipDataAdapter.ingestLegacyData()`. | IMPLEMENTED (shared transform) | Full migration of legacy coordinate paths. |
| Versioned authoring data | No external Lua schema/parser/serializer. | NOT IMPLEMENTED | External Lua parsing, loading, validation, and persistence. |
| Player/NPC lifecycles | Separate player (scene-owned) and NPC (managed queue) paths work; `Ship.init()` canonical resolution shared. | COMPATIBLE | Preserve boundaries during integration. |
| Projectile lifecycle | `ProjectileManager` owns pooling, attribution, collision, lifespan, cleanup; `ManagedWeapon` delegates spawn. | COMPATIBLE | Preserve ownership; verify spawn transform integration. |

## Proposed Data Ownership

- **Game:** remains the authoritative owner of canonical typed `hullDefinitions`, `componentDefinitions`, and `shipLoadouts`. Extend the existing game-data ownership rather than introducing a manager or parallel registry. Existing `shipData` and `componentData` remain legacy inputs/adapters only until migration is verified; they must not compete as a second canonical source.
- **ShipManager:** retains the ShipBlueprint catalogue, including ID/source-key indexes and ordinary ship creation/disposal. It resolves a blueprint's `hullId` and `loadoutId` through `Game`, not a new manager or parallel registry.
- **ShipBlueprintDefinition:** remains a plain data contract for ship-specific identity, classification, stats, and hull/loadout references. It does not own hull/component sprite definitions.
- **ShipBlueprint:** remains the catalogue wrapper with registration identity and one reference to its structured definition, or the established legacy-resolution mechanism. There is one authoritative structured definition per blueprint; do not copy it into a second registry.

The Game registries own shared configuration records; a blueprint owns its ship-specific record; the ShipManager indexes wrappers and resolves references. This keeps hull geometry reusable across blueprints/loadouts and preserves existing manager boundaries.

### Legacy Compatibility Boundary

During migration, each unconverted legacy `Game.shipData` ship tuple and `Game.componentData` component tuple remains the authoritative source for that entry. A temporary adapter projects the tuple values into the shape consumed by the new initialization/composition path; that projected view is ephemeral adapter output, not a second canonical definition registry or cache. `ShipManager` remains the blueprint catalogue owner, and its legacy resolution continues to consult the existing source rather than retaining a competing copy. Existing structured entries remain authoritative in their current form until individually migrated. Once an entry is migrated, the corresponding structured hull/component/loadout records owned by `Game` become its canonical source. Preserve both paths until tests verify parity.

## Three-Definition Architecture — Exact Existing Contracts (src/types/Shipmaker.ts) and Proposed Extensions

**Authority:** The exact existing TypeScript contracts are those currently in `src/types/Shipmaker.ts`. Everything below labeled **[EXISTING]** reflects that source exactly. Everything labeled **[PROPOSED]** is a design extension not yet present in the source and is preserved here as the intended future shape. Runtime validation is required for imported or editor-authored records because TypeScript types do not validate data at runtime.

Do not treat [PROPOSED] fields as implemented. They must be implemented through the approved prerequisite refactoring phases before they exist in the runtime.

### Shared Primitives and Branded IDs

```ts
export type HullPartId = string & { readonly __hullPartId: unique symbol };
export type HullPointId = string & { readonly __hullPointId: unique symbol };
export type HullModificationId = string & { readonly __hullModificationId: unique symbol };
export type ComponentId = string;
export type SpriteKey = string;

export interface Point2 {
    x: number;
    y: number;
}

export interface SpriteLayer {
    id: string;
    textureKey: SpriteKey;
    textureOrigin?: Point2;
    position: Point2;
    rotationDeg?: number;
    scale?: Point2;
    rotationFrame?: 'component' | 'turret';
    order: number;
}

export interface ComponentAttachment {
    position: Point2;
    attachmentRotationDeg: number;
}

export interface HullPart {
    id: HullPartId;
    name: string;
    position: Point2;
    rotationDeg: number;
    isLoot: boolean;
    maxHull?: number;
}
```

`textureOrigin` selects the image point placed at a layer position; its numeric coordinates must be finite without an imposed `[0, 1]` project restriction. `rotationFrame` defaults to `'component'` when omitted.

### HullDefinition — EXISTING Fields (Exact)

```ts
export interface WeaponHardpoint {
    id: HullPointId;
    position: Point2;
    rotationDeg: number;
    accepts: readonly ('spinal' | 'turret')[];
    maxDimensions?: Point2; // EXISTING: Point2, not Dimensions
    restrictions: Readonly<Record<string, unknown>>; // EXISTING: Record<string, unknown>, not string[]
    builtInComponentId?: ComponentId;
}

export interface ThrusterVent {
    id: HullPointId;
    position: Point2;
    rotationDeg: number;
    width: number;
    height: number;
    exhaustDirectionDeg: number;
    acceptsPropulsionCategories: readonly string[];
    restrictions: Readonly<Record<string, unknown>>;
    builtInComponentId?: ComponentId;
}

export interface UtilitySocket {
    id: HullPointId;
    position: Point2;
    rotationDeg: number;
    acceptedCategories: readonly string[]; // EXISTING: acceptedCategories, not acceptsCategories
    restrictions: Readonly<Record<string, unknown>>;
    builtInComponentId?: ComponentId;
}

export interface ActiveModuleMount {
    id: HullPointId;
    position: Point2;
    rotationDeg: number;
    acceptedCategories: readonly string[];
    restrictions: Readonly<Record<string, unknown>>;
    builtInComponentId?: ComponentId;
}

export interface HullDefinition {
    id: string;
    parts: readonly HullPart[];
    sprites: readonly SpriteLayer[];
    weaponHardpoints: readonly WeaponHardpoint[];
    activeModuleMounts: readonly ActiveModuleMount[];
    thrusterVents: readonly ThrusterVent[];
    utilitySockets: readonly UtilitySocket[];
    hullModCapacity: number;
}
```

**Key existing details:**
- `WeaponHardpoint.maxDimensions` is `Point2` (not `Dimensions`).
- Mount `restrictions` are `Readonly<Record<string, unknown>>` (not `readonly string[]`).
- `ThrusterVent` does **not** have `maxPropulsionOutput` or `maxComponentDimensions`.
- All point IDs use the branded `HullPointId` type.
- Point IDs share one hull-local namespace across weapon hardpoints, thruster vents, utility sockets, and active module mounts.

### HullDefinition — PROPOSED Extensions (Not Yet in Source)

```ts
// PROPOSED: WeaponHardpoint.maxDimensions as Dimensions (with length/width/height)
// PROPOSED: Mount restrictions as readonly string[]
// PROPOSED: ThrusterVent.maxPropulsionOutput?: number
// PROPOSED: ThrusterVent.maxComponentDimensions?: Dimensions
// PROPOSED: Physical-dimension validation for vents and hardpoints
```

### ComponentDefinition — EXISTING Fields (Exact)

```ts
export interface BaseComponentDef {
    id: ComponentId;
    operation: {
        cooldown: number;
        energyCost: number;
    };
    attachment: ComponentAttachment;
    dimensions?: {
        length: number;
        width: number;
        height: number;
    };
}

export type WeaponOperation = BaseComponentDef['operation'] & {
    firingMode: string;
    damage: number;
    range: number;
    projectileSpeed: number;
    splashRadius: number;
    // cooldown and energyCost inherited from BaseComponentDef['operation']
};

export interface SpinalWeaponDefinition extends BaseComponentDef {
    kind: 'weapon';
    configuration: 'spinal';
    operation: WeaponOperation;
    visuals: {
        fixed: readonly SpriteLayer[]; // EXISTING: fixed, not fixedLayers
    };
    geometry: {
        muzzles: readonly {
            position: Point2;
            directionDeg: number;
        }[];
    };
}

export interface TurretWeaponDefinition extends BaseComponentDef {
    kind: 'weapon';
    configuration: 'turret';
    operation: WeaponOperation;
    visuals: {
        fixed: readonly SpriteLayer[]; // EXISTING: fixed, not fixedLayers
        rotating: readonly SpriteLayer[]; // EXISTING: rotating, not rotatingLayers
    };
    geometry: {
        pivot: Point2;
        rotationLimitsDeg: { min: number; max: number };
        rotationSpeedDegPerSecond: number;
        barrels: readonly {
            id: string;
            position: Point2;
            rotationDeg: number;
            muzzles: readonly {
                position: Point2;
                directionDeg: number;
            }[];
        }[];
    };
}

export interface PropulsionComponentDefinition extends BaseComponentDef {
    kind: 'propulsion';
    category: string;
    propulsion: { output: number };
    sprites: readonly SpriteLayer[];
    // operation: { cooldown, energyCost } inherited from BaseComponentDef
}

export interface UtilityComponentDefinition extends BaseComponentDef {
    kind: 'utility';
    category: string;
    sprites: readonly SpriteLayer[];
    // operation: { cooldown, energyCost } inherited from BaseComponentDef
}

export type ActiveModuleOperation = BaseComponentDef['operation'] & {
    chargeTime?: number;
};

export type ActiveModuleTargeting =
    | { kind: 'self' }
    | { kind: 'single'; allowed: readonly ('Ally' | 'Enemy')[] }
    | { kind: 'area'; allowed: readonly ('Ally' | 'Enemy')[]; radius: number; includeSelf: boolean };

export type ActiveModulePayload =
    | { kind: 'resource_restore'; shell: number; hull: number; energy: number };

export interface ActiveModuleDefinition extends BaseComponentDef {
    kind: 'active-module';
    category: string;
    operation: ActiveModuleOperation;
    payload: ActiveModulePayload;
    targeting: ActiveModuleTargeting;
    sprites: readonly SpriteLayer[];
}

export type ComponentDefinition =
    | SpinalWeaponDefinition
    | TurretWeaponDefinition
    | PropulsionComponentDefinition
    | UtilityComponentDefinition
    | ActiveModuleDefinition
    | LegacyComponentDef;
```

**Key existing details:**
- `BaseComponentDef.dimensions`, when provided, requires `length`, `width`, and `height` (not individually optional).
- `SpinalWeaponDefinition.visuals.fixed` and `TurretWeaponDefinition.visuals.fixed/rotating` use the exact field names.
- `ActiveModuleTargeting` is a discriminated union with required fields per kind (not all optional).
- `ComponentDefinition` is a discriminated union of the five variants plus `LegacyComponentDef`.

### ComponentDefinition — PROPOSED Extensions (Not Yet in Source)

```ts
// PROPOSED: behaviorId?: string; behaviorConfig?: Record<string, unknown> on weapon definitions
// PROPOSED: Weapon-side mount requirement fields (narrowing, not overriding WeaponHardpoint.accepts)
// PROPOSED: Additional component categories beyond the existing five
```

### ShipLoadout and ShipBlueprint — EXISTING (Exact)

```ts
export interface InstallationRecord {
    mountId: HullPointId; // EXISTING: HullPointId, not string
    componentId: ComponentId;
}

export interface ShipLoadout {
    id: string;
    installations: readonly InstallationRecord[];
}

export interface ShipBlueprintStats {
    maxHull: number;
    maxShell: number;
    regenShell: number;
    maxEnergy: number;
    regenEnergy?: number;
    maxSpeed: number;
    acceleration: number;
    weight: number;
    radius: number;
    value: number;
}

export interface ShipBlueprintDefinition {
    hullId: string;
    loadoutId: string;
    superType: string;
    subType: string;
    name: string;
    categoryType: string;
    stats: ShipBlueprintStats;
}
```

**Key existing detail:** `InstallationRecord.mountId` is `HullPointId` (branded).

`ShipBlueprintDefinition.hullId` is the sole authoritative hull reference. `loadoutId` identifies component installations, and `ShipLoadout` contains only its own ID and explicit assignments; it does not select a hull. Interpret each loadout against the hull selected by the referencing blueprint. An empty installation list is valid. The blueprint retains ship identity/classification and all existing ship-specific stats; different blueprints/loadouts may reuse one hull without duplicating geometry. Catalogue `id` and `sourceKey` remain on the `ShipBlueprint` wrapper, not in this plain definition.

### Built-In Resolution

`ShipManager` resolves a blueprint's canonical hull and loadout references through registries owned by `Game`. During `Ship.init()`, materialize explicit built-ins from the selected hull and explicit loadout installations from the selected loadout. For each `builtInComponentId`, resolve the component definition from `Game.componentDefinitions`, validate kind/category/configuration and point compatibility, then construct the per-ship `Component` instance with installation source `built-in` and reserve that point after successful validation. This is independent of the loadout, so even an empty loadout receives built-ins. Reject explicit loadout installation at a reserved point. No other points are filled automatically. Built-ins are fixed/non-removable in this initial scope. Runtime state belongs to each Component instance; definitions remain reusable data. No separate loadout resolver manager is introduced.

### Sprite Composition Ownership

The final composition derives from `HullDefinition.sprites`, component sprite layers selected by explicit built-in assignments and `ShipLoadout.installations`, each installed instance's state (including turret angle), and deterministic layer ordering. Hull and component definitions own only their respective source sprites. The loadout determines which component visuals are present. After migration, `ShipBlueprintDefinition` does not duplicate whole-ship visuals.

A pure composition helper produces deterministic visual descriptors from the selected hull, resolved component installations, per-instance turret state, and the temporary legacy adapter where applicable. The helper is independent of Phaser and combat. `Ship.init()` resolves the initial descriptors once; it is not recomputed each frame. Ship-owned Phaser display objects and cleanup are proposed responsibilities of the approved refactor. The current source has no Ship scene-attachment or composition-materialization path: `Ship.init()` builds logical parts/components, while `main.ts` creates the player and debug visual containers. The refactor must add attachment/materialization using Phaser context supplied by the scene, without changing player/NPC lifecycle boundaries; do not describe this as existing Ship behavior. If composition is resolved before scene context exists, retaining descriptors until the proposed attachment step is part of that refactor. Turret angle changes update only the relevant rotating group/child transforms, not the entire composition. Future component add/remove operations must go through Ship-owned operations that refresh the composition; fixed built-ins remain non-removable. Do not introduce `ShipVisualManager` for this responsibility.

`SpriteLayer.order` is finite but need not be globally unique. Sort ascending by the complete stable key `(sourceRank, installationPointId, componentId, layerOrder, layerIdOrdinal)`:

1. `sourceRank`: legacy whole-ship adapter `0`, canonical hull layer `1`, installed component layer `2` (built-in and loadout components share this rank).
2. `installationPointId`: ordinal lexical order when present; empty for legacy/hull layers.
3. `componentId`: ordinal lexical order when present; empty for legacy/hull layers.
4. `layerOrder`: the definition-local numeric `order`.
5. `layerIdOrdinal`: ordinal lexical comparison of the layer ID as the final tie-break.

This permits layer IDs and order values to be reused in different definitions without coupling a reusable component to other installed components. IDs are unique only within their owning `HullDefinition` or `ComponentDefinition`; there is no global layer-ID or order namespace. Canonical hull/component layer IDs must not use the reserved `legacy:` prefix. Legacy whole-ship sprites use synthetic IDs `legacy:<source-index>`, their source-array index as `layerOrder`, and the distinct legacy source rank. Preserve their current array ordering through this adapter, then remove it only after migration and parity tests.

## Compatibility and Validation Rules

1. `Game` owns the canonical typed hull, component, and loadout registries. `ShipManager` retains blueprint ID/source-key indexing and ordinary ship creation/disposal; it resolves blueprint references through `Game`, not a new manager or parallel registry.
2. `ShipBlueprintDefinition.hullId` is the sole hull reference for a blueprint. Its `loadoutId` identifies installations only. `ShipLoadout` has no hull reference and is interpreted against the blueprint-selected hull. A plain blueprint definition contains ship identity/classification/stats and these two IDs, not hull/component visuals. `ShipBlueprint` is the catalogue wrapper and references one authoritative structured definition or uses the legacy resolution path.
3. Hull IDs, component IDs, loadout IDs, blueprint IDs, and point IDs must be stable and unique in their namespaces. Hull sprite-layer IDs are unique within their `HullDefinition`; component layer IDs are unique within their `ComponentDefinition`. Layer IDs may be reused across definitions, and `order` values need not be globally unique. Canonical hull/component layer IDs must not use the reserved `legacy:` prefix. Weapon hardpoints, vents, utility sockets, and active module mounts share one point-ID namespace per hull; built-ins and loadouts resolve through it.
4. Resolve each blueprint's hull and loadout through `Game`. Every loadout installation must reference a registered component and a point in that blueprint's hull. A loadout does not select or override the hull.
5. Each installation point has capacity one. `Ship.init()` materializes explicit built-ins and loadout installations. For a `builtInComponentId`, resolve from `Game.componentDefinitions`, validate component kind/category/configuration and point compatibility, construct a fixed instance with source `built-in`, and reserve the point. This occurs even for an empty loadout. Reject loadout assignments to reserved points. Built-ins are fixed/non-removable in this initial scope; component runtime state belongs to the individual instance.
6. A weapon installation is accepted only when the generic hardpoint's `accepts` includes the component's discriminated `configuration`. A vent validates propulsion category; a utility socket retains category matching only; an active module mount validates active-module category. Built-ins pass the same checks.
7. `Dimensions` gives full envelope extents, not half-extents. Defined `length` and `width` must be finite and strictly positive; defined `height` must be finite and nonnegative, with zero meaning planar. Omitted values mean unknown. If a `dimensions` object is supplied, reject `{}`; components with no known dimensions omit the property.
8. Dimension maxima are partial constraints and only specified axes are checked. Checking either projected in-plane axis (`length` or `width`) requires both component `length` and `width`, because each projection couples both. A height-only constraint requires only component `height`. Missing any value required by an active constraint rejects that constraint; if no constraint needs it, missing dimensions are allowed.
9. A vent opening always constrains both projected in-plane axes and therefore requires both component `length` and `width`. `maxComponentDimensions`, when supplied, is a separate partial installation envelope; only specified axes are checked under the same dependency rules. Vent opening dimensions must be finite and strictly positive. Dimension maxima must be finite and nonnegative; `{}` as a supplied maxima object is invalid.
10. Rotated-envelope formulas are size-limit checks independent of translation. They do not prove containment, collision avoidance, or physical clearance for off-center attachment datums. Offset-aware containment would require explicit local footprint bounds and is outside this prerequisite scope.
11. Turret limits must be finite, ordered, and span no more than 360 degrees; rotation speed must be finite and nonnegative. The interval is an unwrapped azimuth offset, not a multi-turn actuator. Initialize at the equivalent of zero in the interval with smallest absolute angle, tie-breaking lower. If none exists, compare both boundaries by minimum angular distance to any multiple of 360 degrees, select the closer boundary, and tie-break lower. Do not wrap subsequent angles; clamp them to the unwrapped interval.
12. All authored angles (including turret limits, barrel/muzzle offsets, attachment, mount, sprite, vent, and exhaust angles), sprite order, and scale values must be finite. `textureOrigin` coordinates must be finite; the project imposes no `[0, 1]` bound. Only rotating layers on turret weapons may use `rotationFrame: 'turret'`, and they must specify it explicitly; hull layers omit `rotationFrame`, while all other component layers omit it or use `'component'`.
13. Propulsion output must always be finite and nonnegative. If `maxPropulsionOutput` is present, it must be finite and nonnegative and output must not exceed it. This remains metadata only; no movement behavior is derived from it.
14. Public sprite keys validate against generated manifest metadata without `BootScene`; any source-asset keys validate only against an explicitly supported Vite source-asset catalog. Utility sockets remain minimal: installation point, category compatibility, and optional explicit built-in. Defer additional utility restrictions or runtime behavior until a concrete requirement exists.

### Dimension Frames

`Dimensions.length`, `width`, and `height` are full envelope extents, not half-extents. Length and width are measured in component-local `+X` and `+Y`; height is along component-local `+Z`, perpendicular to the 2D plane. Installation-point maximum dimensions are maximum permitted full extents in that point's local frame. The projection uses only extents and relative rotation, independent of translation. It is not a containment, collision, or clearance test and does not account for an off-center attachment datum or envelope-center offset. Offset-aware physical containment would require explicit local footprint bounds and is outside this prerequisite scope.

Let relative in-plane rotation be `δ = θcomponent - θmount`, converting degrees to radians before evaluating trigonometric functions. Projected extents are:

```text
Lmount = |cos(δ)| * L + |sin(δ)| * W
Wmount = |sin(δ)| * L + |cos(δ)| * W
Hmount = H
```

For a hardpoint maximum, compare only axes whose maxima were specified. A `length` maximum checks `Lmount`; a `width` maximum checks `Wmount`; either in-plane check requires both component `length` and `width`. A `height` maximum checks only `Hmount` and requires only component `height`. Partial maximum objects are valid, but an explicitly supplied empty `{}` is rejected. Without an active constraint, the entire component `dimensions` property may be omitted. These are size-limit checks only, not proof of physical containment or clearance.

For a thruster vent, `width` and `height` describe the opening in vent-local `+X/+Y`. Both opening checks are active, so both component length and width are required; compare `Lmount` to opening width and `Wmount` to opening height. Component `height` is `+Z` depth and is not compared to the planar opening. Optional `maxComponentDimensions` is a separate partial envelope in vent-local axes; only specified maxima are checked, using both length/width for either in-plane projection and height alone for a depth constraint. Neither comparison accounts for an off-center attachment's physical clearance.

## Coordinate and Rotation Contract

All new hull/component points use local pixels. The ship origin is its center. Coordinates are screen coordinates: `+X` right and `+Y` down. Angles are degrees, positive clockwise visually. `Ship.rotation` is degrees. Phaser `GameObject.rotation` is radians; the current player scene converts radians to degrees when synchronizing to `Ship.rotation`.

Define the y-down rotation matrix:

```text
R(θ) = [ cos(θ)  -sin(θ) ]
       [ sin(θ)   cos(θ) ]
```

With this screen-space convention, positive 90 degrees maps local right `(1, 0)` to screen-down `(0, 1)`. This is consistent with the existing projectile trigonometry and is not a convention change.

---

### Current Runtime Contract — Mount-Local Attachment (Implemented)

The shared `WeaponTransform.resolveWeaponMuzzles()` (used by both `Weapon.resolveMuzzles()` and `ManagedWeapon.fireArcadeProjectile()`) operates on a **mount-local attachment** convention:

- `mount.position` / `mount.rotationDeg`: position and rotation of the hardpoint in **ship-local** coordinates
- `attachment.position` / `attachment.rotationDeg`: position and rotation of the component's attachment datum in **mount-local** coordinates
- `muzzle.position` / `muzzle.directionDeg`: position and direction in **component-local** coordinates

The transform computes:
```text
componentDirectionDeg = ship.rotationDeg + mount.rotationDeg + attachment.rotationDeg
componentWorld = ship + R(ship.rotationDeg) * mount.position + R(ship.rotationDeg + mount.rotationDeg) * attachment.position
Pmuzzle = componentWorld + R(componentDirectionDeg) * muzzle.position
θmuzzle = componentDirectionDeg + muzzle.directionDeg
```

**Contract:** hardpoint defines the ship→mount transform; attachment defines the mount→component transform; component geometry (muzzles, barrels) is defined in component-local coordinates.

The existing weapon-transform tests verify this mount-local contract at cardinal angles (0°, 90°, 180°, 270°), parent-to-child composition, multiple muzzle order/direction, and empty-muzzle fallback.

---

### Proposed Target Contract — Component-Local Attachment Datum (Not Yet Implemented)

The proposed architecture intends a **component-local attachment datum** convention for authoring:

For ship world position `Ps`, ship rotation `θs`, hull-local hardpoint position `H`, hardpoint rotation `φh`, component-local attachment datum `A`, and `attachmentRotationDeg = α`:

```text
Ph = Ps + R(θs) * H
θcomponent = θs + φh - α
Pc = Ph - R(θcomponent) * A
```

The hardpoint sets hull-side orientation; `attachmentRotationDeg` is the component-side datum axis that aligns to it. The component attachment point is an actual point in the component-local frame, not the sprite origin.

Worked sign example: with ship rotation `0°`, hardpoint rotation `0°`, and component `attachmentRotationDeg = +30°`, `θcomponent = 0° + 0° - 30° = -30°`. The subtraction rotates the component frame so its own attachment datum axis aligns with the hardpoint axis; it does not rotate the ship or change the component-local visual origin.

Hull sprite layers use hull-local positions and cannot use the turret frame. Component fixed-layer positions are component-local and transform by `Pc + R(θcomponent) * L`. A turret-frame layer's position and rotation are pivot-local; its group is positioned at the component-transformed pivot and rotated by that installed instance's `turretAngleDeg`. `textureOrigin` selects the image point placed at a layer position; it does not shift the component attachment datum or muzzle coordinates.

For spinal muzzle position `M` in component-local pixels and per-muzzle direction `μ`:

```text
Pmuzzle = Pc + R(θcomponent) * M
θmuzzle = θcomponent + μ
```

Here `M` is relative to the component visual origin, not to the attachment datum. `μ` is fixed in the spinal component frame and does not create another weapon alignment setting.

For turret pivot `T`, instance angle `θturret`, barrel origin `B` and fixed neutral-frame barrel angle `β`, and muzzle point `M` / direction offset `μ` in that barrel-local frame:

```text
Pmuzzle = Pc + R(θcomponent) * (T + R(θturret) * (B + R(β) * M))
θmuzzle = θcomponent + θturret + β + μ
```

Mechanical rotation is only `θturret` and is clamped by the definition's unwrapped limits. Barrel position/orientation is fixed geometry relative to the neutral turret frame. `Muzzle.directionDeg` (`μ`) is a fixed offset relative to the barrel-local `+X` direction and is added only when calculating projectile direction; it cannot change mechanical turret angle or limits. All values are finite degrees. No second spinal alignment or geometry-level firing direction is defined.

Thruster vent position transforms as `Pvent = Ps + R(θs) * V`. Exhaust direction is relative to the vent's local orientation:

```text
θexhaustWorld = θship + θvent + θexhaustLocal
direction = (cos(θexhaustWorld), sin(θexhaustWorld))
```

No propulsion movement is derived from this data during prerequisite refactoring.

---

### Migration Requirement

**Current runtime compatibility requires mount-local semantics.** The existing `WeaponTransform` tests do **not** verify the proposed target convention. The proposed component-local attachment datum equations describe the intended authoring target; implementing them requires a transform migration in `WeaponTransform.ts` and corresponding test updates. Until that migration is implemented and approved:

- **Authoring remains mount-local** — editor tools and Lua definitions must produce mount-local attachment data for runtime compatibility.
- **No adapter translates between conventions** — the proposed component-local target is a future authoring convention only; it is not currently used at runtime, and no conversion layer exists.
- **Editor preview must target the current runtime convention** (mount-local attachment) until the `WeaponTransform` migration is approved and implemented.

The Lua authoring and editor-preview sections refer to the intended target convention only when that migration is available. Do not claim that current runtime and future authoring behavior are already identical.

## Completed PlayerCannon Migration — Canonical Registration and Visual Composition Status

The player already uses a canonical `ShipBlueprintDefinition` referencing its registered `HullDefinition` and `ShipLoadout`. The hull has one hardpoint at `(0, 0)`, rotation `0`, compatible with spinal weapons. The player loadout assigns `PlayerCannon` to that point. It is not a built-in; other points remain empty.

`PlayerCannon` is registered as a spinal `SpinalWeaponDefinition`:

| Property | Preserved value |
|---|---|
| `configuration` | `spinal` |
| `operation.firingMode` | `ProjectileArcade` |
| Damage | `10` |
| Range | `400` |
| Cooldown | `0.15` seconds |
| Energy cost | `5` |
| Projectile speed | `600` |
| Splash radius | `0` |
| Dimensions | Unknown; omit `dimensions` |
| Attachment position/rotation | `(0, 0)` / `0°` |
| `geometry.muzzles` | Empty array; shared transform supplies an effective origin muzzle at `(0, 0)` / `0°` |

**Implementation status of PlayerCannon migration:**

- **Canonical registration: COMPLETE** — `Game.loadGameData()` registers the player `HullDefinition`, `PlayerCannon` `ComponentDefinition`, and player `ShipLoadout` in `Game`'s canonical registries. The player ship is initialized through `Ship.initCanonicalBlueprint()` using `hullId`/`loadoutId` resolution.
- **Player hull: `sprites: []`** — The registered player hull currently has an empty sprite array. Visual composition has **not** been migrated into hull sprite layers.
- **PlayerCannon visuals: `fixed: []`** — The registered `PlayerCannon` component has an empty fixed visual layers array.
- **PlayerCannon muzzles: `[]`** — The registered `PlayerCannon` component has an empty muzzles array. The origin muzzle at fire time is supplied by `WeaponTransform.resolveWeaponMuzzles()` empty-array fallback (`{ position: {0,0}, directionDeg: 0 }`), **not by an explicitly authored muzzle**.
- **Visual composition: NOT MIGRATED** — The player's visual composition still uses the legacy path in `main.ts` (scene-owned container synchronized to logical ship). The deterministic sprite composition helper and Ship-owned Phaser display-object lifecycle remain **proposed prerequisite work**, not implemented.
- **Coordinates are canonical pixels, not legacy ×5** — The canonical `PlayerCannon` definition uses `attachment: { position: { x: 0, y: 0 }, attachmentRotationDeg: 0 }` and `muzzles: []` in **local pixels**. Legacy `×5` scaling occurs in the separate legacy paths `Ship.initLegacyTuple()`, `Ship.initStructuredLegacyBlueprint()`, and `ShipDataAdapter.ingestLegacyData()`. Canonical definitions do not apply the ×5 factor.

| `Ship.rotation` | Effective origin muzzle from the shared empty-array fallback | Ship-forward direction | 600-speed muzzle vector before inherited shooter velocity |
|---:|---|---|---|
| 0° | `(ship.x, ship.y)` | `(1, 0)` right | `(600, 0)` |
| 90° | `(ship.x, ship.y)` | `(0, 1)` down | `(0, 600)` |
| 180° | `(ship.x, ship.y)` | `(-1, 0)` left | `(-600, 0)` |
| 270° | `(ship.x, ship.y)` | `(0, -1)` up | `(0, -600)` |

With a Phaser scene and `ProjectileManager` available, `Component` creates `ManagedWeapon`; it captures body velocity and source entity/faction at fire time. `ProjectileManager` adds shooter velocity to muzzle velocity and retains attribution while the source may be destroyed. Preserve those values and ownership. `Weapon` also has a fallback `PhysicsProjectile` path, but the normal configured player path prefers `ManagedWeapon`. The existing manager's direct-damage behavior does not currently implement splash radius or range checks; do not silently add those mechanics.

The player remains outside the NPC `shipQueue`, with its existing Phaser body, scene, container synchronization, direct player firing input, and shutdown cleanup. NPCs continue to use ShipManager and the managed queue. NPC loadouts may be predefined, but this refactoring must not add NPC Phaser body/rendering, aiming, combat AI, or alter lifecycle boundaries.

## Asset Pipeline

### Existing Discovery, Keys, and Loading

`scripts/generate-public-svg-manifest.mjs` recursively discovers SVGs under the registered asset roots (via `asset-registry.mjs`), sorts paths for deterministic output, and excludes the root `Planets` directory. It converts each relative path to a `public-...` key: it removes the extension, normalizes Unicode, sanitizes separators/characters, lowercases, and resolves normalized collisions with a stable SHA-256 suffix. URLs are `/assets/` plus each encoded path segment. Three explicit legacy aliases map existing ship/hull textures; alias collisions are checked.

The script writes `src/generated/publicSvgManifest.ts` only when content differs. `BootScene.preload()` loads planet PNGs separately, loads each generated public SVG with Phaser `load.svg()` at scale `0.5`, and also uses Vite `import.meta.glob('/src/assets/Components/**/*.svg', { eager: true, query: '?url', import: 'default' })` for source-directory component SVGs. `BootScene.create()` registers aliases by adding the loaded image to Phaser's texture manager. Shipmaker should consume these existing keys/assets and avoid creating a parallel sprite loader.

### Assets Present at Inspection

| Location/category | Observed contents |
|---|---|
| Registered asset roots (via `asset-registry.mjs`) | Component SVGs from Aistiaria, Yutiarin; Ship SVGs; Turret/Platform SVGs |
| `public/assets/Planets/` | Five PNG files; loaded separately and excluded from the SVG manifest. |
| `src/assets/` | Vite starter `hero.png`, `javascript.svg`, and `vite.svg`; no `src/assets/Components/` content exists, so the component glob currently contributes no assets. |

The generated manifest contains the public component, ship, and turret/platform SVG entries, with stable texture keys and aliases: `central-hull` → `public-components-aistiaria-01_side_hull_angular`, `human-dreadnought` → `public-ships-human-dreadnought`, and `alien-interceptor` → `public-ships-alien-interceptor`. Shipmaker should consume the generated manifest metadata directly to enumerate and validate public texture keys; this must work before or without gameplay `BootScene` initialization. For optional Vite source assets, validate only keys in an explicitly supported source-asset catalog derived from the existing glob/key convention. Do not create another loader or duplicate asset registry. The editor may load thumbnails for display, but public-key discovery and validation use metadata rather than Phaser runtime texture existence.

### App Entry

`index.html` is a Vite app shell with `#app` and `/src/main.ts`; `main.ts` boots Phaser scenes. Workspace search found no current `/shipmaker` route or Shipmaker implementation. The package declares Phaser `^4.2.1`, Vite scripts, `npm test` (`tsx --test`), and `npm run build`. The `prebuild` script regenerates the SVG manifest.

## Prerequisite Refactoring Proposal — Reconciled with Implementation State

This section distinguishes between **already implemented foundations** and **remaining integration work**. The implementation code at inspected HEAD `1c8dd23` (identical to audit baseline `74c6821`) has already completed the core data-model migration. Intervening commits changed documentation only. Do not re-implement these foundations.

### Implemented Foundations (do not re-implement)

| File | Current responsibility (implemented) | Verification |
|---|---|---|
| [ShipBlueprint.ts](../src/managers/ShipBlueprint.ts) | Blueprint catalogue with `id`/`sourceKey`; structured definitions include `hullId`/`loadoutId` canonical shape; `syncFromGame()` indexes legacy tuples. | `ship-blueprint.test.ts` — player catalogue registration, legacy tuple catalogue/init. |
| [ShipManager.ts](../src/managers/ShipManager.ts) | Blueprint registration, `createShip()`/`disposeShip()` centralized; resolves blueprint `hullId`/`loadoutId` through `Game` registries. | `ship-lifecycle.test.ts` — registration/queue/disposal/pooling; `ship-blueprint.test.ts` — source-key lookup. |
| [Game.ts](../src/core/Game.ts) | Owns canonical registries: `hullDefinitions`, `componentDefinitions`, `shipLoadouts`, `legacyCompatibilityViews`, `hullModificationDefinitions`; player hull/loadout registered in `loadGameData()`. | `ship-blueprint.test.ts` — player stats/components, canonical hull/loadout path. |
| [Ship.ts](../src/entities/Ship.ts) | `initCanonicalBlueprint()`: resolves hull/loadout via `Game`; builds parts from `HullDefinition`; materializes built-ins (validates, reserves point, `installationSource: 'built-in'`); installs loadout components (validates mount exists, component exists, compatibility); legacy paths (`initStructuredLegacyBlueprint`, `initLegacyTuple`) translate tuples and scale `×5` once. | `ship-blueprint.test.ts` — player runtime ship, stats, parts, components; `shipmaker-parity.test.ts` — canonical geometry, built-ins, invalid mounts, legacy coordinate conversion, legacy compatibility views. |
| [Component.ts](../src/entities/Component.ts) | `applyDefinition()`: typed `ComponentDefinition` → `effect` (`ManagedWeapon`/`Weapon`), `activeModuleRuntime`; stores `installationSource`, `fixed`, per-instance `turretAngleDeg`. | `shipmaker-parity.test.ts` — canonical PlayerCannon, built-in fixed/loadout distinction; `player-weapon.test.ts` — activation, cooldown, energy, attribution. |
| [Weapon.ts](../src/weapons/Weapon.ts) | `resolveMuzzles()` uses shared `WeaponTransform.resolveWeaponMuzzles()` for fallback `PhysicsProjectile` path; canonical definition provides `spinalWeaponDefinition`. | `weapon-transform.test.ts` — transform composition at cardinal angles; `player-weapon.test.ts` — legacy fallback firing. |
| [ManagedWeapon.ts](../src/weapons/ManagedWeapon.ts) | Delegates to `ProjectileManager.spawn()` with shared `WeaponTransform` resolution; captures `sourceEntityId`/`sourceFactionId` at fire time; velocity inheritance. | `player-weapon.test.ts` — managed multi-muzzle, attribution, velocity inheritance, energy/cooldown. |

`ModularHull.ts` is isolated (no runtime use) — leave unchanged. `publicSvgManifest.ts` is generated output — modify generator only when approved. `EntityManager`, `ProjectileManager`, `ObjectPool` — no changes needed.

### Remaining Integration Work (requires explicit approval)

| Area | Work |
|---|---|
| **Runtime validation & conversion boundary** | TypeScript types don't validate at runtime. Need validator/converter for imported/editor-authored definitions (schema + cross-ref: hullId exists, loadoutId exists, mountId in hull, componentId exists). |
| **Remaining legacy migration** | Migrate all structured/legacy blueprints (beyond player) to canonical `hullId`/`loadoutId`; `ShipDataAdapter.ingestLegacyData()` projects tuples but unconverted ships still use legacy path. Migration order in table below. |
| **Deterministic sprite composition helper** | Pure function producing visual descriptors from hull + component installations + per-instance turret state (no Phaser); used once in `Ship.init()`; not recomputed per frame. |
| **Ship-owned Phaser display-object lifecycle** | Ship owns composed display objects; scene provides attachment/body context; `main.ts` currently creates player/debug visuals. Preserve player/NPC lifecycle boundaries. |
| **Scene integration** | Connect Ship-owned composition to Phaser scene without merging player/NPC update/render/cleanup paths. |
| **External Lua parsing, loading, validation, persistence** | Restricted Lua subset, shared browser/Node parser, dev-server Save & Apply middleware, hot-reload, production build pipeline. See Revised Implementation Phases 2–5. |

### Migration Order (remaining)

1. **Runtime validator/conversion boundary** for imported/editor-authored records (separate from TypeScript types).
2. **Complete legacy migration** for all structured/legacy blueprints: convert each ship tuple to canonical `HullDefinition` + `ShipLoadout` + `ShipBlueprintDefinition`; register in `Game` registries; `ShipDataAdapter` projects unconverted tuples until individually migrated.
3. **Deterministic sprite composition helper** (pure, no Phaser) and **Ship-owned display-object lifecycle** (attachment, cleanup, add/remove operations refresh composition).
4. **Scene integration** for player/debug ships: supply scene context to Ship composition; preserve player queue separation; do not imply general NPC renderer.
5. **Keep adapters** until tests verify parity for all structured and tuple definitions; remove legacy support in separately approved migration.

The Lua parser and Shipmaker editor phases remain separate from these runtime foundations.

## Regression Test Matrix

### Existing Core Tests (Implemented, Verified)

| Existing file | Verified coverage in current suite |
|---|---|
| [ship-blueprint.test.ts](../tests/ship-blueprint.test.ts#L18) | Player catalogue registration; structured gameplay/visual separation; player stats/components; energy regeneration defaults; legacy ship tuple catalogue/init. |
| [player-weapon.test.ts](../tests/player-weapon.test.ts#L24) | Legacy weapon tuple values; passive tuple compatibility; failed/successful activation; energy/cooldown; failure without a Phaser scene. It does not verify physical projectile transforms at four rotations. |
| [projectile-manager.test.ts](../tests/projectile-manager.test.ts#L215) | Pool reuse/cleanup, scene shutdown, swept collision, faction/source attribution, velocity/direction and lifespan behavior. |
| [ship-lifecycle.test.ts](../tests/ship-lifecycle.test.ts#L42) | ShipManager registration/queue/disposal/pooling; legacy component rebuild; debug blueprint texture keys and lifecycle. |
| [public-svg-manifest.test.ts](../tests/public-svg-manifest.test.ts#L26) | SVG discovery, Planet exclusion, deterministic keys/URLs, aliases, collisions, and unchanged manifest writes. |
| [faction-manager.test.ts](../tests/faction-manager.test.ts#L617) | Shared ship queue, faction-aware targeting/relationships, spawn lifecycle, and disposal interactions. |
| [shipmaker-parity.test.ts](../tests/shipmaker-parity.test.ts#L18) | Legacy coordinate conversion (×5), canonical geometry, built-ins, invalid mounts, compatibility views. |
| [weapon-transform.test.ts](../tests/weapon-transform.test.ts#L18) | Transform composition at cardinal angles (0°, 90°, 180°, 270°); parent-to-child composition; multiple muzzle order/direction; empty muzzle-array origin fallback. |

These are not tests of the proposed editor/configuration architecture. Current test harnesses often bypass Phaser scene construction, so browser/render behavior remains unverified by these unit tests.

**Already covered by existing tests (do not re-add):**
- Legacy ×5 coordinate conversion (shipmaker-parity)
- Built-in reservation vs loadout distinction (shipmaker-parity)
- PlayerCannon canonical values and activation/cooldown/energy semantics (player-weapon)
- WeaponTransform resolution at cardinal angles, composition order, multiple muzzles, empty-array fallback (weapon-transform)
- ProjectileManager pool, cleanup, collision, attribution, velocity/direction, lifespan (projectile-manager)

### Required Tests for Prerequisite Refactoring (Runtime Foundations)

| Area | Required assertions |
|---|---|
| Definition ownership | Multiple blueprints select the same hull with distinct loadouts and ship-specific stats; loadouts contain no hull reference. |
| Generic hardpoints | Empty is valid; spinal-only, turret-only, and dual-compatible hardpoints accept correct configurations; incompatible assignments reject. |
| Validation | One duplicate-ID pass covers weapon points, vents, utility sockets, and active module mounts; the same namespace resolves built-ins and loadouts; unresolved IDs, duplicate assignments, invalid dimensions/angles/output, and sprite references are reported. |
| Built-ins | No built-in is synthesized; each `builtInComponentId` resolves from `Game.componentDefinitions`, validates against its exact point, is instantiated independently of an empty loadout, occupies/reserves the point, has source `built-in`, and rejects loadout replacement. |
| Component state/visuals | Two turret instances share definition but not angle; component-frame layers remain fixed; turret-frame layers explicitly rotate around the component-local pivot; limits/speed are finite, ordered, span at most 360°, `[350, 710]` initializes at `360°`, `[340, 350]` at `350°`, `[-350, -340]` at `-350°`, and `[10, 20]` at `10°`; angles stay unwrapped and muzzle offsets do not affect mechanical limits. **NEW: Turret mechanical-limit clamping/aiming/transforms not yet implemented — these assertions describe required behavior once implemented.** |
| Weapon transforms | Spinal attachment axis and per-muzzle direction; turret pivot-local barrel position, fixed barrel rotation, barrel-local muzzle position/direction, and world bore direction; offsets tested at nonzero ship/hardpoint rotations and at `0°`, `90°`, `180°`, `270°`. **NEW: Turret transforms require full pivot/barrel/muzzle resolution — currently only spinal path is implemented.** |
| Dimensions | Optional dimensions pass unconstrained points; empty supplied dimension/maximum objects reject; any active projected in-plane maximum requires both finite positive length and width; a height-only maximum requires only finite nonnegative height; partial maxima compare only specified axes; size projection does not claim containment/clearance for off-center datums. |
| Thrusters | Vent/category compatibility; built-in assignment resolves from canonical component data even for an empty loadout; output rejects NaN, infinity, and negatives. **Proposed (not yet implemented):** output cap enforcement, dimension checks against vent opening and component envelope. Exhaust visual rotation with ship/vent is metadata only. Movement output remains unchanged. |
| Legacy migration | Existing structured and tuple ships initialize; unconverted ship/component tuples remain authoritative and are projected without a duplicate cache; migrated records switch to Game-owned typed data; legacy part `×5` conversion occurs exactly once; pooled reuse rebuilds per-instance state. |
| Player cannon | Values, cooldown/energy semantics, origin/direction at four cardinal rotations, shooter-velocity inheritance, source/faction attribution, projectile pool/collision/cleanup remain unchanged. Preserve `range`/`splashRadius` data without adding absent gameplay mechanics. |
| Lifecycle | Player stays outside managed NPC queue and retains scene/input cleanup; NPC predefined loadout remains on ShipManager/queue lifecycle; Ship owns composition display objects while scenes provide their attachment/body context. |
| Rendering/assets | Empty hull sprite arrays are valid; hull/component layer IDs are definition-local with the reserved `legacy:` prefix unavailable to canonical IDs; layer orders may repeat; the five-key source/point/component/order/layer-ID sort is deterministic; the pure helper resolves once during `Ship.init()`; Ship owns display-object cleanup; turret changes update only rotating groups; Ship-owned add/remove refreshes composition; manifest keys validate without BootScene. |

**Note:** Items marked **NEW** above are not covered by existing tests and must be added as part of the prerequisite refactoring. Items not marked NEW are either already covered by existing tests (see "Already covered by existing tests" above) or describe behavioral requirements that must be verified once the implementation exists.

### Additional Future Shipmaker Tests (Editor/Configuration Architecture)

| Area | Required assertions |
|---|---|
| Lua validation | Schema-version validation; unified hull-local point IDs; duplicate IDs; invalid references; invalid dimensions, angular fields, or propulsion output; manifest-backed asset validation without BootScene. |
| Serialization | Deterministic output; no Phaser objects, classes, transient editor state, or base64 image data. |
| Round trip | Import exported hull/component/loadout Lua and reproduce equivalent normalized configuration. |
| Asset library | Discover/search/filter manifest metadata and validate keys before gameplay boot; reuse an asset across hulls/components without image duplication. |
| Editor preview | Numeric edits, snapping, layer order, fixed/rotating turret preview, occupied/empty point overlays, and coordinate updates. |
| Persistence actions | Save preview/display, copy, download, import, and validate do not silently mutate gameplay source files. |

Run the existing suite and production build after approved code changes: `npm test` and `npm run build`. The build's `prebuild` regenerates the SVG manifest, so report any generated-file delta and preserve user work. Browser-test the editor after a future editor phase; no test/build result is claimed by this documentation.

## Shipmaker Requirements (Future Work)

Shipmaker is a developer-only authoring tool at `/shipmaker`, not gameplay UI. Current `index.html` and `main.ts` have no such route. The editor must render a composition preview from definitions; it must not instantiate gameplay ships or combat entities.

### Four Primary Editing Areas

#### A. Hull Editor

- Define hull structure and visual layers.
- Place and configure weapon mounting hardpoints.
- Place and configure module mounting points (active module mounts).
- Define thruster vent positions.
- Configure each vent's exhaust direction relative to the hull.
- Define utility sockets for other hull-specific attachment points where required by the existing architecture.
- Define compatibility and mounting restrictions.
- Support other hull-specific attachment points where required by the existing architecture.

#### B. Ship Editor

- Define ship identity, name, category, and metadata.
- Retrieve and modify gameplay statistics.
- Store ship statistics in separate Lua ship-definition files.
- Reference the selected hull and loadout.
- Keep ship statistics independent of hull, weapon, and module definitions.

#### C. Component Editor

- Author reusable weapon and module definitions (weapons, propulsion, utility, active modules).
- Keep weapon and module data in their own separate Lua data domains.
- Preserve the distinction between static component configuration and specialized TypeScript behavior implementations (per [WEAPON-CONTENT-AND-BEHAVIOR-ARCHITECTURE.md](WEAPON-CONTENT-AND-BEHAVIOR-ARCHITECTURE.md)).

#### D. Ship Assembly Editor

- Select a reusable hull.
- Attach compatible weapons and modules to their mounting points.
- Configure equipment assignments.
- Assemble reusable ship blueprints and variations.

### Asset Library

- Browse discovered assets with thumbnails, search, and category filters.
- Assign multiple independent sprite layers to a central hull and each component.
- Reuse existing public SVG keys and Vite-supported source assets; do not duplicate image files or loaders.
- Validate public references against `publicSvgTextures` manifest metadata without booting gameplay; validate source references only against an explicitly supported source-asset catalog.

### Hull and Mount Authoring

- Select/edit hull identity, sprite layers, layer order, origin, scale, rotation, pan/zoom, grid, optional snapping, and numeric coordinates.
- Place generic weapon hardpoints and select spinal/turret/both compatibility, restrictions, and optional size limits.
- Place thruster vents with opening geometry, local exhaust direction, accepted categories, **proposed** optional output cap, **proposed** optional component envelope, and explicit optional fixed built-in.
- Place utility sockets with category acceptance and optional fixed built-ins.
- Place active module mounts with category acceptance and optional fixed built-ins.
- Display point occupancy and never make an ordinary hardpoint typed as permanently spinal or turret.

**Coordinate convention:** Until the approved `WeaponTransform` migration is implemented, authoring and editor preview must use the **current mount-local attachment convention**. Do not author component-local attachment-datum data yet; no adapter currently translates between the conventions. The component-local datum convention remains the proposed future target after the runtime migration.

### Component Authoring and Preview

- Create reusable component definitions with independent sprite collections and attachment data.
- Author spinal muzzles/directions and fixed layers; author turret pivot, limits, speed, barrels, muzzles, fixed layers, and rotating layers.
- Author propulsion category, finite nonnegative output, optional physical dimensions, and independent sprites.
- Author utility and active module categories with independent sprites.
- Preview component alignment, fixed/rotating groups, occupied/unoccupied hull points, and the **proposed target** component transforms (component-local attachment datum convention).
- No aiming AI, combat automation, movement simulation, or gameplay entities in editor preview.

**Coordinate convention:** Until the approved `WeaponTransform` migration is implemented, component authoring and editor preview must use the **current mount-local attachment convention**. Do not author component-local attachment-datum data yet; no adapter currently translates between the conventions. The component-local datum convention remains the proposed future target after the runtime migration.

## Lua Data Organization

The proposed data architecture must distinguish these domains:

| Domain | Responsibilities |
|---|---|
| Hulls | Physical structure, visual composition, mounting points (weapon hardpoints, thruster vents, utility sockets, active module mounts), exhaust directions |
| Ships | Identity, metadata, hull/loadout references, gameplay statistics |
| Weapons | Weapon configuration, firing parameters, visuals, registered behavior identifiers |
| Modules | Reusable module configuration and specialized properties (propulsion, utility, active modules) |
| Loadouts | Mounting-point-to-component assignments |

The same hull must be reusable by multiple ship definitions with different statistics and equipment configurations.

Do not put ship-specific gameplay statistics inside hull definitions.

Inspect the existing contracts in `src/types/Shipmaker.ts` before deciding exact schemas or file organization. Preserve existing architectural responsibilities and avoid redundant abstractions.

## Lua Source Location and Data Loading Architecture

**Placeholder:** `DATA_ROOT` denotes the authoritative Lua authoring root. The currently proposed development location is `public/data/`. This placeholder is used throughout phase descriptions, browser/Node responsibilities, development workflow, Save & Apply, and editor persistence destinations. The production distribution decision remains unresolved (see "Important: Production Distribution of Lua Source" below).

The **proposed** authoritative Lua authoring location during development is:

```
public/data/
```

An illustrative structure:

```
public/
└── data/
    ├── hulls/
    ├── ships/
    ├── weapons/
    ├── modules/
    └── loadouts/
```

These are separate data domains, not one combined definition file.

The documentation should explain why `public/data/` is a viable development location for Lua source files:

- Vite serves public assets directly during development.
- The browser can retrieve the definitions through HTTP requests in dev.
- The local development server can access these files for Shipmaker persistence (Save & Apply).
- The data remains separate from TypeScript gameplay implementation.
However, do not assume that Phaser can execute or interpret Lua files natively.

**Important:** The production distribution decision remains unresolved (see "Important: Production Distribution of Lua Source" below). If Alternative 3 is chosen, the authoritative source moves outside `public/` (e.g., `data/` at repo root) and is exposed only via the dev server endpoint. Do not describe `DATA_ROOT` as irrevocably settled while alternatives remain open. **All phase descriptions that reference `DATA_ROOT` are qualified as the proposed development authoring location, not a final decision.**

### Important: Production Distribution of Lua Source

Vite normally copies the entire `public/` directory into the production output unchanged. This has implications that must be resolved before production deployment:

**Unresolved Decision — Three Alternatives:**

| Alternative | Description | Implications |
|---|---|---|
| **Include Lua source in production** | Ship `public/data/` as-is to production. | Simple; Lua files publicly downloadable and inspectable. Source contents may reveal ship statistics, weapon balance values, and unreleased game content — not merely the authoring structure. No runtime execution risk since the browser does not execute Lua. |
| **Exclude Lua source from production** | Configure a custom build strategy to omit `public/data/` while retaining other public assets (e.g., a Vite plugin that filters the public directory copy, or a post-build cleanup step). Vite's `build.copyPublicDir: false` disables copying the **entire** public directory; it cannot selectively exclude a subdirectory. This Vite-specific limitation applies only when `DATA_ROOT` is located under `public/`. | Cleaner production bundle; requires custom build config. Source remains only in repo. |
| **Move authoritative source outside `public/`** | Keep authoritative Lua under e.g. `data/` (repo root) and expose via dev server endpoint only. | Cleanest separation; dev server reads/writes `data/`; production build reads `data/` at build time, never ships source. The `build.copyPublicDir` limitation does not apply because the source is outside `public/`. Requires dev server middleware and build script changes. |

**Do not unilaterally change the proposed source location.** Record the alternatives and their implications here. The decision affects dev server design, build pipeline, and whether production clients can fetch Lua over HTTP.

### Browser and Node Responsibilities

The division of labor between browser and Node environments must be explicit. **Use a single shared Lua parser and validation core** wherever technically possible; separate only the I/O layer.

| Responsibility | Environment | Notes |
|---|---|---|
| **Lua parsing, schema validation, typed runtime conversion** | **Browser-safe TypeScript** (bundled into Phaser runtime) | Must not use Node APIs (`fs`, `path`, etc.). Runs in browser during development to load definitions from HTTP responses. **Shares the same parser/validator core as Node.** |
| **Development-server file read/write (Save & Apply)** | **Node (Vite dev middleware / custom endpoint)** | `fs` access to `DATA_ROOT`; invokes shared parser/validator core before write; triggers hot-reload. Never bundled into browser. |
| **Build-time parsing and production-ready data generation** | **Node (build script / Vite plugin)** | Runs at `npm run build`; reads authoritative Lua via `fs`, invokes shared parser/validator core, emits runtime-ready JSON/TS modules for production bundle. |

The browser must not directly access the filesystem. Do not put filesystem write functionality into the Phaser runtime bundle. **Do not introduce two independently maintained parsers that might produce different interpretations of the same Lua definitions.** Separate environment-specific I/O (HTTP `fetch` in browser, `fs` in Node) from the shared parsing and validation logic.

**Development-only security boundaries for the Save & Apply endpoint:**
- Localhost-only binding (bind to `127.0.0.1`, not `0.0.0.0`). This is separate from origin validation.
- Origin/request validation: verify the `Origin` header and `Host` header match the actual configured development-server origin (e.g., `http://localhost:5173`). **Do not use wildcard matching** such as `http://localhost:*`. Reject requests with unexpected or missing origins/hosts.
- Path restrictions: canonicalize and verify target path stays within `DATA_ROOT` (or `data/` if Alternative 3 chosen); reject path traversal (`..`, symlinks).
- HTTP method restriction: `POST`/`PUT` only; no `GET` for writes.
- Request body validation: parse as Lua data format, validate schema before write.
- No arbitrary Lua execution: parser must be restricted/data-oriented.
- Per-server CSRF token for mutating requests (optional but recommended).
- Endpoint registered only in development mode (`import.meta.env.DEV` or `mode === 'development'`).

Keep the security design proportionate to a local development tool — no over-engineering, but no gaping holes.

### Runtime loading infrastructure

The `src/` directory should own the TypeScript infrastructure responsible for:

- Retrieving Lua source definitions (via HTTP `fetch` in browser; via `fs` in Node build script).
- Parsing the supported Lua data format (browser-safe parser).
- Validating definitions and cross-references.
- Converting parsed definitions into typed runtime data (the contracts in `src/types/Shipmaker.ts`).
- Registering validated data with the existing Game registries and relevant managers.
Do not introduce a parallel registry or duplicate existing manager responsibilities.

### Development workflow

During development:

1. The game retrieves definitions from `DATA_ROOT` via HTTP.
2. The browser-safe loading infrastructure parses and validates them.
3. Validated definitions become available to the existing runtime registries.
4. Shipmaker retrieves existing definitions for editing (via HTTP).
5. Shipmaker validates modifications and previews the changes.
6. After explicit confirmation, Shipmaker calls the development-server Save & Apply endpoint (Node middleware).
7. The endpoint validates, writes updated Lua source files to `DATA_ROOT`, and signals reload.
8. The development environment reloads the affected definitions (hot-reload) or restarts the game when necessary.

### Production workflow

Investigate and document a suitable build-time pipeline:

`Lua source (repo) → Node parser/validator → Runtime-ready generated data (JSON/TS modules) → Production bundle`

The production game should consume validated runtime-ready data rather than relying on arbitrary Lua execution in the browser.

Do not assume that Vite automatically converts `.lua` files into TypeScript or JavaScript. Explain the required parsing/build integration and identify unresolved implementation choices.

## Save & Apply

The editor must retrieve, modify, validate, save, and apply Lua definitions.

JSON export followed by manual copying must no longer be the primary persistence workflow. JSON may still be used internally for interchange, debugging, or backups.

**Persistence test expectations:**

Ordinary preview, validation, import, and export operations must not silently modify source files. They operate on in-memory representations only.

**Explicit Save & Apply is the intentional exception:**

- Requires explicit user confirmation (e.g., a modal "Save Changes" action).
- Validates the complete change set before any write (schema + cross-reference checks).
- Writes only approved Lua definition files to the authorized directory (`DATA_ROOT` or `data/` per distribution decision).
- Rejects out-of-scope paths (path traversal, symlinks, directories outside allowlist).
- Failed validation or failed writes must not leave partial modifications (atomic write, `.bak` retention, rollback).

Document a safe Save & Apply design covering:

- Localhost-only development access (bind to `127.0.0.1`, not `0.0.0.0`).
- A development-server endpoint or middleware for file operations (Node-only, never bundled).
- Strict write access to approved `DATA_ROOT` directories (or `data/` if Alternative 3 chosen).
- Validation before writing (schema + cross-reference checks).
- Cross-reference and mounting compatibility checks (loadout mountId exists in hull, componentId exists in componentDefinitions, etc.).
- Previewing the proposed changes before applying them (diff view, validation summary).
- Safe file replacement, backup, and recovery considerations (atomic write, `.bak` retention, rollback).
- Reloading updated definitions into the development environment (hot-reload signal or full restart).
- Prevention of path traversal and arbitrary filesystem access (canonicalize, verify within allowlist).
- No unrestricted Lua execution or arbitrary script side effects (restricted parser only).
- No production exposure of file-writing endpoints (guarded by `import.meta.env.DEV` / Vite `mode === 'development'`).
- Origin/request validation on the endpoint: verify the exact configured development-server origin and the expected request Host; reject unexpected or missing origins for browser-based mutating requests; never use wildcard origin matching.
- Per-server CSRF token for mutating requests (optional but recommended).
Prefer a constrained static Lua data format that can be parsed and serialized safely. Do not prematurely select a parser or implementation library without examining project compatibility.

## Architecture and Existing Responsibilities

Preserve the current architecture's ownership boundaries.

In particular:

- Game owns the existing canonical definition registries.
- ShipManager remains responsible for ship catalogue and creation responsibilities.
- EntityManager and other existing managers retain their established responsibilities.
- Weapon behavior implementations remain registered TypeScript functionality (see [WEAPON-CONTENT-AND-BEHAVIOR-ARCHITECTURE.md](WEAPON-CONTENT-AND-BEHAVIOR-ARCHITECTURE.md)).
- Lua files describe static data and configuration, not arbitrary executable gameplay logic.
- Existing weapon/component compatibility rules must remain authoritative.
- Hull geometry, ship statistics, equipment definitions, and loadout assignments must remain separate concerns.
Inspect the existing types in `src/types/Shipmaker.ts` before recommending structural changes. Do not replace existing specialized mounting-point contracts with a generic abstraction unless the current architecture demonstrates a concrete need.

## Revised Implementation Phases

Revisit the existing implementation phases to account for correct dependency ordering. Save & Apply infrastructure must exist before editors that persist Lua.

### Shared Data Infrastructure and Build Integration

| Phase | Work | Dependencies |
|---|---|---|
| **1. Data-model foundations (already implemented)** | Typed contracts in `src/types/Shipmaker.ts`; `Game` registries (`hullDefinitions`, `componentDefinitions`, `shipLoadouts`); `Ship.init()` canonical hull/loadout path. | — |
| **2. Lua data format & parser** | Select restricted Lua subset; implement a single shared browser-safe parser and validation core; schema validation against Shipmaker.ts contracts. | Phase 1 |
| **3. Validation & typed runtime conversion** | Cross-reference validation (hullId, loadoutId, componentId, mountId); conversion to typed runtime records; registration with `Game` registries. | Phase 2 |
| **4. Dev-server read/write & Save & Apply** | Vite dev middleware/endpoint for `DATA_ROOT` (or `data/`); validation before write; atomic write/backup; hot-reload signal; localhost/origin/path security. | Phase 3 |
| **5. Production build integration** | Node build script: read authoritative Lua → parse/validate (using shared parser/validator core) → emit runtime-ready JSON/TS modules → bundle. | Phase 3 + resolution of production Lua distribution decision (see "Important: Production Distribution of Lua Source") |

### Shared Data Infrastructure and Build Integration — Clarification

- Phases 2–4 establish the shared parsing, validation, runtime conversion, and development persistence infrastructure.
- Phase 5 establishes production build integration.
- Phase 5 can proceed independently after Phase 3 and the production Lua distribution decision are resolved.
- Production build integration is not a prerequisite for developing the local Shipmaker editor.

### Editor-Specific UI Work (depend on shared infrastructure)

| Phase | Work | Dependencies |
|---|---|---|
| **6. `/shipmaker` workspace & asset library** | Route, editor shell, asset browser using `publicSvgManifest.ts` metadata. | Phase 4 (read) |
| **7. Hull Editor** | Hardpoints, vents, utility sockets, active module mounts, sprites, exhaust direction; persists to `DATA_ROOT/hulls/`. | Phase 4 (read/write), Phase 6 |
| **8. Ship Editor** | Identity, stats, hull/loadout references; persists to `DATA_ROOT/ships/`. | Phase 4 (read/write), Phase 6 |
| **9. Component Editor** | Weapons, propulsion, utility, active modules; persists to `DATA_ROOT/weapons/`, `DATA_ROOT/modules/`. | Phase 4 (read/write), Phase 6 |
| **10. Ship Assembly Editor** | Select hull, attach components to mounts, author loadouts; persists to `DATA_ROOT/loadouts/`. | Phases 7, 8, 9, Phase 4 (read/write) |

### Verification

| Phase | Work | Dependencies |
|---|---|---|
| **11. Verification & architectural tests** | Regression matrix (existing + new), browser editor testing, production build verification. | All prior |

These are proposed phases, not a declaration that implementation is already complete.

Reconcile the phases with existing completed work rather than blindly replacing the entire roadmap. Record dependencies and identify which milestones can proceed independently.

**Key dependency insight:** Phases 2–4 establish the shared parsing, validation, runtime conversion, and development persistence infrastructure. Phase 5 (production build integration) depends on Phase 3 and the production Lua distribution decision — it does not inherently require Phase 4 (dev-server Save & Apply) to complete; Phase 5 may proceed independently once its shared validation foundation and the distribution decision are available. Phases 6–10 are editor UI: Phase 6 depends on Phase 4 (read); Phases 7–10 additionally depend on Phase 4 (write) for persistence. Do not duplicate parsing, validation, or persistence logic in each editor — they must share the infrastructure from Phases 2–4.

## Documentation Quality Requirements

The revised documents must clearly explain:

- The purpose and boundaries of `/shipmaker`.
- The responsibilities of each editor area.
- The separation of hulls, ships, weapons, modules, and loadouts.
- The location and organization of Lua source files.
- The relationship between Lua source, TypeScript loading infrastructure, and runtime registries.
- Development and production data-loading workflows.
- The Save & Apply persistence mechanism.
- Security boundaries of the development-only file-writing endpoint.
- What is implemented, what remains planned, and what still requires architectural decisions.
Avoid presenting recommendations as existing functionality.

Do not introduce implementation details that contradict the current repository.

## Completion Report

After editing:

- List every modified documentation file.
- Summarize the important architectural decisions.
- Explain the proposed Lua parsing and loading pipeline.
- Identify unresolved technical questions.
- Summarize revised implementation phases.
- Confirm that no source code, configuration, dependency, or test files were modified.
- Confirm that no unrelated documentation was changed.
Do not stage, commit, or push any changes.

## Decisions and Open Questions

### Settled Contract

- `Game` owns canonical typed hull/component/loadout definitions; the blueprint alone selects `hullId` and `loadoutId`, and the loadout contains installations only. ShipManager remains the catalogue/creation owner and Ship.init materializes installations.
- Hull hardpoints are generic, empty unless explicitly assigned, and share a hull-local point-ID namespace with vents, utility sockets, and active module mounts. Explicit fixed built-ins resolve independently of loadouts and reserve their point.
- Component dimensions are optional when unconstrained; full-envelope projection validates only specified size limits and does not establish off-center containment or clearance. PlayerCannon dimensions remain unknown.
- Turret limits are unwrapped single-turn azimuth intervals; each installation owns its angle, while fixed barrel/muzzle offsets affect bore direction only. No aiming behavior is specified.
- Visual composition is derived, deterministically ordered, and owned by Ship for display-object lifecycle. Existing movement, player/NPC lifecycle, and ProjectileManager ownership remain unchanged.
- Public asset-key discovery and validation use generated manifest metadata without requiring BootScene. No additional manager, registry, or loader is proposed.
- Lua source files use the **proposed development authoring location** `DATA_ROOT` with separate directories per domain; production distribution decision unresolved (see "Important: Production Distribution of Lua Source").
- TypeScript loading infrastructure in `src/` parses, validates, and registers Lua definitions.
- Save & Apply uses a development-only server endpoint with strict path restrictions.
- Weapon behavior implementations remain TypeScript; Lua references behavior IDs.

### Items for Later Implementation Review

- The exact schema versioning/migration policy and Lua file layout remain undecided until the serializer phase.
- Existing data has no verified physical size for PlayerCannon or vent/component dimensions; omit unknown values. If future physical-clearance checks are required, author local footprint bounds/offsets separately from full extents.
- No source assets currently exist in `src/assets/Components`; decide whether that catalog is supported only when a concrete workflow requires it.
- General NPC rendering, Phaser body setup, combat, and aiming are not part of the approved prerequisite scope and need their own design/approval if later required.
- The current runtime does not make `range` or splash radius operative for the PlayerCannon projectile path; changing that would be a gameplay feature requiring separate approval.
- Keep utility sockets and active module mounts category-only until a concrete component requirement justifies additional restrictions or runtime behavior.
- The restricted Lua subset and parser library have not been selected; this requires compatibility evaluation.
- The production build-time pipeline for Lua → runtime data needs concrete design.
- Cross-domain reference validation (e.g., loadout mountId exists in hull, componentId exists in componentDefinitions) strategy needs design.

## Handoff Guidance for Future AI Agents

### DeepSeek / Independent Architecture Reviewer

- Review-only unless separately authorized: verify every claim against the current checkout; review ownership boundaries, type unions, coordinate mathematics, transform consistency, dimensions, validation, and regression risks.
- Identify inconsistencies and recommend the smallest correction. Do not edit source code or infer permission from this handoff.

### Qwen Coder / Implementation Agent

- Read this handoff, current source, `QWEN.md`, `CLAUDE.md`, `ARCHITECTURE.md`, and applicable conventions before work.
- Confirm branch, HEAD, worktree status, and current line references. This document may become stale.
- Use Phaser 4 APIs only; preserve current manager/queue/registry ownership; add no parallel manager or duplicate asset pipeline.
- Implement only the explicitly approved phase and files. Ask again if implementation requires broader scope.
- Add meaningful focused tests, run `npm test` and `npm run build` when authorized, and report exact results. Never claim unrun tests or builds passed.
- Treat this document as a specification proposal, not authorization for prerequisite code or Shipmaker implementation.

## Final Approval Boundary

At this handoff's creation, distinguish between:

**Already implemented foundations (do not re-implement):**
- Typed contracts in `src/types/Shipmaker.ts` (`HullDefinition`, `ComponentDefinition`, `ShipLoadout`, `ShipBlueprintDefinition`, validation primitives).
- `Game` canonical registries: `hullDefinitions`, `componentDefinitions`, `shipLoadouts`, `legacyCompatibilityViews`, `hullModificationDefinitions`.
- `Ship.init()` canonical path resolving `hullId`/`loadoutId` through `Game` registries, materializing built-ins and loadout installations.
- `ShipDataAdapter.ingestLegacyData()` projecting legacy tuples into compatibility views.
- Player hull, `PlayerCannon` component, and player loadout registered as typed records in `Game.loadGameData()`.

**Remaining prerequisite architecture work (requires explicit approval):**
- Complete legacy migration for all structured/legacy blueprints (migration order in Prerequisite Refactoring Proposal).
- Runtime validator/conversion boundary for imported/editor-authored records (TypeScript types don't validate at runtime).
- Full cross-reference validation across registries (hullId exists, loadoutId exists, mountId exists in hull, componentId exists, etc.).
- Sprite composition helper and Ship-owned Phaser display object lifecycle (currently `main.ts` creates player/debug visuals).

**Lua parsing/loading/persistence work (NOT implemented):**
- Restricted Lua subset selection and parser library evaluation.
- Single shared browser-safe Lua parser and validation core (used by both browser HTTP fetch and Node fs I/O).
- Schema validation against Shipmaker.ts contracts.
- Dev-server Save & Apply middleware (Node-only, localhost/origin/path security).
- Hot-reload / restart integration.
- Production build-time pipeline (Lua → runtime-ready generated data).

**Shipmaker editor functionality (NOT implemented):**
- `/shipmaker` route, workspace, asset library.
- Hull, Ship, Component, Assembly editors.
- Lua persistence from editors via Save & Apply endpoint.

The next implementation step follows the revised dependency order in **Revised Implementation Phases** and still requires explicit approval at each phase. Do not start Phase 2 without approval. Phase 6 may proceed after Phase 4 read capability is available. Phases 7–10 require Phase 4 read/write capability where they persist authored definitions. Do not require Phase 4 write capability before beginning the read-only workspace and asset library.