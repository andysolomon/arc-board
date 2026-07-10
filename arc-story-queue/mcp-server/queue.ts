import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  routeNeedsWriteLock,
  type AnnotateOutcome,
  type AppConfig,
  type Handoff,
  type KnownProject,
  type Plan,
  type Project,
  type RunRecord,
  type Story,
  type StoryDetail,
  isDispatchEligible,
} from "arc-contracts";
import type { SessionRegistry } from "./registry.js";
import type { SseHub } from "./sse.js";
import type { StoryStore } from "./store.js";
import { validateHandoff, validatePlan, validateProject, validateRunRecord, validateStory } from "./validate.js";
import { ghListIssues, importIssuesToStore, type IssueLister } from "./github-import.js";

export interface QueueConfig {
  worktreeRoot: string;
  maxParallel: number;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: ExecFileSyncOptions
) => string | Buffer;

export interface PrReconcileResult {
  checked: number;
  merged: string[];
  closed: string[];
  errors: Array<{ id: string; message: string }>;
}

export interface IssueReconcileResult {
  checked: number;
  purged: string[];
  errors: Array<{ id: string; message: string }>;
}

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
    return routeNeedsWriteLock(route);
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
    const inProgress = this.running(projectId);
    if (inProgress.length >= maxParallel) return null;

    const repo = this.repoOf(projectId);
    const repoPath = this.registry.repoPathOf(projectId);
    const order = this.store.queueIds();

    const id = order.find((sid) => {
      const s = this.store.getStory(sid);
      if (!s || s.draft || s.column !== "queued" || s.repo !== repo) return false;
      return isDispatchEligible(s, inProgress, maxParallel);
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
    validatePlan(plan);
    const s = this.store.getStory(id);
    if (s) {
      s.plan = plan;
      this.store.upsertStory(s);
    }
    return { ok: true };
  }

  async save(story: Story): Promise<Story> {
    const existing = this.store.getStory(story.id);
    if (!existing) throw new Error(`Unknown story: ${story.id}`);
    validateStory(story);
    this.store.upsertStory(story);
    return story;
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
    outcome: AnnotateOutcome;
  }): Promise<{ ok: true }> {
    validateHandoff(args.handoff);
    for (const run of args.runs) validateRunRecord(run);
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

  async block(args: {
    id: string;
    handoff: Handoff;
    outcome: Extract<AnnotateOutcome, "blocked" | "verification-failed" | "escalated">;
  }): Promise<{ ok: true }> {
    validateHandoff(args.handoff);
    const s = this.store.getStory(args.id);
    if (!s) throw new Error(`Unknown story: ${args.id}`);

    this.store.saveHandoff(args.id, args.handoff);
    s.annotation = args.outcome;
    this.store.upsertStory(s);

    if (s.worktree) this.releaseWrite(s.worktree);
    return { ok: true };
  }

  /** Derive the repo's default base branch for PRs (origin/HEAD, else "main"). */
  private baseBranch(worktree: string): string {
    try {
      const ref = this.runCommand(
        "git",
        ["-C", worktree, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { encoding: "utf8", stdio: "pipe" }
      ).toString().trim();
      const short = ref.replace(/^origin\//, "");
      if (short) return short;
    } catch {
      // No origin/HEAD ref configured; fall back to main.
    }
    return "main";
  }

  /** Count commits and changed files on the worktree branch vs its base. Never throws. */
  private reviewGitState(worktree: string, base: string): { commitCount: number; changed: string[] } {
    try {
      const commitCount = Number(
        this.runCommand("git", ["-C", worktree, "rev-list", "--count", `${base}..HEAD`], {
          encoding: "utf8",
          stdio: "pipe",
        }).toString().trim() || "0"
      );
      const changed = this.runCommand("git", ["-C", worktree, "diff", "--name-only", `${base}...HEAD`], {
        encoding: "utf8",
        stdio: "pipe",
      })
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
      return { commitCount: Number.isFinite(commitCount) ? commitCount : 0, changed };
    } catch {
      return { commitCount: 0, changed: [] };
    }
  }

  /** Push the worktree branch and open (or reuse) a GitHub PR; returns the PR URL. */
  private openPullRequest(story: Story, worktree: string, branch: string, base: string): string {
    this.runCommand("git", ["-C", worktree, "push", "-u", "origin", branch], { stdio: "pipe" });
    try {
      return this.runCommand(
        "gh",
        [
          "pr", "create",
          "--repo", story.repo,
          "--head", branch,
          "--base", base,
          "--title", story.title,
          "--body", `Auto-opened from arc-story-queue for ${story.wid}.`,
        ],
        { encoding: "utf8", stdio: "pipe" }
      ).toString().trim();
    } catch {
      // A PR for this branch may already exist — reuse its URL.
      const existing = this.runCommand(
        "gh",
        ["pr", "view", branch, "--repo", story.repo, "--json", "url", "-q", ".url"],
        { encoding: "utf8", stdio: "pipe" }
      ).toString().trim();
      if (existing) return existing;
      throw new Error(`Failed to open or find a PR for branch ${branch}`);
    }
  }

  /**
   * Send an in-progress story to review. For GitHub repos, push the worktree branch
   * and open a PR (creating an empty commit first when the branch has no commits ahead
   * of base). Local or local/-prefixed repos get a local:// sentinel with no git push
   * or gh calls. Builds a handoff from the worktree git state.
   */
  async review(id: string): Promise<Story> {
    const story = this.store.getStory(id);
    if (!story) throw new Error(`Unknown story: ${id}`);
    if (story.column !== "in_progress") throw new Error("Only in-progress stories can be sent to review");
    const worktree = story.worktree?.trim();
    if (!worktree || !existsSync(worktree)) throw new Error(`Story ${id} has no worktree to review`);

    const base = this.baseBranch(worktree);
    const { commitCount, changed } = this.reviewGitState(worktree, base);
    const isGithubRepo = !!story.repo && !story.repo.startsWith("local/");

    let pr: string;
    if (isGithubRepo) {
      if (commitCount === 0) {
        this.runCommand(
          "git",
          ["-C", worktree, "commit", "--allow-empty", "-m", `chore(${story.wid}): open review PR`],
          { stdio: "pipe" }
        );
      }
      pr = this.openPullRequest(story, worktree, story.branch, base);
    } else {
      pr = `local://arc-story-queue/${story.wid}`;
    }

    const handoff: Handoff = {
      status: "completed",
      summary: `${story.wid} sent to Review from the board — ${commitCount} commit(s) on ${story.branch}.`,
      changes: changed.length ? changed : ["No file changes detected against the base branch."],
      verification: [`git rev-list --count ${base}..HEAD -> ${commitCount}`],
      risks: ["Sent to review by an operator board action, not an automated worker run."],
      next_actions: this.isLocalPr(pr)
        ? ["Review the worktree, then Merge PR & clean worktree to finish."]
        : [`Review the PR at ${pr}, then Merge PR & clean worktree to finish.`],
    };
    validateHandoff(handoff);
    this.store.saveHandoff(id, handoff);

    story.column = "review";
    story.pr = pr;
    story.prState = "open";
    story.annotation = "accepted";
    this.store.upsertStory(story);

    const run: RunRecord = {
      id: `run-${story.id}-review-${story.wid}`,
      storyId: story.id,
      label: "Sent to review from board",
      repo: story.repo,
      route: "fable",
      backend: "Board action",
      model: "operator",
      access: "parent",
      tokens: 0,
      durMs: 1,
      status: "completed",
      changed: changed.length,
      outcome: "accepted",
    };
    validateRunRecord(run);
    this.store.saveRun(run);

    if (story.worktree) this.releaseWrite(story.worktree);
    return story;
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

  private isGithubReviewPr(story: Story): boolean {
    const pr = story.pr?.trim();
    const isGithubRepo = !!story.repo && !story.repo.startsWith("local/");
    return (
      story.column === "review" &&
      !!pr &&
      isGithubRepo &&
      story.prState !== "merged" &&
      story.prState !== "closed" &&
      !this.isLocalPr(pr)
    );
  }

  private viewPr(story: Story): { state: string; mergedAt?: string | null } {
    const pr = story.pr?.trim();
    if (!pr) throw new Error(`Story ${story.id} has no PR to inspect`);

    const args = ["pr", "view", this.prSelector(pr), "--json", "state,mergedAt", "--repo", story.repo];
    const raw = this.runCommand("gh", args, { encoding: "utf8", stdio: "pipe" }).toString();
    return JSON.parse(raw) as { state: string; mergedAt?: string | null };
  }

  private finishMergedStory(story: Story): Story {
    this.cleanupWorktree(story);
    story.column = "done";
    story.prState = "merged";
    story.worktree = "";
    this.store.upsertStory(story);
    return story;
  }

  /** Evict a closed-without-merge PR from Review to Backlog; preserve worktree for recovery. */
  private evictClosedPr(story: Story): Story {
    story.column = "backlog";
    story.pr = null;
    story.prState = "closed";
    story.annotation = "escalated";
    this.store.upsertStory(story);
    return story;
  }

  async reconcileReviewPrs(): Promise<PrReconcileResult> {
    const result: PrReconcileResult = { checked: 0, merged: [], closed: [], errors: [] };
    const reviewStories = this.store.listStories().filter((story) => this.isGithubReviewPr(story));

    for (const story of reviewStories) {
      result.checked += 1;
      try {
        const pr = this.viewPr(story);
        const state = pr.state.toUpperCase();
        if (state === "MERGED" || !!pr.mergedAt) {
          const updated = this.finishMergedStory(story);
          result.merged.push(updated.id);
          await this.sse.emitEvent({
            kind: "done",
            id: updated.id,
            wid: updated.wid,
            title: updated.title,
            column: updated.column,
          });
        } else if (state === "CLOSED") {
          const updated = this.evictClosedPr(story);
          result.closed.push(updated.id);
          await this.sse.emitEvent({
            kind: "escalated",
            id: updated.id,
            wid: updated.wid,
            title: updated.title,
            column: updated.column,
          });
        }
      } catch (error) {
        result.errors.push({ id: story.id, message: error instanceof Error ? error.message : String(error) });
      }
    }

    return result;
  }

  private issueSelector(issue: string): string {
    const trimmed = issue.trim();
    const hash = trimmed.match(/#(\d+)/);
    if (hash) return hash[1];
    const issueUrl = trimmed.match(/\/issues\/(\d+)(?:\b|$)/);
    if (issueUrl) return issueUrl[1];
    return trimmed;
  }

  private isGithubInProgressIssue(story: Story): boolean {
    const issue = story.issue?.trim();
    const isGithubRepo = !!story.repo && !story.repo.startsWith("local/");
    return story.column === "in_progress" && !!issue && isGithubRepo;
  }

  private viewIssue(story: Story): { state: string } {
    const issue = story.issue?.trim();
    if (!issue) throw new Error(`Story ${story.id} has no issue to inspect`);

    const args = ["issue", "view", this.issueSelector(issue), "--json", "state", "--repo", story.repo];
    const raw = this.runCommand("gh", args, { encoding: "utf8", stdio: "pipe" }).toString();
    return JSON.parse(raw) as { state: string };
  }

  async reconcileInProgressIssues(): Promise<IssueReconcileResult> {
    const result: IssueReconcileResult = { checked: 0, purged: [], errors: [] };
    const inProgressStories = this.store.listStories().filter((story) => this.isGithubInProgressIssue(story));

    for (const story of inProgressStories) {
      result.checked += 1;
      try {
        const issue = this.viewIssue(story);
        if (issue.state.toUpperCase() === "CLOSED") {
          this.cleanupWorktree(story);
          this.store.dequeue(story.id);
          this.store.deleteStory(story.id);
          result.purged.push(story.id);
          await this.sse.emitEvent({
            kind: "purged",
            id: story.id,
            wid: story.wid,
            title: story.title,
          });
        }
      } catch (error) {
        result.errors.push({ id: story.id, message: error instanceof Error ? error.message : String(error) });
      }
    }

    return result;
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
    return this.finishMergedStory(story);
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
    const projects = this.registry.discover();
    for (const project of projects) validateProject(project);
    return projects;
  }

  async attach(sessionId: string): Promise<Project> {
    const project = this.registry.attach(sessionId, this.cfg.worktreeRoot);
    validateProject(project);
    this.store.upsertKnownProject(project);
    return project;
  }

  listKnownProjects(): KnownProject[] {
    return this.store.listKnownProjects();
  }

  forgetKnownProject(path: string): { forgotten: boolean } {
    return { forgotten: this.store.forgetKnownProject(path) };
  }

  async detach(projectId: string): Promise<Project> {
    const project = this.registry.detach(projectId);
    validateProject(project);
    return project;
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
