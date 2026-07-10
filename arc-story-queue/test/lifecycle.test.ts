import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Handoff, RunRecord, Story } from "arc-contracts";
import { StoryLifecycle } from "../mcp-server/dist/lifecycle.js";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";

const tmpDirs: string[] = [];

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "story-1",
    wid: "W-000001",
    type: "story",
    title: "Lifecycle story",
    repo: "test/repo",
    branch: "feat/lifecycle-story",
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
    issue: "#1",
    ...overrides,
  };
}

function makeGitRepo() {
  const fixtureDir = mkdtempSync(join(tmpdir(), "arc-lifecycle-"));
  tmpDirs.push(fixtureDir);
  const repo = join(fixtureDir, "repo");
  const worktreeRoot = join(fixtureDir, "wt");
  execFileSync("git", ["init", repo], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: "pipe" });
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  execFileSync("git", ["-C", repo, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "commit", "-m", "init"], { stdio: "pipe" });
  return { repo, worktreeRoot };
}

function makeLifecycle(worktreeRoot: string, maxParallel = 2) {
  const store = new StoryStore(":memory:");
  const registry = new SessionRegistry();
  const sse = new SseHub();
  const queue = new QueueManager({ worktreeRoot, maxParallel }, { store, registry, sse });
  const lifecycle = new StoryLifecycle(queue);
  return { store, registry, queue, lifecycle };
}

function completedHandoff(): Handoff {
  return {
    status: "completed",
    summary: "Lifecycle complete",
    changes: ["README.md"],
    verification: ["vitest lifecycle.test.ts"],
    risks: [],
    next_actions: [],
  };
}

function blockedHandoff(): Handoff {
  return {
    status: "blocked",
    summary: "Blocked on verification",
    changes: ["README.md"],
    verification: ["vitest lifecycle.test.ts"],
    risks: ["flaky test"],
    next_actions: ["retry"],
  };
}

