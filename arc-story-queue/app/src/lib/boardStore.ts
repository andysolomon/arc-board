import {
  normalizeStory,
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
  type QueueNextResult,
  type RunRecord,
  type PrReadiness,
  type Story,
  type StoryDetail,
} from "arc-contracts";
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
import {
  activeRepoFilter,
  applyStoryUpdate,
  createInitialBoardState,
  liveWorkerCount as computeLiveWorkerCount,
  projectIdentity,
  reservedWorkerCount as computeReservedWorkerCount,
  storiesForColumn,
  upsertStoryInState,
  type BoardListener,
  type BoardState,
  type BoardStory,
  type ProjectScope,
  type StoryLifecycleEvent,
  type StoryUpdateEvent,
} from "./boardState";
import {
  createNotification,
  lifecycleActivityMeta,
  lifecycleToast,
  type ActivityItem,
  type ActivityMeta,
  type AppNotification,
  type Toast,
  type ToastKind,
} from "./notifications";
import {
  clearAttachmentState,
  defaultStorage,
  persistAttachmentState,
  readAttachmentState,
  type BoardStorage,
} from "./projectPersistence";
import { BoardSync, parseToolResult } from "./boardSync";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

// Re-export the decomposed modules' public API so existing consumers and tests
// keep importing everything from `boardStore` while the internals stay split.
export {
  applyStoryUpdate,
  createInitialBoardState,
  hasLiveWorker,
  liveWorkerCount,
  reservedWorkerCount,
  storiesForColumn,
  upsertStoryInState,
  type BoardListener,
  type BoardState,
  type BoardStory,
  type ConnectionStatus,
  type LaneStatus,
  type LifecycleKind,
  type ProjectScope,
  type StoryLifecycleEvent,
  type StoryUpdateEvent,
  type TerminalLine,
  type WorkerLane,
} from "./boardState";
export {
  type ActivityItem,
  type ActivityMeta,
  type AppNotification,
  type Toast,
  type ToastKind,
} from "./notifications";
export { LAST_PROJECT_STORAGE_KEY, type BoardStorage } from "./projectPersistence";
export { resolveTauriHttpFetch } from "./boardSync";
export {
  BOARD_COLUMNS,
  COLUMN_LABELS,
  columnDotColor,
  priorityColor,
  routeAccess,
  routeColor,
  routeLabel,
  routeModel,
} from "./routes";
export { workerLanes } from "./workerLanes";
export type { ModelComplete, ModelCompleteArgs } from "./intakePipeline";

export type RefineAction = "split" | "tighten" | "dedupe";

export interface RefineResult {
  action: RefineAction;
  source: IntakeDraftSource;
  note: string;
  story: Story;
  children: Story[];
}

export interface BoardStoreLivenessOptions {
  reconnectDelaysMs?: number[];
  watchdogIntervalMs?: number;
  staleEventThresholdMs?: number;
}

export interface BoardStoreOptions {
  storage?: BoardStorage | null;
  modelComplete?: ModelComplete | null;
  mcpFetch?: FetchLike | null;
  sync?: BoardSync;
  liveness?: BoardStoreLivenessOptions;
}

export interface SessionRegisterArgs {
  repo: string;
  path: string;
  branch: string;
  model: string;
  pid: number;
}

function defaultModelComplete(): ModelComplete | null {
  const globals = globalThis as typeof globalThis & {
    claude?: { complete?: ModelComplete };
  };
  return typeof globals.claude?.complete === "function" ? globals.claude.complete : null;
}

/**
 * Facade over the decomposed board modules. Holds the mutable board state and
 * exposes the stable method surface React components depend on, delegating
 * transport to {@link BoardSync}, persistence to `projectPersistence`, and
 * pure state transitions to `boardState` reducers.
 */
export class BoardStore {
  private state: BoardState = createInitialBoardState();
  private listeners = new Set<BoardListener>();
  private readonly sync: BoardSync;
  private notifySeq = 0;
  private detailRefreshSeq = 0;
  private readonly storage: BoardStorage | null;
  private readonly modelComplete: ModelComplete | null;
  private disposed = false;
  private isReconnecting = false;
  private reconnectAttempt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | undefined;
  private removeFocusListeners: (() => void) | undefined;
  private readonly reconnectDelaysMs: number[];
  private readonly watchdogIntervalMs: number;
  private readonly staleEventThresholdMs: number;

