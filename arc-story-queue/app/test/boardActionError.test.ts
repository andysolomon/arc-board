import { describe, expect, it } from "vitest";
import type { BoardActionError } from "arc-contracts";
import { formatBoardActionError, isMachineDetail } from "../src/lib/boardActionError";

describe("boardActionError", () => {
  it("detects machine-oriented merge detail strings", () => {
    expect(isMachineDetail("mergeStateStatus=BLOCKED; failing checks: Merge Gate")).toBe(true);
    expect(isMachineDetail("gh pr merge failed: policy")).toBe(true);
    expect(isMachineDetail("PR title must use a conventional prefix")).toBe(false);
  });

  it("formatBoardActionError keeps actions separate from machine detail", () => {
    const error: BoardActionError = {
      code: "checks_failed",
      title: "PR title needs a conventional prefix",
      detail: "mergeStateStatus=BLOCKED; failing checks: Merge Gate",
      actions: [
        "Open the PR on GitHub and edit the title to use a conventional prefix (feat:, fix:, chore:, etc.)",
      ],
      retryable: false,
      raw: "gh pr merge failed: Required status check \"Merge Gate\" is failing",
    };
    const formatted = formatBoardActionError(error);
    expect(formatted.title).toBe("PR title needs a conventional prefix");
    expect(formatted.actions).toEqual(error.actions);
    expect(formatted.technicalDetail).toBe(error.raw);
    expect(formatted.actions.some((a) => /mergeStateStatus=/i.test(a))).toBe(false);
  });

  it("does not surface machine detail as a bullet when raw is absent", () => {
    const error: BoardActionError = {
      code: "timeout",
      title: "Timed out waiting for checks",
      detail: "mergeStateStatus=BLOCKED; pending checks: commitlint",
      actions: ["Wait for CI to finish and retry merge"],
      retryable: true,
    };
    const formatted = formatBoardActionError(error);
    expect(formatted.actions).toEqual(error.actions);
    expect(formatted.technicalDetail).toMatch(/pending checks: commitlint/);
  });
});
