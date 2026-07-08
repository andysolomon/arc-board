import type {
  Access,
  AppConfig,
  Column,
  FsDirListing,
  GherkinScenario,
  IntakeDraftProposal,
  IntakeDraftSource,
  IntakeGenerateResult,
  IntakeItem,
  IntakeKind,
  KnownProject,
  Project,
  RouteId,
  RunRecord,
  Story,
  StoryDetail,
} from "arc-contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
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

export interface ModelCompleteArgs {
  system: string;
  max_tokens: number;
  messages: Array<{ role: "user"; content: string }>;
}
export type ModelComplete = (args: ModelCompleteArgs) => Promise<string>;

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

function cap(s: string): string {
  const trimmed = s.trim().replace(/^[-*\d.)\s]+/, "");
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : "Untitled";
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "draft";
}

function linesFromText(text: string, fallback: string[]): string[] {
  const lines = text
    .split(/\n|(?<=[.;])\s+/)
    .map((s) => s.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((s) => s.length > 3);
  return (lines.length ? lines : fallback).slice(0, 4);
}

function guessEpic(text: string): string {
  if (/login|auth|password|sign|oauth/i.test(text)) return "Auth";
  if (/export|report|csv|dashboard/i.test(text)) return "Reporting";
  if (/api|endpoint|rate|limit|webhook/i.test(text)) return "API";
  if (/test|ci|flak/i.test(text)) return "Quality";
  if (/search|filter|paginat/i.test(text)) return "Search";
  return "Product";
}

function priority(value: unknown, fallback: IntakeDraftProposal["priority"]): IntakeDraftProposal["priority"] {
  return value === "high" || value === "med" || value === "low" ? value : fallback;
}

function size(value: unknown, fallback: IntakeDraftProposal["size"]): IntakeDraftProposal["size"] {
  return value === "S" || value === "M" || value === "L" || value === "XL" ? value : fallback;
}

function parseJsonLike(raw: string): unknown {
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) return JSON.parse(trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed);
    if (trimmed.startsWith("[")) return JSON.parse(trimmed.match(/\[[\s\S]*\]/)?.[0] ?? trimmed);
    const array = raw.match(/\[[\s\S]*\]/);
    if (array) return JSON.parse(array[0]);
    const object = raw.match(/\{[\s\S]*\}/);
    if (object) return JSON.parse(object[0]);
  } catch {
    return null;
  }
  return null;
}

function normalizeScenario(value: unknown, fallbackName: string): GherkinScenario {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const steps = Array.isArray(v.steps)
    ? v.steps
        .map((step): GherkinScenario["steps"][number] | null => {
          if (!Array.isArray(step) || step.length < 2) return null;
          const kw = String(step[0]);
          if (kw !== "Given" && kw !== "When" && kw !== "Then" && kw !== "And") return null;
          return [kw, String(step[1])];
        })
        .filter((step): step is GherkinScenario["steps"][number] => !!step)
    : ([
        ["Given", String(v.given ?? "the story is ready to refine")],
        ["When", String(v.when ?? "the user performs the refined workflow")],
        ["Then", String(v.then ?? "the expected outcome is observable")],
        ...(v.and ? ([["And", String(v.and)]] as GherkinScenario["steps"]) : []),
      ] as GherkinScenario["steps"]);
  return {
    name: cap(String(v.name ?? fallbackName)),
    steps: steps.length > 0 ? steps : [["Then", fallbackName]],
  };
}

function normalizeScenarios(value: unknown, fallbacks: string[]): GherkinScenario[] {
  const arr = Array.isArray(value) ? value : [];
  const scenarios = arr.map((item, i) => normalizeScenario(item, fallbacks[i] ?? `Scenario ${i + 1}`));
  return scenarios.length > 0
    ? scenarios.slice(0, 4)
    : fallbacks.slice(0, 4).map((name) => normalizeScenario({ name }, name));
}

function criteriaFromScenarios(scenarios: GherkinScenario[]): string[] {
  return scenarios.map((scenario) => scenario.name);
}

