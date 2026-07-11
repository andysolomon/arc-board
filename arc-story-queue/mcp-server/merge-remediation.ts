import { existsSync } from "node:fs";
import { z } from "zod";
import type { Handoff, RouteId, RunRecord, Story } from "arc-contracts";
import { validateHandoff, validateRunRecord } from "./validate.js";
import {
  orchestratorCommandLine,
  orchestratorRunArgs,
  resolveOrchestratorBin,
  runOrchestratorPhase,
  type OrchestratorExecutorOptions,
  type OrchestratorRunResult,
} from "./orchestrator-executor.js";
import { QueueManager } from "./queue.js";
import { StoryStore } from "./store.js";

export const MERGE_REMEDIATION_CODES = ["checks_failed", "branch_policy", "behind_base", "unknown"] as const;
export type MergeRemediationCode = (typeof MERGE_REMEDIATION_CODES)[number];
export const mergeRemediationInputSchema = z.object({
  id: z.string(),
  code: z.enum(MERGE_REMEDIATION_CODES),
});

type StreamLine = (
  route: RouteId,
  kind: "cmd" | "out" | "ok" | "lock" | "unlock",
  text: string,
  status?: "running" | "done"
) => Promise<void>;

const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PR_NUMBER = /^[1-9]\d*$/;

function validRepo(repo: string): string {
  const trimmed = repo.trim();
  if (!GITHUB_REPO.test(trimmed)) throw new Error("Story has an invalid GitHub repository");
  return trimmed;
}

/** Safely normalize a GitHub PR URL, #number, or number for a worker contract. */
export function mergeRemediationPrSelector(repo: string, pr: string): string {
  const expectedRepo = validRepo(repo);
  const trimmed = pr.trim();
  const number = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (PR_NUMBER.test(number)) return number;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Story has an invalid GitHub PR to remediate");
  }
  const match =
    url.protocol === "https:" &&
    url.hostname.toLowerCase() === "github.com" &&
    url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
  if (!match || `${match[1]}/${match[2]}` !== expectedRepo) {
    throw new Error("Story has an invalid GitHub PR to remediate");
  }
  return match[3];
}

/** A bounded worker contract for fixing a merge blockage without changing lifecycle state. */
export function buildMergeRemediationTaskContract(story: Story): string {
  const repo = validRepo(story.repo);
  const selector = mergeRemediationPrSelector(repo, story.pr ?? "");
  return [
    `Remediate the merge blockage for review story ${story.wid} in its existing worktree only.`,
    "",
    "## Scope",
    `Repo: ${repo}`,
    `Story branch: ${story.branch}`,
    `Worktree: ${story.worktree}`,
    `PR: #${selector}`,
    "",
    "## Required diagnosis",
    `Start by running: gh pr view ${selector} --json state,mergeStateStatus,statusCheckRollup,title --repo ${repo}`,
    "Inspect the checked-out story branch and the reported merge/check failure before changing anything.",
    "",
    "## Allowed remediation",
    "You may fix the PR title when appropriate, make and commit minimal worktree fixes, and push the story branch normally.",
    `A push, if needed, must target only the story branch (${story.branch}).`,
    "",
    "## Prohibited",
    "Do not merge the PR or run gh pr merge.",
    "Do not force-push any branch.",
    "Never push, rewrite, or force-push main (or any base branch).",
    "Do not move the story out of Review, remove its worktree, deploy, or perform unrelated refactors.",
    "",
    "## Required structured handoff",
    "Return exactly one JSON object with keys status, summary, changes, verification, risks, and next_actions.",
    "next_actions must include the exact string \"Retry merge\" so the operator can re-run the existing merge action.",
  ].join("\n");
}

export function assertMergeRemediationStory(story: Story | null): asserts story is Story {
  if (!story) throw new Error("Unknown story");
  if (story.column !== "review") throw new Error("Only review stories can be remediated for merge");
  if (!story.worktree) throw new Error("Story has no worktree");
  if (!existsSync(story.worktree)) throw new Error(`Story worktree is unavailable: ${story.worktree}`);
  if (!story.pr || story.pr.startsWith("local://")) throw new Error("Story has no GitHub PR to remediate");
  mergeRemediationPrSelector(story.repo, story.pr);
}

