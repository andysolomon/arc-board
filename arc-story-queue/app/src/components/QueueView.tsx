import type { BoardStore, BoardStory } from "../lib/boardStore";
import { routeColor, routeLabel } from "../lib/boardStore";
import { dispatchBlockReason } from "arc-contracts";
import { useAsyncAction } from "../lib/useAsyncAction";
import { AsyncButton } from "./AsyncButton";

interface QueueViewProps {
  store: BoardStore;
  onOpen?: (id: string) => void;
}

function IntakeDraftButton({ store, intakeId }: { store: BoardStore; intakeId: string }) {
  const { busy, run } = useAsyncAction();

  return (
    <AsyncButton
      type="button"
      className="btn btn--secondary"
      busy={busy}
      data-testid={`draft-intake-${intakeId}`}
      onClick={() => run(() => store.draftIntake(intakeId))}
    >
      Draft →
    </AsyncButton>
  );
}

export function QueueView({ store, onOpen }: QueueViewProps) {
  const { busy: pullNextBusy, run: runPullNext } = useAsyncAction();
  const state = store.getState();
  const running = store.storiesByColumn("in_progress");
  const queued = store.queueStories();
  const pendingIntake = store.getIntake().filter((i) => i.status !== "done");

  function lastLine(story: BoardStory): string | null {
    return story.lines.length > 0 ? story.lines[story.lines.length - 1].text : null;
  }

  return (
    <div className="sq-view">
      <header className="sq-view__head">
        <div>
          <h1 className="sq-view__title">Queue</h1>
          <p className="sq-view__sub">
            {state.activeProjectId === "all"
              ? `Ordered work across ${state.projects.length} projects`
              : state.project
                ? `Ordered work for ${state.project.repo}`
                : "No project attached"}
          </p>
        </div>
        <div className="sq-view__actions">
          <span className="sq-count">{queued.length} queued</span>
          <AsyncButton
            type="button"
            className="btn btn--secondary"
            busy={pullNextBusy}
            data-testid="pull-next"
            disabled={!state.project || queued.length === 0}
            onClick={() => runPullNext(() => store.queueNext())}
          >
            Pull next
          </AsyncButton>
        </div>
      </header>

      {pendingIntake.length > 0 && (
        <section className="sq-block">
          <div className="sq-block__label">Intake · {pendingIntake.length}</div>
          {pendingIntake.map((item) => (
            <div key={item.id} className="sq-qrow">
              <span className={`sq-kind-chip sq-kind-chip--${item.kind}`}>{item.kind}</span>
              <span className="sq-qrow__main">
                <span className="sq-qrow__title">{item.title}</span>
                <span className="sq-qrow__meta">
                  <span className="sq-mono">{item.status}</span>
                </span>
              </span>
              <IntakeDraftButton store={store} intakeId={item.id} />
            </div>
          ))}
        </section>
      )}

      <section className="sq-block">
        <div className="sq-block__label">Running · {running.length}</div>
        {running.length === 0 && <div className="sq-empty">No worktrees running</div>}
        {running.map((story) => {
          const route = story.activeRoute;
          const color = route ? routeColor(route) : "var(--sq-running)";
          const label = route ? routeLabel(route) : "running";
          const line = lastLine(story);
          return (
            <button
              key={story.id}
              type="button"
              className="sq-qrow sq-qrow--running"
              onClick={onOpen ? () => onOpen(story.id) : undefined}
            >
              <span className="sq-qrow__main">
                <span className="sq-qrow__title">{story.title}</span>
                {story.worktree && <span className="sq-mono sq-qrow__wt">{story.worktree}</span>}
                {line && (
                  <span className="sq-qrow__term sq-mono">
                    {line}
                    <span className="sq-qrow__caret" style={{ color }} aria-hidden>
                      ▊
                    </span>
                  </span>
                )}
              </span>
              <span className="sq-route" style={{ color }}>
                <span className="sq-route__dot" style={{ background: color }} />
                {label}
              </span>
            </button>
          );
        })}
      </section>

      <section className="sq-block">
        <div className="sq-block__label">Up next · {queued.length}</div>
        {queued.length === 0 && (
          <div className="sq-empty">Nothing queued — file a draft, then enqueue it from the Board.</div>
        )}
        {queued.map((story, i) => {
          const waitReason = dispatchBlockReason(story, running);
          return (
          <div key={story.id} className="sq-qrow">
            <span className="sq-qrow__pos">#{i + 1}</span>
            <button
              type="button"
              className="sq-qrow__main sq-qrow__main--btn"
              onClick={onOpen ? () => onOpen(story.id) : undefined}
            >
              <span className="sq-qrow__title">{story.title}</span>
              <span className="sq-qrow__meta">
                {waitReason && <span className="sq-qrow__wait">{waitReason}</span>}
                {story.issue && <span className="sq-mono">{story.issue}</span>}
                <span className="sq-mono">{story.taskClass}</span>
                <span className="sq-mono">{story.branch}</span>
              </span>
            </button>
            <span className="sq-qrow__reorder">
              <button
                type="button"
                className="sq-iconbtn"
                aria-label="Move up"
                disabled={i === 0}
                onClick={() => void store.reorderQueue(story.id, "up")}
              >
                ▲
              </button>
              <button
                type="button"
                className="sq-iconbtn"
                aria-label="Move down"
                disabled={i === queued.length - 1}
                onClick={() => void store.reorderQueue(story.id, "down")}
              >
                ▼
              </button>
            </span>
          </div>
        );
        })}
      </section>
    </div>
  );
}
