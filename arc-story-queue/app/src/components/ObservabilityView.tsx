import { useEffect, useState } from "react";
import type { RunRecord } from "arc-contracts";
import type { ActivityItem, BoardStore } from "../lib/boardStore";
import { routeColor, routeLabel } from "../lib/boardStore";
import {
  buildObsDagLayout,
  obsStoryHeader,
  phaseHeaderCenters,
  selectObsStory,
} from "../lib/observabilityDag";
import { formatRelativeTime } from "./ActivityView";

const BROADCAST_LIMIT = 20;
export const OBS_24H_MS = 24 * 60 * 60 * 1000;

export type ObsScope = "24h" | "all";

interface ObservabilityViewProps {
  store: BoardStore;
}

export const OBS_DONUT_RADIUS = 52;
export const OBS_DONUT_CIRCUMFERENCE = 2 * Math.PI * OBS_DONUT_RADIUS;

export interface ModelUsageBar {
  model: string;
  runs: number;
  color: string;
  widthPct: number;
}

export interface TokenDonutSegment {
  route: string;
  short: string;
  color: string;
  tokens: number;
  label: string;
  dash: string;
  offset: number;
  fraction: number;
}

export interface RouteDurationStat {
  route: string;
  short: string;
  color: string;
  meanMs: number;
  p95Ms: number;
  meanLabel: string;
  p95Label: string;
  meanPct: number;
  p95Pct: number;
}

export interface ObsKpiTile {
  key: string;
  label: string;
  value: string;
  sub: string;
}

function predominantRoute(runs: RunRecord[]): string {
  if (runs.length === 0) return "fable";
  const counts = new Map<string, number>();
  for (const run of runs) {
    counts.set(run.route, (counts.get(run.route) ?? 0) + 1);
  }
  let bestRoute: string = runs[0]!.route;
  let bestCount = 0;
  for (const [route, count] of counts) {
    if (count > bestCount) {
      bestRoute = route;
      bestCount = count;
    }
  }
  return bestRoute;
}

export function buildModelUsageBars(runs: RunRecord[]): ModelUsageBar[] {
  const byModel = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const group = byModel.get(run.model) ?? [];
    group.push(run);
    byModel.set(run.model, group);
  }
  const rows = [...byModel.entries()].map(([model, modelRuns]) => ({
    model,
    runs: modelRuns.length,
    color: routeColor(predominantRoute(modelRuns)),
  }));
  rows.sort((a, b) => b.runs - a.runs);
  const maxRuns = Math.max(1, ...rows.map((row) => row.runs));
  return rows.map((row) => ({
    ...row,
    widthPct: (row.runs / maxRuns) * 100,
  }));
}

export function buildTokenDonutSegments(runs: RunRecord[]): {
  segments: TokenDonutSegment[];
  totalTokens: number;
} {
  const byRoute = new Map<string, number>();
  for (const run of runs) {
    byRoute.set(run.route, (byRoute.get(run.route) ?? 0) + run.tokens);
  }
  const entries = [...byRoute.entries()]
    .map(([route, tokens]) => ({ route, tokens }))
    .sort((a, b) => b.tokens - a.tokens);
  const totalTokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  let accumulated = 0;
  const segments = entries.map(({ route, tokens }) => {
    const fraction = totalTokens > 0 ? tokens / totalTokens : 0;
    const arc = fraction * OBS_DONUT_CIRCUMFERENCE;
    const segment = {
      route,
      short: routeLabel(route),
      color: routeColor(route),
      tokens,
      label: tokens.toLocaleString(),
      dash: `${arc} ${OBS_DONUT_CIRCUMFERENCE - arc}`,
      offset: -accumulated,
      fraction,
    };
    accumulated += arc;
    return segment;
  });
  return { segments, totalTokens };
}

export function buildRouteDurationStats(runs: RunRecord[]): RouteDurationStat[] {
  const byRoute = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const group = byRoute.get(run.route) ?? [];
    group.push(run);
    byRoute.set(run.route, group);
  }
  const maxDur = Math.max(1, ...runs.map((run) => run.durMs));
  return [...byRoute.entries()]
    .map(([route, routeRuns]) => {
      const meanMs = computeMeanDuration(routeRuns);
      const p95Ms = computeP95Duration(routeRuns);
      return {
        route,
        short: routeLabel(route),
        color: routeColor(route),
        meanMs,
        p95Ms,
        meanLabel: formatObsDuration(meanMs),
        p95Label: formatObsDuration(p95Ms),
        meanPct: (meanMs / maxDur) * 100,
        p95Pct: (p95Ms / maxDur) * 100,
      };
    })
    .sort((a, b) => b.meanMs - a.meanMs);
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
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
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

function accessClass(access: string): string {
  const slug = access.replace(/[^a-z]/g, "");
  if (slug === "write") return "sq-access--write";
  if (slug === "parent") return "sq-access--parent";
  return "sq-access--readonly";
}

