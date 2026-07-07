# Build prompt — paste into Claude Code

Use this to scaffold the project. Run it from the parent folder that holds your `arc-orchestrator` clone. Attach the handoff folder (this design system, contracts, and stubs) and `Story Queue.dc.html` as references.

---

You are helping me build **arc-story-queue**: an MCP server + Tauri desktop board that queues engineering stories and feeds them to live Claude Code sessions, where Fable (my arc-orchestrator plugin) delegates bounded tasks to worker routes (composer / codex / opus) in isolated git worktrees.

**Context I'm attaching:**
- `Story Queue.dc.html` — a working UI prototype. It is the source of truth for layout, interactions, and the full pipeline. Study it first.
- `handoff/DESIGN_SYSTEM.md`, `tokens.css`, `tokens.json` — the visual language. Use these tokens verbatim.
- `handoff/arc-contracts/` — the shared types + JSON Schemas (Story, Route, Plan, Handoff, RunRecord, Project). This is the contract; do not redefine it.
- `handoff/arc-story-queue/` — MCP server + queue-manager stubs and app notes to build from.

**Repo strategy:** create `arc-story-queue` as a new repo that depends on `arc-contracts` (extract it as its own package). Never make arc-orchestrator depend on the app.

**Build order:**
1. Publish `arc-contracts` (types + schemas) as a local package.
2. Implement `mcp-server`: the tool surface in `server.ts` and the worktree/lock manager in `queue.ts`. Enforce the parallelism law — read-only routes never lock, writes serialize per worktree via an advisory lock keyed by worktree path, separate worktrees parallelize. Persist queue + stories (SQLite is fine). Expose on :7420.
3. Wire `project.discover` / `project.attach` to real MCP session discovery so attaching a running Claude Code session creates a project from its cwd.
4. Build the Tauri app to the prototype's spec, styled with tokens.css: Board, Queue, Observability, Orchestrator, and the card drawer. Board/Queue/Observability scope to the active project.
5. Implement the pipeline guardrails: intake drafts (features/PRD/bug) → file through Fable to a real GitHub issue → arc-planning-work plan on queue → dispatch → parallel worker lanes → structured handoff → per-project observability. Drafts cannot be queued until filed.
6. Agent-backed intake + in-drawer refine call the model through the harness, always with a deterministic fallback.

**Constraints:**
- The app is a thin client; all orchestration lives in the MCP server / Fable.
- Match the design system exactly — dark liquid-glass, one blue accent, semantic status + route colors, mono for machine facts, restrained motion. No emoji, no decorative gradients.
- Keep the handoff JSON and route table conformant to arc-contracts; validate at the MCP boundary with the JSON Schemas.

Start by reading the prototype and `arc-contracts`, then propose a concrete file tree and the `arc-contracts` package before writing the server.
