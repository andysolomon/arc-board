# Output Contract

## Plan File
Use `IMPLEMENTATION_PLAN.md` unless user asks for a different filename.

Required sections:
1. Product goal and scope boundaries
2. Current baseline (omit only for true greenfield)
3. Missing capabilities (or full capability map for greenfield)
4. Milestones/phases with:
- goals
- deliverables
- dependencies
- risks
- acceptance criteria
5. Out-of-scope/deferred
6. Immediate next steps

## Progress File
Filename: `progress.txt` in project root unless user specifies otherwise.

Required format:
- Plain text
- Top title line
- One phase-level checkbox plus sub-step checkboxes for each phase
- Stable step IDs (`1.0`, `1.1`, `2.0`, etc.) so updates are merge-friendly

Template:

```txt
Project Name - Progress
Generated: YYYY-MM-DD HH:MM:SS TZ

[ ] 1.0 - Phase 1 - Foundation
    [ ] 1.1 - Task
    [ ] 1.2 - Task
[ ] 2.0 - Phase 2 - Feature Build
    [ ] 2.1 - Task
```

## Quality Bar
- Tie tasks to concrete repository outcomes (files, services, tests, docs)
- Prefer explicit unknowns over assumptions
- Keep wording executable by another LLM without extra prompting
