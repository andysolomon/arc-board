import { useState, type ReactNode } from "react";
import type { Story, StoryDetail } from "arc-contracts";
import type { BoardStore } from "../lib/boardStore";
import { COLUMN_LABELS, columnDotColor, routeColor } from "../lib/boardStore";
import { useDialog } from "../lib/useDialog";

interface StoryDrawerProps {
  store: BoardStore;
  detail: StoryDetail;
}

export function StoryDrawer({ store, detail }: StoryDrawerProps) {
  const { story, runs, handoff } = detail;
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
          <span className="sq-drawer__col">
            <span className="sq-dot" style={{ background: columnDotColor(story.column) }} />
            {COLUMN_LABELS[story.column]}
          </span>
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
