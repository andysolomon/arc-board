import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isRouteId,
  routeMeta,
  routeAccess,
  routeModel,
  routeNeedsWriteLock,
  type RouteId,
  type RunRecord,
  type Story,
} from "arc-contracts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export type OrchestratorBackend = "composer" | "codex" | "claude";
export type OrchestratorMode = "analyze" | "implement" | "review";
export type AnalysisFallbackBackend = Exclude<OrchestratorBackend, "codex">;

export interface OrchestratorRunResult {
  status: "completed" | "blocked";
  summary: string;
  changes: string[];
  verification: string[];
  risks: string[];
  next_actions: string[];
}

export interface OrchestrationAnalysis {
  route: RouteId;
  backend: OrchestratorBackend;
  mode: "implement";
  rationale: string;
  complexity: string;
}

type OrchestratorSandbox = "read-only" | "workspace-write";
/** Upstream `task_class_variants` record; retains the matching semantics verbatim. */
export interface OrchestratorTaskClassVariant {
  task_class: string;
  case_sensitive: boolean;
  trim_whitespace: boolean;
  model: string;
}
export interface OrchestratorRouteCapability {
  id: RouteId;
  backend: OrchestratorBackend;
  mode: OrchestratorMode;
  model: string;
  sandbox: OrchestratorSandbox;
  guidance: string;
  taskClassVariants?: OrchestratorTaskClassVariant[];
}
export interface OrchestratorRouteProfile {
  schema_version: 1;
  source: "fable-orchestrator";
  routes: OrchestratorRouteCapability[];
}
export type AnalysisCapabilityGuidance =
  | { kind: "profile"; profile: OrchestratorRouteProfile }
  | { kind: "built-in"; fallbackReason: "profile-command-unavailable" };

export interface OrchestratorTraceRecord {
  run_id: string;
  backend: OrchestratorBackend;
  mode: OrchestratorMode;
  model: string;
  label?: string;
  duration_ms: number;
  status: string;
  changed_files: number | null;
  tokens: { total_tokens: number } | null;
  error: string | null;
}

export interface OrchestratorExecutorOptions {
  bin?: string;
  /**
   * Compatibility switch for the runner's built-in Codex -> Claude retry.
   * Omit for the safe default; set false to explicitly disable it.
   */
  fallbackClaude?: boolean;
  /** Ordered opt-in analysis fallbacks. Composer is write-capable, even when its task is analysis-only. */
  analysisFallbacks?: AnalysisFallbackBackend[];
}

export interface StreamLineFn {
  (
    client: Client,
    story: Story,
    route: RouteId,
    kind: "cmd" | "out" | "ok" | "lock" | "unlock",
    text: string,
    status?: "running" | "done"
  ): Promise<void>;
}

const BACKEND_LABEL: Record<OrchestratorBackend, string> = {
  composer: "Cursor Agent",
  codex: "Codex CLI",
  claude: "Claude Agent",
};

export function discoverPluginOrchestratorBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    join(homedir(), ".claude/plugins/cache/fable-orchestrator/fable-orchestrator"),
    env.CLAUDE_CONFIG_DIR
      ? join(env.CLAUDE_CONFIG_DIR, "plugins/cache/fable-orchestrator/fable-orchestrator")
      : null,
  ].filter((path): path is string => Boolean(path));
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root)
      .filter((version) => existsSync(join(root, version, "bin/fable-orchestrator")))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions[0]) return join(root, versions[0], "bin/fable-orchestrator");
  }
  return null;
}

export function resolveOrchestratorBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARC_ORCHESTRATOR_BIN?.trim() || env.FABLE_ORCHESTRATOR_BIN?.trim() || discoverPluginOrchestratorBin(env) || "fable-orchestrator";
}

export function orchestratorRoute(backend: OrchestratorBackend, mode: OrchestratorMode): RouteId {
  const routes: Partial<Record<`${OrchestratorBackend}:${OrchestratorMode}`, RouteId>> = {
    "composer:implement": "composer-implement",
    "codex:analyze": "codex-explore",
    "codex:implement": "codex-implement",
    "codex:review": "codex-check",
    "claude:analyze": "opus-explore",
    "claude:implement": "opus-implement",
    "claude:review": "opus-check",
  };
  const route = routes[`${backend}:${mode}`];
  return route && isRouteId(route) ? route : "composer-implement";
}

