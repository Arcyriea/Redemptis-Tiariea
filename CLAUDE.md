# Claude project rules

Follow `CONVENTIONS.md` (either find it in this project or your global `~/.claude` directory) for scope control, approval (`approved` before edits),
engine workflows, and verification.

Follow `ARCHITECTURE.md` for engine layout, managers, entity contract, and systems.
Do not invent parallel managers or bypass existing queues/registries.

## Tool boundary
You are **Claude Code**. `QWEN.md` is for Qwen Code only.

## This project (short)
- Phaser 4 + Vite; entry `src/main.ts`; core loop `src/core/Game.ts`.