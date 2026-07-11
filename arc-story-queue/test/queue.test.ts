import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";
import type { Story, ReviewLoop } from "arc-contracts";
import {
  dispatchBlockReason,
  isDispatchEligible,
  mutexKeysFromTags,
  storyMutexKeys,
  type BoardActionError,
} from "arc-contracts";

const ARC_ACTION_ERROR_PREFIX = "ARC_ACTION_ERROR:";

function parseMergeActionError(error: unknown): BoardActionError | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith(ARC_ACTION_ERROR_PREFIX)) return null;
  return JSON.parse(message.slice(ARC_ACTION_ERROR_PREFIX.length)) as BoardActionError;
}

function approvedReviewLoop(overrides: Partial<ReviewLoop> = {}): ReviewLoop {
  return { round: 1, maxRounds: 3, verdict: "approved", blockingCount: 0, ...overrides };
}

function cleanGhRunner(
  onGh?: (args: string[]) => string | Buffer | undefined
): ConstructorParameters<typeof QueueManager>[1]["commandRunner"] {
  return (file, args, options) => {
    if (file === "gh") {
      const custom = onGh?.(args);
      if (custom !== undefined) return custom;
      if (args.includes("state,mergedAt")) {
        return Buffer.from(JSON.stringify({ state: "OPEN", mergedAt: null }));
      }
      if (args.includes("mergeStateStatus,statusCheckRollup")) {
        return Buffer.from(JSON.stringify({ mergeStateStatus: "CLEAN", statusCheckRollup: [] }));
      }
      return Buffer.from("");
    }
    return execFileSync(file, args, options);
  };
}

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
    orchestration: {
      status: "planned",
      route: "codex-implement",
      backend: "codex",
      mode: "implement",
      rationale: "Test fixture is ready to dispatch.",
      complexity: "low",
      plannedAt: "2026-07-10T00:00:00.000Z",
      storyDigest: "test",
    },
    ...overrides,
  };
}

function makeQueue(
  maxParallel = 2,
  commandRunner?: ConstructorParameters<typeof QueueManager>[1]["commandRunner"],
  queueConfig: Partial<ConstructorParameters<typeof QueueManager>[0]> = {}
) {
  const store = new StoryStore(":memory:");
  const registry = new SessionRegistry();
  const sse = new SseHub();
  const queue = new QueueManager(
    { worktreeRoot: "/tmp/wt", maxParallel, ...queueConfig },
    { store, registry, sse, commandRunner }
  );
  return { store, registry, queue };
}

const tmpDirs: string[] = [];