const PROFILE_EXECUTABLE_ROUTES: Readonly<Record<`${OrchestratorBackend}:${OrchestratorMode}`, RouteId | undefined>> = {
  "composer:analyze": undefined, "composer:implement": "composer-implement", "composer:review": undefined,
  "codex:analyze": "codex-explore", "codex:implement": "codex-implement", "codex:review": "codex-check",
  "claude:analyze": "opus-explore", "claude:implement": "opus-implement", "claude:review": "opus-check",
};

function profileRouteFor(backend: OrchestratorBackend, mode: OrchestratorMode): RouteId | null {
  return PROFILE_EXECUTABLE_ROUTES[`${backend}:${mode}`] ?? null;
}

function requiredProfileText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid orchestrator route profile: ${field} must be a non-empty string`);
  return value.trim();
}

function routeSandbox(route: RouteId): OrchestratorSandbox | null {
  const access = routeMeta(route)?.access;
  return access === "read-only" ? "read-only" : access === "write" ? "workspace-write" : null;
}

const TASK_CLASS_VARIANT_KEYS = ["task_class", "case_sensitive", "trim_whitespace", "model"] as const;

function requiredProfileBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid orchestrator route profile: ${field} must be a boolean`);
  return value;
}

/** Strictly consume upstream `task_class_variants`, preserving case/trim matching config. */
function parseTaskClassVariants(value: unknown, index: number): OrchestratorTaskClassVariant[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Invalid orchestrator route profile: routes[${index}].task_class_variants must be an array`);
  const seen = new Set<string>();
  return value.map((entry, variantIndex): OrchestratorTaskClassVariant => {
    const field = `routes[${index}].task_class_variants[${variantIndex}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid orchestrator route profile: ${field} must be an object`);
    const variant = entry as Record<string, unknown>;
    for (const key of Object.keys(variant)) {
      if (!(TASK_CLASS_VARIANT_KEYS as readonly string[]).includes(key)) throw new Error(`Invalid orchestrator route profile: ${field} has unknown key ${JSON.stringify(key)}`);
    }
    const taskClass = requiredProfileText(variant.task_class, `${field}.task_class`);
    const caseSensitive = requiredProfileBoolean(variant.case_sensitive, `${field}.case_sensitive`);
    const trimWhitespace = requiredProfileBoolean(variant.trim_whitespace, `${field}.trim_whitespace`);
    const model = requiredProfileText(variant.model, `${field}.model`);
    const normalized = trimWhitespace ? taskClass.trim() : taskClass;
    const key = caseSensitive ? normalized : normalized.toLowerCase();
    if (seen.has(key)) throw new Error(`Invalid orchestrator route profile: ${field} duplicates task_class ${JSON.stringify(taskClass)}`);
    seen.add(key);
    return { task_class: taskClass, case_sensitive: caseSensitive, trim_whitespace: trimWhitespace, model };
  });
}

/** Human-readable variant guidance for the planner analysis contract. */
function renderTaskClassVariants(variants?: OrchestratorTaskClassVariant[]): string {
  if (!variants?.length) return "none";
  return variants.map((variant) => `${variant.task_class}=>${variant.model} (case_sensitive=${variant.case_sensitive}, trim_whitespace=${variant.trim_whitespace})`).join(", ");
}

/** Validate all upstream records up front; never use a valid prefix of a profile. */
export function parseOrchestratorRouteProfile(stdout: string): OrchestratorRouteProfile {
  let raw: unknown;
  try { raw = JSON.parse(stdout.trim()); } catch { throw new Error("Invalid orchestrator route profile: routes --json produced invalid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid orchestrator route profile: expected an object");
  const profile = raw as Record<string, unknown>;
  if (profile.schema_version !== 1) throw new Error(`Unsupported orchestrator route profile schema_version: ${JSON.stringify(profile.schema_version)}`);
  if (profile.source !== "fable-orchestrator") throw new Error(`Unsupported orchestrator route profile source: ${JSON.stringify(profile.source)}`);
  if (!Array.isArray(profile.routes) || !profile.routes.length) throw new Error("Invalid orchestrator route profile: routes must be a non-empty array");
  const routes = profile.routes.map((item, index): OrchestratorRouteCapability => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid orchestrator route profile: routes[${index}] must be an object`);
    const route = item as Record<string, unknown>;
    const id = requiredProfileText(route.id, `routes[${index}].id`);
    if (!isRouteId(id)) throw new Error(`Invalid orchestrator route profile: routes[${index}] has unknown route id ${JSON.stringify(id)}`);
    const backend = requiredProfileText(route.backend, `routes[${index}].backend`);
    const mode = requiredProfileText(route.mode, `routes[${index}].mode`);
    if (!isOrchestratorBackend(backend) || !isOrchestratorMode(mode) || profileRouteFor(backend, mode) !== id) {
      throw new Error(`Invalid orchestrator route profile: routes[${index}] conflicts with executable backend/mode mapping`);
    }
    const sandbox = requiredProfileText(route.sandbox, `routes[${index}].sandbox`);
    if ((sandbox !== "read-only" && sandbox !== "workspace-write") || routeSandbox(id) !== sandbox) {
      throw new Error(`Invalid orchestrator route profile: routes[${index}] sandbox conflicts with registered route access`);
    }
    const taskClassVariants = parseTaskClassVariants(route.task_class_variants, index);
    return { id, backend, mode, sandbox, model: requiredProfileText(route.model, `routes[${index}].model`), guidance: requiredProfileText(route.guidance, `routes[${index}].guidance`), taskClassVariants };
  });
  const expected = Object.values(PROFILE_EXECUTABLE_ROUTES).filter((route): route is RouteId => Boolean(route));
  if (new Set(routes.map((route) => route.id)).size !== routes.length || routes.length !== expected.length || expected.some((id) => !routes.some((route) => route.id === id))) {
    throw new Error("Invalid orchestrator route profile: profile does not contain the complete executable route catalog");
  }
  return { schema_version: 1, source: "fable-orchestrator", routes };
}

