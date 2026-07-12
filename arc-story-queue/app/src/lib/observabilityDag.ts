import { ROUTE_ORDER, type RouteId, type RunRecord } from "arc-contracts";
import { routeColor, routeLabel } from "./boardStore";
import type { BoardStory } from "./boardState";

export type ObsPhase = "plan" | "understand" | "build" | "verify" | "decide";

export const OBS_PHASES: ObsPhase[] = ["plan", "understand", "build", "verify", "decide"];

export const OBS_PHASE_LABELS: Record<ObsPhase, string> = {
  plan: "PLAN",
  understand: "UNDERSTAND",
  build: "BUILD",
  verify: "VERIFY",
  decide: "DECIDE",
};

export const OBS_DAG_NODE_W = 168;
export const OBS_DAG_NODE_H = 66;
export const OBS_DAG_CANVAS_W = 1200;
export const OBS_DAG_ROW_GAP = 88;

const PHASE_X: Record<ObsPhase, number> = {
  plan: 6,
  understand: 211,
  build: 416,
  verify: 621,
  decide: 1031,
};

const PHASE_CENTER_X: Record<ObsPhase, number> = {
  plan: 90,
  understand: 295,
  build: 500,
  verify: 807,
  decide: 1115,
};

function formatRunDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export interface ObsDagNodeLayout {
  run: RunRecord;
  phase: ObsPhase;
  x: number;
  y: number;
  cx: number;
  cy: number;
  color: string;
  short: string;
  durLabel: string;
  tokLabel: string;
  live: boolean;
}

export interface ObsDagEdgeLayout {
  id: string;
  d: string;
  color: string;
  markerId: string;
  live: boolean;
  queued: boolean;
}

export interface ObsDagLayout {
  nodes: ObsDagNodeLayout[];
  edges: ObsDagEdgeLayout[];
  width: number;
  height: number;
  markers: Array<{ id: string; color: string }>;
}

function routeLaneIndex(route: string): number {
  const idx = ROUTE_ORDER.indexOf(route as RouteId);
  return idx === -1 ? ROUTE_ORDER.length : idx;
}

/** Order runs by startedAt when present, else canonical route-lane order. */
export function sortStoryRuns(runs: RunRecord[]): RunRecord[] {
  return [...runs].sort((a, b) => {
    const aStart = a.startedAt;
    const bStart = b.startedAt;
    if (aStart != null && bStart != null) return aStart - bStart;
    if (aStart != null) return -1;
    if (bStart != null) return 1;
    const lane = routeLaneIndex(a.route) - routeLaneIndex(b.route);
    if (lane !== 0) return lane;
    return a.id.localeCompare(b.id);
  });
}

function resolveFablePhases(runs: RunRecord[]): Map<string, ObsPhase> {
  const fableRuns = runs.filter((run) => run.route === "fable");
  const phases = new Map<string, ObsPhase>();
  if (fableRuns.length === 0) return phases;
  if (fableRuns.length === 1) {
    phases.set(fableRuns[0]!.id, "plan");
    return phases;
  }
  phases.set(fableRuns[0]!.id, "plan");
  phases.set(fableRuns[fableRuns.length - 1]!.id, "decide");
  for (let i = 1; i < fableRuns.length - 1; i += 1) {
    phases.set(fableRuns[i]!.id, "decide");
  }
  return phases;
}

export function runPhase(run: RunRecord, fablePhases: Map<string, ObsPhase>): ObsPhase {
  const fablePhase = fablePhases.get(run.id);
  if (fablePhase) return fablePhase;
  if (run.route.endsWith("-explore")) return "understand";
  if (run.route.endsWith("-implement")) return "build";
  if (run.route.endsWith("-check")) return "verify";
  if (run.route === "fable") return "plan";
  return "understand";
}

function latestRunTimestamp(runs: RunRecord[]): number {
  let best = 0;
  for (const run of runs) {
    const ts = run.finishedAt ?? run.startedAt ?? 0;
    if (ts > best) best = ts;
  }
  return best;
}

