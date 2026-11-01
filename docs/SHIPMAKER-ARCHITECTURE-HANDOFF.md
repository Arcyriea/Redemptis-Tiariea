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
| Local HEAD | `4933ceca47a8cef4fcf70af6c5a55806645f3f8d` |
| HEAD commit | `Implemented NPC ship testing. I will replace this kind of thing in the far future with proper systems.` |
| Local worktree | Clean (`git status --short` produced no entries) |
| Remote comparison | Local HEAD, cached `origin/main`, and live `git ls-remote origin refs/heads/main` all resolved to `4933ceca47a8cef4fcf70af6c5a55806645f3f8d` during inspection. |

The remote reference was checked directly, not inferred from a stale local tracking ref. No local/remote discrepancy was found.

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

## Proposed Three-Definition Architecture

The following TypeScript is an architectural contract, not current source code. Runtime validation is required for imported or editor-authored records because TypeScript types do not validate JSON at runtime.

### Shared Primitives and Built-Ins

```ts
type Point = { x: number; y: number };

interface Dimensions {
  length?: number; // component-local +X
  width?: number;  // component-local +Y
  height?: number; // component-local +Z (depth, perpendicular to 2D plane)
}

interface SpriteLayer {
  textureKey: string;
  position: Point; // position of the sprite origin in its declared parent frame
  rotationDeg?: number;
  scale?: Point;
  origin?: Point; // normalized texture origin, e.g. { x: 0.5, y: 0.5 }
  depth?: number;
}

interface ComponentAttachment {
  position: Point; // component-local attachment datum
  attachmentRotationDeg: number;
}

interface BuiltInAssignment {
  componentId: string;
  removalPolicy: 'fixed';
}
```

`depth` on a visual layer is a composition/layer-order value, not physical component height. A built-in exists only when its specific hull installation point explicitly declares it. Built-ins are fixed, occupy that point, and have installation source `built-in`; loadout installations have source `loadout`.

### HullDefinition

```ts
type WeaponConfiguration = 'spinal' | 'turret';

interface WeaponHardpoint {
  id: string;
  position: Point;
  rotationDeg: number;
  accepts: readonly WeaponConfiguration[];
  maxDimensions?: Dimensions;
  restrictions?: readonly string[];
  builtIn?: BuiltInAssignment;
}

interface ThrusterVent {
  id: string;
  position: Point;
  rotationDeg: number;
  width: number;
  height: number;
  exhaustDirectionDeg: number;
  acceptsPropulsionCategories: readonly string[];
  maxPropulsionOutput?: number;
  maxComponentDimensions?: Dimensions;
  builtIn?: BuiltInAssignment;
}

interface UtilitySocket {
  id: string;
  position: Point;
  rotationDeg: number;
  acceptsCategories: readonly string[];
  maxDimensions?: Dimensions;
  builtIn?: BuiltInAssignment;
}

interface HullDefinition {
  id: string;
  sprites: readonly SpriteLayer[];
  weaponHardpoints: readonly WeaponHardpoint[];
  thrusterVents: readonly ThrusterVent[];
  utilitySockets: readonly UtilitySocket[];
}
```

Hull geometry and points are reusable. A hardpoint is never intrinsically spinal or turret: it declares accepted configurations. Hardpoint capacity is one. An ordinary point remains empty absent a loadout assignment or explicit built-in.

### ComponentDefinition