class ProfileCommandUnavailableError extends Error {}

export async function resolveAnalysisCapabilityGuidance(bin: string, signal?: AbortSignal): Promise<AnalysisCapabilityGuidance> {
  try {
    const profile = await new Promise<OrchestratorRouteProfile>((resolve, reject) => {
    const child = spawn(bin, ["routes", "--json"], { signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-12_000); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.name === "AbortError" || error.code === "ABORT_ERR") return reject(error);
      if (error.code === "ENOENT") return reject(new ProfileCommandUnavailableError("orchestrator route profile command is unavailable"));
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        if (/expected the run command|(?:unknown|unrecognized|invalid) (?:command|subcommand)|unknown option/i.test(stderr)) return reject(new ProfileCommandUnavailableError("orchestrator route profile command is unsupported by this runner"));
        return reject(new Error(`orchestrator route profile command exited with code ${code}: ${stderr.trim() || "no stderr"}`));
      }
      try { resolve(parseOrchestratorRouteProfile(stdout)); } catch (error) { reject(error); }
    });
    });
    return { kind: "profile", profile };
  } catch (error) {
    if (error instanceof ProfileCommandUnavailableError) return { kind: "built-in", fallbackReason: "profile-command-unavailable" };
    throw error;
  }
}

function guidanceForRoute(guidance: AnalysisCapabilityGuidance, route: RouteId): string {
  if (guidance.kind === "profile") {
    const capability = guidance.profile.routes.find((candidate) => candidate.id === route);
    if (!capability) throw new Error(`Invalid orchestration analysis: route ${JSON.stringify(route)} is absent from the validated route profile`);
    return capability.guidance;
  }
  return routeMeta(route)?.use ?? "registered built-in route metadata";
}

const DEFAULT_BACKEND: OrchestratorBackend = "composer";
const DEFAULT_MODE: OrchestratorMode = "implement";

export interface ResolvedOrchestrationExecution {
  backend: OrchestratorBackend;
  mode: OrchestratorMode;
  route: RouteId;
  usedFallback: boolean;
}

/**
 * Daemon configuration for background analysis. The default deliberately uses
 * the runner's native Codex -> Claude fallback; `none` (or `off`) makes an
 * explicit no-fallback deployment possible. Composer is never implicit.
 */
export function resolveAnalysisFallbacks(env: NodeJS.ProcessEnv = process.env): AnalysisFallbackBackend[] {
  const configured = env.ARC_ORCHESTRATION_ANALYZE_FALLBACKS?.trim();
  if (!configured) return ["claude"];
  if (["none", "off", "false", "0"].includes(configured.toLowerCase())) return [];
  const fallbacks = configured.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!fallbacks.length || fallbacks.some((value) => value !== "claude" && value !== "composer")) {
    throw new Error("ARC_ORCHESTRATION_ANALYZE_FALLBACKS must be none, claude, composer, or a comma-separated claude,composer chain");
  }
  if (new Set(fallbacks).size !== fallbacks.length) {
    throw new Error("ARC_ORCHESTRATION_ANALYZE_FALLBACKS must not repeat a backend");
  }
  return fallbacks as AnalysisFallbackBackend[];
}