function makeGitFixture() {
  const fixtureDir = mkdtempSync(join(tmpdir(), "arc-queue-"));
  tmpDirs.push(fixtureDir);
  const repo = join(fixtureDir, "repo");
  const worktree = join(fixtureDir, "wt", "story-1");
  execFileSync("git", ["init", repo], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { stdio: "pipe" });
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  execFileSync("git", ["-C", repo, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "commit", "-m", "init"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "branch", "-M", "main"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "worktree", "add", worktree, "-b", "feat/story-1"], {
    stdio: "pipe",
  });
  return { repo, worktree };
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function attachProject(registry: SessionRegistry, repoPath: string) {
  const session = registry.register({
    repo: "test/repo",
    path: repoPath,
    branch: "main",
    model: "test",
    pid: 1,
  });
  return registry.attach(session.id, "/tmp/wt");
}

describe("label concurrency groups", () => {
  it("mutexKeysFromTags prefers parallel-group over epic", () => {
    expect(
      mutexKeysFromTags(["epic: a", "parallel-group: ci", "epic: b"])
    ).toEqual(["parallel-group: ci"]);
    expect(mutexKeysFromTags(["epic: release-automation"])).toEqual(["epic: release-automation"]);
    expect(mutexKeysFromTags(["bug", "feature"])).toEqual([]);
  });

  it("dispatchBlockReason surfaces the conflicting label", () => {
    const running = makeStory({ tags: ["epic: release-automation"] });
    const queued = makeStory({ tags: ["epic: release-automation"] });
    expect(dispatchBlockReason(queued, [running])).toBe(
      "waiting · epic: release-automation in progress"
    );
  });

  it("epic label creates a mutex group", async () => {
    const { store, registry, queue } = makeQueue(2);
    const { repo } = makeGitFixture();
    const project = attachProject(registry, repo);
    const running = makeStory({
      id: "s1",
      column: "in_progress",
      tags: ["epic: release-automation"],
      worktree: "/wt/s1",
      repo: "test/repo",
    });
    const queued = makeStory({
      id: "s2",
      column: "queued",
      tags: ["epic: release-automation"],
      branch: "feat/story-2",
      repo: "test/repo",
    });
    store.upsertStory(running);
    store.upsertStory(queued);
    store.enqueue("s2");

    expect(await queue.next(project.id)).toEqual({ story: null });
    expect(store.getStory("s2")?.column).toBe("queued");
  });

  it("different epic labels can run in parallel when under maxParallel", async () => {
    const { store, registry, queue } = makeQueue(2);
    const { repo } = makeGitFixture();
    const project = attachProject(registry, repo);
    const running = makeStory({
      id: "s1",
      column: "in_progress",
      tags: ["epic: release-automation"],
      worktree: "/wt/s1",
      repo: "test/repo",
    });
    const queued = makeStory({
      id: "s2",
      column: "queued",
      tags: ["epic: release"],
      branch: "feat/story-2",
      repo: "test/repo",
    });
    store.upsertStory(running);
    store.upsertStory(queued);
    store.enqueue("s2");
    queue.acquireWrite("/wt/s1", "s1");

    const next = (await queue.next(project.id)).story;
    expect(next?.id).toBe("s2");
    expect(next?.column).toBe("in_progress");
  });

  it("global maxParallel still caps total concurrency", async () => {
    const { store, registry, queue } = makeQueue(2);
    const { repo } = makeGitFixture();
    const project = attachProject(registry, repo);
    const s1 = makeStory({
      id: "s1",
      column: "in_progress",
      tags: ["epic: a"],
      worktree: "/wt/s1",
      repo: "test/repo",
    });
    const s2 = makeStory({
      id: "s2",
      column: "in_progress",
      tags: ["epic: b"],
      worktree: "/wt/s2",
      repo: "test/repo",
    });
    const s3 = makeStory({
      id: "s3",
      column: "queued",
      tags: ["epic: c"],
      branch: "feat/story-3",
      repo: "test/repo",
    });
    store.upsertStory(s1);
    store.upsertStory(s2);
    store.upsertStory(s3);
    store.enqueue("s3");

    expect((await queue.next(project.id)).story).toBeNull();
    expect(store.getStory("s3")?.column).toBe("queued");
  });

  it("queue.next skips blocked head and picks next eligible story", async () => {
    const { store, registry, queue } = makeQueue(2);
    const { repo } = makeGitFixture();
    const project = attachProject(registry, repo);
    const running = makeStory({
      id: "s0",
      column: "in_progress",
      tags: ["epic: shared"],
      worktree: "/wt/s0",
      repo: "test/repo",
    });
    const blocked = makeStory({
      id: "s1",
      column: "queued",
      tags: ["epic: shared"],
      branch: "feat/blocked",
      repo: "test/repo",
    });
    const eligible = makeStory({
      id: "s2",
      column: "queued",
      tags: ["epic: other"],
      branch: "feat/eligible",
      repo: "test/repo",
    });
    store.upsertStory(running);
    store.upsertStory(blocked);
    store.upsertStory(eligible);
    store.enqueue("s1");
    store.enqueue("s2");
    queue.acquireWrite("/wt/s0", "s0");

    const next = (await queue.next(project.id)).story;
    expect(next?.id).toBe("s2");
    expect(store.getStory("s1")?.column).toBe("queued");
  });

  it("stories without epic labels are only gated by maxParallel", async () => {
    const { store, registry, queue } = makeQueue(2);
    const { repo } = makeGitFixture();
    const project = attachProject(registry, repo);
    const running = makeStory({
      id: "s1",
      column: "in_progress",
      tags: ["bug"],
      worktree: "/wt/s1",
      repo: "test/repo",
    });
    const queued = makeStory({
      id: "s2",
      column: "queued",
      tags: [],
      branch: "feat/no-mutex",
      repo: "test/repo",
    });
    store.upsertStory(running);
    store.upsertStory(queued);
    store.enqueue("s2");
    queue.acquireWrite("/wt/s1", "s1");

    const next = (await queue.next(project.id)).story;
    expect(next?.id).toBe("s2");
    expect(isDispatchEligible(queued, [running], 2)).toBe(true);
  });

  it("parallel-group label overrides epic for mutex", async () => {
    const { store, registry, queue } = makeQueue(2);
    const { repo } = makeGitFixture();
    const project = attachProject(registry, repo);
    const running = makeStory({
      id: "s1",
      column: "in_progress",
      tags: ["epic: alpha", "parallel-group: ci"],
      worktree: "/wt/s1",
      repo: "test/repo",
    });
    const queued = makeStory({
      id: "s2",
      column: "queued",
      tags: ["epic: beta", "parallel-group: ci"],
      branch: "feat/ci-blocked",
      repo: "test/repo",
    });
    store.upsertStory(running);
    store.upsertStory(queued);
    store.enqueue("s2");

    expect(storyMutexKeys(running)).toEqual(["parallel-group: ci"]);
    expect((await queue.next(project.id)).story).toBeNull();
  });
});

describe("QueueManager parallelism law", () => {
  it("read-only routes never lock", () => {
    const { queue } = makeQueue();
    const readOnlyRoutes = [
      "codex-explore",
      "composer-explore",
      "opus-explore",
      "codex-check",
      "composer-check",
      "opus-check",
    ];

    for (const route of readOnlyRoutes) {
      expect(queue.needsWriteLock(route)).toBe(false);
      expect(queue.acquireForRoute("/wt/a", "s1", route)).toBe(true);
      expect(queue.isWriteLocked("/wt/a")).toBe(false);
    }
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

  it("merge() skips update-branch when already CLEAN, merges, removes the worktree, releases the lock, and marks done", async () => {
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push(args);
        if (args.includes("state,mergedAt")) {
          return Buffer.from(JSON.stringify({ state: "OPEN", mergedAt: null }));
        }
        if (args.includes("mergeStateStatus,statusCheckRollup")) {
          return Buffer.from(JSON.stringify({ mergeStateStatus: "CLEAN", statusCheckRollup: [] }));
        }
        return Buffer.from("");
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    const story = makeStory({
      column: "review",
      pr: "https://github.com/test/repo/pull/12",
      prState: "open",
      worktree,
      reviewLoop: approvedReviewLoop(),
    });
    store.upsertStory(story);
    queue.acquireWrite(worktree, story.id);

    const merged = await queue.merge(story.id);

    expect(ghCalls).toEqual([
      ["pr", "view", "12", "--json", "state,mergedAt", "--repo", "test/repo"],
      ["pr", "view", "12", "--json", "mergeStateStatus,statusCheckRollup", "--repo", "test/repo"],
      ["pr", "merge", "12", "--squash", "--delete-branch", "--repo", "test/repo"],
    ]);
    expect(merged.column).toBe("done");
    expect(merged.prState).toBe("merged");
    expect(merged.worktree).toBe("");
    expect(existsSync(worktree)).toBe(false);
    expect(queue.isWriteLocked(worktree)).toBe(false);
  });

  it("merge() syncs the PR branch when BEHIND, waits for checks, then merges", async () => {
    const ghCalls: string[][] = [];
    let readinessPolls = 0;
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push(args);
        if (args.includes("state,mergedAt")) {
          return Buffer.from(JSON.stringify({ state: "OPEN", mergedAt: null }));
        }
        if (args.includes("mergeStateStatus,statusCheckRollup")) {
          readinessPolls += 1;
          if (readinessPolls === 1) {
            return Buffer.from(
              JSON.stringify({
                mergeStateStatus: "BEHIND",
                statusCheckRollup: [{ name: "Test arc-story-queue", status: "IN_PROGRESS", conclusion: null }],
              })
            );
          }
          return Buffer.from(JSON.stringify({ mergeStateStatus: "CLEAN", statusCheckRollup: [] }));
        }
        return Buffer.from("");
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner, { mergeReadinessPollMs: 1, mergeReadinessMaxWaitMs: 50 });
    const { worktree } = makeGitFixture();
    const story = makeStory({
      column: "review",
      pr: "https://github.com/test/repo/pull/12",
      prState: "open",
      worktree,
      reviewLoop: approvedReviewLoop(),
    });
    store.upsertStory(story);
    queue.acquireWrite(worktree, story.id);

    const merged = await queue.merge(story.id);

    expect(ghCalls).toEqual([
      ["pr", "view", "12", "--json", "state,mergedAt", "--repo", "test/repo"],
      ["pr", "view", "12", "--json", "mergeStateStatus,statusCheckRollup", "--repo", "test/repo"],
      ["pr", "update-branch", "12", "--repo", "test/repo"],
      ["pr", "view", "12", "--json", "mergeStateStatus,statusCheckRollup", "--repo", "test/repo"],
      ["pr", "merge", "12", "--squash", "--delete-branch", "--repo", "test/repo"],
    ]);
    expect(merged.column).toBe("done");
    expect(merged.prState).toBe("merged");
  });

  it("merge() on an already-merged GitHub PR skips update-branch and merge, then finishes done", async () => {
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        return Buffer.from(JSON.stringify({ state: "MERGED", mergedAt: "2026-07-08T00:00:00Z" }));
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    const story = makeStory({
      column: "review",
      pr: "https://github.com/test/repo/pull/12",
      prState: "open",
      worktree,
    });
    store.upsertStory(story);
    queue.acquireWrite(worktree, story.id);

    const merged = await queue.merge(story.id);

    expect(ghCalls).toEqual([["pr", "view", "12", "--json", "state,mergedAt", "--repo", "test/repo"]]);
    expect(merged.column).toBe("done");
    expect(merged.prState).toBe("merged");
    expect(merged.worktree).toBe("");
    expect(existsSync(worktree)).toBe(false);
    expect(queue.isWriteLocked(worktree)).toBe(false);
  });

  it("merge() rejects failing checks before calling gh pr merge", async () => {
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        if (args.includes("state,mergedAt")) {
          return Buffer.from(JSON.stringify({ state: "OPEN", mergedAt: null }));
        }
        if (args.includes("mergeStateStatus,statusCheckRollup")) {
          return Buffer.from(
            JSON.stringify({
              mergeStateStatus: "BLOCKED",
              statusCheckRollup: [
                { name: "Test arc-story-queue", status: "COMPLETED", conclusion: "FAILURE" },
                { name: "commitlint", status: "IN_PROGRESS", conclusion: null },
              ],
            })
          );
        }
        return Buffer.from("");
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    const story = makeStory({
      column: "review",
      pr: "https://github.com/test/repo/pull/12",
      prState: "open",
      worktree,
      reviewLoop: approvedReviewLoop(),
    });
    store.upsertStory(story);

    await expect(queue.merge(story.id)).rejects.toSatisfy((error: unknown) => {
      const parsed = parseMergeActionError(error);
      expect(parsed?.code).toBe("checks_failed");
      expect(parsed?.detail).toMatch(/mergeStateStatus=BLOCKED/);
      expect(parsed?.detail).toMatch(/failing checks: Test arc-story-queue/);
      expect(parsed?.detail).toMatch(/pending checks: commitlint/);
      return true;
    });
    expect(ghCalls).toEqual([
      ["pr", "view", "12", "--json", "state,mergedAt", "--repo", "test/repo"],
      ["pr", "view", "12", "--json", "mergeStateStatus,statusCheckRollup", "--repo", "test/repo"],
    ]);
    expect(store.getStory(story.id)?.column).toBe("review");
  });

  it("merge() ignores stale FAILURE rollup entries when a newer SUCCESS exists for the same check", async () => {
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push(args);
        if (args.includes("state,mergedAt")) {
          return Buffer.from(JSON.stringify({ state: "OPEN", mergedAt: null }));
        }
        if (args.includes("mergeStateStatus,statusCheckRollup")) {
          return Buffer.from(
            JSON.stringify({
              mergeStateStatus: "CLEAN",
              statusCheckRollup: [
                {
                  name: "Merge Gate",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                  startedAt: "2026-07-08T10:00:00Z",
                  completedAt: "2026-07-08T10:01:00Z",
                },
                {
                  name: "Merge Gate",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  startedAt: "2026-07-08T11:00:00Z",
                  completedAt: "2026-07-08T11:01:00Z",
                },
              ],
            })
          );
        }
        return Buffer.from("");
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    const story = makeStory({
      column: "review",
      pr: "https://github.com/test/repo/pull/12",
      prState: "open",
      worktree,
      reviewLoop: approvedReviewLoop(),
    });
    store.upsertStory(story);
    queue.acquireWrite(worktree, story.id);

    const merged = await queue.merge(story.id);

    expect(merged.column).toBe("done");
    expect(ghCalls.some((args) => args[1] === "merge")).toBe(true);
  });

  it("merge() auto-fixes a non-conventional PR title when Merge Gate fails, retries readiness once, then merges", async () => {
    const ghCalls: string[][] = [];
    let readinessPolls = 0;
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        if (args.includes("state,mergedAt")) {
          return Buffer.from(JSON.stringify({ state: "OPEN", mergedAt: null }));
        }
        if (args[1] === "edit" && args.includes("--title")) {
          return Buffer.from("");
        }
        if (args.includes("mergeStateStatus,statusCheckRollup")) {
          readinessPolls += 1;
          if (readinessPolls === 1) {
            return Buffer.from(
              JSON.stringify({
                mergeStateStatus: "BLOCKED",
                statusCheckRollup: [
                  { name: "Merge Gate", status: "COMPLETED", conclusion: "FAILURE" },
                ],
              })
            );
          }
          return Buffer.from(JSON.stringify({ mergeStateStatus: "CLEAN", statusCheckRollup: [] }));
        }
        return Buffer.from("");
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    const story = makeStory({
      title: "Add widget",
      column: "review",
      pr: "https://github.com/test/repo/pull/12",
      prState: "open",
      worktree,
      reviewLoop: approvedReviewLoop(),
    });
    store.upsertStory(story);
    queue.acquireWrite(worktree, story.id);

    const merged = await queue.merge(story.id);

    expect(ghCalls).toEqual([
      ["pr", "view", "12", "--json", "state,mergedAt", "--repo", "test/repo"],
      ["pr", "view", "12", "--json", "mergeStateStatus,statusCheckRollup", "--repo", "test/repo"],
      ["pr", "edit", "12", "--title", "feat: Add widget", "--repo", "test/repo"],
      ["pr", "view", "12", "--json", "mergeStateStatus,statusCheckRollup", "--repo", "test/repo"],
      ["pr", "merge", "12", "--squash", "--delete-branch", "--repo", "test/repo"],
    ]);
    expect(merged.column).toBe("done");
    expect(merged.prState).toBe("merged");
  });

  it("merge() auto-fixes the PR title once and surfaces checks_failed when Merge Gate still fails", async () => {
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        if (args.includes("state,mergedAt")) {
          return Buffer.from(JSON.stringify({ state: "OPEN", mergedAt: null }));
        }
        if (args[1] === "edit" && args.includes("--title")) {
          return Buffer.from("");
        }
        if (args.includes("mergeStateStatus,statusCheckRollup")) {
          return Buffer.from(
            JSON.stringify({
              mergeStateStatus: "BLOCKED",
              statusCheckRollup: [
                { name: "Merge Gate", status: "COMPLETED", conclusion: "FAILURE" },
              ],
            })
          );
        }
        return Buffer.from("");
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    const story = makeStory({
      title: "Add widget",
      column: "review",
      pr: "https://github.com/test/repo/pull/12",
      prState: "open",
      worktree,
      reviewLoop: approvedReviewLoop(),
    });
    store.upsertStory(story);

    await expect(queue.merge(story.id)).rejects.toSatisfy((error: unknown) => {
      const parsed = parseMergeActionError(error);
      expect(parsed?.code).toBe("checks_failed");
      expect(parsed?.title).toBe("PR title needs a conventional prefix");
      expect(parsed?.detail).toMatch(/failing checks: Merge Gate/);
      return true;
    });
    expect(ghCalls.filter((args) => args[1] === "edit")).toHaveLength(1);
    expect(ghCalls.some((args) => args[1] === "merge")).toBe(false);
    expect(store.getStory(story.id)?.column).toBe("review");
  });

  it("merge() auto-fixes a legacy non-conventional PR title for operator-sent review stories", async () => {
    const ghCalls: string[][] = [];
    let readinessPolls = 0;
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        if (args.includes("state,mergedAt")) {
          return Buffer.from(JSON.stringify({ state: "OPEN", mergedAt: null }));
        }
        if (args[1] === "edit" && args.includes("--title")) {
          return Buffer.from("");
        }
        if (args.includes("mergeStateStatus,statusCheckRollup")) {
          readinessPolls += 1;
          if (readinessPolls === 1) {
            return Buffer.from(
              JSON.stringify({
                mergeStateStatus: "BLOCKED",
                statusCheckRollup: [
                  { name: "Merge Gate", status: "COMPLETED", conclusion: "FAILURE" },
                ],
              })
            );
          }
          return Buffer.from(JSON.stringify({ mergeStateStatus: "CLEAN", statusCheckRollup: [] }));
        }
        return Buffer.from("");
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    const story = makeStory({
      title: "Ship operator review",
      column: "review",
      pr: "https://github.com/test/repo/pull/99",
      prState: "open",
      worktree,
      reviewLoop: approvedReviewLoop(),
    });
    store.upsertStory(story);
    queue.acquireWrite(worktree, story.id);

    const merged = await queue.merge(story.id);

    expect(ghCalls).toContainEqual([
      "pr",
      "edit",
      "99",
      "--title",
      "feat: Ship operator review",
      "--repo",
      "test/repo",
    ]);
    expect(merged.column).toBe("done");
  });

  it("merge() times out when checks stay pending after update-branch", async () => {
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        if (args.includes("state,mergedAt")) {
          return Buffer.from(JSON.stringify({ state: "OPEN", mergedAt: null }));
        }
        if (args.includes("mergeStateStatus,statusCheckRollup")) {
          return Buffer.from(
            JSON.stringify({
              mergeStateStatus: "BLOCKED",
              statusCheckRollup: [{ name: "commitlint", status: "IN_PROGRESS", conclusion: null }],
            })
          );
        }
        return Buffer.from("");
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner, { mergeReadinessPollMs: 1, mergeReadinessMaxWaitMs: 10 });
    const { worktree } = makeGitFixture();
    const story = makeStory({
      column: "review",
      pr: "https://github.com/test/repo/pull/12",
      prState: "open",
      worktree,
      reviewLoop: approvedReviewLoop(),
    });
    store.upsertStory(story);

    await expect(queue.merge(story.id)).rejects.toSatisfy((error: unknown) => {
      const parsed = parseMergeActionError(error);
      expect(parsed?.code).toBe("timeout");
      expect(parsed?.detail).toMatch(/pending checks: commitlint/);
      return true;
    });
    expect(ghCalls.some((args) => args[1] === "merge")).toBe(false);
    expect(ghCalls.some((args) => args[1] === "update-branch")).toBe(true);
    expect(store.getStory(story.id)?.column).toBe("review");
  });

  it("reconcileReviewPrs() marks externally merged GitHub PRs done without re-merging", async () => {
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        return Buffer.from(JSON.stringify({ state: "MERGED", mergedAt: "2026-07-08T00:00:00Z" }));
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    const story = makeStory({
      column: "review",
      pr: "https://github.com/test/repo/pull/12",
      prState: "open",
      worktree,
    });
    store.upsertStory(story);

    const result = await queue.reconcileReviewPrs();
    const updated = store.getStory(story.id)!;

    expect(result).toEqual({ checked: 1, merged: [story.id], closed: [], errors: [] });
    expect(ghCalls).toEqual([["pr", "view", "12", "--json", "state,mergedAt", "--repo", "test/repo"]]);
    expect(updated.column).toBe("done");
    expect(updated.prState).toBe("merged");
    expect(updated.doneAt).toBeTypeOf("number");
    expect(updated.worktree).toBe("");
    expect(existsSync(worktree)).toBe(false);
  });

  it("reconcileReviewPrs() ignores local PR sentinels without calling gh", async () => {
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        return Buffer.from("");
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const story = makeStory({ column: "review", pr: "local://arc-story-queue/W-000001", prState: "open" });
    store.upsertStory(story);

    const result = await queue.reconcileReviewPrs();

    expect(result).toEqual({ checked: 0, merged: [], closed: [], errors: [] });
    expect(ghCalls).toEqual([]);
    expect(store.getStory(story.id)?.column).toBe("review");
  });

  it("reconcileInProgressIssues() purges in-progress stories whose issue is closed", async () => {
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        return Buffer.from(JSON.stringify({ state: "CLOSED" }));
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    const story = makeStory({
      column: "in_progress",
      issue: "https://github.com/test/repo/issues/16",
      worktree,
    });
    store.upsertStory(story);
    queue.acquireWrite(worktree, story.id);

    const result = await queue.reconcileInProgressIssues();

    expect(result).toEqual({ checked: 1, purged: [story.id], errors: [] });
    expect(ghCalls).toEqual([["issue", "view", "16", "--json", "state", "--repo", "test/repo"]]);
    expect(store.getStory(story.id)).toBeNull();
    expect(existsSync(worktree)).toBe(false);
    expect(queue.isWriteLocked(worktree)).toBe(false);
  });

  it("reconcileInProgressIssues() leaves open-issue stories untouched", async () => {
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        return Buffer.from(JSON.stringify({ state: "OPEN" }));
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    const story = makeStory({
      column: "in_progress",
      issue: "https://github.com/test/repo/issues/16",
      worktree,
    });
    store.upsertStory(story);

    const result = await queue.reconcileInProgressIssues();
    const updated = store.getStory(story.id)!;

    expect(result).toEqual({ checked: 1, purged: [], errors: [] });
    expect(updated.column).toBe("in_progress");
    expect(updated.worktree).toBe(worktree);
    expect(ghCalls).toEqual([["issue", "view", "16", "--json", "state", "--repo", "test/repo"]]);
  });

  it("reconcileInProgressIssues() skips stories without an issue or not in progress", async () => {
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        return Buffer.from("");
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const backlogWithIssue = makeStory({
      id: "story-backlog",
      column: "backlog",
      issue: "https://github.com/test/repo/issues/1",
    });
    const inProgressNoIssue = makeStory({
      id: "story-no-issue",
      column: "in_progress",
      issue: "",
    });
    store.upsertStory(backlogWithIssue);
    store.upsertStory(inProgressNoIssue);

    const result = await queue.reconcileInProgressIssues();

    expect(result).toEqual({ checked: 0, purged: [], errors: [] });
    expect(ghCalls).toEqual([]);
    expect(store.getStory(backlogWithIssue.id)).not.toBeNull();
    expect(store.getStory(inProgressNoIssue.id)).not.toBeNull();
  });

  it("reconcileReviewPrs() evicts PRs closed without merging from Review to Backlog", async () => {
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") return Buffer.from(JSON.stringify({ state: "CLOSED", mergedAt: null }));
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const story = makeStory({
      column: "review",
      pr: "https://github.com/test/repo/pull/12",
      prState: "open",
      worktree: "/tmp/arc-queue-closed-pr-worktree",
    });
    store.upsertStory(story);

    const result = await queue.reconcileReviewPrs();
    const updated = store.getStory(story.id)!;

    expect(result).toEqual({ checked: 1, merged: [], closed: [story.id], errors: [] });
    expect(updated.column).toBe("backlog");
    expect(updated.pr).toBeFalsy();
    expect(updated.prState).toBe("closed");
    expect(updated.annotation).toBe("escalated");
    expect(updated.worktree).toBe(story.worktree);
  });

  it("abandon() removes an in-progress worktree, releases the lock, and frees capacity", async () => {
    const { store, registry, queue } = makeQueue(1);
    const { repo, worktree } = makeGitFixture();
    const session = registry.register({ repo: "test/repo", path: repo, branch: "main", model: "test", pid: 1 });
    const project = registry.attach(session.id, "/tmp/wt");
    const running = makeStory({ id: "s1", column: "in_progress", worktree, repo: "test/repo" });
    const queued = makeStory({ id: "s2", column: "queued", branch: "feat/story-2", repo: "test/repo" });
    store.upsertStory(running);
    store.upsertStory(queued);
    store.enqueue(queued.id);
    queue.acquireWrite(worktree, running.id);

    const abandoned = await queue.abandon(running.id);
    expect(abandoned.column).toBe("backlog");
    expect(abandoned.worktree).toBe("");
    expect(existsSync(worktree)).toBe(false);
    expect(queue.isWriteLocked(worktree)).toBe(false);

    const next = (await queue.next(project.id)).story;
    expect(next?.id).toBe(queued.id);
    expect(next?.column).toBe("in_progress");
  });

  it("review() opens a GitHub PR when the branch has commits", async () => {
    const gitCalls: string[][] = [];
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        if (args[0] === "pr" && args[1] === "create") {
          return Buffer.from("https://github.com/test/repo/pull/42");
        }
        return Buffer.from("");
      }
      if (file === "git") {
        gitCalls.push([...args]);
        if (args.includes("push")) return Buffer.from("");
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    writeFileSync(join(worktree, "change.txt"), "x");
    execFileSync("git", ["-C", worktree, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", worktree, "commit", "-m", "feature"], { stdio: "pipe" });
    const story = makeStory({
      column: "in_progress",
      worktree,
      branch: "feat/story-1",
      repo: "test/repo",
    });
    store.upsertStory(story);

    const reviewed = await queue.review(story.id);

    expect(reviewed.column).toBe("review");
    expect(reviewed.pr).toBe("https://github.com/test/repo/pull/42");
    expect(reviewed.prState).toBe("open");
    expect(reviewed.annotation).toBeUndefined();
    expect(reviewed.reviewLoop).toEqual({ round: 0, maxRounds: 3, verdict: "pending", blockingCount: 0 });
    expect(reviewed.shipMode).toBe("pr");
    expect(ghCalls.some((c) => c[0] === "pr" && c[1] === "create")).toBe(true);
    expect(gitCalls.some((c) => c.includes("push"))).toBe(true);
    expect(gitCalls.some((c) => c.includes("--allow-empty"))).toBe(false);
  });

  it("review() creates an empty commit and opens a GitHub PR when the branch has no commits", async () => {
    const gitCalls: string[][] = [];
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        if (args[0] === "pr" && args[1] === "create") {
          return Buffer.from("https://github.com/test/repo/pull/43");
        }
        return Buffer.from("");
      }
      if (file === "git") {
        gitCalls.push([...args]);
        if (args.includes("push")) return Buffer.from("");
      }
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    const story = makeStory({
      column: "in_progress",
      worktree,
      branch: "feat/story-1",
      repo: "test/repo",
    });
    store.upsertStory(story);

    const reviewed = await queue.review(story.id);

    expect(reviewed.column).toBe("review");
    expect(reviewed.pr).toBe("https://github.com/test/repo/pull/43");
    expect(reviewed.pr).not.toMatch(/^local:\/\//);
    expect(reviewed.prState).toBe("open");
    expect(gitCalls.some((c) => c.includes("commit") && c.includes("--allow-empty"))).toBe(true);
    expect(gitCalls.some((c) => c.includes("push"))).toBe(true);
    expect(ghCalls.some((c) => c[0] === "pr" && c[1] === "create")).toBe(true);
  });

  it("review() rejects when gh pr create fails and no existing PR is found", async () => {
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        if (args[0] === "pr" && args[1] === "create") throw new Error("pr create failed");
        if (args[0] === "pr" && args[1] === "view") return Buffer.from("");
        return Buffer.from("");
      }
      if (file === "git" && args.includes("push")) return Buffer.from("");
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    const story = makeStory({
      column: "in_progress",
      worktree,
      branch: "feat/story-1",
      repo: "test/repo",
    });
    store.upsertStory(story);

    await expect(queue.review(story.id)).rejects.toThrow(/Failed to open or find a PR/);
    const unchanged = store.getStory(story.id)!;
    expect(unchanged.column).toBe("in_progress");
    expect(unchanged.pr).toBeFalsy();
  });

  it("review() uses a local:// sentinel for local/ repos without gh or git push", async () => {
    const gitCalls: string[][] = [];
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push([...args]);
        return Buffer.from("");
      }
      if (file === "git") gitCalls.push([...args]);
      return execFileSync(file, args, options);
    };
    const { store, queue } = makeQueue(2, runner);
    const { worktree } = makeGitFixture();
    const story = makeStory({
      column: "in_progress",
      worktree,
      branch: "feat/story-1",
      repo: "local/my-project",
    });
    store.upsertStory(story);

    const reviewed = await queue.review(story.id);

    expect(reviewed.column).toBe("review");
    expect(reviewed.pr).toBe("local://arc-story-queue/W-000001");
    expect(ghCalls).toEqual([]);
    expect(gitCalls.some((c) => c.includes("push"))).toBe(false);
  });

  describe("ship-aware review and verdict-gated merge", () => {
    it("review() honors ship and maxRounds opts without arming auto-merge for pr/auto modes", async () => {
      const ghCalls: string[][] = [];
      const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
        if (file === "gh") {
          ghCalls.push([...args]);
          if (args[0] === "pr" && args[1] === "create") {
            return Buffer.from("https://github.com/test/repo/pull/50");
          }
          return Buffer.from("");
        }
        if (file === "git" && args.includes("push")) return Buffer.from("");
        return execFileSync(file, args, options);
      };
      const { store, queue } = makeQueue(2, runner);
      const { worktree } = makeGitFixture();
      writeFileSync(join(worktree, "change.txt"), "x");
      execFileSync("git", ["-C", worktree, "add", "."], { stdio: "pipe" });
      execFileSync("git", ["-C", worktree, "commit", "-m", "feature"], { stdio: "pipe" });
      const story = makeStory({ id: "auto-story", column: "in_progress", worktree, branch: "feat/story-1" });
      store.upsertStory(story);

      const reviewed = await queue.review(story.id, { ship: "auto", maxRounds: 5 });

      expect(reviewed.shipMode).toBe("auto");
      expect(reviewed.reviewLoop).toEqual({ round: 0, maxRounds: 5, verdict: "pending", blockingCount: 0 });
      expect(reviewed.annotation).toBeUndefined();
      expect(ghCalls.some((args) => args[1] === "merge")).toBe(false);
    });

    it("review() in merge mode squashes immediately after opening the PR", async () => {
      const ghCalls: string[][] = [];
      const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
        if (file === "gh") {
          ghCalls.push([...args]);
          if (args[0] === "pr" && args[1] === "create") {
            return Buffer.from("https://github.com/test/repo/pull/51");
          }
          if (args.includes("state,mergedAt")) {
            return Buffer.from(JSON.stringify({ state: "OPEN", mergedAt: null }));
          }
          if (args.includes("mergeStateStatus,statusCheckRollup")) {
            return Buffer.from(JSON.stringify({ mergeStateStatus: "CLEAN", statusCheckRollup: [] }));
          }
          return Buffer.from("");
        }
        if (file === "git" && args.includes("push")) return Buffer.from("");
        return execFileSync(file, args, options);
      };
      const { store, queue } = makeQueue(2, runner);
      const { worktree } = makeGitFixture();
      writeFileSync(join(worktree, "change.txt"), "x");
      execFileSync("git", ["-C", worktree, "add", "."], { stdio: "pipe" });
      execFileSync("git", ["-C", worktree, "commit", "-m", "feature"], { stdio: "pipe" });
      const story = makeStory({ id: "merge-story", column: "in_progress", worktree, branch: "feat/story-1" });
      store.upsertStory(story);

      const reviewed = await queue.review(story.id, { ship: "merge" });

      expect(reviewed.column).toBe("done");
      expect(reviewed.prState).toBe("merged");
      expect(ghCalls.some((args) => args.includes("--squash"))).toBe(true);
      expect(ghCalls.some((args) => args.includes("--auto"))).toBe(false);
    });

    it("reviewRound() sets accepted on approval and arms auto-merge only for auto ship mode", async () => {
      const ghCalls: string[][] = [];
      const runner = cleanGhRunner((args) => {
        ghCalls.push([...args]);
        return undefined;
      });
      const { store, queue } = makeQueue(2, runner);
      const story = makeStory({
        column: "review",
        pr: "https://github.com/test/repo/pull/52",
        prState: "open",
        shipMode: "auto",
        reviewLoop: { round: 0, maxRounds: 3, verdict: "pending", blockingCount: 0 },
      });
      store.upsertStory(story);

      const approved = await queue.reviewRound(story.id, {
        verdict: "approved",
        blockingCount: 0,
        prCommentsUrl: "https://github.com/test/repo/pull/52#pullrequestreview-1",
      });

      expect(approved.annotation).toBe("accepted");
      expect(approved.reviewLoop).toMatchObject({
        round: 1,
        verdict: "approved",
        blockingCount: 0,
        prCommentsUrl: "https://github.com/test/repo/pull/52#pullrequestreview-1",
      });
      expect(ghCalls).toEqual([
        ["pr", "merge", "52", "--auto", "--squash", "--delete-branch", "--repo", "test/repo"],
      ]);
    });

    it("reviewRound() rejects stories whose PR is not open", async () => {
      const { store, queue } = makeQueue(2, cleanGhRunner(() => undefined));
      const story = makeStory({
        column: "review",
        pr: "https://github.com/test/repo/pull/52",
        prState: "merged",
        reviewLoop: { round: 0, maxRounds: 3, verdict: "pending", blockingCount: 0 },
      });
      store.upsertStory(story);

      await expect(
        queue.reviewRound(story.id, { verdict: "approved", blockingCount: 0 })
      ).rejects.toThrow(/open PR/);
    });

    it("reviewRound() keeps the approved state when arming auto-merge fails", async () => {
      const runner = cleanGhRunner((args) => {
        if (args[0] === "pr" && args[1] === "merge") throw new Error("auto-merge disallowed");
        return undefined;
      });
      const { store, queue } = makeQueue(2, runner);
      const story = makeStory({
        column: "review",
        pr: "https://github.com/test/repo/pull/52",
        prState: "open",
        shipMode: "auto",
        reviewLoop: { round: 0, maxRounds: 3, verdict: "pending", blockingCount: 0 },
      });
      store.upsertStory(story);

      const approved = await queue.reviewRound(story.id, { verdict: "approved", blockingCount: 0 });

      expect(approved.annotation).toBe("accepted");
      expect(store.getStory(story.id)?.reviewLoop?.verdict).toBe("approved");
    });

    it("merge() rejects without approval and succeeds with override", async () => {
      const ghCalls: string[][] = [];
      const runner = cleanGhRunner((args) => {
        ghCalls.push([...args]);
        return undefined;
      });
      const { store, queue } = makeQueue(2, runner);
      const { worktree } = makeGitFixture();
      const story = makeStory({
        column: "review",
        pr: "https://github.com/test/repo/pull/53",
        prState: "open",
        worktree,
        reviewLoop: { round: 1, maxRounds: 3, verdict: "changes_requested", blockingCount: 2 },
      });
      store.upsertStory(story);
      queue.acquireWrite(worktree, story.id);

      await expect(queue.merge(story.id)).rejects.toSatisfy((error: unknown) => {
        expect(parseMergeActionError(error)?.code).toBe("review_pending");
        return true;
      });

      const merged = await queue.merge(story.id, { override: true });

      expect(merged.column).toBe("done");
      expect(store.getStory(story.id)?.annotation).toBe("escalated");
      expect(ghCalls.some((args) => args.includes("--squash"))).toBe(true);
    });

    it("reviewRound() throws max_rounds_exceeded and escalates after the cap", async () => {
      const { store, queue } = makeQueue();
      const story = makeStory({
        column: "review",
        pr: "https://github.com/test/repo/pull/54",
        prState: "open",
        reviewLoop: { round: 3, maxRounds: 3, verdict: "changes_requested", blockingCount: 1 },
      });
      store.upsertStory(story);

      await expect(
        queue.reviewRound(story.id, { verdict: "changes_requested", blockingCount: 2 })
      ).rejects.toSatisfy((error: unknown) => {
        expect(parseMergeActionError(error)?.code).toBe("max_rounds_exceeded");
        return true;
      });

      expect(store.getStory(story.id)).toMatchObject({
        column: "review",
        annotation: "escalated",
        reviewLoop: { round: 3, maxRounds: 3, verdict: "changes_requested", blockingCount: 1 },
      });
    });

    it("complete() initializes reviewLoop and suppresses premature acceptance", async () => {
      const { store, queue } = makeQueue();
      const story = makeStory({ column: "in_progress", shipMode: "pr" });
      store.upsertStory(story);

      await queue.complete({
        id: story.id,
        handoff: {
          status: "completed",
          summary: "done",
          changes: ["a.ts"],
          verification: ["vitest"],
          risks: [],
          next_actions: [],
        },
        pr: "https://github.com/test/repo/pull/55",
        runs: [],
        outcome: "accepted",
      });

      expect(store.getStory(story.id)).toMatchObject({
        column: "review",
        reviewLoop: { round: 0, maxRounds: 3, verdict: "pending", blockingCount: 0 },
      });
      expect(store.getStory(story.id)?.annotation).toBeUndefined();
    });
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
    expect(result.story).toBeNull();
  });
});

