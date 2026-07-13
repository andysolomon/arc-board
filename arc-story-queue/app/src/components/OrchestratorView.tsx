import { ROUTES, routeColor } from "arc-contracts";
import type { BoardStore } from "../lib/boardStore";
import { GithubBoardSection } from "./GithubBoardSection";

interface OrchestratorViewProps {
  store: BoardStore;
}

const MCP_SNIPPET = `{
  "mcpServers": {
    "story-queue": {
      "type": "http",
      "url": "http://127.0.0.1:7420/mcp"
    }
  }
}`;

export function OrchestratorView({ store }: OrchestratorViewProps) {
  const state = store.getState();
  const config = store.getConfig();
  const connected = state.status === "connected";

  return (
    <div className="sq-view">
      <header className="sq-view__head">
        <div>
          <h1 className="sq-view__title">Orchestrator</h1>
          <p className="sq-view__sub">Fable pulls work; the daemon stays passive.</p>
        </div>
      </header>

      <section className="sq-block">
        <div className="sq-block__label">Connection</div>
        <div className="sq-conn">
          <span className={`sq-pill${connected ? " sq-pill--live" : ""}`}>
            <span className="sq-pill__dot" />
            {connected ? "Connected" : "Offline"}
          </span>
          <span className="sq-mono sq-conn__meta">
            parent {state.project?.model ?? "claude-fable-5"} · http://127.0.0.1:7420/mcp
          </span>
        </div>
      </section>

      <GithubBoardSection store={store} />

      <section className="sq-block">
        <div className="sq-block__label">Rules</div>
        <div className="sq-tiles">
          <div className="sq-tile">
            <div className="sq-toggle-row">
              <span>Auto-run</span>
              <button
                type="button"
                role="switch"
                aria-checked={config.autoRun}
                className={`sq-toggle${config.autoRun ? " sq-toggle--on" : ""}`}
                onClick={() => void store.updateConfig({ autoRun: !config.autoRun })}
              >
                <span className="sq-toggle__knob" />
              </button>
            </div>
            <div className="sq-tile__label">Board pulls queue.next automatically</div>
          </div>
          <div className="sq-tile">
            <div className="sq-toggle-row">
              <span>Require orchestration plan</span>
              <button
                type="button"
                role="switch"
                aria-checked={config.requireOrchestrationPlan}
                className={`sq-toggle${config.requireOrchestrationPlan ? " sq-toggle--on" : ""}`}
                onClick={() =>
                  void store.updateConfig({ requireOrchestrationPlan: !config.requireOrchestrationPlan })
                }
              >
                <span className="sq-toggle__knob" />
              </button>
            </div>
            <div className="sq-tile__label">Only dispatch stories with a planned orchestration route</div>
          </div>
          <div className="sq-tile">
            <div className="sq-stepper">
              <button
                type="button"
                className="sq-iconbtn"
                aria-label="Fewer parallel worktrees"
                disabled={config.maxParallel <= 1}
                onClick={() => void store.updateConfig({ maxParallel: Math.max(1, config.maxParallel - 1) })}
              >
                −
              </button>
              <span className="sq-mono sq-stepper__val">{config.maxParallel}</span>
              <button
                type="button"
                className="sq-iconbtn"
                aria-label="More parallel worktrees"
                disabled={config.maxParallel >= 8}
                onClick={() => void store.updateConfig({ maxParallel: Math.min(8, config.maxParallel + 1) })}
              >
                +
              </button>
            </div>
            <div className="sq-tile__label">Parallel worktrees (writes serialize per worktree)</div>
          </div>
        </div>
      </section>

      <section className="sq-block">
        <div className="sq-block__label">Worker routes</div>
        {ROUTES.map((r) => (
          <div key={r.id} className="sq-routerow">
            <span className="sq-route__dot" style={{ background: routeColor(r.id) }} />
            <span className="sq-mono sq-routerow__id">{r.id}</span>
            <span className="sq-mono sq-routerow__model">{r.backend} · {r.model}</span>
            <span className={`sq-access sq-access--${r.access.replace(/[^a-z]/g, "")}`}>{r.access}</span>
            <span className="sq-routerow__use">{r.use}</span>
          </div>
        ))}
      </section>

      <section className="sq-block">
        <div className="sq-block__label">.mcp.json</div>
        <pre className="sq-code sq-mono">{MCP_SNIPPET}</pre>
      </section>
    </div>
  );
}
