// arc-contracts — shared types, schemas, validators, and route metadata for the Story Queue pipeline.

import Ajv, { type ValidateFunction } from "ajv";

export {
  dispatchBlockReason,
  isDispatchEligible,
  mutexConflict,
  mutexKeysFromTags,
  storyMutexKeys,
} from "./concurrency.js";

export type Column = "backlog" | "queued" | "in_progress" | "review" | "done";
export type Priority = "high" | "med" | "low";
export type Size = "S" | "M" | "L" | "XL";
export type WorkType = "story" | "bug" | "slice";
export type TaskClass = "feature" | "bugfix" | "migration" | "refactor" | "perf" | "docs";
export type Severity = "S1" | "S2" | "S3" | "S4";

export type AnnotateOutcome = "accepted" | "rejected" | "blocked" | "verification-failed" | "escalated";
export type RunOutcome = AnnotateOutcome | "unrated";

export type Access = "read-only" | "write" | "parent";

export const ROUTES = [
  {
    id: "codex-explore",
    label: "codex-explore",
    backend: "Codex CLI",
    model: "gpt-5.4-mini",
    access: "read-only",
    color: "var(--sq-route-explore)",
    use: "Repo exploration, evidence gathering",
  },
  {
    id: "composer-explore",
    label: "composer-explore",
    backend: "Cursor Agent",
    model: "composer-2.5",
    access: "read-only",
    color: "var(--sq-route-composer)",
    use: "Composer fallback exploration",
  },
  {
    id: "opus-explore",
    label: "opus-explore",
    backend: "Claude Agent",
    model: "opus-4.8",
    access: "read-only",
    color: "var(--sq-route-review)",
    use: "Deep reasoning exploration",
  },
  {
    id: "composer-implement",
    label: "composer-implement",
    backend: "Cursor Agent",
    model: "composer-2.5",
    access: "write",
    color: "var(--sq-route-composer)",
    use: "Default bulk implementation",
  },
  {
    id: "codex-implement",
    label: "codex-implement",
    backend: "Codex CLI",
    model: "gpt-5.5",
    access: "write",
    color: "var(--sq-route-codex)",
    use: "Hard implementation / escalation",
  },
  {
    id: "opus-implement",
    label: "opus-implement",
    backend: "Claude Agent",
    model: "opus-4.8",
    access: "write",
    color: "var(--sq-route-review)",
    use: "High-taste implementation fallback",
  },
  {
    id: "codex-check",
    label: "codex-check",
    backend: "Codex CLI",
    model: "gpt-5.5",
    access: "read-only",
    color: "var(--sq-route-check)",
    use: "Independent review of changes",
  },
  {
    id: "composer-check",
    label: "composer-check",
    backend: "Cursor Agent",
    model: "composer-2.5",
    access: "read-only",
    color: "var(--sq-route-composer)",
    use: "Fast implementation check",
  },
  {
    id: "opus-check",
    label: "opus-check",
    backend: "Claude Agent",
    model: "opus-4.8",
    access: "read-only",
    color: "var(--sq-route-review)",
    use: "Deep verification and review",
  },
  {
    id: "fable",
    label: "fable",
    backend: "Claude Code",
    model: "orchestrator",
    access: "parent",
    color: "var(--sq-route-fable)",
    use: "Parent — runs every model",
  },
] as const;

export type RouteId = (typeof ROUTES)[number]["id"];
export type Route = (typeof ROUTES)[number];
export type RouteMetadata = Route;
export const ROUTE_METADATA = ROUTES;

export const ROUTE_ORDER = ROUTES.map((route) => route.id) as RouteId[];
export const READ_ONLY_ROUTE_IDS = ROUTES.filter((route) => route.access === "read-only").map((route) => route.id) as RouteId[];
export const READ_ONLY_ROUTES: ReadonlySet<RouteId> = new Set(READ_ONLY_ROUTE_IDS);

export function isRouteId(route: string): route is RouteId {
  return ROUTE_ORDER.includes(route as RouteId);
}

export function routeMeta(route: RouteId | string): RouteMetadata | null {
  return ROUTES.find((candidate) => candidate.id === route) ?? null;
}

export function routeLabel(route: RouteId | string): string {
  return routeMeta(route)?.label ?? route;
}

export function routeColor(route: RouteId | string): string {
  return routeMeta(route)?.color ?? "var(--sq-accent)";
}

export function routeModel(route: RouteId | string): string {
  return routeMeta(route)?.model ?? "unknown";
}

