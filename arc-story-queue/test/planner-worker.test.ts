import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Story } from "arc-contracts";
import {
  extractOrchestrationAnalysis,
  parseOrchestratorRouteProfile,
  orchestratorAnalyzeArgs,
  parseOrchestratorStdout,
  resolveAnalysisFallbacks,
  runOrchestrationAnalysis,
  runOrchestratorPhase,
  type OrchestrationAnalysis,
} from "../mcp-server/dist/orchestrator-executor.js";
import { StoryLifecycle } from "../mcp-server/dist/lifecycle.js";
import { PlannerWorker } from "../mcp-server/dist/planner-worker.js";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";

type AnalysisResult = {
  analysis: OrchestrationAnalysis;
};

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: "planner-1", wid: "W-000043", type: "story", title: "Plan in background", repo: "test/planner",
    branch: "feat/planner", worktree: "", column: "queued", priority: "med", size: "S", epic: "",
    taskClass: "feature", tags: [], description: "Analyze this queued story.", criteria: ["read only"],
    draft: false, issue: "#43", orchestration: { status: "unplanned" }, ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for planner");
}

function recommendation(rationale = "Read the repo first."): AnalysisResult {
  return { analysis: { route: "codex-implement", backend: "codex", mode: "implement", rationale, complexity: "low" } };
}

const UPSTREAM_TASK_CLASS_VARIANTS = [
  { task_class: "taste-sensitive", case_sensitive: false, trim_whitespace: true, model: "gpt-5-codex-high" },
  { task_class: "ui", case_sensitive: false, trim_whitespace: true, model: "gpt-5-codex" },
  { task_class: "copy", case_sensitive: false, trim_whitespace: true, model: "gpt-5-codex" },
  { task_class: "api-design", case_sensitive: false, trim_whitespace: true, model: "gpt-5-codex-high" },
];

function routeProfile(): string {
  return JSON.stringify({ schema_version: 1, source: "fable-orchestrator", routes: [
    ["codex-explore", "codex", "analyze", "read-only", "Codex explore"], ["codex-implement", "codex", "implement", "workspace-write", "Codex implement"], ["codex-check", "codex", "review", "read-only", "Codex check"],
    ["composer-implement", "composer", "implement", "workspace-write", "Composer implement"], ["opus-explore", "claude", "analyze", "read-only", "Claude explore"], ["opus-implement", "claude", "implement", "workspace-write", "Claude implement"], ["opus-check", "claude", "review", "read-only", "Claude check"],
  ].map(([id, backend, mode, sandbox, guidance]) => ({ id, backend, mode, sandbox, guidance, model: "test", ...(id === "codex-implement" || id === "codex-check" ? { task_class_variants: UPSTREAM_TASK_CLASS_VARIANTS } : {}) })) });
}

function backendChainBin(directory: string, output: string, exhaustComposer = false): string {
  const bin = join(directory, "backend-chain");
  const summary = JSON.stringify({ route: "composer-implement", backend: "composer", mode: "implement", rationale: "[profile:fable-orchestrator@1 route=composer-implement] Composer implement", complexity: "low" });
  const result = JSON.stringify({ status: "completed", summary, changes: [], verification: [], risks: [], next_actions: [] });
  writeFileSync(bin, [
    "#!/bin/sh", `if [ "$1" = routes ]; then printf '%s\\n' '${routeProfile()}'; exit 0; fi`, "backend=\"\"", "mode=\"\"", "while [ \"$#\" -gt 0 ]; do",
    "  case \"$1\" in", "    --backend) backend=\"$2\"; shift 2 ;;", "    --mode) mode=\"$2\"; shift 2 ;;", "    *) shift ;;", "  esac", "done",
    `printf '%s/%s\\n' \"$backend\" \"$mode\" >> '${output}'`, "case \"$backend\" in",
    "  codex) printf '%s\\n' '{\"failure_class\":\"backend_unavailable\",\"outage_reason\":\"usage_limit\"}' >&2; exit 7 ;;",
    "  claude) printf '%s\\n' '{\"failure_class\":\"backend_unavailable\",\"outage_reason\":\"auth\"}' >&2; exit 8 ;;",
    exhaustComposer
      ? "  composer) printf '%s\\n' '{\"failure_class\":\"backend_unavailable\",\"outage_reason\":\"missing_binary\",\"detail\":\"composer stderr\"}' >&2; exit 9 ;;"
      : `  composer) printf '%s\\n' '${result}' ;;`, "esac",
  ].join("\n"));
  chmodSync(bin, 0o755);
  return bin;
}