```ts
interface Muzzle {
  position: Point;
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
  pivot: Point; // component-local pixels
  rotationLimitsDeg: { min: number; max: number };
  rotationSpeedDegPerSecond: number;
  barrels: readonly {
    id: string;
    muzzles: readonly Muzzle[]; // positions relative to pivot
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
      visuals: { fixedLayers: readonly SpriteLayer[] };
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
        fixedLayers: readonly SpriteLayer[];
        rotatingLayers: readonly SpriteLayer[];
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

`configuration` is authoritative and discriminates weapon geometry/visual fields. No second mounting or geometry configuration flag is maintained. Component dimensions are optional because `PlayerCannon` has no verified physical dimensions; when supplied, they are stored once on the component definition. Spinal local `+X` is longitudinal. There is no separate spinal alignment or geometry-level firing direction: attachment rotation establishes orientation, and each muzzle supplies its direction offset.

For a turret, definition limits and angular speed are immutable configuration. Each installed runtime `Component` instance owns its own `turretAngleDeg`, initially zero and bounded by the definition. Fixed layers remain in component coordinates. Rotating layers are children of a pivot-positioned group and rotate by the instance angle. Barrel and muzzle geometry use that same pivot. This introduces no aiming AI.

### ShipLoadout and ShipBlueprint

```ts
interface ShipLoadout {
  id: string;
  hullId: string;
  installations: readonly {
    mountId: string;
    componentId: string;
  }[];
}

interface ShipBlueprintDefinition {
  id: string;
  sourceKey: string;
  hullId: string;
  loadoutId: string;
  superType: string;
  subType: string;
  name: string;
  categoryType: string;
  stats: ShipBlueprintStats;
}
```

The loadout contains player-selectable assignments and selects its hull. Built-ins stay declared on the particular hull point, are materialized as fixed instances, and cannot also be assigned by the loadout. Empty loadouts are valid. A blueprint retains ship identity/classification and all existing ship-specific stats; multiple blueprints/loadouts may share one hull without duplicating geometry.

## Compatibility and Validation Rules

1. Hull IDs, component IDs, loadout IDs, blueprint IDs, and point IDs must be stable and unique within their respective registries; point IDs must be unique across a hull’s hardpoints, vents, and sockets.
2. Every loadout must reference an existing hull. Every assignment must reference an existing component and a point on that hull.
3. Each point has capacity one. A loadout assignment to an explicitly built-in occupied point is invalid. No automatic component assignment is allowed.
4. A weapon assignment is accepted only when the hardpoint’s `accepts` includes the component’s discriminated `configuration`. Built-ins pass the same checks.
5. An unconstrained hardpoint may accept a component without dimensions. If `maxDimensions` is active, each required component dimension must exist and fit after rotation into the hardpoint-local frame.
6. A utility socket validates the utility category; a thruster vent validates the propulsion category. Built-ins receive the same category checks.
7. Propulsion output is always finite and nonnegative. If `maxPropulsionOutput` is present, the cap must also be finite and nonnegative and component output must not exceed it.
8. A vent’s opening width/height constrain the component’s projected in-plane footprint. `maxComponentDimensions`, if specified, is a separate installation envelope and may additionally limit length, width, or depth.
9. All provided dimensions and coordinates must be finite and nonnegative where they represent extents. A constraint requiring missing dimensions fails validation.
10. Sprite texture keys must resolve to existing Phaser texture keys at runtime; editor/JSON validation reports missing references before installation.

### Dimension Frames

Component `length`, `width`, and `height` are measured along component-local `+X`, `+Y`, and `+Z`; `height` is physical depth perpendicular to the 2D plane. Installation envelopes are expressed in the installation point’s local axes, not implicitly in component axes.

Let relative in-plane rotation be `δ = θcomponent - θmount`, converting degrees to radians before evaluating trigonometric functions. Projected extents are:

```text
Lmount = |cos(δ)| * L + |sin(δ)| * W
Wmount = |sin(δ)| * L + |cos(δ)| * W
Hmount = H
```

For a hardpoint envelope, compare the projected `length`, `width`, and unchanged depth to each specified maximum. If a necessary component dimension is unknown, reject the constrained installation. `Dimensions` may be absent entirely on unconstrained points.

For a thruster vent, `width` and `height` describe the opening in the vent-local 2D plane. Compare `Lmount` with vent opening width and `Wmount` with opening height. Component `height` is depth on `+Z`, so it is not compared to the planar opening. A specified `maxComponentDimensions` supplies a separate envelope measured on vent-local `+X`, `+Y`, and `+Z`; compare projected length/width and depth against the corresponding maxima. Vent opening geometry is not silently treated as a full 3D component envelope.

## Coordinate and Rotation Contract

All new hull/component points use local pixels. The ship origin is its center. Coordinates are screen coordinates: `+X` right and `+Y` down. Angles are degrees, positive clockwise. `Ship.rotation` is degrees. Phaser `GameObject.rotation` is radians; the current player scene converts radians to degrees when synchronizing to `Ship.rotation`.

Define the y-down rotation matrix:

```text
R(θ) = [ cos(θ)  -sin(θ) ]
       [ sin(θ)   cos(θ) ]
