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

Columns: **Backlog** → **Queued** → **In Progress** → **Review** → **Done**. Story labels live in `story.tags`, imported from GitHub issue labels.

1. **Intake** — features / PRD / bug prompt → drafts (potential issues). Backed by an agent (Composer 2.5 for drafting), grounded by a read-only `codex-explore` pass, with deterministic fallback.
2. **File** — a draft is filed through Fable to become a real GitHub issue (gets a number). Drafts cannot be queued until filed.
3. **Plan** — on queue, an `arc-planning-work` pass drafts the execution plan (tasks, file changes, test strategy, AC mapping) → becomes the delegation contract.
4. **Dispatch** — `queue.next` reserves the top **eligible** queued story into a worktree (up to global `maxParallel`, default 2). Label mutex groups (`epic:` / `parallel-group:` prefixes on `story.tags`) gate dispatch: a story is skipped when any of its mutex keys is already held by an in_progress story — the next eligible story dispatches instead of stalling the queue.
5. **Run** — write worker + read-only explore/check run concurrently; writes serialize per worktree. **Start** (`story.start`) re-emits an SSE `started` event so the headless `arc-worker` re-dispatches execution; the daemon itself never runs a model.
6. **Handoff** — worker returns structured JSON; Fable accepts or escalates via `story.complete` (handoff + PR → Review). Drag-to-Review or `story.review` for GitHub repos **always** opens a real PR; if the branch has no commits it first creates an empty commit, then pushes the branch and runs `gh pr create`. `local://` sentinel PRs are only for local (non-GitHub) repos — never for GitHub repos.
7. **Observe** — every run appends a trace record (tokens, duration, model, outcome). Per-project.
8. **GitHub reconcile** — a shared daemon timer (`prReconcileIntervalMs`, default 60s) runs `reconcileReviewPrs()` and `reconcileInProgressIssues()` on every tick. Review PRs: merged → Done + worktree removed; closed unmerged → evicted to Backlog (worktree preserved for recovery). In-progress issues: closed on GitHub → story deleted entirely + worktree removed (not moved to Backlog). Review does not hold closed PRs indefinitely.

## Projects = attached sessions

The app doesn't clone or spawn. It discovers running Claude Code sessions over MCP; attaching one turns its cwd into a project. Board / Queue / Observability scope to the active project.

**Local `Project` ≠ GitHub Project.** An attached session `Project` is ephemeral (in-memory registry). A **GitHub Project** binding is durable SQLite state keyed by `repo` (`project.github_board.get` / `link` / `ensure`), used to mirror board columns via a single-select field (`Status` when option names already match columns, otherwise `Arc Column`). One GitHub Project per repo by convention (`Arc Board · <repo-name>`). Call `project.github_board.ensure` with `autoCreate: true` to create when missing.

Outbound: column transitions sync Status when a binding exists. Inbound: the shared reconcile timer refreshes `story.githubBoardColumn`, skips `queue.next` for remote `in_progress|review|done`, and reflects other remote Status values onto non-reserved stories (local worktree reservations always win). Orchestrator view exposes Ensure / Link URL / Open on GitHub and last sync health.

## Getting started

```bash
npm install
npm test                         # builds workspaces and runs the daemon + app tests
npm run build                    # builds arc-contracts and the MCP server
npm run start -w story-queue-mcp # start the MCP server on :7420
npm run dev -w arc-story-queue-app # start the Vite web board
```

The current supported client runtime is the Vite web app in `app/`. Tauri packaging is deferred to a later desktop shell; any Tauri scripts/files are optional and not part of the v1 getting-started path.

> **Restart the daemon after rebuilding it.** The daemon registers its MCP tool
> set once at process startup and runs from compiled `dist/`, so a process
> started before a rebuild keeps serving the old tool set. The board detects
> this skew and names the missing tool with restart guidance instead of a raw
> `MCP error -32602` (W-000034).

## Fable pull loop

From a live Claude Code/Fable session, use the helper to register the session, attach the current repo, reserve the next queued story, and print the assignment prompt:

```bash
npm run fable:pull -- --path /absolute/path/to/repo --model "<current-model>"
```

Then stream progress with `npm run fable:update -- --id <story-id> --line "..."` and complete with `npm run fable:complete -- --id <story-id> --pr <url> --handoff handoff.json --runs runs.json`. See `skills/fable-pull-loop/SKILL.md`.

## Headless auto-worker

`arc-worker` is the no-human event loop for the board. Start the daemon, attach the board to a project, then run:

```bash
npm run arc-worker -- --path /absolute/path/to/repo
```

The worker subscribes to daemon `story.event` broadcasts, reacts to `started` events created by the board's `queue.next`, runs the configured executor inside the story worktree, streams `story.update` lines, commits changed files, and calls `story.review` to move the card to Review.

Executor options:

- `--executor claude` (default): runs Claude Code CLI subscription auth with `claude -p`, `--output-format stream-json --verbose`, `--permission-mode acceptEdits`, and a generated MCP config for the daemon.
- `--executor cursor`: runs `ARC_WORKER_CURSOR_COMMAND` or `cursor-agent` with the story prompt on stdin.
- `--executor command --command "<shell command>"`: runs any compatible headless agent command.
- `--executor dry-run`: test-only proof executor.

For subscription auth, the worker unsets `ANTHROPIC_API_KEY` before spawning `claude -p` so Claude Code can use the signed-in Pro/Max OAuth credentials (or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`). Do not run the executor with `--bare`, because that skips the local Claude Code credentials.

Use `Story Queue.dc.html` from the handoff as the visual + interaction reference.
