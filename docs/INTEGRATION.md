# Integration smoke test

This guide gets the local story-queue daemon, the board UI, and one live Fable / Claude Code session connected end-to-end. The expected MCP endpoint is:

```text
http://127.0.0.1:7420/mcp
```

## Prerequisites

- Node.js with the experimental `node:sqlite` module available.
- An authenticated GitHub CLI if you plan to import real issues: `gh auth status`.
- Claude Code with the arc-orchestrator plugin available in the session that will act as Fable.
- A real repository path to attach as the project; use an absolute path in the commands below.

Run the one-time install and build from the repository root:

```bash
cd /absolute/path/to/arc-board/arc-story-queue
npm install
npm run build
```

## Terminal 1: start the daemon

```bash
cd /absolute/path/to/arc-board/arc-story-queue
npm run daemon
```

Success looks like:

```text
arc-story-queue daemon listening on http://127.0.0.1:7420/mcp
```

Keep this terminal running. The daemon owns queue state, worktrees, locks, SSE fan-out, handoffs, and run records. It does not run a model.

## Terminal 2: start the board UI

```bash
cd /absolute/path/to/arc-board/arc-story-queue/app
npm run dev
```

Open the Vite URL printed by the command, usually `http://localhost:5173`.

Expected board state:

1. The titlebar connection pill changes from `Offline` to a connected state.
2. The Orchestrator view shows `Connected` and `http://127.0.0.1:7420/mcp`.
3. After a project is attached by the Fable session, Board, Queue, and Observability scope to that project.

## Terminal 3: start Claude Code / Fable

Configure the shared HTTP MCP server before starting or restarting Claude Code:

```bash
claude mcp add --transport http story-queue http://127.0.0.1:7420/mcp
```

Equivalent `.mcp.json`:

```json
{
  "mcpServers": {
    "story-queue": {
      "type": "http",
      "url": "http://127.0.0.1:7420/mcp"
    }
  }
}
```

Start Claude Code from the repository that should become the attached project, with the arc-orchestrator plugin enabled. Load the story-queue session skill (currently stored in this repo as `arc-story-queue/skills/fable-pull-loop/SKILL.md`) and run the helper:

```bash
cd /absolute/path/to/arc-board/arc-story-queue
npm run fable:pull -- --path /absolute/path/to/project-repo --model "<current-claude-model-id>"
```

The helper performs the required MCP calls in order:

1. `session.register` for the live Claude Code session.
2. `project.attach` for the project repo.
3. `queue.next` to reserve the next queued story and open its worktree.
4. `story.update` to emit the first live terminal line over SSE.

Then follow the assignment prompt printed by the helper. During implementation, stream progress and completion back to the daemon:

```bash
npm run fable:update -- --id <story-id> --route fable --kind out --line "Starting implementation" --lane-status running
npm run fable:update -- --id <story-id> --route fable --kind ok --line "Opened pull request" --lane-status done
npm run fable:complete -- \
  --id <story-id> \
  --pr https://github.com/owner/repo/pull/123 \
  --handoff /tmp/handoff.json \
  --runs /tmp/runs.json \
  --outcome accepted
```

## Queue one story

Use one of these paths before running `fable:pull`:

- In the board, click `+ New Story`, file/import the story, then move it to `Queued`.
- Or import open GitHub issues, then enqueue one in the board:

```bash
cd /absolute/path/to/arc-board/arc-story-queue
npm run import -- owner/repo
```

Imported issues land in Backlog as filed, non-draft stories. Drag one to Queued, or use the card enqueue action.

## Success checklist

The smoke test is passing when all of these are true:

- Daemon is running at `http://127.0.0.1:7420/mcp`.
- Board UI shows a connected state and the attached project repo.
- Fable pulls one queued story through `queue.next`.
- The story card moves to In Progress while Fable works.
- Live terminal lines from `story.update` appear in the board over SSE.
- Fable calls `story.complete` with a strict handoff and run records.
- The story lands in Review with the PR URL and persisted handoff visible in the drawer.
- Observability shows the run record with its outcome.

## Troubleshooting

### Daemon offline

Symptoms:

- Board titlebar says `Offline`.
- Orchestrator view says `Offline`.
- Claude Code or `fable:pull` cannot connect to `127.0.0.1:7420`.

Fix:

```bash
cd /absolute/path/to/arc-board/arc-story-queue
npm run build
npm run daemon
```

If port `7420` is already in use, stop the stale daemon process and restart. Keep Terminal 1 open for the entire smoke test.

### MCP misconfigured

Symptoms:

- Claude Code does not list a `story-queue` MCP server.
- Tool calls fail before `session.register`.
- The board is connected, but the Fable session never appears as an attachable project.

Fix:

```bash
claude mcp add --transport http story-queue http://127.0.0.1:7420/mcp
```

Then restart Claude Code. The server must be configured as HTTP with this exact URL:

```json
{ "type": "http", "url": "http://127.0.0.1:7420/mcp" }
```

Do not configure this as a per-session stdio server; all clients connect to the shared daemon.

### Session not registered

Symptoms:

- Board connects to the daemon but shows no attached project.
- Board, Queue, or Observability says `No project attached`.
- `fable:pull` cannot reserve work for the expected repo.

Fix:

Run the pull helper from Terminal 3 with an absolute project path:

```bash
cd /absolute/path/to/arc-board/arc-story-queue
npm run fable:pull -- --path /absolute/path/to/project-repo --model "<current-claude-model-id>"
```

This registers the session and attaches the project. If you are not using the helper, call `session.register`, then `project.attach`, then `queue.next` through the `story-queue` MCP server in that order.
