import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Story } from "arc-contracts";
import {
  extractOrchestrationAnalysis,
  orchestratorAnalyzeArgs,
  parseOrchestratorStdout,
  runOrchestratorPhase,
} from "../mcp-server/dist/orchestrator-executor.js";
import { StoryLifecycle } from "../mcp-server/dist/lifecycle.js";
import { PlannerWorker } from "../mcp-server/dist/planner-worker.js";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";

type AnalysisResult = {
  analysis: { route: "codex-implement"; backend: "codex"; mode: "implement"; rationale: string; complexity: string };
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

function setup(analyze = vi.fn(async () => recommendation()), maxConcurrent = 2) {
  const store = new StoryStore(":memory:");
  const registry = new SessionRegistry();
  const sse = new SseHub();
  const queue = new QueueManager({ worktreeRoot: "/tmp/planner-wt", maxParallel: 1 }, { store, registry, sse });
  const lifecycle = new StoryLifecycle(queue);
  const session = registry.register({ repo: "test/planner", path: "/tmp/planner-repository", branch: "main", model: "test", pid: 1 });
  registry.attach(session.id, "/tmp/planner-wt");
  const planner = new PlannerWorker({ queue, registry, sse, analyze }, { maxConcurrent });
  return { store, queue, lifecycle, planner, sse, analyze };
}

describe("orchestrator analysis protocol", () => {
  it("uses codex analyze without a worktree and encodes an executable recommendation in the strict handoff", () => {
    const item = story({ worktree: "/tmp/should-not-be-used" });
    const { args } = orchestratorAnalyzeArgs(item, "/tmp/repository", "fable-orchestrator");
    expect(args).toEqual(expect.arrayContaining(["--backend", "codex", "--mode", "analyze", "/tmp/repository"]));
    expect(args).not.toContain("/tmp/should-not-be-used");

    const summary = JSON.stringify({ route: "codex-implement", backend: "codex", mode: "implement", rationale: "Implement after analysis", complexity: "low" });
    const result = parseOrchestratorStdout(JSON.stringify({
      status: "completed", summary, changes: [], verification: [], risks: [], next_actions: [],
    }));
    expect(extractOrchestrationAnalysis(result)).toMatchObject({ route: "codex-implement", backend: "codex", mode: "implement" });
    expect(() => parseOrchestratorStdout(JSON.stringify({ ...result, orchestration: {} }))).toThrow(/unexpected top-level/);
    expect(() => extractOrchestrationAnalysis({ ...result, summary: JSON.stringify({ route: "codex-explore", backend: "codex", mode: "implement", rationale: "wrong", complexity: "low" }) })).toThrow(/match backend and mode/);
    expect(() => extractOrchestrationAnalysis({ ...result, summary: JSON.stringify({ route: "codex-implement", backend: "Codex CLI", mode: "implement", rationale: "wrong", complexity: "low" }) })).toThrow(/CLI id/);
    expect(() => parseOrchestratorStdout("not json")).toThrow(/invalid JSON/);
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
    const { store, planner } = setup(analyze);
    const bad = story({ id: "bad" });
    const good = story({ id: "good", wid: "W-000045" });
    store.upsertStory(bad); store.enqueue(bad.id); store.upsertStory(good); store.enqueue(good.id);
    planner.start();
    await waitFor(() => store.getStory(bad.id)?.orchestration?.status === "failed" && store.getStory(good.id)?.orchestration?.status === "planned");
    expect(store.getStory(bad.id)?.orchestration).toMatchObject({ status: "failed", error: "model unavailable" });
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