export function routeAccess(route: RouteId | string): Access {
  return routeMeta(route)?.access ?? "read-only";
}

export function routeNeedsWriteLock(route: RouteId | string): boolean {
  return routeAccess(route) !== "read-only";
}

export interface GherkinScenario {
  name: string;
  steps: Array<["Given" | "When" | "Then" | "And", string]>;
}

/** arc-planning-work output: the execution plan a worker runs against. */
export interface Plan {
  tasks: string[];
  files: Array<{ path: string; change: string }>;
  testStrategy: string;
  acMapping: Array<{ ac: string; by: string }>;
}

interface OrchestrationPlanDetails {
  route: RouteId;
  backend: string;
  mode: string;
  rationale: string;
  complexity: string;
  plannedAt: string;
  storyDigest: string;
}

/** Durable route planning state attached to a story before execution. */
export type OrchestrationPlan =
  | ({ status: "planned"; error?: string } & OrchestrationPlanDetails)
  | ({ status: "unplanned" | "planning" | "failed"; error?: string } & Partial<OrchestrationPlanDetails>);

/** Bug intake fields (arc-bug-finder). */
export interface BugDetail {
  severity: Severity;
  area: string;
  steps: string[];
  rootCause: string;      // "file:line — why"
  fixOptions: string[];   // recommended first
}

/** PRD slice fields (arc-prd-to-issues). */
export interface SliceDetail {
  afk: boolean;                 // false => needs a human decision (HITL)
  blockedBy: string | null;
  userStoriesCovered: string;
}

export type ShipMode = "pr" | "auto" | "merge";
export type ReviewVerdict = "pending" | "changes_requested" | "approved";

export interface ReviewLoop {
  round: number;
  maxRounds: number;
  verdict: ReviewVerdict;
  blockingCount: number;
  prCommentsUrl?: string;
}

export interface Story {
  id: string;
  wid: string;                  // "W-000001"
  type: WorkType;
  title: string;
  repo: string;                 // "acme/api"
  branch: string;
  worktree: string;             // "../wt/<slug>"
  column: Column;
  priority: Priority;
  size: Size;
  epic: string;
  taskClass: TaskClass;
  tags: string[];
  description: string;
  criteria: string[];
  scenarios?: GherkinScenario[];
  draft: boolean;               // true = potential issue, not yet filed
  fileRequested?: boolean;      // user asked Fable to file this draft to GitHub
  issue?: string | null;        // "#215" once filed through Fable
  pr?: string | null;
  prState?: "open" | "merged" | "closed";
  /** Epoch ms when the story entered Done (for automatic retention). */
  doneAt?: number;
  annotation?: AnnotateOutcome;
  plan?: Plan | null;
  orchestration?: OrchestrationPlan | null;
  bug?: BugDetail;
  slice?: SliceDetail;
  shipMode?: ShipMode;
  reviewLoop?: ReviewLoop | null;
}

/** Worker -> parent structured handoff (the compact result Fable evaluates). */
export interface Handoff {
  status: "completed" | "blocked" | "failed";
  summary: string;
  changes: string[];
  verification: string[];
  risks: string[];
  next_actions: string[];
}

/** One trace record per delegated run (observability). */
export interface RunRecord {
  id: string;
  storyId: string;
  label: string;
  repo: string;
  route: RouteId;
  backend: string;
  model: string;
  access: Access;
  tokens: number;
  durMs: number;
  startedAt?: number;           // epoch ms when the run began
  finishedAt?: number;            // epoch ms when the run ended
  status: "completed" | "failed";
  changed: number;              // files changed
  outcome: RunOutcome;
}

/** An attached, already-running agent session = a project. */
export interface Project {
  id: string;
  repo: string;
  path: string;                 // session cwd
  branch: string;
  model: string;
  pid: number;
  worktreeRoot: string;
  status: "attached" | "detached";
}

/** Durable daemon-side record of a repo path that can be reconnected later. */
export interface KnownProject {
  repo: string;
  path: string;
  branch: string;
  model: string;
  lastUsedAt: number;
  exists: boolean;
}

export interface FsDirEntry {
  name: string;
  path: string;
  isDir: boolean;
  isGitRepo: boolean;
}

export interface FsDirListing {
  path: string;
  parent: string | null;
  entries: FsDirEntry[];
}

