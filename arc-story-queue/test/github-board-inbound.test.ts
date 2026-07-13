import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isGithubBoardRemoteBusy, type GithubBoardBinding, type Story } from "arc-contracts";
import { columnFromProjectItem } from "../mcp-server/dist/github-projects.js";
import { QueueManager, type CommandRunner } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const binding: GithubBoardBinding = {
  repo: "acme/api",
  githubProjectId: "PVT_1",
  githubProjectNumber: 7,
  statusFieldId: "FIELD_1",
  statusOptionIds: {
    backlog: "opt_b",
    queued: "opt_q",
    in_progress: "opt_i",
    review: "opt_r",
    done: "opt_d",
  },
  autoCreate: true,
  updatedAt: 1,
};

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "s1",
    wid: "W-000001",
    type: "story",
    title: "Inbound",
    repo: "acme/api",
    branch: "feat/in",
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
    issue: "https://github.com/acme/api/issues/9",
    orchestration: { status: "planned", route: "composer-implement", backend: "cursor", mode: "implement", rationale: "x", complexity: "low", plannedAt: "2026-01-01T00:00:00.000Z", storyDigest: "d" },
    ...overrides,
  };
}

function mockGh(handlers: Record<string, () => unknown>): CommandRunner {
  return (file, args) => {
    if (file === "git") return "";
    const key = args.join(" ");
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (key.includes(pattern)) {
        const value = handler();
        return typeof value === "string" ? value : JSON.stringify(value);
      }
    }
    throw new Error(`Unexpected: ${file} ${key}`);
  };
}

describe("inbound GitHub board reconcile (#168)", () => {
  it("maps Arc Column / Status option names to columns", () => {
    expect(columnFromProjectItem({ id: "1", status: "in_progress" })).toBe("in_progress");
    expect(columnFromProjectItem({ id: "1", "Arc Column": "review" })).toBe("review");
    expect(columnFromProjectItem({ id: "1", status: "Done" })).toBeNull();
  });

  it("treats remote review/done/in_progress as busy", () => {
    expect(isGithubBoardRemoteBusy({ githubBoardColumn: "review" })).toBe(true);
    expect(isGithubBoardRemoteBusy({ githubBoardColumn: "queued" })).toBe(false);
  });

  it("skips queue.next when remote Status is in flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-inbound-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, ".git"), "");
    const store = new StoryStore(":memory:");
    const registry = new SessionRegistry();
    const queue = new QueueManager(
      { worktreeRoot: join(dir, "wt"), maxParallel: 2 },
      { store, registry, sse: new SseHub(), commandRunner: mockGh({}) }
    );
    store.upsertGithubBoardBinding(binding);
    store.upsertStory(makeStory({ githubBoardColumn: "in_progress" }));
    store.enqueue("s1");

    const session = registry.register({
      repo: "acme/api",
      path: dir,
      branch: "main",
      model: "vitest",
      pid: 1,
    });
    const project = await queue.attach(session.id);
    const next = await queue.next(project.id);
    expect(next.story).toBeNull();
  });

  it("reflects remote backlog onto a non-reserved queued story", async () => {
    const store = new StoryStore(":memory:");
    const queue = new QueueManager(
      { worktreeRoot: "/tmp/wt", maxParallel: 2 },
      {
        store,
        registry: new SessionRegistry(),
        sse: new SseHub(),
        commandRunner: mockGh({
          "item-list": () => ({
            items: [
              {
                id: "PVTI_1",
                status: "backlog",
                content: { url: "https://github.com/acme/api/issues/9" },
              },
            ],
          }),
        }),
      }
    );
    store.upsertGithubBoardBinding(binding);
    store.upsertStory(makeStory({ column: "queued" }));
    store.enqueue("s1");

    const result = await queue.reconcileGithubBoards();
    expect(result.reflected).toContain("s1");
    expect(store.getStory("s1")?.column).toBe("backlog");
    expect(store.getStory("s1")?.githubBoardColumn).toBe("backlog");
    expect(store.queueIds()).not.toContain("s1");
  });

  it("never steals a reserved in_progress worktree", async () => {
    const store = new StoryStore(":memory:");
    const queue = new QueueManager(
      { worktreeRoot: "/tmp/wt", maxParallel: 2 },
      {
        store,
        registry: new SessionRegistry(),
        sse: new SseHub(),
        commandRunner: mockGh({
          "item-list": () => ({
            items: [
              {
                id: "PVTI_1",
                status: "backlog",
                content: { url: "https://github.com/acme/api/issues/9" },
              },
            ],
          }),
        }),
      }
    );
    store.upsertGithubBoardBinding(binding);
    store.upsertStory(
      makeStory({
        column: "in_progress",
        worktree: "/tmp/wt/s1",
        githubBoardColumn: "in_progress",
      })
    );

    const result = await queue.reconcileGithubBoards();
    expect(result.reflected).not.toContain("s1");
    expect(store.getStory("s1")?.column).toBe("in_progress");
    expect(store.getStory("s1")?.githubBoardColumn).toBe("backlog");
  });
});
