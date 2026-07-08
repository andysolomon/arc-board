import { describe, expect, it } from "vitest";
import type { IntakeDraftProposal, Story } from "arc-contracts";
import {
  criteriaFromScenarios,
  fallbackDraftProposals,
  generateDraftProposals,
  normalizeModelDrafts,
  planSplit,
  planTighten,
  storyProposalFromPart,
  type ModelComplete,
} from "../src/lib/intakePipeline";

const project = { id: "p1", repo: "acme/web", path: "/tmp/acme", branch: "main" } as unknown as Parameters<
  typeof generateDraftProposals
>[0]["project"];

function keysOf(proposal: IntakeDraftProposal): string[] {
  return Object.keys(proposal).sort();
}

function backlogStory(overrides: Partial<Story> = {}): Story {
  return {
    id: "story-1",
    wid: "W-000123",
    type: "story",
    title: "Add saved filters",
    repo: "acme/web",
    branch: "draft/add-saved-filters",
    worktree: "",
    column: "backlog",
    priority: "med",
    size: "L",
    epic: "Search",
    taskClass: "feature",
    tags: ["intake"],
    description: "As a user, I want saved filters so I can return to common views.",
    criteria: ["Saved filters appear in the menu", "Filters persist across reloads"],
    draft: true,
    issue: null,
    ...overrides,
  };
}

describe("intake pipeline — proposal shape parity", () => {
  it("feature: model and fallback proposals produce the same IntakeDraftProposal shape", () => {
    const fallback = fallbackDraftProposals("feature", "Let users sign in with Google");
    const model = normalizeModelDrafts("feature", [
      { title: "Let users sign in with Google", prio: "high", size: "M", acceptance: ["SSO works"] },
    ]);

    for (const proposal of [...fallback, ...model]) {
      expect(proposal.type).toBe("story");
      expect(proposal.include).toBe(true);
      // criteria coverage
      expect(Array.isArray(proposal.criteria)).toBe(true);
      expect(proposal.criteria.length).toBeGreaterThan(0);
      // stories carry neither bug nor slice details
      expect(proposal.bug).toBeUndefined();
      expect(proposal.slice).toBeUndefined();
    }
    expect(keysOf(model[0])).toEqual(keysOf(fallback[0]));
  });

  it("bug: model and fallback proposals both carry full bug details", () => {
    const fallback = fallbackDraftProposals("bug", "Checkout goes blank on submit");
    const model = normalizeModelDrafts("bug", {
      title: "Checkout goes blank on submit",
      severity: "S1",
      area: "app",
      steps: ["Open checkout", "Submit"],
      rootCause: "unhandled null in cart reducer",
      fixOptions: ["Guard the reducer"],
      acceptance: ["Checkout renders after submit"],
    });

    for (const proposal of [...fallback, ...model]) {
      expect(proposal.type).toBe("bug");
      expect(proposal.taskClass).toBe("bugfix");
      // bug details coverage
      expect(proposal.bug).toBeDefined();
      expect(proposal.bug!.severity).toMatch(/^S[1-4]$/);
      expect(typeof proposal.bug!.area).toBe("string");
      expect(Array.isArray(proposal.bug!.steps)).toBe(true);
      expect(proposal.bug!.steps.length).toBeGreaterThan(0);
      expect(typeof proposal.bug!.rootCause).toBe("string");
      expect(Array.isArray(proposal.bug!.fixOptions)).toBe(true);
      // criteria coverage
      expect(proposal.criteria.length).toBeGreaterThan(0);
      expect(proposal.slice).toBeUndefined();
    }
    expect(keysOf(model[0])).toEqual(keysOf(fallback[0]));
    // both paths produce exactly one bug proposal
    expect(fallback).toHaveLength(1);
    expect(model).toHaveLength(1);
  });

  it("prd: model and fallback proposals both carry slice details", () => {
    const fallback = fallbackDraftProposals("prd", "Public API with per-user reporting\nCSV export");
    const model = normalizeModelDrafts("prd", [
      { title: "Public rate-limit tracer bullet", afk: true, blockedBy: null, userStoriesCovered: "story 1" },
      { title: "Reporting read path", afk: false, blockedBy: "slice 1", userStoriesCovered: "story 2" },
    ]);

    for (const proposal of [...fallback, ...model]) {
      expect(proposal.type).toBe("slice");
      // slice details coverage
      expect(proposal.slice).toBeDefined();
      expect(typeof proposal.slice!.afk).toBe("boolean");
      expect("blockedBy" in proposal.slice!).toBe(true);
      expect(typeof proposal.slice!.userStoriesCovered).toBe("string");
      expect(proposal.criteria.length).toBeGreaterThan(0);
      expect(proposal.bug).toBeUndefined();
    }
    expect(keysOf(model[0])).toEqual(keysOf(fallback[0]));
  });

  it("refine split/tighten carry scenarios whose names become the criteria", async () => {
    const story = backlogStory();

    // deterministic (no model) split still yields a child proposal with scenarios
    const split = await planSplit({ modelComplete: null, project: null }, story);
    expect(split.source).toBe("fallback");
    expect(split.child.scenarios).toBeDefined();
    expect(split.child.criteria).toEqual(criteriaFromScenarios(split.child.scenarios!));

    // deterministic tighten converts criteria into Given/When/Then scenarios
    const tighten = await planTighten({ modelComplete: null, project: null }, story);
    expect(tighten.source).toBe("fallback");
    expect(tighten.scenarios.length).toBeGreaterThan(0);
    expect(tighten.scenarios[0].steps.map((s) => s[0])).toEqual(["Given", "When", "Then", "And"]);

    // a model part normalizes into scenarios + matching criteria
    const proposal = storyProposalFromPart(
      story,
      { title: "Child story", scenarios: [{ name: "Saved", given: "g", when: "w", then: "t" }] },
      "Child story"
    );
    expect(proposal.scenarios![0].name).toBe("Saved");
    expect(proposal.criteria).toEqual(["Saved"]);
  });
});

