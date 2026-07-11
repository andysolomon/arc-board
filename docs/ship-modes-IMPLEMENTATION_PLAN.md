# Ship Modes & PR Review Loop Alignment — Implementation Plan

**Mode:** gap analysis (implementation exists; this plan closes the delta to the new arc release model)

## Objective

Align arc-board's story shipping with the ecosystem's new release model (arc-skills PR #11, arc-orchestrator PR #102): explicit ship modes (`pr` | `auto` | `merge`), a PR review loop between PR-open and merge (premium reviewer posts PR comments, workers fix, rounds tracked, max 3 by default), and merge authority gated on an approved verdict instead of being granted implicitly at PR creation.

Decisions already made (2026-07-11):
- **Native ship modes.** The daemon keeps its own `gh`/`git` mechanics in `queue.ts` (readiness snapshots, structured merge errors, Composer remediation) and implements the same ship *semantics* as `arc-git-pr-check --ship`; it does not shell out to the skill script.
- **Review loop is a substate of the `review` column.** No new column; the story carries `reviewLoop` fields (round, verdict, blocking count) that the review drawer renders.

## Scope boundaries

- In scope: `arc-story-queue` contracts, daemon (`mcp-server`), fable-pull-loop skill, board app review drawer, tests, integration docs.
- Out of scope: the arc-skills repo itself, arc-orchestrator plugin internals, board columns/enum changes, worktree lifecycle, Composer remediation internals (it already never merges).

## Baseline (evidence)

- Columns are `backlog → queued → in_progress → review → done` (`arc-story-queue/packages/arc-contracts/src/index.ts:13`); no loop substate exists.
- `queue.review` pushes the branch, runs `gh pr create`, and sets `column=review`, `prState=open`, **`annotation=accepted` immediately** (`arc-story-queue/mcp-server/queue.ts:390,411`) — acceptance is granted before any review happens.
- Merge is operator-driven and unconditional: review drawer "Merge PR & clean worktree" (`arc-story-queue/app/.../StoryDrawer.tsx:521-559`) → MCP `story.merge` (`mcp-server/server.ts:320`) → `queue.merge`/`mergePr` (`queue.ts:788-884`), which uses `gh pr merge --merge --delete-branch` (merge commit, not squash — ecosystem standard is squash).
- MCP tools `story.review` / `story.merge` / `story.complete` take no ship-mode parameter (`server.ts:280,310,320`).
- W-000054 already added `PrReadinessStrip` + `queue.prReadiness` (`queue.ts:1087`); W-000055 added merge-blocked Composer remediation (`merge-remediation.ts:170`, prohibited from merging at `:83-91`). Both are building blocks this plan extends, not replaces.
- `docs/INTEGRATION.md:13,75` documents the Fable pull loop; `skills-lock.json` pins `arc-work-issue` but nothing references `arc-git-pr-check` or `arc-pr-review-loop` yet.
- Working tree is clean; the W-000057 analyze-fallback work is committed (`eb76fe3`).

## Milestones

### Phase 1 — Contracts: ship mode + review-loop substate

Deliverables:
- `arc-contracts`: `Story.shipMode: 'pr' | 'auto' | 'merge'` (default `'pr'`) and `Story.reviewLoop?: { round: number; maxRounds: number; verdict: 'pending' | 'changes_requested' | 'approved'; blockingCount: number }`. Invariant: `verdict='approved'` requires `blockingCount === 0`; schema/contract validation rejects the combination otherwise.
- `story.schema.json` updated (additive; `additionalProperties: false` means the schema must name every new field).
- `contract-validation.test.ts` covers both fields, including rejection of unknown verdicts and rejection of `approved` with `blockingCount > 0`.

Acceptance criteria:
- [ ] A story serialized with `shipMode` and `reviewLoop` round-trips through contract validation
  - Verify: `npm test` in `arc-story-queue` passes with new contract-validation cases
- [ ] Stories persisted before this change still validate (fields optional/defaulted)
  - Verify: contract test loading a legacy fixture without the new fields passes
- [ ] Contract validation rejects `reviewLoop.verdict='approved'` when `blockingCount > 0`
  - Verify: `contract-validation.test.ts` case asserting the rejection

### Phase 2 — Daemon: ship-aware review, gated merge

Deliverables:
- `story.review` accepts `ship` (default `'pr'`) and `maxRounds` (default `3`, stored in `reviewLoop.maxRounds`): `pr` = open PR, set `reviewLoop = {round: 0, maxRounds: <param>, verdict: 'pending', blockingCount: 0}` (review loop initialized, NO auto-merge armed); `auto` = behaves like `pr` at PR-open (review loop initialized, NO auto-merge armed); when a `story.review_round` records verdict `approved`, the daemon then enables GitHub squash auto-merge so the PR merges without a manual `story.merge` call; `merge` = squash-merge immediately after PR creation via `mergePr` (existing readiness/remediation path). Merge mode calls `mergePr` directly after PR creation and is therefore intentionally not subject to the `story.merge` verdict gate; it remains subject to the existing readiness checks and remediation path.
- `queue.review` stops setting `annotation=accepted` at PR-open; an `approved` `story.review_round` is what sets `annotation=accepted`.
- New MCP tool `story.review_round` recording `{verdict, blockingCount, prCommentsUrl?}`, incrementing `round`; after round `maxRounds` completes with verdict `changes_requested`, a further `story.review_round` call fails with a structured `MaxRoundsExceeded` error; the story stays in the `review` column with its last verdict, and an annotation records escalation to the operator, whose options are `story.merge {override: true}` or sending the story back to `in_progress`.
- `story.merge` gated: requires `reviewLoop.verdict === 'approved'` unless called with `override: true` (operator escape hatch, logged in annotations).
- `mergePr` switches `gh pr merge --merge` → `--squash` to match the ecosystem.

Note: the daemon's `reviewLoop.verdict` gate is the authoritative application-level gate; GitHub branch protection, when present, is an independent backstop and is never relaxed by the daemon; `override: true` bypasses only the app-level gate, never GitHub's.

Dependencies: Phase 1. Risks: gating `story.merge` and switching merge-commit → squash are breaking behavior changes for existing operators; the story implementing them carries a `BREAKING CHANGE` footer, and semantic-release should cut a major release (see Phase 5). The override flag plus a clear structured error keeps the old path reachable; squash-merge changes history shape on consuming repos (release notes call it out).

Acceptance criteria:
- [ ] `story.review` with each ship mode produces the correct behavior; auto-merge is armed only after approval
  - Verify: new `queue.test.ts` cases per mode (gh calls mocked)
- [ ] `story.review` accepts `maxRounds` (default 3) and initializes `reviewLoop.maxRounds` from the param
  - Verify: `queue.test.ts` case with custom `maxRounds` and default omitted
- [ ] `story.merge` without an approved verdict returns a structured `ReviewPending` error and merges with `override: true`
  - Verify: `merge-errors.test.ts` + `lifecycle.test.ts` cases
- [ ] PR-open no longer marks the story `accepted`; an approved `story.review_round` sets `annotation=accepted`
  - Verify: `queue.test.ts` asserts annotation unset until an approved `story.review_round`
- [ ] After `maxRounds` with verdict `changes_requested`, a further `story.review_round` fails with structured `MaxRoundsExceeded` and records operator-escalation annotation
  - Verify: new `queue.test.ts`/`merge-errors.test.ts` case asserting the structured error and annotation after the max round

### Phase 3 — Fable pull-loop skill: run the review loop

Deliverables:
- `arc-story-queue/skills/fable-pull-loop/SKILL.md` gains the ship step mirroring arc-orchestrator PR #102: after implementation, `story.review` with `ship: 'pr'`, then `arc-pr-review-loop <PR#>` (premium reviewer posts blocking/nit comments; workers fix in the worktree; the Fable session pushes each round and records it via `story.review_round`), then `story.merge` after approval.
- Workers stay prohibited from commit/push/merge; the parent session performs mechanics.
- Pin `arc-pr-review-loop` in `skills-lock.json`.

Dependencies: Phase 2; arc-pr-review-loop skill released in arc-skills (external, not owned by this plan). Risks: Phase 3 blocks if that skill is unreleased.

Acceptance criteria:
- [ ] Skill text names the exact MCP calls per round and the 3-round escalation path
  - Verify: manual read-through against arc-orchestrator's story-queue-session section for parity
- [ ] `arc-pr-review-loop` pinned in `skills-lock.json` and resolvable
  - Verify: skills-lock.json entry present and resolvable

### Phase 4 — Board UI: review-loop visibility and gated merge

Deliverables:
- Review drawer: review-rounds strip (round n/maxRounds, verdict badge, blocking-findings count, link to PR comments) alongside `PrReadinessStrip`.
- Merge button disabled with reason until `verdict === 'approved'`; explicit "Override & merge" secondary action mapping to `story.merge {override: true}`.
- Board card shows a compact loop indicator on `review`-column stories with `verdict !== 'approved'`.

Dependencies: Phases 1–2. Risks: drawer crowding — reuse the readiness-strip visual language.

Acceptance criteria:
- [ ] Drawer renders round/verdict/blocking data from a story fixture and gates the merge button
  - Verify: app component tests (existing StoryDrawer/boardActionError suites extended)

### Phase 5 — Tests, docs, release

Deliverables:
- Updated suites: `queue.test.ts`, `lifecycle.test.ts`, `merge-errors.test.ts`, `merge-remediation.test.ts`, `pr-readiness.test.ts`, `contract-validation.test.ts`, app tests.
- `docs/INTEGRATION.md` documents ship modes, the review loop, and the `story.review_round` tool; README lifecycle diagram updated.
- Conventional commits per story so semantic-release cuts the version and CHANGELOG.
- On completion, move `docs/ship-modes-IMPLEMENTATION_PLAN.md` and `docs/ship-modes-progress.txt` to `docs/archive/`.

Acceptance criteria:
- [ ] Full suite green: `npm test` in `arc-story-queue` and app tests
  - Verify: CI run on the PR
- [ ] semantic-release dry run shows a major release with the breaking-change notes for the merge gate and squash switch
  - Verify: `npx semantic-release --dry-run` on the branch
- [ ] Plan and progress tracker archived under `docs/archive/`
  - Verify: files exist under `docs/archive/` and are no longer at `docs/`

## Deferred / out of scope

- Auto-merge mode surfacing in the UI beyond a status chip (auto is primarily an orchestrator concern).
- Migrating existing `done` stories' historical annotations.
- Delegation of daemon mechanics to the `arc-git-pr-check` script (explicitly decided against; revisit only if the two implementations drift).

## Immediate next steps

1. Phase 1 contracts change on a `feat/ship-modes-contracts` branch.
2. Define stories per phase in the tracker (W-numbered) so the board can dogfood this plan through its own queue.
