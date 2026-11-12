# Weapon Content and Behavior Architecture

## Status and Scope

This document proposes a future hybrid content architecture for Redemptis-Tiariea: Lua-authored weapon definitions describe configuration, while TypeScript implementations provide gameplay behavior. It is a documentation proposal, not an implementation specification or authorization to change gameplay code.

Existing weapon runtime code remains authoritative for now. `PlayerCannon` has not been migrated to Lua. A Lua parser has not been selected or implemented, the behavior registry and faction arsenal loading have not been implemented, and runtime mod loading and hot reload remain future considerations. Weapon inheritance and variant overrides remain open design questions.

## Responsibilities

### Lua weapon definitions: configuration data

Lua is the intended human-facing format for authoring weapon content. A definition should describe a stable weapon ID, name and description, category and configuration, operation parameters, projectile parameters, component attachment, hardpoint compatibility where applicable, muzzle geometry, visual configuration, a custom behavior identifier, and behavior-specific configuration.

Weapon statistics and balancing values should remain data-driven whenever possible. A definition says what a weapon is configured to do; it does not implement the gameplay mechanics. For example, cadence, cooldown, energy cost, damage, projectile speed, spread, range, and geometry belong in data when the selected behavior can consume them as parameters.

### TypeScript behaviors: gameplay mechanics

TypeScript contains the programmed gameplay behavior. Possible shared or specialized behaviors include generic projectile firing, burst firing, charge and release, homing or guided projectiles, cluster and fragmentation weapons, beam or laser mechanics, alien particle manipulation, and other genuinely unique mechanics.

A weapon does not automatically need its own TypeScript file. Prefer a generic shared behavior first, then a shared implementation for a related family, and a dedicated implementation only for genuinely unique mechanics. Keep numerical values in Lua when they can be expressed as validated behavior parameters.

### Stable behavior IDs and future registry

Lua definitions should name a stable behavior ID, for example:

```lua
behavior = "weapon.charge_lance"
```

A future TypeScript `WeaponBehaviorRegistry` would map explicitly registered IDs to implementations. Content cannot provide TypeScript import paths or trigger arbitrary dynamic module loading. Every ID must resolve to a registered implementation; unknown IDs should produce useful validation errors. A generic fallback is allowed only when the future schema explicitly defines it.

The registry is a proposed integration mechanism. This proposal is not a reason to create a new manager prematurely.

### `behavior` and `firingMode`

These fields have different roles. `behavior` selects the programmed TypeScript behavior, for example `behavior = "weapon.charge_lance"`. `firingMode` is the existing operation field in `WeaponOperation`; the current `Weapon.activate()` uses it to choose among its supported firing paths. It describes the current firing/compatibility mechanism and does not identify a TypeScript behavior.

During migration, a definition without `behavior` continues to use the existing `firingMode` dispatch. Once a definition has a registered `behavior`, that behavior is the single authority for activation dispatch. A transitional adapter may pass `firingMode` to that behavior as legacy configuration when explicitly declared, but it must not independently dispatch a second firing path or override the selected behavior. New behavior-backed definitions should use behavior-specific configuration contracts instead of relying on `firingMode` for behavior selection. The eventual decision to remove, retain, or absorb `firingMode` into operation data is open; until then, compatibility behavior must be explicit and deterministic.

## Hardpoint Compatibility Ownership

The hull mount is authoritative about which component configurations it permits. The existing `WeaponHardpoint.accepts` field expresses whether a mount accepts spinal weapons, turret weapons, or both. A weapon definition must not duplicate that mount capability as a competing list of configurations.

If weapon-side compatibility data is needed, model it as an additional weapon requirement (for example, a required mount capability or restriction), not as another declaration of what the mount accepts. An installation is valid only when the mount accepts the weapon's configuration and all weapon requirements and mount restrictions are satisfied. The two sides combine conjunctively: weapon requirements can narrow eligible mounts, but cannot make a mount accept a configuration it rejects. Conflicting or unsatisfied constraints reject the installation; there is no implicit override rule. The exact future requirement fields and restriction vocabulary remain to be designed.

