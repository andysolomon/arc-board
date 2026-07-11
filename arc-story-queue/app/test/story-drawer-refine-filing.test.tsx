/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Story, StoryDetail } from "arc-contracts";
import type { BoardStore, BoardStory } from "../src/lib/boardStore";
import { StoryDrawer } from "../src/components/StoryDrawer";

function backlogStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "story-refine-1",
    wid: "W-000051",
    type: "story",
    title: "Refine actions mutual exclusion",
    repo: "acme/board",
    branch: "feat/W-000051",
    worktree: "",
    column: "backlog",
    priority: "med",
    size: "S",
    epic: "board",
    taskClass: "feature",
    tags: [],
    description: "",
    criteria: ["Criterion one"],
    draft: false,
    issue: "#111",
    ...overrides,
  };
}

function draftStory(overrides: Partial<Story> = {}): Story {
  return backlogStory({
    id: "story-draft-1",
    wid: "W-000052",
    title: "Draft filing busy state",
    draft: true,
    issue: undefined,
    ...overrides,
  });
}

function boardStory(story: Story): BoardStory {
  return { ...story, lines: [], lanes: {} };
}

function detail(story: Story): StoryDetail {
  return { story, runs: [], handoff: null };
}

function storeStub(
  story: Story,
  extra: Partial<BoardStore> = {},
): BoardStore {
  return {
    getState: () => ({ stories: { [story.id]: boardStory(story) } }),
    getConfig: () => ({ maxParallel: 2 }),
    liveWorkerCount: () => 0,
    closeStory: () => {},
    refineStory: vi.fn(async () => ({ note: "done" })),
    requestFile: vi.fn(async () => story),
    fileStory: vi.fn(async () => story),
    ...extra,
  } as unknown as BoardStore;
}

describe("StoryDrawer RefineActions", () => {
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

  function refineButton(testId: string): HTMLButtonElement {
    return container.querySelector(`[data-testid='${testId}']`) as HTMLButtonElement;
  }

  it("disables all refine buttons and shows an inline spinner on the active action", async () => {
    let resolve!: () => void;
    const refineStory = vi.fn(
      () =>
        new Promise<{ note: string }>((r) => {
          resolve = () => r({ note: "split complete" });
        }),
    );
    const story = backlogStory();
    const store = storeStub(story, { refineStory });

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });

    const split = refineButton("refine-split");
    const tighten = refineButton("refine-tighten");
    const dedupe = refineButton("refine-dedupe");

    await act(async () => {
      split.click();
    });

    expect(refineStory).toHaveBeenCalledTimes(1);
    expect(refineStory).toHaveBeenCalledWith(story.id, "split");
    expect(split.disabled).toBe(true);
    expect(split.querySelector(".sq-merge-phase__spinner")).not.toBeNull();
    expect(split.textContent).toContain("Splitting…");
    expect(tighten.disabled).toBe(true);
    expect(tighten.querySelector(".sq-merge-phase__spinner")).toBeNull();
    expect(dedupe.disabled).toBe(true);
    expect(dedupe.querySelector(".sq-merge-phase__spinner")).toBeNull();

    await act(async () => {
      resolve();
      await Promise.resolve();
    });

    expect(split.disabled).toBe(false);
    expect(split.querySelector(".sq-merge-phase__spinner")).toBeNull();
    expect(container.querySelector(".sq-refine-note")?.textContent).toBe("split complete");
  });
});

describe("StoryDrawer FilingSection", () => {
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

  function requestButton(): HTMLButtonElement {
    return container.querySelector("[data-testid='filing-request']") as HTMLButtonElement;
  }

  function submitButton(): HTMLButtonElement {
    return container.querySelector("[data-testid='filing-submit']") as HTMLButtonElement;
  }

  function filingInput(): HTMLInputElement {
    return container.querySelector("[data-testid='filing-input']") as HTMLInputElement;
  }

  it("disables request, input, and submit while requestFile is in flight", async () => {
    let resolve!: () => void;
    const requestFile = vi.fn(
      () =>
        new Promise<Story>((r) => {
          resolve = () => r(draftStory());
        }),
    );
    const story = draftStory();
    const store = storeStub(story, { requestFile });

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });

    await act(async () => {
      requestButton().click();
    });

    expect(requestFile).toHaveBeenCalledTimes(1);
    expect(requestButton().disabled).toBe(true);
    expect(requestButton().querySelector(".sq-merge-phase__spinner")).not.toBeNull();
    expect(filingInput().disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);

    await act(async () => {
      resolve();
      await Promise.resolve();
    });

    expect(requestButton().disabled).toBe(false);
    expect(filingInput().disabled).toBe(false);
  });

  function setFilingInput(value: string) {
    const input = filingInput();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("disables request, input, and submit while fileStory is in flight", async () => {
    let resolve!: () => void;
    const fileStory = vi.fn(
      () =>
        new Promise<Story>((r) => {
          resolve = () => r(draftStory({ draft: false, issue: "#99" }));
        }),
    );
    const story = draftStory();
    const store = storeStub(story, { fileStory });

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });

    await act(async () => {
      setFilingInput("#99");
    });

    await act(async () => {
      submitButton().click();
    });

    expect(fileStory).toHaveBeenCalledTimes(1);
    expect(fileStory).toHaveBeenCalledWith(story.id, "#99");
    expect(requestButton().disabled).toBe(true);
    expect(filingInput().disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().querySelector(".sq-merge-phase__spinner")).not.toBeNull();

    await act(async () => {
      resolve();
      await Promise.resolve();
    });

    expect(requestButton().disabled).toBe(false);
    expect(filingInput().disabled).toBe(false);
  });
});