```

For ship world position `Ps`, ship rotation `θs`, hull-local hardpoint position `H`, hardpoint rotation `φh`, component-local attachment datum `A`, and `attachmentRotationDeg = α`:

```text
Ph = Ps + R(θs) * H
θcomponent = θs + φh - α
Pc = Ph - R(θcomponent) * A
```

The hardpoint sets hull-side orientation; `attachmentRotationDeg` is the component-side datum axis that aligns to it. The component attachment point is an actual point in the component-local frame, not the sprite origin.

Hull sprite layers are positioned in the hull frame. Component fixed-layer positions are in component coordinates and transform by `Pc + R(θcomponent) * L`. Turret rotating-layer positions are in pivot/group coordinates and inherit the group pivot and the installed instance’s `turretAngleDeg`. Phaser sprite `origin` selects the texture point placed at that layer position; it does not silently shift the component attachment point or muzzle coordinates.

For spinal muzzle position `M` in component-local pixels and per-muzzle direction `μ`:

```text
Pmuzzle = Pc + R(θcomponent) * M
θmuzzle = θcomponent + μ
```

For turret pivot `T`, instance angle `θturret`, and barrel muzzle point `M` relative to the pivot:

```text
Pmuzzle = Pc + R(θcomponent) * (T + R(θturret) * M)
θmuzzle = θcomponent + θturret + μ
```

No second barrel, spinal, or muzzle orientation field may duplicate these values. `Muzzle.directionDeg` is the individual muzzle’s local firing offset.

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

The generated manifest contains the public component, ship, and turret/platform SVG entries, with stable texture keys and aliases: `central-hull` → `public-components-aistiaria-01_side_hull_angular`, `human-dreadnought` → `public-ships-human-dreadnought`, and `alien-interceptor` → `public-ships-alien-interceptor` ([publicSvgManifest.ts](../src/generated/publicSvgManifest.ts#L1)). Shipmaker’s asset browser should discover manifest-backed public assets, show their existing texture keys, and allow reuse by hull and component definitions. Any imported/source SVG support should use the existing Vite path only if that asset category is deliberately adopted; do not duplicate images or register a second loader without a demonstrated need.

### App Entry

`index.html` is a Vite app shell with `#app` and `/src/main.ts`; `main.ts` boots Phaser scenes. Workspace search found no current `/shipmaker` route or Shipmaker implementation ([index.html](../index.html#L1), [index.html](../index.html#L26), [index.html](../index.html#L27)). The package declares Phaser `^4.2.1`, Vite scripts, `npm test` (`tsx --test`), and `npm run build` ([package.json](../package.json#L6), [package.json](../package.json#L21)).

## Prerequisite Refactoring Proposal

This is the minimum proposed code scope. It is not authorized by the presence of this document. Keep `ProjectileManager`, `EntityManager`, and `ObjectPool` responsibilities intact; do not add `WeaponManager` or another registry.