function fallbackTightenedScenarios(story: Story): GherkinScenario[] {
  const seeds = (story.criteria.length ? story.criteria : [story.title]).slice(0, 4);
  return seeds.map((criterion, i) => ({
    name: cap(criterion),
    steps: [
      ["Given", `the user is working with ${story.wid}`],
      ["When", `they complete ${criterion.toLowerCase()}`],
      ["Then", `the UI shows a verifiable result for ${criterion.toLowerCase()}`],
      ...(i === 0 ? ([ ["And", "no existing queue behavior regresses"] ] as GherkinScenario["steps"]) : []),
    ],
  }));
}

function refineTitlePart(title: string, part: number): string {
  return /\(part \d+\)$/i.test(title) ? title.replace(/\(part \d+\)$/i, `(part ${part})`) : `${title} (part ${part})`;
}

function storyText(story: Story): string {
  return [story.title, story.description, ...story.criteria, ...(story.scenarios?.map((s) => s.name) ?? [])]
    .join(" ")
    .toLowerCase();
}

function bestDeterministicOverlap(story: Story, siblings: Story[]): { story: Story; score: number } | null {
  const title = story.title.trim().toLowerCase();
  const words = new Set(storyText(story).split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  let best: { story: Story; score: number } | null = null;
  for (const sibling of siblings) {
    const siblingTitle = sibling.title.trim().toLowerCase();
    let score = title && siblingTitle && title === siblingTitle ? 1 : 0;
    const siblingWords = new Set(storyText(sibling).split(/[^a-z0-9]+/).filter((w) => w.length > 3));
    const shared = [...words].filter((w) => siblingWords.has(w)).length;
    const total = new Set([...words, ...siblingWords]).size || 1;
    score = Math.max(score, shared / total);
    if (score >= 0.34 && (!best || score > best.score)) best = { story: sibling, score };
  }
  return best;
}

function fallbackDraftProposals(kind: IntakeKind, text: string): IntakeDraftProposal[] {
  if (kind === "bug") {
    const title = cap(text || "A screen shows an error instead of the expected content").slice(0, 72);
    const severity = /crash|data loss|down|security|outage/i.test(title) ? "S1" : /broken|fail|error|throw|500|blank/i.test(title) ? "S2" : "S3";
    const area = /api|backend|webhook|endpoint/i.test(title) ? "api" : "app";
    return [{
      include: true,
      type: "bug",
      title,
      priority: severity === "S1" || severity === "S2" ? "high" : "med",
      size: "M",
      summary: `Investigate ${area} symptom and confirm the root cause before patching.`,
      description: `Symptom: ${title}`,
      epic: guessEpic(title),
      taskClass: "bugfix",
      tags: ["intake", "bug"],
      criteria: ["Reported behavior is reproducible", "Root cause is documented", "Fix is covered by a regression check"],
      bug: {
        severity,
        area,
        steps: ["Navigate to the affected screen", "Perform the reported action", "Observe the incorrect result"],
        rootCause: `src/${area}/${slug(title).slice(0, 16)}.ts:142 — suspected unhandled edge case; re-confirm before patching`,
        fixOptions: ["Guard the failing path and render a safe result (recommended)", "Fix upstream so the invalid state cannot occur"],
      },
    }];
  }

  const defaults = kind === "prd"
    ? ["Public rate-limit tracer bullet", "Read-path for the new report", "Write-path and persistence", "UI surface with empty state"]
    : ["Let users sign in with Google", "Export activity as CSV", "Add empty states to the dashboard"];

  return linesFromText(text, defaults).map((line, i) => {
    const title = cap(line);
    const isSlice = kind === "prd";
    const isBugish = /fix|bug|broken|error/i.test(line);
    return {
      include: true,
      type: isSlice ? "slice" : "story",
      title,
      priority: i === 0 ? "high" : i === 1 ? "med" : "low",
      size: line.length > 64 ? "L" : line.length > 34 ? "M" : "S",
      summary: isSlice ? `Ship an end-to-end tracer bullet for ${title.toLowerCase()}.` : `As a user, I want ${title.charAt(0).toLowerCase() + title.slice(1)} so that the workflow improves.`,
      description: isSlice ? `Vertical slice through the stack for ${title}.` : `As a user, I want ${title.charAt(0).toLowerCase() + title.slice(1)} so that the product better fits my workflow.`,
      epic: guessEpic(line),
      taskClass: isBugish ? "bugfix" : "feature",
      tags: ["intake", guessEpic(line)],
      criteria: isSlice
        ? [`End-to-end path works for ${title.toLowerCase()}`, "Covered by a focused test", "Demoable on its own"]
        : [`${title} works end to end`, "No existing behavior regresses"],
      slice: isSlice ? { afk: i === 0, blockedBy: i === 0 ? null : `slice ${i}`, userStoriesCovered: `story ${i + 1}` } : undefined,
    } satisfies IntakeDraftProposal;
  });
}

function normalizeModelDrafts(kind: IntakeKind, parsed: unknown): IntakeDraftProposal[] {
  const arr = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).slice(0, kind === "bug" ? 1 : 4) as Array<Record<string, unknown>>;
  return arr.map((d, i) => {
    const title = cap(String(d.title ?? (kind === "bug" ? "Bug" : kind === "prd" ? "Slice" : "Story")));
    if (kind === "bug") {
      const severity = ["S1", "S2", "S3", "S4"].includes(String(d.severity)) ? String(d.severity) as "S1" | "S2" | "S3" | "S4" : "S3";
      const area = String(d.area ?? "app");
      return {
        include: true,
        type: "bug",
        title,
        priority: priority(d.priority ?? d.prio, severity === "S1" || severity === "S2" ? "high" : "med"),
        size: size(d.size, "M"),
        summary: String(d.summary ?? d.context ?? `Fix ${title.toLowerCase()}.`),
        description: String(d.description ?? d.context ?? title),
        epic: String(d.epic ?? guessEpic(title)),
        taskClass: "bugfix",
        tags: ["intake", "bug"],
        criteria: Array.isArray(d.acceptance) ? d.acceptance.map(String) : ["Regression is fixed"],
        bug: {
          severity,
          area,
          steps: Array.isArray(d.steps) ? d.steps.map(String) : ["Reproduce the reported action"],
          rootCause: String(d.rootCause ?? "to be confirmed by arc-bug-fixer"),
          fixOptions: Array.isArray(d.fixOptions) ? d.fixOptions.map(String) : ["Investigate and patch at the source"],
        },
      };
    }

    const isSlice = kind === "prd";
    return {
      include: true,
      type: isSlice ? "slice" : "story",
      title,
      priority: priority(d.priority ?? d.prio, i === 0 ? "high" : "med"),
      size: size(d.size, "M"),
      summary: String(d.summary ?? d.userStory ?? d.userStoriesCovered ?? d.context ?? title),
      description: String(d.description ?? d.userStory ?? d.context ?? title),
      epic: String(d.epic ?? guessEpic(title)),
      taskClass: String(d.taskClass) === "bugfix" ? "bugfix" : "feature",
      tags: ["intake", String(d.epic ?? guessEpic(title))],
      criteria: Array.isArray(d.acceptance) ? d.acceptance.map(String) : Array.isArray(d.criteria) ? d.criteria.map(String) : ["Works end to end"],
      slice: isSlice ? {
        afk: d.afk !== false,
        blockedBy: d.blockedBy && String(d.blockedBy).toLowerCase() !== "null" ? String(d.blockedBy) : null,
        userStoriesCovered: String(d.userStoriesCovered ?? `story ${i + 1}`),
      } : undefined,
    } satisfies IntakeDraftProposal;
  });
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
    if (this.state.project || this.state.projects.length > 0) void this.refreshViews().catch(() => undefined);
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

  async generateDraftProposals(args: { kind: IntakeKind; text: string }): Promise<IntakeGenerateResult> {
    const text = args.text.trim();
    const model = this.modelComplete;
    const project = this.state.project;

    if (model && project) {
      try {
        const exploreRaw = await model({
          system:
            "You are codex-explore, a read-only repository analyst. Output ONLY JSON: {\"note\":\"one short line naming what was scanned\",\"files\":[\"path\", up to 5]}.",
          max_tokens: 400,
          messages: [{ role: "user", content: `Repo: ${project.repo}\nRequest:\n${text || "(use sensible defaults)"}` }],
        });
        const explored = parseJsonLike(exploreRaw) as { note?: string; files?: string[] } | null;
        const files = Array.isArray(explored?.files) ? explored.files.slice(0, 5) : [];
        const exploreNote = explored?.note
          ? `${explored.note}${files.length ? ` · ${files.slice(0, 3).join(", ")}` : ""}`
          : files.length ? `scanned ${files.slice(0, 3).join(", ")}` : "";
        const promptByKind: Record<IntakeKind, { system: string; body: string }> = {
          feature: {
            system:
              "You are the arc-creating-user-stories drafting agent. Convert feature requests into up to 4 independently deliverable Gherkin user stories. Output ONLY a JSON array of objects with title, epic, prio, size, userStory, acceptance, and summary.",
            body: `Features:\n${text || "Let users sign in with Google\nExport activity as CSV\nAdd empty states to the dashboard"}`,
          },
          prd: {
            system:
              "You are the arc-prd-to-issues drafting agent. Slice this PRD into up to 4 independently shippable tracer-bullet issues. Output ONLY a JSON array with title, epic, prio, size, afk, blockedBy, acceptance, userStoriesCovered, and summary.",
            body: `PRD:\n${text || "A dashboard showing per-user activity with CSV export and a rate-limited public API."}`,
          },
          bug: {
            system:
              "You are the arc-bug-finder drafting agent. Draft ONE root-caused bug ticket. Output ONLY a JSON object with title, severity, area, steps, rootCause, fixOptions, acceptance, and summary.",
            body: `Symptom:\n${text || "A screen shows a blank error instead of the expected content"}`,
          },
        };
        const spec = promptByKind[args.kind];
        const draftRaw = await model({
          system: spec.system,
          max_tokens: 2000,
          messages: [{ role: "user", content: `${spec.body}${files.length ? `\n\nGround items in these files where relevant: ${files.join(", ")}` : ""}` }],
        });
        const drafts = normalizeModelDrafts(args.kind, parseJsonLike(draftRaw));
        if (drafts.length) return { source: "model", exploreNote, drafts };
      } catch {
        // Fall through to deterministic proposals when the live harness cannot answer.
      }
    }

    return {
      source: "fallback",
      exploreNote: model && !project ? "Attach a Fable session to enable model-backed drafting" : "deterministic fallback used",
      drafts: fallbackDraftProposals(args.kind, text),
    };
  }

  private smallerSize(size: Story["size"]): Story["size"] {
    if (size === "XL") return "L";
    if (size === "L") return "M";
    return "S";
  }

  private storyProposalFromPart(story: Story, part: Record<string, unknown>, fallbackTitle: string): IntakeDraftProposal {
    const title = cap(String(part.title ?? fallbackTitle));
    const scenarios = normalizeScenarios(part.scenarios, [title]);
    return {
      include: true,
      type: story.type,
      title,
      priority: story.priority,
      size: this.smallerSize(story.size),
      summary: String(part.summary ?? part.userStory ?? part.description ?? `Refined child story for ${story.title}.`),
      description: String(part.userStory ?? part.description ?? story.description),
      epic: story.epic,
      taskClass: story.taskClass,
      tags: story.tags,
      criteria: criteriaFromScenarios(scenarios),
      scenarios,
      bug: story.type === "bug" ? story.bug : undefined,
      slice: story.type === "slice" ? story.slice : undefined,
    };
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
    if (this.client && this.state.status === "connected") {
      const result = await this.client.callTool(
        { name: "story.save", arguments: { story } },
        CallToolResultSchema
      );
      const saved = parseToolResult<Story>(result);
      this.updateStoryAndDetail(saved);
      return saved;
    }
    this.updateStoryAndDetail(story);
    return story;
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

  private fallbackSplit(story: Story): { story: Story; child: IntakeDraftProposal } {
    const criteria = story.criteria.length ? story.criteria : [`${story.title} works end to end`, "No existing behavior regresses"];
    const midpoint = Math.max(1, Math.ceil(criteria.length / 2));
    const firstCriteria = criteria.slice(0, midpoint);
    const secondCriteria = criteria.slice(midpoint);
    const childCriteria = secondCriteria.length ? secondCriteria : [`${story.title} follow-up path works end to end`];
    return {
      story: {
        ...story,
        title: refineTitlePart(story.title, 1),
        size: this.smallerSize(story.size),
        criteria: firstCriteria,
        scenarios: fallbackTightenedScenarios({ ...story, criteria: firstCriteria }),
      },
      child: {
        include: true,
        type: story.type,
        title: refineTitlePart(story.title, 2),
        priority: story.priority,
        size: this.smallerSize(story.size),
        summary: `Deterministic split-out child story for ${story.title}.`,
        description: story.description,
        epic: story.epic,
        taskClass: story.taskClass,
        tags: story.tags,
        criteria: childCriteria,
        scenarios: fallbackTightenedScenarios({ ...story, title: refineTitlePart(story.title, 2), criteria: childCriteria }),
        bug: story.type === "bug" ? story.bug : undefined,
        slice: story.type === "slice" ? story.slice : undefined,
      },
    };
  }

  async refineStory(id: string, action: RefineAction): Promise<RefineResult> {
    const story = this.state.stories[id] ?? await this.refreshStory(id);
    if (!story) throw new Error(`Unknown story: ${id}`);
    if (story.column !== "backlog") throw new Error("Only backlog stories can be refined");

    const siblings = Object.values(this.state.stories).filter((s) => s.id !== story.id && s.repo === story.repo);
    const canUseModel = !!(this.modelComplete && this.state.project);
    let source: IntakeDraftSource = "fallback";
    let note = "Deterministic fallback used.";
    let saved: Story = story;
    let children: Story[] = [];

    if (action === "split") {
      let split = this.fallbackSplit(story);
      if (canUseModel && this.modelComplete) {
        try {
          const raw = await this.modelComplete({
            system:
              "You split an over-large user story into exactly 2 smaller, independently deliverable Gherkin stories. Output ONLY a JSON array of exactly 2 objects with title, userStory, summary, and scenarios [{name,given,when,then,and?}].",
            max_tokens: 1200,
            messages: [{ role: "user", content: `Story: ${story.title}\n${story.description}\nCriteria: ${JSON.stringify(story.criteria)}` }],
          });
          const parsed = parseJsonLike(raw);
          const arr = Array.isArray(parsed) ? parsed : [];
          if (arr.length >= 2) {
            const first = (arr[0] && typeof arr[0] === "object" ? arr[0] : {}) as Record<string, unknown>;
            const firstTitle = cap(String(first.title ?? refineTitlePart(story.title, 1)));
            const firstScenarios = normalizeScenarios(first.scenarios, [firstTitle]);
            split = {
              story: {
                ...story,
                title: firstTitle,
                description: String(first.userStory ?? first.description ?? story.description),
                size: this.smallerSize(story.size),
                criteria: criteriaFromScenarios(firstScenarios),
                scenarios: firstScenarios,
              },
              child: this.storyProposalFromPart(story, arr[1] as Record<string, unknown>, refineTitlePart(story.title, 2)),
            };
            source = "model";
            note = "Model split this story into two smaller drafts.";
          }
        } catch {
          source = "fallback";
        }
      }
      saved = await this.saveStory(split.story);
      children = await this.createRefineChildren([split.child], story.repo);
      if (source === "fallback") note = "Fallback used: split into deterministic part 1 and part 2 drafts.";
      this.notify("success", `Split ${story.wid} into ${children.length + 1} stories`);
    } else if (action === "tighten") {
      let scenarios = fallbackTightenedScenarios(story);
      if (canUseModel && this.modelComplete) {
        try {
          const raw = await this.modelComplete({
            system:
              "You rewrite acceptance criteria to be crisper and more testable. Output ONLY a JSON array of scenario objects: {name,given,when,then,and?}. Keep the same intent; make each step observable and specific.",
            max_tokens: 1000,
            messages: [{ role: "user", content: `Story: ${story.title}\nCurrent: ${JSON.stringify([...(story.scenarios?.map((s) => s.name) ?? []), ...story.criteria])}` }],
          });
          const parsed = parseJsonLike(raw);
          const arr = Array.isArray(parsed) ? parsed : [];
          if (arr.length > 0) {
            scenarios = normalizeScenarios(arr, story.criteria.length ? story.criteria : [story.title]);
            source = "model";
            note = "Model tightened the acceptance criteria into testable scenarios.";
          }
        } catch {
          source = "fallback";
        }
      }
      saved = await this.saveStory({ ...story, criteria: criteriaFromScenarios(scenarios), scenarios });
      if (source === "fallback") note = "Fallback used: criteria were converted into deterministic Given/When/Then scenarios.";
      this.notify("success", `Tightened criteria for ${story.wid}`);
    } else {
      if (canUseModel && this.modelComplete) {
        try {
          const existing = siblings.map((s) => `${s.issue ?? s.wid} ${s.title}`).join("\n");
          const raw = await this.modelComplete({
            system:
              "You check whether a candidate story duplicates any existing sibling story. Output ONLY JSON: {\"duplicate\":true|false,\"of\":\"matching issue or story\",\"reason\":\"one sentence\"}. Do not delete anything.",
            max_tokens: 300,
            messages: [{ role: "user", content: `Candidate: ${story.title}\n${story.description}\nExisting:\n${existing}` }],
          });
          const parsed = parseJsonLike(raw);
          const obj = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown> | null;
          if (obj) {
            source = "model";
            note = obj.duplicate
              ? `Possible duplicate of ${String(obj.of ?? "an existing story")}${obj.reason ? ` — ${String(obj.reason)}` : ""}. Nothing was deleted.`
              : `No duplicate found${obj.reason ? ` — ${String(obj.reason)}` : ""}. Nothing was deleted.`;
          }
        } catch {
          source = "fallback";
        }
      }
      if (source === "fallback") {
        const overlap = bestDeterministicOverlap(story, siblings);
        note = overlap
          ? `Fallback used: possible overlap with ${overlap.story.issue ?? overlap.story.wid} “${overlap.story.title}” (${Math.round(overlap.score * 100)}% title/content similarity). Nothing was deleted.`
          : "Fallback used: no exact or high-similarity sibling overlap found. Nothing was deleted.";
      }
      this.notify("info", `Checked duplicates for ${story.wid}`);
    }

    return { action, source, note, story: saved, children };
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

const ROUTE_META: Record<RouteId, { label: string; color: string; model: string; access: Access }> = {
  "codex-explore": {
    label: "codex-explore",
    color: "var(--sq-route-explore)",
    model: "gpt-5.4-mini",
    access: "read-only",
  },
  "composer-explore": {
    label: "composer-explore",
    color: "var(--sq-route-composer)",
    model: "composer-2.5",
    access: "read-only",
  },
  "opus-explore": {
    label: "opus-explore",
    color: "var(--sq-route-review)",
    model: "opus-4.8",
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
  "opus-implement": {
    label: "opus-implement",
    color: "var(--sq-route-review)",
    model: "opus-4.8",
    access: "write",
  },
  "codex-check": {
    label: "codex-check",
    color: "var(--sq-route-check)",
    model: "gpt-5.5",
    access: "read-only",
  },
  "composer-check": {
    label: "composer-check",
    color: "var(--sq-route-composer)",
    model: "composer-2.5",
    access: "read-only",
  },
  "opus-check": {
    label: "opus-check",
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
