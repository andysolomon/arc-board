import { describe, expect, it, vi } from "vitest";
import type { Project, RunRecord, Story, StoryDetail } from "arc-contracts";
import { BoardStore } from "../src/lib/boardStore";

const story: Story = {
  id: "remediate-store-1", wid: "W-000115", type: "story", title: "Refresh remediation detail",
  repo: "acme/board", branch: "feat/W-000115", worktree: "/tmp/w-000115", column: "review",
  priority: "med", size: "S", epic: "board", taskClass: "feature", tags: [], description: "", criteria: [],
  draft: false, issue: "#115", pr: "https://github.com/acme/board/pull/115",
};

const run: RunRecord = {
  id: "run-remediate", storyId: story.id, label: "remediation", repo: story.repo, route: "composer-implement",
  backend: "Cursor Agent", model: "composer", access: "write", tokens: 0, durMs: 1, status: "completed",
  changed: 1, outcome: "accepted",
};

function result(value: unknown, isError = false) {
  return { isError, content: [{ type: "text", text: JSON.stringify(value) }] };
}

function storeWithSync(callRaw: () => Promise<unknown>) {
  const refreshed: StoryDetail = {
    story,
    runs: [run],
    handoff: { status: "completed", summary: "persisted", changes: [], verification: [], risks: [], next_actions: ["Retry merge"] },
  };
  const sync = {
    isConnected: () => true,
    callRaw: vi.fn(callRaw),
    call: vi.fn(async (tool: string) => {
      if (tool === "story.detail") return refreshed;
      if (tool === "queue.list") return [story];
      if (tool === "runs.list") return [run];
      throw new Error(`Unexpected tool: ${tool}`);
    }),
  };
  const store = new BoardStore("http://127.0.0.1:9/mcp", { storage: null, sync: sync as never });
  (store as unknown as { state: { project: Project; detail: StoryDetail } }).state = {
    ...store.getState(),
    project: { id: "project-1" } as Project,
    detail: { story, runs: [], handoff: null },
  };
  return { store, sync, refreshed };
}

describe("BoardStore merge remediation refresh", () => {
  it("refreshes the open detail, handoff, and runs after successful remediation", async () => {
    const { store, sync, refreshed } = storeWithSync(async () => result(story));

    await expect(store.remediateMergeStory(story.id, "checks_failed")).resolves.toEqual(story);
    expect(sync.call).toHaveBeenCalledWith("story.detail", { id: story.id });
    expect(sync.call).toHaveBeenCalledWith("runs.list", { projectId: "project-1" });
    expect(store.getState().detail).toMatchObject({ story, runs: refreshed.runs, handoff: refreshed.handoff });
  });

  it("refreshes persisted blocked output and rethrows the original action error", async () => {
    const actionError = new Error("blocked remediation response");
    const { store, sync, refreshed } = storeWithSync(async () => { throw actionError; });

    await expect(store.remediateMergeStory(story.id, "branch_policy")).rejects.toBe(actionError);
    expect(sync.call).toHaveBeenCalledWith("story.detail", { id: story.id });
    expect(sync.call).toHaveBeenCalledWith("runs.list", { projectId: "project-1" });
    expect(store.getState().detail).toMatchObject({ story, runs: refreshed.runs, handoff: refreshed.handoff });
  });
});