  constructor(
    mcpUrl: string,
    storageOrOptions?: BoardStorage | null | BoardStoreOptions
  ) {
    const looksLikeOptions =
      storageOrOptions !== null &&
      typeof storageOrOptions === "object" &&
      ("storage" in storageOrOptions || "modelComplete" in storageOrOptions || "mcpFetch" in storageOrOptions || "sync" in storageOrOptions || "liveness" in storageOrOptions);
    const options = looksLikeOptions ? (storageOrOptions as BoardStoreOptions) : undefined;
    this.storage = options
      ? options.storage === undefined ? defaultStorage() : options.storage
      : storageOrOptions === undefined ? defaultStorage() : (storageOrOptions as BoardStorage | null);
    this.modelComplete = options?.modelComplete === undefined ? defaultModelComplete() : options.modelComplete;
    const mcpFetch = options?.mcpFetch === undefined ? null : options.mcpFetch;
    const liveness = options?.liveness;
    this.reconnectDelaysMs = liveness?.reconnectDelaysMs ?? [1_000, 2_000, 4_000, 8_000, 15_000];
    this.watchdogIntervalMs = liveness?.watchdogIntervalMs ?? 15_000;
    this.staleEventThresholdMs = liveness?.staleEventThresholdMs ?? 60_000;
    const syncHandlers = {
      onStoryUpdate: (event: StoryUpdateEvent) => this.reduce((state) => applyStoryUpdate(state, event)),
      onLifecycle: (event: StoryLifecycleEvent) => this.handleLifecycleEvent(event),
      onDisconnect: () => this.handleDisconnect(),
    };
    this.sync = options?.sync ?? new BoardSync(mcpUrl, mcpFetch, syncHandlers);
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

  private persist(): void {
    persistAttachmentState(this.storage, this.state.projects, this.state.activeProjectId, this.state.project);
  }

  private async restoreLastAttachment(): Promise<void> {
    if (this.state.projects.length > 0) return;
    const saved = readAttachmentState(this.storage);
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
      clearAttachmentState(this.storage);
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
    this.persist();
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
    const m = lifecycleToast(evt);
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

  private handleDisconnect(): void {
    if (this.disposed) return;
    this.patch({ status: "connecting", error: undefined });
    void this.runReconnectLoop();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private reconnectDelayMs(): number {
    const index = Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1);
    return this.reconnectDelaysMs[index];
  }

  private async runReconnectLoop(): Promise<void> {
    if (this.disposed || this.isReconnecting) return;
    this.isReconnecting = true;
    try {
      while (!this.disposed && !this.sync.isConnected()) {
        this.patch({ status: "connecting", error: undefined });
        const delayMs = this.reconnectDelayMs();
        this.reconnectAttempt += 1;
        await this.delay(delayMs);
        if (this.disposed) return;
        try {
          await this.sync.connect();
          this.reconnectAttempt = 0;
          this.patch({ status: "connected" });
          this.startWatchdog();
          await this.afterReconnectSuccess();
          return;
        } catch {
          // keep backing off until success or dispose
        }
      }
    } finally {
      this.isReconnecting = false;
    }
  }

  private async afterReconnectSuccess(): Promise<void> {
    const openDetailId = this.state.detail?.story.id;
    await this.refreshViews();
    if (openDetailId && this.state.detail?.story.id === openDetailId) {
      await this.refreshOpenDetail(openDetailId);
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    if (this.watchdogIntervalMs <= 0) return;
    this.watchdogTimer = setInterval(() => {
      void this.checkWatchdog();
    }, this.watchdogIntervalMs);
    const timer = this.watchdogTimer;
    if (timer && typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== undefined) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  private async checkWatchdog(): Promise<void> {
    if (this.disposed || this.state.status !== "connected") return;
    const last = this.sync.lastEventAt;
    if (last === null) return;
    if (Date.now() - last <= this.staleEventThresholdMs) return;
    await this.sync.close();
    if (this.disposed) return;
    this.patch({ status: "connecting", error: undefined });
    void this.runReconnectLoop();
  }

  private ensureFocusListeners(): void {
    if (this.removeFocusListeners) return;
    const globals = globalThis as typeof globalThis & {
      document?: {
        addEventListener(type: string, listener: () => void): void;
        removeEventListener(type: string, listener: () => void): void;
        visibilityState?: string;
      };
      window?: {
        addEventListener(type: string, listener: () => void): void;
        removeEventListener(type: string, listener: () => void): void;
      };
    };
    if (!globals.document || !globals.window) return;

    const onFocusReturn = () => this.handleFocusReturn();
    const onVisibilityChange = () => {
      if (globals.document?.visibilityState === "visible") this.handleFocusReturn();
    };
    globals.window.addEventListener("focus", onFocusReturn);
    globals.document.addEventListener("visibilitychange", onVisibilityChange);
    this.removeFocusListeners = () => {
      globals.window?.removeEventListener("focus", onFocusReturn);
      globals.document?.removeEventListener("visibilitychange", onVisibilityChange);
      this.removeFocusListeners = undefined;
    };
  }

  private handleFocusReturn(): void {
    if (this.disposed) return;
    if (this.state.status === "connected") {
      void this.refreshViews().catch(() => undefined);
      return;
    }
    void this.runReconnectLoop();
  }

  async connect(): Promise<void> {
    if (this.state.status === "connected" || this.state.status === "connecting") return;
    this.patch({ status: "connecting", error: undefined });

    try {
      await this.sync.connect();
      this.reconnectAttempt = 0;
      this.patch({ status: "connected" });
      this.startWatchdog();
      this.ensureFocusListeners();
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
    this.disposed = true;
    this.stopWatchdog();
    this.removeFocusListeners?.();
    await this.sync.close();
    this.state = createInitialBoardState();
    this.emit();
  }

  async discover(): Promise<Project[]> {
    return this.sync.call<Project[]>("project.discover", {});
  }

  async listKnownProjects(): Promise<KnownProject[]> {
    return this.sync.call<KnownProject[]>("projects.known.list", {});
  }

  async forgetKnownProject(path: string): Promise<boolean> {
    const result = await this.sync.call<{ forgotten: boolean }>("projects.known.forget", { path });
    return result.forgotten;
  }

  /** List daemon-host directories within the daemon's allowed filesystem root. */
  async listDir(path = ""): Promise<FsDirListing> {
    return this.sync.call<FsDirListing>("fs.listDir", { path });
  }

  /** Derive owner/name from a local repo's git origin remote (empty if none). */
  async detectRepoId(path: string): Promise<{ repoId: string | null; remote: string | null }> {
    return this.sync.call<{ repoId: string | null; remote: string | null }>("git.repoId", { path });
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
    const stories = await this.sync.call<Story[]>("github.import", { repo });
    this.reduce((state) => stories.reduce((s, st) => upsertStoryInState(s, st), state));
    await this.refreshViews();
    this.notify(
      stories.length > 0 ? "success" : "info",
      `Imported ${stories.length} issue(s) from ${repo}`
    );
    return stories;
  }

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

  /** Pull every data set the views render: stories, queue order, runs, config, intake. */
  async refreshViews(): Promise<void> {
    if (!this.activeProjectArgs()) {
      await Promise.all([this.loadConfig(), this.loadIntake()]);
      return;
    }
    await this.hydrate();
    await Promise.all([this.loadQueue(), this.loadRuns(), this.loadConfig(), this.loadIntake()]);
  }

  async loadIntake(): Promise<void> {
    this.patch({ intake: await this.sync.call<IntakeItem[]>("intake.list", {}) });
  }

  async enqueueIntake(args: { kind: IntakeKind; title: string; description: string }): Promise<IntakeItem> {
    const item = await this.sync.call<IntakeItem>("intake.enqueue", args);
    await this.loadIntake();
    return item;
  }

  /** Deterministic fallback: template a pending intake item into a backlog draft. */
  async draftIntake(id: string): Promise<Story> {
    const project = this.state.project;
    if (!project) throw new Error("No project attached");
    const story = await this.sync.call<Story>("intake.draft", { id, projectId: project.id });
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
    if (this.sync.isConnected()) {
      const saved = await this.sync.call<Story>("story.save", { story: persistedStory });
      this.updateStoryAndDetail(saved);
      return saved;
    }
    this.updateStoryAndDetail(persistedStory);
    return persistedStory;
  }

  private async createRefineChildren(proposals: IntakeDraftProposal[], repo: string): Promise<Story[]> {
    if (proposals.length === 0) return [];
    if (this.state.project && this.sync.isConnected()) {
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
    const stories = await this.sync.call<Story[]>("intake.createDrafts", { projectId: project.id, drafts: selected });
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
    const stories = await this.sync.call<Story[]>("stories.list", args);
    this.reduce((state) =>
      stories.reduce((s, story) => upsertStoryInState(s, story), state)
    );
  }

  async enqueueStory(id: string): Promise<Story> {
    let result: unknown;
    try {
      result = await this.sync.callRaw("story.enqueue", { id });
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
    const session = await this.sync.call<{ id: string }>("session.register", { ...args });
    const project = await this.sync.call<Project>("project.attach", { sessionId: session.id });
    this.patch({
      project,
      projects: this.projectListWith(project),
      activeProjectId: project.id,
      error: undefined,
    });
    if (options.persist !== false) this.persist();
    await this.safeHydrate();
    return project;
  }

  async attachSession(sessionId: string): Promise<Project> {
    const project = await this.sync.call<Project>("project.attach", { sessionId });
    this.patch({
      project,
      projects: this.projectListWith(project),
      activeProjectId: project.id,
      error: undefined,
    });
    this.persist();
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
    if (options.persist !== false) this.persist();
    await this.refreshViews();
  }

  async detachProject(projectId: string): Promise<Project> {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    const detached = await this.sync.call<Project>("project.detach", { projectId });
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
    this.persist();
    if (projects.length > 0) await this.refreshViews();
    return detached;
  }

  trackStory(id: string): void {
    if (this.state.trackedIds.includes(id)) return;
    this.patch({ trackedIds: [...this.state.trackedIds, id] });
  }

  async refreshStory(id: string): Promise<BoardStory | null> {
    const story = await this.sync.call<Story | null>("story.get", { id });
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
    const dispatched = await this.sync.call<QueueNextResult>("queue.next", { projectId: project.id });
    const story = dispatched.story;
    if (story) this.reduce((state) => upsertStoryInState(state, story));
    else if (dispatched.reason === "awaiting-orchestration-plan") {
      this.notify("info", "Queued stories are awaiting orchestration plan approval.");
    }
    await this.loadQueue();
    return story;
  }

  async loadQueue(): Promise<void> {
    const args = this.activeProjectArgs();
    if (!args) return;
    const stories = await this.sync.call<Story[]>("queue.list", args);
    this.reduce((state) => {
      const next = stories.reduce((s, story) => upsertStoryInState(s, story), state);
      return { ...next, queueOrder: stories.map((s) => s.id) };
    });
  }

  async reorderQueue(id: string, direction: "up" | "down"): Promise<void> {
    const stories = await this.sync.call<Story[]>("queue.reorder", { id, direction });
    this.reduce((state) => {
      const next = stories.reduce((s, story) => upsertStoryInState(s, story), state);
      return { ...next, queueOrder: stories.map((s) => s.id) };
    });
  }

  /** Apply an arbitrary drag-reorder of the queue. */
  async reorderQueueTo(ids: string[]): Promise<void> {
    const stories = await this.sync.call<Story[]>("queue.setOrder", { ids });
    this.reduce((state) => {
      const next = stories.reduce((s, story) => upsertStoryInState(s, story), state);
      return { ...next, queueOrder: stories.map((s) => s.id) };
    });
  }

  /**
   * Re-trigger orchestration analysis for a queued story (Replan / Retry
   * planning). Uses the existing lifecycle triggers only: unqueue resets the
   * plan to `unplanned`, re-enqueue emits the `queued` event the background
   * planner listens for, and the original queue position is restored.
   */
  async replanStory(id: string): Promise<Story> {
    const order = [...this.state.queueOrder];
    await this.unqueueStory(id);
    const story = await this.enqueueStory(id);
    if (order.includes(id)) await this.reorderQueueTo(order);
    return story;
  }

  /** Pull a story out of the queue back to backlog (drag Queued → Backlog). */
  async unqueueStory(id: string): Promise<Story> {
    const story = await this.sync.call<Story>("story.unqueue", { id });
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

  async prReadiness(id: string): Promise<PrReadiness> {
    return this.sync.call<PrReadiness>("pr.readiness", { id });
  }

  async mergeStory(id: string, options?: { override?: boolean }): Promise<Story> {
    let result: unknown;
    try {
      result = await this.sync.callRaw("story.merge", {
        id,
        ...(options?.override ? { override: true } : {}),
      });
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "Failed to merge story");
    }
    const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = r.content?.find((c) => c.type === "text")?.text;
    if (r.isError) throw new Error(text ?? "Failed to merge story");
    const story = parseToolResult<Story>(result);
    this.updateStoryAndDetail(story);
    await Promise.all([this.loadQueue(), this.loadRuns()]);
    return story;
  }

  async remediateMergeStory(id: string, code: "checks_failed" | "branch_policy" | "behind_base" | "unknown"): Promise<Story> {
    let actionError: unknown;
    try {
      const result = await this.sync.callRaw("story.remediateMerge", { id, code });
      const response = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      const text = response.content?.find((content) => content.type === "text")?.text;
      if (response.isError) throw new Error(text ?? "Failed to remediate merge blockage");
      const story = parseToolResult<Story>(result);
      this.updateStoryAndDetail(story);
      return story;
    } catch (err) {
      actionError = err;
      throw err;
    } finally {
      try {
        await Promise.all([this.refreshOpenDetail(id), this.loadQueue(), this.loadRuns()]);
      } catch (refreshError) {
        // A persisted handoff/run must not hide the action result that caused this refresh.
        if (!actionError) throw refreshError;
      }
    }
  }

  /**
   * Send an in-progress story to Review from the board ("implementation is done").
   * The daemon's story.review pushes the worktree branch and opens a real GitHub PR
   * when there are commits, or uses a local:// sentinel for no-code stories. It also
   * builds the handoff from the worktree git state and moves the card to Review.
   */
  async reviewStory(id: string): Promise<Story> {
    const story = this.state.stories[id];
    if (story && story.column !== "in_progress") {
      throw new Error("Only in-progress stories can be sent to review");
    }
    let result: unknown;
    try {
      result = await this.sync.callRaw("story.review", { id });
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

  async startStory(id: string): Promise<Story> {
    const story = await this.sync.call<Story>("story.start", { id });
    this.updateStoryAndDetail(story);
    return story;
  }

  async abandonStory(id: string): Promise<Story> {
    const story = await this.sync.call<Story>("story.abandon", { id });
    this.updateStoryAndDetail(story);
    await this.loadQueue();
    return story;
  }

  /** Flag a draft for Fable to file to GitHub. */
  async requestFile(id: string): Promise<Story> {
    const story = await this.sync.call<Story>("story.requestFile", { id });
    this.reduce((state) => upsertStoryInState(state, story));
    return story;
  }

  /** Manually file a draft with a known issue (deterministic fallback / no Fable). */
  async fileStory(id: string, issue: string): Promise<Story> {
    const story = await this.sync.call<Story>("story.file", { id, issue });
    this.reduce((state) => upsertStoryInState(state, story));
    return story;
  }

  async loadRuns(): Promise<void> {
    const args = this.activeProjectArgs();
    if (!args) return;
    this.patch({ runs: await this.sync.call<RunRecord[]>("runs.list", args) });
  }

  async loadConfig(): Promise<void> {
    this.patch({ config: await this.sync.call<AppConfig>("config.get", {}) });
  }

  async updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    const config = await this.sync.call<AppConfig>("config.set", patch);
    this.patch({ config });
    return config;
  }

  private async refreshOpenDetail(id = this.state.detail?.story.id): Promise<StoryDetail | null> {
    if (!id || !this.sync.isConnected()) return null;
    const seq = ++this.detailRefreshSeq;
    const detail = await this.sync.call<StoryDetail>("story.detail", { id });
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
    const { toast, note } = createNotification(`ntf-${this.notifySeq}`, kind, message, Date.now(), activity);
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
    return computeLiveWorkerCount(this.state);
  }

  reservedWorkerCount(): number {
    return computeReservedWorkerCount(this.state);
  }

  getDetail(): StoryDetail | null {
    return this.state.detail;
  }

  storiesByColumn(column: Column): BoardStory[] {
    return storiesForColumn(this.state, column);
  }
}