## Definition Data Boundaries

A weapon definition should keep these concerns distinct, even if the eventual Lua syntax nests some of them:

| Data area | Responsibility |
| --- | --- |
| Weapon identity and category | Stable ID, display name, description, category, spinal or turret configuration. |
| Operation | Activation mode, cooldown, energy cost, cadence, charge or burst settings when these are shared operational values. |
| Projectile | Speed, damage, range, spread, lifetime, and other projectile settings. The selected behavior determines which fields it uses. |
| Component attachment and geometry | Attachment transform, mount requirements where needed, barrels, muzzles, and muzzle direction. The hull mount remains authoritative for accepted configurations. |
| Visual configuration | Texture or asset references, fixed and rotating layers, and other presentation data. |
| Behavior selection and configuration | Stable behavior ID plus a behavior-owned validated parameter object. |

For example, a behavior-specific table might look like:

```lua
behaviorConfig = {
    chargeTime = 2.5,
    minimumDamage = 40,
    maximumDamage = 180,
}
```

The TypeScript behavior interprets this table through its own validated configuration contract. The common operation, projectile, geometry, visuals, and behavior-specific configuration remain separate concepts; behavior configuration does not become an untyped dumping ground for general weapon data.

## Activation and Projectile Responsibilities

Custom behaviors should cooperate with shared gameplay infrastructure rather than independently duplicating its common responsibilities:

- Weapon readiness and cooldown.
- Energy consumption.
- Shared weapon transform calculations.
- Projectile ownership and pooling.
- Source attribution and faction information.
- Projectile lifecycle and cleanup.

The existing `WeaponTransform` is the reusable muzzle-transform utility. `ProjectileManager` owns the managed projectile lifecycle, including spawning, pooling, attribution, collision/damage coordination, and cleanup. Future behaviors should use these existing responsibilities where appropriate. The final behavior interface and activation lifecycle hooks remain to be designed.

## Faction Arsenals

Weapon definitions and faction availability are independent. A weapon may be available to more than one faction. Future faction-specific Lua arsenal definitions should reference existing weapon IDs rather than duplicate complete weapon definitions.

Potential future arsenal responsibilities include available weapons, faction manufacturing availability, technology and unlock requirements, equipment restrictions, and faction-specific weapon variants. This document does not finalize a faction economy or technology schema, nor does it define whether variants use inheritance, composition, or explicit separate definitions.

## Lua Parsing and Validation Pipeline

The proposed controlled build-time flow is:

```text
Lua content source
       |
       v
Static Lua parsing
       |
       v
Typed schema validation
       |
       v
Behavior ID resolution
       |
       v
Validated runtime definitions
       |
       v
Existing TypeScript registries
```

The intended Lua subset is restricted and data-oriented. The design does not require arbitrary Lua execution at runtime. Weapon content must not execute unrestricted functions, import arbitrary modules, access the filesystem, or alter the engine environment. A parser should preserve the convenience of Lua tables while enforcing a predictable data schema. No parser dependency is selected by this document.

Parsing, schema validation, and behavior ID resolution are distinct stages. Invalid structure and unknown behavior IDs should report actionable content errors before runtime use. The output is validated runtime definition data consumed by existing TypeScript systems; this does not prescribe a new manager for the pipeline.

## Shipmaker Contract Relationship

Future Lua definitions should eventually map into the typed contracts in `src/types/Shipmaker.ts`, rather than bypass them. The current types already define `ComponentDefinition` variants, including `SpinalWeaponDefinition` and `TurretWeaponDefinition`; `ComponentAttachment`; weapon operation values; spinal and turret geometry; muzzle positions and directions; and visual layers. `Component` currently consumes typed or legacy component definitions. These contracts are the existing integration baseline, not evidence that a Lua parser or content compiler exists.

