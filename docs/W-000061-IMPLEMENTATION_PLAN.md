# W-000061 — Daemon: ship-aware review, verdict-gated merge, squash — Implementation Plan

## Product goal & scope

Implement ship-aware review, verdict-gated merge, squash merge, and review-round lifecycle in the MCP daemon so stories follow ship-mode semantics and no longer accept prematurely at PR-open. Work happens on branch `feat/W-000061-gated-merge-review-rounds`. Scope is daemon queue/lifecycle/server behavior, new error codes, and test coverage — board UI and skill docs are sibling stories.

## Current baseline

`queue.review(id)` (`arc-story-queue/mcp-server/queue.ts:370-434`) opens the PR and sets `annotation="accepted"` at :411 (and RunRecord outcome `"accepted"` at :427) — acceptance before any review. `queue.merge(id)` (:859-884) merges unconditionally via `mergePr` (:788-837), which runs `gh pr merge <sel> --merge --delete-branch` (:818-822). Structured errors flow through `throwMergeError(boardActionErrorFromMergeFailure(...))` (`merge-errors.ts:221-223`, prefix `ARC_ACTION_ERROR:`), with codes in the `BoardActionErrorCode` union (`arc-contracts/src/index.ts:362-371` + Set :382 + inline schema :662-689). MCP tools are registered in `server.ts` via `server.registerTool` and call a **`StoryLifecycle` wrapper** (lifecycle.ts), not queue directly — `story.review`=:309-317, `story.merge`=:319-327 — so `story.review_round` needs a lifecycle method and SSE event too. The pull-loop's `story.complete` path also lands stories in review; it must flow through the same no-premature-acceptance behavior.

## Missing capabilities

- Error codes `review_pending` and `max_rounds_exceeded` do not exist in contracts
- `queue.review(id, opts)` is not ship-aware and prematurely sets acceptance
- `queue.reviewRound(id, {verdict, blockingCount, prCommentsUrl?})` does not exist
- `queue.merge(id, {override = false})` is not gated on review verdict
- `mergePr` uses `--merge` instead of `--squash`
- Lifecycle and server lack `reviewRound` wiring and extended tool schemas
- `story.complete` path does not initialize `reviewLoop` or suppress premature acceptance
- Tests do not cover per-mode review, maxRounds, merge gate, override, or squash

## Milestones

### Implementation

**Goals**

- Gate merge on review verdict, add ship modes and review rounds to the daemon

**Deliverables**

