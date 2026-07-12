/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "arc-contracts";
import { BoardStore, routeColor } from "../src/lib/boardStore";
import {
  activityRoute,
  buildModelUsageBars,
  buildObsKpiTiles,
  buildRouteDurationStats,
  buildTokenDonutSegments,
  computeMeanDuration,
  computeP95Duration,
  filterRunsByScope,
  ObservabilityView,
} from "../src/components/ObservabilityView";

const repoId = "acme/observability";

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    storyId: "story-1",
    label: "composer-implement",
    repo: repoId,
    route: "composer-implement",
    backend: "Cursor Agent",
    model: "composer-2.5",
    access: "write",
    tokens: 1000,
    durMs: 1000,
    status: "completed",
    changed: 1,
    outcome: "accepted",
    ...overrides,
  };
}

function obsStoreStub(opts: {
  runs?: RunRecord[];
  liveWorkerCount?: number;
  maxParallel?: number;
} = {}): BoardStore {
  const runs = opts.runs ?? [];
  const state = {
    activeProjectId: null as const,
    projects: [],
    project: null,
    config: {
      autoRun: false,
      maxParallel: opts.maxParallel ?? 3,
      requireOrchestrationPlan: true,
    },
  };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    getRuns: () => runs,
    getConfig: () => state.config,
    liveWorkerCount: () => opts.liveWorkerCount ?? 0,
    getActivityItems: () => [],
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as BoardStore;
}

describe("observability KPI helpers", () => {
  it("computes mean and p95 durations for a known distribution", () => {
    const runs = [
      makeRun({ id: "a", durMs: 100 }),
      makeRun({ id: "b", durMs: 200 }),
      makeRun({ id: "c", durMs: 300 }),
      makeRun({ id: "d", durMs: 400 }),
      makeRun({ id: "e", durMs: 500 }),
    ];
    expect(computeMeanDuration(runs)).toBe(300);
    expect(computeP95Duration(runs)).toBe(500);
  });

  it("uses the nearest-rank p95 when 0.95 * n is an integer", () => {
    const runs = Array.from({ length: 20 }, (_, i) =>
      makeRun({ id: `r${i}`, durMs: (i + 1) * 100 }),
    );
    expect(computeP95Duration(runs)).toBe(1900);
  });

  it("filters runs by 24h scope and keeps missing startedAt only under All", () => {
    const now = 1_700_000_000_000;
    const runs = [
      makeRun({ id: "recent", startedAt: now - 60 * 60 * 1000 }),
      makeRun({ id: "old", startedAt: now - 48 * 60 * 60 * 1000 }),
      makeRun({ id: "legacy", startedAt: undefined }),
    ];
    expect(filterRunsByScope(runs, "all", now).map((run) => run.id)).toEqual([
      "recent",
      "old",
      "legacy",
    ]);
    expect(filterRunsByScope(runs, "24h", now).map((run) => run.id)).toEqual(["recent"]);
  });

  it("builds six KPI tiles with acceptance and duration sub-labels", () => {
    const runs = [
      makeRun({ id: "a", outcome: "accepted", tokens: 1000, durMs: 100 }),
      makeRun({ id: "b", outcome: "accepted", tokens: 2000, durMs: 200 }),
      makeRun({ id: "c", outcome: "rejected", tokens: 3000, durMs: 300 }),
    ];
    const tiles = buildObsKpiTiles(runs, { liveWorkerCount: 2, maxParallel: 4 });
    expect(tiles.map((tile) => tile.label)).toEqual([
      "Runs",
      "Acceptance",
      "Mean run",
      "Tokens",
      "Active sessions",
      "Max parallel",
    ]);
    expect(tiles[0]?.value).toBe("3");
    expect(tiles[1]?.value).toBe("67%");
    expect(tiles[1]?.sub).toBe("2 / 3 rated");
    expect(tiles[2]?.value).toBe("200ms");
    expect(tiles[2]?.sub).toBe("p95 300ms");
    expect(tiles[3]?.value).toBe("6,000");
    expect(tiles[4]?.value).toBe("2");
    expect(tiles[5]?.value).toBe("4");
  });
});

