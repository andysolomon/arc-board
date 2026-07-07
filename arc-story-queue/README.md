# arc-story-queue

MCP server + desktop board for feeding a story queue to live Claude Code sessions. Fable (arc-orchestrator) pulls the top story, opens an isolated git worktree, and delegates bounded tasks to worker routes.

## Layout

```
arc-story-queue/
  mcp-server/        # headless engine — the source of truth
    server.ts        # MCP tool surface (queue.next, story.*, project.*)
    queue.ts         # queue ordering + worktree/lock manager
  app/               # Tauri desktop client (primary face)
  .mcp.json.example  # how a Claude Code session attaches
```

## The pipeline

1. **Intake** — features / PRD / bug prompt → drafts (potential issues). Backed by an agent (Composer 2.5 for drafting), grounded by a read-only `codex-explore` pass, with deterministic fallback.
2. **File** — a draft is filed through Fable to become a real GitHub issue (gets a number). Drafts cannot be queued until filed.
3. **Plan** — on queue, an `arc-planning-work` pass drafts the execution plan (tasks, file changes, test strategy, AC mapping) → becomes the delegation contract.
4. **Dispatch** — Fable pulls the top queued story into a worktree, up to N in parallel.
5. **Run** — write worker + read-only explore/check run concurrently; writes serialize per worktree.
6. **Handoff** — worker returns structured JSON; Fable accepts or escalates; a PR opens → Review.
7. **Observe** — every run appends a trace record (tokens, duration, model, outcome). Per-project.

## Projects = attached sessions

The app doesn't clone or spawn. It discovers running Claude Code sessions over MCP; attaching one turns its cwd into a project. Board / Queue / Observability scope to the active project.

## Getting started

```bash
pnpm install
pnpm --filter mcp-server dev     # start the MCP server on :7420
pnpm --filter app tauri dev      # start the desktop board
```

Use `Story Queue.dc.html` from the handoff as the visual + interaction reference.
