import { useEffect, useState } from "react";
import type { RunRecord } from "arc-contracts";
import type { ActivityItem, BoardStore } from "../lib/boardStore";
import { routeColor } from "../lib/boardStore";
import { formatRelativeTime } from "./ActivityView";

const BROADCAST_LIMIT = 20;
export const OBS_24H_MS = 24 * 60 * 60 * 1000;

export type ObsScope = "24h" | "all";

interface ObservabilityViewProps {
  store: BoardStore;
}

interface ModelGroup {
  model: string;
  runs: number;
  accepted: number;
  meanTok: number;
  meanDur: number;
}

export interface ObsKpiTile {
  key: string;
  label: string;
  value: string;
  sub: string;
}

function groupByModel(runs: RunRecord[]): ModelGroup[] {
  const map = new Map<string, { runs: number; accepted: number; tok: number; dur: number }>();
  for (const r of runs) {
    const g = map.get(r.model) ?? { runs: 0, accepted: 0, tok: 0, dur: 0 };
    g.runs += 1;
    if (r.outcome === "accepted") g.accepted += 1;
    g.tok += r.tokens;
    g.dur += r.durMs;
    map.set(r.model, g);
  }
  return [...map.entries()]
    .map(([model, g]) => ({
      model,
      runs: g.runs,
      accepted: g.accepted,
      meanTok: Math.round(g.tok / g.runs),
      meanDur: Math.round(g.dur / g.runs),
    }))
    .sort((a, b) => b.runs - a.runs);
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 100);
}

export function filterRunsByScope(
  runs: RunRecord[],
  scope: ObsScope,
  now = Date.now(),
): RunRecord[] {
  if (scope === "all") return runs;
  const cutoff = now - OBS_24H_MS;
  return runs.filter((r) => r.startedAt !== undefined && r.startedAt >= cutoff);
}

export function computeMeanDuration(runs: RunRecord[]): number {
  if (runs.length === 0) return 0;
  return Math.round(runs.reduce((sum, run) => sum + run.durMs, 0) / runs.length);
}

export function computeP95Duration(runs: RunRecord[]): number {
  if (runs.length === 0) return 0;
  const sorted = runs.map((run) => run.durMs).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx]!;
}

export function formatObsDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function buildObsKpiTiles(
  runs: RunRecord[],
  opts: {
    liveWorkerCount?: number;
    maxParallel?: number;
  } = {},
): ObsKpiTile[] {
  const accepted = runs.filter((run) => run.outcome === "accepted").length;
  const rated = runs.filter((run) => run.outcome !== "unrated");
  const acceptPct = rated.length === 0 ? 0 : pct(accepted, rated.length);
  const totalTokens = runs.reduce((sum, run) => sum + run.tokens, 0);
  const meanDur = computeMeanDuration(runs);
  const p95Dur = computeP95Duration(runs);
  const liveCount = opts.liveWorkerCount;
  const maxParallel = opts.maxParallel;

  return [
    {
      key: "runs",
      label: "Runs",
      value: String(runs.length),
      sub: liveCount !== undefined && liveCount > 0 ? "live · updating" : "delegated",
    },
    {
      key: "acceptance",
      label: "Acceptance",
      value: `${acceptPct}%`,
      sub: `${accepted} / ${rated.length} rated`,
    },
    {
      key: "mean-run",
      label: "Mean run",
      value: runs.length === 0 ? "—" : formatObsDuration(meanDur),
      sub: runs.length === 0 ? "p95 —" : `p95 ${formatObsDuration(p95Dur)}`,
    },
    {
      key: "tokens",
      label: "Tokens",
      value: totalTokens.toLocaleString(),
      sub: "across scoped runs",
    },
    {
      key: "active-sessions",
      label: "Active sessions",
      value: liveCount === undefined ? "—" : String(liveCount),
      sub:
        liveCount === undefined
          ? "—"
          : liveCount === 1
            ? "1 running now"
            : `${liveCount} running now`,
    },
    {
      key: "max-parallel",
      label: "Max parallel",
      value: maxParallel === undefined ? "—" : String(maxParallel),
      sub: maxParallel === undefined ? "—" : `cap ${maxParallel}`,
    },
  ];
}

/** Map activity subjects to orchestration routes for broadcast markers. */
export function activityRoute(item: ActivityItem): string {
  const bySubject: Record<string, string> = {
    Queue: "composer-implement",
    Planner: "opus-explore",
    Fable: "fable",
    You: "fable",
  };
  return bySubject[item.subject] ?? "fable";
}

