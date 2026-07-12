import { describe, expect, it } from "vitest";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";
import {
  ROUTES,
  type AnnotateOutcome,
  type Handoff,
  type OrchestrationPlan,
  type Plan,
  type Project,
  type RouteId,
  type RunRecord,
  type Story,
  normalizeStory,
  validateHandoff,
  validateOrchestrationPlan,
  validatePlan,
  validateProject,
  validateRunRecord,
  validateStory,
} from "arc-contracts";

const routeIds: RouteId[] = ROUTES.map((route) => route.id);

const annotateOutcomes: AnnotateOutcome[] = [
  "accepted",
  "rejected",
  "blocked",
  "verification-failed",
  "escalated",
];

const plan: Plan = {
  tasks: ["Add schemas"],
  files: [{ path: "packages/arc-contracts/schema/plan.schema.json", change: "Add schema" }],
  testStrategy: "Validate representative fixtures",
  acMapping: [{ ac: "Schemas validate fixtures", by: "contract-validation.test.ts" }],
};

const handoff: Handoff = {
  status: "completed",
  summary: "done",
  changes: ["a.ts"],
  verification: ["vitest"],
  risks: [],
  next_actions: [],
};

const orchestrationPlan: OrchestrationPlan = {
  status: "planned",
  route: "codex-implement",
  backend: "codex",
  mode: "implement",
  rationale: "The story needs a write-capable implementation route.",
  complexity: "medium",
  plannedAt: "2026-07-10T12:00:00.000Z",
  storyDigest: "sha256:story-1",
  error: "No planning error.",
};

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "story-1",
    wid: "W-000001",
    type: "story",
    title: "Test",
    repo: "test/repo",
    branch: "feat/test",
    worktree: "/tmp/wt/test",
    column: "in_progress",
    priority: "med",
    size: "S",
    epic: "Architecture",
    taskClass: "feature",
    tags: ["contracts"],
    description: "Contract validation covers the persisted story shape.",
    criteria: ["valid stories pass", "invalid stories fail"],
    scenarios: [
      {
        name: "Contract fixtures catch drift",
        steps: [
          ["Given", "valid and invalid contract fixtures"],
          ["When", "schema validation runs"],
          ["Then", "the result is explicit"],
        ],
      },
    ],
    plan,
    draft: false,
    bug: {
      severity: "S3",
      area: "contracts",
      steps: ["Open the board", "Validate the story"],
      rootCause: "packages/arc-contracts/src/index.ts:1 — schema drift",
      fixOptions: ["Centralize contracts in arc-contracts"],
    },
    slice: {
      afk: true,
      blockedBy: null,
      userStoriesCovered: "W-000001",
    },
    ...overrides,
  };
}

function accessForRoute(route: RouteId): RunRecord["access"] {
  return ROUTES.find((candidate) => candidate.id === route)?.access ?? "read-only";
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    storyId: "story-1",
    label: "contract run",
    repo: "test/repo",
    route: "composer-implement",
    backend: "Cursor Agent",
    model: "composer-2.5",
    access: "write",
    tokens: 100,
    durMs: 500,
    status: "completed",
    changed: 1,
    outcome: "accepted",
    ...overrides,
  };
}

const project: Project = {
  id: "project-1",
  repo: "test/repo",
  path: "/tmp/repo",
  branch: "main",
  model: "fable",
  pid: 123,
  worktreeRoot: "/tmp/wt",
  status: "attached",
};

function makeQueue() {
  const store = new StoryStore(":memory:");
  const registry = new SessionRegistry();
  const sse = new SseHub();
  const queue = new QueueManager({ worktreeRoot: "/tmp/wt", maxParallel: 2 }, { store, registry, sse });
  return { store, registry, queue };
}

