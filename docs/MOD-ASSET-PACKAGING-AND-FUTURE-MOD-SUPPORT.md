# Folder-Driven Asset Packaging and Future Mod Support

**Project:** Redemptis-Tiariea  
**Document type:** Architecture concept / planning archive  
**Status:** Proposed future direction — not implemented  
**Recorded:** 2026-11-06

## 1. Purpose

This document records a future asset-packaging direction for Redemptis-Tiariea: organize the game's private source assets into category folders, generate RTAB `.bin` bundles from that folder structure, and eventually allow mods to contribute additional assets by following the same mirrored folder and registry conventions as the base game.

The aim is to make future mod assets fit into the game's existing asset categories without requiring a new hard-coded bundle definition for every mod.

This is a planning archive. It does not authorize implementation, change the current registry, or imply that modding support already exists.

## 2. Base-game folder structure

The private source tree is the organizational reference for the base game's assets. Its current categories include:

```text
private/
└── assets/
    ├── Ships/
    │   └── ...
    ├── Components/
    │   ├── Aistiaria/
    │   │   └── ...
    │   └── Yutiarin/
    │       └── ...
    └── Turrets-Platforms/
        └── ...
```

The top-level category folders determine the bundle grouping. Nested folders organize assets within a category and are included recursively in that category's bundle.

## 3. Bundle naming convention

Bundle filenames are derived from the top-level category folder names, normalized for filenames. No arbitrary sequential suffixes are required.

The intended current layout is:

| Private source category | Generated RTAB bundle | Current contents |
|---|---|---:|
| `Ships/` | `ships.bin` | 10 ship assets |
| `Components/` | `components.bin` | 19 component assets across Aistiaria and Yutiarin |
| `Turrets-Platforms/` | `turret-platforms.bin` | 2 turret/platform assets |

`ships.bin`, `components.bin`, and `turret-platforms.bin` are separate category bundles. The 21 non-ship assets are **not** intended to be combined into a single `nonships.bin` bundle under this direction.

The `.bin` files use the existing RTAB container format. The RTAB format version is separate from the bundle filename and does not require names such as `ships1.bin` or `components1.bin`.

## 4. Future mod directory convention

If modding support is implemented, a mod should provide an asset directory hierarchy that mirrors the base game's category organization. A conceptual example is:

```text
mods/
└── ExampleFactionMod/
    ├── mod metadata and registry files
    └── assets/
        ├── Ships/
        │   └── ... mod ship assets ...
        ├── Components/
        │   └── ExampleFaction/
        │       └── ... mod component assets ...
        └── Turrets-Platforms/
            └── ... mod turret/platform assets ...
```

The mod's folder hierarchy follows the same conventions as `private/assets/`. The mod also supplies the corresponding registry information in the agreed format, so the game can identify each additional asset and its runtime metadata.

This is a conceptual layout, not a finalized mod manifest or registry schema. Exact filenames, required metadata, versioning, dependencies, and installation locations remain to be designed.

## 5. Merging mod assets into category bundles

When mods are enabled, their additional assets should be included in the matching category bundle alongside the base game's assets.

For example:

```text
Base game Ships ─────────┐
Mod A Ships ──────────────┼──> ships.bin (combined asset set)
Mod B Ships ──────────────┘

Base game Components ────┐
Mod A Components ─────────┼──> components.bin (combined asset set)
Mod B Components ────────┘

Base game Turrets-Platforms ─┐
Mod A Turrets-Platforms ──────┼──> turret-platforms.bin (combined asset set)
Mod B Turrets-Platforms ──────┘
```

A mod that adds assets under `Components/` contributes to `components.bin`; a mod that adds assets under `Ships/` contributes to `ships.bin`. The same principle applies to other recognized top-level asset categories.

The intended result is that mod-provided assets become part of the game's effective asset collection in the corresponding default category bundle. Adding a new subfolder beneath an existing category should not require creating a new bundle. A genuinely new top-level category may result in a new bundle, subject to validation and the game's support for that category.

### Preserve source ownership

The base game and each mod should retain ownership of their own source files. The packaging process should build a combined output from those sources rather than destructively modifying the original base-game assets or a mod's source directory.

This allows a mod to be disabled or removed and the combined outputs to be regenerated without having to reconstruct the original base-game bundle from modified data.

The exact location and lifecycle of combined bundles (for example, generated installation data versus a temporary build output) are future design decisions.

## 6. Registry responsibilities

The folder hierarchy determines **which category bundle receives an asset**. Registry metadata determines **what the asset is and how the game identifies and uses it**.

The future design should preserve that separation:

