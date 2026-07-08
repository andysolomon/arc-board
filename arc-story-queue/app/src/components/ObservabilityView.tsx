import type { RunRecord } from "arc-contracts";
import type { BoardStore } from "../lib/boardStore";
import { routeColor } from "../lib/boardStore";

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

export function ObservabilityView({ store }: ObservabilityViewProps) {
  const state = store.getState();
  const runs = store.getRuns();
  const total = runs.length;
  const accepted = runs.filter((r) => r.outcome === "accepted").length;
  const totalTokens = runs.reduce((s, r) => s + r.tokens, 0);
  const groups = groupByModel(runs);
  const recent = [...runs].slice(-12).reverse();

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
      </header>

      <div className="sq-tiles">
        <div className="sq-tile">
          <div className="sq-tile__val sq-mono">{total}</div>
          <div className="sq-tile__label">Total runs</div>
        </div>
        <div className="sq-tile">
          <div className="sq-tile__val sq-mono">{pct(accepted, total)}%</div>
          <div className="sq-tile__label">Acceptance</div>
        </div>
        <div className="sq-tile">
          <div className="sq-tile__val sq-mono">{totalTokens.toLocaleString()}</div>
          <div className="sq-tile__label">Total tokens</div>
        </div>
      </div>

      {total === 0 ? (
        <div className="sq-empty">No runs yet — complete a story to record traces.</div>
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
