import { describe, expect, it } from "vitest";
import type { Story } from "arc-contracts";
import { buildContractRows } from "../src/lib/delegationContract";

function makeStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "W-000025",
    wid: "W-000025",
    type: "story",
    title: "Delegation contract fidelity",
    repo: "",
    branch: "",
    worktree: "",
    column: "queued",
    priority: "med",
    size: "S",
    epic: "view-parity",
    taskClass: "feature",
    tags: [],
    description: "Match the prototype color-coded contract list",
    criteria: [],
    draft: false,
    issue: null,
    plan: null,
    ...overrides,
  };
}

describe("buildContractRows", () => {
  it("returns the five contract rows in prototype order", () => {
    const rows = buildContractRows(makeStory());
    expect(rows.map((r) => r.label)).toEqual([
      "Outcome",
      "Scope",
      "Invariants",
      "Verification",
      "Prohibited",
    ]);
  });

  it("maps each label to its prototype accent color (AC1)", () => {
    const rows = buildContractRows(makeStory());
    const colors = Object.fromEntries(rows.map((r) => [r.slug, r.color]));
    expect(colors).toEqual({
      outcome: "#3ecf8e", // green
      scope: "#7c9cff", // blue
      invariants: "#c084fc", // purple
      verification: "#f5b544", // amber
      prohibited: "#f87171", // red
    });
  });

  it("preserves derived values for populated stories (AC3)", () => {
    const rows = buildContractRows(
      makeStory({
        description: "Ship the drawer",
        repo: "arc-board",
        branch: "feat/x",
        worktree: "wt/x",
        issue: "#62",
        criteria: ["Board renders", "No overflow", "Colors correct", "Extra ignored"],
        plan: { testStrategy: "vitest + visual check" } as Story["plan"],
      }),
    );
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel.Outcome).toBe("Ship the drawer");
    expect(byLabel.Scope).toBe("arc-board · feat/x · wt/x");
    // invariants: GitHub link first, then criteria, capped at 3, joined with " · "
    expect(byLabel.Invariants).toBe("Preserve GitHub link #62 · Board renders · No overflow");
    expect(byLabel.Verification).toBe("vitest + visual check");
  });

  it("falls back to safe defaults when story fields are empty (AC3)", () => {
    const rows = buildContractRows(makeStory({ description: "", title: "Untitled work" }));
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel.Outcome).toBe("Untitled work");
    expect(byLabel.Scope).toBe("Story-scoped repository changes only");
    expect(byLabel.Invariants).toBe("No unrelated queue, board, or daemon behavior regresses.");
    expect(byLabel.Verification).toBe("Verify the accepted behavior before handoff.");
    expect(byLabel.Prohibited).toContain("No unrelated rewrites");
  });
});
