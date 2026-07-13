/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Story } from "arc-contracts";
import { BoardView } from "../src/components/Board";
import { AppShell } from "../src/components/AppShell";
import type { BoardStore } from "../src/lib/boardStore";
import { createInitialBoardState, upsertStoryInState } from "../src/lib/boardState";
import { POINTER_DRAG_THRESHOLD_PX } from "../src/lib/pointerDnd";

beforeAll(() => {
  if (typeof globalThis.PointerEvent === "undefined") {
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    } as typeof PointerEvent;
  }
});

function filedStory(id: string, column: Story["column"] = "backlog"): Story {
  return {
    id,
    wid: `W-${id}`,
    type: "story",
    title: `Story ${id}`,
    repo: "acme/api",
    branch: `feat/${id}`,
    worktree: "",
    column,
    priority: "med",
    size: "S",
    epic: "board",
    taskClass: "feature",
    tags: [],
    description: "test",
    criteria: [],
    draft: false,
    issue: `#${id}`,
  };
}

function makeStore(stories: Story[], overrides: Partial<BoardStore> = {}): BoardStore {
  let state = createInitialBoardState();
  state = {
    ...state,
    status: "connected",
    project: {
      id: "proj-1",
      repo: "acme/api",
      path: "/tmp/api",
      branch: "main",
      model: "vitest",
      pid: 1,
      worktreeRoot: "/tmp/wt",
      status: "attached",
    },
    projects: [
      {
        id: "proj-1",
        repo: "acme/api",
        path: "/tmp/api",
        branch: "main",
        model: "vitest",
        pid: 1,
        worktreeRoot: "/tmp/wt",
        status: "attached",
      },
    ],
    activeProjectId: "proj-1",
  };
  for (const story of stories) {
    state = upsertStoryInState(state, story);
  }

  return {
    getState: () => state,
    storiesByColumn: (column: Story["column"]) =>
      Object.values(state.stories).filter((story) => story.column === column),
    queueStories: () =>
      state.queueOrder
        .map((id) => state.stories[id])
        .filter((story): story is NonNullable<typeof story> => !!story),
    liveWorkerCount: () => 0,
    reservedWorkerCount: () => 0,
    unreadCount: () => 0,
    getRuns: () => [],
    getDetail: () => state.detail,
    getNotifications: () => state.notifications,
    getToasts: () => state.toasts,
    getActivityItems: () => [],
    getIntake: () => [],
    notify: vi.fn(),
    openStory: vi.fn(async () => ({ story: filedStory("x"), runs: [], handoff: null })),
    markNotificationsRead: vi.fn(),
    queueNext: vi.fn(async () => undefined),
    getConfig: () => state.config,
    updateConfig: vi.fn(),
    closeStory: vi.fn(),
    enqueueStory: vi.fn(async () => undefined),
    unqueueStory: vi.fn(async () => undefined),
    reorderQueueTo: vi.fn(async () => undefined),
    reviewStory: vi.fn(async () => undefined),
    importIssues: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as BoardStore;
}

function dispatchPointer(
  target: Element | Window,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      pointerId: 1,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
    })
  );
}

describe("board card click vs drag", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => container),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens a draggable backlog card on sub-threshold pointerdown→pointerup", async () => {
    const onOpen = vi.fn();
    const store = makeStore([filedStory("story-a")]);

    await act(async () => {
      root.render(<BoardView store={store} onOpen={onOpen} />);
    });

    const card = container.querySelector("[data-story-id='story-a']") as HTMLElement;
    expect(card).not.toBeNull();

    await act(async () => {
      dispatchPointer(card, "pointerdown", 100, 100);
    });

    await act(async () => {
      dispatchPointer(window, "pointerup", 103, 102);
      await Promise.resolve();
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("story-a");
  });

  it("does not open when pointer movement exceeds the drag threshold", async () => {
    const onOpen = vi.fn();
    const store = makeStore([filedStory("story-a"), filedStory("story-b", "queued")]);

    await act(async () => {
      root.render(<BoardView store={store} onOpen={onOpen} />);
    });

    const card = container.querySelector("[data-story-id='story-a']") as HTMLElement;

    await act(async () => {
      dispatchPointer(card, "pointerdown", 50, 50);
    });

    await act(async () => {
      dispatchPointer(window, "pointermove", 50 + POINTER_DRAG_THRESHOLD_PX + 2, 50);
      dispatchPointer(window, "pointerup", 50 + POINTER_DRAG_THRESHOLD_PX + 2, 50);
      await Promise.resolve();
    });

    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("AppShell openStory errors", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => container),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("surfaces openStory failures via store.notify", async () => {
    const notify = vi.fn();
    const openStory = vi.fn(async () => {
      throw new Error("detail unavailable");
    });
    const store = makeStore([filedStory("err-story")], { notify, openStory });

    await act(async () => {
      root.render(<AppShell store={store} />);
    });

    const card = container.querySelector("[data-story-id='err-story']") as HTMLElement;

    await act(async () => {
      dispatchPointer(card, "pointerdown", 10, 10);
    });

    await act(async () => {
      dispatchPointer(window, "pointerup", 12, 11);
      await Promise.resolve();
    });

    expect(openStory).toHaveBeenCalledWith("err-story");
    expect(notify).toHaveBeenCalledWith("error", "detail unavailable");
  });
});
