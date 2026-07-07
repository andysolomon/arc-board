import { useState } from "react";
import type { IntakeKind } from "arc-contracts";
import type { BoardStore } from "../lib/boardStore";
import { useDialog } from "../lib/useDialog";

interface IntakeModalProps {
  store: BoardStore;
  onClose: () => void;
}

const KINDS: Array<{ id: IntakeKind; label: string }> = [
  { id: "feature", label: "Feature" },
  { id: "prd", label: "PRD slice" },
  { id: "bug", label: "Bug" },
];

export function IntakeModal({ store, onClose }: IntakeModalProps) {
  const [kind, setKind] = useState<IntakeKind>("feature");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  const attached = !!store.getState().project;
  const canSubmit = title.trim().length > 0 && attached && !busy;

  async function run(action: "draft" | "queue") {
    setBusy(true);
    setError(null);
    try {
      const args = { kind, title: title.trim(), description: description.trim() };
      if (action === "draft") await store.createDraftNow(args);
      else await store.enqueueIntake(args);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      store.notify("error", msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="sq-scrim" onClick={onClose} />
      <div
        ref={dialogRef}
        className="sq-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sq-intake-title"
        tabIndex={-1}
      >
        <header className="sq-modal__head">
          <h2 id="sq-intake-title" className="sq-modal__title">New story</h2>
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
              onClick={() => setKind(k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>

        <label className="sq-field">
          <span className="sq-field__label">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short imperative summary"
            disabled={busy}
          />
        </label>

        <label className="sq-field">
          <span className="sq-field__label">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Context, acceptance intent, links…"
            rows={4}
            disabled={busy}
          />
        </label>

        {!attached && <div className="sq-warn">Attach a project first to create work.</div>}
        {error && <div className="connect-bar__error">{error}</div>}

        <footer className="sq-modal__actions">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void run("queue")}
            disabled={!canSubmit}
            title="Enqueue for a Fable session to draft"
          >
            Queue for Fable
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void run("draft")}
            disabled={!canSubmit}
            title="Deterministically draft into Backlog now"
          >
            Draft now →
          </button>
        </footer>
      </div>
    </>
  );
}
