# Story Queue — build handoff

An orchestration board that queues **stories** and feeds them to live **Claude Code** sessions over MCP, where **Fable** (arc-orchestrator) delegates bounded tasks to worker routes (composer / codex / opus) in isolated git worktrees.

## Repo strategy (recommended)

Three logical packages, dependency arrow points **toward** the orchestrator — the orchestrator never depends on the app.

| Package | What it is | Depends on |
|---|---|---|
| `arc-orchestrator` | Existing Claude Code plugin (delegation, routes, lock rules) | — |
| `arc-contracts` | Shared schema: handoff, routes, story, run record | — |
| `arc-story-queue` | MCP server + desktop app (this prototype) | `arc-contracts` |

Start `arc-story-queue` as a **new repo** that depends on `arc-orchestrator` via the extracted `arc-contracts`. Promote to a monorepo (`apps/`, `packages/`) only if the contract starts churning in lockstep with consumers. Never nest the app inside the plugin repo.

## Form factor

Build the **engine as a headless local service** (MCP server + worktree/lock manager + session discovery). The Kanban is one client of it:

- **Desktop (primary)** — Tauri app; full board, drawers, live worker terminals, observability. Needs the local filesystem for git worktrees + spawning agents.
- **TUI (secondary)** — in-terminal "what's running / dispatch next / tail a run".
- **Web (read-mostly)** — remote dashboard over a tunnel; approve drafts, reorder, monitor.

## What's in this handoff

- `DESIGN_SYSTEM.md` + `tokens.css` + `tokens.json` — the visual language of the prototype.
- `arc-contracts/` — TypeScript types + JSON Schemas for the shared seam.
- `arc-story-queue/` — MCP server stubs, queue/worktree/lock manager stub, app notes.
- `BUILD_PROMPT.md` — paste into Claude Code to scaffold the project.

The working UI prototype (`Story Queue.dc.html`) is the source of truth for layout and interaction.
