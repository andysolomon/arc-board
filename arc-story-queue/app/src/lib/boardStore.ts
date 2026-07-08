import {
  ROUTE_ORDER,
  normalizeStory,
  routeAccess as contractRouteAccess,
  routeColor as contractRouteColor,
  routeLabel as contractRouteLabel,
  routeModel as contractRouteModel,
  type Access,
  type AppConfig,
  type Column,
  type FsDirListing,
  type IntakeDraftProposal,
  type IntakeDraftSource,
  type IntakeGenerateResult,
  type IntakeItem,
  type IntakeKind,
  type KnownProject,
  type Project,
  type RouteId,
  type RunRecord,
  type Story,
  type StoryDetail,
} from "arc-contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  criteriaFromScenarios,
  generateDraftProposals as pipelineGenerateDraftProposals,
  planDedupe,
  planSplit,
  planTighten,
  slug,
  type ModelComplete,
  type ModelCompleteArgs,
} from "./intakePipeline";

export type { ModelComplete, ModelCompleteArgs } from "./intakePipeline";

export const BOARD_COLUMNS: Column[] = ["backlog", "queued", "in_progress", "review", "done"];

export const COLUMN_LABELS: Record<Column, string> = {
  backlog: "Backlog",
  queued: "Queued",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

export interface TerminalLine {
  kind: "cmd" | "out" | "ok" | "lock" | "unlock";
  text: string;
  route: string;
}

export type LaneStatus = "running" | "done";

export interface WorkerLane {
  route: string;
  status: LaneStatus;
  lines: TerminalLine[];
  lastUpdateAt?: number;
}

export interface BoardStory extends Story {
  lines: TerminalLine[];
  lanes: Record<string, WorkerLane>;
  activeRoute?: string;
  lastWorkerUpdateAt?: number;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export type ToastKind = "info" | "success" | "error";
export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}
export interface ActivityMeta {
  icon: string;
  subject: string;
  text: string;
  tone: string;
}

export interface ActivityItem extends ActivityMeta {
  id: string;
  message: string;
  ts: number;
  read: boolean;
}

export interface AppNotification extends Toast {
  ts: number;
  read: boolean;
  activity: ActivityMeta;
}

export type RefineAction = "split" | "tighten" | "dedupe";

export interface RefineResult {
  action: RefineAction;
  source: IntakeDraftSource;
  note: string;
  story: Story;
  children: Story[];
}

export interface BoardStoreOptions {
  storage?: BoardStorage | null;
  modelComplete?: ModelComplete | null;
  mcpFetch?: FetchLike | null;
}

export type ProjectScope = "all" | string | null;

export interface BoardState {
  status: ConnectionStatus;
  project: Project | null;
  projects: Project[];
  activeProjectId: ProjectScope;
  stories: Record<string, BoardStory>;
  trackedIds: string[];
  runs: RunRecord[];
  queueOrder: string[];
  config: AppConfig;
  detail: StoryDetail | null;
  intake: IntakeItem[];
  toasts: Toast[];
  notifications: AppNotification[];
  error?: string;
}

export interface StoryUpdateEvent {
  type: "story.update";
  id: string;
  route: string;
  line?: Omit<TerminalLine, "route"> & { route?: string };
  lane?: { route: string; status: LaneStatus };
}

export type LifecycleKind =
  | "queued"
  | "started"
  | "review"
  | "done"
  | "abandoned"
  | "unqueued"
  | "drafted"
  | "file-requested"
  | "filed"
  | "merged"
  | "escalated";

export interface StoryLifecycleEvent {
  type: "story.event";
  kind: LifecycleKind;
  id: string;
  wid?: string;
  title?: string;
  column?: string;
}

export interface SessionRegisterArgs {
  repo: string;
  path: string;
  branch: string;
  model: string;
  pid: number;
}

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

interface PersistedProjectAttachmentState {
  projects: PersistedProjectAttachment[];
  active: "all" | { repo: string; path: string } | null;
}

export const LAST_PROJECT_STORAGE_KEY = "arc-story-queue:last-project";

function defaultStorage(): BoardStorage | null {
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

function parseToolResult<T>(result: unknown): T {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (r.isError) throw new Error(text ?? "MCP tool returned an error");
  if (!text) throw new Error("No text content in tool result");
  try {
    return JSON.parse(text) as T;
  } catch {
    // Non-JSON payload (e.g. a raw daemon error) — surface the text itself
    // instead of a misleading "JSON Parse error".
    throw new Error(text);
  }
}

function defaultModelComplete(): ModelComplete | null {
  const globals = globalThis as typeof globalThis & {
    claude?: { complete?: ModelComplete };
  };
  return typeof globals.claude?.complete === "function" ? globals.claude.complete : null;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function resolveTauriHttpFetch(): Promise<FetchLike | null> {
  if (!isTauriRuntime()) return null;
  const mod = (await import("@tauri-apps/plugin-http")) as unknown as { fetch?: FetchLike };
  if (typeof mod.fetch !== "function") throw new Error("tauri-plugin-http fetch is unavailable");
  return mod.fetch;
}

function laneFromRoute(route: string): WorkerLane {
  return { route, status: "running", lines: [] };
}

function defaultActivityMeta(kind: ToastKind, message: string): ActivityMeta {
  const icon: Record<ToastKind, string> = {
    info: "•",
    success: "✓",
    error: "!",
  };
  return { icon: icon[kind], subject: message, text: "", tone: kind };
}

function lifecycleActivityLabel(evt: StoryLifecycleEvent): string {
  const title = evt.title ?? evt.id;
  return evt.wid ? `${evt.wid} — “${title}”` : `“${title}”`;
}

function lifecycleActivityMeta(evt: StoryLifecycleEvent): ActivityMeta {
  const label = lifecycleActivityLabel(evt);
  const map: Record<LifecycleKind, ActivityMeta> = {
    queued: { icon: "➕", subject: "Queue", text: `queued ${label}`, tone: "queued" },
    started: { icon: "◈", subject: "Fable", text: `started ${label}`, tone: "started" },
    review: { icon: "◇", subject: "Fable", text: `moved ${label} to review`, tone: "review" },
    done: { icon: "✓", subject: "Fable", text: `completed ${label}`, tone: "done" },
    abandoned: { icon: "↯", subject: "Fable", text: `abandoned ${label}`, tone: "abandoned" },
    unqueued: { icon: "↩", subject: "Queue", text: `moved ${label} back to backlog`, tone: "unqueued" },
    drafted: { icon: "✎", subject: "Fable", text: `drafted ${label}`, tone: "drafted" },
    "file-requested": { icon: "⇢", subject: "You", text: `asked Fable to file ${label}`, tone: "file-requested" },
    filed: { icon: "⊕", subject: "Fable", text: `filed ${label}`, tone: "filed" },
    merged: { icon: "✓", subject: "You", text: `merged ${label}`, tone: "merged" },
    escalated: { icon: "↥", subject: "Fable", text: `escalated ${label}`, tone: "escalated" },
  };
  return map[evt.kind];
}

function lanesFromLines(lines: TerminalLine[]): Record<string, WorkerLane> {
  return lines.reduce<Record<string, WorkerLane>>((acc, line) => {
    const lane = acc[line.route] ?? laneFromRoute(line.route);
    acc[line.route] = { ...lane, lines: [...lane.lines, line] };
    return acc;
  }, {});
}

function toBoardStory(story: Story, existing?: BoardStory): BoardStory {
  const lines = existing?.lines ?? [];
  return {
    ...story,
    lines,
    lanes: existing?.lanes ?? lanesFromLines(lines),
    activeRoute: existing?.activeRoute,
    lastWorkerUpdateAt: existing?.lastWorkerUpdateAt,
  };
}

export function createInitialBoardState(): BoardState {
  return {
    status: "disconnected",
    project: null,
    projects: [],
    activeProjectId: null,
    stories: {},
    trackedIds: [],
    runs: [],
    queueOrder: [],
    config: { autoRun: false, maxParallel: 2 },
    detail: null,
    intake: [],
    toasts: [],
    notifications: [],
  };
}

export function upsertStoryInState(state: BoardState, story: Story): BoardState {
  const existing = state.stories[story.id];
  const boardStory = toBoardStory(story, existing);
  const stories = {
    ...state.stories,
    [story.id]: boardStory,
  };
  const trackedIds = state.trackedIds.includes(story.id)
    ? state.trackedIds
    : [...state.trackedIds, story.id];
  const detail = state.detail?.story.id === story.id ? { ...state.detail, story: boardStory } : state.detail;
  return { ...state, stories, trackedIds, detail };
}

export function applyStoryUpdate(state: BoardState, event: StoryUpdateEvent): BoardState {
  const existing = state.stories[event.id];
  const base: BoardStory = existing ?? {
    id: event.id,
    wid: "W-000000",
    type: "story",
    title: event.id,
    repo: state.project?.repo ?? "",
    branch: "",
    worktree: "",
    column: "in_progress",
    priority: "med",
    size: "S",
    epic: "",
    taskClass: "feature",
    tags: [],
    description: "",
    criteria: [],
    draft: false,
    lines: [],
    lanes: {},
  };

  const route = event.lane?.route ?? event.line?.route ?? event.route;
  const line = event.line ? { ...event.line, route } : undefined;
  const now = Date.now();
  const lines = line ? [...base.lines, line] : base.lines;
  const existingLanes = base.lanes ?? lanesFromLines(base.lines);
  const currentLane = existingLanes[route] ?? laneFromRoute(route);
  const lane: WorkerLane = {
    ...currentLane,
    status: event.lane?.status ?? (line ? "running" : currentLane.status),
    lines: line ? [...currentLane.lines, line] : currentLane.lines,
    lastUpdateAt: line ? now : currentLane.lastUpdateAt,
  };
  const updatedStory: BoardStory = {
    ...base,
    activeRoute: route,
    lines,
    lanes: { ...existingLanes, [route]: lane },
    lastWorkerUpdateAt: line ? now : base.lastWorkerUpdateAt,
  };
  const stories = {
    ...state.stories,
    [event.id]: updatedStory,
  };
  const trackedIds = state.trackedIds.includes(event.id)
    ? state.trackedIds
    : [...state.trackedIds, event.id];
  const detail = state.detail?.story.id === event.id ? { ...state.detail, story: updatedStory } : state.detail;

  return { ...state, stories, trackedIds, detail };
}

function projectIdentity(project: Pick<Project, "repo" | "path">): string {
  return `${project.repo}\u0000${project.path}`;
}

function activeRepoFilter(state: BoardState, repo?: string): ((story: { repo: string }) => boolean) {
  if (repo) return (story) => story.repo === repo;
  if (state.activeProjectId === "all") {
    const repos = new Set(state.projects.map((project) => project.repo));
    return (story) => repos.has(story.repo);
  }
  if (state.project) return (story) => story.repo === state.project!.repo;
  return () => state.projects.length === 0 && state.activeProjectId === null;
}

export function storiesForColumn(state: BoardState, column: Column, repo?: string): BoardStory[] {
  const matchesRepo = activeRepoFilter(state, repo);
  return Object.values(state.stories)
    .filter((s) => s.column === column && matchesRepo(s))
    .sort((a, b) => a.wid.localeCompare(b.wid));
}

export function hasLiveWorker(story: BoardStory, now = Date.now(), recencyMs = 30_000): boolean {
  if (story.column !== "in_progress") return false;
  return Object.values(story.lanes).some(
    (lane) =>
      lane.status === "running" &&
      lane.lines.length > 0 &&
      lane.lastUpdateAt !== undefined &&
      now - lane.lastUpdateAt <= recencyMs
  );
}

export function liveWorkerCount(state: BoardState, now = Date.now(), recencyMs = 30_000): number {
  return storiesForColumn(state, "in_progress").filter((story) =>
    hasLiveWorker(story, now, recencyMs)
  ).length;
}

export function reservedWorkerCount(state: BoardState, now = Date.now(), recencyMs = 30_000): number {
  return storiesForColumn(state, "in_progress").filter(
    (story) => !hasLiveWorker(story, now, recencyMs)
  ).length;
}

export type BoardListener = (state: BoardState) => void;

export class BoardStore {
  private state: BoardState = createInitialBoardState();
  private listeners = new Set<BoardListener>();
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private notifySeq = 0;
  private detailRefreshSeq = 0;
  private readonly storage: BoardStorage | null;
  private readonly modelComplete: ModelComplete | null;
  private readonly mcpFetch: FetchLike | null;

  constructor(
    private readonly mcpUrl: string,
    storageOrOptions?: BoardStorage | null | BoardStoreOptions
  ) {
    const looksLikeOptions =
      storageOrOptions !== null &&
      typeof storageOrOptions === "object" &&
      ("storage" in storageOrOptions || "modelComplete" in storageOrOptions || "mcpFetch" in storageOrOptions);
    const options = looksLikeOptions ? (storageOrOptions as BoardStoreOptions) : undefined;
    this.storage = options
      ? options.storage === undefined ? defaultStorage() : options.storage
      : storageOrOptions === undefined ? defaultStorage() : (storageOrOptions as BoardStorage | null);
    this.modelComplete = options?.modelComplete === undefined ? defaultModelComplete() : options.modelComplete;
    this.mcpFetch = options?.mcpFetch === undefined ? null : options.mcpFetch;
  }

  getState(): BoardState {
    return this.state;
  }

  subscribe(listener: BoardListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  private patch(partial: Partial<BoardState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private reduce(mutator: (state: BoardState) => BoardState): void {
    this.state = mutator(this.state);
    this.emit();
  }

  private isPersistedAttachment(value: Partial<PersistedProjectAttachment>): value is PersistedProjectAttachment {
    return (
      typeof value.repo === "string" &&
      typeof value.path === "string" &&
      typeof value.branch === "string" &&
      typeof value.model === "string"
    );
  }

  private readLastAttachmentState(): PersistedProjectAttachmentState | null {
    const raw = this.storage?.getItem(LAST_PROJECT_STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedProjectAttachmentState> & Partial<PersistedProjectAttachment>;
      if (Array.isArray(parsed.projects)) {
        const projects = parsed.projects.filter((p): p is PersistedProjectAttachment => this.isPersistedAttachment(p));
        if (projects.length > 0) {
          const active = parsed.active === "all" || parsed.active === null
            ? parsed.active
            : parsed.active && typeof parsed.active.repo === "string" && typeof parsed.active.path === "string"
              ? { repo: parsed.active.repo, path: parsed.active.path }
              : null;
          return { projects, active };
        }
      }
      if (this.isPersistedAttachment(parsed)) {
        return { projects: [parsed], active: { repo: parsed.repo, path: parsed.path } };
      }
    } catch {
      // Malformed persisted state should not block the connect flow.
    }
    this.storage?.removeItem(LAST_PROJECT_STORAGE_KEY);
    return null;
  }

  private persistAttachmentState(): void {
    if (this.state.projects.length === 0) {
      this.storage?.removeItem(LAST_PROJECT_STORAGE_KEY);
      return;
    }
    const projects = this.state.projects.map(({ repo, path, branch, model }) => ({ repo, path, branch, model }));
    const active = this.state.activeProjectId === "all"
      ? "all"
      : this.state.project
        ? { repo: this.state.project.repo, path: this.state.project.path }
        : null;
    this.storage?.setItem(LAST_PROJECT_STORAGE_KEY, JSON.stringify({ projects, active }));
  }

  private clearLastAttachment(): void {
    this.storage?.removeItem(LAST_PROJECT_STORAGE_KEY);
  }

  private async restoreLastAttachment(): Promise<void> {
    if (this.state.projects.length > 0) return;
    const saved = this.readLastAttachmentState();
    if (!saved) return;

    const restored: Project[] = [];
    const failures: string[] = [];
    for (const attachment of saved.projects) {
      try {
        const project = await this.registerAndAttach({ ...attachment, pid: 0 }, { persist: false });
        restored.push(project);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${attachment.repo}: ${msg}`);
      }
    }

    if (restored.length === 0) {
      const error = `Unable to restore last project (${saved.projects.map((p) => p.repo).join(", ")}): ${failures.join("; ")}. Attach a project to continue.`;
      this.clearLastAttachment();
      this.patch({ project: null, projects: [], activeProjectId: null, error });
      this.notify("error", error);
      return;
    }

    if (saved.active === "all" && restored.length > 1) {
      await this.selectProject("all", { persist: false });
    } else if (saved.active && saved.active !== "all") {
      const savedActive = saved.active;
      const active = this.state.projects.find((project) => project.repo === savedActive.repo && project.path === savedActive.path);
      if (active) await this.selectProject(active.id, { persist: false });
    }
    this.persistAttachmentState();
    this.notify("success", `Restored ${restored.length === 1 ? restored[0].repo : `${restored.length} projects`}`);
    if (failures.length > 0) {
      this.notify("error", `Some projects could not be restored: ${failures.join("; ")}`);
    }
  }

  /**
   * A coarse lifecycle event arrived over SSE (from this or any other session).
   * This is the single source of activity notifications; it also refreshes so
   * cross-client boards reflect work done elsewhere.
   */
  private handleLifecycleEvent(evt: StoryLifecycleEvent): void {
    const label = evt.wid ? `${evt.wid} — ${evt.title ?? evt.id}` : evt.title ?? evt.id;
    const map: Record<LifecycleKind, { kind: ToastKind; msg: string }> = {
      queued: { kind: "info", msg: `Queued ${label}` },
      started: { kind: "info", msg: `Started ${label}` },
      review: { kind: "success", msg: `Review ready: ${label}` },
      done: { kind: "success", msg: `Merged ${label}` },
      abandoned: { kind: "info", msg: `Abandoned ${label}` },
      unqueued: { kind: "info", msg: `Moved ${label} to backlog` },
      drafted: { kind: "success", msg: `Drafted ${label}` },
      "file-requested": { kind: "info", msg: `Filing requested: ${label}` },
      filed: { kind: "success", msg: `Filed ${label}` },
      merged: { kind: "success", msg: `Merged ${label}` },
      escalated: { kind: "info", msg: `Escalated ${label}` },
    };
    const m = map[evt.kind];
    if (m) this.notify(m.kind, m.msg, lifecycleActivityMeta(evt));
    const openDetailId = this.state.detail?.story.id;
    const refresh = this.state.project || this.state.projects.length > 0
      ? this.refreshViews()
      : Promise.resolve();
    void refresh
      .then(() => {
        if (openDetailId === evt.id && this.state.detail?.story.id === evt.id) {
          return this.refreshOpenDetail(evt.id);
        }
        return null;
      })
      .catch(() => undefined);
  }

  async connect(): Promise<void> {
    if (this.state.status === "connected" || this.state.status === "connecting") return;
    this.patch({ status: "connecting", error: undefined });

    try {
      const mcpFetch = this.mcpFetch ?? (await resolveTauriHttpFetch());
      this.transport = new StreamableHTTPClientTransport(
        new URL(this.mcpUrl),
        mcpFetch ? { fetch: mcpFetch } : undefined
      );
      this.client = new Client({ name: "arc-story-queue-board", version: "0.1.0" });
      this.client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        const raw = notification.params?.data;
        if (typeof raw !== "string") return;
        try {
          const parsed = JSON.parse(raw) as { type?: string };
          if (parsed.type === "story.update") {
            this.reduce((state) => applyStoryUpdate(state, parsed as StoryUpdateEvent));
          } else if (parsed.type === "story.event") {
            this.handleLifecycleEvent(parsed as StoryLifecycleEvent);
          }
        } catch {
          // ignore non-JSON log lines
        }
      });
      await this.client.connect(this.transport);
      this.patch({ status: "connected" });
      await this.restoreLastAttachment();
    } catch (err) {
      this.patch({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
    this.client = null;
    this.transport = null;
    this.state = createInitialBoardState();
    this.emit();
  }

  private ensureClient(): Client {
    if (!this.client || this.state.status !== "connected") {
      throw new Error("Board store is not connected");
    }
    return this.client;
  }

  async discover(): Promise<Project[]> {
    const client = this.ensureClient();
    const result = await client.callTool({ name: "project.discover", arguments: {} }, CallToolResultSchema);
    return parseToolResult<Project[]>(result);
  }

  async listKnownProjects(): Promise<KnownProject[]> {
    const client = this.ensureClient();
    const result = await client.callTool({ name: "projects.known.list", arguments: {} }, CallToolResultSchema);
    return parseToolResult<KnownProject[]>(result);
  }

  async forgetKnownProject(path: string): Promise<boolean> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "projects.known.forget", arguments: { path } },
      CallToolResultSchema
    );
    return parseToolResult<{ forgotten: boolean }>(result).forgotten;
  }

  /** List daemon-host directories within the daemon's allowed filesystem root. */
  async listDir(path = ""): Promise<FsDirListing> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "fs.listDir", arguments: { path } },
      CallToolResultSchema
    );
    return parseToolResult<FsDirListing>(result);
  }

  /** Derive owner/name from a local repo's git origin remote (empty if none). */
  async detectRepoId(path: string): Promise<{ repoId: string | null; remote: string | null }> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "git.repoId", arguments: { path } },
      CallToolResultSchema
    );
    return parseToolResult<{ repoId: string | null; remote: string | null }>(result);
  }

  private async safeHydrate(): Promise<void> {
    try {
      await this.refreshViews();
    } catch (err) {
      console.error("hydrate failed:", err);
    }
  }

  /** Import a repo's open GitHub issues as backlog stories (via the daemon's gh bridge). */
  async importIssues(repo: string): Promise<Story[]> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "github.import", arguments: { repo } },
      CallToolResultSchema
    );
    const stories = parseToolResult<Story[]>(result);
    this.reduce((state) => stories.reduce((s, st) => upsertStoryInState(s, st), state));
    await this.refreshViews();
    this.notify(
      stories.length > 0 ? "success" : "info",
      `Imported ${stories.length} issue(s) from ${repo}`
    );
    return stories;
  }

  /** Pull every data set the views render: stories, queue order, runs, config, intake. */
  private projectListWith(project: Project): Project[] {
    const identity = projectIdentity(project);
    return [
      ...this.state.projects.filter((existing) => existing.id !== project.id && projectIdentity(existing) !== identity),
      project,
    ];
  }

  private activeProjectArgs(): { projectId?: string } | null {
    if (this.state.activeProjectId === "all") return {};
    if (this.state.project) return { projectId: this.state.project.id };
    return null;
  }

  async refreshViews(): Promise<void> {
    if (!this.activeProjectArgs()) {
      await Promise.all([this.loadConfig(), this.loadIntake()]);
      return;
    }
    await this.hydrate();
    await Promise.all([this.loadQueue(), this.loadRuns(), this.loadConfig(), this.loadIntake()]);
  }

  async loadIntake(): Promise<void> {
    const client = this.ensureClient();
    const result = await client.callTool({ name: "intake.list", arguments: {} }, CallToolResultSchema);
    this.patch({ intake: parseToolResult<IntakeItem[]>(result) });
  }

  async enqueueIntake(args: { kind: IntakeKind; title: string; description: string }): Promise<IntakeItem> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "intake.enqueue", arguments: args },
      CallToolResultSchema
    );
    const item = parseToolResult<IntakeItem>(result);
    await this.loadIntake();
    return item;
  }

  /** Deterministic fallback: template a pending intake item into a backlog draft. */
  async draftIntake(id: string): Promise<Story> {
    const project = this.state.project;
    if (!project) throw new Error("No project attached");
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "intake.draft", arguments: { id, projectId: project.id } },
      CallToolResultSchema
    );
    const story = parseToolResult<Story>(result);
    this.reduce((state) => upsertStoryInState(state, story));
    await Promise.all([this.loadIntake(), this.hydrate()]);
    return story;
  }

  /** New Story convenience: enqueue then immediately draft (no-Fable fallback path). */
  async createDraftNow(args: { kind: IntakeKind; title: string; description: string }): Promise<Story> {
    const item = await this.enqueueIntake(args);
    return this.draftIntake(item.id);
  }

  /** Intake request → proposal, delegated to the intake pipeline adapter. */
  async generateDraftProposals(args: { kind: IntakeKind; text: string }): Promise<IntakeGenerateResult> {
    return pipelineGenerateDraftProposals(
      { modelComplete: this.modelComplete, project: this.state.project },
      args
    );
  }

  private localDraftFromProposal(proposal: IntakeDraftProposal, repo: string): Story {
    const titleSlug = slug(proposal.title).slice(0, 40);
    return {
      id: `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      wid: "W-000000",
      type: proposal.type,
      title: proposal.title,
      repo,
      branch: `draft/${titleSlug}`,
      worktree: "",
      column: "backlog",
      priority: proposal.priority,
      size: proposal.size,
      epic: proposal.epic,
      taskClass: proposal.taskClass,
      tags: proposal.tags ?? [],
      description: proposal.description,
      criteria: proposal.criteria,
      scenarios: proposal.scenarios,
      draft: true,
      issue: null,
      bug: proposal.bug,
      slice: proposal.slice,
    };
  }

  private async saveStory(story: Story): Promise<Story> {
    const persistedStory = normalizeStory(story);
    if (this.client && this.state.status === "connected") {
      const result = await this.client.callTool(
        { name: "story.save", arguments: { story: persistedStory } },
        CallToolResultSchema
      );
      const saved = parseToolResult<Story>(result);
      this.updateStoryAndDetail(saved);
      return saved;
    }
    this.updateStoryAndDetail(persistedStory);
    return persistedStory;
  }

  private async createRefineChildren(proposals: IntakeDraftProposal[], repo: string): Promise<Story[]> {
    if (proposals.length === 0) return [];
    if (this.state.project && this.client && this.state.status === "connected") {
      return this.createDraftsFromProposals(proposals);
    }
    const stories = proposals.map((proposal) => this.localDraftFromProposal(proposal, repo));
    this.reduce((state) => stories.reduce((s, story) => upsertStoryInState(s, story), state));
    return stories;
  }

  /**
   * Refine a backlog story via the intake pipeline adapter. The pipeline owns
   * all prompt construction and model JSON normalization; the board only
   * persists the plan (saveStory / createRefineChildren) and notifies.
   */
  async refineStory(id: string, action: RefineAction): Promise<RefineResult> {
    const story = this.state.stories[id] ?? await this.refreshStory(id);
    if (!story) throw new Error(`Unknown story: ${id}`);
    if (story.column !== "backlog") throw new Error("Only backlog stories can be refined");

    const deps = { modelComplete: this.modelComplete, project: this.state.project };

    if (action === "split") {
      const plan = await planSplit(deps, story);
      const saved = await this.saveStory(plan.story);
      const children = await this.createRefineChildren([plan.child], story.repo);
      this.notify("success", `Split ${story.wid} into ${children.length + 1} stories`);
      return { action, source: plan.source, note: plan.note, story: saved, children };
    }

    if (action === "tighten") {
      const plan = await planTighten(deps, story);
      const saved = await this.saveStory({
        ...story,
        criteria: criteriaFromScenarios(plan.scenarios),
        scenarios: plan.scenarios,
      });
      this.notify("success", `Tightened criteria for ${story.wid}`);
      return { action, source: plan.source, note: plan.note, story: saved, children: [] };
    }

    const siblings = Object.values(this.state.stories).filter((s) => s.id !== story.id && s.repo === story.repo);
    const plan = await planDedupe(deps, story, siblings);
    this.notify("info", `Checked duplicates for ${story.wid}`);
    return { action, source: plan.source, note: plan.note, story, children: [] };
  }

  async createDraftsFromProposals(drafts: IntakeDraftProposal[]): Promise<Story[]> {
    const project = this.state.project;
    if (!project) throw new Error("No project attached");
    const selected = drafts.filter((draft) => draft.include);
    if (selected.length === 0) return [];
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "intake.createDrafts", arguments: { projectId: project.id, drafts: selected } },
      CallToolResultSchema
    );
    const stories = parseToolResult<Story[]>(result);
    this.reduce((state) => stories.reduce((s, story) => upsertStoryInState(s, story), state));
    await this.hydrate();
    this.notify("success", `Added ${stories.length} draft${stories.length === 1 ? "" : "s"} to Backlog`);
    return stories;
  }

  getIntake(): IntakeItem[] {
    return this.state.intake;
  }

  async hydrate(): Promise<void> {
    const args = this.activeProjectArgs();
    if (!args) throw new Error("No project attached");
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "stories.list", arguments: args },
      CallToolResultSchema
    );
    const stories = parseToolResult<Story[]>(result);
    this.reduce((state) =>
      stories.reduce((s, story) => upsertStoryInState(s, story), state)
    );
  }

  async enqueueStory(id: string): Promise<Story> {
    const client = this.ensureClient();
    let result: unknown;
    try {
      result = await client.callTool(
        { name: "story.enqueue", arguments: { id } },
        CallToolResultSchema
      );
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "Failed to enqueue story");
    }
    const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = r.content?.find((c) => c.type === "text")?.text;
    if (r.isError) {
      throw new Error(text ?? "Failed to enqueue story");
    }
    const story = parseToolResult<Story>(result);
    this.reduce((state) => upsertStoryInState(state, story));
    await this.loadQueue();
    return story;
  }

  async registerAndAttach(
    args: SessionRegisterArgs,
    options: { persist?: boolean } = {}
  ): Promise<Project> {
    const client = this.ensureClient();
    const reg = await client.callTool(
      { name: "session.register", arguments: { ...args } },
      CallToolResultSchema
    );
    const session = parseToolResult<{ id: string }>(reg);
    const attach = await client.callTool(
      { name: "project.attach", arguments: { sessionId: session.id } },
      CallToolResultSchema
    );
    const project = parseToolResult<Project>(attach);
    this.patch({
      project,
      projects: this.projectListWith(project),
      activeProjectId: project.id,
      error: undefined,
    });
    if (options.persist !== false) this.persistAttachmentState();
    await this.safeHydrate();
    return project;
  }

  async attachSession(sessionId: string): Promise<Project> {
    const client = this.ensureClient();
    const attach = await client.callTool(
      { name: "project.attach", arguments: { sessionId } },
      CallToolResultSchema
    );
    const project = parseToolResult<Project>(attach);
    this.patch({
      project,
      projects: this.projectListWith(project),
      activeProjectId: project.id,
      error: undefined,
    });
    this.persistAttachmentState();
    await this.safeHydrate();
    return project;
  }

  async selectProject(scope: Exclude<ProjectScope, null>, options: { persist?: boolean } = {}): Promise<void> {
    if (scope === "all") {
      if (this.state.projects.length === 0) throw new Error("No projects attached");
      this.patch({ project: null, activeProjectId: "all", detail: null, error: undefined });
    } else {
      const project = this.state.projects.find((p) => p.id === scope);
      if (!project) throw new Error(`Unknown project: ${scope}`);
      this.patch({ project, activeProjectId: project.id, detail: null, error: undefined });
    }
    if (options.persist !== false) this.persistAttachmentState();
    await this.refreshViews();
  }

  async detachProject(projectId: string): Promise<Project> {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    const client = this.ensureClient();
    const detach = await client.callTool(
      { name: "project.detach", arguments: { projectId } },
      CallToolResultSchema
    );
    const detached = parseToolResult<Project>(detach);
    const projects = this.state.projects.filter((p) => p.id !== projectId);
    const activeWasDetached = this.state.project?.id === projectId;
    const nextProject = projects.length === 0
      ? null
      : activeWasDetached
        ? projects[0]
        : this.state.project;
    const activeProjectId: ProjectScope = projects.length === 0
      ? null
      : activeWasDetached
        ? nextProject!.id
        : this.state.activeProjectId;
    const storyIdsToRemove = new Set(
      Object.values(this.state.stories)
        .filter((story) => story.repo === project.repo)
        .map((story) => story.id)
    );
    const stories = Object.fromEntries(
      Object.entries(this.state.stories).filter(([id]) => !storyIdsToRemove.has(id))
    ) as Record<string, BoardStory>;
    this.patch({
      project: nextProject,
      projects,
      activeProjectId,
      stories,
      queueOrder: this.state.queueOrder.filter((id) => !storyIdsToRemove.has(id)),
      runs: this.state.runs.filter((run) => run.repo !== project.repo),
      detail: this.state.detail?.story.repo === project.repo ? null : this.state.detail,
    });
    this.persistAttachmentState();
    if (projects.length > 0) await this.refreshViews();
    return detached;
  }

  trackStory(id: string): void {
    if (this.state.trackedIds.includes(id)) return;
    this.patch({ trackedIds: [...this.state.trackedIds, id] });
  }

  async refreshStory(id: string): Promise<BoardStory | null> {
    const client = this.ensureClient();
    const result = await client.callTool({ name: "story.get", arguments: { id } }, CallToolResultSchema);
    const story = parseToolResult<Story | null>(result);
    if (!story) return null;
    this.reduce((state) => upsertStoryInState(state, story));
    return this.state.stories[id] ?? null;
  }

  async refreshTrackedStories(): Promise<void> {
    for (const id of this.state.trackedIds) {
      await this.refreshStory(id);
    }
  }

  async queueNext(): Promise<Story | null> {
    const project = this.state.project;
    if (!project) throw new Error("No project attached");
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "queue.next", arguments: { projectId: project.id } },
      CallToolResultSchema
    );
    const story = parseToolResult<Story | null>(result);
    if (story) this.reduce((state) => upsertStoryInState(state, story));
    await this.loadQueue();
    return story;
  }

  async loadQueue(): Promise<void> {
    const args = this.activeProjectArgs();
    if (!args) return;
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "queue.list", arguments: args },
      CallToolResultSchema
    );
    const stories = parseToolResult<Story[]>(result);
    this.reduce((state) => {
      const next = stories.reduce((s, story) => upsertStoryInState(s, story), state);
      return { ...next, queueOrder: stories.map((s) => s.id) };
    });
  }

  async reorderQueue(id: string, direction: "up" | "down"): Promise<void> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "queue.reorder", arguments: { id, direction } },
      CallToolResultSchema
    );
    const stories = parseToolResult<Story[]>(result);
    this.reduce((state) => {
      const next = stories.reduce((s, story) => upsertStoryInState(s, story), state);
      return { ...next, queueOrder: stories.map((s) => s.id) };
    });
  }

  /** Apply an arbitrary drag-reorder of the queue. */
  async reorderQueueTo(ids: string[]): Promise<void> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "queue.setOrder", arguments: { ids } },
      CallToolResultSchema
    );
    const stories = parseToolResult<Story[]>(result);
    this.reduce((state) => {
      const next = stories.reduce((s, story) => upsertStoryInState(s, story), state);
      return { ...next, queueOrder: stories.map((s) => s.id) };
    });
  }

  /** Pull a story out of the queue back to backlog (drag Queued → Backlog). */
  async unqueueStory(id: string): Promise<Story> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "story.unqueue", arguments: { id } },
      CallToolResultSchema
    );
    const story = parseToolResult<Story>(result);
    this.reduce((state) => upsertStoryInState(state, story));
    await this.loadQueue();
    return story;
  }

  private updateStoryAndDetail(story: Story): void {
    this.reduce((state) => {
      const next = upsertStoryInState(state, story);
      return {
        ...next,
        detail: state.detail?.story.id === story.id ? { ...state.detail, story } : state.detail,
      };
    });
  }

  async mergeStory(id: string): Promise<Story> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "story.merge", arguments: { id } },
      CallToolResultSchema
    );
    const story = parseToolResult<Story>(result);
    this.updateStoryAndDetail(story);
    await Promise.all([this.loadQueue(), this.loadRuns()]);
    return story;
  }

  /**
   * Send an in-progress story to Review from the board ("implementation is done").
   * The daemon's story.review pushes the worktree branch and opens a real GitHub PR
   * when there are commits, or uses a local:// sentinel for no-code stories. It also
   * builds the handoff from the worktree git state and moves the card to Review.
   */
  async reviewStory(id: string): Promise<Story> {
    const client = this.ensureClient();
    const story = this.state.stories[id];
    if (story && story.column !== "in_progress") {
      throw new Error("Only in-progress stories can be sent to review");
    }
    let result: unknown;
    try {
      result = await client.callTool(
        { name: "story.review", arguments: { id } },
        CallToolResultSchema
      );
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "Failed to send story to review");
    }
    const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = r.content?.find((c) => c.type === "text")?.text;
    if (r.isError) throw new Error(text ?? "Failed to send story to review");
    const updated = parseToolResult<Story>(result);
    this.updateStoryAndDetail(updated);
    await Promise.all([this.loadQueue(), this.loadRuns()]);
    return updated;
  }

  async abandonStory(id: string): Promise<Story> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "story.abandon", arguments: { id } },
      CallToolResultSchema
    );
    const story = parseToolResult<Story>(result);
    this.updateStoryAndDetail(story);
    await this.loadQueue();
    return story;
  }

  /** Flag a draft for Fable to file to GitHub. */
  async requestFile(id: string): Promise<Story> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "story.requestFile", arguments: { id } },
      CallToolResultSchema
    );
    const story = parseToolResult<Story>(result);
    this.reduce((state) => upsertStoryInState(state, story));
    return story;
  }

  /** Manually file a draft with a known issue (deterministic fallback / no Fable). */
  async fileStory(id: string, issue: string): Promise<Story> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "story.file", arguments: { id, issue } },
      CallToolResultSchema
    );
    const story = parseToolResult<Story>(result);
    this.reduce((state) => upsertStoryInState(state, story));
    return story;
  }

  async loadRuns(): Promise<void> {
    const args = this.activeProjectArgs();
    if (!args) return;
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "runs.list", arguments: args },
      CallToolResultSchema
    );
    this.patch({ runs: parseToolResult<RunRecord[]>(result) });
  }

  async loadConfig(): Promise<void> {
    const client = this.ensureClient();
    const result = await client.callTool({ name: "config.get", arguments: {} }, CallToolResultSchema);
    this.patch({ config: parseToolResult<AppConfig>(result) });
  }

  async updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "config.set", arguments: patch },
      CallToolResultSchema
    );
    const config = parseToolResult<AppConfig>(result);
    this.patch({ config });
    return config;
  }

  private async refreshOpenDetail(id = this.state.detail?.story.id): Promise<StoryDetail | null> {
    if (!id || !this.client || this.state.status !== "connected") return null;
    const seq = ++this.detailRefreshSeq;
    const result = await this.client.callTool(
      { name: "story.detail", arguments: { id } },
      CallToolResultSchema
    );
    const detail = parseToolResult<StoryDetail>(result);
    this.reduce((state) => {
      if (seq !== this.detailRefreshSeq) return state;
      const next = upsertStoryInState(state, detail.story);
      return { ...next, detail };
    });
    return this.state.detail?.story.id === id ? this.state.detail : null;
  }

  async openStory(id: string): Promise<StoryDetail> {
    const detail = await this.refreshOpenDetail(id);
    if (!detail) throw new Error(`Story detail not found: ${id}`);
    return detail;
  }

  closeStory(): void {
    this.detailRefreshSeq += 1;
    this.patch({ detail: null });
  }

  /** Emit a transient toast + a persistent notification/activity entry. */
  notify(kind: ToastKind, message: string, activity?: Partial<ActivityMeta>): void {
    this.notifySeq += 1;
    const id = `ntf-${this.notifySeq}`;
    const toast: Toast = { id, kind, message };
    const note: AppNotification = {
      ...toast,
      ts: Date.now(),
      read: false,
      activity: { ...defaultActivityMeta(kind, message), ...activity },
    };
    this.patch({
      toasts: [...this.state.toasts, toast],
      notifications: [note, ...this.state.notifications].slice(0, 50),
    });
  }

  dismissToast(id: string): void {
    this.patch({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  markNotificationsRead(): void {
    if (this.state.notifications.every((n) => n.read)) return;
    this.patch({ notifications: this.state.notifications.map((n) => ({ ...n, read: true })) });
  }

  getToasts(): Toast[] {
    return this.state.toasts;
  }

  getNotifications(): AppNotification[] {
    return this.state.notifications;
  }

  getActivityItems(): ActivityItem[] {
    return this.state.notifications.map((n) => ({
      id: n.id,
      message: n.message,
      ts: n.ts,
      read: n.read,
      ...n.activity,
    }));
  }

  unreadCount(): number {
    return this.state.notifications.filter((n) => !n.read).length;
  }

  /** Queued stories in daemon queue order. */
  queueStories(): BoardStory[] {
    const matchesRepo = activeRepoFilter(this.state);
    return this.state.queueOrder
      .map((id) => this.state.stories[id])
      .filter((s): s is BoardStory => !!s && matchesRepo(s));
  }

  getRuns(): RunRecord[] {
    const matchesRepo = activeRepoFilter(this.state);
    return this.state.runs.filter((run) => matchesRepo(run));
  }

  getConfig(): AppConfig {
    return this.state.config;
  }

  liveWorkerCount(): number {
    return liveWorkerCount(this.state);
  }

  reservedWorkerCount(): number {
    return reservedWorkerCount(this.state);
  }

  getDetail(): StoryDetail | null {
    return this.state.detail;
  }

  storiesByColumn(column: Column): BoardStory[] {
    return storiesForColumn(this.state, column);
  }
}

export function workerLanes(story: BoardStory): WorkerLane[] {
  return Object.values(story.lanes).sort((a, b) => {
    const ai = ROUTE_ORDER.indexOf(a.route as RouteId);
    const bi = ROUTE_ORDER.indexOf(b.route as RouteId);
    if (ai === -1 && bi === -1) return a.route.localeCompare(b.route);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

export function routeColor(route: string): string {
  return contractRouteColor(route);
}

export function routeLabel(route: RouteId | string): string {
  return contractRouteLabel(route);
}

export function routeModel(route: RouteId | string): string {
  return contractRouteModel(route);
}

export function routeAccess(route: RouteId | string): Access {
  return contractRouteAccess(route);
}

export function priorityColor(priority: Story["priority"]): string {
  if (priority === "high") return "var(--sq-danger)";
  if (priority === "med") return "var(--sq-running)";
  return "var(--sq-text-4)";
}

export function columnDotColor(column: Column): string {
  const map: Record<Column, string> = {
    backlog: "var(--sq-text-3)",
    queued: "var(--sq-queued)",
    in_progress: "var(--sq-running)",
    review: "var(--sq-review)",
    done: "var(--sq-done)",
  };
  return map[column];
}
