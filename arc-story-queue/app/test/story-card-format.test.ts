import { describe, expect, it } from "vitest";
import { formatIssueBadge, formatPrLabel, formatTerminalLine } from "../src/lib/storyCardFormat";

describe("StoryCard formatting", () => {
  it("renders GitHub issues as short numeric pills", () => {
    expect(formatIssueBadge("https://github.com/andysolomon/arc-orchestrator/issues/16")).toBe("⊙ 16");
    expect(formatIssueBadge("#214")).toBe("⊙ 214");
  });

  it("renders pull requests as short PR labels", () => {
    expect(formatPrLabel("https://github.com/andysolomon/arc-board/pull/486")).toBe("PR #486");
    expect(formatPrLabel("PR #482")).toBe("PR #482");
  });

  it("uses prototype terminal prefixes", () => {
    expect(formatTerminalLine({ kind: "cmd", route: "composer-implement", text: "git status" })).toBe("$ git status");
    expect(formatTerminalLine({ kind: "lock", route: "composer-implement", text: "write-lock acquired" })).toBe("⚿ write-lock acquired");
  });
});