/** Parallelism law enforced by the queue manager. */
export const PARALLELISM = {
  readOnlyRunsInParallel: true,           // explore/check/review never lock
  writeSerializesPerWorktree: true,       // advisory lock keyed by worktree
  separateWorktreesParallelizeWrites: true
} as const;

export type IntakeKind = "feature" | "prd" | "bug";
export interface IntakeItem {
  id: string;
  kind: IntakeKind;
  title: string;
  description: string;
  status: "pending" | "claimed" | "done";
  storyId?: string | null;   // set when intake.complete drafts a story
}

export type IntakeDraftSource = "model" | "fallback";

/** A selectable intake proposal generated by Fable/the harness or the fallback. */
export interface IntakeDraftProposal {
  include: boolean;
  type: WorkType;
  title: string;
  priority: Priority;
  size: Size;
  summary: string;
  description: string;
  epic: string;
  taskClass: TaskClass;
  tags?: string[];
  criteria: string[];
  scenarios?: GherkinScenario[];
  bug?: BugDetail;
  slice?: SliceDetail;
}

export interface IntakeGenerateResult {
  source: IntakeDraftSource;
  exploreNote: string;
  drafts: IntakeDraftProposal[];
}

/** Persisted daemon config (Orchestrator view controls). */
export interface AppConfig {
  autoRun: boolean;
  maxParallel: number;
  /** Require an approved orchestration plan before a queued story can be dispatched. */
  requireOrchestrationPlan: boolean;
}

/** Result of asking the queue to reserve its next runnable story. */
export type QueueNextResult =
  | { story: Story; reason?: never }
  | { story: null; reason?: "awaiting-orchestration-plan" };

/** Full drawer hydration: the story plus its persisted runs + handoff. */
export interface StoryDetail {
  story: Story;
  runs: RunRecord[];
  handoff: Handoff | null;
}

/** GitHub PR merge gate snapshot for the review drawer readiness strip. */
export interface PrReadiness {
  mergeStateStatus: string;
  failingChecks: string[];
  pendingChecks: string[];
}

export type BoardActionErrorCode =
  | "checks_failed"
  | "checks_pending"
  | "branch_policy"
  | "behind_base"
  | "already_merged"
  | "pr_closed"
  | "graphql"
  | "timeout"
  | "review_pending"
  | "max_rounds_exceeded"
  | "unknown";

export interface BoardActionError {
  code: BoardActionErrorCode;
  title: string;
  detail: string;
  actions: string[];
  retryable?: boolean;
  raw?: string;
}

const BOARD_ACTION_ERROR_CODES = new Set<BoardActionErrorCode>([
  "checks_failed",
  "checks_pending",
  "branch_policy",
  "behind_base",
  "already_merged",
  "pr_closed",
  "graphql",
  "timeout",
  "review_pending",
  "max_rounds_exceeded",
  "unknown",
]);

export function isBoardActionError(value: unknown): value is BoardActionError {
  if (!value || typeof value !== "object") return false;
  const candidate = value as BoardActionError;
  return (
    typeof candidate.code === "string" &&
    BOARD_ACTION_ERROR_CODES.has(candidate.code) &&
    typeof candidate.title === "string" &&
    typeof candidate.detail === "string" &&
    Array.isArray(candidate.actions) &&
    candidate.actions.every((action) => typeof action === "string") &&
    (candidate.retryable === undefined || typeof candidate.retryable === "boolean") &&
    (candidate.raw === undefined || typeof candidate.raw === "string")
  );
}

type JsonSchema = Record<string, unknown>;

const nonEmptyString = { type: "string", minLength: 1 } as const;
const stringArraySchema = { type: "array", items: { type: "string" } } as const;

const gherkinScenarioSchema: JsonSchema = {
  type: "object",
  required: ["name", "steps"],
  properties: {
    name: nonEmptyString,
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: [{ enum: ["Given", "When", "Then", "And"] }, nonEmptyString],
      },
    },
  },
  additionalProperties: false,
};