function DelegationDagSection({
  store,
  allRuns,
}: {
  store: BoardStore;
  allRuns: RunRecord[];
}) {
  const state = store.getState();
  const selectedStory = selectObsStory(state.stories, allRuns);
  const storyRuns = selectedStory
    ? allRuns.filter((run) => run.storyId === selectedStory.id)
    : [];
  const dag = storyRuns.length > 0 ? buildObsDagLayout(storyRuns, selectedStory) : null;
  const headers = phaseHeaderCenters();

  return (
    <section className="sq-block sq-obs-dag" data-testid="obs-delegation-dag">
      <div className="sq-obs-dag__head">
        <div className="sq-block__label sq-obs-dag__title" data-testid="obs-dag-story-header">
          {obsStoryHeader(selectedStory, storyRuns[0]?.storyId)}
        </div>
        <div className="sq-obs-dag__legend" data-testid="obs-dag-legend">
          <span className="sq-obs-dag__legend-item sq-obs-dag__legend-item--handoff">
            handoff
          </span>
          <span className="sq-obs-dag__legend-item sq-obs-dag__legend-item--readonly">
            read-only
          </span>
          <span className="sq-obs-dag__legend-item sq-obs-dag__legend-item--write">write</span>
          <span className="sq-obs-dag__legend-item sq-obs-dag__legend-item--parent">parent</span>
        </div>
      </div>

      {!dag ? (
        <div className="sq-empty" data-testid="obs-dag-empty">
          No delegation runs yet — complete a story to trace agent handoffs here.
        </div>
      ) : (
        <div className="sq-obs-dag__scroll sq-scroll" data-testid="obs-dag-scroll">
          <div
            className="sq-obs-dag__canvas"
            data-testid="obs-dag-canvas"
            style={{ width: dag.width }}
          >
            <div className="sq-obs-dag__phases" aria-hidden>
              {headers.map((header) => (
                <span
                  key={header.phase}
                  className="sq-obs-dag__phase"
                  style={{ left: header.x }}
                >
                  {header.label}
                </span>
              ))}
            </div>
            <div
              className="sq-obs-dag__graph"
              style={{ width: dag.width, height: dag.height }}
            >
              <svg
                className="sq-obs-dag__edges"
                viewBox={`0 0 ${dag.width} ${dag.height}`}
                aria-hidden
                data-testid="obs-dag-edges"
              >
                <defs>
                  {dag.markers.map((marker) => (
                    <marker
                      key={marker.id}
                      id={marker.id}
                      markerWidth="9"
                      markerHeight="9"
                      refX="8"
                      refY="4.5"
                      orient="auto"
                    >
                      <path d="M0,0 L9,4.5 L0,9 Z" fill={marker.color} />
                    </marker>
                  ))}
                </defs>
                {dag.edges.map((edge) => (
                  <path
                    key={edge.id}
                    d={edge.d}
                    fill="none"
                    stroke={edge.color}
                    strokeWidth={edge.live ? 2.6 : 2}
                    strokeOpacity={edge.live ? 0.95 : edge.queued ? 0.5 : 0.62}
                    strokeDasharray={edge.live ? "6 6" : edge.queued ? "2 6" : "6 6"}
                    markerEnd={`url(#${edge.markerId})`}
                    className={
                      edge.live ? "sq-obs-dag__edge sq-obs-dag__edge--live" : "sq-obs-dag__edge"
                    }
                    data-testid={`obs-dag-edge-${edge.id}`}
                  />
                ))}
              </svg>
              {dag.nodes.map((node) => (
                <div
                  key={node.run.id}
                  className={`sq-obs-dag__node${node.live ? " sq-obs-dag__node--live" : ""}`}
                  data-testid={`obs-dag-node-${node.run.id}`}
                  style={{
                    left: node.x,
                    top: node.y,
                    width: 168,
                    height: 66,
                    borderColor: node.color,
                  }}
                  title={`${node.run.label} · ${node.short}`}
                >
                  <span
                    className="sq-obs-dag__node-bar"
                    style={{ background: node.color }}
                    aria-hidden
                  />
                  <div className="sq-obs-dag__node-body">
                    <div className="sq-obs-dag__node-head">
                      <span className="sq-obs-dag__node-label">{node.run.label}</span>
                      <span className={`sq-access ${accessClass(node.run.access)}`}>
                        {node.run.access}
                      </span>
                    </div>
                    <span className="sq-mono sq-obs-dag__node-route">{node.short}</span>
                    <div className="sq-obs-dag__node-meta">
                      <span className="sq-mono sq-obs-dag__node-model">{node.run.model}</span>
                      <span className="sq-mono sq-obs-dag__node-dur">{node.durLabel}</span>
                      <span className="sq-mono sq-obs-dag__node-tok">{node.tokLabel}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function ObservabilityView({ store }: ObservabilityViewProps) {
  const [scope, setScope] = useState<ObsScope>("24h");
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((n) => n + 1)), [store]);

  const state = store.getState();
  const allRuns = store.getRuns();
  const scopedRuns = filterRunsByScope(allRuns, scope);
  const total = allRuns.length;
  const modelUsage = buildModelUsageBars(scopedRuns);
  const tokenDonut = buildTokenDonutSegments(scopedRuns);
  const routeDurations = buildRouteDurationStats(scopedRuns);
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

      <DelegationDagSection store={store} allRuns={allRuns} />

      {total === 0 ? (
        <div className="sq-empty" data-testid="obs-empty-runs">
          No runs yet — complete a story to record traces.
        </div>
      ) : (
        <>
          <div className="sq-obs-grid">
            <section className="sq-block sq-obs-panel" data-testid="obs-model-usage">
              <div className="sq-block__label">Model usage · runs</div>
              {modelUsage.length === 0 ? (
                <div className="sq-empty sq-obs-empty">No runs in this scope.</div>
              ) : (
                <div className="sq-obs-bars">
                  {modelUsage.map((bar) => (
                    <div key={bar.model} className="sq-obs-bar" data-testid={`obs-model-bar-${bar.model}`}>
                      <div className="sq-obs-bar__head">
                        <span className="sq-mono sq-obs-bar__model">{bar.model}</span>
                        <span className="sq-mono sq-obs-bar__count">{bar.runs}</span>
                      </div>
                      <div className="sq-obs-bar__track">
                        <span
                          className="sq-obs-bar__fill"
                          data-testid={`obs-model-bar-fill-${bar.model}`}
                          style={{ width: `${bar.widthPct}%`, background: bar.color }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="sq-block sq-obs-panel" data-testid="obs-token-donut">
              <div className="sq-block__label">Token spend</div>
              <div className="sq-obs-donut">
                <svg
                  className="sq-obs-donut__chart"
                  viewBox="0 0 128 128"
                  aria-label="Token spend by route"
                  data-testid="obs-token-donut-svg"
                >
                  <circle
                    cx="64"
                    cy="64"
                    r={OBS_DONUT_RADIUS}
                    fill="none"
                    stroke="rgba(255,255,255,0.06)"
                    strokeWidth="16"
                  />
                  <g transform="rotate(-90 64 64)">
                    {tokenDonut.segments.map((segment) => (
                      <circle
                        key={segment.route}
                        cx="64"
                        cy="64"
                        r={OBS_DONUT_RADIUS}
                        fill="none"
                        stroke={segment.color}
                        strokeWidth="16"
                        strokeDasharray={segment.dash}
                        strokeDashoffset={segment.offset}
                        data-testid={`obs-token-seg-${segment.route}`}
                        data-fraction={segment.fraction}
                      />
                    ))}
                  </g>
                  <text
                    x="64"
                    y="60"
                    textAnchor="middle"
                    className="sq-obs-donut__total"
                    data-testid="obs-token-total"
                  >
                    {tokenDonut.totalTokens.toLocaleString()}
                  </text>
                  <text x="64" y="78" textAnchor="middle" className="sq-obs-donut__caption">
                    TOKENS
                  </text>
                </svg>
                <div className="sq-obs-donut__legend">
                  {tokenDonut.segments.map((segment) => (
                    <div key={segment.route} className="sq-obs-donut__legend-row">
                      <span className="sq-obs-donut__swatch" style={{ background: segment.color }} />
                      <span className="sq-obs-donut__route">{segment.short}</span>
                      <span className="sq-mono sq-obs-donut__value">{segment.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>

          <section className="sq-block sq-obs-panel" data-testid="obs-dur-routes">
            <div className="sq-block__label sq-block__label--row">
              Duration by route
              <span className="sq-obs-dur__legend">
                <span className="sq-obs-dur__legend-mean">mean</span>
                <span className="sq-obs-dur__legend-p95">p95</span>
              </span>
            </div>
            {routeDurations.length === 0 ? (
              <div className="sq-empty sq-obs-empty">No runs in this scope.</div>
            ) : (
              <div className="sq-obs-dur">
                {routeDurations.map((route) => (
                  <div key={route.route} className="sq-obs-dur__row" data-testid={`obs-dur-route-${route.route}`}>
                    <div className="sq-obs-dur__head">
                      <span className="sq-obs-dur__label">
                        <span className="sq-obs-dur__swatch" style={{ background: route.color }} />
                        {route.short}
                      </span>
                      <span
                        className="sq-mono sq-obs-dur__values"
                        data-testid={`obs-dur-values-${route.route}`}
                      >
                        {route.meanLabel} · {route.p95Label}
                      </span>
                    </div>
                    <div className="sq-obs-dur__track">
                      <span
                        className="sq-obs-dur__mean"
                        style={{ width: `${route.meanPct}%`, background: route.color }}
                      />
                      <span
                        className="sq-obs-dur__p95"
                        style={{ left: `${route.p95Pct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
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
