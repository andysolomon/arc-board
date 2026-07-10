import { describe, expect, it } from "vitest";
import type { Story } from "arc-contracts";
import { conventionalTitle, conventionalTypeForStory } from "../mcp-server/conventional-title.js";

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: "s1",
    wid: "W-000001",
    type: "story",
    title: "Add widget",
    repo: "test/repo",
    branch: "feat/widget",
    worktree: "/wt",
    column: "in_progress",
    priority: "med",
    size: "S",
    epic: "",
    taskClass: "feature",
    tags: [],
    description: "",
    criteria: [],
    draft: false,
    ...overrides,
  };
}

describe("conventionalTitle", () => {
  it("prefixes bug stories with fix:", () => {
    expect(
      conventionalTitle(
        story({
          type: "bug",
          title: "[W-000036] BUG: Release workflow blocked",
        })
      )
    ).toBe("fix: [W-000036] BUG: Release workflow blocked");
  });

  it("prefixes monitor/smoke stories with chore:", () => {
    expect(
      conventionalTitle(
        story({
          title: "[monitor] Dummy orchestrator pipeline smoke",
          tags: ["monitor", "smoke"],
        })
      )
    ).toBe("chore: [monitor] Dummy orchestrator pipeline smoke");
  });

  it("leaves titles that already have a conventional prefix unchanged", () => {
    expect(conventionalTitle(story({ title: "fix: already formatted" }))).toBe("fix: already formatted");
  });

  it("maps taskClass to conventional types", () => {
    expect(conventionalTypeForStory(story({ taskClass: "refactor" }))).toBe("refactor");
    expect(conventionalTypeForStory(story({ taskClass: "docs" }))).toBe("docs");
    expect(conventionalTypeForStory(story({ taskClass: "feature" }))).toBe("feat");
  });
});