describe("arc-contracts schema fixtures", () => {
  it("accepts valid Story, Plan, Handoff, RunRecord, and Project fixtures", () => {
    expect(validateStory(makeStory())).toBe(true);
    expect(validatePlan(plan)).toBe(true);
    expect(validateHandoff(handoff)).toBe(true);
    expect(validateRunRecord(makeRun())).toBe(true);
    expect(validateProject(project)).toBe(true);
  });

  it("accepts RunRecord with startedAt and finishedAt timestamps", () => {
    const startedAt = 1_700_000_000_000;
    const finishedAt = startedAt + 500;
    expect(validateRunRecord(makeRun({ startedAt, finishedAt, durMs: 500 }))).toBe(true);
  });

  it("accepts legacy RunRecord without startedAt or finishedAt", () => {
    const legacy = makeRun();
    expect(validateRunRecord(legacy)).toBe(true);
    expect(legacy.startedAt).toBeUndefined();
    expect(legacy.finishedAt).toBeUndefined();
  });

  it("rejects invalid fixtures with clear schema errors", () => {
    const { description: _description, ...storyWithoutDescription } = makeStory();

    expect(() => validateStory(storyWithoutDescription)).toThrow(/Invalid Story:.*description/);
    expect(() => validatePlan({ ...plan, files: [{ path: "x.ts" }] })).toThrow(/Invalid Plan:.*change/);
    expect(() => validateHandoff({ ...handoff, status: "unknown" })).toThrow(/Invalid Handoff:.*status/);
    expect(() => validateRunRecord(makeRun({ route: "unknown-route" as RouteId }))).toThrow(/Invalid RunRecord:.*route/);
    expect(() => validateProject({ ...project, pid: -1 })).toThrow(/Invalid Project:.*pid/);
  });

  it("accepts every live route in an orchestration plan", () => {
    expect(validateOrchestrationPlan({ status: "unplanned" })).toBe(true);
    for (const route of routeIds) {
      const routePlan: OrchestrationPlan = { ...orchestrationPlan, route };
      expect(validateOrchestrationPlan(routePlan)).toBe(true);
      expect(validateStory(makeStory({ orchestration: routePlan }))).toBe(true);
    }
  });

  it("rejects an incomplete planned orchestration plan while keeping error optional", () => {
    const { error: _error, ...planWithoutError } = orchestrationPlan;

    expect(validateOrchestrationPlan(planWithoutError)).toBe(true);
    expect(() => validateOrchestrationPlan({ status: "planned", route: "codex-implement" })).toThrow(
      /Invalid OrchestrationPlan:.*required/
    );
    expect(() =>
      validateStory(makeStory({ orchestration: { status: "planned", route: "codex-implement" } as OrchestrationPlan }))
    ).toThrow(/Invalid Story:.*required/);
  });

  it("rejects an unknown orchestration route and identifies its value", () => {
    expect(() =>
      validateOrchestrationPlan({ ...orchestrationPlan, route: "gpt-9-mega" })
    ).toThrow(/Invalid OrchestrationPlan:.*route=.*gpt-9-mega/);
  });

  it("defaults absent, null, and non-object orchestration state without rewriting objects", () => {
    const preserved = { status: "planned", route: "codex-implement", futureField: "preserve me" };

    expect(normalizeStory(makeStory()).orchestration).toEqual({ status: "unplanned" });
    expect(normalizeStory(makeStory({ orchestration: null })).orchestration).toEqual({ status: "unplanned" });
    expect(normalizeStory({ ...makeStory(), orchestration: "malformed" }).orchestration).toEqual({
      status: "unplanned",
    });
    expect(normalizeStory({ ...makeStory(), orchestration: preserved }).orchestration).toBe(preserved);
  });

  it("accepts a story with shipMode and reviewLoop", () => {
    expect(
      validateStory(
        makeStory({
          shipMode: "auto",
          reviewLoop: { round: 1, maxRounds: 3, verdict: "pending", blockingCount: 2 },
        })
      )
    ).toBe(true);
  });

  it("accepts legacy stories without shipMode or reviewLoop", () => {
    const { shipMode: _shipMode, reviewLoop: _reviewLoop, ...legacyStory } = makeStory({
      shipMode: "pr",
      reviewLoop: { round: 0, maxRounds: 1, verdict: "pending", blockingCount: 0 },
    });

    expect(validateStory(legacyStory)).toBe(true);
  });

  it("rejects reviewLoop with an unknown verdict", () => {
    expect(() =>
      validateStory(
        makeStory({
          reviewLoop: { round: 1, maxRounds: 3, verdict: "rejected" as "pending", blockingCount: 0 },
        })
      )
    ).toThrow(/Invalid Story/);
  });

  it("rejects approved reviewLoop with blockingCount greater than zero", () => {
    expect(() =>
      validateStory(
        makeStory({
          reviewLoop: { round: 2, maxRounds: 3, verdict: "approved", blockingCount: 2 },
        })
      )
    ).toThrow(/Invalid Story/);
  });

  it("normalizes shipMode and reviewLoop shapes", () => {
    const { shipMode: _shipMode, reviewLoop: _reviewLoop, ...legacy } = {
      ...makeStory(),
      shipMode: "pr" as const,
      reviewLoop: null,
    };
    expect("shipMode" in normalizeStory(legacy)).toBe(false);
    expect("reviewLoop" in normalizeStory(legacy)).toBe(false);
    expect(normalizeStory({ ...makeStory(), shipMode: "yolo" }).shipMode).toBe("pr");
    expect(normalizeStory({ ...makeStory(), reviewLoop: null }).reviewLoop).toBeNull();
    const loop = { round: 1, maxRounds: 3, verdict: "pending" as const, blockingCount: 0 };
    expect(normalizeStory({ ...makeStory(), reviewLoop: loop }).reviewLoop).toBe(loop);
    expect("reviewLoop" in normalizeStory({ ...makeStory(), reviewLoop: [] })).toBe(false);
  });
});

