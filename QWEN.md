# Project brief — Redemptis-Tiariea

## Global rules
Follow `%USERPROFILE%\.qwen\CONVENTIONS.md` (and repo `CONVENTIONS.md` if present).

## Architecture
Follow `ARCHITECTURE.md` in this repository for layout, systems, and entity contract.
Do not invent parallel managers or bypass existing queues/registries.

## Tool boundary
You are **Qwen Code**. `CLAUDE.md` is for Claude Code only.

## Phaser
- Check package.json/lockfile for installed Phaser version (`^4.2.1` declared).
- Phaser 4 APIs only; no Phaser 3 examples.