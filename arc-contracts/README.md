# arc-contracts

The shared seam. Both `arc-orchestrator` and `arc-story-queue` import these types/schemas so they evolve together without a runtime dependency on each other.

- `src/index.ts` — TypeScript source of truth.
- `schema/*.schema.json` — JSON Schema for the handoff and story (validate at the MCP boundary).

Version this package with semver; a breaking contract change is a major bump that both consumers pin to.
