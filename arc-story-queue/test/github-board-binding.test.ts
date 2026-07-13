import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  githubBoardTitleForRepo,
  validateGithubBoardBinding,
  type GithubBoardBinding,
} from "arc-contracts";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function makeQueue(dbPath = ":memory:") {
  const store = new StoryStore(dbPath);
  const registry = new SessionRegistry();
  const queue = new QueueManager(
    { worktreeRoot: "/tmp/wt", maxParallel: 2 },
    { store, registry, sse: new SseHub() }
  );
  return { store, registry, queue };
}

describe("GitHub Project board binding (#164)", () => {
  it("names the convention title from the repo short name", () => {
    expect(githubBoardTitleForRepo("acme/api")).toBe("Arc Board · api");
    expect(githubBoardTitleForRepo("solo")).toBe("Arc Board · solo");
  });

  it("validates a complete binding fixture", () => {
    const binding: GithubBoardBinding = {
      repo: "acme/api",
      githubProjectId: "PVT_kwDOABCDEF",
      githubProjectNumber: 12,
      githubProjectUrl: "https://github.com/users/acme/projects/12",
      githubProjectTitle: "Arc Board · api",
      statusFieldId: "PVTSSF_kwDOStatus",
      statusOptionIds: {
        backlog: "opt_backlog",
        queued: "opt_queued",
        in_progress: "opt_ip",
        review: "opt_review",
        done: "opt_done",
      },
      autoCreate: true,
      lastSyncedAt: 1_700_000_000_000,
      lastSyncError: null,
      updatedAt: 1_700_000_000_100,
    };
    expect(validateGithubBoardBinding(binding)).toBe(true);
  });

  it("persists link by repo and survives a fresh StoryStore on the same db", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-gh-board-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "store.db");

    const first = makeQueue(dbPath);
    expect(first.queue.getGithubBoardBinding({ repo: "acme/api" })).toBeNull();

    const linked = first.queue.linkGithubBoard({
      repo: "acme/api",
      githubProjectId: "PVT_kwDOABCDEF",
      githubProjectNumber: 3,
      githubProjectTitle: "Arc Board · api",
      statusFieldId: "PVTSSF_1",
      statusOptionIds: { backlog: "a", in_progress: "b", done: "c" },
      autoCreate: true,
    });
    expect(linked.repo).toBe("acme/api");
    expect(linked.autoCreate).toBe(true);
    expect(linked.statusOptionIds?.backlog).toBe("a");
    first.store.close();

    const second = makeQueue(dbPath);
    expect(second.queue.getGithubBoardBinding({ repo: "acme/api" })).toMatchObject({
      githubProjectId: "PVT_kwDOABCDEF",
      githubProjectNumber: 3,
      autoCreate: true,
      statusOptionIds: { backlog: "a", in_progress: "b", done: "c" },
    });
    second.store.close();
  });

  it("isolates bindings per repo", () => {
    const { store, queue } = makeQueue();
    queue.linkGithubBoard({ repo: "acme/a", githubProjectId: "PVT_a" });
    queue.linkGithubBoard({ repo: "acme/b", githubProjectId: "PVT_b", autoCreate: true });

    expect(queue.getGithubBoardBinding({ repo: "acme/a" })?.githubProjectId).toBe("PVT_a");
    expect(queue.getGithubBoardBinding({ repo: "acme/b" })?.githubProjectId).toBe("PVT_b");
    expect(store.listGithubBoardBindings().map((b) => b.repo)).toEqual(["acme/a", "acme/b"]);
  });

  it("merges partial updates and resolves repo from an attached projectId", async () => {
    const { registry, queue } = makeQueue();
    const session = registry.register({
      repo: "acme/api",
      path: "/tmp/acme-api",
      branch: "main",
      model: "vitest",
      pid: 9,
    });
    const project = await queue.attach(session.id);

    queue.linkGithubBoard({
      projectId: project.id,
      githubProjectId: "PVT_1",
      statusFieldId: "field_1",
      statusOptionIds: { backlog: "b1" },
    });

    const updated = queue.linkGithubBoard({
      projectId: project.id,
      githubProjectId: "PVT_1",
      statusOptionIds: { review: "r1" },
      lastSyncError: "rate limited",
    });

    expect(updated.statusFieldId).toBe("field_1");
    expect(updated.statusOptionIds).toEqual({ backlog: "b1", review: "r1" });
    expect(updated.lastSyncError).toBe("rate limited");
    expect(queue.getGithubBoardBinding({ projectId: project.id })?.repo).toBe("acme/api");
  });

  it("unlinks a binding", () => {
    const { queue } = makeQueue();
    queue.linkGithubBoard({ repo: "acme/api", githubProjectId: "PVT_x" });
    expect(queue.unlinkGithubBoard({ repo: "acme/api" })).toEqual({ unlinked: true });
    expect(queue.getGithubBoardBinding({ repo: "acme/api" })).toBeNull();
    expect(queue.unlinkGithubBoard({ repo: "acme/api" })).toEqual({ unlinked: false });
  });

  it("requires repo or projectId", () => {
    const { queue } = makeQueue();
    expect(() => queue.getGithubBoardBinding({})).toThrow(/repo or projectId/);
    expect(() =>
      queue.linkGithubBoard({ githubProjectId: "PVT_x" } as { githubProjectId: string })
    ).toThrow(/repo or projectId/);
  });
});