describe("orchestration plan dispatch gate", () => {
  it("defaults to requiring a plan and dispatches planned B past unplanned A in queue order", async () => {
    const { store, registry, queue } = makeQueue();
    const { repo } = makeGitFixture();
    const project = attachProject(registry, repo);
    const awaitingPlan = makeStory({
      id: "s1",
      branch: "feat/awaiting-plan",
      orchestration: { status: "unplanned" },
    });
    const planned = makeStory({ id: "s2", branch: "feat/planned" });
    store.upsertStory(awaitingPlan);
    store.upsertStory(planned);
    store.enqueue(awaitingPlan.id);
    store.enqueue(planned.id);

    expect(store.getConfig().requireOrchestrationPlan).toBe(true);
    expect((await queue.next(project.id)).story?.id).toBe(planned.id);
    expect(store.queueIds()).toEqual([awaitingPlan.id]);
    expect(store.getStory(awaitingPlan.id)?.column).toBe("queued");
    expect(store.getStory(planned.id)?.column).toBe("in_progress");
  });

  it("reports awaiting-orchestration-plan without reserving or mutating all unplanned candidates", async () => {
    const { store, registry, queue } = makeQueue();
    const { repo } = makeGitFixture();
    const project = attachProject(registry, repo);
    const unplanned = makeStory({ id: "s1", orchestration: { status: "unplanned" } });
    const planning = makeStory({ id: "s2", branch: "feat/planning", orchestration: { status: "planning" } });
    store.upsertStory(unplanned);
    store.upsertStory(planning);
    store.enqueue(unplanned.id);
    store.enqueue(planning.id);

    expect(await queue.next(project.id)).toEqual({ story: null, reason: "awaiting-orchestration-plan" });
    expect(store.queueIds()).toEqual([unplanned.id, planning.id]);
    expect(store.getStory(unplanned.id)).toMatchObject({ column: "queued", worktree: "" });
    expect(store.getStory(planning.id)).toMatchObject({ column: "queued", worktree: "" });
    expect(queue.isWriteLocked("")).toBe(false);
  });

  it("restores legacy dispatch for unplanned stories when the kill-switch is false", async () => {
    const { store, registry, queue } = makeQueue();
    const { repo } = makeGitFixture();
    const project = attachProject(registry, repo);
    const story = makeStory({ orchestration: { status: "unplanned" } });
    store.upsertStory(story);
    store.enqueue(story.id);
    expect(store.setConfig({ requireOrchestrationPlan: false })).toMatchObject({ requireOrchestrationPlan: false });

    expect((await queue.next(project.id)).story?.id).toBe(story.id);
  });
});

