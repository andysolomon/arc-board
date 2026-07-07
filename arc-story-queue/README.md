# arc-story-queue

MCP server + Vite web board for feeding a story queue to live Claude Code sessions. Fable (arc-orchestrator) pulls the top story, opens an isolated git worktree, and delegates bounded tasks to worker routes.

## Layout

```
arc-story-queue/
  packages/arc-contracts/  # shared TypeScript types + JSON Schemas (single source of truth)
  mcp-server/              # headless engine — the source of truth
    server.ts              # MCP tool surface (queue.next, story.*, project.*)
    queue.ts               # queue ordering + worktree/lock manager
  app/                     # React + Vite web client
  .mcp.json.example        # how a Claude Code session attaches
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
npm install
npm test                         # builds workspaces and runs the daemon + app tests
npm run build                    # builds arc-contracts and the MCP server
npm run start -w story-queue-mcp # start the MCP server on :7420
npm run dev -w arc-story-queue-app # start the Vite web board
```

The current supported client runtime is the Vite web app in `app/`. Tauri packaging is deferred to a later desktop shell; any Tauri scripts/files are optional and not part of the v1 getting-started path.

## Fable pull loop

From a live Claude Code/Fable session, use the helper to register the session, attach the current repo, reserve the next queued story, and print the assignment prompt:

```bash
npm run fable:pull -- --path /absolute/path/to/repo --model "<current-model>"
```

Then stream progress with `npm run fable:update -- --id <story-id> --line "..."` and complete with `npm run fable:complete -- --id <story-id> --pr <url> --handoff handoff.json --runs runs.json`. See `skills/fable-pull-loop/SKILL.md`.

Use `Story Queue.dc.html` from the handoff as the visual + interaction reference.
