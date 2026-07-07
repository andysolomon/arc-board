import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { AppConfig, Handoff, Plan, Project, RunRecord, Story, StoryDetail } from "arc-contracts";
import type { SessionRegistry } from "./registry.js";
import type { SseHub } from "./sse.js";
import type { StoryStore } from "./store.js";
import { validateHandoff } from "./validate.js";
import { ghListIssues, importIssuesToStore, type IssueLister } from "./github-import.js";

const READ_ONLY_ROUTES = new Set(["codex-explore", "codex-check", "opus-review"]);

export interface QueueConfig {
  worktreeRoot: string;
  maxParallel: number;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: ExecFileSyncOptions
) => string | Buffer;

export interface QueueDeps {
  store: StoryStore;
  registry: SessionRegistry;
  sse: SseHub;
  commandRunner?: CommandRunner;
}

function slugify(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

export class QueueManager {
  private locks = new Map<string, string>();

  constructor(
    private cfg: QueueConfig,
    private deps: QueueDeps
  ) {}

  private runCommand(file: string, args: readonly string[], options?: ExecFileSyncOptions): string | Buffer {
    const runner = this.deps.commandRunner ?? execFileSync;
    return runner(file, args, options);
  }

  private get store() {
    return this.deps.store;
  }

  private get registry() {
    return this.deps.registry;
  }

  private get sse() {
    return this.deps.sse;
  }

  repoOf(projectId: string): string {
    return this.registry.repoOf(projectId);
  }

  private running(projectId?: string): Story[] {
    const repo = projectId ? this.repoOf(projectId) : undefined;
    return this.store.listStories().filter(
      (s) => s.column === "in_progress" && (!repo || s.repo === repo)
    );
  }

  isWriteLocked(worktree: string): boolean {
    return this.locks.has(worktree);
  }

  writeLockHolder(worktree: string): string | undefined {
    return this.locks.get(worktree);
  }

  needsWriteLock(route: string): boolean {
    return !READ_ONLY_ROUTES.has(route);
  }

  acquireWrite(worktree: string, storyId: string): boolean {
    if (this.locks.has(worktree)) return false;
    this.locks.set(worktree, storyId);
    return true;
  }

  acquireForRoute(worktree: string, storyId: string, route: string): boolean {
    if (!this.needsWriteLock(route)) return true;
    return this.acquireWrite(worktree, storyId);
  }

  releaseWrite(worktree: string): void {
    this.locks.delete(worktree);
  }

  async next(projectId: string): Promise<Story | null> {
    const maxParallel = this.store.getConfiguredMaxParallel() ?? this.cfg.maxParallel;
    if (this.running(projectId).length >= maxParallel) return null;

    const repo = this.repoOf(projectId);
    const repoPath = this.registry.repoPathOf(projectId);
    const order = this.store.queueIds();

    const id = order.find((sid) => {
      const s = this.store.getStory(sid);
      return s && !s.draft && s.column === "queued" && s.repo === repo;
    });
    if (!id) return null;

    const story = this.store.getStory(id)!;
    const wtDir = resolve(this.cfg.worktreeRoot, slugify(story.branch || story.id));
    mkdirSync(this.cfg.worktreeRoot, { recursive: true });

    if (!existsSync(wtDir)) {
      this.runCommand("git", ["-C", repoPath, "worktree", "add", wtDir, "-b", story.branch], {
        stdio: "pipe",
      });
    }

    story.worktree = wtDir;
    story.column = "in_progress";
    this.store.upsertStory(story);
    this.store.dequeue(id);

    if (!this.acquireWrite(wtDir, id)) {
      throw new Error(`Write lock already held for worktree ${wtDir}`);
    }

    return story;
  }

  async get(id: string): Promise<Story | null> {
    return this.store.getStory(id);
  }

  async setPlan(id: string, plan: Plan): Promise<{ ok: true }> {
    const s = this.store.getStory(id);
    if (s) {
      s.plan = plan;
      this.store.upsertStory(s);
    }
    return { ok: true };
  }

  async update(args: {
    id: string;
    route: string;
    line?: { kind: "cmd" | "out" | "ok" | "lock" | "unlock"; text: string };
    lane?: { route: string; status: "running" | "done" };
  }): Promise<{ ok: true }> {
    const story = this.store.getStory(args.id);
    if (story && args.line?.kind === "lock") {
      this.acquireForRoute(story.worktree, args.id, args.route);
    }
    if (story && args.line?.kind === "unlock") {
      this.releaseWrite(story.worktree);
    }
    await this.sse.broadcast(args);
    return { ok: true };
  }

  async complete(args: {
    id: string;
    handoff: Handoff;
    pr: string;
    runs: RunRecord[];
    outcome: "accepted" | "escalated";
  }): Promise<{ ok: true }> {
    validateHandoff(args.handoff);
    const s = this.store.getStory(args.id);
    if (!s) throw new Error(`Unknown story: ${args.id}`);

    this.store.saveHandoff(args.id, args.handoff);

    s.column = "review";
    s.pr = args.pr;
    s.prState = "open";
    s.annotation = args.outcome;
    this.store.upsertStory(s);

    for (const run of args.runs) {
      this.store.saveRun(run);
    }

    if (s.worktree) this.releaseWrite(s.worktree);
    return { ok: true };
  }

  private prSelector(pr: string): string {
    const trimmed = pr.trim();
    const hash = trimmed.match(/#(\d+)/);
    if (hash) return hash[1];
    const pullUrl = trimmed.match(/\/pull\/(\d+)(?:\b|$)/);
    if (pullUrl) return pullUrl[1];
    return trimmed;
  }

  private isLocalPr(pr: string): boolean {
    return pr.startsWith("local://");
  }

  private mergePr(story: Story): void {
    const pr = story.pr?.trim();
    if (!pr) throw new Error(`Story ${story.id} has no PR to merge`);
    if (story.prState === "merged" || this.isLocalPr(pr)) return;

    const args = ["pr", "merge", this.prSelector(pr), "--merge", "--delete-branch"];
    if (story.repo) args.push("--repo", story.repo);
    this.runCommand("gh", args, { stdio: "pipe" });
  }

  private cleanupWorktree(story: Story): void {
    const worktree = story.worktree?.trim();
    if (!worktree) return;

    try {
      if (!existsSync(worktree)) return;
      const rawCommonDir = this.runCommand(
        "git",
        ["-C", worktree, "rev-parse", "--git-common-dir"],
        { encoding: "utf8", stdio: "pipe" }
      ).toString().trim();
      const commonDir = isAbsolute(rawCommonDir) ? rawCommonDir : resolve(worktree, rawCommonDir);
      this.runCommand("git", ["--git-dir", commonDir, "worktree", "remove", "--force", worktree], {
        stdio: "pipe",
      });
    } finally {
      this.releaseWrite(worktree);
    }
  }

  async merge(id: string): Promise<Story> {
    const story = this.store.getStory(id);
    if (!story) throw new Error(`Unknown story: ${id}`);
    if (story.column !== "review") throw new Error("Only review stories can be merged");
    if (!story.pr) throw new Error(`Story ${id} has no open PR`);

    this.mergePr(story);
    this.cleanupWorktree(story);
    story.column = "done";
    story.prState = "merged";
    story.worktree = "";
    this.store.upsertStory(story);
    return story;
  }

  async abandon(id: string): Promise<Story> {
    const story = this.store.getStory(id);
    if (!story) throw new Error(`Unknown story: ${id}`);
    if (story.column !== "in_progress") throw new Error("Only in-progress stories can be abandoned");

    this.cleanupWorktree(story);
    this.store.dequeue(id);
    story.column = "backlog";
    story.worktree = "";
    this.store.upsertStory(story);
    return story;
  }

  async discover(): Promise<Project[]> {
    return this.registry.discover();
  }

  async attach(sessionId: string): Promise<Project> {
    return this.registry.attach(sessionId, this.cfg.worktreeRoot);
  }

  async file(id: string, issue: string): Promise<Story> {
    const story = this.store.getStory(id);
    if (!story) throw new Error(`Unknown story: ${id}`);

    story.draft = false;
    story.fileRequested = false;
    story.issue = issue;
    this.store.upsertStory(story);
    return story;
  }

  /** Flag a draft so a Fable session knows the user wants it filed to GitHub. */
  async requestFile(id: string): Promise<Story> {
    const story = this.store.getStory(id);
    if (!story) throw new Error(`Unknown story: ${id}`);
    if (!story.draft) throw new Error("Only drafts can be filed");
    story.fileRequested = true;
    this.store.upsertStory(story);
    return story;
  }

  /** Import a repo's open GitHub issues as backlog stories (deduped by issue url). */
  importGithub(repo: string, lister: IssueLister = ghListIssues): Story[] {
    const issues = lister(repo);
    return importIssuesToStore({ store: this.store, repo, issues });
  }

  /** Drafts awaiting filing — the pull queue a Fable session drains via `gh`. */
  filePending(projectId?: string): Story[] {
    const repo = projectId ? this.repoOf(projectId) : undefined;
    return this.store
      .listStories()
      .filter((s) => s.draft && s.fileRequested && (!repo || s.repo === repo));
  }

  async enqueueStory(id: string): Promise<Story> {
    const story = this.store.getStory(id);
    if (!story) throw new Error(`Unknown story: ${id}`);

    if (story.draft === true) {
      throw new Error("Cannot queue a draft — file it as a GitHub issue first (story.file)");
    }
    if (!story.issue) {
      throw new Error("Cannot queue an unfiled story — no issue attached");
    }

    story.column = "queued";
    this.store.enqueue(id);
    this.store.upsertStory(story);
    return story;
  }

  /** Ordered queue (queue_order), optionally scoped to a project's repo. */
  listQueue(projectId?: string): Story[] {
    const repo = projectId ? this.repoOf(projectId) : undefined;
    return this.store
      .queueIds()
      .map((sid) => this.store.getStory(sid))
      .filter((s): s is Story => !!s && (!repo || s.repo === repo));
  }

  /** Swap a queued story with its neighbor; returns the new full ordered queue. */
  reorder(id: string, direction: "up" | "down"): Story[] {
    const order = this.store.queueIds();
    const idx = order.indexOf(id);
    if (idx === -1) throw new Error("Story not in queue");
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= order.length) return this.listQueue();
    [order[idx], order[swapWith]] = [order[swapWith], order[idx]];
    this.store.setQueueOrder(order);
    return this.listQueue();
  }

  /**
   * Set an arbitrary queue order (drag reorder). Robust to a partial list:
   * provided ids that are still queued come first (in given order), then any
   * remaining queued ids are appended — never silently drops a queued story.
   */
  setOrder(ids: string[]): Story[] {
    const current = this.store.queueIds();
    const provided = ids.filter((id) => current.includes(id));
    const remaining = current.filter((id) => !provided.includes(id));
    this.store.setQueueOrder([...provided, ...remaining]);
    return this.listQueue();
  }

  /** Pull a story out of the queue back to backlog (drag Queued → Backlog). */
  unqueue(id: string): Story {
    const story = this.store.getStory(id);
    if (!story) throw new Error(`Unknown story: ${id}`);
    this.store.dequeue(id);
    story.column = "backlog";
    this.store.upsertStory(story);
    return story;
  }

  /** All run records, optionally scoped to a project's repo (observability). */
  listRuns(projectId?: string): RunRecord[] {
    const repo = projectId ? this.repoOf(projectId) : undefined;
    return this.store.listRuns().filter((r) => !repo || r.repo === repo);
  }

  /** Full drawer hydration: story + persisted runs + handoff. */
  detail(id: string): StoryDetail {
    const story = this.store.getStory(id);
    if (!story) throw new Error(`Unknown story: ${id}`);
    return {
      story,
      runs: this.store.getRunsForStory(id),
      handoff: this.store.getHandoff(id),
    };
  }

  getConfig(): AppConfig {
    return this.store.getConfig();
  }

  setConfig(patch: Partial<AppConfig>): AppConfig {
    return this.store.setConfig(patch);
  }
}