const planObjectSchema: JsonSchema = {
  type: "object",
  required: ["tasks", "files", "testStrategy", "acMapping"],
  properties: {
    tasks: { type: "array", items: nonEmptyString },
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "change"],
        properties: {
          path: nonEmptyString,
          change: nonEmptyString,
        },
        additionalProperties: false,
      },
    },
    testStrategy: nonEmptyString,
    acMapping: {
      type: "array",
      items: {
        type: "object",
        required: ["ac", "by"],
        properties: {
          ac: nonEmptyString,
          by: nonEmptyString,
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export const planSchema: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://arc.dev/schema/plan.json",
  title: "Plan",
  ...planObjectSchema,
};

const orchestrationPlanObjectSchema: JsonSchema = {
  type: "object",
  required: ["status"],
  properties: {
    status: { enum: ["unplanned", "planning", "planned", "failed"] },
    route: { enum: ROUTE_ORDER },
    backend: nonEmptyString,
    mode: nonEmptyString,
    rationale: nonEmptyString,
    complexity: nonEmptyString,
    plannedAt: nonEmptyString,
    storyDigest: nonEmptyString,
    error: nonEmptyString,
  },
  allOf: [
    {
      if: {
        properties: { status: { const: "planned" } },
        required: ["status"],
      },
      then: {
        required: ["route", "backend", "mode", "rationale", "complexity", "plannedAt", "storyDigest"],
      },
    },
  ],
  additionalProperties: false,
};

export const orchestrationPlanSchema: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://arc.dev/schema/orchestration-plan.json",
  title: "OrchestrationPlan",
  ...orchestrationPlanObjectSchema,
};

const bugDetailSchema: JsonSchema = {
  type: "object",
  required: ["severity", "area", "steps", "rootCause", "fixOptions"],
  properties: {
    severity: { enum: ["S1", "S2", "S3", "S4"] },
    area: nonEmptyString,
    steps: { type: "array", items: nonEmptyString },
    rootCause: nonEmptyString,
    fixOptions: { type: "array", items: nonEmptyString },
  },
  additionalProperties: false,
};

const sliceDetailSchema: JsonSchema = {
  type: "object",
  required: ["afk", "blockedBy", "userStoriesCovered"],
  properties: {
    afk: { type: "boolean" },
    blockedBy: { type: ["string", "null"] },
    userStoriesCovered: nonEmptyString,
  },
  additionalProperties: false,
};

const reviewLoopSchema: JsonSchema = {
  type: "object",
  required: ["round", "maxRounds", "verdict", "blockingCount"],
  properties: {
    round: { type: "integer", minimum: 0 },
    maxRounds: { type: "integer", minimum: 0 },
    verdict: { enum: ["pending", "changes_requested", "approved"] },
    blockingCount: { type: "integer", minimum: 0 },
    prCommentsUrl: { type: "string", minLength: 1 },
  },
  allOf: [
    {
      if: {
        properties: { verdict: { const: "approved" } },
        required: ["verdict"],
      },
      then: {
        properties: { blockingCount: { const: 0 } },
      },
    },
  ],
  additionalProperties: false,
};

export const storySchema: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://arc.dev/schema/story.json",
  title: "Story",
  type: "object",
  required: [
    "id",
    "wid",
    "type",
    "title",
    "repo",
    "branch",
    "worktree",
    "column",
    "priority",
    "size",
    "epic",
    "taskClass",
    "tags",
    "description",
    "criteria",
    "draft",
  ],
  properties: {
    id: nonEmptyString,
    wid: { type: "string", pattern: "^W-\\d{6}$" },
    type: { enum: ["story", "bug", "slice"] },
    title: nonEmptyString,
    repo: nonEmptyString,
    branch: { type: "string" },
    worktree: { type: "string" },
    column: { enum: ["backlog", "queued", "in_progress", "review", "done"] },
    priority: { enum: ["high", "med", "low"] },
    size: { enum: ["S", "M", "L", "XL"] },
    epic: { type: "string" },
    taskClass: { enum: ["feature", "bugfix", "migration", "refactor", "perf", "docs"] },
    tags: stringArraySchema,
    description: { type: "string" },
    criteria: stringArraySchema,
    scenarios: { type: "array", items: gherkinScenarioSchema },
    draft: { type: "boolean" },
    fileRequested: { type: "boolean" },
    issue: { type: ["string", "null"] },
    pr: { type: ["string", "null"] },
    prState: { enum: ["open", "merged", "closed"] },
    doneAt: { type: "number" },
    annotation: { enum: ["accepted", "rejected", "blocked", "verification-failed", "escalated"] },
    plan: { anyOf: [planObjectSchema, { type: "null" }] },
    orchestration: { anyOf: [orchestrationPlanObjectSchema, { type: "null" }] },
    bug: bugDetailSchema,
    slice: sliceDetailSchema,
    shipMode: { enum: ["pr", "auto", "merge"] },
    reviewLoop: { anyOf: [reviewLoopSchema, { type: "null" }] },
  },
  additionalProperties: false,
};