describe("contract validation at the MCP boundary", () => {
  it("accepts all live orchestrator routes and annotate outcomes on RunRecord", async () => {
    const { store, queue } = makeQueue();
    store.upsertStory(makeStory());

    const runs = routeIds.map((route, i) =>
      makeRun({
        id: `run-${route}`,
        route,
        access: accessForRoute(route),
        outcome: annotateOutcomes[i % annotateOutcomes.length],
      })
    );

    await expect(
      queue.complete({ id: "story-1", handoff, pr: "https://example/pr/1", runs, outcome: "accepted" })
    ).resolves.toEqual({ ok: true });
    expect(queue.detail("story-1").runs.map((r) => r.route)).toEqual(routeIds);
    expect(new Set(queue.detail("story-1").runs.map((r) => r.outcome))).toEqual(new Set(annotateOutcomes));
  });

  it("rejects invalid run records before persisting completion", async () => {
    const { store, queue } = makeQueue();
    store.upsertStory(makeStory());

    await expect(
      queue.complete({
        id: "story-1",
        handoff,
        pr: "https://example/pr/1",
        runs: [makeRun({ route: "unknown-route" as RouteId })],
        outcome: "accepted",
      })
    ).rejects.toThrow(/Invalid RunRecord/);
    expect(queue.detail("story-1").runs).toEqual([]);
  });

  it("validates plans before saving story.plan", async () => {
    const { store, queue } = makeQueue();
    store.upsertStory(makeStory({ plan: null }));

    await expect(queue.setPlan("story-1", plan)).resolves.toEqual({ ok: true });
    expect(queue.detail("story-1").story.plan).toEqual(plan);

    await expect(
      queue.setPlan("story-1", { ...plan, files: [{ path: "x.ts" }] } as Plan)
    ).rejects.toThrow(/Invalid Plan/);
  });

  it("validates attached projects before returning them", async () => {
    const { registry, queue } = makeQueue();
    const session = registry.register({ repo: "test/repo", path: "/tmp/repo", branch: "main", model: "fable", pid: 123 });

    await expect(queue.attach(session.id)).resolves.toMatchObject({
      repo: "test/repo",
      path: "/tmp/repo",
      branch: "main",
      model: "fable",
      pid: 123,
      worktreeRoot: "/tmp/wt",
      status: "attached",
    });
  });

  it("round-trips legacy runs without timestamps through store.getRuns()", () => {
    const store = new StoryStore(":memory:");
    const legacy = makeRun({ id: "legacy-run", startedAt: undefined, finishedAt: undefined });
    validateRunRecord(legacy);
    store.saveRun(legacy);
    const loaded = store.getRuns();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(legacy);
    expect(loaded[0].startedAt).toBeUndefined();
    expect(loaded[0].finishedAt).toBeUndefined();
  });
});
