# Shipmaker Architecture Handoff

## Purpose and Status

This document is a self-contained architectural handoff for a future developer-only Shipmaker editor at `/shipmaker`. It records the current repository as inspected on 2026-11-01, separates verified behavior from proposed architecture, and defines the compatibility work that must be reviewed before implementation.

**This is a proposal, not an implementation authorization.** The HullDefinition / ComponentDefinition / ShipLoadout design is specified, but prerequisite refactoring has not been implemented. Shipmaker, player loadout UI, and the JSON serializer have not been implemented. Any agent must receive explicit approval for prerequisite code changes and separate approval at each implementation phase.

## Inspected Repository Snapshot

| Item | Inspected value |
|---|---|
| Repository | `Arcyriea/Redemptis-Tiariea` |
| Date inspected | 2026-11-01 |
| Branch | `main` |
| Local HEAD | `84259b5a1fcfef2b9041c81f5d4fb959e5e8fc93` |
| HEAD commit | `Submit handoff for future AIs agents that will work on the Shipmaker.` |
| Local worktree | Clean at the recorded inspection snapshot before handoff edits; later documentation-only changes are not represented by this historical status. |
| Remote comparison | Local HEAD and live `git ls-remote origin refs/heads/main` both resolved to `84259b5a1fcfef2b9041c81f5d4fb959e5e8fc93` during this reconciliation. |

The remote reference was checked directly, not inferred from a stale local tracking ref. No local/remote discrepancy was found. The prior handoff snapshot at `4933ceca...` preceded the commit that added this document; the intervening commit changed `.gitignore` and added the handoff, not gameplay source. The tracked handoff is not currently ignored.

## Project Instructions and Architecture

- [ARCHITECTURE.md](../ARCHITECTURE.md) describes the Phaser 4.2.1 project structure, `Game` loop, entities, `EntityManager`, the shared `Game.shipQueue`, and the entity contract. It requires preserving manager boundaries and the shared queue.
- [QWEN.md](../QWEN.md) requires Phaser 4 APIs, repository architecture compliance, and scope control. It points to the global Qwen conventions file.
- [CLAUDE.md](../CLAUDE.md) requires following architecture and conventions, preserving manager responsibilities, and not treating `QWEN.md` as Claude-specific instructions.
- The global Claude and Qwen `CONVENTIONS.md` files were inspected. No repository-local `CONVENTIONS.md` was found. The conventions require narrow changes, tests for behavior, no dependency additions without approval, and respecting approval boundaries.
- [MANAGER-PLAN.md](../MANAGER-PLAN.md) is a future architecture proposal. It mentions a possible `WeaponManager`, but no such manager exists in the implementation inspected here. Do not create it merely because it appears in the plan.

## Current Architecture

### Data Ownership and Blueprints

