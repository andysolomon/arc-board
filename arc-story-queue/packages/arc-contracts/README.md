# arc-contracts

The shared seam. Both `arc-orchestrator` and `arc-story-queue` import these types/schemas so they evolve together without a runtime dependency on each other.

- `src/index.ts` — TypeScript source of truth.
- `schema/*.schema.json` — JSON Schema for stories, handoffs, plans, run records, projects, and GitHub board bindings (validate at the MCP boundary).

## Outcome mapping

`fable-orchestrator annotate` outcomes map directly to `RunRecord.outcome`:

| Annotate outcome | RunRecord outcome |
| --- | --- |
| `accepted` | `accepted` |
| `rejected` | `rejected` |
| `blocked` | `blocked` |
| `verification-failed` | `verification-failed` |
| `escalated` | `escalated` |

`unrated` is retained for runs that have been recorded before a final annotation is known.

Version this package with semver; a breaking contract change is a major bump that both consumers pin to.
