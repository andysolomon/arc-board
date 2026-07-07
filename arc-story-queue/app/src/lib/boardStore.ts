import type {
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

export interface BoardStory extends Story {
  lines: TerminalLine[];
  activeRoute?: string;
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
  line?: TerminalLine;
  lane?: { route: string; status: "running" | "done" };
}

export type LifecycleKind =
  | "queued"
  | "started"
  | "review"
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

function parseToolResult<T>(result: unknown): T {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new Error("No text content in tool result");
  return JSON.parse(text) as T;
}

function toBoardStory(story: Story, existing?: BoardStory): BoardStory {
  return {
    ...story,
    lines: existing?.lines ?? [],
    activeRoute: existing?.activeRoute,
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
  };

  const lines = event.line ? [...base.lines, { ...event.line, route: event.route }] : base.lines;
  const stories = {
    ...state.stories,
    [event.id]: {
      ...base,
      activeRoute: event.route,
      lines,
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

export type BoardListener = (state: BoardState) => void;

export class BoardStore {
  private state: BoardState = createInitialBoardState();
  private listeners = new Set<BoardListener>();
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private notifySeq = 0;

  constructor(private readonly mcpUrl: string) {}

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
    return story;
  }

  async registerAndAttach(args: SessionRegisterArgs): Promise<Project> {
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
    this.patch({ project });
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
    this.patch({ project });
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

  getDetail(): StoryDetail | null {
    return this.state.detail;
  }

  storiesByColumn(column: Column): BoardStory[] {
    const repo = this.state.project?.repo;
    return storiesForColumn(this.state, column, repo);
  }
}

export function routeColor(route: string): string {
  const map: Record<string, string> = {
    "codex-explore": "var(--sq-route-explore)",
    "composer-implement": "var(--sq-route-composer)",
    "codex-implement": "var(--sq-route-codex)",
    "codex-check": "var(--sq-route-check)",
    "opus-review": "var(--sq-route-review)",
    fable: "var(--sq-route-fable)",
  };
  return map[route] ?? "var(--sq-accent)";
}

export function routeLabel(route: RouteId | string): string {
  const map: Record<string, string> = {
    "codex-explore": "codex-explore",
    "composer-implement": "composer-implement",
    "codex-implement": "codex-implement",
    "codex-check": "codex-check",
    "opus-review": "opus-review",
    fable: "fable",
  };
  return map[route] ?? route;
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
