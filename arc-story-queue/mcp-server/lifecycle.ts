import type { AnnotateOutcome, Handoff, IntakeDraftProposal, RunRecord, Story } from "arc-contracts";
import { IntakeManager } from "./intake.js";
import { QueueManager } from "./queue.js";
import type { StoryLifecycleEvent } from "./sse.js";

export interface LifecycleResult<T> {
  value: T;
  events: StoryLifecycleEvent[];
}

function result<T>(value: T, events: StoryLifecycleEvent[] = []): LifecycleResult<T> {
  return { value, events };
}

function storyEvent(kind: StoryLifecycleEvent["kind"], story: Story): StoryLifecycleEvent {
  return { kind, id: story.id, wid: story.wid, title: story.title, column: story.column };
}

/**
 * Deep lifecycle interface for Story state transitions.
 *
 * MCP adapters should call this module for queue/dispatch/review/merge/abandon
 * transitions and emit the returned event facts verbatim. Low-level queue,
 * persistence, lock, and worktree mechanics stay behind this interface so tests
 * can exercise behavior without coupling to the MCP transport seam.
 */
export class StoryLifecycle {
  constructor(
    private queue: QueueManager,
    private intake?: IntakeManager
  ) {}

  private requireIntake(): IntakeManager {
    if (!this.intake) throw new Error("Intake lifecycle operations are unavailable");
    return this.intake;
  }

  async dispatch(projectId: string): Promise<LifecycleResult<Story | null>> {
    const story = await this.queue.next(projectId);
    return result(story, story ? [storyEvent("started", story)] : []);
  }

  async start(id: string): Promise<LifecycleResult<Story>> {
    const story = await this.queue.get(id);
    if (!story) throw new Error(`Unknown story: ${id}`);
    if (story.column !== "in_progress") throw new Error("Only in-progress stories can be started");
    if (!story.worktree) throw new Error("Story has no worktree");
    return result(story, [storyEvent("started", story)]);
  }

  async update(args: Parameters<QueueManager["update"]>[0]): Promise<LifecycleResult<{ ok: true }>> {
    return result(await this.queue.update(args));
  }

  async complete(args: {
    id: string;
    handoff: Handoff;
    pr: string;
    runs: RunRecord[];
    outcome: AnnotateOutcome;
  }): Promise<LifecycleResult<{ ok: true }>> {
    const value = await this.queue.complete(args);
    const story = await this.queue.get(args.id);
    return result(value, story ? [storyEvent("review", story)] : []);
  }

  async block(args: {
    id: string;
    handoff: Handoff;
    outcome: Extract<AnnotateOutcome, "blocked" | "verification-failed" | "escalated">;
  }): Promise<LifecycleResult<{ ok: true }>> {
    const value = await this.queue.block(args);
    const story = await this.queue.get(args.id);
    return result(value, story ? [storyEvent("escalated", story)] : []);
  }

  async review(id: string): Promise<LifecycleResult<Story>> {
    const story = await this.queue.review(id);
    return result(story, [storyEvent("review", story)]);
  }

  async merge(id: string): Promise<LifecycleResult<Story>> {
    const story = await this.queue.merge(id);
    return result(story, [storyEvent("done", story)]);
  }

  async abandon(id: string): Promise<LifecycleResult<Story>> {
    const story = await this.queue.abandon(id);
    return result(story, [storyEvent("abandoned", story)]);
  }

  async file(id: string, issue: string): Promise<LifecycleResult<Story>> {
    const story = await this.queue.file(id, issue);
    return result(story, [storyEvent("filed", story)]);
  }

  async requestFile(id: string): Promise<LifecycleResult<Story>> {
    const story = await this.queue.requestFile(id);
    return result(story, [storyEvent("file-requested", story)]);
  }

  async enqueue(id: string): Promise<LifecycleResult<Story>> {
    const story = await this.queue.enqueueStory(id);
    return result(story, [storyEvent("queued", story)]);
  }

  unqueue(id: string): LifecycleResult<Story> {
    const story = this.queue.unqueue(id);
    return result(story, [storyEvent("unqueued", story)]);
  }

  draftIntake(id: string, repo: string): LifecycleResult<Story> {
    const story = this.requireIntake().draft(id, repo);
    return result(story, [storyEvent("drafted", story)]);
  }

  createDrafts(drafts: IntakeDraftProposal[], repo: string): LifecycleResult<Story[]> {
    const stories = this.requireIntake().createDrafts(drafts, repo);
    return result(stories, stories.map((story) => storyEvent("drafted", story)));
  }
}
