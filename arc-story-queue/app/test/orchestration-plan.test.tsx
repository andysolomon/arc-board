import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrchestrationPlan, Story } from "arc-contracts";
import type { BoardStore, BoardStory } from "../src/lib/boardStore";
import { formatPlannedAt, planBadge, planDetailRows, planStatus } from "../src/lib/orchestrationPlan";
import { OrchestrationPlanSection } from "../src/components/OrchestrationPlanSection";
import { StoryCard } from "../src/components/StoryCard";

function story(orchestration?: OrchestrationPlan | null): Story {
  return {
    id: "story-1",
    wid: "W-000045",
    type: "story",
    title: "Board UI: orchestration status",
    repo: "acme/api",
    branch: "feat/W-000045-plan-status-ui",
    worktree: "../wt/w-000045",
    column: "queued",
    priority: "high",
    size: "M",
    epic: "board",
    taskClass: "feature",
    tags: [],
    description: "Show plan state on queued cards",
    criteria: [],
    draft: false,
    issue: "#104",
    ...(orchestration !== undefined ? { orchestration } : {}),
  };
}

function boardStory(orchestration?: OrchestrationPlan | null): BoardStory {
  return { ...story(orchestration), lines: [], lanes: {} };
}

const PLANNED: OrchestrationPlan = {
  status: "planned",
  route: "composer-implement",
  backend: "Cursor Agent",
  mode: "worktree",
  rationale: "Clear-spec UI slice; default bulk implementation route.",
  complexity: "medium",
  plannedAt: "2026-07-09T14:30:00.000Z",
  storyDigest: "abc123",
};

const storeStub = { replanStory: async () => story(PLANNED) } as unknown as BoardStore;

describe("orchestration plan badge mapping", () => {
  it("maps every plan state to its board badge", () => {
    expect(planBadge(story({ status: "unplanned" }))).toEqual({ label: "Unplanned", slug: "unplanned" });
    expect(planBadge(story({ status: "planning" }))).toEqual({ label: "Planning…", slug: "planning" });
    expect(planBadge(story(PLANNED))).toEqual({ label: "Ready", slug: "planned" });
    expect(planBadge(story({ status: "failed", error: "boom" }))).toEqual({ label: "Plan failed", slug: "failed" });
  });

  it("treats stories persisted before orchestration shipped as unplanned", () => {
    expect(planStatus(story())).toBe("unplanned");
    expect(planStatus(story(null))).toBe("unplanned");
    expect(planBadge(story(null)).label).toBe("Unplanned");
  });

  it("renders the badge on a queued card and reflects a fresher story state", () => {
    const planning = renderToStaticMarkup(<StoryCard story={boardStory({ status: "planning" })} queueIndex={0} />);
    expect(planning).toContain("story-card__plan--planning");
    expect(planning).toContain("Planning…");

    // Live story events replace the story in the store; a re-render shows the new state.
    const planned = renderToStaticMarkup(<StoryCard story={boardStory(PLANNED)} queueIndex={0} />);
    expect(planned).toContain("story-card__plan--planned");
    expect(planned).toContain("Ready");
  });

  it("does not show a plan badge outside the Queued column", () => {
    const backlog = renderToStaticMarkup(
      <StoryCard story={{ ...boardStory(PLANNED), column: "backlog" }} />
    );
    expect(backlog).not.toContain("story-card__plan");
  });
});

describe("orchestration plan detail rows", () => {
  it("solidifies route, model, mode, complexity, rationale, and planned-at", () => {
    const rows = planDetailRows(story(PLANNED));
    const bySlug = Object.fromEntries(rows.map((row) => [row.slug, row.value]));
    expect(bySlug["route"]).toBe("composer-implement");
    expect(bySlug["model"]).toBe("composer-2.5 · Cursor Agent");
    expect(bySlug["mode"]).toBe("worktree");
    expect(bySlug["complexity"]).toBe("medium");
    expect(bySlug["rationale"]).toContain("Clear-spec UI slice");
    expect(bySlug["planned-at"]).toContain("2026");
  });

  it("returns no rows until a plan is solidified", () => {
    expect(planDetailRows(story({ status: "planning" }))).toEqual([]);
    expect(planDetailRows(story())).toEqual([]);
  });

  it("falls back to the raw string for an unparseable planned-at", () => {
    expect(formatPlannedAt("not-a-date")).toBe("not-a-date");
  });
});

describe("OrchestrationPlanSection", () => {
  it("shows the solidified plan and a Replan action for a planned story", () => {
    const out = renderToStaticMarkup(
      <OrchestrationPlanSection store={storeStub} story={story(PLANNED)} />
    );
    expect(out).toContain("Orchestration plan");
    expect(out).toContain("composer-implement");
    expect(out).toContain("composer-2.5 · Cursor Agent");
    expect(out).toContain("worktree");
    expect(out).toContain("medium");
    expect(out).toContain("Clear-spec UI slice");
    expect(out).toContain("2026");
    expect(out).toContain(">Replan<");
  });

  it("shows the failure detail and a Retry planning action for a failed plan", () => {
    const out = renderToStaticMarkup(
      <OrchestrationPlanSection
        store={storeStub}
        story={story({ status: "failed", error: "Analysis timed out after 120s" })}
      />
    );
    expect(out).toContain("sq-orch-error");
    expect(out).toContain("Analysis timed out after 120s");
    expect(out).toContain("Retry planning");
    expect(out).not.toContain(">Replan<");
  });

  it("shows live progress while planning and a waiting note when unplanned", () => {
    const planning = renderToStaticMarkup(
      <OrchestrationPlanSection store={storeStub} story={story({ status: "planning" })} />
    );
    expect(planning).toContain("Analyzing route, model, and mode…");

    const unplanned = renderToStaticMarkup(
      <OrchestrationPlanSection store={storeStub} story={story({ status: "unplanned" })} />
    );
    expect(unplanned).toContain("Awaiting orchestration analysis");
  });
});
