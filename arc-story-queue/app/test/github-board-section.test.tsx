/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubBoardBinding, Project } from "arc-contracts";
import { GithubBoardSection, projectNumberFromUrl } from "../src/components/GithubBoardSection";
import type { BoardStore } from "../src/lib/boardStore";
import { createInitialBoardState } from "../src/lib/boardState";

describe("projectNumberFromUrl", () => {
  it("parses user and org project URLs", () => {
    expect(projectNumberFromUrl("https://github.com/users/acme/projects/12")).toBe(12);
    expect(projectNumberFromUrl("https://github.com/orgs/acme/projects/3")).toBe(3);
    expect(projectNumberFromUrl("not-a-url")).toBeNull();
  });
});

describe("GithubBoardSection", () => {
  let container: HTMLDivElement;
  let root: Root;

  const project: Project = {
    id: "proj-1",
    repo: "acme/api",
    path: "/tmp/api",
    branch: "main",
    model: "vitest",
    pid: 1,
    worktreeRoot: "/tmp/wt",
    status: "attached",
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function makeStore(binding: GithubBoardBinding | null = null): BoardStore {
    const state = {
      ...createInitialBoardState(),
      status: "connected" as const,
      project,
      projects: [project],
      activeProjectId: project.id,
    };
    return {
      getState: () => state,
      getGithubBoardBinding: vi.fn(async () => binding),
      ensureGithubBoard: vi.fn(async () => ({
        repo: "acme/api",
        githubProjectId: "PVT_1",
        githubProjectNumber: 12,
        githubProjectUrl: "https://github.com/users/acme/projects/12",
        githubProjectTitle: "Arc Board · api",
        statusFieldId: "F1",
        statusOptionIds: { backlog: "b" },
        autoCreate: true,
        lastSyncedAt: 1_700_000_000_000,
        lastSyncError: null,
        updatedAt: 1,
      })),
    } as unknown as BoardStore;
  }

  it("shows linked sync health and runs ensure", async () => {
    const binding: GithubBoardBinding = {
      repo: "acme/api",
      githubProjectId: "PVT_1",
      githubProjectTitle: "Arc Board · api",
      githubProjectUrl: "https://github.com/users/acme/projects/12",
      autoCreate: true,
      lastSyncedAt: 1_700_000_000_000,
      lastSyncError: null,
      updatedAt: 1,
    };
    const store = makeStore(binding);

    await act(async () => {
      root.render(<GithubBoardSection store={store} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Arc Board · api");
    const link = container.querySelector('a[href="https://github.com/users/acme/projects/12"]');
    expect(link?.textContent).toMatch(/Open on GitHub/);

    const ensureBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Ensure board")
    );
    expect(ensureBtn).toBeTruthy();
    await act(async () => {
      ensureBtn!.click();
    });
    expect(store.ensureGithubBoard).toHaveBeenCalledWith({
      projectId: "proj-1",
      autoCreate: true,
    });
  });
});