/** Pick the in-progress story, else the story with the most recently finished run. */
export function selectObsStory(
  stories: Record<string, BoardStory>,
  runs: RunRecord[],
): BoardStory | null {
  if (runs.length === 0) return null;

  const runsByStory = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const group = runsByStory.get(run.storyId) ?? [];
    group.push(run);
    runsByStory.set(run.storyId, group);
  }

  const inProgress = Object.values(stories).filter(
    (story) => story.column === "in_progress" && runsByStory.has(story.id),
  );
  if (inProgress.length === 1) return inProgress[0]!;
  if (inProgress.length > 1) {
    return inProgress.reduce((best, story) => {
      const bestTs = latestRunTimestamp(runsByStory.get(best.id) ?? []);
      const storyTs = latestRunTimestamp(runsByStory.get(story.id) ?? []);
      return storyTs > bestTs ? story : best;
    });
  }

  let selected: BoardStory | null = null;
  let bestTs = -1;
  for (const [storyId, storyRuns] of runsByStory) {
    const story = stories[storyId];
    if (!story) continue;
    const ts = latestRunTimestamp(storyRuns);
    if (ts > bestTs) {
      bestTs = ts;
      selected = story;
    }
  }
  return selected;
}

export function isRunLive(run: RunRecord, story: BoardStory | null | undefined): boolean {
  if (run.finishedAt != null) return false;
  return story?.column === "in_progress";
}

function mkEdgePath(
  from: ObsDagNodeLayout,
  to: ObsDagNodeLayout,
): { d: string; color: string } {
  const x1 = from.x + OBS_DAG_NODE_W;
  const y1 = from.cy;
  const x2 = to.x;
  const y2 = to.cy;
  const dx = Math.max(48, (x2 - x1) * 0.42);
  return {
    d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
    color: to.color,
  };
}

export function buildObsDagLayout(
  runs: RunRecord[],
  story: BoardStory | null | undefined,
): ObsDagLayout {
  const ordered = sortStoryRuns(runs);
  const fablePhases = resolveFablePhases(ordered);
  const phaseCounts = new Map<ObsPhase, number>();

  const nodes: ObsDagNodeLayout[] = ordered.map((run) => {
    const phase = runPhase(run, fablePhases);
    const stack = phaseCounts.get(phase) ?? 0;
    phaseCounts.set(phase, stack + 1);
    const x = PHASE_X[phase];
    const y = 40 + stack * OBS_DAG_ROW_GAP;
    const cy = y + OBS_DAG_NODE_H / 2;
    return {
      run,
      phase,
      x,
      y,
      cx: x + OBS_DAG_NODE_W / 2,
      cy,
      color: routeColor(run.route),
      short: routeLabel(run.route),
      durLabel: formatRunDuration(run.durMs),
      tokLabel: `${run.tokens.toLocaleString()} tok`,
      live: isRunLive(run, story),
    };
  });

  const edges: ObsDagEdgeLayout[] = [];
  const markers: Array<{ id: string; color: string }> = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const from = nodes[i]!;
    const to = nodes[i + 1]!;
    const { d, color } = mkEdgePath(from, to);
    const markerId = `sq-obs-dag-arrow-${i}`;
    markers.push({ id: markerId, color });
    edges.push({
      id: `edge-${from.run.id}-${to.run.id}`,
      d,
      color,
      markerId,
      live: to.live,
      queued: to.phase === "decide" && !to.live,
    });
  }

  const maxStacks = Math.max(1, ...[...phaseCounts.values()]);
  const height = Math.max(330, 40 + maxStacks * OBS_DAG_ROW_GAP + OBS_DAG_NODE_H + 24);

  return {
    nodes,
    edges,
    width: OBS_DAG_CANVAS_W,
    height,
    markers,
  };
}

export function obsStoryHeader(story: BoardStory | null, fallbackStoryId?: string): string {
  if (story) return `${story.wid} · ${story.title}`;
  if (fallbackStoryId) return fallbackStoryId;
  return "Delegation flow";
}

export function phaseHeaderCenters(): Array<{ phase: ObsPhase; x: number; label: string }> {
  return OBS_PHASES.map((phase) => ({
    phase,
    x: PHASE_CENTER_X[phase],
    label: OBS_PHASE_LABELS[phase],
  }));
}
