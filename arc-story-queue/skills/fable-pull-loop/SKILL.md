# Fable Story Queue Pull Loop

Use this skill inside a live Fable / Claude Code session when the operator asks this session to work the Story Queue, pull the next queued story, or run model-driven implementation through `arc-story-queue`.

## Invariant

The daemon never runs a model. This live session is where all planning, implementation, review, and delegation happen. The daemon only stores queue state, worktrees, locks, SSE updates, handoffs, and run records.

## Prerequisites

1. The daemon is running on the local machine:
   ```bash
   cd arc-story-queue
   npm run daemon
   ```
2. This Claude Code session has the shared HTTP MCP server configured, for example:
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
3. Run from the repository root that should become the attached project, or pass `--path <repo>`.

## Pull the next story

Preferred helper CLI:

```bash
cd arc-story-queue
npm run fable:pull -- --path /absolute/path/to/repo --model "<current-model-id>"
```

The helper performs deterministic plumbing only:

1. `session.register` with repo/path/branch/model/pid.
2. `project.attach` for the current cwd.
3. `queue.next` to reserve the top **eligible** queued story and create its worktree. Eligibility respects global `maxParallel` and label mutex groups (`epic:` / `parallel-group:` on `story.tags`); stories whose group is busy are skipped and the next eligible story dispatches.
4. One `story.update` line announcing that Fable pulled the story.
5. Prints a JSON assignment containing `project`, `story`, and a ready-to-follow prompt.

If `queue.next` returns no story, check whether all queued stories are blocked on mutex keys (`waiting · <key> in progress`) or the global `maxParallel` cap before retrying.

If not using the helper, call the MCP tools directly in the same order:

1. `session.register({ repo, path, branch, model, pid })`
2. `project.attach({ sessionId })`
3. `queue.next({ projectId })`
4. `story.update({ id, route: "fable", line: { kind: "out", text } })`

## Work the story

After `queue.next` returns a story:

1. Treat `story.worktree` as the implementation working directory.
2. Read the story title, description, criteria, scenarios, and persisted plan.
3. If no plan exists, create one in-session before coding. Do not ask the daemon to think.
4. Delegate bounded workers from Fable as appropriate:
   - `composer-implement` / `codex-implement` for write work in the worktree.
   - `codex-explore`, `codex-check`, and `opus-review` for read-only routes.
5. Stream meaningful progress through `story.update` before/after commands and at phase boundaries.

Helper CLI for a progress line (add `--lane-status done` on a worker's final line so the drawer stops that lane's caret):

```bash
npm run fable:update -- --id <story-id> --route codex-explore --kind out --line "Mapping files" --lane-status running
npm run fable:update -- --id <story-id> --route codex-explore --kind ok --line "Explore complete" --lane-status done
```

Direct MCP equivalent:

```json
{
  "id": "<story-id>",
  "route": "codex-explore",
  "line": { "kind": "ok", "text": "Explore complete" },
  "lane": { "route": "codex-explore", "status": "done" }
}
```

## Complete the story

When implementation is ready:

1. Ensure changes are committed in the story worktree.
2. Open or attach a PR URL.
3. Prepare a strict handoff JSON:
   ```json
   {
     "status": "completed",
     "summary": "What changed and why",
     "changes": ["file/path.ts — change made"],
     "verification": ["command run and result"],
     "risks": ["known risk or none"],
     "next_actions": ["follow-up or none"]
   }
   ```
4. Prepare one or more run records with backend/model/tokens/duration/outcome.
5. Call `story.complete`.

Helper CLI:

```bash
npm run fable:complete -- \
  --id <story-id> \
  --pr https://github.com/owner/repo/pull/123 \
  --handoff /tmp/handoff.json \
  --runs /tmp/runs.json \
  --outcome accepted
```

Direct MCP equivalent:

```json
{
  "id": "<story-id>",
  "handoff": { "status": "completed", "summary": "...", "changes": [], "verification": [], "risks": [], "next_actions": [] },
  "pr": "https://github.com/owner/repo/pull/123",
  "runs": [],
  "outcome": "accepted"
}
```

## Ship the story

`story.complete` lands the story in the `review` column with an open PR and a
review loop initialized from the story's ship mode (`shipMode`, default `pr`):
`reviewLoop = {round: 0, maxRounds: 3, verdict: "pending", blockingCount: 0}`.
Acceptance is no longer granted at PR-open — an approved review round is what
sets `annotation = accepted`.

Run the review loop one round at a time (max `maxRounds`, default 3):

1. Run `arc-pr-review-loop <PR#>` — the premium reviewer posts blocking and
   nit comments on the PR.
2. Workers fix the blocking findings in the story worktree. Workers stay
   prohibited from commit/push/merge; the parent Fable session commits and
   pushes each round's fixes.
3. Record the round via `story.review_round`:
   ```json
   {
     "id": "<story-id>",
     "verdict": "changes_requested",
     "blockingCount": 2,
     "prCommentsUrl": "https://github.com/owner/repo/pull/123#pullrequestreview-1"
   }
   ```
   `verdict` is `changes_requested` or `approved`; `approved` requires
   `blockingCount` 0.
4. On `approved`: call `story.merge` (squash merge). In `auto` ship mode the
   daemon arms squash auto-merge at approval, so no `story.merge` call is
   needed.
5. If a further round is attempted after `maxRounds` rounds still requesting
   changes, `story.review_round` fails with a structured `MaxRoundsExceeded`
   error and the story is annotated `escalated`. Escalate to the operator:
   merge with `story.merge {"override": true}` or send the story back to
   `in_progress` for a larger fix.

Ship modes: `pr` (default) opens the PR and runs this loop; `auto` runs the
same loop with squash auto-merge armed on approval; `merge` squash-merges
immediately after PR creation with no loop (readiness checks and merge
remediation still apply).

## Failure / blocked path

If the story cannot proceed, stream the reason with `story.update`, then either:

- complete with `handoff.status = "blocked"` and `outcome = "escalated"`, or
- leave it in progress only if a human is actively investigating.

Never silently hold a worktree lock with no streamed explanation.
