# app — Vite web board

The primary client is a React + Vite web app, styled with `tokens.css` and following the interaction model from the prototype (`Story Queue.dc.html`). Tauri packaging is deferred/optional and is not required for v1 development.

## Views
- **Board** — 5 columns (Backlog / Queued / In Progress / Review / Done), drag-and-drop, W-ids, DRAFT / BUG·Sn badges, GitHub import, per-project scope via the titlebar switcher.
- **Queue** — running lanes + reorderable up-next, per project.
- **Observability** — per-project trace records + by-model report (runs, acceptance %, mean tokens/duration).
- **Orchestrator** — Fable connection, worker route table, parallelism rules, `.mcp.json`.
- **Drawer** — contract, implementation plan, Gherkin criteria, live parallel worker lanes, structured handoff.

## Guardrails to preserve
- Drafts cannot enter Queued/In Progress until filed as a GitHub issue through Fable.
- Read-only lanes stream in parallel; the write lane shows the worktree lock.
- Acceptance % separates "worker finished" from "Fable kept the result".

## State -> engine
Every mutation is an MCP call to `mcp-server`; the app subscribes to `story.update` for live terminals. Keep the app a thin client — no orchestration logic lives here.

## Agent-backed intake
Drafting (features -> stories, PRD -> slices, bug report), the `codex-explore` grounding pass, and in-drawer refine (split / tighten / dedupe) call the model through the harness. Always keep the deterministic fallback.
