import { describe, expect, it } from "vitest";
import {
  ARC_ACTION_ERROR_PREFIX,
  boardActionErrorFromMergeFailure,
  sanitizeGhMessage,
  throwMergeError,
} from "../mcp-server/dist/merge-errors.js";

describe("merge-errors", () => {
  it("strips GraphQL request IDs and dedupes repeated lines", () => {
    const raw = [
      "GraphQL: Pull request is not mergeable [ABC123:DEF456]",
      "GraphQL: Pull request is not mergeable [ABC123:DEF456]",
      "Base branch policy prohibits merging this commit",
    ].join("\n");
    expect(sanitizeGhMessage(raw)).toBe(
      "GraphQL: Pull request is not mergeable\nBase branch policy prohibits merging this commit"
    );
  });

  it("classifies branch policy failures", () => {
    const error = boardActionErrorFromMergeFailure(
      "gh pr merge failed: Base branch policy prohibits merging this commit"
    );
    expect(error.code).toBe("branch_policy");
    expect(error.title).toBe("Branch policy blocked merge");
    expect(error.actions.some((action) => /branch protection/i.test(action))).toBe(true);
  });

  it("classifies Merge Gate is expected as checks pending", () => {
    const error = boardActionErrorFromMergeFailure(
      'gh pr merge failed: Required status check "Merge Gate" is expected',
      {
        mergeStateStatus: "BLOCKED",
        failingChecks: [],
        pendingChecks: [],
      }
    );
    expect(error.code).toBe("checks_pending");
    expect(error.title).toBe("Checks still running");
    expect(error.retryable).toBe(true);
    expect(error.actions).toEqual([
      "Wait for CI checks to complete",
      "Open the PR on GitHub to watch check progress",
    ]);
    expect(error.actions.some((action) => /conventional prefix/i.test(action))).toBe(false);
  });

  it("classifies rollup FAILURE as checks_failed but IN_PROGRESS as checks_pending", () => {
    const failed = boardActionErrorFromMergeFailure("PR merge blocked", {
      mergeStateStatus: "BLOCKED",
      failingChecks: ["commitlint"],
      pendingChecks: [],
    });
    expect(failed.code).toBe("checks_failed");
    expect(failed.title).toBe("Required checks failed");

    const queued = boardActionErrorFromMergeFailure("PR merge blocked", {
      mergeStateStatus: "BLOCKED",
      failingChecks: [],
      pendingChecks: ["Merge Gate"],
    });
    expect(queued.code).toBe("checks_pending");
    expect(queued.title).toBe("Checks still running");

    const inProgress = boardActionErrorFromMergeFailure("PR merge blocked", {
      mergeStateStatus: "BLOCKED",
      failingChecks: [],
      pendingChecks: ["Test arc-story-queue"],
    });
    expect(inProgress.code).toBe("checks_pending");
  });

  it("classifies Merge Gate failures with actionable guidance", () => {
    const error = boardActionErrorFromMergeFailure("Required status check \"Merge Gate\" is failing", {
      mergeStateStatus: "BLOCKED",
      failingChecks: ["Merge Gate", "commitlint"],
      pendingChecks: [],
    });
    expect(error.code).toBe("checks_failed");
    expect(error.title).toBe("PR title needs a conventional prefix");
    expect(error.detail).toMatch(/failing checks: Merge Gate, commitlint/);
    expect(error.retryable).toBe(false);
    expect(error.actions).toEqual([
      "Open the PR on GitHub and edit the title to use a conventional prefix (feat:, fix:, chore:, etc.)",
      "Or re-open review with an updated story title",
    ]);
  });

  it("classifies Merge Gate failing plus branch policy from gh stderr", () => {
    const error = boardActionErrorFromMergeFailure(
      [
        "gh pr merge failed: GraphQL: Pull request is not mergeable [A1B2:C3D4]",
        "Base branch policy prohibits merging this commit",
        "Required status check \"Merge Gate\" is failing",
      ].join("\n"),
      {
        mergeStateStatus: "BLOCKED",
        failingChecks: ["Merge Gate"],
        pendingChecks: [],
      }
    );
    expect(error.code).toBe("checks_failed");
    expect(error.title).toBe("PR title needs a conventional prefix");
    expect(error.actions[0]).toMatch(/Open the PR on GitHub/);
  });

  it("classifies timeout while waiting for checks", () => {
    const error = boardActionErrorFromMergeFailure(
      "timed out waiting for required checks (pending: commitlint)",
      {
        mergeStateStatus: "BLOCKED",
        failingChecks: [],
        pendingChecks: ["commitlint"],
      }
    );
    expect(error.code).toBe("timeout");
    expect(error.detail).toMatch(/pending checks: commitlint/);
    expect(error.retryable).toBe(true);
  });

  it("classifies pending checks without failures", () => {
    const error = boardActionErrorFromMergeFailure("PR merge blocked", {
      mergeStateStatus: "BLOCKED",
      failingChecks: [],
      pendingChecks: ["Test arc-story-queue", "commitlint"],
    });
    expect(error.code).toBe("checks_pending");
    expect(error.title).toBe("Checks still running");
    expect(error.detail).toMatch(/pending checks: Test arc-story-queue, commitlint/);
  });

  it("classifies graphql sync failures with human copy", () => {
    const error = boardActionErrorFromMergeFailure("GraphQL: Could not update pull request branch");
    expect(error.code).toBe("graphql");
    expect(error.title).toBe("Couldn't sync the PR branch");
    expect(error.actions).toEqual(["Open the PR on GitHub", "Try merge again"]);
  });

  it("classifies behind-base failures", () => {
    const error = boardActionErrorFromMergeFailure("gh pr merge failed: Head branch is not up to date");
    expect(error.code).toBe("behind_base");
  });

  it("throws structured ARC_ACTION_ERROR payloads", () => {
    expect(() =>
      throwMergeError({
        code: "unknown",
        title: "Merge failed",
        detail: "boom",
        actions: ["Retry merge"],
      })
    ).toThrow(/^ARC_ACTION_ERROR:/);

    try {
      throwMergeError({
        code: "unknown",
        title: "Merge failed",
        detail: "boom",
        actions: ["Retry merge"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message.startsWith(ARC_ACTION_ERROR_PREFIX)).toBe(true);
      const parsed = JSON.parse(message.slice(ARC_ACTION_ERROR_PREFIX.length)) as { code: string };
      expect(parsed.code).toBe("unknown");
    }
  });

  it("round-trips review_pending and max_rounds_exceeded codes", () => {
    for (const code of ["review_pending", "max_rounds_exceeded"] as const) {
      try {
        throwMergeError({
          code,
          title: code,
          detail: "detail",
          actions: ["action"],
          retryable: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const parsed = JSON.parse(message.slice(ARC_ACTION_ERROR_PREFIX.length)) as { code: string };
        expect(parsed.code).toBe(code);
      }
    }
  });
});