describe("observability analytics helpers", () => {
  it("builds model usage bars sorted by run count with route colors and proportional widths", () => {
    const runs = [
      makeRun({ id: "a", model: "composer-2.5", route: "composer-implement" }),
      makeRun({ id: "b", model: "composer-2.5", route: "composer-implement" }),
      makeRun({ id: "c", model: "composer-2.5", route: "composer-implement" }),
      makeRun({ id: "d", model: "gpt-5.5", route: "codex-implement" }),
      makeRun({ id: "e", model: "opus-4.8", route: "opus-check" }),
      makeRun({ id: "f", model: "opus-4.8", route: "opus-check" }),
    ];
    const bars = buildModelUsageBars(runs);
    expect(bars.map((bar) => bar.model)).toEqual(["composer-2.5", "opus-4.8", "gpt-5.5"]);
    expect(bars[0]?.widthPct).toBe(100);
    expect(bars[1]?.widthPct).toBeCloseTo((2 / 3) * 100, 5);
    expect(bars[2]?.widthPct).toBeCloseTo((1 / 3) * 100, 5);
    expect(bars[0]?.color).toBe(routeColor("composer-implement"));
    expect(bars[1]?.color).toBe(routeColor("opus-check"));
    expect(bars[2]?.color).toBe(routeColor("codex-implement"));
  });

  it("builds token donut segments with fractions that sum to 1", () => {
    const runs = [
      makeRun({ id: "a", route: "composer-implement", tokens: 3000 }),
      makeRun({ id: "b", route: "codex-implement", tokens: 1000 }),
      makeRun({ id: "c", route: "opus-check", tokens: 1000 }),
    ];
    const { segments, totalTokens } = buildTokenDonutSegments(runs);
    expect(totalTokens).toBe(5000);
    expect(segments.map((segment) => segment.route)).toEqual([
      "composer-implement",
      "codex-implement",
      "opus-check",
    ]);
    const sum = segments.reduce((acc, segment) => acc + segment.fraction, 0);
    expect(sum).toBeCloseTo(1, 3);
    expect(segments[0]?.fraction).toBeCloseTo(0.6, 3);
    expect(segments[1]?.fraction).toBeCloseTo(0.2, 3);
    expect(segments[2]?.fraction).toBeCloseTo(0.2, 3);
    for (const segment of segments) {
      expect(Number.isFinite(segment.offset)).toBe(true);
      expect(segment.dash).not.toMatch(/NaN|Infinity/);
    }
  });

  it("returns zero-token donut segments without invalid SVG values", () => {
    const runs = [makeRun({ id: "a", tokens: 0 }), makeRun({ id: "b", tokens: 0 })];
    const { segments, totalTokens } = buildTokenDonutSegments(runs);
    expect(totalTokens).toBe(0);
    expect(segments.every((segment) => segment.fraction === 0)).toBe(true);
    expect(segments.every((segment) => Number.isFinite(segment.offset))).toBe(true);
  });

  it("computes per-route mean and p95 durations for known distributions", () => {
    const runs = [
      makeRun({ id: "a", route: "composer-implement", durMs: 100 }),
      makeRun({ id: "b", route: "composer-implement", durMs: 200 }),
      makeRun({ id: "c", route: "composer-implement", durMs: 300 }),
      makeRun({ id: "d", route: "codex-implement", durMs: 400 }),
      makeRun({ id: "e", route: "codex-implement", durMs: 500 }),
    ];
    const stats = buildRouteDurationStats(runs);
    const composer = stats.find((row) => row.route === "composer-implement");
    const codex = stats.find((row) => row.route === "codex-implement");
    expect(composer?.meanMs).toBe(200);
    expect(composer?.p95Ms).toBe(300);
    expect(codex?.meanMs).toBe(450);
    expect(codex?.p95Ms).toBe(500);
    expect(stats[0]?.route).toBe("codex-implement");
  });
});