| File | Current responsibility | Proposed change and compatibility strategy | Main regression risk |
|---|---|---|---|
| [ShipBlueprint.ts](../src/managers/ShipBlueprint.ts) | Blueprint and legacy tuple types; catalogue entry resolves structured definition or `Game.shipData`. | Add `HullDefinition`, `ComponentDefinition`, and `ShipLoadout` types; make blueprint reference hull/loadout while retaining a legacy definition projection. | Breaking existing structured/debug/test blueprint consumers. |
| [ShipManager.ts](../src/managers/ShipManager.ts) | Catalogue registration and ordinary create/dispose orchestration. | Resolve/validate blueprint hull and loadout data through existing catalogue/owner; retain method boundaries and spawn/disposal behavior. | Source-key lookup or pooling lifecycle mismatch. |
| [Game.ts](../src/core/Game.ts) | Owns current inline game data, player cannon tuple, player blueprint, queues, and frame/system orchestration. | Make current player/hull/component/loadout data canonical typed records while keeping the legacy registries as adapters where needed. No new manager or movement behavior. | Duplicate registries, altered player stats, or spawn queue behavior. |
| [Ship.ts](../src/entities/Ship.ts) | Applies blueprint stats, builds parts/components from structured or legacy tuples, and owns logical ship state/movement. | Resolve hull/loadout; construct each installed component with mount ID and source; initialize fixed built-ins; adapt legacy parts once. Retain all movement and logical lifecycle code. | Part coordinates scaled twice, missing components on pooled reuse, or altered stats. |
| [Component.ts](../src/entities/Component.ts) | Initializes tuple-defined component behavior and cooldown/energy; stores ship/part references. | Retain typed definition, installation metadata, per-instance turret angle, and mount transform access; do not share runtime state between installs. | Cooldown/energy regressions or shared turret state. |
| [Weapon.ts](../src/weapons/Weapon.ts) | Loads weapon tuple and handles firing mode/fallback firing. | Use resolved muzzle position and direction for fallback firing, retaining existing operation values and behavior. | Coordinate sign/unit drift or fallback projectile differences. |
| [ManagedWeapon.ts](../src/weapons/ManagedWeapon.ts) | Captures shooter velocity/attribution and delegates projectile spawn. | Use the same resolved muzzle transform as `Weapon`; continue delegating lifecycle to `ProjectileManager`. | Duplicate offset application or lost attribution/velocity inheritance. |
| [main.ts](../src/main.ts) | Owns Phaser scene, player container/body, player sync/input, and debug NPC visual containers. | Render hull and component sprite layers with the same transforms for player/debug preview; preserve specialized player and debug/NPC lifecycle. | Phaser radians/degrees confusion, changed player setup, or implying a general NPC renderer. |

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
| Definition ownership | Several blueprints/loadouts share one hull while retaining distinct ship stats, components, and visuals; no hull geometry duplication is required. |
| Generic hardpoints | Empty is valid; spinal-only, turret-only, and dual-compatible hardpoints accept correct configurations; incompatible assignments reject. |
| Validation | Stable/duplicate IDs, unresolved IDs, duplicate mount assignments, dimension requirements, missing constrained dimensions, and invalid texture keys are reported. |
| Built-ins | No built-in is synthesized; explicit fixed built-in is compatible, occupies one point, has source `built-in`, and cannot be replaced by loadout assignment. |
| Component state/visuals | Two turret instances share definition but not angle; fixed layers do not rotate; rotating housing/barrel layers rotate around pivot; configured limits are honored with no aiming AI. |
| Weapon transforms | Spinal attachment axis and per-muzzle direction; turret pivot/barrel/muzzle transforms; offsets tested at nonzero ship/hardpoint rotations and at `0°`, `90°`, `180°`, `270°`. |
| Dimensions | Optional dimensions pass unconstrained points; constrained missing dimensions fail; rotated footprint projection is checked in mount-local axes; height/depth is not confused with vent aperture height. |
| Thrusters | Vent/category compatibility; built-in vent assignment; output rejects NaN, infinity, and negatives regardless of cap; optional finite cap accepts equal/lower and rejects greater output; dimensions fit aperture/envelope; exhaust rotates with ship and vent. Movement output remains unchanged. |
| Legacy migration | Existing structured and tuple ships initialize; legacy part `×5` conversion occurs exactly once; existing pooled ship reinitialization clears and rebuilds per-instance component state. |
| Player cannon | Values, cooldown/energy semantics, origin/direction at four cardinal rotations, shooter-velocity inheritance, source/faction attribution, projectile pool/collision/cleanup remain unchanged. Preserve `range`/`splashRadius` data without adding absent gameplay mechanics. |
| Lifecycle | Player stays outside managed NPC queue and retains scene cleanup; NPC predefined loadout remains on ShipManager/queue lifecycle; debug NPC visuals remain scene-owned. |
| Rendering/assets | Hull and component sprite layers use existing texture keys and matching transform math; missing key is rejected; no duplicated asset loader. |