function successfulAnalyzeBin(directory: string, output: string): string {
  const bin = join(directory, "successful-analyze");
  const summary = JSON.stringify({
    route: "codex-implement",
    backend: "codex",
    mode: "implement",
    rationale: "[profile:fable-orchestrator@1 route=codex-implement] Codex implement",
    complexity: "low",
  });
  const result = JSON.stringify({ status: "completed", summary, changes: [], verification: [], risks: [], next_actions: [] });
  writeFileSync(bin, ["#!/bin/sh", `if [ "$1" = routes ]; then printf '%s\\n' '${routeProfile()}'; exit 0; fi`, `printf '%s\\n' \"$@\" > '${output}'`, `printf '%s\\n' '${result}'`].join("\n"));
  chmodSync(bin, 0o755);
  return bin;
}

function builtInClaudeFallbackBin(directory: string, output: string): string {
  const bin = join(directory, "built-in-claude-fallback");
  const summary = JSON.stringify({
    route: "opus-implement", backend: "claude", mode: "implement", rationale: "[profile:fable-orchestrator@1 route=opus-implement] Claude implement", complexity: "low",
  });
  const result = JSON.stringify({ status: "completed", summary, changes: [], verification: [], risks: [], next_actions: [] });
  writeFileSync(bin, [
    "#!/bin/sh", `if [ "$1" = routes ]; then printf '%s\\n' '${routeProfile()}'; exit 0; fi`,
    `printf '%s\\n' \"$@\" > '${output}'`,
    "printf '%s\\n' 'fable-orchestrator: codex unavailable (malformed); retrying on claude backend extra' >&2",
    "printf '%s' 'fable-orchestrator: codex unavailable (usage' >&2",
    "sleep 0.02",
    "printf '%s\\n' ' limit); retrying on claude backend' >&2",
    "printf '%s\\n' 'fable-orchestrator: codex unavailable (duplicate); retrying on claude backend' >&2",
    "sleep 0.02",
    `printf '%s\\n' '${result}'`,
  ].join("\n"));
  chmodSync(bin, 0o755);
  return bin;
}

function builtInClaudeFallbackAtEofBin(directory: string): string {
  const bin = join(directory, "built-in-claude-fallback-eof");
  const summary = JSON.stringify({
    route: "opus-implement", backend: "claude", mode: "implement", rationale: "[profile:fable-orchestrator@1 route=opus-implement] Claude implement", complexity: "low",
  });
  const result = JSON.stringify({ status: "completed", summary, changes: [], verification: [], risks: [], next_actions: [] });
  writeFileSync(bin, [
    "#!/bin/sh", `if [ "$1" = routes ]; then printf '%s\\n' '${routeProfile()}'; exit 0; fi`,
    "printf '%s\\n' 'fable-orchestrator: codex unavailable (malformed); retrying on claude backend extra' >&2",
    "printf '%s' 'fable-orchestrator: codex unavailable (usage' >&2",
    "sleep 0.02",
    "printf '%s' ' limit); retrying on claude backend' >&2",
    `printf '%s\\n' '${result}'`,
  ].join("\n"));
  chmodSync(bin, 0o755);
  return bin;
}

function composerWrongPlanBin(directory: string): string {
  const bin = join(directory, "composer-wrong-plan");
  const summary = JSON.stringify({
    route: "codex-implement", backend: "codex", mode: "implement", rationale: "[profile:fable-orchestrator@1 route=codex-implement] Codex implement", complexity: "low",
  });
  const result = JSON.stringify({ status: "completed", summary, changes: [], verification: [], risks: [], next_actions: [] });
  writeFileSync(bin, [
    "#!/bin/sh", `if [ "$1" = routes ]; then printf '%s\\n' '${routeProfile()}'; exit 0; fi`, "backend=\"\"", "while [ \"$#\" -gt 0 ]; do",
    "  case \"$1\" in", "    --backend) backend=\"$2\"; shift 2 ;;", "    *) shift ;;", "  esac", "done",
    "if [ \"$backend\" = codex ]; then printf '%s\\n' '{\"failure_class\":\"backend_unavailable\"}' >&2; exit 7; fi",
    `printf '%s\\n' '${result}'`,
  ].join("\n"));
  chmodSync(bin, 0o755);
  return bin;
}

