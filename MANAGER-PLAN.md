# Manager and Systems Architecture Plan

## 1. Purpose and Scope

This document defines the proposed manager and systems architecture for **Redemptis-Tiariea**.

The project is intended to grow into a space-and-ground combat simulation, with multiple entity types, combat layers, autonomous units, fleet coordination, spatial navigation, and resource operations.

To support this growth, the architecture is organized around five primary responsibility domains:

1. Entity Management
2. Combat and Tactical Coordination
3. Spatial Management and Navigation
4. Resource Management and Industrial Operations
5. Shared Gameplay Systems

Each domain represents a distinct area of responsibility. Managers and systems should remain independent where their behaviors and responsibilities differ, while cooperating through clearly defined interfaces.

**Planning status:** This document describes a provisional architectural direction. It does not require every proposed manager or system to be implemented immediately. Implementation should proceed incrementally, based on actual gameplay requirements.

---

## 2. Entity Management

### 2.1 Architectural Objective

Entity management is responsible for the registration, ownership, lookup, and lifecycle coordination of the various entity types within the game world.

Different entity categories should have dedicated managers when their gameplay behavior, movement, collision characteristics, or lifecycle requirements differ significantly.

### 2.2 Proposed Manager Structure

#### EntityManager

The common foundation for entity management.

Responsibilities:
- Entity registration and removal.
- Stable entity ID generation.
- Entity lookup and retrieval.
- Lifecycle cleanup.
- Common entity registration and management behavior.

`EntityManager` should remain a lightweight foundation. Entity-specific movement, rendering, combat, AI, and other specialized behaviors should remain outside its responsibilities.

#### ShipManager

Responsible for ordinary space-faring ships.

Responsibilities:
- Ship entity management.
- Ship blueprint integration.
- Ship component configuration.
- Ship-specific lifecycle coordination.

#### FighterManager

Responsible for fighter-class entities.

Responsibilities:
- Fighter entity management.
- Fighter flight and movement behavior.
- Fighter-specific gameplay logic.

Fighters operate on a separate combat layer above ordinary ships and follow different physical collision rules.

#### CorvetteManager

Responsible for corvette-class entities.

Corvettes occupy an intermediate category between fighters and ordinary ships.

Characteristics:
- Larger than fighters.
- Primarily equipped with turret-based weapon mounts.
- Not large enough to be classified as capital ships.
- Do not possess their own jump drives.
- Operate above the ordinary ship layer with different physical collision behavior.

Their separate management allows corvette-specific behavior to evolve without unnecessarily expanding `ShipManager` or `FighterManager`.

#### TankManager

Responsible for ground-based armored vehicles.

Responsibilities:
- Tank entity management.
- Ground movement.
- Tank-to-tank physical collisions.
- Crushing interactions with infantry.

#### AssaultcraftManager

Responsible for ground-based assaultcraft, occupying an intermediate classification between tanks and infantry.

Characteristics:
- High-speed ground movement.
- Movement speeds comparable to fighters and corvettes, but restricted to ground operations.
- Cannot crush or run over infantry.
- Physical collisions can knock infantry away, with the resulting impact influenced by the assaultcraft's movement speed.

Assaultcraft should retain its own management because its physical interactions and battlefield role differ from both tanks and infantry.

#### InfantryManager

Responsible for infantry entities and their ground-unit behavior.

#### StationManager

Responsible for space stations, platforms, and station-specific operations.

Responsibilities:
- Station entity management.
- Docking operations.
- Hangar operations.
- Station-specific interactions.

Stations may host fighters, tanks, and other entities, but hosting an entity does not transfer ownership of that entity's lifecycle to `StationManager`.

#### AsteroidManager

Responsible for asteroid entities within the game world.

Responsibilities:
- Asteroid entity management.
- Asteroid lifecycle.
- Asteroid-related entity state.

Mining and resource extraction activities should be managed separately from asteroid entity ownership.

### 2.3 Entity Management Boundaries

The following distinctions should be maintained:

- Fighters and corvettes remain separate from ordinary ships because they operate on different physical layers and follow different collision rules.
- Tanks, assaultcraft, and infantry retain distinct managers because their movement and physical interactions differ.
- Stations may host other entity types without taking over their entity management responsibilities.
- `EntityManager` provides shared entity management functionality without accumulating specialized gameplay logic.

These boundaries should prevent individual managers from becoming overloaded with responsibilities belonging to other entity categories.

---

## 3. Combat and Tactical Coordination

### 3.1 Architectural Objective

Combat and coordination systems are responsible for weapon operations, projectile handling, tactical orders, faction relationships, and autonomous unit coordination.

