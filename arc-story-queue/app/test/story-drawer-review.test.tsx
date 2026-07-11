/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrReadiness, Story, StoryDetail } from "arc-contracts";
import type { BoardStore, BoardStory } from "../src/lib/boardStore";
import { StoryDrawer } from "../src/components/StoryDrawer";

function reviewStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "story-review-1",
    wid: "W-000054",
    type: "story",
    title: "PR readiness strip",
    repo: "acme/board",
    branch: "feat/W-000054-pr-readiness",
    worktree: "/tmp/wt/w-000054",
    column: "review",
    priority: "med",
    size: "S",
    epic: "board",
    taskClass: "feature",
    tags: [],
    description: "",
    criteria: [],
    draft: false,
    issue: "#114",
    pr: "https://github.com/acme/board/pull/54",
    ...overrides,
  };
}

function boardStory(overrides: Partial<BoardStory> = {}): BoardStory {
  return {
    ...reviewStory(),
    lines: [],
    lanes: {},
    ...overrides,
  };
}

function detail(story: Story): StoryDetail {
  return { story, runs: [], handoff: null };
}

function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        assertion();
        resolve();
      } catch (err) {
        if (Date.now() - start >= timeoutMs) reject(err);
        else setTimeout(tick, 20);
      }
    };
    tick();
  });
}

function storeStub(
  board: BoardStory,
  readiness: PrReadiness,
  opts: {
    prReadiness?: BoardStore["prReadiness"];
    mergeStory?: BoardStore["mergeStory"];
    remediateMergeStory?: BoardStore["remediateMergeStory"];
  } = {}
): BoardStore {
  const prReadiness =
    opts.prReadiness ??
    vi.fn(async () => readiness);
  return {
    getState: () => ({ stories: { [board.id]: board } }),
    getConfig: () => ({ maxParallel: 2 }),
    liveWorkerCount: () => 0,
    closeStory: () => {},
    mergeStory: opts.mergeStory ?? vi.fn(async () => board),
    remediateMergeStory: opts.remediateMergeStory ?? vi.fn(async () => board),
    prReadiness,
  } as unknown as BoardStore;
}

