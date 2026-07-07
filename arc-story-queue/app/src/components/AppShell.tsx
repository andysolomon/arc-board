import { useEffect, useRef, useState } from "react";
import type { BoardStore } from "../lib/boardStore";
import { BoardView } from "./Board";
import { QueueView } from "./QueueView";
import { ObservabilityView } from "./ObservabilityView";
import { OrchestratorView } from "./OrchestratorView";
import { StoryDrawer } from "./StoryDrawer";
import { IntakeModal } from "./IntakeModal";
import { ToastHost } from "./ToastHost";
import { NotificationsBell } from "./NotificationsBell";
import { ProjectSwitcher } from "./ProjectSwitcher";

type ViewId = "board" | "queue" | "observability" | "orchestrator";

const NAV: Array<{ id: ViewId; label: string }> = [
  { id: "board", label: "Board" },
  { id: "queue", label: "Queue" },
  { id: "observability", label: "Observability" },
  { id: "orchestrator", label: "Orchestrator" },
];

function navCount(store: BoardStore, id: ViewId): number | null {
  if (id === "queue") return store.queueStories().length;
  if (id === "observability") return store.getRuns().length;
  return null;
}

interface AppShellProps {
  store: BoardStore;
}

export function AppShell({ store }: AppShellProps) {
  const [view, setView] = useState<ViewId>("board");
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [, setLivenessTick] = useState(0);
  const state = store.getState();
  const connected = state.status === "connected";
  const runningCount = store.storiesByColumn("in_progress").length;
  const liveWorkerCount = store.liveWorkerCount();
  const reservedWorkerCount = store.reservedWorkerCount();
  const queueLen = store.queueStories().length;
  const detail = store.getDetail();
  const autoPulling = useRef(false);

  // Auto-run: when enabled and a worktree slot is free, pull the next queued story.
  // Capacity-guarded so it never busy-loops. The dependency array fires the effect
  // exactly when the inputs change (config, connection, in-progress count, queue depth)
  // rather than on every render.
  const { autoRun, maxParallel } = state.config;
  const attached = !!state.project;

  // Re-evaluate recent-worker liveness even if no fresh SSE arrives, so stale streams
  // naturally fall back to the reserved/no-worker state.
  useEffect(() => {
    if (!connected || runningCount === 0) return;
    const id = window.setInterval(() => setLivenessTick((n) => n + 1), 5_000);
    return () => window.clearInterval(id);
  }, [connected, runningCount]);

  useEffect(() => {
    if (!autoRun || !connected || !attached) return;
    if (autoPulling.current) return;
    if (runningCount >= maxParallel) return;
    if (queueLen === 0) return;
    autoPulling.current = true;
    store.queueNext().finally(() => {
      autoPulling.current = false;
    });
  }, [store, autoRun, maxParallel, connected, attached, runningCount, queueLen]);

  async function openStory(id: string) {
    try {
      await store.openStory(id);
    } catch (err) {
      console.error("open story failed:", err);
    }
  }

  return (
    <div className="sq-shell">
      <div className="sq-titlebar">
        <div className="sq-traffic" aria-hidden>
          <span className="sq-traffic__dot sq-traffic__dot--r" />
          <span className="sq-traffic__dot sq-traffic__dot--y" />
          <span className="sq-traffic__dot sq-traffic__dot--g" />
        </div>
        <div className="sq-titlebar__mark" aria-hidden />
        <ProjectSwitcher store={store} />
        <span
          className={`sq-pill ${
            !connected
              ? "sq-pill--off"
              : liveWorkerCount > 0
                ? "sq-pill--working"
                : reservedWorkerCount > 0
                  ? "sq-pill--reserved"
                  : "sq-pill--idle"
          }`}
        >
          <span className="sq-pill__dot" />
          {!connected
            ? "Offline"
            : liveWorkerCount > 0
              ? `Fable · ${liveWorkerCount} running`
              : reservedWorkerCount > 0
                ? "Fable · no worker attached"
                : "Fable · idle"}
          {connected && liveWorkerCount > 0 && <span className="sq-pill__spinner" aria-hidden />}
        </span>
        <div className="sq-titlebar__spacer" />
        <button
          type="button"
          className="sq-iconbtn"
          aria-label="Refresh"
          title="Refresh"
          onClick={() => void store.refreshViews()}
          disabled={!connected || !state.project}
        >
          ⟳
        </button>
        <NotificationsBell store={store} />
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setIntakeOpen(true)}
          disabled={!connected}
        >
          + New Story
        </button>
      </div>

      <div className="sq-shell__body">
        <nav className="sq-nav">
          <div className="sq-nav__section">Workspace</div>
          {NAV.map((item) => {
            const count = navCount(store, item.id);
            return (
              <button
                key={item.id}
                type="button"
                className={`sq-nav__item${view === item.id ? " sq-nav__item--active" : ""}`}
                onClick={() => setView(item.id)}
              >
                <span>{item.label}</span>
                {count !== null && <span className="sq-nav__count">{count}</span>}
              </button>
            );
          })}
        </nav>

        <main className="sq-main sq-scroll">
          {view === "board" && <BoardView store={store} onOpen={openStory} />}
          {view === "queue" && <QueueView store={store} onOpen={openStory} />}
          {view === "observability" && <ObservabilityView store={store} />}
          {view === "orchestrator" && <OrchestratorView store={store} />}
        </main>
      </div>

      {detail && <StoryDrawer store={store} detail={detail} />}
      {intakeOpen && <IntakeModal store={store} onClose={() => setIntakeOpen(false)} />}
      <ToastHost store={store} />
    </div>
  );
}