export const handoffSchema: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://arc.dev/schema/handoff.json",
  title: "Handoff",
  type: "object",
  required: ["status", "summary", "changes", "verification", "risks", "next_actions"],
  properties: {
    status: { enum: ["completed", "blocked", "failed"] },
    summary: { type: "string" },
    changes: stringArraySchema,
    verification: stringArraySchema,
    risks: stringArraySchema,
    next_actions: stringArraySchema,
  },
  additionalProperties: false,
};

export const runRecordSchema: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://arc.dev/schema/run-record.json",
  title: "RunRecord",
  type: "object",
  required: [
    "id",
    "storyId",
    "label",
    "repo",
    "route",
    "backend",
    "model",
    "access",
    "tokens",
    "durMs",
    "status",
    "changed",
    "outcome",
  ],
  properties: {
    id: nonEmptyString,
    storyId: nonEmptyString,
    label: nonEmptyString,
    repo: nonEmptyString,
    route: { enum: ROUTE_ORDER },
    backend: nonEmptyString,
    model: nonEmptyString,
    access: { enum: ["read-only", "write", "parent"] },
    tokens: { type: "integer", minimum: 0 },
    durMs: { type: "integer", minimum: 0 },
    startedAt: { type: "integer", minimum: 0 },
    finishedAt: { type: "integer", minimum: 0 },
    status: { enum: ["completed", "failed"] },
    changed: { type: "integer", minimum: 0 },
    outcome: { enum: ["accepted", "rejected", "blocked", "verification-failed", "escalated", "unrated"] },
  },
  additionalProperties: false,
};

export const projectSchema: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://arc.dev/schema/project.json",
  title: "Project",
  type: "object",
  required: ["id", "repo", "path", "branch", "model", "pid", "worktreeRoot", "status"],
  properties: {
    id: nonEmptyString,
    repo: nonEmptyString,
    path: nonEmptyString,
    branch: nonEmptyString,
    model: nonEmptyString,
    pid: { type: "integer", minimum: 0 },
    worktreeRoot: { type: "string" },
    status: { enum: ["attached", "detached"] },
  },
  additionalProperties: false,
};

export const boardActionErrorSchema: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://arc.dev/schema/board-action-error.json",
  title: "BoardActionError",
  type: "object",
  required: ["code", "title", "detail", "actions"],
  properties: {
    code: {
      enum: [
        "checks_failed",
        "checks_pending",
        "branch_policy",
        "behind_base",
        "already_merged",
        "pr_closed",
        "graphql",
        "timeout",
        "review_pending",
        "max_rounds_exceeded",
        "unknown",
      ],
    },
    title: nonEmptyString,
    detail: { type: "string" },
    actions: stringArraySchema,
    retryable: { type: "boolean" },
    raw: { type: "string" },
  },
  additionalProperties: false,
};

export const schemas = {
  story: storySchema,
  plan: planSchema,
  orchestrationPlan: orchestrationPlanSchema,
  handoff: handoffSchema,
  runRecord: runRecordSchema,
  project: projectSchema,
  boardActionError: boardActionErrorSchema,
} as const;

let ajvInstance: Ajv | null = null;
const validators = new Map<JsonSchema, ValidateFunction>();

function ajv(): Ajv {
  ajvInstance ??= new Ajv({ allErrors: true });
  return ajvInstance;
}

function validatorFor(schema: JsonSchema): ValidateFunction {
  const cached = validators.get(schema);
  if (cached) return cached;
  const validate = ajv().compile(schema);
  validators.set(schema, validate);
  return validate;
}

function assertSchema<T>(name: string, schema: JsonSchema, value: unknown): value is T {
  const validate = validatorFor(schema);
  if (!validate(value)) {
    throw new Error(`Invalid ${name}: ${ajv().errorsText(validate.errors, { separator: "; " })}`);
  }
  return true;
}

export function validateStory(story: unknown): story is Story {
  return assertSchema<Story>("Story", storySchema, story);
}

export function validateHandoff(handoff: unknown): handoff is Handoff {
  return assertSchema<Handoff>("Handoff", handoffSchema, handoff);
}

export function validatePlan(plan: unknown): plan is Plan {
  return assertSchema<Plan>("Plan", planSchema, plan);
}

