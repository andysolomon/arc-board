import { describe, expect, it } from "vitest";
import type { Story } from "arc-contracts";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "story-no-pr",
    wid: "W-000054",
    type: "story",
    title: "No PR readiness",
    repo: "test/repo",
    branch: "feat/no-pr",
    worktree: "",
    column: "review",
    priority: "med",
    size: "S",
    epic: "",
    taskClass: "feature",
    tags: [],
    description: "",
    criteria: [],
    draft: false,
    issue: "#54",
    ...overrides,
  };
}

function setup() {
  const store = new StoryStore(":memory:");
  const registry = new SessionRegistry();
  const sse = new SseHub();
  const queue = new QueueManager({ worktreeRoot: "/tmp/wt", maxParallel: 2 }, { store, registry, sse });
  return { store, queue };
}

describe("prReadiness", () => {
  it("throws for an unknown story", async () => {
    const { queue } = setup();
    await expect(queue.prReadiness("missing")).rejects.toThrow(/Unknown story/);
  });

  it("throws for a review story without a PR before shelling to gh", async () => {
    const { store, queue } = setup();
    const story = makeStory();
    store.upsertStory(story);
    await expect(queue.prReadiness(story.id)).rejects.toThrow(/has no PR to inspect/);
  });
});
