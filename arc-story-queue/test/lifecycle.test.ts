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
});
