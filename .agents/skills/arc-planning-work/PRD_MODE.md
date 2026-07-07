# PRD-to-Plan Mode

Load this when the source is a PRD and the requested output is an implementation plan, not new issues.

## Source handling

Confirm the PRD is available from conversation, file, or linked issue. If unavailable, ask for a file path, issue number, URL, or pasted PRD.

## Planning approach

Identify durable architectural decisions before slicing:

- route structures / URL patterns
- database schema shape
- key data models
- auth approach
- third-party service boundaries
- test strategy

Draft tracer-bullet phases: each phase should deliver a narrow but complete path through relevant layers and be demoable or verifiable on its own.

## Output file

Write to:

```text
./plans/<feature>.md
```

unless the user specifies another path.

## Format

```markdown
# Plan: <Feature Name>

> Source PRD: <identifier or link>

## Architectural decisions

- **Routes:** ...
- **Schema:** ...
- **Key models:** ...
- **Auth:** ...

---

## Phase 1: <Title>

**User stories:** <list from PRD>

### What to build

A concise end-to-end description of this vertical slice.

### Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

### Tasks

- [ ] Task with files and test notes
```

## Boundary

If the user wants GitHub issues created from the PRD, use `arc-prd-to-issues` instead.
