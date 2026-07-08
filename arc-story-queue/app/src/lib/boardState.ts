import type {
  AppConfig,
  Column,
  Project,
  RunRecord,
  IntakeItem,
  Story,
  StoryDetail,
} from "arc-contracts";
import type { AppNotification, Toast } from "./notifications";

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

export type BoardListener = (state: BoardState) => void;

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

export function projectIdentity(project: Pick<Project, "repo" | "path">): string {
  return `${project.repo}\u0000${project.path}`;
}

export function activeRepoFilter(state: BoardState, repo?: string): ((story: { repo: string }) => boolean) {
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
