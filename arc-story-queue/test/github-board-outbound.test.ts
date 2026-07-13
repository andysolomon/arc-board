import { describe, expect, it, vi } from "vitest";
import type { GithubBoardBinding, Story } from "arc-contracts";
import {
  findProjectItemByIssueUrl,
  issueUrlForStory,
  syncStoryColumnToGithubBoard,
  type GhRunner,
} from "../mcp-server/dist/github-projects.js";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";

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
    title: "Sync me",
    repo: "acme/api",
    branch: "feat/sync",
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
    orchestration: { status: "unplanned" },
    ...overrides,
  };
}

function mockGh(handlers: Record<string, (args: readonly string[]) => unknown>): GhRunner {
  return (_file, args) => {
    const key = args.join(" ");
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (key.includes(pattern)) {
        const value = handler(args);
        return typeof value === "string" ? value : JSON.stringify(value);
      }
    }
    throw new Error(`Unexpected gh: ${key}`);
  };
}

describe("outbound GitHub board sync (#166)", () => {
  it("builds issue URLs from #N and full URLs", () => {
    expect(issueUrlForStory("acme/api", "#12")).toBe("https://github.com/acme/api/issues/12");
    expect(issueUrlForStory("acme/api", "https://github.com/acme/api/issues/3")).toBe(
      "https://github.com/acme/api/issues/3"
    );
    expect(issueUrlForStory("acme/api", null)).toBeNull();
  });

  it("finds an existing project item by issue URL", () => {
    const item = findProjectItemByIssueUrl(
      [
        {
          id: "PVTI_1",
          content: { url: "https://github.com/acme/api/issues/9/" },
        },
      ],
      "https://github.com/acme/api/issues/9"
    );
    expect(item?.id).toBe("PVTI_1");
  });

  it("adds a missing item then sets Status option", () => {
    const edits: string[] = [];
    const runner = mockGh({
      "item-list": () => ({ items: [] }),
      "item-add": () => ({ id: "PVTI_new" }),
      "item-edit": (args) => {
        edits.push(args.join(" "));
        return "";
      },
    });
    const result = syncStoryColumnToGithubBoard({
      binding,
      column: "in_progress",
      issueUrl: "https://github.com/acme/api/issues/9",
      runner,
    });
    expect(result.itemId).toBe("PVTI_new");
    expect(result.optionId).toBe("opt_i");
    expect(edits[0]).toContain("--single-select-option-id opt_i");
  });

  it("syncs on enqueue without aborting when gh fails", async () => {
    const runner = mockGh({
      "item-list": () => {
        throw new Error("boom");
      },
    });
    const store = new StoryStore(":memory:");
    const queue = new QueueManager(
      { worktreeRoot: "/tmp/wt", maxParallel: 2 },
      { store, registry: new SessionRegistry(), sse: new SseHub(), commandRunner: runner }
    );
    store.upsertGithubBoardBinding(binding);
    store.upsertStory(makeStory({ column: "backlog" }));

    const story = await queue.enqueueStory("s1");
    expect(story.column).toBe("queued");
    expect(queue.getGithubBoardBinding({ repo: "acme/api" })?.lastSyncError).toMatch(/boom/);
  });

  it("persists githubProjectItemId after a successful sync", async () => {
    const runner = mockGh({
      "item-list": () => ({
        items: [{ id: "PVTI_existing", content: { url: "https://github.com/acme/api/issues/9" } }],
      }),
      "item-edit": () => "",
    });
    const store = new StoryStore(":memory:");
    const queue = new QueueManager(
      { worktreeRoot: "/tmp/wt", maxParallel: 2 },
      { store, registry: new SessionRegistry(), sse: new SseHub(), commandRunner: runner }
    );
    store.upsertGithubBoardBinding(binding);
    store.upsertStory(makeStory({ column: "backlog" }));

    await queue.enqueueStory("s1");
    expect(store.getStory("s1")?.githubProjectItemId).toBe("PVTI_existing");
    expect(queue.getGithubBoardBinding({ repo: "acme/api" })?.lastSyncError).toBeNull();
    expect(queue.getGithubBoardBinding({ repo: "acme/api" })?.lastSyncedAt).toEqual(expect.any(Number));
  });

  it("no-ops when the repo has no binding", async () => {
    const runner = vi.fn(() => {
      throw new Error("should not call gh");
    }) as unknown as GhRunner;
    const store = new StoryStore(":memory:");
    const queue = new QueueManager(
      { worktreeRoot: "/tmp/wt", maxParallel: 2 },
      { store, registry: new SessionRegistry(), sse: new SseHub(), commandRunner: runner }
    );
    store.upsertStory(makeStory({ column: "backlog" }));
    await queue.enqueueStory("s1");
    expect(runner).not.toHaveBeenCalled();
  });
});