export function ObservabilityView({ store }: ObservabilityViewProps) {
  const [scope, setScope] = useState<ObsScope>("24h");
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((n) => n + 1)), [store]);

  const state = store.getState();
  const allRuns = store.getRuns();
  const scopedRuns = filterRunsByScope(allRuns, scope);
  const total = allRuns.length;
  const groups = groupByModel(scopedRuns);
  const recent = [...scopedRuns].slice(-12).reverse();
  const broadcast = store.getActivityItems().slice(0, BROADCAST_LIMIT);
  const now = Date.now();
  const liveWorkerCount = store.liveWorkerCount?.();
  const maxParallel = store.getConfig?.()?.maxParallel;
  const kpiTiles = buildObsKpiTiles(scopedRuns, { liveWorkerCount, maxParallel });

  return (
    <div className="sq-view">
      <header className="sq-view__head">
        <div>
          <h1 className="sq-view__title">Observability</h1>
          <p className="sq-view__sub">
            {state.activeProjectId === "all"
              ? `Runs across ${state.projects.length} projects`
              : state.project
                ? `Runs for ${state.project.repo}`
                : "No project attached"}
          </p>
        </div>
        <div className="sq-scope-toggle" role="group" aria-label="KPI time scope">
          <button
            type="button"
            className={`sq-scope-toggle__btn${scope === "24h" ? " sq-scope-toggle__btn--active" : ""}`}
            data-testid="obs-scope-24h"
            aria-pressed={scope === "24h"}
            onClick={() => setScope("24h")}
          >
            24h
          </button>
          <button
            type="button"
            className={`sq-scope-toggle__btn${scope === "all" ? " sq-scope-toggle__btn--active" : ""}`}
            data-testid="obs-scope-all"
            aria-pressed={scope === "all"}
            onClick={() => setScope("all")}
          >
            All
          </button>
        </div>
      </header>

      <div className="sq-tiles sq-tiles--obs" data-testid="obs-kpi-grid">
        {kpiTiles.map((tile) => (
          <div key={tile.key} className="sq-tile" data-testid={`obs-kpi-${tile.key}`}>
            <div className="sq-tile__val sq-mono">{tile.value}</div>
            <div className="sq-tile__label">{tile.label}</div>
            <div className="sq-tile__sub">{tile.sub}</div>
          </div>
        ))}
      </div>

      <section className="sq-block" data-testid="monitor-broadcast">
        <div className="sq-block__label sq-block__label--row">
          Monitor broadcast
          <span className="sq-block__meta">
            <span className="sq-live-label">
              <span className="sq-dot" />
              LIVE
            </span>
          </span>
        </div>
        <div role="feed" aria-label="Monitor broadcast">
          {broadcast.length === 0 ? (
            <div className="sq-empty" data-testid="monitor-broadcast-empty">
              No broadcast events yet. Orchestration activity will stream here as it arrives.
            </div>
          ) : (
            broadcast.map((item) => {
              const route = activityRoute(item);
              return (
                <div key={item.id} className="sq-runrow" data-testid={`monitor-broadcast-item-${item.id}`}>
                  <span
                    className="sq-route__dot"
                    data-route={route}
                    style={{ background: routeColor(route) }}
                  />
                  <span className="sq-runrow__label">
                    <span className="sq-activity__subject">{item.subject}</span>
                    {item.text ? <span> {item.text}</span> : <span> {item.message}</span>}
                  </span>
                  <time
                    className="sq-activity__time"
                    dateTime={new Date(item.ts).toISOString()}
                    title={new Date(item.ts).toLocaleString()}
                  >
                    {formatRelativeTime(item.ts, now)}
                  </time>
                </div>
              );
            })
          )}
        </div>
      </section>

      {total === 0 ? (
        <div className="sq-empty" data-testid="obs-empty-runs">
          No runs yet — complete a story to record traces.
        </div>
      ) : (
        <>
          <section className="sq-block">
            <div className="sq-block__label">By model</div>
            <div className="sq-table">
              <div className="sq-table__head">
                <span>Model</span>
                <span>Runs</span>
                <span>Acceptance</span>
                <span>Mean tok</span>
                <span>Mean dur</span>
              </div>
              {groups.map((g) => (
                <div key={g.model} className="sq-table__row">
                  <span className="sq-mono">{g.model}</span>
                  <span className="sq-mono">{g.runs}</span>
                  <span className="sq-meter">
                    <span className="sq-meter__bar">
                      <span
                        className="sq-meter__fill"
                        style={{ width: `${pct(g.accepted, g.runs)}%` }}
                      />
                    </span>
                    <span className="sq-mono">{pct(g.accepted, g.runs)}%</span>
                  </span>
                  <span className="sq-mono">{g.meanTok.toLocaleString()}</span>
                  <span className="sq-mono">{g.meanDur}ms</span>
                </div>
              ))}
            </div>
          </section>

          <section className="sq-block">
            <div className="sq-block__label">Recent runs</div>
            {recent.map((r) => (
              <div key={r.id} className="sq-runrow">
                <span className="sq-route__dot" style={{ background: routeColor(r.route) }} />
                <span className="sq-runrow__label">{r.label}</span>
                <span className="sq-mono sq-runrow__route">{r.route}</span>
                <span className={`sq-access sq-access--${r.access.replace(/[^a-z]/g, "")}`}>
                  {r.access}
                </span>
                <span className="sq-mono sq-runrow__tok">{r.tokens.toLocaleString()} tok</span>
                <span className="sq-mono sq-runrow__dur">{r.durMs}ms</span>
                <span className={`sq-outcome sq-outcome--${r.outcome}`}>{r.outcome}</span>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
