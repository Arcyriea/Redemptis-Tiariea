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

## Initiative — Explicit User Control

**Default state:** Idle. Do not initiate work without a user request.

### Questions
- When the user asks a factual or conceptual question, answer in text only.
- Do not use tools or inspect files unless the user authorizes investigation.

### Explicit Tasks
- Treat a direct request to implement, edit, fix, test, or write a specified item as an explicit task, regardless of how small it is.
- Do not interpret a clear action request as a question merely because it uses question phrasing.
- Read only the files necessary to complete the requested task. Do not perform unrelated exploration or make unrequested changes.
- For trivial, reversible, single-file edits, execute the request directly without a separate planning round.
- For multi-file changes, architectural changes, destructive operations, or tasks with significant uncertainty, provide a plan of no more than three sentences and wait for the exact response `approved`.
- After approval, execute only the approved plan. If the scope must expand, stop and request approval for the expanded scope.

### Missing Information
- Never claim that there is no explicit task when the user has clearly specified an action and its target.
- If essential information is genuinely missing, identify precisely what is missing. Do not use ambiguity as a reason to abandon an otherwise actionable task.

### Scope and Architecture
- Follow the applicable `CONVENTIONS.md` and `ARCHITECTURE.md`.
- Respect existing managers, queues, registries, and entity contracts.
- Do not add unrelated features, abstractions, refactors, or scaffolding.
- Use the installed Phaser version and its documented APIs.
- `CLAUDE.md` is for Claude Code only, unless the user explicitly directs otherwise.