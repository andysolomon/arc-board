import type {
  Access,
  AppConfig,
  Column,
  IntakeItem,
  IntakeKind,
  Project,
  RouteId,
  RunRecord,
  Story,
  StoryDetail,
} from "arc-contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

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
export interface AppNotification extends Toast {
  ts: number;
  read: boolean;
}

export interface BoardState {
  status: ConnectionStatus;
  project: Project | null;
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
  | "filed";

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
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text) as T;
}

function laneFromRoute(route: string): WorkerLane {
  return { route, status: "running", lines: [] };
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
  const stories = {
    ...state.stories,
    [story.id]: toBoardStory(story, existing),
  };
  const trackedIds = state.trackedIds.includes(story.id)
    ? state.trackedIds
    : [...state.trackedIds, story.id];
  return { ...state, stories, trackedIds };
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
  const stories = {
    ...state.stories,
    [event.id]: {
      ...base,
      activeRoute: route,
      lines,
      lanes: { ...existingLanes, [route]: lane },
      lastWorkerUpdateAt: line ? now : base.lastWorkerUpdateAt,
    },
  };
  const trackedIds = state.trackedIds.includes(event.id)
    ? state.trackedIds
    : [...state.trackedIds, event.id];

  return { ...state, stories, trackedIds };
}

export function storiesForColumn(state: BoardState, column: Column, repo?: string): BoardStory[] {
  return Object.values(state.stories)
    .filter((s) => s.column === column && (!repo || s.repo === repo))
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
  const repo = state.project?.repo;
  return storiesForColumn(state, "in_progress", repo).filter((story) =>
    hasLiveWorker(story, now, recencyMs)
  ).length;
}

