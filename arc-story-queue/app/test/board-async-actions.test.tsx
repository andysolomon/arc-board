/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardStore, BoardStory } from "../src/lib/boardStore";
import { QueueView } from "../src/components/QueueView";
import { StoryCard } from "../src/components/StoryCard";

function backlogStory(id: string): BoardStory {
  return {
    id,
    wid: `W-${id}`,
    type: "story",
    title: `Story ${id}`,
    repo: "acme/api",
    branch: `feat/${id}`,
    worktree: "",
    column: "backlog",
    priority: "med",
    size: "S",
    epic: "board",
    taskClass: "feature",
    tags: [],
    description: "test",
    criteria: [],
    draft: false,
    issue: `#${id}`,
    lines: [],
    lanes: {},
  };
}

describe("per-row and per-card async busy isolation", () => {
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

  it("only disables the clicked intake Draft button while drafting", async () => {
    const resolvers = new Map<string, () => void>();
    const draftIntake = vi.fn(
      (id: string) =>
        new Promise<void>((resolve) => {
          resolvers.set(id, resolve);
        }),
    );

    const store = {
      getState: () => ({
        activeProjectId: "proj",
        projects: [{ id: "proj" }],
        project: { repo: "acme/api" },
      }),
      storiesByColumn: () => [],
      queueStories: () => [],
      getIntake: () => [
        { id: "intake-a", kind: "idea", title: "First", status: "pending" },
        { id: "intake-b", kind: "idea", title: "Second", status: "pending" },
      ],
      draftIntake,
    } as unknown as BoardStore;

    await act(async () => {
      root.render(<QueueView store={store} />);
    });

    const btnA = container.querySelector("[data-testid='draft-intake-intake-a']") as HTMLButtonElement;
    const btnB = container.querySelector("[data-testid='draft-intake-intake-b']") as HTMLButtonElement;

    await act(async () => {
      btnA.click();
    });

    expect(draftIntake).toHaveBeenCalledTimes(1);
    expect(draftIntake).toHaveBeenCalledWith("intake-a");
    expect(btnA.disabled).toBe(true);
    expect(btnA.querySelector(".sq-merge-phase__spinner")).not.toBeNull();
    expect(btnB.disabled).toBe(false);
    expect(btnB.querySelector(".sq-merge-phase__spinner")).toBeNull();

    await act(async () => {
      resolvers.get("intake-a")?.();
      await Promise.resolve();
    });

    expect(btnA.disabled).toBe(false);
  });

  it("only disables the clicked StoryCard Enqueue button while enqueueing", async () => {
    const resolvers = new Map<string, () => void>();
    const onEnqueue = vi.fn(
      (id: string) =>
        new Promise<void>((resolve) => {
          resolvers.set(id, resolve);
        }),
    );

    await act(async () => {
      root.render(
        <>
          <StoryCard story={backlogStory("card-a")} onEnqueue={onEnqueue} />
          <StoryCard story={backlogStory("card-b")} onEnqueue={onEnqueue} />
        </>,
      );
    });

    const btnA = container.querySelector("[data-testid='enqueue-card-a']") as HTMLButtonElement;
    const btnB = container.querySelector("[data-testid='enqueue-card-b']") as HTMLButtonElement;

    await act(async () => {
      btnA.click();
    });

    expect(onEnqueue).toHaveBeenCalledTimes(1);
    expect(onEnqueue).toHaveBeenCalledWith("card-a");
    expect(btnA.disabled).toBe(true);
    expect(btnA.querySelector(".sq-merge-phase__spinner")).not.toBeNull();
    expect(btnB.disabled).toBe(false);
    expect(btnB.querySelector(".sq-merge-phase__spinner")).toBeNull();

    await act(async () => {
      resolvers.get("card-a")?.();
      await Promise.resolve();
    });

    expect(btnA.disabled).toBe(false);
  });
});