function analysisFallbacks(opts: OrchestratorExecutorOptions): AnalysisFallbackBackend[] {
  if (opts.analysisFallbacks) return opts.analysisFallbacks;
  return opts.fallbackClaude === false ? [] : ["claude"];
}

function isOrchestratorBackend(value: string): value is OrchestratorBackend {
  return value === "composer" || value === "codex" || value === "claude";
}

function isOrchestratorMode(value: string): value is OrchestratorMode {
  return value === "analyze" || value === "implement" || value === "review";
}

/** Read the story's persisted orchestration plan or fall back to composer/implement. */
export function resolveOrchestrationExecution(story: Story): ResolvedOrchestrationExecution {
  const plan = story.orchestration;
  if (plan?.status === "planned" && plan.route && plan.backend && plan.mode) {
    const route = plan.route;
    if (!isRouteId(route)) {
      throw new Error(`Invalid orchestration plan: route ${JSON.stringify(route)} is not registered`);
    }
    if (!isOrchestratorBackend(plan.backend)) {
      throw new Error(`Invalid orchestration plan: backend ${JSON.stringify(plan.backend)} is not a CLI id`);
    }
    if (!isOrchestratorMode(plan.mode)) {
      throw new Error(`Invalid orchestration plan: mode ${JSON.stringify(plan.mode)} is not supported`);
    }
    const expectedRoute = orchestratorRoute(plan.backend, plan.mode);
    if (route !== expectedRoute) {
      throw new Error(
        `Invalid orchestration plan: route ${JSON.stringify(route)} does not match backend and mode (expected ${JSON.stringify(expectedRoute)})`
      );
    }
    return { backend: plan.backend, mode: plan.mode, route, usedFallback: false };
  }
  return {
    backend: DEFAULT_BACKEND,
    mode: DEFAULT_MODE,
    route: orchestratorRoute(DEFAULT_BACKEND, DEFAULT_MODE),
    usedFallback: true,
  };
}

function compactLabel(value: string, max = 48): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
}

/** Task contract aligned with fable-orchestrator /orchestrate requirements. */
export function buildOrchestratorTaskContract(story: Story): string {
  const criteria = story.criteria.length ? story.criteria.map((criterion) => `- ${criterion}`).join("\n") : "- Verify the accepted behavior before handoff.";
  const tasks = story.plan?.tasks?.length ? story.plan.tasks.map((task, index) => `${index + 1}. ${task}`).join("\n") : "Inspect the repo and make the smallest correct change.";
  return [
    `Implement story ${story.wid} in the target worktree only.`, "", "## Outcome", story.description || story.title, "",
    "## Scope", `Repo: ${story.repo}`, `Branch: ${story.branch}`, `Worktree: ${story.worktree}`, "",
    "### Plan tasks", tasks, "", "## Verification", story.plan?.testStrategy || criteria, "", "## Prohibited",
    "No commits, pushes, merges, deployments, or unrelated refactors.",
  ].join("\n");
}

/**
 * The analysis command is read-only, but its recommendation is the executable
 * route that will be persisted for a later worker. Keep that plan inside the
 * standard worker `summary` field: fable-orchestrator rejects extra top-level
 * keys in its handoff schema.
 */
export function buildOrchestrationAnalysisTaskContract(story: Story, capabilityGuidance: AnalysisCapabilityGuidance = { kind: "built-in", fallbackReason: "profile-command-unavailable" }): string {
  const criteria = story.criteria.length ? story.criteria.map((criterion) => `- ${criterion}`).join("\n") : "- No explicit criteria supplied.";
  const routes = capabilityGuidance.kind === "profile"
    ? capabilityGuidance.profile.routes.map((route) => `- ${route.id}: backend=${route.backend}; mode=${route.mode}; model=${route.model}; sandbox=${route.sandbox}; task_class_variants=${renderTaskClassVariants(route.taskClassVariants)}; guidance=${JSON.stringify(route.guidance)}`).join("\n")
    : ["codex-implement", "composer-implement", "opus-implement"].map((route) => `- ${route}: guidance=${JSON.stringify(guidanceForRoute(capabilityGuidance, route as RouteId))}`).join("\n");
  const provenance = capabilityGuidance.kind === "profile" ? "[profile:fable-orchestrator@1 route=<route id>] followed by the selected route guidance quoted verbatim" : "[built-in-routes fallback=profile-command-unavailable route=<route id>] followed by the selected route guidance quoted verbatim";
  return [
    `Analyze queued story ${story.wid} in the attached repository.`, "", "## Story", story.description || story.title,
    "", "## Acceptance criteria", criteria, "", "## Constraints",
    "Read repository files only. Do not create a worktree, modify files, acquire a write lock, commit, push, merge, or deploy.",
    "", "## Required JSON result", "Return exactly this top-level JSON object and no additional keys:",
    '{"status":"completed","summary":"<strict execution-plan JSON>","changes":[],"verification":[],"risks":[],"next_actions":[]}',
    "`summary` must be a JSON-encoded object (not prose) with exactly these keys:",
    '{"route":"<executable route id>","backend":"<backend CLI id>","mode":"implement","rationale":"<why>","complexity":"<level>"}',
    "Use backend CLI ids (`composer`, `codex`, or `claude`). The recommended route must equal the registered route for that backend and mode (for example `codex`, `implement`, `codex-implement`).",
    "", "## Validated routing capability guidance", routes, `The rationale must cite ${provenance}.`,
  ].join("\n");
}