### Additional Future Shipmaker Tests

| Area | Required assertions |
|---|---|
| JSON validation | Schema-version validation; duplicate IDs; invalid references; invalid dimensions/output; invalid texture keys. |
| Serialization | Deterministic output; no Phaser objects, classes, transient editor state, or base64 image data. |
| Round trip | Import exported hull/component/loadout JSON and reproduce equivalent normalized configuration. |
| Asset library | Discover/search/filter current manifest-backed keys and reuse an asset across hulls/components without image duplication. |
| Editor preview | Numeric edits, snapping, layer order, fixed/rotating turret preview, occupied/empty point overlays, and coordinate updates. |
| Persistence actions | Save preview/display, copy, download, import, and validate do not silently mutate gameplay source files. |

Run the existing suite and production build after approved code changes: `npm test` and `npm run build`. The build’s `prebuild` regenerates the SVG manifest, so report any generated-file delta and preserve user work. Browser-test the editor after a future editor phase; no test/build result is claimed by this documentation.

## Shipmaker Requirements (Future Work)

Shipmaker is a developer-only authoring tool at `/shipmaker`, not gameplay UI. Current `index.html` and `main.ts` have no such route. The editor must render a composition preview from definitions; it must not instantiate gameplay ships or combat entities.

### Asset Library

- Browse discovered assets with thumbnails, search, and category filters.
- Assign multiple independent sprite layers to a central hull and each component.
- Reuse existing public SVG keys and Vite-supported source assets; do not duplicate image files or loaders.
- Validate all asset-key references against the loaded/manifest registry.

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

### Decisions Specified in This Proposal

- Hull geometry, reusable component definitions, and individual ship loadouts are separate data concepts.
- ShipBlueprint remains a catalogue/archetype and retains ship-specific statistics.
- A hardpoint is generic and declares accepted spinal/turret configurations.
- No assignment is automatic; built-ins are explicit, fixed, occupy a point, and are validated like loadout installations.
- Component dimensions are optional unless required by an active constraint; `PlayerCannon` dimensions remain unknown.
- Turret configuration is definition-owned; turret angle is per installed `Component` instance.
- Vent opening geometry differs from its optional component installation envelope; propulsion output is always finite/nonnegative and may have an additional cap.
- New positions are pixels, `Ship.rotation` is degrees, Phaser rotation is radians, and legacy part coordinates are converted by five exactly once.
- Projectile lifecycle stays with `ProjectileManager`; no `WeaponManager` or other duplicate registry is introduced.
- Existing player and NPC lifecycle boundaries and movement mechanics stay intact.
- Public SVG manifest and existing asset loading are reused.

### Items for Later Implementation Review

- The exact schema versioning/migration policy and JSON file layout remain undecided until the serializer phase.
- Existing data has no verified physical size for PlayerCannon or verified vent/component dimensions; definitions must omit them until authored from real source data.
- No source assets currently exist in `src/assets/Components`; decide whether to add any there only when a real workflow requires it.
- General NPC rendering, Phaser body setup, combat, and aiming are not part of the approved prerequisite scope and need their own design/approval if later required.
- The current runtime does not make `range` or splash radius operative for the PlayerCannon projectile path; changing that would be a gameplay feature requiring separate approval.

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