function setup(analyze = vi.fn(async () => recommendation()), maxConcurrent = 2, repositoryPath = "/tmp/planner-repository") {
  const store = new StoryStore(":memory:");
  const registry = new SessionRegistry();
  const sse = new SseHub();
  const queue = new QueueManager({ worktreeRoot: "/tmp/planner-wt", maxParallel: 1 }, { store, registry, sse });
  const lifecycle = new StoryLifecycle(queue);
  const session = registry.register({ repo: "test/planner", path: repositoryPath, branch: "main", model: "test", pid: 1 });
  registry.attach(session.id, "/tmp/planner-wt");
  const planner = new PlannerWorker({ queue, registry, sse, analyze }, { maxConcurrent });
  return { store, queue, lifecycle, planner, sse, analyze };
}

describe("orchestrator analysis protocol", () => {
  it("uses Codex analyze with the built-in Claude fallback by default and can explicitly disable it", () => {
    const item = story({ worktree: "/tmp/should-not-be-used" });
    const { args } = orchestratorAnalyzeArgs(item, "/tmp/repository", "fable-orchestrator");
    expect(args).toEqual(expect.arrayContaining(["--backend", "codex", "--mode", "analyze", "--fallback", "claude", "/tmp/repository"]));
    expect(args).not.toContain("/tmp/should-not-be-used");
    expect(orchestratorAnalyzeArgs(item, "/tmp/repository", "fable-orchestrator", { fallbackClaude: false }).args).not.toContain("--fallback");
    expect(resolveAnalysisFallbacks({})).toEqual(["claude"]);
    expect(resolveAnalysisFallbacks({ ARC_ORCHESTRATION_ANALYZE_FALLBACKS: "none" })).toEqual([]);
    expect(resolveAnalysisFallbacks({ ARC_ORCHESTRATION_ANALYZE_FALLBACKS: "claude,composer" })).toEqual(["claude", "composer"]);
  });

  it("encodes executable recommendations in the strict handoff, including Composer's registered route", () => {

    const summary = JSON.stringify({ route: "codex-implement", backend: "codex", mode: "implement", rationale: "Implement after analysis", complexity: "low" });
    const result = parseOrchestratorStdout(JSON.stringify({
      status: "completed", summary, changes: [], verification: [], risks: [], next_actions: [],
    }));
    expect(extractOrchestrationAnalysis(result)).toMatchObject({ route: "codex-implement", backend: "codex", mode: "implement" });
    expect(extractOrchestrationAnalysis({ ...result, summary: JSON.stringify({ route: "composer-implement", backend: "composer", mode: "implement", rationale: "fallback", complexity: "low" }) })).toMatchObject({ route: "composer-implement", backend: "composer" });
    expect(() => extractOrchestrationAnalysis({ ...result, summary: JSON.stringify({ route: "composer-explore", backend: "composer", mode: "implement", rationale: "wrong", complexity: "low" }) })).toThrow(/match backend and mode/);
    expect(() => parseOrchestratorStdout(JSON.stringify({ ...result, orchestration: {} }))).toThrow(/unexpected top-level/);
    expect(() => extractOrchestrationAnalysis({ ...result, summary: JSON.stringify({ route: "codex-explore", backend: "codex", mode: "implement", rationale: "wrong", complexity: "low" }) })).toThrow(/match backend and mode/);
    expect(() => extractOrchestrationAnalysis({ ...result, summary: JSON.stringify({ route: "codex-implement", backend: "Codex CLI", mode: "implement", rationale: "wrong", complexity: "low" }) })).toThrow(/CLI id/);
    expect(() => parseOrchestratorStdout("not json")).toThrow(/invalid JSON/);
  });

  it("rejects malformed, incompatible, unknown, and partial returned profiles before any guidance can be used", () => {
    const valid = JSON.parse(routeProfile());
    const parsed = parseOrchestratorRouteProfile(routeProfile());
    expect(parsed.routes).toHaveLength(7);
    expect(parsed.routes.find((route) => route.id === "codex-implement")?.taskClassVariants?.map((variant) => variant.task_class))
      .toEqual(["taste-sensitive", "ui", "copy", "api-design"]);
    expect(parsed.routes.find((route) => route.id === "codex-check")?.taskClassVariants?.map((variant) => variant.model))
      .toEqual(["gpt-5-codex-high", "gpt-5-codex", "gpt-5-codex", "gpt-5-codex-high"]);
    expect(() => parseOrchestratorRouteProfile("bad json")).toThrow(/invalid JSON/);
    expect(() => parseOrchestratorRouteProfile(JSON.stringify({ ...valid, schema_version: 2 }))).toThrow(/schema_version/);
    expect(() => parseOrchestratorRouteProfile(JSON.stringify({ ...valid, source: "other" }))).toThrow(/source/);
    expect(() => parseOrchestratorRouteProfile(JSON.stringify({ ...valid, routes: [{ ...valid.routes[0], id: "unknown" }] }))).toThrow(/unknown route/);
    expect(() => parseOrchestratorRouteProfile(JSON.stringify({ ...valid, routes: [{ ...valid.routes[1], backend: "claude", mode: "implement" }] }))).toThrow(/backend\/mode/);
    expect(() => parseOrchestratorRouteProfile(JSON.stringify({ ...valid, routes: [{ ...valid.routes[1], sandbox: "read-only" }] }))).toThrow(/sandbox/);
    expect(() => parseOrchestratorRouteProfile(JSON.stringify({ ...valid, routes: [valid.routes[0]] }))).toThrow(/complete executable/);
  });

  it("rejects malformed task_class_variants: wrong types, unknown keys, and duplicates", () => {
    const valid = JSON.parse(routeProfile());
    const withVariant = (variant: Record<string, unknown>) =>
      JSON.stringify({ ...valid, routes: [{ ...valid.routes[1], task_class_variants: [variant] }] });
    // The exact upstream key set parses cleanly (narrow unknown-key acceptance check).
    expect(() => parseOrchestratorRouteProfile(withVariant({ task_class: "ui", case_sensitive: false, trim_whitespace: true, model: "m" }))).toThrow(/complete executable/);
    expect(() => parseOrchestratorRouteProfile(withVariant({ task_class: "ui", case_sensitive: "yes", trim_whitespace: true, model: "m" }))).toThrow(/case_sensitive/);
    expect(() => parseOrchestratorRouteProfile(withVariant({ task_class: "", case_sensitive: false, trim_whitespace: true, model: "m" }))).toThrow(/task_class/);
    expect(() => parseOrchestratorRouteProfile(withVariant({ task_class: "ui", case_sensitive: false, trim_whitespace: true, model: "m", extra: 1 }))).toThrow(/unknown key/);
    expect(() => parseOrchestratorRouteProfile(JSON.stringify({ ...valid, routes: [{ ...valid.routes[1], task_class_variants: [
      { task_class: "ui", case_sensitive: false, trim_whitespace: true, model: "m" },
      { task_class: "UI", case_sensitive: false, trim_whitespace: true, model: "m" },
    ] }] }))).toThrow(/duplicates task_class/);
  });

  it("surfaces an orchestrator process failure without accepting a plan", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-executor-"));
    const bin = join(directory, "failing-orchestrator");
    writeFileSync(bin, "#!/bin/sh\necho unavailable >&2\nexit 7\n");
    chmodSync(bin, 0o755);
    try {
      await expect(runOrchestratorPhase(story(), "codex", "analyze", { bin, cwd: directory })).rejects.toThrow(/code 7: unavailable/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("passes cancellation through to the spawned analyze process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-abort-"));
    const bin = join(directory, "waiting-orchestrator");
    writeFileSync(bin, "#!/bin/sh\nsleep 30\n");
    chmodSync(bin, 0o755);
    const controller = new AbortController();
    try {
      const running = runOrchestratorPhase(story(), "codex", "analyze", { bin, cwd: directory, signal: controller.signal });
      controller.abort();
      await expect(running).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("passes cancellation through to the profile command before analysis starts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-profile-abort-"));
    const bin = join(directory, "waiting-profile");
    writeFileSync(bin, "#!/bin/sh\nsleep 30\n");
    chmodSync(bin, 0o755);
    const controller = new AbortController();
    try {
      const running = runOrchestrationAnalysis(story(), directory, { bin, signal: controller.signal });
      controller.abort();
      await expect(running).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses explicit Codex -> Claude -> Composer attempts only for the configured Composer chain", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-chain-"));
    const attempts = join(directory, "attempts");
    const bin = backendChainBin(directory, attempts);
    try {
      const outcome = await runOrchestrationAnalysis(story(), directory, { bin, analysisFallbacks: ["claude", "composer"] });
      expect(outcome.analysis).toMatchObject({ backend: "composer", route: "composer-implement", mode: "implement" });
      expect(outcome.attemptedBackends).toEqual(["codex", "claude", "composer"]);
      expect(readFileSync(attempts, "utf8").trim().split("\n")).toEqual(["codex/analyze", "claude/analyze", "composer/implement"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a valid non-Composer plan returned by an explicit Composer fallback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-composer-identity-"));
    const bin = composerWrongPlanBin(directory);
    try {
      await expect(runOrchestrationAnalysis(story(), directory, { bin, analysisFallbacks: ["composer"] }))
        .rejects.toThrow(/Composer fallback must return composer\/implement/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("summarizes exhausted configured attempts and preserves the final backend stderr", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-exhausted-"));
    const bin = backendChainBin(directory, join(directory, "attempts"), true);
    try {
      await expect(runOrchestrationAnalysis(story(), directory, { bin, analysisFallbacks: ["claude", "composer"] })).rejects.toThrow(/exhausted backends \(codex -> claude -> composer\).*composer stderr/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not announce a fallback for successful Codex analysis", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-codex-success-"));
    const command = join(directory, "command");
    const bin = successfulAnalyzeBin(directory, command);
    const onFallback = vi.fn();
    try {
      const outcome = await runOrchestrationAnalysis(story(), directory, { bin, onFallback });
      expect(outcome.analysis).toMatchObject({ backend: "codex", route: "codex-implement", mode: "implement" });
      expect(outcome.attemptedBackends).toEqual(["codex"]);
      expect(onFallback).not.toHaveBeenCalled();
      expect(readFileSync(command, "utf8")).toContain("--backend\ncodex\n--mode\nanalyze");
      expect(readFileSync(command, "utf8")).toContain("--fallback\nclaude");
      expect(readFileSync(command, "utf8")).toContain("Codex implement");
      expect(readFileSync(command, "utf8")).toContain("profile:fable-orchestrator@1");
      expect(readFileSync(command, "utf8")).toContain("task_class_variants=taste-sensitive=>gpt-5-codex-high");
      expect(readFileSync(command, "utf8")).toContain("api-design=>gpt-5-codex-high (case_sensitive=false, trim_whitespace=true)");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats an unrecognized nonzero routes-command failure as fatal rather than falling back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-routes-error-"));
    const bin = join(directory, "erroring-routes");
    writeFileSync(bin, ["#!/bin/sh", "if [ \"$1\" = routes ]; then echo 'fable-orchestrator: internal routing failure' >&2; exit 3; fi", "exit 0"].join("\n"));
    chmodSync(bin, 0o755);
    try {
      await expect(runOrchestrationAnalysis(story(), directory, { bin })).rejects.toThrow(/exited with code 3/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses built-in guidance only when an older runner rejects routes, and makes fallback provenance mandatory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-old-profile-"));
    const bin = join(directory, "old-orchestrator");
    const summary = JSON.stringify({ route: "codex-implement", backend: "codex", mode: "implement", rationale: "[built-in-routes fallback=profile-command-unavailable route=codex-implement] Hard implementation / escalation", complexity: "low" });
    const result = JSON.stringify({ status: "completed", summary, changes: [], verification: [], risks: [], next_actions: [] });
    writeFileSync(bin, ["#!/bin/sh", "if [ \"$1\" = routes ]; then echo 'fable-orchestrator: expected the run command' >&2; exit 2; fi", `printf '%s\\n' '${result}'`].join("\n"));
    chmodSync(bin, 0o755);
    try {
      const outcome = await runOrchestrationAnalysis(story(), directory, { bin });
      expect(outcome.analysis.rationale).toContain("built-in-routes fallback=profile-command-unavailable");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports the built-in Claude retry once and preserves planning lifecycle order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-claude-success-"));
    const command = join(directory, "command");
    const bin = builtInClaudeFallbackBin(directory, command);
    const analyze = (item: Story, path: string, opts: {
      signal: AbortSignal;
      onFallback?: (retry: { backend: "claude" | "composer"; previousBackend: "codex" | "claude" | "composer"; attempt: number; error: string }) => Promise<void> | void;
    }) => runOrchestrationAnalysis(item, path, { bin, ...opts });
    const { store, planner, sse } = setup(analyze, 2, directory);
    const item = story();
    store.upsertStory(item); store.enqueue(item.id);
    const events = vi.spyOn(sse, "emitEvent");
    try {
      planner.start();
      await waitFor(() => store.getStory(item.id)?.orchestration?.status === "planned");
      expect(readFileSync(command, "utf8")).toContain("--fallback\nclaude");
      expect(store.getStory(item.id)?.orchestration).toMatchObject({ status: "planned", backend: "claude", route: "opus-implement" });
      const lifecycle = events.mock.calls.map(([evt]) => evt);
      expect(lifecycle.map((evt) => evt.kind)).toEqual(["planning", "planning", "planned"]);
      expect(lifecycle[1]).toMatchObject({ kind: "planning", backend: "claude", previousBackend: "codex", attempt: 2, error: "usage limit" });
    } finally {
      await planner.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recognizes a split built-in Claude retry marker at EOF without a trailing newline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-claude-eof-"));
    const bin = builtInClaudeFallbackAtEofBin(directory);
    const onFallback = vi.fn();
    try {
      const outcome = await runOrchestrationAnalysis(story(), directory, { bin, onFallback });
      expect(outcome.attemptedBackends).toEqual(["codex", "claude"]);
      expect(onFallback).toHaveBeenCalledTimes(1);
      expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ backend: "claude", error: "usage limit" }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["synchronous", () => { throw new Error("telemetry failed"); }],
    ["asynchronous", () => Promise.reject(new Error("telemetry failed"))],
  ])("keeps successful built-in fallback analysis when %s telemetry fails", async (_kind, onFallback) => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-claude-observer-"));
    const bin = builtInClaudeFallbackBin(directory, join(directory, "command"));
    try {
      const outcome = await runOrchestrationAnalysis(story(), directory, { bin, onFallback });
      expect(outcome.analysis.backend).toBe("claude");
      expect(outcome.attemptedBackends).toEqual(["codex", "claude"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["synchronous", () => { throw new Error("telemetry failed"); }],
    ["asynchronous", () => Promise.reject(new Error("telemetry failed"))],
  ])("continues explicit fallback analysis when %s telemetry fails", async (_kind, onFallback) => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-chain-observer-"));
    const bin = backendChainBin(directory, join(directory, "attempts"));
    try {
      const outcome = await runOrchestrationAnalysis(story(), directory, { bin, analysisFallbacks: ["claude", "composer"], onFallback });
      expect(outcome.analysis.backend).toBe("composer");
      expect(outcome.attemptedBackends).toEqual(["codex", "claude", "composer"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("PlannerWorker", () => {
  it("subscribes after SSE delivery and performs a startup catch-up without execution capacity or a write lock", async () => {
    const { store, queue, lifecycle, planner, sse, analyze } = setup();
    const caughtUp = story();
    const newItem = story({ id: "planner-2", wid: "W-000044", column: "backlog" });
    store.upsertStory(caughtUp); store.enqueue(caughtUp.id); store.upsertStory(newItem);
    const events = vi.spyOn(sse, "emitEvent");

    planner.start();
    await waitFor(() => store.getStory(caughtUp.id)?.orchestration?.status === "planned");
    const queued = await lifecycle.enqueue(newItem.id);
    await sse.emitEvent(queued.events[0]!);
    await waitFor(() => store.getStory(newItem.id)?.orchestration?.status === "planned");

    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ worktree: "" }), "/tmp/planner-repository", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(store.getStory(caughtUp.id)).toMatchObject({ column: "queued", worktree: "", orchestration: { status: "planned" } });
    expect(store.listStories().filter((item) => item.column === "in_progress")).toHaveLength(0);
    expect(queue.isWriteLocked("")).toBe(false);
    expect(events.mock.calls.map(([evt]) => evt.kind)).toEqual(expect.arrayContaining(["planning", "planned"]));
  });

  it("isolates failures and keeps processing other queued stories", async () => {
    const analyze = vi.fn(async (item: Story) => {
      if (item.id === "bad") throw new Error("model unavailable");
      return recommendation("safe");
    });
    const { store, planner, sse } = setup(analyze);
    const bad = story({ id: "bad" });
    const good = story({ id: "good", wid: "W-000045" });
    store.upsertStory(bad); store.enqueue(bad.id); store.upsertStory(good); store.enqueue(good.id);
    const events = vi.spyOn(sse, "emitEvent");
    planner.start();
    await waitFor(() => store.getStory(bad.id)?.orchestration?.status === "failed" && store.getStory(good.id)?.orchestration?.status === "planned");
    expect(store.getStory(bad.id)?.orchestration).toMatchObject({ status: "failed", error: "model unavailable" });
    expect(events.mock.calls.map(([evt]) => evt).find((evt) => evt.kind === "planning-failed")).toMatchObject({ error: "model unavailable" });
  });

  it("surfaces an invalid profile as planning-failed and never invokes analysis", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arc-planner-profile-failure-"));
    const bin = join(directory, "bad-profile");
    const calls = join(directory, "calls");
    writeFileSync(bin, ["#!/bin/sh", `printf '%s\\n' \"$1\" >> '${calls}'`, "if [ \"$1\" = routes ]; then echo '{bad'; exit 0; fi", "exit 9"].join("\n"));
    chmodSync(bin, 0o755);
    const analyze = (item: Story, path: string, opts: { signal: AbortSignal }) => runOrchestrationAnalysis(item, path, { bin, ...opts });
    const { store, planner, sse } = setup(analyze, 2, directory);
    const item = story();
    store.upsertStory(item); store.enqueue(item.id);
    const events = vi.spyOn(sse, "emitEvent");
    try {
      planner.start();
      await waitFor(() => store.getStory(item.id)?.orchestration?.status === "failed");
      expect(events.mock.calls.map(([entry]) => entry.kind)).toContain("planning-failed");
      expect(readFileSync(calls, "utf8").trim()).toBe("routes");
    } finally {
      await planner.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves a bounded final backend diagnostic in failed planning state and activity", async () => {
    const finalDiagnostic = "FINAL BACKEND DIAGNOSTIC: composer auth expired";
    const analyze = vi.fn(async () => {
      throw new Error(`${"x".repeat(1_100)} ${finalDiagnostic}`);
    });
    const { store, planner, sse } = setup(analyze);
    const item = story();
    store.upsertStory(item); store.enqueue(item.id);
    const events = vi.spyOn(sse, "emitEvent");
    planner.start();
    await waitFor(() => store.getStory(item.id)?.orchestration?.status === "failed");
    const error = store.getStory(item.id)?.orchestration?.error ?? "";
    expect(error).toContain(finalDiagnostic);
    expect(error.length).toBeLessThanOrEqual(1_000);
    expect(events.mock.calls.map(([evt]) => evt).find((evt) => evt.kind === "planning-failed")).toMatchObject({ error: expect.stringContaining(finalDiagnostic) });
  });

  it("bounds analysis independently with its own concurrency", async () => {
    let running = 0;
    let peak = 0;
    const first = deferred<AnalysisResult>();
    const analyze = vi.fn(async () => {
      running += 1; peak = Math.max(peak, running);
      const value = await first.promise;
      running -= 1;
      return value;
    });
    const { store, planner } = setup(analyze, 1);
    const one = story({ id: "one" });
    const two = story({ id: "two", wid: "W-000046" });
    store.upsertStory(one); store.enqueue(one.id); store.upsertStory(two); store.enqueue(two.id);
    planner.start();
    await waitFor(() => analyze.mock.calls.length === 1);
    expect(peak).toBe(1);
    first.resolve(recommendation("safe"));
    await waitFor(() => analyze.mock.calls.length === 2);
    expect(peak).toBe(1);
  });

  it("rescans and replans after unqueue + requeue while an old analysis is active", async () => {
    const first = deferred<AnalysisResult>();
    const second = deferred<AnalysisResult>();
    const analyze = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { store, lifecycle, planner, sse } = setup(analyze);
    const item = story();
    store.upsertStory(item); store.enqueue(item.id);
    const events = vi.spyOn(sse, "emitEvent");
    planner.start();
    await waitFor(() => store.getStory(item.id)?.orchestration?.status === "planning");
    const unqueued = lifecycle.unqueue(item.id);
    await sse.emitEvent(unqueued.events[0]!);
    const requeued = await lifecycle.enqueue(item.id);
    await sse.emitEvent(requeued.events[0]!);
    first.resolve(recommendation("old"));
    await waitFor(() => analyze.mock.calls.length === 2);
    second.resolve(recommendation("fresh"));
    await waitFor(() => store.getStory(item.id)?.orchestration?.status === "planned");
    expect(store.getStory(item.id)).toMatchObject({ column: "queued", orchestration: { status: "planned", rationale: "fresh" } });
    expect(events.mock.calls.map(([evt]) => evt.kind)).toEqual(expect.arrayContaining(["planning", "planned"]));
  });

  it("delivers queued through SSE before planner emits planning or starts analysis", async () => {
    const order: string[] = [];
    const analyze = vi.fn(async () => {
      order.push("analyze");
      return recommendation("safe");
    });
    const { store, lifecycle, planner, sse } = setup(analyze);
    const item = story({ column: "backlog" });
    store.upsertStory(item);
    const emit = sse.emitEvent.bind(sse);
    vi.spyOn(sse, "emitEvent").mockImplementation(async (evt) => {
      order.push(`event:${evt.kind}`);
      await emit(evt);
    });
    planner.start();
    const queued = await lifecycle.enqueue(item.id);
    await sse.emitEvent(queued.events[0]!);
    await waitFor(() => store.getStory(item.id)?.orchestration?.status === "planned");
    expect(order).toEqual(["event:queued", "event:planning", "analyze", "event:planned"]);
  });

  it("keeps durable planning status while emitting backend-aware retry activity, then plans successfully", async () => {
    const analyze = vi.fn(async (_story: Story, _path: string, opts: {
      signal: AbortSignal;
      onFallback?: (retry: { backend: "claude"; previousBackend: "codex"; attempt: number; error: string }) => Promise<void>;
    }) => {
      await opts.onFallback?.({ backend: "claude", previousBackend: "codex", attempt: 2, error: "usage limit" });
      return recommendation("Claude recovered");
    });
    const { store, planner, sse } = setup(analyze);
    const item = story();
    store.upsertStory(item); store.enqueue(item.id);
    const events = vi.spyOn(sse, "emitEvent");
    planner.start();
    await waitFor(() => store.getStory(item.id)?.orchestration?.status === "planned");
    const lifecycle = events.mock.calls.map(([evt]) => evt);
    expect(lifecycle.map((evt) => evt.kind)).toEqual(["planning", "planning", "planned"]);
    expect(lifecycle[1]).toMatchObject({ kind: "planning", backend: "claude", previousBackend: "codex", attempt: 2, error: "usage limit" });
    expect(lifecycle.some((evt) => evt.kind === "planning-failed")).toBe(false);
  });

  it("aborts active analysis and awaits it without persisting an expected failure", async () => {
    const analyze = vi.fn((_story: Story, _path: string, { signal }: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
    }));
    const { store, planner, sse } = setup(analyze);
    const item = story();
    store.upsertStory(item); store.enqueue(item.id);
    const events = vi.spyOn(sse, "emitEvent");
    planner.start();
    await waitFor(() => analyze.mock.calls.length === 1);
    await planner.stop();
    expect(store.getStory(item.id)?.orchestration).toMatchObject({ status: "planning" });
    expect(events.mock.calls.map(([evt]) => evt.kind)).not.toContain("planning-failed");
  });
});
