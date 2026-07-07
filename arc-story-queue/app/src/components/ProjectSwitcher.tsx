import { useEffect, useState } from "react";
import type { Project } from "arc-contracts";
import type { BoardStore } from "../lib/boardStore";

export function ProjectSwitcher({ store }: { store: BoardStore }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<Project[]>([]);
  const [repoPath, setRepoPath] = useState("");
  const [repoId, setRepoId] = useState("local/project");
  const state = store.getState();
  const project = state.project;

  async function openMenu() {
    setOpen(true);
    setError(null);
    setBusy(true);
    try {
      if (state.status !== "connected") await store.connect();
      setDiscovered(await store.discover());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Fill the repo id from the local repo's git origin remote (best-effort).
  async function fillRepoIdFrom(path: string) {
    if (!path.trim()) return;
    try {
      if (store.getState().status !== "connected") await store.connect();
      const { repoId: detected } = await store.detectRepoId(path.trim());
      if (detected) setRepoId(detected);
    } catch {
      // best-effort — leave the field as-is
    }
  }

  async function attach(id: string) {
    setBusy(true);
    setError(null);
    try {
      if (store.getState().status !== "connected") await store.connect();
      await store.attachSession(id);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function connectManual() {
    setBusy(true);
    setError(null);
    try {
      if (store.getState().status !== "connected") await store.connect();
      await store.registerAndAttach({
        repo: repoId.trim() || "local/project",
        path: repoPath.trim(),
        branch: "main",
        model: "board-ui",
        pid: 0,
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Native directory picker — desktop (Tauri) only; the web build can't read FS paths.
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  async function browse() {
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "Select the local repo" });
      if (typeof dir === "string") {
        setRepoPath(dir);
        await fillRepoIdFrom(dir);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="sq-switcher">
      <button
        type="button"
        className="sq-switcher__btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : void openMenu())}
      >
        <span className="sq-mono sq-switcher__label">{project ? project.repo : "Connect…"}</span>
        <span aria-hidden>▾</span>
      </button>

      {open && (
        <>
          <div className="sq-bell__scrim" onClick={() => setOpen(false)} />
          <div className="sq-switcher__popover sq-scroll" role="dialog" aria-label="Switch project">
            <div className="sq-block__label">Sessions</div>
            {discovered.length === 0 && (
              <div className="sq-empty">{busy ? "Discovering…" : "No unattached sessions"}</div>
            )}
            {discovered.map((d) => (
              <div key={d.id} className="sq-switcher__row">
                <span className="sq-mono sq-switcher__repo">{d.repo}</span>
                <span className="sq-mono sq-switcher__meta">
                  {d.branch} · {d.model}
                </span>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => void attach(d.id)}
                  disabled={busy}
                >
                  Attach
                </button>
              </div>
            ))}

            <div className="sq-block__label">Connect a repo</div>
            <label className="sq-field">
              <span className="sq-field__label">Path</span>
              <div className="sq-file-manual">
                <input
                  type="text"
                  className="sq-file-input"
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                  onBlur={() => void fillRepoIdFrom(repoPath)}
                  placeholder="/path/to/repo"
                  disabled={busy}
                />
                {isTauri && (
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => void browse()}
                    disabled={busy}
                  >
                    Browse…
                  </button>
                )}
              </div>
            </label>
            <label className="sq-field">
              <span className="sq-field__label">Repo id</span>
              <input
                type="text"
                value={repoId}
                onChange={(e) => setRepoId(e.target.value)}
                disabled={busy}
              />
            </label>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void connectManual()}
              disabled={busy || !repoPath.trim()}
            >
              Attach path
            </button>
            {error && <div className="connect-bar__error">{error}</div>}
          </div>
        </>
      )}
    </div>
  );
}
