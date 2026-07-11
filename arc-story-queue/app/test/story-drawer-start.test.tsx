/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Story, StoryDetail } from "arc-contracts";
import type { BoardStore, BoardStory } from "../src/lib/boardStore";
import { StoryDrawer } from "../src/components/StoryDrawer";

function baseStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "story-start-1",
    wid: "W-000050",
    type: "story",
    title: "Start button disabled when workers are live",
    repo: "acme/board",
    branch: "feat/W-000050-start-disabled-live-worker",
    worktree: "/tmp/wt/w-000050",
    column: "in_progress",
    priority: "med",
    size: "S",
    epic: "board",
    taskClass: "feature",
    tags: [],
    description: "",
    criteria: [],
    draft: false,
    issue: "#110",
    ...overrides,
  };
}

function boardStory(overrides: Partial<BoardStory> = {}): BoardStory {
  return {
    ...baseStory(),
    lines: [],
    lanes: {},
    ...overrides,
  };
}

function liveBoardStory(): BoardStory {
  const now = Date.now();
  return boardStory({
    lanes: {
      "composer-implement": {
        route: "composer-implement",
        status: "running",
        lines: [{ kind: "out", text: "working", route: "composer-implement" }],
        lastUpdateAt: now,
      },
    },
    lines: [{ kind: "out", text: "working", route: "composer-implement" }],
    activeRoute: "composer-implement",
    lastWorkerUpdateAt: now,
  });
}

function detail(story: Story): StoryDetail {
  return { story, runs: [], handoff: null };
}

function storeStub(
  board: BoardStory | undefined,
  opts: { maxParallel?: number; liveWorkerCount?: number } = {}
): BoardStore {
  const maxParallel = opts.maxParallel ?? 2;
  const liveCount = opts.liveWorkerCount ?? 0;
  return {
    getState: () => ({ stories: board ? { [board.id]: board } : {} }),
    getConfig: () => ({ maxParallel }),
    liveWorkerCount: () => liveCount,
    closeStory: () => {},
    startStory: vi.fn(async () => board ?? baseStory()),
  } as unknown as BoardStore;
}

function startButtonMarkup(html: string): string | null {
  const match = html.match(/<button[^>]*btn--primary[^>]*>[\s\S]*?Start work[\s\S]*?<\/button>/);
  return match?.[0] ?? null;
}

describe("StoryDrawer Start work", () => {
  it("always renders Start work for in_progress stories with a worktree", () => {
    const html = renderToStaticMarkup(
      <StoryDrawer store={storeStub(liveBoardStory())} detail={detail(baseStory())} />
    );
    expect(html).toContain("Start work");
    expect(html).toContain("Worktree cleanup");
  });

  it("disables Start without a spinner when a live worker is streaming", () => {
    const html = renderToStaticMarkup(
      <StoryDrawer store={storeStub(liveBoardStory())} detail={detail(baseStory())} />
    );
    const button = startButtonMarkup(html);
    expect(button).not.toBeNull();
    expect(button).toContain("disabled");
    expect(button).not.toContain("sq-merge-phase__spinner");
  });

  it("enables Start for a reserved-but-idle in_progress slot", () => {
    const html = renderToStaticMarkup(
      <StoryDrawer store={storeStub(boardStory())} detail={detail(baseStory())} />
    );
    const button = startButtonMarkup(html);
    expect(button).not.toBeNull();
    expect(button).not.toContain("disabled");
  });

  it("shows the slot-busy message instead of Start when all worker slots are full", () => {
    const html = renderToStaticMarkup(
      <StoryDrawer
        store={storeStub(boardStory(), { maxParallel: 2, liveWorkerCount: 2 })}
        detail={detail(baseStory())}
      />
    );
    expect(html).toContain("All 2 worker slots busy");
    expect(startButtonMarkup(html)).toBeNull();
  });

  describe("async start click", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
    });

    it("disables Start with an inline spinner until startStory settles", async () => {
      let resolve!: () => void;
      const startStory = vi.fn(
        () =>
          new Promise<Story>((r) => {
            resolve = () => r(baseStory());
          })
      );
      const store = {
        ...storeStub(boardStory()),
        startStory,
      } as unknown as BoardStore;

      await act(async () => {
        root.render(<StoryDrawer store={store} detail={detail(baseStory())} />);
      });

      const button = container.querySelector(".btn--primary") as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.querySelector(".sq-merge-phase__spinner")).toBeNull();

      await act(async () => {
        button.click();
      });

      expect(startStory).toHaveBeenCalledTimes(1);
      expect(button.disabled).toBe(true);
      expect(button.querySelector(".sq-merge-phase__spinner")).not.toBeNull();

      await act(async () => {
        resolve();
        await Promise.resolve();
      });

      expect(button.disabled).toBe(false);
      expect(button.querySelector(".sq-merge-phase__spinner")).toBeNull();
    });
  });
});