describe("reconcileDoneRetention", () => {
  const retentionMs = 30 * 60_000;

  it("purges done stories past retention and emits purged event; fresh done stories are untouched", async () => {
    const store = new StoryStore(":memory:");
    const registry = new SessionRegistry();
    const sse = new SseHub();
    const emitSpy = vi.spyOn(sse, "emitEvent");
    const queue = new QueueManager({ worktreeRoot: "/tmp/wt", maxParallel: 2 }, { store, registry, sse });

    const stale = makeStory({
      id: "done-stale",
      column: "done",
      prState: "merged",
      doneAt: Date.now() - retentionMs - 1,
    });
    const fresh = makeStory({
      id: "done-fresh",
      column: "done",
      prState: "merged",
      doneAt: Date.now(),
    });
    store.upsertStory(stale);
    store.upsertStory(fresh);

    const result = await queue.reconcileDoneRetention(retentionMs);

    expect(result).toEqual({ checked: 2, stamped: [], purged: ["done-stale"] });
    expect(store.getStory("done-stale")).toBeNull();
    expect(store.getStory("done-fresh")).not.toBeNull();
    expect(emitSpy).toHaveBeenCalledWith({
      kind: "purged",
      id: "done-stale",
      wid: stale.wid,
      title: stale.title,
    });
  });

  it("stamps legacy done stories on first sweep without deleting; purges on a later sweep", async () => {
    const store = new StoryStore(":memory:");
    const registry = new SessionRegistry();
    const sse = new SseHub();
    const queue = new QueueManager({ worktreeRoot: "/tmp/wt", maxParallel: 2 }, { store, registry, sse });

    const legacy = makeStory({ id: "done-legacy", column: "done", prState: "merged" });
    store.upsertStory(legacy);

    const first = await queue.reconcileDoneRetention(retentionMs);

    expect(first).toEqual({ checked: 1, stamped: ["done-legacy"], purged: [] });
    const stamped = store.getStory("done-legacy")!;
    expect(stamped.doneAt).toBeTypeOf("number");

    stamped.doneAt = Date.now() - retentionMs - 1;
    store.upsertStory(stamped);

    const second = await queue.reconcileDoneRetention(retentionMs);

    expect(second).toEqual({ checked: 1, stamped: [], purged: ["done-legacy"] });
    expect(store.getStory("done-legacy")).toBeNull();
  });

  it("never stamps or deletes stories in other columns", async () => {
    const store = new StoryStore(":memory:");
    const registry = new SessionRegistry();
    const sse = new SseHub();
    const queue = new QueueManager({ worktreeRoot: "/tmp/wt", maxParallel: 2 }, { store, registry, sse });

    const inProgress = makeStory({ id: "s-ip", column: "in_progress", worktree: "/wt/s-ip" });
    const review = makeStory({ id: "s-review", column: "review", pr: "https://github.com/test/repo/pull/1" });
    const queued = makeStory({ id: "s-queued", column: "queued" });
    store.upsertStory(inProgress);
    store.upsertStory(review);
    store.upsertStory(queued);

    const result = await queue.reconcileDoneRetention(retentionMs);

    expect(result).toEqual({ checked: 0, stamped: [], purged: [] });
    expect(store.getStory(inProgress.id)?.doneAt).toBeUndefined();
    expect(store.getStory(review.id)?.doneAt).toBeUndefined();
    expect(store.getStory(queued.id)?.doneAt).toBeUndefined();
    expect(store.getStory(inProgress.id)?.column).toBe("in_progress");
    expect(store.getStory(review.id)?.column).toBe("review");
    expect(store.getStory(queued.id)?.column).toBe("queued");
  });
});