- Folder structure: category and bundle grouping.
- Asset registry: stable asset identity and runtime metadata such as logical paths, texture keys, aliases, and content types.
- Packager: validates source trees and registries, collects the eligible assets, and builds RTAB bundles.
- Generated manifest: describes the resulting bundles and the assets available to the runtime.

A mod should follow the game's registry conventions. The packager must not silently invent asset IDs, texture keys, aliases, or other required metadata for newly discovered files. Missing or invalid registry entries should be reported and handled according to explicit validation rules.

Potential collision rules still need to be designed. In particular, asset IDs and texture keys from different mods must not accidentally collide. Any intentional replacement or override behavior should be explicit rather than an accidental consequence of file ordering.

## 7. Future filesystem listener

A future listener is intended to keep generated `.bin` files synchronized with changes in the source directories. It may monitor the base game's private asset tree and, if mod support exists, the asset trees and registry files of enabled mods.

The listener should detect relevant events such as:

- New asset files or directories.
- Modified asset files.
- Deleted asset files or directories.
- Renamed or moved files.
- Changes to a mod's registry or enabled state.

When a change occurs, the system should determine which category bundle is affected and regenerate the corresponding output. Changes beneath `Components/`, for example, should affect `components.bin`, including changes inside nested faction folders.

### Reliability expectations

The listener and packager should be designed to:

1. Debounce bursts of filesystem events.
2. Serialize packaging jobs so that overlapping changes cannot publish competing outputs.
3. Rebuild only affected bundles where safe, while retaining a full validation/preparation path.
4. Validate all sources and the completed RTAB output before publication.
5. Publish outputs and the generated manifest consistently, without exposing a partially updated set.
6. Preserve the last valid output if a rebuild fails.
7. Handle file moves, deletions, and registry changes—not only file modifications.
8. Avoid silently registering unknown assets or changing stable identities.
9. Run a complete preparation/validation pass at appropriate startup or build boundaries so missed filesystem events cannot leave stale packaged data indefinitely.

The listener is a future capability. It is not part of the completed Phase 3B.2 migration.

## 8. Mod enablement and regeneration

If modding support is implemented, the effective asset collection should be based on the base game plus the set of enabled and valid mods.

A conceptual rebuild flow is:

```text
Base-game sources + base registry
                 │
Enabled mod sources + mod registries
                 │
                 ▼
       Validate and resolve assets
                 │
                 ▼
       Group by top-level category
                 │
                 ▼
       Build category RTAB bundles
                 │
                 ▼
       Publish bundles and manifest
```

Enabling, disabling, installing, or removing a mod should cause the affected combined category outputs and manifest to be regenerated. The base game's source assets and each mod's own sources should remain independently recoverable.

The precise behavior for dependency resolution, load priority, incompatible mods, duplicate assets, overrides, and runtime installation is not decided in this document.

## 9. Relationship to the current migration

This concept builds on the current private-source organization and RTAB packaging work:

- Phase 3B.2 migrated the 31 registered game SVG sources to mirrored paths under `private/assets/` while retaining the public loose SVG copies.
- The intended category bundles are `ships.bin`, `components.bin`, and `turret-platforms.bin`.
- Phase 3C runtime integration remains a separate phase.
- A filesystem listener and mod-aware asset merging are future work, not completed functionality.

The current registry and packager may still contain explicit bundle assignments. A future implementation must deliberately reconcile those assignments with folder-derived category grouping; this document does not assume that migration has already occurred.

## 10. Open design questions

The following points require a separate design and approval before implementation:

- The exact mod folder layout and required mod metadata.
- Whether each mod has its own registry file and the precise schema/version compatibility rules.
- How stable asset IDs and texture keys are namespaced across mods.
- How duplicate IDs, duplicate texture keys, intentional replacements, and conflicts are handled.
- Whether arbitrary new top-level asset categories are allowed or must first be declared by the game.
- Where combined bundles are stored and whether they are generated during installation, at startup, or in a separate mod build step.
- How mod enable/disable and removal trigger safe regeneration.
- How bundle and manifest publication remains atomic as a group.
- How the system handles untrusted or malformed mod files.
- Which asset types beyond SVG are supported by future bundle generations.

## 11. Scope and status

This document records a future architectural direction only.

It does **not** authorize:

- Implementing a filesystem listener now.
- Changing the current asset registry or bundle assignments.
- Implementing mod installation, enablement, or runtime loading.
- Adding automatic asset IDs or texture keys.
- Changing RTAB v1.0 or the current bundle format.
- Starting Phase 3C or deleting public loose SVG sources.

Any implementation should be proposed as a separately scoped phase, reviewed against the current repository architecture, and explicitly approved before edits begin.
