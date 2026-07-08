import type { Project } from "arc-contracts";
import type { ProjectScope } from "./boardState";

export interface BoardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PersistedProjectAttachment {
  repo: string;
  path: string;
  branch: string;
  model: string;
}

export interface PersistedProjectAttachmentState {
  projects: PersistedProjectAttachment[];
  active: "all" | { repo: string; path: string } | null;
}

export const LAST_PROJECT_STORAGE_KEY = "arc-story-queue:last-project";

export function defaultStorage(): BoardStorage | null {
  const globals = globalThis as typeof globalThis & { localStorage?: Partial<BoardStorage> };
  try {
    const storage = globals.localStorage;
    if (
      storage &&
      typeof storage.getItem === "function" &&
      typeof storage.setItem === "function" &&
      typeof storage.removeItem === "function"
    ) {
      return storage as BoardStorage;
    }
  } catch {
    // Storage access can throw in restricted browser contexts.
  }
  return null;
}

function isPersistedAttachment(value: Partial<PersistedProjectAttachment>): value is PersistedProjectAttachment {
  return (
    typeof value.repo === "string" &&
    typeof value.path === "string" &&
    typeof value.branch === "string" &&
    typeof value.model === "string"
  );
}

export function readAttachmentState(storage: BoardStorage | null): PersistedProjectAttachmentState | null {
  const raw = storage?.getItem(LAST_PROJECT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedProjectAttachmentState> & Partial<PersistedProjectAttachment>;
    if (Array.isArray(parsed.projects)) {
      const projects = parsed.projects.filter((p): p is PersistedProjectAttachment => isPersistedAttachment(p));
      if (projects.length > 0) {
        const active = parsed.active === "all" || parsed.active === null
          ? parsed.active
          : parsed.active && typeof parsed.active.repo === "string" && typeof parsed.active.path === "string"
            ? { repo: parsed.active.repo, path: parsed.active.path }
            : null;
        return { projects, active };
      }
    }
    if (isPersistedAttachment(parsed)) {
      return { projects: [parsed], active: { repo: parsed.repo, path: parsed.path } };
    }
  } catch {
    // Malformed persisted state should not block the connect flow.
  }
  storage?.removeItem(LAST_PROJECT_STORAGE_KEY);
  return null;
}

export function persistAttachmentState(
  storage: BoardStorage | null,
  projects: Project[],
  activeProjectId: ProjectScope,
  activeProject: Project | null
): void {
  if (projects.length === 0) {
    storage?.removeItem(LAST_PROJECT_STORAGE_KEY);
    return;
  }
  const persistedProjects = projects.map(({ repo, path, branch, model }) => ({ repo, path, branch, model }));
  const active = activeProjectId === "all"
    ? "all"
    : activeProject
      ? { repo: activeProject.repo, path: activeProject.path }
      : null;
  storage?.setItem(LAST_PROJECT_STORAGE_KEY, JSON.stringify({ projects: persistedProjects, active }));
}

export function clearAttachmentState(storage: BoardStorage | null): void {
  storage?.removeItem(LAST_PROJECT_STORAGE_KEY);
}
