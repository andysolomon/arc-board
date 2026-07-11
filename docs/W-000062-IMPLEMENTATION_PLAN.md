# W-000062 — Fable pull-loop skill: run the PR review loop — Implementation Plan

## Product goal & scope

Document the ship step and PR review loop in the Fable pull-loop skill so workers follow the correct MCP call sequence after `story.complete` lands a story in review. Work happens on branch `feat/W-000062-pull-loop-review-step`. Scope is docs-only updates to SKILL.md plus verification of the existing `arc-pr-review-loop` pin — no runtime daemon or UI changes.

## Current baseline

`arc-story-queue/skills/fable-pull-loop/SKILL.md` sections: Invariant (:5), Prerequisites (:9), Pull the next story (:29), Work the story (:56), Complete the story (:85), Failure/blocked path (:128). The skill currently **ends at `story.complete`** (which moves the story to review) — there is no ship/merge step at all. Two corrections vs the epic plan: (a) the ship step must build on the `story.complete` path, not a separate `story.review` call; (b) `skills-lock.json` lives at the **repo root** and **already pins `arc-pr-review-loop`** (:58-63) and `arc-git-pr-check` (:34-39), so the "pin" AC reduces to verifying the existing pin resolves.

## Missing capabilities

- SKILL.md lacks a "## Ship the story" section documenting the review loop and MCP calls
- Existing `arc-pr-review-loop` pin in `skills-lock.json` has not been verified as resolvable
- Parity against arc-orchestrator PR #102 ship section has not been confirmed

## Milestones

### Implementation

**Goals**

- Add ship step documentation with PR review loop to fable-pull-loop skill

**Deliverables**

1. **Add a "## Ship the story" section to SKILL.md**
   - Files: `arc-story-queue/skills/fable-pull-loop/SKILL.md` (new section after "Complete the story", after :126)
   - Details: document the loop per round — after `story.complete` lands the story in review with an open PR: run `arc-pr-review-loop <PR#>` (premium reviewer posts blocking/nit PR comments); workers fix in the worktree (workers stay prohibited from commit/push/merge — the parent Fable session pushes each round); record the round via `story.review_round {verdict, blockingCount, prCommentsUrl}`; on `approved` → `story.merge`; on `MaxRoundsExceeded` (after `maxRounds`, default 3) → stop and escalate to the operator per the daemon contract (`story.merge {override:true}` or back to `in_progress`). Name the exact MCP calls in order.

2. **Verify the existing `arc-pr-review-loop` pin resolves**
   - Files: `skills-lock.json` (repo root, :58-63)
   - Details: confirm `source`/`skillPath`/`computedHash` resolve against arc-skills; refresh the hash only if stale. Do not add a duplicate entry.

3. **Parity check against arc-orchestrator PR #102**
   - Files: SKILL.md (read-only comparison)
   - Details: read arc-orchestrator's story-queue-session ship section and confirm call order, round accounting, and escalation wording match.

**Dependencies**

- Depends on W-000061 (the `story.review_round` tool and gate must exist for the skill text to be truthful).
- External dependency: the `arc-pr-review-loop` skill lives in arc-skills; if its released content drifts from PR #11, the pinned hash verification in task #2 catches it.

**Risks**

- Depends on W-000061 (the `story.review_round` tool and gate must exist for the skill text to be truthful).
- External dependency: the `arc-pr-review-loop` skill lives in arc-skills; if its released content drifts from PR #11, the pinned hash verification in task #2 catches it.

**Acceptance criteria**

| Criterion | Task(s) | How Verified |
| --- | --- | --- |
| Skill names exact MCP calls per round + 3-round escalation | #1, #3 | manual read-through for parity |
| arc-pr-review-loop pinned and resolvable | #2 | skills-lock.json entry resolves |

## Out of scope / deferred

Covered by sibling stories W-000060–W-000064.

## Immediate next steps

1. Create branch `feat/W-000062-pull-loop-review-step`
2. Begin task 1: Add a "## Ship the story" section to SKILL.md
