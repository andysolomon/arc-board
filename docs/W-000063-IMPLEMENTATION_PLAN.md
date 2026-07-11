# W-000063 — Board UI: review-loop visibility and gated merge — Implementation Plan

## Product goal & scope

Expose review-loop state in the board UI and gate the merge action on review verdict, with an operator override path, so review-column stories show round/verdict progress and cannot merge until approved. Work happens on branch `feat/W-000063-review-loop-ui`. Scope is React components, store wiring, and component tests — daemon contract and tool behavior are sibling stories.

## Current baseline

In `arc-story-queue/app/src/components/StoryDrawer.tsx`, the review section renders `<PrReadinessStrip story readiness stale/>` (:491) then `<ReviewActions .../>` (:492); `ReviewActions` (:497-561) computes `gateBlocked` (:510-514) and renders the merge `AsyncButton` (:526-541) calling `store.mergeStory(story.id)`. `PrReadinessStrip.tsx` (`data-testid="pr-readiness-strip"`, chips at :98-131) is the visual language to mirror. The board card is `StoryCard.tsx` with a badges row (:91-115; annotation badge :101-107). App tests are vitest+jsdom with `reviewStory(overrides)` / `storeStub(board, readiness, opts)` fixtures (`app/test/story-drawer-review.test.tsx:9-62`).

## Missing capabilities

- `ReviewRoundsStrip` component does not exist
- StoryDrawer does not mount a review-rounds strip
- Merge button is not gated on `reviewLoop.verdict`; no Override & merge action
- StoryCard lacks a compact loop indicator for review-column stories
- Component tests do not cover strip rendering, merge gating, override, or card indicator

## Milestones

### Implementation

**Goals**

- Add review-loop strip, gated merge with override, and compact card indicator to the board UI

**Deliverables**

1. **`ReviewRoundsStrip` component**
   - Files: `arc-story-queue/app/src/components/ReviewRoundsStrip.tsx` (new)
   - Details: mirror PrReadinessStrip chips; `data-testid="review-rounds-strip"`; renders round n/maxRounds, verdict badge, blocking-findings count, and a PR-comments link when `prCommentsUrl` present. Render nothing when `story.reviewLoop` is absent (legacy stories).

2. **Mount the strip in the drawer**
   - Files: `arc-story-queue/app/src/components/StoryDrawer.tsx` (between :491 and :492)
   - Details: `<ReviewRoundsStrip story={story}/>` alongside PrReadinessStrip.

3. **Gate the merge button + Override & merge**
   - Files: `arc-story-queue/app/src/components/StoryDrawer.tsx` (`ReviewActions` :497-561), the board store module
   - Details: extend `gateBlocked` reasoning: when `reviewLoop` exists and `verdict !== 'approved'`, disable the merge button with a visible reason ("review round n/m — verdict pending/changes requested"); add a secondary "Override & merge" `AsyncButton` (beside :531) calling `store.mergeStory(story.id, {override: true})`. Extend the store's `mergeStory` to pass `override` through to MCP `story.merge`.

4. **Compact loop indicator on review-column cards**
   - Files: `arc-story-queue/app/src/components/StoryCard.tsx` (badges row :91-115)
   - Details: for `column === 'review'` stories with `reviewLoop` and `verdict !== 'approved'`, render a compact indicator (e.g. `↻ 1/3`) near :114; nothing for approved or loop-less stories.

5. **Component tests**
   - Files: `arc-story-queue/app/test/story-drawer-review.test.tsx`, new `app/test/story-card-review-loop.test.tsx`
   - Details: extend `reviewStory(overrides)` with `reviewLoop` fixtures. Cases: strip renders round/verdict/blocking/link from fixture; merge button disabled + reason when verdict pending; enabled when approved; Override & merge invokes `mergeStory` with `{override: true}` (vi.fn assertion via `storeStub`); card indicator renders for pending-verdict review story and not for approved.

**Dependencies**

- Depends on W-000060 (types) and W-000061 (`story.merge` override param must exist server-side).

**Risks**

- Depends on W-000060 (types) and W-000061 (`story.merge` override param must exist server-side).
- Drawer crowding: reuse the readiness-strip visual language (W-000054) as the plan directs.

**Acceptance criteria**

| Criterion | Task(s) | How Verified |
| --- | --- | --- |
| Drawer renders review-rounds strip from fixture | #1, #2, #5 | story-drawer-review tests |
| Merge disabled with reason until approved; Override & merge → `story.merge {override:true}` | #3, #5 | drawer tests with storeStub |
| Compact loop indicator on review cards | #4, #5 | story-card test |

## Out of scope / deferred

Covered by sibling stories W-000060–W-000064.

## Immediate next steps

1. Create branch `feat/W-000063-review-loop-ui`
2. Begin task 1: `ReviewRoundsStrip` component
