# W-000060 — Contracts: shipMode + reviewLoop substate — Implementation Plan

## Product goal & scope

Extend the Story contract with `shipMode` and `reviewLoop` fields so downstream daemon, skill, and UI stories can persist and validate ship-mode state and review-loop substates. Work happens on branch `feat/W-000060-ship-mode-contracts`. Scope is limited to additive contract types, schema mirrors, normalization defaults, and contract-validation tests — no consumer behavior changes.

## Current baseline

The Story contract (`arc-story-queue/packages/arc-contracts/src/index.ts:199-228`) has no ship-mode or review-loop fields. The schema has **two sources of truth** that must stay in sync: the inline `storySchema` (index.ts:533-586, drives `validateStory()`) and the standalone `schema/story.schema.json` mirror — both with `additionalProperties: false`, so every new field must be named in both. `normalizeStory()` (index.ts:771-827) hydrates fields with defaults and needs guard lines for the new fields. The approved⇒blockingCount===0 invariant can copy the `allOf/if/then` conditional pattern already used by `orchestrationPlanObjectSchema` (index.ts:488-498).

## Missing capabilities

- `ShipMode`, `ReviewVerdict`, `ReviewLoop` types and Story field extensions do not exist
- Inline `storySchema` does not define `shipMode` or `reviewLoop`
- `schema/story.schema.json` does not mirror the new fields
- `normalizeStory()` does not hydrate defaults for `shipMode` / `reviewLoop`
- Contract-validation tests do not cover round-trip, legacy, unknown verdict, or invariant rejection

## Milestones

### Implementation

**Goals**

- Add ship-mode and review-loop types, schema, normalization, and tests to arc-contracts

**Deliverables**

1. **Add types: `ShipMode`, `ReviewVerdict`, `ReviewLoop`, and Story fields**
   - Files: `arc-story-queue/packages/arc-contracts/src/index.ts`
   - Details: `export type ShipMode = 'pr' | 'auto' | 'merge'`; `export type ReviewVerdict = 'pending' | 'changes_requested' | 'approved'`; `export interface ReviewLoop { round: number; maxRounds: number; verdict: ReviewVerdict; blockingCount: number }`. Extend `Story` (near :219-225) with `shipMode?: ShipMode` and `reviewLoop?: ReviewLoop | null` following the existing optional-field style (`pr?: string | null`).

2. **Extend the inline `storySchema`**
   - Files: `arc-story-queue/packages/arc-contracts/src/index.ts` (properties block :556-584)
   - Details: add `shipMode` (enum of three values) and `reviewLoop` nested object schema (copy `bugDetailSchema` shape pattern :509-520; all four props required inside, `additionalProperties: false`). Encode the invariant with `allOf/if/then` (pattern :488-498): if `verdict` is `approved` then `blockingCount` is `const 0`. Fields stay optional (not in `required`).

3. **Mirror both fields in `schema/story.schema.json`**
   - Files: `arc-story-queue/packages/arc-contracts/schema/story.schema.json`
   - Details: identical property definitions + invariant; keep top-level `additionalProperties: false` (:176) intact.

4. **Hydrate defaults in `normalizeStory()`**
   - Files: `arc-story-queue/packages/arc-contracts/src/index.ts` (:771-827)
   - Details: default `shipMode` to `'pr'` when absent; pass `reviewLoop` through unchanged when present, else leave undefined (spread-guard pattern at :803-825). Legacy stories without the fields must normalize and validate.

5. **Contract-validation tests**
   - Files: `arc-story-queue/test/contract-validation.test.ts`
   - Details: extend `makeStory(overrides)` fixture (:63-106). Cases: (a) story with both fields round-trips `validateStory`; (b) legacy fixture without the fields passes (style of :178-205); (c) unknown `verdict` rejected (`expect(() => validateStory(x)).toThrow(/Invalid Story/)`, style of :159-167); (d) `verdict:'approved'` with `blockingCount: 2` rejected.

**Dependencies**

- Inline schema and story.schema.json drift is the main hazard — change both in the same commit.
- Additive-only: no `required` changes, no consumer behavior changes; W-000061/63 consume these types.

**Risks**

- Inline schema and story.schema.json drift is the main hazard — change both in the same commit.
- Additive-only: no `required` changes, no consumer behavior changes; W-000061/63 consume these types.

**Acceptance criteria**

| Criterion | Task(s) | How Verified |
| --- | --- | --- |
| shipMode + reviewLoop round-trip validation | #1-#4, #5a | `cd arc-story-queue && npm test` |
| Legacy stories still validate | #4, #5b | legacy-fixture test |
| Unknown verdict rejected | #2, #5c | rejection test |
| approved + blockingCount>0 rejected | #2, #3, #5d | invariant test |

## Out of scope / deferred

Covered by sibling stories W-000060–W-000064.

## Immediate next steps

1. Create branch `feat/W-000060-ship-mode-contracts`
2. Begin task 1: Add types: `ShipMode`, `ReviewVerdict`, `ReviewLoop`, and Story fields