/** Composer only exposes implement mode, so make its opt-in fallback contract explicit and non-authorizing. */
export function buildComposerAnalysisTaskContract(story: Story, capabilityGuidance: AnalysisCapabilityGuidance = { kind: "built-in", fallbackReason: "profile-command-unavailable" }): string {
  return [
    buildOrchestrationAnalysisTaskContract(story, capabilityGuidance), "", "## Composer fallback restriction",
    "This is an analysis-only fallback despite Composer's implement mode. Do not modify files, create a worktree, acquire a lock, commit, push, merge, or deploy.",
    "Return the required strict execution-plan JSON with backend `composer`, mode `implement`, and route `composer-implement`.",
  ].join("\n");
}

export function orchestratorRunArgs(
  story: Story,
  backend: OrchestratorBackend,
  mode: OrchestratorMode,
  bin: string,
  opts: { fallbackClaude?: boolean; cwd?: string; task?: string } = {}
): { command: string; args: string[] } {
  const cwd = opts.cwd ?? story.worktree;
  if (!cwd) throw new Error(`Story ${story.id} has no worktree`);
  const label = `${story.wid}-${compactLabel(story.title)}`.slice(0, 80);
  const args = ["run", "--backend", backend, "--mode", mode, "--task", opts.task ?? buildOrchestratorTaskContract(story), "--cwd", cwd, "--label", label];
  if (opts.fallbackClaude && backend === "codex") args.push("--fallback", "claude");
  return { command: bin, args };
}

export function orchestratorAnalyzeArgs(story: Story, repositoryPath: string, bin: string, opts: Pick<OrchestratorExecutorOptions, "fallbackClaude" | "analysisFallbacks"> = {}) {
  const fallbacks = analysisFallbacks(opts);
  return orchestratorRunArgs(story, "codex", "analyze", bin, {
    fallbackClaude: fallbacks.length === 1 && fallbacks[0] === "claude",
    cwd: repositoryPath,
    task: buildOrchestrationAnalysisTaskContract(story),
  });
}

export function orchestratorCommandLine(bin: string, args: string[]): string {
  return `${bin} ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`;
}

export function traceToRunRecord(trace: OrchestratorTraceRecord, story: Story, route: RouteId): RunRecord {
  return {
    id: trace.run_id, storyId: story.id, label: trace.label ?? `${story.wid} orchestrator`, repo: story.repo, route,
    backend: BACKEND_LABEL[trace.backend], model: trace.model, access: routeAccess(route), tokens: trace.tokens?.total_tokens ?? 0,
    durMs: trace.duration_ms, status: trace.status === "completed" || trace.status === "blocked" ? "completed" : "failed",
    changed: trace.changed_files ?? 0, outcome: "unrated",
  };
}

const WORKER_RESULT_KEYS = ["status", "summary", "changes", "verification", "risks", "next_actions"] as const;