The runtime data is presently authored inline in `Game.loadGameData()` rather than loaded from JSON. `Game` exposes permissive `shipData`, `partData`, and `componentData` registries. `loadGameData()` clears `shipData`, defines a single `PlayerCannon` tuple in `componentData`, registers the structured player blueprint, then indexes any remaining legacy ship data through `ShipManager.syncFromGame()` ([Game.ts](../src/core/Game.ts#L29), [Game.ts](../src/core/Game.ts#L101), [ShipBlueprint.ts](../src/managers/ShipBlueprint.ts#L3)).

`ShipBlueprintDefinition` currently combines ship identity/classification, ship statistics, gameplay parts, component-by-part attachments, and whole-ship visual sprites. `ShipBlueprint` is a stable catalogue entry with `id` and `sourceKey`; it may own a structured definition or resolve a legacy tuple from `Game.shipData` ([ShipBlueprint.ts](../src/managers/ShipBlueprint.ts#L37), [ShipBlueprint.ts](../src/managers/ShipBlueprint.ts#L52), [ShipBlueprint.ts](../src/managers/ShipBlueprint.ts#L66)).

`ShipManager` owns blueprint registration and source-key lookup, indexes legacy keys, and provides centralized creation and disposal for ordinary managed ships. Its `createShip()` acquires from `ObjectPool`, assigns faction and position, registers with `EntityManager`, applies options, and inserts into `Game.shipQueue`; `disposeShip()` removes from the queue, unregisters, clears faction, and returns the ship to the pool ([ShipManager.ts](../src/managers/ShipManager.ts#L22), [ShipManager.ts](../src/managers/ShipManager.ts#L39), [ShipManager.ts](../src/managers/ShipManager.ts#L130), [ShipManager.ts](../src/managers/ShipManager.ts#L163), [ShipManager.ts](../src/managers/ShipManager.ts#L251)).

`ShipBlueprintStats` is applied directly to a `Ship` and currently combines physical-looking values (`weight`, `radius`, `maxHull`) with ship-specific gameplay values (speed, acceleration, energy, shell, credits/value). The repository does not establish that these values are inherent to a physical hull. The proposed design therefore keeps all existing stats on `ShipBlueprint`; it does not migrate them wholesale into `HullDefinition` ([ShipBlueprint.ts](../src/managers/ShipBlueprint.ts#L3), [Ship.ts](../src/entities/Ship.ts#L172)).

### Ship Initialization and Lifecycle

`ObjectPool.getShipObject(type)` calls `Ship.init(type)` on new and reused ships. `Ship.init()` first resolves a structured blueprint using the `ShipManager` source-key catalogue, otherwise it reads a legacy tuple from `Game.shipData`. Structured components attach by `partIndex`; legacy tuples encode component names for each part. Parts are constructed with `x` and `y` multiplied by five, and components are initialized against the resulting part object ([ObjectPool.ts](../src/core/ObjectPool.ts#L25), [Ship.ts](../src/entities/Ship.ts#L81), [Ship.ts](../src/entities/Ship.ts#L91), [Ship.ts](../src/entities/Ship.ts#L134), [Ship.ts](../src/entities/Ship.ts#L147)).

The ordinary NPC path is `Game` spawn queue → `ShipManager.createShip()` → `ObjectPool.getShipObject()` → `Ship.init()` → `EntityManager` registration and `Game.shipQueue` insertion. `Game.update()` updates managed ships through `shipQueue`, processes projectile lifecycle, then processes spawn and respawn queues ([Game.ts](../src/core/Game.ts#L156), [Game.ts](../src/core/Game.ts#L188), [Game.ts](../src/core/Game.ts#L223), [Game.ts](../src/core/Game.ts#L248)). `processSectorShips()` converts sector ship rows to spawn queue entries; `clearCurrentSector()` clears queues, registries, pools, and managed projectiles ([Game.ts](../src/core/Game.ts#L324)).

The player deliberately follows a different path in `GameScene`: it creates a Phaser container/body, acquires its logical `Ship` directly from the object pool, sets its faction and Phaser references, and registers it with `EntityManager` without inserting it into `Game.shipQueue`. Each frame, Phaser container state is synchronized to the logical ship; player weapon cooldowns and activation are driven by the scene. Shutdown returns the player to the pool and unbinds the projectile manager ([main.ts](../src/main.ts#L283), [main.ts](../src/main.ts#L344), [main.ts](../src/main.ts#L380), [main.ts](../src/main.ts#L487)).

Debug NPC ships are another distinct path. `main.ts` temporarily registers test blueprints through `ShipManager`, creates ships through `ShipManager.createShip()`, then creates scene-owned visual containers and synchronizes them to logical ships. These are debug/test visuals, not a general NPC rendering pipeline ([main.ts](../src/main.ts#L540), [main.ts](../src/main.ts#L584), [main.ts](../src/main.ts#L633)). `TestAllyManager` similarly registers temporary definitions and uses `ShipManager` for ordinary managed lifecycle ([TestAllyManager.ts](../src/managers/Test/TestAllyManager.ts#L43), [TestAllyManager.ts](../src/managers/Test/TestAllyManager.ts#L202), [TestAllyManager.ts](../src/managers/Test/TestAllyManager.ts#L279)).

### Components, Weapons, and Projectiles

`Component.init()` reads `Game.componentData[name]`, interprets its tuple, and constructs either `ManagedWeapon` when `ProjectileManager` is available or `Weapon` otherwise. A component retains a ship and a `shipPart`, but has no mount identity, compatibility validation, installation origin, sprite collection, or per-instance turret state ([Component.ts](../src/entities/Component.ts#L11), [Component.ts](../src/entities/Component.ts#L47), [Component.ts](../src/entities/Component.ts#L59)).

`Weapon.init()` reads the same tuple to set firing mode and weapon values. `Weapon.activate()` dispatches by firing mode. Its Arcade path converts `Ship.rotation` from degrees to radians, rotates the attached part offset to compute projectile origin, and uses the ship angle for direction. `ManagedWeapon` duplicates the part-offset transform and delegates projectile creation to `ProjectileManager` ([Weapon.ts](../src/weapons/Weapon.ts#L29), [Weapon.ts](../src/weapons/Weapon.ts#L49), [Weapon.ts](../src/weapons/Weapon.ts#L85), [ManagedWeapon.ts](../src/weapons/ManagedWeapon.ts#L18)).

When a `ProjectileManager` exists, `Component` prefers `ManagedWeapon`. `ManagedWeapon` snapshots source entity ID and faction at firing time and calls `ProjectileManager.spawn()`. The manager owns scene binding, pooling, velocity initialization, attribution retention, lifespan, swept collision/damage, cleanup, and scene shutdown handling. It does not own weapon energy/cooldown or register projectiles in `EntityManager` ([ProjectileManager.ts](../src/managers/ProjectileManager.ts#L9), [ProjectileManager.ts](../src/managers/ProjectileManager.ts#L44), [ProjectileManager.ts](../src/managers/ProjectileManager.ts#L76), [ProjectileManager.ts](../src/managers/ProjectileManager.ts#L117), [ProjectileManager.ts](../src/managers/ProjectileManager.ts#L266), [ProjectileManager.ts](../src/managers/ProjectileManager.ts#L323)).

`PlayerCannon` currently has damage `10`, firing mode `ProjectileArcade`, range `400`, cooldown `0.15` seconds, energy cost `5`, projectile speed `600`, and splash radius `0`. `Component.activate()` spends energy and starts cooldown only after successful activation. The `ProjectileSpawnConfig` does not carry weapon range or splash radius, and collision applies direct damage; those tuple values are not currently used to provide range/splash gameplay. The refactor must retain the data values without claiming new behavior for them ([Game.ts](../src/core/Game.ts#L110), [Component.ts](../src/entities/Component.ts#L130), [ProjectileManager.ts](../src/managers/ProjectileManager.ts#L9)).

### Entity, Pool, and Modular Hull Boundaries

`EntityManager` is a reference registry and stable-ID allocator. It does not create, render, move, or dispose ships. `ObjectPool` owns ship/component/effect/resource/power-up reuse; it calls ship initialization on acquisition and resets/disposes pooled objects ([EntityManager.ts](../src/managers/EntityManager.ts#L22), [EntityManager.ts](../src/managers/EntityManager.ts#L42), [ObjectPool.ts](../src/core/ObjectPool.ts#L8), [ObjectPool.ts](../src/core/ObjectPool.ts#L25), [ObjectPool.ts](../src/core/ObjectPool.ts#L50)).

`ModularHull.ts` defines `HullSection`, `HullSectionDef`, and a separate `Hardpoint` model. Its hardpoints are already assigned `weapon` or `ability` types and carry combat stats/cooldown. Repository search found no constructor/use sites for these classes; they are not consumed by `Ship`, `Component`, `Weapon`, or projectile spawning. Keep this isolated implementation unchanged during prerequisite refactoring unless later usage evidence supports a safe migration ([ModularHull.ts](../src/entities/ModularHull.ts#L3), [ModularHull.ts](../src/entities/ModularHull.ts#L17), [ModularHull.ts](../src/entities/ModularHull.ts#L84), [ModularHull.ts](../src/entities/ModularHull.ts#L98)).

`MANAGER-PLAN.md` describes a possible future `WeaponManager`; this is not an implemented manager. Do not add a parallel manager or move projectile ownership out of `ProjectileManager` as part of this design.

## Current Versus Proposed Compatibility

| Concern | Current implementation | Compatibility | Prerequisite change |
|---|---|---|---|
| Ship catalogue | `ShipBlueprint` indexes structured definitions and legacy `Game.shipData` tuples. | PARTIALLY COMPATIBLE | Preserve the catalogue and provide compatibility resolution for hull/loadout IDs. |
| Hull identity/geometry | Player/debug definitions include gameplay parts; no reusable hull registry. | INCOMPATIBLE | Add `HullDefinition` for shared geometry, sprites, and installation points. |
| Generic weapon hardpoints | No runtime hardpoint abstraction in the ship path; `ModularHull` has disconnected typed points. | INCOMPATIBLE | Add generic hull hardpoints with explicit accepted weapon configurations. |
| Empty/loadout assignment | Current player blueprint directly attaches a cannon to part index zero. | PARTIALLY COMPATIBLE | Move player-selectable installations into explicit `ShipLoadout`; empty mounts remain empty. |
| Component definitions | Tuple registry provides categories and some operation values. | PARTIALLY COMPATIBLE | Add typed, reusable `ComponentDefinition`, independent visuals, geometry, attachment data, and optional dimensions. |
| Spinal/turret models | No spinal/turret distinction in component mount semantics, pivots, limits, or barrel/muzzle data. | NOT IMPLEMENTED | Add discriminated component configurations; hull points remain generic and declare compatibility. |
| Built-in components | No built-in assignment or installation-origin distinction. | NOT IMPLEMENTED | Support explicit fixed built-ins on a compatible hull point; never auto-fill. |
| Thruster vents | No vent or propulsion component model; movement is independent. | NOT IMPLEMENTED | Add vent and propulsion metadata/validation only; do not alter movement. |
| Component/hull visuals | Whole-ship visual sprite lists exist; components do not own visual layers. | PARTIALLY COMPATIBLE | Separate reusable hull and component sprite collections, retaining texture keys. |
| Coordinate handling | Part offsets scale by five; both firing paths rotate the part offset by ship rotation. | PARTIALLY COMPATIBLE | Convert legacy offsets once and use a common mount/component/muzzle transform. |
| Versioned authoring JSON | No JSON schema, validator, serializer, or import/export boundary. | NOT IMPLEMENTED | Future serializer boundary must validate portable versioned data; not part of prerequisite code. |
| Player/NPC lifecycles | Separate player and managed NPC paths already work. | COMPATIBLE WITH DATA ADAPTER | Resolve common definitions without merging their registration, update, render, or cleanup paths. |
| Projectile lifecycle | `ProjectileManager` owns pooling, attribution, collision, lifespan, and cleanup. | COMPATIBLE | Preserve ownership and verify spawn transform integration only. |

## Proposed Data Ownership

- **Game:** remains the authoritative owner of canonical typed `hullDefinitions`, `componentDefinitions`, and `shipLoadouts`. Extend the existing game-data ownership rather than introducing a manager or parallel registry. Existing `shipData` and `componentData` remain legacy inputs/adapters only until migration is verified; they must not compete as a second canonical source.
- **ShipManager:** retains the ShipBlueprint catalogue, including ID/source-key indexes and ordinary ship creation/disposal. It resolves a blueprint’s `hullId` and `loadoutId` through `Game`, not a new manager or parallel registry.
- **ShipBlueprintDefinition:** remains a plain data contract for ship-specific identity, classification, stats, and hull/loadout references. It does not own hull/component sprite definitions.
- **ShipBlueprint:** remains the catalogue wrapper with registration identity and one reference to its structured definition, or the established legacy-resolution mechanism. There is one authoritative structured definition per blueprint; do not copy it into a second registry.

The Game registries own shared configuration records; a blueprint owns its ship-specific record; the ShipManager indexes wrappers and resolves references. This keeps hull geometry reusable across blueprints/loadouts and preserves existing manager boundaries.

### Legacy Compatibility Boundary

During migration, each unconverted legacy `Game.shipData` ship tuple and `Game.componentData` component tuple remains the authoritative source for that entry. A temporary adapter projects the tuple values into the shape consumed by the new initialization/composition path; that projected view is ephemeral adapter output, not a second canonical definition registry or cache. `ShipManager` remains the blueprint catalogue owner, and its legacy resolution continues to consult the existing source rather than retaining a competing copy. Existing structured entries remain authoritative in their current form until individually migrated. Once an entry is migrated, the corresponding structured hull/component/loadout records owned by `Game` become its canonical source. Preserve both paths until tests verify parity.

## Proposed Three-Definition Architecture

The following TypeScript is an architectural contract, not current source code. Runtime validation is required for imported or editor-authored records because TypeScript types do not validate JSON at runtime.

### Shared Primitives and Built-Ins

```ts
type Point2 = { x: number; y: number };

interface Dimensions {
  length?: number; // full envelope extent along component-local +X
  width?: number;  // full envelope extent along component-local +Y
  height?: number; // full envelope extent along component-local +Z
}

interface SpriteLayer {
  id: string;
  textureKey: string;
  position: Point2; // hull-, component-, or rotationFrame-local texture-origin position
  rotationDeg?: number;
  scale?: Point2;
  textureOrigin?: Point2; // finite Phaser texture-origin coordinates
  rotationFrame?: 'component' | 'turret';
  order: number; // deterministic composition order; lower renders first
}

interface ComponentAttachment {
  position: Point2; // component-local attachment datum
  attachmentRotationDeg: number;
}
```

The component-local visual origin is `(0, 0)`, the origin of the component frame used by component-frame sprite positions, attachment coordinates, barrel geometry, and muzzles. It is not necessarily the attachment datum or center of the physical bounding envelope. `ComponentAttachment.position` is the component-local attachment datum and may be offset from that origin. `Dimensions` describes full bounding-envelope extents only; it has no envelope-center/offset field. `textureOrigin` selects the image point placed at a layer position; it is distinct from component origin and attachment datum, and its numeric coordinates must be finite without an imposed `[0, 1]` project restriction.

For component sprite layers, `rotationFrame` defaults to `'component'` when omitted. A component-frame layer’s position and `rotationDeg` are relative to the component visual origin and do not follow turret rotation. A turret-frame layer’s position and rotation are relative to the turret pivot; it belongs to that instance’s pivot-positioned rotating group and follows its mechanical `turretAngleDeg`. Hull sprite layers are always hull-local and must omit `rotationFrame`; they never use the turret frame. Spinal, propulsion, and utility component layers use the component frame. In a turret definition, fixed layers must omit the field or specify `'component'`; every layer in `rotatingLayers` must explicitly specify `'turret'`.

A built-in exists only when its specific hull installation point explicitly declares its component ID. That declaration implies fixed, non-removable behavior in this initial architecture; no redundant single-valued removal policy is stored. Built-ins occupy their point and have installation source `built-in`; loadout installations have source `loadout`.

### HullDefinition

```ts
type WeaponConfiguration = 'spinal' | 'turret';

interface WeaponHardpoint {
  id: string;
  position: Point2;
  rotationDeg: number;
  accepts: readonly WeaponConfiguration[];
  maxDimensions?: Dimensions;
  restrictions?: readonly string[];
  builtInComponentId?: string;
}

interface ThrusterVent {
  id: string;
  position: Point2;
  rotationDeg: number;
  width: number;
  height: number;
  exhaustDirectionDeg: number;
  acceptsPropulsionCategories: readonly string[];
  maxPropulsionOutput?: number;
  maxComponentDimensions?: Dimensions;
  builtInComponentId?: string;
}

interface UtilitySocket {
  id: string;
  position: Point2;
  rotationDeg: number;
  acceptsCategories: readonly string[];
  builtInComponentId?: string;
}

interface HullDefinition {
  id: string;
  sprites: readonly SpriteLayer[]; // an empty array is valid
  weaponHardpoints: readonly WeaponHardpoint[];
  thrusterVents: readonly ThrusterVent[];
  utilitySockets: readonly UtilitySocket[];
}
```

Hull geometry and points are reusable. `sprites: []` is valid: a hull may define only attachment geometry and acquire its visible appearance from installed components. No required hull sprite is invented. A hardpoint is never intrinsically spinal or turret: it declares accepted configurations. Hardpoint capacity is one. An ordinary point remains empty absent a loadout assignment or explicit built-in.

Every point ID shares one hull-local namespace across weapon hardpoints, thruster vents, and utility sockets. A single validation pass rejects duplicates before either built-ins or loadout installations resolve IDs.

Utility sockets remain minimal authoring points with position, rotation, accepted category, and optional `builtInComponentId`. Additional utility-specific restrictions and runtime behavior are deferred until a concrete utility component requires them.

### ComponentDefinition

```ts
interface Muzzle {
  position: Point2;
  directionDeg: number;
}

interface WeaponOperation {
  firingMode: string;
  damage: number;
  range: number;
  cooldown: number;
  energyCost: number;
  projectileSpeed: number;
  splashRadius: number;
}

interface SpinalWeaponGeometry {
  muzzles: readonly Muzzle[];
}

interface TurretWeaponGeometry {
  pivot: Point2; // component-local pixels
  rotationLimitsDeg: { min: number; max: number };
  rotationSpeedDegPerSecond: number;
  barrels: readonly {
    id: string;
    position: Point2; // barrel origin relative to pivot
    rotationDeg: number; // fixed barrel orientation relative to neutral turret frame
    muzzles: readonly Muzzle[]; // position/direction relative to this barrel frame
  }[];
}

type WeaponComponentDefinition =
  | {
      id: string;
      kind: 'weapon';
      configuration: 'spinal';
      attachment: ComponentAttachment;
      dimensions?: Dimensions;
      operation: WeaponOperation;
      geometry: SpinalWeaponGeometry;
      visuals: { fixedLayers: readonly SpriteLayer[] }; // component-frame layers
    }
  | {
      id: string;
      kind: 'weapon';
      configuration: 'turret';
      attachment: ComponentAttachment;
      dimensions?: Dimensions;
      operation: WeaponOperation;
      geometry: TurretWeaponGeometry;
      visuals: {
        fixedLayers: readonly SpriteLayer[]; // component frame, omitted rotationFrame or 'component'
        rotatingLayers: readonly SpriteLayer[]; // every layer explicitly sets rotationFrame: 'turret'
      };
    };

interface PropulsionComponentDefinition {
  id: string;
  kind: 'propulsion';
  category: string;
  attachment: ComponentAttachment;
  dimensions?: Dimensions;
  propulsion: { output: number };
  sprites: readonly SpriteLayer[];
}

interface UtilityComponentDefinition {
  id: string;
  kind: 'utility';
  category: string;
  attachment: ComponentAttachment;
  dimensions?: Dimensions;
  sprites: readonly SpriteLayer[];
}

type ComponentDefinition =
  | WeaponComponentDefinition
  | PropulsionComponentDefinition
  | UtilityComponentDefinition;
```

`configuration` is authoritative and discriminates weapon geometry/visual fields. No second mounting or geometry configuration flag is maintained. Component dimensions are optional because `PlayerCannon` has no verified physical dimensions; when supplied, they are stored once on the component definition. Spinal local `+X` is longitudinal. There is no separate spinal alignment or geometry-level firing direction: attachment rotation establishes orientation, and each spinal muzzle supplies its direction offset relative to the component-local `+X` axis.

For a turret, definition limits and angular speed are immutable configuration. Each installed runtime `Component` instance owns its own `turretAngleDeg`; definition reuse never shares this state. The angle is an **unwrapped offset** from neutral turret orientation. Limits and speed must be finite, `min <= max`, span `max - min <= 360`, and speed nonnegative. This 2D azimuth model represents orientation modulo 360 degrees, not cable winding, accumulated revolutions, or a multi-turn actuator; a travel interval larger than 360 would claim behavior this model does not represent. Keep the interval unwrapped so a range crossing conventional zero (for example `[350, 370]`) remains explicit.

Initialize at an equivalent of zero inside the permitted interval if one exists: choose a value `360k` in `[min, max]` with the smallest absolute value, breaking an exact tie toward the lower value. For example, `[350, 710]` initializes at `360`, physically equivalent to `0`. If no multiple of 360 lies in the interval, compare the boundaries by their minimum angular distance to any multiple of 360: `distance(a) = min over integer k of |a - 360k|`. Choose the boundary with smaller distance and break a tie toward the lower boundary. Thus `[340, 350]` initializes at `350`, `[-350, -340]` at `-350`, and `[10, 20]` at `10`; an interval with no zero-equivalent starts at its nearest mechanical stop, not at a neutral orientation. Thereafter clamp directly to the unwrapped interval without wrapping runtime angles.

`rotationLimitsDeg` constrain mechanical `turretAngleDeg`, not world-space muzzle direction. Fixed barrel and muzzle direction offsets add to bore direction but do not expand mechanical travel. For a desired world bore direction, future aiming logic may derive `θrequired = θdesiredWorld - θcomponent - β - μ`, then consider equivalent candidates `θrequired + 360k` that lie in the unwrapped mechanical interval before applying the limits. It must not blindly clamp a wrapped target angle without considering equivalent orientations. This describes a future calculation only; no aiming logic is part of this proposal. Fixed visual layers remain in component coordinates. Turret-frame sprite layers and barrels rotate around the configured pivot by the instance angle; muzzle coordinates/directions are barrel-local.
### ShipLoadout and ShipBlueprint

```ts
interface ShipLoadout {
  id: string;
  installations: readonly {
    mountId: string;
    componentId: string;
  }[];
}

interface ShipBlueprintDefinition {
  hullId: string;
  loadoutId: string;
  superType: string;
  subType: string;
  name: string;
  categoryType: string;
  stats: ShipBlueprintStats;
}
```

`ShipBlueprintDefinition.hullId` is the sole authoritative hull reference. `loadoutId` identifies component installations, and `ShipLoadout` contains only its own ID and explicit assignments; it does not select a hull. Interpret each loadout against the hull selected by the referencing blueprint. An empty installation list is valid. The blueprint retains ship identity/classification and all existing ship-specific stats; different blueprints/loadouts may reuse one hull without duplicating geometry. Catalogue `id` and `sourceKey` remain on the `ShipBlueprint` wrapper, not in this plain definition.

### Built-In Resolution

`ShipManager` resolves a blueprint’s canonical hull and loadout references through registries owned by `Game`. During `Ship.init()`, materialize explicit built-ins from the selected hull and explicit loadout installations from the selected loadout. For each `builtInComponentId`, resolve the component definition from `Game.componentDefinitions`, validate kind/category/configuration and point compatibility, then construct the per-ship `Component` instance with installation source `built-in` and reserve that point after successful validation. This is independent of the loadout, so even an empty loadout receives built-ins. Reject explicit loadout installation at a reserved point. No other points are filled automatically. Built-ins are fixed/non-removable in this initial scope. Runtime state belongs to each Component instance; definitions remain reusable data. No separate loadout resolver manager is introduced.

### Sprite Composition Ownership

The final composition derives from `HullDefinition.sprites`, component sprite layers selected by explicit built-in assignments and `ShipLoadout.installations`, each installed instance’s state (including turret angle), and deterministic layer ordering. Hull and component definitions own only their respective source sprites. The loadout determines which component visuals are present. After migration, `ShipBlueprintDefinition` does not duplicate whole-ship visuals.

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
3. Hull IDs, component IDs, loadout IDs, blueprint IDs, and point IDs must be stable and unique in their namespaces. Hull sprite-layer IDs are unique within their `HullDefinition`; component layer IDs are unique within their `ComponentDefinition`. Layer IDs may be reused across definitions, and `order` values need not be globally unique. Canonical hull/component layer IDs must not use the reserved `legacy:` prefix. Weapon hardpoints, vents, and utility sockets share one point-ID namespace per hull; built-ins and loadouts resolve through it.
4. Resolve each blueprint’s hull and loadout through `Game`. Every loadout installation must reference a registered component and a point in that blueprint’s hull. A loadout does not select or override the hull.
5. Each installation point has capacity one. `Ship.init()` materializes explicit built-ins and loadout installations. For a `builtInComponentId`, resolve from `Game.componentDefinitions`, validate component kind/category/configuration and point compatibility, construct a fixed instance with source `built-in`, and reserve the point. This occurs even for an empty loadout. Reject loadout assignments to reserved points. Built-ins are fixed/non-removable in this initial scope; component runtime state belongs to the individual instance.
6. A weapon installation is accepted only when the generic hardpoint’s `accepts` includes the component’s discriminated `configuration`. A vent validates propulsion category; a utility socket retains category matching only. Built-ins pass the same checks.
7. `Dimensions` gives full envelope extents, not half-extents. Defined `length` and `width` must be finite and strictly positive; defined `height` must be finite and nonnegative, with zero meaning planar. Omitted values mean unknown. If a `dimensions` object is supplied, reject `{}`; components with no known dimensions omit the property.
8. Dimension maxima are partial constraints and only specified axes are checked. Checking either projected in-plane axis (`length` or `width`) requires both component `length` and `width`, because each projection couples both. A height-only constraint requires only component `height`. Missing any value required by an active constraint rejects that constraint; if no constraint needs it, missing dimensions are allowed.
9. A vent opening always constrains both projected in-plane axes and therefore requires both component `length` and `width`. `maxComponentDimensions`, when supplied, is a separate partial installation envelope; only specified axes are checked under the same dependency rules. Vent opening dimensions must be finite and strictly positive. Dimension maxima must be finite and nonnegative; `{}` as a supplied maxima object is invalid.
10. Rotated-envelope formulas are size-limit checks independent of translation. They do not prove containment, collision avoidance, or physical clearance for off-center attachment datums. Offset-aware containment would require explicit local footprint bounds and is outside this prerequisite scope.
11. Turret limits must be finite, ordered, and span no more than 360 degrees; rotation speed must be finite and nonnegative. The interval is an unwrapped azimuth offset, not a multi-turn actuator. Initialize at the equivalent of zero in the interval with smallest absolute angle, tie-breaking lower. If none exists, compare both boundaries by minimum angular distance to any multiple of 360 degrees, select the closer boundary, and tie-break lower. Do not wrap subsequent angles; clamp them to the unwrapped interval.
12. All authored angles (including turret limits, barrel/muzzle offsets, attachment, mount, sprite, vent, and exhaust angles), sprite order, and scale values must be finite. `textureOrigin` coordinates must be finite; the project imposes no `[0, 1]` bound. Only rotating layers on turret weapons may use `rotationFrame: 'turret'`, and they must specify it explicitly; hull layers omit `rotationFrame`, while all other component layers omit it or use `'component'`.
13. Propulsion output must always be finite and nonnegative. If `maxPropulsionOutput` is present, it must be finite and nonnegative and output must not exceed it. This remains metadata only; no movement behavior is derived from it.
14. Public sprite keys validate against generated manifest metadata without `BootScene`; any source-asset keys validate only against an explicitly supported Vite source-asset catalog. Utility sockets remain minimal: installation point, category compatibility, and optional explicit built-in. Defer additional utility restrictions or runtime behavior until a concrete requirement exists.

### Dimension Frames

`Dimensions.length`, `width`, and `height` are full envelope extents, not half-extents. Length and width are measured in component-local `+X` and `+Y`; height is along component-local `+Z`, perpendicular to the 2D plane. Installation-point maximum dimensions are maximum permitted full extents in that point’s local frame. The projection uses only extents and relative rotation, independent of translation. It is not a containment, collision, or clearance test and does not account for an off-center attachment datum or envelope-center offset. Offset-aware physical containment would require explicit local footprint bounds and is outside this prerequisite scope.

Let relative in-plane rotation be `δ = θcomponent - θmount`, converting degrees to radians before evaluating trigonometric functions. Projected extents are:

```text
Lmount = |cos(δ)| * L + |sin(δ)| * W
Wmount = |sin(δ)| * L + |cos(δ)| * W
Hmount = H
```

For a hardpoint maximum, compare only axes whose maxima were specified. A `length` maximum checks `Lmount`; a `width` maximum checks `Wmount`; either in-plane check requires both component `length` and `width`. A `height` maximum checks only `Hmount` and requires only component `height`. Partial maximum objects are valid, but an explicitly supplied empty `{}` is rejected. Without an active constraint, the entire component `dimensions` property may be omitted. These are size-limit checks only, not proof of physical containment or clearance.

For a thruster vent, `width` and `height` describe the opening in vent-local `+X/+Y`. Both opening checks are active, so both component length and width are required; compare `Lmount` to opening width and `Wmount` to opening height. Component `height` is `+Z` depth and is not compared to the planar opening. Optional `maxComponentDimensions` is a separate partial envelope in vent-local axes; only specified maxima are checked, using both length/width for either in-plane projection and height alone for a depth constraint. Neither comparison accounts for an off-center attachment’s physical clearance.

## Coordinate and Rotation Contract

All new hull/component points use local pixels. The ship origin is its center. Coordinates are screen coordinates: `+X` right and `+Y` down. Angles are degrees, positive clockwise visually. `Ship.rotation` is degrees. Phaser `GameObject.rotation` is radians; the current player scene converts radians to degrees when synchronizing to `Ship.rotation`.

Define the y-down rotation matrix:

```text
R(θ) = [ cos(θ)  -sin(θ) ]
       [ sin(θ)   cos(θ) ]
```

With this screen-space convention, positive 90 degrees maps local right `(1, 0)` to screen-down `(0, 1)`. This is consistent with the existing projectile trigonometry and is not a convention change.

For ship world position `Ps`, ship rotation `θs`, hull-local hardpoint position `H`, hardpoint rotation `φh`, component-local attachment datum `A`, and `attachmentRotationDeg = α`:

```text
Ph = Ps + R(θs) * H
θcomponent = θs + φh - α
Pc = Ph - R(θcomponent) * A
```

The hardpoint sets hull-side orientation; `attachmentRotationDeg` is the component-side datum axis that aligns to it. The component attachment point is an actual point in the component-local frame, not the sprite origin.

Worked sign example: with ship rotation `0°`, hardpoint rotation `0°`, and component `attachmentRotationDeg = +30°`, `θcomponent = 0° + 0° - 30° = -30°`. The subtraction rotates the component frame so its own attachment datum axis aligns with the hardpoint axis; it does not rotate the ship or change the component-local visual origin.

Hull sprite layers use hull-local positions and cannot use the turret frame. Component fixed-layer positions are component-local and transform by `Pc + R(θcomponent) * L`. A turret-frame layer’s position and rotation are pivot-local; its group is positioned at the component-transformed pivot and rotated by that installed instance’s `turretAngleDeg`. `textureOrigin` selects the image point placed at a layer position; it does not shift the component attachment datum or muzzle coordinates.

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

Mechanical rotation is only `θturret` and is clamped by the definition’s unwrapped limits. Barrel position/orientation is fixed geometry relative to the neutral turret frame. `Muzzle.directionDeg` (`μ`) is a fixed offset relative to the barrel-local `+X` direction and is added only when calculating projectile direction; it cannot change mechanical turret angle or limits. All values are finite degrees. No second spinal alignment or geometry-level firing direction is defined.

Thruster vent position transforms as `Pvent = Ps + R(θs) * V`. Exhaust direction is relative to the vent’s local orientation:

```text
θexhaustWorld = θship + θvent + θexhaustLocal
direction = (cos(θexhaustWorld), sin(θexhaustWorld))
```

No propulsion movement is derived from this data during prerequisite refactoring.

## PlayerCannon Migration and Behavior Preservation

The existing player definition becomes a `ShipBlueprintDefinition` referencing an explicit player `HullDefinition` and player `ShipLoadout`. The hull has one explicitly defined hardpoint at `(0, 0)`, rotation `0`, compatible with spinal weapons. The player loadout assigns `PlayerCannon` to that point. It is not a built-in; other points remain empty. The player keeps its current explicit hull and visual composition, migrated into hull sprite layers without copying image assets.

`PlayerCannon` becomes a spinal `WeaponComponentDefinition`:

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
| Muzzle position/direction | `(0, 0)` / `0°` |

Current part coordinates are multiplied by five in `Ship.init()` and then rotated by ship angle. The player’s part offset is `(0,0)`, so its current firing origin is the ship center at every angle. Under the proposed model, zero attachment and muzzle offsets preserve that origin without applying legacy part offsets twice.

| `Ship.rotation` | Current and proposed muzzle origin | Ship-forward direction | 600-speed muzzle vector before inherited shooter velocity |
|---:|---|---|---|
| 0° | `(ship.x, ship.y)` | `(1, 0)` right | `(600, 0)` |
| 90° | `(ship.x, ship.y)` | `(0, 1)` down | `(0, 600)` |
| 180° | `(ship.x, ship.y)` | `(-1, 0)` left | `(-600, 0)` |
| 270° | `(ship.x, ship.y)` | `(0, -1)` up | `(0, -600)` |

With a Phaser scene and `ProjectileManager` available, `Component` creates `ManagedWeapon`; it captures body velocity and source entity/faction at fire time. `ProjectileManager` adds shooter velocity to muzzle velocity and retains attribution while the source may be destroyed. Preserve those values and ownership. `Weapon` also has a fallback `PhysicsProjectile` path, but the normal configured player path prefers `ManagedWeapon`. The existing manager’s direct-damage behavior does not currently implement splash radius or range checks; do not silently add those mechanics.

The player remains outside the NPC `shipQueue`, with its existing Phaser body, scene, container synchronization, direct player firing input, and shutdown cleanup. NPCs continue to use ShipManager and the managed queue. NPC loadouts may be predefined, but this refactoring must not add NPC Phaser body/rendering, aiming, combat AI, or alter lifecycle boundaries.

## Asset Pipeline

### Existing Discovery, Keys, and Loading

`scripts/generate-public-svg-manifest.mjs` recursively discovers SVGs under `public/assets`, sorts paths for deterministic output, and excludes the root `Planets` directory. It converts each relative path to a `public-...` key: it removes the extension, normalizes Unicode, sanitizes separators/characters, lowercases, and resolves normalized collisions with a stable SHA-256 suffix. URLs are `/assets/` plus each encoded path segment. Three explicit legacy aliases map existing ship/hull textures; alias collisions are checked ([manifest generator](../scripts/generate-public-svg-manifest.mjs#L6), [generator](../scripts/generate-public-svg-manifest.mjs#L16), [generator](../scripts/generate-public-svg-manifest.mjs#L30), [generator](../scripts/generate-public-svg-manifest.mjs#L39), [generator](../scripts/generate-public-svg-manifest.mjs#L114)).

The script writes `src/generated/publicSvgManifest.ts` only when content differs. `BootScene.preload()` loads planet PNGs separately, loads each generated public SVG with Phaser `load.svg()` at scale `0.5`, and also uses Vite `import.meta.glob('/src/assets/Components/**/*.svg', { eager: true, query: '?url', import: 'default' })` for source-directory component SVGs. `BootScene.create()` registers aliases by adding the loaded image to Phaser’s texture manager. Shipmaker should consume these existing keys/assets and avoid creating a parallel sprite loader ([main.ts](../src/main.ts#L89), [main.ts](../src/main.ts#L96), [main.ts](../src/main.ts#L100), [main.ts](../src/main.ts#L120), [manifest generator](../scripts/generate-public-svg-manifest.mjs#L141)).

### Assets Present at Inspection

| Location/category | Observed contents |
|---|---|
| `public/assets/Components/Aistiaria/` | Eight component SVGs, including `01_side_hull_angular.svg`. |
| `public/assets/Components/Yutiarin/` | `Part 1.svg` through `Part 10.svg` and `Wing 1.svg` (11 SVGs). |
| `public/assets/Components/Verdania/` | Placeholder `.gitkeep` only. |
| `public/assets/Ships/` | Nine ship SVG files. |
| `public/assets/Turrets-Platforms/` | Two Yutiarin turret/platform SVGs. |
| `public/assets/Weapons/Spinals/` and `Turrets/` | Placeholder `.gitkeep` files only; no weapon SVGs found there. |
| `public/assets/Planets/` | Five PNG files; loaded separately and excluded from the SVG manifest. |
| `public/raw/Ships/` and `public/raw/Components/` | Placeholder `.gitkeep` files. There is no root-level `raw/` directory in the inspected worktree. |
| `src/assets/` | Vite starter `hero.png`, `javascript.svg`, and `vite.svg`; no `src/assets/Components/` content exists, so the component glob currently contributes no assets. |

The generated manifest contains the public component, ship, and turret/platform SVG entries, with stable texture keys and aliases: `central-hull` → `public-components-aistiaria-01_side_hull_angular`, `human-dreadnought` → `public-ships-human-dreadnought`, and `alien-interceptor` → `public-ships-alien-interceptor` ([publicSvgManifest.ts](../src/generated/publicSvgManifest.ts#L1)). Shipmaker should consume the generated manifest metadata directly to enumerate and validate public texture keys; this must work before or without gameplay `BootScene` initialization. For optional Vite source assets, validate only keys in an explicitly supported source-asset catalog derived from the existing glob/key convention. Do not create another loader or duplicate asset registry. The editor may load thumbnails for display, but public-key discovery and validation use metadata rather than Phaser runtime texture existence.

### App Entry

`index.html` is a Vite app shell with `#app` and `/src/main.ts`; `main.ts` boots Phaser scenes. Workspace search found no current `/shipmaker` route or Shipmaker implementation ([index.html](../index.html#L1), [index.html](../index.html#L26), [index.html](../index.html#L27)). The package declares Phaser `^4.2.1`, Vite scripts, `npm test` (`tsx --test`), and `npm run build` ([package.json](../package.json#L6), [package.json](../package.json#L21)).

## Prerequisite Refactoring Proposal

This is the minimum proposed code scope. It is not authorized by the presence of this document. Keep `ProjectileManager`, `EntityManager`, and `ObjectPool` responsibilities intact; do not add `WeaponManager` or another registry.

| File | Current responsibility | Proposed change and compatibility strategy | Main regression risk |
|---|---|---|---|
| [ShipBlueprint.ts](../src/managers/ShipBlueprint.ts) | Blueprint and legacy tuple types; catalogue entry resolves structured definition or `Game.shipData`. | Add `HullDefinition`, `ComponentDefinition`, and `ShipLoadout` types; make blueprint reference hull/loadout while retaining a legacy definition projection. | Breaking existing structured/debug/test blueprint consumers. |
| [ShipManager.ts](../src/managers/ShipManager.ts) | Catalogue registration and ordinary create/dispose orchestration. | Resolve/validate blueprint hull and loadout data through existing catalogue/owner; retain method boundaries and spawn/disposal behavior. | Source-key lookup or pooling lifecycle mismatch. |
| [Game.ts](../src/core/Game.ts) | Owns current inline game data, player cannon tuple, player blueprint, queues, and frame/system orchestration. | Make current player/hull/component/loadout data canonical typed records while keeping the legacy registries as adapters where needed. No new manager or movement behavior. | Duplicate registries, altered player stats, or spawn queue behavior. |
| [Ship.ts](../src/entities/Ship.ts) | Applies blueprint stats, builds parts/components from structured or legacy tuples, and owns logical ship state/movement. | Resolve hull/loadout; materialize built-ins/installations; resolve initial composition descriptors during `init()`; own the composed Phaser display objects and cleanup; expose Ship-owned add/remove operations that refresh composition. Retain movement and logical lifecycle code. | Part coordinates scaled twice, missing components on pooled reuse, shared turret state, or altered stats. |
| [Component.ts](../src/entities/Component.ts) | Initializes tuple-defined component behavior and cooldown/energy; stores ship/part references. | Retain typed definition, installation metadata, per-instance turret angle, and mount transform access; do not share runtime state between installs. | Cooldown/energy regressions or shared turret state. |
| [Weapon.ts](../src/weapons/Weapon.ts) | Loads weapon tuple and handles firing mode/fallback firing. | Use resolved muzzle position and direction for fallback firing, retaining existing operation values and behavior. | Coordinate sign/unit drift or fallback projectile differences. |
| [ManagedWeapon.ts](../src/weapons/ManagedWeapon.ts) | Captures shooter velocity/attribution and delegates projectile spawn. | Use the same resolved muzzle transform as `Weapon`; continue delegating lifecycle to `ProjectileManager`. | Duplicate offset application or lost attribution/velocity inheritance. |
| [main.ts](../src/main.ts) | Owns Phaser scene, player container/body, player sync/input, and debug NPC visual containers. | Supply/attach the scene and existing player body/input integration to Ship-owned composition; preserve player queue separation and debug/NPC lifecycle without owning composed sprite cleanup. | Phaser radians/degrees confusion, changed player setup, visual ownership leaks, or implying a general NPC renderer. |

`ModularHull.ts` should not be migrated or deleted: no current runtime use was found, and its section-level damage/hardpoint behavior differs from the proposed generic configuration points. The existing `publicSvgManifest.ts` remains generated output; modify the generator or asset loader only if an approved implementation establishes a real missing capability. Do not edit `EntityManager.ts`, `ProjectileManager.ts`, or `ObjectPool.ts` absent new evidence that the required behavior cannot fit their present responsibilities.

### Migration Order

1. Introduce typed definitions and a runtime validator/conversion boundary without removing existing definitions.
2. Express the player hull and `PlayerCannon` as typed records and an explicit player default loadout; preserve player stats, visuals, energy/cooldown, muzzle transform, and managed projectile behavior.
3. Adapt `Ship.init()` to build installed components from hull plus loadout while translating legacy tuples and scaling legacy part coordinates exactly once.
4. Resolve weapon origins through one shared transform for fallback and managed firing; keep the projectile manager API/ownership unchanged.
5. Adapt existing player/debug composition to render hull/component sprite groups. Do not claim ordinary NPC rendering support.
6. Keep adapters until tests demonstrate existing structured and tuple definitions still work; only remove legacy support in a separately approved migration.

## Regression Test Matrix

### Existing Tests and Their Present Coverage

| Existing file | Verified coverage in current suite |
|---|---|
| [ship-blueprint.test.ts](../tests/ship-blueprint.test.ts#L18) | Player catalogue registration; structured gameplay/visual separation; player stats/components; energy regeneration defaults; legacy ship tuple catalogue/init. |
| [player-weapon.test.ts](../tests/player-weapon.test.ts#L24) | Legacy weapon tuple values; passive tuple compatibility; failed/successful activation; energy/cooldown; failure without a Phaser scene. It does not verify physical projectile transforms at four rotations. |
| [projectile-manager.test.ts](../tests/projectile-manager.test.ts#L215) | Pool reuse/cleanup, scene shutdown, swept collision, faction/source attribution, velocity/direction and lifespan behavior. |
| [ship-lifecycle.test.ts](../tests/ship-lifecycle.test.ts#L42) | ShipManager registration/queue/disposal/pooling; legacy component rebuild; debug blueprint texture keys and lifecycle. |
| [public-svg-manifest.test.ts](../tests/public-svg-manifest.test.ts#L26) | SVG discovery, Planet exclusion, deterministic keys/URLs, aliases, collisions, and unchanged manifest writes. |
| [faction-manager.test.ts](../tests/faction-manager.test.ts#L617) | Shared ship queue, faction-aware targeting/relationships, spawn lifecycle, and disposal interactions. |

These are not tests of the proposed editor/configuration architecture. Current test harnesses often bypass Phaser scene construction, so browser/render behavior remains unverified by these unit tests.

### Required Tests for Prerequisite Refactoring

| Area | Required assertions |
|---|---|
| Definition ownership | Multiple blueprints select the same hull with distinct loadouts and ship-specific stats; loadouts contain no hull reference. |
| Generic hardpoints | Empty is valid; spinal-only, turret-only, and dual-compatible hardpoints accept correct configurations; incompatible assignments reject. |
| Validation | One duplicate-ID pass covers weapon points, vents, and utility sockets; the same namespace resolves built-ins and loadouts; unresolved IDs, duplicate assignments, invalid dimensions/angles/output, and sprite references are reported. |
| Built-ins | No built-in is synthesized; each `builtInComponentId` resolves from `Game.componentDefinitions`, validates against its exact point, is instantiated independently of an empty loadout, occupies/reserves the point, has source `built-in`, and rejects loadout replacement. |
| Component state/visuals | Two turret instances share definition but not angle; component-frame layers remain fixed; turret-frame layers explicitly rotate around the component-local pivot; limits/speed are finite, ordered, span at most 360°, `[350, 710]` initializes at `360°`, `[340, 350]` at `350°`, `[-350, -340]` at `-350°`, and `[10, 20]` at `10°`; angles stay unwrapped and muzzle offsets do not affect mechanical limits. |
| Weapon transforms | Spinal attachment axis and per-muzzle direction; turret pivot-local barrel position, fixed barrel rotation, barrel-local muzzle position/direction, and world bore direction; offsets tested at nonzero ship/hardpoint rotations and at `0°`, `90°`, `180°`, `270°`. |
| Dimensions | Optional dimensions pass unconstrained points; empty supplied dimension/maximum objects reject; any active projected in-plane maximum requires both finite positive length and width; a height-only maximum requires only finite nonnegative height; partial maxima compare only specified axes; size projection does not claim containment/clearance for off-center datums. |
| Thrusters | Vent/category compatibility; built-in assignment resolves from canonical component data even for an empty loadout; output rejects NaN, infinity, and negatives regardless of cap; optional finite cap accepts equal/lower and rejects greater output; dimensions are checked against the opening and separate envelope; exhaust rotates with ship and vent. Movement output remains unchanged. |
| Legacy migration | Existing structured and tuple ships initialize; unconverted ship/component tuples remain authoritative and are projected without a duplicate cache; migrated records switch to Game-owned typed data; legacy part `×5` conversion occurs exactly once; pooled reuse rebuilds per-instance state. |
| Player cannon | Values, cooldown/energy semantics, origin/direction at four cardinal rotations, shooter-velocity inheritance, source/faction attribution, projectile pool/collision/cleanup remain unchanged. Preserve `range`/`splashRadius` data without adding absent gameplay mechanics. |
| Lifecycle | Player stays outside managed NPC queue and retains scene/input cleanup; NPC predefined loadout remains on ShipManager/queue lifecycle; Ship owns composition display objects while scenes provide their attachment/body context. |
| Rendering/assets | Empty hull sprite arrays are valid; hull/component layer IDs are definition-local with the reserved `legacy:` prefix unavailable to canonical IDs; layer orders may repeat; the five-key source/point/component/order/layer-ID sort is deterministic; the pure helper resolves once during `Ship.init()`; Ship owns display-object cleanup; turret changes update only rotating groups; Ship-owned add/remove refreshes composition; manifest keys validate without BootScene. |

### Additional Future Shipmaker Tests

| Area | Required assertions |
|---|---|
| JSON validation | Schema-version validation; unified hull-local point IDs; duplicate IDs; invalid references; invalid dimensions, angular fields, or propulsion output; manifest-backed asset validation without BootScene. |
| Serialization | Deterministic output; no Phaser objects, classes, transient editor state, or base64 image data. |
| Round trip | Import exported hull/component/loadout JSON and reproduce equivalent normalized configuration. |
| Asset library | Discover/search/filter manifest metadata and validate keys before gameplay boot; reuse an asset across hulls/components without image duplication. |
| Editor preview | Numeric edits, snapping, layer order, fixed/rotating turret preview, occupied/empty point overlays, and coordinate updates. |
| Persistence actions | Save preview/display, copy, download, import, and validate do not silently mutate gameplay source files. |

Run the existing suite and production build after approved code changes: `npm test` and `npm run build`. The build’s `prebuild` regenerates the SVG manifest, so report any generated-file delta and preserve user work. Browser-test the editor after a future editor phase; no test/build result is claimed by this documentation.

## Shipmaker Requirements (Future Work)

Shipmaker is a developer-only authoring tool at `/shipmaker`, not gameplay UI. Current `index.html` and `main.ts` have no such route. The editor must render a composition preview from definitions; it must not instantiate gameplay ships or combat entities.

### Asset Library

- Browse discovered assets with thumbnails, search, and category filters.
- Assign multiple independent sprite layers to a central hull and each component.
- Reuse existing public SVG keys and Vite-supported source assets; do not duplicate image files or loaders.
- Validate public references against `publicSvgTextures` manifest metadata without booting gameplay; validate source references only against an explicitly supported source-asset catalog.

### Hull and Mount Authoring

- Select/edit hull identity, sprite layers, layer order, origin, scale, rotation, pan/zoom, grid, optional snapping, and numeric coordinates.
- Place generic weapon hardpoints and select spinal/turret/both compatibility, restrictions, and optional size limits.
- Place thruster vents with opening geometry, local exhaust direction, accepted categories, optional output cap, optional component envelope, and explicit optional fixed built-in.
- Place utility sockets with category acceptance and optional fixed built-ins.
- Display point occupancy and never make an ordinary hardpoint typed as permanently spinal or turret.

### Component Authoring and Preview

- Create reusable component definitions with independent sprite collections and attachment data.
- Author spinal muzzles/directions and fixed layers; author turret pivot, limits, speed, barrels, muzzles, fixed layers, and rotating layers.
- Author propulsion category, finite nonnegative output, optional physical dimensions, and independent sprites.
- Preview component alignment, fixed/rotating groups, occupied/unoccupied hull points, and the same component transforms as gameplay.
- No aiming AI, combat automation, movement simulation, or gameplay entities in editor preview.

## JSON Export and Persistence (Future Work)

The future serializer must produce deterministic, portable, versioned JSON containing:

- Schema version and stable IDs.
- Hull identity, hull sprite collection, visual layers, hardpoints, thruster vents, utility sockets, and explicit built-ins.
- Component definitions, independent component sprite assignments, optional known dimensions, spinal/turret operation and geometry, or propulsion metadata.
- Ship-specific blueprint stats and identity separately from hull geometry.
- Loadout assignments from installation point IDs to component IDs.
- Existing Phaser texture keys and/or portable relative asset references where appropriate.

JSON must contain no Phaser runtime objects, class instances, base64 images, or transient editor state. The exact final JSON schema and serializer remain future implementation work; runtime TypeScript contracts will need a dedicated parse/validate/conversion boundary for imported JSON.

Required editor actions: Save Configuration (display generated JSON, never silently write gameplay source), Copy JSON (clipboard), Export JSON file, Import JSON for continued editing, Preview JSON, and Validate Configuration. The developer manually copies approved generated data into the relevant TypeScript definitions. Save/import must not overwrite gameplay source files.

## Implementation Phases and Approval Gates

Each phase is a separate review boundary; do not start a later phase without review/approval of the preceding one.

1. **Prerequisite architecture refactoring:** Typed hull/component/loadout records, validation, current PlayerCannon migration, compatibility adapters, focused regression tests. Requires explicit approval before source edits.
2. **Shipmaker foundation:** Developer-only `/shipmaker` access and editor workspace, using existing Vite/Phaser asset infrastructure.
3. **Hull and mount authoring:** Hull sprite assignment, generic weapon hardpoints, vents, utility sockets, fixed built-ins.
4. **Component authoring:** Independent component visuals, spinal/turret geometry, turret visual groups, propulsion metadata.
5. **Composition preview:** Transform-correct editor-only assembly and overlays; no gameplay ships.
6. **JSON serializer:** Validation, deterministic JSON, copy/download/import/preview.
7. **Verification:** Existing tests, architecture regression tests, production build, and desktop/mobile browser testing of editor behavior.

## Decisions and Open Questions

### Settled Contract

- `Game` owns canonical typed hull/component/loadout definitions; the blueprint alone selects `hullId` and `loadoutId`, and the loadout contains installations only. ShipManager remains the catalogue/creation owner and Ship.init materializes installations.
- Hull hardpoints are generic, empty unless explicitly assigned, and share a hull-local point-ID namespace with vents and utility sockets. Explicit fixed built-ins resolve independently of loadouts and reserve their point.
- Component dimensions are optional when unconstrained; full-envelope projection validates only specified size limits and does not establish off-center containment or clearance. PlayerCannon dimensions remain unknown.
- Turret limits are unwrapped single-turn azimuth intervals; each installation owns its angle, while fixed barrel/muzzle offsets affect bore direction only. No aiming behavior is specified.
- Visual composition is derived, deterministically ordered, and owned by Ship for display-object lifecycle. Existing movement, player/NPC lifecycle, and ProjectileManager ownership remain unchanged.
- Public asset-key discovery and validation use generated manifest metadata without requiring BootScene. No additional manager, registry, or loader is proposed.

### Items for Later Implementation Review

- The exact schema versioning/migration policy and JSON file layout remain undecided until the serializer phase.
- Existing data has no verified physical size for PlayerCannon or vent/component dimensions; omit unknown values. If future physical-clearance checks are required, author local footprint bounds/offsets separately from full extents.
- No source assets currently exist in `src/assets/Components`; decide whether that catalog is supported only when a concrete workflow requires it.
- General NPC rendering, Phaser body setup, combat, and aiming are not part of the approved prerequisite scope and need their own design/approval if later required.
- The current runtime does not make `range` or splash radius operative for the PlayerCannon projectile path; changing that would be a gameplay feature requiring separate approval.
- Keep utility sockets category-only until a concrete utility-component requirement justifies additional restrictions or runtime behavior.

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

At this handoff’s creation, the architecture audit and proposal exist only as documentation. The prerequisite refactor is awaiting explicit approval. Shipmaker UI, `/shipmaker`, loadout UI, runtime JSON serialization/import/export, and propulsion movement changes are not implemented or authorized by this document. The next implementation step is the reviewed prerequisite architecture phase only, after the developer explicitly approves its exact scope.