import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";
import type { Story } from "arc-contracts";
import {
  dispatchBlockReason,
  isDispatchEligible,
  mutexKeysFromTags,
  storyMutexKeys,
} from "arc-contracts";

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

function makeQueue(maxParallel = 2, commandRunner?: ConstructorParameters<typeof QueueManager>[1]["commandRunner"]) {
  const store = new StoryStore(":memory:");
  const registry = new SessionRegistry();
  const sse = new SseHub();
  const queue = new QueueManager(
    { worktreeRoot: "/tmp/wt", maxParallel },
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

    expect(await queue.next(project.id)).toBeNull();
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

    const next = await queue.next(project.id);
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

    expect(await queue.next(project.id)).toBeNull();
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

    const next = await queue.next(project.id);
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

    const next = await queue.next(project.id);
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
    expect(await queue.next(project.id)).toBeNull();
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

  it("merge() deterministically merges the PR, removes the worktree, releases the lock, and marks done", async () => {
    const ghCalls: string[][] = [];
    const runner: ConstructorParameters<typeof QueueManager>[1]["commandRunner"] = (file, args, options) => {
      if (file === "gh") {
        ghCalls.push(args);
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
    });
    store.upsertStory(story);
    queue.acquireWrite(worktree, story.id);

    const merged = await queue.merge(story.id);

    expect(ghCalls).toEqual([["pr", "merge", "12", "--merge", "--delete-branch", "--repo", "test/repo"]]);
    expect(merged.column).toBe("done");
    expect(merged.prState).toBe("merged");
    expect(merged.worktree).toBe("");
    expect(existsSync(worktree)).toBe(false);
    expect(queue.isWriteLocked(worktree)).toBe(false);
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

    const next = await queue.next(project.id);
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