export function parseOrchestratorStdout(stdout: string): OrchestratorRunResult {
  const line = stdout.trim().split("\n").map((part) => part.trim()).filter(Boolean).at(-1);
  if (!line) throw new Error("fable-orchestrator produced no JSON result on stdout");
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new Error("fable-orchestrator produced invalid JSON on stdout"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("fable-orchestrator returned an invalid worker result");
  const result = parsed as Record<string, unknown>;
  if (
    Object.keys(result).length !== WORKER_RESULT_KEYS.length ||
    WORKER_RESULT_KEYS.some((field) => !(field in result)) ||
    Object.keys(result).some((field) => !WORKER_RESULT_KEYS.includes(field as typeof WORKER_RESULT_KEYS[number]))
  ) {
    throw new Error("fable-orchestrator returned an invalid worker result: unexpected top-level fields");
  }
  if ((result.status !== "completed" && result.status !== "blocked") || typeof result.summary !== "string" || !result.summary.trim()) {
    throw new Error("fable-orchestrator returned an invalid worker result");
  }
  for (const field of ["changes", "verification", "risks", "next_actions"] as const) {
    if (!Array.isArray(result[field]) || !result[field].every((value) => typeof value === "string")) {
      throw new Error(`fable-orchestrator returned an invalid worker result: ${field}`);
    }
  }
  return result as unknown as OrchestratorRunResult;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid orchestration analysis: ${name} must be a non-empty string`);
  return value.trim();
}

/** Strictly extract the persisted execution recommendation from an analyze result. */
export function extractOrchestrationAnalysis(result: OrchestratorRunResult, capabilityGuidance?: AnalysisCapabilityGuidance): OrchestrationAnalysis {
  if (result.status !== "completed") throw new Error("Invalid orchestration analysis: analyze worker did not complete");
  let raw: unknown;
  try { raw = JSON.parse(result.summary); } catch { throw new Error("Invalid orchestration analysis: summary must contain JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid orchestration analysis: summary must contain an execution plan object");
  const value = raw as Record<string, unknown>;
  const planKeys = ["route", "backend", "mode", "rationale", "complexity"] as const;
  if (
    Object.keys(value).length !== planKeys.length ||
    planKeys.some((field) => !(field in value)) ||
    Object.keys(value).some((field) => !planKeys.includes(field as typeof planKeys[number]))
  ) {
    throw new Error("Invalid orchestration analysis: execution plan has unexpected fields");
  }
  const backend = requiredText(value.backend, "backend");
  if (backend !== "composer" && backend !== "codex" && backend !== "claude") {
    throw new Error(`Invalid orchestration analysis: backend must be a CLI id (received ${JSON.stringify(backend)})`);
  }
  const route = requiredText(value.route, "route");
  const mode = requiredText(value.mode, "mode");
  if (mode !== "implement") throw new Error(`Invalid orchestration analysis: mode must be implement (received ${JSON.stringify(mode)})`);
  const expectedRoute = orchestratorRoute(backend, mode);
  if (!isRouteId(route) || route !== expectedRoute) {
    throw new Error(`Invalid orchestration analysis: route must match backend and mode (expected ${JSON.stringify(expectedRoute)}, received ${JSON.stringify(route)})`);
  }
  const analysis: OrchestrationAnalysis = {
    route: route as RouteId,
    backend: backend as OrchestratorBackend,
    mode: "implement",
    rationale: requiredText(value.rationale, "rationale"),
    complexity: requiredText(value.complexity, "complexity"),
  };
  if (capabilityGuidance) {
    const provenance = capabilityGuidance.kind === "profile"
      ? `[profile:fable-orchestrator@1 route=${analysis.route}]`
      : `[built-in-routes fallback=profile-command-unavailable route=${analysis.route}]`;
    if (!analysis.rationale.includes(provenance) || !analysis.rationale.includes(guidanceForRoute(capabilityGuidance, analysis.route))) {
      throw new Error("Invalid orchestration analysis: rationale must cite the selected route guidance and provenance");
    }
  }
  return analysis;
}

export async function runOrchestratorPhase(
  story: Story,
  backend: OrchestratorBackend,
  mode: OrchestratorMode,
  opts: OrchestratorExecutorOptions & {
    cwd?: string;
    task?: string;
    signal?: AbortSignal;
    /** Observes stderr as it arrives while retaining the bounded diagnostic buffer. */
    onStderr?: StderrObserver;
  } = {}
): Promise<{ result: OrchestratorRunResult; stderr: string }> {
  const bin = opts.bin ?? resolveOrchestratorBin();
  const { command, args } = orchestratorRunArgs(story, backend, mode, bin, opts);
  const cwd = opts.cwd ?? story.worktree;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal: opts.signal, env: { ...process.env, ARC_STORY_ID: story.id, ARC_STORY_WID: story.wid, ARC_STORY_WORKTREE: story.worktree }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-12_000);
      try {
        // stderr observers are diagnostic telemetry. A failed observer must
        // never turn a successful runner result into a failed orchestration.
        void Promise.resolve(opts.onStderr?.(chunk)).catch(() => undefined);
      } catch {
        // A synchronous observer failure is likewise telemetry-only.
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        // Flush the final unterminated stderr line before resolving. This is
        // important for runners that print their retry marker without `\n`.
        void Promise.resolve(opts.onStderr?.flush?.()).catch(() => undefined);
      } catch {
        // Observer failures are non-fatal activity telemetry.
      }
      if (code !== 0) return reject(new Error(`fable-orchestrator exited with code ${code}: ${stderr.trim() || "no stderr"}`));
      try { resolve({ result: parseOrchestratorStdout(stdout), stderr }); } catch (error) { reject(error); }
    });
  });
}

const BUILT_IN_CLAUDE_RETRY_MARKER = /^fable-orchestrator: codex unavailable \((.+)\); retrying on claude backend$/;

/**
 * The runner reports its native fallback on one stderr line. Buffer only an
 * incomplete line so detection remains correct even when stream chunks split
 * the marker, while malformed or duplicate lines cannot trigger another retry.
 */
interface StderrObserver {
  (chunk: string): Promise<void> | void;
  flush?: () => Promise<void> | void;
}

function observeBuiltInClaudeRetry(
  onRetry: (error: string) => Promise<void> | void
): StderrObserver {
  let incompleteLine = "";
  let observed = false;
  const observeLine = (rawLine: string): Promise<void> | void => {
    if (observed) return;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = BUILT_IN_CLAUDE_RETRY_MARKER.exec(line);
    const error = match?.[1]?.trim();
    if (!error) return;
    observed = true;
    return onRetry(error);
  };
  const observer: StderrObserver = (chunk) => {
    if (observed) return;
    incompleteLine += chunk;
    const lines = incompleteLine.split("\n");
    incompleteLine = lines.pop() ?? "";
    for (const rawLine of lines) {
      const result = observeLine(rawLine);
      if (result || observed) return result;
    }
  };
  observer.flush = () => {
    const finalLine = incompleteLine;
    incompleteLine = "";
    return observeLine(finalLine);
  };
  return observer;
}

/** Activity callbacks must not gate backend retries or successful analysis. */
function reportFallback(
  onFallback: ((retry: { backend: AnalysisFallbackBackend; previousBackend: OrchestratorBackend; attempt: number; error: string }) => Promise<void> | void) | undefined,
  retry: { backend: AnalysisFallbackBackend; previousBackend: OrchestratorBackend; attempt: number; error: string }
): void {
  try {
    void Promise.resolve(onFallback?.(retry)).catch(() => undefined);
  } catch {
    // Fallback notifications are best-effort telemetry.
  }
}

export async function runOrchestrationAnalysis(
  story: Story,
  repositoryPath: string,
  opts: OrchestratorExecutorOptions & {
    signal?: AbortSignal;
    onFallback?: (retry: { backend: AnalysisFallbackBackend; previousBackend: OrchestratorBackend; attempt: number; error: string }) => Promise<void> | void;
  } = {}
): Promise<{ result: OrchestratorRunResult; analysis: OrchestrationAnalysis; stderr: string; attemptedBackends: OrchestratorBackend[] }> {
  const bin = opts.bin ?? resolveOrchestratorBin();
  // A malformed returned profile is deliberately fatal; PlannerWorker turns it
  // into its existing visible planning-failed state before any route persists.
  const capabilityGuidance = await resolveAnalysisCapabilityGuidance(bin, opts.signal);
  const fallbacks = analysisFallbacks(opts);
  // Keep the observable Codex/Claude default on the installed runner. It
  // retains its trace linkage and only retries availability-classified errors.
  if (fallbacks.length === 1 && fallbacks[0] === "claude") {
    let usedClaudeFallback = false;
    const { result, stderr } = await runOrchestratorPhase(story, "codex", "analyze", {
      ...opts,
      bin,
      fallbackClaude: true,
      cwd: repositoryPath,
      task: buildOrchestrationAnalysisTaskContract(story, capabilityGuidance),
      onStderr: observeBuiltInClaudeRetry((error) => {
        usedClaudeFallback = true;
        reportFallback(opts.onFallback, { backend: "claude", previousBackend: "codex", attempt: 2, error });
      }),
    });
    return {
      result,
      analysis: extractOrchestrationAnalysis(result, capabilityGuidance),
      stderr,
      attemptedBackends: usedClaudeFallback ? ["codex", "claude"] : ["codex"],
    };
  }

  const attempts: Array<{ backend: OrchestratorBackend; mode: OrchestratorMode; task: string }> = [
    { backend: "codex", mode: "analyze", task: buildOrchestrationAnalysisTaskContract(story, capabilityGuidance) },
    ...fallbacks.map((backend) => ({
      backend,
      mode: backend === "composer" ? "implement" as const : "analyze" as const,
      task: backend === "composer" ? buildComposerAnalysisTaskContract(story, capabilityGuidance) : buildOrchestrationAnalysisTaskContract(story, capabilityGuidance),
    })),
  ];
  const attemptedBackends: OrchestratorBackend[] = [];
  let previousError: Error | undefined;
  for (const [index, attempt] of attempts.entries()) {
    if (index > 0) {
      const error = previousError?.message ?? "backend unavailable";
      reportFallback(opts.onFallback, { backend: attempt.backend as AnalysisFallbackBackend, previousBackend: attempts[index - 1]!.backend, attempt: index + 1, error });
    }
    attemptedBackends.push(attempt.backend);
    try {
      const { result, stderr } = await runOrchestratorPhase(story, attempt.backend, attempt.mode, {
        ...opts,
        bin,
        fallbackClaude: false,
        cwd: repositoryPath,
        task: attempt.task,
      });
      const analysis = extractOrchestrationAnalysis(result, capabilityGuidance);
      if (
        attempt.backend === "composer" &&
        (analysis.backend !== "composer" || analysis.mode !== "implement" || analysis.route !== "composer-implement")
      ) {
        throw new Error("Invalid orchestration analysis: Composer fallback must return composer/implement (composer-implement)");
      }
      return { result, analysis, stderr, attemptedBackends };
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      previousError = normalized;
      if (!isRecoverableBackendUnavailable(normalized) || index === attempts.length - 1) break;
    }
  }
  const attempted = attemptedBackends.join(" -> ");
  throw new Error(`Orchestration analysis exhausted backends (${attempted}): ${previousError?.message ?? "unknown backend error"}`);
}

/** The runner emits this structured marker; common direct executable outages stay recoverable in tests and older runners. */
export function isRecoverableBackendUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /backend_unavailable|usage limit|rate limit|hit your usage|not logged in|authentication|\b401\b|\bENOENT\b|CLI not found/i.test(message);
}

export async function runOrchestratorPipeline(client: Client, story: Story, streamLine: StreamLineFn, opts: OrchestratorExecutorOptions = {}) {
  if (!story.worktree) throw new Error(`Story ${story.id} has no worktree`);
  const bin = opts.bin ?? resolveOrchestratorBin();
  const { backend, mode, route, usedFallback } = resolveOrchestrationExecution(story);
  const { args } = orchestratorRunArgs(story, backend, mode, bin, opts);
  if (usedFallback) {
    await streamLine(
      client,
      story,
      "fable",
      "out",
      `no orchestration plan for ${story.wid}; falling back to ${backend}/${mode} (${route})`
    );
  }
  await streamLine(client, story, "fable", "out", `orchestrator delegating ${story.wid} to ${route}`);
  if (routeNeedsWriteLock(route)) await streamLine(client, story, route, "lock", `write-lock requested for ${story.worktree}`);
  await streamLine(client, story, route, "cmd", orchestratorCommandLine(bin, args).replace(buildOrchestratorTaskContract(story), "<task contract>"));
  const startedAt = Date.now();
  const { result, stderr } = await runOrchestratorPhase(story, backend, mode, opts);
  for (const line of stderr.trim().split(/\r?\n/).filter(Boolean).slice(-6)) await streamLine(client, story, route, "out", line.slice(0, 1200));
  if (result.status === "blocked") throw new Error(result.summary);
  await streamLine(client, story, route, "ok", result.summary, "done");
  if (routeNeedsWriteLock(route)) await streamLine(client, story, route, "unlock", "write-lock released after orchestrator run");
  const runRecord: RunRecord = {
    id: `run-${story.id}-${route}-${startedAt}`,
    storyId: story.id,
    label: `${story.wid} orchestrator`,
    repo: story.repo,
    route,
    backend: BACKEND_LABEL[backend],
    model: routeModel(route),
    access: routeAccess(route),
    tokens: 0,
    durMs: Math.max(1, Date.now() - startedAt),
    status: "completed",
    changed: result.changes.length,
    outcome: "unrated",
  };
  return { route, result, traces: [] as OrchestratorTraceRecord[], runRecord };
}