An eventual conversion boundary would map Lua weapon identity and stats into the appropriate component definition, operation values into the existing operation shape, component mounting into `ComponentAttachment`, and configuration/geometry/visual layers into their typed counterparts. Depending on final design, schema extensions may be needed for `behaviorId` and `behaviorConfig`, as well as fields not represented by the current contracts such as weapon name, description, category, mount requirements, or additional projectile configuration. Such extensions require a separate design and code change; this proposal does not modify TypeScript interfaces. `WeaponHardpoint.accepts` remains the authoritative mount capability field; weapon-side requirements, if introduced, can only narrow compatibility.

The current `Weapon` and `ManagedWeapon` implementations remain authoritative for the runtime paths they support. `WeaponTransform` remains reusable for shared muzzle calculations, while `ProjectileManager` retains managed projectile lifecycle and attribution responsibilities. The final activation API must fit these boundaries without moving projectile ownership into every behavior.

## Arsenal Forgery Reference

Arsenal Forgery's [`blocks.lua`](https://github.com/Arcyriea/Arsenal-Forgery/blob/master/Arsenal%20Forgery/blocks.lua) is useful as organizational inspiration. Its nested cannon and laser configuration, burst and projectile properties, nested fragmentation definitions, turret properties, barrel configuration, visual `shroud` construction, and reusable definitions illustrate ways to group related content.

That file also contains engine-specific syntax, constants, flags, preprocessor directives such as `#include`, and inheritance conventions such as `extends`. Redemptis-Tiariea should not adopt the complete file format or its game-specific engine semantics. The reference informs content organization only; any equivalent concepts need explicit contracts in this project.

## Future Player Control Configuration

Player control settings are separate from weapon behavior IDs. Future control configuration may include player-defined weapon firing groups, spinal and turret activation assignments, manual keyboard activation of installed modules, and configurable ship control profiles. These are player input and ship-control requirements, not weapon gameplay behavior, and are outside this content architecture's implementation scope.

## Proposed Content Organization

One conceptual Lua layout is:

```text
data/
├── weapons/
│   ├── common/
│   ├── human/
│   └── alien/
└── factions/
    ├── human/
    │   └── arsenal.lua
    └── alien/
        └── arsenal.lua
```

One conceptual TypeScript layout is:

```text
src/
└── weapons/
    ├── Weapon.ts
    ├── ManagedWeapon.ts
    ├── WeaponTransform.ts
    ├── WeaponBehavior.ts
    ├── WeaponBehaviorRegistry.ts
    └── behaviors/
        ├── GenericProjectile.ts
        ├── BurstCannon.ts
        ├── ChargeLance.ts
        └── ClusterLauncher.ts
```

These are illustrative responsibilities and locations, not required directories or files. Content compilation/loading would own parsing and validation; a behavior registry would own the explicit mapping of stable IDs to implementations; shared runtime systems would continue to own their existing lifecycle responsibilities.

## Open Decisions

- Which restricted Lua grammar and parser implementation to use, and whether compilation occurs during development, packaging, or both.
- The exact typed schema, versioning and migration policy, diagnostics format, and asset-reference rules.
- The final behavior interface, lifecycle hooks, and division of shared operation handling from specialized mechanics.
- The transition and eventual disposition of `firingMode`, including which legacy definitions retain it and how a behavior-backed adapter consumes it without competing activation dispatch.
- The future weapon-side mount requirement model and restriction vocabulary, while retaining `WeaponHardpoint.accepts` as the authoritative mount capability.
- Which fields belong in shared operation/projectile data versus behavior-specific configuration.
- How to represent inheritance, reusable definitions, and faction-specific variants without obscuring effective data.
- How faction availability, manufacturing, unlocks, and equipment restrictions will be modeled.
- Whether runtime mod loading or hot reload is needed and how it would preserve the restricted content boundary.
- How player control profiles and activation assignments will connect to installed components.

