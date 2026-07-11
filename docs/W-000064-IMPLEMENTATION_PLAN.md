# W-000064 — Ship-modes tests, docs, and major release — Implementation Plan

## Product goal & scope

Close out the ship-modes epic after W-000060–W-000063 merge by running a full test sweep, updating integration docs, verifying a semantic-release major bump, and archiving planning artifacts. Work happens on branch `feat/W-000064-ship-modes-docs-release`. Scope is test fixes, documentation, release verification, and artifact archival — no new feature implementation.

## Current baseline

Closes out the ship-modes epic after W-000060–W-000063 merge. Test suites live at `arc-story-queue/test/` (vitest over compiled dist; `npm test` at `arc-story-queue/` builds, runs daemon suites, then app tests). `docs/INTEGRATION.md` documents the Fable pull loop (:13, :75) but not ship modes or the review loop. There is no lint script — "lint" resolves to the app's `tsc --noEmit` inside its build. semantic-release runs on conventional commits; the major bump is driven by W-000061's `BREAKING CHANGE` footer.

## Missing capabilities

- Full test suite may have drift from squash/merge-gate changes in feature stories
- `docs/INTEGRATION.md` and README lifecycle diagram do not document ship modes or review loop
- semantic-release major bump has not been dry-run verified
- Epic and per-story planning artifacts have not been archived to `docs/archive/`

## Milestones

### Implementation

**Goals**

- Ship-modes integration docs, full-suite green, major release dry run, and epic archive

**Deliverables**

1. **Full-suite sweep**
   - Files: `arc-story-queue/test/*.test.ts`, `arc-story-queue/app/test/*`
   - Details: run `cd arc-story-queue && npm test`; fix any drift the four feature stories left (including `merge-remediation.test.ts` and `pr-readiness.test.ts`, which touch merge paths that switched to squash).

2. **INTEGRATION.md + README lifecycle**
   - Files: `docs/INTEGRATION.md`, `README.md`
   - Details: document `shipMode` (`pr`/`auto`/`merge` semantics, auto arming only after approval), the review loop (rounds, verdicts, `MaxRoundsExceeded` escalation), the `story.review_round` tool contract, the `story.merge` gate + `override`, and the gate-authority note (app gate authoritative; GitHub branch protection an independent backstop). Update the README lifecycle diagram to show review-loop rounds between PR-open and merge.

3. **semantic-release dry run**
   - Files: none (verification)
   - Details: `npx semantic-release --dry-run` on the branch; confirm a **major** bump with breaking-change notes for the merge gate and squash switch (from W-000061's commit footer).

4. **Archive planning artifacts**
   - Files: `docs/ship-modes-IMPLEMENTATION_PLAN.md`, `docs/ship-modes-progress.txt`, `docs/W-00006[0-4]-IMPLEMENTATION_PLAN.md`, `docs/W-00006[0-4]-progress.txt` → `docs/archive/`
   - Details: move the epic plan/tracker and the five per-story artifacts; mark all progress items `[x]` first.

**Dependencies**

- Depends on all of W-000060–W-000063 being merged.

**Risks**

- Depends on all of W-000060–W-000063 being merged.
- If the dry run shows minor instead of major, the W-000061 breaking-change footer was lost in squash — fix by amending the squash commit message convention on that PR before release.

**Acceptance criteria**

| Criterion | Task(s) | How Verified |
| --- | --- | --- |
| Full suite green | #1 | CI run on the PR |
| INTEGRATION.md + README updated | #2 | manual read-through |
| Major release dry run | #3 | `npx semantic-release --dry-run` output |
| Artifacts archived | #4 | files under `docs/archive/`, gone from `docs/` |

## Out of scope / deferred

Covered by sibling stories W-000060–W-000064.

## Immediate next steps

1. Create branch `feat/W-000064-ship-modes-docs-release`
2. Begin task 1: Full-suite sweep