These systems should operate across the different entity categories without requiring every entity manager to implement its own versions of shared combat and coordination logic.

### 3.2 Proposed Manager Structure

#### WeaponManager

Responsible for weapon definitions and weapon operations.

Responsibilities:
- Weapon definitions.
- Weapon mount management.
- Turret behavior.
- Targeting coordination.
- Weapon firing requests.

#### ProjectileManager

Responsible for projectile lifecycle and projectile-related interactions.

Responsibilities:
- Projectile spawning.
- Projectile movement.
- Source attribution.
- Collision handling integration.
- Hit detection and resolution coordination.

Projectiles should retain information about their originating entity and faction where applicable.

#### FleetManager

Responsible for fleet-level organization and coordination.

Responsibilities:
- Fleet membership.
- Fleet orders.
- Coordination of autonomous ships.
- Fleet-level command management.

#### SquadManager

Responsible for tactical squad organization and coordination.

Supported unit categories include:
- Fighters.
- Corvettes.
- Infantry.
- Assaultcraft.

Responsibilities:
- Squad membership.
- Formation management.
- Interception orders.
- Escort behavior.
- Regrouping.
- Squad-level tactical coordination.

Individual entities remain responsible for executing their own movement and actions. Squad coordination should not replace individual entity behavior.

#### FactionManager

Responsible for faction identities, ownership, and diplomatic relationships.

Responsibilities:
- Faction identification.
- Entity and ownership relationships.
- Friendly, neutral, and hostile relationships.
- Faction relationship data for targeting and combat decisions.

### 3.3 Combat and Collision Requirements

Combat must support interactions between entities operating on different physical layers.

The following behaviors are part of the intended gameplay design:

**Space combat**
- Ordinary ships physically collide with other ships, including friendly ships.
- Fighters can fly above ordinary ships without physically colliding with them.
- Point-defense turrets can target fighters operating above the ordinary ship layer.
- Fighter weapons can attack ordinary ships from above.

**Ground combat**
- Tanks physically collide with other tanks.
- Tanks can crush infantry through physical contact.
- Assaultcraft cannot crush infantry.
- Assaultcraft collisions can knock infantry away depending on their movement speed and collision impact.

These interactions should be coordinated through shared collision and combat systems rather than duplicated independently across every entity manager.

### 3.4 System Interaction Example

A fighter squad receives an interception order through `SquadManager`.

Each fighter executes its assigned movement and combat behavior individually.

When a fighter requests weapon fire, `WeaponManager` handles the firing request, while `ProjectileManager` manages the resulting projectile.

`FactionManager` supplies the faction relationship information required for target selection and combat decisions.

This division allows tactical coordination, individual entity behavior, weapon operations, and projectile management to remain independent responsibilities.

### 3.5 Weapon Content and Behavior Architecture (Proposed)

Weapon content authoring is separate from weapon runtime behavior. Future Lua weapon definitions should be parsed and validated into typed runtime definitions, then registered before runtime use. A content compiler or loader and a behavior registry are separate responsibilities. If `WeaponManager` is implemented, it should not parse arbitrary Lua scripts or own every specialized weapon implementation. This proposal does not require a new manager solely for the Lua pipeline. See [Weapon Content and Behavior Architecture](docs/WEAPON-CONTENT-AND-BEHAVIOR-ARCHITECTURE.md) for boundaries, proposed flow, and current status.

The Shipmaker editor (documented in [SHIPMAKER-ARCHITECTURE-HANDOFF.md](docs/SHIPMAKER-ARCHITECTURE-HANDOFF.md)) will author weapon and module definitions as Lua data files under `public/data/weapons/` and `public/data/modules/`. The TypeScript loading infrastructure in `src/` will parse, validate, and register these definitions with the existing `Game.componentDefinitions` registry. Weapon behavior implementations remain registered TypeScript functionality; Lua files describe static configuration and reference stable behavior IDs.

