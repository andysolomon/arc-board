import { useState } from "react";
import type { IntakeDraftProposal, IntakeGenerateResult, IntakeKind } from "arc-contracts";
import type { BoardStore } from "../lib/boardStore";
import { useDialog } from "../lib/useDialog";

interface IntakeModalProps {
  store: BoardStore;
  onClose: () => void;
}

const KINDS: Array<{ id: IntakeKind; label: string; helper: string; placeholder: string }> = [
  {
    id: "feature",
    label: "Features → stories",
    helper: "List features. Fable proposes independently deliverable user stories.",
    placeholder: "e.g.\nLet users sign in with Google\nExport activity as CSV\nAdd empty states to the dashboard",
  },
  {
    id: "prd",
    label: "PRD → slices",
    helper: "Paste a PRD or brief. Fable slices it into tracer-bullet issues.",
    placeholder: "Paste your PRD or feature brief…",
  },
  {
    id: "bug",
    label: "Report a bug",
    helper: "Describe the symptom. Fable drafts a root-caused bug ticket.",
    placeholder: "e.g. On /checkout, submitting payment shows a blank screen instead of the receipt",
  },
];

function typeBadge(draft: IntakeDraftProposal): string {
  if (draft.type === "bug") return `BUG · ${draft.bug?.severity ?? "S3"}`;
  if (draft.type === "slice") return draft.slice?.afk === false ? "HITL" : "AFK";
  return "STORY";
}

export function IntakeModal({ store, onClose }: IntakeModalProps) {
  const [kind, setKind] = useState<IntakeKind>("feature");
  const [text, setText] = useState("");
  const [result, setResult] = useState<IntakeGenerateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  const attached = !!store.getState().project;
  const meta = KINDS.find((k) => k.id === kind)!;
  const canGenerate = text.trim().length > 0 && !busy;
  const selectedCount = result?.drafts.filter((d) => d.include).length ?? 0;

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setResult(await store.generateDraftProposals({ kind, text }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      store.notify("error", msg);
    } finally {
      setBusy(false);
    }
  }

  async function createDrafts() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const stories = await store.createDraftsFromProposals(result.drafts);
      if (stories.length > 0) onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      store.notify("error", msg);
    } finally {
      setBusy(false);
    }
  }

  function toggleDraft(index: number) {
    setResult((current) =>
      current
        ? {
            ...current,
            drafts: current.drafts.map((draft, i) =>
              i === index ? { ...draft, include: !draft.include } : draft
            ),
          }
        : current
    );
  }

  return (
    <>
      <div className="sq-scrim" onClick={onClose} />
      <div
        ref={dialogRef}
        className="sq-modal sq-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sq-intake-title"
        tabIndex={-1}
      >
        <header className="sq-modal__head">
          <div>
            <h2 id="sq-intake-title" className="sq-modal__title">Draft new work</h2>
            <div className="sq-modal__sub">Potential issues · file through Fable before queueing</div>
          </div>
          <button type="button" className="sq-iconbtn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="sq-modal__kinds">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className={`sq-kind${kind === k.id ? " sq-kind--active" : ""}`}
              onClick={() => {
                setKind(k.id);
                setResult(null);
              }}
              disabled={busy}
            >
              {k.label}
            </button>
          ))}
        </div>

        <label className="sq-field">
          <span className="sq-field__label">Intake</span>
          <span className="sq-field__hint">{meta.helper}</span>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setResult(null);
            }}
            placeholder={meta.placeholder}
            rows={5}
            disabled={busy}
          />
        </label>

        {!attached && <div className="sq-warn">No Fable session is attached. Generate will use the deterministic fallback; attach a project before creating drafts.</div>}
        {error && <div className="connect-bar__error">{error}</div>}

        <button
          type="button"
          className="btn btn--primary sq-generate"
          onClick={() => void generate()}
          disabled={!canGenerate}
        >
          {busy && !result ? "Generating…" : "Generate"}
        </button>

        {result && (
          <section className="sq-proposals" aria-label="Proposed drafts">
            <div className="sq-proposals__head">
              <span>Proposed — deselect anything you do not want</span>
              <span className={`sq-source sq-source--${result.source}`}>
                {result.source === "model" ? "model-backed" : "fallback used"}
              </span>
            </div>
            {result.exploreNote && <div className="sq-explore-note">{result.exploreNote}</div>}
            <div className="sq-proposals__list">
              {result.drafts.map((draft, index) => (
                <button
                  key={`${draft.title}-${index}`}
                  type="button"
                  className={`sq-proposal${draft.include ? " sq-proposal--selected" : ""}`}
                  onClick={() => toggleDraft(index)}
                  disabled={busy}
                >
                  <span className="sq-proposal__check">{draft.include ? "✓" : ""}</span>
                  <span className="sq-proposal__body">
                    <span className="sq-proposal__meta">
                      <span className={`sq-priority sq-priority--${draft.priority}`} />
                      <span className={`sq-type sq-type--${draft.type}`}>{typeBadge(draft)}</span>
                      <span className="sq-proposal__title">{draft.title}</span>
                    </span>
                    <span className="sq-proposal__summary">{draft.summary}</span>
                    <span className="sq-proposal__sub">{draft.epic} · {draft.taskClass} · {draft.size}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        <footer className="sq-modal__actions">
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {result && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void createDrafts()}
              disabled={busy || selectedCount === 0 || !attached}
              title="Created drafts stay in Backlog as DRAFT until filed as GitHub issues"
            >
              Create {selectedCount} draft{selectedCount === 1 ? "" : "s"} →
            </button>
          )}
        </footer>
      </div>
    </>
  );
}
