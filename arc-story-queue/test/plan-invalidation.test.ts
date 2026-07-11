import { describe, expect, it } from "vitest";
import type { Plan, Story } from "arc-contracts";
import { StoryLifecycle } from "../mcp-server/dist/lifecycle.js";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";
import { storyDigest } from "../mcp-server/dist/story-digest.js";

const plan: Plan = {
  tasks: ["Implement feature"],
  files: [{ path: "src/feature.ts", change: "Add feature" }],
  testStrategy: "Unit tests",
  acMapping: [{ ac: "Feature works", by: "feature.test.ts" }],
};

function makeStory(overrides: Partial<Story> = {}): Story {
  const base: Story = {
    id: "story-1",
    wid: "W-000046",
    type: "story",
    title: "Plan invalidation",
    repo: "test/repo",
    branch: "feat/plan-invalidation",
    worktree: "",
    column: "queued",
    priority: "med",
    size: "S",
    epic: "",
    taskClass: "feature",
    tags: [],
    description: "Original description",
    criteria: ["AC-1"],
    draft: false,
    issue: "#46",
    plan: null,
    orchestration: {
      status: "planned",
      route: "codex-implement",
      backend: "codex",
      mode: "implement",
      rationale: "Ready to implement.",
      complexity: "low",
      plannedAt: "2026-07-10T00:00:00.000Z",
      storyDigest: "",
    },
  };
  const story = { ...base, ...overrides };
  if (story.orchestration?.status === "planned") {
    story.orchestration = {
      ...story.orchestration,
      storyDigest: storyDigest(story),
    };
  }
  return story;
}

function setup() {
  const store = new StoryStore(":memory:");
  const registry = new SessionRegistry();
  const sse = new SseHub();
  const queue = new QueueManager({ worktreeRoot: "/tmp/wt", maxParallel: 2 }, { store, registry, sse });
  const lifecycle = new StoryLifecycle(queue);
  return { store, queue, lifecycle };
}

describe("plan invalidation", () => {
  it("save invalidates a queued planned story when substantive fields change", async () => {
    const { store, queue } = setup();
    const story = makeStory();
    store.upsertStory(story);
    store.enqueue(story.id);

    const edited = { ...story, title: "Updated title" };
    await queue.save(edited);

    expect(store.getStory(story.id)?.orchestration).toEqual({ status: "unplanned" });
  });

  it("setPlan invalidates a queued planned story when the execution plan changes", async () => {
    const { store, queue } = setup();
    const story = makeStory();
    store.upsertStory(story);
    store.enqueue(story.id);

    await queue.setPlan(story.id, plan);

    expect(store.getStory(story.id)?.orchestration).toEqual({ status: "unplanned" });
    expect(store.getStory(story.id)?.plan).toEqual(plan);
  });

  it("save does not invalidate when only non-substantive fields change", async () => {
    const { store, queue } = setup();
    const story = makeStory({ tags: ["epic: alpha"], priority: "low" });
    store.upsertStory(story);
    store.enqueue(story.id);
    const before = store.getStory(story.id)!.orchestration;

    await queue.save({
      ...story,
      tags: ["epic: beta", "bug"],
      priority: "high",
      size: "L",
      epic: "new-epic",
    });

    expect(store.getStory(story.id)?.orchestration).toEqual(before);
  });

  it("reorder does not invalidate a planned queued story", () => {
    const { store, queue } = setup();
    const first = makeStory({ id: "s1", wid: "W-000047" });
    const second = makeStory({ id: "s2", wid: "W-000048", title: "Second story" });
    store.upsertStory(first);
    store.upsertStory(second);
    store.enqueue(first.id);
    store.enqueue(second.id);
    const before = store.getStory(first.id)!.orchestration;

    queue.reorder(second.id, "up");

    expect(store.getStory(first.id)?.orchestration).toEqual(before);
    expect(store.getStory(second.id)?.orchestration?.status).toBe("planned");
  });

  it("replan via unqueue + enqueue resets orchestration regardless of prior status", async () => {
    const { store, lifecycle } = setup();
    for (const status of ["planned", "failed"] as const) {
      const id = `story-${status}`;
      const story = makeStory({
        id,
        wid: `W-${status}`,
        orchestration:
          status === "failed"
            ? { status: "failed", error: "model unavailable" }
            : undefined,
      });
      store.upsertStory(story);
      store.enqueue(id);

      const unqueued = lifecycle.unqueue(id);
      const requeued = await lifecycle.enqueue(id);

      expect(requeued.value.orchestration).toEqual({ status: "unplanned" });
      expect(requeued.value.column).toBe("queued");
      expect([...unqueued.events, ...requeued.events].map((event) => event.kind)).toEqual([
        "unqueued",
        "queued",
      ]);
    }
  });
});