1. **New error codes `review_pending` and `max_rounds_exceeded`**
   - Files: `arc-story-queue/packages/arc-contracts/src/index.ts`
   - Details: add to `BoardActionErrorCode` union (:362), the Set (:382), and inline `boardActionErrorSchema` enum (:669) so errors round-trip. (Small contracts addendum owned by this story; W-000060 doesn't know these codes.)

2. **Ship-aware `queue.review(id, opts)`**
   - Files: `arc-story-queue/mcp-server/queue.ts` (:370-434)
   - Details: accept `{ship = story.shipMode ?? 'pr', maxRounds = 3}`. All modes: init `reviewLoop = {round: 0, maxRounds, verdict: 'pending', blockingCount: 0}`; **remove** `annotation="accepted"` (:411) and the RunRecord `"accepted"` outcome (:427 → neutral outcome). `pr`/`auto`: open PR only, no auto-merge armed. `merge`: after PR creation call `this.mergePr(story)` + `finishMergedStory` (existing readiness/remediation path; intentionally bypasses the story.merge gate). Persist `shipMode` on the story.

3. **New `queue.reviewRound(id, {verdict, blockingCount, prCommentsUrl?})`**
   - Files: `arc-story-queue/mcp-server/queue.ts`
   - Details: guard column==="review". If `reviewLoop.round >= maxRounds` and verdict still `changes_requested`: `throwMergeError({code: 'max_rounds_exceeded', ...})`, keep story in review, write operator-escalation annotation naming the options (`story.merge {override:true}` or back to `in_progress`). Otherwise increment `round`, set verdict/blockingCount (enforce approved⇒blockingCount===0 via contract validation), store `prCommentsUrl`. On `approved`: set `annotation='accepted'`; if `shipMode==='auto'`, run `gh pr merge <sel> --auto --squash --delete-branch` via commandRunner.

4. **Gate `queue.merge(id, {override = false})`**
   - Files: `arc-story-queue/mcp-server/queue.ts` (:859-884)
   - Details: after the existing guards (:862-879), unless `reviewLoop?.verdict === 'approved'` or `override`, `throwMergeError({code: 'review_pending', ...})` with actions pointing at the review loop and the override. When `override`, write an annotation recording the operator override before merging.

5. **Squash merge**
   - Files: `arc-story-queue/mcp-server/queue.ts` (:818-822)
   - Details: `gh pr merge <sel> --merge --delete-branch` → `--squash --delete-branch`.

6. **Lifecycle + server wiring**
   - Files: `arc-story-queue/mcp-server/lifecycle.ts`, `arc-story-queue/mcp-server/server.ts`
   - Details: lifecycle: extend `review`/`merge` signatures (:85-93 pattern) and add `reviewRound` returning `{value, events: [storyEvent(kind, story)]}` with a new SSE event kind. server.ts: `story.review` inputSchema gains `ship: z.enum(['pr','auto','merge']).optional()` and `maxRounds: z.number().int().positive().optional()`; `story.merge` gains `override: z.boolean().optional()`; register `story.review_round` copying the :309-317 pattern (`verdict: z.enum([...])`, `blockingCount: z.number().int().nonnegative()`, `prCommentsUrl: z.string().optional()`).

7. **Audit the `story.complete` path**
   - Files: `arc-story-queue/mcp-server/queue.ts`, `lifecycle.ts` (:63-73)
   - Details: the pull-loop skill completes via `story.complete`, which moves stories to review — ensure that path also initializes `reviewLoop` per the story's shipMode and no longer records premature acceptance, so both entry points behave identically.

8. **Tests**
   - Files: `arc-story-queue/test/queue.test.ts`, `test/lifecycle.test.ts`, `test/merge-errors.test.ts`
   - Details: use the `commandRunner` mock (`makeQueue` pattern queue.test.ts:59-72; gh-intercept style :945-983). Cases: per-mode review behavior incl. `merge` mode immediate squash and `auto` arming only after approval (`ghCalls` assertions); `maxRounds` param honored + default 3; `merge` without approval → `review_pending` (parse via `parseMergeActionError` :21-25) and succeeds with `override:true` + annotation; annotation unset at PR-open, set by approved round; `max_rounds_exceeded` after the cap with escalation annotation; mergePr asserts `--squash`.

**Dependencies**

- Depends on W-000060 (types/schema must be on main first).

**Risks**

- **BREAKING CHANGE:** the merge gate and squash switch change operator-facing behavior — commit as `feat(daemon)!: ...` with a `BREAKING CHANGE:` footer (drives the major release verified in W-000064).
- The daemon's verdict gate is the authoritative app-level gate; GitHub branch protection remains an independent backstop; `override:true` bypasses only the app-level gate.

**Acceptance criteria**

| Criterion | Task(s) | How Verified |
| --- | --- | --- |
| Each ship mode correct; auto-merge armed only after approval | #2, #3, #8 | queue.test.ts per-mode cases |
| maxRounds param (default 3) | #2, #8 | queue.test.ts param cases |
| ReviewPending gate + override merge | #1, #4, #8 | merge-errors + lifecycle tests |
| No acceptance at PR-open; approved round sets accepted | #2, #3, #7, #8 | queue.test.ts annotation assertions |
| MaxRoundsExceeded terminal + escalation annotation | #1, #3, #8 | queue/merge-errors tests |
| mergePr uses --squash | #5, #8 | mocked gh invocation assertion |

## Out of scope / deferred

Covered by sibling stories W-000060–W-000064.

## Immediate next steps

1. Create branch `feat/W-000061-gated-merge-review-rounds`
2. Begin task 1: New error codes `review_pending` and `max_rounds_exceeded`
