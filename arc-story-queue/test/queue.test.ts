import { describe, expect, it } from "vitest";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";
import type { Story } from "arc-contracts";

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "story-1",
    wid: "W-000001",
    type: "story",
    title: "Test",
    repo: "test/repo",
    branch: "feat/test",
    worktree: "",
    column: "queued",
    priority: "med",
    size: "S",
    epic: "",
    taskClass: "feature",
    tags: [],
    description: "",
    criteria: [],
    draft: false,
    ...overrides,
  };
}

function makeQueue(maxParallel = 2) {
  const store = new StoryStore(":memory:");
  const registry = new SessionRegistry();
  const sse = new SseHub();
  const queue = new QueueManager(
    { worktreeRoot: "/tmp/wt", maxParallel },
    { store, registry, sse }
  );
  return { store, registry, queue };
}

describe("QueueManager parallelism law", () => {
  it("read-only routes never lock", () => {
    const { queue } = makeQueue();
    expect(queue.needsWriteLock("codex-explore")).toBe(false);
    expect(queue.acquireForRoute("/wt/a", "s1", "codex-explore")).toBe(true);
    expect(queue.isWriteLocked("/wt/a")).toBe(false);
  });

  it("second acquireWrite on the same worktree fails fast", () => {
    const { queue } = makeQueue();
    expect(queue.acquireWrite("/wt/a", "s1")).toBe(true);
    expect(queue.acquireWrite("/wt/a", "s2")).toBe(false);
    expect(queue.writeLockHolder("/wt/a")).toBe("s1");
  });

  it("different worktrees both acquire", () => {
    const { queue } = makeQueue();
    expect(queue.acquireWrite("/wt/a", "s1")).toBe(true);
    expect(queue.acquireWrite("/wt/b", "s2")).toBe(true);
    expect(queue.isWriteLocked("/wt/a")).toBe(true);
    expect(queue.isWriteLocked("/wt/b")).toBe(true);
  });

  it("maxParallel gating makes next() return null when at capacity", async () => {
    const { store, registry, queue } = makeQueue(1);
    const session = registry.register({
      repo: "test/repo",
      path: "/tmp",
      branch: "main",
      model: "test",
      pid: 1,
    });
    const project = registry.attach(session.id, "/tmp/wt");

    const s1 = makeStory({ id: "s1", column: "in_progress", repo: "test/repo", worktree: "/wt/1" });
    const s2 = makeStory({ id: "s2", column: "queued", repo: "test/repo" });
    store.upsertStory(s1);
    store.upsertStory(s2);
    store.enqueue("s2");
    queue.acquireWrite("/wt/1", "s1");

    const result = await queue.next(project.id);
    expect(result).toBeNull();
  });
});
