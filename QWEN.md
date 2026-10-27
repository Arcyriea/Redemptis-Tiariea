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

## Initiative (hard rules)

Default state: **idle**. Do not start work, exploration, or tool use on your own.

### Never do unless the user explicitly asks
- Suggest "next steps", feature menus, or "what should we work on"
- Explore the repo, run searches, or read files "to get oriented"
- Write tests, refactors, migrations, or scaffolding
- Open other projects or paths outside this working directory
- Implement anything that was not requested in the latest user message

### When the user only asks a question
- Reply with **text only**
- **No tools** (no read/list/search/shell) unless they say you may use tools
- No offers to implement or "I can also..."

### When the user gives a task (implement / edit / fix)
1. Output at most a **3-sentence** plan that matches CONVENTIONS.md
2. **STOP** — do not call tools, do not edit files
3. Wait until the user types exactly: `approved`
4. Then do **only** what that plan described
5. If scope must grow, stop again and ask for a new `approved`

### Response shape
- Factual questions → direct answer only
- Tasks → plan only, then wait
- Do not end replies with engagement bait or option lists unless the user asks for options

### Priority
If this section conflicts with being "helpful", **this section wins**.
User message of the current turn wins over memory.