describe("ObservabilityView analytics sections", () => {
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

  it("renders model usage bars with route colors and proportional widths", async () => {
    const now = Date.now();
    const store = obsStoreStub({
      runs: [
        makeRun({
          id: "a",
          model: "composer-2.5",
          route: "composer-implement",
          startedAt: now - 60 * 60 * 1000,
        }),
        makeRun({
          id: "b",
          model: "composer-2.5",
          route: "composer-implement",
          startedAt: now - 50 * 60 * 1000,
        }),
        makeRun({
          id: "c",
          model: "gpt-5.5",
          route: "codex-implement",
          startedAt: now - 40 * 60 * 1000,
        }),
      ],
    });

    await act(async () => {
      root.render(<ObservabilityView store={store} />);
    });

    const models = [...container.querySelectorAll("[data-testid='obs-model-usage'] .sq-obs-bar")].map(
      (row) => row.getAttribute("data-testid")?.replace("obs-model-bar-", ""),
    );
    expect(models).toEqual(["composer-2.5", "gpt-5.5"]);

    const topFill = container.querySelector(
      "[data-testid='obs-model-bar-fill-composer-2.5']",
    ) as HTMLElement;
    const secondFill = container.querySelector(
      "[data-testid='obs-model-bar-fill-gpt-5.5']",
    ) as HTMLElement;
    expect(topFill.style.width).toBe("100%");
    expect(secondFill.style.width).toBe("50%");
    expect(topFill.style.background).toBe(routeColor("composer-implement"));
    expect(secondFill.style.background).toBe(routeColor("codex-implement"));
  });

  it("scopes analytics sections to 24h vs All using startedAt", async () => {
    const now = Date.now();
    const store = obsStoreStub({
      runs: [
        makeRun({
          id: "recent",
          model: "composer-2.5",
          route: "composer-implement",
          tokens: 1000,
          startedAt: now - 60 * 60 * 1000,
        }),
        makeRun({
          id: "old",
          model: "gpt-5.5",
          route: "codex-implement",
          tokens: 9000,
          startedAt: now - 48 * 60 * 60 * 1000,
        }),
      ],
    });

    await act(async () => {
      root.render(<ObservabilityView store={store} />);
    });

    expect(container.querySelector("[data-testid='obs-token-total']")?.textContent).toBe("1,000");
    expect(container.querySelectorAll("[data-testid='obs-model-usage'] .sq-obs-bar")).toHaveLength(1);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='obs-scope-all']")?.click();
    });

    expect(container.querySelector("[data-testid='obs-token-total']")?.textContent).toBe("10,000");
    expect(container.querySelectorAll("[data-testid='obs-model-usage'] .sq-obs-bar")).toHaveLength(2);
    expect(
      container.querySelector("[data-testid='obs-dur-values-codex-implement']")?.textContent,
    ).toBeTruthy();
  });
});

describe("ObservabilityView KPI grid", () => {
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

  it("renders six KPI tiles with computed values for seeded runs", async () => {
    const now = Date.now();
    const store = obsStoreStub({
      runs: [
        makeRun({
          id: "r1",
          outcome: "accepted",
          tokens: 1500,
          durMs: 120,
          startedAt: now - 30 * 60 * 1000,
        }),
        makeRun({
          id: "r2",
          outcome: "rejected",
          tokens: 2500,
          durMs: 180,
          startedAt: now - 20 * 60 * 1000,
        }),
      ],
      liveWorkerCount: 1,
      maxParallel: 5,
    });

    await act(async () => {
      root.render(<ObservabilityView store={store} />);
    });

    expect(container.querySelectorAll("[data-testid='obs-kpi-grid'] .sq-tile")).toHaveLength(6);
    expect(container.querySelector("[data-testid='obs-kpi-runs'] .sq-tile__val")?.textContent).toBe("2");
    expect(container.querySelector("[data-testid='obs-kpi-acceptance'] .sq-tile__val")?.textContent).toBe(
      "50%",
    );
    expect(container.querySelector("[data-testid='obs-kpi-acceptance'] .sq-tile__sub")?.textContent).toBe(
      "1 / 2 rated",
    );
    expect(container.querySelector("[data-testid='obs-kpi-mean-run'] .sq-tile__val")?.textContent).toBe(
      "150ms",
    );
    expect(container.querySelector("[data-testid='obs-kpi-mean-run'] .sq-tile__sub")?.textContent).toBe(
      "p95 180ms",
    );
    expect(container.querySelector("[data-testid='obs-kpi-tokens'] .sq-tile__val")?.textContent).toBe(
      "4,000",
    );
    expect(container.querySelector("[data-testid='obs-kpi-active-sessions'] .sq-tile__val")?.textContent).toBe(
      "1",
    );
    expect(container.querySelector("[data-testid='obs-kpi-max-parallel'] .sq-tile__val")?.textContent).toBe(
      "5",
    );
    expect(container.textContent).not.toMatch(/\$\d/);
  });

  it("scopes KPI counts to 24h vs All using startedAt", async () => {
    const now = Date.now();
    const store = obsStoreStub({
      runs: [
        makeRun({ id: "recent", startedAt: now - 60 * 60 * 1000 }),
        makeRun({ id: "old", startedAt: now - 48 * 60 * 60 * 1000 }),
        makeRun({ id: "legacy", startedAt: undefined }),
      ],
    });

    await act(async () => {
      root.render(<ObservabilityView store={store} />);
    });

    expect(container.querySelector("[data-testid='obs-kpi-runs'] .sq-tile__val")?.textContent).toBe("1");

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='obs-scope-all']")?.click();
    });

    expect(container.querySelector("[data-testid='obs-kpi-runs'] .sq-tile__val")?.textContent).toBe("3");
  });

  it("renders the zero-runs empty state without crashing", async () => {
    const store = obsStoreStub({ runs: [] });

    await act(async () => {
      root.render(<ObservabilityView store={store} />);
    });

    const empty = container.querySelector("[data-testid='obs-empty-runs']");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("No runs yet");
    expect(container.querySelectorAll("[data-testid='obs-kpi-grid'] .sq-tile")).toHaveLength(6);
  });
});