function runRecord(storyId: string): RunRecord {
  return {
    id: `run-${storyId}`,
    storyId,
    label: "composer-implement",
    repo: "test/repo",
    route: "composer-implement",
    backend: "Cursor Agent",
    model: "composer-test",
    access: "write",
    tokens: 1,
    durMs: 1,
    status: "completed",
    changed: 1,
    outcome: "accepted",
  };
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("StoryLifecycle", () => {
  it("dispatches and completes through one interface, returning event facts and preserving lock behavior", async () => {
    const { repo, worktreeRoot } = makeGitRepo();
    const { store, registry, queue, lifecycle } = makeLifecycle(worktreeRoot);

    const session = registry.register({ repo: "test/repo", path: repo, branch: "main", model: "vitest", pid: 1 });
    const project = registry.attach(session.id, worktreeRoot);
    const story = makeStory();
    store.upsertStory(story);
    store.enqueue(story.id);

    const dispatched = await lifecycle.dispatch(project.id);

    expect(dispatched.events).toEqual([
      { kind: "started", id: story.id, wid: story.wid, title: story.title, column: "in_progress" },
    ]);
    expect(dispatched.value?.column).toBe("in_progress");
    expect(dispatched.value?.worktree).toBeTruthy();
    expect(existsSync(dispatched.value!.worktree)).toBe(true);
    expect(queue.isWriteLocked(dispatched.value!.worktree)).toBe(true);

    const completed = await lifecycle.complete({
      id: story.id,
      handoff: completedHandoff(),
      pr: "local://arc-story-queue/W-000001",
      runs: [runRecord(story.id)],
      outcome: "accepted",
    });

    expect(completed.value).toEqual({ ok: true });
    expect(completed.events).toEqual([
      { kind: "review", id: story.id, wid: story.wid, title: story.title, column: "review" },
    ]);
    expect(store.getStory(story.id)?.column).toBe("review");
    expect(store.getRunsForStory(story.id)).toHaveLength(1);
    expect(queue.isWriteLocked(dispatched.value!.worktree)).toBe(false);
  });

  it("merges reviewed local work and cleans the worktree through the lifecycle interface", async () => {
    const { repo, worktreeRoot } = makeGitRepo();
    const { store, registry, lifecycle } = makeLifecycle(worktreeRoot);

    const session = registry.register({ repo: "test/repo", path: repo, branch: "main", model: "vitest", pid: 1 });
    const project = registry.attach(session.id, worktreeRoot);
    const story = makeStory();
    store.upsertStory(story);
    store.enqueue(story.id);

    const dispatched = await lifecycle.dispatch(project.id);
    await lifecycle.complete({
      id: story.id,
      handoff: completedHandoff(),
      pr: "local://arc-story-queue/W-000001",
      runs: [runRecord(story.id)],
      outcome: "accepted",
    });

    const merged = await lifecycle.merge(story.id);

    expect(merged.events).toEqual([
      { kind: "done", id: story.id, wid: story.wid, title: story.title, column: "done" },
    ]);
    expect(merged.value.column).toBe("done");
    expect(merged.value.worktree).toBe("");
    expect(existsSync(dispatched.value!.worktree)).toBe(false);
  });

  it("abandons in-progress work, cleans the worktree, and returns an abandoned event fact", async () => {
    const { repo, worktreeRoot } = makeGitRepo();
    const { store, registry, queue, lifecycle } = makeLifecycle(worktreeRoot);

    const session = registry.register({ repo: "test/repo", path: repo, branch: "main", model: "vitest", pid: 1 });
    const project = registry.attach(session.id, worktreeRoot);
    const story = makeStory();
    store.upsertStory(story);
    store.enqueue(story.id);
    const dispatched = await lifecycle.dispatch(project.id);

    const abandoned = await lifecycle.abandon(story.id);

    expect(abandoned.events).toEqual([
      { kind: "abandoned", id: story.id, wid: story.wid, title: story.title, column: "backlog" },
    ]);
    expect(abandoned.value.column).toBe("backlog");
    expect(abandoned.value.worktree).toBe("");
    expect(existsSync(dispatched.value!.worktree)).toBe(false);
    expect(queue.isWriteLocked(dispatched.value!.worktree)).toBe(false);
  });

  it("starts a reserved in-progress story with worktree and returns a started event without mutating the story", async () => {
    const { repo, worktreeRoot } = makeGitRepo();
    const { store, registry, queue, lifecycle } = makeLifecycle(worktreeRoot);

    const session = registry.register({ repo: "test/repo", path: repo, branch: "main", model: "vitest", pid: 1 });
    const project = registry.attach(session.id, worktreeRoot);
    const story = makeStory();
    store.upsertStory(story);
    store.enqueue(story.id);
    const dispatched = await lifecycle.dispatch(project.id);
    const worktree = dispatched.value!.worktree;

    const started = await lifecycle.start(story.id);

    expect(started.events).toEqual([
      { kind: "started", id: story.id, wid: story.wid, title: story.title, column: "in_progress" },
    ]);
    expect(started.value.column).toBe("in_progress");
    expect(started.value.worktree).toBe(worktree);
    expect(store.getStory(story.id)?.column).toBe("in_progress");
    expect(store.getStory(story.id)?.worktree).toBe(worktree);
    expect(existsSync(worktree)).toBe(true);
    expect(queue.isWriteLocked(worktree)).toBe(true);
  });

  it("rejects start for stories not in in_progress", async () => {
    const { worktreeRoot } = makeGitRepo();
    const { store, lifecycle } = makeLifecycle(worktreeRoot);
    const story = makeStory({ column: "queued" });
    store.upsertStory(story);

    await expect(lifecycle.start(story.id)).rejects.toThrow("Only in-progress stories can be started");
  });

  it("rejects start for in-progress stories without a worktree", async () => {
    const { worktreeRoot } = makeGitRepo();
    const { store, lifecycle } = makeLifecycle(worktreeRoot);
    const story = makeStory({ column: "in_progress", worktree: "" });
    store.upsertStory(story);

    await expect(lifecycle.start(story.id)).rejects.toThrow("Story has no worktree");
  });

  it("rejects start for unknown story ids", async () => {
    const { worktreeRoot } = makeGitRepo();
    const { lifecycle } = makeLifecycle(worktreeRoot);

    await expect(lifecycle.start("missing-story")).rejects.toThrow("Unknown story: missing-story");
  });

  it("start clears a stale handoff from a previous blocked run", async () => {
    const { repo, worktreeRoot } = makeGitRepo();
    const { store, registry, lifecycle, queue } = makeLifecycle(worktreeRoot);

    const session = registry.register({ repo: "test/repo", path: repo, branch: "main", model: "vitest", pid: 1 });
    const project = registry.attach(session.id, worktreeRoot);
    const story = makeStory();
    store.upsertStory(story);
    store.enqueue(story.id);

    await lifecycle.dispatch(project.id);
    await lifecycle.block({ id: story.id, handoff: blockedHandoff(), outcome: "blocked" });
    expect(store.getHandoff(story.id)).not.toBeNull();
    expect(queue.detail(story.id).handoff?.status).toBe("blocked");

    await lifecycle.start(story.id);

    expect(store.getHandoff(story.id)).toBeNull();
    expect(queue.detail(story.id).handoff).toBeNull();
  });

  it("dispatch clears a stale handoff when re-queuing and handing out a story", async () => {
    const { repo, worktreeRoot } = makeGitRepo();
    const { store, registry, lifecycle, queue } = makeLifecycle(worktreeRoot);

    const session = registry.register({ repo: "test/repo", path: repo, branch: "main", model: "vitest", pid: 1 });
    const project = registry.attach(session.id, worktreeRoot);
    const story = makeStory();
    store.upsertStory(story);
    store.saveHandoff(story.id, blockedHandoff());
    store.enqueue(story.id);

    expect(store.getHandoff(story.id)).not.toBeNull();

    const dispatched = await lifecycle.dispatch(project.id);

    expect(dispatched.value?.id).toBe(story.id);
    expect(store.getHandoff(story.id)).toBeNull();
    expect(queue.detail(story.id).handoff).toBeNull();
  });

  it("block and complete still persist handoffs for detail hydration", async () => {
    const { repo, worktreeRoot } = makeGitRepo();
    const { store, registry, lifecycle, queue } = makeLifecycle(worktreeRoot);

    const session = registry.register({ repo: "test/repo", path: repo, branch: "main", model: "vitest", pid: 1 });
    const project = registry.attach(session.id, worktreeRoot);
    const story = makeStory({ id: "handoff-persist" });
    store.upsertStory(story);
    store.enqueue(story.id);

    await lifecycle.dispatch(project.id);
    const blocked = blockedHandoff();
    await lifecycle.block({ id: story.id, handoff: blocked, outcome: "blocked" });
    expect(queue.detail(story.id).handoff).toEqual(blocked);

    await lifecycle.start(story.id);
    expect(queue.detail(story.id).handoff).toBeNull();

    const completed = completedHandoff();
    await lifecycle.complete({
      id: story.id,
      handoff: completed,
      pr: "local://arc-story-queue/W-000001",
      runs: [runRecord(story.id)],
      outcome: "accepted",
    });
    expect(queue.detail(story.id).handoff).toEqual(completed);
  });
});
