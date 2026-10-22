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
- **Entity Management:** `src/managers/EntityManager.ts` provides a shared registry for registering, looking up, and unregistering entities by stable unique ID. It is orthogonal to the iteration queues (queueAlly, queueEnemy, etc.) — those handle per-frame updates; EntityManager handles O(1) lookup by ID.
- **Scene Management:** The game uses Phaser scenes for booting and gameplay.
- **Physics:** Utilizes Phaser Arcade Physics.

## Entity Contract

- `src/entities/Entity.ts` defines the minimal structural interface: `id?`, `active`, `removeIt`, and optional `update()`. It is deliberately an interface, not a base class — existing classes (Ship, Effect, PowerUp, Resource, etc.) already satisfy it without inheritance.

## Documentation

This file tracks the architecture and core systems. Future additions should be documented here as they are developed.
