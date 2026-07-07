---
name: arc-implementation-plan-progress
description: Implementation-plan/progress tracker creation for software projects. Use when a user asks for an implementation plan, phased roadmap, gap analysis against a spec, or synchronized `IMPLEMENTATION_PLAN.md` and `progress.txt` execution tracker. Do not use for creating GitHub user-story backlogs.
---
# Arc Implementation Plan Progress

Create two synchronized root-level artifacts:

- `IMPLEMENTATION_PLAN.md` or a clearly named variant
- `progress.txt` with checkbox execution tracking mapped to the plan phases

The leading word is **synchronized**: every progress item must trace to the plan, and every plan phase must have progress coverage.

For the required output shape, load [references/output-contract.md](references/output-contract.md). For default stack assumptions, load [STACK_DEFAULTS.md](STACK_DEFAULTS.md) only when the user has not specified a stack.

## Steps

1. **Gather repository and request context.**
   - Read existing `README*`, planning docs, `progress.txt`, and relevant source structure.
   - Identify user-provided specs/ideas and whether they are available locally.
   - Prefer explicit `unknown` notes over invented details.

   Completion criterion: the baseline section can cite concrete repo evidence or explicitly mark unavailable facts as `unknown`.

2. **Choose plan mode.**
   - Greenfield mode: no meaningful implementation exists; plan from zero.
   - Gap mode: implementation exists; compare current baseline to target scope and plan missing work.

   Completion criterion: the plan states its mode and why that mode fits the observed repo state.

3. **Write the implementation plan.**
   - Follow the contract in `references/output-contract.md`.
   - Include objective, scope boundaries, baseline, milestones, deliverables, dependencies, risks, acceptance criteria, deferred/out-of-scope work, and immediate next steps.
   - Include concrete test tasks aligned to user-focused behavior, not implementation-detail coupling.

   Completion criterion: every milestone has deliverables, dependencies/risks where relevant, and acceptance criteria that another agent can verify.

4. **Create or update `progress.txt`.**
   - Run or follow `scripts/init_progress_txt.sh <plan-file> [progress-file]` when useful.
   - Preserve completed `[x]` items when updating an existing tracker.
   - Use stable numeric IDs (`1.0`, `1.1`, `2.0`) and ASCII checkboxes.

   Completion criterion: every plan phase has a phase-level checkbox and concrete sub-step checkboxes; completed prior work remains completed.

5. **Validate synchronization.**
   - Check that each progress item maps to a plan phase.
   - Check that each plan phase appears in `progress.txt`.
   - Replace vague tasks such as "improve app" with concrete deliverables.

   Completion criterion: the final response names both artifact paths and confirms plan/progress synchronization or lists the exact unresolved mismatch.

## Boundaries

- Use `arc-creating-user-stories` when the user wants GitHub Issues with Gherkin user stories.
- Use `arc-planning-work` when the user asks to plan implementation of an existing tracked work item rather than create root-level plan/progress artifacts.
