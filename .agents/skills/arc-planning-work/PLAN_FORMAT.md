# Implementation Plan Format

Use this shared format for GitHub and Agile Accelerator implementation plans.

```markdown
## Implementation Plan

**Story:** [source ID] Title
**Branch:** `feat/<source-id>-short-description`

### Analysis

Brief summary of what needs to change and why, based on reading the actual code.

### Tasks

- [ ] **1. [Task title]**
  - Files: `path/to/file.ts`, `path/to/test.ts`
  - Details: Specific change and sequencing notes

- [ ] **2. [Task title]**
  - Files: `path/to/file.ts`
  - Details: Specific change and sequencing notes

### Test Strategy

- [ ] **Unit tests:** file path and behavior to test
- [ ] **Integration/E2E tests:** scenario to cover
- [ ] **Manual QA:** visual or interactive checks

### Acceptance Criteria Mapping

| Scenario / Criterion | Task(s) | How Verified |
| --- | --- | --- |
| Source criterion | #1, #2 | Unit / E2E / Manual |

### Risks & Notes

- Edge cases, dependencies, or decisions to flag
```

## Quality rules

- Read source files before planning.
- Tasks are atomic and reviewable.
- Order tasks so each builds on previous work: data/types before consumers, utilities before UI, tests alongside behavior.
- Map every source acceptance criterion or Gherkin scenario to tasks and verification.
- Include specific test file paths and test names where possible.
- Do not start implementation in this skill.