export function validateOrchestrationPlan(plan: unknown): plan is OrchestrationPlan {
  const validate = validatorFor(orchestrationPlanSchema);
  if (!validate(plan)) {
    const route =
      plan !== null && typeof plan === "object" && "route" in plan
        ? ` route=${JSON.stringify((plan as Record<string, unknown>).route)};`
        : "";
    throw new Error(
      `Invalid OrchestrationPlan:${route} ${ajv().errorsText(validate.errors, { separator: "; " })}`
    );
  }
  return true;
}

export function validateRunRecord(run: unknown): run is RunRecord {
  return assertSchema<RunRecord>("RunRecord", runRecordSchema, run);
}

export function validateProject(project: unknown): project is Project {
  return assertSchema<Project>("Project", projectSchema, project);
}

/** Numeric suffix from a canonical work id (`W-000046` → `46`). */
export function widSequence(wid: string): number {
  const match = wid.match(/^W-(\d{6})$/);
  return match ? Number(match[1]) : 0;
}

/** First `W-XXXXXX` token in a title (e.g. `[W-000046] [pipeline] …`). */
export function parseWidFromTitle(title: string): string | null {
  const match = title.match(/\b(W-\d{6})\b/);
  return match?.[1] ?? null;
}

export function normalizeStory(
  value:
    | Story
    | (Omit<Partial<Story>, "orchestration"> & { orchestration?: unknown } & Record<string, unknown>)
): Story {
  return {
    id: String(value.id ?? ""),
    wid: String(value.wid ?? "W-000000"),
    type: (value.type === "bug" || value.type === "slice" || value.type === "story" ? value.type : "story"),
    title: String(value.title ?? "Untitled"),
    repo: String(value.repo ?? ""),
    branch: String(value.branch ?? ""),
    worktree: String(value.worktree ?? ""),
    column:
      value.column === "queued" || value.column === "in_progress" || value.column === "review" || value.column === "done"
        ? value.column
        : "backlog",
    priority: value.priority === "high" || value.priority === "low" || value.priority === "med" ? value.priority : "med",
    size: value.size === "S" || value.size === "L" || value.size === "XL" || value.size === "M" ? value.size : "M",
    epic: String(value.epic ?? ""),
    taskClass:
      value.taskClass === "bugfix" ||
      value.taskClass === "migration" ||
      value.taskClass === "refactor" ||
      value.taskClass === "perf" ||
      value.taskClass === "docs" ||
      value.taskClass === "feature"
        ? value.taskClass
        : "feature",
    tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
    description: String(value.description ?? ""),
    criteria: Array.isArray(value.criteria) ? value.criteria.map(String) : [],
    ...(Array.isArray(value.scenarios) ? { scenarios: value.scenarios } : {}),
    draft: typeof value.draft === "boolean" ? value.draft : false,
    ...(typeof value.fileRequested === "boolean" ? { fileRequested: value.fileRequested } : {}),
    ...(typeof value.issue === "string" || value.issue === null ? { issue: value.issue } : {}),
    ...(typeof value.pr === "string" || value.pr === null ? { pr: value.pr } : {}),
    ...(value.prState === "open" || value.prState === "merged" || value.prState === "closed" ? { prState: value.prState } : {}),
    ...(typeof value.doneAt === "number" ? { doneAt: value.doneAt } : {}),
    ...(
      value.annotation === "accepted" ||
      value.annotation === "rejected" ||
      value.annotation === "blocked" ||
      value.annotation === "verification-failed" ||
      value.annotation === "escalated"
        ? { annotation: value.annotation }
        : {}
    ),
    ...(value.plan === null || (value.plan && typeof value.plan === "object") ? { plan: value.plan as Plan | null } : {}),
    orchestration:
      value.orchestration !== null && typeof value.orchestration === "object" && !Array.isArray(value.orchestration)
        ? (value.orchestration as OrchestrationPlan)
        : { status: "unplanned" },
    ...(value.bug && typeof value.bug === "object" ? { bug: value.bug as BugDetail } : {}),
    ...(value.slice && typeof value.slice === "object" ? { slice: value.slice as SliceDetail } : {}),
    ...(value.shipMode === "auto" || value.shipMode === "merge" || value.shipMode === "pr"
      ? { shipMode: value.shipMode }
      : "shipMode" in value
        ? { shipMode: "pr" as ShipMode }
        : {}),
    ...(value.reviewLoop && typeof value.reviewLoop === "object" && !Array.isArray(value.reviewLoop)
      ? { reviewLoop: value.reviewLoop as ReviewLoop }
      : {}),
    ...(value.reviewLoop === null ? { reviewLoop: null } : {}),
  };
}