describe("QueueManager known projects", () => {
  it("persists attached projects recent-first and can forget them", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "arc-known-db-"));
    tmpDirs.push(dbDir);
    const dbPath = join(dbDir, "store.db");
    const repoA = mkdtempSync(join(tmpdir(), "arc-known-a-"));
    const repoB = mkdtempSync(join(tmpdir(), "arc-known-b-"));
    tmpDirs.push(repoA, repoB);

    const firstStore = new StoryStore(dbPath);
    const registry = new SessionRegistry();
    const queue = new QueueManager(
      { worktreeRoot: "/tmp/wt", maxParallel: 2 },
      { store: firstStore, registry, sse: new SseHub() }
    );

    const sessionA = registry.register({ repo: "test/a", path: repoA, branch: "main", model: "vitest", pid: 1 });
    await queue.attach(sessionA.id);
    expect(queue.listKnownProjects().map((project) => project.path)).toContain(repoA);

    firstStore.upsertKnownProject({ repo: "test/a", path: repoA, branch: "main", model: "vitest" }, 100);
    firstStore.upsertKnownProject({ repo: "test/b", path: repoB, branch: "main", model: "vitest" }, 200);

    expect(queue.listKnownProjects().map((project) => project.path)).toEqual([repoB, repoA]);
    firstStore.close();

    const secondStore = new StoryStore(dbPath);
    expect(secondStore.listKnownProjects().map((project) => project.path)).toEqual([repoB, repoA]);
    expect(secondStore.forgetKnownProject(repoA)).toBe(true);
    expect(secondStore.listKnownProjects().map((project) => project.path)).toEqual([repoB]);
    secondStore.close();
  });

  it("flags a known path that disappeared instead of dropping the row", () => {
    const { store } = makeQueue();
    const repo = mkdtempSync(join(tmpdir(), "arc-known-missing-"));
    tmpDirs.push(repo);
    store.upsertKnownProject({ repo: "test/missing", path: repo, branch: "main", model: "vitest" });
    expect(store.listKnownProjects()[0]?.exists).toBe(true);

    rmSync(repo, { recursive: true, force: true });
    expect(store.listKnownProjects()[0]).toMatchObject({ path: repo, exists: false });
  });
});