**Note on production Lua distribution:** Vite copies `public/` to production output by default. The unresolved decision (documented in SHIPMAKER-ARCHITECTURE-HANDOFF.md) is whether to (a) ship Lua source in production, (b) configure a custom build strategy to omit `public/data/` while retaining other public assets (Vite's `build.copyPublicDir: false` disables the entire public directory; it cannot selectively exclude a subdirectory), or (c) move authoritative source outside `public/` and expose it only via dev server. This decision affects the dev server design and build pipeline but not the TypeScript loading infrastructure, which reads via HTTP in dev and from generated modules in production.

---

## 4. Spatial Management and Navigation

### 4.1 Architectural Objective

Spatial management represents the different geographical scales of the game world, from local planetary environments to interstellar and galactic navigation.

Each manager should handle the spatial rules and navigation responsibilities appropriate to its scale.

### 4.2 Proposed Manager Structure

#### SectorManager

Responsible for local planetary sectors.

Responsibilities:
- Local hexagonal sector organization around planets.
- Membership within individual sectors.
- Movement between adjacent hexagonal sectors.
- Gravity-supported sector-space boundaries and restrictions.

#### SolarSystemManager

Responsible for star-system organization.

Responsibilities:
- Star-system management.
- Planetary locations.
- Orbital locations.
- Interplanetary navigation.

#### GalacticSectorManager

Responsible for galaxy-scale spatial organization.

Responsibilities:
- Galactic sector organization.
- Star-system locations.
- Interstellar navigation.

### 4.3 Spatial Management Boundaries

The proposed managers represent increasingly large spatial scopes.

Their relationship should represent navigation scale and spatial organization, not necessarily class inheritance or direct ownership.

Entity managers remain responsible for their respective entities, while spatial managers determine where those entities belong within the game world.

For example, moving a ship between sectors should not require recreating that ship or generating a new entity identity.

Entity identity and lifecycle should remain independent of spatial membership.

---

## 5. Resource Management and Industrial Operations

### 5.1 Architectural Objective

Resource management covers mining, extraction, production-related activities, and the management of resources obtained from the environment.

The architecture should distinguish between managing resource-bearing entities and managing activities performed on those entities.

### 5.2 Proposed Systems

#### MiningSystem

Responsible for asteroid mining operations.

Responsibilities:
- Mining operations on asteroids.
- Extraction progress.
- Mining equipment requirements.
- Resource yield calculations.
- Mining operation state.

Asteroid entities themselves remain under `AsteroidManager`.

#### ResourceExtractionManager

Responsible for planetary resource extraction operations.

Responsibilities:
- Planetary extraction sites.
- Resource deposits.
- Extraction and production rates.
- Operational state of extraction facilities.

### 5.3 Resource Management Boundaries

`AsteroidManager` owns and manages asteroid entities, while `MiningSystem` manages the mining activities performed on them.

Similarly, planetary resource entities and extraction activities should remain separate responsibilities where appropriate.

Mining and planetary extraction may eventually share significant amounts of common functionality.

If that happens, a shared resource-extraction system with specialized operation types may be preferable to maintaining two completely independent implementations.

A shared resource and inventory system may also become necessary to coordinate:
- Resource quantities.
- Storage capacity.
- Resource transfers.
- Resource consumption.
- Production and extraction outputs.

The final division between these responsibilities should be determined by the actual gameplay and economic requirements.

### 5.4 Related References

The following references provide additional context for the intended resource and mining direction:

- [Asteroid Mining Could Become One of the First Multi-Trillion Dollar Deep Space Industries](https://images.openai.com/static-rsc-4/18P9HWdbaYJOYSDZ4wUrYae8NqikNf0wpMCn_Y9UB2VA68C8im_Q-NAGjYpXirassOkuQcZCytqTWY_aMwd_SfTee3lEVGs_HxS0FXr0MkVKL7sQZ7m_Cq2jWdUGQSGlhuc-swKkS3PCBeSplvrxU3K1J4L-hTEpZasvh-QzhGM?purpose=inline)
- [The Crust Story](https://images.openai.com/static-rsc-4/bYFscaj5MD3h8gWrh5A6QOvLPptjZ63RasTjGXvKDnxvudiRoNuPXgAEUI7DJeHVrf8u6Iuc7X4Na_PelUAsVqqKVsqS91BMi9bOqkd6OmYWsPLfYK01Yn2VmeIB25cTlGmk6Bm9xTL7gO14r1tiTT4dTzpzSp8xWRiWcm-IbbE?purpose=inline)

---

## 6. Shared Gameplay Systems

### 6.1 Architectural Objective

Some gameplay responsibilities span multiple entity categories and manager domains.

These responsibilities should be implemented as shared systems rather than forcing individual managers to duplicate the same logic.

Not every shared system needs to become a separate manager or class immediately.

### 6.2 Proposed Shared Systems

| System | Responsibility |
|---|---|
| Collision / Interaction System | Physical collisions, movement blocking, tank crushing, and entity-to-entity interactions. |
| PlanetManager | Planet entities and planet-specific state, if these responsibilities are not already covered by another system. |
| Resource / Inventory System | Resource quantities, storage, transfers, and consumption across mining and extraction operations. |
| DamageSystem (future consideration) | Shared damage calculations and damage resolution if combat complexity eventually justifies a dedicated system. |

### 6.3 Shared System Boundaries

Shared systems should provide common functionality to the relevant managers without taking over their specialized responsibilities.

For example:
- A collision system resolves interactions between different entity categories.
- A damage system may eventually handle shared damage calculations.
- An inventory system manages resource quantities and transfers rather than taking ownership of mining or extraction operations.

The objective is to reduce unnecessary dependencies and prevent individual managers from becoming responsible for unrelated gameplay systems.

---

## 7. Consolidated Architecture Overview

The following structure summarizes the proposed manager and system organization.

### Entity Management
- `EntityManager`
- `ShipManager`
- `FighterManager`
- `CorvetteManager`
- `TankManager`
- `AssaultcraftManager`
- `InfantryManager`
- `StationManager`
- `AsteroidManager`
- Potentially `PlanetManager`

### Combat and Tactical Coordination
- `WeaponManager`
- `ProjectileManager`
- `FleetManager`
- `SquadManager`
- `FactionManager`
- Collision / Interaction System
- Potentially `DamageSystem`

### Spatial Management and Navigation
- `SectorManager`
- `SolarSystemManager`
- `GalacticSectorManager`

### Resource Management and Industrial Operations
- `MiningSystem`
- `ResourceExtractionManager`
- Potentially a shared Resource / Inventory System

This is a responsibility map, not a mandatory inheritance hierarchy or a requirement to create every listed class.

---

## 8. Architectural Principles and Development Approach

The proposed architecture should follow several guiding principles.

### 8.1 Maintain Clear Responsibility Boundaries

Each manager should own a well-defined area of responsibility.

Managers should not accumulate unrelated behaviors merely because those behaviors involve the same entity type.

Entity ownership, individual behavior, tactical coordination, spatial navigation, and shared gameplay interactions should remain distinct concerns.

### 8.2 Prefer Shared Systems for Cross-Entity Behavior

Interactions involving multiple entity categories should be handled through appropriate shared systems.

Collision, targeting, and damage calculations should work across entity types without requiring every manager to understand the internal implementation of every other manager.

### 8.3 Avoid Premature Implementation

The proposed architecture should evolve alongside actual gameplay requirements.

A manager or system should be introduced when a meaningful responsibility boundary exists, rather than creating a large number of empty managers simply because different entity types have been identified.

Implementation should proceed incrementally, prioritizing the systems required by the current stage of gameplay.

### 8.4 Keep Simulation Responsibilities Separate from Rendering

Managers should own or coordinate gameplay state and entity lifecycles without necessarily owning every rendering detail.

Phaser display objects should remain separate from the underlying simulation responsibilities wherever practical.

This separation will make it easier to expand the game world, change rendering behavior, and introduce additional gameplay systems without tightly coupling simulation logic to Phaser's rendering objects.

---

## 9. Planning Status

This document serves as the provisional architectural reference for the manager and systems structure of Redemptis-Tiariea.

The proposed structure establishes:
- Which responsibilities belong to individual managers.
- Which gameplay behaviors should be shared across entity categories.
- How combat, tactical coordination, and navigation interact.
- How resource operations should remain separate from entity ownership.
- Which additional systems may become necessary as gameplay complexity increases.

The architecture is intended to evolve as the game develops. Individual managers and systems should be specified, implemented, and validated when their respective gameplay requirements become concrete.

**The objective is to establish a maintainable foundation for expanding Redemptis-Tiariea without prematurely committing to unnecessary complexity.**

---

## 10. Cross-References to Shipmaker Architecture

The Shipmaker editor architecture is documented in [SHIPMAKER-ARCHITECTURE-HANDOFF.md](docs/SHIPMAKER-ARCHITECTURE-HANDOFF.md). Key integration points:

- **Game registries**: The `Game` class owns canonical typed registries (`hullDefinitions`, `componentDefinitions`, `shipLoadouts`) that Shipmaker will populate from Lua source files under `public/data/`.
- **Component definitions**: Weapon and module definitions authored in Shipmaker become `ComponentDefinition` entries in `Game.componentDefinitions`, preserving the distinction between static Lua configuration and TypeScript behavior implementations (see [WEAPON-CONTENT-AND-BEHAVIOR-ARCHITECTURE.md](docs/WEAPON-CONTENT-AND-BEHAVIOR-ARCHITECTURE.md)).
- **ShipManager**: Remains the ship catalogue and creation owner; it resolves blueprint `hullId` and `loadoutId` through `Game` registries.
- **WeaponManager**: If implemented, should consume validated component definitions from `Game.componentDefinitions` rather than parsing Lua directly. The Lua parsing/validation pipeline lives in `src/` infrastructure, not in a manager.
- **No parallel registries**: Shipmaker's Save & Apply workflow writes Lua source files; the TypeScript loading infrastructure reads, validates, and registers them. No duplicate registries are introduced.