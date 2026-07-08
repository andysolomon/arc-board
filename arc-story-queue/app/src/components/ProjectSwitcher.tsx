import { useEffect, useState } from "react";
import type { FsDirListing, Project } from "arc-contracts";
import type { BoardStore } from "../lib/boardStore";
import { useDialog } from "../lib/useDialog";

function projectSubline(project: Pick<Project, "path" | "branch" | "model">): string {
  return `${project.path} · ${project.branch} · ${project.model}`;
}

function pathCrumbs(path: string): Array<{ label: string; path: string }> {
  const normalized = path.replace(/\\/g, "/");
  const drive = normalized.match(/^[A-Za-z]:\//)?.[0] ?? "";
  const rest = drive ? normalized.slice(drive.length) : normalized;
  const absolute = rest.startsWith("/") || Boolean(drive);
  const parts = rest.split("/").filter(Boolean);
  const crumbs: Array<{ label: string; path: string }> = [];
  let current = drive || (absolute ? "/" : "");

  if (absolute) crumbs.push({ label: drive || "/", path: current });
  for (const part of parts) {
    current = current === "/" || current === drive ? `${current}${part}` : current ? `${current}/${part}` : part;
    crumbs.push({ label: part, path: current });
  }
  return crumbs.length ? crumbs : [{ label: path || "Home", path }];
}

function DirectoryPicker({
  listing,
  busy,
  error,
  onOpen,
  onSelect,
  onClose,
}: {
  listing: FsDirListing | null;
  busy: boolean;
  error: string | null;
  onOpen(path: string): void;
  onSelect(path: string): void;
  onClose(): void;
}) {
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const crumbs = listing ? pathCrumbs(listing.path) : [];

  return (
    <>
      <div className="sq-dir-picker__scrim" onClick={onClose} />
      <div
        ref={dialogRef}
        className="sq-dir-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Browse daemon host folders"
        tabIndex={-1}
      >
        <div className="sq-modal__head">
          <div>
            <h2 className="sq-modal__title">Choose a repo folder</h2>
            <div className="sq-modal__sub">Browsing directories on the daemon host.</div>
          </div>
          <button type="button" className="sq-drawer__close" aria-label="Close folder picker" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="sq-dir-picker__crumbs" aria-label="Current folder">
          {crumbs.length === 0 ? (
            <span className="sq-dir-picker__crumb">Loading…</span>
          ) : (
            crumbs.map((crumb, index) => (
              <span key={`${crumb.path}-${index}`} className="sq-dir-picker__crumb-wrap">
                {index > 0 && <span className="sq-dir-picker__sep">/</span>}
                <button
                  type="button"
                  className="sq-dir-picker__crumb"
                  onClick={() => onOpen(crumb.path)}
                  disabled={busy}
                >
                  {crumb.label}
                </button>
              </span>
            ))
          )}
        </div>

        <div className="sq-dir-picker__toolbar">
          <button type="button" className="btn btn--secondary" onClick={() => onOpen("")} disabled={busy}>
            Home
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => listing?.parent && onOpen(listing.parent)}
            disabled={busy || !listing?.parent}
          >
            Up
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => listing && onSelect(listing.path)}
            disabled={busy || !listing}
          >
            Select this folder
          </button>
        </div>

        {error && <div className="connect-bar__error sq-dir-picker__error">{error}</div>}

        <div className="sq-dir-picker__list sq-scroll" role="list" aria-busy={busy}>
          {busy && <div className="sq-empty">Loading folders…</div>}
          {!busy && listing && listing.entries.length === 0 && <div className="sq-empty">No folders here</div>}
          {!busy &&
            listing?.entries.map((entry) => (
              <button
                type="button"
                role="listitem"
                key={entry.path}
                className="sq-dir-picker__row"
                onClick={() => onOpen(entry.path)}
                onDoubleClick={() => onOpen(entry.path)}
              >
                <span className="sq-dir-picker__folder" aria-hidden>
                  📁
                </span>
                <span className="sq-dir-picker__name">{entry.name}</span>
                {entry.isGitRepo && <span className="sq-dir-picker__repo-badge">Git repo</span>}
              </button>
            ))}
        </div>
      </div>
    </>
  );
}