describe("ObservabilityView monitor broadcast", () => {
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

  it("lists the latest 20 notifications newest first with route-colored markers", async () => {
    const store = new BoardStore("http://127.0.0.1:9/mcp");

    for (let i = 0; i < 22; i++) {
      store.notify("info", `filler-${i}`, {
        icon: "•",
        subject: "Fable",
        text: `event ${i}`,
        tone: "started",
      });
    }
    store.notify("info", "queued story", {
      icon: "➕",
      subject: "Queue",
      text: "queued W-000001",
      tone: "queued",
    });
    store.notify("info", "planning story", {
      icon: "◌",
      subject: "Planner",
      text: "analyzing W-000002",
      tone: "planning",
    });
    store.notify("info", "started story", {
      icon: "◈",
      subject: "Fable",
      text: "started W-000003",
      tone: "started",
    });

    await act(async () => {
      root.render(<ObservabilityView store={store} />);
    });

    const items = container.querySelectorAll("[data-testid^='monitor-broadcast-item-']");
    expect(items).toHaveLength(20);

    const first = container.querySelector("[data-testid^='monitor-broadcast-item-'] .sq-route__dot") as HTMLElement;
    expect(first.getAttribute("data-route")).toBe("fable");
    expect(first.style.background).toBe(routeColor("fable"));

    const routes = [...container.querySelectorAll(".sq-route__dot")].map((dot) =>
      dot.getAttribute("data-route"),
    );
    expect(routes[0]).toBe("fable");
    expect(routes).toContain("composer-implement");
    expect(routes).toContain("opus-explore");

    const labels = [...items].map((item) => item.querySelector(".sq-runrow__label")?.textContent?.trim());
    expect(labels[0]).toContain("started W-000003");
    expect(labels[1]).toContain("analyzing W-000002");
    expect(labels[2]).toContain("queued W-000001");
    expect(labels[3]).toContain("event 21");
  });

  it("updates live when the store emits a new notification without remounting", async () => {
    const store = new BoardStore("http://127.0.0.1:9/mcp");

    await act(async () => {
      root.render(<ObservabilityView store={store} />);
    });

    expect(container.querySelector("[data-testid='monitor-broadcast-empty']")).not.toBeNull();

    await act(async () => {
      store.notify("info", "Live event arrived", {
        icon: "◈",
        subject: "Fable",
        text: "started W-000099",
        tone: "started",
      });
    });

    expect(container.querySelector("[data-testid='monitor-broadcast-empty']")).toBeNull();
    expect(container.textContent).toContain("started W-000099");
    expect(container.querySelectorAll("[data-testid^='monitor-broadcast-item-']")).toHaveLength(1);
  });

  it("renders an explicit empty state when there are no notifications", async () => {
    const store = new BoardStore("http://127.0.0.1:9/mcp");

    await act(async () => {
      root.render(<ObservabilityView store={store} />);
    });

    const empty = container.querySelector("[data-testid='monitor-broadcast-empty']");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("No broadcast events yet");
    expect(container.querySelectorAll("[data-testid^='monitor-broadcast-item-']")).toHaveLength(0);
  });
});

describe("activityRoute", () => {
  it("maps activity subjects to orchestration routes", () => {
    expect(
      activityRoute({
        id: "1",
        message: "m",
        ts: 0,
        read: false,
        icon: "•",
        subject: "Queue",
        text: "",
        tone: "queued",
      }),
    ).toBe("composer-implement");
    expect(
      activityRoute({
        id: "2",
        message: "m",
        ts: 0,
        read: false,
        icon: "•",
        subject: "Planner",
        text: "",
        tone: "planning",
      }),
    ).toBe("opus-explore");
    expect(
      activityRoute({
        id: "3",
        message: "m",
        ts: 0,
        read: false,
        icon: "•",
        subject: "Fable",
        text: "",
        tone: "started",
      }),
    ).toBe("fable");
  });
});
