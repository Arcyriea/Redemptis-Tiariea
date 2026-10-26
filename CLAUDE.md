# redemptis-tiariea

A Phaser 2D game project, initially translated from ActionScript (AS3).

## Architecture

- **Engine Core:** `src/core/Game.ts` handles the main game loop, entity queues (ships, effects, resources, etc.), spawn management, and system integration.
- **Entities:** `src/entities/` contains ship and other entity logic.
- **UI:** `src/ui/` contains HUD elements like the `MiniMap` and `UIManager`.
- **Game Loop:** Powered by Vite + Phaser 4.2.1.
- **Entry Point:** `src/main.ts` sets up the `BootScene` and `GameScene`.

## Key Systems

- **Object Pooling:** `src/core/ObjectPool.ts` is used for efficient management of game objects like ships, projectiles, and effects.
- **Entity Management:** `src/managers/EntityManager.ts` provides a shared registry for registering, looking up, and unregistering entities by stable unique ID. Managed ships use the single `Game.shipQueue` for per-frame updates; faction identity and relationships are maintained separately by `FactionManager`.
- **Factions and Diplomacy:** `src/managers/FactionManager.ts` owns registered faction identity, ship membership, optional one-group-per-faction political membership, symmetric direct faction relationships, group-level external diplomacy, and explicit bilateral agreements. `resolveRelationship()` uses direct scores for independent pairs and same-group pairs, and group diplomacy for external pairs. Explicit faction/faction agreements outrank group/faction, which outrank group/group; equal-rank conflicting outcomes and group changes that would activate one are rejected. Agreements are bilateral, remain active until revoked, and only set the relationship outcome (Alliance → Ally, Ceasefire → Neutral, Treaty → its declared state). Internal member relationships remain separate from external group diplomacy; no group or diplomatic position is preconfigured.
- **Scene Management:** The game uses Phaser scenes for booting and gameplay.
- **Physics:** Utilizes Phaser Arcade Physics.

## Entity Contract

- `src/entities/Entity.ts` defines the minimal structural interface: `id?`, `active`, `removeIt`, and optional `update()`. It is deliberately an interface, not a base class — existing classes (Ship, Effect, PowerUp, Resource, etc.) already satisfy it without inheritance.

## Documentation

This file tracks the architecture and core systems. Future additions should be documented here as they are developed.
