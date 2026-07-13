import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import {
  githubBoardTitleForRepo,
  type Column,
  type GithubBoardBinding,
  type GithubBoardStatusOptionIds,
} from "arc-contracts";

export type GhRunner = (
  file: string,
  args: readonly string[],
  options?: ExecFileSyncOptions
) => string | Buffer;

const BOARD_COLUMNS: Column[] = ["backlog", "queued", "in_progress", "review", "done"];

/** Prefer default Status when options already match columns; otherwise Arc Column. */
export const ARC_COLUMN_FIELD_NAME = "Arc Column";
export const STATUS_FIELD_NAME = "Status";

export interface GithubProjectSummary {
  id: string;
  number: number;
  title: string;
  url: string;
  owner: { login: string; type?: string };
}

interface ProjectFieldOption {
  id: string;
  name: string;
}

interface ProjectField {
  id: string;
  name: string;
  type: string;
  options?: ProjectFieldOption[];
}

function runGh(runner: GhRunner, args: readonly string[]): string {
  const out = runner("gh", args, { encoding: "utf8" });
  return typeof out === "string" ? out : out.toString("utf8");
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`Failed to parse ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** owner/name → owner login used by `gh project --owner`. */
export function ownerFromRepo(repo: string): string {
  const owner = repo.split("/")[0]?.trim();
  if (!owner) throw new Error(`Invalid repo: ${repo}`);
  return owner;
}

export function listGithubProjects(
  owner: string,
  runner: GhRunner = execFileSync
): GithubProjectSummary[] {
  const raw = runGh(runner, [
    "project",
    "list",
    "--owner",
    owner,
    "--format",
    "json",
    "-L",
    "100",
  ]);
  const parsed = parseJson<{ projects: GithubProjectSummary[] }>(raw, "project list");
  return parsed.projects ?? [];
}

export function findGithubProjectByTitle(
  owner: string,
  title: string,
  runner: GhRunner = execFileSync
): GithubProjectSummary | null {
  return listGithubProjects(owner, runner).find((p) => p.title === title) ?? null;
}

export function createGithubProject(
  owner: string,
  title: string,
  runner: GhRunner = execFileSync
): GithubProjectSummary {
  const raw = runGh(runner, [
    "project",
    "create",
    "--owner",
    owner,
    "--title",
    title,
    "--format",
    "json",
  ]);
  return parseJson<GithubProjectSummary>(raw, "project create");
}

export function listGithubProjectFields(
  owner: string,
  projectNumber: number,
  runner: GhRunner = execFileSync
): ProjectField[] {
  const raw = runGh(runner, [
    "project",
    "field-list",
    String(projectNumber),
    "--owner",
    owner,
    "--format",
    "json",
    "-L",
    "50",
  ]);
  const parsed = parseJson<{ fields: ProjectField[] }>(raw, "field list");
  return parsed.fields ?? [];
}

export function createArcColumnField(
  owner: string,
  projectNumber: number,
  runner: GhRunner = execFileSync
): ProjectField {
  const raw = runGh(runner, [
    "project",
    "field-create",
    String(projectNumber),
    "--owner",
    owner,
    "--name",
    ARC_COLUMN_FIELD_NAME,
    "--data-type",
    "SINGLE_SELECT",
    "--single-select-options",
    BOARD_COLUMNS.join(","),
    "--format",
    "json",
  ]);
  return parseJson<ProjectField>(raw, "field create");
}

export function linkGithubProjectToRepo(
  owner: string,
  projectNumber: number,
  repo: string,
  runner: GhRunner = execFileSync
): void {
  runGh(runner, [
    "project",
    "link",
    String(projectNumber),
    "--owner",
    owner,
    "--repo",
    repo,
  ]);
}

function optionMapFromField(field: ProjectField): Partial<GithubBoardStatusOptionIds> | null {
  if (!field.options?.length) return null;
  const byName = new Map(field.options.map((o) => [o.name, o.id]));
  const mapped: Partial<GithubBoardStatusOptionIds> = {};
  let hits = 0;
  for (const column of BOARD_COLUMNS) {
    const id = byName.get(column);
    if (id) {
      mapped[column] = id;
      hits += 1;
    }
  }
  return hits > 0 ? mapped : null;
}

/**
 * Pick Status if it already uses board column option names; else Arc Column
 * (create when missing).
 */
export function resolveStatusField(
  owner: string,
  projectNumber: number,
  fields: ProjectField[],
  runner: GhRunner = execFileSync
): { field: ProjectField; statusOptionIds: Partial<GithubBoardStatusOptionIds>; created: boolean } {
  const status = fields.find(
    (f) => f.name === STATUS_FIELD_NAME && f.type === "ProjectV2SingleSelectField"
  );
  if (status) {
    const mapped = optionMapFromField(status);
    if (mapped && BOARD_COLUMNS.every((c) => mapped[c])) {
      return { field: status, statusOptionIds: mapped, created: false };
    }
  }

  const arc = fields.find(
    (f) => f.name === ARC_COLUMN_FIELD_NAME && f.type === "ProjectV2SingleSelectField"
  );
  if (arc) {
    const mapped = optionMapFromField(arc) ?? {};
    return { field: arc, statusOptionIds: mapped, created: false };
  }

  const created = createArcColumnField(owner, projectNumber, runner);
  const mapped = optionMapFromField(created) ?? {};
  return { field: created, statusOptionIds: mapped, created: true };
}

export interface EnsureGithubBoardArgs {
  repo: string;
  /** Existing binding (from store); used for URL/number shortcuts and autoCreate. */
  existing?: GithubBoardBinding | null;
  /** When true, create the project if missing. Defaults to existing.autoCreate ?? false. */
  autoCreate?: boolean;
  /** Prefer this project number when linking an already-known board. */
  projectNumber?: number;
  runner?: GhRunner;
  /** Skip `gh project link` (tests / already linked). */
  skipLink?: boolean;
}

export interface EnsureGithubBoardResult {
  binding: Omit<GithubBoardBinding, "updatedAt"> & { updatedAt?: number };
  createdProject: boolean;
  createdField: boolean;
}

/**
 * Find or create `Arc Board · <repo>` and resolve Status/Arc Column field IDs.
 * Does not persist — caller writes via `linkGithubBoard`.
 */
export function ensureGithubBoard(args: EnsureGithubBoardArgs): EnsureGithubBoardResult {
  const runner = args.runner ?? execFileSync;
  const owner = ownerFromRepo(args.repo);
  const title = args.existing?.githubProjectTitle ?? githubBoardTitleForRepo(args.repo);
  const autoCreate = args.autoCreate ?? args.existing?.autoCreate ?? false;
  const preferredNumber = args.projectNumber ?? args.existing?.githubProjectNumber;

  let project: GithubProjectSummary | null = null;
  let createdProject = false;

  if (preferredNumber) {
    project =
      listGithubProjects(owner, runner).find((p) => p.number === preferredNumber) ?? null;
  }

  if (!project && args.existing?.githubProjectId) {
    project =
      listGithubProjects(owner, runner).find((p) => p.id === args.existing!.githubProjectId) ??
      null;
  }

  if (!project) {
    project = findGithubProjectByTitle(owner, title, runner);
  }

  if (!project) {
    if (!autoCreate) {
      throw new Error(
        `No GitHub Project titled "${title}" for ${args.repo}. Pass autoCreate: true or link an existing project.`
      );
    }
    project = createGithubProject(owner, title, runner);
    createdProject = true;
  }

  const fields = listGithubProjectFields(owner, project.number, runner);
  const { field, statusOptionIds, created: createdField } = resolveStatusField(
    owner,
    project.number,
    fields,
    runner
  );

  if (!args.skipLink) {
    try {
      linkGithubProjectToRepo(owner, project.number, args.repo, runner);
    } catch {
      // Link is best-effort (already linked / permission); binding still succeeds.
    }
  }

  return {
    createdProject,
    createdField,
    binding: {
      repo: args.repo,
      githubProjectId: project.id,
      githubProjectNumber: project.number,
      githubProjectUrl: project.url,
      githubProjectTitle: project.title,
      statusFieldId: field.id,
      statusOptionIds,
      autoCreate,
      lastSyncError: null,
    },
  };
}

export interface GithubProjectItem {
  id: string;
  title?: string;
  status?: string;
  content?: { url?: string; number?: number; type?: string };
  [key: string]: unknown;
}

const BOARD_COLUMN_SET = new Set<Column>(BOARD_COLUMNS);

/** Map a project item's Status / Arc Column display value to a local column. */
export function columnFromProjectItem(item: GithubProjectItem): Column | null {
  const candidates = [
    item.status,
    item["Arc Column"],
    item["arc column"],
    item.arcColumn,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && BOARD_COLUMN_SET.has(value as Column)) {
      return value as Column;
    }
  }
  return null;
}

/** Resolve story.issue (#N or URL) to a GitHub issue/PR URL for item-add. */
export function issueUrlForStory(repo: string, issue: string | null | undefined): string | null {
  if (!issue) return null;
  const trimmed = issue.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const hash = trimmed.match(/^#(\d+)$/);
  if (hash) return `https://github.com/${repo}/issues/${hash[1]}`;
  if (/^\d+$/.test(trimmed)) return `https://github.com/${repo}/issues/${trimmed}`;
  return null;
}

