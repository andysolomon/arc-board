/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Story } from "arc-contracts";
import type { BoardStory } from "../src/lib/boardStore";
import { StoryCard } from "../src/components/StoryCard";

function reviewStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "story-review-card-1",
    wid: "W-000063",
    type: "story",
    title: "Review loop indicator",
    repo: "acme/board",
    branch: "feat/W-000063-review-loop-ui",
    worktree: "/tmp/wt/w-000063",
    column: "review",
    priority: "med",
    size: "S",
    epic: "board",
    taskClass: "feature",
    tags: [],
    description: "",
    criteria: [],
    draft: false,
    issue: "#163",
    pr: "https://github.com/acme/board/pull/63",
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

describe("StoryCard review loop indicator", () => {
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

  it("renders compact loop indicator for pending-verdict review stories", async () => {
    const story = boardStory({
      reviewLoop: { round: 1, maxRounds: 3, verdict: "pending", blockingCount: 0 },
    });

    await act(async () => {
      root.render(<StoryCard story={story} />);
    });

    const indicator = container.querySelector('[data-testid="review-loop-indicator"]');
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toBe("↻ 1/3");
    expect(indicator?.getAttribute("aria-label")).toBe("review round 1 of 3");
    expect(indicator?.getAttribute("title")).toBe("review round 1 of 3");
  });

  it("renders awaiting indicator for round zero", async () => {
    const story = boardStory({
      reviewLoop: { round: 0, maxRounds: 3, verdict: "pending", blockingCount: 0 },
    });

    await act(async () => {
      root.render(<StoryCard story={story} />);
    });

    const indicator = container.querySelector('[data-testid="review-loop-indicator"]');
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toBe("↻ awaiting");
    expect(indicator?.getAttribute("aria-label")).toBe("awaiting review");
    expect(indicator?.getAttribute("title")).toBe("awaiting review");
  });

  it("omits loop indicator when reviewLoop verdict is approved", async () => {
    const story = boardStory({
      reviewLoop: { round: 2, maxRounds: 3, verdict: "approved", blockingCount: 0 },
    });

    await act(async () => {
      root.render(<StoryCard story={story} />);
    });

    expect(container.querySelector('[data-testid="review-loop-indicator"]')).toBeNull();
  });

  it("omits loop indicator for legacy review stories without reviewLoop", async () => {
    const story = boardStory();

    await act(async () => {
      root.render(<StoryCard story={story} />);
    });

    expect(container.querySelector('[data-testid="review-loop-indicator"]')).toBeNull();
  });
});
