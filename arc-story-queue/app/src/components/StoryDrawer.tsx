import { useState, type ReactNode } from "react";
import type { Story, StoryDetail } from "arc-contracts";
import type { BoardStore } from "../lib/boardStore";
import {
  COLUMN_LABELS,
  columnDotColor,
  routeAccess,
  routeColor,
  routeLabel,
  routeModel,
  workerLanes,
  type WorkerLane,
} from "../lib/boardStore";
import { useDialog } from "../lib/useDialog";

interface StoryDrawerProps {
  store: BoardStore;
  detail: StoryDetail;
}

export function StoryDrawer({ store, detail }: StoryDrawerProps) {
  const { story, runs, handoff } = detail;
  const boardStory = store.getState().stories[story.id];
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
            <span className="sq-drawer__col">
              <span className="sq-dot" style={{ background: columnDotColor(story.column) }} />
              {COLUMN_LABELS[story.column]}
            </span>
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

        <div className="sq-drawer__pills">
          <span className="sq-mono sq-pill-flat">{story.wid}</span>
          {story.issue && <span className="sq-mono sq-pill-flat">{story.issue}</span>}
          {story.pr && <span className="sq-mono sq-pill-flat">{story.pr}</span>}
          {story.draft && <span className="story-card__draft">DRAFT</span>}
          <span className="sq-mono sq-pill-flat">{story.taskClass}</span>
          <span className="sq-mono sq-pill-flat">{story.size}</span>
        </div>

        <div className="sq-mono sq-drawer__path">{story.repo} · {story.branch}</div>
        {story.worktree && <div className="sq-mono sq-drawer__path">{story.worktree}</div>}

        {story.draft && (
          <>
            <div className="sq-warn">Draft — file it as a GitHub issue before it can be queued.</div>
            <FilingSection store={store} story={story} />
          </>
        )}

        {story.column === "review" && story.pr && story.prState !== "merged" && (
          <ReviewActions store={store} story={story} />
        )}

        {story.column === "in_progress" && story.worktree && (
          <AbandonActions store={store} story={story} />
        )}

        {story.description && (
          <Section label="Contract">
            <p className="sq-drawer__desc">{story.description}</p>
          </Section>
        )}

        {story.plan && (
          <Section label="Plan">
            <ul className="sq-list">
              {story.plan.tasks.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
            {story.plan.files.length > 0 && (
              <div className="sq-mono sq-drawer__files">
                {story.plan.files.map((f, i) => (
                  <div key={i}>{f.path} — {f.change}</div>
                ))}
              </div>
            )}
            {story.plan.testStrategy && (
              <p className="sq-drawer__desc">Tests: {story.plan.testStrategy}</p>
            )}
          </Section>
        )}

        {story.criteria.length > 0 && (
          <Section label="Acceptance criteria">
            <ul className="sq-list">
              {story.criteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </Section>
        )}

        {lanes.length > 0 && (
          <Section label="Delegated run · parallel workers">
            <div className="sq-lanes">
              {lanes.map((lane) => (
                <WorkerLaneTerminal key={lane.route} lane={lane} />
              ))}
            </div>
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

        {runs.length > 0 && (
          <Section label={`Runs · ${runs.length}`}>
            {runs.map((r) => (
              <div key={r.id} className="sq-runrow">
                <span className="sq-route__dot" style={{ background: routeColor(r.route) }} />
                <span className="sq-runrow__label">{r.label}</span>
                <span className="sq-mono sq-runrow__tok">{r.tokens.toLocaleString()} tok</span>
                <span className="sq-mono sq-runrow__dur">{r.durMs}ms</span>
                <span className={`sq-outcome sq-outcome--${r.outcome}`}>{r.outcome}</span>
              </div>
            ))}
          </Section>
        )}

        {handoff && (
          <Section label={`Handoff · ${handoff.status}`}>
            <p className="sq-drawer__desc">{handoff.summary}</p>
            <HandoffList label="Changes" items={handoff.changes} />
            <HandoffList label="Verification" items={handoff.verification} />
            <HandoffList label="Risks" items={handoff.risks} />
            <HandoffList label="Next actions" items={handoff.next_actions} />
          </Section>
        )}
      </aside>
    </>
  );
}

function accessClass(access: string): string {
  if (access === "write") return "sq-access--write";
  if (access === "parent") return "sq-access--parent";
  return "sq-access--readonly";
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
        <span className={`sq-access ${accessClass(access)}`}>{access}</span>
        {access === "write" && <span className="sq-lane__lock">⚿ write-lock</span>}
        <span className={`sq-lane__status sq-lane__status--${lane.status}`}>{lane.status}</span>
      </header>
      <div className="sq-lane__model sq-mono">{routeModel(lane.route)}</div>
      <div className="sq-lane__terminal sq-mono" aria-label={`${routeLabel(lane.route)} terminal`}>
        {lane.lines.length > 0 ? (
          lane.lines.map((line, i) => (
            <div key={`${line.text}-${i}`} className={`sq-lane__line sq-lane__line--${line.kind} sq-stream`}>
              {line.text}
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

function ReviewActions({ store, story }: { store: BoardStore; story: Story }) {
  const { busy, error, run } = useStoryAction();
  return (
    <Section label="Review decision">
      <div className="sq-action-row">
        <button
          type="button"
          className="btn btn--success sq-action-row__button"
          disabled={busy}
          onClick={() => void run(() => store.mergeStory(story.id))}
        >
          Merge PR &amp; clean worktree
        </button>
      </div>
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

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="sq-drawer__section">
      <div className="sq-block__label">{label}</div>
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
