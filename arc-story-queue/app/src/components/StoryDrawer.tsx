import { useState, useEffect, type CSSProperties, type ReactNode } from "react";
import type { Handoff, RunRecord, Story, StoryDetail } from "arc-contracts";
import { dispatchBlockReason } from "arc-contracts";
import type { BoardStore, RefineAction } from "../lib/boardStore";
import {
  COLUMN_LABELS,
  columnDotColor,
  hasLiveWorker,
  routeAccess,
  routeColor,
  routeLabel,
  routeModel,
  workerLanes,
  type TerminalLine,
  type WorkerLane,
} from "../lib/boardStore";
import { useDialog } from "../lib/useDialog";
import { buildContractRows } from "../lib/delegationContract";
import { parseBoardActionError } from "../lib/boardActionError";
import { MergeBlockedCallout } from "./MergeBlockedCallout";
import { OrchestrationPlanSection } from "./OrchestrationPlanSection";
import { Markdown } from "./Markdown";

interface StoryDrawerProps {
  store: BoardStore;
  detail: StoryDetail;
}

export function StoryDrawer({ store, detail }: StoryDrawerProps) {
  const boardStory = store.getState().stories[detail.story.id];
  const story = boardStory ?? detail.story;
  const { runs, handoff } = detail;
  const lanes = boardStory ? workerLanes(boardStory) : [];
  const activeLaneCount = lanes.filter((lane) => lane.status === "running").length;
  const asideRef = useDialog<HTMLElement>(() => store.closeStory());

  return (
    <>
      <div className="sq-scrim" onClick={() => store.closeStory()} />
      <aside
        ref={asideRef}
        className="sq-drawer sq-scroll"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sq-drawer-title"
        tabIndex={-1}
      >
        <header className="sq-drawer__head">
          <div className="sq-drawer__head-left">
            <HeaderPills story={story} />
            {lanes.length > 0 && (
              <span className="sq-drawer__workers">
                <span className="sq-dot" />
                {activeLaneCount > 0 ? `${activeLaneCount} active` : "lanes done"}
              </span>
            )}
          </div>
          <button
            type="button"
            className="sq-drawer__close"
            aria-label="Close"
            onClick={() => store.closeStory()}
          >
            ✕
          </button>
        </header>

        <h2 id="sq-drawer-title" className="sq-drawer__title">{story.title}</h2>
        <TitleChips story={story} />

        {story.draft && (
          <>
            <div className="sq-warn">Draft — file it as a GitHub issue before it can be queued.</div>
            <FilingSection store={store} story={story} />
          </>
        )}

        {story.column === "backlog" && <RefineActions store={store} story={story} />}

        {story.column === "queued" && (() => {
          const inProgress = Object.values(store.getState().stories).filter(
            (s) => s.column === "in_progress"
          );
          const waitReason = dispatchBlockReason(story, inProgress);
          return waitReason ? <div className="sq-warn">{waitReason}</div> : null;
        })()}

        {story.column === "queued" && <OrchestrationPlanSection store={store} story={story} />}

        {story.column === "backlog" && story.prState === "closed" && (
          <div className="sq-warn">PR closed without merging; this card was returned to Backlog. Its worktree is preserved for recovery.</div>
        )}

        {story.column === "in_progress" && story.worktree && (
          <>
            {(!boardStory || !hasLiveWorker(boardStory)) && (
              <StartActions store={store} story={story} />
            )}
            <AbandonActions store={store} story={story} />
          </>
        )}

        <DelegationContract story={story} />
        {story.plan && <ImplementationPlan story={story} />}

        {story.criteria.length > 0 && (
          <Section label="Acceptance criteria">
            <ul className="sq-checklist">
              {story.criteria.map((c, i) => (
                <li key={i}>
                  <input
                    type="checkbox"
                    checked={story.column === "review" || story.column === "done"}
                    readOnly
                    aria-label={c}
                  />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {story.scenarios && story.scenarios.length > 0 && (
          <Section label="Scenarios">
            {story.scenarios.map((s, i) => (
              <div key={i} className="sq-scenario">
                <div className="sq-scenario__name">{s.name}</div>
                {s.steps.map(([kw, text], j) => (
                  <div key={j} className="sq-mono sq-scenario__step">
                    <span className="sq-scenario__kw">{kw}</span> {text}
                  </div>
                ))}
              </div>
            ))}
          </Section>
        )}

        {story.bug && (
          <Section label={`Bug · ${story.bug.severity}`}>
            <p className="sq-drawer__desc">Area: {story.bug.area}</p>
            <p className="sq-mono sq-drawer__desc">Root cause: {story.bug.rootCause}</p>
            <ul className="sq-list">
              {story.bug.fixOptions.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </Section>
        )}

        {story.slice && (
          <Section label="Slice">
            <p className="sq-drawer__desc">
              {story.slice.afk ? "AFK-safe" : "Needs a human decision (HITL)"}
              {story.slice.blockedBy ? ` · blocked by ${story.slice.blockedBy}` : ""}
            </p>
            <p className="sq-drawer__desc">{story.slice.userStoriesCovered}</p>
          </Section>
        )}

        {lanes.length > 0 && (
          <Section
            label="Delegated run · parallel workers"
            meta={activeLaneCount > 0 ? <span className="sq-live-label"><span className="sq-dot" />LIVE</span> : null}
          >
            <div className="sq-lanes">
              {lanes.map((lane) => (
                <WorkerLaneTerminal key={lane.route} lane={lane} />
              ))}
            </div>
          </Section>
        )}

        {handoff && <StructuredHandoff handoff={handoff} story={story} runs={runs} />}

        {story.column === "review" && story.pr && story.prState !== "merged" && story.prState !== "closed" && (
          <ReviewActions store={store} story={story} />
        )}
      </aside>
    </>
  );
}

function HeaderPills({ story }: { story: Story }) {
  const pr = prLabel(story.pr);
  return (
    <div className="sq-drawer__pills sq-drawer__pills--head">
      <span className="sq-drawer__state">
        <span className="sq-dot" style={{ background: columnDotColor(story.column) }} />
        {COLUMN_LABELS[story.column].toUpperCase()}
      </span>
      <span className={`sq-drawer__priority sq-drawer__priority--${story.priority}`}>
        {story.priority.toUpperCase()} PRIORITY
      </span>
      <span className="sq-mono sq-pill-flat">{story.wid}</span>
      {story.epic && <span className="sq-mono sq-pill-flat">epic: {story.epic}</span>}
      <span className="sq-mono sq-pill-flat">size: {story.size}</span>
      <span className="sq-mono sq-pill-flat">{workTypeLabel(story)}</span>
      {pr && <span className="sq-mono sq-pill-flat sq-pill-flat--pr">{pr}</span>}
    </div>
  );
}

function TitleChips({ story }: { story: Story }) {
  return (
    <div className="sq-title-chips">
      {story.repo && <span className="sq-mono sq-title-chip">{story.repo}</span>}
      {story.worktree && <span className="sq-mono sq-title-chip">⌥ {story.worktree}</span>}
      {story.branch && <span className="sq-mono sq-title-chip">⎇ {story.branch}</span>}
    </div>
  );
}

function workTypeLabel(story: Story): string {
  if (story.type === "bug" || story.taskClass === "bugfix") return "BUG";
  if (story.type === "slice") return "SLICE";
  return story.taskClass.toUpperCase();
}

function prLabel(pr?: string | null): string | null {
  if (!pr) return null;
  const hash = pr.match(/#\d+/)?.[0];
  if (hash) return `PR ${hash}`;
  const pathNumber = pr.match(/\/pull\/(\d+)/)?.[1] ?? pr.match(/\bpr\/(\d+)/i)?.[1];
  if (pathNumber) return `PR #${pathNumber}`;
  const plain = pr.match(/^\d+$/)?.[0];
  if (plain) return `PR #${plain}`;
  return pr;
}

function DelegationContract({ story }: { story: Story }) {
  const rows = buildContractRows(story);

  return (
    <Section label="Delegation contract">
      <div className="sq-contract-grid">
        {rows.map((row) => (
          <div
            key={row.slug}
            className={`sq-contract-row sq-contract-row--${row.slug}`}
            style={{ "--sq-contract-c": row.color } as CSSProperties}
          >
            <div className="sq-contract-row__label">{row.label}</div>
            <Markdown className="sq-contract-row__value" text={row.value} />
          </div>
        ))}
      </div>
    </Section>
  );
}

function ImplementationPlan({ story }: { story: Story }) {
  const plan = story.plan;
  if (!plan) return null;
  const tasks = plan.tasks ?? [];
  const files = plan.files ?? [];
  const acMapping = plan.acMapping ?? [];
  if (tasks.length === 0 && files.length === 0 && !plan.testStrategy && acMapping.length === 0) return null;
  return (
    <Section label="Implementation plan">
      {tasks.length > 0 && (
        <PlanBlock label="Ordered tasks">
          <ol className="sq-plan-list sq-plan-list--ordered">
            {tasks.map((task, i) => <li key={i}>{task}</li>)}
          </ol>
        </PlanBlock>
      )}
      {files.length > 0 && (
        <PlanBlock label="File changes">
          <div className="sq-plan-files sq-mono">
            {files.map((file, i) => (
              <div key={`${file.path}-${i}`}>{file.path} — {file.change}</div>
            ))}
          </div>
        </PlanBlock>
      )}
      {plan.testStrategy && (
        <PlanBlock label="Test strategy">
          <p className="sq-drawer__desc">{plan.testStrategy}</p>
        </PlanBlock>
      )}
      {acMapping.length > 0 && (
        <PlanBlock label="Acceptance mapping">
          <div className="sq-plan-map">
            {acMapping.map((mapping, i) => (
              <div key={`${mapping.ac}-${i}`} className="sq-plan-map__row">
                <span>{mapping.ac}</span>
                <span aria-hidden>←</span>
                <span>{mapping.by}</span>
              </div>
            ))}
          </div>
        </PlanBlock>
      )}
    </Section>
  );
}

function PlanBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sq-plan-block">
      <div className="sq-plan-block__label">{label}</div>
      {children}
    </div>
  );
}

function StructuredHandoff({ handoff, story, runs }: { handoff: Handoff; story: Story; runs: RunRecord[] }) {
  const payload: Handoff = {
    status: handoff.status,
    summary: handoff.summary,
    changes: handoff.changes,
    verification: handoff.verification,
    risks: handoff.risks,
    next_actions: handoff.next_actions,
  };
  const tokens = runs.reduce((sum, run) => sum + run.tokens, 0);
  const durMs = runs.reduce((sum, run) => sum + run.durMs, 0);
  const meta = [tokens ? `${tokens.toLocaleString()} tok` : null, durMs ? formatDuration(durMs) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Section
      label="Structured handoff"
      meta={
        <>
          <span className={`sq-outcome sq-outcome--${story.annotation ?? "unrated"}`}>
            Fable · {story.annotation ?? handoff.status}
          </span>
          {meta && <span className="sq-handoff-meta sq-mono">{meta}</span>}
        </>
      }
    >
      <pre className="sq-handoff-json sq-scroll">{JSON.stringify(payload, null, 2)}</pre>
    </Section>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function accessClass(access: string): string {
  if (access === "write") return "sq-access--write";
  if (access === "parent") return "sq-access--parent";
  return "sq-access--readonly";
}

function linePrefix(line: TerminalLine): string {
  if (line.kind === "cmd") return "$ ";
  if (line.kind === "ok") return "✓ ";
  if (line.kind === "lock") return "⚿ ";
  if (line.kind === "unlock") return "↯ ";
  return "";
}

function WorkerLaneTerminal({ lane }: { lane: WorkerLane }) {
  const access = routeAccess(lane.route);
  const active = lane.status === "running";
  return (
    <article className={`sq-lane sq-lane--${lane.status}`} style={{ borderColor: routeColor(lane.route) }}>
      <header className="sq-lane__head">
        <div className="sq-lane__route">
          <span className="sq-route__dot" style={{ background: routeColor(lane.route) }} />
          <span>{routeLabel(lane.route)}</span>
        </div>
        <span className="sq-lane__model sq-mono">{routeModel(lane.route)}</span>
        <span className="sq-lane__spacer" />
        {access === "write" && <span className="sq-lane__lock">⚿ write-lock</span>}
        <span className={`sq-access ${accessClass(access)}`}>{access}</span>
        <span className={`sq-lane__status sq-lane__status--${lane.status}`}>{lane.status}</span>
      </header>
      <div className="sq-lane__terminal sq-mono" aria-label={`${routeLabel(lane.route)} terminal`}>
        {lane.lines.length > 0 ? (
          lane.lines.map((line, i) => (
            <div key={`${line.text}-${i}`} className={`sq-lane__line sq-lane__line--${line.kind} sq-stream`}>
              <span className="sq-lane__prefix">{linePrefix(line)}</span>{line.text}
            </div>
          ))
        ) : (
          <div className="sq-lane__line sq-lane__line--empty">waiting for output</div>
        )}
        {active && (
          <span className="sq-lane__caret" style={{ color: routeColor(lane.route) }} aria-hidden>
            ▊
          </span>
        )}
      </div>
    </article>
  );
}

function useStoryAction() {
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

function RefineActions({ store, story }: { store: BoardStore; story: Story }) {
  const [refining, setRefining] = useState<RefineAction | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: RefineAction) {
    setRefining(action);
    setError(null);
    setNote(null);
    try {
      const result = await store.refineStory(story.id, action);
      setNote(result.note);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefining(null);
    }
  }

  const labels: Record<RefineAction, string> = {
    split: "Splitting…",
    tighten: "Tightening…",
    dedupe: "Checking…",
  };

  return (
    <Section label="Refine with agent">
      <div className="sq-action-row sq-refine-row">
        <button
          type="button"
          className="btn btn--secondary sq-action-row__button"
          disabled={!!refining}
          onClick={() => void run("split")}
        >
          Split story
        </button>
        <button
          type="button"
          className="btn btn--secondary sq-action-row__button"
          disabled={!!refining}
          onClick={() => void run("tighten")}
        >
          Tighten criteria
        </button>
        <button
          type="button"
          className="btn btn--secondary sq-action-row__button"
          disabled={!!refining}
          onClick={() => void run("dedupe")}
        >
          Dedupe
        </button>
      </div>
      {refining && (
        <div className="sq-refine-status" role="status" aria-live="polite">
          <span className="sq-refine-status__spinner" aria-hidden />
          {labels[refining]}
        </div>
      )}
      {note && <div className="sq-refine-note">{note}</div>}
      {error && <div className="connect-bar__error">{error}</div>}
    </Section>
  );
}

function useMergePhase(busy: boolean) {
  const [phase, setPhase] = useState<"sync" | "checks" | "merge">("sync");

  useEffect(() => {
    if (!busy) return;
    setPhase("sync");
    const checksTimer = setTimeout(() => setPhase("checks"), 3000);
    const mergeTimer = setTimeout(() => setPhase("merge"), 10000);
    return () => {
      clearTimeout(checksTimer);
      clearTimeout(mergeTimer);
    };
  }, [busy]);

  const labels: Record<typeof phase, string> = {
    sync: "Syncing branch…",
    checks: "Waiting for Merge Gate…",
    merge: "Merging…",
  };

  return busy ? labels[phase] : null;
}

function ReviewActions({ store, story }: { store: BoardStore; story: Story }) {
  const { busy, error, run } = useStoryAction();
  const phaseLabel = useMergePhase(busy);
  const structuredError = error ? parseBoardActionError(error) : null;

  const buttonLabel = busy
    ? (phaseLabel ?? "Syncing branch…")
    : "✓ Merge PR & clean worktree";

  return (
    <Section label="Review decision">
      <div className="sq-action-row">
        <button
          type="button"
          className="btn btn--success sq-action-row__button"
          disabled={busy}
          onClick={() => void run(() => store.mergeStory(story.id))}
        >
          {busy && <span className="sq-merge-phase__spinner" aria-hidden />}
          {buttonLabel}
        </button>
      </div>
      {busy && phaseLabel && (
        <p className="sq-merge-phase" aria-live="polite">
          <span className="sq-merge-phase__spinner" aria-hidden />
          {phaseLabel}
        </p>
      )}
      {structuredError ? (
        <MergeBlockedCallout
          error={structuredError}
          story={story}
          onRetry={() => void run(() => store.mergeStory(story.id))}
        />
      ) : (
        error && <div className="connect-bar__error">{error}</div>
      )}
    </Section>
  );
}

function StartActions({ store, story }: { store: BoardStore; story: Story }) {
  const { busy, error, run } = useStoryAction();
  const { maxParallel } = store.getConfig();
  const slotsBusy = store.liveWorkerCount() >= maxParallel;
  return (
    <Section label="Start work">
      <p className="sq-drawer__desc">
        Dispatch a worker to execute this reserved story in its worktree.
      </p>
      {slotsBusy ? (
        <p className="sq-drawer__desc">All {maxParallel} worker slots busy</p>
      ) : (
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          onClick={() => void run(() => store.startStory(story.id))}
        >
          Start work
        </button>
      )}
      {error && <div className="connect-bar__error">{error}</div>}
    </Section>
  );
}

function AbandonActions({ store, story }: { store: BoardStore; story: Story }) {
  const { busy, error, run } = useStoryAction();
  return (
    <Section label="Worktree cleanup">
      <p className="sq-drawer__desc">
        Abandon this run to move the story back to Backlog and reclaim its worktree slot.
      </p>
      <button
        type="button"
        className="btn btn--secondary"
        disabled={busy}
        onClick={() => void run(() => store.abandonStory(story.id))}
      >
        Abandon &amp; clean worktree
      </button>
      {error && <div className="connect-bar__error">{error}</div>}
    </Section>
  );
}

function FilingSection({ store, story }: { store: BoardStore; story: Story }) {
  const [issue, setIssue] = useState("");
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

  return (
    <Section label="File to GitHub">
      {story.fileRequested ? (
        <p className="sq-drawer__desc">
          Requested — a Fable session will file this via <span className="sq-mono">gh</span> and
          attach the issue.
        </p>
      ) : (
        <button
          type="button"
          className="btn btn--secondary"
          disabled={busy}
          onClick={() => void run(() => store.requestFile(story.id))}
        >
          Request Fable to file
        </button>
      )}
      <div className="sq-file-manual">
        <input
          type="text"
          className="sq-file-input sq-mono"
          placeholder="#123 or issue URL"
          value={issue}
          onChange={(e) => setIssue(e.target.value)}
          disabled={busy}
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !issue.trim()}
          onClick={() => void run(() => store.fileStory(story.id, issue.trim()))}
        >
          File now
        </button>
      </div>
      {error && <div className="connect-bar__error">{error}</div>}
    </Section>
  );
}

function Section({ label, meta, children }: { label: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="sq-drawer__section">
      <div className="sq-block__label sq-block__label--row">
        <span>{label}</span>
        {meta && <span className="sq-block__meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function HandoffList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="sq-handoff__group">
      <div className="sq-handoff__key">{label}</div>
      <ul className="sq-list sq-mono">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
