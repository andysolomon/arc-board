/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardActionError, Story } from "arc-contracts";
import { canRemediateMerge, MergeBlockedCallout } from "../src/components/MergeBlockedCallout";

const story: Story = {
  id: "review-1", wid: "W-000055", type: "story", title: "Blocked merge", repo: "acme/board",
  branch: "feat/blocked", worktree: "/tmp/blocked", column: "review", priority: "med", size: "S",
  epic: "", taskClass: "feature", tags: [], description: "", criteria: [], draft: false, issue: "#115",
  pr: "https://github.com/acme/board/pull/115",
};

function error(code: BoardActionError["code"]): BoardActionError {
  return { code, title: "Merge blocked", detail: "", actions: [], retryable: true };
}

describe("MergeBlockedCallout remediation eligibility", () => {
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

  it("uses the exact eligible codes and hides composer remediation for every ineligible merge error", () => {
    for (const code of ["checks_failed", "branch_policy", "behind_base", "unknown"] as const) {
      expect(canRemediateMerge(code)).toBe(true);
    }
    for (const code of ["checks_pending", "timeout", "already_merged", "pr_closed", "graphql"] as const) {
      expect(canRemediateMerge(code)).toBe(false);
    }
  });

  it("passes the structured error code to the composer action", async () => {
    const fix = vi.fn();
    await act(async () => {
      root.render(<MergeBlockedCallout error={error("behind_base")} story={story} onFixWithComposer={fix} />);
    });
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Fix with Composer") as HTMLButtonElement;
    await act(async () => { button.click(); });
    expect(fix).toHaveBeenCalledWith("behind_base");
  });
});
