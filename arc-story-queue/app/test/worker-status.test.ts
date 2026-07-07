import { describe, expect, it } from "vitest";
import type { Project, Story } from "arc-contracts";
import {
  applyStoryUpdate,
  createInitialBoardState,
  liveWorkerCount,
  reservedWorkerCount,
  upsertStoryInState,
  workerLanes,
} from "../src/lib/boardStore";

const project: Project = {
  id: "project-1",
  repo: "test/status",
  path: "/tmp/status",
  branch: "main",
  model: "vitest",
  pid: 1,
  worktreeRoot: "/tmp/wt",
  status: "attached",
};

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: "s1",
    wid: "W-000007",
    type: "story",
    title: "Status story",
    repo: "test/status",
    branch: "feat/status",
    worktree: "/tmp/wt/feat-status",
    column: "in_progress",
    priority: "med",
    size: "S",
    epic: "Pipeline Execution",
    taskClass: "feature",
    tags: [],
    description: "",
    criteria: [],
    draft: false,
    issue: "#7",
    ...overrides,
  };
}

describe("worker liveness status", () => {
  it("treats an in-progress story with no streamed lines as reserved, not live", () => {
    const initial = { ...createInitialBoardState(), project };
    const state = upsertStoryInState(initial, story());

    expect(liveWorkerCount(state)).toBe(0);
    expect(reservedWorkerCount(state)).toBe(1);
  });

  it("counts recent story.update lines as a live worker", () => {
    const initial = upsertStoryInState({ ...createInitialBoardState(), project }, story());
    const state = applyStoryUpdate(initial, {
      type: "story.update",
      id: "s1",
      route: "composer-implement",
      line: { kind: "out", text: "working", route: "composer-implement" },
    });

    expect(liveWorkerCount(state)).toBe(1);
    expect(reservedWorkerCount(state)).toBe(0);
  });

  it("lets stale streams fall back to reserved/no-worker status", () => {
    const initial = upsertStoryInState({ ...createInitialBoardState(), project }, story());
    const updated = applyStoryUpdate(initial, {
      type: "story.update",
      id: "s1",
      route: "composer-implement",
      line: { kind: "out", text: "old line", route: "composer-implement" },
    });
    const markedStale = {
      ...updated,
      stories: {
        ...updated.stories,
        s1: {
          ...updated.stories.s1,
          lastWorkerUpdateAt: 1_000,
          lanes: {
            "composer-implement": {
              ...updated.stories.s1.lanes["composer-implement"],
              lastUpdateAt: 1_000,
            },
          },
        },
      },
    };

    expect(liveWorkerCount(markedStale, 40_001, 30_000)).toBe(0);
    expect(reservedWorkerCount(markedStale, 40_001, 30_000)).toBe(1);
  });

  it("groups streamed output into per-route worker lanes and resolves lane status", () => {
    const base = upsertStoryInState({ ...createInitialBoardState(), project }, story());
    const explored = applyStoryUpdate(base, {
      type: "story.update",
      id: "s1",
      route: "codex-explore",
      line: { kind: "out", text: "mapped files" },
    });
    const implemented = applyStoryUpdate(explored, {
      type: "story.update",
      id: "s1",
      route: "composer-implement",
      line: { kind: "cmd", text: "npm test" },
    });
    const done = applyStoryUpdate(implemented, {
      type: "story.update",
      id: "s1",
      route: "codex-explore",
      lane: { route: "codex-explore", status: "done" },
    });

    const lanes = workerLanes(done.stories.s1);
    expect(lanes.map((lane) => lane.route)).toEqual(["codex-explore", "composer-implement"]);
    expect(lanes.find((lane) => lane.route === "codex-explore")?.status).toBe("done");
    expect(lanes.find((lane) => lane.route === "codex-explore")?.lines.map((line) => line.text)).toEqual([
      "mapped files",
    ]);
    expect(lanes.find((lane) => lane.route === "composer-implement")?.status).toBe("running");
  });
});
