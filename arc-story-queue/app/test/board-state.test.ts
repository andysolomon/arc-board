import { describe, expect, it } from "vitest";
import type { Project, Story } from "arc-contracts";
// Import straight from the pure state module — no BoardStore, no MCP client.
// If board state ever grew a transport dependency, this import would pull the
// MCP SDK into a test that never connects, so the seam stays honest here.
import {
  activeRepoFilter,
  applyStoryUpdate,
  type BoardState,
  createInitialBoardState,
  liveWorkerCount,
  replaceStoriesInState,
  reservedWorkerCount,
  storiesForColumn,
  upsertStoryInState,
} from "../src/lib/boardState";

const project: Project = {
  id: "project-1",
  repo: "acme/board",
  path: "/tmp/board",
  branch: "main",
  model: "vitest",
  pid: 1,
  worktreeRoot: "/tmp/wt",
  status: "attached",
};

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: "s1",
    wid: "W-000001",
    type: "story",
    title: "State story",
    repo: "acme/board",
    branch: "feat/state",
    worktree: "/tmp/wt/feat-state",
    column: "backlog",
    priority: "med",
    size: "S",
    epic: "Board",
    taskClass: "feature",
    tags: [],
    description: "",
    criteria: [],
    draft: false,
    issue: "#1",
    ...overrides,
  };
}

describe("board state reducers (transport-free)", () => {
  it("upserts a story and tracks it exactly once", () => {
    const initial = { ...createInitialBoardState(), project };
    const once = upsertStoryInState(initial, story());
    const twice = upsertStoryInState(once, story({ title: "Renamed" }));

    expect(Object.keys(twice.stories)).toEqual(["s1"]);
    expect(twice.stories.s1.title).toBe("Renamed");
    expect(twice.trackedIds).toEqual(["s1"]);
    // Reducers are pure: the original state is not mutated.
    expect(initial.stories).toEqual({});
  });

  it("appends streamed lines into per-route lanes", () => {
    const base = upsertStoryInState({ ...createInitialBoardState(), project }, story({ column: "in_progress" }));
    const updated = applyStoryUpdate(base, {
      type: "story.update",
      id: "s1",
      route: "composer-implement",
      line: { kind: "out", text: "working", route: "composer-implement" },
    });

    expect(updated.stories.s1.lines.map((l) => l.text)).toEqual(["working"]);
    expect(updated.stories.s1.lanes["composer-implement"].lines).toHaveLength(1);
    expect(updated.stories.s1.activeRoute).toBe("composer-implement");
  });

  it("selects and orders stories per column, scoped to the active repo", () => {
    let state: BoardState = { ...createInitialBoardState(), project };
    state = upsertStoryInState(state, story({ id: "b", wid: "W-000003" }));
    state = upsertStoryInState(state, story({ id: "a", wid: "W-000002" }));
    state = upsertStoryInState(state, story({ id: "other", wid: "W-000009", repo: "other/repo" }));

    const backlog = storiesForColumn(state, "backlog");
    // Sorted by W-id, and the story from a non-active repo is filtered out.
    expect(backlog.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("filters by the active repo via activeRepoFilter", () => {
    const state = { ...createInitialBoardState(), project };
    const matches = activeRepoFilter(state);
    expect(matches({ repo: "acme/board" })).toBe(true);
    expect(matches({ repo: "other/repo" })).toBe(false);
  });

  it("derives live vs reserved worker counts from lane recency", () => {
    let state = upsertStoryInState({ ...createInitialBoardState(), project }, story({ column: "in_progress" }));
    // No streamed lines yet → reserved, not live.
    expect(liveWorkerCount(state)).toBe(0);
    expect(reservedWorkerCount(state)).toBe(1);

    state = applyStoryUpdate(state, {
      type: "story.update",
      id: "s1",
      route: "composer-implement",
      line: { kind: "out", text: "live", route: "composer-implement" },
    });
    expect(liveWorkerCount(state)).toBe(1);
    expect(reservedWorkerCount(state)).toBe(0);
  });

  it("replaceStoriesInState drops scoped orphans and keeps other repos", () => {
    let state: BoardState = { ...createInitialBoardState(), project };
    state = upsertStoryInState(state, story({ id: "keep", wid: "W-000010" }));
    state = upsertStoryInState(state, story({ id: "drop", wid: "W-000011" }));
    state = upsertStoryInState(state, story({ id: "other", wid: "W-000099", repo: "other/repo" }));
    state = { ...state, queueOrder: ["keep", "drop"], trackedIds: ["keep", "drop", "other"] };

    const next = replaceStoriesInState(state, [story({ id: "keep", wid: "W-000010", title: "Still here" })]);

    expect(Object.keys(next.stories).sort()).toEqual(["keep", "other"]);
    expect(next.stories.keep.title).toBe("Still here");
    expect(next.queueOrder).toEqual(["keep"]);
    expect(next.trackedIds).toEqual(["keep", "other"]);
  });
});