export function reservedWorkerCount(state: BoardState, now = Date.now(), recencyMs = 30_000): number {
  const repo = state.project?.repo;
  return storiesForColumn(state, "in_progress", repo).filter(
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
  private readonly storage: BoardStorage | null;

  constructor(
    private readonly mcpUrl: string,
    storage?: BoardStorage | null
  ) {
    this.storage = storage === undefined ? defaultStorage() : storage;
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

  private readLastAttachment(): PersistedProjectAttachment | null {
    const raw = this.storage?.getItem(LAST_PROJECT_STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedProjectAttachment>;
      if (
        typeof parsed.repo === "string" &&
        typeof parsed.path === "string" &&
        typeof parsed.branch === "string" &&
        typeof parsed.model === "string"
      ) {
        return parsed as PersistedProjectAttachment;
      }
    } catch {
      // Malformed persisted state should not block the connect flow.
    }
    this.storage?.removeItem(LAST_PROJECT_STORAGE_KEY);
    return null;
  }

  private persistAttachment(args: PersistedProjectAttachment): void {
    this.storage?.setItem(LAST_PROJECT_STORAGE_KEY, JSON.stringify(args));
  }

  private clearLastAttachment(): void {
    this.storage?.removeItem(LAST_PROJECT_STORAGE_KEY);
  }

  private async restoreLastAttachment(): Promise<void> {
    if (this.state.project) return;
    const saved = this.readLastAttachment();
    if (!saved) return;

    try {
      await this.registerAndAttach({ ...saved, pid: 0 }, { persist: false });
      this.persistAttachment(saved);
      this.notify("success", `Restored ${saved.repo}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const error = `Unable to restore last project (${saved.repo}): ${msg}. Attach a project to continue.`;
      this.clearLastAttachment();
      this.patch({ project: null, error });
      this.notify("error", error);
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
    };
    const m = map[evt.kind];
    if (m) this.notify(m.kind, m.msg);
    if (this.state.project) void this.refreshViews().catch(() => undefined);
  }

  async connect(): Promise<void> {
    if (this.state.status === "connected" || this.state.status === "connecting") return;
    this.patch({ status: "connecting", error: undefined });

    try {
      this.transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl));
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
  async refreshViews(): Promise<void> {
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

  getIntake(): IntakeItem[] {
    return this.state.intake;
  }

  async hydrate(): Promise<void> {
    const project = this.state.project;
    if (!project) throw new Error("No project attached");
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "stories.list", arguments: { projectId: project.id } },
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
    if (options.persist !== false) {
      this.persistAttachment({
        repo: args.repo,
        path: args.path,
        branch: args.branch,
        model: args.model,
      });
    }
    this.patch({ project, error: undefined });
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
    this.persistAttachment({
      repo: project.repo,
      path: project.path,
      branch: project.branch,
      model: project.model,
    });
    this.patch({ project, error: undefined });
    await this.safeHydrate();
    return project;
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
    const project = this.state.project;
    if (!project) return;
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "queue.list", arguments: { projectId: project.id } },
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
    const project = this.state.project;
    if (!project) return;
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "runs.list", arguments: { projectId: project.id } },
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

  async openStory(id: string): Promise<StoryDetail> {
    const client = this.ensureClient();
    const result = await client.callTool(
      { name: "story.detail", arguments: { id } },
      CallToolResultSchema
    );
    const detail = parseToolResult<StoryDetail>(result);
    this.reduce((state) => ({ ...upsertStoryInState(state, detail.story), detail }));
    return detail;
  }

  closeStory(): void {
    this.patch({ detail: null });
  }

  /** Emit a transient toast + a persistent notification entry. */
  notify(kind: ToastKind, message: string): void {
    this.notifySeq += 1;
    const id = `ntf-${this.notifySeq}`;
    const toast: Toast = { id, kind, message };
    const note: AppNotification = { ...toast, ts: Date.now(), read: false };
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

  unreadCount(): number {
    return this.state.notifications.filter((n) => !n.read).length;
  }

  /** Queued stories in daemon queue order. */
  queueStories(): BoardStory[] {
    return this.state.queueOrder
      .map((id) => this.state.stories[id])
      .filter((s): s is BoardStory => !!s);
  }

  getRuns(): RunRecord[] {
    return this.state.runs;
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
    const repo = this.state.project?.repo;
    return storiesForColumn(this.state, column, repo);
  }
}

const ROUTE_META: Record<RouteId, { label: string; color: string; model: string; access: Access }> = {
  "codex-explore": {
    label: "codex-explore",
    color: "var(--sq-route-explore)",
    model: "gpt-5.4-mini",
    access: "read-only",
  },
  "composer-implement": {
    label: "composer-implement",
    color: "var(--sq-route-composer)",
    model: "composer-2.5",
    access: "write",
  },
  "codex-implement": {
    label: "codex-implement",
    color: "var(--sq-route-codex)",
    model: "gpt-5.5",
    access: "write",
  },
  "codex-check": {
    label: "codex-check",
    color: "var(--sq-route-check)",
    model: "gpt-5.5",
    access: "read-only",
  },
  "opus-review": {
    label: "opus-review",
    color: "var(--sq-route-review)",
    model: "opus-4.8",
    access: "read-only",
  },
  fable: {
    label: "fable",
    color: "var(--sq-route-fable)",
    model: "orchestrator",
    access: "parent",
  },
};

const ROUTE_ORDER = Object.keys(ROUTE_META);

function metaForRoute(route: RouteId | string) {
  return ROUTE_META[route as RouteId] ?? {
    label: route,
    color: "var(--sq-accent)",
    model: "unknown",
    access: "read-only" as Access,
  };
}

export function workerLanes(story: BoardStory): WorkerLane[] {
  return Object.values(story.lanes).sort((a, b) => {
    const ai = ROUTE_ORDER.indexOf(a.route);
    const bi = ROUTE_ORDER.indexOf(b.route);
    if (ai === -1 && bi === -1) return a.route.localeCompare(b.route);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

export function routeColor(route: string): string {
  return metaForRoute(route).color;
}

export function routeLabel(route: RouteId | string): string {
  return metaForRoute(route).label;
}

export function routeModel(route: RouteId | string): string {
  return metaForRoute(route).model;
}

export function routeAccess(route: RouteId | string): Access {
  return metaForRoute(route).access;
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