describe("intake pipeline — model vs fallback orchestration", () => {
  it("returns deterministic fallback when no model is attached", async () => {
    const result = await generateDraftProposals({ modelComplete: null, project: null }, {
      kind: "bug",
      text: "Checkout goes blank",
    });
    expect(result.source).toBe("fallback");
    expect(result.exploreNote).toMatch(/fallback/i);
    expect(result.drafts[0]).toMatchObject({ type: "bug", include: true });
    expect("draft" in result.drafts[0]).toBe(false);
  });

  it("uses the injected model, then normalizes to the same proposal shape", async () => {
    const modelComplete: ModelComplete = async (args) =>
      args.system.includes("codex-explore")
        ? JSON.stringify({ note: "scanned app", files: ["src/search.ts"] })
        : JSON.stringify([
            {
              title: "Add smart saved search",
              prio: "high",
              size: "M",
              epic: "Search",
              userStory: "As a user, I want smart saved search.",
              acceptance: ["Saved search appears in the menu"],
              summary: "Users can save and reuse a generated search.",
            },
          ]);

    const result = await generateDraftProposals({ modelComplete, project }, { kind: "feature", text: "saved search" });
    expect(result.source).toBe("model");
    expect(result.exploreNote).toContain("src/search.ts");
    expect(result.drafts[0]).toMatchObject({ title: "Add smart saved search", priority: "high", include: true });

    // model output matches the fallback proposal shape for the same kind
    const fallback = fallbackDraftProposals("feature", "saved search");
    expect(keysOf(result.drafts[0])).toEqual(keysOf(fallback[0]));
  });

  it("falls back to deterministic proposals when the model throws", async () => {
    const modelComplete: ModelComplete = async () => {
      throw new Error("harness offline");
    };
    const result = await generateDraftProposals({ modelComplete, project }, { kind: "feature", text: "saved search" });
    expect(result.source).toBe("fallback");
    expect(result.drafts.length).toBeGreaterThan(0);
  });
});