export function listGithubProjectItems(
  owner: string,
  projectNumber: number,
  runner: GhRunner = execFileSync,
  limit = 200
): GithubProjectItem[] {
  const raw = runGh(runner, [
    "project",
    "item-list",
    String(projectNumber),
    "--owner",
    owner,
    "--format",
    "json",
    "-L",
    String(limit),
  ]);
  const parsed = parseJson<{ items: GithubProjectItem[] }>(raw, "item list");
  return parsed.items ?? [];
}

export function addGithubProjectItem(
  owner: string,
  projectNumber: number,
  url: string,
  runner: GhRunner = execFileSync
): GithubProjectItem {
  const raw = runGh(runner, [
    "project",
    "item-add",
    String(projectNumber),
    "--owner",
    owner,
    "--url",
    url,
    "--format",
    "json",
  ]);
  return parseJson<GithubProjectItem>(raw, "item add");
}

export function setGithubProjectItemStatus(args: {
  projectId: string;
  itemId: string;
  fieldId: string;
  optionId: string;
  runner?: GhRunner;
}): void {
  const runner = args.runner ?? execFileSync;
  runGh(runner, [
    "project",
    "item-edit",
    "--project-id",
    args.projectId,
    "--id",
    args.itemId,
    "--field-id",
    args.fieldId,
    "--single-select-option-id",
    args.optionId,
  ]);
}