describe("StoryDrawer review readiness", () => {
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

  it("renders readiness chips from store.prReadiness", async () => {
    const story = reviewStory();
    const readiness: PrReadiness = {
      mergeStateStatus: "BLOCKED",
      failingChecks: ["Merge Gate"],
      pendingChecks: ["CI / lint"],
    };
    const store = storeStub(boardStory(story), readiness);

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="pr-readiness-strip"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="pr-readiness-status"]')?.textContent).toBe("BLOCKED");
      expect(container.querySelectorAll('[data-testid="pr-readiness-fail"]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-testid="pr-readiness-pending"]')).toHaveLength(1);
      expect(container.querySelector('[data-testid="pr-readiness-link"]')).not.toBeNull();
    });
  });

  it("disables Merge with Waiting for Merge Gate when checks are pending", async () => {
    const story = reviewStory();
    const readiness: PrReadiness = {
      mergeStateStatus: "BLOCKED",
      failingChecks: [],
      pendingChecks: ["Merge Gate"],
    };
    const store = storeStub(boardStory(story), readiness);

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });

    await waitFor(() => {
      const button = container.querySelector(".btn--success") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain("Waiting for Merge Gate…");
      expect(button.querySelector(".sq-merge-phase__spinner")).not.toBeNull();
    });
  });

  it("enables Merge when readiness is CLEAN with no failing or pending checks", async () => {
    const story = reviewStory();
    const readiness: PrReadiness = {
      mergeStateStatus: "CLEAN",
      failingChecks: [],
      pendingChecks: [],
    };
    const store = storeStub(boardStory(story), readiness);

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });

    await waitFor(() => {
      const button = container.querySelector(".btn--success") as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.textContent).toContain("✓ Merge PR & clean worktree");
      expect(container.querySelector('[data-testid="pr-readiness-passing"]')).not.toBeNull();
    });
  });

  it("shows Fix with Composer only for remediable structured errors and wires it with busy/error behavior", async () => {
    const story = reviewStory();
    const readiness: PrReadiness = { mergeStateStatus: "CLEAN", failingChecks: [], pendingChecks: [] };
    const mergeError = `ARC_ACTION_ERROR:${JSON.stringify({
      code: "checks_failed",
      title: "Checks failed",
      detail: "CI failed",
      actions: ["Fix checks", "Retry merge"],
      retryable: true,
    })}`;
    let rejectFix!: (error: Error) => void;
    const remediateMergeStory = vi.fn(
      () => new Promise<Story>((_resolve, reject) => { rejectFix = reject; })
    );
    const mergeStory = vi.fn(async () => { throw new Error(mergeError); });
    const store = storeStub(boardStory(story), readiness, { mergeStory, remediateMergeStory });

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });
    await waitFor(() => expect(container.querySelector(".btn--success")).not.toBeNull());

    await act(async () => {
      (container.querySelector(".btn--success") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(container.textContent).toContain("Fix with Composer"));

    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry merge") as HTMLButtonElement;
    await act(async () => { retry.click(); await Promise.resolve(); });
    expect(mergeStory).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(container.textContent).toContain("Fix with Composer"));

    const fix = [...container.querySelectorAll("button")].find((button) => button.textContent === "Fix with Composer") as HTMLButtonElement;
    await act(async () => { fix.click(); });
    expect(remediateMergeStory).toHaveBeenCalledWith(story.id, "checks_failed");
    expect((container.querySelector(".btn--success") as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      rejectFix(new Error("Composer remediation failed"));
      await Promise.resolve();
    });
    await waitFor(() => expect(container.textContent).toContain("Composer remediation failed"));
  });

  it("renders review-rounds strip from reviewLoop fixture", async () => {
    const story = reviewStory({
      reviewLoop: {
        round: 1,
        maxRounds: 3,
        verdict: "changes_requested",
        blockingCount: 2,
        prCommentsUrl: "https://github.com/acme/board/pull/54#issuecomment-1",
      },
    });
    const readiness: PrReadiness = {
      mergeStateStatus: "CLEAN",
      failingChecks: [],
      pendingChecks: [],
    };
    const store = storeStub(boardStory(story), readiness);

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="review-rounds-strip"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="review-rounds-round"]')?.textContent).toBe("round 1/3");
      expect(container.querySelector('[data-testid="review-rounds-verdict"]')?.textContent).toBe("changes requested");
      expect(container.querySelector('[data-testid="review-rounds-blocking"]')?.textContent).toBe("2 blocking");
      expect(container.querySelector('[data-testid="review-rounds-comments-link"]')).not.toBeNull();
    });
  });

  it("omits review-rounds strip for legacy stories without reviewLoop", async () => {
    const story = reviewStory();
    const readiness: PrReadiness = {
      mergeStateStatus: "CLEAN",
      failingChecks: [],
      pendingChecks: [],
    };
    const store = storeStub(boardStory(story), readiness);

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="review-rounds-strip"]')).toBeNull();
    });
  });

  it("disables merge with review-loop reason when verdict is pending", async () => {
    const story = reviewStory({
      reviewLoop: { round: 0, maxRounds: 3, verdict: "pending", blockingCount: 0 },
    });
    const readiness: PrReadiness = {
      mergeStateStatus: "CLEAN",
      failingChecks: [],
      pendingChecks: [],
    };
    const store = storeStub(boardStory(story), readiness);

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });

    await waitFor(() => {
      const button = container.querySelector(".btn--success") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain("awaiting review (0/3)");
      expect(container.querySelector('[data-testid="merge-override"]')).not.toBeNull();
    });
  });

  it("enables merge when reviewLoop verdict is approved", async () => {
    const story = reviewStory({
      reviewLoop: { round: 2, maxRounds: 3, verdict: "approved", blockingCount: 0 },
    });
    const readiness: PrReadiness = {
      mergeStateStatus: "CLEAN",
      failingChecks: [],
      pendingChecks: [],
    };
    const store = storeStub(boardStory(story), readiness);

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });

    await waitFor(() => {
      const button = container.querySelector(".btn--success") as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.textContent).toContain("✓ Merge PR & clean worktree");
      expect(container.querySelector('[data-testid="merge-override"]')).toBeNull();
    });
  });

  it("Merge anyway invokes mergeStory with override", async () => {
    const story = reviewStory({
      reviewLoop: { round: 1, maxRounds: 3, verdict: "changes_requested", blockingCount: 1 },
    });
    const readiness: PrReadiness = {
      mergeStateStatus: "CLEAN",
      failingChecks: [],
      pendingChecks: [],
    };
    const mergeStory = vi.fn(async () => story);
    const store = storeStub(boardStory(story), readiness, { mergeStory });

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="merge-override"]')).not.toBeNull();
    });

    await act(async () => {
      (container.querySelector('[data-testid="merge-override"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(mergeStory).toHaveBeenCalledWith(story.id, { override: true });
  });

  it("disables override when both review and readiness gates are blocked", async () => {
    const story = reviewStory({
      reviewLoop: { round: 1, maxRounds: 3, verdict: "changes_requested", blockingCount: 1 },
    });
    const readiness: PrReadiness = {
      mergeStateStatus: "BLOCKED",
      failingChecks: ["Merge Gate"],
      pendingChecks: [],
    };
    const store = storeStub(boardStory(story), readiness);

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });

    await waitFor(() => {
      const override = container.querySelector('[data-testid="merge-override"]') as HTMLButtonElement;
      expect(override).not.toBeNull();
      expect(override.disabled).toBe(true);
      expect(override.textContent).toContain("Merge anyway (skips review only)");
    });
  });

  it("omits override button for legacy stories without reviewLoop", async () => {
    const story = reviewStory();
    const readiness: PrReadiness = {
      mergeStateStatus: "CLEAN",
      failingChecks: [],
      pendingChecks: [],
    };
    const store = storeStub(boardStory(story), readiness);

    await act(async () => {
      root.render(<StoryDrawer store={store} detail={detail(story)} />);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="merge-override"]')).toBeNull();
    });
  });
});
