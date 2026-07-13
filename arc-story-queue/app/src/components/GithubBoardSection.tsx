import { useEffect, useState } from "react";
import type { GithubBoardBinding } from "arc-contracts";
import type { BoardStore } from "../lib/boardStore";
import { AsyncButton } from "./AsyncButton";

/** Extract project number from a GitHub Projects URL. */
export function projectNumberFromUrl(url: string): number | null {
  const match = url.trim().match(/\/projects\/(\d+)\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function syncHealthLabel(binding: GithubBoardBinding | null): string {
  if (!binding) return "Not linked";
  if (binding.lastSyncError) return `Sync error: ${binding.lastSyncError}`;
  if (binding.lastSyncedAt) {
    return `Last sync ${new Date(binding.lastSyncedAt).toLocaleString()}`;
  }
  return "Linked · awaiting first sync";
}

interface GithubBoardSectionProps {
  store: BoardStore;
}

export function GithubBoardSection({ store }: GithubBoardSectionProps) {
  const state = store.getState();
  const project = state.project;
  const [binding, setBinding] = useState<GithubBoardBinding | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!project || state.activeProjectId === "all") {
        setBinding(null);
        return;
      }
      try {
        const next = await store.getGithubBoardBinding({ projectId: project.id });
        if (!cancelled) {
          setBinding(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setBinding(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [store, project?.id, state.activeProjectId]);

  if (!project || state.activeProjectId === "all") {
    return (
      <section className="sq-block">
        <div className="sq-block__label">GitHub Project</div>
        <p className="sq-tile__label">Select a single attached repo to link or ensure its Arc Board project.</p>
      </section>
    );
  }

  return (
    <section className="sq-block" aria-label="GitHub Project board">
      <div className="sq-block__label">GitHub Project</div>
      <div className="sq-tiles">
        <div className="sq-tile">
          <div className="sq-mono" style={{ marginBottom: "0.35rem" }}>
            {binding?.githubProjectTitle ?? "No board linked"}
          </div>
          <div className="sq-tile__label">{syncHealthLabel(binding)}</div>
          {binding?.githubProjectUrl && (
            <div style={{ marginTop: "0.5rem" }}>
              <a
                className="sq-mono"
                href={binding.githubProjectUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open on GitHub
              </a>
            </div>
          )}
          {error && (
            <div className="sq-tile__label" role="alert" style={{ marginTop: "0.5rem" }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
            <AsyncButton
              className="btn btn--secondary"
              busy={loading}
              onClick={async () => {
                setLoading(true);
                setError(null);
                try {
                  const next = await store.ensureGithubBoard({
                    projectId: project.id,
                    autoCreate: true,
                  });
                  setBinding(next);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setLoading(false);
                }
              }}
            >
              Ensure board
            </AsyncButton>
          </div>
        </div>
        <div className="sq-tile">
          <div className="sq-tile__label" style={{ marginBottom: "0.5rem" }}>
            Link existing Project URL
          </div>
          <input
            className="sq-mono"
            type="url"
            placeholder="https://github.com/users/…/projects/12"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            aria-label="GitHub Project URL"
            style={{ width: "100%", marginBottom: "0.5rem" }}
          />
          <AsyncButton
            className="btn btn--secondary"
            busy={loading}
            disabled={!linkUrl.trim()}
            onClick={async () => {
              const number = projectNumberFromUrl(linkUrl);
              if (!number) {
                setError("Could not parse a project number from that URL");
                return;
              }
              setLoading(true);
              setError(null);
              try {
                const next = await store.ensureGithubBoard({
                  projectId: project.id,
                  projectNumber: number,
                  autoCreate: false,
                });
                setBinding(next);
                setLinkUrl("");
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setLoading(false);
              }
            }}
          >
            Link URL
          </AsyncButton>
        </div>
      </div>
    </section>
  );
}
