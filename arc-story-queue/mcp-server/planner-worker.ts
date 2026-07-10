import { createHash } from "node:crypto";
import type { Story } from "arc-contracts";
import { runOrchestrationAnalysis, type OrchestrationAnalysis } from "./orchestrator-executor.js";
import type { QueueManager } from "./queue.js";
import type { SessionRegistry } from "./registry.js";
import type { SseHub, StoryLifecycleEvent } from "./sse.js";

export interface PlannerWorkerDeps {
  queue: QueueManager;
  registry: SessionRegistry;
  sse: SseHub;
  analyze?: (story: Story, repositoryPath: string, opts: { signal: AbortSignal }) => Promise<{ analysis: OrchestrationAnalysis }>;
  now?: () => Date;
}

export interface PlannerWorkerOptions {
  /** Independent from execution maxParallel: planning never reserves a dispatch slot. */
  maxConcurrent?: number;
}

function event(kind: StoryLifecycleEvent["kind"], story: Story): StoryLifecycleEvent {
  return { kind, id: story.id, wid: story.wid, title: story.title, column: story.column };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR");
}

function planningError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 1_000) || "Orchestration analysis failed";
}

function digest(story: Story): string {
  return createHash("sha256")
    .update(JSON.stringify({ id: story.id, title: story.title, description: story.description, criteria: story.criteria, tags: story.tags }))
    .digest("hex");
}

/**
 * Background, read-only planner. It reacts to facts only after SseHub has
 * delivered them to subscribers, then catches up durable queued work.
 */
export class PlannerWorker {
  private readonly activeIds = new Set<string>();
  private readonly pendingIds: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly maxConcurrent: number;
  private unsubscribe?: () => void;
  private stopped = false;

  constructor(private deps: PlannerWorkerDeps, options: PlannerWorkerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 2;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1) {
      throw new Error("Planner maxConcurrent must be a positive integer");
    }
  }

  /** Subscribe before a durable catch-up scan so no queued event is missed. */
  start(): void {
    if (this.unsubscribe || this.stopped) return;
    this.unsubscribe = this.deps.sse.subscribeLifecycle((lifecycleEvent) => this.onLifecycleEvent(lifecycleEvent));
    this.catchUp();
  }

  /** Abort active analysis and wait for it before its backing store is closed. */
  async stop(): Promise<void> {
    if (this.stopped) {
      await Promise.allSettled([...this.inFlight]);
      return;
    }
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const id of this.pendingIds.splice(0)) this.activeIds.delete(id);
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.inFlight]);
  }

  /** Exposed for narrow unit tests and explicit catch-up callers. */
  catchUp(): void {
    if (this.stopped) return;
    for (const story of this.deps.queue.planningCandidates()) this.enqueue(story.id);
  }

  private onLifecycleEvent(lifecycleEvent: StoryLifecycleEvent): void {
    if (this.stopped) return;
    if (lifecycleEvent.kind === "queued") this.enqueue(lifecycleEvent.id);
    if (lifecycleEvent.kind === "unqueued") this.controllers.get(lifecycleEvent.id)?.abort();
  }

  private enqueue(id: string): void {
    if (this.stopped || this.activeIds.has(id)) return;
    this.activeIds.add(id);
    this.pendingIds.push(id);
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.controllers.size < this.maxConcurrent && this.pendingIds.length > 0) {
      const id = this.pendingIds.shift()!;
      const controller = new AbortController();
      this.controllers.set(id, controller);
      let work!: Promise<void>;
      work = this.plan(id, controller.signal)
        .catch((error) => {
          // plan normally contains failures; this is a final guard against a
          // detached promise becoming an unhandled rejection.
          if (!controller.signal.aborted && !isAbort(error)) {
            const failed = this.deps.queue.failPlanning(id, planningError(error));
            if (failed) void this.deps.sse.emitEvent(event("planning-failed", failed));
          }
        })
        .finally(() => {
          this.controllers.delete(id);
          this.activeIds.delete(id);
          this.inFlight.delete(work);
          if (!this.stopped) {
            this.pump();
            // An old analysis may have become stale after unqueue + requeue.
            // Its cleanup is the point at which that fresh attempt can run.
            this.catchUp();
          }
        });
      this.inFlight.add(work);
    }
  }

  private async plan(id: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const queued = await this.deps.queue.get(id);
    if (signal.aborted || !queued || queued.column !== "queued") return;
    // An attached repository is a prerequisite, not an analysis failure. This
    // leaves durable work unplanned until project.attach triggers another scan.
    const repositoryPath = this.deps.registry.repoPathForRepo(queued.repo);
    if (!repositoryPath) return;
    const story = this.deps.queue.beginPlanning(id);
    if (!story || signal.aborted) return;

    try {
      await this.deps.sse.emitEvent(event("planning", story));
      if (signal.aborted) return;
      const analyze = this.deps.analyze ?? runOrchestrationAnalysis;
      const { analysis } = await analyze(story, repositoryPath, { signal });
      if (signal.aborted) return;
      const planned = this.deps.queue.finishPlanning(id, {
        status: "planned",
        ...analysis,
        plannedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
        storyDigest: digest(story),
      });
      if (planned && !signal.aborted) await this.deps.sse.emitEvent(event("planned", planned));
    } catch (error) {
      // Cancellation and stale work are expected lifecycle transitions, not
      // user-visible planning failures and never write a replacement attempt.
      if (signal.aborted || isAbort(error)) return;
      const failed = this.deps.queue.failPlanning(id, planningError(error));
      if (failed) await this.deps.sse.emitEvent(event("planning-failed", failed));
    }
  }
}