export function ProjectSwitcher({ store }: { store: BoardStore }) {
  const [open, setOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [dirListing, setDirListing] = useState<FsDirListing | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pickerOpen) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, pickerOpen]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<Project[]>([]);
  const [repoPath, setRepoPath] = useState("");
  const [repoId, setRepoId] = useState("local/project");
  const state = store.getState();
  const project = state.project;
  const attached = state.projects;
  const activeAll = state.activeProjectId === "all";
  const label = activeAll ? "All projects" : project ? project.repo : "Connect…";

  async function refreshDiscovered() {
    if (store.getState().status !== "connected") await store.connect();
    setDiscovered(await store.discover());
  }

  async function openMenu() {
    setOpen(true);
    setError(null);
    setBusy(true);
    try {
      await refreshDiscovered();
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
      await refreshDiscovered();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function switchTo(scope: "all" | string) {
    setBusy(true);
    setError(null);
    try {
      await store.selectProject(scope);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function detach(id: string) {
    setBusy(true);
    setError(null);
    try {
      await store.detachProject(id);
      await refreshDiscovered();
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

  // Native directory picker for desktop; daemon-backed picker for the browser build.
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

  async function loadDirectory(path: string) {
    setPickerBusy(true);
    setPickerError(null);
    try {
      if (store.getState().status !== "connected") await store.connect();
      setDirListing(await store.listDir(path));
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickerBusy(false);
    }
  }

  function openWebPicker() {
    setPickerOpen(true);
    setDirListing(null);
    void loadDirectory(repoPath.trim());
  }

  async function selectDirectory(path: string) {
    setRepoPath(path);
    setPickerBusy(true);
    try {
      await fillRepoIdFrom(path);
      setPickerOpen(false);
    } finally {
      setPickerBusy(false);
    }
  }

  function closePicker() {
    setPickerOpen(false);
    setPickerError(null);
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
        <span className="sq-mono sq-switcher__label">{label}</span>
        <span aria-hidden>▾</span>
      </button>

      {open && (
        <>
          <div className="sq-bell__scrim" onClick={() => setOpen(false)} />
          <div className="sq-switcher__popover sq-scroll" role="dialog" aria-label="Switch project">
            <div className="sq-block__label">Attached sessions</div>
            {attached.length > 1 && (
              <button
                type="button"
                className={`sq-switcher__row sq-switcher__row--button${activeAll ? " sq-switcher__row--active" : ""}`}
                onClick={() => void switchTo("all")}
                disabled={busy}
              >
                <span className="sq-switcher__check" aria-hidden>{activeAll ? "✓" : ""}</span>
                <span className="sq-switcher__main">
                  <span className="sq-mono sq-switcher__repo">All projects</span>
                  <span className="sq-mono sq-switcher__meta">Aggregate board, queue, and observability</span>
                </span>
              </button>
            )}
            {attached.length === 0 && (
              <div className="sq-empty">No attached sessions</div>
            )}
            {attached.map((p) => {
              const active = !activeAll && project?.id === p.id;
              return (
                <div key={p.id} className={`sq-switcher__row${active ? " sq-switcher__row--active" : ""}`}>
                  <button
                    type="button"
                    className="sq-switcher__select"
                    onClick={() => void switchTo(p.id)}
                    disabled={busy}
                  >
                    <span className="sq-switcher__check" aria-hidden>{active ? "✓" : ""}</span>
                    <span className="sq-switcher__main">
                      <span className="sq-mono sq-switcher__repo">{p.repo}</span>
                      <span className="sq-mono sq-switcher__meta">{projectSubline(p)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="sq-iconbtn sq-switcher__detach"
                    aria-label={`Detach ${p.repo}`}
                    title={`Detach ${p.repo}`}
                    onClick={() => void detach(p.id)}
                    disabled={busy}
                  >
                    ×
                  </button>
                </div>
              );
            })}

            <div className="sq-block__label">Available sessions</div>
            {discovered.length === 0 && (
              <div className="sq-empty">{busy ? "Discovering…" : "No unattached sessions"}</div>
            )}
            {discovered.map((d) => (
              <div key={d.id} className="sq-switcher__row">
                <span className="sq-switcher__main">
                  <span className="sq-mono sq-switcher__repo">{d.repo}</span>
                  <span className="sq-mono sq-switcher__meta">{projectSubline(d)}</span>
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
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => (isTauri ? void browse() : openWebPicker())}
                  disabled={busy}
                >
                  Browse…
                </button>
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

          {pickerOpen && (
            <DirectoryPicker
              listing={dirListing}
              busy={pickerBusy}
              error={pickerError}
              onOpen={(path) => void loadDirectory(path)}
              onSelect={(path) => void selectDirectory(path)}
              onClose={closePicker}
            />
          )}
        </>
      )}
    </div>
  );
}