export function findProjectItemByIssueUrl(
  items: GithubProjectItem[],
  issueUrl: string
): GithubProjectItem | null {
  const normalized = issueUrl.replace(/\/$/, "").toLowerCase();
  return (
    items.find((item) => item.content?.url?.replace(/\/$/, "").toLowerCase() === normalized) ?? null
  );
}

export interface SyncStoryColumnArgs {
  binding: GithubBoardBinding;
  column: Column;
  issueUrl: string;
  itemId?: string | null;
  runner?: GhRunner;
}

export interface SyncStoryColumnResult {
  itemId: string;
  optionId: string;
}

/**
 * Ensure the issue is on the project and set Arc Column/Status to the local column.
 * Throws on hard failures; callers should catch and record lastSyncError.
 */
export function syncStoryColumnToGithubBoard(args: SyncStoryColumnArgs): SyncStoryColumnResult {
  const runner = args.runner ?? execFileSync;
  const { binding, column, issueUrl } = args;
  if (!binding.githubProjectNumber || !binding.statusFieldId) {
    throw new Error("GitHub board binding is missing project number or status field id");
  }
  const optionId = binding.statusOptionIds?.[column];
  if (!optionId) {
    throw new Error(`GitHub board binding has no Status option for column "${column}"`);
  }

  const owner = ownerFromRepo(binding.repo);
  let itemId = args.itemId ?? null;
  if (!itemId) {
    const items = listGithubProjectItems(owner, binding.githubProjectNumber, runner);
    itemId = findProjectItemByIssueUrl(items, issueUrl)?.id ?? null;
  }
  if (!itemId) {
    itemId = addGithubProjectItem(owner, binding.githubProjectNumber, issueUrl, runner).id;
  }

  setGithubProjectItemStatus({
    projectId: binding.githubProjectId,
    itemId,
    fieldId: binding.statusFieldId,
    optionId,
    runner,
  });

  return { itemId, optionId };
}