function requireRetryMerge(result: OrchestratorRunResult): void {
  if (!result.next_actions.includes("Retry merge")) {
    throw new Error('Merge remediation worker handoff must include "Retry merge" in next_actions');
  }
}

export async function runMergeRemediationPipeline(
  story: Story,
  streamLine: StreamLine,
  opts: OrchestratorExecutorOptions = {}
): Promise<{ result: OrchestratorRunResult; runRecord: RunRecord }> {
  assertMergeRemediationStory(story);
  const route: RouteId = "composer-implement";
  const bin = opts.bin ?? resolveOrchestratorBin();
  const task = buildMergeRemediationTaskContract(story);
  const { args } = orchestratorRunArgs(story, "composer", "implement", bin, { ...opts, task });
  const startedAt = Date.now();

  await streamLine("fable", "out", `merge remediation dispatched for ${story.wid} via composer/implement`, "running");
  await streamLine(route, "lock", `write-lock requested for ${story.worktree}`);
  let completed = false;
  try {
    await streamLine(route, "cmd", orchestratorCommandLine(bin, args).replace(task, "<merge remediation task contract>"));
    const { result, stderr } = await runOrchestratorPhase(story, "composer", "implement", { ...opts, task });
    for (const line of stderr.trim().split(/\r?\n/).filter(Boolean).slice(-6)) {
      await streamLine(route, "out", line.slice(0, 1200));
    }
    requireRetryMerge(result);
    await streamLine(route, result.status === "completed" ? "ok" : "out", result.summary, "done");
    const runRecord: RunRecord = {
      id: `run-${story.id}-${route}-remediate-${startedAt}`,
      storyId: story.id,
      label: `${story.wid} merge remediation`,
      repo: story.repo,
      route,
      backend: "Cursor Agent",
      model: "composer",
      access: "write",
      tokens: 0,
      durMs: Math.max(1, Date.now() - startedAt),
      status: "completed",
      changed: result.changes.length,
      outcome: result.status === "completed" ? "accepted" : "blocked",
    };
    validateRunRecord(runRecord);
    completed = true;
    return { result, runRecord };
  } finally {
    await streamLine(route, "unlock", "write-lock released after merge remediation", "done");
    await streamLine(
      "fable",
      completed ? "ok" : "out",
      completed ? "merge remediation delegation complete" : "merge remediation delegation ended without completion",
      "done"
    );
  }
}

/** Dispatches a remediation worker without mutating Review state or worktree ownership. */
export class MergeRemediation {
  constructor(
    private readonly queue: QueueManager,
    private readonly store: StoryStore,
    private readonly opts: OrchestratorExecutorOptions = {}
  ) {}

  async remediate(id: string, _code: MergeRemediationCode): Promise<Story> {
    const story = await this.queue.get(id);
    assertMergeRemediationStory(story);
    const lockOwner = `merge-remediation:${story.id}:${Date.now()}`;
    if (!this.queue.acquireWrite(story.worktree, lockOwner)) {
      throw new Error(`Merge remediation is already running for story ${story.id}`);
    }
    try {
      const { result, runRecord } = await runMergeRemediationPipeline(
        story,
        async (route, kind, text, status) => {
          await this.queue.update({
            id: story.id,
            route,
            line: { kind, text },
            lane: status ? { route, status } : undefined,
          });
        },
        this.opts
      );
      const handoff: Handoff = {
        status: result.status,
        summary: result.summary,
        changes: result.changes,
        verification: result.verification,
        risks: result.risks,
        next_actions: result.next_actions,
      };
      validateHandoff(handoff);
      this.store.saveHandoff(story.id, handoff);
      this.store.saveRun(runRecord);
      if (result.status === "blocked") throw new Error(result.summary);
      return story;
    } finally {
      this.queue.releaseWrite(story.worktree, lockOwner);
    }
  }
}
