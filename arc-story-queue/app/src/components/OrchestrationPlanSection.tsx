import { useState, type CSSProperties } from "react";
import type { Story } from "arc-contracts";
import type { BoardStore } from "../lib/boardStore";
import { planDetailRows, planStatus } from "../lib/orchestrationPlan";

interface OrchestrationPlanSectionProps {
  store: BoardStore;
  story: Story;
}

/** Same shape as StoryDrawer's useStoryAction, kept local so this section stays self-contained. */
function usePlanAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run };
}

/**
 * Drawer section for a queued story's orchestration plan: the solidified
 * route decision when planned, the failure detail when analysis failed, and
 * a Replan / Retry action that re-triggers the background planner.
 */
export function OrchestrationPlanSection({ store, story }: OrchestrationPlanSectionProps) {
  const { busy, error, run } = usePlanAction();
  const status = planStatus(story);
  const rows = planDetailRows(story);

  return (
    <section className="sq-drawer__section" data-plan-status={status}>
      <div className="sq-block__label sq-block__label--row">
        <span>Orchestration plan</span>
        <span className="sq-block__meta">
          <span className={`sq-orch-status sq-orch-status--${status}`}>
            {status === "planned" ? "ready" : status}
          </span>
        </span>
      </div>

      {status === "unplanned" && (
        <p className="sq-drawer__desc">Awaiting orchestration analysis — the planner picks queued stories up automatically.</p>
      )}

      {status === "planning" && (
        <div className="sq-refine-status" role="status" aria-live="polite">
          <span className="sq-refine-status__spinner" aria-hidden />
          Analyzing route, model, and mode…
        </div>
      )}

      {status === "planned" && (
        <>
          <div className="sq-orch-grid">
            {rows.map((row) => (
              <div
                key={row.slug}
                className={`sq-orch-row sq-orch-row--${row.slug}`}
                style={{ "--sq-orch-c": row.color } as CSSProperties}
              >
                <div className="sq-orch-row__label">{row.label}</div>
                <div className="sq-orch-row__value">{row.value}</div>
              </div>
            ))}
          </div>
          <div className="sq-action-row">
            <button
              type="button"
              className="btn btn--secondary sq-action-row__button"
              disabled={busy}
              onClick={() => void run(() => store.replanStory(story.id))}
            >
              {busy ? "Replanning…" : "Replan"}
            </button>
          </div>
        </>
      )}

      {status === "failed" && (
        <>
          <div className="sq-orch-error">
            {story.orchestration?.error ?? "Orchestration analysis failed."}
          </div>
          <div className="sq-action-row">
            <button
              type="button"
              className="btn btn--secondary sq-action-row__button"
              disabled={busy}
              onClick={() => void run(() => store.replanStory(story.id))}
            >
              {busy ? "Retrying…" : "Retry planning"}
            </button>
          </div>
        </>
      )}

      {error && <div className="connect-bar__error">{error}</div>}
    </section>
  );
}
